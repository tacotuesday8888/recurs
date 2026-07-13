import Foundation
import Testing

@testable import RecursBrokerCore

@Suite("Broker journal record adapter")
struct BrokerJournalRecordAdapterTests {
  @Test
  func capturesTimeOnceAtCanonicalMillisecondPrecisionAndRoundTripsValues() throws {
    let raw = Date(timeIntervalSince1970: 1_700_000_000.1239)
    let captured = try BrokerJournalRecordAdapter.captureTimestamp(from: raw)
    #expect(captured.unixMilliseconds == 1_700_000_000_123)

    let generation = CredentialGeneration(
      generationID: fixtureUUID(1),
      ordinal: 7,
      createdAt: captured.date
    )
    let journal = try BrokerJournalRecordAdapter.journalGeneration(from: generation)
    let projected = try BrokerJournalRecordAdapter.generation(from: journal)

    #expect(journal.createdAt == captured)
    #expect(projected == generation)
  }

  @Test
  func convertsReadyAndTombstoneProjectionsExactlyAndRejectsUnsafeCounters() throws {
    let timestamp = try fixtureTimestamp(1_000)
    let generation = CredentialGeneration(
      generationID: fixtureUUID(2),
      ordinal: 1,
      createdAt: timestamp.date
    )
    let ready = ReadyProjection(
      connectionID: fixtureUUID(3),
      fence: 1,
      ready: ReadyGeneration(generation: generation, committedAt: timestamp.date),
      lastGenerationOrdinal: 1
    )
    let journalReady = try BrokerJournalRecordAdapter.journalReadyProjection(from: ready)
    let projectedReady = try BrokerJournalRecordAdapter.readyProjection(from: journalReady)
    #expect(projectedReady == ready)

    let tombstone = TombstoneProjection(
      connectionID: ready.connectionID,
      fence: 2,
      lastGenerationOrdinal: 1,
      tombstonedAt: timestamp.date
    )
    let journalTombstone = try BrokerJournalRecordAdapter.journalTombstoneProjection(
      from: tombstone
    )
    let projectedTombstone = try BrokerJournalRecordAdapter.tombstoneProjection(
      from: journalTombstone
    )
    #expect(projectedTombstone == tombstone)

    let badReady = ReadyProjection(
      connectionID: ready.connectionID,
      fence: 2,
      ready: ready.ready,
      lastGenerationOrdinal: 1
    )
    #expect(throws: BrokerJournalError.invalidRecord) {
      _ = try BrokerJournalRecordAdapter.journalReadyProjection(from: badReady)
    }
    let badTombstone = TombstoneProjection(
      connectionID: ready.connectionID,
      fence: 3,
      lastGenerationOrdinal: 1,
      tombstonedAt: timestamp.date
    )
    #expect(throws: BrokerJournalError.invalidRecord) {
      _ = try BrokerJournalRecordAdapter.journalTombstoneProjection(from: badTombstone)
    }
  }

  @Test
  func derivesSafeBootstrapProjectionAndExactRecoveryWorkForAllNinePhases() throws {
    let fixture = try PhaseFixture()
    let recoveryTime = try fixtureTimestamp(9_000)
    let records = try fixture.records()

    for record in records {
      let plan = try BrokerJournalRecordAdapter.recoveryPlan(
        for: record,
        recoveryChangedAt: recoveryTime
      )
      #expect(record.providerBinding == .openAI)
      if let preparation = plan.preparation {
        #expect(preparation.providerBinding == record.providerBinding)
      }
      #expect(plan.bootstrap == (try fixture.expectedBootstrap(for: record.phase)))
      #expect(plan.projection == (try fixture.expectedProjection(for: record.phase)))

      switch record.phase {
      case .vacant, .ready, .tombstoned:
        #expect(plan.preparation == nil)
        #expect(plan.cleanup == nil)

      case .storePending:
        let preparation = try #require(plan.preparation)
        #expect(preparation.revision == record.revision + 1)
        #expect(preparation.changedAt == recoveryTime)
        guard case .stageCleanupPending(let payload) = preparation.payload else {
          Issue.record("expected stage cleanup preparation")
          return
        }
        #expect(payload.error == .storeUnavailable)
        #expect(plan.cleanup == fixture.stageCleanup(error: .storeUnavailable))

      case .staging:
        let preparation = try #require(plan.preparation)
        guard case .stageCleanupPending(let payload) = preparation.payload else {
          Issue.record("expected stage cleanup preparation")
          return
        }
        #expect(payload.error == .attemptNotCurrent)
        #expect(plan.cleanup == fixture.stageCleanup(error: .attemptNotCurrent))

      case .readyCleanupPending:
        #expect(plan.preparation == nil)
        #expect(plan.cleanup == fixture.commitCleanup())

      case .stageCleanupPending:
        #expect(plan.preparation == nil)
        #expect(plan.cleanup == fixture.stageCleanup(error: .cancelled))

      case .abortCleanupPending:
        #expect(plan.preparation == nil)
        #expect(plan.cleanup == fixture.abortCleanup())

      case .disconnectFenced:
        #expect(plan.preparation == nil)
        #expect(plan.cleanup == fixture.disconnectCleanup())
      }
    }
  }

  @Test
  func buildsFirstStageAndDirectCommitWithOneCapturedTimeAndExactFIFO() throws {
    let captured = try fixtureTimestamp(10_000)
    let connectionID = fixtureUUID(20)
    let attemptID = fixtureUUID(21)
    let stageOperationID = fixtureUUID(22)
    let generationID = fixtureUUID(23)
    let pending = try BrokerJournalRecordAdapter.makeStorePending(
      predecessor: nil,
      connectionID: connectionID,
      providerBinding: .openAI,
      attemptID: attemptID,
      operationID: stageOperationID,
      candidateGenerationID: generationID,
      capturedAt: captured
    )

    #expect(pending.revision == 1)
    #expect(pending.providerBinding == .openAI)
    #expect(pending.fence == 1)
    #expect(pending.lastGenerationOrdinal == 1)
    #expect(pending.changedAt == captured)
    guard case .storePending(let pendingPayload) = pending.payload else {
      Issue.record("expected store pending")
      return
    }
    #expect(pendingPayload.candidate.createdAt == captured)
    #expect(pendingPayload.startedAt == captured)

    let staging = try BrokerJournalRecordAdapter.makeStaging(
      predecessor: pending,
      changedAt: captured
    )
    let committed = try BrokerJournalRecordAdapter.makeCommitAuthority(
      predecessor: staging,
      operationID: fixtureUUID(24),
      capturedAt: captured
    )
    #expect(committed.phase == .ready)
    #expect(staging.providerBinding == pending.providerBinding)
    #expect(committed.providerBinding == pending.providerBinding)
    #expect(committed.changedAt == captured)
    #expect(committed.terminalOperations.count == 1)
    guard
      case .ready(let readyPayload) = committed.payload,
      case .commit(let terminal) = committed.terminalOperations.last
    else {
      Issue.record("expected direct ready commit")
      return
    }
    #expect(readyPayload.ready.committedAt == captured)
    #expect(terminal.ready.ready == readyPayload.ready)
  }

  @Test
  func buildsReconnectCommitCleanupWithoutChangingAuthorityIdentities() throws {
    let fixture = try PhaseFixture()
    let captured = try fixtureTimestamp(11_000)
    let readyRecord = try fixture.readyRecord()
    let pending = try BrokerJournalRecordAdapter.makeStorePending(
      predecessor: readyRecord,
      connectionID: fixture.connectionID,
      providerBinding: .openAI,
      attemptID: fixtureUUID(31),
      operationID: fixtureUUID(32),
      candidateGenerationID: fixtureUUID(33),
      capturedAt: captured
    )
    let staging = try BrokerJournalRecordAdapter.makeStaging(
      predecessor: pending,
      changedAt: captured
    )
    let cleanupPending = try BrokerJournalRecordAdapter.makeCommitAuthority(
      predecessor: staging,
      operationID: fixtureUUID(34),
      capturedAt: captured
    )
    #expect(cleanupPending.phase == .readyCleanupPending)
    #expect(cleanupPending.providerBinding == readyRecord.providerBinding)

    let stable = try BrokerJournalRecordAdapter.makeStableCommit(
      predecessor: cleanupPending,
      changedAt: captured
    )
    #expect(stable.phase == .ready)
    #expect(stable.providerBinding == readyRecord.providerBinding)
    #expect(stable.fence == cleanupPending.fence)
    #expect(stable.lastGenerationOrdinal == cleanupPending.lastGenerationOrdinal)
    #expect(stable.terminalOperations.count == readyRecord.terminalOperations.count + 1)
    try BrokerJournalTransitionValidator.validate(
      predecessor: cleanupPending,
      successor: stable
    )
  }

  @Test
  func buildsStoreFailureStageCleanupAndAbortStableSuccessors() throws {
    let fixture = try PhaseFixture()
    let changedAt = try fixtureTimestamp(12_000)
    let pending = try fixture.storePendingRecord()

    let storeFailure = try BrokerJournalRecordAdapter.makeStableStoreFailure(
      predecessor: pending,
      changedAt: changedAt
    )
    #expect(storeFailure.phase == .ready)
    guard case .stageFailure(let storeTerminal) = storeFailure.terminalOperations.last else {
      Issue.record("expected stage failure terminal")
      return
    }
    #expect(storeTerminal.error == .storeUnavailable)

    let cleanup = try BrokerJournalRecordAdapter.makeStageCleanupPending(
      predecessor: pending,
      error: .cancelled,
      changedAt: changedAt
    )
    let stableFailure = try BrokerJournalRecordAdapter.makeStableStageFailure(
      predecessor: cleanup,
      changedAt: changedAt
    )
    #expect(stableFailure.phase == .ready)
    guard case .stageFailure(let cancelled) = stableFailure.terminalOperations.last else {
      Issue.record("expected cancelled terminal")
      return
    }
    #expect(cancelled.error == .cancelled)

    let staging = try fixture.stagingRecord()
    let abortPending = try BrokerJournalRecordAdapter.makeAbortCleanupPending(
      predecessor: staging,
      operationID: fixtureUUID(40),
      changedAt: changedAt
    )
    let stableAbort = try BrokerJournalRecordAdapter.makeStableAbort(
      predecessor: abortPending,
      changedAt: changedAt
    )
    #expect(stableAbort.phase == .ready)
    guard case .abort(let abortTerminal) = stableAbort.terminalOperations.last else {
      Issue.record("expected abort terminal")
      return
    }
    #expect(abortTerminal.restoredReady?.ready == fixture.previous)
  }

  @Test
  func buildsDisconnectDeleteOrderAndStableTombstoneExactly() throws {
    let fixture = try PhaseFixture()
    let changedAt = try fixtureTimestamp(13_000)
    let staging = try fixture.stagingRecord()
    let fenced = try BrokerJournalRecordAdapter.makeDisconnectFenced(
      predecessor: staging,
      operationID: fixtureUUID(50),
      capturedAt: changedAt
    )
    guard case .disconnectFenced(let payload) = fenced.payload else {
      Issue.record("expected disconnect fenced")
      return
    }
    #expect(payload.deleteGenerations == [fixture.candidate, fixture.previous.generation])
    #expect(payload.tombstonedAt == changedAt)

    let tombstoned = try BrokerJournalRecordAdapter.makeTombstoned(
      predecessor: fenced,
      changedAt: changedAt
    )
    #expect(tombstoned.phase == .tombstoned)
    #expect(tombstoned.fence == fenced.fence)
    guard case .disconnect(let terminal) = tombstoned.terminalOperations.last else {
      Issue.record("expected disconnect terminal")
      return
    }
    #expect(terminal.tombstone.tombstonedAt == changedAt)
  }

  @Test
  func terminalAppendRetainsLatest64FIFOAndRejectsIdentityReuse() throws {
    var operations = (0..<64).map { index in
      BrokerJournalTerminalOperation.stageFailure(
        BrokerJournalStageFailureTerminal(
          operationID: fixtureUUID(1_000 + index),
          expectedFence: 0,
          error: .cancelled
        )
      )
    }
    let appended = BrokerJournalTerminalOperation.stageFailure(
      BrokerJournalStageFailureTerminal(
        operationID: fixtureUUID(2_000),
        expectedFence: 0,
        error: .storeUnavailable
      )
    )
    operations = try BrokerJournalRecordAdapter.appendingTerminal(appended, to: operations)
    #expect(operations.count == 64)
    #expect(operations.first?.operationID == fixtureUUID(1_001))
    #expect(operations.last == appended)

    #expect(throws: BrokerJournalError.invalidRecord) {
      _ = try BrokerJournalRecordAdapter.appendingTerminal(appended, to: operations)
    }

    let attemptID = fixtureUUID(3_000)
    let ready = BrokerJournalReadyProjection(
      connectionID: fixtureUUID(3_001),
      fence: 1,
      ready: BrokerJournalReadyGeneration(
        generation: BrokerJournalCredentialGeneration(
          generationID: fixtureUUID(3_002),
          ordinal: 1,
          createdAt: try fixtureTimestamp(1_000)
        ),
        committedAt: try fixtureTimestamp(1_000)
      ),
      lastGenerationOrdinal: 1
    )
    let commit = BrokerJournalTerminalOperation.commit(
      BrokerJournalCommitTerminal(
        operationID: fixtureUUID(3_003),
        expectedFence: 1,
        attemptID: attemptID,
        ready: ready
      )
    )
    let abort = BrokerJournalTerminalOperation.abort(
      BrokerJournalAbortTerminal(
        operationID: fixtureUUID(3_004),
        expectedFence: 1,
        attemptID: attemptID,
        restoredReady: ready
      )
    )
    #expect(throws: BrokerJournalError.invalidRecord) {
      _ = try BrokerJournalRecordAdapter.appendingTerminal(abort, to: [commit])
    }
  }

  @Test
  func buildersRejectWrongPhaseOverflowAndGenerationCollisionAsInvalidRecord() throws {
    let fixture = try PhaseFixture()
    let timestamp = try fixtureTimestamp(14_000)
    let ready = try fixture.readyRecord()
    #expect(throws: BrokerJournalError.invalidRecord) {
      _ = try BrokerJournalRecordAdapter.makeStaging(
        predecessor: ready,
        changedAt: timestamp
      )
    }
    #expect(throws: BrokerJournalError.invalidRecord) {
      _ = try BrokerJournalRecordAdapter.makeStorePending(
        predecessor: ready,
        connectionID: fixture.connectionID,
        providerBinding: .openAI,
        attemptID: fixtureUUID(61),
        operationID: fixtureUUID(62),
        candidateGenerationID: fixture.previous.generation.generationID,
        capturedAt: timestamp
      )
    }
    #expect(throws: BrokerJournalError.invalidRecord) {
      _ = try BrokerJournalRecordAdapter.makeStorePending(
        predecessor: ready,
        connectionID: fixtureUUID(63),
        providerBinding: .openAI,
        attemptID: fixtureUUID(64),
        operationID: fixtureUUID(65),
        candidateGenerationID: fixtureUUID(66),
        capturedAt: timestamp
      )
    }
  }

  @Test
  func newStageRejectsRetainedOperationAndAttemptIdentityCollisions() throws {
    let fixture = try PhaseFixture()
    let timestamp = try fixtureTimestamp(15_000)
    let retainedOperationID = fixtureUUID(70)
    let operationHistory = [
      BrokerJournalTerminalOperation.stageFailure(
        BrokerJournalStageFailureTerminal(
          operationID: retainedOperationID,
          expectedFence: 0,
          error: .cancelled
        )
      )
    ]
    let readyWithOperationHistory = try BrokerJournalRecord(
      revision: 1,
      connectionID: fixture.connectionID,
      providerBinding: .openAI,
      fence: 2,
      lastGenerationOrdinal: 2,
      changedAt: timestamp,
      payload: .ready(BrokerJournalReadyPayload(ready: fixture.previous)),
      terminalOperations: operationHistory
    )
    #expect(throws: BrokerJournalError.invalidRecord) {
      _ = try BrokerJournalRecordAdapter.makeStorePending(
        predecessor: readyWithOperationHistory,
        connectionID: fixture.connectionID,
        providerBinding: .openAI,
        attemptID: fixtureUUID(71),
        operationID: retainedOperationID,
        candidateGenerationID: fixtureUUID(72),
        capturedAt: timestamp
      )
    }

    let retainedAttemptID = fixtureUUID(73)
    let historicalProjection = BrokerJournalReadyProjection(
      connectionID: fixture.connectionID,
      fence: 1,
      ready: fixture.previous,
      lastGenerationOrdinal: 1
    )
    let attemptHistory = [
      BrokerJournalTerminalOperation.commit(
        BrokerJournalCommitTerminal(
          operationID: fixtureUUID(74),
          expectedFence: 1,
          attemptID: retainedAttemptID,
          ready: historicalProjection
        )
      )
    ]
    let readyWithAttemptHistory = try BrokerJournalRecord(
      revision: 1,
      connectionID: fixture.connectionID,
      providerBinding: .openAI,
      fence: 2,
      lastGenerationOrdinal: 2,
      changedAt: timestamp,
      payload: .ready(BrokerJournalReadyPayload(ready: fixture.previous)),
      terminalOperations: attemptHistory
    )
    #expect(throws: BrokerJournalError.invalidRecord) {
      _ = try BrokerJournalRecordAdapter.makeStorePending(
        predecessor: readyWithAttemptHistory,
        connectionID: fixture.connectionID,
        providerBinding: .openAI,
        attemptID: retainedAttemptID,
        operationID: fixtureUUID(75),
        candidateGenerationID: fixtureUUID(76),
        capturedAt: timestamp
      )
    }

    let duplicateHistory = [operationHistory[0], operationHistory[0]]
    #expect(throws: BrokerJournalError.invalidRecord) {
      _ = try BrokerJournalRecordAdapter.appendingTerminal(
        .stageFailure(
          BrokerJournalStageFailureTerminal(
            operationID: fixtureUUID(77),
            expectedFence: 0,
            error: .cancelled
          )
        ),
        to: duplicateHistory
      )
    }
  }

  @Test
  func cleanupPhaseBuildersRejectRetainedOperationIdentityBeforeDurableTransition() throws {
    let fixture = try PhaseFixture()
    let retainedOperationID = fixtureUUID(80)
    let history = [
      BrokerJournalTerminalOperation.stageFailure(
        BrokerJournalStageFailureTerminal(
          operationID: retainedOperationID,
          expectedFence: 0,
          error: .cancelled
        )
      )
    ]
    let staging = try fixture.stagingRecord(terminalOperations: history)

    #expect(throws: BrokerJournalError.invalidRecord) {
      _ = try BrokerJournalRecordAdapter.makeCommitAuthority(
        predecessor: staging,
        operationID: retainedOperationID,
        capturedAt: fixture.timestamp
      )
    }
    #expect(throws: BrokerJournalError.invalidRecord) {
      _ = try BrokerJournalRecordAdapter.makeAbortCleanupPending(
        predecessor: staging,
        operationID: retainedOperationID,
        changedAt: fixture.timestamp
      )
    }
    #expect(throws: BrokerJournalError.invalidRecord) {
      _ = try BrokerJournalRecordAdapter.makeDisconnectFenced(
        predecessor: staging,
        operationID: retainedOperationID,
        capturedAt: fixture.timestamp
      )
    }
  }

  @Test
  func commitAndAbortRejectCurrentAttemptIdentityRetainedByTerminalHistory() throws {
    let fixture = try PhaseFixture()
    let historicalReady = BrokerJournalReadyProjection(
      connectionID: fixture.connectionID,
      fence: 1,
      ready: fixture.previous,
      lastGenerationOrdinal: 1
    )
    let history = [
      BrokerJournalTerminalOperation.commit(
        BrokerJournalCommitTerminal(
          operationID: fixtureUUID(81),
          expectedFence: 1,
          attemptID: fixture.attemptID,
          ready: historicalReady
        )
      )
    ]
    let staging = try fixture.stagingRecord(terminalOperations: history)

    #expect(throws: BrokerJournalError.invalidRecord) {
      _ = try BrokerJournalRecordAdapter.makeCommitAuthority(
        predecessor: staging,
        operationID: fixtureUUID(82),
        capturedAt: fixture.timestamp
      )
    }
    #expect(throws: BrokerJournalError.invalidRecord) {
      _ = try BrokerJournalRecordAdapter.makeAbortCleanupPending(
        predecessor: staging,
        operationID: fixtureUUID(83),
        changedAt: fixture.timestamp
      )
    }
  }
}

