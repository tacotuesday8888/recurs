import Foundation
import Testing

@testable import RecursBrokerCore

@Suite("Broker credential recovery executor")
struct BrokerCredentialRecoveryExecutorTests {
  @Test
  func emptyAndStableRecoveryInstallAuthorityWithoutCleanupSideEffects() async throws {
    let fixture = try RecoveryExecutorFixture()
    let emptyJournal = try InMemoryBrokerJournalStore()
    let emptyClock = LockedSequence([fixture.recoveryDate])
    let empty = try await BrokerCredentialState.recoveringForTests(
      store: InMemoryCredentialStore(),
      journal: emptyJournal,
      clock: emptyClock.next
    )
    #expect(await empty.projection(for: fixture.connectionID(99)) == nil)
    #expect(emptyClock.count() == 0)

    let ready = try fixture.snapshot(fixture.readyRecord(id: 1))
    let tombstone = try fixture.snapshot(fixture.tombstoneRecord(id: 2))
    let journal = try InMemoryBrokerJournalStore(snapshots: [tombstone, ready])
    let clock = LockedSequence([fixture.recoveryDate])
    let state = try await BrokerCredentialState.recoveringForTests(
      store: InMemoryCredentialStore(),
      journal: journal,
      clock: clock.next
    )

    #expect(
      await state.projection(for: ready.record.connectionID) == fixture.readyProjection(id: 1))
    #expect(
      await state.projection(for: tombstone.record.connectionID)
        == fixture.tombstoneProjection(id: 2)
    )
    #expect(clock.count() == 1)
    #expect(await journal.events() == [.list])
  }

  @Test
  func factoryCompletesAllFourCleanupFamiliesInCanonicalOrder() async throws {
    let fixture = try RecoveryExecutorFixture()
    let records = try [
      fixture.stageCleanupRecord(id: 10, restored: false),
      fixture.readyCleanupRecord(id: 11),
      fixture.abortCleanupRecord(id: 12, restored: true),
      fixture.disconnectCleanupRecord(id: 13),
    ]
    let snapshots = try records.reversed().map(fixture.snapshot)
    let journal = try InMemoryBrokerJournalStore(snapshots: snapshots)
    let store = InMemoryCredentialStore()
    let clock = LockedSequence(Array(repeating: fixture.recoveryDate, count: 5))

    let state = try await BrokerCredentialState.recoveringForTests(
      store: store,
      journal: journal,
      clock: clock.next
    )

    #expect(await state.projection(for: records[0].connectionID) == nil)
    #expect(await state.projection(for: records[1].connectionID) == fixture.candidateReady(id: 11))
    #expect(await state.projection(for: records[2].connectionID) == fixture.readyProjection(id: 12))
    #expect(
      await state.projection(for: records[3].connectionID)
        == fixture.tombstoneProjection(id: 13)
    )
    #expect(clock.count() == 5)

    for record in records {
      let selected = try #require(try await journal.load(connectionID: record.connectionID))
      #expect(selected.record.phase == fixture.stablePhase(after: record))
      let cleanup = try #require(
        try BrokerJournalRecordAdapter.recoveryPlan(
          for: record,
          recoveryChangedAt: fixture.recoveryTime
        ).cleanup
      )
      for key in cleanup.credentialKeys {
        #expect(await store.deleteCallCount(for: key) == 1)
      }
    }
    let casEvents = await journal.events().filter {
      if case .compareAndSwap = $0 { return true }
      return false
    }
    #expect(casEvents == records.map { .compareAndSwap($0.connectionID) })
  }

  @Test
  func deleteFailurePausesOneConnectionButFactoryAttemptsEveryOtherCleanup() async throws {
    let fixture = try RecoveryExecutorFixture()
    let first = try fixture.stageCleanupRecord(id: 20, restored: false)
    let second = try fixture.abortCleanupRecord(id: 21, restored: true)
    let journal = try InMemoryBrokerJournalStore(
      snapshots: [try fixture.snapshot(first), try fixture.snapshot(second)]
    )
    let store = InMemoryCredentialStore()
    await store.failNext(at: .deleteBeforeSideEffect)
    let clock = LockedSequence(Array(repeating: fixture.recoveryDate, count: 3))

    let state = try await BrokerCredentialState.recoveringForTests(
      store: store,
      journal: journal,
      clock: clock.next
    )

    #expect((try await journal.load(connectionID: first.connectionID))?.record == first)
    #expect(
      (try await journal.load(connectionID: second.connectionID))?.record.phase == .ready
    )
    #expect(await state.projection(for: first.connectionID) == nil)
    #expect(await state.projection(for: second.connectionID) == fixture.readyProjection(id: 21))

    _ = try await state.resumeRecoveredCleanupForTests(connectionID: first.connectionID)
    #expect(
      (try await journal.load(connectionID: first.connectionID))?.record.phase == .vacant
    )
  }

  @Test
  func afterSideEffectDeleteFailureRetriesTheIdempotentDeleteThenFinalizes() async throws {
    let fixture = try RecoveryExecutorFixture()
    let record = try fixture.stageCleanupRecord(id: 30, restored: false)
    let journal = try InMemoryBrokerJournalStore(snapshots: [try fixture.snapshot(record)])
    let store = InMemoryCredentialStore()
    await store.failNext(at: .deleteAfterSideEffect)
    let clock = LockedSequence(Array(repeating: fixture.recoveryDate, count: 3))

    let state = try await BrokerCredentialState.recoveringForTests(
      store: store,
      journal: journal,
      clock: clock.next
    )
    let key = try #require(
      try BrokerJournalRecordAdapter.recoveryPlan(
        for: record,
        recoveryChangedAt: fixture.recoveryTime
      ).cleanup
    ).credentialKeys[0]
    #expect(await store.deleteCallCount(for: key) == 1)

    _ = try await state.resumeRecoveredCleanupForTests(connectionID: record.connectionID)

    #expect(await store.deleteCallCount(for: key) == 2)
    #expect((try await journal.load(connectionID: record.connectionID))?.record.phase == .vacant)
  }

  @Test
  func finalCASFailureAbortsFactoryAndRestartRepeatsIdempotentDeletes() async throws {
    let fixture = try RecoveryExecutorFixture()
    let record = try fixture.disconnectCleanupRecord(id: 40)
    let journal = try InMemoryBrokerJournalStore(snapshots: [try fixture.snapshot(record)])
    await journal.failNext(.storageUnavailable, at: .compareAndSwapBeforeSideEffect)
    let store = InMemoryCredentialStore()
    let clock = LockedSequence(Array(repeating: fixture.recoveryDate, count: 4))

    await #expect(throws: BrokerJournalError.storageUnavailable) {
      _ = try await BrokerCredentialState.recoveringForTests(
        store: store,
        journal: journal,
        clock: clock.next
      )
    }
    let cleanup = try #require(
      try BrokerJournalRecordAdapter.recoveryPlan(
        for: record,
        recoveryChangedAt: fixture.recoveryTime
      ).cleanup
    )
    for key in cleanup.credentialKeys {
      #expect(await store.deleteCallCount(for: key) == 1)
    }
    #expect((try await journal.load(connectionID: record.connectionID))?.record == record)

    _ = try await BrokerCredentialState.recoveringForTests(
      store: store,
      journal: journal,
      clock: clock.next
    )

    for key in cleanup.credentialKeys {
      #expect(await store.deleteCallCount(for: key) == 2)
    }
    #expect(
      (try await journal.load(connectionID: record.connectionID))?.record.phase == .tombstoned
    )
  }

  @Test(arguments: [BrokerJournalError.authenticationFailed, .rollbackDetected])
  func finalAuthorityFailuresAbortRecoveryFactory(_ failure: BrokerJournalError) async throws {
    let fixture = try RecoveryExecutorFixture()
    let record = try fixture.stageCleanupRecord(
      id: failure == .authenticationFailed ? 41 : 42, restored: false)
    let journal = try InMemoryBrokerJournalStore(snapshots: [try fixture.snapshot(record)])
    await journal.failNext(failure, at: .compareAndSwapBeforeSideEffect)
    let clock = LockedSequence(Array(repeating: fixture.recoveryDate, count: 2))

    await #expect(throws: failure) {
      _ = try await BrokerCredentialState.recoveringForTests(
        store: InMemoryCredentialStore(),
        journal: journal,
        clock: clock.next
      )
    }
  }

  @Test
  func invalidFinalizationClockAbortsAfterAValidListAndDelete() async throws {
    let fixture = try RecoveryExecutorFixture()
    let record = try fixture.stageCleanupRecord(id: 43, restored: false)
    let journal = try InMemoryBrokerJournalStore(snapshots: [try fixture.snapshot(record)])
    let store = InMemoryCredentialStore()
    let clock = LockedSequence([
      fixture.recoveryDate,
      Date(timeIntervalSince1970: .infinity),
    ])

    await #expect(throws: BrokerJournalError.invalidRecord) {
      _ = try await BrokerCredentialState.recoveringForTests(
        store: store,
        journal: journal,
        clock: clock.next
      )
    }

    let cleanup = try #require(
      try BrokerJournalRecordAdapter.recoveryPlan(
        for: record,
        recoveryChangedAt: fixture.recoveryTime
      ).cleanup
    )
    #expect(await store.deleteCallCount(for: cleanup.credentialKeys[0]) == 1)
    #expect((try await journal.load(connectionID: record.connectionID))?.record == record)
  }

  @Test
  func cleanupClockIsLazyUntilEveryDeleteHasCompleted() async throws {
    let fixture = try RecoveryExecutorFixture()
    let record = try fixture.stageCleanupRecord(id: 50, restored: false)
    let journal = try InMemoryBrokerJournalStore(snapshots: [try fixture.snapshot(record)])
    let store = InMemoryCredentialStore()
    await store.pauseNext(at: .deleteBeforeSideEffect)
    let clock = LockedSequence(Array(repeating: fixture.recoveryDate, count: 2))
    let operation = Task {
      try await BrokerCredentialState.recoveringForTests(
        store: store,
        journal: journal,
        clock: clock.next
      )
    }
    await store.waitUntilPaused(at: .deleteBeforeSideEffect)

    #expect(clock.count() == 1)
    await store.releaseOne(at: .deleteBeforeSideEffect)
    _ = try await operation.value
    #expect(clock.count() == 2)
  }

  @Test
  func recoveredActorsAllowJournaledLifecycleAndPreserveStateErrors() async throws {
    let fixture = try RecoveryExecutorFixture()
    let ready = try fixture.readyRecordWithStageFailure(id: 60)
    let journal = try InMemoryBrokerJournalStore(snapshots: [try fixture.snapshot(ready)])
    let store = InMemoryCredentialStore()
    let state = try await BrokerCredentialState.recoveringForTests(
      store: store,
      journal: journal,
      clock: { fixture.recoveryDate }
    )
    let alias = UncheckedSecretAlias(SecretBytes(Data("must-erase".utf8)))

    let attempt = try await state.stage(
      connectionID: ready.connectionID,
      operationID: recoveryExecutorUUID(60, 90),
      expectedFence: ready.fence,
      secret: alias.value
    )
    #expect(!alias.isErased())
    #expect(await state.projection(for: ready.connectionID) == .staging(attempt))
    let replayAlias = UncheckedSecretAlias(SecretBytes(Data("replay-erase".utf8)))
    await expectRecoveryBrokerError(.cancelled) {
      try await state.stage(
        connectionID: ready.connectionID,
        operationID: recoveryExecutorUUID(60, 92),
        expectedFence: 0,
        secret: replayAlias.value
      )
    }
    #expect(replayAlias.isErased())
    await expectRecoveryBrokerError(.staleFence) {
      try await state.disconnect(
        connectionID: ready.connectionID,
        operationID: recoveryExecutorUUID(60, 91),
        expectedFence: ready.fence
      )
    }
    #expect(await store.inspection().storeCallCounts.count == 1)
    #expect(await store.inspection().deleteCallCounts.isEmpty)
  }

  @Test
  func cancelledFreshStagePrecedesRecoveredActorModeGuardAndErasesSecret() async throws {
    let fixture = try RecoveryExecutorFixture()
    let ready = try fixture.readyRecord(id: 61)
    let journal = try InMemoryBrokerJournalStore(snapshots: [try fixture.snapshot(ready)])
    let store = InMemoryCredentialStore()
    let state = try await BrokerCredentialState.recoveringForTests(
      store: store,
      journal: journal,
      clock: { fixture.recoveryDate }
    )
    let gate = AsyncGate()
    let alias = UncheckedSecretAlias(SecretBytes(Data("cancelled-stage".utf8)))
    let task = Task {
      await gate.wait()
      return try await state.stage(
        connectionID: ready.connectionID,
        operationID: recoveryExecutorUUID(61, 90),
        expectedFence: ready.fence,
        secret: alias.value
      )
    }

    task.cancel()
    await gate.release()
    await expectRecoveryTaskError(.cancelled, task)

    #expect(alias.isErased())
    #expect(await store.inspection().storeCallCounts.isEmpty)
  }

  @Test
  func cancelledFreshDisconnectPrecedesRecoveredActorModeGuard() async throws {
    let fixture = try RecoveryExecutorFixture()
    let ready = try fixture.readyRecord(id: 62)
    let journal = try InMemoryBrokerJournalStore(snapshots: [try fixture.snapshot(ready)])
    let store = InMemoryCredentialStore()
    let state = try await BrokerCredentialState.recoveringForTests(
      store: store,
      journal: journal,
      clock: { fixture.recoveryDate }
    )
    let gate = AsyncGate()
    let task = Task {
      await gate.wait()
      return try await state.disconnect(
        connectionID: ready.connectionID,
        operationID: recoveryExecutorUUID(62, 90),
        expectedFence: ready.fence
      )
    }

    task.cancel()
    await gate.release()
    await expectRecoveryTaskError(.cancelled, task)

    #expect(await store.inspection().deleteCallCounts.isEmpty)
  }
}

