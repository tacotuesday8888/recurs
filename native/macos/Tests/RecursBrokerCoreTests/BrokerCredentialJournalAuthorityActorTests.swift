import Foundation
import Testing

@testable import RecursBrokerCore

@Suite("Broker credential journal authority actor")
struct BrokerCredentialJournalAuthorityActorTests {
  @Test
  func directCommitPersistsExactReadyTerminalThenReplaysWithoutIO() async throws {
    let fixture = try AuthorityActorFixture()
    let harness = try await fixture.harness(.empty)
    let attempt = try await fixture.stage(harness, reconnect: false)
    let staging = try #require(try await harness.journal.load(connectionID: fixture.primaryID))
    await harness.journal.resetEvents()
    let callsBefore = await harness.store.inspection()

    let ready = try await harness.state.commit(
      connectionID: fixture.primaryID,
      attemptID: attempt.attemptID,
      operationID: fixture.commitID,
      expectedFence: attempt.fence
    )

    let expected = try BrokerJournalRecordAdapter.makeCommitAuthority(
      predecessor: staging.record,
      operationID: fixture.commitID,
      capturedAt: fixture.time
    )
    let selected = try #require(try await harness.journal.load(connectionID: fixture.primaryID))
    #expect(selected.record == expected)
    #expect(selected.record.phase == .ready)
    #expect(selected.record.terminalOperations.last == expected.terminalOperations.last)
    #expect(ready == (try fixture.committedReady(in: expected)))
    #expect((await harness.store.inspection()).deleteCallCounts == callsBefore.deleteCallCounts)

    let eventsBeforeReplay = await harness.journal.events()
    let storeBeforeReplay = await harness.store.inspection()
    let replay = try await harness.state.commit(
      connectionID: fixture.primaryID,
      attemptID: attempt.attemptID,
      operationID: fixture.commitID,
      expectedFence: attempt.fence
    )
    #expect(replay == ready)
    #expect(await harness.journal.events() == eventsBeforeReplay)
    let storeAfterReplay = await harness.store.inspection()
    #expect(storeAfterReplay.keys == storeBeforeReplay.keys)
    #expect(storeAfterReplay.retainedCount == storeBeforeReplay.retainedCount)
    #expect(storeAfterReplay.storeCallCounts == storeBeforeReplay.storeCallCounts)
    #expect(storeAfterReplay.loadCallCounts == storeBeforeReplay.loadCallCounts)
    #expect(storeAfterReplay.deleteCallCounts == storeBeforeReplay.deleteCallCounts)
  }

  @Test
  func reconnectCommitSelectsAuthorityBeforeCleanupAndCancellationIsAdvisory() async throws {
    let fixture = try AuthorityActorFixture()
    let harness = try await fixture.harness(.ready)
    let attempt = try await fixture.stage(harness, reconnect: true)
    let staging = try #require(try await harness.journal.load(connectionID: fixture.primaryID))
    let priorKey = try #require(fixture.key(forReadyPayloadIn: staging.record))
    await harness.journal.resetEvents()
    await harness.store.pauseNext(at: .deleteBeforeSideEffect)

    let operation = Task {
      try await harness.state.commit(
        connectionID: fixture.primaryID,
        attemptID: attempt.attemptID,
        operationID: fixture.commitID,
        expectedFence: attempt.fence
      )
    }
    await harness.store.waitUntilPaused(at: .deleteBeforeSideEffect)

    let authority = try BrokerJournalRecordAdapter.makeCommitAuthority(
      predecessor: staging.record,
      operationID: fixture.commitID,
      capturedAt: fixture.time
    )
    let selectedAuthority = try #require(
      try await harness.journal.load(connectionID: fixture.primaryID)
    )
    #expect(selectedAuthority.record == authority)
    #expect(selectedAuthority.record.phase == .readyCleanupPending)
    #expect(selectedAuthority.record.terminalOperations == staging.record.terminalOperations)
    #expect(await harness.store.deleteCallCount(for: priorKey) == 1)
    await expectAuthorityError(.operationInProgress) {
      try await harness.state.commit(
        connectionID: fixture.primaryID,
        attemptID: attempt.attemptID,
        operationID: fixture.commitID,
        expectedFence: attempt.fence
      )
    }

