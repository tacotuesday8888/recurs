import Foundation
import Testing

@testable import RecursBrokerCore
@testable import RecursBrokerService

@Suite("Broker OpenAI setup catalog fetcher")
struct BrokerOpenAISetupCatalogFetcherTests {
  private let connectionID = UUID(
    uuidString: "10000000-0000-4000-8000-000000000200"
  )!
  private let expiresAt = Date(timeIntervalSince1970: 1_800_000_060)

  @Test
  func issuesOneBoundedSetupCapabilityThenCancelsAndClosesIt() async throws {
    let route = SetupCatalogRoute()
    let fetcher = BrokerOpenAISetupCatalogFetcher(
      route: route,
      network: SetupCatalogNetwork(statusCode: 200)
    )

    let catalog = try await fetcher.fetchSetupCatalog(
      context: setupContext,
      expiresAt: expiresAt
    )

    #expect(catalog.modelIDs == ["gpt-5"])
    #expect(
      await route.issueCalls == [
        SetupIssueCall(
          scope: .setup,
          connectionID: connectionID,
          attemptID: setupContext.attemptID,
          expectedFence: setupContext.fence,
          expiresAt: expiresAt,
          requestBudget: 1,
          byteBudget: 0
        )
      ])
    #expect(await route.cancelCount == 1)
    #expect(await route.closeCount == 1)
  }

  @Test
  func providerFailureStillCancelsCapabilityAndClosesRoute() async {
    let route = SetupCatalogRoute()
    let fetcher = BrokerOpenAISetupCatalogFetcher(
      route: route,
      network: SetupCatalogNetwork(statusCode: 401)
    )

    await #expect(throws: BrokerOpenAIModelCatalogError.authenticationRejected) {
      _ = try await fetcher.fetchSetupCatalog(
        context: setupContext,
        expiresAt: expiresAt
      )
    }

    #expect(await route.issueCalls.count == 1)
    #expect(await route.cancelCount == 1)
    #expect(await route.closeCount == 1)
  }

  @Test
  func cancellationAfterIssueStillCancelsCapabilityAndClosesRoute() async {
    let route = SetupCatalogRoute()
    let fetcher = BrokerOpenAISetupCatalogFetcher(
      route: route,
      network: SetupCatalogNetwork(statusCode: 200, suspended: true)
    )
    let fetch = Task {
      try await fetcher.fetchSetupCatalog(
        context: setupContext,
        expiresAt: expiresAt
      )
    }
    await route.waitUntilIssued()

    fetch.cancel()

    await #expect(throws: BrokerOpenAIModelCatalogError.cancelled) {
      _ = try await fetch.value
    }
    #expect(await route.cancelCount == 1)
    #expect(await route.closeCount == 1)
  }

  @Test
  func issueFailureClosesRouteWithoutInventingACapability() async {
    let route = SetupCatalogRoute(issueFailure: true)
    let fetcher = BrokerOpenAISetupCatalogFetcher(
      route: route,
      network: SetupCatalogNetwork(statusCode: 200)
    )

    await #expect(throws: BrokerProviderRouteAuthorityError.closed) {
      _ = try await fetcher.fetchSetupCatalog(
        context: setupContext,
        expiresAt: expiresAt
      )
    }

    #expect(await route.issueCalls.count == 1)
    #expect(await route.cancelCount == 0)
    #expect(await route.closeCount == 1)
  }
}

private struct SetupIssueCall: Sendable, Equatable {
  let scope: BrokerProviderRouteScope
  let connectionID: UUID
  let attemptID: UUID
  let expectedFence: UInt64
  let expiresAt: Date
  let requestBudget: UInt64
  let byteBudget: UInt64
}

private struct SetupCatalogCapability: Sendable, Equatable {
  let value: UInt64
}

private struct SetupCatalogReservation: Sendable {}

