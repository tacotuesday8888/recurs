import Foundation

package enum BrokerJournalPhase: Sendable, Hashable {
  case vacant
  case storePending
  case staging
  case readyCleanupPending
  case ready
  case stageCleanupPending
  case abortCleanupPending
  case disconnectFenced
  case tombstoned
}

package struct BrokerJournalCredentialGeneration: Sendable, Hashable {
  package let generationID: UUID
  package let ordinal: UInt64
  package let createdAt: JournalTimestamp

  package init(generationID: UUID, ordinal: UInt64, createdAt: JournalTimestamp) {
    self.generationID = generationID
    self.ordinal = ordinal
    self.createdAt = createdAt
  }
}

package struct BrokerJournalReadyGeneration: Sendable, Hashable {
  package let generation: BrokerJournalCredentialGeneration
  package let committedAt: JournalTimestamp

  package init(
    generation: BrokerJournalCredentialGeneration,
    committedAt: JournalTimestamp
  ) {
    self.generation = generation
    self.committedAt = committedAt
  }
}

package struct BrokerJournalReadyProjection: Sendable, Hashable {
  package let connectionID: UUID
  package let fence: UInt64
  package let ready: BrokerJournalReadyGeneration
  package let lastGenerationOrdinal: UInt64

  package init(
    connectionID: UUID,
    fence: UInt64,
    ready: BrokerJournalReadyGeneration,
    lastGenerationOrdinal: UInt64
  ) {
    self.connectionID = connectionID
    self.fence = fence
    self.ready = ready
    self.lastGenerationOrdinal = lastGenerationOrdinal
  }
}

package struct BrokerJournalTombstoneProjection: Sendable, Hashable {
  package let connectionID: UUID
  package let fence: UInt64
  package let lastGenerationOrdinal: UInt64
  package let tombstonedAt: JournalTimestamp

  package init(
    connectionID: UUID,
    fence: UInt64,
    lastGenerationOrdinal: UInt64,
    tombstonedAt: JournalTimestamp
  ) {
    self.connectionID = connectionID
    self.fence = fence
    self.lastGenerationOrdinal = lastGenerationOrdinal
    self.tombstonedAt = tombstonedAt
  }
}

package enum BrokerJournalStageError: Sendable, Hashable {
  case cancelled
  case storeUnavailable
  case attemptNotCurrent
}

package struct BrokerJournalVacantPayload: Sendable, Hashable {
  package init() {}
}

package struct BrokerJournalStorePendingPayload: Sendable, Hashable {
  package let attemptID: UUID
  package let operationID: UUID
  package let expectedFence: UInt64
  package let candidate: BrokerJournalCredentialGeneration
  package let previousReady: BrokerJournalReadyGeneration?
  package let startedAt: JournalTimestamp

  package init(
    attemptID: UUID,
    operationID: UUID,
    expectedFence: UInt64,
    candidate: BrokerJournalCredentialGeneration,
    previousReady: BrokerJournalReadyGeneration?,
    startedAt: JournalTimestamp
  ) {
    self.attemptID = attemptID
    self.operationID = operationID
    self.expectedFence = expectedFence
    self.candidate = candidate
    self.previousReady = previousReady
    self.startedAt = startedAt
  }
}

package struct BrokerJournalStagingPayload: Sendable, Hashable {
  package let attemptID: UUID
  package let operationID: UUID
  package let expectedFence: UInt64
  package let candidate: BrokerJournalCredentialGeneration
  package let previousReady: BrokerJournalReadyGeneration?
  package let startedAt: JournalTimestamp

  package init(
    attemptID: UUID,
    operationID: UUID,
    expectedFence: UInt64,
    candidate: BrokerJournalCredentialGeneration,
    previousReady: BrokerJournalReadyGeneration?,
    startedAt: JournalTimestamp
  ) {
    self.attemptID = attemptID
    self.operationID = operationID
    self.expectedFence = expectedFence
    self.candidate = candidate
    self.previousReady = previousReady
    self.startedAt = startedAt
  }
}

package struct BrokerJournalReadyCleanupPendingPayload: Sendable, Hashable {
  package let attemptID: UUID
  package let operationID: UUID
  package let expectedFence: UInt64
  package let ready: BrokerJournalReadyGeneration
  package let previousReady: BrokerJournalReadyGeneration

  package init(
    attemptID: UUID,
    operationID: UUID,
    expectedFence: UInt64,
    ready: BrokerJournalReadyGeneration,
    previousReady: BrokerJournalReadyGeneration
  ) {
    self.attemptID = attemptID
    self.operationID = operationID
    self.expectedFence = expectedFence
    self.ready = ready
    self.previousReady = previousReady
  }
}

