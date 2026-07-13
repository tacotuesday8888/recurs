import Foundation
import Testing

@testable import RecursBrokerCore

@Suite("Broker credential state machine journal stage")
struct BrokerCredentialStateMachineStageJournalTests {
  @Test
  func proposalReservationAndResumeFingerprintBindTheExactProfile() throws {
    let fixture = try StageJournalMachineFixture()
    let ready = try fixture.readyEntry(connectionID: fixture.connectionID, seed: 9)
    var machine = try BrokerCredentialStateMachine(preparedJournalEntries: [ready])

    #expect(throws: BrokerStateError.invalidTransition) {
      _ = try machine.stageProposal(
        connectionID: fixture.connectionID,
        expectedFence: 1,
        providerBinding: .anthropic
      )
    }

    let proposal = try machine.stageProposal(
      connectionID: fixture.connectionID,
      expectedFence: 1,
      providerBinding: .openAI
    )
    let unbound = BrokerCredentialStateMachine.fingerprint(
      kind: .stage,
      connectionID: fixture.connectionID,
      expectedFence: 1
    )
    #expect(throws: BrokerJournalError.casConflict) {
      _ = try machine.reserveJournalStage(
        proposal: proposal,
        operationID: fixture.operationID,
        fingerprint: unbound,
        generationID: fixture.candidateID,
        attemptID: fixture.attemptID,
        capturedAt: fixture.startedAt
      )
    }

    let bound = BrokerCredentialStateMachine.fingerprint(
      kind: .stage,
      connectionID: fixture.connectionID,
      expectedFence: 1,
      providerBinding: .openAI
    )
    _ = try machine.reserveJournalStage(
      proposal: proposal,
      operationID: fixture.operationID,
      fingerprint: bound,
      generationID: fixture.candidateID,
      attemptID: fixture.attemptID,
      capturedAt: fixture.startedAt
    )
    #expect(
      try machine.resumeStageFingerprint(
        connectionID: fixture.connectionID,
        operationID: fixture.operationID,
        expectedFence: 1
      ) == bound
    )
  }

  @Test
  func recoveredStageFailureHydratesItsAuthenticatedBinding() throws {
    let fixture = try StageJournalMachineFixture()
    let pending = try BrokerJournalRecordAdapter.makeStorePending(
      predecessor: nil,
      connectionID: fixture.connectionID,
      providerBinding: .openAI,
      attemptID: fixture.attemptID,
      operationID: fixture.operationID,
      candidateGenerationID: fixture.candidateID,
      capturedAt: fixture.startedAt
    )
    let failed = try BrokerJournalRecordAdapter.makeStableStoreFailure(
      predecessor: pending,
      changedAt: fixture.finishedAt
    )
    let snapshot = try fixture.snapshot(record: failed, tagByte: 8)
    let plan = try BrokerJournalRecordAdapter.recoveryPlan(
      for: failed,
      recoveryChangedAt: fixture.finishedAt
    )
    let machine = try BrokerCredentialStateMachine(
      preparedJournalEntries: [BrokerJournalPreparedEntry(snapshot: snapshot, plan: plan)]
    )

    let recovered = try machine.resumeStageFingerprint(
      connectionID: fixture.connectionID,
      operationID: fixture.operationID,
      expectedFence: 0
    )
    #expect(recovered.providerBinding == .openAI)
    #expect(
      try machine.preflight(
        connectionID: fixture.connectionID,
        operationID: fixture.operationID,
        fingerprint: recovered
      ) == .replay(.stage(.failure(.storeUnavailable)))
    )
    let changed = BrokerCredentialStateMachine.fingerprint(
      kind: .stage,
      connectionID: fixture.connectionID,
      expectedFence: 0,
      providerBinding: .anthropic
    )
    #expect(throws: BrokerStateError.operationIDConflict) {
      _ = try machine.preflight(
        connectionID: fixture.connectionID,
        operationID: fixture.operationID,
        fingerprint: changed
      )
    }
  }

  @Test
  func absentStageReservationProposesExactStorePendingWithoutConsumingAuthority() throws {
    let fixture = try StageJournalMachineFixture()
    var machine = try BrokerCredentialStateMachine(preparedJournalEntries: [])
    let proposal = try machine.stageProposal(
      connectionID: fixture.connectionID,
      expectedFence: 0,
      providerBinding: .openAI
    )
    let fingerprint = BrokerCredentialStateMachine.fingerprint(
      kind: .stage,
      connectionID: fixture.connectionID,
      expectedFence: 0,
      providerBinding: .openAI
    )

    let token = try machine.reserveJournalStage(
      proposal: proposal,
      operationID: fixture.operationID,
      fingerprint: fingerprint,
      generationID: fixture.candidateID,
      attemptID: fixture.attemptID,
      capturedAt: fixture.startedAt
    )

    #expect(token.connectionID == fixture.connectionID)
    #expect(token.expected == nil)
    #expect(token.replacement.revision == 1)
    #expect(token.replacement.connectionID == fixture.connectionID)
    #expect(token.replacement.providerBinding == .openAI)
    #expect(token.replacement.fence == 1)
    #expect(token.replacement.lastGenerationOrdinal == 1)
    guard case .storePending(let payload) = token.replacement.payload else {
      Issue.record("expected store-pending replacement")
      return
    }
    #expect(payload.operationID == fixture.operationID)
    #expect(payload.attemptID == fixture.attemptID)
    #expect(payload.expectedFence == 0)
    #expect(payload.candidate.generationID == fixture.candidateID)
    #expect(payload.candidate.ordinal == 1)
    #expect(payload.previousReady == nil)
    #expect(payload.startedAt == fixture.startedAt)
    #expect(machine.projection(for: fixture.connectionID) == nil)
    #expect(machine.journalSnapshot(for: fixture.connectionID) == nil)
    #expect(
      try machine.stageProposal(
        connectionID: fixture.connectionID,
        expectedFence: 0,
        providerBinding: .openAI
      ) == proposal
    )
  }

  @Test
  func readyStageReservationCarriesExactPredecessorAndBlocksOnlyItsConnection() throws {
    let fixture = try StageJournalMachineFixture()
    let readyEntry = try fixture.readyEntry(connectionID: fixture.connectionID, seed: 10)
    var machine = try BrokerCredentialStateMachine(preparedJournalEntries: [readyEntry])
    let proposal = try machine.stageProposal(
      connectionID: fixture.connectionID,
      expectedFence: 1,
      providerBinding: .openAI
    )
    let fingerprint = BrokerCredentialStateMachine.fingerprint(
      kind: .stage,
      connectionID: fixture.connectionID,
      expectedFence: 1,
      providerBinding: .openAI
    )

    let token = try machine.reserveJournalStage(
      proposal: proposal,
      operationID: fixture.operationID,
      fingerprint: fingerprint,
      generationID: fixture.candidateID,
      attemptID: fixture.attemptID,
      capturedAt: fixture.startedAt
    )

    #expect(token.expected == readyEntry.snapshot)
    #expect(token.replacement.revision == 2)
    guard case .storePending(let payload) = token.replacement.payload else {
      Issue.record("expected store-pending replacement")
      return
    }
    guard case .ready(let priorPayload) = readyEntry.snapshot.record.payload else {
      Issue.record("expected ready predecessor")
      return
    }
    #expect(payload.previousReady == priorPayload.ready)
    #expect(machine.projection(for: fixture.connectionID) == readyEntry.plan.projection)

    let competingFingerprint = BrokerCredentialStateMachine.fingerprint(
      kind: .stage,
      connectionID: fixture.connectionID,
      expectedFence: 1,
      providerBinding: .openAI
    )
    #expect(throws: BrokerStateError.operationInProgress) {
      _ = try machine.preflight(
        connectionID: fixture.connectionID,
        operationID: fixture.otherOperationID,
        fingerprint: competingFingerprint
      )
    }

    let otherProposal = try machine.stageProposal(
      connectionID: fixture.otherConnectionID,
      expectedFence: 0,
      providerBinding: .openAI
    )
    let otherToken = try machine.reserveJournalStage(
      proposal: otherProposal,
      operationID: fixture.otherOperationID,
      fingerprint: BrokerCredentialStateMachine.fingerprint(
        kind: .stage,
        connectionID: fixture.otherConnectionID,
        expectedFence: 0,
        providerBinding: .openAI
      ),
      generationID: fixture.otherCandidateID,
      attemptID: fixture.otherAttemptID,
      capturedAt: fixture.startedAt
    )
    #expect(otherToken.connectionID == fixture.otherConnectionID)
  }

  @Test
  func successfulStorePendingCASConsumesCountersAndEntersDurableStoring() throws {
    let fixture = try StageJournalMachineFixture()
    let readyEntry = try fixture.readyEntry(connectionID: fixture.connectionID, seed: 20)
    var machine = try BrokerCredentialStateMachine(preparedJournalEntries: [readyEntry])
    let fingerprint = BrokerCredentialStateMachine.fingerprint(
      kind: .stage,
      connectionID: fixture.connectionID,
      expectedFence: 1,
      providerBinding: .openAI
    )
    let reservation = try machine.reserveJournalStage(
      proposal: machine.stageProposal(
        connectionID: fixture.connectionID,
        expectedFence: 1,
        providerBinding: .openAI
      ),
      operationID: fixture.operationID,
      fingerprint: fingerprint,
      generationID: fixture.candidateID,
      attemptID: fixture.attemptID,
      capturedAt: fixture.startedAt
    )
    let selected = try fixture.snapshot(record: reservation.replacement, tagByte: 0x71)

    let storing = try machine.finishJournalStageReservation(
      reservation,
      result: .success(selected)
    )

    #expect(storing.connectionID == fixture.connectionID)
    #expect(storing.expected == selected)
    #expect(storing.attempt.attemptID == fixture.attemptID)
    #expect(storing.attempt.fence == 2)
    #expect(storing.attempt.candidate.ordinal == 2)
    #expect(storing.candidateKey.generationID == fixture.candidateID)
    #expect(machine.journalSnapshot(for: fixture.connectionID) == selected)
    guard case .ready(let fallback) = machine.projection(for: fixture.connectionID) else {
      Issue.record("expected consumed-fence ready fallback")
      return
    }
    #expect(fallback.fence == 2)
    #expect(fallback.lastGenerationOrdinal == 2)
    #expect(fallback.ready == storing.attempt.previousReady)
    #expect(throws: BrokerStateError.operationInProgress) {
      _ = try machine.preflight(
        connectionID: fixture.connectionID,
        operationID: fixture.otherOperationID,
        fingerprint: fingerprint
      )
    }
  }

  @Test
  func failedStorePendingCASClearsReservationWithoutConsumingCounters() throws {
    let fixture = try StageJournalMachineFixture()
    var machine = try BrokerCredentialStateMachine(preparedJournalEntries: [])
    let fingerprint = BrokerCredentialStateMachine.fingerprint(
      kind: .stage,
      connectionID: fixture.connectionID,
      expectedFence: 0,
      providerBinding: .openAI
    )
    let reservation = try machine.reserveJournalStage(
      proposal: machine.stageProposal(
        connectionID: fixture.connectionID,
        expectedFence: 0,
        providerBinding: .openAI
      ),
      operationID: fixture.operationID,
      fingerprint: fingerprint,
      generationID: fixture.candidateID,
      attemptID: fixture.attemptID,
      capturedAt: fixture.startedAt
    )

    #expect(throws: BrokerJournalError.storageUnavailable) {
      _ = try machine.finishJournalStageReservation(
        reservation,
        result: .failure(.storageUnavailable)
      )
    }

    #expect(machine.projection(for: fixture.connectionID) == nil)
    #expect(machine.journalSnapshot(for: fixture.connectionID) == nil)
    #expect(
      try machine.preflight(
        connectionID: fixture.connectionID,
        operationID: fixture.operationID,
        fingerprint: fingerprint
      ) == .proceed
    )
    #expect(
      try machine.stageProposal(
        connectionID: fixture.connectionID,
        expectedFence: 0,
        providerBinding: .openAI
      ).nextOrdinal == 1
    )
  }

  @Test
  func stagingIsPublishedAndVolatileMemoizedOnlyAfterItsExactJournalCAS() throws {
    let fixture = try StageJournalMachineFixture()
    var prepared = try fixture.storingMachine(fromReady: true)

    let transition = try prepared.machine.beginJournalStaging(
      prepared.storing,
      changedAt: fixture.finishedAt
    )

    #expect(transition.expected == prepared.storing.expected)
    #expect(transition.replacement.phase == .staging)
    #expect(
      prepared.machine.journalSnapshot(for: fixture.connectionID) == prepared.storing.expected)
    #expect(
      prepared.machine.projection(for: fixture.connectionID) != .staging(prepared.storing.attempt))

    let selected = try fixture.snapshot(record: transition.replacement, tagByte: 0x72)
    let attempt = try prepared.machine.finishJournalStaging(
      transition,
      result: .success(selected)
    )

    #expect(attempt == prepared.storing.attempt)
    #expect(prepared.machine.journalSnapshot(for: fixture.connectionID) == selected)
    #expect(prepared.machine.projection(for: fixture.connectionID) == .staging(attempt))
    #expect(
      try prepared.machine.preflight(
        connectionID: fixture.connectionID,
        operationID: fixture.operationID,
        fingerprint: prepared.fingerprint
      ) == .replay(.stage(.success(attempt)))
    )
  }

  @Test
  func stableStoreFailureIsMemoizedOnlyAfterItsExactJournalCAS() throws {
    let fixture = try StageJournalMachineFixture()
    var prepared = try fixture.storingMachine(fromReady: false)
    let first = try prepared.machine.beginJournalStableStoreFailure(
      prepared.storing,
      changedAt: fixture.finishedAt
    )

    #expect(throws: BrokerJournalError.storageUnavailable) {
      _ = try prepared.machine.finishJournalStableStoreFailure(
        first,
        result: .failure(.storageUnavailable)
      )
    }
    #expect(
      prepared.machine.journalSnapshot(for: fixture.connectionID) == prepared.storing.expected)
    #expect(throws: BrokerStateError.operationInProgress) {
      _ = try prepared.machine.preflight(
        connectionID: fixture.connectionID,
        operationID: fixture.otherOperationID,
        fingerprint: prepared.fingerprint
      )
    }

    let retry = try prepared.machine.beginJournalStableStoreFailure(
      prepared.storing,
      changedAt: fixture.finishedAt
    )
    let selected = try fixture.snapshot(record: retry.replacement, tagByte: 0x73)
    let outcome = try prepared.machine.finishJournalStableStoreFailure(
      retry,
      result: .success(selected)
    )

    #expect(outcome == .stage(.failure(.storeUnavailable)))
    #expect(prepared.machine.journalSnapshot(for: fixture.connectionID) == selected)
    #expect(prepared.machine.projection(for: fixture.connectionID) == nil)
    #expect(
      try prepared.machine.preflight(
        connectionID: fixture.connectionID,
        operationID: fixture.operationID,
        fingerprint: prepared.fingerprint
      ) == .replay(outcome)
    )
  }

  @Test(arguments: [BrokerStateError.cancelled, .storeUnavailable])
  func durableStageCleanupInstallsExactExistingCleanupContext(
    terminalError: BrokerStateError
  ) throws {
    let fixture = try StageJournalMachineFixture()
    var prepared = try fixture.storingMachine(fromReady: true)
    let transition = try prepared.machine.beginJournalStageCleanup(
      prepared.storing,
      terminalError: terminalError,
      changedAt: fixture.finishedAt
    )
    guard case .stageCleanupPending(let payload) = transition.replacement.payload else {
      Issue.record("expected durable stage cleanup")
      return
    }
    #expect(payload.candidate.generationID == fixture.candidateID)
    #expect(payload.error == (terminalError == .cancelled ? .cancelled : .storeUnavailable))

    let selected = try fixture.snapshot(record: transition.replacement, tagByte: 0x74)
    try prepared.machine.finishJournalStageCleanup(
      transition,
      result: .success(selected)
    )

    #expect(prepared.machine.journalSnapshot(for: fixture.connectionID) == selected)
    #expect(
      try prepared.machine.preflight(
        connectionID: fixture.connectionID,
        operationID: fixture.operationID,
        fingerprint: prepared.fingerprint
      ) == .resumeCleanup
    )
    #expect(throws: BrokerStateError.cleanupPending) {
      _ = try prepared.machine.preflight(
        connectionID: fixture.connectionID,
        operationID: fixture.otherOperationID,
        fingerprint: prepared.fingerprint
      )
    }
    guard
      case .delete(let key, _) = try prepared.machine.beginJournalCleanup(
        connectionID: fixture.connectionID
      )
    else {
      Issue.record("expected candidate cleanup")
      return
    }
    #expect(key == prepared.storing.candidateKey)
  }

  @Test
  func transitionRejectsAnInexactSelectedRecordAndLeavesDurableStoringRetryable() throws {
    let fixture = try StageJournalMachineFixture()
    var prepared = try fixture.storingMachine(fromReady: false)
    let transition = try prepared.machine.beginJournalStaging(
      prepared.storing,
      changedAt: fixture.finishedAt
    )

    #expect(throws: BrokerJournalError.casConflict) {
      _ = try prepared.machine.finishJournalStaging(
        transition,
        result: .success(prepared.storing.expected)
      )
    }
    #expect(
      prepared.machine.journalSnapshot(for: fixture.connectionID) == prepared.storing.expected)
    #expect(prepared.machine.projection(for: fixture.connectionID) == nil)

    let retry = try prepared.machine.beginJournalStaging(
      prepared.storing,
      changedAt: fixture.finishedAt
    )
    #expect(retry.replacement == transition.replacement)
  }

  @Test
  func failedStableResolutionRetainsExactIntentForNormalStageResume() throws {
    let fixture = try StageJournalMachineFixture()
    var prepared = try fixture.storingMachine(fromReady: false)
    let transition = try prepared.machine.beginJournalStableStoreFailure(
      prepared.storing,
      changedAt: fixture.finishedAt
    )

    try prepared.machine.pauseJournalStageTransition(transition)

    #expect(
      try prepared.machine.preflight(
        connectionID: fixture.connectionID,
        operationID: fixture.operationID,
        fingerprint: prepared.fingerprint
      ) == .resumeStageResolution
    )
    #expect(throws: BrokerStateError.cleanupPending) {
      _ = try prepared.machine.preflight(
        connectionID: fixture.connectionID,
        operationID: fixture.otherOperationID,
        fingerprint: prepared.fingerprint
      )
    }

    let resolution = try prepared.machine.beginJournalStageResolution(
      connectionID: fixture.connectionID,
      operationID: fixture.operationID,
      fingerprint: prepared.fingerprint
    )
    #expect(resolution.expected == prepared.storing.expected)
    #expect(resolution.replacement == transition.replacement)
    #expect(
      try prepared.machine.classifyJournalStageResolutionSelection(
        resolution,
        selected: prepared.storing.expected
      ) == .expected
    )
    let selected = try fixture.snapshot(record: resolution.replacement, tagByte: 0x75)
    #expect(
      try prepared.machine.finishJournalStageResolution(
        resolution,
        result: .success(selected)
      ) == .terminal(.stage(.failure(.storeUnavailable)))
    )
  }

  @Test
  func failedStagingCASBecomesAnExactStoreUnavailableCleanupResolution() throws {
    let fixture = try StageJournalMachineFixture()
    var prepared = try fixture.storingMachine(fromReady: true)
    let staging = try prepared.machine.beginJournalStaging(
      prepared.storing,
      changedAt: fixture.finishedAt
    )
    let cleanupTime = try JournalTimestamp(canonicalText: "2026-07-13T00:00:02.000Z")

    try prepared.machine.prepareJournalStageCleanupAfterStaging(
      staging,
      selectedStaging: nil,
      terminalError: .storeUnavailable,
      changedAt: cleanupTime
    )

    let resolution = try prepared.machine.beginJournalStageResolution(
      connectionID: fixture.connectionID,
      operationID: fixture.operationID,
      fingerprint: prepared.fingerprint
    )
    #expect(resolution.expected == prepared.storing.expected)
    guard case .stageCleanupPending(let payload) = resolution.replacement.payload else {
      Issue.record("expected cleanup resolution")
      return
    }
    #expect(payload.error == .storeUnavailable)
    #expect(payload.candidate.generationID == fixture.candidateID)
  }
}

