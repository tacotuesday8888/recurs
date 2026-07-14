import Foundation
import RecursBrokerCore

enum BrokerAnthropicMessagesTransportError:
  Error, Sendable, Equatable, CustomStringConvertible, LocalizedError
{
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

  private var fixedDescription: String {
    switch self {
    case .cancelled:
      "Recurs stopped waiting for Anthropic; delivery or billing may still have occurred."
    case .invalidRequest: "The Anthropic Messages request is invalid."
    case .requestTooLarge: "The Anthropic Messages request exceeded its size limit."
    case .invalidCredential: "The Anthropic credential is invalid."
    case .routeUnavailable: "The Anthropic Messages route is unavailable."
    case .deliveryUncertain:
      "The Anthropic request did not complete; delivery is uncertain and usage or billing may have occurred."
    case .invalidResponse:
      "Anthropic returned an invalid Messages stream; usage or billing may have occurred."
    case .responseTooLarge:
      "Anthropic returned an oversized Messages stream; usage or billing may have occurred."
    case .authenticationRejected:
      "Anthropic received the request and rejected the credential; generation billing is not expected."
    case .rateLimited:
      "Anthropic received and rate-limited the request; generation billing is not expected."
    case .providerUnavailable:
      "Anthropic became unavailable after request delivery; usage or billing may have occurred."
    case .requestRejected:
      "Anthropic received and rejected the request; generation billing is not expected."
    case .contentFiltered:
      "Anthropic stopped the delivered response because of its content policy; usage or billing may have occurred."
    case .providerFailure:
      "Anthropic failed to complete the delivered response; usage or billing may have occurred."
    case .credentialEchoDetected:
      "Anthropic returned credential material in the delivered response; usage or billing may have occurred."
    }
  }

  var description: String { fixedDescription }
  var errorDescription: String? { fixedDescription }
}

protocol BrokerAnthropicMessagesNetworkAttempt: Sendable {
  func start()
  func response() async throws -> BrokerOpenAIResponsesCompletion
  func cancel()
}

protocol BrokerAnthropicMessagesNetworking: Sendable {
  func makeAttempt(
    request: URLRequest,
    accumulator: BrokerAnthropicMessagesResponseAccumulator,
    endpoint: BrokerGenerationEndpoint
  ) -> any BrokerAnthropicMessagesNetworkAttempt
}

struct BrokerGenerationEndpoint: Sendable, Equatable {
  let requestURL: URL
  let host: String

  static let anthropic = Self(
    requestURL: URL(string: "https://api.anthropic.com/v1/messages")!,
    host: "api.anthropic.com"
  )
  static let kimiCode = Self(
    requestURL: URL(string: "https://api.kimi.com/coding/v1/chat/completions")!,
    host: "api.kimi.com"
  )
}

private enum BrokerGenerationStreamDecoder {
  case anthropic(BrokerAnthropicMessagesStreamDecoder)
  case openAIChat(BrokerOpenAIChatCompletionsStreamDecoder)

  mutating func receive(_ data: Data) throws -> [BrokerOpenAIResponsesEvent] {
    switch self {
    case .anthropic(var decoder):
      defer { self = .anthropic(decoder) }
      return try decoder.receive(data)
    case .openAIChat(var decoder):
      defer { self = .openAIChat(decoder) }
      return try decoder.receive(data)
    }
  }

  mutating func finish() throws -> BrokerOpenAIResponsesCompletion {
    switch self {
    case .anthropic(var decoder):
      defer { self = .anthropic(decoder) }
      return try decoder.finish()
    case .openAIChat(var decoder):
      defer { self = .openAIChat(decoder) }
      return try decoder.finish()
    }
  }
}

enum BrokerAnthropicMessagesNetworkError: Error, Sendable, Equatable {
  case cancelled
  case transportFailure
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

final class BrokerAnthropicMessagesResponseAccumulator: @unchecked Sendable {
  private struct Head { let statusCode: Int }

  private let lock = NSLock()
  private let deliveryLock = NSRecursiveLock()
  private let rawFilter: StreamingSecretFilter
  private var semanticFilter: BrokerOpenAIResponsesSemanticFilter
  private let onEvent: @Sendable (BrokerOpenAIResponsesEvent) -> Void
  private var decoder: BrokerGenerationStreamDecoder
  private var head: Head?
  private var errorBodyByteCount = 0
  private var terminalError: BrokerAnthropicMessagesNetworkError?
  private var isFinished = false
  private var eventDeliveryAllowed = true

