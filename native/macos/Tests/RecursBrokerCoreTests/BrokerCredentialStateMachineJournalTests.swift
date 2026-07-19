import Foundation
import Testing

@testable import RecursBrokerCore

@Suite("Broker credential state machine journal")
struct BrokerCredentialStateMachineJournalTests {
  @Test
  func hydratesEveryPersistedTerminalVariantForExactReplayAndConflict() throws {
    let fixture = try JournalMachineFixture()
    let readyRecord = try fixture.readyRecordWithTerminalVariants(id: 1)
    let disconnectRecord = try fixture.tombstoneRecordWithTerminal(id: 2)
    let machine = try BrokerCredentialStateMachine(
      preparedJournalEntries: [
        try fixture.entry(readyRecord),
        try fixture.entry(disconnectRecord),
      ]
    )

    let readyConnection = readyRecord.connectionID
    for terminal in readyRecord.terminalOperations {
      let expected = try fixture.expectedHydratedTerminal(
        terminal,
        connectionID: readyConnection
      )
      let disposition = try machine.preflight(
        connectionID: readyConnection,
        operationID: terminal.operationID,
        fingerprint: expected.fingerprint
      )
      #expect(disposition == .replay(expected.outcome))
      #expect(throws: BrokerStateError.operationIDConflict) {
        _ = try machine.preflight(
          connectionID: readyConnection,
          operationID: terminal.operationID,
          fingerprint: BrokerCredentialStateMachine.fingerprint(
            kind: .disconnect,
            connectionID: readyConnection,
            expectedFence: 999
          )
        )
      }
    }

