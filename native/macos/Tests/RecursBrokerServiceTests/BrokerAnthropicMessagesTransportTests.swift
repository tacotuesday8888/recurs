import Foundation
import Testing

@testable import RecursBrokerCore
@testable import RecursBrokerService

@Suite(.serialized)
struct BrokerAnthropicMessagesTransportTests {
  private typealias Subject = BrokerAnthropicMessagesTransport<AnthropicRoute, AnthropicNetwork>

  @Test
  func authorizesAndStartsOneExactFixedMessagesRequest() async throws {
    let route = AnthropicRoute(credential: Data("sk-ant-private".utf8))
    let network = AnthropicNetwork(script: .response(Data(validAnthropicStream.utf8)))
    let recorder = AnthropicEventRecorder()

    let completion = try await Subject(route: route, network: network).stream(
      try request(),
      capability: AnthropicCapability(),
      onEvent: recorder.append
    )

    #expect(completion.responseID == "msg_transport")
    #expect(
      recorder.events == [
        .textDelta("ok"),
        .usage(
          BrokerOpenAIResponsesUsage(
            inputTokens: 2,
            outputTokens: 1,
            totalTokens: 3,
            cachedInputTokens: 0,
            cacheWriteTokens: nil,
            reasoningTokens: 0
          )),
        .done(.complete),
      ])
    let sent = try #require(network.requests.first)
    #expect(sent.url?.absoluteString == "https://api.anthropic.com/v1/messages")
    #expect(sent.httpMethod == "POST")
    #expect(sent.value(forHTTPHeaderField: "Accept") == "text/event-stream")
    #expect(sent.value(forHTTPHeaderField: "Content-Type") == "application/json")
    #expect(sent.value(forHTTPHeaderField: "anthropic-version") == "2023-06-01")
    #expect(sent.value(forHTTPHeaderField: "x-api-key") == "sk-ant-private")
    #expect(sent.allHTTPHeaderFields?.count == 4)
    #expect(await route.bindings == [.anthropic, .anthropic])
    #expect(network.attempts.first?.startCount == 1)
  }

  @Test
  func mapsProviderStatusesWithoutExposingBodies() async throws {
    for (status, expected) in [
      (401, BrokerAnthropicMessagesTransportError.authenticationRejected),
      (403, .authenticationRejected),
      (429, .rateLimited),
      (500, .providerUnavailable),
      (529, .providerUnavailable),
      (400, .requestRejected),
    ] {
      await #expect(throws: expected) {
        _ = try await Subject(
          route: AnthropicRoute(credential: Data("secret".utf8)),
          network: AnthropicNetwork(script: .status(status))
        ).stream(try request(), capability: AnthropicCapability())
      }
    }
  }

  @Test
  func rejectsInvalidCredentialsAndLiteralOrEscapedEchoes() async throws {
    for credential in [Data(), Data("line\nbreak".utf8), Data([0xff])] {
      let network = AnthropicNetwork(script: .response(Data(validAnthropicStream.utf8)))
      await #expect(throws: BrokerAnthropicMessagesTransportError.invalidCredential) {
        _ = try await Subject(
          route: AnthropicRoute(credential: credential), network: network
        ).stream(try request(), capability: AnthropicCapability())
      }
      #expect(network.requests.isEmpty)
    }

    let secret = "sk-ant-secret"
    for stream in [
      validAnthropicStream.replacingOccurrences(of: "ok", with: secret),
      validAnthropicStream.replacingOccurrences(
        of: #""ok""#,
        with: #""\u0073\u006b\u002d\u0061\u006e\u0074\u002d\u0073\u0065\u0063\u0072\u0065\u0074""#
      ),
    ] {
      let recorder = AnthropicEventRecorder()
      await #expect(throws: BrokerAnthropicMessagesTransportError.credentialEchoDetected) {
        _ = try await Subject(
          route: AnthropicRoute(credential: Data(secret.utf8)),
          network: AnthropicNetwork(script: .response(Data(stream.utf8)))
        ).stream(
          try request(), capability: AnthropicCapability(), onEvent: recorder.append)
      }
      #expect(!recorder.text.contains(secret))
    }
  }

  @Test
  func cancellationStopsTheOnlyStartedAttempt() async throws {
    let network = AnthropicNetwork(script: .suspended)
    let task = Task {
      try await Subject(
        route: AnthropicRoute(credential: Data("secret".utf8)), network: network
      ).stream(try request(), capability: AnthropicCapability())
    }
    let attempt = await network.waitForAttempt()
    await attempt.waitUntilStarted()
    task.cancel()
    await #expect(throws: BrokerAnthropicMessagesTransportError.cancelled) {
      _ = try await task.value
    }
    #expect(attempt.isCancelled)
    #expect(network.attempts.count == 1)
  }

  private func request() throws -> BrokerAnthropicMessagesRequest {
    try BrokerAnthropicMessagesRequest(
      model: "claude-test",
      input: [.message(role: .user, text: "hello")],
      tools: [],
      maxOutputTokens: 128
    )
  }
}

