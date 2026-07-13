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

  package func authoritativeProjection(
    for connectionID: UUID
  ) async throws(BrokerJournalError) -> CredentialProjection? {
    guard let journal else {
      return machine.projection(for: connectionID)
    }
    let token = try machine.beginAuthoritativeProjection(connectionID: connectionID)
    let result: Result<BrokerJournalSnapshot?, BrokerJournalError>
    do {
      result = .success(try await journal.load(connectionID: connectionID))
    } catch let error {
      result = .failure(error)
    }
    return try machine.finishAuthoritativeProjection(token, result: result)
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
    case .resumeJournalStaging:
      secret.erase()
      return try await continueJournalStagingReconciliation(
        connectionID: connectionID,
        operationID: operationID,
        fingerprint: fingerprint
      )
    case .resumeStageResolutionRequest:
      secret.erase()
      return try machine.resolveStage(
        await continueJournalStageResolutionRequest(
          connectionID: connectionID,
          operationID: operationID,
          fingerprint: fingerprint
        )
      )
    case .resumeStageResolution:
      secret.erase()
      return try machine.resolveStage(
        await continueJournalStageResolution(
          connectionID: connectionID,
          operationID: operationID,
          fingerprint: fingerprint
        )
      )
    case .resumeCleanup:
      secret.erase()
      if journal != nil {
        return try machine.resolveStage(
          await continueJournalCleanup(connectionID: connectionID)
        )
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

    if let journal {
      return try await stageWithJournal(
        journal: journal,
        proposal: proposal,
        operationID: operationID,
        fingerprint: fingerprint,
        secret: secret
      )
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

  private func stageWithJournal(
    journal: any BrokerJournalStore,
    proposal: BrokerCredentialStateMachine.StageProposal,
    operationID: UUID,
    fingerprint: BrokerCredentialStateMachine.OperationFingerprint,
    secret: sending SecretBytes
  ) async throws(BrokerStateError) -> StagingAttempt {
    let reservation: BrokerCredentialStateMachine.JournalStageReservationAwaitToken
    do {
      reservation = try machine.reserveJournalStage(
        proposal: proposal,
        operationID: operationID,
        fingerprint: fingerprint,
        generationID: generationIDSource(),
        attemptID: attemptIDSource(),
        capturedAt: BrokerJournalRecordAdapter.captureTimestamp(from: clock())
      )
    } catch {
      secret.erase()
      throw .storeUnavailable
    }

    let pendingResult: Result<BrokerJournalSnapshot, BrokerJournalError>
    do {
      pendingResult = .success(
        try await journal.compareAndSwap(
          expected: reservation.expected,
          replacement: reservation.replacement
        )
      )
    } catch let error {
      machine.recordJournalFailure(error)
      if error == .mutationOutcomeUnknown {
        let reconciliation: BrokerJournalCASReconciliation
        do {
          reconciliation = try await journal.reconcileCompareAndSwap(
            expected: reservation.expected,
            replacement: reservation.replacement
          )
        } catch let loadError {
          machine.recordJournalFailure(loadError)
          secret.erase()
          throw .cleanupPending
        }
        switch reconciliation {
        case .replacement(let selected):
          pendingResult = .success(selected)
        case .expected:
          pendingResult = .failure(.storageUnavailable)
        case .unrelated:
          secret.erase()
          throw .cleanupPending
        }
      } else {
        pendingResult = .failure(error)
      }
    }

    let storing: BrokerCredentialStateMachine.JournalStageStoreToken
    do {
      storing = try machine.finishJournalStageReservation(
        reservation,
        result: pendingResult
      )
    } catch {
      secret.erase()
      throw .storeUnavailable
    }

    if Task.isCancelled {
      secret.erase()
      return try await finishJournalStageCleanup(
        journal: journal,
        storing: storing,
        terminalError: .cancelled
      )
    }

    do {
      try await store.store(secret, for: storing.candidateKey)
    } catch let error {
      switch error {
      case .unavailable:
        if Task.isCancelled {
          return try await finishJournalStageCleanup(
            journal: journal,
            storing: storing,
            terminalError: .cancelled
          )
        }
        return try await finishJournalStableStoreFailure(
          journal: journal,
          storing: storing
        )
      case .mutationOutcomeUnknown:
        return try await finishJournalStageCleanup(
          journal: journal,
          storing: storing,
          terminalError: Task.isCancelled ? .cancelled : .storeUnavailable
        )
      }
    }

    if Task.isCancelled {
      return try await finishJournalStageCleanup(
        journal: journal,
        storing: storing,
        terminalError: .cancelled
      )
    }

    let stagingChangedAt: JournalTimestamp
    do {
      stagingChangedAt = try journalTimestamp()
    } catch {
      _ = try? machine.pauseJournalStageCleanupRequest(
        storing,
        terminalError: .storeUnavailable
      )
      throw .cleanupPending
    }
    let transition: BrokerCredentialStateMachine.JournalStageTransitionAwaitToken
    do {
      transition = try machine.beginJournalStaging(
        storing,
        changedAt: stagingChangedAt
      )
    } catch {
      _ = try? machine.pauseJournalStageCleanupRequest(
        storing,
        terminalError: .storeUnavailable
      )
      throw .cleanupPending
    }
    let selectedStaging: BrokerJournalSnapshot
    do {
      selectedStaging = try await journal.compareAndSwap(
        expected: transition.expected,
        replacement: transition.replacement
      )
    } catch let error {
      if machine.recordJournalFailure(error) {
        _ = try? machine.pauseJournalStageTransition(
          transition,
          cancellationObserved: Task.isCancelled
        )
        throw .cleanupPending
      }
      return try await recoverFromJournalStagingFailure(
        journal: journal,
        transition: transition,
        fingerprint: fingerprint
      )
    }
    if Task.isCancelled {
      let cleanupChangedAt: JournalTimestamp
      do {
        cleanupChangedAt = try journalTimestamp()
      } catch {
        _ = try? machine.pauseJournalStageCleanupRequestAfterStaging(
          transition,
          selectedStaging: selectedStaging,
          terminalError: .cancelled
        )
        throw .cleanupPending
      }
      do {
        try machine.prepareJournalStageCleanupAfterStaging(
          transition,
          selectedStaging: selectedStaging,
          terminalError: .cancelled,
          changedAt: cleanupChangedAt
        )
      } catch {
        throw .cleanupPending
      }
      return try machine.resolveStage(
        await continueJournalStageResolution(
          connectionID: transition.connectionID,
          operationID: transition.reservation.operationID,
          fingerprint: transition.reservation.fingerprint
        )
      )
    }
    do {
      return try machine.finishJournalStaging(
        transition,
        result: .success(selectedStaging)
      )
    } catch {
      throw .cleanupPending
    }
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
    case .resumeJournalStaging:
      return try await continueJournalStagingReconciliation(
        connectionID: connectionID,
        operationID: operationID,
        fingerprint: fingerprint
      )
    case .resumeStageResolutionRequest:
      return try machine.resolveStage(
        await continueJournalStageResolutionRequest(
          connectionID: connectionID,
          operationID: operationID,
          fingerprint: fingerprint
        )
      )
    case .resumeStageResolution:
      return try machine.resolveStage(
        await continueJournalStageResolution(
          connectionID: connectionID,
          operationID: operationID,
          fingerprint: fingerprint
        )
      )
    case .resumeCleanup:
      if journal != nil {
        return try machine.resolveStage(
          await continueJournalCleanup(connectionID: connectionID)
        )
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
    case .resumeJournalStaging:
      throw .cleanupPending
    case .resumeStageResolutionRequest:
      throw .cleanupPending
    case .resumeStageResolution:
      throw .cleanupPending
    case .resumeCleanup:
      if journal != nil {
        return try machine.resolveCommit(
          await continueJournalCleanup(connectionID: connectionID)
        )
      }
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
    if let journal {
      let token: BrokerCredentialStateMachine.JournalAuthorityAwaitToken
      do {
        token = try machine.reserveJournalCommit(
          proposal: proposal,
          capturedAt: journalTimestamp()
        )
      } catch {
        throw .storeUnavailable
      }
      return try machine.resolveCommit(
        await performJournalAuthority(journal: journal, token: token)
      )
    }
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
    case .resumeJournalStaging:
      throw .cleanupPending
    case .resumeStageResolutionRequest:
      throw .cleanupPending
    case .resumeStageResolution:
      throw .cleanupPending
    case .resumeCleanup:
      if journal != nil {
        return try machine.resolveAbort(
          await continueJournalCleanup(connectionID: connectionID)
        )
      }
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

    let proposal = try machine.abortProposal(
      connectionID: connectionID,
      attemptID: attemptID,
      operationID: operationID,
      fingerprint: fingerprint
    )
    if let journal {
      let token: BrokerCredentialStateMachine.JournalAuthorityAwaitToken
      do {
        token = try machine.reserveJournalAbort(
          proposal: proposal,
          changedAt: journalTimestamp()
        )
      } catch {
        throw .storeUnavailable
      }
      return try machine.resolveAbort(
        await performJournalAuthority(journal: journal, token: token)
      )
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
    case .resumeJournalStaging:
      throw .cleanupPending
    case .resumeStageResolutionRequest:
      throw .cleanupPending
    case .resumeStageResolution:
      throw .cleanupPending
    case .resumeCleanup:
      if journal != nil {
        return try machine.resolveDisconnect(
          await continueJournalCleanup(connectionID: connectionID)
        )
      }
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
    if let journal {
      let token: BrokerCredentialStateMachine.JournalAuthorityAwaitToken
      do {
        token = try machine.reserveJournalDisconnect(
          proposal: proposal,
          capturedAt: journalTimestamp()
        )
      } catch {
        throw .storeUnavailable
      }
      return try machine.resolveDisconnect(
        await performJournalAuthority(journal: journal, token: token)
      )
    }
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
          machine.recordJournalFailure(error)
          result = .failure(error)
        }
        return try machine.finishJournalFinalization(token, result: result)
      }
    }
  }

  private func performJournalAuthority(
    journal: any BrokerJournalStore,
    token: BrokerCredentialStateMachine.JournalAuthorityAwaitToken
  ) async throws(BrokerStateError) -> BrokerCredentialStateMachine.TerminalOutcome {
    let result: Result<BrokerJournalSnapshot, BrokerJournalError>
    do {
      result = .success(
        try await journal.compareAndSwap(
          expected: token.expected,
          replacement: token.replacement
        )
      )
    } catch let error {
      machine.recordJournalFailure(error)
      result = .failure(error)
    }

    let completion: BrokerCredentialStateMachine.JournalAuthorityCompletion
    do {
      completion = try machine.finishJournalAuthority(token, result: result)
    } catch {
      switch result {
      case .failure(.mutationOutcomeUnknown), .success:
        throw .cleanupPending
      case .failure:
        throw .storeUnavailable
      }
    }
    switch completion {
    case .completed(let outcome):
      return outcome
    case .cleanup:
      return try await continueJournalCleanup(connectionID: token.connectionID)
    }
  }

  private func finishJournalStableStoreFailure(
    journal: any BrokerJournalStore,
    storing: BrokerCredentialStateMachine.JournalStageStoreToken
  ) async throws(BrokerStateError) -> StagingAttempt {
    let changedAt: JournalTimestamp
    do {
      changedAt = try journalTimestamp()
    } catch {
      _ = try? machine.pauseJournalStableStoreFailureRequest(storing)
      throw .cleanupPending
    }
    let transition: BrokerCredentialStateMachine.JournalStageTransitionAwaitToken
    do {
      transition = try machine.beginJournalStableStoreFailure(
        storing,
        changedAt: changedAt
      )
    } catch {
      throw .cleanupPending
    }
    let selected: BrokerJournalSnapshot
    do {
      selected = try await journal.compareAndSwap(
        expected: transition.expected,
        replacement: transition.replacement
      )
    } catch let error {
      machine.recordJournalFailure(error)
      do {
        try machine.pauseJournalStageTransition(transition)
      } catch {
        throw .cleanupPending
      }
      throw .cleanupPending
    }
    let outcome: BrokerCredentialStateMachine.TerminalOutcome
    do {
      outcome = try machine.finishJournalStableStoreFailure(
        transition,
        result: .success(selected)
      )
    } catch {
      throw .cleanupPending
    }
    return try machine.resolveStage(outcome)
  }

  private func finishJournalStageCleanup(
    journal: any BrokerJournalStore,
    storing: BrokerCredentialStateMachine.JournalStageStoreToken,
    terminalError: BrokerStateError
  ) async throws(BrokerStateError) -> StagingAttempt {
    let changedAt: JournalTimestamp
    do {
      changedAt = try journalTimestamp()
    } catch {
      _ = try? machine.pauseJournalStageCleanupRequest(
        storing,
        terminalError: terminalError
      )
      throw .cleanupPending
    }
    let transition: BrokerCredentialStateMachine.JournalStageTransitionAwaitToken
    do {
      transition = try machine.beginJournalStageCleanup(
        storing,
        terminalError: terminalError,
        changedAt: changedAt
      )
    } catch {
      throw .cleanupPending
    }
    let selected: BrokerJournalSnapshot
    do {
      selected = try await journal.compareAndSwap(
        expected: transition.expected,
        replacement: transition.replacement
      )
    } catch let error {
      machine.recordJournalFailure(error)
      do {
        try machine.pauseJournalStageTransition(transition)
      } catch {
        throw .cleanupPending
      }
      throw .cleanupPending
    }
    do {
      try machine.finishJournalStageCleanup(
        transition,
        result: .success(selected)
      )
    } catch {
      throw .cleanupPending
    }
    return try machine.resolveStage(
      await continueJournalCleanup(connectionID: transition.connectionID)
    )
  }

  private func continueJournalStagingReconciliation(
    connectionID: UUID,
    operationID: UUID,
    fingerprint: BrokerCredentialStateMachine.OperationFingerprint
  ) async throws(BrokerStateError) -> StagingAttempt {
    guard let journal else {
      throw .cleanupPending
    }
    let transition: BrokerCredentialStateMachine.JournalStageTransitionAwaitToken
    do {
      transition = try machine.beginJournalStagingReconciliation(
        connectionID: connectionID,
        operationID: operationID,
        fingerprint: fingerprint
      )
    } catch {
      throw .cleanupPending
    }
    return try await recoverFromJournalStagingFailure(
      journal: journal,
      transition: transition,
      fingerprint: fingerprint
    )
  }

  private func recoverFromJournalStagingFailure(
    journal: any BrokerJournalStore,
    transition: BrokerCredentialStateMachine.JournalStageTransitionAwaitToken,
    fingerprint: BrokerCredentialStateMachine.OperationFingerprint
  ) async throws(BrokerStateError) -> StagingAttempt {
    let reconciliation: BrokerJournalCASReconciliation
    do {
      reconciliation = try await journal.reconcileCompareAndSwap(
        expected: transition.expected,
        replacement: transition.replacement
      )
    } catch let error {
      machine.recordJournalFailure(error)
      _ = try? machine.pauseJournalStageTransition(
        transition,
        cancellationObserved: Task.isCancelled
      )
      throw .cleanupPending
    }
    if case .replacement(let selected) = reconciliation {
      let wasCancelled = transition.cancellationObserved || Task.isCancelled
      if !wasCancelled {
        do {
          return try machine.finishJournalStaging(
            transition,
            result: .success(selected)
          )
        } catch {
          throw .cleanupPending
        }
      }
      let cleanupChangedAt: JournalTimestamp
      do {
        cleanupChangedAt = try journalTimestamp()
      } catch {
        _ = try? machine.pauseJournalStageCleanupRequestAfterStaging(
          transition,
          selectedStaging: selected,
          terminalError: .cancelled
        )
        throw .cleanupPending
      }
      do {
        try machine.prepareJournalStageCleanupAfterStaging(
          transition,
          selectedStaging: selected,
          terminalError: .cancelled,
          changedAt: cleanupChangedAt
        )
      } catch {
        throw .cleanupPending
      }
      return try machine.resolveStage(
        await continueJournalStageResolution(
          connectionID: transition.connectionID,
          operationID: transition.reservation.operationID,
          fingerprint: fingerprint
        )
      )
    }
    guard reconciliation == .expected else {
      _ = try? machine.pauseJournalStageTransition(
        transition,
        cancellationObserved: Task.isCancelled
      )
      throw .cleanupPending
    }
    let terminalError: BrokerStateError =
      transition.cancellationObserved || Task.isCancelled ? .cancelled : .storeUnavailable
    let cleanupChangedAt: JournalTimestamp
    do {
      cleanupChangedAt = try journalTimestamp()
    } catch {
      _ = try? machine.pauseJournalStageCleanupRequestAfterStaging(
        transition,
        selectedStaging: nil,
        terminalError: terminalError
      )
      throw .cleanupPending
    }
    do {
      try machine.prepareJournalStageCleanupAfterStaging(
        transition,
        selectedStaging: nil,
        terminalError: terminalError,
        changedAt: cleanupChangedAt
      )
    } catch {
      throw .cleanupPending
    }
    return try machine.resolveStage(
      await continueJournalStageResolution(
        connectionID: transition.connectionID,
        operationID: transition.reservation.operationID,
        fingerprint: fingerprint
      )
    )
  }

  private func continueJournalStageResolution(
    connectionID: UUID,
    operationID: UUID,
    fingerprint: BrokerCredentialStateMachine.OperationFingerprint
  ) async throws(BrokerStateError) -> BrokerCredentialStateMachine.TerminalOutcome {
    guard let journal else {
      throw .cleanupPending
    }
    let token: BrokerCredentialStateMachine.JournalStageResolutionAwaitToken
    do {
      token = try machine.beginJournalStageResolution(
        connectionID: connectionID,
        operationID: operationID,
        fingerprint: fingerprint
      )
    } catch {
      throw .cleanupPending
    }

    let selected: BrokerJournalSnapshot?
    do {
      selected = try await journal.load(connectionID: connectionID)
    } catch let error {
      machine.recordJournalFailure(error)
      _ = try? machine.finishJournalStageResolution(token, result: .failure(error))
      throw .cleanupPending
    }
    let selection: BrokerCredentialStateMachine.JournalStageResolutionSelection
    do {
      selection = try machine.classifyJournalStageResolutionSelection(
        token,
        selected: selected
      )
    } catch {
      _ = try? machine.finishJournalStageResolution(token, result: .failure(.casConflict))
      throw .cleanupPending
    }
    guard selection == .expected else {
      _ = try? machine.finishJournalStageResolution(token, result: .failure(.casConflict))
      throw .cleanupPending
    }

    let replacement: BrokerJournalSnapshot
    do {
      replacement = try await journal.compareAndSwap(
        expected: token.expected,
        replacement: token.replacement
      )
    } catch let error {
      machine.recordJournalFailure(error)
      _ = try? machine.finishJournalStageResolution(token, result: .failure(error))
      throw .cleanupPending
    }
    let completion: BrokerCredentialStateMachine.JournalStageResolutionCompletion
    do {
      completion = try machine.finishJournalStageResolution(
        token,
        result: .success(replacement)
      )
    } catch {
      throw .cleanupPending
    }
    switch completion {
    case .terminal(let outcome):
      return outcome
    case .cleanup:
      return try await continueJournalCleanup(connectionID: connectionID)
    }
  }

  private func continueJournalStageResolutionRequest(
    connectionID: UUID,
    operationID: UUID,
    fingerprint: BrokerCredentialStateMachine.OperationFingerprint
  ) async throws(BrokerStateError) -> BrokerCredentialStateMachine.TerminalOutcome {
    let request: BrokerCredentialStateMachine.JournalStageResolutionRequestToken
    do {
      request = try machine.beginJournalStageResolutionRequest(
        connectionID: connectionID,
        operationID: operationID,
        fingerprint: fingerprint
      )
      try machine.finishJournalStageResolutionRequest(
        request,
        changedAt: journalTimestamp()
      )
    } catch {
      throw .cleanupPending
    }
    return try await continueJournalStageResolution(
      connectionID: connectionID,
      operationID: operationID,
      fingerprint: fingerprint
    )
  }

  private func continueJournalCleanup(
    connectionID: UUID
  ) async throws(BrokerStateError) -> BrokerCredentialStateMachine.TerminalOutcome {
    do {
      return try await continueRecoveredCleanup(connectionID: connectionID)
    } catch {
      throw .cleanupPending
    }
  }

  private func journalTimestamp() throws(BrokerJournalError) -> JournalTimestamp {
    try BrokerJournalRecordAdapter.captureTimestamp(from: clock())
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
    case .resumeJournalStaging:
      throw .cleanupPending
    case .resumeStageResolutionRequest:
      throw .cleanupPending
    case .resumeStageResolution:
      throw .cleanupPending
    case .resumeCleanup:
      return disposition
    case .proceed:
      break
    }
    guard !Task.isCancelled else {
      throw .cancelled
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