    operation.cancel()
    await harness.store.releaseOne(at: .deleteBeforeSideEffect)
    let ready = try await operation.value
    let stable = try BrokerJournalRecordAdapter.makeStableCommit(
      predecessor: authority,
      changedAt: fixture.time
    )
    let selectedStable = try #require(
      try await harness.journal.load(connectionID: fixture.primaryID))
    #expect(selectedStable.record == stable)
    #expect(ready == (try fixture.committedReady(in: stable)))
    #expect(await harness.store.deleteCallCount(for: priorKey) == 1)
  }

  @Test
  func cancellationAtSelectedReconnectCommitCASIsAdvisory() async throws {
    let fixture = try AuthorityActorFixture()
    let harness = try await fixture.harness(.ready)
    let attempt = try await fixture.stage(harness, reconnect: true)
    let staging = try #require(try await harness.journal.load(connectionID: fixture.primaryID))
    let priorKey = try #require(fixture.key(forReadyPayloadIn: staging.record))
    await harness.journal.resetEvents()
    await harness.journal.pauseNext(at: .compareAndSwapAfterSideEffect)

    let operation = Task {
      try await harness.state.commit(
        connectionID: fixture.primaryID,
        attemptID: attempt.attemptID,
        operationID: fixture.commitID,
        expectedFence: attempt.fence
      )
    }
    await harness.journal.waitUntilPaused(at: .compareAndSwapAfterSideEffect)

    let authority = try BrokerJournalRecordAdapter.makeCommitAuthority(
      predecessor: staging.record,
      operationID: fixture.commitID,
      capturedAt: fixture.time
    )
    #expect(
      (try await harness.journal.load(connectionID: fixture.primaryID))?.record == authority
    )
    #expect(await harness.state.projection(for: fixture.primaryID) == .staging(attempt))
    #expect(await harness.store.deleteCallCount(for: priorKey) == 0)

    operation.cancel()
    await harness.journal.releaseOne(at: .compareAndSwapAfterSideEffect)
    let ready = try await operation.value

    let stable = try BrokerJournalRecordAdapter.makeStableCommit(
      predecessor: authority,
      changedAt: fixture.time
    )
    #expect((try await harness.journal.load(connectionID: fixture.primaryID))?.record == stable)
    #expect(ready == (try fixture.committedReady(in: stable)))
    #expect(await harness.state.projection(for: fixture.primaryID) == .ready(ready))
    #expect(await harness.store.deleteCallCount(for: priorKey) == 1)
  }

  @Test(arguments: [false, true])
  func abortSelectsCleanupAuthorityThenRestoresVacantOrReady(_ reconnect: Bool) async throws {
    let fixture = try AuthorityActorFixture()
    let harness = try await fixture.harness(reconnect ? .ready : .empty)
    let attempt = try await fixture.stage(harness, reconnect: reconnect)
    let staging = try #require(try await harness.journal.load(connectionID: fixture.primaryID))
    let candidateKey = fixture.key(for: attempt.candidate, connectionID: fixture.primaryID)
    await harness.journal.resetEvents()
    await harness.store.pauseNext(at: .deleteBeforeSideEffect)

    let operation = Task {
      try await harness.state.abort(
        connectionID: fixture.primaryID,
        attemptID: attempt.attemptID,
        operationID: fixture.abortID,
        expectedFence: attempt.fence
      )
    }
    await harness.store.waitUntilPaused(at: .deleteBeforeSideEffect)

    let authority = try BrokerJournalRecordAdapter.makeAbortCleanupPending(
      predecessor: staging.record,
      operationID: fixture.abortID,
      changedAt: fixture.time
    )
    #expect(
      (try await harness.journal.load(connectionID: fixture.primaryID))?.record == authority
    )
    #expect(await harness.store.deleteCallCount(for: candidateKey) == 1)
    await harness.store.releaseOne(at: .deleteBeforeSideEffect)

    let restored = try await operation.value
    let stable = try BrokerJournalRecordAdapter.makeStableAbort(
      predecessor: authority,
      changedAt: fixture.time
    )
    let selected = try #require(try await harness.journal.load(connectionID: fixture.primaryID))
    #expect(selected.record == stable)
    #expect(selected.record.phase == (reconnect ? .ready : .vacant))
    #expect(restored == (try fixture.abortedReady(in: stable)))
    #expect(await harness.store.deleteCallCount(for: candidateKey) == 1)
  }

  @Test
  func vacantDisconnectUsesExplicitZeroKeyFinalization() async throws {
    let fixture = try AuthorityActorFixture()
    let harness = try await fixture.harness(.vacant)
    let predecessor = try #require(try await harness.journal.load(connectionID: fixture.primaryID))
    await harness.journal.resetEvents()

    let tombstone = try await harness.state.disconnect(
      connectionID: fixture.primaryID,
      operationID: fixture.disconnectID,
      expectedFence: 0
    )

    let fenced = try BrokerJournalRecordAdapter.makeDisconnectFenced(
      predecessor: predecessor.record,
      operationID: fixture.disconnectID,
      capturedAt: fixture.time
    )
    let stable = try BrokerJournalRecordAdapter.makeTombstoned(
      predecessor: fenced,
      changedAt: fixture.time
    )
    let selected = try #require(try await harness.journal.load(connectionID: fixture.primaryID))
    #expect(selected.record == stable)
    #expect(tombstone == (try fixture.disconnectedTombstone(in: stable)))
    #expect((await harness.store.inspection()).deleteCallCounts.isEmpty)
    #expect(
      await harness.journal.events() == [
        .compareAndSwap(fixture.primaryID),
        .compareAndSwap(fixture.primaryID),
        .load(fixture.primaryID),
      ]
    )
  }

  @Test
  func readyDisconnectDeletesItsGenerationBetweenFencingAndTombstone() async throws {
    let fixture = try AuthorityActorFixture()
    let harness = try await fixture.harness(.ready)
    let predecessor = try #require(try await harness.journal.load(connectionID: fixture.primaryID))
    let key = try #require(fixture.key(forReadyPayloadIn: predecessor.record))
    await harness.journal.resetEvents()
    await harness.store.pauseNext(at: .deleteBeforeSideEffect)

    let operation = Task {
      try await harness.state.disconnect(
        connectionID: fixture.primaryID,
        operationID: fixture.disconnectID,
        expectedFence: 1
      )
    }
    await harness.store.waitUntilPaused(at: .deleteBeforeSideEffect)

    let fenced = try BrokerJournalRecordAdapter.makeDisconnectFenced(
      predecessor: predecessor.record,
      operationID: fixture.disconnectID,
      capturedAt: fixture.time
    )
    #expect((try await harness.journal.load(connectionID: fixture.primaryID))?.record == fenced)
    #expect(await harness.store.deleteCallCount(for: key) == 1)
    await harness.store.releaseOne(at: .deleteBeforeSideEffect)
    let tombstone = try await operation.value

    let stable = try BrokerJournalRecordAdapter.makeTombstoned(
      predecessor: fenced,
      changedAt: fixture.time
    )
    #expect((try await harness.journal.load(connectionID: fixture.primaryID))?.record == stable)
    #expect(tombstone == (try fixture.disconnectedTombstone(in: stable)))
  }

  @Test
  func stagingDisconnectDeletesCandidateBeforePriorReadyAndResumesAtSecondKey() async throws {
    let fixture = try AuthorityActorFixture()
    let harness = try await fixture.harness(.ready)
    let attempt = try await fixture.stage(harness, reconnect: true)
    let staging = try #require(try await harness.journal.load(connectionID: fixture.primaryID))
    let candidateKey = fixture.key(for: attempt.candidate, connectionID: fixture.primaryID)
    let priorKey = try #require(fixture.key(forReadyPayloadIn: staging.record))
    await harness.journal.resetEvents()
    await harness.store.pauseNext(at: .deleteAfterSideEffect)

    let operation = Task {
      try await harness.state.disconnect(
        connectionID: fixture.primaryID,
        operationID: fixture.disconnectID,
        expectedFence: attempt.fence
      )
    }
    await harness.store.waitUntilPaused(at: .deleteAfterSideEffect)
    #expect(await harness.store.deleteCallCount(for: candidateKey) == 1)
    #expect(await harness.store.deleteCallCount(for: priorKey) == 0)
    await harness.store.failNext(at: .deleteBeforeSideEffect)
    await harness.store.releaseOne(at: .deleteAfterSideEffect)

    await expectAuthorityTaskError(.cleanupPending, operation)
    #expect(await harness.store.deleteCallCount(for: candidateKey) == 1)
    #expect(await harness.store.deleteCallCount(for: priorKey) == 1)
    #expect(!(await harness.store.contains(candidateKey)))
    #expect(await harness.store.contains(priorKey))

    let tombstone = try await harness.state.disconnect(
      connectionID: fixture.primaryID,
      operationID: fixture.disconnectID,
      expectedFence: attempt.fence
    )
    #expect(await harness.store.deleteCallCount(for: candidateKey) == 1)
    #expect(await harness.store.deleteCallCount(for: priorKey) == 2)
    #expect(await harness.store.retainedCount() == 0)
    let fenced = try BrokerJournalRecordAdapter.makeDisconnectFenced(
      predecessor: staging.record,
      operationID: fixture.disconnectID,
      capturedAt: fixture.time
    )
    let stable = try BrokerJournalRecordAdapter.makeTombstoned(
      predecessor: fenced,
      changedAt: fixture.time
    )
    #expect((try await harness.journal.load(connectionID: fixture.primaryID))?.record == stable)
    #expect(tombstone == (try fixture.disconnectedTombstone(in: stable)))
  }

  @Test
  func preAuthorityCASFailureMapsToStoreUnavailableAndExactRetrySucceeds() async throws {
    let fixture = try AuthorityActorFixture()
    let harness = try await fixture.harness(.empty)
    let attempt = try await fixture.stage(harness, reconnect: false)
    let staging = try #require(try await harness.journal.load(connectionID: fixture.primaryID))
    let candidateKey = fixture.key(for: attempt.candidate, connectionID: fixture.primaryID)
    await harness.journal.resetEvents()
    await harness.journal.failNext(.storageUnavailable, at: .compareAndSwapBeforeSideEffect)

    await expectAuthorityError(.storeUnavailable) {
      try await harness.state.abort(
        connectionID: fixture.primaryID,
        attemptID: attempt.attemptID,
        operationID: fixture.abortID,
        expectedFence: attempt.fence
      )
    }
    #expect((try await harness.journal.load(connectionID: fixture.primaryID)) == staging)
    #expect(await harness.store.deleteCallCount(for: candidateKey) == 0)

    let result = try await harness.state.abort(
      connectionID: fixture.primaryID,
      attemptID: attempt.attemptID,
      operationID: fixture.abortID,
      expectedFence: attempt.fence
    )
    #expect(result == nil)
    #expect(await harness.store.deleteCallCount(for: candidateKey) == 1)
  }

  @Test
  func invalidPreAuthorityTimestampCreatesNoReservationOrJournalMutation() async throws {
    let fixture = try AuthorityActorFixture()
    let harness = try await fixture.harness(
      .empty,
      dates: [
        fixture.time.date,
        fixture.time.date,
        Date(timeIntervalSince1970: .infinity),
        fixture.time.date,
      ]
    )
    let attempt = try await fixture.stage(harness, reconnect: false)
    let staging = try #require(try await harness.journal.load(connectionID: fixture.primaryID))
    await harness.journal.resetEvents()

    await expectAuthorityError(.storeUnavailable) {
      try await harness.state.commit(
        connectionID: fixture.primaryID,
        attemptID: attempt.attemptID,
        operationID: fixture.commitID,
        expectedFence: attempt.fence
      )
    }

    #expect(await harness.journal.events().isEmpty)
    #expect(await harness.state.projection(for: fixture.primaryID) == .staging(attempt))
    #expect((try await harness.journal.load(connectionID: fixture.primaryID)) == staging)
    _ = try await harness.state.commit(
      connectionID: fixture.primaryID,
      attemptID: attempt.attemptID,
      operationID: fixture.commitID,
      expectedFence: attempt.fence
    )
  }

  @Test
  func failedFinalCASResumesWithoutRepeatingCompletedDelete() async throws {
    let fixture = try AuthorityActorFixture()
    let harness = try await fixture.harness(.empty)
    let attempt = try await fixture.stage(harness, reconnect: false)
    let candidateKey = fixture.key(for: attempt.candidate, connectionID: fixture.primaryID)
    await harness.store.pauseNext(at: .deleteAfterSideEffect)

    let operation = Task {
      try await harness.state.abort(
        connectionID: fixture.primaryID,
        attemptID: attempt.attemptID,
        operationID: fixture.abortID,
        expectedFence: attempt.fence
      )
    }
    await harness.store.waitUntilPaused(at: .deleteAfterSideEffect)
    await harness.journal.failNext(.storageUnavailable, at: .compareAndSwapBeforeSideEffect)
    await harness.store.releaseOne(at: .deleteAfterSideEffect)

    await expectAuthorityTaskError(.cleanupPending, operation)
    #expect(await harness.store.deleteCallCount(for: candidateKey) == 1)
    let result = try await harness.state.abort(
      connectionID: fixture.primaryID,
      attemptID: attempt.attemptID,
      operationID: fixture.abortID,
      expectedFence: attempt.fence
    )
    #expect(result == nil)
    #expect(await harness.store.deleteCallCount(for: candidateKey) == 1)
    #expect(
      (try await harness.journal.load(connectionID: fixture.primaryID))?.record.phase == .vacant)
  }

  @Test(arguments: AuthorityActorMutation.allCases)
  fileprivate func rawUnknownAuthorityCASRemainsFailClosedUntilRestart(
    _ mutation: AuthorityActorMutation
  ) async throws {
    let fixture = try AuthorityActorFixture()
    let harness = try await fixture.harness(mutation == .abort ? .empty : .ready)
    let attempt: StagingAttempt?
    switch mutation {
    case .commit:
      attempt = try await fixture.stage(harness, reconnect: true)
    case .abort:
      attempt = try await fixture.stage(harness, reconnect: false)
    case .disconnect:
      attempt = nil
    }
    let predecessor = try #require(try await harness.journal.load(connectionID: fixture.primaryID))
    let projectionBefore = await harness.state.projection(for: fixture.primaryID)
    let storeBefore = await harness.store.inspection()
    await harness.journal.resetEvents()
    await harness.journal.failNext(
      .mutationOutcomeUnknown,
      at: .compareAndSwapAfterSideEffect
    )

    await expectAuthorityError(.cleanupPending) {
      try await fixture.perform(mutation, state: harness.state, attempt: attempt)
    }

    let expectedAuthority = try fixture.authorityRecord(
      mutation,
      predecessor: predecessor.record
    )
    let selected = try #require(try await harness.journal.load(connectionID: fixture.primaryID))
    #expect(selected.record == expectedAuthority)
    #expect(await harness.state.projection(for: fixture.primaryID) == projectionBefore)
    let storeAfterUnknown = await harness.store.inspection()
    #expect(storeAfterUnknown.keys == storeBefore.keys)
    #expect(storeAfterUnknown.deleteCallCounts == storeBefore.deleteCallCounts)

    await expectAuthorityError(.operationInProgress) {
      try await fixture.perform(mutation, state: harness.state, attempt: attempt)
    }
    let rejected = UncheckedSecretAlias(SecretBytes(Data("blocked-after-unknown".utf8)))
    await expectAuthorityError(.operationInProgress) {
      try await harness.state.stage(
        connectionID: fixture.primaryID,
        operationID: fixture.blockedMutationID,
        expectedFence: projectionBefore?.fenceForAuthorityActorTest ?? 0,
        secret: rejected.value
      )
    }
    #expect(rejected.isErased())
    #expect((await harness.store.inspection()).deleteCallCounts == storeBefore.deleteCallCounts)

    let restarted = try await BrokerCredentialState.recovering(
      store: harness.store,
      journal: harness.journal,
      clock: { fixture.time.date }
    )
    let eventsBeforeReplay = await harness.journal.events()
    let deletesBeforeReplay = (await harness.store.inspection()).deleteCallCounts
    _ = try await fixture.perform(mutation, state: restarted, attempt: attempt)
    #expect(await harness.journal.events() == eventsBeforeReplay)
    #expect((await harness.store.inspection()).deleteCallCounts == deletesBeforeReplay)
  }

  @Test
  func selectedAuthorityBlocksSameConnectionButDifferentConnectionProgresses() async throws {
    let fixture = try AuthorityActorFixture()
    let harness = try await fixture.harness(.empty)
    let first = try await fixture.stage(harness, reconnect: false)
    let second = try await fixture.stage(
      harness,
      connectionID: fixture.secondaryID,
      operationID: fixture.secondaryStageID,
      reconnect: false
    )
    await harness.journal.pauseNext(at: .compareAndSwapAfterSideEffect)
    let firstCommit = Task {
      try await harness.state.commit(
        connectionID: fixture.primaryID,
        attemptID: first.attemptID,
        operationID: fixture.commitID,
        expectedFence: first.fence
      )
    }
    await harness.journal.waitUntilPaused(at: .compareAndSwapAfterSideEffect)

    await expectAuthorityError(.operationInProgress) {
      try await harness.state.abort(
        connectionID: fixture.primaryID,
        attemptID: first.attemptID,
        operationID: fixture.abortID,
        expectedFence: first.fence
      )
    }
    let independent = try await harness.state.commit(
      connectionID: fixture.secondaryID,
      attemptID: second.attemptID,
      operationID: fixture.secondaryCommitID,
      expectedFence: second.fence
    )
    #expect(independent.connectionID == fixture.secondaryID)

    await harness.journal.releaseOne(at: .compareAndSwapAfterSideEffect)
    _ = try await firstCommit.value
  }
}