private struct AnthropicCapability: Sendable {}
private struct AnthropicReservation: Sendable {}

private actor AnthropicRoute: BrokerOpenAIResponsesRouteAuthorizing {
  typealias Capability = AnthropicCapability
  typealias Reservation = AnthropicReservation
  private let credential: Data
  private(set) var bindings: [ProviderProfileBinding] = []

  init(credential: Data) { self.credential = credential }

  func reserveCredentialUse(
    _ handle: AnthropicCapability,
    expectedScope: BrokerProviderRouteScope,
    expectedProviderBinding: ProviderProfileBinding,
    requestBytes: UInt64
  ) async throws -> AnthropicReservation {
    #expect(expectedScope == .run)
    bindings.append(expectedProviderBinding)
    return AnthropicReservation()
  }

  func startCredentialUse<Prepared: Sendable>(
    _ reservation: AnthropicReservation,
    capability handle: AnthropicCapability,
    expectedScope: BrokerProviderRouteScope,
    expectedProviderBinding: ProviderProfileBinding,
    requestBytes: UInt64,
    prepare: @Sendable (UnsafeRawBufferPointer) -> CredentialUsePreparation<Prepared>,
    start: @Sendable (Prepared) -> Void
  ) async throws -> DeliveryState {
    #expect(expectedScope == .run)
    bindings.append(expectedProviderBinding)
    switch credential.withUnsafeBytes(prepare) {
    case .prepared(let prepared):
      start(prepared)
      return .requestStarted
    case .rejected:
      throw BrokerProviderRouteAuthorityError.invalidCredential
    }
  }
}

private enum AnthropicScript: Sendable {
  case response(Data)
  case status(Int)
  case suspended
}

private final class AnthropicNetwork: BrokerAnthropicMessagesNetworking, @unchecked Sendable {
  private let lock = NSLock()
  private let script: AnthropicScript
  private var storedRequests: [URLRequest] = []
  private var storedAttempts: [AnthropicAttempt] = []
  private var waiters: [CheckedContinuation<AnthropicAttempt, Never>] = []

  init(script: AnthropicScript) { self.script = script }
  var requests: [URLRequest] { lock.withLock { storedRequests } }
  var attempts: [AnthropicAttempt] { lock.withLock { storedAttempts } }

  func makeAttempt(
    request: URLRequest,
    accumulator: BrokerAnthropicMessagesResponseAccumulator
  ) -> any BrokerAnthropicMessagesNetworkAttempt {
    let attempt = AnthropicAttempt(script: script, accumulator: accumulator)
    lock.lock()
    storedRequests.append(request)
    storedAttempts.append(attempt)
    let selected = waiters
    waiters.removeAll()
    lock.unlock()
    for waiter in selected { waiter.resume(returning: attempt) }
    return attempt
  }

