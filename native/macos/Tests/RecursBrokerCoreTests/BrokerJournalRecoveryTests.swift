import Foundation
import Testing

@testable import RecursBrokerCore

@Suite("Broker journal recovery")
struct BrokerJournalRecoveryTests {
  @Test
  func stablePhasesReturnExactSnapshotsAndPlansWithoutCAS() async throws {
    let fixture = try RecoveryFixture()
    let snapshots = try [
      fixture.snapshot(.tombstoned, id: 7),
      fixture.snapshot(.ready, id: 3),
      fixture.snapshot(.vacant, id: 1),
      fixture.snapshot(.disconnectFenced, id: 6),
      fixture.snapshot(.abortCleanupPending, id: 5),
      fixture.snapshot(.stageCleanupPending, id: 4),
      fixture.snapshot(.readyCleanupPending, id: 2),
    ]
    let journal = try InMemoryBrokerJournalStore(snapshots: snapshots)
    let clock = LockedSequence([fixture.recoveryTime.date])

    let entries = try await BrokerJournalRecovery.prepare(journal: journal, clock: clock.next)

    let expected = snapshots.sorted(by: canonicalSnapshotOrder)
    #expect(entries.map(\.snapshot) == expected)
    #expect(
      entries.map(\.plan)
        == (try expected.map {
          try BrokerJournalRecordAdapter.recoveryPlan(
            for: $0.record,
            recoveryChangedAt: fixture.recoveryTime
          )
        }))
    #expect(await journal.events() == [.list])
    #expect(clock.count() == 1)
  }

  @Test
  func convertsPendingPhasesInCanonicalOrderWithOneCapturedTime() async throws {
    let fixture = try RecoveryFixture()
    let later = try fixture.snapshot(.staging, id: 2)
    let earlier = try fixture.snapshot(.storePending, id: 1)
    let journal = try InMemoryBrokerJournalStore(snapshots: [later, earlier])
    let clock = LockedSequence([fixture.recoveryTime.date])

    let entries = try await BrokerJournalRecovery.prepare(journal: journal, clock: clock.next)

    #expect(
      entries.map { $0.snapshot.record.connectionID } == [
        earlier.record.connectionID, later.record.connectionID,
      ])
    guard
      case .stageCleanupPending(let first) = entries[0].snapshot.record.payload,
      case .stageCleanupPending(let second) = entries[1].snapshot.record.payload
    else {
      Issue.record("expected both interrupted stages to be durably prepared")
      return
    }
    #expect(first.error == .storeUnavailable)
    #expect(second.error == .attemptNotCurrent)
    #expect(entries.allSatisfy { $0.snapshot.record.changedAt == fixture.recoveryTime })
    let predecessorPlans = try [earlier, later].map {
      try BrokerJournalRecordAdapter.recoveryPlan(
        for: $0.record,
        recoveryChangedAt: fixture.recoveryTime
      )
    }
    for (entry, predecessorPlan) in zip(entries, predecessorPlans) {
      let selectedPlan = try BrokerJournalRecordAdapter.recoveryPlan(
        for: entry.snapshot.record,
        recoveryChangedAt: fixture.recoveryTime
      )
      #expect(entry.plan == selectedPlan)
      #expect(entry.plan.preparation == nil)
      #expect(entry.plan.bootstrap == predecessorPlan.bootstrap)
      #expect(entry.plan.projection == predecessorPlan.projection)
      #expect(entry.plan.cleanup == predecessorPlan.cleanup)
    }
    #expect(
      await journal.events() == [
        .list,
        .compareAndSwap(earlier.record.connectionID),
        .compareAndSwap(later.record.connectionID),
      ])
    #expect(clock.count() == 1)
  }

  @Test
  func emptyJournalAvoidsClockAndMutation() async throws {
    let journal = try InMemoryBrokerJournalStore()
    let clock = LockedSequence([Date.distantFuture])

    let entries = try await BrokerJournalRecovery.prepare(journal: journal, clock: clock.next)

    #expect(entries.isEmpty)
    #expect(clock.count() == 0)
    #expect(await journal.events() == [.list])
  }

  @Test
  func listAndClockFailuresOccurBeforeMutation() async throws {
    let fixture = try RecoveryFixture()
    let pending = try fixture.snapshot(.storePending, id: 1)

    let listFailureJournal = try InMemoryBrokerJournalStore(snapshots: [pending])
    await listFailureJournal.failNext(.storageUnavailable, at: .listBeforeReturn)
    let unusedClock = LockedSequence([fixture.recoveryTime.date])
    await #expect(throws: BrokerJournalError.storageUnavailable) {
      _ = try await BrokerJournalRecovery.prepare(
        journal: listFailureJournal,
        clock: unusedClock.next
      )
    }
    #expect(unusedClock.count() == 0)
    #expect(await listFailureJournal.events() == [.list])

    let clockFailureJournal = try InMemoryBrokerJournalStore(snapshots: [pending])
    let invalidClock = LockedSequence([Date(timeIntervalSince1970: .infinity)])
    await #expect(throws: BrokerJournalError.invalidRecord) {
      _ = try await BrokerJournalRecovery.prepare(
        journal: clockFailureJournal,
        clock: invalidClock.next
      )
    }
    #expect(invalidClock.count() == 1)
    #expect(await clockFailureJournal.events() == [.list])
    #expect(
      try await clockFailureJournal.load(connectionID: pending.record.connectionID) == pending)
  }

  @Test
  func everyPlanIsValidatedBeforeTheFirstConversion() async throws {
    let fixture = try RecoveryFixture()
    let first = try fixture.snapshot(.storePending, id: 1)
    let overflowing = try fixture.snapshot(.staging, id: 2, revision: UInt64.max)
    let journal = try InMemoryBrokerJournalStore(snapshots: [first, overflowing])
    let clock = LockedSequence([fixture.recoveryTime.date])

    await #expect(throws: BrokerJournalError.revisionOverflow) {
      _ = try await BrokerJournalRecovery.prepare(journal: journal, clock: clock.next)
    }

    #expect(await journal.events() == [.list])
    #expect(clock.count() == 1)
    #expect(try await journal.load(connectionID: first.record.connectionID) == first)
  }

  @Test
  func laterConversionFailureLeavesEarlierPreparationDurableAndStopsLaterWork() async throws {
    let fixture = try RecoveryFixture()
    let first = try fixture.snapshot(.storePending, id: 1)
    let second = try fixture.snapshot(.staging, id: 2)
    let third = try fixture.snapshot(.storePending, id: 3)
    let journal = try InMemoryBrokerJournalStore(snapshots: [third, second, first])
    await journal.pauseNext(at: .compareAndSwapAfterSideEffect)
    let operation = Task {
      try await BrokerJournalRecovery.prepare(
        journal: journal,
        clock: { fixture.recoveryTime.date }
      )
    }
    await journal.waitUntilPaused(at: .compareAndSwapAfterSideEffect)
    await journal.failNext(.storageUnavailable, at: .compareAndSwapBeforeSideEffect)
    await journal.releaseOne(at: .compareAndSwapAfterSideEffect)

    await #expect(throws: BrokerJournalError.storageUnavailable) {
      _ = try await operation.value
    }

    let firstSelected = try #require(
      try await journal.load(connectionID: first.record.connectionID)
    )
    #expect(firstSelected.record.phase == .stageCleanupPending)
    #expect(try await journal.load(connectionID: second.record.connectionID) == second)
    #expect(try await journal.load(connectionID: third.record.connectionID) == third)
    let mutationEvents = await journal.events().filter {
      if case .compareAndSwap = $0 { return true }
      return false
    }
    #expect(
      mutationEvents == [
        .compareAndSwap(first.record.connectionID),
        .compareAndSwap(second.record.connectionID),
      ])
  }

  @Test
  func outcomeUnknownNeverPromotesARecordWithoutExactTagIdentity() async throws {
    let fixture = try RecoveryFixture()
    let pending = try fixture.snapshot(.storePending, id: 1)
    let journal = try InMemoryBrokerJournalStore(snapshots: [pending])
    await journal.failNext(.mutationOutcomeUnknown, at: .compareAndSwapAfterSideEffect)

    await #expect(throws: BrokerJournalError.mutationOutcomeUnknown) {
      _ = try await BrokerJournalRecovery.prepare(
        journal: journal,
        clock: { fixture.recoveryTime.date }
      )
    }

    let selected = try #require(
      try await journal.load(connectionID: pending.record.connectionID)
    )
    #expect(selected.record.phase == .stageCleanupPending)
    #expect(
      await journal.events() == [
        .list,
        .compareAndSwap(pending.record.connectionID),
        .load(pending.record.connectionID),
      ])
  }

  @Test
  func outcomeUnknownWithExactPreviousRethrowsTheOriginalError() async throws {
    let fixture = try RecoveryFixture()
    let pending = try fixture.snapshot(.storePending, id: 1)
    let journal = try InMemoryBrokerJournalStore(snapshots: [pending])
    await journal.failNext(.mutationOutcomeUnknown, at: .compareAndSwapBeforeSideEffect)

    await #expect(throws: BrokerJournalError.mutationOutcomeUnknown) {
      _ = try await BrokerJournalRecovery.prepare(
        journal: journal,
        clock: { fixture.recoveryTime.date }
      )
    }

    #expect(try await journal.load(connectionID: pending.record.connectionID) == pending)
  }

  @Test
  func outcomeUnknownWithUnrelatedOrAbsentSelectionRemainsUnknown() async throws {
    let fixture = try RecoveryFixture()
    for remove in [false, true] {
      let pending = try fixture.snapshot(.storePending, id: remove ? 2 : 1)
      let journal = try InMemoryBrokerJournalStore(snapshots: [pending])
      await journal.pauseNext(at: .compareAndSwapAfterSideEffect)
      await journal.failNext(.mutationOutcomeUnknown, at: .compareAndSwapAfterSideEffect)
      let operation = Task {
        try await BrokerJournalRecovery.prepare(
          journal: journal,
          clock: { fixture.recoveryTime.date }
        )
      }
      await journal.waitUntilPaused(at: .compareAndSwapAfterSideEffect)
      if remove {
        await journal.removeExternally(connectionID: pending.record.connectionID)
      } else {
        await journal.replaceExternally(
          BrokerJournalSnapshot(
            record: pending.record,
            authenticationTag: try fixture.tag(byte: 0xee)
          )
        )
      }
      await journal.releaseOne(at: .compareAndSwapAfterSideEffect)

      await #expect(throws: BrokerJournalError.mutationOutcomeUnknown) {
        _ = try await operation.value
      }
    }
  }

  @Test
  func definiteCASConflictWithUnrelatedSelectionRemainsConflict() async throws {
    let fixture = try RecoveryFixture()
    let pending = try fixture.snapshot(.storePending, id: 1)
    let journal = try InMemoryBrokerJournalStore(snapshots: [pending])
    await journal.pauseNext(at: .compareAndSwapBeforeSideEffect)
    let operation = Task {
      try await BrokerJournalRecovery.prepare(
        journal: journal,
        clock: { fixture.recoveryTime.date }
      )
    }
    await journal.waitUntilPaused(at: .compareAndSwapBeforeSideEffect)
    await journal.replaceExternally(
      BrokerJournalSnapshot(
        record: pending.record,
        authenticationTag: try fixture.tag(byte: 0xdd)
      )
    )
    await journal.releaseOne(at: .compareAndSwapBeforeSideEffect)

    await #expect(throws: BrokerJournalError.casConflict) {
      _ = try await operation.value
    }
  }
}