private struct AuthorityActorFixture: Sendable {
  enum Bootstrap {
    case empty
    case vacant
    case ready
  }

  let primaryID = authorityActorUUID(1)
  let secondaryID = authorityActorUUID(2)
  let stageID = authorityActorUUID(10)
  let secondaryStageID = authorityActorUUID(11)
  let commitID = authorityActorUUID(12)
  let secondaryCommitID = authorityActorUUID(13)
  let abortID = authorityActorUUID(14)
  let disconnectID = authorityActorUUID(15)
  let blockedMutationID = authorityActorUUID(16)
  let time: JournalTimestamp

  init() throws {
    time = try JournalTimestamp(canonicalText: "2026-07-13T02:00:00.000Z")
  }

  func harness(
    _ bootstrap: Bootstrap,
    dates: [Date]? = nil
  ) async throws -> AuthorityActorHarness {
    let store = InMemoryCredentialStore()
    let snapshots: [BrokerJournalSnapshot]
    switch bootstrap {
    case .empty:
      snapshots = []
    case .vacant:
      snapshots = [try snapshot(vacantRecord())]
    case .ready:
      let ready = try readyRecord()
      snapshots = [try snapshot(ready)]
      try await store.store(
        SecretBytes(Data("prior-ready".utf8)),
        for: try #require(key(forReadyPayloadIn: ready))
      )
    }
    let journal = try InMemoryBrokerJournalStore(snapshots: snapshots)
    let clock = LockedSequence(dates ?? Array(repeating: time.date, count: 64))
    let generationIDs = LockedSequence((20..<40).map(authorityActorUUID))
    let attemptIDs = LockedSequence((40..<60).map(authorityActorUUID))
    let state = try await BrokerCredentialState.recovering(
      store: store,
      journal: journal,
      clock: clock.next,
      generationIDSource: generationIDs.next,
      attemptIDSource: attemptIDs.next
    )
    return AuthorityActorHarness(
      state: state,
      journal: journal,
      store: store,
      clock: clock
    )
  }