private struct PhaseFixture {
  let connectionID = fixtureUUID(100)
  let attemptID = fixtureUUID(101)
  let stageOperationID = fixtureUUID(102)
  let commitOperationID = fixtureUUID(103)
  let abortOperationID = fixtureUUID(104)
  let disconnectOperationID = fixtureUUID(105)
  let timestamp: JournalTimestamp
  let previous: BrokerJournalReadyGeneration
  let candidate: BrokerJournalCredentialGeneration

  init() throws {
    timestamp = try fixtureTimestamp(5_000)
    previous = BrokerJournalReadyGeneration(
      generation: BrokerJournalCredentialGeneration(
        generationID: fixtureUUID(106),
        ordinal: 1,
        createdAt: timestamp
      ),
      committedAt: timestamp
    )
    candidate = BrokerJournalCredentialGeneration(
      generationID: fixtureUUID(107),
      ordinal: 2,
      createdAt: timestamp
    )
  }

  func records() throws -> [BrokerJournalRecord] {
    [
      try vacantRecord(),
      try storePendingRecord(),
      try stagingRecord(),
      try readyCleanupPendingRecord(),
      try readyRecord(),
      try stageCleanupPendingRecord(),
      try abortCleanupPendingRecord(),
      try disconnectFencedRecord(),
      try tombstonedRecord(),
    ]
  }

