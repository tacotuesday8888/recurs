import Foundation
import Testing

@testable import RecursBrokerCore

@Suite("Broker credential authoritative projection actor")
struct BrokerCredentialAuthoritativeProjectionActorTests {
  @Test
  func volatileModeReturnsItsDiagnosticProjectionWithoutJournalIO() async throws {
    let fixture = try AuthoritativeProjectionActorFixture()
    let ready = try fixture.readyProjection(connectionID: fixture.primaryID)
    let state = try BrokerCredentialState(
      store: InMemoryCredentialStore(),
      bootstrap: [.ready(ready)]
    )

    #expect(try await state.authoritativeProjection(for: fixture.primaryID) == .ready(ready))
    #expect(try await state.authoritativeProjection(for: fixture.secondaryID) == nil)
  }

  @Test(arguments: AuthoritativeStableReadCase.allCases)
  fileprivate func journalStableReadsRequireExactlyOneMatchingLoad(
    _ readCase: AuthoritativeStableReadCase
  ) async throws {
    let fixture = try AuthoritativeProjectionActorFixture()
    let record = try fixture.record(for: readCase)
    let harness = try await fixture.harness(records: record.map { [$0] } ?? [])
    await harness.journal.resetEvents()

    let projected = try await harness.state.authoritativeProjection(for: fixture.primaryID)

    #expect(projected == (try fixture.projection(for: record)))
    #expect(await harness.journal.events() == [.load(fixture.primaryID)])
  }

