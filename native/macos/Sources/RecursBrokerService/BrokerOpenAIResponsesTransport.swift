import Foundation
import RecursBrokerCore

enum BrokerOpenAIResponsesError:
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
      "Recurs stopped waiting for OpenAI; delivery or billing may still have occurred."
    case .invalidRequest:
      "The OpenAI Responses request is invalid."
    case .requestTooLarge:
      "The OpenAI Responses request exceeded its size limit."
    case .invalidCredential:
      "The OpenAI credential is invalid."
    case .routeUnavailable:
      "The OpenAI Responses route is unavailable."
    case .deliveryUncertain:
      "The OpenAI request did not complete; delivery is uncertain and usage or billing may have occurred."
    case .invalidResponse:
      "OpenAI returned an invalid Responses stream; usage or billing may have occurred."
    case .responseTooLarge:
      "OpenAI returned an oversized Responses stream; usage or billing may have occurred."
    case .authenticationRejected:
      "OpenAI received the request and rejected the credential; generation billing is not expected."
    case .rateLimited:
      "OpenAI received and rate-limited the request; generation billing is not expected."
    case .providerUnavailable:
      "OpenAI became unavailable after request delivery; usage or billing may have occurred."
    case .requestRejected:
      "OpenAI received and rejected the request; generation billing is not expected."
    case .contentFiltered:
      "OpenAI stopped the delivered response because of its content filter; usage or billing may have occurred."
    case .providerFailure:
      "OpenAI failed to complete the delivered response; usage or billing may have occurred."
    case .credentialEchoDetected:
      "OpenAI returned credential material in the delivered response; usage or billing may have occurred."
    }
  }

  var description: String { fixedDescription }
  var errorDescription: String? { fixedDescription }
}

protocol BrokerOpenAIResponsesRouteAuthorizing: Sendable {
  associatedtype Capability: Sendable
  associatedtype Reservation: Sendable

  func reserveCredentialUse(
    _ handle: Capability,
    expectedScope: BrokerProviderRouteScope,
    expectedProviderBinding: ProviderProfileBinding,
    requestBytes: UInt64
  ) async throws -> Reservation

  func startCredentialUse<Prepared: Sendable>(
    _ reservation: Reservation,
    capability handle: Capability,
    expectedScope: BrokerProviderRouteScope,
    expectedProviderBinding: ProviderProfileBinding,
    requestBytes: UInt64,
    prepare: @Sendable (UnsafeRawBufferPointer) -> CredentialUsePreparation<Prepared>,
    start: @Sendable (Prepared) -> Void
  ) async throws -> DeliveryState
}

extension BrokerProviderRouteAuthority: BrokerOpenAIResponsesRouteAuthorizing {}

protocol BrokerOpenAIResponsesNetworkAttempt: Sendable {
  func start()
  func response() async throws -> BrokerOpenAIResponsesCompletion
  func cancel()
}

protocol BrokerOpenAIResponsesNetworking: Sendable {
  func makeAttempt(
    request: URLRequest,
    accumulator: BrokerOpenAIResponsesResponseAccumulator
  ) -> any BrokerOpenAIResponsesNetworkAttempt
}

enum BrokerOpenAIResponsesNetworkError: Error, Sendable, Equatable {
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

private struct BrokerOpenAIResponsesSemanticFilter {
  private enum Visibility {
    case text
    case reasoning
    case refusal
    case silent
  }

  private struct Segment {
    let visibility: Visibility
    let data: Data
  }

  private let filter: StreamingSecretFilter
  private var pending: [Segment] = []
  private var pendingIndex = 0
  private var pendingOffset = 0
  private var deferredEvents: [BrokerOpenAIResponsesEvent] = []

  init(filter: StreamingSecretFilter) {
    self.filter = filter
  }

