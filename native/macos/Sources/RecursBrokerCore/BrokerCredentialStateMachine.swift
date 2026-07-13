import Foundation

struct BrokerCredentialStateMachine: Sendable {
  enum Record: Sendable, Equatable {
    case vacant(connectionID: UUID, fence: UInt64, lastGenerationOrdinal: UInt64)
    case ready(ReadyProjection)
    case staging(StagingAttempt)
    case tombstoned(TombstoneProjection)

    var fence: UInt64 {
      switch self {
      case .vacant(_, let fence, _):
        fence
      case .ready(let projection):
        projection.fence
      case .staging(let attempt):
        attempt.fence
      case .tombstoned(let projection):
        projection.fence
      }
    }

    var lastGenerationOrdinal: UInt64 {
      switch self {
      case .vacant(_, _, let ordinal):
        ordinal
      case .ready(let projection):
        projection.lastGenerationOrdinal
      case .staging(let attempt):
        attempt.candidate.ordinal
      case .tombstoned(let projection):
        projection.lastGenerationOrdinal
      }
    }

    var projection: CredentialProjection? {
      switch self {
      case .vacant:
        nil
      case .ready(let projection):
        .ready(projection)
      case .staging(let attempt):
        .staging(attempt)
      case .tombstoned(let projection):
        .tombstoned(projection)
      }
    }
  }

  enum OperationKind: Sendable, Equatable {
    case stage
    case commit
    case abort
    case disconnect
  }

  struct OperationFingerprint: Sendable, Equatable {
    let kind: OperationKind
    let connectionID: UUID
    let expectedFence: UInt64
    let attemptID: UUID?
  }

  enum TerminalOutcome: Sendable, Equatable {
    case stage(Result<StagingAttempt, BrokerStateError>)
    case commit(Result<ReadyProjection, BrokerStateError>)
    case abort(Result<ReadyProjection?, BrokerStateError>)
    case disconnect(Result<TombstoneProjection, BrokerStateError>)
  }

  enum PreflightDisposition: Sendable, Equatable {
    case proceed
    case replay(TerminalOutcome)
    case resumeCleanup
  }

  enum FinalizationDisposition<Value: Sendable>: Sendable {
    case completed(Value)
    case cleanup(Value)
  }

  struct StageProposal: Sendable, Equatable {
    let connectionID: UUID
    let current: Record?
    let nextFence: UInt64
    let nextOrdinal: UInt64
    let previousReady: ReadyGeneration?
  }

  struct StageReservationToken: Sendable, Equatable {
    let connectionID: UUID
    let reservation: Reservation
    let fallback: Record

    var attempt: StagingAttempt {
      guard case .storing(let context) = reservation.phase else {
        preconditionFailure("A stage token must retain its storing reservation.")
      }
      return context.attempt
    }

    var candidateKey: CredentialStoreKey {
      guard case .storing(let context) = reservation.phase else {
        preconditionFailure("A stage token must retain its storing reservation.")
      }
      return context.candidateKey
    }
  }

  struct CommitProposal: Sendable, Equatable {
    let connectionID: UUID
    let operationID: UUID
    let fingerprint: OperationFingerprint
    let record: Record
    let attempt: StagingAttempt
  }

  struct DisconnectProposal: Sendable, Equatable {
    let connectionID: UUID
    let operationID: UUID
    let fingerprint: OperationFingerprint
    let record: Record
    let keys: [CredentialStoreKey]
  }

  enum CleanupStep: Sendable, Equatable {
    case completed(TerminalOutcome)
    case delete(CredentialStoreKey, CleanupAwaitToken)
  }

  struct CleanupAwaitToken: Sendable, Equatable {
    let connectionID: UUID
    let reservation: Reservation
    let linearizedRecord: Record
  }

  private struct TerminalEntry: Sendable, Equatable {
    let fingerprint: OperationFingerprint
    let outcome: TerminalOutcome
  }

  private struct TerminalMemo: Sendable {
    var entries: [UUID: TerminalEntry] = [:]
    var order: [UUID] = []