  @Test
  func journalStagingReadReturnsExactAttemptWithOneLoad() async throws {
    let fixture = try AuthoritativeProjectionActorFixture()
    let harness = try await fixture.harness(records: [])
    let attempt = try await fixture.stage(
      state: harness.state,
      connectionID: fixture.primaryID,
      operationID: fixture.stageID
    )
    await harness.journal.resetEvents()

    #expect(
      try await harness.state.authoritativeProjection(for: fixture.primaryID)
        == .staging(attempt)
    )
    #expect(await harness.journal.events() == [.load(fixture.primaryID)])
  }

  @Test
  func pausedUsableCleanupReturnsItsSafeReadyGenerationWithOneLoad() async throws {
    let fixture = try AuthoritativeProjectionActorFixture()
    let harness = try await fixture.pausedAbortCleanupHarness()
    let diagnostic = await harness.state.projection(for: fixture.primaryID)
    await harness.journal.resetEvents()

    let projected = try await harness.state.authoritativeProjection(for: fixture.primaryID)

    #expect(projected == diagnostic)
    #expect(projected?.usableReady?.generation.generationID == fixture.readyGenerationID)
    #expect(await harness.journal.events() == [.load(fixture.primaryID)])
  }

  @Test
  func readLeaseBlocksSameConnectionMutationWhileOtherConnectionProgresses() async throws {
    let fixture = try AuthoritativeProjectionActorFixture()
    let harness = try await fixture.harness(
      records: [
        fixture.vacantRecord(connectionID: fixture.primaryID),
        fixture.vacantRecord(connectionID: fixture.secondaryID),
      ]
    )
    await harness.journal.resetEvents()
    await harness.journal.pauseNext(at: .loadBeforeReturn)
    let read = Task {
      try await harness.state.authoritativeProjection(for: fixture.primaryID)
    }
    await harness.journal.waitUntilPaused(at: .loadBeforeReturn)

    let rejected = UncheckedSecretAlias(SecretBytes(Data("same-read-lease".utf8)))
    await expectAuthoritativeStateError(.operationInProgress) {
      try await harness.state.stage(
        connectionID: fixture.primaryID,
        operationID: fixture.blockedID,
        expectedFence: 0,
        secret: rejected.value
      )
    }
    #expect(rejected.isErased())

    let independent = try await fixture.stage(
      state: harness.state,
      connectionID: fixture.secondaryID,
      operationID: fixture.secondaryStageID
    )
    #expect(independent.connectionID == fixture.secondaryID)
    await harness.journal.releaseOne(at: .loadBeforeReturn)
    #expect(try await read.value == nil)
    #expect(
      await harness.journal.events().filter {
        if case .load(fixture.primaryID) = $0 { return true }
        return false
      } == [.load(fixture.primaryID)]
    )
  }

  @Test
  func activeMutationRejectsAuthoritativeReadBeforeJournalLoad() async throws {
    let fixture = try AuthoritativeProjectionActorFixture()
    let harness = try await fixture.harness(records: [])
    await harness.journal.pauseNext(at: .compareAndSwapBeforeSideEffect)
    let mutation = Task {
      try await fixture.stage(
        state: harness.state,
        connectionID: fixture.primaryID,
        operationID: fixture.stageID
      )
    }
    await harness.journal.waitUntilPaused(at: .compareAndSwapBeforeSideEffect)
    await harness.journal.resetEvents()

    await expectAuthoritativeJournalError(.casConflict) {
      try await harness.state.authoritativeProjection(for: fixture.primaryID)
    }
    #expect(await harness.journal.events().isEmpty)

    await harness.journal.releaseOne(at: .compareAndSwapBeforeSideEffect)
    _ = try await mutation.value
  }

  @Test
  func sameRecordDifferentTagDisablesOnlyConnectionWhileTerminalReplayWins() async throws {
    let fixture = try AuthoritativeProjectionActorFixture()
    let harness = try await fixture.harness(records: [])
    let attempt = try await fixture.stage(
      state: harness.state,
      connectionID: fixture.primaryID,
      operationID: fixture.stageID
    )
    let selected = try #require(try await harness.journal.load(connectionID: fixture.primaryID))
    let staleTag = BrokerJournalSnapshot(
      record: selected.record,
      authenticationTag: try JournalAuthenticationTag(bytes: Array(repeating: 0xee, count: 32))
    )
    await harness.journal.replaceExternally(staleTag)
    await harness.journal.resetEvents()

    await expectAuthoritativeJournalError(.casConflict) {
      try await harness.state.authoritativeProjection(for: fixture.primaryID)
    }
    #expect(await harness.state.projection(for: fixture.primaryID) == .staging(attempt))

    let eventsBeforeReplay = await harness.journal.events()
    let replaySecret = UncheckedSecretAlias(SecretBytes(Data("terminal-replay".utf8)))
    let replay = try await harness.state.stage(
      connectionID: fixture.primaryID,
      operationID: fixture.stageID,
      expectedFence: 0,
      secret: replaySecret.value
    )
    #expect(replay == attempt)
    #expect(replaySecret.isErased())
    #expect(await harness.journal.events() == eventsBeforeReplay)

    let rejected = UncheckedSecretAlias(SecretBytes(Data("disabled-connection".utf8)))
    await expectAuthoritativeStateError(.storeUnavailable) {
      try await harness.state.stage(
        connectionID: fixture.primaryID,
        operationID: fixture.blockedID,
        expectedFence: attempt.fence,
        secret: rejected.value
      )
    }
    #expect(rejected.isErased())

    #expect(try await harness.state.authoritativeProjection(for: fixture.secondaryID) == nil)
  }

  @Test(arguments: AuthoritativeSelectionMismatch.allCases)
  fileprivate func selectedNilAndPresentMismatchesDisableTheExactConnection(
    _ mismatch: AuthoritativeSelectionMismatch
  ) async throws {
    let fixture = try AuthoritativeProjectionActorFixture()
    let expectedRecord =
      mismatch == .expectedPresent
      ? try fixture.vacantRecord(
        connectionID: fixture.primaryID
      ) : nil
    let harness = try await fixture.harness(records: expectedRecord.map { [$0] } ?? [])
    if mismatch == .expectedPresent {
      await harness.journal.removeExternally(connectionID: fixture.primaryID)
    } else {
      await harness.journal.replaceExternally(
        try fixture.snapshot(fixture.vacantRecord(connectionID: fixture.primaryID))
      )
    }
    await harness.journal.resetEvents()

    await expectAuthoritativeJournalError(.casConflict) {
      try await harness.state.authoritativeProjection(for: fixture.primaryID)
    }
    #expect(await harness.journal.events() == [.load(fixture.primaryID)])
    await harness.journal.resetEvents()
    await expectAuthoritativeJournalError(.storageUnavailable) {
      try await harness.state.authoritativeProjection(for: fixture.primaryID)
    }
    #expect(await harness.journal.events().isEmpty)
  }

  @Test(arguments: AuthoritativeProjectionActorFixture.severeErrors)
  func severeLoadErrorGloballyPoisonsInflightAndLaterReads(
    _ error: BrokerJournalError
  ) async throws {
    let fixture = try AuthoritativeProjectionActorFixture()
    let harness = try await fixture.harness(
      records: [
        fixture.vacantRecord(connectionID: fixture.primaryID),
        fixture.vacantRecord(connectionID: fixture.secondaryID),
      ]
    )
    await harness.journal.resetEvents()
    await harness.journal.pauseNext(at: .loadBeforeReturn)
    let inflight = Task {
      try await harness.state.authoritativeProjection(for: fixture.secondaryID)
    }
    await harness.journal.waitUntilPaused(at: .loadBeforeReturn)
    await harness.journal.failNext(error, at: .loadBeforeReturn)

    await expectAuthoritativeJournalError(error) {
      try await harness.state.authoritativeProjection(for: fixture.primaryID)
    }
    await harness.journal.releaseOne(at: .loadBeforeReturn)
    await expectAuthoritativeJournalTaskError(.storageUnavailable, inflight)

    await harness.journal.resetEvents()
    await expectAuthoritativeJournalError(.storageUnavailable) {
      try await harness.state.authoritativeProjection(for: fixture.primaryID)
    }
    await expectAuthoritativeJournalError(.storageUnavailable) {
      try await harness.state.authoritativeProjection(for: fixture.secondaryID)
    }
    #expect(await harness.journal.events().isEmpty)
  }

  @Test(arguments: AuthoritativeProjectionActorFixture.severeErrors)
  func severeAuthorityMutationFailureGloballyPoisonsLaterWork(
    _ error: BrokerJournalError
  ) async throws {
    let fixture = try AuthoritativeProjectionActorFixture()
    let harness = try await fixture.harness(
      records: [fixture.vacantRecord(connectionID: fixture.secondaryID)]
    )
    let attempt = try await fixture.stage(
      state: harness.state,
      connectionID: fixture.primaryID,
      operationID: fixture.stageID
    )
    await harness.journal.resetEvents()
    await harness.journal.failNext(error, at: .compareAndSwapBeforeSideEffect)

    await expectAuthoritativeStateError(.storeUnavailable) {
      try await harness.state.commit(
        connectionID: fixture.primaryID,
        attemptID: attempt.attemptID,
        operationID: fixture.commitID,
        expectedFence: attempt.fence
      )
    }

    await harness.journal.resetEvents()
    await expectAuthoritativeJournalError(.storageUnavailable) {
      try await harness.state.authoritativeProjection(for: fixture.secondaryID)
    }
    let rejected = UncheckedSecretAlias(SecretBytes(Data("poisoned-journal".utf8)))
    await expectAuthoritativeStateError(.storeUnavailable) {
      try await harness.state.stage(
        connectionID: fixture.secondaryID,
        operationID: fixture.secondaryStageID,
        expectedFence: 0,
        secret: rejected.value
      )
    }
    #expect(rejected.isErased())
    #expect(await harness.journal.events().isEmpty)
    #expect(await harness.state.projection(for: fixture.primaryID) == .staging(attempt))
  }

  @Test(arguments: AuthoritativeProjectionActorFixture.nonsevereErrors)
  func nonsevereLoadFailureReleasesLeaseForOneLoadRetry(
    _ error: BrokerJournalError
  ) async throws {
    let fixture = try AuthoritativeProjectionActorFixture()
    let harness = try await fixture.harness(
      records: [fixture.vacantRecord(connectionID: fixture.primaryID)]
    )
    await harness.journal.resetEvents()
    await harness.journal.failNext(error, at: .loadBeforeReturn)

    await expectAuthoritativeJournalError(error) {
      try await harness.state.authoritativeProjection(for: fixture.primaryID)
    }
    #expect(await harness.journal.events() == [.load(fixture.primaryID)])
    await harness.journal.resetEvents()

    #expect(try await harness.state.authoritativeProjection(for: fixture.primaryID) == nil)
    #expect(await harness.journal.events() == [.load(fixture.primaryID)])
  }
}