package struct BrokerJournalReadyPayload: Sendable, Hashable {
  package let ready: BrokerJournalReadyGeneration

  package init(ready: BrokerJournalReadyGeneration) {
    self.ready = ready
  }
}

package struct BrokerJournalStageCleanupPendingPayload: Sendable, Hashable {
  package let attemptID: UUID
  package let operationID: UUID
  package let expectedFence: UInt64
  package let candidate: BrokerJournalCredentialGeneration
  package let restoredReady: BrokerJournalReadyGeneration?
  package let error: BrokerJournalStageError

  package init(
    attemptID: UUID,
    operationID: UUID,
    expectedFence: UInt64,
    candidate: BrokerJournalCredentialGeneration,
    restoredReady: BrokerJournalReadyGeneration?,
    error: BrokerJournalStageError
  ) {
    self.attemptID = attemptID
    self.operationID = operationID
    self.expectedFence = expectedFence
    self.candidate = candidate
    self.restoredReady = restoredReady
    self.error = error
  }
}

package struct BrokerJournalAbortCleanupPendingPayload: Sendable, Hashable {
  package let attemptID: UUID
  package let operationID: UUID
  package let expectedFence: UInt64
  package let candidate: BrokerJournalCredentialGeneration
  package let restoredReady: BrokerJournalReadyGeneration?

  package init(
    attemptID: UUID,
    operationID: UUID,
    expectedFence: UInt64,
    candidate: BrokerJournalCredentialGeneration,
    restoredReady: BrokerJournalReadyGeneration?
  ) {
    self.attemptID = attemptID
    self.operationID = operationID
    self.expectedFence = expectedFence
    self.candidate = candidate
    self.restoredReady = restoredReady
  }
}

package struct BrokerJournalDisconnectFencedPayload: Sendable, Hashable {
  package let operationID: UUID
  package let expectedFence: UInt64
  package let tombstonedAt: JournalTimestamp
  package let deleteGenerations: [BrokerJournalCredentialGeneration]

  package init(
    operationID: UUID,
    expectedFence: UInt64,
    tombstonedAt: JournalTimestamp,
    deleteGenerations: [BrokerJournalCredentialGeneration]
  ) {
    self.operationID = operationID
    self.expectedFence = expectedFence
    self.tombstonedAt = tombstonedAt
    self.deleteGenerations = deleteGenerations
  }
}

package struct BrokerJournalTombstonedPayload: Sendable, Hashable {
  package let tombstonedAt: JournalTimestamp

  package init(tombstonedAt: JournalTimestamp) {
    self.tombstonedAt = tombstonedAt
  }
}

package enum BrokerJournalPayload: Sendable, Hashable {
  case vacant(BrokerJournalVacantPayload)
  case storePending(BrokerJournalStorePendingPayload)
  case staging(BrokerJournalStagingPayload)
  case readyCleanupPending(BrokerJournalReadyCleanupPendingPayload)
  case ready(BrokerJournalReadyPayload)
  case stageCleanupPending(BrokerJournalStageCleanupPendingPayload)
  case abortCleanupPending(BrokerJournalAbortCleanupPendingPayload)
  case disconnectFenced(BrokerJournalDisconnectFencedPayload)
  case tombstoned(BrokerJournalTombstonedPayload)

  package var phase: BrokerJournalPhase {
    switch self {
    case .vacant:
      .vacant
    case .storePending:
      .storePending
    case .staging:
      .staging
    case .readyCleanupPending:
      .readyCleanupPending
    case .ready:
      .ready
    case .stageCleanupPending:
      .stageCleanupPending
    case .abortCleanupPending:
      .abortCleanupPending
    case .disconnectFenced:
      .disconnectFenced
    case .tombstoned:
      .tombstoned
    }
  }
}

package enum BrokerJournalTerminalKind: Sendable, Hashable {
  case stageFailure
  case commit
  case abort
  case disconnect
}

package struct BrokerJournalStageFailureTerminal: Sendable, Hashable {
  package let operationID: UUID
  package let expectedFence: UInt64
  package let error: BrokerJournalStageError

  package init(
    operationID: UUID,
    expectedFence: UInt64,
    error: BrokerJournalStageError
  ) {
    self.operationID = operationID
    self.expectedFence = expectedFence
    self.error = error
  }
}

