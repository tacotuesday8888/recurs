import Foundation
import RecursBrokerCore

enum BrokerOpenAIModelCatalogUse: Sendable, Equatable {
  case setup
  case maintenance

  fileprivate var routeScope: BrokerProviderRouteScope {
    switch self {
    case .setup:
      .setup
    case .maintenance:
      .maintenance
    }
  }
}

struct BrokerOpenAIModelCatalog: Sendable, Equatable {
  let modelIDs: [String]
  let requestID: String?
}

enum BrokerOpenAIModelCatalogError:
  Error,
  Sendable,
  Equatable,
  CustomStringConvertible,
  CustomDebugStringConvertible,
  LocalizedError
{
  case cancelled
  case invalidCredential
  case routeUnavailable
  case networkFailure
  case invalidResponse
  case responseTooLarge
  case authenticationRejected
  case rateLimited
  case providerUnavailable
  case requestRejected
  case credentialEchoDetected

  private var fixedDescription: String {
    switch self {
    case .cancelled:
      "Recurs stopped waiting for the OpenAI model-catalog request; OpenAI delivery or billing may still have occurred."
    case .invalidCredential:
      "The OpenAI credential is invalid."
    case .routeUnavailable:
      "The OpenAI model-catalog route is unavailable."
    case .networkFailure:
      "The OpenAI request did not complete; its delivery state is uncertain."
    case .invalidResponse:
      "OpenAI returned an invalid model-catalog response."
    case .responseTooLarge:
      "OpenAI returned a model-catalog response that exceeded the size limit."
    case .authenticationRejected:
      "OpenAI rejected the credential."
    case .rateLimited:
      "OpenAI rate-limited the model-catalog request."
    case .providerUnavailable:
      "OpenAI is unavailable."
    case .requestRejected:
      "OpenAI rejected the model-catalog request."
    case .credentialEchoDetected:
      "OpenAI returned credential material in its response."
    }
  }

  var description: String { fixedDescription }
  var debugDescription: String { fixedDescription }
  var errorDescription: String? { fixedDescription }
}

protocol BrokerOpenAIModelCatalogRouteAuthorizing: Sendable {
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

extension BrokerProviderRouteAuthority: BrokerOpenAIModelCatalogRouteAuthorizing {
  typealias Capability = BrokerProviderRouteCapability
  typealias Reservation = BrokerProviderRouteReservation
}

protocol BrokerOpenAIModelCatalogNetworkAttempt: Sendable {
  func start()
  func response() async throws -> BrokerOpenAIModelCatalogNetworkResponse
  func cancel()
}

protocol BrokerOpenAIModelCatalogNetworking: Sendable {
  func makeAttempt(
    request: URLRequest,
    accumulator: BrokerOpenAIModelCatalogResponseAccumulator
  ) -> any BrokerOpenAIModelCatalogNetworkAttempt
}

struct BrokerOpenAIModelCatalogNetworkResponse: Sendable, Equatable {
  let statusCode: Int
  let contentType: String?
  let xRequestID: String?
  let requestID: String?
  let body: Data
}

private struct BrokerOpenAIModelCatalogEnvelope: Decodable {
  struct Model: Decodable {
    let id: String
  }

  let data: [Model]
}

enum BrokerOpenAIModelCatalogNetworkError: Error, Sendable, Equatable {
  case cancelled
  case transportFailure
  case invalidResponse
  case responseTooLarge
  case credentialEchoDetected
}

final class BrokerOpenAIModelCatalogResponseAccumulator: @unchecked Sendable {
  static let maximumBodyByteCount = 1_048_576
  static let maximumHeaderByteCount = 4_096

  private struct Head {
    let statusCode: Int
    let contentType: String?
    let xRequestID: String?
    let requestID: String?
  }

  private let lock = NSLock()
  private let filter: StreamingSecretFilter
  private var head: Head?
  private var body = Data()
  private var receivedByteCount = 0
  private var terminalError: BrokerOpenAIModelCatalogNetworkError?
  private var isFinished = false