private struct AuthoritativeProjectionActorFixture: Sendable {
  static let severeErrors: [BrokerJournalError] = [
    .invalidRecord,
    .nonCanonical,
    .unsupportedVersion,
    .authenticationFailed,
    .rollbackDetected,
  ]
  static let nonsevereErrors: [BrokerJournalError] = [
    .revisionOverflow,
    .casConflict,
    .lockUnavailable,
    .storageUnavailable,
    .mutationOutcomeUnknown,
  ]

  let primaryID = authoritativeProjectionActorUUID(1)
  let secondaryID = authoritativeProjectionActorUUID(2)
  let stageID = authoritativeProjectionActorUUID(10)
  let secondaryStageID = authoritativeProjectionActorUUID(11)
  let blockedID = authoritativeProjectionActorUUID(12)
  let commitID = authoritativeProjectionActorUUID(13)
  let attemptID = authoritativeProjectionActorUUID(20)
  let generationID = authoritativeProjectionActorUUID(21)
  let readyGenerationID = authoritativeProjectionActorUUID(22)
  let cleanupOperationID = authoritativeProjectionActorUUID(23)
  let time: JournalTimestamp

  init() throws {
    time = try JournalTimestamp(canonicalText: "2026-07-13T03:00:00.000Z")
  }

  func harness(
    records: [BrokerJournalRecord],
    store: InMemoryCredentialStore = InMemoryCredentialStore()
  ) async throws -> AuthoritativeProjectionActorHarness {
    let journal = try InMemoryBrokerJournalStore(snapshots: try records.map(snapshot))
    let generationIDs = LockedSequence([
      generationID,
      authoritativeProjectionActorUUID(30),
      authoritativeProjectionActorUUID(31),
    ])
    let attemptIDs = LockedSequence([
      attemptID,
      authoritativeProjectionActorUUID(40),
      authoritativeProjectionActorUUID(41),
    ])
    let state = try await BrokerCredentialState.recovering(
      store: store,
      journal: journal,
      clock: { time.date },
      generationIDSource: generationIDs.next,
      attemptIDSource: attemptIDs.next
    )
    return AuthoritativeProjectionActorHarness(state: state, journal: journal, store: store)
  }

