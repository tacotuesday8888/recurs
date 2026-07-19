import Foundation
import Testing

@testable import RecursBrokerCore

@Suite("Broker credential state machine authoritative projection")
struct BrokerCredentialStateMachineAuthoritativeProjectionTests {
  @Test
  func exactReadsReturnSafeAbsentVacantStagingReadyCleanupAndTombstoneProjections() throws {
    let fixture = try AuthoritativeProjectionFixture()

    var absent = try BrokerCredentialStateMachine(preparedJournalEntries: [])
    let absentToken = try absent.beginAuthoritativeProjection(
      connectionID: fixture.primaryID
    )
    #expect(absentToken.expected == nil)
    #expect(
      try absent.finishAuthoritativeProjection(
        absentToken,
        result: .success(nil)
      ) == nil
    )

    let vacantRecord = try fixture.vacantRecord(connectionID: fixture.primaryID)
    var vacant = try fixture.machine(records: [vacantRecord])
    let vacantToken = try vacant.beginAuthoritativeProjection(
      connectionID: fixture.primaryID
    )
    #expect(
      try vacant.finishAuthoritativeProjection(
        vacantToken,
        result: .success(vacantToken.expected)
      ) == nil
    )

    var staging = try fixture.stagingMachine()
    let stagingToken = try staging.machine.beginAuthoritativeProjection(
      connectionID: fixture.primaryID
    )
    #expect(
      try staging.machine.finishAuthoritativeProjection(
        stagingToken,
        result: .success(stagingToken.expected)
      ) == .staging(staging.attempt)
    )

    let readyRecord = try fixture.readyRecord(connectionID: fixture.primaryID)
    var ready = try fixture.machine(records: [readyRecord])
    let readyToken = try ready.beginAuthoritativeProjection(
      connectionID: fixture.primaryID
    )
    #expect(
      try ready.finishAuthoritativeProjection(
        readyToken,
        result: .success(readyToken.expected)
      ) == ready.projection(for: fixture.primaryID)
    )

    let cleanupRecord = try BrokerJournalRecordAdapter.makeDisconnectFenced(
      predecessor: readyRecord,
      operationID: fixture.disconnectID,
      capturedAt: fixture.finishedAt
    )
    var cleanup = try fixture.machine(records: [cleanupRecord])
    let cleanupToken = try cleanup.beginAuthoritativeProjection(
      connectionID: fixture.primaryID
    )
    let cleanupProjection = cleanup.projection(for: fixture.primaryID)
    #expect(
      try cleanup.finishAuthoritativeProjection(
        cleanupToken,
        result: .success(cleanupToken.expected)
      ) == cleanupProjection
    )
    #expect(cleanupProjection?.usableReady == nil)

    let tombstoneRecord = try BrokerJournalRecordAdapter.makeTombstoned(
      predecessor: cleanupRecord,
      changedAt: fixture.finishedAt
    )
    var tombstone = try fixture.machine(records: [tombstoneRecord])
    let tombstoneToken = try tombstone.beginAuthoritativeProjection(
      connectionID: fixture.primaryID
    )
    #expect(
      try tombstone.finishAuthoritativeProjection(
        tombstoneToken,
        result: .success(tombstoneToken.expected)
      ) == tombstone.projection(for: fixture.primaryID)
    )
  }

  @Test
  func readLeaseBlocksSameConnectionMutationAndReadButIsolatesOtherConnections() throws {
    let fixture = try AuthoritativeProjectionFixture()
    var machine = try fixture.machine(
      records: [
        fixture.vacantRecord(connectionID: fixture.primaryID),
        fixture.vacantRecord(connectionID: fixture.secondaryID),
      ]
    )
    let token = try machine.beginAuthoritativeProjection(connectionID: fixture.primaryID)
    #expect(throws: BrokerJournalError.casConflict) {
      _ = try machine.beginAuthoritativeProjection(connectionID: fixture.primaryID)
    }
    let primaryFingerprint = BrokerCredentialStateMachine.fingerprint(
      kind: .stage,
      connectionID: fixture.primaryID,
      expectedFence: 0
    )
    #expect(throws: BrokerStateError.operationInProgress) {
      _ = try machine.preflight(
        connectionID: fixture.primaryID,
        operationID: fixture.operationID,
        fingerprint: primaryFingerprint
      )
    }
    let secondaryFingerprint = BrokerCredentialStateMachine.fingerprint(
      kind: .stage,
      connectionID: fixture.secondaryID,
      expectedFence: 0
    )
    #expect(
      try machine.preflight(
        connectionID: fixture.secondaryID,
        operationID: fixture.otherOperationID,
        fingerprint: secondaryFingerprint
      ) == .proceed
    )
    let secondary = try machine.beginAuthoritativeProjection(
      connectionID: fixture.secondaryID
    )

    #expect(
      try machine.finishAuthoritativeProjection(
        token,
        result: .success(token.expected)
      ) == nil
    )
    #expect(
      try machine.preflight(
        connectionID: fixture.primaryID,
        operationID: fixture.operationID,
        fingerprint: primaryFingerprint
      ) == .proceed
    )
    #expect(
      try machine.finishAuthoritativeProjection(
        secondary,
        result: .success(secondary.expected)
      ) == nil
    )
  }

  @Test
  func tagMismatchDisablesOnlyTheConnectionButTerminalReplayStillWins() throws {
    let fixture = try AuthoritativeProjectionFixture()
    var live = try fixture.stagingMachine()
    let token = try live.machine.beginAuthoritativeProjection(
      connectionID: fixture.primaryID
    )
    let mismatched = try #require(token.expected).withAuthenticationTag(byte: 0xee)

    #expect(throws: BrokerJournalError.casConflict) {
      _ = try live.machine.finishAuthoritativeProjection(
        token,
        result: .success(mismatched)
      )
    }
    #expect(live.machine.projection(for: fixture.primaryID) == .staging(live.attempt))
    #expect(throws: BrokerJournalError.storageUnavailable) {
      _ = try live.machine.beginAuthoritativeProjection(connectionID: fixture.primaryID)
    }
    let fingerprint = BrokerCredentialStateMachine.fingerprint(
      kind: .stage,
      connectionID: fixture.primaryID,
      expectedFence: 0,
      providerBinding: .openAI
    )
    #expect(
      try live.machine.preflight(
        connectionID: fixture.primaryID,
        operationID: fixture.operationID,
        fingerprint: fingerprint
      ) == .replay(.stage(.success(live.attempt)))
    )
    #expect(throws: BrokerStateError.storeUnavailable) {
      _ = try live.machine.preflight(
        connectionID: fixture.primaryID,
        operationID: fixture.otherOperationID,
        fingerprint: fingerprint
      )
    }

    let other = try live.machine.beginAuthoritativeProjection(
      connectionID: fixture.secondaryID
    )
    #expect(
      try live.machine.finishAuthoritativeProjection(other, result: .success(nil)) == nil
    )
  }

  @Test(
    arguments: [
      BrokerJournalError.invalidRecord,
      .nonCanonical,
      .unsupportedVersion,
      .authenticationFailed,
      .rollbackDetected,
    ]
  )
  func severeReadFailurePoisonsAllConnectionsAndInflightReads(
    _ error: BrokerJournalError
  ) throws {
    let fixture = try AuthoritativeProjectionFixture()
    var machine = try fixture.machine(
      records: [
        fixture.readyRecord(connectionID: fixture.primaryID),
        fixture.readyRecord(connectionID: fixture.secondaryID),
      ]
    )
    let primary = try machine.beginAuthoritativeProjection(connectionID: fixture.primaryID)
    let secondary = try machine.beginAuthoritativeProjection(connectionID: fixture.secondaryID)

    #expect(throws: error) {
      _ = try machine.finishAuthoritativeProjection(primary, result: .failure(error))
    }
    #expect(throws: BrokerJournalError.storageUnavailable) {
      _ = try machine.finishAuthoritativeProjection(
        secondary,
        result: .success(secondary.expected)
      )
    }
    #expect(throws: BrokerJournalError.storageUnavailable) {
      _ = try machine.beginAuthoritativeProjection(connectionID: fixture.secondaryID)
    }
    #expect(machine.projection(for: fixture.primaryID)?.usableReady != nil)
  }

  @Test(
    arguments: [
      BrokerJournalError.revisionOverflow,
      .casConflict,
      .lockUnavailable,
      .storageUnavailable,
      .mutationOutcomeUnknown,
    ]
  )
  func nonsevereReadFailureReleasesTheLeaseForExactRetry(
    _ error: BrokerJournalError
  ) throws {
    let fixture = try AuthoritativeProjectionFixture()
    var machine = try fixture.machine(
      records: [fixture.readyRecord(connectionID: fixture.primaryID)]
    )
    let failed = try machine.beginAuthoritativeProjection(connectionID: fixture.primaryID)
    #expect(throws: error) {
      _ = try machine.finishAuthoritativeProjection(failed, result: .failure(error))
    }

    let retry = try machine.beginAuthoritativeProjection(connectionID: fixture.primaryID)
    #expect(
      try machine.finishAuthoritativeProjection(
        retry,
        result: .success(retry.expected)
      ) == machine.projection(for: fixture.primaryID)
    )
  }

  @Test
  func staleTokenCannotClearANewerReadLease() throws {
    let fixture = try AuthoritativeProjectionFixture()
    var machine = try fixture.machine(
      records: [fixture.readyRecord(connectionID: fixture.primaryID)]
    )
    let stale = try machine.beginAuthoritativeProjection(connectionID: fixture.primaryID)
    #expect(throws: BrokerJournalError.storageUnavailable) {
      _ = try machine.finishAuthoritativeProjection(
        stale,
        result: .failure(.storageUnavailable)
      )
    }
    let current = try machine.beginAuthoritativeProjection(connectionID: fixture.primaryID)
    #expect(throws: BrokerJournalError.casConflict) {
      _ = try machine.finishAuthoritativeProjection(
        stale,
        result: .success(stale.expected)
      )
    }
    #expect(
      try machine.finishAuthoritativeProjection(
        current,
        result: .success(current.expected)
      ) == machine.projection(for: fixture.primaryID)
    )
  }

  @Test
  func awaitingCleanupRejectsReadWhilePausedCleanupAllowsExactProjection() throws {
    let fixture = try AuthoritativeProjectionFixture()
    let ready = try fixture.readyRecord(connectionID: fixture.primaryID)
    let fenced = try BrokerJournalRecordAdapter.makeDisconnectFenced(
      predecessor: ready,
      operationID: fixture.disconnectID,
      capturedAt: fixture.finishedAt
    )
    var machine = try fixture.machine(records: [fenced])
    guard
      case .delete(_, let delete) = try machine.beginJournalCleanup(
        connectionID: fixture.primaryID
      )
    else {
      Issue.record("expected disconnect cleanup deletion")
      return
    }
    #expect(throws: BrokerJournalError.casConflict) {
      _ = try machine.beginAuthoritativeProjection(connectionID: fixture.primaryID)
    }

    try machine.finishJournalDeleteAwait(delete, succeeded: false)
    let token = try machine.beginAuthoritativeProjection(connectionID: fixture.primaryID)
    let projected = machine.projection(for: fixture.primaryID)
    #expect(
      try machine.finishAuthoritativeProjection(
        token,
        result: .success(token.expected)
      ) == projected
    )
    #expect(projected?.usableReady == nil)
  }

  @Test
  func everyUsableCleanupFamilyReturnsItsSafeReadyGeneration() throws {
    let fixture = try AuthoritativeProjectionFixture()
    let ready = try fixture.readyRecord(connectionID: fixture.primaryID)
    let pending = try BrokerJournalRecordAdapter.makeStorePending(
      predecessor: ready,
      connectionID: fixture.primaryID,
      providerBinding: .openAI,
      attemptID: fixture.attemptID,
      operationID: fixture.operationID,
      candidateGenerationID: fixture.candidateID,
      capturedAt: fixture.finishedAt
    )
    let staging = try BrokerJournalRecordAdapter.makeStaging(
      predecessor: pending,
      changedAt: fixture.finishedAt
    )
    let stageCleanup = try BrokerJournalRecordAdapter.makeStageCleanupPending(
      predecessor: staging,
      error: .storeUnavailable,
      changedAt: fixture.finishedAt
    )
    let commitCleanup = try BrokerJournalRecordAdapter.makeCommitAuthority(
      predecessor: staging,
      operationID: fixture.disconnectID,
      capturedAt: fixture.finishedAt
    )
    let abortCleanup = try BrokerJournalRecordAdapter.makeAbortCleanupPending(
      predecessor: staging,
      operationID: fixture.disconnectID,
      changedAt: fixture.finishedAt
    )

    let priorGenerationID = try #require(ready.readyGenerationID)
    for record in [stageCleanup, abortCleanup] {
      var machine = try fixture.machine(records: [record])
      let token = try machine.beginAuthoritativeProjection(connectionID: fixture.primaryID)
      let projection = try machine.finishAuthoritativeProjection(
        token,
        result: .success(token.expected)
      )
      #expect(projection?.usableReady?.generation.generationID == priorGenerationID)
    }

    var committed = try fixture.machine(records: [commitCleanup])
    let committedToken = try committed.beginAuthoritativeProjection(
      connectionID: fixture.primaryID
    )
    let committedProjection = try committed.finishAuthoritativeProjection(
      committedToken,
      result: .success(committedToken.expected)
    )
    #expect(
      committedProjection?.usableReady?.generation.generationID == fixture.candidateID
    )
  }

  @Test(
    arguments: [
      BrokerJournalError.invalidRecord,
      .nonCanonical,
      .unsupportedVersion,
      .authenticationFailed,
      .rollbackDetected,
    ]
  )
  func recordedSevereMutationFailurePoisonsReadsAndFutureMutations(
    _ error: BrokerJournalError
  ) throws {
    let fixture = try AuthoritativeProjectionFixture()
    var machine = try fixture.machine(
      records: [fixture.readyRecord(connectionID: fixture.primaryID)]
    )
    let inflight = try machine.beginAuthoritativeProjection(connectionID: fixture.primaryID)

    machine.recordJournalFailure(error)

    #expect(throws: BrokerJournalError.storageUnavailable) {
      _ = try machine.finishAuthoritativeProjection(
        inflight,
        result: .success(inflight.expected)
      )
    }
    let fingerprint = BrokerCredentialStateMachine.fingerprint(
      kind: .stage,
      connectionID: fixture.secondaryID,
      expectedFence: 0
    )
    #expect(throws: BrokerStateError.storeUnavailable) {
      _ = try machine.preflight(
        connectionID: fixture.secondaryID,
        operationID: fixture.otherOperationID,
        fingerprint: fingerprint
      )
    }
    #expect(machine.projection(for: fixture.primaryID)?.usableReady != nil)
  }

  @Test
  func recordedNonsevereMutationFailureDoesNotPoisonReads() throws {
    let fixture = try AuthoritativeProjectionFixture()
    var machine = try fixture.machine(
      records: [fixture.readyRecord(connectionID: fixture.primaryID)]
    )

    machine.recordJournalFailure(.storageUnavailable)

    let token = try machine.beginAuthoritativeProjection(connectionID: fixture.primaryID)
    #expect(
      try machine.finishAuthoritativeProjection(
        token,
        result: .success(token.expected)
      ) == machine.projection(for: fixture.primaryID)
    )
  }
}