    mutating func insert(
      operationID: UUID,
      fingerprint: OperationFingerprint,
      outcome: TerminalOutcome
    ) {
      guard entries[operationID] == nil else {
        return
      }
      entries[operationID] = TerminalEntry(fingerprint: fingerprint, outcome: outcome)
      order.append(operationID)
      if order.count > 64 {
        let evicted = order.removeFirst()
        entries.removeValue(forKey: evicted)
      }
    }
  }

  struct StageContext: Sendable, Equatable {
    let attempt: StagingAttempt
    let candidateKey: CredentialStoreKey
    let fallback: Record
  }

  struct CleanupContext: Sendable, Equatable {
    let terminalOutcome: TerminalOutcome
    let linearizedRecord: Record
    var remainingKeys: [CredentialStoreKey]
    var isAwaiting: Bool
  }

  enum ReservationPhase: Sendable, Equatable {
    case storing(StageContext)
    case cleanup(CleanupContext)
  }

  struct Reservation: Sendable, Equatable {
    let operationID: UUID
    let fingerprint: OperationFingerprint
    var phase: ReservationPhase
  }

  private enum MemoDisposition {
    case none
    case conflict
    case replay(TerminalOutcome)
  }

  private enum ReservationDisposition {
    case none
    case resumeCleanup
    case reject(BrokerStateError)
  }

  private var records: [UUID: Record]
  private var reservations: [UUID: Reservation] = [:]
  private var terminalMemos: [UUID: TerminalMemo] = [:]

  init(bootstrap: [CredentialBootstrap] = []) throws(BrokerStateError) {
    var validated: [UUID: Record] = [:]
    validated.reserveCapacity(bootstrap.count)

    for value in bootstrap {
      let connectionID: UUID
      let record: Record
      switch value {
      case .vacant(let id, let fence, let lastOrdinal):
        guard fence == lastOrdinal, fence < UInt64.max else {
          throw .invalidBootstrap
        }
        connectionID = id
        record = .vacant(
          connectionID: id,
          fence: fence,
          lastGenerationOrdinal: lastOrdinal
        )

      case .ready(let projection):
        guard
          projection.fence == projection.lastGenerationOrdinal,
          projection.fence < UInt64.max,
          projection.ready.generation.ordinal > 0,
          projection.ready.generation.ordinal <= projection.lastGenerationOrdinal,
          projection.ready.generation.createdAt.timeIntervalSinceReferenceDate.isFinite,
          projection.ready.committedAt.timeIntervalSinceReferenceDate.isFinite
        else {
          throw .invalidBootstrap
        }
        connectionID = projection.connectionID
        record = .ready(projection)

      case .tombstoned(let projection):
        guard
          projection.lastGenerationOrdinal < UInt64.max,
          projection.fence == projection.lastGenerationOrdinal + 1,
          projection.tombstonedAt.timeIntervalSinceReferenceDate.isFinite
        else {
          throw .invalidBootstrap
        }
        connectionID = projection.connectionID
        record = .tombstoned(projection)
      }

      guard validated.updateValue(record, forKey: connectionID) == nil else {
        throw .invalidBootstrap
      }
    }

    records = validated
  }

  func projection(for connectionID: UUID) -> CredentialProjection? {
    records[connectionID]?.projection
  }

  static func fingerprint(
    kind: OperationKind,
    connectionID: UUID,
    expectedFence: UInt64,
    attemptID: UUID? = nil
  ) -> OperationFingerprint {
    OperationFingerprint(
      kind: kind,
      connectionID: connectionID,
      expectedFence: expectedFence,
      attemptID: attemptID
    )
  }

  func preflight(
    connectionID: UUID,
    operationID: UUID,
    fingerprint: OperationFingerprint
  ) throws(BrokerStateError) -> PreflightDisposition {
    switch memoDisposition(
      connectionID: connectionID,
      operationID: operationID,
      fingerprint: fingerprint
    ) {
    case .conflict:
      throw .operationIDConflict
    case .replay(let outcome):
      return .replay(outcome)
    case .none:
      break
    }

    switch reservationDisposition(
      connectionID: connectionID,
      operationID: operationID,
      fingerprint: fingerprint
    ) {
    case .reject(let error):
      throw error
    case .resumeCleanup:
      return .resumeCleanup
    case .none:
      return .proceed
    }
  }