  init(
    rawFilter: StreamingSecretFilter,
    semanticFilter: StreamingSecretFilter,
    openAIChat: Bool = false,
    onEvent: @escaping @Sendable (BrokerOpenAIResponsesEvent) -> Void
  ) {
    self.rawFilter = rawFilter
    self.semanticFilter = BrokerOpenAIResponsesSemanticFilter(filter: semanticFilter)
    decoder =
      openAIChat
      ? .openAIChat(BrokerOpenAIChatCompletionsStreamDecoder())
      : .anthropic(BrokerAnthropicMessagesStreamDecoder())
    self.onEvent = onEvent
  }

  func receiveHead(statusCode: Int, contentType: String?, requestID: String? = nil) throws {
    lock.lock()
    defer { lock.unlock() }
    try requireActiveLocked()
    guard head == nil, (100...599).contains(statusCode) else { throw failLocked(.invalidResponse) }
    do {
      let filteredType = try filteredHeaderLocked(contentType)
      _ = try filteredHeaderLocked(requestID)
      if statusCode == 200, !Self.isEventStream(filteredType) {
        throw BrokerAnthropicMessagesNetworkError.invalidResponse
      }
      head = Head(statusCode: statusCode)
    } catch let error as BrokerAnthropicMessagesNetworkError {
      throw failLocked(error)
    } catch let error as StreamingSecretFilterError {
      throw failLocked(Self.mapFilterError(error))
    } catch {
      throw failLocked(.invalidResponse)
    }
  }

  func receive(_ chunk: Data) throws {
    lock.lock()
    let events: [BrokerOpenAIResponsesEvent]
    do {
      try requireActiveLocked()
      guard let head else { throw BrokerAnthropicMessagesNetworkError.invalidResponse }
      let filtered = try rawFilter.process(chunk)
      if head.statusCode == 200 {
        events = try semanticFilter.process(decoder.receive(filtered))
      } else {
        let (next, overflowed) = errorBodyByteCount.addingReportingOverflow(filtered.count)
        guard !overflowed,
          next <= BrokerOpenAIResponsesResponseAccumulator.maximumErrorBodyByteCount
        else { throw BrokerAnthropicMessagesNetworkError.responseTooLarge }
        errorBodyByteCount = next
        events = []
      }
      lock.unlock()
    } catch let error as BrokerAnthropicMessagesNetworkError {
      let selected = failLocked(error)
      lock.unlock()
      throw selected
    } catch let error as BrokerAnthropicMessagesError {
      let selected = failLocked(Self.mapStreamError(error))
      lock.unlock()
      throw selected
    } catch let error as BrokerOpenAIChatCompletionsError {
      let selected = failLocked(Self.mapChatStreamError(error))
      lock.unlock()
      throw selected
    } catch let error as StreamingSecretFilterError {
      let selected = failLocked(Self.mapFilterError(error))
      lock.unlock()
      throw selected
    } catch {
      let selected = failLocked(.invalidResponse)
      lock.unlock()
      throw selected
    }
    deliver(events)
  }

  func finish() throws -> BrokerOpenAIResponsesCompletion {
    lock.lock()
    let events: [BrokerOpenAIResponsesEvent]
    let completion: BrokerOpenAIResponsesCompletion
    do {
      try requireActiveLocked()
      guard let head else { throw BrokerAnthropicMessagesNetworkError.invalidResponse }
      let tail = try rawFilter.finish()
      if head.statusCode != 200 {
        let (next, overflowed) = errorBodyByteCount.addingReportingOverflow(tail.count)
        guard !overflowed,
          next <= BrokerOpenAIResponsesResponseAccumulator.maximumErrorBodyByteCount
        else { throw BrokerAnthropicMessagesNetworkError.responseTooLarge }
        throw Self.statusError(head.statusCode)
      }
      var selected = try semanticFilter.process(decoder.receive(tail))
      completion = try decoder.finish()
      selected.append(contentsOf: try semanticFilter.finish(completion: completion))
      events = selected
      isFinished = true
      lock.unlock()
    } catch let error as BrokerAnthropicMessagesNetworkError {
      let selected = failLocked(error)
      lock.unlock()
      throw selected
    } catch let error as BrokerAnthropicMessagesError {
      let selected = failLocked(Self.mapStreamError(error))
      lock.unlock()
      throw selected
    } catch let error as BrokerOpenAIChatCompletionsError {
      let selected = failLocked(Self.mapChatStreamError(error))
      lock.unlock()
      throw selected
    } catch let error as StreamingSecretFilterError {
      let selected = failLocked(Self.mapFilterError(error))
      lock.unlock()
      throw selected
    } catch {
      let selected = failLocked(.invalidResponse)
      lock.unlock()
      throw selected
    }
    deliver(events)
    return completion
  }