  func vacantRecord() throws -> BrokerJournalRecord {
    try BrokerJournalRecord(
      revision: 1,
      connectionID: connectionID,
      providerBinding: .openAI,
      fence: 0,
      lastGenerationOrdinal: 0,
      changedAt: timestamp,
      payload: .vacant(BrokerJournalVacantPayload())
    )
  }

  func storePendingRecord() throws -> BrokerJournalRecord {
    try record(
      phase: .storePending(
        BrokerJournalStorePendingPayload(
          attemptID: attemptID,
          operationID: stageOperationID,
          expectedFence: 1,
          candidate: candidate,
          previousReady: previous,
          startedAt: timestamp
        )
      )
    )
  }

  func stagingRecord(
    terminalOperations: [BrokerJournalTerminalOperation] = []
  ) throws -> BrokerJournalRecord {
    try record(
      phase: .staging(
        BrokerJournalStagingPayload(
          attemptID: attemptID,
          operationID: stageOperationID,
          expectedFence: 1,
          candidate: candidate,
          previousReady: previous,
          startedAt: timestamp
        )
      ),
      terminalOperations: terminalOperations
    )
  }

  func readyCleanupPendingRecord() throws -> BrokerJournalRecord {
    try record(
      phase: .readyCleanupPending(
        BrokerJournalReadyCleanupPendingPayload(
          attemptID: attemptID,
          operationID: commitOperationID,
          expectedFence: 2,
          ready: BrokerJournalReadyGeneration(generation: candidate, committedAt: timestamp),
          previousReady: previous
        )
      )
    )
  }

