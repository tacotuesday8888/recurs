import Foundation
import Testing

@testable import RecursBrokerCore

@Suite("In-memory broker journal store")
struct InMemoryBrokerJournalStoreTests {
  @Test
  func listAndLoadPreserveExactSnapshotsInCanonicalConnectionOrder() async throws {
    let later = try initialSnapshot(id: 2)
    let earlier = try initialSnapshot(id: 1)
    let missingID = UUID()
    let store = try InMemoryBrokerJournalStore(snapshots: [later, earlier])

    #expect(try await store.list() == [earlier, later])
    #expect(try await store.load(connectionID: earlier.record.connectionID) == earlier)
    #expect(try await store.load(connectionID: missingID) == nil)
    #expect(await store.events() == [.list, .load(earlier.record.connectionID), .load(missingID)])
  }

  @Test
  func initializationRejectsDuplicateOrUnboundedAuthority() throws {
    let snapshot = try initialSnapshot(id: 3)
    #expect(throws: BrokerJournalError.rollbackDetected) {
      _ = try InMemoryBrokerJournalStore(snapshots: [snapshot, snapshot])
    }

    let excessive = try (0...InMemoryBrokerJournalStore.maximumSnapshotCount).map {
      try initialSnapshot(id: $0 + 10)
    }
    #expect(throws: BrokerJournalError.rollbackDetected) {
      _ = try InMemoryBrokerJournalStore(snapshots: excessive)
    }
  }

  @Test
  func creationEnforcesTheAuthorityBoundBeforeAndAfterItsBarrier() async throws {
    let fullSnapshots = try (0..<InMemoryBrokerJournalStore.maximumSnapshotCount).map {
      try initialSnapshot(id: $0 + 10_000)
    }
    let fullStore = try InMemoryBrokerJournalStore(snapshots: fullSnapshots)
    let rejected = try initialSnapshot(id: 20_000)

    await #expect(throws: BrokerJournalError.rollbackDetected) {
      _ = try await fullStore.compareAndSwap(
        expected: nil,
        replacement: rejected.record
      )
    }
    #expect(try await fullStore.load(connectionID: rejected.record.connectionID) == nil)

    let almostFullSnapshots = try (0..<(InMemoryBrokerJournalStore.maximumSnapshotCount - 1))
      .map {
        try initialSnapshot(id: $0 + 30_000)
      }
    let racedStore = try InMemoryBrokerJournalStore(snapshots: almostFullSnapshots)
    let raced = try initialSnapshot(id: 40_000)
    let competitor = try initialSnapshot(id: 50_000)
    await racedStore.pauseNext(at: .compareAndSwapBeforeSideEffect)
    let operation = Task {
      try await racedStore.compareAndSwap(expected: nil, replacement: raced.record)
    }
    await racedStore.waitUntilPaused(at: .compareAndSwapBeforeSideEffect)
    await racedStore.replaceExternally(competitor)
    await racedStore.releaseOne(at: .compareAndSwapBeforeSideEffect)

    await #expect(throws: BrokerJournalError.rollbackDetected) {
      _ = try await operation.value
    }
    #expect(try await racedStore.load(connectionID: raced.record.connectionID) == nil)
    #expect(
      try await racedStore.load(connectionID: competitor.record.connectionID)
        == competitor
    )
  }

  @Test
  func compareAndSwapRequiresExactSnapshotAndClosedTransition() async throws {
    let current = try initialSnapshot(id: 4)
    let store = try InMemoryBrokerJournalStore(snapshots: [current])
    let successor = try stagingRecord(from: current.record)

    let result = try await store.compareAndSwap(expected: current, replacement: successor)

    #expect(result.record == successor)
    #expect(try await store.load(connectionID: successor.connectionID) == result)
    await #expect(throws: BrokerJournalError.casConflict) {
      _ = try await store.compareAndSwap(expected: current, replacement: successor)
    }
    await #expect(throws: BrokerJournalError.casConflict) {
      _ = try await store.compareAndSwap(expected: nil, replacement: successor)
    }
  }

  @Test
  func pausedCASRechecksExpectedSnapshotBeforeItsSideEffect() async throws {
    let current = try initialSnapshot(id: 5)
    let store = try InMemoryBrokerJournalStore(snapshots: [current])
    let successor = try stagingRecord(from: current.record)
    let competitor = BrokerJournalSnapshot(
      record: current.record,
      authenticationTag: try tag(byte: 0xcc)
    )
    await store.pauseNext(at: .compareAndSwapBeforeSideEffect)
    let operation = Task {
      try await store.compareAndSwap(expected: current, replacement: successor)
    }
    await store.waitUntilPaused(at: .compareAndSwapBeforeSideEffect)
    await store.replaceExternally(competitor)
    await store.releaseOne(at: .compareAndSwapBeforeSideEffect)

    await #expect(throws: BrokerJournalError.casConflict) {
      _ = try await operation.value
    }
    #expect(try await store.load(connectionID: current.record.connectionID) == competitor)
  }

  @Test
  func scriptedFailuresExposeWhetherTheCASSideEffectOccurred() async throws {
    let beforeCurrent = try initialSnapshot(id: 6)
    let beforeStore = try InMemoryBrokerJournalStore(snapshots: [beforeCurrent])
    let beforeSuccessor = try stagingRecord(from: beforeCurrent.record)
    await beforeStore.failNext(
      .storageUnavailable,
      at: .compareAndSwapBeforeSideEffect
    )

    await #expect(throws: BrokerJournalError.storageUnavailable) {
      _ = try await beforeStore.compareAndSwap(
        expected: beforeCurrent,
        replacement: beforeSuccessor
      )
    }
    #expect(
      try await beforeStore.load(connectionID: beforeCurrent.record.connectionID)
        == beforeCurrent
    )

    let afterCurrent = try initialSnapshot(id: 7)
    let afterStore = try InMemoryBrokerJournalStore(snapshots: [afterCurrent])
    let afterSuccessor = try stagingRecord(from: afterCurrent.record)
    await afterStore.failNext(
      .mutationOutcomeUnknown,
      at: .compareAndSwapAfterSideEffect
    )

    await #expect(throws: BrokerJournalError.mutationOutcomeUnknown) {
      _ = try await afterStore.compareAndSwap(
        expected: afterCurrent,
        replacement: afterSuccessor
      )
    }
    #expect(
      try await afterStore.load(connectionID: afterCurrent.record.connectionID)?.record
        == afterSuccessor
    )
  }

  private func initialSnapshot(id: Int) throws -> BrokerJournalSnapshot {
    let connectionID = try #require(
      UUID(uuidString: String(format: "00000000-0000-4000-8000-%012d", id))
    )
    let createdAt = try JournalTimestamp(canonicalText: "2026-07-13T00:00:00.000Z")
    let generation = BrokerJournalCredentialGeneration(
      generationID: try #require(
        UUID(uuidString: String(format: "10000000-0000-4000-8000-%012d", id))
      ),
      ordinal: 1,
      createdAt: createdAt
    )
    let record = try BrokerJournalRecord(
      revision: 1,
      connectionID: connectionID,
      fence: 1,
      lastGenerationOrdinal: 1,
      changedAt: createdAt,
      payload: .storePending(
        BrokerJournalStorePendingPayload(
          attemptID: try #require(
            UUID(uuidString: String(format: "20000000-0000-4000-8000-%012d", id))
          ),
          operationID: try #require(
            UUID(uuidString: String(format: "30000000-0000-4000-8000-%012d", id))
          ),
          expectedFence: 0,
          candidate: generation,
          previousReady: nil,
          startedAt: createdAt
        )
      )
    )
    return BrokerJournalSnapshot(
      record: record,
      authenticationTag: try tag(byte: UInt8(truncatingIfNeeded: id))
    )
  }

  private func stagingRecord(from current: BrokerJournalRecord) throws -> BrokerJournalRecord {
    guard case .storePending(let pending) = current.payload else {
      throw BrokerJournalError.invalidRecord
    }
    return try BrokerJournalRecord(
      revision: current.revision + 1,
      connectionID: current.connectionID,
      fence: current.fence,
      lastGenerationOrdinal: current.lastGenerationOrdinal,
      changedAt: current.changedAt,
      payload: .staging(
        BrokerJournalStagingPayload(
          attemptID: pending.attemptID,
          operationID: pending.operationID,
          expectedFence: pending.expectedFence,
          candidate: pending.candidate,
          previousReady: pending.previousReady,
          startedAt: pending.startedAt
        )
      ),
      terminalOperations: current.terminalOperations
    )
  }

  private func tag(byte: UInt8) throws -> JournalAuthenticationTag {
    try JournalAuthenticationTag(bytes: Array(repeating: byte, count: 32))
  }
}
