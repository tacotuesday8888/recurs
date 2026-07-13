import Foundation
import Testing

@testable import RecursBrokerCore
@testable import RecursBrokerService

@Suite
struct BrokerCredentialAuthorityTests {
  @Test
  func recoveryRestoresStableRecordsAndForwardsToOneStateActor() async throws {
    let vacantID = UUID(uuidString: "10000000-0000-4000-8000-000000000001")!
    let readyID = UUID(uuidString: "10000000-0000-4000-8000-000000000002")!
    let tombstoneID = UUID(uuidString: "10000000-0000-4000-8000-000000000003")!
    let store = AuthorityCredentialStore()
    let journal = AuthorityJournalStore(
      snapshots: try [
        snapshot(record: vacantRecord(vacantID)),
        snapshot(record: readyRecord(readyID)),
        snapshot(record: tombstoneRecord(tombstoneID)),
      ]
    )

    let authority = try await BrokerCredentialAuthority.recovering(
      store: store,
      journal: journal
    )

    #expect(
      try await authority.authoritativeLifecycleProjection(for: vacantID)
        == .vacant(connectionID: vacantID, fence: 0)
    )
    #expect(
      try await authority.authoritativeLifecycleProjection(for: readyID)
        == .ready(connectionID: readyID, fence: 1)
    )
    #expect(
      try await authority.authoritativeLifecycleProjection(for: tombstoneID)
        == .tombstoned(connectionID: tombstoneID, fence: 2)
    )

    let operationID = UUID(uuidString: "20000000-0000-4000-8000-000000000001")!
    let attempt = try await authority.stage(
      connectionID: vacantID,
      operationID: operationID,
      expectedFence: 0,
      secret: SecretBytes(Data("authority-secret".utf8))
    )
    #expect(attempt.connectionID == vacantID)
    #expect(
      try await authority.authoritativeLifecycleProjection(for: vacantID)
        == .staging(
          connectionID: vacantID,
          fence: 1,
          attemptID: attempt.attemptID,
          hasUsableReady: false
        )
    )
    #expect(await store.storedCount() == 1)
  }

  @Test(arguments: [
    BrokerJournalError.authenticationFailed,
    .rollbackDetected,
    .lockUnavailable,
    .storageUnavailable,
  ])
  func recoveryDoesNotDowngradeJournalAuthorityFailures(
    _ failure: BrokerJournalError
  ) async {
    let journal = AuthorityJournalStore(listFailure: failure)

    await #expect(throws: failure) {
      _ = try await BrokerCredentialAuthority.recovering(
        store: AuthorityCredentialStore(),
        journal: journal
      )
    }
  }

  @Test
  func cleanupFailureBlocksThatConnectionWhileOtherReadyRecordsRecover() async throws {
    let cleanupID = UUID(uuidString: "10000000-0000-4000-8000-000000000010")!
    let readyID = UUID(uuidString: "10000000-0000-4000-8000-000000000011")!
    let cleanupOperationID = UUID(uuidString: "20000000-0000-4000-8000-000000000010")!
    let store = AuthorityCredentialStore(failingDeleteConnectionID: cleanupID)
    let journal = AuthorityJournalStore(
      snapshots: try [
        snapshot(record: cleanupRecord(cleanupID, operationID: cleanupOperationID)),
        snapshot(record: readyRecord(readyID)),
      ]
    )

    let authority = try await BrokerCredentialAuthority.recovering(
      store: store,
      journal: journal
    )

    #expect(
      try await authority.authoritativeLifecycleProjection(for: readyID)
        == .ready(connectionID: readyID, fence: 1)
    )
    await #expect(throws: BrokerStateError.cleanupPending) {
      _ = try await authority.resumeStage(
        connectionID: cleanupID,
        operationID: cleanupOperationID,
        expectedFence: 0
      )
    }
    #expect(await store.loadCount() == 0)
  }

  private func snapshot(record: BrokerJournalRecord) throws -> BrokerJournalSnapshot {
    BrokerJournalSnapshot(record: record, authenticationTag: .zero)
  }

  private func vacantRecord(_ connectionID: UUID) throws -> BrokerJournalRecord {
    try BrokerJournalRecord(
      revision: 1,
      connectionID: connectionID,
      fence: 0,
      lastGenerationOrdinal: 0,
      changedAt: JournalTimestamp(unixMilliseconds: 1_000),
      payload: .vacant(BrokerJournalVacantPayload())
    )
  }

  private func readyRecord(_ connectionID: UUID) throws -> BrokerJournalRecord {
    let time = try JournalTimestamp(unixMilliseconds: 1_000)
    let generation = BrokerJournalCredentialGeneration(
      generationID: UUID(uuidString: "30000000-0000-4000-8000-000000000001")!,
      ordinal: 1,
      createdAt: time
    )
    let ready = BrokerJournalReadyGeneration(generation: generation, committedAt: time)
    return try BrokerJournalRecord(
      revision: 1,
      connectionID: connectionID,
      fence: 1,
      lastGenerationOrdinal: 1,
      changedAt: time,
      payload: .ready(BrokerJournalReadyPayload(ready: ready))
    )
  }

  private func tombstoneRecord(_ connectionID: UUID) throws -> BrokerJournalRecord {
    let time = try JournalTimestamp(unixMilliseconds: 1_000)
    return try BrokerJournalRecord(
      revision: 1,
      connectionID: connectionID,
      fence: 2,
      lastGenerationOrdinal: 1,
      changedAt: time,
      payload: .tombstoned(BrokerJournalTombstonedPayload(tombstonedAt: time))
    )
  }

  private func cleanupRecord(
    _ connectionID: UUID,
    operationID: UUID
  ) throws -> BrokerJournalRecord {
    let time = try JournalTimestamp(unixMilliseconds: 1_000)
    let candidate = BrokerJournalCredentialGeneration(
      generationID: UUID(uuidString: "30000000-0000-4000-8000-000000000010")!,
      ordinal: 1,
      createdAt: time
    )
    return try BrokerJournalRecord(
      revision: 1,
      connectionID: connectionID,
      fence: 1,
      lastGenerationOrdinal: 1,
      changedAt: time,
      payload: .stageCleanupPending(
        BrokerJournalStageCleanupPendingPayload(
          attemptID: UUID(uuidString: "40000000-0000-4000-8000-000000000010")!,
          operationID: operationID,
          expectedFence: 0,
          candidate: candidate,
          restoredReady: nil,
          error: .storeUnavailable
        )
      )
    )
  }
}