  init(filter: StreamingSecretFilter) {
    self.filter = filter
  }

  func receiveHead(
    statusCode: Int,
    contentType: String?,
    xRequestID: String?,
    requestID: String?
  ) throws(BrokerOpenAIModelCatalogNetworkError) {
    lock.lock()
    defer { lock.unlock() }
    try requireActiveLocked()
    guard head == nil, (100...599).contains(statusCode) else {
      failLocked(.invalidResponse)
      throw .invalidResponse
    }
    do {
      head = Head(
        statusCode: statusCode,
        contentType: try filteredHeaderValueLocked(contentType),
        xRequestID: try filteredHeaderValueLocked(xRequestID),
        requestID: try filteredHeaderValueLocked(requestID)
      )
    } catch let error {
      failLocked(error)
      throw error
    }
  }

  func receive(_ chunk: Data) throws(BrokerOpenAIModelCatalogNetworkError) {
    lock.lock()
    defer { lock.unlock() }
    try requireActiveLocked()
    guard head != nil else {
      failLocked(.invalidResponse)
      throw .invalidResponse
    }

    let (nextByteCount, overflowed) = receivedByteCount.addingReportingOverflow(chunk.count)
    guard !overflowed, nextByteCount <= Self.maximumBodyByteCount else {
      failLocked(.responseTooLarge)
      throw .responseTooLarge
    }
    receivedByteCount = nextByteCount

    do {
      body.append(try filter.process(chunk))
    } catch let error {
      let mapped = Self.mapFilterError(error)
      failLocked(mapped)
      throw mapped
    }
  }

  func finish() throws(BrokerOpenAIModelCatalogNetworkError)
    -> BrokerOpenAIModelCatalogNetworkResponse
  {
    lock.lock()
    defer { lock.unlock() }
    try requireActiveLocked()
    guard let head else {
      failLocked(.invalidResponse)
      throw .invalidResponse
    }
    do {
      body.append(try filter.finish())
    } catch let error {
      let mapped = Self.mapFilterError(error)
      failLocked(mapped)
      throw mapped
    }
    isFinished = true
    return BrokerOpenAIModelCatalogNetworkResponse(
      statusCode: head.statusCode,
      contentType: head.contentType,
      xRequestID: head.xRequestID,
      requestID: head.requestID,
      body: body
    )
  }

  func cancel() {
    lock.lock()
    defer { lock.unlock() }
    guard terminalError == nil, !isFinished else { return }
    failLocked(.cancelled)
  }

  private func requireActiveLocked() throws(BrokerOpenAIModelCatalogNetworkError) {
    if let terminalError {
      throw terminalError
    }
    guard !isFinished else { throw .invalidResponse }
  }

  private func failLocked(_ error: BrokerOpenAIModelCatalogNetworkError) {
    guard terminalError == nil, !isFinished else { return }
    terminalError = error
    body.resetBytes(in: body.startIndex..<body.endIndex)
    body.removeAll(keepingCapacity: false)
    filter.cancel()
  }

  private func filteredHeaderValueLocked(
    _ supplied: String?
  ) throws(BrokerOpenAIModelCatalogNetworkError) -> String? {
    guard
      let byteCount = supplied?.utf8.count,
      byteCount <= Self.maximumHeaderByteCount
    else {
      if supplied != nil { throw .invalidResponse }
      return try filteredAbsentHeaderLocked()
    }
    var bytes = supplied.map { Data($0.utf8) } ?? Data()
    defer {
      bytes.resetBytes(in: bytes.startIndex..<bytes.endIndex)
      bytes.removeAll(keepingCapacity: false)
    }
    do {
      var filtered = try filter.process(bytes)
      var separator = try filter.process(Data([0]))
      defer {
        filtered.resetBytes(in: filtered.startIndex..<filtered.endIndex)
        separator.resetBytes(in: separator.startIndex..<separator.endIndex)
      }
      filtered.append(separator)
      guard filtered.last == 0 else { throw BrokerOpenAIModelCatalogNetworkError.invalidResponse }
      filtered.removeLast()
      guard supplied != nil else {
        guard filtered.isEmpty else {
          throw BrokerOpenAIModelCatalogNetworkError.invalidResponse
        }
        return nil
      }
      guard let value = String(data: filtered, encoding: .utf8) else {
        throw BrokerOpenAIModelCatalogNetworkError.invalidResponse
      }
      return value
    } catch let error as BrokerOpenAIModelCatalogNetworkError {
      throw error
    } catch let error as StreamingSecretFilterError {
      throw Self.mapFilterError(error)
    } catch {
      throw .invalidResponse
    }
  }