  mutating func process(
    _ events: [BrokerOpenAIResponsesEvent]
  ) throws -> [BrokerOpenAIResponsesEvent] {
    var emitted: [BrokerOpenAIResponsesEvent] = []
    for event in events {
      switch event {
      case .textDelta(let value):
        emitted.append(contentsOf: try process(value, visibility: .text))
      case .reasoningDelta(let value):
        emitted.append(contentsOf: try process(value, visibility: .reasoning))
      case .refusalDelta(let value):
        emitted.append(contentsOf: try process(value, visibility: .refusal))
      case .toolCall, .usage, .done:
        deferredEvents.append(event)
      }
    }
    return emitted
  }

  mutating func finish(
    completion: BrokerOpenAIResponsesCompletion
  ) throws -> [BrokerOpenAIResponsesEvent] {
    var emitted: [BrokerOpenAIResponsesEvent] = []
    var deferredKeys: [String] = []

    emitted.append(contentsOf: try process(completion.responseID, visibility: .silent))
    for event in deferredEvents {
      guard case .toolCall(let call) = event else { continue }
      let arguments = try BrokerStrictJSON.object(
        from: call.argumentsJSON,
        maximumByteCount: BrokerOpenAIResponsesStreamDecoder.maximumAccumulatedValueByteCount
      )
      let fragments = Self.stringFragments(in: arguments)
      for value in fragments.values {
        emitted.append(contentsOf: try process(value, visibility: .silent))
      }
      deferredKeys.append(contentsOf: fragments.keys)
    }

    let output = try completion.outputItems.map { try $0.decodedObject() }
    for item in output where item["type"] as? String == "reasoning" {
      if let encrypted = item["encrypted_content"] as? String {
        emitted.append(contentsOf: try process(encrypted, visibility: .silent))
      }
    }
    for item in output {
      let fragments = Self.stringFragments(in: item, excludingKeys: ["encrypted_content"])
      for value in fragments.values {
        emitted.append(contentsOf: try process(value, visibility: .silent))
      }
      deferredKeys.append(contentsOf: fragments.keys)
    }
    for key in deferredKeys {
      emitted.append(contentsOf: try process(key, visibility: .silent))
    }

    emitted.append(contentsOf: try drain(filter.finish()))
    guard pendingIndex == pending.count else {
      throw BrokerOpenAIResponsesNetworkError.invalidResponse
    }
    emitted.append(contentsOf: deferredEvents)
    deferredEvents.removeAll(keepingCapacity: false)
    return emitted
  }

  func cancel() {
    filter.cancel()
  }

  private mutating func process(
    _ value: String,
    visibility: Visibility
  ) throws -> [BrokerOpenAIResponsesEvent] {
    let data = Data(value.utf8)
    guard !data.isEmpty else { return [] }
    pending.append(Segment(visibility: visibility, data: data))
    return try drain(filter.process(data))
  }

  private mutating func drain(
    _ released: Data
  ) throws -> [BrokerOpenAIResponsesEvent] {
    var emitted: [BrokerOpenAIResponsesEvent] = []
    var releasedOffset = 0
    while releasedOffset < released.count {
      guard pending.indices.contains(pendingIndex) else {
        throw BrokerOpenAIResponsesNetworkError.invalidResponse
      }
      let segment = pending[pendingIndex]
      let available = segment.data.count - pendingOffset
      let count = min(available, released.count - releasedOffset)
      let expected = segment.data.subdata(in: pendingOffset..<(pendingOffset + count))
      let actual = released.subdata(in: releasedOffset..<(releasedOffset + count))
      guard expected == actual else { throw BrokerOpenAIResponsesNetworkError.invalidResponse }

      if segment.visibility != .silent {
        guard let value = String(data: actual, encoding: .utf8) else {
          throw BrokerOpenAIResponsesNetworkError.invalidResponse
        }
        switch segment.visibility {
        case .text: emitted.append(.textDelta(value))
        case .reasoning: emitted.append(.reasoningDelta(value))
        case .refusal: emitted.append(.refusalDelta(value))
        case .silent: break
        }
      }
      pendingOffset += count
      releasedOffset += count
      if pendingOffset == segment.data.count {
        pendingIndex += 1
        pendingOffset = 0
      }
    }
    if pendingIndex >= 64, pendingIndex * 2 >= pending.count {
      pending.removeFirst(pendingIndex)
      pendingIndex = 0
    }
    return emitted
  }

