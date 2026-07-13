import Foundation

package struct BrokerJournalCleanupInstruction: Sendable, Hashable {
  package let terminalOperation: BrokerJournalTerminalOperation
  package let credentialKeys: [CredentialStoreKey]

  package init(
    terminalOperation: BrokerJournalTerminalOperation,
    credentialKeys: [CredentialStoreKey]
  ) {
    self.terminalOperation = terminalOperation
    self.credentialKeys = credentialKeys
  }
}

package struct BrokerJournalRecoveryPlan: Sendable, Hashable {
  package let bootstrap: CredentialBootstrap
  package let projection: CredentialProjection?
  package let preparation: BrokerJournalRecord?
  package let cleanup: BrokerJournalCleanupInstruction?

  package init(
    bootstrap: CredentialBootstrap,
    projection: CredentialProjection?,
    preparation: BrokerJournalRecord?,
    cleanup: BrokerJournalCleanupInstruction?
  ) {
    self.bootstrap = bootstrap
    self.projection = projection
    self.preparation = preparation
    self.cleanup = cleanup
  }
}

package enum BrokerJournalRecordAdapter {
  package static func captureTimestamp(
    from date: Date
  ) throws(BrokerJournalError) -> JournalTimestamp {
    try JournalTimestamp(date: date)
  }

  package static func journalGeneration(
    from generation: CredentialGeneration
  ) throws(BrokerJournalError) -> BrokerJournalCredentialGeneration {
    guard generation.ordinal > 0 else {
      throw .invalidRecord
    }
    return BrokerJournalCredentialGeneration(
      generationID: generation.generationID,
      ordinal: generation.ordinal,
      createdAt: try captureTimestamp(from: generation.createdAt)
    )
  }

  package static func generation(
    from generation: BrokerJournalCredentialGeneration
  ) throws(BrokerJournalError) -> CredentialGeneration {
    guard generation.ordinal > 0 else {
      throw .invalidRecord
    }
    return CredentialGeneration(
      generationID: generation.generationID,
      ordinal: generation.ordinal,
      createdAt: generation.createdAt.date
    )
  }

  package static func journalReadyGeneration(
    from ready: ReadyGeneration
  ) throws(BrokerJournalError) -> BrokerJournalReadyGeneration {
    BrokerJournalReadyGeneration(
      generation: try journalGeneration(from: ready.generation),
      committedAt: try captureTimestamp(from: ready.committedAt)
    )
  }

  package static func readyGeneration(
    from ready: BrokerJournalReadyGeneration
  ) throws(BrokerJournalError) -> ReadyGeneration {
    ReadyGeneration(
      generation: try generation(from: ready.generation),
      committedAt: ready.committedAt.date
    )
  }

  package static func journalReadyProjection(
    from projection: ReadyProjection
  ) throws(BrokerJournalError) -> BrokerJournalReadyProjection {
    guard
      projection.fence == projection.lastGenerationOrdinal,
      projection.fence < UInt64.max,
      projection.ready.generation.ordinal > 0,
      projection.ready.generation.ordinal <= projection.lastGenerationOrdinal
    else {
      throw .invalidRecord
    }
    return BrokerJournalReadyProjection(
      connectionID: projection.connectionID,
      fence: projection.fence,
      ready: try journalReadyGeneration(from: projection.ready),
      lastGenerationOrdinal: projection.lastGenerationOrdinal
    )
  }

  package static func readyProjection(
    from projection: BrokerJournalReadyProjection
  ) throws(BrokerJournalError) -> ReadyProjection {
    guard
      projection.fence == projection.lastGenerationOrdinal,
      projection.fence < UInt64.max,
      projection.ready.generation.ordinal > 0,
      projection.ready.generation.ordinal <= projection.lastGenerationOrdinal
    else {
      throw .invalidRecord
    }
    return ReadyProjection(
      connectionID: projection.connectionID,
      fence: projection.fence,
      ready: try readyGeneration(from: projection.ready),
      lastGenerationOrdinal: projection.lastGenerationOrdinal
    )
  }

  package static func journalTombstoneProjection(
    from projection: TombstoneProjection
  ) throws(BrokerJournalError) -> BrokerJournalTombstoneProjection {
    guard incrementing(projection.lastGenerationOrdinal) == projection.fence else {
      throw .invalidRecord
    }
    return BrokerJournalTombstoneProjection(
      connectionID: projection.connectionID,
      fence: projection.fence,
      lastGenerationOrdinal: projection.lastGenerationOrdinal,
      tombstonedAt: try captureTimestamp(from: projection.tombstonedAt)
    )
  }

  package static func tombstoneProjection(
    from projection: BrokerJournalTombstoneProjection
  ) throws(BrokerJournalError) -> TombstoneProjection {
    guard incrementing(projection.lastGenerationOrdinal) == projection.fence else {
      throw .invalidRecord
    }
    return TombstoneProjection(
      connectionID: projection.connectionID,
      fence: projection.fence,
      lastGenerationOrdinal: projection.lastGenerationOrdinal,
      tombstonedAt: projection.tombstonedAt.date
    )
  }

  package static func recoveryPlan(
    for record: BrokerJournalRecord,
    recoveryChangedAt: JournalTimestamp
  ) throws(BrokerJournalError) -> BrokerJournalRecoveryPlan {
    let bootstrap = try safeBootstrap(for: record)
    let projection = projection(from: bootstrap)

    switch record.payload {
    case .vacant, .ready, .tombstoned:
      return BrokerJournalRecoveryPlan(
        bootstrap: bootstrap,
        projection: projection,
        preparation: nil,
        cleanup: nil
      )

    case .storePending(let payload):
      let preparation = try makeStageCleanupPending(
        predecessor: record,
        error: .storeUnavailable,
        changedAt: recoveryChangedAt
      )
      return BrokerJournalRecoveryPlan(
        bootstrap: bootstrap,
        projection: projection,
        preparation: preparation,
        cleanup: stageCleanupInstruction(
          connectionID: record.connectionID,
          operationID: payload.operationID,
          expectedFence: payload.expectedFence,
          candidate: payload.candidate,
          error: .storeUnavailable
        )
      )

    case .staging(let payload):
      let preparation = try makeStageCleanupPending(
        predecessor: record,
        error: .attemptNotCurrent,
        changedAt: recoveryChangedAt
      )
      return BrokerJournalRecoveryPlan(
        bootstrap: bootstrap,
        projection: projection,
        preparation: preparation,
        cleanup: stageCleanupInstruction(
          connectionID: record.connectionID,
          operationID: payload.operationID,
          expectedFence: payload.expectedFence,
          candidate: payload.candidate,
          error: .attemptNotCurrent
        )
      )

    case .readyCleanupPending(let payload):
      let ready = journalReadyProjection(
        connectionID: record.connectionID,
        fence: record.fence,
        ready: payload.ready,
        lastGenerationOrdinal: record.lastGenerationOrdinal
      )
      let terminal = BrokerJournalTerminalOperation.commit(
        BrokerJournalCommitTerminal(
          operationID: payload.operationID,
          expectedFence: payload.expectedFence,
          attemptID: payload.attemptID,
          ready: ready
        )
      )
      return BrokerJournalRecoveryPlan(
        bootstrap: bootstrap,
        projection: projection,
        preparation: nil,
        cleanup: BrokerJournalCleanupInstruction(
          terminalOperation: terminal,
          credentialKeys: [
            key(connectionID: record.connectionID, generation: payload.previousReady.generation)
          ]
        )
      )

    case .stageCleanupPending(let payload):
      return BrokerJournalRecoveryPlan(
        bootstrap: bootstrap,
        projection: projection,
        preparation: nil,
        cleanup: stageCleanupInstruction(
          connectionID: record.connectionID,
          operationID: payload.operationID,
          expectedFence: payload.expectedFence,
          candidate: payload.candidate,
          error: payload.error
        )
      )

    case .abortCleanupPending(let payload):
      let restored = payload.restoredReady.map {
        journalReadyProjection(
          connectionID: record.connectionID,
          fence: record.fence,
          ready: $0,
          lastGenerationOrdinal: record.lastGenerationOrdinal
        )
      }
      let terminal = BrokerJournalTerminalOperation.abort(
        BrokerJournalAbortTerminal(
          operationID: payload.operationID,
          expectedFence: payload.expectedFence,
          attemptID: payload.attemptID,
          restoredReady: restored
        )
      )
      return BrokerJournalRecoveryPlan(
        bootstrap: bootstrap,
        projection: projection,
        preparation: nil,
        cleanup: BrokerJournalCleanupInstruction(
          terminalOperation: terminal,
          credentialKeys: [key(connectionID: record.connectionID, generation: payload.candidate)]
        )
      )

    case .disconnectFenced(let payload):
      let tombstone = BrokerJournalTombstoneProjection(
        connectionID: record.connectionID,
        fence: record.fence,
        lastGenerationOrdinal: record.lastGenerationOrdinal,
        tombstonedAt: payload.tombstonedAt
      )
      let terminal = BrokerJournalTerminalOperation.disconnect(
        BrokerJournalDisconnectTerminal(
          operationID: payload.operationID,
          expectedFence: payload.expectedFence,
          tombstone: tombstone
        )
      )
      return BrokerJournalRecoveryPlan(
        bootstrap: bootstrap,
        projection: projection,
        preparation: nil,
        cleanup: BrokerJournalCleanupInstruction(
          terminalOperation: terminal,
          credentialKeys: payload.deleteGenerations.map {
            key(connectionID: record.connectionID, generation: $0)
          }
        )
      )
    }
  }

  package static func makeStorePending(
    predecessor: BrokerJournalRecord?,
    connectionID: UUID,
    providerBinding: ProviderProfileBinding,
    attemptID: UUID,
    operationID: UUID,
    candidateGenerationID: UUID,
    capturedAt: JournalTimestamp
  ) throws(BrokerJournalError) -> BrokerJournalRecord {
    let revision: UInt64
    let fence: UInt64
    let ordinal: UInt64
    let previousReady: BrokerJournalReadyGeneration?
    let terminalOperations: [BrokerJournalTerminalOperation]

    if let predecessor {
      guard
        predecessor.connectionID == connectionID,
        predecessor.providerBinding == providerBinding
      else {
        throw .invalidRecord
      }
      guard predecessor.fence <= UInt64.max - 2 else {
        throw .invalidRecord
      }
      revision = try nextRevision(after: predecessor)
      guard
        let nextFence = incrementing(predecessor.fence),
        let nextOrdinal = incrementing(predecessor.lastGenerationOrdinal)
      else {
        throw .invalidRecord
      }
      fence = nextFence
      ordinal = nextOrdinal
      switch predecessor.payload {
      case .vacant:
        previousReady = nil
      case .ready(let payload):
        previousReady = payload.ready
      default:
        throw .invalidRecord
      }
      terminalOperations = predecessor.terminalOperations
      guard !generationIDs(in: predecessor).contains(candidateGenerationID) else {
        throw .invalidRecord
      }
      try validateNewOperationIdentity(
        operationID: operationID,
        attemptID: attemptID,
        in: predecessor
      )
    } else {
      revision = 1
      fence = 1
      ordinal = 1
      previousReady = nil
      terminalOperations = []
    }

    let candidate = BrokerJournalCredentialGeneration(
      generationID: candidateGenerationID,
      ordinal: ordinal,
      createdAt: capturedAt
    )
    let record = try BrokerJournalRecord(
      revision: revision,
      connectionID: connectionID,
      providerBinding: providerBinding,
      fence: fence,
      lastGenerationOrdinal: ordinal,
      changedAt: capturedAt,
      payload: .storePending(
        BrokerJournalStorePendingPayload(
          attemptID: attemptID,
          operationID: operationID,
          expectedFence: fence - 1,
          candidate: candidate,
          previousReady: previousReady,
          startedAt: capturedAt
        )
      ),
      terminalOperations: terminalOperations
    )
    return try validated(predecessor: predecessor, successor: record)
  }

  package static func makeStaging(
    predecessor: BrokerJournalRecord,
    changedAt: JournalTimestamp
  ) throws(BrokerJournalError) -> BrokerJournalRecord {
    guard case .storePending(let payload) = predecessor.payload else {
      throw .invalidRecord
    }
    return try successor(
      to: predecessor,
      changedAt: changedAt,
      payload: .staging(
        BrokerJournalStagingPayload(
          attemptID: payload.attemptID,
          operationID: payload.operationID,
          expectedFence: payload.expectedFence,
          candidate: payload.candidate,
          previousReady: payload.previousReady,
          startedAt: payload.startedAt
        )
      ),
      terminalOperations: predecessor.terminalOperations
    )
  }

  package static func makeStableStoreFailure(
    predecessor: BrokerJournalRecord,
    changedAt: JournalTimestamp
  ) throws(BrokerJournalError) -> BrokerJournalRecord {
    guard case .storePending(let payload) = predecessor.payload else {
      throw .invalidRecord
    }
    let terminal = BrokerJournalTerminalOperation.stageFailure(
      BrokerJournalStageFailureTerminal(
        operationID: payload.operationID,
        expectedFence: payload.expectedFence,
        error: .storeUnavailable
      )
    )
    return try stableAuthoritySuccessor(
      to: predecessor,
      restoredReady: payload.previousReady,
      changedAt: changedAt,
      terminal: terminal
    )
  }

  package static func makeStageCleanupPending(
    predecessor: BrokerJournalRecord,
    error: BrokerJournalStageError,
    changedAt: JournalTimestamp
  ) throws(BrokerJournalError) -> BrokerJournalRecord {
    let identity:
      (
        attemptID: UUID,
        operationID: UUID,
        expectedFence: UInt64,
        candidate: BrokerJournalCredentialGeneration,
        previousReady: BrokerJournalReadyGeneration?
      )
    switch predecessor.payload {
    case .storePending(let payload):
      identity = (
        payload.attemptID, payload.operationID, payload.expectedFence,
        payload.candidate, payload.previousReady
      )
    case .staging(let payload):
      identity = (
        payload.attemptID, payload.operationID, payload.expectedFence,
        payload.candidate, payload.previousReady
      )
    default:
      throw .invalidRecord
    }
    return try successor(
      to: predecessor,
      changedAt: changedAt,
      payload: .stageCleanupPending(
        BrokerJournalStageCleanupPendingPayload(
          attemptID: identity.attemptID,
          operationID: identity.operationID,
          expectedFence: identity.expectedFence,
          candidate: identity.candidate,
          restoredReady: identity.previousReady,
          error: error
        )
      ),
      terminalOperations: predecessor.terminalOperations
    )
  }

  package static func makeStableStageFailure(
    predecessor: BrokerJournalRecord,
    changedAt: JournalTimestamp
  ) throws(BrokerJournalError) -> BrokerJournalRecord {
    guard case .stageCleanupPending(let payload) = predecessor.payload else {
      throw .invalidRecord
    }
    let terminal = BrokerJournalTerminalOperation.stageFailure(
      BrokerJournalStageFailureTerminal(
        operationID: payload.operationID,
        expectedFence: payload.expectedFence,
        error: payload.error
      )
    )
    return try stableAuthoritySuccessor(
      to: predecessor,
      restoredReady: payload.restoredReady,
      changedAt: changedAt,
      terminal: terminal
    )
  }

  package static func makeCommitAuthority(
    predecessor: BrokerJournalRecord,
    operationID: UUID,
    capturedAt: JournalTimestamp
  ) throws(BrokerJournalError) -> BrokerJournalRecord {
    guard case .staging(let payload) = predecessor.payload else {
      throw .invalidRecord
    }
    try validateNewOperationIdentity(
      operationID: operationID,
      attemptID: payload.attemptID,
      in: predecessor
    )
    let ready = BrokerJournalReadyGeneration(
      generation: payload.candidate,
      committedAt: capturedAt
    )
    if let previousReady = payload.previousReady {
      return try successor(
        to: predecessor,
        changedAt: capturedAt,
        payload: .readyCleanupPending(
          BrokerJournalReadyCleanupPendingPayload(
            attemptID: payload.attemptID,
            operationID: operationID,
            expectedFence: predecessor.fence,
            ready: ready,
            previousReady: previousReady
          )
        ),
        terminalOperations: predecessor.terminalOperations
      )
    }

    let projection = journalReadyProjection(
      connectionID: predecessor.connectionID,
      fence: predecessor.fence,
      ready: ready,
      lastGenerationOrdinal: predecessor.lastGenerationOrdinal
    )
    let terminal = BrokerJournalTerminalOperation.commit(
      BrokerJournalCommitTerminal(
        operationID: operationID,
        expectedFence: predecessor.fence,
        attemptID: payload.attemptID,
        ready: projection
      )
    )
    return try successor(
      to: predecessor,
      changedAt: capturedAt,
      payload: .ready(BrokerJournalReadyPayload(ready: ready)),
      terminalOperations: appendingTerminal(terminal, to: predecessor.terminalOperations)
    )
  }

  package static func makeStableCommit(
    predecessor: BrokerJournalRecord,
    changedAt: JournalTimestamp
  ) throws(BrokerJournalError) -> BrokerJournalRecord {
    guard case .readyCleanupPending(let payload) = predecessor.payload else {
      throw .invalidRecord
    }
    let projection = journalReadyProjection(
      connectionID: predecessor.connectionID,
      fence: predecessor.fence,
      ready: payload.ready,
      lastGenerationOrdinal: predecessor.lastGenerationOrdinal
    )
    let terminal = BrokerJournalTerminalOperation.commit(
      BrokerJournalCommitTerminal(
        operationID: payload.operationID,
        expectedFence: payload.expectedFence,
        attemptID: payload.attemptID,
        ready: projection
      )
    )
    return try successor(
      to: predecessor,
      changedAt: changedAt,
      payload: .ready(BrokerJournalReadyPayload(ready: payload.ready)),
      terminalOperations: appendingTerminal(terminal, to: predecessor.terminalOperations)
    )
  }

  package static func makeAbortCleanupPending(
    predecessor: BrokerJournalRecord,
    operationID: UUID,
    changedAt: JournalTimestamp
  ) throws(BrokerJournalError) -> BrokerJournalRecord {
    guard case .staging(let payload) = predecessor.payload else {
      throw .invalidRecord
    }
    try validateNewOperationIdentity(
      operationID: operationID,
      attemptID: payload.attemptID,
      in: predecessor
    )
    return try successor(
      to: predecessor,
      changedAt: changedAt,
      payload: .abortCleanupPending(
        BrokerJournalAbortCleanupPendingPayload(
          attemptID: payload.attemptID,
          operationID: operationID,
          expectedFence: predecessor.fence,
          candidate: payload.candidate,
          restoredReady: payload.previousReady
        )
      ),
      terminalOperations: predecessor.terminalOperations
    )
  }

  package static func makeStableAbort(
    predecessor: BrokerJournalRecord,
    changedAt: JournalTimestamp
  ) throws(BrokerJournalError) -> BrokerJournalRecord {
    guard case .abortCleanupPending(let payload) = predecessor.payload else {
      throw .invalidRecord
    }
    let restoredProjection = payload.restoredReady.map {
      journalReadyProjection(
        connectionID: predecessor.connectionID,
        fence: predecessor.fence,
        ready: $0,
        lastGenerationOrdinal: predecessor.lastGenerationOrdinal
      )
    }
    let terminal = BrokerJournalTerminalOperation.abort(
      BrokerJournalAbortTerminal(
        operationID: payload.operationID,
        expectedFence: payload.expectedFence,
        attemptID: payload.attemptID,
        restoredReady: restoredProjection
      )
    )
    return try stableAuthoritySuccessor(
      to: predecessor,
      restoredReady: payload.restoredReady,
      changedAt: changedAt,
      terminal: terminal
    )
  }

  package static func makeDisconnectFenced(
    predecessor: BrokerJournalRecord,
    operationID: UUID,
    capturedAt: JournalTimestamp
  ) throws(BrokerJournalError) -> BrokerJournalRecord {
    try validateNewOperationIdentity(
      operationID: operationID,
      attemptID: nil,
      in: predecessor
    )
    let deleteGenerations: [BrokerJournalCredentialGeneration]
    switch predecessor.payload {
    case .vacant:
      deleteGenerations = []
    case .ready(let payload):
      deleteGenerations = [payload.ready.generation]
    case .staging(let payload):
      deleteGenerations =
        [payload.candidate] + (payload.previousReady.map { [$0.generation] } ?? [])
    default:
      throw .invalidRecord
    }
    guard let fence = incrementing(predecessor.fence) else {
      throw .invalidRecord
    }
    return try successor(
      to: predecessor,
      fence: fence,
      changedAt: capturedAt,
      payload: .disconnectFenced(
        BrokerJournalDisconnectFencedPayload(
          operationID: operationID,
          expectedFence: predecessor.fence,
          tombstonedAt: capturedAt,
          deleteGenerations: deleteGenerations
        )
      ),
      terminalOperations: predecessor.terminalOperations
    )
  }

  package static func makeTombstoned(
    predecessor: BrokerJournalRecord,
    changedAt: JournalTimestamp
  ) throws(BrokerJournalError) -> BrokerJournalRecord {
    guard case .disconnectFenced(let payload) = predecessor.payload else {
      throw .invalidRecord
    }
    let tombstone = BrokerJournalTombstoneProjection(
      connectionID: predecessor.connectionID,
      fence: predecessor.fence,
      lastGenerationOrdinal: predecessor.lastGenerationOrdinal,
      tombstonedAt: payload.tombstonedAt
    )
    let terminal = BrokerJournalTerminalOperation.disconnect(
      BrokerJournalDisconnectTerminal(
        operationID: payload.operationID,
        expectedFence: payload.expectedFence,
        tombstone: tombstone
      )
    )
    return try successor(
      to: predecessor,
      changedAt: changedAt,
      payload: .tombstoned(
        BrokerJournalTombstonedPayload(tombstonedAt: payload.tombstonedAt)
      ),
      terminalOperations: appendingTerminal(terminal, to: predecessor.terminalOperations)
    )
  }

  package static func appendingTerminal(
    _ operation: BrokerJournalTerminalOperation,
    to previous: [BrokerJournalTerminalOperation]
  ) throws(BrokerJournalError) -> [BrokerJournalTerminalOperation] {
    let previousOperationIDs = previous.map(\.operationID)
    let previousAttemptIDs = previous.compactMap(attemptID(of:))
    guard
      previous.count <= 64,
      Set(previousOperationIDs).count == previousOperationIDs.count,
      Set(previousAttemptIDs).count == previousAttemptIDs.count,
      !previousOperationIDs.contains(operation.operationID)
    else {
      throw .invalidRecord
    }
    if let attemptID = attemptID(of: operation) {
      guard !previousAttemptIDs.contains(attemptID) else {
        throw .invalidRecord
      }
    }
    var result = previous
    result.append(operation)
    if result.count == 65 {
      result.removeFirst()
    }
    return result
  }

  private static func safeBootstrap(
    for record: BrokerJournalRecord
  ) throws(BrokerJournalError) -> CredentialBootstrap {
    switch record.payload {
    case .vacant:
      return .vacant(
        connectionID: record.connectionID,
        fence: record.fence,
        lastGenerationOrdinal: record.lastGenerationOrdinal
      )

    case .storePending(let payload):
      return try stableBootstrap(
        connectionID: record.connectionID,
        fence: record.fence,
        lastGenerationOrdinal: record.lastGenerationOrdinal,
        ready: payload.previousReady
      )

    case .staging(let payload):
      return try stableBootstrap(
        connectionID: record.connectionID,
        fence: record.fence,
        lastGenerationOrdinal: record.lastGenerationOrdinal,
        ready: payload.previousReady
      )

    case .readyCleanupPending(let payload):
      return try stableBootstrap(
        connectionID: record.connectionID,
        fence: record.fence,
        lastGenerationOrdinal: record.lastGenerationOrdinal,
        ready: payload.ready
      )

    case .ready(let payload):
      return try stableBootstrap(
        connectionID: record.connectionID,
        fence: record.fence,
        lastGenerationOrdinal: record.lastGenerationOrdinal,
        ready: payload.ready
      )

    case .stageCleanupPending(let payload):
      return try stableBootstrap(
        connectionID: record.connectionID,
        fence: record.fence,
        lastGenerationOrdinal: record.lastGenerationOrdinal,
        ready: payload.restoredReady
      )

    case .abortCleanupPending(let payload):
      return try stableBootstrap(
        connectionID: record.connectionID,
        fence: record.fence,
        lastGenerationOrdinal: record.lastGenerationOrdinal,
        ready: payload.restoredReady
      )

    case .disconnectFenced(let payload):
      return .tombstoned(
        TombstoneProjection(
          connectionID: record.connectionID,
          fence: record.fence,
          lastGenerationOrdinal: record.lastGenerationOrdinal,
          tombstonedAt: payload.tombstonedAt.date
        )
      )

    case .tombstoned(let payload):
      return .tombstoned(
        TombstoneProjection(
          connectionID: record.connectionID,
          fence: record.fence,
          lastGenerationOrdinal: record.lastGenerationOrdinal,
          tombstonedAt: payload.tombstonedAt.date
        )
      )
    }
  }

  private static func stableBootstrap(
    connectionID: UUID,
    fence: UInt64,
    lastGenerationOrdinal: UInt64,
    ready: BrokerJournalReadyGeneration?
  ) throws(BrokerJournalError) -> CredentialBootstrap {
    guard let ready else {
      return .vacant(
        connectionID: connectionID,
        fence: fence,
        lastGenerationOrdinal: lastGenerationOrdinal
      )
    }
    let journal = journalReadyProjection(
      connectionID: connectionID,
      fence: fence,
      ready: ready,
      lastGenerationOrdinal: lastGenerationOrdinal
    )
    return .ready(try readyProjection(from: journal))
  }

  private static func projection(
    from bootstrap: CredentialBootstrap
  ) -> CredentialProjection? {
    switch bootstrap {
    case .vacant:
      nil
    case .ready(let ready):
      .ready(ready)
    case .tombstoned(let tombstone):
      .tombstoned(tombstone)
    }
  }

  private static func stableAuthoritySuccessor(
    to predecessor: BrokerJournalRecord,
    restoredReady: BrokerJournalReadyGeneration?,
    changedAt: JournalTimestamp,
    terminal: BrokerJournalTerminalOperation
  ) throws(BrokerJournalError) -> BrokerJournalRecord {
    let payload: BrokerJournalPayload =
      restoredReady.map {
        .ready(BrokerJournalReadyPayload(ready: $0))
      } ?? .vacant(BrokerJournalVacantPayload())
    return try successor(
      to: predecessor,
      changedAt: changedAt,
      payload: payload,
      terminalOperations: appendingTerminal(terminal, to: predecessor.terminalOperations)
    )
  }

  private static func successor(
    to predecessor: BrokerJournalRecord,
    fence: UInt64? = nil,
    changedAt: JournalTimestamp,
    payload: BrokerJournalPayload,
    terminalOperations: [BrokerJournalTerminalOperation]
  ) throws(BrokerJournalError) -> BrokerJournalRecord {
    let record = try BrokerJournalRecord(
      revision: nextRevision(after: predecessor),
      connectionID: predecessor.connectionID,
      providerBinding: predecessor.providerBinding,
      fence: fence ?? predecessor.fence,
      lastGenerationOrdinal: predecessor.lastGenerationOrdinal,
      changedAt: changedAt,
      payload: payload,
      terminalOperations: terminalOperations
    )
    return try validated(predecessor: predecessor, successor: record)
  }

  private static func validated(
    predecessor: BrokerJournalRecord?,
    successor: BrokerJournalRecord
  ) throws(BrokerJournalError) -> BrokerJournalRecord {
    do {
      try BrokerJournalTransitionValidator.validate(
        predecessor: predecessor,
        successor: successor
      )
      return successor
    } catch let error {
      if error == .revisionOverflow {
        throw error
      }
      throw .invalidRecord
    }
  }

  private static func nextRevision(
    after record: BrokerJournalRecord
  ) throws(BrokerJournalError) -> UInt64 {
    guard let revision = incrementing(record.revision) else {
      throw .revisionOverflow
    }
    return revision
  }

  private static func incrementing(_ value: UInt64) -> UInt64? {
    let (result, overflow) = value.addingReportingOverflow(1)
    return overflow ? nil : result
  }

  private static func journalReadyProjection(
    connectionID: UUID,
    fence: UInt64,
    ready: BrokerJournalReadyGeneration,
    lastGenerationOrdinal: UInt64
  ) -> BrokerJournalReadyProjection {
    BrokerJournalReadyProjection(
      connectionID: connectionID,
      fence: fence,
      ready: ready,
      lastGenerationOrdinal: lastGenerationOrdinal
    )
  }

  private static func stageCleanupInstruction(
    connectionID: UUID,
    operationID: UUID,
    expectedFence: UInt64,
    candidate: BrokerJournalCredentialGeneration,
    error: BrokerJournalStageError
  ) -> BrokerJournalCleanupInstruction {
    BrokerJournalCleanupInstruction(
      terminalOperation: .stageFailure(
        BrokerJournalStageFailureTerminal(
          operationID: operationID,
          expectedFence: expectedFence,
          error: error
        )
      ),
      credentialKeys: [key(connectionID: connectionID, generation: candidate)]
    )
  }

  private static func key(
    connectionID: UUID,
    generation: BrokerJournalCredentialGeneration
  ) -> CredentialStoreKey {
    CredentialStoreKey(
      connectionID: connectionID,
      generationID: generation.generationID,
      generationOrdinal: generation.ordinal
    )
  }

  private static func attemptID(
    of operation: BrokerJournalTerminalOperation
  ) -> UUID? {
    switch operation {
    case .stageFailure, .disconnect:
      nil
    case .commit(let value):
      value.attemptID
    case .abort(let value):
      value.attemptID
    }
  }

  private static func validateNewOperationIdentity(
    operationID: UUID,
    attemptID: UUID?,
    in predecessor: BrokerJournalRecord
  ) throws(BrokerJournalError) {
    guard
      !predecessor.terminalOperations.contains(where: { $0.operationID == operationID })
    else {
      throw .invalidRecord
    }
    if let attemptID {
      guard
        !predecessor.terminalOperations.compactMap(attemptID(of:)).contains(attemptID)
      else {
        throw .invalidRecord
      }
    }
  }

  private static func generationIDs(in record: BrokerJournalRecord) -> Set<UUID> {
    var result: Set<UUID> = []
    func insert(_ generation: BrokerJournalCredentialGeneration?) {
      if let generation {
        result.insert(generation.generationID)
      }
    }
    func insert(_ projection: BrokerJournalReadyProjection?) {
      insert(projection?.ready.generation)
    }

    switch record.payload {
    case .vacant, .tombstoned:
      break
    case .storePending(let value):
      insert(value.candidate)
      insert(value.previousReady?.generation)
    case .staging(let value):
      insert(value.candidate)
      insert(value.previousReady?.generation)
    case .readyCleanupPending(let value):
      insert(value.ready.generation)
      insert(value.previousReady.generation)
    case .ready(let value):
      insert(value.ready.generation)
    case .stageCleanupPending(let value):
      insert(value.candidate)
      insert(value.restoredReady?.generation)
    case .abortCleanupPending(let value):
      insert(value.candidate)
      insert(value.restoredReady?.generation)
    case .disconnectFenced(let value):
      for generation in value.deleteGenerations {
        insert(generation)
      }
    }

    for operation in record.terminalOperations {
      switch operation {
      case .stageFailure, .disconnect:
        break
      case .commit(let value):
        insert(value.ready)
      case .abort(let value):
        insert(value.restoredReady)
      }
    }
    return result
  }
}
