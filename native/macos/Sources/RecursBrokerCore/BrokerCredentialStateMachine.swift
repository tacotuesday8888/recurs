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

    var lifecycleProjection: CredentialLifecycleProjection {
      switch self {
      case .vacant(let connectionID, let fence, _):
        .vacant(connectionID: connectionID, fence: fence)
      case .ready(let projection):
        .ready(connectionID: projection.connectionID, fence: projection.fence)
      case .staging(let attempt):
        .staging(
          connectionID: attempt.connectionID,
          fence: attempt.fence,
          attemptID: attempt.attemptID,
          hasUsableReady: attempt.previousReady != nil
        )
      case .tombstoned(let projection):
        .tombstoned(connectionID: projection.connectionID, fence: projection.fence)
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
    let providerBinding: ProviderProfileBinding?
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
    case resumeJournalStaging
    case resumeStageResolutionRequest
    case resumeStageResolution
    case resumeCleanup
  }

  struct CredentialUseAuthority: Sendable, Equatable {
    let connectionID: UUID
    let record: Record
    let snapshot: BrokerJournalSnapshot
    let ready: ReadyGeneration
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
    let providerBinding: ProviderProfileBinding
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

  struct JournalStageReservationAwaitToken: Sendable, Equatable {
    let connectionID: UUID
    let reservation: Reservation
    let expected: BrokerJournalSnapshot?
    let replacement: BrokerJournalRecord
  }

  struct JournalStageStoreToken: Sendable, Equatable {
    let connectionID: UUID
    let reservation: Reservation
    let fallback: Record
    let expected: BrokerJournalSnapshot

    var attempt: StagingAttempt {
      guard case .storing(let context) = reservation.phase else {
        preconditionFailure("A durable stage-store token must retain its storing reservation.")
      }
      return context.attempt
    }

    var candidateKey: CredentialStoreKey {
      guard case .storing(let context) = reservation.phase else {
        preconditionFailure("A durable stage-store token must retain its storing reservation.")
      }
      return context.candidateKey
    }
  }

  struct JournalStageTransitionAwaitToken: Sendable, Equatable {
    let connectionID: UUID
    let reservation: Reservation
    let fallback: Record
    let expected: BrokerJournalSnapshot
    let replacement: BrokerJournalRecord
    let cancellationObserved: Bool
  }

  struct JournalStageResolutionAwaitToken: Sendable, Equatable {
    let connectionID: UUID
    let reservation: Reservation
    let fallback: Record
    let expected: BrokerJournalSnapshot
    let replacement: BrokerJournalRecord
  }

  struct JournalStageResolutionRequestToken: Sendable, Equatable {
    let connectionID: UUID
    let reservation: Reservation
    let fallback: Record
    let expected: BrokerJournalSnapshot
  }

  enum JournalStageResolutionSelection: Sendable, Equatable {
    case expected
    case unrelated
  }

  enum JournalStageResolutionCompletion: Sendable, Equatable {
    case terminal(TerminalOutcome)
    case cleanup
  }

  struct JournalAuthorityAwaitToken: Sendable, Equatable {
    let connectionID: UUID
    let reservation: Reservation
    let current: Record
    let expected: BrokerJournalSnapshot
    let replacement: BrokerJournalRecord
  }

  struct JournalAuthoritativeProjectionReadToken: Sendable, Equatable {
    let connectionID: UUID
    let sequence: UInt64
    let expectedRecord: Record?
    let expected: BrokerJournalSnapshot?
  }

  enum JournalAuthorityCompletion: Sendable, Equatable {
    case completed(TerminalOutcome)
    case cleanup(TerminalOutcome)
  }

  struct CommitProposal: Sendable, Equatable {
    let connectionID: UUID
    let operationID: UUID
    let fingerprint: OperationFingerprint
    let record: Record
    let attempt: StagingAttempt
  }

  struct AbortProposal: Sendable, Equatable {
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

  enum JournalCleanupStep: Sendable, Equatable {
    case delete(CredentialStoreKey, CleanupAwaitToken)
    case needsFinalization(JournalFinalizationRequestToken)
  }

  struct CleanupAwaitToken: Sendable, Equatable {
    let connectionID: UUID
    let reservation: Reservation
    let linearizedRecord: Record
  }

  struct JournalFinalizationRequestToken: Sendable, Equatable {
    let connectionID: UUID
    let reservation: Reservation
    let linearizedRecord: Record
    let expected: BrokerJournalSnapshot
  }

  struct JournalFinalizationAwaitToken: Sendable, Equatable {
    let connectionID: UUID
    let reservation: Reservation
    let linearizedRecord: Record
    let expected: BrokerJournalSnapshot
    let replacement: BrokerJournalRecord
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

  struct JournalStageReservationContext: Sendable, Equatable {
    let current: Record?
    let expected: BrokerJournalSnapshot?
    let replacement: BrokerJournalRecord
    let stage: StageContext
  }

  enum JournalStageTransitionKind: Sendable, Equatable {
    case staging
    case stableStoreFailure
    case cleanup(BrokerStateError)
  }

  struct JournalStageTransitionContext: Sendable, Equatable {
    let stage: StageContext
    let expected: BrokerJournalSnapshot
    let replacement: BrokerJournalRecord
    let kind: JournalStageTransitionKind
    var isAwaiting: Bool
    var cancellationObserved: Bool
  }

  enum JournalStageResolutionKind: Sendable, Equatable {
    case stableStoreFailure
    case cleanup(BrokerStateError)
  }

  struct JournalStageResolutionContext: Sendable, Equatable {
    let stage: StageContext
    let expected: BrokerJournalSnapshot
    let replacement: BrokerJournalRecord
    let kind: JournalStageResolutionKind
    var isAwaiting: Bool
  }

  struct JournalStageResolutionRequestContext: Sendable, Equatable {
    let stage: StageContext
    let expected: BrokerJournalSnapshot
    let kind: JournalStageResolutionKind
  }

  struct JournalAuthorityContext: Sendable, Equatable {
    let current: Record
    let expected: BrokerJournalSnapshot
    let replacement: BrokerJournalRecord
    let linearizedRecord: Record
    let terminalOutcome: TerminalOutcome
    let cleanupKeys: [CredentialStoreKey]
    let requiresFinalization: Bool
  }

  struct CleanupContext: Sendable, Equatable {
    let terminalOutcome: TerminalOutcome
    let linearizedRecord: Record
    var remainingKeys: [CredentialStoreKey]
    var isAwaiting: Bool
    let journal: JournalCleanupContext?
  }

  struct JournalCleanupContext: Sendable, Equatable {
    let snapshot: BrokerJournalSnapshot
  }

  enum ReservationPhase: Sendable, Equatable {
    case journalStageReservation(JournalStageReservationContext)
    case storing(StageContext)
    case journalStageTransition(JournalStageTransitionContext)
    case journalStageResolutionRequest(JournalStageResolutionRequestContext)
    case journalStageResolution(JournalStageResolutionContext)
    case journalAuthority(JournalAuthorityContext)
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
    case resumeJournalStaging
    case resumeStageResolutionRequest
    case resumeStageResolution
    case resumeCleanup
    case reject(BrokerStateError)
  }

  private var records: [UUID: Record]
  private var reservations: [UUID: Reservation] = [:]
  private var terminalMemos: [UUID: TerminalMemo] = [:]
  private var journalSnapshots: [UUID: BrokerJournalSnapshot] = [:]
  private var authoritativeReadSequences: [UUID: UInt64] = [:]
  private var nextAuthoritativeReadSequence: UInt64 = 0
  private var unavailableConnections: Set<UUID> = []
  private var journalHealthUnavailable = false

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

  init(
    preparedJournalEntries: [BrokerJournalPreparedEntry]
  ) throws(BrokerJournalError) {
    guard preparedJournalEntries.count <= 1_024 else {
      throw .invalidRecord
    }

    var bootstraps: [CredentialBootstrap] = []
    bootstraps.reserveCapacity(preparedJournalEntries.count)
    var previousConnectionID: String?
    for entry in preparedJournalEntries {
      let connectionID = entry.snapshot.record.connectionID.uuidString.lowercased()
      if let previousConnectionID, previousConnectionID >= connectionID {
        throw .invalidRecord
      }
      previousConnectionID = connectionID
      guard entry.plan.preparation == nil else {
        throw .invalidRecord
      }
      let recomputed = try BrokerJournalRecordAdapter.recoveryPlan(
        for: entry.snapshot.record,
        recoveryChangedAt: entry.snapshot.record.changedAt
      )
      guard recomputed == entry.plan else {
        throw .invalidRecord
      }
      bootstraps.append(entry.plan.bootstrap)
    }

    do {
      self = try BrokerCredentialStateMachine(bootstrap: bootstraps)
    } catch {
      throw .invalidRecord
    }

    for entry in preparedJournalEntries {
      let connectionID = entry.snapshot.record.connectionID
      guard
        journalSnapshots.updateValue(entry.snapshot, forKey: connectionID) == nil,
        let linearizedRecord = records[connectionID]
      else {
        throw .invalidRecord
      }

      for terminal in entry.snapshot.record.terminalOperations {
        let hydrated = try Self.hydratedTerminal(
          terminal,
          connectionID: connectionID,
          providerBinding: entry.snapshot.record.providerBinding
        )
        guard terminalMemos[connectionID]?.entries[terminal.operationID] == nil else {
          throw .invalidRecord
        }
        memoize(
          connectionID: connectionID,
          operationID: terminal.operationID,
          fingerprint: hydrated.fingerprint,
          outcome: hydrated.outcome
        )
      }

      guard let cleanup = entry.plan.cleanup else {
        continue
      }
      let hydrated = try Self.hydratedTerminal(
        cleanup.terminalOperation,
        connectionID: connectionID,
        providerBinding: entry.snapshot.record.providerBinding
      )
      guard
        terminalMemos[connectionID]?.entries[cleanup.terminalOperation.operationID] == nil,
        !Self.hasAttemptCollision(
          cleanup.terminalOperation,
          with: entry.snapshot.record.terminalOperations
        ),
        reservations[connectionID] == nil
      else {
        throw .invalidRecord
      }
      reservations[connectionID] = cleanupReservation(
        operationID: cleanup.terminalOperation.operationID,
        fingerprint: hydrated.fingerprint,
        outcome: hydrated.outcome,
        linearizedRecord: linearizedRecord,
        keys: cleanup.credentialKeys,
        journal: JournalCleanupContext(snapshot: entry.snapshot)
      )
    }
  }

  func projection(for connectionID: UUID) -> CredentialProjection? {
    records[connectionID]?.projection
  }

  func lifecycleProjection(
    for connectionID: UUID
  ) -> CredentialLifecycleProjection {
    records[connectionID]?.lifecycleProjection ?? .missing(connectionID: connectionID)
  }

  func journalSnapshot(for connectionID: UUID) -> BrokerJournalSnapshot? {
    journalSnapshots[connectionID]
  }

  func credentialUseAuthority(
    connectionID: UUID
  ) throws(BrokerStateError) -> CredentialUseAuthority {
    guard !journalHealthUnavailable, !unavailableConnections.contains(connectionID) else {
      throw .storeUnavailable
    }
    guard
      authoritativeReadSequences[connectionID] == nil,
      reservations[connectionID] == nil
    else {
      throw .operationInProgress
    }
    guard let record = records[connectionID] else {
      throw .connectionNotFound
    }
    if case .tombstoned = record {
      throw .connectionTombstoned
    }
    guard
      let snapshot = journalSnapshots[connectionID],
      let ready = record.projection?.usableReady
    else {
      throw .invalidTransition
    }
    return CredentialUseAuthority(
      connectionID: connectionID,
      record: record,
      snapshot: snapshot,
      ready: ready
    )
  }

  mutating func validateCredentialUseAuthority(
    _ authority: CredentialUseAuthority
  ) throws(BrokerJournalError) {
    guard
      !journalHealthUnavailable,
      !unavailableConnections.contains(authority.connectionID)
    else {
      throw .storageUnavailable
    }
    guard
      authoritativeReadSequences[authority.connectionID] == nil,
      reservations[authority.connectionID] == nil
    else {
      throw .casConflict
    }
    guard
      records[authority.connectionID] == authority.record,
      journalSnapshots[authority.connectionID] == authority.snapshot
    else {
      unavailableConnections.insert(authority.connectionID)
      throw .casConflict
    }
  }

  mutating func invalidateCredentialUseAuthority(connectionID: UUID) {
    unavailableConnections.insert(connectionID)
  }

  mutating func beginAuthoritativeProjection(
    connectionID: UUID
  ) throws(BrokerJournalError) -> JournalAuthoritativeProjectionReadToken {
    guard !journalHealthUnavailable, !unavailableConnections.contains(connectionID) else {
      throw .storageUnavailable
    }
    guard
      authoritativeReadSequences[connectionID] == nil,
      canBeginAuthoritativeProjection(connectionID: connectionID),
      nextAuthoritativeReadSequence < UInt64.max
    else {
      throw .casConflict
    }

    nextAuthoritativeReadSequence += 1
    let token = JournalAuthoritativeProjectionReadToken(
      connectionID: connectionID,
      sequence: nextAuthoritativeReadSequence,
      expectedRecord: records[connectionID],
      expected: journalSnapshots[connectionID]
    )
    authoritativeReadSequences[connectionID] = token.sequence
    return token
  }

  mutating func finishAuthoritativeProjection(
    _ token: JournalAuthoritativeProjectionReadToken,
    result: Result<BrokerJournalSnapshot?, BrokerJournalError>
  ) throws(BrokerJournalError) -> CredentialProjection? {
    guard authoritativeReadSequences[token.connectionID] == token.sequence else {
      throw .casConflict
    }
    guard
      records[token.connectionID] == token.expectedRecord,
      journalSnapshots[token.connectionID] == token.expected
    else {
      authoritativeReadSequences.removeValue(forKey: token.connectionID)
      unavailableConnections.insert(token.connectionID)
      throw .casConflict
    }
    if journalHealthUnavailable {
      authoritativeReadSequences.removeValue(forKey: token.connectionID)
      throw .storageUnavailable
    }

    switch result {
    case .failure(let error):
      authoritativeReadSequences.removeValue(forKey: token.connectionID)
      recordJournalFailure(error)
      throw error

    case .success(let selected):
      guard selected == token.expected else {
        authoritativeReadSequences.removeValue(forKey: token.connectionID)
        unavailableConnections.insert(token.connectionID)
        throw .casConflict
      }
      authoritativeReadSequences.removeValue(forKey: token.connectionID)
      return token.expectedRecord?.projection
    }
  }

  @discardableResult
  mutating func recordJournalFailure(_ error: BrokerJournalError) -> Bool {
    let isSevere = Self.isSevereJournalHealthError(error)
    if isSevere {
      journalHealthUnavailable = true
    }
    return isSevere
  }

  static func fingerprint(
    kind: OperationKind,
    connectionID: UUID,
    expectedFence: UInt64,
    attemptID: UUID? = nil,
    providerBinding: ProviderProfileBinding? = nil
  ) -> OperationFingerprint {
    OperationFingerprint(
      kind: kind,
      connectionID: connectionID,
      expectedFence: expectedFence,
      attemptID: attemptID,
      providerBinding: providerBinding
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

    guard !journalHealthUnavailable, !unavailableConnections.contains(connectionID) else {
      throw .storeUnavailable
    }
    guard authoritativeReadSequences[connectionID] == nil else {
      throw .operationInProgress
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
    case .resumeJournalStaging:
      return .resumeJournalStaging
    case .resumeStageResolutionRequest:
      return .resumeStageResolutionRequest
    case .resumeStageResolution:
      return .resumeStageResolution
    case .none:
      return .proceed
    }
  }

  func resumeStageFingerprint(
    connectionID: UUID,
    operationID: UUID,
    expectedFence: UInt64
  ) throws(BrokerStateError) -> OperationFingerprint {
    let probe = Self.fingerprint(
      kind: .stage,
      connectionID: connectionID,
      expectedFence: expectedFence
    )
    if let entry = terminalMemos[connectionID]?.entries[operationID] {
      return Self.matchesStageResume(
        entry.fingerprint,
        connectionID: connectionID,
        expectedFence: expectedFence
      ) ? entry.fingerprint : probe
    }
    if let reservation = reservations[connectionID],
      reservation.operationID == operationID,
      Self.matchesStageResume(
        reservation.fingerprint,
        connectionID: connectionID,
        expectedFence: expectedFence
      )
    {
      return reservation.fingerprint
    }
    return probe
  }

  func stageProposal(
    connectionID: UUID,
    expectedFence: UInt64,
    providerBinding: ProviderProfileBinding
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
    if let snapshot = journalSnapshots[connectionID],
      snapshot.record.providerBinding != providerBinding
    {
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
      previousReady: previousReady,
      providerBinding: providerBinding
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
      reservations[proposal.connectionID] == nil,
      fingerprint
        == Self.fingerprint(
          kind: .stage,
          connectionID: proposal.connectionID,
          expectedFence: proposal.current?.fence ?? 0,
          providerBinding: proposal.providerBinding
        )
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

  mutating func reserveJournalStage(
    proposal: StageProposal,
    operationID: UUID,
    fingerprint: OperationFingerprint,
    generationID: UUID,
    attemptID: UUID,
    capturedAt: JournalTimestamp
  ) throws(BrokerJournalError) -> JournalStageReservationAwaitToken {
    let expected = journalSnapshots[proposal.connectionID]
    let expectedFence = proposal.current?.fence ?? 0
    guard
      records[proposal.connectionID] == proposal.current,
      reservations[proposal.connectionID] == nil,
      (proposal.current == nil) == (expected == nil),
      fingerprint
        == Self.fingerprint(
          kind: .stage,
          connectionID: proposal.connectionID,
          expectedFence: expectedFence,
          providerBinding: proposal.providerBinding
        )
    else {
      throw .casConflict
    }

    let replacement = try BrokerJournalRecordAdapter.makeStorePending(
      predecessor: expected?.record,
      connectionID: proposal.connectionID,
      providerBinding: proposal.providerBinding,
      attemptID: attemptID,
      operationID: operationID,
      candidateGenerationID: generationID,
      capturedAt: capturedAt
    )
    guard
      replacement.fence == proposal.nextFence,
      replacement.lastGenerationOrdinal == proposal.nextOrdinal,
      case .storePending(let payload) = replacement.payload
    else {
      throw .invalidRecord
    }

    let candidate = try BrokerJournalRecordAdapter.generation(from: payload.candidate)
    let previousReady = try payload.previousReady.map(
      BrokerJournalRecordAdapter.readyGeneration(from:)
    )
    guard previousReady == proposal.previousReady else {
      throw .invalidRecord
    }
    let attempt = StagingAttempt(
      connectionID: proposal.connectionID,
      attemptID: payload.attemptID,
      fence: replacement.fence,
      candidate: candidate,
      previousReady: previousReady,
      startedAt: payload.startedAt.date
    )
    let fallback: Record
    if let previousReady = attempt.previousReady {
      fallback = .ready(
        ReadyProjection(
          connectionID: proposal.connectionID,
          fence: replacement.fence,
          ready: previousReady,
          lastGenerationOrdinal: replacement.lastGenerationOrdinal
        )
      )
    } else {
      fallback = .vacant(
        connectionID: proposal.connectionID,
        fence: replacement.fence,
        lastGenerationOrdinal: replacement.lastGenerationOrdinal
      )
    }
    let stage = StageContext(
      attempt: attempt,
      candidateKey: Self.key(for: proposal.connectionID, generation: candidate),
      fallback: fallback
    )
    let reservation = Reservation(
      operationID: operationID,
      fingerprint: fingerprint,
      phase: .journalStageReservation(
        JournalStageReservationContext(
          current: proposal.current,
          expected: expected,
          replacement: replacement,
          stage: stage
        )
      )
    )
    reservations[proposal.connectionID] = reservation
    return JournalStageReservationAwaitToken(
      connectionID: proposal.connectionID,
      reservation: reservation,
      expected: expected,
      replacement: replacement
    )
  }

  mutating func finishJournalStageReservation(
    _ token: JournalStageReservationAwaitToken,
    result: Result<BrokerJournalSnapshot, BrokerJournalError>
  ) throws(BrokerJournalError) -> JournalStageStoreToken {
    guard
      reservations[token.connectionID] == token.reservation,
      case .journalStageReservation(let context) = token.reservation.phase,
      context.expected == token.expected,
      context.replacement == token.replacement,
      records[token.connectionID] == context.current,
      journalSnapshots[token.connectionID] == token.expected
    else {
      throw .casConflict
    }

    let selected: BrokerJournalSnapshot
    switch result {
    case .failure(let error):
      reservations.removeValue(forKey: token.connectionID)
      throw error
    case .success(let value):
      guard value.record == token.replacement else {
        reservations.removeValue(forKey: token.connectionID)
        throw .casConflict
      }
      selected = value
    }

    let storingReservation = Reservation(
      operationID: token.reservation.operationID,
      fingerprint: token.reservation.fingerprint,
      phase: .storing(context.stage)
    )
    records[token.connectionID] = context.stage.fallback
    journalSnapshots[token.connectionID] = selected
    reservations[token.connectionID] = storingReservation
    return JournalStageStoreToken(
      connectionID: token.connectionID,
      reservation: storingReservation,
      fallback: context.stage.fallback,
      expected: selected
    )
  }

  mutating func beginJournalStaging(
    _ token: JournalStageStoreToken,
    changedAt: JournalTimestamp
  ) throws(BrokerJournalError) -> JournalStageTransitionAwaitToken {
    let replacement = try BrokerJournalRecordAdapter.makeStaging(
      predecessor: token.expected.record,
      changedAt: changedAt
    )
    return try beginJournalStageTransition(
      token,
      replacement: replacement,
      kind: .staging
    )
  }

  mutating func beginJournalStableStoreFailure(
    _ token: JournalStageStoreToken,
    changedAt: JournalTimestamp
  ) throws(BrokerJournalError) -> JournalStageTransitionAwaitToken {
    let replacement = try BrokerJournalRecordAdapter.makeStableStoreFailure(
      predecessor: token.expected.record,
      changedAt: changedAt
    )
    return try beginJournalStageTransition(
      token,
      replacement: replacement,
      kind: .stableStoreFailure
    )
  }

  mutating func beginJournalStageCleanup(
    _ token: JournalStageStoreToken,
    terminalError: BrokerStateError,
    changedAt: JournalTimestamp
  ) throws(BrokerJournalError) -> JournalStageTransitionAwaitToken {
    let journalError: BrokerJournalStageError
    switch terminalError {
    case .cancelled:
      journalError = .cancelled
    case .storeUnavailable:
      journalError = .storeUnavailable
    default:
      throw .invalidRecord
    }
    let replacement = try BrokerJournalRecordAdapter.makeStageCleanupPending(
      predecessor: token.expected.record,
      error: journalError,
      changedAt: changedAt
    )
    return try beginJournalStageTransition(
      token,
      replacement: replacement,
      kind: .cleanup(terminalError)
    )
  }

  mutating func finishJournalStaging(
    _ token: JournalStageTransitionAwaitToken,
    result: Result<BrokerJournalSnapshot, BrokerJournalError>
  ) throws(BrokerJournalError) -> StagingAttempt {
    let completion = try selectJournalStageTransition(
      token,
      result: result,
      kind: .staging
    )
    let attempt = completion.context.stage.attempt
    records[token.connectionID] = .staging(attempt)
    journalSnapshots[token.connectionID] = completion.selected
    reservations.removeValue(forKey: token.connectionID)
    memoize(
      connectionID: token.connectionID,
      operationID: token.reservation.operationID,
      fingerprint: token.reservation.fingerprint,
      outcome: .stage(.success(attempt))
    )
    return attempt
  }

  mutating func finishJournalStableStoreFailure(
    _ token: JournalStageTransitionAwaitToken,
    result: Result<BrokerJournalSnapshot, BrokerJournalError>
  ) throws(BrokerJournalError) -> TerminalOutcome {
    let completion = try selectJournalStageTransition(
      token,
      result: result,
      kind: .stableStoreFailure
    )
    let outcome = TerminalOutcome.stage(.failure(.storeUnavailable))
    journalSnapshots[token.connectionID] = completion.selected
    reservations.removeValue(forKey: token.connectionID)
    memoize(
      connectionID: token.connectionID,
      operationID: token.reservation.operationID,
      fingerprint: token.reservation.fingerprint,
      outcome: outcome
    )
    return outcome
  }

  mutating func finishJournalStageCleanup(
    _ token: JournalStageTransitionAwaitToken,
    result: Result<BrokerJournalSnapshot, BrokerJournalError>
  ) throws(BrokerJournalError) {
    guard
      case .journalStageTransition(let tokenContext) = token.reservation.phase,
      case .cleanup(let terminalError) = tokenContext.kind
    else {
      throw .casConflict
    }
    let completion = try selectJournalStageTransition(
      token,
      result: result,
      kind: .cleanup(terminalError)
    )
    let outcome = TerminalOutcome.stage(.failure(terminalError))
    journalSnapshots[token.connectionID] = completion.selected
    reservations[token.connectionID] = cleanupReservation(
      operationID: token.reservation.operationID,
      fingerprint: token.reservation.fingerprint,
      outcome: outcome,
      linearizedRecord: token.fallback,
      keys: [completion.context.stage.candidateKey],
      journal: JournalCleanupContext(snapshot: completion.selected)
    )
  }

  mutating func pauseJournalStageTransition(
    _ token: JournalStageTransitionAwaitToken,
    cancellationObserved: Bool = false
  ) throws(BrokerJournalError) {
    var context = try validatedJournalStageTransition(token)
    let kind: JournalStageResolutionKind
    switch context.kind {
    case .stableStoreFailure:
      kind = .stableStoreFailure
    case .cleanup(let terminalError):
      kind = .cleanup(terminalError)
    case .staging:
      context.isAwaiting = false
      context.cancellationObserved =
        context.cancellationObserved || cancellationObserved
      var reservation = token.reservation
      reservation.phase = .journalStageTransition(context)
      reservations[token.connectionID] = reservation
      return
    }
    reservations[token.connectionID] = Reservation(
      operationID: token.reservation.operationID,
      fingerprint: token.reservation.fingerprint,
      phase: .journalStageResolution(
        JournalStageResolutionContext(
          stage: context.stage,
          expected: token.expected,
          replacement: token.replacement,
          kind: kind,
          isAwaiting: false
        )
      )
    )
  }

  mutating func beginJournalStagingReconciliation(
    connectionID: UUID,
    operationID: UUID,
    fingerprint: OperationFingerprint
  ) throws(BrokerJournalError) -> JournalStageTransitionAwaitToken {
    guard
      var reservation = reservations[connectionID],
      reservation.operationID == operationID,
      reservation.fingerprint == fingerprint,
      case .journalStageTransition(var context) = reservation.phase,
      context.kind == .staging,
      !context.isAwaiting,
      records[connectionID] == context.stage.fallback,
      journalSnapshots[connectionID] == context.expected
    else {
      throw .casConflict
    }
    context.isAwaiting = true
    reservation.phase = .journalStageTransition(context)
    reservations[connectionID] = reservation
    return JournalStageTransitionAwaitToken(
      connectionID: connectionID,
      reservation: reservation,
      fallback: context.stage.fallback,
      expected: context.expected,
      replacement: context.replacement,
      cancellationObserved: context.cancellationObserved
    )
  }

  mutating func pauseJournalStableStoreFailureRequest(
    _ token: JournalStageStoreToken
  ) throws(BrokerJournalError) {
    try pauseJournalStageResolutionRequest(token, kind: .stableStoreFailure)
  }

  mutating func pauseJournalStageCleanupRequest(
    _ token: JournalStageStoreToken,
    terminalError: BrokerStateError
  ) throws(BrokerJournalError) {
    guard terminalError == .cancelled || terminalError == .storeUnavailable else {
      throw .invalidRecord
    }
    try pauseJournalStageResolutionRequest(token, kind: .cleanup(terminalError))
  }

  mutating func pauseJournalStageCleanupRequestAfterStaging(
    _ token: JournalStageTransitionAwaitToken,
    selectedStaging: BrokerJournalSnapshot?,
    terminalError: BrokerStateError
  ) throws(BrokerJournalError) {
    let context = try validatedJournalStageTransition(token)
    guard
      context.kind == .staging,
      terminalError == .cancelled || terminalError == .storeUnavailable
    else {
      throw .invalidRecord
    }
    let expected: BrokerJournalSnapshot
    if let selectedStaging {
      guard selectedStaging.record == token.replacement else {
        throw .casConflict
      }
      expected = selectedStaging
      journalSnapshots[token.connectionID] = selectedStaging
    } else {
      expected = token.expected
    }
    reservations[token.connectionID] = Reservation(
      operationID: token.reservation.operationID,
      fingerprint: token.reservation.fingerprint,
      phase: .journalStageResolutionRequest(
        JournalStageResolutionRequestContext(
          stage: context.stage,
          expected: expected,
          kind: .cleanup(terminalError)
        )
      )
    )
  }

  func beginJournalStageResolutionRequest(
    connectionID: UUID,
    operationID: UUID,
    fingerprint: OperationFingerprint
  ) throws(BrokerJournalError) -> JournalStageResolutionRequestToken {
    guard
      let reservation = reservations[connectionID],
      reservation.operationID == operationID,
      reservation.fingerprint == fingerprint,
      case .journalStageResolutionRequest(let context) = reservation.phase,
      records[connectionID] == context.stage.fallback,
      journalSnapshots[connectionID] == context.expected
    else {
      throw .casConflict
    }
    return JournalStageResolutionRequestToken(
      connectionID: connectionID,
      reservation: reservation,
      fallback: context.stage.fallback,
      expected: context.expected
    )
  }

  mutating func finishJournalStageResolutionRequest(
    _ token: JournalStageResolutionRequestToken,
    changedAt: JournalTimestamp
  ) throws(BrokerJournalError) {
    guard
      reservations[token.connectionID] == token.reservation,
      case .journalStageResolutionRequest(let context) = token.reservation.phase,
      context.stage.fallback == token.fallback,
      context.expected == token.expected,
      records[token.connectionID] == token.fallback,
      journalSnapshots[token.connectionID] == token.expected
    else {
      throw .casConflict
    }
    let replacement: BrokerJournalRecord
    switch context.kind {
    case .stableStoreFailure:
      replacement = try BrokerJournalRecordAdapter.makeStableStoreFailure(
        predecessor: token.expected.record,
        changedAt: changedAt
      )
    case .cleanup(let terminalError):
      let journalError: BrokerJournalStageError
      switch terminalError {
      case .cancelled:
        journalError = .cancelled
      case .storeUnavailable:
        journalError = .storeUnavailable
      default:
        throw .invalidRecord
      }
      replacement = try BrokerJournalRecordAdapter.makeStageCleanupPending(
        predecessor: token.expected.record,
        error: journalError,
        changedAt: changedAt
      )
    }
    reservations[token.connectionID] = Reservation(
      operationID: token.reservation.operationID,
      fingerprint: token.reservation.fingerprint,
      phase: .journalStageResolution(
        JournalStageResolutionContext(
          stage: context.stage,
          expected: token.expected,
          replacement: replacement,
          kind: context.kind,
          isAwaiting: false
        )
      )
    )
  }

  mutating func prepareJournalStageCleanupAfterStaging(
    _ token: JournalStageTransitionAwaitToken,
    selectedStaging: BrokerJournalSnapshot?,
    terminalError: BrokerStateError,
    changedAt: JournalTimestamp
  ) throws(BrokerJournalError) {
    let context = try validatedJournalStageTransition(token)
    guard context.kind == .staging else {
      throw .invalidRecord
    }
    let journalError: BrokerJournalStageError
    switch terminalError {
    case .cancelled:
      journalError = .cancelled
    case .storeUnavailable:
      journalError = .storeUnavailable
    default:
      throw .invalidRecord
    }

    let expected: BrokerJournalSnapshot
    if let selectedStaging {
      guard selectedStaging.record == token.replacement else {
        throw .casConflict
      }
      expected = selectedStaging
      journalSnapshots[token.connectionID] = selectedStaging
    } else {
      expected = token.expected
    }
    let replacement = try BrokerJournalRecordAdapter.makeStageCleanupPending(
      predecessor: expected.record,
      error: journalError,
      changedAt: changedAt
    )
    reservations[token.connectionID] = Reservation(
      operationID: token.reservation.operationID,
      fingerprint: token.reservation.fingerprint,
      phase: .journalStageResolution(
        JournalStageResolutionContext(
          stage: context.stage,
          expected: expected,
          replacement: replacement,
          kind: .cleanup(terminalError),
          isAwaiting: false
        )
      )
    )
  }

  mutating func beginJournalStageResolution(
    connectionID: UUID,
    operationID: UUID,
    fingerprint: OperationFingerprint
  ) throws(BrokerJournalError) -> JournalStageResolutionAwaitToken {
    guard
      var reservation = reservations[connectionID],
      reservation.operationID == operationID,
      reservation.fingerprint == fingerprint,
      case .journalStageResolution(var context) = reservation.phase,
      !context.isAwaiting,
      records[connectionID] == context.stage.fallback,
      journalSnapshots[connectionID] == context.expected
    else {
      throw .casConflict
    }
    context.isAwaiting = true
    reservation.phase = .journalStageResolution(context)
    reservations[connectionID] = reservation
    return JournalStageResolutionAwaitToken(
      connectionID: connectionID,
      reservation: reservation,
      fallback: context.stage.fallback,
      expected: context.expected,
      replacement: context.replacement
    )
  }

  func classifyJournalStageResolutionSelection(
    _ token: JournalStageResolutionAwaitToken,
    selected: BrokerJournalSnapshot?
  ) throws(BrokerJournalError) -> JournalStageResolutionSelection {
    _ = try validatedJournalStageResolution(token)
    if selected == token.expected {
      return .expected
    }
    return .unrelated
  }

  mutating func finishJournalStageResolution(
    _ token: JournalStageResolutionAwaitToken,
    result: Result<BrokerJournalSnapshot, BrokerJournalError>
  ) throws(BrokerJournalError) -> JournalStageResolutionCompletion {
    let context = try validatedJournalStageResolution(token)
    let selected: BrokerJournalSnapshot
    switch result {
    case .failure(let error):
      restoreJournalStageResolution(token: token, context: context)
      throw error
    case .success(let value):
      guard value.record == token.replacement else {
        restoreJournalStageResolution(token: token, context: context)
        throw .casConflict
      }
      selected = value
    }

    journalSnapshots[token.connectionID] = selected
    switch context.kind {
    case .stableStoreFailure:
      let outcome = TerminalOutcome.stage(.failure(.storeUnavailable))
      reservations.removeValue(forKey: token.connectionID)
      memoize(
        connectionID: token.connectionID,
        operationID: token.reservation.operationID,
        fingerprint: token.reservation.fingerprint,
        outcome: outcome
      )
      return .terminal(outcome)

    case .cleanup(let terminalError):
      reservations[token.connectionID] = cleanupReservation(
        operationID: token.reservation.operationID,
        fingerprint: token.reservation.fingerprint,
        outcome: .stage(.failure(terminalError)),
        linearizedRecord: token.fallback,
        keys: [context.stage.candidateKey],
        journal: JournalCleanupContext(snapshot: selected)
      )
      return .cleanup
    }
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

  func abortProposal(
    connectionID: UUID,
    attemptID: UUID,
    operationID: UUID,
    fingerprint: OperationFingerprint
  ) throws(BrokerStateError) -> AbortProposal {
    let current = try currentMutableRecord(
      connectionID: connectionID,
      expectedFence: fingerprint.expectedFence
    )
    guard case .staging(let attempt) = current, attempt.attemptID == attemptID else {
      throw .attemptNotCurrent
    }
    return AbortProposal(
      connectionID: connectionID,
      operationID: operationID,
      fingerprint: fingerprint,
      record: current,
      attempt: attempt
    )
  }

  mutating func reserveJournalCommit(
    proposal: CommitProposal,
    capturedAt: JournalTimestamp
  ) throws(BrokerJournalError) -> JournalAuthorityAwaitToken {
    guard
      proposal.fingerprint.kind == .commit,
      proposal.fingerprint.connectionID == proposal.connectionID,
      proposal.fingerprint.attemptID == proposal.attempt.attemptID,
      let expected = journalSnapshots[proposal.connectionID],
      records[proposal.connectionID] == proposal.record
    else {
      throw .casConflict
    }
    let replacement = try BrokerJournalRecordAdapter.makeCommitAuthority(
      predecessor: expected.record,
      operationID: proposal.operationID,
      capturedAt: capturedAt
    )
    return try reserveJournalAuthority(
      connectionID: proposal.connectionID,
      operationID: proposal.operationID,
      fingerprint: proposal.fingerprint,
      current: proposal.record,
      expected: expected,
      replacement: replacement
    )
  }

  mutating func reserveJournalAbort(
    proposal: AbortProposal,
    changedAt: JournalTimestamp
  ) throws(BrokerJournalError) -> JournalAuthorityAwaitToken {
    guard
      proposal.fingerprint.kind == .abort,
      proposal.fingerprint.connectionID == proposal.connectionID,
      proposal.fingerprint.attemptID == proposal.attempt.attemptID,
      let expected = journalSnapshots[proposal.connectionID],
      records[proposal.connectionID] == proposal.record
    else {
      throw .casConflict
    }
    let replacement = try BrokerJournalRecordAdapter.makeAbortCleanupPending(
      predecessor: expected.record,
      operationID: proposal.operationID,
      changedAt: changedAt
    )
    return try reserveJournalAuthority(
      connectionID: proposal.connectionID,
      operationID: proposal.operationID,
      fingerprint: proposal.fingerprint,
      current: proposal.record,
      expected: expected,
      replacement: replacement
    )
  }

  mutating func reserveJournalDisconnect(
    proposal: DisconnectProposal,
    capturedAt: JournalTimestamp
  ) throws(BrokerJournalError) -> JournalAuthorityAwaitToken {
    guard
      proposal.fingerprint.kind == .disconnect,
      proposal.fingerprint.connectionID == proposal.connectionID,
      proposal.fingerprint.attemptID == nil,
      proposal.fingerprint.expectedFence == proposal.record.fence,
      let expected = journalSnapshots[proposal.connectionID],
      records[proposal.connectionID] == proposal.record
    else {
      throw .casConflict
    }
    let replacement = try BrokerJournalRecordAdapter.makeDisconnectFenced(
      predecessor: expected.record,
      operationID: proposal.operationID,
      capturedAt: capturedAt
    )
    return try reserveJournalAuthority(
      connectionID: proposal.connectionID,
      operationID: proposal.operationID,
      fingerprint: proposal.fingerprint,
      current: proposal.record,
      expected: expected,
      replacement: replacement
    )
  }

  mutating func finishJournalAuthority(
    _ token: JournalAuthorityAwaitToken,
    result: Result<BrokerJournalSnapshot, BrokerJournalError>
  ) throws(BrokerJournalError) -> JournalAuthorityCompletion {
    guard
      reservations[token.connectionID] == token.reservation,
      case .journalAuthority(let context) = token.reservation.phase,
      context.current == token.current,
      context.expected == token.expected,
      context.replacement == token.replacement,
      records[token.connectionID] == token.current,
      journalSnapshots[token.connectionID] == token.expected
    else {
      throw .casConflict
    }

    let selected: BrokerJournalSnapshot
    switch result {
    case .failure(let error):
      switch error {
      case .revisionOverflow, .casConflict, .lockUnavailable, .storageUnavailable:
        reservations.removeValue(forKey: token.connectionID)
      default:
        break
      }
      throw error
    case .success(let value):
      guard value.record == token.replacement else {
        throw .casConflict
      }
      selected = value
    }

    records[token.connectionID] = context.linearizedRecord
    journalSnapshots[token.connectionID] = selected
    if context.requiresFinalization {
      reservations[token.connectionID] = cleanupReservation(
        operationID: token.reservation.operationID,
        fingerprint: token.reservation.fingerprint,
        outcome: context.terminalOutcome,
        linearizedRecord: context.linearizedRecord,
        keys: context.cleanupKeys,
        journal: JournalCleanupContext(snapshot: selected)
      )
      return .cleanup(context.terminalOutcome)
    }

    reservations.removeValue(forKey: token.connectionID)
    memoize(
      connectionID: token.connectionID,
      operationID: token.reservation.operationID,
      fingerprint: token.reservation.fingerprint,
      outcome: context.terminalOutcome
    )
    return .completed(context.terminalOutcome)
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
    let proposal = try abortProposal(
      connectionID: connectionID,
      attemptID: attemptID,
      operationID: operationID,
      fingerprint: fingerprint
    )
    let attempt = proposal.attempt

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
      guard cleanup.journal == nil else {
        throw .cleanupPending
      }
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

  mutating func beginJournalCleanup(
    connectionID: UUID
  ) throws(BrokerJournalError) -> JournalCleanupStep {
    guard
      var reservation = reservations[connectionID],
      case .cleanup(var cleanup) = reservation.phase,
      let journal = cleanup.journal,
      records[connectionID] == cleanup.linearizedRecord,
      journalSnapshots[connectionID] == journal.snapshot,
      !cleanup.isAwaiting
    else {
      throw .casConflict
    }

    if let key = cleanup.remainingKeys.first {
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

    return .needsFinalization(
      JournalFinalizationRequestToken(
        connectionID: connectionID,
        reservation: reservation,
        linearizedRecord: cleanup.linearizedRecord,
        expected: journal.snapshot
      )
    )
  }

  mutating func finishJournalDeleteAwait(
    _ token: CleanupAwaitToken,
    succeeded: Bool
  ) throws(BrokerJournalError) {
    guard
      reservations[token.connectionID] == token.reservation,
      records[token.connectionID] == token.linearizedRecord,
      var reservation = reservations[token.connectionID],
      case .cleanup(var cleanup) = reservation.phase,
      cleanup.journal != nil,
      cleanup.isAwaiting
    else {
      throw .casConflict
    }
    try Self.validateJournalDeleteAwait(
      token,
      liveSnapshot: journalSnapshots[token.connectionID]
    )
    if succeeded {
      guard !cleanup.remainingKeys.isEmpty else {
        throw .casConflict
      }
      cleanup.remainingKeys.removeFirst()
    }
    cleanup.isAwaiting = false
    reservation.phase = .cleanup(cleanup)
    reservations[token.connectionID] = reservation
  }

  static func validateJournalDeleteAwait(
    _ token: CleanupAwaitToken,
    liveSnapshot: BrokerJournalSnapshot?
  ) throws(BrokerJournalError) {
    guard
      case .cleanup(let cleanup) = token.reservation.phase,
      let expected = cleanup.journal?.snapshot,
      liveSnapshot == expected
    else {
      throw .casConflict
    }
  }

  mutating func beginJournalFinalization(
    _ request: JournalFinalizationRequestToken,
    changedAt: JournalTimestamp
  ) throws(BrokerJournalError) -> JournalFinalizationAwaitToken {
    guard
      reservations[request.connectionID] == request.reservation,
      records[request.connectionID] == request.linearizedRecord,
      journalSnapshots[request.connectionID] == request.expected,
      var reservation = reservations[request.connectionID],
      case .cleanup(var cleanup) = reservation.phase,
      cleanup.remainingKeys.isEmpty,
      !cleanup.isAwaiting,
      cleanup.journal?.snapshot == request.expected
    else {
      throw .casConflict
    }

    let replacement = try Self.stableJournalSuccessor(
      to: request.expected.record,
      changedAt: changedAt
    )
    cleanup.isAwaiting = true
    reservation.phase = .cleanup(cleanup)
    reservations[request.connectionID] = reservation
    return JournalFinalizationAwaitToken(
      connectionID: request.connectionID,
      reservation: reservation,
      linearizedRecord: request.linearizedRecord,
      expected: request.expected,
      replacement: replacement
    )
  }

  mutating func finishJournalFinalization(
    _ token: JournalFinalizationAwaitToken,
    result: Result<BrokerJournalSnapshot, BrokerJournalError>
  ) throws(BrokerJournalError) -> TerminalOutcome {
    guard
      reservations[token.connectionID] == token.reservation,
      records[token.connectionID] == token.linearizedRecord,
      journalSnapshots[token.connectionID] == token.expected,
      var reservation = reservations[token.connectionID],
      case .cleanup(var cleanup) = reservation.phase,
      cleanup.remainingKeys.isEmpty,
      cleanup.isAwaiting,
      cleanup.journal?.snapshot == token.expected
    else {
      throw .casConflict
    }

    switch result {
    case .failure(let error):
      cleanup.isAwaiting = false
      reservation.phase = .cleanup(cleanup)
      reservations[token.connectionID] = reservation
      throw error

    case .success(let selected):
      guard selected.record == token.replacement else {
        cleanup.isAwaiting = false
        reservation.phase = .cleanup(cleanup)
        reservations[token.connectionID] = reservation
        throw .casConflict
      }
      journalSnapshots[token.connectionID] = selected
      reservations.removeValue(forKey: token.connectionID)
      memoize(
        connectionID: token.connectionID,
        operationID: reservation.operationID,
        fingerprint: reservation.fingerprint,
        outcome: cleanup.terminalOutcome
      )
      return cleanup.terminalOutcome
    }
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
    case .journalStageReservation, .storing, .journalAuthority:
      return .reject(.operationInProgress)
    case .journalStageTransition(let transition):
      guard !transition.isAwaiting else {
        return .reject(.operationInProgress)
      }
      guard
        reservation.operationID == operationID,
        reservation.fingerprint == fingerprint,
        transition.kind == .staging
      else {
        return .reject(.cleanupPending)
      }
      return .resumeJournalStaging
    case .journalStageResolutionRequest:
      guard
        reservation.operationID == operationID,
        reservation.fingerprint == fingerprint
      else {
        return .reject(.cleanupPending)
      }
      return .resumeStageResolutionRequest
    case .journalStageResolution(let resolution):
      if resolution.isAwaiting {
        return .reject(.operationInProgress)
      }
      guard
        reservation.operationID == operationID,
        reservation.fingerprint == fingerprint
      else {
        return .reject(.cleanupPending)
      }
      return .resumeStageResolution
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

  private func canBeginAuthoritativeProjection(connectionID: UUID) -> Bool {
    guard let reservation = reservations[connectionID] else {
      return true
    }
    switch reservation.phase {
    case .journalStageResolutionRequest:
      return true
    case .journalStageResolution(let resolution):
      return !resolution.isAwaiting
    case .cleanup(let cleanup):
      return cleanup.journal != nil && !cleanup.isAwaiting
    case .journalStageReservation, .storing, .journalStageTransition, .journalAuthority:
      return false
    }
  }

  private static func isSevereJournalHealthError(_ error: BrokerJournalError) -> Bool {
    switch error {
    case .invalidRecord, .nonCanonical, .unsupportedVersion, .authenticationFailed,
      .rollbackDetected:
      true
    case .revisionOverflow, .casConflict, .lockUnavailable, .storageUnavailable,
      .mutationOutcomeUnknown:
      false
    }
  }

  private static func matchesStageResume(
    _ fingerprint: OperationFingerprint,
    connectionID: UUID,
    expectedFence: UInt64
  ) -> Bool {
    fingerprint.kind == .stage
      && fingerprint.connectionID == connectionID
      && fingerprint.expectedFence == expectedFence
      && fingerprint.attemptID == nil
      && fingerprint.providerBinding != nil
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

  private mutating func beginJournalStageTransition(
    _ token: JournalStageStoreToken,
    replacement: BrokerJournalRecord,
    kind: JournalStageTransitionKind
  ) throws(BrokerJournalError) -> JournalStageTransitionAwaitToken {
    guard
      reservations[token.connectionID] == token.reservation,
      case .storing(let stage) = token.reservation.phase,
      records[token.connectionID] == token.fallback,
      stage.fallback == token.fallback,
      journalSnapshots[token.connectionID] == token.expected
    else {
      throw .casConflict
    }

    let reservation = Reservation(
      operationID: token.reservation.operationID,
      fingerprint: token.reservation.fingerprint,
      phase: .journalStageTransition(
        JournalStageTransitionContext(
          stage: stage,
          expected: token.expected,
          replacement: replacement,
          kind: kind,
          isAwaiting: true,
          cancellationObserved: false
        )
      )
    )
    reservations[token.connectionID] = reservation
    return JournalStageTransitionAwaitToken(
      connectionID: token.connectionID,
      reservation: reservation,
      fallback: token.fallback,
      expected: token.expected,
      replacement: replacement,
      cancellationObserved: false
    )
  }

  private mutating func reserveJournalAuthority(
    connectionID: UUID,
    operationID: UUID,
    fingerprint: OperationFingerprint,
    current: Record,
    expected: BrokerJournalSnapshot,
    replacement: BrokerJournalRecord
  ) throws(BrokerJournalError) -> JournalAuthorityAwaitToken {
    guard
      records[connectionID] == current,
      reservations[connectionID] == nil,
      journalSnapshots[connectionID] == expected,
      expected.record.connectionID == connectionID,
      replacement.connectionID == connectionID
    else {
      throw .casConflict
    }

    let plan = try BrokerJournalRecordAdapter.recoveryPlan(
      for: replacement,
      recoveryChangedAt: replacement.changedAt
    )
    guard plan.preparation == nil else {
      throw .invalidRecord
    }
    let terminal: BrokerJournalTerminalOperation
    let cleanupKeys: [CredentialStoreKey]
    let requiresFinalization: Bool
    if let cleanup = plan.cleanup {
      terminal = cleanup.terminalOperation
      cleanupKeys = cleanup.credentialKeys
      requiresFinalization = true
    } else {
      let matches = replacement.terminalOperations.filter {
        $0.operationID == operationID
      }
      guard matches.count == 1, let match = matches.first else {
        throw .invalidRecord
      }
      terminal = match
      cleanupKeys = []
      requiresFinalization = false
    }
    guard terminal.operationID == operationID else {
      throw .invalidRecord
    }
    let hydrated = try Self.hydratedTerminal(
      terminal,
      connectionID: connectionID,
      providerBinding: replacement.providerBinding
    )
    guard hydrated.fingerprint == fingerprint else {
      throw .invalidRecord
    }
    let linearizedRecord = Self.record(from: plan.bootstrap)
    let context = JournalAuthorityContext(
      current: current,
      expected: expected,
      replacement: replacement,
      linearizedRecord: linearizedRecord,
      terminalOutcome: hydrated.outcome,
      cleanupKeys: cleanupKeys,
      requiresFinalization: requiresFinalization
    )
    let reservation = Reservation(
      operationID: operationID,
      fingerprint: fingerprint,
      phase: .journalAuthority(context)
    )
    reservations[connectionID] = reservation
    return JournalAuthorityAwaitToken(
      connectionID: connectionID,
      reservation: reservation,
      current: current,
      expected: expected,
      replacement: replacement
    )
  }

  private mutating func pauseJournalStageResolutionRequest(
    _ token: JournalStageStoreToken,
    kind: JournalStageResolutionKind
  ) throws(BrokerJournalError) {
    guard
      reservations[token.connectionID] == token.reservation,
      case .storing(let stage) = token.reservation.phase,
      stage.fallback == token.fallback,
      records[token.connectionID] == token.fallback,
      journalSnapshots[token.connectionID] == token.expected
    else {
      throw .casConflict
    }
    reservations[token.connectionID] = Reservation(
      operationID: token.reservation.operationID,
      fingerprint: token.reservation.fingerprint,
      phase: .journalStageResolutionRequest(
        JournalStageResolutionRequestContext(
          stage: stage,
          expected: token.expected,
          kind: kind
        )
      )
    )
  }

  private mutating func selectJournalStageTransition(
    _ token: JournalStageTransitionAwaitToken,
    result: Result<BrokerJournalSnapshot, BrokerJournalError>,
    kind: JournalStageTransitionKind
  ) throws(BrokerJournalError) -> (
    context: JournalStageTransitionContext,
    selected: BrokerJournalSnapshot
  ) {
    guard
      reservations[token.connectionID] == token.reservation,
      case .journalStageTransition(let context) = token.reservation.phase,
      context.expected == token.expected,
      context.replacement == token.replacement,
      context.cancellationObserved == token.cancellationObserved,
      context.kind == kind,
      context.stage.fallback == token.fallback,
      records[token.connectionID] == token.fallback,
      journalSnapshots[token.connectionID] == token.expected
    else {
      throw .casConflict
    }

    let selected: BrokerJournalSnapshot
    switch result {
    case .failure(let error):
      restoreJournalStageStoring(token: token, context: context)
      throw error
    case .success(let value):
      guard value.record == token.replacement else {
        restoreJournalStageStoring(token: token, context: context)
        throw .casConflict
      }
      selected = value
    }
    return (context, selected)
  }

  private mutating func restoreJournalStageStoring(
    token: JournalStageTransitionAwaitToken,
    context: JournalStageTransitionContext
  ) {
    reservations[token.connectionID] = Reservation(
      operationID: token.reservation.operationID,
      fingerprint: token.reservation.fingerprint,
      phase: .storing(context.stage)
    )
  }

  private func validatedJournalStageTransition(
    _ token: JournalStageTransitionAwaitToken
  ) throws(BrokerJournalError) -> JournalStageTransitionContext {
    guard
      reservations[token.connectionID] == token.reservation,
      case .journalStageTransition(let context) = token.reservation.phase,
      context.expected == token.expected,
      context.replacement == token.replacement,
      context.cancellationObserved == token.cancellationObserved,
      context.stage.fallback == token.fallback,
      records[token.connectionID] == token.fallback,
      journalSnapshots[token.connectionID] == token.expected
    else {
      throw .casConflict
    }
    return context
  }

  private func validatedJournalStageResolution(
    _ token: JournalStageResolutionAwaitToken
  ) throws(BrokerJournalError) -> JournalStageResolutionContext {
    guard
      reservations[token.connectionID] == token.reservation,
      case .journalStageResolution(let context) = token.reservation.phase,
      context.isAwaiting,
      context.expected == token.expected,
      context.replacement == token.replacement,
      context.stage.fallback == token.fallback,
      records[token.connectionID] == token.fallback,
      journalSnapshots[token.connectionID] == token.expected
    else {
      throw .casConflict
    }
    return context
  }

  private mutating func restoreJournalStageResolution(
    token: JournalStageResolutionAwaitToken,
    context: JournalStageResolutionContext
  ) {
    var paused = context
    paused.isAwaiting = false
    reservations[token.connectionID] = Reservation(
      operationID: token.reservation.operationID,
      fingerprint: token.reservation.fingerprint,
      phase: .journalStageResolution(paused)
    )
  }

  private func cleanupReservation(
    operationID: UUID,
    fingerprint: OperationFingerprint,
    outcome: TerminalOutcome,
    linearizedRecord: Record,
    keys: [CredentialStoreKey],
    journal: JournalCleanupContext? = nil
  ) -> Reservation {
    Reservation(
      operationID: operationID,
      fingerprint: fingerprint,
      phase: .cleanup(
        CleanupContext(
          terminalOutcome: outcome,
          linearizedRecord: linearizedRecord,
          remainingKeys: keys,
          isAwaiting: false,
          journal: journal
        )
      )
    )
  }

  private static func record(from bootstrap: CredentialBootstrap) -> Record {
    switch bootstrap {
    case .vacant(let connectionID, let fence, let lastGenerationOrdinal):
      .vacant(
        connectionID: connectionID,
        fence: fence,
        lastGenerationOrdinal: lastGenerationOrdinal
      )
    case .ready(let projection):
      .ready(projection)
    case .tombstoned(let projection):
      .tombstoned(projection)
    }
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

  private static func hydratedTerminal(
    _ terminal: BrokerJournalTerminalOperation,
    connectionID: UUID,
    providerBinding: ProviderProfileBinding
  ) throws(BrokerJournalError) -> (
    fingerprint: OperationFingerprint,
    outcome: TerminalOutcome
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
        fingerprint(
          kind: .stage,
          connectionID: connectionID,
          expectedFence: value.expectedFence,
          providerBinding: providerBinding
        ),
        .stage(.failure(error))
      )

    case .commit(let value):
      return (
        fingerprint(
          kind: .commit,
          connectionID: connectionID,
          expectedFence: value.expectedFence,
          attemptID: value.attemptID
        ),
        .commit(
          .success(try BrokerJournalRecordAdapter.readyProjection(from: value.ready))
        )
      )

    case .abort(let value):
      let restored: ReadyProjection?
      if let journalReady = value.restoredReady {
        restored = try BrokerJournalRecordAdapter.readyProjection(from: journalReady)
      } else {
        restored = nil
      }
      return (
        fingerprint(
          kind: .abort,
          connectionID: connectionID,
          expectedFence: value.expectedFence,
          attemptID: value.attemptID
        ),
        .abort(.success(restored))
      )

    case .disconnect(let value):
      return (
        fingerprint(
          kind: .disconnect,
          connectionID: connectionID,
          expectedFence: value.expectedFence
        ),
        .disconnect(
          .success(
            try BrokerJournalRecordAdapter.tombstoneProjection(from: value.tombstone)
          )
        )
      )
    }
  }

  private static func hasAttemptCollision(
    _ cleanup: BrokerJournalTerminalOperation,
    with persisted: [BrokerJournalTerminalOperation]
  ) -> Bool {
    guard let cleanupAttemptID = journalAttemptID(of: cleanup) else {
      return false
    }
    return persisted.contains { journalAttemptID(of: $0) == cleanupAttemptID }
  }

  private static func journalAttemptID(
    of terminal: BrokerJournalTerminalOperation
  ) -> UUID? {
    switch terminal {
    case .stageFailure, .disconnect:
      nil
    case .commit(let value):
      value.attemptID
    case .abort(let value):
      value.attemptID
    }
  }

  private static func stableJournalSuccessor(
    to predecessor: BrokerJournalRecord,
    changedAt: JournalTimestamp
  ) throws(BrokerJournalError) -> BrokerJournalRecord {
    switch predecessor.phase {
    case .stageCleanupPending:
      try BrokerJournalRecordAdapter.makeStableStageFailure(
        predecessor: predecessor,
        changedAt: changedAt
      )
    case .readyCleanupPending:
      try BrokerJournalRecordAdapter.makeStableCommit(
        predecessor: predecessor,
        changedAt: changedAt
      )
    case .abortCleanupPending:
      try BrokerJournalRecordAdapter.makeStableAbort(
        predecessor: predecessor,
        changedAt: changedAt
      )
    case .disconnectFenced:
      try BrokerJournalRecordAdapter.makeTombstoned(
        predecessor: predecessor,
        changedAt: changedAt
      )
    default:
      throw .invalidRecord
    }
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
