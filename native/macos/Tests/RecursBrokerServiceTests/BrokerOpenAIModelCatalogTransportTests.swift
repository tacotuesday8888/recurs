import Foundation
import Testing

@testable import RecursBrokerCore
@testable import RecursBrokerService

@Suite(.serialized)
struct BrokerOpenAIModelCatalogTransportTests {
  private typealias Subject = BrokerOpenAIModelCatalogTransport<CatalogRoute, CatalogNetwork>

  @Test
  func setupBuildsOneExactRequestAndReturnsBoundedSortedCatalog() async throws {
    let route = CatalogRoute(credential: Data("sk-test-private".utf8))
    let network = CatalogNetwork(
      script: .response(
        statusCode: 200,
        contentType: "Application/JSON; charset=utf-8",
        xRequestID: "request_123",
        requestID: "ignored",
        chunks: [
          Data(#"{"data":[{"id":"é","object":"model"},{"id":"a"},"#.utf8),
          Data(#"{"id":"z"}],"unknown":true}"#.utf8),
        ]
      )
    )
    let catalog = try await Subject(route: route, network: network).fetch(
      capability: CatalogCapability(),
      use: .setup
    )

    #expect(
      catalog == BrokerOpenAIModelCatalog(modelIDs: ["a", "z", "é"], requestID: "request_123"))
    #expect(
      await route.invocations
        == [
          CatalogRouteInvocation(
            phase: .reserve,
            scope: .setup,
            providerBinding: .openAI,
            requestBytes: 0
          ),
          CatalogRouteInvocation(
            phase: .start,
            scope: .setup,
            providerBinding: .openAI,
            requestBytes: 0
          ),
        ]
    )
    let requests = network.requests
    #expect(requests.count == 1)
    let request = try #require(requests.first)
    #expect(request.url?.absoluteString == "https://api.openai.com/v1/models")
    #expect(request.httpMethod == "GET")
    #expect(request.value(forHTTPHeaderField: "Accept") == "application/json")
    #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer sk-test-private")
    #expect(request.allHTTPHeaderFields?.count == 2)
    #expect(request.httpBody == nil)
    #expect(request.cachePolicy == .reloadIgnoringLocalCacheData)
    #expect(request.timeoutInterval == 15)
    #expect(network.attempts.count == 1)
    #expect(network.attempts[0].startCount == 1)
  }

  @Test
  func anthropicUsesNativeHeadersBindingAndCompleteCatalogEnvelope() async throws {
    let route = CatalogRoute(credential: Data("sk-ant-private".utf8))
    let network = CatalogNetwork(
      script: .response(
        statusCode: 200,
        contentType: "application/json",
        xRequestID: "request-ant",
        requestID: nil,
        chunks: [
          Data(
            #"{"data":[{"id":"claude-sonnet"},{"id":"claude-opus"}],"has_more":false,"first_id":"claude-sonnet","last_id":"claude-opus"}"#
              .utf8
          )
        ]
      )
    )

    let catalog = try await Subject(
      route: route,
      network: network,
      profile: .anthropic
    ).fetch(capability: CatalogCapability(), use: .setup)

    #expect(catalog.modelIDs == ["claude-opus", "claude-sonnet"])
    #expect(await route.invocations.allSatisfy { $0.providerBinding == .anthropic })
    let request = try #require(network.requests.first)
    #expect(request.url?.absoluteString == "https://api.anthropic.com/v1/models?limit=1000")
    #expect(request.value(forHTTPHeaderField: "x-api-key") == "sk-ant-private")
    #expect(request.value(forHTTPHeaderField: "anthropic-version") == "2023-06-01")
    #expect(request.value(forHTTPHeaderField: "Authorization") == nil)

    let partial = BrokerOpenAIModelCatalogNetworkResponse(
      statusCode: 200,
      contentType: "application/json",
      xRequestID: nil,
      requestID: nil,
      body: Data(#"{"data":[{"id":"claude"}],"has_more":true,"last_id":"claude"}"#.utf8)
    )
    #expect(throws: BrokerOpenAIModelCatalogError.invalidResponse) {
      _ = try Subject.catalog(from: partial, profile: .anthropic)
    }
  }