  func cancel() {
    deliveryLock.withLock {
      lock.withLock {
        eventDeliveryAllowed = false
        guard terminalError == nil, !isFinished else { return }
        _ = failLocked(.cancelled)
      }
    }
  }

  private func requireActiveLocked() throws {
    if let terminalError { throw terminalError }
    guard !isFinished else { throw BrokerAnthropicMessagesNetworkError.invalidResponse }
  }

  @discardableResult
  private func failLocked(_ error: BrokerAnthropicMessagesNetworkError)
    -> BrokerAnthropicMessagesNetworkError
  {
    if terminalError == nil, !isFinished {
      terminalError = error
      eventDeliveryAllowed = false
      rawFilter.cancel()
      semanticFilter.cancel()
    }
    return terminalError ?? error
  }

  private func deliver(_ events: [BrokerOpenAIResponsesEvent]) {
    for event in events {
      deliveryLock.lock()
      guard lock.withLock({ eventDeliveryAllowed && terminalError == nil }) else {
        deliveryLock.unlock()
        return
      }
      onEvent(event)
      deliveryLock.unlock()
    }
  }

  private func filteredHeaderLocked(_ supplied: String?) throws -> String? {
    guard let supplied else {
      let separator = try rawFilter.process(Data([0]))
      guard separator == Data([0]) else {
        throw BrokerAnthropicMessagesNetworkError.invalidResponse
      }
      return nil
    }
    guard supplied.utf8.count <= BrokerOpenAIResponsesResponseAccumulator.maximumHeaderByteCount
    else { throw BrokerAnthropicMessagesNetworkError.invalidResponse }
    var filtered = try rawFilter.process(Data(supplied.utf8))
    filtered.append(try rawFilter.process(Data([0])))
    guard filtered.last == 0 else { throw BrokerAnthropicMessagesNetworkError.invalidResponse }
    filtered.removeLast()
    guard let result = String(data: filtered, encoding: .utf8) else {
      throw BrokerAnthropicMessagesNetworkError.invalidResponse
    }
    return result
  }

  private static func isEventStream(_ supplied: String?) -> Bool {
    guard let supplied,
      supplied.unicodeScalars.allSatisfy({ $0.value >= 0x20 && $0.value <= 0x7e })
    else { return false }
    return supplied.split(separator: ";", maxSplits: 1)[0]
      .trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "text/event-stream"
  }

  private static func statusError(_ status: Int) -> BrokerAnthropicMessagesNetworkError {
    switch status {
    case 401, 403: .authenticationRejected
    case 429: .rateLimited
    case 500...599: .providerUnavailable
    default: .requestRejected
    }
  }

  private static func mapFilterError(_ error: StreamingSecretFilterError)
    -> BrokerAnthropicMessagesNetworkError
  {
    switch error {
    case .credentialEchoDetected: .credentialEchoDetected
    case .cancelled: .cancelled
    case .emptyPattern, .patternLimitExceeded, .alreadyFinished: .invalidResponse
    }
  }

  private static func mapStreamError(_ error: BrokerAnthropicMessagesError)
    -> BrokerAnthropicMessagesNetworkError
  {
    switch error {
    case .responseTooLarge: .responseTooLarge
    case .authenticationRejected: .authenticationRejected
    case .rateLimited: .rateLimited
    case .providerUnavailable: .providerUnavailable
    case .requestRejected: .requestRejected
    case .contentFiltered: .contentFiltered
    case .providerFailure: .providerFailure
    case .invalidRequest, .requestTooLarge, .invalidStream, .deliveryUncertain: .invalidResponse
    }
  }