private struct RecoveryExecutorFixture: Sendable {
  let recordTime: JournalTimestamp
  let recoveryTime: JournalTimestamp

  init() throws {
    recordTime = try JournalTimestamp(canonicalText: "2026-07-13T00:00:00.000Z")
    recoveryTime = try JournalTimestamp(canonicalText: "2026-07-13T00:00:01.000Z")
  }

  var recoveryDate: Date { recoveryTime.date }

  func connectionID(_ id: Int) -> UUID { recoveryExecutorUUID(id, 0) }

  func snapshot(_ record: BrokerJournalRecord) throws -> BrokerJournalSnapshot {
    BrokerJournalSnapshot(
      record: record,
      authenticationTag: try JournalAuthenticationTag(
        bytes: Array(repeating: UInt8(truncatingIfNeeded: record.revision), count: 32)
      )
    )
  }

  func readyRecord(id: Int) throws -> BrokerJournalRecord {
    let values = values(id)
    return try record(id: id, payload: .ready(BrokerJournalReadyPayload(ready: values.previous)))
  }

  func readyRecordWithStageFailure(id: Int) throws -> BrokerJournalRecord {
    let values = values(id)
    return try BrokerJournalRecord(
      revision: 1,
      connectionID: connectionID(id),
      fence: 2,
      lastGenerationOrdinal: 2,
      changedAt: recordTime,
      payload: .ready(BrokerJournalReadyPayload(ready: values.previous)),
      terminalOperations: [
        .stageFailure(
          BrokerJournalStageFailureTerminal(
            operationID: recoveryExecutorUUID(id, 92),
            expectedFence: 0,
            error: .cancelled
          )
        )
      ]
    )
  }