  func stageProposal(
    connectionID: UUID,
    expectedFence: UInt64
  ) throws(BrokerStateError) -> StageProposal {
    let current = records[connectionID]
    if case .tombstoned? = current {
      throw .connectionTombstoned
    }

    let currentFence = current?.fence ?? 0
    guard expectedFence == currentFence else {
      throw .staleFence
    }
    if case .staging? = current {
      throw .invalidTransition
    }

    let lastOrdinal = current?.lastGenerationOrdinal ?? 0
    guard currentFence <= UInt64.max - 2 else {
      throw .fenceOverflow
    }
    guard lastOrdinal < UInt64.max else {
      throw .generationOverflow
    }

    let previousReady: ReadyGeneration?
    switch current {
    case .ready(let projection):
      previousReady = projection.ready
    case .vacant, .none:
      previousReady = nil
    case .staging, .tombstoned:
      throw .invalidTransition
    }

    return StageProposal(
      connectionID: connectionID,
      current: current,
      nextFence: currentFence + 1,
      nextOrdinal: lastOrdinal + 1,
      previousReady: previousReady
    )
  }

  mutating func reserveStage(
    proposal: StageProposal,
    operationID: UUID,
    fingerprint: OperationFingerprint,
    generationID: UUID,
    createdAt: Date,
    attemptID: UUID,
    startedAt: Date
  ) throws(BrokerStateError) -> StageReservationToken {
    guard
      records[proposal.connectionID] == proposal.current,
      reservations[proposal.connectionID] == nil
    else {
      throw .operationInProgress
    }

    let candidate = CredentialGeneration(
      generationID: generationID,
      ordinal: proposal.nextOrdinal,
      createdAt: createdAt
    )
    let attempt = StagingAttempt(
      connectionID: proposal.connectionID,
      attemptID: attemptID,
      fence: proposal.nextFence,
      candidate: candidate,
      previousReady: proposal.previousReady,
      startedAt: startedAt
    )
    let fallback: Record
    if let previousReady = proposal.previousReady {
      fallback = .ready(
        ReadyProjection(
          connectionID: proposal.connectionID,
          fence: proposal.nextFence,
          ready: previousReady,
          lastGenerationOrdinal: proposal.nextOrdinal
        )
      )
    } else {
      fallback = .vacant(
        connectionID: proposal.connectionID,
        fence: proposal.nextFence,
        lastGenerationOrdinal: proposal.nextOrdinal
      )
    }
    let candidateKey = Self.key(for: proposal.connectionID, generation: candidate)
    let context = StageContext(
      attempt: attempt,
      candidateKey: candidateKey,
      fallback: fallback
    )
    let reservation = Reservation(
      operationID: operationID,
      fingerprint: fingerprint,
      phase: .storing(context)
    )
    records[proposal.connectionID] = fallback
    reservations[proposal.connectionID] = reservation
    return StageReservationToken(
      connectionID: proposal.connectionID,
      reservation: reservation,
      fallback: fallback
    )
  }

  mutating func cancelStageBeforeStore(
    _ token: StageReservationToken
  ) throws(BrokerStateError) -> TerminalOutcome {
    try validateStageReservation(token)
    reservations.removeValue(forKey: token.connectionID)
    let outcome = TerminalOutcome.stage(.failure(.cancelled))
    memoize(token: token, outcome: outcome)
    return outcome
  }

  mutating func finishStageStoreUnavailable(
    _ token: StageReservationToken
  ) throws(BrokerStateError) -> TerminalOutcome {
    try validateStageReservation(token)
    reservations.removeValue(forKey: token.connectionID)
    let outcome = TerminalOutcome.stage(.failure(.storeUnavailable))
    memoize(token: token, outcome: outcome)
    return outcome
  }

  mutating func enterStageCleanup(
    _ token: StageReservationToken,
    terminalError: BrokerStateError
  ) throws(BrokerStateError) {
    try validateStageReservation(token)
    let outcome = TerminalOutcome.stage(.failure(terminalError))
    reservations[token.connectionID] = cleanupReservation(
      operationID: token.reservation.operationID,
      fingerprint: token.reservation.fingerprint,
      outcome: outcome,
      linearizedRecord: token.fallback,
      keys: [token.candidateKey]
    )
  }