  func pausedAbortCleanupHarness() async throws -> AuthoritativeProjectionActorHarness {
    let ready = try readyRecord(connectionID: primaryID)
    let pending = try BrokerJournalRecordAdapter.makeStorePending(
      predecessor: ready,
      connectionID: primaryID,
      providerBinding: .openAI,
      attemptID: attemptID,
      operationID: stageID,
      candidateGenerationID: generationID,
      capturedAt: time
    )
    let staging = try BrokerJournalRecordAdapter.makeStaging(
      predecessor: pending,
      changedAt: time
    )
    let cleanup = try BrokerJournalRecordAdapter.makeAbortCleanupPending(
      predecessor: staging,
      operationID: cleanupOperationID,
      changedAt: time
    )
    let store = InMemoryCredentialStore()
    await store.failNext(at: .deleteBeforeSideEffect)
    return try await harness(records: [cleanup], store: store)
  }

  func stage(
    state: BrokerCredentialState,
    connectionID: UUID,
    operationID: UUID
  ) async throws -> StagingAttempt {
    try await state.stage(
      connectionID: connectionID,
      operationID: operationID,
      expectedFence: 0,
      secret: SecretBytes(Data("authoritative-stage".utf8))
    )
  }

  func record(for readCase: AuthoritativeStableReadCase) throws -> BrokerJournalRecord? {
    switch readCase {
    case .absent:
      nil
    case .vacant:
      try vacantRecord(connectionID: primaryID)
    case .ready:
      try readyRecord(connectionID: primaryID)
    case .tombstone:
      try tombstoneRecord(connectionID: primaryID)
    }
  }