  func tombstoneRecord(id: Int) throws -> BrokerJournalRecord {
    try BrokerJournalRecord(
      revision: 1,
      connectionID: connectionID(id),
      fence: 3,
      lastGenerationOrdinal: 2,
      changedAt: recordTime,
      payload: .tombstoned(BrokerJournalTombstonedPayload(tombstonedAt: recordTime))
    )
  }

  func stageCleanupRecord(id: Int, restored: Bool) throws -> BrokerJournalRecord {
    let values = values(id)
    return try record(
      id: id,
      payload: .stageCleanupPending(
        BrokerJournalStageCleanupPendingPayload(
          attemptID: values.attemptID,
          operationID: values.operationID,
          expectedFence: 1,
          candidate: values.candidate,
          restoredReady: restored ? values.previous : nil,
          error: .cancelled
        )
      )
    )
  }

  func readyCleanupRecord(id: Int) throws -> BrokerJournalRecord {
    let values = values(id)
    return try record(
      id: id,
      payload: .readyCleanupPending(
        BrokerJournalReadyCleanupPendingPayload(
          attemptID: values.attemptID,
          operationID: values.operationID,
          expectedFence: 2,
          ready: BrokerJournalReadyGeneration(
            generation: values.candidate,
            committedAt: recordTime
          ),
          previousReady: values.previous
        )
      )
    )
  }