  private static func mapChatStreamError(_ error: BrokerOpenAIChatCompletionsError)
    -> BrokerAnthropicMessagesNetworkError
  {
    switch error {
    case .responseTooLarge: .responseTooLarge
    case .contentFiltered: .contentFiltered
    case .providerFailure: .providerFailure
    case .invalidRequest, .requestTooLarge, .invalidStream: .invalidResponse
    }
  }
}

struct BrokerAnthropicMessagesURLSessionNetworking: BrokerAnthropicMessagesNetworking {
  func makeAttempt(
    request: URLRequest,
    accumulator: BrokerAnthropicMessagesResponseAccumulator,
    endpoint: BrokerGenerationEndpoint
  )
    -> any BrokerAnthropicMessagesNetworkAttempt
  {
    BrokerAnthropicMessagesURLSessionAttempt(
      request: request,
      accumulator: accumulator,
      endpoint: endpoint
    )
  }
}

enum BrokerAnthropicMessagesURLPolicy {
  static func challengeDisposition(
    authenticationMethod: String,
    host: String,
    expectedHost: String,
    hasHandledServerTrust: Bool
  ) -> URLSession.AuthChallengeDisposition {
    guard authenticationMethod == NSURLAuthenticationMethodServerTrust,
      host.lowercased() == expectedHost, !hasHandledServerTrust
    else { return .cancelAuthenticationChallenge }
    return .performDefaultHandling
  }
}

private final class BrokerAnthropicMessagesSessionDelegate:
  NSObject, URLSessionDataDelegate, @unchecked Sendable
{
  private let lock = NSLock()
  private let accumulator: BrokerAnthropicMessagesResponseAccumulator
  private let result: BrokerAnthropicMessagesNetworkResult
  private let endpoint: BrokerGenerationEndpoint
  private var handledServerTrust = false

  init(
    accumulator: BrokerAnthropicMessagesResponseAccumulator,
    result: BrokerAnthropicMessagesNetworkResult,
    endpoint: BrokerGenerationEndpoint
  ) {
    self.accumulator = accumulator
    self.result = result
    self.endpoint = endpoint
  }

  func urlSession(
    _ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
    completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void
  ) {
    guard let response = response as? HTTPURLResponse,
      response.url?.absoluteString == endpoint.requestURL.absoluteString
    else {
      fail(.invalidResponse, task: dataTask)
      completionHandler(.cancel)
      return
    }
    do {
      try accumulator.receiveHead(
        statusCode: response.statusCode,
        contentType: response.value(forHTTPHeaderField: "content-type"),
        requestID: response.value(forHTTPHeaderField: "request-id")
      )
      completionHandler(.allow)
    } catch let error as BrokerAnthropicMessagesNetworkError {
      fail(error, task: dataTask)
      completionHandler(.cancel)
    } catch {
      fail(.invalidResponse, task: dataTask)
      completionHandler(.cancel)
    }
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    do { try accumulator.receive(data) } catch let error as BrokerAnthropicMessagesNetworkError {
      fail(error, task: dataTask)
    } catch { fail(.invalidResponse, task: dataTask) }
  }

  func urlSession(
    _ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?
  ) {
    if error != nil {
      result.complete(.failure(.transportFailure))
      return
    }
    do { result.complete(.success(try accumulator.finish())) } catch let error
      as BrokerAnthropicMessagesNetworkError
    { result.complete(.failure(error)) } catch { result.complete(.failure(.invalidResponse)) }
  }

  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void
  ) {
    fail(.invalidResponse, task: task)
    completionHandler(nil)
  }

  func urlSession(
    _ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
    completionHandler:
      @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) { complete(challenge, completionHandler: completionHandler) }

  func urlSession(
    _ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
    completionHandler:
      @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) { complete(challenge, completionHandler: completionHandler) }

  private func complete(
    _ challenge: URLAuthenticationChallenge,
    completionHandler:
      @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    let disposition = lock.withLock {
      let selected = BrokerAnthropicMessagesURLPolicy.challengeDisposition(
        authenticationMethod: challenge.protectionSpace.authenticationMethod,
        host: challenge.protectionSpace.host,
        expectedHost: endpoint.host,
        hasHandledServerTrust: handledServerTrust
      )
      if selected == .performDefaultHandling { handledServerTrust = true }
      return selected
    }
    completionHandler(disposition, nil)
    if disposition != .performDefaultHandling {
      accumulator.cancel()
      result.complete(.failure(.invalidResponse))
    }
  }