  mutating func publishStaging(
    _ token: StageReservationToken
  ) throws(BrokerStateError) -> StagingAttempt {
    try validateStageReservation(token)
    let attempt = token.attempt
    records[token.connectionID] = .staging(attempt)
    reservations.removeValue(forKey: token.connectionID)
    memoize(token: token, outcome: .stage(.success(attempt)))
    return attempt
  }

  func validateResumeStage(
    connectionID: UUID,
    expectedFence: UInt64
  ) throws(BrokerStateError) -> Never {
    guard let current = records[connectionID] else {
      throw .connectionNotFound
    }
    if case .tombstoned = current {
      throw .connectionTombstoned
    }
    guard current.fence == expectedFence else {
      throw .staleFence
    }
    throw .attemptNotCurrent
  }

  func commitProposal(
    connectionID: UUID,
    attemptID: UUID,
    operationID: UUID,
    fingerprint: OperationFingerprint
  ) throws(BrokerStateError) -> CommitProposal {
    let current = try currentMutableRecord(
      connectionID: connectionID,
      expectedFence: fingerprint.expectedFence
    )
    guard case .staging(let attempt) = current, attempt.attemptID == attemptID else {
      throw .attemptNotCurrent
    }
    return CommitProposal(
      connectionID: connectionID,
      operationID: operationID,
      fingerprint: fingerprint,
      record: current,
      attempt: attempt
    )
  }

  mutating func linearizeCommit(
    proposal: CommitProposal,
    committedAt: Date
  ) throws(BrokerStateError) -> FinalizationDisposition<ReadyProjection> {
    guard
      records[proposal.connectionID] == proposal.record,
      reservations[proposal.connectionID] == nil
    else {
      throw .operationInProgress
    }

    let attempt = proposal.attempt
    let ready = ReadyProjection(
      connectionID: proposal.connectionID,
      fence: attempt.fence,
      ready: ReadyGeneration(generation: attempt.candidate, committedAt: committedAt),
      lastGenerationOrdinal: attempt.candidate.ordinal
    )
    records[proposal.connectionID] = .ready(ready)
    let outcome = TerminalOutcome.commit(.success(ready))
    guard let previous = attempt.previousReady else {
      memoize(
        connectionID: proposal.connectionID,
        operationID: proposal.operationID,
        fingerprint: proposal.fingerprint,
        outcome: outcome
      )
      return .completed(ready)
    }

    reservations[proposal.connectionID] = cleanupReservation(
      operationID: proposal.operationID,
      fingerprint: proposal.fingerprint,
      outcome: outcome,
      linearizedRecord: .ready(ready),
      keys: [Self.key(for: proposal.connectionID, generation: previous.generation)]
    )
    return .cleanup(ready)
  }

  mutating func linearizeAbort(
    connectionID: UUID,
    attemptID: UUID,
    operationID: UUID,
    fingerprint: OperationFingerprint
  ) throws(BrokerStateError) -> ReadyProjection? {
    let current = try currentMutableRecord(
      connectionID: connectionID,
      expectedFence: fingerprint.expectedFence
    )
    guard case .staging(let attempt) = current, attempt.attemptID == attemptID else {
      throw .attemptNotCurrent
    }

    let restored: ReadyProjection?
    let restoredRecord: Record
    if let previous = attempt.previousReady {
      let ready = ReadyProjection(
        connectionID: connectionID,
        fence: attempt.fence,
        ready: previous,
        lastGenerationOrdinal: attempt.candidate.ordinal
      )
      restoredRecord = .ready(ready)
      restored = ready
    } else {
      restoredRecord = .vacant(
        connectionID: connectionID,
        fence: attempt.fence,
        lastGenerationOrdinal: attempt.candidate.ordinal
      )
      restored = nil
    }
    records[connectionID] = restoredRecord
    reservations[connectionID] = cleanupReservation(
      operationID: operationID,
      fingerprint: fingerprint,
      outcome: .abort(.success(restored)),
      linearizedRecord: restoredRecord,
      keys: [Self.key(for: connectionID, generation: attempt.candidate)]
    )
    return restored
  }

