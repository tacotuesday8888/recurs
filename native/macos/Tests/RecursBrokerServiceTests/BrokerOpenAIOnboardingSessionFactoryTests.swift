import Foundation
import Testing

@testable import RecursBrokerCore
@testable import RecursBrokerService

@Suite("Broker OpenAI onboarding session factory")
struct BrokerOpenAIOnboardingSessionFactoryTests {
  @Test
  func everySessionOwnsAFreshRouteAuthority() async throws {
    let authority = SessionFactoryAuthority()
    let network = SessionFactoryNetwork()
    let factory = BrokerOpenAIOnboardingSessionFactoryLive(
      authority: authority,
      network: network
    )
    let context = SessionFactoryAuthority.context
    let first = try factory.makeSession(
      context: context,
      abortOperationID: UUID(uuidString: "10000000-0000-4000-8000-000000000004")!
    )
    let second = try factory.makeSession(
      context: context,
      abortOperationID: UUID(uuidString: "10000000-0000-4000-8000-000000000005")!
    )

    #expect(try await first.verify().modelIDs == ["gpt-5"])
    #expect(try await second.verify().modelIDs == ["gpt-5"])
    #expect(network.attemptCount == 2)

    try await first.close()
    try await second.close()
  }
}

private final class SessionFactoryAuthority:
  BrokerCredentialLifecycleAuthority,
  BrokerProviderCredentialUseAuthority,
  BrokerProviderRouteProjectionReader,
  @unchecked Sendable
{
  static let connectionID = UUID(uuidString: "10000000-0000-4000-8000-000000000001")!
  static let attemptID = UUID(uuidString: "10000000-0000-4000-8000-000000000002")!
  static let generation = CredentialGeneration(
    generationID: UUID(uuidString: "10000000-0000-4000-8000-000000000003")!,
    ordinal: 1,
    createdAt: Date(timeIntervalSince1970: 1)
  )
  static let context = BrokerOpenAIOnboardingStagingContext(
    connectionID: connectionID,
    attemptID: attemptID,
    fence: 1,
    providerBinding: .openAI
  )

  func authoritativeBoundProjection(
    for connectionID: UUID
  ) async throws(BrokerJournalError) -> BrokerCredentialBoundProjection? {
    BrokerCredentialBoundProjection(
      providerBinding: .openAI,
      projection: .staging(
        StagingAttempt(
          connectionID: connectionID,
          attemptID: Self.attemptID,
          fence: 1,
          candidate: Self.generation,
          previousReady: nil,
          startedAt: Date(timeIntervalSince1970: 1)
        )
      )
    )
  }

  func reserveCredentialUse(
    connectionID: UUID,
    expectedBinding: ProviderProfileBinding,
    purpose: CredentialUsePurpose
  ) async throws(CredentialUseError) -> CredentialUseReservation {
    let lifetime = CredentialUseLifetime(onAbandon: { _ in })
    _ = lifetime.install(SecretBytes(Data("factory-key".utf8)))
    return CredentialUseReservation(
      lifetime: lifetime,
      identity: .stagingCandidate(
        connectionID: connectionID,
        fence: 1,
        attemptID: Self.attemptID,
        generation: Self.generation
      ),
      providerBinding: expectedBinding
    )
  }

  func startCredentialUse<Prepared: Sendable>(
    _ reservation: CredentialUseReservation,
    prepare: @Sendable (UnsafeRawBufferPointer) -> CredentialUsePreparation<Prepared>,
    start: @Sendable (Prepared) -> Void
  ) async throws(CredentialUseError) -> DeliveryState {
    let selected = reservation.lifetime.withSecret { secret in
      secret.withUnsafeBytes(prepare)
    }
    guard let selected else { throw .invalidReservation }
    switch selected {
    case .prepared(let prepared):
      start(prepared)
      return .requestStarted
    case .rejected:
      throw .invalidCredential
    }
  }

  func cancelCredentialUse(_ reservation: CredentialUseReservation) async {
    reservation.lifetime.eraseSecret()
  }

  func releaseCredentialUse(_ reservation: CredentialUseReservation) async {
    reservation.lifetime.release()
  }

  func authoritativeLifecycleProjection(
    for connectionID: UUID
  ) async throws(BrokerJournalError) -> CredentialLifecycleProjection {
    .staging(
      connectionID: connectionID,
      fence: 1,
      attemptID: Self.attemptID,
      hasUsableReady: false
    )
  }

  func stage(
    connectionID: UUID,
    providerBinding: ProviderProfileBinding,
    operationID: UUID,
    expectedFence: UInt64,
    secret: sending SecretBytes
  ) async throws(BrokerStateError) -> StagingAttempt {
    secret.erase()
    throw .invalidTransition
  }

  func resumeStage(
    connectionID: UUID,
    operationID: UUID,
    expectedFence: UInt64
  ) async throws(BrokerStateError) -> StagingAttempt {
    throw .invalidTransition
  }

  func commit(
    connectionID: UUID,
    attemptID: UUID,
    operationID: UUID,
    expectedFence: UInt64
  ) async throws(BrokerStateError) -> ReadyProjection {
    throw .invalidTransition
  }

  func abort(
    connectionID: UUID,
    attemptID: UUID,
    operationID: UUID,
    expectedFence: UInt64
  ) async throws(BrokerStateError) -> ReadyProjection? {
    nil
  }

  func disconnect(
    connectionID: UUID,
    operationID: UUID,
    expectedFence: UInt64
  ) async throws(BrokerStateError) -> TombstoneProjection {
    throw .invalidTransition
  }
}

private final class SessionFactoryNetwork:
  BrokerOpenAIModelCatalogNetworking,
  @unchecked Sendable
{
  private let lock = NSLock()
  private var attempts = 0

  var attemptCount: Int { lock.withLock { attempts } }

  func makeAttempt(
    request: URLRequest,
    accumulator: BrokerOpenAIModelCatalogResponseAccumulator
  ) -> any BrokerOpenAIModelCatalogNetworkAttempt {
    lock.withLock { attempts += 1 }
    return SessionFactoryNetworkAttempt()
  }
}

private final class SessionFactoryNetworkAttempt:
  BrokerOpenAIModelCatalogNetworkAttempt,
  @unchecked Sendable
{
  func start() {}

  func response() async throws -> BrokerOpenAIModelCatalogNetworkResponse {
    BrokerOpenAIModelCatalogNetworkResponse(
      statusCode: 200,
      contentType: "application/json",
      xRequestID: "request-id",
      requestID: nil,
      body: Data(#"{"data":[{"id":"gpt-5"}]}"#.utf8)
    )
  }

  func cancel() {}
}