    guard case .disconnect(let disconnect) = disconnectRecord.terminalOperations[0] else {
      Issue.record("expected disconnect terminal")
      return
    }
    let disconnectProjection = try BrokerJournalRecordAdapter.tombstoneProjection(
      from: disconnect.tombstone
    )
    let disconnectFingerprint = BrokerCredentialStateMachine.fingerprint(
      kind: .disconnect,
      connectionID: disconnectRecord.connectionID,
      expectedFence: disconnect.expectedFence
    )
    #expect(
      try machine.preflight(
        connectionID: disconnectRecord.connectionID,
        operationID: disconnect.operationID,
        fingerprint: disconnectFingerprint
      ) == .replay(.disconnect(.success(disconnectProjection)))
    )
  }

  @Test
  func retainsExactlySixtyFourPersistedTerminalEntries() throws {
    let fixture = try JournalMachineFixture()
    let record = try fixture.readyRecordWithStageFIFO(id: 3, count: 64)
    let machine = try BrokerCredentialStateMachine(
      preparedJournalEntries: [try fixture.entry(record)]
    )

    for terminal in [record.terminalOperations.first!, record.terminalOperations.last!] {
      guard case .stageFailure(let value) = terminal else {
        Issue.record("expected stage failure")
        return
      }
      let fingerprint = BrokerCredentialStateMachine.fingerprint(
        kind: .stage,
        connectionID: record.connectionID,
        expectedFence: value.expectedFence,
        providerBinding: record.providerBinding
      )
      #expect(
        try machine.preflight(
          connectionID: record.connectionID,
          operationID: value.operationID,
          fingerprint: fingerprint
        ) == .replay(.stage(.failure(.cancelled)))
      )
    }
  }

  @Test
  func journalInitializationRejectsDuplicateInvalidAndCleanupTerminalCollisions() throws {
    let fixture = try JournalMachineFixture()
    let stable = try fixture.entry(fixture.readyRecord(id: 4))
    #expect(throws: BrokerJournalError.invalidRecord) {
      _ = try BrokerCredentialStateMachine(preparedJournalEntries: [stable, stable])
    }

    let stalePlan = BrokerJournalRecoveryPlan(
      bootstrap: stable.plan.bootstrap,
      projection: stable.plan.projection,
      preparation: stable.snapshot.record,
      cleanup: stable.plan.cleanup
    )
    #expect(throws: BrokerJournalError.invalidRecord) {
      _ = try BrokerCredentialStateMachine(
        preparedJournalEntries: [
          BrokerJournalPreparedEntry(snapshot: stable.snapshot, plan: stalePlan)
        ]
      )
    }

    #expect(throws: BrokerJournalError.invalidRecord) {
      _ = try BrokerCredentialStateMachine(
        preparedJournalEntries: [try fixture.stageCleanupWithOperationCollision(id: 5)]
      )
    }
    #expect(throws: BrokerJournalError.invalidRecord) {
      _ = try BrokerCredentialStateMachine(
        preparedJournalEntries: [try fixture.abortCleanupWithAttemptCollision(id: 6)]
      )
    }
  }

  @Test
  func installsAllCleanupFamiliesWithTheirSafeAuthorityAndExactSnapshots() throws {
    let fixture = try JournalMachineFixture()
    let entries = try [
      fixture.entry(fixture.stageCleanupRecord(id: 10, restored: false)),
      fixture.entry(fixture.readyCleanupRecord(id: 11)),
      fixture.entry(fixture.abortCleanupRecord(id: 12, restored: true)),
      fixture.entry(fixture.disconnectCleanupRecord(id: 13)),
    ]
    var machine = try BrokerCredentialStateMachine(preparedJournalEntries: entries)

    #expect(machine.projection(for: entries[0].snapshot.record.connectionID) == nil)
    #expect(
      machine.projection(for: entries[1].snapshot.record.connectionID)
        == entries[1].plan.projection
    )
    #expect(
      machine.projection(for: entries[2].snapshot.record.connectionID)
        == entries[2].plan.projection
    )
    #expect(
      machine.projection(for: entries[3].snapshot.record.connectionID)
        == entries[3].plan.projection
    )
    for entry in entries {
      #expect(
        machine.journalSnapshot(for: entry.snapshot.record.connectionID) == entry.snapshot
      )
    }

    for entry in entries {
      let connectionID = entry.snapshot.record.connectionID
      let expectedKeys = try #require(entry.plan.cleanup).credentialKeys
      for expectedKey in expectedKeys {
        guard
          case .delete(let key, let token) = try machine.beginJournalCleanup(
            connectionID: connectionID
          )
        else {
          Issue.record("expected ordered credential deletion")
          return
        }
        #expect(key == expectedKey)
        try machine.finishJournalDeleteAwait(token, succeeded: true)
      }

      guard
        case .needsFinalization(let request) = try machine.beginJournalCleanup(
          connectionID: connectionID
        )
      else {
        Issue.record("expected journal finalization")
        return
      }
      let token = try machine.beginJournalFinalization(
        request,
        changedAt: fixture.finalTime
      )
      #expect(token.expected == entry.snapshot)
      let expectedReplacement = try fixture.stableSuccessor(
        for: entry.snapshot.record,
        changedAt: fixture.finalTime
      )
      #expect(token.replacement == expectedReplacement)
      let selected = BrokerJournalSnapshot(
        record: token.replacement,
        authenticationTag: try fixture.tag(byte: UInt8(token.replacement.revision))
      )
      let outcome = try machine.finishJournalFinalization(
        token,
        result: .success(selected)
      )
      #expect(machine.journalSnapshot(for: connectionID) == selected)

      let cleanup = try #require(entry.plan.cleanup)
      let expectedTerminal = try fixture.expectedHydratedTerminal(
        cleanup.terminalOperation,
        connectionID: connectionID
      )
      #expect(outcome == expectedTerminal.outcome)
      #expect(
        try machine.preflight(
          connectionID: connectionID,
          operationID: cleanup.terminalOperation.operationID,
          fingerprint: expectedTerminal.fingerprint
        ) == .replay(expectedTerminal.outcome)
      )
    }
  }

  @Test
  func deleteAndFinalizationFailuresRetainExactResumableState() throws {
    let fixture = try JournalMachineFixture()
    let entry = try fixture.entry(fixture.disconnectCleanupRecord(id: 20))
    var machine = try BrokerCredentialStateMachine(preparedJournalEntries: [entry])
    let connectionID = entry.snapshot.record.connectionID
    let keys = try #require(entry.plan.cleanup).credentialKeys
    let timestamps = LockedSequence([fixture.finalTime, fixture.finalTime])

    guard
      case .delete(let firstKey, let failedDelete) = try machine.beginJournalCleanup(
        connectionID: connectionID
      )
    else {
      Issue.record("expected first delete")
      return
    }
    #expect(firstKey == keys[0])
    #expect(timestamps.count() == 0)
    try machine.finishJournalDeleteAwait(failedDelete, succeeded: false)
    #expect(throws: BrokerJournalError.casConflict) {
      try machine.finishJournalDeleteAwait(failedDelete, succeeded: true)
    }
    guard
      case .delete(let retriedKey, let retriedDelete) = try machine.beginJournalCleanup(
        connectionID: connectionID
      )
    else {
      Issue.record("expected retried delete")
      return
    }
    #expect(retriedKey == firstKey)
    #expect(timestamps.count() == 0)
    try machine.finishJournalDeleteAwait(retriedDelete, succeeded: true)

    guard
      case .delete(let secondKey, let secondDelete) = try machine.beginJournalCleanup(
        connectionID: connectionID
      )
    else {
      Issue.record("expected second delete")
      return
    }
    #expect(secondKey == keys[1])
    #expect(timestamps.count() == 0)
    try machine.finishJournalDeleteAwait(secondDelete, succeeded: true)

    guard
      case .needsFinalization(let request) = try machine.beginJournalCleanup(
        connectionID: connectionID
      )
    else {
      Issue.record("expected finalization request")
      return
    }
    #expect(timestamps.count() == 0)
    let failedFinalization = try machine.beginJournalFinalization(
      request,
      changedAt: timestamps.next()
    )
    #expect(timestamps.count() == 1)
    #expect(throws: BrokerJournalError.storageUnavailable) {
      _ = try machine.finishJournalFinalization(
        failedFinalization,
        result: .failure(.storageUnavailable)
      )
    }
    #expect(machine.journalSnapshot(for: connectionID) == entry.snapshot)
    #expect(throws: BrokerJournalError.casConflict) {
      _ = try machine.finishJournalFinalization(
        failedFinalization,
        result: .failure(.storageUnavailable)
      )
    }

    guard
      case .needsFinalization(let retryRequest) = try machine.beginJournalCleanup(
        connectionID: connectionID
      )
    else {
      Issue.record("expected finalization retry")
      return
    }
    let retry = try machine.beginJournalFinalization(
      retryRequest,
      changedAt: timestamps.next()
    )
    #expect(timestamps.count() == 2)
    let wrong = BrokerJournalSnapshot(
      record: entry.snapshot.record,
      authenticationTag: try fixture.tag(byte: 0xfa)
    )
    #expect(throws: BrokerJournalError.casConflict) {
      _ = try machine.finishJournalFinalization(retry, result: .success(wrong))
    }
    #expect(machine.journalSnapshot(for: connectionID) == entry.snapshot)
  }

  @Test
  func cleanupAwaitOnOneConnectionDoesNotBlockAnotherConnection() throws {
    let fixture = try JournalMachineFixture()
    let first = try fixture.entry(fixture.stageCleanupRecord(id: 30, restored: false))
    let second = try fixture.entry(fixture.abortCleanupRecord(id: 31, restored: true))
    var machine = try BrokerCredentialStateMachine(
      preparedJournalEntries: [first, second]
    )

    guard
      case .delete(_, let firstToken) = try machine.beginJournalCleanup(
        connectionID: first.snapshot.record.connectionID
      )
    else {
      Issue.record("expected first delete")
      return
    }
    guard
      case .delete(_, let secondToken) = try machine.beginJournalCleanup(
        connectionID: second.snapshot.record.connectionID
      )
    else {
      Issue.record("expected independent second delete")
      return
    }

    try machine.finishJournalDeleteAwait(secondToken, succeeded: true)
    try machine.finishJournalDeleteAwait(firstToken, succeeded: true)
  }

  @Test
  func deleteAwaitValidationRejectsSameRecordWithAStaleAuthenticationTag() throws {
    let fixture = try JournalMachineFixture()
    let entry = try fixture.entry(fixture.stageCleanupRecord(id: 40, restored: false))
    var machine = try BrokerCredentialStateMachine(preparedJournalEntries: [entry])
    guard
      case .delete(_, let token) = try machine.beginJournalCleanup(
        connectionID: entry.snapshot.record.connectionID
      )
    else {
      Issue.record("expected journal delete")
      return
    }
    let stale = BrokerJournalSnapshot(
      record: entry.snapshot.record,
      authenticationTag: try fixture.tag(byte: 0xfe)
    )

    #expect(throws: BrokerJournalError.casConflict) {
      try BrokerCredentialStateMachine.validateJournalDeleteAwait(
        token,
        liveSnapshot: stale
      )
    }
    try BrokerCredentialStateMachine.validateJournalDeleteAwait(
      token,
      liveSnapshot: entry.snapshot
    )
  }
}