  func stage(
    _ harness: AuthorityActorHarness,
    connectionID: UUID? = nil,
    operationID: UUID? = nil,
    reconnect: Bool
  ) async throws -> StagingAttempt {
    try await harness.state.stage(
      connectionID: connectionID ?? primaryID,
      operationID: operationID ?? stageID,
      expectedFence: reconnect ? 1 : 0,
      secret: SecretBytes(Data("candidate".utf8))
    )
  }

  func vacantRecord() throws -> BrokerJournalRecord {
    try BrokerJournalRecord(
      revision: 1,
      connectionID: primaryID,
      fence: 0,
      lastGenerationOrdinal: 0,
      changedAt: time,
      payload: .vacant(BrokerJournalVacantPayload())
    )
  }

  func readyRecord() throws -> BrokerJournalRecord {
    let generation = BrokerJournalCredentialGeneration(
      generationID: authorityActorUUID(3),
      ordinal: 1,
      createdAt: time
    )
    return try BrokerJournalRecord(
      revision: 1,
      connectionID: primaryID,
      fence: 1,
      lastGenerationOrdinal: 1,
      changedAt: time,
      payload: .ready(
        BrokerJournalReadyPayload(
          ready: BrokerJournalReadyGeneration(generation: generation, committedAt: time)
        )
      )
    )
  }

