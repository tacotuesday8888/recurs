import Foundation
import Testing

@testable import RecursBrokerCore

@Suite("Broker credential state machine journal authority")
struct BrokerCredentialStateMachineAuthorityJournalTests {
  @Test
  func directCommitPublishesAndMemoizesOnlyAfterExactAuthorityCAS() throws {
    let fixture = try AuthorityJournalMachineFixture()
    var live = try fixture.liveStaging(previousReady: false)
    let fingerprint = BrokerCredentialStateMachine.fingerprint(
      kind: .commit,
      connectionID: fixture.connectionID,
      expectedFence: live.attempt.fence,
      attemptID: live.attempt.attemptID
    )
    let proposal = try live.machine.commitProposal(
      connectionID: fixture.connectionID,
      attemptID: live.attempt.attemptID,
      operationID: fixture.commitOperationID,
      fingerprint: fingerprint
    )

    let token = try live.machine.reserveJournalCommit(
      proposal: proposal,
      capturedAt: fixture.authorityTime
    )

    #expect(token.connectionID == fixture.connectionID)
    #expect(token.expected == live.snapshot)
    #expect(token.replacement.phase == .ready)
    #expect(live.machine.projection(for: fixture.connectionID) == .staging(live.attempt))
    #expect(throws: BrokerStateError.operationInProgress) {
      _ = try live.machine.preflight(
        connectionID: fixture.connectionID,
        operationID: fixture.otherOperationID,
        fingerprint: fingerprint
      )
    }