private actor SetupCatalogRoute: BrokerOpenAISetupRouteAuthorizing {
  typealias Capability = SetupCatalogCapability
  typealias Reservation = SetupCatalogReservation

  private let issueFailure: Bool
  private(set) var issueCalls: [SetupIssueCall] = []
  private(set) var cancelCount = 0
  private(set) var closeCount = 0

  init(issueFailure: Bool = false) {
    self.issueFailure = issueFailure
  }

  func issueSetup(
    connectionID: UUID,
    attemptID: UUID,
    expectedFence: UInt64,
    expiresAt: Date,
    requestBudget: UInt64,
    byteBudget: UInt64
  ) async throws -> SetupCatalogCapability {
    issueCalls.append(
      SetupIssueCall(
        scope: .setup,
        connectionID: connectionID,
        attemptID: attemptID,
        expectedFence: expectedFence,
        expiresAt: expiresAt,
        requestBudget: requestBudget,
        byteBudget: byteBudget
      )
    )
    if issueFailure { throw BrokerProviderRouteAuthorityError.closed }
    return SetupCatalogCapability(value: 1)
  }

  func reserveCredentialUse(
    _ handle: SetupCatalogCapability,
    expectedScope: BrokerProviderRouteScope,
    expectedProviderBinding: ProviderProfileBinding,
    requestBytes: UInt64
  ) async throws -> SetupCatalogReservation {
    SetupCatalogReservation()
  }

  func startCredentialUse<Prepared: Sendable>(
    _ reservation: SetupCatalogReservation,
    capability handle: SetupCatalogCapability,
    expectedScope: BrokerProviderRouteScope,
    expectedProviderBinding: ProviderProfileBinding,
    requestBytes: UInt64,
    prepare: @Sendable (UnsafeRawBufferPointer) -> CredentialUsePreparation<Prepared>,
    start: @Sendable (Prepared) -> Void
  ) async throws -> DeliveryState {
    let credential = Data("fixture-credential".utf8)
    switch credential.withUnsafeBytes(prepare) {
    case .prepared(let prepared):
      start(prepared)
      return .requestStarted
    case .rejected:
      throw BrokerProviderRouteAuthorityError.invalidCredential
    }
  }

  func cancel(_ handle: SetupCatalogCapability) async {
    cancelCount += 1
  }

  func close() async {
    closeCount += 1
  }

  func waitUntilIssued() async {
    while issueCalls.isEmpty {
      await Task.yield()
    }
  }
}

private let setupContext = BrokerOpenAIOnboardingStagingContext(
  connectionID: UUID(uuidString: "10000000-0000-4000-8000-000000000200")!,
  attemptID: UUID(uuidString: "20000000-0000-4000-8000-000000000200")!,
  fence: 7,
  providerBinding: .openAI,
  expiresAt: Date(timeIntervalSince1970: 4_000_000_000)
)

private struct SetupCatalogNetwork: BrokerOpenAIModelCatalogNetworking {
  let statusCode: Int
  var suspended = false

  func makeAttempt(
    request: URLRequest,
    accumulator: BrokerOpenAIModelCatalogResponseAccumulator
  ) -> any BrokerOpenAIModelCatalogNetworkAttempt {
    SetupCatalogNetworkAttempt(
      statusCode: statusCode,
      suspended: suspended,
      accumulator: accumulator
    )
  }
}

private final class SetupCatalogNetworkAttempt:
  BrokerOpenAIModelCatalogNetworkAttempt,
  @unchecked Sendable
{
  private let lock = NSLock()
  private let statusCode: Int
  private let suspended: Bool
  private let accumulator: BrokerOpenAIModelCatalogResponseAccumulator
  private var started = false

  init(
    statusCode: Int,
    suspended: Bool,
    accumulator: BrokerOpenAIModelCatalogResponseAccumulator
  ) {
    self.statusCode = statusCode
    self.suspended = suspended
    self.accumulator = accumulator
  }

  func start() {
    lock.withLock { started = true }
  }

  func response() async throws -> BrokerOpenAIModelCatalogNetworkResponse {
    guard lock.withLock({ started }) else {
      throw BrokerOpenAIModelCatalogNetworkError.invalidResponse
    }
    if suspended {
      try await Task.sleep(for: .seconds(60))
      throw BrokerOpenAIModelCatalogNetworkError.invalidResponse
    }
    try accumulator.receiveHead(
      statusCode: statusCode,
      contentType: "application/json",
      xRequestID: "request-setup",
      requestID: nil
    )
    try accumulator.receive(Data(#"{"data":[{"id":"gpt-5"}]}"#.utf8))
    return try accumulator.finish()
  }

  func cancel() {
    accumulator.cancel()
  }
}