  func snapshot(_ record: BrokerJournalRecord) throws -> BrokerJournalSnapshot {
    BrokerJournalSnapshot(
      record: record,
      authenticationTag: try JournalAuthenticationTag(bytes: Array(repeating: 0xa1, count: 32))
    )
  }

  func key(
    for generation: CredentialGeneration,
    connectionID: UUID
  ) -> CredentialStoreKey {
    CredentialStoreKey(
      connectionID: connectionID,
      generationID: generation.generationID,
      generationOrdinal: generation.ordinal
    )
  }

  func key(forReadyPayloadIn record: BrokerJournalRecord) -> CredentialStoreKey? {
    let generation: BrokerJournalCredentialGeneration?
    switch record.payload {
    case .ready(let payload):
      generation = payload.ready.generation
    case .staging(let payload):
      generation = payload.previousReady?.generation
    default:
      generation = nil
    }
    return generation.map {
      CredentialStoreKey(
        connectionID: record.connectionID,
        generationID: $0.generationID,
        generationOrdinal: $0.ordinal
      )
    }
  }

  func committedReady(in record: BrokerJournalRecord) throws -> ReadyProjection {
    guard case .commit(let terminal) = record.terminalOperations.last else {
      throw BrokerJournalError.invalidRecord
    }
    return try BrokerJournalRecordAdapter.readyProjection(from: terminal.ready)
  }