package struct BrokerJournalCommitTerminal: Sendable, Hashable {
  package let operationID: UUID
  package let expectedFence: UInt64
  package let attemptID: UUID
  package let ready: BrokerJournalReadyProjection

  package init(
    operationID: UUID,
    expectedFence: UInt64,
    attemptID: UUID,
    ready: BrokerJournalReadyProjection
  ) {
    self.operationID = operationID
    self.expectedFence = expectedFence
    self.attemptID = attemptID
    self.ready = ready
  }
}

package struct BrokerJournalAbortTerminal: Sendable, Hashable {
  package let operationID: UUID
  package let expectedFence: UInt64
  package let attemptID: UUID
  package let restoredReady: BrokerJournalReadyProjection?

  package init(
    operationID: UUID,
    expectedFence: UInt64,
    attemptID: UUID,
    restoredReady: BrokerJournalReadyProjection?
  ) {
    self.operationID = operationID
    self.expectedFence = expectedFence
    self.attemptID = attemptID
    self.restoredReady = restoredReady
  }
}

package struct BrokerJournalDisconnectTerminal: Sendable, Hashable {
  package let operationID: UUID
  package let expectedFence: UInt64
  package let tombstone: BrokerJournalTombstoneProjection

  package init(
    operationID: UUID,
    expectedFence: UInt64,
    tombstone: BrokerJournalTombstoneProjection
  ) {
    self.operationID = operationID
    self.expectedFence = expectedFence
    self.tombstone = tombstone
  }
}

package enum BrokerJournalTerminalOperation: Sendable, Hashable {
  case stageFailure(BrokerJournalStageFailureTerminal)
  case commit(BrokerJournalCommitTerminal)
  case abort(BrokerJournalAbortTerminal)
  case disconnect(BrokerJournalDisconnectTerminal)

  package var kind: BrokerJournalTerminalKind {
    switch self {
    case .stageFailure:
      .stageFailure
    case .commit:
      .commit
    case .abort:
      .abort
    case .disconnect:
      .disconnect
    }
  }

  package var operationID: UUID {
    switch self {
    case .stageFailure(let value):
      value.operationID
    case .commit(let value):
      value.operationID
    case .abort(let value):
      value.operationID
    case .disconnect(let value):
      value.operationID
    }
  }

  package var expectedFence: UInt64 {
    switch self {
    case .stageFailure(let value):
      value.expectedFence
    case .commit(let value):
      value.expectedFence
    case .abort(let value):
      value.expectedFence
    case .disconnect(let value):
      value.expectedFence
    }
  }
}