  private func filteredAbsentHeaderLocked() throws(BrokerOpenAIModelCatalogNetworkError) -> String?
  {
    do {
      let separator = try filter.process(Data([0]))
      guard separator == Data([0]) else {
        throw BrokerOpenAIModelCatalogNetworkError.invalidResponse
      }
      return nil
    } catch let error as BrokerOpenAIModelCatalogNetworkError {
      throw error
    } catch let error as StreamingSecretFilterError {
      throw Self.mapFilterError(error)
    } catch {
      throw .invalidResponse
    }
  }

  private static func mapFilterError(
    _ error: StreamingSecretFilterError
  ) -> BrokerOpenAIModelCatalogNetworkError {
    switch error {
    case .credentialEchoDetected:
      .credentialEchoDetected
    case .cancelled:
      .cancelled
    case .emptyPattern, .patternLimitExceeded, .alreadyFinished:
      .invalidResponse
    }
  }
}

struct BrokerOpenAIModelCatalogURLSessionNetworking: BrokerOpenAIModelCatalogNetworking {
  func makeAttempt(
    request: URLRequest,
    accumulator: BrokerOpenAIModelCatalogResponseAccumulator
  ) -> any BrokerOpenAIModelCatalogNetworkAttempt {
    BrokerOpenAIModelCatalogURLSessionAttempt(
      request: request,
      accumulator: accumulator
    )
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
    configuration.timeoutIntervalForRequest = 15
    configuration.timeoutIntervalForResource = 30
    configuration.tlsMinimumSupportedProtocolVersion = .TLSv12
    return configuration
  }
}

private final class BrokerOpenAIModelCatalogURLSessionAttempt:
  NSObject,
  BrokerOpenAIModelCatalogNetworkAttempt,
  @unchecked Sendable
{
  private let lock = NSLock()
  private let result = BrokerOpenAIModelCatalogNetworkResult()
  private let accumulator: BrokerOpenAIModelCatalogResponseAccumulator
  private let delegate: BrokerOpenAIModelCatalogURLSessionDelegate
  private let session: URLSession
  private let task: URLSessionDataTask
  private var isStarted = false
  private var isCancelled = false

  init(request: URLRequest, accumulator: BrokerOpenAIModelCatalogResponseAccumulator) {
    self.accumulator = accumulator
    let result = self.result
    delegate = BrokerOpenAIModelCatalogURLSessionDelegate(
      accumulator: accumulator,
      result: result
    )
    session = URLSession(
      configuration: BrokerOpenAIModelCatalogURLSessionNetworking.configuration(),
      delegate: delegate,
      delegateQueue: nil
    )
    task = session.dataTask(with: request)
    super.init()
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

  func response() async throws -> BrokerOpenAIModelCatalogNetworkResponse {
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
    result.complete(.failure(.cancelled))
    accumulator.cancel()
    task.cancel()
    session.invalidateAndCancel()
  }

  deinit {
    cancel()
  }
}

private final class BrokerOpenAIModelCatalogURLSessionDelegate:
  NSObject,
  URLSessionDataDelegate,
  @unchecked Sendable
{
  private let lock = NSLock()
  private let accumulator: BrokerOpenAIModelCatalogResponseAccumulator
  private let result: BrokerOpenAIModelCatalogNetworkResult
  private var handledServerTrust = false

  init(
    accumulator: BrokerOpenAIModelCatalogResponseAccumulator,
    result: BrokerOpenAIModelCatalogNetworkResult
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
    guard
      let response = response as? HTTPURLResponse,
      BrokerOpenAIModelCatalogURLPolicy.accepts(response.url)
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
    if let error {
      result.complete(.failure(BrokerOpenAIModelCatalogURLPolicy.completionFailure(for: error)))
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
      @escaping @Sendable (
        URLSession.AuthChallengeDisposition,
        URLCredential?
      ) -> Void
  ) {
    complete(challenge: challenge, session: session, completionHandler: completionHandler)
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    didReceive challenge: URLAuthenticationChallenge,
    completionHandler:
      @escaping @Sendable (
        URLSession.AuthChallengeDisposition,
        URLCredential?
      ) -> Void
  ) {
    complete(challenge: challenge, session: session, completionHandler: completionHandler)
  }

  private func complete(
    challenge: URLAuthenticationChallenge,
    session: URLSession,
    completionHandler:
      @escaping @Sendable (
        URLSession.AuthChallengeDisposition,
        URLCredential?
      ) -> Void
  ) {
    lock.lock()
    let disposition = BrokerOpenAIModelCatalogURLPolicy.challengeDisposition(
      authenticationMethod: challenge.protectionSpace.authenticationMethod,
      host: challenge.protectionSpace.host,
      hasHandledServerTrust: handledServerTrust
    )
    if disposition == .performDefaultHandling {
      handledServerTrust = true
    }
    lock.unlock()

    completionHandler(disposition, nil)
    if disposition != .performDefaultHandling {
      result.complete(.failure(.invalidResponse))
      session.invalidateAndCancel()
    }
  }

  private func fail(
    _ error: BrokerOpenAIModelCatalogNetworkError,
    task: URLSessionTask
  ) {
    accumulator.cancel()
    result.complete(.failure(error))
    task.cancel()
  }
}

enum BrokerOpenAIModelCatalogURLPolicy {
  private static let endpoint = URL(string: "https://api.openai.com/v1/models")!

  static func accepts(_ url: URL?) -> Bool {
    url?.absoluteString == endpoint.absoluteString
  }

  static func challengeDisposition(
    authenticationMethod: String,
    host: String,
    hasHandledServerTrust: Bool
  ) -> URLSession.AuthChallengeDisposition {
    guard
      authenticationMethod == NSURLAuthenticationMethodServerTrust,
      host.lowercased() == "api.openai.com",
      !hasHandledServerTrust
    else {
      return .cancelAuthenticationChallenge
    }
    return .performDefaultHandling
  }

  static func completionFailure(
    for error: any Error
  ) -> BrokerOpenAIModelCatalogNetworkError {
    _ = error
    return .transportFailure
  }

  static var requestURL: URL { endpoint }
}

private final class BrokerOpenAIModelCatalogNetworkResult: @unchecked Sendable {
  typealias Value = Result<
    BrokerOpenAIModelCatalogNetworkResponse,
    BrokerOpenAIModelCatalogNetworkError
  >

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

private final class BrokerOpenAIModelCatalogAttemptBox: @unchecked Sendable {
  private let lock = NSLock()
  private var attempt: (any BrokerOpenAIModelCatalogNetworkAttempt)?
  private var isCancelled = false

  func install(_ selected: any BrokerOpenAIModelCatalogNetworkAttempt) -> Bool {
    lock.lock()
    guard attempt == nil, !isCancelled else {
      lock.unlock()
      selected.cancel()
      return false
    }
    attempt = selected
    lock.unlock()
    return true
  }

  func response() async throws -> BrokerOpenAIModelCatalogNetworkResponse {
    let selected = lock.withLock { attempt }
    guard let selected else {
      throw BrokerOpenAIModelCatalogNetworkError.invalidResponse
    }
    return try await selected.response()
  }

  func cancel() {
    lock.lock()
    isCancelled = true
    let selected = attempt
    lock.unlock()
    selected?.cancel()
  }
}

struct BrokerOpenAIModelCatalogPreparedAttempt: Sendable {
  let attempt: any BrokerOpenAIModelCatalogNetworkAttempt
}

struct BrokerOpenAIModelCatalogTransport<
  Route: BrokerOpenAIModelCatalogRouteAuthorizing,
  Network: BrokerOpenAIModelCatalogNetworking
>: Sendable {
  private static var requestBytes: UInt64 { 0 }
  static var maximumCredentialByteCount: Int { 16_384 }

  private let route: Route
  private let network: Network

  init(route: Route, network: Network) {
    self.route = route
    self.network = network
  }

  func fetch(
    capability: Route.Capability,
    use: BrokerOpenAIModelCatalogUse
  ) async throws(BrokerOpenAIModelCatalogError) -> BrokerOpenAIModelCatalog {
    let attemptBox = BrokerOpenAIModelCatalogAttemptBox()
    do {
      return try await withTaskCancellationHandler {
        try Task.checkCancellation()
        let reservation = try await route.reserveCredentialUse(
          capability,
          expectedScope: use.routeScope,
          expectedProviderBinding: .openAI,
          requestBytes: Self.requestBytes
        )
        try Task.checkCancellation()
        let delivery = try await route.startCredentialUse(
          reservation,
          capability: capability,
          expectedScope: use.routeScope,
          expectedProviderBinding: .openAI,
          requestBytes: Self.requestBytes,
          prepare: {
            credential -> CredentialUsePreparation<
              BrokerOpenAIModelCatalogPreparedAttempt
            > in
            guard
              let prepared = Self.prepareRequest(
                credential: credential,
                network: network,
                attemptBox: attemptBox
              )
            else {
              return .rejected
            }
            return .prepared(prepared)
          },
          start: { (prepared: BrokerOpenAIModelCatalogPreparedAttempt) in
            prepared.attempt.start()
          }
        )
        guard delivery == .requestStarted else {
          attemptBox.cancel()
          throw BrokerOpenAIModelCatalogError.networkFailure
        }
        let response = try await attemptBox.response()
        try Task.checkCancellation()
        return try Self.catalog(from: response)
      } onCancel: {
        attemptBox.cancel()
      }
    } catch let error as BrokerOpenAIModelCatalogError {
      if Task.isCancelled { throw .cancelled }
      throw error
    } catch let error as BrokerProviderRouteAuthorityError {
      if Task.isCancelled { throw .cancelled }
      throw Self.mapRouteError(error)
    } catch let error as BrokerOpenAIModelCatalogNetworkError {
      if Task.isCancelled { throw .cancelled }
      throw Self.mapNetworkError(error)
    } catch is CancellationError {
      throw .cancelled
    } catch {
      throw .routeUnavailable
    }
  }

  private static func prepareRequest(
    credential: UnsafeRawBufferPointer,
    network: Network,
    attemptBox: BrokerOpenAIModelCatalogAttemptBox
  ) -> BrokerOpenAIModelCatalogPreparedAttempt? {
    guard
      (1...maximumCredentialByteCount).contains(credential.count),
      credential.allSatisfy({ (0x21...0x7e).contains($0) })
    else {
      return nil
    }

    let credentialData = Data(credential)
    var bearerData = Data("Bearer ".utf8)
    bearerData.append(credentialData)
    let filter: StreamingSecretFilter
    do {
      filter = try StreamingSecretFilter(
        patterns: [SecretBytes(credentialData), SecretBytes(bearerData)]
      )
    } catch {
      return nil
    }

    var request = URLRequest(
      url: BrokerOpenAIModelCatalogURLPolicy.requestURL,
      cachePolicy: .reloadIgnoringLocalCacheData,
      timeoutInterval: 15
    )
    request.httpMethod = "GET"
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue(
      "Bearer \(String(decoding: credential, as: UTF8.self))",
      forHTTPHeaderField: "Authorization"
    )
    request.httpBody = nil
    let attempt = network.makeAttempt(
      request: request,
      accumulator: BrokerOpenAIModelCatalogResponseAccumulator(filter: filter)
    )
    guard attemptBox.install(attempt) else { return nil }
    return BrokerOpenAIModelCatalogPreparedAttempt(attempt: attempt)
  }

  static func catalog(
    from response: BrokerOpenAIModelCatalogNetworkResponse
  ) throws(BrokerOpenAIModelCatalogError) -> BrokerOpenAIModelCatalog {
    guard response.body.count <= BrokerOpenAIModelCatalogResponseAccumulator.maximumBodyByteCount
    else {
      throw .responseTooLarge
    }
    guard
      [response.contentType, response.xRequestID, response.requestID]
        .compactMap({ $0 })
        .allSatisfy({
          $0.utf8.count <= BrokerOpenAIModelCatalogResponseAccumulator.maximumHeaderByteCount
        })
    else {
      throw .invalidResponse
    }
    guard isJSONContentType(response.contentType) else {
      throw .invalidResponse
    }
    switch response.statusCode {
    case 200:
      break
    case 401, 403:
      throw .authenticationRejected
    case 429:
      throw .rateLimited
    case 500...599:
      throw .providerUnavailable
    default:
      throw .requestRejected
    }

    let envelope: BrokerOpenAIModelCatalogEnvelope
    do {
      envelope = try JSONDecoder().decode(
        BrokerOpenAIModelCatalogEnvelope.self,
        from: response.body
      )
    } catch {
      throw .invalidResponse
    }
    guard envelope.data.count <= 4_096 else {
      throw .invalidResponse
    }

    var seen = Set<Data>()
    var models: [(id: String, bytes: Data)] = []
    models.reserveCapacity(envelope.data.count)
    for model in envelope.data {
      let bytes = Data(model.id.utf8)
      guard
        (1...256).contains(bytes.count),
        !bytes.contains(where: { $0 < 0x20 || $0 == 0x7f }),
        seen.insert(bytes).inserted
      else {
        throw .invalidResponse
      }
      models.append((model.id, bytes))
    }
    models.sort { left, right in
      left.bytes.lexicographicallyPrecedes(right.bytes)
    }

    return BrokerOpenAIModelCatalog(
      modelIDs: models.map(\.id),
      requestID: requestIdentifier(from: response)
    )
  }

  private static func isJSONContentType(_ supplied: String?) -> Bool {
    guard let supplied else { return false }
    guard supplied.utf8.allSatisfy({ (0x20...0x7e).contains($0) }) else {
      return false
    }
    let mediaType = supplied.split(separator: ";", maxSplits: 1)[0]
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .lowercased()
    return mediaType == "application/json"
  }

  private static func requestIdentifier(
    from response: BrokerOpenAIModelCatalogNetworkResponse
  ) -> String? {
    if let xRequestID = response.xRequestID {
      return validatedRequestIdentifier(xRequestID)
    }
    return response.requestID.flatMap(validatedRequestIdentifier)
  }

  private static func validatedRequestIdentifier(_ supplied: String) -> String? {
    let bytes = supplied.utf8
    guard
      (1...256).contains(bytes.count),
      bytes.allSatisfy({ (0x21...0x7e).contains($0) })
    else {
      return nil
    }
    return supplied
  }

  private static func mapRouteError(
    _ error: BrokerProviderRouteAuthorityError
  ) -> BrokerOpenAIModelCatalogError {
    switch error {
    case .cancelled:
      .cancelled
    case .invalidCredential:
      .invalidCredential
    case .closed, .expired, .invalidCapability, .wrongScope, .wrongProvider,
      .wrongRequestBytes, .staleCapability, .authorityUnavailable, .routeUnavailable,
      .requestBudgetExceeded, .byteBudgetExceeded:
      .routeUnavailable
    }
  }

  private static func mapNetworkError(
    _ error: BrokerOpenAIModelCatalogNetworkError
  ) -> BrokerOpenAIModelCatalogError {
    switch error {
    case .cancelled:
      .cancelled
    case .transportFailure:
      .networkFailure
    case .invalidResponse:
      .invalidResponse
    case .responseTooLarge:
      .responseTooLarge
    case .credentialEchoDetected:
      .credentialEchoDetected
    }
  }
}