private struct JournalMachineFixture {
  let time: JournalTimestamp
  let finalTime: JournalTimestamp

  init() throws {
    time = try JournalTimestamp(canonicalText: "2026-07-13T00:00:00.000Z")
    finalTime = try JournalTimestamp(canonicalText: "2026-07-13T00:00:02.000Z")
  }

  func entry(_ record: BrokerJournalRecord) throws -> BrokerJournalPreparedEntry {
    let plan = try BrokerJournalRecordAdapter.recoveryPlan(
      for: record,
      recoveryChangedAt: finalTime
    )
    guard plan.preparation == nil else {
      throw BrokerJournalError.invalidRecord
    }
    return BrokerJournalPreparedEntry(
      snapshot: BrokerJournalSnapshot(
        record: record,
        authenticationTag: try tag(byte: UInt8(truncatingIfNeeded: record.revision))
      ),
      plan: plan
    )
  }

  func tag(byte: UInt8) throws -> JournalAuthenticationTag {
    try JournalAuthenticationTag(bytes: Array(repeating: byte, count: 32))
  }

  func readyRecord(id: Int) throws -> BrokerJournalRecord {
    let values = values(id)
    return try BrokerJournalRecord(
      revision: 1,
      connectionID: values.connectionID,
      providerBinding: .openAI,
      fence: 2,
      lastGenerationOrdinal: 2,
      changedAt: time,
      payload: .ready(BrokerJournalReadyPayload(ready: values.previous))
    )
  }