package struct BrokerJournalRecord: Sendable, Hashable {
  package let schemaVersion: UInt64 = 2
  package let revision: UInt64
  package let connectionID: UUID
  package let providerBinding: ProviderProfileBinding
  package let phase: BrokerJournalPhase
  package let fence: UInt64
  package let lastGenerationOrdinal: UInt64
  package let changedAt: JournalTimestamp
  package let payload: BrokerJournalPayload
  package let terminalOperations: [BrokerJournalTerminalOperation]

  package init(
    revision: UInt64,
    connectionID: UUID,
    providerBinding: ProviderProfileBinding,
    fence: UInt64,
    lastGenerationOrdinal: UInt64,
    changedAt: JournalTimestamp,
    payload: BrokerJournalPayload,
    terminalOperations: [BrokerJournalTerminalOperation] = []
  ) throws(BrokerJournalError) {
    guard revision > 0 else {
      throw .invalidRecord
    }
    switch payload {
    case .disconnectFenced, .tombstoned:
      guard
        let tombstoneFence = Self.incrementing(lastGenerationOrdinal),
        tombstoneFence == fence
      else {
        throw .invalidRecord
      }
    default:
      guard fence == lastGenerationOrdinal, fence < UInt64.max else {
        throw .invalidRecord
      }
    }

    switch payload {
    case .storePending(let value):
      guard Self.incrementing(value.expectedFence) == fence else {
        throw .invalidRecord
      }
    case .staging(let value):
      guard Self.incrementing(value.expectedFence) == fence else {
        throw .invalidRecord
      }
    case .readyCleanupPending(let value):
      guard value.expectedFence == fence else {
        throw .invalidRecord
      }
    case .stageCleanupPending(let value):
      guard Self.incrementing(value.expectedFence) == fence else {
        throw .invalidRecord
      }
    case .abortCleanupPending(let value):
      guard value.expectedFence == fence else {
        throw .invalidRecord
      }
    case .disconnectFenced(let value):
      guard Self.incrementing(value.expectedFence) == fence else {
        throw .invalidRecord
      }
    case .vacant, .ready, .tombstoned:
      break
    }

    switch payload {
    case .storePending(let value):
      guard
        Self.isValidCandidate(
          value.candidate, priorReady: value.previousReady,
          lastGenerationOrdinal: lastGenerationOrdinal)
      else {
        throw .invalidRecord
      }
    case .staging(let value):
      guard
        Self.isValidCandidate(
          value.candidate, priorReady: value.previousReady,
          lastGenerationOrdinal: lastGenerationOrdinal)
      else {
        throw .invalidRecord
      }
    case .readyCleanupPending(let value):
      guard
        Self.isValidReady(value.ready, lastGenerationOrdinal: lastGenerationOrdinal),
        Self.isValidPriorReady(
          value.previousReady,
          candidate: value.ready.generation,
          lastGenerationOrdinal: lastGenerationOrdinal
        )
      else {
        throw .invalidRecord
      }
    case .ready(let value):
      guard Self.isValidReady(value.ready, lastGenerationOrdinal: lastGenerationOrdinal) else {
        throw .invalidRecord
      }
    case .stageCleanupPending(let value):
      guard
        Self.isValidCandidate(
          value.candidate, priorReady: value.restoredReady,
          lastGenerationOrdinal: lastGenerationOrdinal)
      else {
        throw .invalidRecord
      }
    case .abortCleanupPending(let value):
      guard
        Self.isValidCandidate(
          value.candidate, priorReady: value.restoredReady,
          lastGenerationOrdinal: lastGenerationOrdinal)
      else {
        throw .invalidRecord
      }
    case .disconnectFenced(let value):
      guard
        Self.isValidDeleteList(
          value.deleteGenerations, lastGenerationOrdinal: lastGenerationOrdinal)
      else {
        throw .invalidRecord
      }
    case .vacant, .tombstoned:
      break
    }

    try Self.validateTerminalOperations(
      terminalOperations,
      connectionID: connectionID,
      fence: fence,
      lastGenerationOrdinal: lastGenerationOrdinal,
      payload: payload
    )

    self.revision = revision
    self.connectionID = connectionID
    self.providerBinding = providerBinding
    phase = payload.phase
    self.fence = fence
    self.lastGenerationOrdinal = lastGenerationOrdinal
    self.changedAt = changedAt
    self.payload = payload
    self.terminalOperations = terminalOperations
  }

  private static func incrementing(_ value: UInt64) -> UInt64? {
    let (result, overflow) = value.addingReportingOverflow(1)
    return overflow ? nil : result
  }

  private static func isValidCandidate(
    _ candidate: BrokerJournalCredentialGeneration,
    priorReady: BrokerJournalReadyGeneration?,
    lastGenerationOrdinal: UInt64
  ) -> Bool {
    guard candidate.ordinal > 0, candidate.ordinal == lastGenerationOrdinal else {
      return false
    }
    guard let priorReady else {
      return true
    }
    return isValidPriorReady(
      priorReady,
      candidate: candidate,
      lastGenerationOrdinal: lastGenerationOrdinal
    )
  }

  private static func isValidPriorReady(
    _ ready: BrokerJournalReadyGeneration,
    candidate: BrokerJournalCredentialGeneration,
    lastGenerationOrdinal: UInt64
  ) -> Bool {
    let prior = ready.generation
    return prior.ordinal > 0
      && prior.ordinal <= lastGenerationOrdinal
      && prior.ordinal < candidate.ordinal
      && prior.generationID != candidate.generationID
  }

  private static func isValidReady(
    _ ready: BrokerJournalReadyGeneration,
    lastGenerationOrdinal: UInt64
  ) -> Bool {
    ready.generation.ordinal > 0
      && ready.generation.ordinal <= lastGenerationOrdinal
  }

  private static func isValidDeleteList(
    _ generations: [BrokerJournalCredentialGeneration],
    lastGenerationOrdinal: UInt64
  ) -> Bool {
    guard generations.count <= 2 else {
      return false
    }
    var generationIDs: Set<UUID> = []
    var previousOrdinal: UInt64?
    for generation in generations {
      guard
        generation.ordinal > 0,
        generation.ordinal <= lastGenerationOrdinal,
        generationIDs.insert(generation.generationID).inserted
      else {
        return false
      }
      if let previousOrdinal, previousOrdinal <= generation.ordinal {
        return false
      }
      previousOrdinal = generation.ordinal
    }
    return true
  }

  private static func validateTerminalOperations(
    _ operations: [BrokerJournalTerminalOperation],
    connectionID: UUID,
    fence: UInt64,
    lastGenerationOrdinal: UInt64,
    payload: BrokerJournalPayload
  ) throws(BrokerJournalError) {
    guard operations.count <= 64 else {
      throw .invalidRecord
    }

    var generations: [UUID: BrokerJournalCredentialGeneration] = [:]
    guard registerPayloadGenerations(payload, in: &generations) else {
      throw .invalidRecord
    }
    var operationIDs: Set<UUID> = []
    var attemptIDs: Set<UUID> = []

    for (index, operation) in operations.enumerated() {
      guard operationIDs.insert(operation.operationID).inserted else {
        throw .invalidRecord
      }
      switch operation {
      case .stageFailure(let value):
        guard
          let stageFence = incrementing(value.expectedFence),
          stageFence <= fence
        else {
          throw .invalidRecord
        }

      case .commit(let value):
        guard
          attemptIDs.insert(value.attemptID).inserted,
          value.ready.fence == value.expectedFence,
          isValidReadyProjection(
            value.ready,
            connectionID: connectionID,
            currentFence: fence,
            generations: &generations
          )
        else {
          throw .invalidRecord
        }

      case .abort(let value):
        guard attemptIDs.insert(value.attemptID).inserted, value.expectedFence <= fence else {
          throw .invalidRecord
        }
        if let restoredReady = value.restoredReady {
          guard
            restoredReady.fence == value.expectedFence,
            isValidReadyProjection(
              restoredReady,
              connectionID: connectionID,
              currentFence: fence,
              generations: &generations
            )
          else {
            throw .invalidRecord
          }
        }

      case .disconnect(let value):
        guard
          index == operations.index(before: operations.endIndex),
          let tombstoneFence = incrementing(value.expectedFence),
          tombstoneFence == value.tombstone.fence,
          let current = currentTombstoneProjection(
            connectionID: connectionID,
            fence: fence,
            lastGenerationOrdinal: lastGenerationOrdinal,
            payload: payload
          ),
          value.tombstone == current
        else {
          throw .invalidRecord
        }
      }
    }
  }

  private static func registerPayloadGenerations(
    _ payload: BrokerJournalPayload,
    in generations: inout [UUID: BrokerJournalCredentialGeneration]
  ) -> Bool {
    switch payload {
    case .vacant, .tombstoned:
      return true
    case .storePending(let value):
      return register(value.candidate, in: &generations)
        && register(value.previousReady?.generation, in: &generations)
    case .staging(let value):
      return register(value.candidate, in: &generations)
        && register(value.previousReady?.generation, in: &generations)
    case .readyCleanupPending(let value):
      return register(value.ready.generation, in: &generations)
        && register(value.previousReady.generation, in: &generations)
    case .ready(let value):
      return register(value.ready.generation, in: &generations)
    case .stageCleanupPending(let value):
      return register(value.candidate, in: &generations)
        && register(value.restoredReady?.generation, in: &generations)
    case .abortCleanupPending(let value):
      return register(value.candidate, in: &generations)
        && register(value.restoredReady?.generation, in: &generations)
    case .disconnectFenced(let value):
      return value.deleteGenerations.allSatisfy { register($0, in: &generations) }
    }
  }

  private static func register(
    _ generation: BrokerJournalCredentialGeneration?,
    in generations: inout [UUID: BrokerJournalCredentialGeneration]
  ) -> Bool {
    guard let generation else {
      return true
    }
    if let existing = generations[generation.generationID] {
      return existing == generation
    }
    generations[generation.generationID] = generation
    return true
  }

  private static func isValidReadyProjection(
    _ projection: BrokerJournalReadyProjection,
    connectionID: UUID,
    currentFence: UInt64,
    generations: inout [UUID: BrokerJournalCredentialGeneration]
  ) -> Bool {
    projection.connectionID == connectionID
      && projection.fence == projection.lastGenerationOrdinal
      && projection.fence < UInt64.max
      && projection.fence <= currentFence
      && isValidReady(
        projection.ready,
        lastGenerationOrdinal: projection.lastGenerationOrdinal
      )
      && register(projection.ready.generation, in: &generations)
  }

  private static func currentTombstoneProjection(
    connectionID: UUID,
    fence: UInt64,
    lastGenerationOrdinal: UInt64,
    payload: BrokerJournalPayload
  ) -> BrokerJournalTombstoneProjection? {
    guard case .tombstoned(let value) = payload else {
      return nil
    }
    return BrokerJournalTombstoneProjection(
      connectionID: connectionID,
      fence: fence,
      lastGenerationOrdinal: lastGenerationOrdinal,
      tombstonedAt: value.tombstonedAt
    )
  }
}