  @Test
  func maintenanceUsesExactProviderFenceAndDoesNotRetryTransportFailure() async {
    let route = CatalogRoute(credential: Data("key".utf8))
    let network = CatalogNetwork(script: .failure(.transportFailure))
    await #expect(throws: BrokerOpenAIModelCatalogError.networkFailure) {
      _ = try await Subject(route: route, network: network).fetch(
        capability: CatalogCapability(),
        use: .maintenance
      )
    }
    #expect(network.requests.count == 1)
    #expect(network.attempts.count == 1)
    #expect(network.attempts[0].startCount == 1)
    #expect(await route.invocations.allSatisfy { $0.scope == .maintenance })
    #expect(await route.invocations.allSatisfy { $0.providerBinding == .openAI })
  }

  @Test
  func invalidCredentialIsRejectedBeforeNetworkCreation() async {
    for credential in [Data(), Data("line\nbreak".utf8), Data([0xff])] {
      let route = CatalogRoute(credential: credential)
      let network = CatalogNetwork(script: .validEmptyCatalog)
      await #expect(throws: BrokerOpenAIModelCatalogError.invalidCredential) {
        _ = try await Subject(route: route, network: network).fetch(
          capability: CatalogCapability(),
          use: .setup
        )
      }
      #expect(network.requests.isEmpty)
    }
  }

  @Test
  func credentialLengthBoundaryIsExact() async throws {
    let accepted = Data(repeating: 0x61, count: Subject.maximumCredentialByteCount)
    let acceptedNetwork = CatalogNetwork(script: .validEmptyCatalog)
    _ = try await Subject(
      route: CatalogRoute(credential: accepted),
      network: acceptedNetwork
    ).fetch(capability: CatalogCapability(), use: .setup)
    #expect(acceptedNetwork.requests.count == 1)

    let rejected = Data(repeating: 0x61, count: Subject.maximumCredentialByteCount + 1)
    let rejectedNetwork = CatalogNetwork(script: .validEmptyCatalog)
    await #expect(throws: BrokerOpenAIModelCatalogError.invalidCredential) {
      _ = try await Subject(
        route: CatalogRoute(credential: rejected),
        network: rejectedNetwork
      ).fetch(capability: CatalogCapability(), use: .setup)
    }
    #expect(rejectedNetwork.requests.isEmpty)
  }

  @Test
  func secretEchoAcrossBodyChunksOrAllowedHeadersFailsClosed() async {
    let secret = "sk-never-return-this"
    let bodyNetwork = CatalogNetwork(
      script: .response(
        statusCode: 200,
        contentType: "application/json",
        xRequestID: nil,
        requestID: nil,
        chunks: [Data(#"{"data":[],"message":"sk-never-"#.utf8), Data(#"return-this"}"#.utf8)]
      )
    )
    await expectCredentialEcho(secret: secret, network: bodyNetwork)

    for header in CatalogEchoHeader.allCases {
      let network = CatalogNetwork(
        script: .response(
          statusCode: 200,
          contentType: header == .contentType ? secret : "application/json",
          xRequestID: header == .xRequestID ? "Bearer \(secret)" : nil,
          requestID: header == .requestID ? secret : nil,
          chunks: [Data(#"{"data":[]}"#.utf8)]
        )
      )
      await expectCredentialEcho(secret: secret, network: network)
    }
  }

  @Test
  func responseBodyAndHeaderBoundsFailClosed() async {
    let oversizedBody = CatalogNetwork(
      script: .response(
        statusCode: 200,
        contentType: "application/json",
        xRequestID: nil,
        requestID: nil,
        chunks: [
          Data(
            repeating: 0x61,
            count: BrokerOpenAIModelCatalogResponseAccumulator.maximumBodyByteCount + 1)
        ]
      )
    )
    await #expect(throws: BrokerOpenAIModelCatalogError.responseTooLarge) {
      _ = try await Subject(
        route: CatalogRoute(credential: Data("key".utf8)),
        network: oversizedBody
      ).fetch(capability: CatalogCapability(), use: .setup)
    }

    let oversizedHeader = CatalogNetwork(
      script: .response(
        statusCode: 200,
        contentType: String(
          repeating: "a",
          count: BrokerOpenAIModelCatalogResponseAccumulator.maximumHeaderByteCount + 1
        ),
        xRequestID: nil,
        requestID: nil,
        chunks: [Data(#"{"data":[]}"#.utf8)]
      )
    )
    await #expect(throws: BrokerOpenAIModelCatalogError.invalidResponse) {
      _ = try await Subject(
        route: CatalogRoute(credential: Data("key".utf8)),
        network: oversizedHeader
      ).fetch(capability: CatalogCapability(), use: .setup)
    }
  }

  @Test
  func contentTypeAndProviderStatusesMapToFixedErrors() async {
    let cases: [(Int, String?, BrokerOpenAIModelCatalogError)] = [
      (200, "text/plain", .invalidResponse),
      (401, "application/json", .authenticationRejected),
      (403, "application/json", .authenticationRejected),
      (429, "application/json", .rateLimited),
      (500, "application/json", .providerUnavailable),
      (599, "application/json", .providerUnavailable),
      (400, "application/json", .requestRejected),
      (600, "application/json", .invalidResponse),
    ]
    for (status, contentType, expected) in cases {
      let network = CatalogNetwork(
        script: .response(
          statusCode: status,
          contentType: contentType,
          xRequestID: nil,
          requestID: nil,
          chunks: [Data(#"{"data":[]}"#.utf8)]
        )
      )
      await #expect(throws: expected) {
        _ = try await Subject(
          route: CatalogRoute(credential: Data("key".utf8)),
          network: network
        ).fetch(capability: CatalogCapability(), use: .setup)
      }
    }
  }

  @Test
  func malformedOversizedDuplicateAndInvalidModelIDsFailClosed() throws {
    let invalidBodies: [Data] = [
      Data("not-json".utf8),
      Data(#"{}"#.utf8),
      Data(#"{"data":[{"id":""}]}"#.utf8),
      Data(
        (#"{"data":[{"id":"# + String(repeating: "a", count: 257) + #""}]}"#).utf8
      ),
      Data(#"{"data":[{"id":"bad\u0000id"}]}"#.utf8),
      Data(#"{"data":[{"id":"same"},{"id":"same"}]}"#.utf8),
    ]
    for body in invalidBodies {
      #expect(throws: BrokerOpenAIModelCatalogError.invalidResponse) {
        _ = try Subject.catalog(from: networkResponse(body: body))
      }
    }

    let tooMany = try JSONSerialization.data(
      withJSONObject: ["data": (0...4_096).map { ["id": "m\($0)"] }]
    )
    #expect(throws: BrokerOpenAIModelCatalogError.invalidResponse) {
      _ = try Subject.catalog(from: networkResponse(body: tooMany))
    }
  }

  @Test
  func modelAndRequestIDBoundariesAreAcceptedWithoutHeaderFallback() throws {
    let boundaryID = String(repeating: "x", count: 256)
    let body = try JSONSerialization.data(
      withJSONObject: ["data": [["id": boundaryID, "type": "model"]]]
    )
    let validRequestID = String(repeating: "r", count: 256)
    let accepted = try Subject.catalog(
      from: BrokerOpenAIModelCatalogNetworkResponse(
        statusCode: 200,
        contentType: "application/json",
        xRequestID: nil,
        requestID: validRequestID,
        body: body
      )
    )
    #expect(accepted.modelIDs == [boundaryID])
    #expect(accepted.requestID == validRequestID)

    let invalidPreferred = try Subject.catalog(
      from: BrokerOpenAIModelCatalogNetworkResponse(
        statusCode: 200,
        contentType: "application/json",
        xRequestID: "bad request id",
        requestID: "must-not-fallback",
        body: body
      )
    )
    #expect(invalidPreferred.requestID == nil)
  }

  @Test
  func taskCancellationCancelsTheSingleStartedAttempt() async throws {
    let network = CatalogNetwork(script: .suspended)
    let task = Task {
      try await Subject(
        route: CatalogRoute(credential: Data("key".utf8)),
        network: network
      ).fetch(capability: CatalogCapability(), use: .setup)
    }
    let attempt = await network.waitForAttempt()
    await attempt.waitUntilStarted()
    task.cancel()
    await #expect(throws: BrokerOpenAIModelCatalogError.cancelled) {
      _ = try await task.value
    }
    #expect(attempt.isCancelled)
    #expect(attempt.startCount == 1)
    #expect(network.attempts.count == 1)
  }

  @Test
  func explicitAndDelegateCancellationRemainSemanticallyDistinct() {
    #expect(
      BrokerOpenAIModelCatalogError.cancelled.description
        == "Recurs stopped waiting for the OpenAI model-catalog request; OpenAI delivery or billing may still have occurred."
    )
    #expect(
      BrokerOpenAIModelCatalogURLPolicy.completionFailure(for: URLError(.cancelled))
        == .transportFailure
    )
    #expect(
      BrokerOpenAIModelCatalogURLPolicy.completionFailure(for: URLError(.timedOut))
        == .transportFailure
    )
  }

  @Test
  func productionSessionAndURLPoliciesAreNarrow() {
    let configuration = BrokerOpenAIModelCatalogURLSessionNetworking.configuration()
    #expect(configuration.identifier == nil)
    #expect(configuration.requestCachePolicy == .reloadIgnoringLocalCacheData)
    #expect(configuration.urlCache == nil)
    #expect(configuration.httpCookieStorage == nil)
    #expect(configuration.httpShouldSetCookies == false)
    #expect(configuration.urlCredentialStorage == nil)
    #expect(configuration.waitsForConnectivity == false)
    #expect(configuration.httpMaximumConnectionsPerHost == 1)
    #expect(configuration.timeoutIntervalForRequest == 15)
    #expect(configuration.timeoutIntervalForResource == 30)
    #expect(configuration.tlsMinimumSupportedProtocolVersion == .TLSv12)

    #expect(
      BrokerOpenAIModelCatalogURLPolicy.accepts(URL(string: "https://api.openai.com/v1/models")))
    for rejected in [
      "http://api.openai.com/v1/models",
      "https://api.openai.com/v1/models?x=1",
      "https://api.openai.com/v1/models/",
      "https://evil.example/v1/models",
      "https://api.openai.com:444/v1/models",
      "https://user@api.openai.com/v1/models",
    ] {
      #expect(!BrokerOpenAIModelCatalogURLPolicy.accepts(URL(string: rejected)))
    }

    #expect(
      BrokerOpenAIModelCatalogURLPolicy.challengeDisposition(
        authenticationMethod: NSURLAuthenticationMethodServerTrust,
        host: "api.openai.com",
        hasHandledServerTrust: false
      ) == .performDefaultHandling
    )
    #expect(
      BrokerOpenAIModelCatalogURLPolicy.challengeDisposition(
        authenticationMethod: NSURLAuthenticationMethodServerTrust,
        host: "api.openai.com",
        hasHandledServerTrust: true
      ) == .cancelAuthenticationChallenge
    )
    #expect(
      BrokerOpenAIModelCatalogURLPolicy.challengeDisposition(
        authenticationMethod: NSURLAuthenticationMethodHTTPBasic,
        host: "api.openai.com",
        hasHandledServerTrust: false
      ) == .cancelAuthenticationChallenge
    )
    #expect(
      BrokerOpenAIModelCatalogURLPolicy.challengeDisposition(
        authenticationMethod: NSURLAuthenticationMethodServerTrust,
        host: "attacker.example",
        hasHandledServerTrust: false
      ) == .cancelAuthenticationChallenge
    )
  }

  private func expectCredentialEcho(secret: String, network: CatalogNetwork) async {
    do {
      _ = try await Subject(
        route: CatalogRoute(credential: Data(secret.utf8)),
        network: network
      ).fetch(capability: CatalogCapability(), use: .setup)
      Issue.record("Expected credential echo detection.")
    } catch let error {
      #expect(error == .credentialEchoDetected)
      #expect(!error.description.contains(secret))
      #expect(!error.description.contains("api.openai.com"))
    }
  }

  private func networkResponse(body: Data) -> BrokerOpenAIModelCatalogNetworkResponse {
    BrokerOpenAIModelCatalogNetworkResponse(
      statusCode: 200,
      contentType: "application/json",
      xRequestID: nil,
      requestID: nil,
      body: body
    )
  }
}

