import Foundation

enum BrokerOpenAIGenerationError: Error, Sendable, Equatable {
  case cancelled
  case invalidRequest
  case requestTooLarge
  case invalidContinuation
  case persistenceUnavailable
  case invalidCredential
  case authenticationRejected
  case rateLimited
  case providerUnavailable
  case requestRejected
  case contentFiltered
  case providerFailure
  case credentialEchoDetected
  case invalidResponse
  case responseTooLarge
  case deliveryUncertain
  case routeUnavailable
}

enum BrokerOpenAIGenerationInput: Sendable, Equatable {
  case message(role: BrokerOpenAIResponsesMessageRole, text: String)
  case image(mediaType: String, data: Data)
  case functionCall(callID: String, name: String, argumentsJSON: Data)
  case functionCallOutput(callID: String, output: String)
  case continuation(BrokerDirectContinuationHandle)
}

enum BrokerImageInput {
  static let maximumTotalByteCount = 5 * 1_024 * 1_024

  static func valid(mediaType: String, data: Data) -> Bool {
    guard !data.isEmpty, data.count <= maximumTotalByteCount else { return false }
    let bytes = [UInt8](data.prefix(12))
    switch mediaType {
    case "image/png":
      return bytes.count >= 8 && bytes.prefix(8).elementsEqual(
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
      )
    case "image/jpeg":
      return bytes.count >= 3 && bytes[0] == 0xff && bytes[1] == 0xd8 && bytes[2] == 0xff
    case "image/webp":
      return bytes.count >= 12 &&
        bytes[0..<4].elementsEqual([0x52, 0x49, 0x46, 0x46]) &&
        bytes[8..<12].elementsEqual([0x57, 0x45, 0x42, 0x50])
    default:
      return false
    }
  }
}

struct BrokerOpenAIGenerationRequest: Sendable, Equatable {
  let connectionID: UUID
  let authorizationID: String
  let sessionID: String
  let turnID: String
  let adapterID: String
  let modelID: String
  let backendFingerprint: String
  let expectedSessionRecordSequence: UInt64
  let authorizationExpiresAt: Date
  let input: [BrokerOpenAIGenerationInput]
  let tools: [BrokerOpenAIResponsesFunctionTool]
  let maxOutputTokens: Int
}

struct BrokerOpenAIGenerationResult: Sendable, Equatable {
  let completion: BrokerOpenAIResponsesCompletion
  let continuation: BrokerDirectContinuationHandle
}

final class BrokerOpenAIGenerationEventRelay: @unchecked Sendable {
  private let lock = NSLock()
  private let downstream: @Sendable (BrokerOpenAIResponsesEvent) -> Void
  private var terminal: BrokerOpenAIResponsesStopReason?
  private var isInvalid = false

  init(downstream: @escaping @Sendable (BrokerOpenAIResponsesEvent) -> Void) {
    self.downstream = downstream
  }

  func receive(_ event: BrokerOpenAIResponsesEvent) {
    let shouldEmit: Bool = lock.withLock {
      switch event {
      case .done(let reason):
        guard terminal == nil else {
          isInvalid = true
          return false
        }
        terminal = reason
        return false
      default:
        guard terminal == nil else {
          isInvalid = true
          return false
        }
        return true
      }
    }
    if shouldEmit { downstream(event) }
  }

  func validates(_ expected: BrokerOpenAIResponsesStopReason) -> Bool {
    lock.withLock { !isInvalid && terminal == expected }
  }

}

protocol BrokerOpenAIGenerationRouteIssuing: Sendable {
  associatedtype Capability: Sendable

  func issueRun(
    connectionID: UUID,
    expiresAt: Date,
    requestBudget: UInt64,
    byteBudget: UInt64
  ) async throws -> Capability

  func cancel(_ capability: Capability) async
}

extension BrokerProviderRouteAuthority: BrokerOpenAIGenerationRouteIssuing {
  func issueRun(
    connectionID: UUID,
    expiresAt: Date,
    requestBudget: UInt64,
    byteBudget: UInt64
  ) async throws -> BrokerProviderRouteCapability {
    try await issue(
      scope: .run,
      connectionID: connectionID,
      expiresAt: expiresAt,
      requestBudget: requestBudget,
      byteBudget: byteBudget
    )
  }
}