package enum BrokerJournalTransitionValidator {
  package static func validate(
    predecessor: BrokerJournalRecord?,
    successor: BrokerJournalRecord
  ) throws(BrokerJournalError) {
    guard let predecessor else {
      guard
        successor.revision == 1,
        successor.fence == 1,
        successor.lastGenerationOrdinal == 1,
        successor.terminalOperations.isEmpty,
        case .storePending(let payload) = successor.payload,
        payload.expectedFence == 0,
        payload.previousReady == nil
      else {
        throw .casConflict
      }
      return
    }

    guard predecessor.revision < UInt64.max else {
      throw .revisionOverflow
    }
    guard
      successor.connectionID == predecessor.connectionID,
      successor.providerBinding == predecessor.providerBinding,
      successor.revision == predecessor.revision + 1
    else {
      throw .casConflict
    }

    let accepted: Bool
    switch (predecessor.payload, successor.payload) {
    case (.vacant, .storePending(let next)):
      accepted = acceptsNewStage(
        predecessor: predecessor,
        successor: successor,
        next: next,
        previousReady: nil
      )

    case (.ready(let current), .storePending(let next)):
      accepted = acceptsNewStage(
        predecessor: predecessor,
        successor: successor,
        next: next,
        previousReady: current.ready
      )

    case (.storePending(let current), .staging(let next)):
      accepted =
        sameCountersAndFIFO(predecessor, successor)
        && StageIdentity(current) == StageIdentity(next)

    case (.storePending(let current), .vacant):
      accepted =
        current.previousReady == nil
        && acceptsStableStageFailure(
          predecessor: predecessor,
          successor: successor,
          operationID: current.operationID,
          expectedFence: current.expectedFence,
          error: .storeUnavailable
        )

    case (.storePending(let current), .ready(let next)):
      accepted =
        current.previousReady == next.ready
        && acceptsStableStageFailure(
          predecessor: predecessor,
          successor: successor,
          operationID: current.operationID,
          expectedFence: current.expectedFence,
          error: .storeUnavailable
        )

    case (.storePending(let current), .stageCleanupPending(let next)):
      accepted = acceptsStageCleanup(
        predecessor: predecessor,
        successor: successor,
        current: StageIdentity(current),
        next: next
      )

    case (.staging(let current), .stageCleanupPending(let next)):
      accepted = acceptsStageCleanup(
        predecessor: predecessor,
        successor: successor,
        current: StageIdentity(current),
        next: next
      )

    case (.stageCleanupPending(let current), .vacant):
      accepted =
        current.restoredReady == nil
        && acceptsStableStageFailure(
          predecessor: predecessor,
          successor: successor,
          operationID: current.operationID,
          expectedFence: current.expectedFence,
          error: current.error
        )

    case (.stageCleanupPending(let current), .ready(let next)):
      accepted =
        current.restoredReady == next.ready
        && acceptsStableStageFailure(
          predecessor: predecessor,
          successor: successor,
          operationID: current.operationID,
          expectedFence: current.expectedFence,
          error: current.error
        )

    case (.staging(let current), .readyCleanupPending(let next)):
      accepted =
        current.previousReady != nil
        && sameCountersAndFIFO(predecessor, successor)
        && next.attemptID == current.attemptID
        && next.expectedFence == predecessor.fence
        && next.ready.generation == current.candidate
        && next.previousReady == current.previousReady

    case (.staging(let current), .ready(let next)):
      accepted = acceptsDirectCommit(
        predecessor: predecessor,
        successor: successor,
        current: current,
        next: next
      )

    case (.readyCleanupPending(let current), .ready(let next)):
      let projection = readyProjection(for: successor, ready: next.ready)
      let terminal = BrokerJournalTerminalOperation.commit(
        BrokerJournalCommitTerminal(
          operationID: current.operationID,
          expectedFence: current.expectedFence,
          attemptID: current.attemptID,
          ready: projection
        )
      )
      accepted =
        next.ready == current.ready
        && successor.fence == predecessor.fence
        && successor.lastGenerationOrdinal == predecessor.lastGenerationOrdinal
        && hasAppended(
          terminal,
          to: predecessor.terminalOperations,
          producing: successor.terminalOperations
        )

    case (.staging(let current), .abortCleanupPending(let next)):
      accepted =
        sameCountersAndFIFO(predecessor, successor)
        && next.attemptID == current.attemptID
        && next.expectedFence == predecessor.fence
        && next.candidate == current.candidate
        && next.restoredReady == current.previousReady

    case (.abortCleanupPending(let current), .vacant):
      accepted =
        current.restoredReady == nil
        && acceptsStableAbort(
          predecessor: predecessor,
          successor: successor,
          current: current,
          restoredReady: nil
        )

    case (.abortCleanupPending(let current), .ready(let next)):
      accepted =
        current.restoredReady == next.ready
        && acceptsStableAbort(
          predecessor: predecessor,
          successor: successor,
          current: current,
          restoredReady: next.ready
        )

    case (.vacant, .disconnectFenced(let next)):
      accepted = acceptsDisconnect(
        predecessor: predecessor,
        successor: successor,
        next: next,
        expectedGenerations: []
      )

    case (.ready(let current), .disconnectFenced(let next)):
      accepted = acceptsDisconnect(
        predecessor: predecessor,
        successor: successor,
        next: next,
        expectedGenerations: [current.ready.generation]
      )

    case (.staging(let current), .disconnectFenced(let next)):
      var generations = [current.candidate]
      if let previousReady = current.previousReady {
        generations.append(previousReady.generation)
      }
      accepted = acceptsDisconnect(
        predecessor: predecessor,
        successor: successor,
        next: next,
        expectedGenerations: generations
      )

    case (.disconnectFenced(let current), .tombstoned(let next)):
      let projection = BrokerJournalTombstoneProjection(
        connectionID: successor.connectionID,
        fence: successor.fence,
        lastGenerationOrdinal: successor.lastGenerationOrdinal,
        tombstonedAt: next.tombstonedAt
      )
      let terminal = BrokerJournalTerminalOperation.disconnect(
        BrokerJournalDisconnectTerminal(
          operationID: current.operationID,
          expectedFence: current.expectedFence,
          tombstone: projection
        )
      )
      accepted =
        next.tombstonedAt == current.tombstonedAt
        && successor.fence == predecessor.fence
        && successor.lastGenerationOrdinal == predecessor.lastGenerationOrdinal
        && hasAppended(
          terminal,
          to: predecessor.terminalOperations,
          producing: successor.terminalOperations
        )

    default:
      accepted = false
    }

    guard accepted else {
      throw .casConflict
    }
  }

  private struct StageIdentity: Equatable {
    let attemptID: UUID
    let operationID: UUID
    let expectedFence: UInt64
    let candidate: BrokerJournalCredentialGeneration
    let previousReady: BrokerJournalReadyGeneration?
    let startedAt: JournalTimestamp

    init(_ value: BrokerJournalStorePendingPayload) {
      attemptID = value.attemptID
      operationID = value.operationID
      expectedFence = value.expectedFence
      candidate = value.candidate
      previousReady = value.previousReady
      startedAt = value.startedAt
    }

    init(_ value: BrokerJournalStagingPayload) {
      attemptID = value.attemptID
      operationID = value.operationID
      expectedFence = value.expectedFence
      candidate = value.candidate
      previousReady = value.previousReady
      startedAt = value.startedAt
    }
  }

  private static func acceptsNewStage(
    predecessor: BrokerJournalRecord,
    successor: BrokerJournalRecord,
    next: BrokerJournalStorePendingPayload,
    previousReady: BrokerJournalReadyGeneration?
  ) -> Bool {
    guard
      let nextFence = incrementing(predecessor.fence),
      let nextOrdinal = incrementing(predecessor.lastGenerationOrdinal)
    else {
      return false
    }
    return successor.fence == nextFence
      && successor.lastGenerationOrdinal == nextOrdinal
      && next.expectedFence == predecessor.fence
      && next.previousReady == previousReady
      && successor.terminalOperations == predecessor.terminalOperations
  }

  private static func acceptsStableStageFailure(
    predecessor: BrokerJournalRecord,
    successor: BrokerJournalRecord,
    operationID: UUID,
    expectedFence: UInt64,
    error: BrokerJournalStageError
  ) -> Bool {
    let terminal = BrokerJournalTerminalOperation.stageFailure(
      BrokerJournalStageFailureTerminal(
        operationID: operationID,
        expectedFence: expectedFence,
        error: error
      )
    )
    return successor.fence == predecessor.fence
      && successor.lastGenerationOrdinal == predecessor.lastGenerationOrdinal
      && hasAppended(
        terminal,
        to: predecessor.terminalOperations,
        producing: successor.terminalOperations
      )
  }

  private static func acceptsStageCleanup(
    predecessor: BrokerJournalRecord,
    successor: BrokerJournalRecord,
    current: StageIdentity,
    next: BrokerJournalStageCleanupPendingPayload
  ) -> Bool {
    sameCountersAndFIFO(predecessor, successor)
      && next.attemptID == current.attemptID
      && next.operationID == current.operationID
      && next.expectedFence == current.expectedFence
      && next.candidate == current.candidate
      && next.restoredReady == current.previousReady
  }

  private static func acceptsDirectCommit(
    predecessor: BrokerJournalRecord,
    successor: BrokerJournalRecord,
    current: BrokerJournalStagingPayload,
    next: BrokerJournalReadyPayload
  ) -> Bool {
    guard
      current.previousReady == nil,
      successor.fence == predecessor.fence,
      successor.lastGenerationOrdinal == predecessor.lastGenerationOrdinal,
      next.ready.generation == current.candidate,
      let appended = appendedOperation(
        to: predecessor.terminalOperations,
        producing: successor.terminalOperations
      ),
      case .commit(let terminal) = appended
    else {
      return false
    }
    return terminal.attemptID == current.attemptID
      && terminal.expectedFence == predecessor.fence
      && terminal.ready == readyProjection(for: successor, ready: next.ready)
  }

  private static func acceptsStableAbort(
    predecessor: BrokerJournalRecord,
    successor: BrokerJournalRecord,
    current: BrokerJournalAbortCleanupPendingPayload,
    restoredReady: BrokerJournalReadyGeneration?
  ) -> Bool {
    let projection = restoredReady.map { readyProjection(for: successor, ready: $0) }
    let terminal = BrokerJournalTerminalOperation.abort(
      BrokerJournalAbortTerminal(
        operationID: current.operationID,
        expectedFence: current.expectedFence,
        attemptID: current.attemptID,
        restoredReady: projection
      )
    )
    return successor.fence == predecessor.fence
      && successor.lastGenerationOrdinal == predecessor.lastGenerationOrdinal
      && hasAppended(
        terminal,
        to: predecessor.terminalOperations,
        producing: successor.terminalOperations
      )
  }

  private static func acceptsDisconnect(
    predecessor: BrokerJournalRecord,
    successor: BrokerJournalRecord,
    next: BrokerJournalDisconnectFencedPayload,
    expectedGenerations: [BrokerJournalCredentialGeneration]
  ) -> Bool {
    guard let nextFence = incrementing(predecessor.fence) else {
      return false
    }
    return successor.fence == nextFence
      && successor.lastGenerationOrdinal == predecessor.lastGenerationOrdinal
      && next.expectedFence == predecessor.fence
      && next.deleteGenerations == expectedGenerations
      && successor.terminalOperations == predecessor.terminalOperations
  }

  private static func sameCountersAndFIFO(
    _ predecessor: BrokerJournalRecord,
    _ successor: BrokerJournalRecord
  ) -> Bool {
    successor.fence == predecessor.fence
      && successor.lastGenerationOrdinal == predecessor.lastGenerationOrdinal
      && successor.terminalOperations == predecessor.terminalOperations
  }

  private static func hasAppended(
    _ operation: BrokerJournalTerminalOperation,
    to previous: [BrokerJournalTerminalOperation],
    producing successor: [BrokerJournalTerminalOperation]
  ) -> Bool {
    var expected = previous
    expected.append(operation)
    if expected.count == 65 {
      expected.removeFirst()
    }
    return successor == expected
  }

  private static func appendedOperation(
    to previous: [BrokerJournalTerminalOperation],
    producing successor: [BrokerJournalTerminalOperation]
  ) -> BrokerJournalTerminalOperation? {
    guard let appended = successor.last else {
      return nil
    }
    if previous.count < 64 {
      return successor.count == previous.count + 1
        && Array(successor.dropLast()) == previous
        ? appended : nil
    }
    return successor.count == 64
      && Array(successor.dropLast()) == Array(previous.dropFirst())
      ? appended : nil
  }

  private static func readyProjection(
    for record: BrokerJournalRecord,
    ready: BrokerJournalReadyGeneration
  ) -> BrokerJournalReadyProjection {
    BrokerJournalReadyProjection(
      connectionID: record.connectionID,
      fence: record.fence,
      ready: ready,
      lastGenerationOrdinal: record.lastGenerationOrdinal
    )
  }

  private static func incrementing(_ value: UInt64) -> UInt64? {
    let (result, overflow) = value.addingReportingOverflow(1)
    return overflow ? nil : result
  }
}
