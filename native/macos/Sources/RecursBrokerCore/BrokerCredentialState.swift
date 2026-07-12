import Foundation

package struct CredentialGeneration: Sendable, Hashable, Codable {
  package let generationID: UUID
  package let ordinal: UInt64
  package let createdAt: Date

  package init(generationID: UUID, ordinal: UInt64, createdAt: Date) {
    self.generationID = generationID
    self.ordinal = ordinal
    self.createdAt = createdAt
  }
}

package struct ReadyGeneration: Sendable, Hashable, Codable {
  package let generation: CredentialGeneration
  package let committedAt: Date

  package init(generation: CredentialGeneration, committedAt: Date) {
    self.generation = generation
    self.committedAt = committedAt
  }
}

package struct StagingAttempt: Sendable, Hashable, Codable {
  package let connectionID: UUID
  package let attemptID: UUID
  package let fence: UInt64
  package let candidate: CredentialGeneration
  package let previousReady: ReadyGeneration?
  package let startedAt: Date

  package init(
    connectionID: UUID,
    attemptID: UUID,
    fence: UInt64,
    candidate: CredentialGeneration,
    previousReady: ReadyGeneration?,
    startedAt: Date
  ) {
    self.connectionID = connectionID
    self.attemptID = attemptID
    self.fence = fence
    self.candidate = candidate
    self.previousReady = previousReady
    self.startedAt = startedAt
  }
}

package struct ReadyProjection: Sendable, Hashable, Codable {
  package let connectionID: UUID
  package let fence: UInt64
  package let ready: ReadyGeneration
  package let lastGenerationOrdinal: UInt64

  package init(
    connectionID: UUID,
    fence: UInt64,
    ready: ReadyGeneration,
    lastGenerationOrdinal: UInt64
  ) {
    self.connectionID = connectionID
    self.fence = fence
    self.ready = ready
    self.lastGenerationOrdinal = lastGenerationOrdinal
  }
}

package struct TombstoneProjection: Sendable, Hashable, Codable {
  package let connectionID: UUID
  package let fence: UInt64
  package let lastGenerationOrdinal: UInt64
  package let tombstonedAt: Date

  package init(
    connectionID: UUID,
    fence: UInt64,
    lastGenerationOrdinal: UInt64,
    tombstonedAt: Date
  ) {
    self.connectionID = connectionID
    self.fence = fence
    self.lastGenerationOrdinal = lastGenerationOrdinal
    self.tombstonedAt = tombstonedAt
  }
}

package enum CredentialProjection: Sendable, Hashable, Codable {
  case staging(StagingAttempt)
  case ready(ReadyProjection)
  case tombstoned(TombstoneProjection)

  package var usableReady: ReadyGeneration? {
    switch self {
    case .staging(let attempt):
      attempt.previousReady
    case .ready(let projection):
      projection.ready
    case .tombstoned:
      nil
    }
  }
}

package enum CredentialBootstrap: Sendable, Hashable, Codable {
  case vacant(connectionID: UUID, fence: UInt64, lastGenerationOrdinal: UInt64)
  case ready(ReadyProjection)
  case tombstoned(TombstoneProjection)
}

package enum BrokerStateError:
  Error,
  Sendable,
  Equatable,
  CustomStringConvertible,
  CustomDebugStringConvertible,
  LocalizedError
{
  case cancelled
  case connectionNotFound
  case connectionTombstoned
  case staleFence
  case fenceOverflow
  case generationOverflow
  case invalidTransition
  case attemptNotCurrent
  case operationIDConflict
  case operationInProgress
  case storeUnavailable
  case cleanupPending
  case invalidBootstrap

  private var fixedDescription: String {
    switch self {
    case .cancelled:
      "The operation was cancelled."
    case .connectionNotFound:
      "The connection was not found."
    case .connectionTombstoned:
      "The connection has been disconnected."
    case .staleFence:
      "The connection fence is stale."
    case .fenceOverflow:
      "The connection fence cannot advance."
    case .generationOverflow:
      "The generation ordinal cannot advance."
    case .invalidTransition:
      "The requested state transition is invalid."
    case .attemptNotCurrent:
      "The staging attempt is not current."
    case .operationIDConflict:
      "The operation identifier was reused with different arguments."
    case .operationInProgress:
      "A connection operation is in progress."
    case .storeUnavailable:
      "The credential store is unavailable."
    case .cleanupPending:
      "Credential cleanup is pending."
    case .invalidBootstrap:
      "The credential bootstrap state is invalid."
    }
  }

  package var description: String {
    fixedDescription
  }

  package var debugDescription: String {
    fixedDescription
  }

  package var errorDescription: String? {
    fixedDescription
  }
}