private struct AuthoritativeProjectionFixture {
  let primaryID = authoritativeProjectionUUID(1)
  let secondaryID = authoritativeProjectionUUID(2)
  let operationID = authoritativeProjectionUUID(10)
  let otherOperationID = authoritativeProjectionUUID(11)
  let disconnectID = authoritativeProjectionUUID(12)
  let attemptID = authoritativeProjectionUUID(20)
  let candidateID = authoritativeProjectionUUID(21)
  let startedAt: JournalTimestamp
  let finishedAt: JournalTimestamp

  init() throws {
    startedAt = try JournalTimestamp(canonicalText: "2026-07-13T03:00:00.000Z")
    finishedAt = try JournalTimestamp(canonicalText: "2026-07-13T03:00:01.000Z")
  }

  func vacantRecord(connectionID: UUID) throws -> BrokerJournalRecord {
    try BrokerJournalRecord(
      revision: 1,
      connectionID: connectionID,
      providerBinding: .openAI,
      fence: 0,
      lastGenerationOrdinal: 0,
      changedAt: startedAt,
      payload: .vacant(BrokerJournalVacantPayload())
    )
  }

  func readyRecord(connectionID: UUID) throws -> BrokerJournalRecord {
    let generation = BrokerJournalCredentialGeneration(
      generationID: authoritativeProjectionUUID(
        connectionID == primaryID ? 30 : 31
      ),
      ordinal: 1,
      createdAt: startedAt
    )
    return try BrokerJournalRecord(
      revision: 1,
      connectionID: connectionID,
      providerBinding: .openAI,
      fence: 1,
      lastGenerationOrdinal: 1,
      changedAt: startedAt,
      payload: .ready(
        BrokerJournalReadyPayload(
          ready: BrokerJournalReadyGeneration(
            generation: generation,
            committedAt: startedAt
          )
        )
      )
    )
  }