  func readyRecord() throws -> BrokerJournalRecord {
    try record(phase: .ready(BrokerJournalReadyPayload(ready: previous)))
  }

  func stageCleanupPendingRecord() throws -> BrokerJournalRecord {
    try record(
      phase: .stageCleanupPending(
        BrokerJournalStageCleanupPendingPayload(
          attemptID: attemptID,
          operationID: stageOperationID,
          expectedFence: 1,
          candidate: candidate,
          restoredReady: previous,
          error: .cancelled
        )
      )
    )
  }

  func abortCleanupPendingRecord() throws -> BrokerJournalRecord {
    try record(
      phase: .abortCleanupPending(
        BrokerJournalAbortCleanupPendingPayload(
          attemptID: attemptID,
          operationID: abortOperationID,
          expectedFence: 2,
          candidate: candidate,
          restoredReady: previous
        )
      )
    )
  }

  func disconnectFencedRecord() throws -> BrokerJournalRecord {
    try BrokerJournalRecord(
      revision: 1,
      connectionID: connectionID,
      providerBinding: .openAI,
      fence: 3,
      lastGenerationOrdinal: 2,
      changedAt: timestamp,
      payload: .disconnectFenced(
        BrokerJournalDisconnectFencedPayload(
          operationID: disconnectOperationID,
          expectedFence: 2,
          tombstonedAt: timestamp,
          deleteGenerations: [candidate, previous.generation]
        )
      )
    )
  }