  func abortCleanupRecord(id: Int, restored: Bool) throws -> BrokerJournalRecord {
    let values = values(id)
    return try record(
      id: id,
      payload: .abortCleanupPending(
        BrokerJournalAbortCleanupPendingPayload(
          attemptID: values.attemptID,
          operationID: values.operationID,
          expectedFence: 2,
          candidate: values.candidate,
          restoredReady: restored ? values.previous : nil
        )
      )
    )
  }

  func disconnectCleanupRecord(id: Int) throws -> BrokerJournalRecord {
    let values = values(id)
    return try BrokerJournalRecord(
      revision: 1,
      connectionID: connectionID(id),
      fence: 3,
      lastGenerationOrdinal: 2,
      changedAt: recordTime,
      payload: .disconnectFenced(
        BrokerJournalDisconnectFencedPayload(
          operationID: values.operationID,
          expectedFence: 2,
          tombstonedAt: recordTime,
          deleteGenerations: [values.candidate, values.previous.generation]
        )
      )
    )
  }

  func readyProjection(id: Int) -> CredentialProjection {
    let values = values(id)
    return .ready(
      ReadyProjection(
        connectionID: connectionID(id),
        fence: 2,
        ready: ReadyGeneration(
          generation: CredentialGeneration(
            generationID: values.previous.generation.generationID,
            ordinal: 1,
            createdAt: recordTime.date
          ),
          committedAt: recordTime.date
        ),
        lastGenerationOrdinal: 2
      )
    )
  }