  func readyRecordWithTerminalVariants(id: Int) throws -> BrokerJournalRecord {
    let values = values(id)
    let historicalReady = journalReadyProjection(
      connectionID: values.connectionID,
      ready: values.previous,
      fence: 1
    )
    let terminals: [BrokerJournalTerminalOperation] = [
      .stageFailure(
        BrokerJournalStageFailureTerminal(
          operationID: journalMachineUUID(id, 10),
          expectedFence: 0,
          error: .cancelled
        )
      ),
      .stageFailure(
        BrokerJournalStageFailureTerminal(
          operationID: journalMachineUUID(id, 11),
          expectedFence: 0,
          error: .storeUnavailable
        )
      ),
      .stageFailure(
        BrokerJournalStageFailureTerminal(
          operationID: journalMachineUUID(id, 12),
          expectedFence: 0,
          error: .attemptNotCurrent
        )
      ),
      .commit(
        BrokerJournalCommitTerminal(
          operationID: journalMachineUUID(id, 13),
          expectedFence: 1,
          attemptID: journalMachineUUID(id, 14),
          ready: historicalReady
        )
      ),
      .abort(
        BrokerJournalAbortTerminal(
          operationID: journalMachineUUID(id, 15),
          expectedFence: 2,
          attemptID: journalMachineUUID(id, 16),
          restoredReady: journalReadyProjection(
            connectionID: values.connectionID,
            ready: values.previous,
            fence: 2
          )
        )
      ),
    ]
    return try BrokerJournalRecord(
      revision: 1,
      connectionID: values.connectionID,
      providerBinding: .openAI,
      fence: 2,
      lastGenerationOrdinal: 2,
      changedAt: time,
      payload: .ready(BrokerJournalReadyPayload(ready: values.previous)),
      terminalOperations: terminals
    )
  }

  func readyRecordWithStageFIFO(id: Int, count: Int) throws -> BrokerJournalRecord {
    let values = values(id)
    let terminals = (0..<count).map { index in
      BrokerJournalTerminalOperation.stageFailure(
        BrokerJournalStageFailureTerminal(
          operationID: journalMachineUUID(id, 100 + index),
          expectedFence: 0,
          error: .cancelled
        )
      )
    }
    return try BrokerJournalRecord(
      revision: 1,
      connectionID: values.connectionID,
      providerBinding: .openAI,
      fence: 64,
      lastGenerationOrdinal: 64,
      changedAt: time,
      payload: .ready(BrokerJournalReadyPayload(ready: values.previous)),
      terminalOperations: terminals
    )
  }