    let selected = try fixture.snapshot(token.replacement, tagByte: 0x31)
    let completion = try live.machine.finishJournalAuthority(
      token,
      result: .success(selected)
    )
    guard case .completed(let outcome) = completion else {
      Issue.record("expected direct completion")
      return
    }
    guard case .commit(.success(let ready)) = outcome else {
      Issue.record("expected commit outcome")
      return
    }
    #expect(ready.ready.generation == live.attempt.candidate)
    #expect(live.machine.projection(for: fixture.connectionID) == .ready(ready))
    #expect(live.machine.journalSnapshot(for: fixture.connectionID) == selected)
    #expect(
      try live.machine.preflight(
        connectionID: fixture.connectionID,
        operationID: fixture.commitOperationID,
        fingerprint: fingerprint
      ) == .replay(outcome)
    )
  }

  @Test
  func ambiguousCommitCASFailureRetainsExactReservationForSafeRetry() throws {
    let fixture = try AuthorityJournalMachineFixture()
    var live = try fixture.liveStaging(previousReady: false)
    let fingerprint = fixture.fingerprint(
      kind: .commit,
      fence: live.attempt.fence,
      attemptID: live.attempt.attemptID
    )
    let token = try live.machine.reserveJournalCommit(
      proposal: live.machine.commitProposal(
        connectionID: fixture.connectionID,
        attemptID: live.attempt.attemptID,
        operationID: fixture.commitOperationID,
        fingerprint: fingerprint
      ),
      capturedAt: fixture.authorityTime
    )

    #expect(throws: BrokerJournalError.mutationOutcomeUnknown) {
      _ = try live.machine.finishJournalAuthority(
        token,
        result: .failure(.mutationOutcomeUnknown)
      )
    }
    #expect(live.machine.projection(for: fixture.connectionID) == .staging(live.attempt))
    #expect(live.machine.journalSnapshot(for: fixture.connectionID) == live.snapshot)
    #expect(throws: BrokerStateError.operationInProgress) {
      _ = try live.machine.preflight(
        connectionID: fixture.connectionID,
        operationID: fixture.otherOperationID,
        fingerprint: fingerprint
      )
    }

    let selected = try fixture.snapshot(token.replacement, tagByte: 0x32)
    #expect(
      try live.machine.finishJournalAuthority(
        token,
        result: .success(selected)
      ).isCompleted
    )
  }

  @Test
  func wrongSelectedCommitRecordRetainsReservationWhileDefiniteFailuresClearIt() throws {
    let fixture = try AuthorityJournalMachineFixture()
    var wrongLive = try fixture.liveStaging(previousReady: false)
    let fingerprint = fixture.fingerprint(
      kind: .commit,
      fence: wrongLive.attempt.fence,
      attemptID: wrongLive.attempt.attemptID
    )
    let wrongToken = try wrongLive.machine.reserveJournalCommit(
      proposal: wrongLive.machine.commitProposal(
        connectionID: fixture.connectionID,
        attemptID: wrongLive.attempt.attemptID,
        operationID: fixture.commitOperationID,
        fingerprint: fingerprint
      ),
      capturedAt: fixture.authorityTime
    )

    #expect(throws: BrokerJournalError.casConflict) {
      _ = try wrongLive.machine.finishJournalAuthority(
        wrongToken,
        result: .success(wrongLive.snapshot)
      )
    }
    #expect(throws: BrokerStateError.operationInProgress) {
      _ = try wrongLive.machine.preflight(
        connectionID: fixture.connectionID,
        operationID: fixture.otherOperationID,
        fingerprint: fingerprint
      )
    }

    for error in [
      BrokerJournalError.revisionOverflow,
      .casConflict,
      .lockUnavailable,
      .storageUnavailable,
    ] {
      var definiteLive = try fixture.liveStaging(previousReady: false)
      let definiteToken = try definiteLive.machine.reserveJournalCommit(
        proposal: definiteLive.machine.commitProposal(
          connectionID: fixture.connectionID,
          attemptID: definiteLive.attempt.attemptID,
          operationID: fixture.commitOperationID,
          fingerprint: fingerprint
        ),
        capturedAt: fixture.authorityTime
      )
      #expect(throws: error) {
        _ = try definiteLive.machine.finishJournalAuthority(
          definiteToken,
          result: .failure(error)
        )
      }
      #expect(
        try definiteLive.machine.preflight(
          connectionID: fixture.connectionID,
          operationID: fixture.commitOperationID,
          fingerprint: fingerprint
        ) == .proceed
      )
    }
  }

  @Test
  func reconnectCommitDerivesReadyAuthorityCleanupAndDelayedMemoFromPlan() throws {
    let fixture = try AuthorityJournalMachineFixture()
    var live = try fixture.liveStaging(previousReady: true)
    let fingerprint = fixture.fingerprint(
      kind: .commit,
      fence: live.attempt.fence,
      attemptID: live.attempt.attemptID
    )
    let token = try live.machine.reserveJournalCommit(
      proposal: live.machine.commitProposal(
        connectionID: fixture.connectionID,
        attemptID: live.attempt.attemptID,
        operationID: fixture.commitOperationID,
        fingerprint: fingerprint
      ),
      capturedAt: fixture.authorityTime
    )
    #expect(token.replacement.phase == .readyCleanupPending)
    let selected = try fixture.snapshot(token.replacement, tagByte: 0x33)

    let completion = try live.machine.finishJournalAuthority(
      token,
      result: .success(selected)
    )
    guard case .cleanup(let outcome) = completion,
      case .commit(.success(let ready)) = outcome
    else {
      Issue.record("expected reconnect commit cleanup")
      return
    }
    #expect(live.machine.projection(for: fixture.connectionID) == .ready(ready))
    #expect(
      try live.machine.preflight(
        connectionID: fixture.connectionID,
        operationID: fixture.commitOperationID,
        fingerprint: fingerprint
      ) == .resumeCleanup
    )

    guard
      case .delete(let key, let delete) = try live.machine.beginJournalCleanup(
        connectionID: fixture.connectionID
      )
    else {
      Issue.record("expected previous-ready deletion")
      return
    }
    #expect(key == fixture.previousReadyKey)
    try live.machine.finishJournalDeleteAwait(delete, succeeded: true)
    guard
      case .needsFinalization(let request) = try live.machine.beginJournalCleanup(
        connectionID: fixture.connectionID
      )
    else {
      Issue.record("expected stable journal finalization")
      return
    }
    let finalization = try live.machine.beginJournalFinalization(
      request,
      changedAt: fixture.finalTime
    )
    let stable = try fixture.snapshot(finalization.replacement, tagByte: 0x34)
    #expect(
      try live.machine.finishJournalFinalization(
        finalization,
        result: .success(stable)
      ) == outcome
    )
    #expect(
      try live.machine.preflight(
        connectionID: fixture.connectionID,
        operationID: fixture.commitOperationID,
        fingerprint: fingerprint
      ) == .replay(outcome)
    )
  }

  @Test
  func freshAbortRestoresVacantAndFinalizesAfterCandidateCleanup() throws {
    let fixture = try AuthorityJournalMachineFixture()
    var live = try fixture.liveStaging(previousReady: false)
    let fingerprint = fixture.fingerprint(
      kind: .abort,
      fence: live.attempt.fence,
      attemptID: live.attempt.attemptID
    )
    let token = try live.machine.reserveJournalAbort(
      proposal: live.machine.abortProposal(
        connectionID: fixture.connectionID,
        attemptID: live.attempt.attemptID,
        operationID: fixture.commitOperationID,
        fingerprint: fingerprint
      ),
      changedAt: fixture.authorityTime
    )
    #expect(token.replacement.phase == .abortCleanupPending)

    let selected = try fixture.snapshot(token.replacement, tagByte: 0x41)
    guard
      case .cleanup(let outcome) = try live.machine.finishJournalAuthority(
        token,
        result: .success(selected)
      ),
      case .abort(.success(let restored)) = outcome
    else {
      Issue.record("expected abort cleanup")
      return
    }
    #expect(restored == nil)
    #expect(live.machine.projection(for: fixture.connectionID) == nil)
    #expect(
      try live.machine.preflight(
        connectionID: fixture.connectionID,
        operationID: fixture.commitOperationID,
        fingerprint: fingerprint
      ) == .resumeCleanup
    )

    guard
      case .delete(let key, let deletion) = try live.machine.beginJournalCleanup(
        connectionID: fixture.connectionID
      )
    else {
      Issue.record("expected candidate cleanup")
      return
    }
    #expect(key.generationID == live.attempt.candidate.generationID)
    try live.machine.finishJournalDeleteAwait(deletion, succeeded: true)
    guard
      case .needsFinalization(let request) = try live.machine.beginJournalCleanup(
        connectionID: fixture.connectionID
      )
    else {
      Issue.record("expected abort finalization")
      return
    }
    let finalization = try live.machine.beginJournalFinalization(
      request,
      changedAt: fixture.finalTime
    )
    let stable = try fixture.snapshot(finalization.replacement, tagByte: 0x42)
    #expect(
      try live.machine.finishJournalFinalization(
        finalization,
        result: .success(stable)
      ) == outcome
    )
    #expect(
      try live.machine.preflight(
        connectionID: fixture.connectionID,
        operationID: fixture.commitOperationID,
        fingerprint: fingerprint
      ) == .replay(outcome)
    )
  }

  @Test
  func reconnectAbortRestoresReadyAndDerivesCandidateCleanupFromPlan() throws {
    let fixture = try AuthorityJournalMachineFixture()
    var live = try fixture.liveStaging(previousReady: true)
    let fingerprint = fixture.fingerprint(
      kind: .abort,
      fence: live.attempt.fence,
      attemptID: live.attempt.attemptID
    )
    let token = try live.machine.reserveJournalAbort(
      proposal: live.machine.abortProposal(
        connectionID: fixture.connectionID,
        attemptID: live.attempt.attemptID,
        operationID: fixture.commitOperationID,
        fingerprint: fingerprint
      ),
      changedAt: fixture.authorityTime
    )
    let selected = try fixture.snapshot(token.replacement, tagByte: 0x43)

    guard
      case .cleanup(let outcome) = try live.machine.finishJournalAuthority(
        token,
        result: .success(selected)
      ),
      case .abort(.success(let restored?)) = outcome
    else {
      Issue.record("expected restored-ready abort cleanup")
      return
    }
    #expect(live.machine.projection(for: fixture.connectionID) == .ready(restored))
    #expect(restored.ready == live.attempt.previousReady)
    guard
      case .delete(let key, _) = try live.machine.beginJournalCleanup(
        connectionID: fixture.connectionID
      )
    else {
      Issue.record("expected candidate cleanup")
      return
    }
    #expect(key.generationID == live.attempt.candidate.generationID)
  }

  @Test
  func vacantDisconnectStillRequiresZeroKeyJournalFinalization() throws {
    let fixture = try AuthorityJournalMachineFixture()
    var machine = try fixture.stableMachine(record: fixture.vacantRecord())
    let fingerprint = fixture.fingerprint(kind: .disconnect, fence: 0, attemptID: nil)
    let token = try machine.reserveJournalDisconnect(
      proposal: machine.disconnectProposal(
        connectionID: fixture.connectionID,
        operationID: fixture.commitOperationID,
        fingerprint: fingerprint
      ),
      capturedAt: fixture.authorityTime
    )
    let selected = try fixture.snapshot(token.replacement, tagByte: 0x51)

    guard
      case .cleanup(let outcome) = try machine.finishJournalAuthority(
        token,
        result: .success(selected)
      ),
      case .disconnect(.success(let tombstone)) = outcome
    else {
      Issue.record("expected disconnect cleanup")
      return
    }
    #expect(machine.projection(for: fixture.connectionID) == .tombstoned(tombstone))
    guard
      case .needsFinalization(let request) = try machine.beginJournalCleanup(
        connectionID: fixture.connectionID
      )
    else {
      Issue.record("zero-key disconnect must still finalize the journal")
      return
    }
    let finalization = try machine.beginJournalFinalization(
      request,
      changedAt: fixture.finalTime
    )
    let stable = try fixture.snapshot(finalization.replacement, tagByte: 0x52)
    #expect(
      try machine.finishJournalFinalization(
        finalization,
        result: .success(stable)
      ) == outcome
    )
    #expect(
      try machine.preflight(
        connectionID: fixture.connectionID,
        operationID: fixture.commitOperationID,
        fingerprint: fingerprint
      ) == .replay(outcome)
    )
  }

  @Test
  func readyDisconnectDerivesReadyGenerationCleanupFromPlan() throws {
    let fixture = try AuthorityJournalMachineFixture()
    var machine = try fixture.stableMachine(record: fixture.readyRecord())
    let fingerprint = fixture.fingerprint(kind: .disconnect, fence: 1, attemptID: nil)
    let token = try machine.reserveJournalDisconnect(
      proposal: machine.disconnectProposal(
        connectionID: fixture.connectionID,
        operationID: fixture.commitOperationID,
        fingerprint: fingerprint
      ),
      capturedAt: fixture.authorityTime
    )
    let selected = try fixture.snapshot(token.replacement, tagByte: 0x53)
    guard
      case .cleanup = try machine.finishJournalAuthority(
        token,
        result: .success(selected)
      ),
      case .delete(let key, _) = try machine.beginJournalCleanup(
        connectionID: fixture.connectionID
      )
    else {
      Issue.record("expected ready-generation cleanup")
      return
    }
    #expect(key == fixture.previousReadyKey)
  }

  @Test
  func stagingDisconnectDerivesDescendingCandidateAndPreviousCleanupFromPlan() throws {
    let fixture = try AuthorityJournalMachineFixture()
    var live = try fixture.liveStaging(previousReady: true)
    let fingerprint = fixture.fingerprint(
      kind: .disconnect,
      fence: live.attempt.fence,
      attemptID: nil
    )
    let token = try live.machine.reserveJournalDisconnect(
      proposal: live.machine.disconnectProposal(
        connectionID: fixture.connectionID,
        operationID: fixture.commitOperationID,
        fingerprint: fingerprint
      ),
      capturedAt: fixture.authorityTime
    )
    let selected = try fixture.snapshot(token.replacement, tagByte: 0x54)
    guard
      case .cleanup = try live.machine.finishJournalAuthority(
        token,
        result: .success(selected)
      ),
      case .delete(let candidateKey, let candidateDelete) =
        try live.machine.beginJournalCleanup(connectionID: fixture.connectionID)
    else {
      Issue.record("expected candidate cleanup first")
      return
    }
    #expect(candidateKey.generationID == live.attempt.candidate.generationID)
    try live.machine.finishJournalDeleteAwait(candidateDelete, succeeded: true)
    guard
      case .delete(let previousKey, _) = try live.machine.beginJournalCleanup(
        connectionID: fixture.connectionID
      )
    else {
      Issue.record("expected previous generation cleanup second")
      return
    }
    #expect(previousKey == fixture.previousReadyKey)
  }

  @Test
  func staleAuthenticationTagTokenCannotClearOrCompleteExactReservation() throws {
    let fixture = try AuthorityJournalMachineFixture()
    var live = try fixture.liveStaging(previousReady: false)
    let fingerprint = fixture.fingerprint(
      kind: .commit,
      fence: live.attempt.fence,
      attemptID: live.attempt.attemptID
    )
    let token = try live.machine.reserveJournalCommit(
      proposal: live.machine.commitProposal(
        connectionID: fixture.connectionID,
        attemptID: live.attempt.attemptID,
        operationID: fixture.commitOperationID,
        fingerprint: fingerprint
      ),
      capturedAt: fixture.authorityTime
    )
    let stale = BrokerCredentialStateMachine.JournalAuthorityAwaitToken(
      connectionID: token.connectionID,
      reservation: token.reservation,
      current: token.current,
      expected: try fixture.snapshot(token.expected.record, tagByte: 0x61),
      replacement: token.replacement
    )
    let selected = try fixture.snapshot(token.replacement, tagByte: 0x62)

    let mismatched = BrokerCredentialStateMachine.JournalAuthorityAwaitToken(
      connectionID: authorityJournalUUID(98),
      reservation: token.reservation,
      current: token.current,
      expected: token.expected,
      replacement: token.replacement
    )
    #expect(throws: BrokerJournalError.casConflict) {
      _ = try live.machine.finishJournalAuthority(mismatched, result: .success(selected))
    }

    #expect(throws: BrokerJournalError.casConflict) {
      _ = try live.machine.finishJournalAuthority(stale, result: .success(selected))
    }
    #expect(throws: BrokerStateError.operationInProgress) {
      _ = try live.machine.preflight(
        connectionID: fixture.connectionID,
        operationID: fixture.otherOperationID,
        fingerprint: fingerprint
      )
    }
    #expect(
      try live.machine.finishJournalAuthority(
        token,
        result: .success(selected)
      ).isCompleted
    )
  }

  @Test
  func abortProposalPreservesStateErrorsBeforeAuthorityReservation() throws {
    let fixture = try AuthorityJournalMachineFixture()
    var live = try fixture.liveStaging(previousReady: false)
    let validFingerprint = fixture.fingerprint(
      kind: .abort,
      fence: live.attempt.fence,
      attemptID: live.attempt.attemptID
    )
    #expect(throws: BrokerStateError.attemptNotCurrent) {
      _ = try live.machine.abortProposal(
        connectionID: fixture.connectionID,
        attemptID: fixture.otherOperationID,
        operationID: fixture.commitOperationID,
        fingerprint: validFingerprint
      )
    }
    let staleFingerprint = fixture.fingerprint(
      kind: .abort,
      fence: live.attempt.fence - 1,
      attemptID: live.attempt.attemptID
    )
    #expect(throws: BrokerStateError.staleFence) {
      _ = try live.machine.abortProposal(
        connectionID: fixture.connectionID,
        attemptID: live.attempt.attemptID,
        operationID: fixture.commitOperationID,
        fingerprint: staleFingerprint
      )
    }
    #expect(throws: BrokerStateError.connectionNotFound) {
      _ = try live.machine.abortProposal(
        connectionID: authorityJournalUUID(99),
        attemptID: live.attempt.attemptID,
        operationID: fixture.commitOperationID,
        fingerprint: validFingerprint
      )
    }
    let proposal = try live.machine.abortProposal(
      connectionID: fixture.connectionID,
      attemptID: live.attempt.attemptID,
      operationID: fixture.commitOperationID,
      fingerprint: validFingerprint
    )
    #expect(
      try live.machine.reserveJournalAbort(
        proposal: proposal,
        changedAt: fixture.authorityTime
      ).connectionID == fixture.connectionID
    )

    let tombstoneRecord = try BrokerJournalRecordAdapter.makeTombstoned(
      predecessor: BrokerJournalRecordAdapter.makeDisconnectFenced(
        predecessor: fixture.vacantRecord(),
        operationID: fixture.otherOperationID,
        capturedAt: fixture.authorityTime
      ),
      changedAt: fixture.finalTime
    )
    let tombstoned = try fixture.stableMachine(record: tombstoneRecord)
    let tombstoneFingerprint = fixture.fingerprint(
      kind: .abort,
      fence: tombstoneRecord.fence,
      attemptID: fixture.attemptID
    )
    #expect(throws: BrokerStateError.connectionTombstoned) {
      _ = try tombstoned.abortProposal(
        connectionID: fixture.connectionID,
        attemptID: fixture.attemptID,
        operationID: fixture.commitOperationID,
        fingerprint: tombstoneFingerprint
      )
    }
  }

  @Test
  func retainedOperationIdentityCollisionIsRejectedWithoutInstallingReservation() throws {
    let fixture = try AuthorityJournalMachineFixture()
    let collision = BrokerJournalTerminalOperation.stageFailure(
      BrokerJournalStageFailureTerminal(
        operationID: fixture.commitOperationID,
        expectedFence: 0,
        error: .cancelled
      )
    )
    var machine = try fixture.stableMachine(
      record: fixture.readyRecord(terminalOperations: [collision])
    )
    let collisionFingerprint = fixture.fingerprint(
      kind: .disconnect,
      fence: 1,
      attemptID: nil
    )
    let collisionProposal = try machine.disconnectProposal(
      connectionID: fixture.connectionID,
      operationID: fixture.commitOperationID,
      fingerprint: collisionFingerprint
    )

    #expect(throws: BrokerJournalError.invalidRecord) {
      _ = try machine.reserveJournalDisconnect(
        proposal: collisionProposal,
        capturedAt: fixture.authorityTime
      )
    }
    let nextFingerprint = fixture.fingerprint(kind: .disconnect, fence: 1, attemptID: nil)
    #expect(
      try machine.reserveJournalDisconnect(
        proposal: machine.disconnectProposal(
          connectionID: fixture.connectionID,
          operationID: fixture.otherOperationID,
          fingerprint: nextFingerprint
        ),
        capturedAt: fixture.authorityTime
      ).connectionID == fixture.connectionID
    )
  }

  @Test
  func authorityReservationBlocksSameConnectionButIsolatesOtherConnections() throws {
    let fixture = try AuthorityJournalMachineFixture()
    let otherConnectionID = authorityJournalUUID(8)
    let firstRecord = try fixture.vacantRecord()
    let otherRecord = try BrokerJournalRecord(
      revision: 1,
      connectionID: otherConnectionID,
      fence: 0,
      lastGenerationOrdinal: 0,
      changedAt: fixture.stageTime,
      payload: .vacant(BrokerJournalVacantPayload())
    )
    var machine = try fixture.stableMachine(records: [firstRecord, otherRecord])
    let firstFingerprint = fixture.fingerprint(kind: .disconnect, fence: 0, attemptID: nil)
    _ = try machine.reserveJournalDisconnect(
      proposal: machine.disconnectProposal(
        connectionID: fixture.connectionID,
        operationID: fixture.commitOperationID,
        fingerprint: firstFingerprint
      ),
      capturedAt: fixture.authorityTime
    )
    #expect(throws: BrokerStateError.operationInProgress) {
      _ = try machine.preflight(
        connectionID: fixture.connectionID,
        operationID: fixture.otherOperationID,
        fingerprint: firstFingerprint
      )
    }

    let otherFingerprint = BrokerCredentialStateMachine.fingerprint(
      kind: .disconnect,
      connectionID: otherConnectionID,
      expectedFence: 0
    )
    #expect(
      try machine.reserveJournalDisconnect(
        proposal: machine.disconnectProposal(
          connectionID: otherConnectionID,
          operationID: fixture.otherOperationID,
          fingerprint: otherFingerprint
        ),
        capturedAt: fixture.authorityTime
      ).connectionID == otherConnectionID
    )
  }
}