  func tombstonedRecord() throws -> BrokerJournalRecord {
    try BrokerJournalRecord(
      revision: 1,
      connectionID: connectionID,
      providerBinding: .openAI,
      fence: 3,
      lastGenerationOrdinal: 2,
      changedAt: timestamp,
      payload: .tombstoned(BrokerJournalTombstonedPayload(tombstonedAt: timestamp))
    )
  }

  func expectedBootstrap(
    for phase: BrokerJournalPhase
  ) throws -> CredentialBootstrap {
    switch phase {
    case .vacant:
      .vacant(connectionID: connectionID, fence: 0, lastGenerationOrdinal: 0)
    case .storePending, .staging, .stageCleanupPending, .abortCleanupPending:
      .ready(try readyProjection(ready: previous, fence: 2, ordinal: 2))
    case .readyCleanupPending:
      .ready(
        try readyProjection(
          ready: BrokerJournalReadyGeneration(generation: candidate, committedAt: timestamp),
          fence: 2,
          ordinal: 2
        )
      )
    case .ready:
      .ready(try readyProjection(ready: previous, fence: 2, ordinal: 2))
    case .disconnectFenced, .tombstoned:
      .tombstoned(
        TombstoneProjection(
          connectionID: connectionID,
          fence: 3,
          lastGenerationOrdinal: 2,
          tombstonedAt: timestamp.date
        )
      )
    }
  }

