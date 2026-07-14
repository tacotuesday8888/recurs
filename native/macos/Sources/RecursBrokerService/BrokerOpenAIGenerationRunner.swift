import Foundation

enum BrokerOpenAIGenerationError: Error, Sendable, Equatable {
  case cancelled
  case invalidRequest
  case invalidContinuation
  case persistenceUnavailable
  case authentication
  case rateLimited
  case providerUnavailable
  case requestRejected
  case invalidResponse
  case responseTooLarge
  case deliveryUncertain
  case routeUnavailable
}

enum BrokerOpenAIGenerationInput: Sendable, Equatable {
  case message(role: BrokerOpenAIResponsesMessageRole, text: String)
  case functionCall(callID: String, name: String, argumentsJSON: Data)
  case functionCallOutput(callID: String, output: String)
  case continuation(BrokerDirectContinuationHandle)
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

private final class BrokerOpenAIGenerationEventRelay: @unchecked Sendable {
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
    case .invalidRequest, .requestTooLarge: .invalidRequest
    case .invalidCredential, .authenticationRejected: .authentication
    case .rateLimited: .rateLimited
    case .providerUnavailable: .providerUnavailable
    case .requestRejected, .contentFiltered, .providerFailure: .requestRejected
    case .invalidResponse, .credentialEchoDetected: .invalidResponse
    case .responseTooLarge: .responseTooLarge
    case .deliveryUncertain: .deliveryUncertain
    case .routeUnavailable: .routeUnavailable
    }
  }
}
