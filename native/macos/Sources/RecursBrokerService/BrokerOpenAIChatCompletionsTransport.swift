import Foundation
import RecursBrokerCore

enum BrokerOpenAIChatCompletionsTransportError: Error, Sendable, Equatable {
  case cancelled
  case invalidRequest
  case requestTooLarge
  case invalidCredential
  case routeUnavailable
  case deliveryUncertain
  case invalidResponse
  case responseTooLarge
  case authenticationRejected
  case rateLimited
  case providerUnavailable
  case requestRejected
  case contentFiltered
  case providerFailure
  case credentialEchoDetected
}

struct BrokerOpenAIChatCompletionsTransport<
  Route: BrokerOpenAIResponsesRouteAuthorizing,
  Network: BrokerAnthropicMessagesNetworking
>: Sendable {
  static var maximumCredentialByteCount: Int { 16_384 }

  private let route: Route
  private let network: Network
  private let endpoint: BrokerGenerationEndpoint
  private let providerBinding: ProviderProfileBinding

  init(
    route: Route,
    network: Network,
    endpoint: BrokerGenerationEndpoint,
    providerBinding: ProviderProfileBinding
  ) {
    self.route = route
    self.network = network
    self.endpoint = endpoint
    self.providerBinding = providerBinding
  }

  func stream(
    _ request: BrokerOpenAIChatCompletionsRequest,
    capability: Route.Capability,
    onEvent: @escaping @Sendable (BrokerOpenAIResponsesEvent) -> Void = { _ in }
  ) async throws(BrokerOpenAIChatCompletionsTransportError)
    -> BrokerOpenAIResponsesCompletion
  {
    let body: Data
    do { body = try request.encodedBody() } catch BrokerOpenAIChatCompletionsError.requestTooLarge {
      throw .requestTooLarge
    } catch {
      throw .invalidRequest
    }
    let requestBytes = UInt64(body.count)
    let attemptBox = BrokerAnthropicMessagesAttemptBox()
    do {
      return try await withTaskCancellationHandler {
        try Task.checkCancellation()
        let reservation = try await route.reserveCredentialUse(
          capability,
          expectedScope: .run,
          expectedProviderBinding: providerBinding,
          requestBytes: requestBytes
        )
        try Task.checkCancellation()
        let delivery = try await route.startCredentialUse(
          reservation,
          capability: capability,
          expectedScope: .run,
          expectedProviderBinding: providerBinding,
          requestBytes: requestBytes,
          prepare: {
            credential -> CredentialUsePreparation<BrokerAnthropicMessagesPreparedAttempt> in
            guard
              let prepared = prepare(
                credential: credential,
                body: body,
                network: network,
                attemptBox: attemptBox,
                onEvent: onEvent
              )
            else { return .rejected }
            return .prepared(prepared)
          },
          start: { (prepared: BrokerAnthropicMessagesPreparedAttempt) in
            prepared.attempt.start()
          }
        )
        guard delivery == .requestStarted else {
          attemptBox.cancel()
          throw BrokerOpenAIChatCompletionsTransportError.deliveryUncertain
        }
        let completion = try await attemptBox.response()
        try Task.checkCancellation()
        return completion
      } onCancel: {
        attemptBox.cancel()
      }
    } catch let error as BrokerOpenAIChatCompletionsTransportError {
      if Task.isCancelled { throw .cancelled }
      throw error
    } catch let error as BrokerProviderRouteAuthorityError {
      if Task.isCancelled { throw .cancelled }
      if error == .invalidCredential { throw .invalidCredential }
      throw .routeUnavailable
    } catch let error as BrokerAnthropicMessagesNetworkError {
      if Task.isCancelled { throw .cancelled }
      throw Self.map(error)
    } catch is CancellationError {
      throw .cancelled
    } catch {
      throw .routeUnavailable
    }
  }

  private func prepare(
    credential: UnsafeRawBufferPointer,
    body: Data,
    network: Network,
    attemptBox: BrokerAnthropicMessagesAttemptBox,
    onEvent: @escaping @Sendable (BrokerOpenAIResponsesEvent) -> Void
  ) -> BrokerAnthropicMessagesPreparedAttempt? {
    guard (1...Self.maximumCredentialByteCount).contains(credential.count),
      credential.allSatisfy({ (0x21...0x7e).contains($0) })
    else { return nil }
    let secret = Data(credential)
    var bearer = Data("Bearer ".utf8)
    bearer.append(secret)
    guard
      let rawFilter = try? StreamingSecretFilter(
        patterns: [SecretBytes(secret), SecretBytes(bearer)]
      ),
      let semanticFilter = try? StreamingSecretFilter(
        patterns: [SecretBytes(secret), SecretBytes(bearer)]
      )
    else { return nil }
    var request = URLRequest(
      url: endpoint.requestURL,
      cachePolicy: .reloadIgnoringLocalCacheData,
      timeoutInterval: 30
    )
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("recurs", forHTTPHeaderField: "User-Agent")
    request.setValue(
      "Bearer \(String(decoding: credential, as: UTF8.self))",
      forHTTPHeaderField: "Authorization"
    )
    request.httpBody = body
    let attempt = network.makeAttempt(
      request: request,
      accumulator: BrokerAnthropicMessagesResponseAccumulator(
        rawFilter: rawFilter,
        semanticFilter: semanticFilter,
        openAIChat: true,
        onEvent: onEvent
      ),
      endpoint: endpoint
    )
    guard attemptBox.install(attempt) else { return nil }
    return BrokerAnthropicMessagesPreparedAttempt(attempt: attempt)
  }

  private static func map(_ error: BrokerAnthropicMessagesNetworkError)
    -> BrokerOpenAIChatCompletionsTransportError
  {
    switch error {
    case .cancelled: .cancelled
    case .transportFailure: .deliveryUncertain
    case .invalidResponse: .invalidResponse
    case .responseTooLarge: .responseTooLarge
    case .authenticationRejected: .authenticationRejected
    case .rateLimited: .rateLimited
    case .providerUnavailable: .providerUnavailable
    case .requestRejected: .requestRejected
    case .contentFiltered: .contentFiltered
    case .providerFailure: .providerFailure
    case .credentialEchoDetected: .credentialEchoDetected
    }
  }
}