  func abortedReady(in record: BrokerJournalRecord) throws -> ReadyProjection? {
    guard case .abort(let terminal) = record.terminalOperations.last else {
      throw BrokerJournalError.invalidRecord
    }
    return try terminal.restoredReady.map(BrokerJournalRecordAdapter.readyProjection)
  }

  func disconnectedTombstone(
    in record: BrokerJournalRecord
  ) throws -> TombstoneProjection {
    guard case .disconnect(let terminal) = record.terminalOperations.last else {
      throw BrokerJournalError.invalidRecord
    }
    return try BrokerJournalRecordAdapter.tombstoneProjection(from: terminal.tombstone)
  }

  func authorityRecord(
    _ mutation: AuthorityActorMutation,
    predecessor: BrokerJournalRecord
  ) throws -> BrokerJournalRecord {
    switch mutation {
    case .commit:
      try BrokerJournalRecordAdapter.makeCommitAuthority(
        predecessor: predecessor,
        operationID: commitID,
        capturedAt: time
      )
    case .abort:
      try BrokerJournalRecordAdapter.makeAbortCleanupPending(
        predecessor: predecessor,
        operationID: abortID,
        changedAt: time
      )
    case .disconnect:
      try BrokerJournalRecordAdapter.makeDisconnectFenced(
        predecessor: predecessor,
        operationID: disconnectID,
        capturedAt: time
      )
    }
  }