private enum CatalogEchoHeader: CaseIterable {
  case contentType
  case xRequestID
  case requestID
}

private struct CatalogCapability: Sendable {}
private struct CatalogReservation: Sendable {}

private struct CatalogRouteInvocation: Sendable, Equatable {
  enum Phase: Sendable, Equatable {
    case reserve
    case start
  }

  let phase: Phase
  let scope: BrokerProviderRouteScope
  let providerBinding: ProviderProfileBinding
  let requestBytes: UInt64
}

private actor CatalogRoute: BrokerOpenAIModelCatalogRouteAuthorizing {
  typealias Capability = CatalogCapability
  typealias Reservation = CatalogReservation

  private let credential: Data
  private(set) var invocations: [CatalogRouteInvocation] = []

  init(credential: Data) {
    self.credential = credential
  }

  func reserveCredentialUse(
    _ handle: CatalogCapability,
    expectedScope: BrokerProviderRouteScope,
    expectedProviderBinding: ProviderProfileBinding,
    requestBytes: UInt64
  ) async throws -> CatalogReservation {
    invocations.append(
      CatalogRouteInvocation(
        phase: .reserve,
        scope: expectedScope,
        providerBinding: expectedProviderBinding,
        requestBytes: requestBytes
      )
    )
    return CatalogReservation()
  }

  func startCredentialUse<Prepared: Sendable>(
    _ reservation: CatalogReservation,
    capability handle: CatalogCapability,
    expectedScope: BrokerProviderRouteScope,
    expectedProviderBinding: ProviderProfileBinding,
    requestBytes: UInt64,
    prepare: @Sendable (UnsafeRawBufferPointer) -> CredentialUsePreparation<Prepared>,
    start: @Sendable (Prepared) -> Void
  ) async throws -> DeliveryState {
    invocations.append(
      CatalogRouteInvocation(
        phase: .start,
        scope: expectedScope,
        providerBinding: expectedProviderBinding,
        requestBytes: requestBytes
      )
    )
    let preparation = credential.withUnsafeBytes(prepare)
    switch preparation {
    case .prepared(let prepared):
      start(prepared)
      return .requestStarted
    case .rejected:
      throw BrokerProviderRouteAuthorityError.invalidCredential
    }
  }
}

