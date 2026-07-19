import Foundation
import Testing

@testable import RecursBrokerCore
@testable import RecursBrokerService

@Suite(.serialized)
struct BrokerOpenAIResponsesTransportTests {
  private typealias Subject = BrokerOpenAIResponsesTransport<ResponsesRoute, ResponsesNetwork>

  @Test
  func authorizesAndStartsOneExactFixedResponsesRequest() async throws {
    let route = ResponsesRoute(credential: Data("sk-private".utf8))
    let network = ResponsesNetwork(script: .response(chunks: [Data(validTextStream.utf8)]))
    let request = try makeRequest()
    let recorder = EventRecorder()

    let completion = try await Subject(route: route, network: network).stream(
      request,
      capability: ResponsesCapability(),
      onEvent: { recorder.append($0) }
    )

    #expect(completion.responseID == "resp_transport")
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
          )
        ),
        .done(.complete),
      ])
    let requests = network.requests
    #expect(requests.count == 1)
    let sent = try #require(requests.first)
    #expect(sent.url?.absoluteString == "https://api.openai.com/v1/responses")
    #expect(sent.httpMethod == "POST")
    #expect(sent.value(forHTTPHeaderField: "Accept") == "text/event-stream")
    #expect(sent.value(forHTTPHeaderField: "Content-Type") == "application/json")
    #expect(sent.value(forHTTPHeaderField: "Authorization") == "Bearer sk-private")
    #expect(sent.allHTTPHeaderFields?.count == 3)
    #expect(sent.cachePolicy == .reloadIgnoringLocalCacheData)
    #expect(sent.timeoutInterval == 30)
    let body = try #require(sent.httpBody)
    let invocations = await route.invocations
    #expect(
      invocations == [
        ResponsesRouteInvocation(phase: .reserve, requestBytes: UInt64(body.count)),
        ResponsesRouteInvocation(phase: .start, requestBytes: UInt64(body.count)),
      ])
    #expect(network.attempts.count == 1)
    #expect(network.attempts[0].startCount == 1)
  }

  @Test
  func rejectsCredentialsAndEchoesBeforeReturningProviderData() async throws {
    for credential in [Data(), Data("line\nbreak".utf8), Data([0xff])] {
      let network = ResponsesNetwork(script: .response(chunks: [Data(validTextStream.utf8)]))
      await #expect(throws: BrokerOpenAIResponsesError.invalidCredential) {
        _ = try await Subject(
          route: ResponsesRoute(credential: credential),
          network: network
        ).stream(try makeRequest(), capability: ResponsesCapability())
      }
      #expect(network.requests.isEmpty)
    }

    let secret = "sk-echo-secret"
    let echoed = validTextStream.replacingOccurrences(of: "ok", with: secret)
    let network = ResponsesNetwork(
      script: .response(chunks: [
        Data(echoed.utf8.prefix(echoed.utf8.count / 2)),
        Data(echoed.utf8.dropFirst(echoed.utf8.count / 2)),
      ])
    )
    await #expect(throws: BrokerOpenAIResponsesError.credentialEchoDetected) {
      _ = try await Subject(
        route: ResponsesRoute(credential: Data(secret.utf8)),
        network: network
      ).stream(try makeRequest(), capability: ResponsesCapability())
    }
  }

  @Test
  func blocksUnicodeEscapedAndCrossChannelCredentialEchoesBeforeExposure() async throws {
    let secret = "sk-secret"
    let escapedSecret = #"\u0073\u006b\u002d\u0073\u0065\u0063\u0072\u0065\u0074"#
    let escaped = validTextStream.replacingOccurrences(
      of: #""ok""#,
      with: "\"\(escapedSecret)\""
    )
    let crossChannel = [
      event(
        "response.created",
        #"{"type":"response.created","sequence_number":1,"response":{"id":"cross","status":"in_progress","output":[]}}"#
      ),
      event(
        "response.output_item.added",
        #"{"type":"response.output_item.added","sequence_number":2,"output_index":0,"item":{"id":"msg","type":"message","status":"in_progress","role":"assistant","content":[]}}"#
      ),
      event(
        "response.content_part.added",
        #"{"type":"response.content_part.added","sequence_number":3,"item_id":"msg","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}"#
      ),
      event(
        "response.output_text.delta",
        #"{"type":"response.output_text.delta","sequence_number":4,"item_id":"msg","output_index":0,"content_index":0,"delta":"safe sk-"}"#
      ),
      event(
        "response.output_text.done",
        #"{"type":"response.output_text.done","sequence_number":5,"item_id":"msg","output_index":0,"content_index":0,"text":"safe sk-"}"#
      ),
      event(
        "response.content_part.done",
        #"{"type":"response.content_part.done","sequence_number":6,"item_id":"msg","output_index":0,"content_index":0,"part":{"type":"output_text","text":"safe sk-","annotations":[]}}"#
      ),
      event(
        "response.output_item.done",
        #"{"type":"response.output_item.done","sequence_number":7,"output_index":0,"item":{"id":"msg","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"safe sk-","annotations":[]}]}}"#
      ),
      event(
        "response.output_item.added",
        #"{"type":"response.output_item.added","sequence_number":8,"output_index":1,"item":{"id":"reasoning","type":"reasoning","status":"in_progress","summary":[]}}"#
      ),
      event(
        "response.reasoning_summary_part.added",
        #"{"type":"response.reasoning_summary_part.added","sequence_number":9,"item_id":"reasoning","output_index":1,"summary_index":0,"part":{"type":"summary_text","text":""}}"#
      ),
      event(
        "response.reasoning_summary_text.delta",
        #"{"type":"response.reasoning_summary_text.delta","sequence_number":10,"item_id":"reasoning","output_index":1,"summary_index":0,"delta":"secret"}"#
      ),
    ].joined()

    for stream in [escaped, crossChannel] {
      let recorder = EventRecorder()
      let network = ResponsesNetwork(script: .response(chunks: [Data(stream.utf8)]))
      await #expect(throws: BrokerOpenAIResponsesError.credentialEchoDetected) {
        _ = try await Subject(
          route: ResponsesRoute(credential: Data(secret.utf8)),
          network: network
        ).stream(
          try makeRequest(),
          capability: ResponsesCapability(),
          onEvent: recorder.append
        )
      }
      #expect(!exposedText(in: recorder.events).contains(secret))
    }
  }

  @Test
  func blocksUnicodeEscapedCredentialInReturnedResponseID() async throws {
    let secret = "sk-secret"
    let escapedSecret = #"\u0073\u006b\u002d\u0073\u0065\u0063\u0072\u0065\u0074"#
    let stream = validTextStream.replacingOccurrences(of: "resp_transport", with: escapedSecret)
    let recorder = EventRecorder()

    await #expect(throws: BrokerOpenAIResponsesError.credentialEchoDetected) {
      _ = try await Subject(
        route: ResponsesRoute(credential: Data(secret.utf8)),
        network: ResponsesNetwork(script: .response(chunks: [Data(stream.utf8)]))
      ).stream(
        try makeRequest(),
        capability: ResponsesCapability(),
        onEvent: recorder.append
      )
    }
    #expect(!exposedText(in: recorder.events).contains(secret))
  }

  @Test
  func blocksSemanticToolAndPrivateOutputEchoesBeforeCallbacksOrCompletion() async throws {
    let secret = "sk-secret"
    let escapedSecret = #"\u0073\u006b\u002d\u0073\u0065\u0063\u0072\u0065\u0074"#
    let escapedArguments = #"{"value":"\u0073\u006b\u002d\u0073\u0065\u0063\u0072\u0065\u0074"}"#
    let encodedArguments = try jsonString(escapedArguments)
    let toolAdded =
      #"{"id":"call","type":"function_call","status":"in_progress","call_id":"call_1","name":"tool","arguments":""}"#
    let toolDone =
      #"{"id":"call","type":"function_call","status":"completed","call_id":"call_1","name":"tool","arguments":\#(encodedArguments)}"#
    let toolStream = [
      event(
        "response.created",
        #"{"type":"response.created","sequence_number":1,"response":{"id":"tool","status":"in_progress","output":[]}}"#
      ),
      event(
        "response.output_item.added",
        #"{"type":"response.output_item.added","sequence_number":2,"output_index":0,"item":\#(toolAdded)}"#
      ),
      event(
        "response.function_call_arguments.delta",
        #"{"type":"response.function_call_arguments.delta","sequence_number":3,"item_id":"call","output_index":0,"delta":\#(encodedArguments)}"#
      ),
      event(
        "response.function_call_arguments.done",
        #"{"type":"response.function_call_arguments.done","sequence_number":4,"item_id":"call","output_index":0,"name":"tool","arguments":\#(encodedArguments)}"#
      ),
      event(
        "response.output_item.done",
        #"{"type":"response.output_item.done","sequence_number":5,"output_index":0,"item":\#(toolDone)}"#
      ),
      event(
        "response.completed",
        #"{"type":"response.completed","sequence_number":6,"response":{"id":"tool","status":"completed","output":[\#(toolDone)]}}"#
      ),
    ].joined()

    let privateDone =
      #"{"id":"reasoning","type":"reasoning","status":"completed","summary":[],"encrypted_content":"\#(escapedSecret)"}"#
    let privateStream = [
      event(
        "response.created",
        #"{"type":"response.created","sequence_number":1,"response":{"id":"private","status":"in_progress","output":[]}}"#
      ),
      event(
        "response.output_item.added",
        #"{"type":"response.output_item.added","sequence_number":2,"output_index":0,"item":{"id":"reasoning","type":"reasoning","status":"in_progress","summary":[]}}"#
      ),
      event(
        "response.output_item.done",
        #"{"type":"response.output_item.done","sequence_number":3,"output_index":0,"item":\#(privateDone)}"#
      ),
      event(
        "response.completed",
        #"{"type":"response.completed","sequence_number":4,"response":{"id":"private","status":"completed","output":[\#(privateDone)]}}"#
      ),
    ].joined()

    let splitArguments = try jsonString(#"{"value":"sk-"}"#)
    let splitToolDone =
      #"{"id":"call","type":"function_call","status":"completed","call_id":"call_1","name":"tool","arguments":\#(splitArguments)}"#
    let splitReasoningDone =
      #"{"id":"reasoning","type":"reasoning","status":"completed","summary":[],"encrypted_content":"secret"}"#
    let splitStream = [
      event(
        "response.created",
        #"{"type":"response.created","sequence_number":1,"response":{"id":"split","status":"in_progress","output":[]}}"#
      ),
      event(
        "response.output_item.added",
        #"{"type":"response.output_item.added","sequence_number":2,"output_index":0,"item":\#(toolAdded)}"#
      ),
      event(
        "response.function_call_arguments.delta",
        #"{"type":"response.function_call_arguments.delta","sequence_number":3,"item_id":"call","output_index":0,"delta":\#(splitArguments)}"#
      ),
      event(
        "response.function_call_arguments.done",
        #"{"type":"response.function_call_arguments.done","sequence_number":4,"item_id":"call","output_index":0,"name":"tool","arguments":\#(splitArguments)}"#
      ),
      event(
        "response.output_item.done",
        #"{"type":"response.output_item.done","sequence_number":5,"output_index":0,"item":\#(splitToolDone)}"#
      ),
      event(
        "response.output_item.added",
        #"{"type":"response.output_item.added","sequence_number":6,"output_index":1,"item":{"id":"reasoning","type":"reasoning","status":"in_progress","summary":[]}}"#
      ),
      event(
        "response.output_item.done",
        #"{"type":"response.output_item.done","sequence_number":7,"output_index":1,"item":\#(splitReasoningDone)}"#
      ),
      event(
        "response.completed",
        #"{"type":"response.completed","sequence_number":8,"response":{"id":"split","status":"completed","output":[\#(splitToolDone),\#(splitReasoningDone)]}}"#
      ),
    ].joined()

    for stream in [toolStream, privateStream, splitStream] {
      let recorder = EventRecorder()
      let network = ResponsesNetwork(script: .response(chunks: [Data(stream.utf8)]))
      await #expect(throws: BrokerOpenAIResponsesError.credentialEchoDetected) {
        _ = try await Subject(
          route: ResponsesRoute(credential: Data(secret.utf8)),
          network: network
        ).stream(
          try makeRequest(),
          capability: ResponsesCapability(),
          onEvent: recorder.append
        )
      }
      #expect(recorder.events.isEmpty)
    }
  }

  @Test
  func preservesWholeUnicodeSegmentsAcrossSemanticLookbehindRelease() async throws {
    let stream = validTextStream.replacingOccurrences(
      of: #""ok""#,
      with: #""🙂sk""#
    )
    let recorder = EventRecorder()
    let completion = try await Subject(
      route: ResponsesRoute(credential: Data("sk-secret".utf8)),
      network: ResponsesNetwork(script: .response(chunks: [Data(stream.utf8)]))
    ).stream(
      try makeRequest(),
      capability: ResponsesCapability(),
      onEvent: recorder.append
    )

    #expect(completion.outcome == .output)
    #expect(exposedText(in: recorder.events) == "🙂sk")
    #expect(recorder.events.last == .done(.complete))
  }

  @Test
  func mapsStatusAndDeliveryUncertainFailuresWithoutRetry() async throws {
    let cases: [(Int, BrokerOpenAIResponsesError)] = [
      (401, .authenticationRejected),
      (429, .rateLimited),
      (500, .providerUnavailable),
      (400, .requestRejected),
    ]
    for (status, expected) in cases {
      let network = ResponsesNetwork(script: .status(status))
      await #expect(throws: expected) {
        _ = try await Subject(
          route: ResponsesRoute(credential: Data("key".utf8)),
          network: network
        ).stream(try makeRequest(), capability: ResponsesCapability())
      }
      #expect(network.requests.count == 1)
      #expect(network.attempts.count == 1)
    }

    let failed = ResponsesNetwork(script: .failure(.transportFailure))
    await #expect(throws: BrokerOpenAIResponsesError.deliveryUncertain) {
      _ = try await Subject(
        route: ResponsesRoute(credential: Data("key".utf8)),
        network: failed
      ).stream(try makeRequest(), capability: ResponsesCapability())
    }
    #expect(failed.attempts.count == 1)
    #expect(failed.attempts[0].startCount == 1)
  }

  @Test
  func postStartFailureDescriptionsDisclosePossibleUsageOrBilling() {
    let postStartFailures: [BrokerOpenAIResponsesError] = [
      .deliveryUncertain,
      .invalidResponse,
      .responseTooLarge,
      .providerUnavailable,
      .contentFiltered,
      .providerFailure,
      .credentialEchoDetected,
    ]
    for error in postStartFailures {
      #expect(error.description.contains("billing may have occurred"))
    }
  }

  @Test
  func cancellationCancelsTheOnlyStartedAttempt() async throws {
    let network = ResponsesNetwork(script: .suspended)
    let task = Task {
      try await Subject(
        route: ResponsesRoute(credential: Data("key".utf8)),
        network: network
      ).stream(try makeRequest(), capability: ResponsesCapability())
    }
    let attempt = await network.waitForAttempt()
    await attempt.waitUntilStarted()
    task.cancel()
    await #expect(throws: BrokerOpenAIResponsesError.cancelled) { _ = try await task.value }
    #expect(attempt.isCancelled)
    #expect(network.attempts.count == 1)
  }

  @Test
  func productionPolicyHasNoAmbientStateOrRedirectAllowance() {
    let configuration = BrokerOpenAIResponsesURLSessionNetworking.configuration()
    #expect(configuration.requestCachePolicy == .reloadIgnoringLocalCacheData)
    #expect(configuration.urlCache == nil)
    #expect(configuration.httpCookieStorage == nil)
    #expect(configuration.httpShouldSetCookies == false)
    #expect(configuration.urlCredentialStorage == nil)
    #expect(configuration.waitsForConnectivity == false)
    #expect(configuration.httpMaximumConnectionsPerHost == 1)
    #expect(
      BrokerOpenAIResponsesURLPolicy.accepts(URL(string: "https://api.openai.com/v1/responses")))
    #expect(
      !BrokerOpenAIResponsesURLPolicy.accepts(URL(string: "https://api.openai.com/v1/responses/")))
    #expect(
      BrokerOpenAIResponsesURLPolicy.challengeDisposition(
        authenticationMethod: NSURLAuthenticationMethodServerTrust,
        host: "api.openai.com",
        hasHandledServerTrust: false
      ) == .performDefaultHandling
    )
    #expect(
      BrokerOpenAIResponsesURLPolicy.challengeDisposition(
        authenticationMethod: NSURLAuthenticationMethodHTTPBasic,
        host: "api.openai.com",
        hasHandledServerTrust: false
      ) == .cancelAuthenticationChallenge
    )
  }

  @Test
  func cancellationFencesEventsAlreadyDecodedFromTheSameChunk() throws {
    let recorder = EventRecorder()
    let box = AccumulatorBox()
    let rawFilter = try StreamingSecretFilter(
      patterns: [SecretBytes(Data("not-present".utf8))]
    )
    let semanticFilter = try StreamingSecretFilter(
      patterns: [SecretBytes(Data("not-present".utf8))]
    )
    let accumulator = BrokerOpenAIResponsesResponseAccumulator(
      rawFilter: rawFilter,
      semanticFilter: semanticFilter,
      onEvent: { event in
        recorder.append(event)
        box.cancel()
      }
    )
    box.install(accumulator)
    try accumulator.receiveHead(statusCode: 200, contentType: "text/event-stream")
    try accumulator.receive(Data(validTextStream.utf8))
    #expect(recorder.events == [.textDelta("ok")])
    #expect(throws: BrokerOpenAIResponsesNetworkError.cancelled) {
      _ = try accumulator.finish()
    }
  }

  private func makeRequest() throws -> BrokerOpenAIResponsesRequest {
    try BrokerOpenAIResponsesRequest(
      model: "gpt-test",
      input: [.message(role: .user, text: "hello")],
      tools: [],
      maxOutputTokens: 128
    )
  }

  private func event(_ name: String, _ json: String) -> String {
    "event: \(name)\ndata: \(json)\n\n"
  }

  private func jsonString(_ value: String) throws -> String {
    let encoded = try JSONSerialization.data(withJSONObject: [value])
    let array = try #require(String(data: encoded, encoding: .utf8))
    return String(array.dropFirst().dropLast())
  }

  private func exposedText(in events: [BrokerOpenAIResponsesEvent]) -> String {
    events.reduce(into: "") { result, event in
      switch event {
      case .textDelta(let value), .reasoningDelta(let value), .refusalDelta(let value):
        result += value
      case .toolCall(let call):
        result += String(decoding: call.argumentsJSON, as: UTF8.self)
      case .usage, .done:
        break
      }
    }
  }
}