private struct AuthorityJournalMachineFixture {
  let connectionID = authorityJournalUUID(1)
  let stageOperationID = authorityJournalUUID(2)
  let commitOperationID = authorityJournalUUID(3)
  let otherOperationID = authorityJournalUUID(4)
  let attemptID = authorityJournalUUID(5)
  let candidateID = authorityJournalUUID(6)
  let stageTime: JournalTimestamp
  let stagingTime: JournalTimestamp
  let authorityTime: JournalTimestamp
  let finalTime: JournalTimestamp

  init() throws {
    stageTime = try JournalTimestamp(canonicalText: "2026-07-13T02:00:00.000Z")
    stagingTime = try JournalTimestamp(canonicalText: "2026-07-13T02:00:01.000Z")
    authorityTime = try JournalTimestamp(canonicalText: "2026-07-13T02:00:02.000Z")
    finalTime = try JournalTimestamp(canonicalText: "2026-07-13T02:00:03.000Z")
  }

  var previousReadyKey: CredentialStoreKey {
    CredentialStoreKey(
      connectionID: connectionID,
      generationID: authorityJournalUUID(7),
      generationOrdinal: 1
    )
  }

  func liveStaging(
    previousReady: Bool
  ) throws -> (
    machine: BrokerCredentialStateMachine,
    attempt: StagingAttempt,
    snapshot: BrokerJournalSnapshot
  ) {
    let entries: [BrokerJournalPreparedEntry]
    if previousReady {
      let ready = try readyRecord()
      entries = [
        BrokerJournalPreparedEntry(
          snapshot: try snapshot(ready, tagByte: 0x01),
          plan: try BrokerJournalRecordAdapter.recoveryPlan(
            for: ready,
            recoveryChangedAt: ready.changedAt
          )
        )
      ]
    } else {
      entries = []
    }
    var machine = try BrokerCredentialStateMachine(preparedJournalEntries: entries)
    let expectedFence: UInt64 = previousReady ? 1 : 0
    let stageFingerprint = BrokerCredentialStateMachine.fingerprint(
      kind: .stage,
      connectionID: connectionID,
      expectedFence: expectedFence
    )
    let reservation = try machine.reserveJournalStage(
      proposal: machine.stageProposal(
        connectionID: connectionID,
        expectedFence: expectedFence
      ),
      operationID: stageOperationID,
      fingerprint: stageFingerprint,
      generationID: candidateID,
      attemptID: attemptID,
      capturedAt: stageTime
    )
    let pending = try snapshot(reservation.replacement, tagByte: 0x11)
    let storing = try machine.finishJournalStageReservation(
      reservation,
      result: .success(pending)
    )
    let transition = try machine.beginJournalStaging(storing, changedAt: stagingTime)
    let selected = try snapshot(transition.replacement, tagByte: 0x21)
    let attempt = try machine.finishJournalStaging(
      transition,
      result: .success(selected)
    )
    return (machine, attempt, selected)
  }