  private func fail(_ error: BrokerAnthropicMessagesNetworkError, task: URLSessionTask) {
    accumulator.cancel()
    result.complete(.failure(error))
    task.cancel()
  }
}

private final class BrokerAnthropicMessagesURLSessionAttempt:
  BrokerAnthropicMessagesNetworkAttempt, @unchecked Sendable
{
  private let lock = NSLock()
  private let accumulator: BrokerAnthropicMessagesResponseAccumulator
  private let result = BrokerAnthropicMessagesNetworkResult()
  private let session: URLSession
  private let task: URLSessionDataTask
  private var started = false
  private var cancelled = false

  init(
    request: URLRequest,
    accumulator: BrokerAnthropicMessagesResponseAccumulator,
    endpoint: BrokerGenerationEndpoint
  ) {
    self.accumulator = accumulator
    let result = self.result
    let delegate = BrokerAnthropicMessagesSessionDelegate(
      accumulator: accumulator,
      result: result,
      endpoint: endpoint
    )
    session = URLSession(
      configuration: BrokerOpenAIResponsesURLSessionNetworking.configuration(),
      delegate: delegate,
      delegateQueue: nil
    )
    task = session.dataTask(with: request)
  }

  func start() {
    lock.lock()
    guard !started, !cancelled else {
      lock.unlock()
      return
    }
    started = true
    lock.unlock()
    task.resume()
  }

  func response() async throws -> BrokerOpenAIResponsesCompletion {
    defer { session.finishTasksAndInvalidate() }
    return try await result.value().get()
  }

  func cancel() {
    lock.lock()
    guard !cancelled else {
      lock.unlock()
      return
    }
    cancelled = true
    lock.unlock()
    accumulator.cancel()
    result.complete(.failure(.cancelled))
    task.cancel()
    session.invalidateAndCancel()
  }

  deinit { cancel() }
}

private final class BrokerAnthropicMessagesNetworkResult: @unchecked Sendable {
  typealias Value = Result<BrokerOpenAIResponsesCompletion, BrokerAnthropicMessagesNetworkError>
  private let lock = NSLock()
  private var stored: Value?
  private var waiters: [CheckedContinuation<Value, Never>] = []

  func value() async -> Value {
    await withCheckedContinuation { continuation in
      lock.lock()
      if let stored {
        lock.unlock()
        continuation.resume(returning: stored)
      } else {
        waiters.append(continuation)
        lock.unlock()
      }
    }
  }

  func complete(_ value: Value) {
    lock.lock()
    guard stored == nil else {
      lock.unlock()
      return
    }
    stored = value
    let selected = waiters
    waiters.removeAll()
    lock.unlock()
    for waiter in selected { waiter.resume(returning: value) }
  }
}

final class BrokerAnthropicMessagesAttemptBox: @unchecked Sendable {
  private let lock = NSLock()
  private var attempt: (any BrokerAnthropicMessagesNetworkAttempt)?
  private var cancelled = false

  func install(_ selected: any BrokerAnthropicMessagesNetworkAttempt) -> Bool {
    lock.lock()
    guard attempt == nil, !cancelled else {
      lock.unlock()
      selected.cancel()
      return false
    }
    attempt = selected
    lock.unlock()
    return true
  }

  func response() async throws -> BrokerOpenAIResponsesCompletion {
    guard let attempt = lock.withLock({ attempt }) else {
      throw BrokerAnthropicMessagesNetworkError.invalidResponse
    }
    return try await attempt.response()
  }

  func cancel() {
    lock.lock()
    cancelled = true
    let selected = attempt
    lock.unlock()
    selected?.cancel()
  }
}

struct BrokerAnthropicMessagesPreparedAttempt: Sendable {
  let attempt: any BrokerAnthropicMessagesNetworkAttempt
}

struct BrokerAnthropicMessagesTransport<
  Route: BrokerOpenAIResponsesRouteAuthorizing,
  Network: BrokerAnthropicMessagesNetworking
