import Foundation
import RecursBrokerXPC
import Testing

@testable import RecursBrokerCore
@testable import RecursBrokerService

@Suite(.serialized)
struct BrokerOpenAIActivationReconciliationGatewayTests {
  @Test
  func freshConnectionUsesSharedHelloAndMonotonicAdmission() throws {
    let authority = ReconciliationAuthority(reads: [.value(nil)])
    let gateway = makeGateway(authority: authority)

    let beforeHello = submitReconciliation(gateway, requestID: 1)
    #expect(
      try decodedReconciliation(beforeHello.wait())
        == .failure(requestID: 1, .sessionNotReady)
    )

    gateway.authorizeAfterHello()
    let replay = submitReconciliation(gateway, requestID: 1)
    #expect(
      try decodedReconciliation(replay.wait())
        == .failure(requestID: 1, .invalidRequest)
    )

    let accepted = submitReconciliation(gateway, requestID: 2)
    #expect(
      try decodedReconciliation(accepted.wait())
        == .status(requestID: 2, .absent)
    )
  }

  @Test
  func authoritativeExactStatesMapToFixedRedactedStatuses() throws {
    let fixtures: [(BrokerCredentialBoundProjection?, BrokerOpenAIActivationReconciliationStatus)] =
      [
        (nil, .absent),
        (bound(.openAI, .ready(ready(connectionID: reconciliationConnectionID))), .readyOpenAI),
        (
          bound(
            .openAI,
            .tombstoned(tombstone(connectionID: reconciliationConnectionID))
          ),
          .absent
        ),
        (bound(.anthropic, .ready(ready(connectionID: reconciliationConnectionID))), .unresolved),
        (
          bound(
            .openAI,
            .ready(ready(connectionID: foreignReconciliationConnectionID))
          ),
          .unresolved
        ),
        (
          bound(
            .openAI,
            .staging(initialAttempt(startedAt: reconciliationNow, fence: 2))
          ),
          .unresolved
        ),
        (
          bound(
            .openAI,
            .staging(reconnectAttempt(startedAt: reconciliationNow))
          ),
          .unresolved
        ),
      ]

    for (offset, fixture) in fixtures.enumerated() {
      let authority = ReconciliationAuthority(reads: [.value(fixture.0)])
      let gateway = makeGateway(authority: authority)
      gateway.authorizeAfterHello()

      let reply = submitReconciliation(gateway, requestID: UInt64(offset + 1))

      #expect(
        try decodedReconciliation(reply.wait())
          == .status(requestID: UInt64(offset + 1), fixture.1)
      )
      #expect(authority.abortCalls.isEmpty)
    }

    let unavailable = ReconciliationAuthority(reads: [.failure(.storageUnavailable)])
    let gateway = makeGateway(authority: unavailable)
    gateway.authorizeAfterHello()
    #expect(
      try decodedReconciliation(submitReconciliation(gateway, requestID: 1).wait())
        == .status(requestID: 1, .unresolved)
    )
  }

  @Test
  func liveInitialSetupIsNeverAbortedBeforeTheSharedLifetime() async throws {
    let startedAt = reconciliationNow.addingTimeInterval(
      -brokerOpenAIOnboardingSetupLifetime + 0.001
    )
    let authority = ReconciliationAuthority(
      reads: [.value(bound(.openAI, .staging(initialAttempt(startedAt: startedAt))))]
    )
    let gateway = makeGateway(authority: authority)
    gateway.authorizeAfterHello()

    let reply = submitReconciliation(gateway, requestID: 1)

    #expect(
      try decodedReconciliation(reply.wait())
        == .status(requestID: 1, .unresolved)
    )
    #expect(authority.abortCalls.isEmpty)
    #expect(brokerOpenAIOnboardingSetupLifetime == 300)
  }

  @Test
  func expiredInitialSetupUsesFreshAbortThenAuthoritativeReread() async throws {
    let expired = initialAttempt(
      startedAt: reconciliationNow.addingTimeInterval(-brokerOpenAIOnboardingSetupLifetime)
    )
    let authority = ReconciliationAuthority(
      reads: [
        .value(bound(.openAI, .staging(expired))),
        .value(nil),
        .value(nil),
      ]
    )
    let gateway = makeGateway(authority: authority)
    gateway.authorizeAfterHello()

    #expect(
      try decodedReconciliation(submitReconciliation(gateway, requestID: 1).wait())
        == .status(requestID: 1, .absent)
    )
    #expect(
      authority.abortCalls == [
        ReconciliationAbortCall(
          connectionID: reconciliationConnectionID,
          attemptID: reconciliationAttemptID,
          operationID: reconciliationAbortOperationID,
          expectedFence: 1
        )
      ]
    )

    #expect(
      try decodedReconciliation(submitReconciliation(gateway, requestID: 2).wait())
        == .status(requestID: 2, .absent)
    )
    #expect(authority.abortCalls.count == 1)
  }

  @Test
  func abortErrorsZeroIdentityAndPostAbortRacesRemainUnresolved() async throws {
    let expired = bound(
      .openAI,
      .staging(
        initialAttempt(
          startedAt: reconciliationNow.addingTimeInterval(-brokerOpenAIOnboardingSetupLifetime)
        )
      )
    )
    let failedAbort = ReconciliationAuthority(
      reads: [.value(expired)],
      abortError: .attemptNotCurrent
    )
    let failedGateway = makeGateway(authority: failedAbort)
    failedGateway.authorizeAfterHello()
    #expect(
      try decodedReconciliation(submitReconciliation(failedGateway, requestID: 1).wait())
        == .status(requestID: 1, .unresolved)
    )

    let raced = ReconciliationAuthority(
      reads: [
        .value(expired),
        .value(bound(.anthropic, .ready(ready(connectionID: reconciliationConnectionID)))),
      ]
    )
    let racedGateway = makeGateway(authority: raced)
    racedGateway.authorizeAfterHello()
    #expect(
      try decodedReconciliation(submitReconciliation(racedGateway, requestID: 1).wait())
        == .status(requestID: 1, .unresolved)
    )

    let zeroIdentity = ReconciliationAuthority(reads: [.value(expired)])
    let zeroGateway = makeGateway(authority: zeroIdentity, generatedUUID: zeroReconciliationUUID)
    zeroGateway.authorizeAfterHello()
    #expect(
      try decodedReconciliation(submitReconciliation(zeroGateway, requestID: 1).wait())
        == .status(requestID: 1, .unresolved)
    )
    #expect(zeroIdentity.abortCalls.isEmpty)
  }

  @Test
  func reconciliationIsOneInflightCancellableAndExactlyOnce() async throws {
    let pause = ReconciliationReadPause()
    let authority = ReconciliationAuthority(reads: [.paused(nil, pause)])
    let gateway = makeGateway(authority: authority)
    gateway.authorizeAfterHello()

    let first = submitReconciliation(gateway, requestID: 1)
    await pause.waitUntilEntered()
    let busy = submitReconciliation(gateway, requestID: 2)
    #expect(
      try decodedReconciliation(busy.wait())
        == .failure(requestID: 2, .busy)
    )

    gateway.close()

    #expect(
      try decodedReconciliation(first.wait())
        == .failure(requestID: 1, .cancelled)
    )
    #expect(first.count == 1)
    #expect(authority.abortCalls.isEmpty)
  }

  private func makeGateway(
    authority: ReconciliationAuthority,
    generatedUUID: UUID = reconciliationAbortOperationID
  ) -> BrokerOpenAIOnboardingGateway {
    BrokerOpenAIOnboardingGateway(
      authority: authority,
      factory: UnusedReconciliationSessionFactory(),
      credentialIdentityFingerprinter: UnusedReconciliationFingerprinter(),
      makeUUID: { generatedUUID },
      clock: { reconciliationNow }
    )
  }
}