private final class EventRecorder: @unchecked Sendable {
  private let lock = NSLock()
  private var stored: [BrokerOpenAIResponsesEvent] = []
  var events: [BrokerOpenAIResponsesEvent] { lock.withLock { stored } }
  func append(_ event: BrokerOpenAIResponsesEvent) { lock.withLock { stored.append(event) } }
}

private final class AccumulatorBox: @unchecked Sendable {
  private let lock = NSLock()
  private var accumulator: BrokerOpenAIResponsesResponseAccumulator?
  func install(_ selected: BrokerOpenAIResponsesResponseAccumulator) {
    lock.withLock { accumulator = selected }
  }
  func cancel() { lock.withLock { accumulator }?.cancel() }
}

private struct ResponsesCapability: Sendable {}
private struct ResponsesReservation: Sendable {}

private struct ResponsesRouteInvocation: Sendable, Equatable {
  enum Phase: Sendable, Equatable { case reserve, start }
  let phase: Phase
  let requestBytes: UInt64
}

private actor ResponsesRoute: BrokerOpenAIResponsesRouteAuthorizing {
  typealias Capability = ResponsesCapability
  typealias Reservation = ResponsesReservation

  private let credential: Data
  private(set) var invocations: [ResponsesRouteInvocation] = []

  init(credential: Data) { self.credential = credential }

  func reserveCredentialUse(
    _ handle: ResponsesCapability,
    expectedScope: BrokerProviderRouteScope,
    expectedProviderBinding: ProviderProfileBinding,
    requestBytes: UInt64
  ) async throws -> ResponsesReservation {
    #expect(expectedScope == .run)
    #expect(expectedProviderBinding == .openAI)
    invocations.append(.init(phase: .reserve, requestBytes: requestBytes))
    return ResponsesReservation()
  }

  func startCredentialUse<Prepared: Sendable>(
    _ reservation: ResponsesReservation,
    capability handle: ResponsesCapability,
    expectedScope: BrokerProviderRouteScope,
    expectedProviderBinding: ProviderProfileBinding,
    requestBytes: UInt64,
    prepare: @Sendable (UnsafeRawBufferPointer) -> CredentialUsePreparation<Prepared>,
    start: @Sendable (Prepared) -> Void
  ) async throws -> DeliveryState {
    #expect(expectedScope == .run)
    #expect(expectedProviderBinding == .openAI)
    invocations.append(.init(phase: .start, requestBytes: requestBytes))
    switch credential.withUnsafeBytes(prepare) {
    case .prepared(let prepared):
      start(prepared)
      return .requestStarted
    case .rejected:
      throw BrokerProviderRouteAuthorityError.invalidCredential
    }
  }
}