  func candidateReady(id: Int) -> CredentialProjection {
    let values = values(id)
    return .ready(
      ReadyProjection(
        connectionID: connectionID(id),
        fence: 2,
        ready: ReadyGeneration(
          generation: CredentialGeneration(
            generationID: values.candidate.generationID,
            ordinal: 2,
            createdAt: recordTime.date
          ),
          committedAt: recordTime.date
        ),
        lastGenerationOrdinal: 2
      )
    )
  }

  func tombstoneProjection(id: Int) -> CredentialProjection {
    .tombstoned(
      TombstoneProjection(
        connectionID: connectionID(id),
        fence: 3,
        lastGenerationOrdinal: 2,
        tombstonedAt: recordTime.date
      )
    )
  }

  func stablePhase(after record: BrokerJournalRecord) -> BrokerJournalPhase {
    switch record.payload {
    case .stageCleanupPending(let payload): payload.restoredReady == nil ? .vacant : .ready
    case .abortCleanupPending(let payload): payload.restoredReady == nil ? .vacant : .ready
    case .readyCleanupPending: .ready
    case .disconnectFenced: .tombstoned
    default: record.phase
    }
  }

  private func record(id: Int, payload: BrokerJournalPayload) throws -> BrokerJournalRecord {
    try BrokerJournalRecord(
      revision: 1,
      connectionID: connectionID(id),
      fence: 2,
      lastGenerationOrdinal: 2,
      changedAt: recordTime,
      payload: payload
    )
  }

  private func values(_ id: Int) -> (
    attemptID: UUID,
    operationID: UUID,
    previous: BrokerJournalReadyGeneration,
    candidate: BrokerJournalCredentialGeneration
  ) {
    (
      recoveryExecutorUUID(id, 1),
      recoveryExecutorUUID(id, 2),
      BrokerJournalReadyGeneration(
        generation: BrokerJournalCredentialGeneration(
          generationID: recoveryExecutorUUID(id, 3),
          ordinal: 1,
          createdAt: recordTime
        ),
        committedAt: recordTime
      ),
      BrokerJournalCredentialGeneration(
        generationID: recoveryExecutorUUID(id, 4),
        ordinal: 2,
        createdAt: recordTime
      )
    )
  }
}

private func recoveryExecutorUUID(_ connection: Int, _ value: Int) -> UUID {
  UUID(
    uuidString: String(
      format: "%08d-0000-4000-8000-%012d",
      connection,
      value
    )
  )!
}

private func expectRecoveryBrokerError<T>(
  _ expected: BrokerStateError,
  operation: () async throws -> T
) async {
  do {
    _ = try await operation()
    Issue.record("Expected broker error \(expected)")
  } catch let error as BrokerStateError {
    #expect(error == expected)
  } catch {
    Issue.record("Unexpected error type: \(String(reflecting: error))")
  }
}

private func expectRecoveryTaskError<Value>(
  _ expected: BrokerStateError,
  _ task: Task<Value, any Error>
) async {
  do {
    _ = try await task.value
    Issue.record("Expected task to fail with \(expected).")
  } catch let error as BrokerStateError {
    #expect(error == expected)
  } catch {
    Issue.record("Unexpected error type: \(String(reflecting: error))")
  }
}