>: Sendable {
  static var maximumCredentialByteCount: Int { 16_384 }
  private let route: Route
  private let network: Network

  init(route: Route, network: Network) {
    self.route = route
    self.network = network
  }

  func stream(
    _ request: BrokerAnthropicMessagesRequest,
    capability: Route.Capability,
    onEvent: @escaping @Sendable (BrokerOpenAIResponsesEvent) -> Void = { _ in }
  ) async throws(BrokerAnthropicMessagesTransportError) -> BrokerOpenAIResponsesCompletion {
    let body: Data
    do { body = try request.encodedBody() } catch BrokerAnthropicMessagesError.requestTooLarge {
      throw .requestTooLarge
    } catch { throw .invalidRequest }
    let requestBytes = UInt64(body.count)
    let attemptBox = BrokerAnthropicMessagesAttemptBox()
    do {
      return try await withTaskCancellationHandler {
        try Task.checkCancellation()
        let reservation = try await route.reserveCredentialUse(
          capability, expectedScope: .run, expectedProviderBinding: .anthropic,
          requestBytes: requestBytes)
        try Task.checkCancellation()
        let delivery = try await route.startCredentialUse(
          reservation, capability: capability, expectedScope: .run,
          expectedProviderBinding: .anthropic, requestBytes: requestBytes,
          prepare: {
            credential -> CredentialUsePreparation<BrokerAnthropicMessagesPreparedAttempt> in
            guard
              let prepared = Self.prepare(
                credential: credential, body: body, network: network,
                attemptBox: attemptBox, onEvent: onEvent)
            else { return .rejected }
            return .prepared(prepared)
          },
          start: { (prepared: BrokerAnthropicMessagesPreparedAttempt) in prepared.attempt.start() }
        )
        guard delivery == .requestStarted else {
          attemptBox.cancel()
          throw BrokerAnthropicMessagesTransportError.deliveryUncertain
        }
        let completion = try await attemptBox.response()
        try Task.checkCancellation()
        return completion
      } onCancel: {
        attemptBox.cancel()
      }
    } catch let error as BrokerAnthropicMessagesTransportError {
      if Task.isCancelled { throw .cancelled }
      throw error
    } catch let error as BrokerProviderRouteAuthorityError {
      if Task.isCancelled { throw .cancelled }
      if error == .invalidCredential { throw .invalidCredential }
      throw .routeUnavailable
    } catch let error as BrokerAnthropicMessagesNetworkError {
      if Task.isCancelled { throw .cancelled }
      throw Self.mapNetworkError(error)
    } catch is CancellationError { throw .cancelled } catch { throw .routeUnavailable }
  }

  private static func prepare(
    credential: UnsafeRawBufferPointer,
    body: Data,
    network: Network,
    attemptBox: BrokerAnthropicMessagesAttemptBox,
    onEvent: @escaping @Sendable (BrokerOpenAIResponsesEvent) -> Void
  ) -> BrokerAnthropicMessagesPreparedAttempt? {
    guard (1...maximumCredentialByteCount).contains(credential.count),
      credential.allSatisfy({ (0x21...0x7e).contains($0) })
    else { return nil }
    let secret = Data(credential)
    guard let rawFilter = try? StreamingSecretFilter(patterns: [SecretBytes(secret)]),
      let semanticFilter = try? StreamingSecretFilter(patterns: [SecretBytes(secret)])
    else { return nil }
    var request = URLRequest(
      url: BrokerGenerationEndpoint.anthropic.requestURL,
      cachePolicy: .reloadIgnoringLocalCacheData,
      timeoutInterval: 30)
    request.httpMethod = "POST"
    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
    request.setValue(String(decoding: credential, as: UTF8.self), forHTTPHeaderField: "x-api-key")
    request.httpBody = body
    let attempt = network.makeAttempt(
      request: request,
      accumulator: BrokerAnthropicMessagesResponseAccumulator(
        rawFilter: rawFilter, semanticFilter: semanticFilter, onEvent: onEvent),
      endpoint: .anthropic
    )
    guard attemptBox.install(attempt) else { return nil }
    return BrokerAnthropicMessagesPreparedAttempt(attempt: attempt)
  }

  private static func mapNetworkError(_ error: BrokerAnthropicMessagesNetworkError)
    -> BrokerAnthropicMessagesTransportError
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