private final class ResponsesNetwork: BrokerOpenAIResponsesNetworking, @unchecked Sendable {
  private let lock = NSLock()
  private let script: ResponsesNetworkScript
  private var storedRequests: [URLRequest] = []
  private var storedAttempts: [ResponsesAttempt] = []
  private var waiters: [CheckedContinuation<ResponsesAttempt, Never>] = []

  init(script: ResponsesNetworkScript) { self.script = script }
  var requests: [URLRequest] { lock.withLock { storedRequests } }
  var attempts: [ResponsesAttempt] { lock.withLock { storedAttempts } }

  func makeAttempt(
    request: URLRequest,
    accumulator: BrokerOpenAIResponsesResponseAccumulator
  ) -> any BrokerOpenAIResponsesNetworkAttempt {
    let attempt = ResponsesAttempt(script: script, accumulator: accumulator)
    lock.lock()
    storedRequests.append(request)
    storedAttempts.append(attempt)
    let selected = waiters
    waiters.removeAll()
    lock.unlock()
    for waiter in selected {
      waiter.resume(returning: attempt)
    }
    return attempt
  }

  func waitForAttempt() async -> ResponsesAttempt {
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

private enum ResponsesNetworkScript: Sendable {
  case response(chunks: [Data])
  case status(Int)
  case failure(BrokerOpenAIResponsesNetworkError)
  case suspended
}

private final class ResponsesAttempt: BrokerOpenAIResponsesNetworkAttempt, @unchecked Sendable {
  private let lock = NSLock()
  private let script: ResponsesNetworkScript
  private let accumulator: BrokerOpenAIResponsesResponseAccumulator
  private var starts = 0
  private var cancelled = false
  private var startWaiters: [CheckedContinuation<Void, Never>] = []
  private var responseWaiter: CheckedContinuation<Void, Never>?

  init(script: ResponsesNetworkScript, accumulator: BrokerOpenAIResponsesResponseAccumulator) {
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
    for waiter in selected {
      waiter.resume()
    }
  }

  func response() async throws -> BrokerOpenAIResponsesCompletion {
    guard startCount == 1 else { throw BrokerOpenAIResponsesNetworkError.invalidResponse }
    switch script {
    case .response(let chunks):
      try accumulator.receiveHead(statusCode: 200, contentType: "text/event-stream")
      for chunk in chunks { try accumulator.receive(chunk) }
      return try accumulator.finish()
    case .status(let status):
      try accumulator.receiveHead(statusCode: status, contentType: "application/json")
      try accumulator.receive(Data(#"{"error":{"message":"redacted"}}"#.utf8))
      return try accumulator.finish()
    case .failure(let error):
      throw error
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
      throw BrokerOpenAIResponsesNetworkError.cancelled
    }
  }

  func cancel() {
    lock.lock()
    guard !cancelled else {
      lock.unlock()
      return
    }
    cancelled = true
    let selected = responseWaiter
    responseWaiter = nil
    lock.unlock()
    accumulator.cancel()
    selected?.resume()
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

private let validTextStream: String = {
  let added =
    #"{"id":"msg_t","type":"message","status":"in_progress","role":"assistant","content":[]}"#
  let done =
    #"{"id":"msg_t","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"ok","annotations":[]}] }"#
  func event(_ name: String, _ json: String) -> String { "event: \(name)\ndata: \(json)\n\n" }
  return [
    event(
      "response.created",
      #"{"type":"response.created","sequence_number":1,"response":{"id":"resp_transport","status":"in_progress","output":[]}}"#
    ),
    event(
      "response.output_item.added",
      #"{"type":"response.output_item.added","sequence_number":2,"output_index":0,"item":\#(added)}"#
    ),
    event(
      "response.content_part.added",
      #"{"type":"response.content_part.added","sequence_number":3,"item_id":"msg_t","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}"#
    ),
    event(
      "response.output_text.delta",
      #"{"type":"response.output_text.delta","sequence_number":4,"item_id":"msg_t","output_index":0,"content_index":0,"delta":"ok"}"#
    ),
    event(
      "response.output_text.done",
      #"{"type":"response.output_text.done","sequence_number":5,"item_id":"msg_t","output_index":0,"content_index":0,"text":"ok"}"#
    ),
    event(
      "response.content_part.done",
      #"{"type":"response.content_part.done","sequence_number":6,"item_id":"msg_t","output_index":0,"content_index":0,"part":{"type":"output_text","text":"ok","annotations":[]}}"#
    ),
    event(
      "response.output_item.done",
      #"{"type":"response.output_item.done","sequence_number":7,"output_index":0,"item":\#(done)}"#),
    event(
      "response.completed",
      #"{"type":"response.completed","sequence_number":8,"response":{"id":"resp_transport","status":"completed","output":[\#(done)],"usage":{"input_tokens":2,"output_tokens":1,"total_tokens":3,"input_tokens_details":{"cached_tokens":0},"output_tokens_details":{"reasoning_tokens":0}}}}"#
    ),
  ].joined()
}()
