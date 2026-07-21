import Foundation

protocol BrokerAnthropicGenerationTransporting: Sendable {
  associatedtype Capability: Sendable

  func stream(
    _ request: BrokerAnthropicMessagesRequest,
    capability: Capability,
    onEvent: @escaping @Sendable (BrokerOpenAIResponsesEvent) -> Void
  ) async throws -> BrokerOpenAIResponsesCompletion
}

extension BrokerAnthropicMessagesTransport: BrokerAnthropicGenerationTransporting {
  typealias Capability = Route.Capability
}

struct BrokerAnthropicGenerationRunner<
  Route: BrokerOpenAIGenerationRouteIssuing,
  Transport: BrokerAnthropicGenerationTransporting
>: BrokerOpenAIGenerationRunning, Sendable where Route.Capability == Transport.Capability {
  private let route: Route
  private let transport: Transport
  private let continuations: BrokerDirectContinuationAuthority
  private let adapterID: String
  private let clock: @Sendable () -> Date

  init(
    route: Route,
    transport: Transport,
    continuations: BrokerDirectContinuationAuthority,
    adapterID: String = "anthropic-messages",
    clock: @escaping @Sendable () -> Date = { Date() }
  ) {
    self.route = route
    self.transport = transport
    self.continuations = continuations
    self.adapterID = adapterID
    self.clock = clock
  }

  func run(
    _ request: BrokerOpenAIGenerationRequest,
    onEvent: @escaping @Sendable (BrokerOpenAIResponsesEvent) -> Void
  ) async throws -> BrokerOpenAIGenerationResult {
    guard request.adapterID == adapterID,
      request.authorizationExpiresAt > clock(),
      !request.input.isEmpty
    else { throw BrokerOpenAIGenerationError.invalidRequest }

    let decoded = try await decodeInput(request)
    let tools: [BrokerAnthropicMessagesTool]
    let providerRequest: BrokerAnthropicMessagesRequest
    do {
      tools = try request.tools.map {
        try BrokerAnthropicMessagesTool(
          name: $0.name,
          description: $0.description,
          inputSchemaJSON: $0.parametersJSON
        )
      }
      providerRequest = try BrokerAnthropicMessagesRequest(
        model: request.modelID,
        input: decoded.items,
        tools: tools,
        maxOutputTokens: request.maxOutputTokens
      )
    } catch BrokerAnthropicMessagesError.requestTooLarge {
      throw BrokerOpenAIGenerationError.requestTooLarge
    } catch {
      throw BrokerOpenAIGenerationError.invalidRequest
    }

    let capability: Route.Capability
    do {
      capability = try await route.issueRun(
        connectionID: request.connectionID,
        expiresAt: request.authorizationExpiresAt,
        requestBudget: 1,
        byteBudget: UInt64(BrokerAnthropicMessagesRequest.maximumBodyByteCount)
      )
    } catch {
      throw BrokerOpenAIGenerationError.routeUnavailable
    }

    let completion: BrokerOpenAIResponsesCompletion
    let relay = BrokerOpenAIGenerationEventRelay(downstream: onEvent)
    do {
      completion = try await transport.stream(
        providerRequest,
        capability: capability,
        onEvent: relay.receive
      )
    } catch let error as BrokerAnthropicMessagesTransportError {
      await route.cancel(capability)
      throw Self.map(error)
    } catch is CancellationError {
      await route.cancel(capability)
      throw BrokerOpenAIGenerationError.cancelled
    } catch {
      await route.cancel(capability)
      throw BrokerOpenAIGenerationError.routeUnavailable
    }
    await route.cancel(capability)
    guard relay.validates(completion.stopReason) else {
      throw BrokerOpenAIGenerationError.invalidResponse
    }

    let handle: BrokerDirectContinuationHandle
    do {
      handle = try await continuations.put(
        binding: writeBinding(request),
        previous: decoded.previous,
        outputItems: []
      )
    } catch let error {
      switch error {
      case .invalidRequest, .invalidCapability, .bindingMismatch, .expired:
        throw BrokerOpenAIGenerationError.invalidContinuation
      case .stateTooLarge, .persistenceUnavailable:
        throw BrokerOpenAIGenerationError.persistenceUnavailable
      }
    }
    return BrokerOpenAIGenerationResult(completion: completion, continuation: handle)
  }

  private func decodeInput(
    _ request: BrokerOpenAIGenerationRequest
  ) async throws -> (
    items: [BrokerAnthropicMessagesInput],
    previous: BrokerDirectContinuationHandle?
  ) {
    let handles = request.input.compactMap { item -> BrokerDirectContinuationHandle? in
      guard case .continuation(let handle) = item else { return nil }
      return handle
    }
    let activeIDs = Set(handles.map(\.id))
    guard activeIDs.count == handles.count else {
      throw BrokerOpenAIGenerationError.invalidContinuation
    }
    var previousSequence: UInt64 = 0
    for handle in handles {
      guard handle.continuationSequence > previousSequence else {
        throw BrokerOpenAIGenerationError.invalidContinuation
      }
      previousSequence = handle.continuationSequence
    }

    var decoded: [BrokerAnthropicMessagesInput] = []
    for item in request.input {
      switch item {
      case .message(let role, let text):
        decoded.append(.message(role: role, text: text))
      case .image(let mediaType, let data):
        decoded.append(.image(mediaType: mediaType, data: data))
      case .functionCall(let callID, let name, let argumentsJSON):
        decoded.append(.toolUse(callID: callID, name: name, argumentsJSON: argumentsJSON))
      case .functionCallOutput(let callID, let output):
        decoded.append(.toolResult(callID: callID, output: output))
      case .continuation(let handle):
        do {
          let output = try await continuations.load(
            handle,
            binding: replayBinding(request),
            activeHandleIDs: activeIDs
          )
          guard output.isEmpty else {
            throw BrokerOpenAIGenerationError.invalidContinuation
          }
        } catch let error as BrokerOpenAIGenerationError {
          throw error
        } catch {
          throw BrokerOpenAIGenerationError.invalidContinuation
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

  private static func map(
    _ error: BrokerAnthropicMessagesTransportError
  ) -> BrokerOpenAIGenerationError {
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

struct BrokerGenerationRunnerRouter: BrokerOpenAIGenerationRunning, Sendable {
  let openAI: any BrokerOpenAIGenerationRunning
  let anthropic: any BrokerOpenAIGenerationRunning
  let openAIChat: any BrokerOpenAIGenerationRunning

  func run(
    _ request: BrokerOpenAIGenerationRequest,
    onEvent: @escaping @Sendable (BrokerOpenAIResponsesEvent) -> Void
  ) async throws -> BrokerOpenAIGenerationResult {
    switch request.adapterID {
    case "openai-responses":
      try await openAI.run(request, onEvent: onEvent)
    case "anthropic-messages":
      try await anthropic.run(request, onEvent: onEvent)
    case "openai-chat-completions":
      try await openAIChat.run(request, onEvent: onEvent)
    default:
      throw BrokerOpenAIGenerationError.invalidRequest
    }
  }
}