struct BrokerOpenAIChatGenerationBridge<Transport: BrokerOpenAIChatGenerationTransporting>:
  BrokerAnthropicGenerationTransporting, Sendable
{
  private let transport: Transport

  init(transport: Transport) {
    self.transport = transport
  }

  func stream(
    _ request: BrokerAnthropicMessagesRequest,
    capability: Transport.Capability,
    onEvent: @escaping @Sendable (BrokerOpenAIResponsesEvent) -> Void
  ) async throws -> BrokerOpenAIResponsesCompletion {
    let input = request.input.map { item -> BrokerOpenAIChatCompletionsInput in
      switch item {
      case .message(let role, let text): .message(role: role, text: text)
      case .image(let mediaType, let data): .image(mediaType: mediaType, data: data)
      case .toolUse(let callID, let name, let argumentsJSON):
        .toolUse(callID: callID, name: name, argumentsJSON: argumentsJSON)
      case .toolResult(let callID, let output): .toolResult(callID: callID, output: output)
      }
    }
    let tools = try request.tools.map {
      try BrokerOpenAIResponsesFunctionTool(
        name: $0.name,
        description: $0.description,
        parametersJSON: $0.inputSchemaJSON
      )
    }
    do {
      return try await transport.stream(
        try BrokerOpenAIChatCompletionsRequest(
          model: request.model,
          input: input,
          tools: tools,
          maxOutputTokens: request.maxOutputTokens
        ),
        capability: capability,
        onEvent: onEvent
      )
    } catch let error as BrokerOpenAIChatCompletionsTransportError {
      throw Self.map(error)
    }
  }

  private static func map(
    _ error: BrokerOpenAIChatCompletionsTransportError
  ) -> BrokerAnthropicMessagesTransportError {
    switch error {
    case .cancelled: .cancelled
    case .invalidRequest: .invalidRequest
    case .requestTooLarge: .requestTooLarge
    case .invalidCredential: .invalidCredential
    case .routeUnavailable: .routeUnavailable
    case .deliveryUncertain: .deliveryUncertain
    case .invalidResponse: .invalidResponse
    case .responseTooLarge: .responseTooLarge
    case .authenticationRejected: .authenticationRejected
    case .rateLimited: .rateLimited
    case .providerUnavailable: .providerUnavailable
    case .requestRejected: .requestRejected
    case .contentFiltered: .contentFiltered
    case .providerFailure: .providerFailure
    case .credentialEchoDetected: .credentialEchoDetected
    }
  }
}

protocol BrokerOpenAIChatGenerationTransporting: Sendable {
  associatedtype Capability: Sendable

  func stream(
    _ request: BrokerOpenAIChatCompletionsRequest,
    capability: Capability,
    onEvent: @escaping @Sendable (BrokerOpenAIResponsesEvent) -> Void
  ) async throws -> BrokerOpenAIResponsesCompletion
}

extension BrokerOpenAIChatCompletionsTransport: BrokerOpenAIChatGenerationTransporting {
  typealias Capability = Route.Capability
}