  func disconnectProposal(
    connectionID: UUID,
    operationID: UUID,
    fingerprint: OperationFingerprint
  ) throws(BrokerStateError) -> DisconnectProposal {
    let current = try currentMutableRecord(
      connectionID: connectionID,
      expectedFence: fingerprint.expectedFence
    )
    guard current.fence < UInt64.max else {
      throw .fenceOverflow
    }

    var keys: [CredentialStoreKey] = []
    switch current {
    case .staging(let attempt):
      keys.append(Self.key(for: connectionID, generation: attempt.candidate))
      if let previous = attempt.previousReady {
        keys.append(Self.key(for: connectionID, generation: previous.generation))
      }
    case .ready(let projection):
      keys.append(Self.key(for: connectionID, generation: projection.ready.generation))
    case .vacant:
      break
    case .tombstoned:
      throw .connectionTombstoned
    }
    keys.sort { $0.generationOrdinal > $1.generationOrdinal }
    return DisconnectProposal(
      connectionID: connectionID,
      operationID: operationID,
      fingerprint: fingerprint,
      record: current,
      keys: keys
    )
  }

  mutating func linearizeDisconnect(
    proposal: DisconnectProposal,
    tombstonedAt: Date
  ) throws(BrokerStateError) -> FinalizationDisposition<TombstoneProjection> {
    guard
      records[proposal.connectionID] == proposal.record,
      reservations[proposal.connectionID] == nil
    else {
      throw .operationInProgress
    }

    let tombstone = TombstoneProjection(
      connectionID: proposal.connectionID,
      fence: proposal.record.fence + 1,
      lastGenerationOrdinal: proposal.record.lastGenerationOrdinal,
      tombstonedAt: tombstonedAt
    )
    records[proposal.connectionID] = .tombstoned(tombstone)
    let outcome = TerminalOutcome.disconnect(.success(tombstone))
    guard !proposal.keys.isEmpty else {
      memoize(
        connectionID: proposal.connectionID,
        operationID: proposal.operationID,
        fingerprint: proposal.fingerprint,
        outcome: outcome
      )
      return .completed(tombstone)
    }

    reservations[proposal.connectionID] = cleanupReservation(
      operationID: proposal.operationID,
      fingerprint: proposal.fingerprint,
      outcome: outcome,
      linearizedRecord: .tombstoned(tombstone),
      keys: proposal.keys
    )
    return .cleanup(tombstone)
  }

  mutating func beginCleanup(
    connectionID: UUID,
    operationID: UUID,
    fingerprint: OperationFingerprint
  ) throws(BrokerStateError) -> CleanupStep {
    guard
      var reservation = reservations[connectionID],
      reservation.operationID == operationID,
      reservation.fingerprint == fingerprint,
      case .cleanup(var cleanup) = reservation.phase,
      records[connectionID] == cleanup.linearizedRecord,
      !cleanup.isAwaiting
    else {
      throw .operationInProgress
    }

    guard let key = cleanup.remainingKeys.first else {
      reservations.removeValue(forKey: connectionID)
      memoize(
        connectionID: connectionID,
        operationID: operationID,
        fingerprint: fingerprint,
        outcome: cleanup.terminalOutcome
      )
      return .completed(cleanup.terminalOutcome)
    }

    cleanup.isAwaiting = true
    reservation.phase = .cleanup(cleanup)
    reservations[connectionID] = reservation
    return .delete(
      key,
      CleanupAwaitToken(
        connectionID: connectionID,
        reservation: reservation,
        linearizedRecord: cleanup.linearizedRecord
      )
    )
  }

  mutating func finishCleanupAwait(
    _ token: CleanupAwaitToken,
    succeeded: Bool
  ) throws(BrokerStateError) {
    guard
      reservations[token.connectionID] == token.reservation,
      records[token.connectionID] == token.linearizedRecord,
      var reservation = reservations[token.connectionID],
      case .cleanup(var cleanup) = reservation.phase
    else {
      throw .operationInProgress
    }

    if succeeded {
      cleanup.remainingKeys.removeFirst()
    }
    cleanup.isAwaiting = false
    reservation.phase = .cleanup(cleanup)
    reservations[token.connectionID] = reservation
  }

