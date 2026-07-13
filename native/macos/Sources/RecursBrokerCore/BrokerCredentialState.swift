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
  private let store: any CredentialStore
  private let clock: @Sendable () -> Date
  private let generationIDSource: @Sendable () -> UUID
  private let attemptIDSource: @Sendable () -> UUID
  private let journal: (any BrokerJournalStore)?
  private var machine: BrokerCredentialStateMachine

  package init(
    store: any CredentialStore,
    bootstrap: [CredentialBootstrap] = [],
    clock: @escaping @Sendable () -> Date = { Date() },
    generationIDSource: @escaping @Sendable () -> UUID = { UUID() },
    attemptIDSource: @escaping @Sendable () -> UUID = { UUID() }
  ) throws(BrokerStateError) {
    self.store = store
    self.journal = nil
    self.machine = try BrokerCredentialStateMachine(bootstrap: bootstrap)
    self.clock = clock
    self.generationIDSource = generationIDSource
    self.attemptIDSource = attemptIDSource
  }

  private init(
    store: any CredentialStore,
    journal: any BrokerJournalStore,
    preparedJournalEntries: [BrokerJournalPreparedEntry],
    clock: @escaping @Sendable () -> Date,
    generationIDSource: @escaping @Sendable () -> UUID,
    attemptIDSource: @escaping @Sendable () -> UUID
  ) throws(BrokerJournalError) {
    self.store = store
    self.journal = journal
    self.machine = try BrokerCredentialStateMachine(
      preparedJournalEntries: preparedJournalEntries
    )
    self.clock = clock
    self.generationIDSource = generationIDSource
    self.attemptIDSource = attemptIDSource
  }

  static func recoveringForTests(
    store: any CredentialStore,
    journal: any BrokerJournalStore,
    clock: @escaping @Sendable () -> Date = { Date() },
    generationIDSource: @escaping @Sendable () -> UUID = { UUID() },
    attemptIDSource: @escaping @Sendable () -> UUID = { UUID() }
  ) async throws(BrokerJournalError) -> BrokerCredentialState {
    let prepared = try await BrokerJournalRecovery.prepare(
      journal: journal,
      clock: clock
    )
    let state = try BrokerCredentialState(
      store: store,
      journal: journal,
      preparedJournalEntries: prepared,
      clock: clock,
      generationIDSource: generationIDSource,
      attemptIDSource: attemptIDSource
    )
    for entry in prepared where entry.plan.cleanup != nil {
      do {
        _ = try await state.resumeRecoveredCleanupForTests(
          connectionID: entry.snapshot.record.connectionID
        )
      } catch let error as BrokerStateError {
        guard error == .cleanupPending else {
          throw BrokerJournalError.invalidRecord
        }
      } catch let error as BrokerJournalError {
        throw error
      } catch {
        throw BrokerJournalError.invalidRecord
      }
    }
    return state
  }

  package func projection(for connectionID: UUID) -> CredentialProjection? {
    machine.projection(for: connectionID)
  }

  package func stage(
    connectionID: UUID,
    operationID: UUID,
    expectedFence: UInt64,
    secret: sending SecretBytes
  ) async throws(BrokerStateError) -> StagingAttempt {
    let fingerprint = BrokerCredentialStateMachine.fingerprint(
      kind: .stage,
      connectionID: connectionID,
      expectedFence: expectedFence
    )

    let preflight: BrokerCredentialStateMachine.PreflightDisposition
    do {
      preflight = try machine.preflight(
        connectionID: connectionID,
        operationID: operationID,
        fingerprint: fingerprint
      )
    } catch let error {
      secret.erase()
      throw error
    }

    switch preflight {
    case .replay(let outcome):
      secret.erase()
      return try machine.resolveStage(outcome)
    case .resumeCleanup:
      secret.erase()
      guard journal == nil else {
        throw .cleanupPending
      }
      return try machine.resolveStage(
        await continueCleanup(
          connectionID: connectionID,
          operationID: operationID,
          fingerprint: fingerprint
        )
      )
    case .proceed:
      break
    }

    guard !Task.isCancelled else {
      secret.erase()
      throw .cancelled
    }
    guard journal == nil else {
      secret.erase()
      throw .storeUnavailable
    }

    let proposal: BrokerCredentialStateMachine.StageProposal
    do {
      proposal = try machine.stageProposal(
        connectionID: connectionID,
        expectedFence: expectedFence
      )
    } catch let error {
      secret.erase()
      throw error
    }

    let generationID = generationIDSource()
    let createdAt = clock()
    let attemptID = attemptIDSource()
    let startedAt = clock()
    let token = try machine.reserveStage(
      proposal: proposal,
      operationID: operationID,
      fingerprint: fingerprint,
      generationID: generationID,
      createdAt: createdAt,
      attemptID: attemptID,
      startedAt: startedAt
    )

    guard !Task.isCancelled else {
      secret.erase()
      return try machine.resolveStage(try machine.cancelStageBeforeStore(token))
    }

    do {
      try await store.store(secret, for: token.candidateKey)
    } catch let error {
      switch error {
      case .unavailable:
        return try machine.resolveStage(try machine.finishStageStoreUnavailable(token))
      case .mutationOutcomeUnknown:
        try machine.enterStageCleanup(token, terminalError: .storeUnavailable)
        return try machine.resolveStage(
          await continueCleanup(
            connectionID: connectionID,
            operationID: operationID,
            fingerprint: fingerprint
          )
        )
      }
    }

    try machine.validateStageReservation(token)
    if Task.isCancelled {
      try machine.enterStageCleanup(token, terminalError: .cancelled)
      return try machine.resolveStage(
        await continueCleanup(
          connectionID: connectionID,
          operationID: operationID,
          fingerprint: fingerprint
        )
      )
    }
    return try machine.publishStaging(token)
  }

  package func resumeStage(
    connectionID: UUID,
    operationID: UUID,
    expectedFence: UInt64
  ) async throws(BrokerStateError) -> StagingAttempt {
    let fingerprint = BrokerCredentialStateMachine.fingerprint(
      kind: .stage,
      connectionID: connectionID,
      expectedFence: expectedFence
    )
    switch try machine.preflight(
      connectionID: connectionID,
      operationID: operationID,
      fingerprint: fingerprint
    ) {
    case .replay(let outcome):
      return try machine.resolveStage(outcome)
    case .resumeCleanup:
      guard journal == nil else {
        throw .cleanupPending
      }
      return try machine.resolveStage(
        await continueCleanup(
          connectionID: connectionID,
          operationID: operationID,
          fingerprint: fingerprint
        )
      )
    case .proceed:
      break
    }
    guard !Task.isCancelled else {
      throw .cancelled
    }
    guard journal == nil else {
      throw .storeUnavailable
    }
    try machine.validateResumeStage(
      connectionID: connectionID,
      expectedFence: expectedFence
    )
  }

  package func commit(
    connectionID: UUID,
    attemptID: UUID,
    operationID: UUID,
    expectedFence: UInt64
  ) async throws(BrokerStateError) -> ReadyProjection {
    let fingerprint = BrokerCredentialStateMachine.fingerprint(
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
      return try machine.resolveCommit(outcome)
    case .resumeCleanup:
      return try machine.resolveCommit(
        await continueCleanup(
          connectionID: connectionID,
          operationID: operationID,
          fingerprint: fingerprint
        )
      )
    case .proceed:
      break
    }

    let proposal = try machine.commitProposal(
      connectionID: connectionID,
      attemptID: attemptID,
      operationID: operationID,
      fingerprint: fingerprint
    )
    switch try machine.linearizeCommit(proposal: proposal, committedAt: clock()) {
    case .completed(let ready):
      return ready
    case .cleanup:
      return try machine.resolveCommit(
        await continueCleanup(
          connectionID: connectionID,
          operationID: operationID,
          fingerprint: fingerprint
        )
      )
    }
  }

  package func abort(
    connectionID: UUID,
    attemptID: UUID,
    operationID: UUID,
    expectedFence: UInt64
  ) async throws(BrokerStateError) -> ReadyProjection? {
    let fingerprint = BrokerCredentialStateMachine.fingerprint(
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
      return try machine.resolveAbort(outcome)
    case .resumeCleanup:
      return try machine.resolveAbort(
        await continueCleanup(
          connectionID: connectionID,
          operationID: operationID,
          fingerprint: fingerprint
        )
      )
    case .proceed:
      break
    }

    _ = try machine.linearizeAbort(
      connectionID: connectionID,
      attemptID: attemptID,
      operationID: operationID,
      fingerprint: fingerprint
    )
    return try machine.resolveAbort(
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
    let fingerprint = BrokerCredentialStateMachine.fingerprint(
      kind: .disconnect,
      connectionID: connectionID,
      expectedFence: expectedFence
    )
    switch try preflight(
      connectionID: connectionID,
      operationID: operationID,
      fingerprint: fingerprint
    ) {
    case .replay(let outcome):
      return try machine.resolveDisconnect(outcome)
    case .resumeCleanup:
      return try machine.resolveDisconnect(
        await continueCleanup(
          connectionID: connectionID,
          operationID: operationID,
          fingerprint: fingerprint
        )
      )
    case .proceed:
      break
    }

    let proposal = try machine.disconnectProposal(
      connectionID: connectionID,
      operationID: operationID,
      fingerprint: fingerprint
    )
    switch try machine.linearizeDisconnect(proposal: proposal, tombstonedAt: clock()) {
    case .completed(let tombstone):
      return tombstone
    case .cleanup:
      return try machine.resolveDisconnect(
        await continueCleanup(
          connectionID: connectionID,
          operationID: operationID,
          fingerprint: fingerprint
        )
      )
    }
  }

  func resumeRecoveredCleanupForTests(
    connectionID: UUID
  ) async throws -> BrokerCredentialStateMachine.TerminalOutcome {
    try await continueRecoveredCleanup(connectionID: connectionID)
  }

  private func continueRecoveredCleanup(
    connectionID: UUID
  ) async throws -> BrokerCredentialStateMachine.TerminalOutcome {
    guard let journal else {
      throw BrokerJournalError.invalidRecord
    }
    while true {
      switch try machine.beginJournalCleanup(connectionID: connectionID) {
      case .delete(let key, let token):
        do {
          try await store.deleteIfPresent(key)
        } catch {
          try machine.finishJournalDeleteAwait(token, succeeded: false)
          throw BrokerStateError.cleanupPending
        }
        try machine.finishJournalDeleteAwait(token, succeeded: true)

      case .needsFinalization(let request):
        let changedAt = try BrokerJournalRecordAdapter.captureTimestamp(from: clock())
        let token = try machine.beginJournalFinalization(
          request,
          changedAt: changedAt
        )
        let result: Result<BrokerJournalSnapshot, BrokerJournalError>
        do {
          result = .success(
            try await journal.compareAndSwap(
              expected: token.expected,
              replacement: token.replacement
            )
          )
        } catch let error {
          result = .failure(error)
        }
        return try machine.finishJournalFinalization(token, result: result)
      }
    }
  }

  private func preflight(
    connectionID: UUID,
    operationID: UUID,
    fingerprint: BrokerCredentialStateMachine.OperationFingerprint
  ) throws(BrokerStateError) -> BrokerCredentialStateMachine.PreflightDisposition {
    let disposition = try machine.preflight(
      connectionID: connectionID,
      operationID: operationID,
      fingerprint: fingerprint
    )
    switch disposition {
    case .replay:
      return disposition
    case .resumeCleanup:
      if journal != nil {
        throw .cleanupPending
      }
      return disposition
    case .proceed:
      break
    }
    guard !Task.isCancelled else {
      throw .cancelled
    }
    guard journal == nil else {
      throw .storeUnavailable
    }
    return .proceed
  }

  private func continueCleanup(
    connectionID: UUID,
    operationID: UUID,
    fingerprint: BrokerCredentialStateMachine.OperationFingerprint
  ) async throws(BrokerStateError) -> BrokerCredentialStateMachine.TerminalOutcome {
    while true {
      switch try machine.beginCleanup(
        connectionID: connectionID,
        operationID: operationID,
        fingerprint: fingerprint
      ) {
      case .completed(let outcome):
        return outcome
      case .delete(let key, let token):
        do {
          try await store.deleteIfPresent(key)
        } catch {
          try machine.finishCleanupAwait(token, succeeded: false)
          throw .cleanupPending
        }
        try machine.finishCleanupAwait(token, succeeded: true)
      }
    }
  }
}