private struct StageJournalMachineFixture {
  let connectionID = UUID(uuidString: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")!
  let operationID = UUID(uuidString: "00000000-0000-4000-8000-000000000001")!
  let otherOperationID = UUID(uuidString: "00000000-0000-4000-8000-000000000011")!
  let attemptID = UUID(uuidString: "00000000-0000-4000-8000-000000000002")!
  let otherAttemptID = UUID(uuidString: "00000000-0000-4000-8000-000000000012")!
  let candidateID = UUID(uuidString: "00000000-0000-4000-8000-000000000003")!
  let otherCandidateID = UUID(uuidString: "00000000-0000-4000-8000-000000000013")!
  let otherConnectionID = UUID(uuidString: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff")!
  let startedAt: JournalTimestamp
  let finishedAt: JournalTimestamp

  init() throws {
    startedAt = try JournalTimestamp(canonicalText: "2026-07-13T00:00:00.000Z")
    finishedAt = try JournalTimestamp(canonicalText: "2026-07-13T00:00:01.000Z")
  }

  func readyEntry(
    connectionID: UUID,
    seed: UInt8
  ) throws -> BrokerJournalPreparedEntry {
    let generation = BrokerJournalCredentialGeneration(
      generationID: UUID(uuidString: "00000000-0000-4000-8000-000000000010")!,
      ordinal: 1,
      createdAt: startedAt
    )
    let ready = BrokerJournalReadyGeneration(generation: generation, committedAt: startedAt)
    let record = try BrokerJournalRecord(
      revision: 1,
      connectionID: connectionID,
      providerBinding: .openAI,
      fence: 1,
      lastGenerationOrdinal: 1,
      changedAt: startedAt,
      payload: .ready(BrokerJournalReadyPayload(ready: ready))
    )
    let snapshot = try snapshot(record: record, tagByte: seed)
    let plan = try BrokerJournalRecordAdapter.recoveryPlan(
      for: record,
      recoveryChangedAt: startedAt
    )
    return BrokerJournalPreparedEntry(snapshot: snapshot, plan: plan)
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

  func storingMachine(
    fromReady: Bool
  ) throws -> (
    machine: BrokerCredentialStateMachine,
    storing: BrokerCredentialStateMachine.JournalStageStoreToken,
    fingerprint: BrokerCredentialStateMachine.OperationFingerprint
  ) {
    let entries = fromReady ? [try readyEntry(connectionID: connectionID, seed: 0x60)] : []
    var machine = try BrokerCredentialStateMachine(preparedJournalEntries: entries)
    let expectedFence: UInt64 = fromReady ? 1 : 0
    let fingerprint = BrokerCredentialStateMachine.fingerprint(
      kind: .stage,
      connectionID: connectionID,
      expectedFence: expectedFence,
      providerBinding: .openAI
    )
    let reservation = try machine.reserveJournalStage(
      proposal: machine.stageProposal(
        connectionID: connectionID,
        expectedFence: expectedFence,
        providerBinding: .openAI
      ),
      operationID: operationID,
      fingerprint: fingerprint,
      generationID: candidateID,
      attemptID: attemptID,
      capturedAt: startedAt
    )
    let selected = try snapshot(record: reservation.replacement, tagByte: 0x61)
    let storing = try machine.finishJournalStageReservation(
      reservation,
      result: .success(selected)
    )
    return (machine, storing, fingerprint)
  }
}