  func resolveStage(
    _ outcome: TerminalOutcome
  ) throws(BrokerStateError) -> StagingAttempt {
    guard case .stage(let result) = outcome else {
      throw .operationIDConflict
    }
    return try result.get()
  }

  func resolveCommit(
    _ outcome: TerminalOutcome
  ) throws(BrokerStateError) -> ReadyProjection {
    guard case .commit(let result) = outcome else {
      throw .operationIDConflict
    }
    return try result.get()
  }

  func resolveAbort(
    _ outcome: TerminalOutcome
  ) throws(BrokerStateError) -> ReadyProjection? {
    guard case .abort(let result) = outcome else {
      throw .operationIDConflict
    }
    return try result.get()
  }

  func resolveDisconnect(
    _ outcome: TerminalOutcome
  ) throws(BrokerStateError) -> TombstoneProjection {
    guard case .disconnect(let result) = outcome else {
      throw .operationIDConflict
    }
    return try result.get()
  }

  private func currentMutableRecord(
    connectionID: UUID,
    expectedFence: UInt64
  ) throws(BrokerStateError) -> Record {
    guard let current = records[connectionID] else {
      throw .connectionNotFound
    }
    if case .tombstoned = current {
      throw .connectionTombstoned
    }
    guard current.fence == expectedFence else {
      throw .staleFence
    }
    return current
  }

  private func memoDisposition(
    connectionID: UUID,
    operationID: UUID,
    fingerprint: OperationFingerprint
  ) -> MemoDisposition {
    guard let entry = terminalMemos[connectionID]?.entries[operationID] else {
      return .none
    }
    guard entry.fingerprint == fingerprint else {
      return .conflict
    }
    return .replay(entry.outcome)
  }

  private func reservationDisposition(
    connectionID: UUID,
    operationID: UUID,
    fingerprint: OperationFingerprint
  ) -> ReservationDisposition {
    guard let reservation = reservations[connectionID] else {
      return .none
    }
    switch reservation.phase {
    case .storing:
      return .reject(.operationInProgress)
    case .cleanup(let cleanup):
      if cleanup.isAwaiting {
        return .reject(.operationInProgress)
      }
      guard
        reservation.operationID == operationID,
        reservation.fingerprint == fingerprint
      else {
        return .reject(.cleanupPending)
      }
      return .resumeCleanup
    }
  }

  func validateStageReservation(
    _ token: StageReservationToken
  ) throws(BrokerStateError) {
    guard
      reservations[token.connectionID] == token.reservation,
      records[token.connectionID] == token.fallback
    else {
      throw .operationInProgress
    }
  }

  private func cleanupReservation(
    operationID: UUID,
    fingerprint: OperationFingerprint,
    outcome: TerminalOutcome,
    linearizedRecord: Record,
    keys: [CredentialStoreKey]
  ) -> Reservation {
    Reservation(
      operationID: operationID,
      fingerprint: fingerprint,
      phase: .cleanup(
        CleanupContext(
          terminalOutcome: outcome,
          linearizedRecord: linearizedRecord,
          remainingKeys: keys,
          isAwaiting: false
        )
      )
    )
  }

  private mutating func memoize(
    token: StageReservationToken,
    outcome: TerminalOutcome
  ) {
    memoize(
      connectionID: token.connectionID,
      operationID: token.reservation.operationID,
      fingerprint: token.reservation.fingerprint,
      outcome: outcome
    )
  }

  private mutating func memoize(
    connectionID: UUID,
    operationID: UUID,
    fingerprint: OperationFingerprint,
    outcome: TerminalOutcome
  ) {
    var memo = terminalMemos[connectionID] ?? TerminalMemo()
    memo.insert(operationID: operationID, fingerprint: fingerprint, outcome: outcome)
    terminalMemos[connectionID] = memo
  }

  private static func key(
    for connectionID: UUID,
    generation: CredentialGeneration
  ) -> CredentialStoreKey {
    CredentialStoreKey(
      connectionID: connectionID,
      generationID: generation.generationID,
      generationOrdinal: generation.ordinal
    )
  }
}