private final class CatalogNetwork: BrokerOpenAIModelCatalogNetworking, @unchecked Sendable {
  private let lock = NSLock()
  private let script: CatalogNetworkScript
  private var storedRequests: [URLRequest] = []
  private var storedAttempts: [CatalogNetworkAttempt] = []
  private var attemptWaiters: [CheckedContinuation<CatalogNetworkAttempt, Never>] = []

  init(script: CatalogNetworkScript) {
    self.script = script
  }

  var requests: [URLRequest] { lock.withLock { storedRequests } }
  var attempts: [CatalogNetworkAttempt] { lock.withLock { storedAttempts } }

  func makeAttempt(
    request: URLRequest,
    accumulator: BrokerOpenAIModelCatalogResponseAccumulator
  ) -> any BrokerOpenAIModelCatalogNetworkAttempt {
    let attempt = CatalogNetworkAttempt(script: script, accumulator: accumulator)
    lock.lock()
    storedRequests.append(request)
    storedAttempts.append(attempt)
    let selected = attemptWaiters
    attemptWaiters.removeAll()
    lock.unlock()
    for waiter in selected {
      waiter.resume(returning: attempt)
    }
    return attempt
  }

  func waitForAttempt() async -> CatalogNetworkAttempt {
    if let existing = lock.withLock({ storedAttempts.first }) {
      return existing
    }
    return await withCheckedContinuation { continuation in
      lock.lock()
      if let existing = storedAttempts.first {
        lock.unlock()
        continuation.resume(returning: existing)
      } else {
        attemptWaiters.append(continuation)
        lock.unlock()
      }
    }
  }
}