  func readyRecord(
    terminalOperations: [BrokerJournalTerminalOperation] = []
  ) throws -> BrokerJournalRecord {
    let ready = BrokerJournalReadyGeneration(
      generation: BrokerJournalCredentialGeneration(
        generationID: authorityJournalUUID(7),
        ordinal: 1,
        createdAt: stageTime
      ),
      committedAt: stageTime
    )
    return try BrokerJournalRecord(
      revision: 1,
      connectionID: connectionID,
      fence: 1,
      lastGenerationOrdinal: 1,
      changedAt: stageTime,
      payload: .ready(BrokerJournalReadyPayload(ready: ready)),
      terminalOperations: terminalOperations
    )
  }

  func vacantRecord() throws -> BrokerJournalRecord {
    try BrokerJournalRecord(
      revision: 1,
      connectionID: connectionID,
      fence: 0,
      lastGenerationOrdinal: 0,
      changedAt: stageTime,
      payload: .vacant(BrokerJournalVacantPayload())
    )
  }

  func stableMachine(record: BrokerJournalRecord) throws -> BrokerCredentialStateMachine {
    try stableMachine(records: [record])
  }

  func stableMachine(records: [BrokerJournalRecord]) throws -> BrokerCredentialStateMachine {
    try BrokerCredentialStateMachine(
      preparedJournalEntries: try records.map { record in
        BrokerJournalPreparedEntry(
          snapshot: try snapshot(record, tagByte: 0x02),
          plan: try BrokerJournalRecordAdapter.recoveryPlan(
            for: record,
            recoveryChangedAt: record.changedAt
          )
        )
      }
    )
  }

  func snapshot(
    _ record: BrokerJournalRecord,
    tagByte: UInt8
  ) throws -> BrokerJournalSnapshot {
    BrokerJournalSnapshot(
      record: record,
      authenticationTag: try JournalAuthenticationTag(
        bytes: Array(repeating: tagByte, count: 32)
      )
    )
  }

  func fingerprint(
    kind: BrokerCredentialStateMachine.OperationKind,
    fence: UInt64,
    attemptID: UUID?
  ) -> BrokerCredentialStateMachine.OperationFingerprint {
    BrokerCredentialStateMachine.fingerprint(
      kind: kind,
      connectionID: connectionID,
      expectedFence: fence,
      attemptID: attemptID
    )
  }
}

extension BrokerCredentialStateMachine.JournalAuthorityCompletion {
  fileprivate var isCompleted: Bool {
    if case .completed = self {
      return true
    }
    return false
  }
}

private func authorityJournalUUID(_ value: UInt64) -> UUID {
  UUID(
    uuidString: String(
      format: "00000000-0000-4000-8000-%012llx",
      value
    )
  )!
}