  private static func stringFragments(
    in value: Any,
    excludingKeys: Set<String> = []
  ) -> (values: [String], keys: [String]) {
    var values: [String] = []
    var keys: [String] = []
    collectStrings(
      in: value,
      excludingKeys: excludingKeys,
      values: &values,
      keys: &keys
    )
    return (values, keys)
  }

  private static func collectStrings(
    in value: Any,
    excludingKeys: Set<String>,
    values: inout [String],
    keys: inout [String]
  ) {
    if let string = value as? String {
      values.append(string)
      return
    }
    if let array = value as? [Any] {
      for element in array {
        collectStrings(
          in: element,
          excludingKeys: excludingKeys,
          values: &values,
          keys: &keys
        )
      }
      return
    }
    guard let dictionary = value as? [String: Any] else { return }
    for key in dictionary.keys.sorted() where !excludingKeys.contains(key) {
      collectStrings(
        in: dictionary[key] as Any,
        excludingKeys: excludingKeys,
        values: &values,
        keys: &keys
      )
      keys.append(key)
    }
  }
}

final class BrokerOpenAIResponsesResponseAccumulator: @unchecked Sendable {
  static let maximumErrorBodyByteCount = 1_048_576
  static let maximumHeaderByteCount = 4_096

  private struct Head {
    let statusCode: Int
    let contentType: String?
  }

  private let lock = NSLock()
  // Serializes callback entry with cancellation; recursive use permits callback-initiated cancellation.
  private let deliveryLock = NSRecursiveLock()
  private let rawFilter: StreamingSecretFilter
  private var semanticFilter: BrokerOpenAIResponsesSemanticFilter
  private let onEvent: @Sendable (BrokerOpenAIResponsesEvent) -> Void
  private var decoder = BrokerOpenAIResponsesStreamDecoder()
  private var head: Head?
  private var errorBodyByteCount = 0
  private var terminalError: BrokerOpenAIResponsesNetworkError?
  private var isFinished = false
  private var eventDeliveryAllowed = true

  init(
    rawFilter: StreamingSecretFilter,
    semanticFilter: StreamingSecretFilter,
    onEvent: @escaping @Sendable (BrokerOpenAIResponsesEvent) -> Void
  ) {
    self.rawFilter = rawFilter
    self.semanticFilter = BrokerOpenAIResponsesSemanticFilter(filter: semanticFilter)
    self.onEvent = onEvent
  }

  func receiveHead(
    statusCode: Int,
    contentType: String?,
    xRequestID: String? = nil,
    requestID: String? = nil
  ) throws(BrokerOpenAIResponsesNetworkError) {
    lock.lock()
    defer { lock.unlock() }
    try requireActiveLocked()
    guard head == nil, (100...599).contains(statusCode) else {
      throw failLocked(.invalidResponse)
    }
    do {
      let filteredContentType = try filteredHeaderLocked(contentType)
      _ = try filteredHeaderLocked(xRequestID)
      _ = try filteredHeaderLocked(requestID)
      if statusCode == 200, !Self.isEventStream(filteredContentType) {
        throw BrokerOpenAIResponsesNetworkError.invalidResponse
      }
      head = Head(statusCode: statusCode, contentType: filteredContentType)
    } catch let error as BrokerOpenAIResponsesNetworkError {
      throw failLocked(error)
    } catch let error as StreamingSecretFilterError {
      throw failLocked(Self.mapFilterError(error))
    } catch {
      throw failLocked(.invalidResponse)
    }
  }