  func waitForAttempt() async -> AnthropicAttempt {
    if let attempt = lock.withLock({ storedAttempts.first }) { return attempt }
    return await withCheckedContinuation { continuation in
      lock.lock()
      if let attempt = storedAttempts.first {
        lock.unlock()
        continuation.resume(returning: attempt)
      } else {
        waiters.append(continuation)
        lock.unlock()
      }
    }
  }
}

private final class AnthropicAttempt: BrokerAnthropicMessagesNetworkAttempt, @unchecked Sendable {
  private let lock = NSLock()
  private let script: AnthropicScript
  private let accumulator: BrokerAnthropicMessagesResponseAccumulator
  private var starts = 0
  private var cancelled = false
  private var responseWaiter: CheckedContinuation<Void, Never>?
  private var startWaiters: [CheckedContinuation<Void, Never>] = []

  init(script: AnthropicScript, accumulator: BrokerAnthropicMessagesResponseAccumulator) {
    self.script = script
    self.accumulator = accumulator
  }

  var startCount: Int { lock.withLock { starts } }
  var isCancelled: Bool { lock.withLock { cancelled } }

  func start() {
    lock.lock()
    starts += 1
    let selected = startWaiters
    startWaiters.removeAll()
    lock.unlock()
    for waiter in selected { waiter.resume() }
  }

  func response() async throws -> BrokerOpenAIResponsesCompletion {
    switch script {
    case .response(let body):
      try accumulator.receiveHead(statusCode: 200, contentType: "text/event-stream")
      try accumulator.receive(body)
      return try accumulator.finish()
    case .status(let status):
      try accumulator.receiveHead(statusCode: status, contentType: "application/json")
      try accumulator.receive(Data(#"{"error":{"message":"private"}}"#.utf8))
      return try accumulator.finish()
    case .suspended:
      await withCheckedContinuation { continuation in
        lock.lock()
        if cancelled {
          lock.unlock()
          continuation.resume()
        } else {
          responseWaiter = continuation
          lock.unlock()
        }
      }
      throw BrokerAnthropicMessagesNetworkError.cancelled
    }
  }

  func cancel() {
    lock.lock()
    guard !cancelled else {
      lock.unlock()
      return
    }
    cancelled = true
    let waiter = responseWaiter
    responseWaiter = nil
    lock.unlock()
    accumulator.cancel()
    waiter?.resume()
  }

  func waitUntilStarted() async {
    if startCount > 0 { return }
    await withCheckedContinuation { continuation in
      lock.lock()
      if starts > 0 {
        lock.unlock()
        continuation.resume()
      } else {
        startWaiters.append(continuation)
        lock.unlock()
      }
    }
  }
}

private final class AnthropicEventRecorder: @unchecked Sendable {
  private let lock = NSLock()
  private var stored: [BrokerOpenAIResponsesEvent] = []
  var events: [BrokerOpenAIResponsesEvent] { lock.withLock { stored } }
  var text: String {
    events.reduce(into: "") { result, event in
      if case .textDelta(let value) = event { result += value }
    }
  }
  func append(_ event: BrokerOpenAIResponsesEvent) { lock.withLock { stored.append(event) } }
}

private let validAnthropicStream: String = {
  func event(_ name: String, _ body: String) -> String {
    "event: \(name)\ndata: \(body)\n\n"
  }
  return [
    event(
      "message_start",
      #"{"type":"message_start","message":{"id":"msg_transport","type":"message","role":"assistant","content":[],"model":"claude-test","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":2,"output_tokens":0}}}"#
    ),
    event(
      "content_block_start",
      #"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#),
    event(
      "content_block_delta",
      #"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}"#),
    event("content_block_stop", #"{"type":"content_block_stop","index":0}"#),
    event(
      "message_delta",
      #"{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}"#
    ),
    event("message_stop", #"{"type":"message_stop"}"#),
  ].joined()
}()