  func tombstoneRecordWithTerminal(id: Int) throws -> BrokerJournalRecord {
    let values = values(id)
    let tombstone = BrokerJournalTombstoneProjection(
      connectionID: values.connectionID,
      fence: 3,
      lastGenerationOrdinal: 2,
      tombstonedAt: time
    )
    return try BrokerJournalRecord(
      revision: 1,
      connectionID: values.connectionID,
      providerBinding: .openAI,
      fence: 3,
      lastGenerationOrdinal: 2,
      changedAt: time,
      payload: .tombstoned(BrokerJournalTombstonedPayload(tombstonedAt: time)),
      terminalOperations: [
        .disconnect(
          BrokerJournalDisconnectTerminal(
            operationID: journalMachineUUID(id, 20),
            expectedFence: 2,
            tombstone: tombstone
          )
        )
      ]
    )
  }

  func stageCleanupRecord(id: Int, restored: Bool) throws -> BrokerJournalRecord {
    let values = values(id)
    return try cleanupRecord(
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
    return try cleanupRecord(
      id: id,
      payload: .readyCleanupPending(
        BrokerJournalReadyCleanupPendingPayload(
          attemptID: values.attemptID,
          operationID: values.operationID,
          expectedFence: 2,
          ready: BrokerJournalReadyGeneration(generation: values.candidate, committedAt: time),
          previousReady: values.previous
        )
      )
    )
  }

  func abortCleanupRecord(id: Int, restored: Bool) throws -> BrokerJournalRecord {
    let values = values(id)
    return try cleanupRecord(
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
      connectionID: values.connectionID,
      providerBinding: .openAI,
      fence: 3,
      lastGenerationOrdinal: 2,
      changedAt: time,
      payload: .disconnectFenced(
        BrokerJournalDisconnectFencedPayload(
          operationID: values.operationID,
          expectedFence: 2,
          tombstonedAt: time,
          deleteGenerations: [values.candidate, values.previous.generation]
        )
      )
    )
  }

  func stageCleanupWithOperationCollision(id: Int) throws -> BrokerJournalPreparedEntry {
    let values = values(id)
    let record = try BrokerJournalRecord(
      revision: 1,
      connectionID: values.connectionID,
      providerBinding: .openAI,
      fence: 2,
      lastGenerationOrdinal: 2,
      changedAt: time,
      payload: .stageCleanupPending(
        BrokerJournalStageCleanupPendingPayload(
          attemptID: values.attemptID,
          operationID: values.operationID,
          expectedFence: 1,
          candidate: values.candidate,
          restoredReady: values.previous,
          error: .cancelled
        )
      ),
      terminalOperations: [
        .stageFailure(
          BrokerJournalStageFailureTerminal(
            operationID: values.operationID,
            expectedFence: 0,
            error: .cancelled
          )
        )
      ]
    )
    return try entry(record)
  }

  func abortCleanupWithAttemptCollision(id: Int) throws -> BrokerJournalPreparedEntry {
    let values = values(id)
    let historicalReady = journalReadyProjection(
      connectionID: values.connectionID,
      ready: values.previous,
      fence: 1
    )
    let record = try BrokerJournalRecord(
      revision: 1,
      connectionID: values.connectionID,
      providerBinding: .openAI,
      fence: 2,
      lastGenerationOrdinal: 2,
      changedAt: time,
      payload: .abortCleanupPending(
        BrokerJournalAbortCleanupPendingPayload(
          attemptID: values.attemptID,
          operationID: values.operationID,
          expectedFence: 2,
          candidate: values.candidate,
          restoredReady: values.previous
        )
      ),
      terminalOperations: [
        .commit(
          BrokerJournalCommitTerminal(
            operationID: journalMachineUUID(id, 90),
            expectedFence: 1,
            attemptID: values.attemptID,
            ready: historicalReady
          )
        )
      ]
    )
    return try entry(record)
  }

  func stableSuccessor(
    for record: BrokerJournalRecord,
    changedAt: JournalTimestamp
  ) throws -> BrokerJournalRecord {
    switch record.phase {
    case .stageCleanupPending:
      try BrokerJournalRecordAdapter.makeStableStageFailure(
        predecessor: record,
        changedAt: changedAt
      )
    case .readyCleanupPending:
      try BrokerJournalRecordAdapter.makeStableCommit(
        predecessor: record,
        changedAt: changedAt
      )
    case .abortCleanupPending:
      try BrokerJournalRecordAdapter.makeStableAbort(
        predecessor: record,
        changedAt: changedAt
      )
    case .disconnectFenced:
      try BrokerJournalRecordAdapter.makeTombstoned(
        predecessor: record,
        changedAt: changedAt
      )
    default:
      throw BrokerJournalError.invalidRecord
    }
  }

  func expectedHydratedTerminal(
    _ terminal: BrokerJournalTerminalOperation,
    connectionID: UUID
  ) throws -> (
    fingerprint: BrokerCredentialStateMachine.OperationFingerprint,
    outcome: BrokerCredentialStateMachine.TerminalOutcome
  ) {
    switch terminal {
    case .stageFailure(let value):
      let error: BrokerStateError =
        switch value.error {
        case .cancelled: .cancelled
        case .storeUnavailable: .storeUnavailable
        case .attemptNotCurrent: .attemptNotCurrent
        }
      return (
        BrokerCredentialStateMachine.fingerprint(
          kind: .stage,
          connectionID: connectionID,
          expectedFence: value.expectedFence,
          providerBinding: .openAI
        ),
        .stage(.failure(error))
      )
    case .commit(let value):
      return (
        BrokerCredentialStateMachine.fingerprint(
          kind: .commit,
          connectionID: connectionID,
          expectedFence: value.expectedFence,
          attemptID: value.attemptID
        ),
        .commit(.success(try BrokerJournalRecordAdapter.readyProjection(from: value.ready)))
      )
    case .abort(let value):
      return (
        BrokerCredentialStateMachine.fingerprint(
          kind: .abort,
          connectionID: connectionID,
          expectedFence: value.expectedFence,
          attemptID: value.attemptID
        ),
        .abort(
          .success(
            try value.restoredReady.map {
              try BrokerJournalRecordAdapter.readyProjection(from: $0)
            }
          )
        )
      )
    case .disconnect(let value):
      return (
        BrokerCredentialStateMachine.fingerprint(
          kind: .disconnect,
          connectionID: connectionID,
          expectedFence: value.expectedFence
        ),
        .disconnect(
          .success(try BrokerJournalRecordAdapter.tombstoneProjection(from: value.tombstone))
        )
      )
    }
  }

  private func cleanupRecord(
    id: Int,
    payload: BrokerJournalPayload
  ) throws -> BrokerJournalRecord {
    try BrokerJournalRecord(
      revision: 1,
      connectionID: values(id).connectionID,
      providerBinding: .openAI,
      fence: 2,
      lastGenerationOrdinal: 2,
      changedAt: time,
      payload: payload
    )
  }

  private func values(_ id: Int) -> (
    connectionID: UUID,
    attemptID: UUID,
    operationID: UUID,
    previous: BrokerJournalReadyGeneration,
    candidate: BrokerJournalCredentialGeneration
  ) {
    let previous = BrokerJournalReadyGeneration(
      generation: BrokerJournalCredentialGeneration(
        generationID: journalMachineUUID(id, 3),
        ordinal: 1,
        createdAt: time
      ),
      committedAt: time
    )
    return (
      journalMachineUUID(id, 0),
      journalMachineUUID(id, 1),
      journalMachineUUID(id, 2),
      previous,
      BrokerJournalCredentialGeneration(
        generationID: journalMachineUUID(id, 4),
        ordinal: 2,
        createdAt: time
      )
    )
  }

  private func journalReadyProjection(
    connectionID: UUID,
    ready: BrokerJournalReadyGeneration,
    fence: UInt64
  ) -> BrokerJournalReadyProjection {
    BrokerJournalReadyProjection(
      connectionID: connectionID,
      fence: fence,
      ready: ready,
      lastGenerationOrdinal: fence
    )
  }
}

private func journalMachineUUID(_ connection: Int, _ value: Int) -> UUID {
  UUID(
    uuidString: String(
      format: "%08d-0000-4000-8000-%012d",
      connection,
      value
    )
  )!
}