  func expectedProjection(
    for phase: BrokerJournalPhase
  ) throws -> CredentialProjection? {
    switch try expectedBootstrap(for: phase) {
    case .vacant:
      nil
    case .ready(let ready):
      .ready(ready)
    case .tombstoned(let tombstone):
      .tombstoned(tombstone)
    }
  }

  func stageCleanup(error: BrokerJournalStageError) -> BrokerJournalCleanupInstruction {
    BrokerJournalCleanupInstruction(
      terminalOperation: .stageFailure(
        BrokerJournalStageFailureTerminal(
          operationID: stageOperationID,
          expectedFence: 1,
          error: error
        )
      ),
      credentialKeys: [key(candidate)]
    )
  }

  func commitCleanup() -> BrokerJournalCleanupInstruction {
    let ready = BrokerJournalReadyGeneration(generation: candidate, committedAt: timestamp)
    return BrokerJournalCleanupInstruction(
      terminalOperation: .commit(
        BrokerJournalCommitTerminal(
          operationID: commitOperationID,
          expectedFence: 2,
          attemptID: attemptID,
          ready: journalReadyProjection(ready: ready, fence: 2, ordinal: 2)
        )
      ),
      credentialKeys: [key(previous.generation)]
    )
  }

  func abortCleanup() -> BrokerJournalCleanupInstruction {
    BrokerJournalCleanupInstruction(
      terminalOperation: .abort(
        BrokerJournalAbortTerminal(
          operationID: abortOperationID,
          expectedFence: 2,
          attemptID: attemptID,
          restoredReady: journalReadyProjection(ready: previous, fence: 2, ordinal: 2)
        )
      ),
      credentialKeys: [key(candidate)]
    )
  }