  func projection(for record: BrokerJournalRecord?) throws -> CredentialProjection? {
    guard let record else { return nil }
    return try BrokerJournalRecordAdapter.recoveryPlan(
      for: record,
      recoveryChangedAt: time
    ).projection
  }

  func vacantRecord(connectionID: UUID) throws -> BrokerJournalRecord {
    try BrokerJournalRecord(
      revision: 1,
      connectionID: connectionID,
      providerBinding: .openAI,
      fence: 0,
      lastGenerationOrdinal: 0,
      changedAt: time,
      payload: .vacant(BrokerJournalVacantPayload())
    )
  }

  func readyRecord(connectionID: UUID) throws -> BrokerJournalRecord {
    let ready = BrokerJournalReadyGeneration(
      generation: BrokerJournalCredentialGeneration(
        generationID: readyGenerationID,
        ordinal: 1,
        createdAt: time
      ),
      committedAt: time
    )
    return try BrokerJournalRecord(
      revision: 1,
      connectionID: connectionID,
      providerBinding: .openAI,
      fence: 1,
      lastGenerationOrdinal: 1,
      changedAt: time,
      payload: .ready(BrokerJournalReadyPayload(ready: ready))
    )
  }

  func readyProjection(connectionID: UUID) throws -> ReadyProjection {
    let record = try readyRecord(connectionID: connectionID)
    guard case .ready(let projection) = try projection(for: record) else {
      throw BrokerJournalError.invalidRecord
    }
    return projection
  }

  func tombstoneRecord(connectionID: UUID) throws -> BrokerJournalRecord {
    let fenced = try BrokerJournalRecordAdapter.makeDisconnectFenced(
      predecessor: readyRecord(connectionID: connectionID),
      operationID: cleanupOperationID,
      capturedAt: time
    )
    return try BrokerJournalRecordAdapter.makeTombstoned(
      predecessor: fenced,
      changedAt: time
    )
  }

  func snapshot(_ record: BrokerJournalRecord) throws -> BrokerJournalSnapshot {
    BrokerJournalSnapshot(
      record: record,
      authenticationTag: try JournalAuthenticationTag(
        bytes: Array(repeating: UInt8(truncatingIfNeeded: record.revision), count: 32)
      )
    )
  }
}

private struct AuthoritativeProjectionActorHarness: Sendable {
  let state: BrokerCredentialState
  let journal: InMemoryBrokerJournalStore
  let store: InMemoryCredentialStore
}

private enum AuthoritativeStableReadCase: CaseIterable, Sendable {
  case absent
  case vacant
  case ready
  case tombstone
}

private enum AuthoritativeSelectionMismatch: CaseIterable, Sendable {
  case expectedNil
  case expectedPresent
}

private func authoritativeProjectionActorUUID(_ value: Int) -> UUID {
  UUID(
    uuidString: String(
      format: "00000000-0000-4000-8000-%012llx",
      value
    )
  )!
}

private func expectAuthoritativeJournalError<Value>(
  _ expected: BrokerJournalError,
  _ operation: () async throws -> Value
) async {
  do {
    _ = try await operation()
    Issue.record("Expected journal error \(expected).")
  } catch let error as BrokerJournalError {
    #expect(error == expected)
  } catch {
    Issue.record("Unexpected error type: \(String(reflecting: error))")
  }
}

private func expectAuthoritativeJournalTaskError<Value>(
  _ expected: BrokerJournalError,
  _ task: Task<Value, any Error>
) async {
  do {
    _ = try await task.value
    Issue.record("Expected journal error \(expected).")
  } catch let error as BrokerJournalError {
    #expect(error == expected)
  } catch {
    Issue.record("Unexpected error type: \(String(reflecting: error))")
  }
}

private func expectAuthoritativeStateError<Value>(
  _ expected: BrokerStateError,
  _ operation: () async throws -> Value
) async {
  do {
    _ = try await operation()
    Issue.record("Expected broker error \(expected).")
  } catch let error as BrokerStateError {
    #expect(error == expected)
  } catch {
    Issue.record("Unexpected error type: \(String(reflecting: error))")
  }
}