private struct RecoveryFixture: Sendable {
  enum Phase {
    case vacant
    case storePending
    case staging
    case readyCleanupPending
    case ready
    case stageCleanupPending
    case abortCleanupPending
    case disconnectFenced
    case tombstoned
  }

  let recordTime: JournalTimestamp
  let recoveryTime: JournalTimestamp

  init() throws {
    recordTime = try JournalTimestamp(canonicalText: "2026-07-13T00:00:00.000Z")
    recoveryTime = try JournalTimestamp(canonicalText: "2026-07-13T00:00:01.000Z")
  }

  func snapshot(
    _ phase: Phase,
    id: Int,
    revision: UInt64 = 1
  ) throws -> BrokerJournalSnapshot {
    BrokerJournalSnapshot(
      record: try record(phase, id: id, revision: revision),
      authenticationTag: try tag(byte: UInt8(truncatingIfNeeded: id))
    )
  }

  func tag(byte: UInt8) throws -> JournalAuthenticationTag {
    try JournalAuthenticationTag(bytes: Array(repeating: byte, count: 32))
  }

  private func record(
    _ phase: Phase,
    id: Int,
    revision: UInt64
  ) throws -> BrokerJournalRecord {
    let connectionID = recoveryUUID(id, prefix: 0)
    let attemptID = recoveryUUID(id, prefix: 1)
    let operationID = recoveryUUID(id, prefix: 2)
    let previous = BrokerJournalReadyGeneration(
      generation: BrokerJournalCredentialGeneration(
        generationID: recoveryUUID(id, prefix: 3),
        ordinal: 1,
        createdAt: recordTime
      ),
      committedAt: recordTime
    )
    let candidate = BrokerJournalCredentialGeneration(
      generationID: recoveryUUID(id, prefix: 4),
      ordinal: 2,
      createdAt: recordTime
    )

    let fence: UInt64
    let ordinal: UInt64
    let payload: BrokerJournalPayload
    switch phase {
    case .vacant:
      fence = 0
      ordinal = 0
      payload = .vacant(BrokerJournalVacantPayload())
    case .storePending:
      fence = 2
      ordinal = 2
      payload = .storePending(
        BrokerJournalStorePendingPayload(
          attemptID: attemptID,
          operationID: operationID,
          expectedFence: 1,
          candidate: candidate,
          previousReady: previous,
          startedAt: recordTime
        )
      )
    case .staging:
      fence = 2
      ordinal = 2
      payload = .staging(
        BrokerJournalStagingPayload(
          attemptID: attemptID,
          operationID: operationID,
          expectedFence: 1,
          candidate: candidate,
          previousReady: previous,
          startedAt: recordTime
        )
      )
    case .readyCleanupPending:
      fence = 2
      ordinal = 2
      payload = .readyCleanupPending(
        BrokerJournalReadyCleanupPendingPayload(
          attemptID: attemptID,
          operationID: operationID,
          expectedFence: 2,
          ready: BrokerJournalReadyGeneration(generation: candidate, committedAt: recordTime),
          previousReady: previous
        )
      )
    case .ready:
      fence = 2
      ordinal = 2
      payload = .ready(BrokerJournalReadyPayload(ready: previous))
    case .stageCleanupPending:
      fence = 2
      ordinal = 2
      payload = .stageCleanupPending(
        BrokerJournalStageCleanupPendingPayload(
          attemptID: attemptID,
          operationID: operationID,
          expectedFence: 1,
          candidate: candidate,
          restoredReady: previous,
          error: .cancelled
        )
      )
    case .abortCleanupPending:
      fence = 2
      ordinal = 2
      payload = .abortCleanupPending(
        BrokerJournalAbortCleanupPendingPayload(
          attemptID: attemptID,
          operationID: operationID,
          expectedFence: 2,
          candidate: candidate,
          restoredReady: previous
        )
      )
    case .disconnectFenced:
      fence = 3
      ordinal = 2
      payload = .disconnectFenced(
        BrokerJournalDisconnectFencedPayload(
          operationID: operationID,
          expectedFence: 2,
          tombstonedAt: recordTime,
          deleteGenerations: [candidate, previous.generation]
        )
      )
    case .tombstoned:
      fence = 3
      ordinal = 2
      payload = .tombstoned(BrokerJournalTombstonedPayload(tombstonedAt: recordTime))
    }
    return try BrokerJournalRecord(
      revision: revision,
      connectionID: connectionID,
      fence: fence,
      lastGenerationOrdinal: ordinal,
      changedAt: recordTime,
      payload: payload
    )
  }
}

private func recoveryUUID(_ value: Int, prefix: Int) -> UUID {
  UUID(uuidString: String(format: "%08d-0000-4000-8000-%012d", prefix, value))!
}

private func canonicalSnapshotOrder(
  _ lhs: BrokerJournalSnapshot,
  _ rhs: BrokerJournalSnapshot
) -> Bool {
  lhs.record.connectionID.uuidString.lowercased()
    < rhs.record.connectionID.uuidString.lowercased()
}