  func receive(_ chunk: Data) throws(BrokerOpenAIResponsesNetworkError) {
    lock.lock()
    let events: [BrokerOpenAIResponsesEvent]
    do {
      try requireActiveLocked()
      guard let head else { throw BrokerOpenAIResponsesNetworkError.invalidResponse }
      let filtered = try rawFilter.process(chunk)
      if head.statusCode == 200 {
        events = try semanticFilter.process(decoder.receive(filtered))
      } else {
        let (next, overflowed) = errorBodyByteCount.addingReportingOverflow(filtered.count)
        guard !overflowed, next <= Self.maximumErrorBodyByteCount else {
          throw BrokerOpenAIResponsesNetworkError.responseTooLarge
        }
        errorBodyByteCount = next
        events = []
      }
      lock.unlock()
    } catch let error as BrokerOpenAIResponsesNetworkError {
      let selected = failLocked(error)
      lock.unlock()
      throw selected
    } catch let error as BrokerOpenAIResponsesStreamError {
      let selected = failLocked(Self.mapStreamError(error))
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

  func finish() throws(BrokerOpenAIResponsesNetworkError) -> BrokerOpenAIResponsesCompletion {
    lock.lock()
    let events: [BrokerOpenAIResponsesEvent]
    let completion: BrokerOpenAIResponsesCompletion
    do {
      try requireActiveLocked()
      guard let head else { throw BrokerOpenAIResponsesNetworkError.invalidResponse }
      let tail = try rawFilter.finish()
      if head.statusCode != 200 {
        let (next, overflowed) = errorBodyByteCount.addingReportingOverflow(tail.count)
        guard !overflowed, next <= Self.maximumErrorBodyByteCount else {
          throw BrokerOpenAIResponsesNetworkError.responseTooLarge
        }
        throw Self.statusError(head.statusCode)
      }
      var selectedEvents = try semanticFilter.process(decoder.receive(tail))
      completion = try decoder.finish()
      selectedEvents.append(contentsOf: try semanticFilter.finish(completion: completion))
      events = selectedEvents
      isFinished = true
      lock.unlock()
    } catch let error as BrokerOpenAIResponsesNetworkError {
      let selected = failLocked(error)
      lock.unlock()
      throw selected
    } catch let error as BrokerOpenAIResponsesStreamError {
      let selected = failLocked(Self.mapStreamError(error))
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
    deliveryLock.lock()
    defer { deliveryLock.unlock() }
    lock.withLock {
      eventDeliveryAllowed = false
      guard terminalError == nil, !isFinished else { return }
      _ = failLocked(.cancelled)
    }
  }

  private func requireActiveLocked() throws(BrokerOpenAIResponsesNetworkError) {
    if let terminalError { throw terminalError }
    guard !isFinished else { throw .invalidResponse }
  }

  @discardableResult
  private func failLocked(
    _ error: BrokerOpenAIResponsesNetworkError
  ) -> BrokerOpenAIResponsesNetworkError {
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
      guard separator == Data([0]) else { throw BrokerOpenAIResponsesNetworkError.invalidResponse }
      return nil
    }
    guard supplied.utf8.count <= Self.maximumHeaderByteCount else {
      throw BrokerOpenAIResponsesNetworkError.invalidResponse
    }
    var filtered = try rawFilter.process(Data(supplied.utf8))
    filtered.append(try rawFilter.process(Data([0])))
    guard filtered.last == 0 else { throw BrokerOpenAIResponsesNetworkError.invalidResponse }
    filtered.removeLast()
    guard let result = String(data: filtered, encoding: .utf8) else {
      throw BrokerOpenAIResponsesNetworkError.invalidResponse
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

  private static func statusError(_ status: Int) -> BrokerOpenAIResponsesNetworkError {
    switch status {
    case 401, 403: .authenticationRejected
    case 429: .rateLimited
    case 500...599: .providerUnavailable
    default: .requestRejected
    }
  }

  private static func mapFilterError(
    _ error: StreamingSecretFilterError
  ) -> BrokerOpenAIResponsesNetworkError {
    switch error {
    case .credentialEchoDetected: .credentialEchoDetected
    case .cancelled: .cancelled
    case .emptyPattern, .patternLimitExceeded, .alreadyFinished: .invalidResponse
    }
  }

  private static func mapStreamError(
    _ error: BrokerOpenAIResponsesStreamError
  ) -> BrokerOpenAIResponsesNetworkError {
    switch error {
    case .invalidStream: .invalidResponse
    case .responseTooLarge: .responseTooLarge
    case .contentFiltered: .contentFiltered
    case .providerFailure: .providerFailure
    }
  }
}

struct BrokerOpenAIResponsesURLSessionNetworking: BrokerOpenAIResponsesNetworking {
  func makeAttempt(
    request: URLRequest,
    accumulator: BrokerOpenAIResponsesResponseAccumulator
  ) -> any BrokerOpenAIResponsesNetworkAttempt {
    BrokerOpenAIResponsesURLSessionAttempt(request: request, accumulator: accumulator)
  }

  static func configuration() -> URLSessionConfiguration {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.urlCache = nil
    configuration.httpCookieStorage = nil
    configuration.httpShouldSetCookies = false
    configuration.urlCredentialStorage = nil
    configuration.waitsForConnectivity = false
    configuration.httpMaximumConnectionsPerHost = 1
    configuration.timeoutIntervalForRequest = 30
    configuration.timeoutIntervalForResource = 600
    configuration.tlsMinimumSupportedProtocolVersion = .TLSv12
    return configuration
  }
}

enum BrokerOpenAIResponsesURLPolicy {
  private static let endpoint = URL(string: "https://api.openai.com/v1/responses")!

  static var requestURL: URL { endpoint }
  static func accepts(_ url: URL?) -> Bool { url?.absoluteString == endpoint.absoluteString }

  static func challengeDisposition(
    authenticationMethod: String,
    host: String,
    hasHandledServerTrust: Bool
  ) -> URLSession.AuthChallengeDisposition {
    guard authenticationMethod == NSURLAuthenticationMethodServerTrust,
      host.lowercased() == "api.openai.com", !hasHandledServerTrust
    else { return .cancelAuthenticationChallenge }
    return .performDefaultHandling
  }
}

private final class BrokerOpenAIResponsesSessionDelegate:
  NSObject, URLSessionDataDelegate, @unchecked Sendable
{
  private let lock = NSLock()
  private let accumulator: BrokerOpenAIResponsesResponseAccumulator
  private let result: BrokerOpenAIResponsesNetworkResult
  private var handledServerTrust = false

  init(
    accumulator: BrokerOpenAIResponsesResponseAccumulator,
    result: BrokerOpenAIResponsesNetworkResult
  ) {
    self.accumulator = accumulator
    self.result = result
  }

  func urlSession(
    _ session: URLSession,
    dataTask: URLSessionDataTask,
    didReceive response: URLResponse,
    completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void
  ) {
    guard let response = response as? HTTPURLResponse,
      BrokerOpenAIResponsesURLPolicy.accepts(response.url)
    else {
      fail(.invalidResponse, task: dataTask)
      completionHandler(.cancel)
      return
    }
    do {
      try accumulator.receiveHead(
        statusCode: response.statusCode,
        contentType: response.value(forHTTPHeaderField: "content-type"),
        xRequestID: response.value(forHTTPHeaderField: "x-request-id"),
        requestID: response.value(forHTTPHeaderField: "request-id")
      )
      completionHandler(.allow)
    } catch let error {
      fail(error, task: dataTask)
      completionHandler(.cancel)
    }
  }

  func urlSession(
    _ session: URLSession,
    dataTask: URLSessionDataTask,
    didReceive data: Data
  ) {
    do {
      try accumulator.receive(data)
    } catch let error {
      fail(error, task: dataTask)
    }
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    didCompleteWithError error: (any Error)?
  ) {
    if error != nil {
      result.complete(.failure(.transportFailure))
      return
    }
    do {
      result.complete(.success(try accumulator.finish()))
    } catch let error {
      result.complete(.failure(error))
    }
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest,
    completionHandler: @escaping @Sendable (URLRequest?) -> Void
  ) {
    fail(.invalidResponse, task: task)
    completionHandler(nil)
  }

  func urlSession(
    _ session: URLSession,
    didReceive challenge: URLAuthenticationChallenge,
    completionHandler:
      @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    complete(challenge, completionHandler: completionHandler)
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    didReceive challenge: URLAuthenticationChallenge,
    completionHandler:
      @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    complete(challenge, completionHandler: completionHandler)
  }

  private func complete(
    _ challenge: URLAuthenticationChallenge,
    completionHandler:
      @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    let disposition = lock.withLock {
      let selected = BrokerOpenAIResponsesURLPolicy.challengeDisposition(
        authenticationMethod: challenge.protectionSpace.authenticationMethod,
        host: challenge.protectionSpace.host,
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

  private func fail(_ error: BrokerOpenAIResponsesNetworkError, task: URLSessionTask) {
    accumulator.cancel()
    result.complete(.failure(error))
    task.cancel()
  }
}

private final class BrokerOpenAIResponsesURLSessionAttempt:
  BrokerOpenAIResponsesNetworkAttempt, @unchecked Sendable
{
  private let lock = NSLock()
  private let request: URLRequest
  private let accumulator: BrokerOpenAIResponsesResponseAccumulator
  private let result = BrokerOpenAIResponsesNetworkResult()
  private let delegate: BrokerOpenAIResponsesSessionDelegate
  private let session: URLSession
  private let task: URLSessionDataTask
  private var isStarted = false
  private var isCancelled = false

  init(request: URLRequest, accumulator: BrokerOpenAIResponsesResponseAccumulator) {
    self.request = request
    self.accumulator = accumulator
    let result = self.result
    delegate = BrokerOpenAIResponsesSessionDelegate(accumulator: accumulator, result: result)
    session = URLSession(
      configuration: BrokerOpenAIResponsesURLSessionNetworking.configuration(),
      delegate: delegate,
      delegateQueue: nil
    )
    task = session.dataTask(with: request)
  }

  func start() {
    lock.lock()
    guard !isStarted, !isCancelled else {
      lock.unlock()
      return
    }
    isStarted = true
    lock.unlock()
    task.resume()
  }

  func response() async throws -> BrokerOpenAIResponsesCompletion {
    defer { session.finishTasksAndInvalidate() }
    return try await result.value().get()
  }

  func cancel() {
    lock.lock()
    guard !isCancelled else {
      lock.unlock()
      return
    }
    isCancelled = true
    lock.unlock()
    accumulator.cancel()
    result.complete(.failure(.cancelled))
    task.cancel()
    session.invalidateAndCancel()
  }

  deinit { cancel() }
}

private final class BrokerOpenAIResponsesNetworkResult: @unchecked Sendable {
  typealias Value = Result<BrokerOpenAIResponsesCompletion, BrokerOpenAIResponsesNetworkError>
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
    for waiter in selected {
      waiter.resume(returning: value)
    }
  }
}

private final class BrokerOpenAIResponsesAttemptBox: @unchecked Sendable {
  private let lock = NSLock()
  private var attempt: (any BrokerOpenAIResponsesNetworkAttempt)?
  private var cancelled = false

  func install(_ selected: any BrokerOpenAIResponsesNetworkAttempt) -> Bool {
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
      throw BrokerOpenAIResponsesNetworkError.invalidResponse
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

private struct BrokerOpenAIResponsesPreparedAttempt: Sendable {
  let attempt: any BrokerOpenAIResponsesNetworkAttempt
}

struct BrokerOpenAIResponsesTransport<
  Route: BrokerOpenAIResponsesRouteAuthorizing,
  Network: BrokerOpenAIResponsesNetworking
>: Sendable {
  static var maximumCredentialByteCount: Int { 16_384 }

  private let route: Route
  private let network: Network

  init(route: Route, network: Network) {
    self.route = route
    self.network = network
  }

  func stream(
    _ request: BrokerOpenAIResponsesRequest,
    capability: Route.Capability,
    onEvent: @escaping @Sendable (BrokerOpenAIResponsesEvent) -> Void = { _ in }
  ) async throws(BrokerOpenAIResponsesError) -> BrokerOpenAIResponsesCompletion {
    let body: Data
    do {
      body = try request.encodedBody()
    } catch let error as BrokerOpenAIResponsesRequestError {
      switch error {
      case .invalidRequest, .invalidJSON: throw .invalidRequest
      case .requestTooLarge: throw .requestTooLarge
      }
    } catch {
      throw .invalidRequest
    }
    let requestBytes = UInt64(body.count)
    let attemptBox = BrokerOpenAIResponsesAttemptBox()
    do {
      return try await withTaskCancellationHandler {
        try Task.checkCancellation()
        let reservation = try await route.reserveCredentialUse(
          capability,
          expectedScope: .run,
          expectedProviderBinding: .openAI,
          requestBytes: requestBytes
        )
        try Task.checkCancellation()
        let delivery = try await route.startCredentialUse(
          reservation,
          capability: capability,
          expectedScope: .run,
          expectedProviderBinding: .openAI,
          requestBytes: requestBytes,
          prepare: { credential -> CredentialUsePreparation<BrokerOpenAIResponsesPreparedAttempt> in
            guard
              let prepared = Self.prepare(
                credential: credential,
                body: body,
                network: network,
                attemptBox: attemptBox,
                onEvent: onEvent
              )
            else { return .rejected }
            return .prepared(prepared)
          },
          start: { (prepared: BrokerOpenAIResponsesPreparedAttempt) in
            prepared.attempt.start()
          }
        )
        guard delivery == .requestStarted else {
          attemptBox.cancel()
          throw BrokerOpenAIResponsesError.deliveryUncertain
        }
        let completion = try await attemptBox.response()
        try Task.checkCancellation()
        return completion
      } onCancel: {
        attemptBox.cancel()
      }
    } catch let error as BrokerOpenAIResponsesError {
      if Task.isCancelled { throw .cancelled }
      throw error
    } catch let error as BrokerProviderRouteAuthorityError {
      if Task.isCancelled { throw .cancelled }
      switch error {
      case .cancelled: throw .cancelled
      case .invalidCredential: throw .invalidCredential
      default: throw .routeUnavailable
      }
    } catch let error as BrokerOpenAIResponsesNetworkError {
      if Task.isCancelled { throw .cancelled }
      throw Self.mapNetworkError(error)
    } catch is CancellationError {
      throw .cancelled
    } catch {
      throw .routeUnavailable
    }
  }

  private static func prepare(
    credential: UnsafeRawBufferPointer,
    body: Data,
    network: Network,
    attemptBox: BrokerOpenAIResponsesAttemptBox,
    onEvent: @escaping @Sendable (BrokerOpenAIResponsesEvent) -> Void
  ) -> BrokerOpenAIResponsesPreparedAttempt? {
    guard (1...maximumCredentialByteCount).contains(credential.count),
      credential.allSatisfy({ (0x21...0x7e).contains($0) })
    else { return nil }
    let secret = Data(credential)
    var bearer = Data("Bearer ".utf8)
    bearer.append(secret)
    guard
      let rawFilter = try? StreamingSecretFilter(
        patterns: [SecretBytes(Data(secret)), SecretBytes(Data(bearer))]
      ),
      let semanticFilter = try? StreamingSecretFilter(
        patterns: [SecretBytes(Data(secret)), SecretBytes(Data(bearer))]
      )
    else { return nil }

    var urlRequest = URLRequest(
      url: BrokerOpenAIResponsesURLPolicy.requestURL,
      cachePolicy: .reloadIgnoringLocalCacheData,
      timeoutInterval: 30
    )
    urlRequest.httpMethod = "POST"
    urlRequest.setValue("text/event-stream", forHTTPHeaderField: "Accept")
    urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
    urlRequest.setValue(
      "Bearer \(String(decoding: credential, as: UTF8.self))",
      forHTTPHeaderField: "Authorization"
    )
    urlRequest.httpBody = body
    let attempt = network.makeAttempt(
      request: urlRequest,
      accumulator: BrokerOpenAIResponsesResponseAccumulator(
        rawFilter: rawFilter,
        semanticFilter: semanticFilter,
        onEvent: onEvent
      )
    )
    guard attemptBox.install(attempt) else { return nil }
    return BrokerOpenAIResponsesPreparedAttempt(attempt: attempt)
  }

  private static func mapNetworkError(
    _ error: BrokerOpenAIResponsesNetworkError
  ) -> BrokerOpenAIResponsesError {
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