  func machine(records: [BrokerJournalRecord]) throws -> BrokerCredentialStateMachine {
    try BrokerCredentialStateMachine(
      preparedJournalEntries: try records.map { record in
        BrokerJournalPreparedEntry(
          snapshot: try snapshot(record: record, tagByte: UInt8(record.revision)),
          plan: try BrokerJournalRecordAdapter.recoveryPlan(
            for: record,
            recoveryChangedAt: record.changedAt
          )
        )
      }
    )
  }

  func stagingMachine() throws -> (
    machine: BrokerCredentialStateMachine,
    attempt: StagingAttempt
  ) {
    var machine = try BrokerCredentialStateMachine(preparedJournalEntries: [])
    let fingerprint = BrokerCredentialStateMachine.fingerprint(
      kind: .stage,
      connectionID: primaryID,
      expectedFence: 0,
      providerBinding: .openAI
    )
    let reservation = try machine.reserveJournalStage(
      proposal: machine.stageProposal(
        connectionID: primaryID,
        expectedFence: 0,
        providerBinding: .openAI
      ),
      operationID: operationID,
      fingerprint: fingerprint,
      generationID: candidateID,
      attemptID: attemptID,
      capturedAt: startedAt
    )
    let pending = try snapshot(record: reservation.replacement, tagByte: 0x41)
    let storing = try machine.finishJournalStageReservation(
      reservation,
      result: .success(pending)
    )
    let transition = try machine.beginJournalStaging(storing, changedAt: finishedAt)
    let selected = try snapshot(record: transition.replacement, tagByte: 0x42)
    let attempt = try machine.finishJournalStaging(
      transition,
      result: .success(selected)
    )
    return (machine, attempt)
  }

  func snapshot(
    record: BrokerJournalRecord,
    tagByte: UInt8
  ) throws -> BrokerJournalSnapshot {
    BrokerJournalSnapshot(
      record: record,
      authenticationTag: try JournalAuthenticationTag(
        bytes: Array(repeating: tagByte, count: 32)
      )
    )
  }
}

private func authoritativeProjectionUUID(_ value: Int) -> UUID {
  UUID(
    uuidString: String(
      format: "00000000-0000-4000-8000-%012llx",
      value
    )
  )!
}

extension BrokerJournalSnapshot {
  fileprivate func withAuthenticationTag(byte: UInt8) throws -> BrokerJournalSnapshot {
    BrokerJournalSnapshot(
      record: record,
      authenticationTag: try JournalAuthenticationTag(
        bytes: Array(repeating: byte, count: 32)
      )
    )
  }
}

extension BrokerJournalRecord {
  fileprivate var readyGenerationID: UUID? {
    guard case .ready(let payload) = payload else {
      return nil
    }
    return payload.ready.generation.generationID
  }
}