private actor AuthorityCredentialStore: CredentialStore {
  private let failingDeleteConnectionID: UUID?
  private var retained: [CredentialStoreKey: SecretBytes] = [:]
  private var loads = 0

  init(failingDeleteConnectionID: UUID? = nil) {
    self.failingDeleteConnectionID = failingDeleteConnectionID
  }

  func store(
    _ secret: sending SecretBytes,
    for key: CredentialStoreKey
  ) async throws(CredentialStoreError) {
    retained.removeValue(forKey: key)?.erase()
    retained[key] = secret
  }

  func load(for key: CredentialStoreKey) async throws(CredentialStoreError) -> sending SecretBytes {
    loads += 1
    guard let retained = retained[key] else { throw .unavailable }
    return SecretBytes(retained.withUnsafeBytes { Data($0) })
  }

  func deleteIfPresent(_ key: CredentialStoreKey) async throws(CredentialStoreError) {
    if key.connectionID == failingDeleteConnectionID { throw .unavailable }
    retained.removeValue(forKey: key)?.erase()
  }

  func storedCount() -> Int { retained.count }
  func loadCount() -> Int { loads }
}

private actor AuthorityJournalStore: BrokerJournalStore {
  private var snapshots: [UUID: BrokerJournalSnapshot]
  private let listFailure: BrokerJournalError?

  init(
    snapshots: [BrokerJournalSnapshot] = [],
    listFailure: BrokerJournalError? = nil
  ) {
    self.snapshots = Dictionary(
      uniqueKeysWithValues: snapshots.map { ($0.record.connectionID, $0) })
    self.listFailure = listFailure
  }

  func list() async throws(BrokerJournalError) -> [BrokerJournalSnapshot] {
    if let listFailure { throw listFailure }
    return snapshots.values.sorted {
      $0.record.connectionID.uuidString < $1.record.connectionID.uuidString
    }
  }

  func load(connectionID: UUID) async throws(BrokerJournalError) -> BrokerJournalSnapshot? {
    snapshots[connectionID]
  }

  func compareAndSwap(
    expected: BrokerJournalSnapshot?,
    replacement: BrokerJournalRecord
  ) async throws(BrokerJournalError) -> BrokerJournalSnapshot {
    guard snapshots[replacement.connectionID] == expected else { throw .casConflict }
    let snapshot = BrokerJournalSnapshot(record: replacement, authenticationTag: .zero)
    snapshots[replacement.connectionID] = snapshot
    return snapshot
  }

  func reconcileCompareAndSwap(
    expected: BrokerJournalSnapshot?,
    replacement: BrokerJournalRecord
  ) async throws(BrokerJournalError) -> BrokerJournalCASReconciliation {
    let current = snapshots[replacement.connectionID]
    if current == expected { return .expected }
    if current?.record == replacement { return .replacement(current!) }
    return .unrelated
  }
}