  func disconnectCleanup() -> BrokerJournalCleanupInstruction {
    BrokerJournalCleanupInstruction(
      terminalOperation: .disconnect(
        BrokerJournalDisconnectTerminal(
          operationID: disconnectOperationID,
          expectedFence: 2,
          tombstone: BrokerJournalTombstoneProjection(
            connectionID: connectionID,
            fence: 3,
            lastGenerationOrdinal: 2,
            tombstonedAt: timestamp
          )
        )
      ),
      credentialKeys: [key(candidate), key(previous.generation)]
    )
  }

  private func record(
    phase: BrokerJournalPayload,
    terminalOperations: [BrokerJournalTerminalOperation] = []
  ) throws -> BrokerJournalRecord {
    try BrokerJournalRecord(
      revision: 1,
      connectionID: connectionID,
      providerBinding: .openAI,
      fence: 2,
      lastGenerationOrdinal: 2,
      changedAt: timestamp,
      payload: phase,
      terminalOperations: terminalOperations
    )
  }

  private func readyProjection(
    ready: BrokerJournalReadyGeneration,
    fence: UInt64,
    ordinal: UInt64
  ) throws -> ReadyProjection {
    ReadyProjection(
      connectionID: connectionID,
      fence: fence,
      ready: try BrokerJournalRecordAdapter.readyGeneration(from: ready),
      lastGenerationOrdinal: ordinal
    )
  }

  private func journalReadyProjection(
    ready: BrokerJournalReadyGeneration,
    fence: UInt64,
    ordinal: UInt64
  ) -> BrokerJournalReadyProjection {
    BrokerJournalReadyProjection(
      connectionID: connectionID,
      fence: fence,
      ready: ready,
      lastGenerationOrdinal: ordinal
    )
  }

  private func key(_ generation: BrokerJournalCredentialGeneration) -> CredentialStoreKey {
    CredentialStoreKey(
      connectionID: connectionID,
      generationID: generation.generationID,
      generationOrdinal: generation.ordinal
    )
  }
}

private func fixtureUUID(_ value: Int) -> UUID {
  UUID(uuidString: String(format: "00000000-0000-4000-8000-%012d", value))!
}

private func fixtureTimestamp(_ milliseconds: Int64) throws -> JournalTimestamp {
  try JournalTimestamp(unixMilliseconds: milliseconds)
}