private let reconciliationConnectionID = UUID(
  uuidString: "71000000-0000-4000-8000-000000000001"
)!
private let foreignReconciliationConnectionID = UUID(
  uuidString: "71000000-0000-4000-8000-000000000002"
)!
private let reconciliationAttemptID = UUID(
  uuidString: "72000000-0000-4000-8000-000000000001"
)!
private let reconciliationGenerationID = UUID(
  uuidString: "73000000-0000-4000-8000-000000000001"
)!
private let reconciliationAbortOperationID = UUID(
  uuidString: "74000000-0000-4000-8000-000000000001"
)!
private let zeroReconciliationUUID = UUID(
  uuid: (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
)
private let reconciliationNow = Date(timeIntervalSince1970: 10_000)

private func bound(
  _ binding: ProviderProfileBinding,
  _ projection: CredentialProjection
) -> BrokerCredentialBoundProjection {
  BrokerCredentialBoundProjection(providerBinding: binding, projection: projection)
}

private func generation() -> CredentialGeneration {
  CredentialGeneration(
    generationID: reconciliationGenerationID,
    ordinal: 1,
    createdAt: reconciliationNow.addingTimeInterval(-1_000)
  )
}

private func readyGeneration() -> ReadyGeneration {
  ReadyGeneration(
    generation: generation(),
    committedAt: reconciliationNow.addingTimeInterval(-900)
  )
}

private func ready(connectionID: UUID) -> ReadyProjection {
  ReadyProjection(
    connectionID: connectionID,
    fence: 1,
    ready: readyGeneration(),
    lastGenerationOrdinal: 1
  )
}

private func tombstone(connectionID: UUID) -> TombstoneProjection {
  TombstoneProjection(
    connectionID: connectionID,
    fence: 2,
    lastGenerationOrdinal: 1,
    tombstonedAt: reconciliationNow.addingTimeInterval(-800)
  )
}

private func initialAttempt(startedAt: Date, fence: UInt64 = 1) -> StagingAttempt {
  StagingAttempt(
    connectionID: reconciliationConnectionID,
    attemptID: reconciliationAttemptID,
    fence: fence,
    candidate: generation(),
    previousReady: nil,
    startedAt: startedAt
  )
}

private func reconnectAttempt(startedAt: Date) -> StagingAttempt {
  StagingAttempt(
    connectionID: reconciliationConnectionID,
    attemptID: reconciliationAttemptID,
    fence: 2,
    candidate: CredentialGeneration(
      generationID: UUID(uuidString: "73000000-0000-4000-8000-000000000002")!,
      ordinal: 2,
      createdAt: startedAt
    ),
    previousReady: readyGeneration(),
    startedAt: startedAt
  )
}

private enum ReconciliationRead: Sendable {
  case value(BrokerCredentialBoundProjection?)
  case failure(BrokerJournalError)
  case paused(BrokerCredentialBoundProjection?, ReconciliationReadPause)
}

private struct ReconciliationAbortCall: Sendable, Equatable {
  let connectionID: UUID
  let attemptID: UUID
  let operationID: UUID
  let expectedFence: UInt64
}

private final class ReconciliationAuthority: @unchecked Sendable,
  BrokerCredentialLifecycleAuthority
{
  private let lock = NSLock()
  private var storedReads: [ReconciliationRead]
  private let abortError: BrokerStateError?
  private var storedAbortCalls: [ReconciliationAbortCall] = []

  init(reads: [ReconciliationRead], abortError: BrokerStateError? = nil) {
    self.storedReads = reads
    self.abortError = abortError
  }

  var abortCalls: [ReconciliationAbortCall] { lock.withLock { storedAbortCalls } }

  func authoritativeBoundProjection(
    for _: UUID
  ) async throws(BrokerJournalError) -> BrokerCredentialBoundProjection? {
    let read = lock.withLock { storedReads.isEmpty ? nil : storedReads.removeFirst() }
    guard let read else { throw .storageUnavailable }
    switch read {
    case .value(let projection):
      return projection
    case .failure(let error):
      throw error
    case .paused(let projection, let pause):
      await pause.wait()
      if Task.isCancelled { throw .storageUnavailable }
      return projection
    }
  }

  func authoritativeLifecycleProjection(
    for connectionID: UUID
  ) async throws(BrokerJournalError) -> CredentialLifecycleProjection {
    .missing(connectionID: connectionID)
  }

  func stage(
    connectionID _: UUID,
    providerBinding _: ProviderProfileBinding,
    operationID _: UUID,
    expectedFence _: UInt64,
    secret: sending SecretBytes
  ) async throws(BrokerStateError) -> StagingAttempt {
    secret.erase()
    throw .invalidTransition
  }

  func resumeStage(
    connectionID _: UUID,
    operationID _: UUID,
    expectedFence _: UInt64
  ) async throws(BrokerStateError) -> StagingAttempt {
    throw .invalidTransition
  }

  func commit(
    connectionID _: UUID,
    attemptID _: UUID,
    operationID _: UUID,
    expectedFence _: UInt64
  ) async throws(BrokerStateError) -> ReadyProjection {
    throw .invalidTransition
  }

  func abort(
    connectionID: UUID,
    attemptID: UUID,
    operationID: UUID,
    expectedFence: UInt64
  ) async throws(BrokerStateError) -> ReadyProjection? {
    lock.withLock {
      storedAbortCalls.append(
        ReconciliationAbortCall(
          connectionID: connectionID,
          attemptID: attemptID,
          operationID: operationID,
          expectedFence: expectedFence
        )
      )
    }
    if let abortError { throw abortError }
    return nil
  }

  func disconnect(
    connectionID _: UUID,
    operationID _: UUID,
    expectedFence _: UInt64
  ) async throws(BrokerStateError) -> TombstoneProjection {
    throw .invalidTransition
  }
}

private actor ReconciliationReadPause {
  private var entered = false

  func wait() async {
    entered = true
    try? await Task.sleep(for: .seconds(30))
  }

  func waitUntilEntered() async {
    while !entered { await Task.yield() }
  }
}

private struct UnusedReconciliationSessionFactory: BrokerOpenAIOnboardingSessionFactory {
  func makeSession(
    context _: BrokerOpenAIOnboardingStagingContext,
    abortOperationID _: UUID
  ) throws(BrokerOpenAIOnboardingError) -> any BrokerOpenAIOnboardingSessionProtocol {
    throw .invalidContext
  }
}

private struct UnusedReconciliationFingerprinter: CredentialIdentityFingerprinting {
  func fingerprint(
    credential _: UnsafeRawBufferPointer,
    binding _: ProviderProfileBinding
  ) throws(CredentialIdentityFingerprintError) -> CredentialIdentityFingerprint {
    throw .invalidCredential
  }
}

private final class ReconciliationReplyProbe: @unchecked Sendable {
  private let condition = NSCondition()
  private var values: [Data] = []

  var count: Int { condition.withLock { values.count } }

  func receive(_ value: Data) {
    condition.withLock {
      values.append(value)
      condition.broadcast()
    }
  }

  func wait(timeout: TimeInterval = 3) -> Data {
    condition.lock()
    defer { condition.unlock() }
    let deadline = Date().addingTimeInterval(timeout)
    while values.isEmpty, condition.wait(until: deadline) {}
    guard let first = values.first else {
      Issue.record("Timed out waiting for a reconciliation reply")
      return Data()
    }
    return first
  }
}

private func submitReconciliation(
  _ gateway: BrokerOpenAIOnboardingGateway,
  requestID: UInt64
) -> ReconciliationReplyProbe {
  let probe = ReconciliationReplyProbe()
  do {
    gateway.submitReconciliation(
      try BrokerOpenAIActivationReconciliationRequest.reconcile(
        requestID: requestID,
        connectionID: reconciliationConnectionID
      ).encode(),
      reply: probe.receive
    )
  } catch {
    Issue.record("Failed to construct a valid reconciliation request")
  }
  return probe
}

private func decodedReconciliation(
  _ data: Data
) throws -> BrokerOpenAIActivationReconciliationReply {
  try BrokerOpenAIActivationReconciliationReply.decode(data)
}