private enum CatalogNetworkScript: Sendable {
  case response(
    statusCode: Int,
    contentType: String?,
    xRequestID: String?,
    requestID: String?,
    chunks: [Data]
  )
  case failure(BrokerOpenAIModelCatalogNetworkError)
  case suspended

  static var validEmptyCatalog: Self {
    .response(
      statusCode: 200,
      contentType: "application/json",
      xRequestID: nil,
      requestID: nil,
      chunks: [Data(#"{"data":[]}"#.utf8)]
    )
  }
}

private final class CatalogNetworkAttempt:
  BrokerOpenAIModelCatalogNetworkAttempt,
  @unchecked Sendable
{
  private let lock = NSLock()
  private let script: CatalogNetworkScript
  private let accumulator: BrokerOpenAIModelCatalogResponseAccumulator
  private var starts = 0
  private var cancelled = false
  private var startWaiters: [CheckedContinuation<Void, Never>] = []
  private var responseWaiter: CheckedContinuation<Void, Never>?

  init(
    script: CatalogNetworkScript,
    accumulator: BrokerOpenAIModelCatalogResponseAccumulator
  ) {
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

  func response() async throws -> BrokerOpenAIModelCatalogNetworkResponse {
    guard startCount == 1 else {
      throw BrokerOpenAIModelCatalogNetworkError.invalidResponse
    }
    switch script {
    case .response(let statusCode, let contentType, let xRequestID, let requestID, let chunks):
      try accumulator.receiveHead(
        statusCode: statusCode,
        contentType: contentType,
        xRequestID: xRequestID,
        requestID: requestID
      )
      for chunk in chunks {
        try accumulator.receive(chunk)
      }
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
      throw BrokerOpenAIModelCatalogNetworkError.cancelled
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