package actor BrokerCredentialState {
  private enum Record: Sendable, Equatable {
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

  private enum OperationKind: Sendable, Equatable {
    case stage
    case commit
    case abort
    case disconnect
  }

  private struct OperationFingerprint: Sendable, Equatable {
    let kind: OperationKind
    let connectionID: UUID
    let expectedFence: UInt64
    let attemptID: UUID?
  }

  private enum TerminalOutcome: Sendable, Equatable {
    case stage(Result<StagingAttempt, BrokerStateError>)
    case commit(Result<ReadyProjection, BrokerStateError>)
    case abort(Result<ReadyProjection?, BrokerStateError>)
    case disconnect(Result<TombstoneProjection, BrokerStateError>)
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

  private struct StageContext: Sendable, Equatable {
    let attempt: StagingAttempt
    let candidateKey: CredentialStoreKey
    let fallback: Record
  }

  private struct CleanupContext: Sendable, Equatable {
    let terminalOutcome: TerminalOutcome
    let linearizedRecord: Record
    var remainingKeys: [CredentialStoreKey]
    var isAwaiting: Bool
  }

  private enum ReservationPhase: Sendable, Equatable {
    case storing(StageContext)
    case cleanup(CleanupContext)
  }

  private struct Reservation: Sendable, Equatable {
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

  private enum MutationPreflightDisposition {
    case proceed
    case replay(TerminalOutcome)
    case resumeCleanup
  }

  private let store: any CredentialStore
  private let clock: @Sendable () -> Date
  private let generationIDSource: @Sendable () -> UUID
  private let attemptIDSource: @Sendable () -> UUID
  private var records: [UUID: Record]
  private var reservations: [UUID: Reservation] = [:]
  private var terminalMemos: [UUID: TerminalMemo] = [:]

  package init(
    store: any CredentialStore,
    bootstrap: [CredentialBootstrap] = [],
    clock: @escaping @Sendable () -> Date = { Date() },
    generationIDSource: @escaping @Sendable () -> UUID = { UUID() },
    attemptIDSource: @escaping @Sendable () -> UUID = { UUID() }
  ) throws(BrokerStateError) {
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

    self.store = store
    self.records = validated
    self.clock = clock
    self.generationIDSource = generationIDSource
    self.attemptIDSource = attemptIDSource
  }

  package func projection(for connectionID: UUID) -> CredentialProjection? {
    records[connectionID]?.projection
  }

  package func stage(
    connectionID: UUID,
    operationID: UUID,
    expectedFence: UInt64,
    secret: sending SecretBytes
  ) async throws(BrokerStateError) -> StagingAttempt {
    let fingerprint = OperationFingerprint(
      kind: .stage,
      connectionID: connectionID,
      expectedFence: expectedFence,
      attemptID: nil
    )

    switch memoDisposition(
      connectionID: connectionID,
      operationID: operationID,
      fingerprint: fingerprint
    ) {
    case .conflict:
      secret.erase()
      throw .operationIDConflict
    case .replay(let outcome):
      secret.erase()
      return try resolveStage(outcome)
    case .none:
      break
    }

    switch reservationDisposition(
      connectionID: connectionID,
      operationID: operationID,
      fingerprint: fingerprint
    ) {
    case .reject(let error):
      secret.erase()
      throw error
    case .resumeCleanup:
      secret.erase()
      return try resolveStage(
        await continueCleanup(
          connectionID: connectionID,
          operationID: operationID,
          fingerprint: fingerprint
        )
      )
    case .none:
      break
    }

    guard !Task.isCancelled else {
      secret.erase()
      throw .cancelled
    }

    let current = records[connectionID]
    if case .tombstoned? = current {
      secret.erase()
      throw .connectionTombstoned
    }

    let currentFence = current?.fence ?? 0
    guard expectedFence == currentFence else {
      secret.erase()
      throw .staleFence
    }

    if case .staging? = current {
      secret.erase()
      throw .invalidTransition
    }

    let lastOrdinal = current?.lastGenerationOrdinal ?? 0
    guard currentFence <= UInt64.max - 2 else {
      secret.erase()
      throw .fenceOverflow
    }
    guard lastOrdinal < UInt64.max else {
      secret.erase()
      throw .generationOverflow
    }

    let nextFence = currentFence + 1
    let nextOrdinal = lastOrdinal + 1
    let previousReady: ReadyGeneration?
    switch current {
    case .ready(let projection):
      previousReady = projection.ready
    case .vacant, .none:
      previousReady = nil
    case .staging, .tombstoned:
      secret.erase()
      throw .invalidTransition
    }

    let candidate = CredentialGeneration(
      generationID: generationIDSource(),
      ordinal: nextOrdinal,
      createdAt: clock()
    )
    let attempt = StagingAttempt(
      connectionID: connectionID,
      attemptID: attemptIDSource(),
      fence: nextFence,
      candidate: candidate,
      previousReady: previousReady,
      startedAt: clock()
    )
    let fallback: Record
    if let previousReady {
      fallback = .ready(
        ReadyProjection(
          connectionID: connectionID,
          fence: nextFence,
          ready: previousReady,
          lastGenerationOrdinal: nextOrdinal
        )
      )
    } else {
      fallback = .vacant(
        connectionID: connectionID,
        fence: nextFence,
        lastGenerationOrdinal: nextOrdinal
      )
    }
    let key = key(for: connectionID, generation: candidate)
    let context = StageContext(attempt: attempt, candidateKey: key, fallback: fallback)
    let reservation = Reservation(
      operationID: operationID,
      fingerprint: fingerprint,
      phase: .storing(context)
    )
    records[connectionID] = fallback
    reservations[connectionID] = reservation

    guard !Task.isCancelled else {
      secret.erase()
      reservations.removeValue(forKey: connectionID)
      let outcome = TerminalOutcome.stage(.failure(.cancelled))
      memoize(
        connectionID: connectionID,
        operationID: operationID,
        fingerprint: fingerprint,
        outcome: outcome
      )
      throw .cancelled
    }

    do {
      try await store.store(secret, for: key)
    } catch let error {
      guard reservations[connectionID] == reservation, records[connectionID] == fallback else {
        throw .operationInProgress
      }
      switch error {
      case .unavailable:
        reservations.removeValue(forKey: connectionID)
        let outcome = TerminalOutcome.stage(.failure(.storeUnavailable))
        memoize(
          connectionID: connectionID,
          operationID: operationID,
          fingerprint: fingerprint,
          outcome: outcome
        )
        throw .storeUnavailable
      case .mutationOutcomeUnknown:
        let outcome = TerminalOutcome.stage(.failure(.storeUnavailable))
        reservations[connectionID] = Reservation(
          operationID: operationID,
          fingerprint: fingerprint,
          phase: .cleanup(
            CleanupContext(
              terminalOutcome: outcome,
              linearizedRecord: fallback,
              remainingKeys: [key],
              isAwaiting: false
            )
          )
        )
        return try resolveStage(
          await continueCleanup(
            connectionID: connectionID,
            operationID: operationID,
            fingerprint: fingerprint
          )
        )
      }
    }

    guard reservations[connectionID] == reservation, records[connectionID] == fallback else {
      throw .operationInProgress
    }
    if Task.isCancelled {
      let outcome = TerminalOutcome.stage(.failure(.cancelled))
      reservations[connectionID] = Reservation(
        operationID: operationID,
        fingerprint: fingerprint,
        phase: .cleanup(
          CleanupContext(
            terminalOutcome: outcome,
            linearizedRecord: fallback,
            remainingKeys: [key],
            isAwaiting: false
          )
        )
      )
      return try resolveStage(
        await continueCleanup(
          connectionID: connectionID,
          operationID: operationID,
          fingerprint: fingerprint
        )
      )
    }

    records[connectionID] = .staging(attempt)
    reservations.removeValue(forKey: connectionID)
    let outcome = TerminalOutcome.stage(.success(attempt))
    memoize(
      connectionID: connectionID,
      operationID: operationID,
      fingerprint: fingerprint,
      outcome: outcome
    )
    return attempt
  }

  package func resumeStage(
    connectionID: UUID,
    operationID: UUID,
    expectedFence: UInt64
  ) async throws(BrokerStateError) -> StagingAttempt {
    let fingerprint = OperationFingerprint(
      kind: .stage,
      connectionID: connectionID,
      expectedFence: expectedFence,
      attemptID: nil
    )
    switch memoDisposition(
      connectionID: connectionID,
      operationID: operationID,
      fingerprint: fingerprint
    ) {
    case .conflict:
      throw .operationIDConflict
    case .replay(let outcome):
      return try resolveStage(outcome)
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
      return try resolveStage(
        await continueCleanup(
          connectionID: connectionID,
          operationID: operationID,
          fingerprint: fingerprint
        )
      )
    case .none:
      break
    }
    guard !Task.isCancelled else {
      throw .cancelled
    }
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

  package func commit(
    connectionID: UUID,
    attemptID: UUID,
    operationID: UUID,
    expectedFence: UInt64
  ) async throws(BrokerStateError) -> ReadyProjection {
    let fingerprint = OperationFingerprint(
      kind: .commit,
      connectionID: connectionID,
      expectedFence: expectedFence,
      attemptID: attemptID
    )
    switch try preflight(
      connectionID: connectionID,
      operationID: operationID,
      fingerprint: fingerprint
    ) {
    case .replay(let outcome):
      return try resolveCommit(outcome)
    case .resumeCleanup:
      return try resolveCommit(
        await continueCleanup(
          connectionID: connectionID,
          operationID: operationID,
          fingerprint: fingerprint
        )
      )
    case .proceed:
      break
    }
    guard let current = records[connectionID] else {
      throw .connectionNotFound
    }
    if case .tombstoned = current {
      throw .connectionTombstoned
    }
    guard current.fence == expectedFence else {
      throw .staleFence
    }
    guard case .staging(let attempt) = current, attempt.attemptID == attemptID else {
      throw .attemptNotCurrent
    }

    let ready = ReadyProjection(
      connectionID: connectionID,
      fence: attempt.fence,
      ready: ReadyGeneration(generation: attempt.candidate, committedAt: clock()),
      lastGenerationOrdinal: attempt.candidate.ordinal
    )
    records[connectionID] = .ready(ready)
    let outcome = TerminalOutcome.commit(.success(ready))
    guard let previous = attempt.previousReady else {
      memoize(
        connectionID: connectionID,
        operationID: operationID,
        fingerprint: fingerprint,
        outcome: outcome
      )
      return ready
    }

    reservations[connectionID] = cleanupReservation(
      operationID: operationID,
      fingerprint: fingerprint,
      outcome: outcome,
      linearizedRecord: .ready(ready),
      keys: [key(for: connectionID, generation: previous.generation)]
    )
    return try resolveCommit(
      await continueCleanup(
        connectionID: connectionID,
        operationID: operationID,
        fingerprint: fingerprint
      )
    )
  }

  package func abort(
    connectionID: UUID,
    attemptID: UUID,
    operationID: UUID,
    expectedFence: UInt64
  ) async throws(BrokerStateError) -> ReadyProjection? {
    let fingerprint = OperationFingerprint(
      kind: .abort,
      connectionID: connectionID,
      expectedFence: expectedFence,
      attemptID: attemptID
    )
    switch try preflight(
      connectionID: connectionID,
      operationID: operationID,
      fingerprint: fingerprint
    ) {
    case .replay(let outcome):
      return try resolveAbort(outcome)
    case .resumeCleanup:
      return try resolveAbort(
        await continueCleanup(
          connectionID: connectionID,
          operationID: operationID,
          fingerprint: fingerprint
        )
      )
    case .proceed:
      break
    }
    guard let current = records[connectionID] else {
      throw .connectionNotFound
    }
    if case .tombstoned = current {
      throw .connectionTombstoned
    }
    guard current.fence == expectedFence else {
      throw .staleFence
    }
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
    let outcome = TerminalOutcome.abort(.success(restored))
    reservations[connectionID] = cleanupReservation(
      operationID: operationID,
      fingerprint: fingerprint,
      outcome: outcome,
      linearizedRecord: restoredRecord,
      keys: [key(for: connectionID, generation: attempt.candidate)]
    )
    return try resolveAbort(
      await continueCleanup(
        connectionID: connectionID,
        operationID: operationID,
        fingerprint: fingerprint
      )
    )
  }

  package func disconnect(
    connectionID: UUID,
    operationID: UUID,
    expectedFence: UInt64
  ) async throws(BrokerStateError) -> TombstoneProjection {
    let fingerprint = OperationFingerprint(
      kind: .disconnect,
      connectionID: connectionID,
      expectedFence: expectedFence,
      attemptID: nil
    )
    switch try preflight(
      connectionID: connectionID,
      operationID: operationID,
      fingerprint: fingerprint
    ) {
    case .replay(let outcome):
      return try resolveDisconnect(outcome)
    case .resumeCleanup:
      return try resolveDisconnect(
        await continueCleanup(
          connectionID: connectionID,
          operationID: operationID,
          fingerprint: fingerprint
        )
      )
    case .proceed:
      break
    }
    guard let current = records[connectionID] else {
      throw .connectionNotFound
    }
    if case .tombstoned = current {
      throw .connectionTombstoned
    }
    guard current.fence == expectedFence else {
      throw .staleFence
    }
    guard current.fence < UInt64.max else {
      throw .fenceOverflow
    }

    let tombstone = TombstoneProjection(
      connectionID: connectionID,
      fence: current.fence + 1,
      lastGenerationOrdinal: current.lastGenerationOrdinal,
      tombstonedAt: clock()
    )
    var keys: [CredentialStoreKey] = []
    switch current {
    case .staging(let attempt):
      keys.append(key(for: connectionID, generation: attempt.candidate))
      if let previous = attempt.previousReady {
        keys.append(key(for: connectionID, generation: previous.generation))
      }
    case .ready(let projection):
      keys.append(key(for: connectionID, generation: projection.ready.generation))
    case .vacant:
      break
    case .tombstoned:
      throw .connectionTombstoned
    }
    keys.sort { $0.generationOrdinal > $1.generationOrdinal }
    records[connectionID] = .tombstoned(tombstone)
    let outcome = TerminalOutcome.disconnect(.success(tombstone))
    guard !keys.isEmpty else {
      memoize(
        connectionID: connectionID,
        operationID: operationID,
        fingerprint: fingerprint,
        outcome: outcome
      )
      return tombstone
    }

    reservations[connectionID] = cleanupReservation(
      operationID: operationID,
      fingerprint: fingerprint,
      outcome: outcome,
      linearizedRecord: .tombstoned(tombstone),
      keys: keys
    )
    return try resolveDisconnect(
      await continueCleanup(
        connectionID: connectionID,
        operationID: operationID,
        fingerprint: fingerprint
      )
    )
  }

  private func preflight(
    connectionID: UUID,
    operationID: UUID,
    fingerprint: OperationFingerprint
  ) throws(BrokerStateError) -> MutationPreflightDisposition {
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
      break
    }
    guard !Task.isCancelled else {
      throw .cancelled
    }
    return .proceed
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

  private func continueCleanup(
    connectionID: UUID,
    operationID: UUID,
    fingerprint: OperationFingerprint
  ) async throws(BrokerStateError) -> TerminalOutcome {
    while true {
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
        return cleanup.terminalOutcome
      }

      cleanup.isAwaiting = true
      reservation.phase = .cleanup(cleanup)
      reservations[connectionID] = reservation

      do {
        try await store.deleteIfPresent(key)
      } catch {
        guard
          reservations[connectionID] == reservation,
          records[connectionID] == cleanup.linearizedRecord
        else {
          throw .operationInProgress
        }
        cleanup.isAwaiting = false
        reservation.phase = .cleanup(cleanup)
        reservations[connectionID] = reservation
        throw .cleanupPending
      }

      guard
        reservations[connectionID] == reservation,
        records[connectionID] == cleanup.linearizedRecord
      else {
        throw .operationInProgress
      }
      cleanup.remainingKeys.removeFirst()
      cleanup.isAwaiting = false
      reservation.phase = .cleanup(cleanup)
      reservations[connectionID] = reservation
    }
  }

  private func memoize(
    connectionID: UUID,
    operationID: UUID,
    fingerprint: OperationFingerprint,
    outcome: TerminalOutcome
  ) {
    var memo = terminalMemos[connectionID] ?? TerminalMemo()
    memo.insert(operationID: operationID, fingerprint: fingerprint, outcome: outcome)
    terminalMemos[connectionID] = memo
  }

  private func key(
    for connectionID: UUID,
    generation: CredentialGeneration
  ) -> CredentialStoreKey {
    CredentialStoreKey(
      connectionID: connectionID,
      generationID: generation.generationID,
      generationOrdinal: generation.ordinal
    )
  }

  private func resolveStage(
    _ outcome: TerminalOutcome
  ) throws(BrokerStateError) -> StagingAttempt {
    guard case .stage(let result) = outcome else {
      throw .operationIDConflict
    }
    return try result.get()
  }

  private func resolveCommit(
    _ outcome: TerminalOutcome
  ) throws(BrokerStateError) -> ReadyProjection {
    guard case .commit(let result) = outcome else {
      throw .operationIDConflict
    }
    return try result.get()
  }

  private func resolveAbort(
    _ outcome: TerminalOutcome
  ) throws(BrokerStateError) -> ReadyProjection? {
    guard case .abort(let result) = outcome else {
      throw .operationIDConflict
    }
    return try result.get()
  }

  private func resolveDisconnect(
    _ outcome: TerminalOutcome
  ) throws(BrokerStateError) -> TombstoneProjection {
    guard case .disconnect(let result) = outcome else {
      throw .operationIDConflict
    }
    return try result.get()
  }
}