protocol BrokerOpenAIGenerationTransporting: Sendable {
  associatedtype Capability: Sendable

  func stream(
    _ request: BrokerOpenAIResponsesRequest,
    capability: Capability,
    onEvent: @escaping @Sendable (BrokerOpenAIResponsesEvent) -> Void
  ) async throws -> BrokerOpenAIResponsesCompletion
}

protocol BrokerOpenAIGenerationRunning: Sendable {
  func run(
    _ request: BrokerOpenAIGenerationRequest,
    onEvent: @escaping @Sendable (BrokerOpenAIResponsesEvent) -> Void
  ) async throws -> BrokerOpenAIGenerationResult
}

extension BrokerOpenAIResponsesTransport: BrokerOpenAIGenerationTransporting {
  typealias Capability = Route.Capability
}

struct BrokerOpenAIGenerationRunner<
  Route: BrokerOpenAIGenerationRouteIssuing,
  Transport: BrokerOpenAIGenerationTransporting
>: Sendable where Route.Capability == Transport.Capability {
  private let route: Route
  private let transport: Transport
  private let continuations: BrokerDirectContinuationAuthority
  private let clock: @Sendable () -> Date

  init(
    route: Route,
    transport: Transport,
    continuations: BrokerDirectContinuationAuthority,
    clock: @escaping @Sendable () -> Date = { Date() }
  ) {
    self.route = route
    self.transport = transport
    self.continuations = continuations
    self.clock = clock
  }

  func run(
    _ request: BrokerOpenAIGenerationRequest,
    onEvent: @escaping @Sendable (BrokerOpenAIResponsesEvent) -> Void = { _ in }
  ) async throws(BrokerOpenAIGenerationError) -> BrokerOpenAIGenerationResult {
    guard request.adapterID == "openai-responses",
      request.authorizationExpiresAt > clock(),
      !request.input.isEmpty
    else { throw .invalidRequest }

    let decoded = try await decodeInput(request)
    let providerRequest: BrokerOpenAIResponsesRequest
    do {
      providerRequest = try BrokerOpenAIResponsesRequest(
        model: request.modelID,
        input: decoded.items,
        tools: request.tools,
        maxOutputTokens: request.maxOutputTokens
      )
    } catch let error as BrokerOpenAIResponsesRequestError {
      switch error {
      case .requestTooLarge: throw .requestTooLarge
      case .invalidRequest, .invalidJSON: throw .invalidRequest
      }
    } catch {
      throw .invalidRequest
    }

    let capability: Route.Capability
    do {
      capability = try await route.issueRun(
        connectionID: request.connectionID,
        expiresAt: request.authorizationExpiresAt,
        requestBudget: 1,
        byteBudget: UInt64(BrokerOpenAIResponsesRequest.maximumBodyByteCount)
      )
    } catch {
      throw .routeUnavailable
    }

    let completion: BrokerOpenAIResponsesCompletion
    let relay = BrokerOpenAIGenerationEventRelay(downstream: onEvent)
    do {
      completion = try await transport.stream(
        providerRequest,
        capability: capability,
        onEvent: relay.receive
      )
    } catch let error as BrokerOpenAIResponsesError {
      await route.cancel(capability)
      throw Self.map(error)
    } catch is CancellationError {
      await route.cancel(capability)
      throw .cancelled
    } catch {
      await route.cancel(capability)
      throw .routeUnavailable
    }
    await route.cancel(capability)
    guard relay.validates(completion.stopReason) else { throw .invalidResponse }

    let handle: BrokerDirectContinuationHandle
    do {
      handle = try await continuations.put(
        binding: writeBinding(request),
        previous: decoded.previous,
        outputItems: completion.outputItems
      )
    } catch let error {
      switch error {
      case .invalidRequest, .invalidCapability, .bindingMismatch, .expired:
        throw .invalidContinuation
      case .stateTooLarge, .persistenceUnavailable:
        throw .persistenceUnavailable
      }
    }
    return BrokerOpenAIGenerationResult(completion: completion, continuation: handle)
  }

  private func decodeInput(
    _ request: BrokerOpenAIGenerationRequest
  ) async throws(BrokerOpenAIGenerationError) -> (
    items: [BrokerOpenAIResponsesInputItem],
    previous: BrokerDirectContinuationHandle?
  ) {
    let handles = request.input.compactMap { item -> BrokerDirectContinuationHandle? in
      guard case .continuation(let handle) = item else { return nil }
      return handle
    }
    let activeIDs = Set(handles.map(\.id))
    guard activeIDs.count == handles.count else { throw .invalidContinuation }
    var previousSequence: UInt64 = 0
    for handle in handles {
      guard handle.continuationSequence > previousSequence else {
        throw .invalidContinuation
      }
      previousSequence = handle.continuationSequence
    }

    let replay = replayBinding(request)
    var decoded: [BrokerOpenAIResponsesInputItem] = []
    for item in request.input {
      switch item {
      case .message(let role, let text):
        decoded.append(.message(role: role, text: text))
      case .image(let mediaType, let data):
        decoded.append(.image(mediaType: mediaType, data: data))
      case .functionCall(let callID, let name, let argumentsJSON):
        decoded.append(.functionCall(callID: callID, name: name, argumentsJSON: argumentsJSON))
      case .functionCallOutput(let callID, let output):
        decoded.append(.functionCallOutput(callID: callID, output: output))
      case .continuation(let handle):
        do {
          let outputs = try await continuations.load(
            handle,
            binding: replay,
            activeHandleIDs: activeIDs
          )
          decoded.append(contentsOf: outputs.map(BrokerOpenAIResponsesInputItem.privateOutput))
        } catch {
          throw .invalidContinuation
        }
      }
    }
    return (decoded, handles.last)
  }

  private func writeBinding(
    _ request: BrokerOpenAIGenerationRequest
  ) -> BrokerDirectContinuationWriteBinding {
    BrokerDirectContinuationWriteBinding(
      authorizationID: request.authorizationID,
      sessionID: request.sessionID,
      connectionID: request.connectionID.uuidString.lowercased(),
      adapterID: request.adapterID,
      modelID: request.modelID,
      backendFingerprint: request.backendFingerprint,
      turnID: request.turnID,
      expectedSessionRecordSequence: request.expectedSessionRecordSequence,
      expiresAt: request.authorizationExpiresAt
    )
  }

  private func replayBinding(
    _ request: BrokerOpenAIGenerationRequest
  ) -> BrokerDirectContinuationReplayBinding {
    BrokerDirectContinuationReplayBinding(
      authorizationID: request.authorizationID,
      sessionID: request.sessionID,
      connectionID: request.connectionID.uuidString.lowercased(),
      adapterID: request.adapterID,
      modelID: request.modelID,
      backendFingerprint: request.backendFingerprint,
      turnID: request.turnID,
      expectedSessionRecordSequence: request.expectedSessionRecordSequence,
      expiresAt: request.authorizationExpiresAt
    )
  }

  private static func map(_ error: BrokerOpenAIResponsesError) -> BrokerOpenAIGenerationError {
    switch error {
    case .cancelled: .cancelled
    case .invalidRequest: .invalidRequest
    case .requestTooLarge: .requestTooLarge
    case .invalidCredential: .invalidCredential
    case .authenticationRejected: .authenticationRejected
    case .rateLimited: .rateLimited
    case .providerUnavailable: .providerUnavailable
    case .requestRejected: .requestRejected
    case .contentFiltered: .contentFiltered
    case .providerFailure: .providerFailure
    case .credentialEchoDetected: .credentialEchoDetected
    case .invalidResponse: .invalidResponse
    case .responseTooLarge: .responseTooLarge
    case .deliveryUncertain: .deliveryUncertain
    case .routeUnavailable: .routeUnavailable
    }
  }
}

extension BrokerOpenAIGenerationRunner: BrokerOpenAIGenerationRunning {}