  func perform(
    _ mutation: AuthorityActorMutation,
    state: BrokerCredentialState,
    attempt: StagingAttempt?
  ) async throws -> AuthorityActorMutationResult {
    switch mutation {
    case .commit:
      let attempt = try #require(attempt)
      return .commit(
        try await state.commit(
          connectionID: primaryID,
          attemptID: attempt.attemptID,
          operationID: commitID,
          expectedFence: attempt.fence
        )
      )
    case .abort:
      let attempt = try #require(attempt)
      return .abort(
        try await state.abort(
          connectionID: primaryID,
          attemptID: attempt.attemptID,
          operationID: abortID,
          expectedFence: attempt.fence
        )
      )
    case .disconnect:
      return .disconnect(
        try await state.disconnect(
          connectionID: primaryID,
          operationID: disconnectID,
          expectedFence: 1
        )
      )
    }
  }
}

private struct AuthorityActorHarness: Sendable {
  let state: BrokerCredentialState
  let journal: InMemoryBrokerJournalStore
  let store: InMemoryCredentialStore
  let clock: LockedSequence<Date>
}

private enum AuthorityActorMutation: CaseIterable, Sendable {
  case commit
  case abort
  case disconnect
}

private enum AuthorityActorMutationResult: Sendable, Equatable {
  case commit(ReadyProjection)
  case abort(ReadyProjection?)
  case disconnect(TombstoneProjection)
}

extension CredentialProjection {
  fileprivate var fenceForAuthorityActorTest: UInt64 {
    switch self {
    case .staging(let attempt):
      attempt.fence
    case .ready(let ready):
      ready.fence
    case .tombstoned(let tombstone):
      tombstone.fence
    }
  }
}

private func authorityActorUUID(_ value: Int) -> UUID {
  UUID(
    uuidString: String(
      format: "00000000-0000-4000-8000-%012llx",
      value
    )
  )!
}

private func expectAuthorityError<Value>(
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

private func expectAuthorityTaskError<Value>(
  _ expected: BrokerStateError,
  _ task: Task<Value, any Error>
) async {
  do {
    _ = try await task.value
    Issue.record("Expected broker error \(expected).")
  } catch let error as BrokerStateError {
    #expect(error == expected)
  } catch {
    Issue.record("Unexpected error type: \(String(reflecting: error))")
  }
}
