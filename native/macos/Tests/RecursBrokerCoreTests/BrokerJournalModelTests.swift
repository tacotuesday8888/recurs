import Foundation
import Testing

@testable import RecursBrokerCore

@Suite("Broker journal model")
struct BrokerJournalModelTests {
  @Test
  func phaseContainsExactlyTheNineContractCases() {
    let phases: [BrokerJournalPhase] = [
      .vacant,
      .storePending,
      .staging,
      .readyCleanupPending,
      .ready,
      .stageCleanupPending,
      .abortCleanupPending,
      .disconnectFenced,
      .tombstoned,
    ]

    #expect(Set(phases).count == 9)
  }

  @Test
  func generationAndProjectionValuesRetainOnlyCanonicalJournalFields() throws {
    let connectionID = UUID(uuidString: "00000000-0000-4000-8000-000000000001")!
    let generationID = UUID(uuidString: "00000000-0000-4000-8000-000000000002")!
    let createdAt = try JournalTimestamp(unixMilliseconds: 1_000)
    let committedAt = try JournalTimestamp(unixMilliseconds: 2_000)
    let generation = BrokerJournalCredentialGeneration(
      generationID: generationID,
      ordinal: 1,
      createdAt: createdAt
    )
    let ready = BrokerJournalReadyGeneration(
      generation: generation,
      committedAt: committedAt
    )
    let readyProjection = BrokerJournalReadyProjection(
      connectionID: connectionID,
      fence: 1,
      ready: ready,
      lastGenerationOrdinal: 1
    )
    let tombstone = BrokerJournalTombstoneProjection(
      connectionID: connectionID,
      fence: 2,
      lastGenerationOrdinal: 1,
      tombstonedAt: committedAt
    )

    #expect(ready.generation.generationID == generationID)
    #expect(ready.generation.createdAt == createdAt)
    #expect(readyProjection.connectionID == connectionID)
    #expect(readyProjection.fence == readyProjection.lastGenerationOrdinal)
    #expect(tombstone.fence == tombstone.lastGenerationOrdinal + 1)
  }

  @Test
  func everyPhaseHasOneExactPayloadValueType() throws {
    let timestamp = try JournalTimestamp(unixMilliseconds: 3_000)
    let attemptID = fixtureUUID(10)
    let operationID = fixtureUUID(11)
    let previous = readyGeneration(id: 12, ordinal: 1, timestamp: timestamp)
    let candidate = credentialGeneration(id: 13, ordinal: 2, timestamp: timestamp)
    let ready = BrokerJournalReadyGeneration(generation: candidate, committedAt: timestamp)

    let payloads: [BrokerJournalPayload] = [
      .vacant(BrokerJournalVacantPayload()),
      .storePending(
        BrokerJournalStorePendingPayload(
          attemptID: attemptID,
          operationID: operationID,
          expectedFence: 1,
          candidate: candidate,
          previousReady: previous,
          startedAt: timestamp
        )
      ),
      .staging(
        BrokerJournalStagingPayload(
          attemptID: attemptID,
          operationID: operationID,
          expectedFence: 1,
          candidate: candidate,
          previousReady: previous,
          startedAt: timestamp
        )
      ),
      .readyCleanupPending(
        BrokerJournalReadyCleanupPendingPayload(
          attemptID: attemptID,
          operationID: operationID,
          expectedFence: 2,
          ready: ready,
          previousReady: previous
        )
      ),
      .ready(BrokerJournalReadyPayload(ready: ready)),
      .stageCleanupPending(
        BrokerJournalStageCleanupPendingPayload(
          attemptID: attemptID,
          operationID: operationID,
          expectedFence: 1,
          candidate: candidate,
          restoredReady: previous,
          error: .cancelled
        )
      ),
      .abortCleanupPending(
        BrokerJournalAbortCleanupPendingPayload(
          attemptID: attemptID,
          operationID: operationID,
          expectedFence: 2,
          candidate: candidate,
          restoredReady: previous
        )
      ),
      .disconnectFenced(
        BrokerJournalDisconnectFencedPayload(
          operationID: operationID,
          expectedFence: 2,
          tombstonedAt: timestamp,
          deleteGenerations: [candidate, previous.generation]
        )
      ),
      .tombstoned(BrokerJournalTombstonedPayload(tombstonedAt: timestamp)),
    ]

    #expect(
      payloads.map(\.phase) == [
        .vacant,
        .storePending,
        .staging,
        .readyCleanupPending,
        .ready,
        .stageCleanupPending,
        .abortCleanupPending,
        .disconnectFenced,
        .tombstoned,
      ])
  }

  @Test
  func terminalOperationsExposeOnlyTheirKindSpecificFields() throws {
    let timestamp = try JournalTimestamp(unixMilliseconds: 4_000)
    let connectionID = fixtureUUID(20)
    let generation = readyGeneration(id: 21, ordinal: 1, timestamp: timestamp)
    let ready = BrokerJournalReadyProjection(
      connectionID: connectionID,
      fence: 1,
      ready: generation,
      lastGenerationOrdinal: 1
    )
    let tombstone = BrokerJournalTombstoneProjection(
      connectionID: connectionID,
      fence: 2,
      lastGenerationOrdinal: 1,
      tombstonedAt: timestamp
    )
    let operations: [BrokerJournalTerminalOperation] = [
      .stageFailure(
        BrokerJournalStageFailureTerminal(
          operationID: fixtureUUID(22),
          expectedFence: 0,
          error: .storeUnavailable
        )
      ),
      .commit(
        BrokerJournalCommitTerminal(
          operationID: fixtureUUID(23),
          expectedFence: 1,
          attemptID: fixtureUUID(24),
          ready: ready
        )
      ),
      .abort(
        BrokerJournalAbortTerminal(
          operationID: fixtureUUID(25),
          expectedFence: 1,
          attemptID: fixtureUUID(26),
          restoredReady: nil
        )
      ),
      .disconnect(
        BrokerJournalDisconnectTerminal(
          operationID: fixtureUUID(27),
          expectedFence: 1,
          tombstone: tombstone
        )
      ),
    ]

    #expect(operations.map(\.kind) == [.stageFailure, .commit, .abort, .disconnect])
    #expect(operations.map(\.operationID).count == 4)
  }

  @Test
  func recordAcceptsOneStructurallyValidValueForEveryPhase() throws {
    let timestamp = try JournalTimestamp(unixMilliseconds: 5_000)
    let previous = readyGeneration(id: 31, ordinal: 1, timestamp: timestamp)
    let candidate = credentialGeneration(id: 32, ordinal: 2, timestamp: timestamp)
    let ready = BrokerJournalReadyGeneration(generation: candidate, committedAt: timestamp)
    let attemptID = fixtureUUID(33)
    let operationID = fixtureUUID(34)
    let fixtures: [(BrokerJournalPayload, UInt64, UInt64)] = [
      (.vacant(BrokerJournalVacantPayload()), 0, 0),
      (
        .storePending(
          BrokerJournalStorePendingPayload(
            attemptID: attemptID,
            operationID: operationID,
            expectedFence: 1,
            candidate: candidate,
            previousReady: previous,
            startedAt: timestamp
          )
        ),
        2,
        2
      ),
      (
        .staging(
          BrokerJournalStagingPayload(
            attemptID: attemptID,
            operationID: operationID,
            expectedFence: 1,
            candidate: candidate,
            previousReady: previous,
            startedAt: timestamp
          )
        ),
        2,
        2
      ),
      (
        .readyCleanupPending(
          BrokerJournalReadyCleanupPendingPayload(
            attemptID: attemptID,
            operationID: operationID,
            expectedFence: 2,
            ready: ready,
            previousReady: previous
          )
        ),
        2,
        2
      ),
      (.ready(BrokerJournalReadyPayload(ready: ready)), 2, 2),
      (
        .stageCleanupPending(
          BrokerJournalStageCleanupPendingPayload(
            attemptID: attemptID,
            operationID: operationID,
            expectedFence: 1,
            candidate: candidate,
            restoredReady: previous,
            error: .attemptNotCurrent
          )
        ),
        2,
        2
      ),
      (
        .abortCleanupPending(
          BrokerJournalAbortCleanupPendingPayload(
            attemptID: attemptID,
            operationID: operationID,
            expectedFence: 2,
            candidate: candidate,
            restoredReady: previous
          )
        ),
        2,
        2
      ),
      (
        .disconnectFenced(
          BrokerJournalDisconnectFencedPayload(
            operationID: operationID,
            expectedFence: 2,
            tombstonedAt: timestamp,
            deleteGenerations: [candidate, previous.generation]
          )
        ),
        3,
        2
      ),
      (.tombstoned(BrokerJournalTombstonedPayload(tombstonedAt: timestamp)), 3, 2),
    ]

    var phases: [BrokerJournalPhase] = []
    for (payload, fence, lastOrdinal) in fixtures {
      let record = try BrokerJournalRecord(
        revision: 1,
        connectionID: fixtureUUID(30),
        providerBinding: .openAI,
        fence: fence,
        lastGenerationOrdinal: lastOrdinal,
        changedAt: timestamp,
        payload: payload,
        terminalOperations: []
      )
      #expect(record.schemaVersion == 2)
      #expect(record.providerBinding == .openAI)
      phases.append(record.phase)
    }
    #expect(phases.count == 9)
  }

  @Test
  func recordRejectsInvalidRevisionFenceAndExpectedFenceArithmetic() throws {
    let timestamp = try JournalTimestamp(unixMilliseconds: 6_000)
    let candidate = credentialGeneration(id: 41, ordinal: 2, timestamp: timestamp)
    let previous = readyGeneration(id: 42, ordinal: 1, timestamp: timestamp)
    let ready = BrokerJournalReadyGeneration(generation: candidate, committedAt: timestamp)

    #expect(throws: BrokerJournalError.invalidRecord) {
      _ = try modelRecord(
        revision: 0,
        fence: 0,
        lastOrdinal: 0,
        payload: .vacant(BrokerJournalVacantPayload()),
        timestamp: timestamp
      )
    }
    #expect(throws: BrokerJournalError.invalidRecord) {
      _ = try modelRecord(
        fence: 1,
        lastOrdinal: 0,
        payload: .vacant(BrokerJournalVacantPayload()),
        timestamp: timestamp
      )
    }
    #expect(throws: BrokerJournalError.invalidRecord) {
      _ = try modelRecord(
        fence: .max,
        lastOrdinal: .max,
        payload: .vacant(BrokerJournalVacantPayload()),
        timestamp: timestamp
      )
    }
    #expect(throws: BrokerJournalError.invalidRecord) {
      _ = try modelRecord(
        fence: .max,
        lastOrdinal: .max,
        payload: .tombstoned(BrokerJournalTombstonedPayload(tombstonedAt: timestamp)),
        timestamp: timestamp
      )
    }
    #expect(throws: BrokerJournalError.invalidRecord) {
      _ = try modelRecord(
        fence: 4,
        lastOrdinal: 2,
        payload: .tombstoned(BrokerJournalTombstonedPayload(tombstonedAt: timestamp)),
        timestamp: timestamp
      )
    }

    let wrongExpectedFencePayloads: [(BrokerJournalPayload, UInt64, UInt64)] = [
      (
        .storePending(
          BrokerJournalStorePendingPayload(
            attemptID: fixtureUUID(43),
            operationID: fixtureUUID(44),
            expectedFence: 0,
            candidate: candidate,
            previousReady: previous,
            startedAt: timestamp
          )
        ),
        2,
        2
      ),
      (
        .staging(
          BrokerJournalStagingPayload(
            attemptID: fixtureUUID(43),
            operationID: fixtureUUID(44),
            expectedFence: 2,
            candidate: candidate,
            previousReady: previous,
            startedAt: timestamp
          )
        ),
        2,
        2
      ),
      (
        .stageCleanupPending(
          BrokerJournalStageCleanupPendingPayload(
            attemptID: fixtureUUID(43),
            operationID: fixtureUUID(44),
            expectedFence: .max,
            candidate: candidate,
            restoredReady: previous,
            error: .cancelled
          )
        ),
        2,
        2
      ),
      (
        .readyCleanupPending(
          BrokerJournalReadyCleanupPendingPayload(
            attemptID: fixtureUUID(43),
            operationID: fixtureUUID(44),
            expectedFence: 1,
            ready: ready,
            previousReady: previous
          )
        ),
        2,
        2
      ),
      (
        .abortCleanupPending(
          BrokerJournalAbortCleanupPendingPayload(
            attemptID: fixtureUUID(43),
            operationID: fixtureUUID(44),
            expectedFence: 1,
            candidate: candidate,
            restoredReady: previous
          )
        ),
        2,
        2
      ),
      (
        .disconnectFenced(
          BrokerJournalDisconnectFencedPayload(
            operationID: fixtureUUID(44),
            expectedFence: .max,
            tombstonedAt: timestamp,
            deleteGenerations: [candidate, previous.generation]
          )
        ),
        3,
        2
      ),
    ]
    for (payload, fence, lastOrdinal) in wrongExpectedFencePayloads {
      #expect(throws: BrokerJournalError.invalidRecord) {
        _ = try modelRecord(
          fence: fence,
          lastOrdinal: lastOrdinal,
          payload: payload,
          timestamp: timestamp
        )
      }
    }
  }

  @Test
  func recordRejectsInvalidGenerationOrdinalsIdentitiesAndDeleteLists() throws {
    let timestamp = try JournalTimestamp(unixMilliseconds: 7_000)
    let attemptID = fixtureUUID(50)
    let operationID = fixtureUUID(51)
    let generation0 = credentialGeneration(id: 52, ordinal: 0, timestamp: timestamp)
    let generation1 = credentialGeneration(id: 53, ordinal: 1, timestamp: timestamp)
    let generation2 = credentialGeneration(id: 54, ordinal: 2, timestamp: timestamp)
    let generation3 = credentialGeneration(id: 55, ordinal: 3, timestamp: timestamp)
    let ready0 = BrokerJournalReadyGeneration(generation: generation0, committedAt: timestamp)
    let ready1 = BrokerJournalReadyGeneration(generation: generation1, committedAt: timestamp)
    let ready2 = BrokerJournalReadyGeneration(generation: generation2, committedAt: timestamp)

    let invalidStagePayloads: [(BrokerJournalPayload, UInt64)] = [
      (
        .storePending(
          BrokerJournalStorePendingPayload(
            attemptID: attemptID,
            operationID: operationID,
            expectedFence: 0,
            candidate: generation0,
            previousReady: nil,
            startedAt: timestamp
          )
        ),
        1
      ),
      (
        .staging(
          BrokerJournalStagingPayload(
            attemptID: attemptID,
            operationID: operationID,
            expectedFence: 1,
            candidate: generation1,
            previousReady: nil,
            startedAt: timestamp
          )
        ),
        2
      ),
      (
        .stageCleanupPending(
          BrokerJournalStageCleanupPendingPayload(
            attemptID: attemptID,
            operationID: operationID,
            expectedFence: 1,
            candidate: generation2,
            restoredReady: ready2,
            error: .cancelled
          )
        ),
        2
      ),
      (
        .abortCleanupPending(
          BrokerJournalAbortCleanupPendingPayload(
            attemptID: attemptID,
            operationID: operationID,
            expectedFence: 2,
            candidate: generation2,
            restoredReady: ready0
          )
        ),
        2
      ),
    ]
    for (payload, fence) in invalidStagePayloads {
      #expect(throws: BrokerJournalError.invalidRecord) {
        _ = try modelRecord(
          fence: fence,
          lastOrdinal: fence,
          payload: payload,
          timestamp: timestamp
        )
      }
    }

    for ready in [ready0, readyGeneration(id: 56, ordinal: 3, timestamp: timestamp)] {
      #expect(throws: BrokerJournalError.invalidRecord) {
        _ = try modelRecord(
          fence: 2,
          lastOrdinal: 2,
          payload: .ready(BrokerJournalReadyPayload(ready: ready)),
          timestamp: timestamp
        )
      }
    }

    let reusedIDCandidate = BrokerJournalCredentialGeneration(
      generationID: generation1.generationID,
      ordinal: 2,
      createdAt: timestamp
    )
    #expect(throws: BrokerJournalError.invalidRecord) {
      _ = try modelRecord(
        fence: 2,
        lastOrdinal: 2,
        payload: .storePending(
          BrokerJournalStorePendingPayload(
            attemptID: attemptID,
            operationID: operationID,
            expectedFence: 1,
            candidate: reusedIDCandidate,
            previousReady: ready1,
            startedAt: timestamp
          )
        ),
        timestamp: timestamp
      )
    }

    let invalidDeletes: [[BrokerJournalCredentialGeneration]] = [
      [generation3, generation2, generation1],
      [generation1, generation2],
      [generation2, generation2],
      [generation0],
      [generation3],
    ]
    for deleteGenerations in invalidDeletes {
      #expect(throws: BrokerJournalError.invalidRecord) {
        _ = try modelRecord(
          fence: 3,
          lastOrdinal: 2,
          payload: .disconnectFenced(
            BrokerJournalDisconnectFencedPayload(
              operationID: operationID,
              expectedFence: 2,
              tombstonedAt: timestamp,
              deleteGenerations: deleteGenerations
            )
          ),
          timestamp: timestamp
        )
      }
    }
  }

  @Test
  func recordRejectsInvalidTerminalFIFOAndResultFingerprints() throws {
    let timestamp = try JournalTimestamp(unixMilliseconds: 8_000)
    let connectionID = fixtureUUID(60)
    let generation1 = readyGeneration(id: 61, ordinal: 1, timestamp: timestamp)
    let generation2 = readyGeneration(id: 62, ordinal: 2, timestamp: timestamp)
    let ready1 = BrokerJournalReadyProjection(
      connectionID: connectionID,
      fence: 1,
      ready: generation1,
      lastGenerationOrdinal: 1
    )
    let ready2 = BrokerJournalReadyProjection(
      connectionID: connectionID,
      fence: 2,
      ready: generation2,
      lastGenerationOrdinal: 2
    )
    let currentPayload = BrokerJournalPayload.ready(BrokerJournalReadyPayload(ready: generation2))

    let tooMany = (0..<65).map { value in
      BrokerJournalTerminalOperation.stageFailure(
        BrokerJournalStageFailureTerminal(
          operationID: fixtureUUID(100 + value),
          expectedFence: 0,
          error: .cancelled
        )
      )
    }
    #expect(throws: BrokerJournalError.invalidRecord) {
      _ = try modelRecord(
        connectionID: connectionID,
        fence: 2,
        lastOrdinal: 2,
        payload: currentPayload,
        timestamp: timestamp,
        terminalOperations: tooMany
      )
    }

    let duplicateOperation = BrokerJournalTerminalOperation.stageFailure(
      BrokerJournalStageFailureTerminal(
        operationID: fixtureUUID(70),
        expectedFence: 0,
        error: .cancelled
      )
    )
    let duplicateAttempts: [BrokerJournalTerminalOperation] = [
      .commit(
        BrokerJournalCommitTerminal(
          operationID: fixtureUUID(71),
          expectedFence: 1,
          attemptID: fixtureUUID(72),
          ready: ready1
        )
      ),
      .abort(
        BrokerJournalAbortTerminal(
          operationID: fixtureUUID(73),
          expectedFence: 2,
          attemptID: fixtureUUID(72),
          restoredReady: ready2
        )
      ),
    ]
    for operations in [[duplicateOperation, duplicateOperation], duplicateAttempts] {
      #expect(throws: BrokerJournalError.invalidRecord) {
        _ = try modelRecord(
          connectionID: connectionID,
          fence: 2,
          lastOrdinal: 2,
          payload: currentPayload,
          timestamp: timestamp,
          terminalOperations: operations
        )
      }
    }

    let wrongConnectionReady = BrokerJournalReadyProjection(
      connectionID: fixtureUUID(74),
      fence: 1,
      ready: generation1,
      lastGenerationOrdinal: 1
    )
    let invalidResults: [BrokerJournalTerminalOperation] = [
      .stageFailure(
        BrokerJournalStageFailureTerminal(
          operationID: fixtureUUID(75),
          expectedFence: .max,
          error: .attemptNotCurrent
        )
      ),
      .stageFailure(
        BrokerJournalStageFailureTerminal(
          operationID: fixtureUUID(76),
          expectedFence: 2,
          error: .storeUnavailable
        )
      ),
      .commit(
        BrokerJournalCommitTerminal(
          operationID: fixtureUUID(77),
          expectedFence: 2,
          attemptID: fixtureUUID(78),
          ready: ready1
        )
      ),
      .abort(
        BrokerJournalAbortTerminal(
          operationID: fixtureUUID(79),
          expectedFence: 2,
          attemptID: fixtureUUID(80),
          restoredReady: ready1
        )
      ),
      .commit(
        BrokerJournalCommitTerminal(
          operationID: fixtureUUID(81),
          expectedFence: 1,
          attemptID: fixtureUUID(82),
          ready: wrongConnectionReady
        )
      ),
    ]
    for operation in invalidResults {
      #expect(throws: BrokerJournalError.invalidRecord) {
        _ = try modelRecord(
          connectionID: connectionID,
          fence: 2,
          lastOrdinal: 2,
          payload: currentPayload,
          timestamp: timestamp,
          terminalOperations: [operation]
        )
      }
    }

    let reusedGeneration = BrokerJournalReadyGeneration(
      generation: BrokerJournalCredentialGeneration(
        generationID: generation2.generation.generationID,
        ordinal: 1,
        createdAt: timestamp
      ),
      committedAt: timestamp
    )
    let substitutedProjection = BrokerJournalReadyProjection(
      connectionID: connectionID,
      fence: 1,
      ready: reusedGeneration,
      lastGenerationOrdinal: 1
    )
    #expect(throws: BrokerJournalError.invalidRecord) {
      _ = try modelRecord(
        connectionID: connectionID,
        fence: 2,
        lastOrdinal: 2,
        payload: currentPayload,
        timestamp: timestamp,
        terminalOperations: [
          .commit(
            BrokerJournalCommitTerminal(
              operationID: fixtureUUID(83),
              expectedFence: 1,
              attemptID: fixtureUUID(84),
              ready: substitutedProjection
            )
          )
        ]
      )
    }
  }

  @Test
  func disconnectTerminalMustBeLastAndEqualTheCurrentTombstone() throws {
    let timestamp = try JournalTimestamp(unixMilliseconds: 9_000)
    let connectionID = fixtureUUID(90)
    let current = BrokerJournalTombstoneProjection(
      connectionID: connectionID,
      fence: 3,
      lastGenerationOrdinal: 2,
      tombstonedAt: timestamp
    )
    let wrong = BrokerJournalTombstoneProjection(
      connectionID: connectionID,
      fence: 2,
      lastGenerationOrdinal: 1,
      tombstonedAt: timestamp
    )
    let validDisconnect = BrokerJournalTerminalOperation.disconnect(
      BrokerJournalDisconnectTerminal(
        operationID: fixtureUUID(91),
        expectedFence: 2,
        tombstone: current
      )
    )
    let stageFailure = BrokerJournalTerminalOperation.stageFailure(
      BrokerJournalStageFailureTerminal(
        operationID: fixtureUUID(92),
        expectedFence: 0,
        error: .cancelled
      )
    )

    for operations in [
      [
        .disconnect(
          BrokerJournalDisconnectTerminal(
            operationID: fixtureUUID(93),
            expectedFence: 1,
            tombstone: wrong
          )
        )
      ],
      [validDisconnect, stageFailure],
    ] {
      #expect(throws: BrokerJournalError.invalidRecord) {
        _ = try modelRecord(
          connectionID: connectionID,
          fence: 3,
          lastOrdinal: 2,
          payload: .tombstoned(BrokerJournalTombstonedPayload(tombstonedAt: timestamp)),
          timestamp: timestamp,
          terminalOperations: operations
        )
      }
    }

    let record = try modelRecord(
      connectionID: connectionID,
      fence: 3,
      lastOrdinal: 2,
      payload: .tombstoned(BrokerJournalTombstonedPayload(tombstonedAt: timestamp)),
      timestamp: timestamp,
      terminalOperations: [stageFailure, validDisconnect]
    )
    #expect(record.terminalOperations.last == validDisconnect)
  }

  @Test
  func transitionValidatorAllowsOnlyExactFirstStorePendingCreation() throws {
    let timestamp = try JournalTimestamp(unixMilliseconds: 10_000)
    let first = try modelRecord(
      fence: 1,
      lastOrdinal: 1,
      payload: .storePending(
        BrokerJournalStorePendingPayload(
          attemptID: fixtureUUID(300),
          operationID: fixtureUUID(301),
          expectedFence: 0,
          candidate: credentialGeneration(id: 302, ordinal: 1, timestamp: timestamp),
          previousReady: nil,
          startedAt: timestamp
        )
      ),
      timestamp: timestamp
    )
    try BrokerJournalTransitionValidator.validate(predecessor: nil, successor: first)

    let wrongCounters = try modelRecord(
      fence: 2,
      lastOrdinal: 2,
      payload: .storePending(
        BrokerJournalStorePendingPayload(
          attemptID: fixtureUUID(300),
          operationID: fixtureUUID(301),
          expectedFence: 1,
          candidate: credentialGeneration(id: 302, ordinal: 2, timestamp: timestamp),
          previousReady: nil,
          startedAt: timestamp
        )
      ),
      timestamp: timestamp
    )
    #expect(throws: BrokerJournalError.casConflict) {
      try BrokerJournalTransitionValidator.validate(predecessor: nil, successor: wrongCounters)
    }
    let vacant = try modelRecord(
      fence: 0,
      lastOrdinal: 0,
      payload: .vacant(BrokerJournalVacantPayload()),
      timestamp: timestamp
    )
    #expect(throws: BrokerJournalError.casConflict) {
      try BrokerJournalTransitionValidator.validate(predecessor: nil, successor: vacant)
    }
  }

  @Test
  func transitionValidatorAcceptsEveryStageAndStoreResolutionRow() throws {
    let timestamp = try JournalTimestamp(unixMilliseconds: 11_000)
    let connectionID = fixtureUUID(400)
    let previous = readyGeneration(id: 401, ordinal: 1, timestamp: timestamp)
    let candidate = credentialGeneration(id: 402, ordinal: 2, timestamp: timestamp)
    let attemptID = fixtureUUID(403)
    let operationID = fixtureUUID(404)
    let history = BrokerJournalTerminalOperation.stageFailure(
      BrokerJournalStageFailureTerminal(
        operationID: fixtureUUID(405),
        expectedFence: 0,
        error: .cancelled
      )
    )

    let vacant = try modelRecord(
      revision: 5,
      connectionID: connectionID,
      fence: 1,
      lastOrdinal: 1,
      payload: .vacant(BrokerJournalVacantPayload()),
      timestamp: timestamp,
      terminalOperations: [history]
    )
    let ready = try modelRecord(
      revision: 5,
      connectionID: connectionID,
      fence: 1,
      lastOrdinal: 1,
      payload: .ready(BrokerJournalReadyPayload(ready: previous)),
      timestamp: timestamp,
      terminalOperations: [history]
    )
    let storeWithoutPrevious = try modelRecord(
      revision: 6,
      connectionID: connectionID,
      fence: 2,
      lastOrdinal: 2,
      payload: .storePending(
        BrokerJournalStorePendingPayload(
          attemptID: attemptID,
          operationID: operationID,
          expectedFence: 1,
          candidate: candidate,
          previousReady: nil,
          startedAt: timestamp
        )
      ),
      timestamp: timestamp,
      terminalOperations: [history]
    )
    let storeWithPrevious = try modelRecord(
      revision: 6,
      connectionID: connectionID,
      fence: 2,
      lastOrdinal: 2,
      payload: .storePending(
        BrokerJournalStorePendingPayload(
          attemptID: attemptID,
          operationID: operationID,
          expectedFence: 1,
          candidate: candidate,
          previousReady: previous,
          startedAt: timestamp
        )
      ),
      timestamp: timestamp,
      terminalOperations: [history]
    )

    try BrokerJournalTransitionValidator.validate(
      predecessor: vacant,
      successor: storeWithoutPrevious
    )
    try BrokerJournalTransitionValidator.validate(
      predecessor: ready,
      successor: storeWithPrevious
    )

    let staging = try modelRecord(
      revision: 7,
      connectionID: connectionID,
      fence: 2,
      lastOrdinal: 2,
      payload: .staging(
        BrokerJournalStagingPayload(
          attemptID: attemptID,
          operationID: operationID,
          expectedFence: 1,
          candidate: candidate,
          previousReady: previous,
          startedAt: timestamp
        )
      ),
      timestamp: timestamp,
      terminalOperations: [history]
    )
    try BrokerJournalTransitionValidator.validate(
      predecessor: storeWithPrevious,
      successor: staging
    )

    let storeFailure = BrokerJournalTerminalOperation.stageFailure(
      BrokerJournalStageFailureTerminal(
        operationID: operationID,
        expectedFence: 1,
        error: .storeUnavailable
      )
    )
    let restoredVacant = try modelRecord(
      revision: 7,
      connectionID: connectionID,
      fence: 2,
      lastOrdinal: 2,
      payload: .vacant(BrokerJournalVacantPayload()),
      timestamp: timestamp,
      terminalOperations: [history, storeFailure]
    )
    let restoredReady = try modelRecord(
      revision: 7,
      connectionID: connectionID,
      fence: 2,
      lastOrdinal: 2,
      payload: .ready(BrokerJournalReadyPayload(ready: previous)),
      timestamp: timestamp,
      terminalOperations: [history, storeFailure]
    )
    try BrokerJournalTransitionValidator.validate(
      predecessor: storeWithoutPrevious,
      successor: restoredVacant
    )
    try BrokerJournalTransitionValidator.validate(
      predecessor: storeWithPrevious,
      successor: restoredReady
    )

    for predecessor in [storeWithPrevious, staging] {
      let cleanup = try modelRecord(
        revision: predecessor.revision + 1,
        connectionID: connectionID,
        fence: 2,
        lastOrdinal: 2,
        payload: .stageCleanupPending(
          BrokerJournalStageCleanupPendingPayload(
            attemptID: attemptID,
            operationID: operationID,
            expectedFence: 1,
            candidate: candidate,
            restoredReady: previous,
            error: .attemptNotCurrent
          )
        ),
        timestamp: timestamp,
        terminalOperations: [history]
      )
      try BrokerJournalTransitionValidator.validate(
        predecessor: predecessor,
        successor: cleanup
      )
    }
  }

  @Test
  func transitionValidatorAcceptsCleanupCommitAbortAndDisconnectRows() throws {
    let timestamp = try JournalTimestamp(unixMilliseconds: 12_000)
    let connectionID = fixtureUUID(500)
    let previous = readyGeneration(id: 501, ordinal: 1, timestamp: timestamp)
    let candidate = credentialGeneration(id: 502, ordinal: 2, timestamp: timestamp)
    let committed = BrokerJournalReadyGeneration(generation: candidate, committedAt: timestamp)
    let attemptID = fixtureUUID(503)
    let stageOperationID = fixtureUUID(504)
    let commitOperationID = fixtureUUID(505)
    let abortOperationID = fixtureUUID(506)

    func staging(previousReady: BrokerJournalReadyGeneration?) throws -> BrokerJournalRecord {
      try modelRecord(
        revision: 10,
        connectionID: connectionID,
        fence: 2,
        lastOrdinal: 2,
        payload: .staging(
          BrokerJournalStagingPayload(
            attemptID: attemptID,
            operationID: stageOperationID,
            expectedFence: 1,
            candidate: candidate,
            previousReady: previousReady,
            startedAt: timestamp
          )
        ),
        timestamp: timestamp
      )
    }

    for restoredReady in [nil, previous] {
      let cleanup = try modelRecord(
        revision: 10,
        connectionID: connectionID,
        fence: 2,
        lastOrdinal: 2,
        payload: .stageCleanupPending(
          BrokerJournalStageCleanupPendingPayload(
            attemptID: attemptID,
            operationID: stageOperationID,
            expectedFence: 1,
            candidate: candidate,
            restoredReady: restoredReady,
            error: .cancelled
          )
        ),
        timestamp: timestamp
      )
      let terminal = BrokerJournalTerminalOperation.stageFailure(
        BrokerJournalStageFailureTerminal(
          operationID: stageOperationID,
          expectedFence: 1,
          error: .cancelled
        )
      )
      let stablePayload: BrokerJournalPayload =
        restoredReady.map {
          .ready(BrokerJournalReadyPayload(ready: $0))
        } ?? .vacant(BrokerJournalVacantPayload())
      let stable = try modelRecord(
        revision: 11,
        connectionID: connectionID,
        fence: 2,
        lastOrdinal: 2,
        payload: stablePayload,
        timestamp: timestamp,
        terminalOperations: [terminal]
      )
      try BrokerJournalTransitionValidator.validate(predecessor: cleanup, successor: stable)
    }

    let stagingWithPrevious = try staging(previousReady: previous)
    let stagingWithoutPrevious = try staging(previousReady: nil)
    let readyCleanup = try modelRecord(
      revision: 11,
      connectionID: connectionID,
      fence: 2,
      lastOrdinal: 2,
      payload: .readyCleanupPending(
        BrokerJournalReadyCleanupPendingPayload(
          attemptID: attemptID,
          operationID: commitOperationID,
          expectedFence: 2,
          ready: committed,
          previousReady: previous
        )
      ),
      timestamp: timestamp
    )
    try BrokerJournalTransitionValidator.validate(
      predecessor: stagingWithPrevious,
      successor: readyCleanup
    )

    let readyProjection = BrokerJournalReadyProjection(
      connectionID: connectionID,
      fence: 2,
      ready: committed,
      lastGenerationOrdinal: 2
    )
    let commitTerminal = BrokerJournalTerminalOperation.commit(
      BrokerJournalCommitTerminal(
        operationID: commitOperationID,
        expectedFence: 2,
        attemptID: attemptID,
        ready: readyProjection
      )
    )
    let directReady = try modelRecord(
      revision: 11,
      connectionID: connectionID,
      fence: 2,
      lastOrdinal: 2,
      payload: .ready(BrokerJournalReadyPayload(ready: committed)),
      timestamp: timestamp,
      terminalOperations: [commitTerminal]
    )
    try BrokerJournalTransitionValidator.validate(
      predecessor: stagingWithoutPrevious,
      successor: directReady
    )
    let cleanupReady = try modelRecord(
      revision: 12,
      connectionID: connectionID,
      fence: 2,
      lastOrdinal: 2,
      payload: .ready(BrokerJournalReadyPayload(ready: committed)),
      timestamp: timestamp,
      terminalOperations: [commitTerminal]
    )
    try BrokerJournalTransitionValidator.validate(
      predecessor: readyCleanup,
      successor: cleanupReady
    )

    for restoredReady in [nil, previous] {
      let source = try staging(previousReady: restoredReady)
      let abortCleanup = try modelRecord(
        revision: 11,
        connectionID: connectionID,
        fence: 2,
        lastOrdinal: 2,
        payload: .abortCleanupPending(
          BrokerJournalAbortCleanupPendingPayload(
            attemptID: attemptID,
            operationID: abortOperationID,
            expectedFence: 2,
            candidate: candidate,
            restoredReady: restoredReady
          )
        ),
        timestamp: timestamp
      )
      try BrokerJournalTransitionValidator.validate(
        predecessor: source,
        successor: abortCleanup
      )

      let restoredProjection = restoredReady.map {
        BrokerJournalReadyProjection(
          connectionID: connectionID,
          fence: 2,
          ready: $0,
          lastGenerationOrdinal: 2
        )
      }
      let abortTerminal = BrokerJournalTerminalOperation.abort(
        BrokerJournalAbortTerminal(
          operationID: abortOperationID,
          expectedFence: 2,
          attemptID: attemptID,
          restoredReady: restoredProjection
        )
      )
      let stablePayload: BrokerJournalPayload =
        restoredReady.map {
          .ready(BrokerJournalReadyPayload(ready: $0))
        } ?? .vacant(BrokerJournalVacantPayload())
      let stable = try modelRecord(
        revision: 12,
        connectionID: connectionID,
        fence: 2,
        lastOrdinal: 2,
        payload: stablePayload,
        timestamp: timestamp,
        terminalOperations: [abortTerminal]
      )
      try BrokerJournalTransitionValidator.validate(
        predecessor: abortCleanup,
        successor: stable
      )
    }

    let vacant = try modelRecord(
      revision: 10,
      connectionID: connectionID,
      fence: 1,
      lastOrdinal: 1,
      payload: .vacant(BrokerJournalVacantPayload()),
      timestamp: timestamp
    )
    let ready = try modelRecord(
      revision: 10,
      connectionID: connectionID,
      fence: 1,
      lastOrdinal: 1,
      payload: .ready(BrokerJournalReadyPayload(ready: previous)),
      timestamp: timestamp
    )
    let disconnectSources: [(BrokerJournalRecord, [BrokerJournalCredentialGeneration])] = [
      (vacant, []),
      (ready, [previous.generation]),
      (stagingWithPrevious, [candidate, previous.generation]),
    ]
    for (source, deleteGenerations) in disconnectSources {
      let disconnect = try modelRecord(
        revision: source.revision + 1,
        connectionID: connectionID,
        fence: source.fence + 1,
        lastOrdinal: source.lastGenerationOrdinal,
        payload: .disconnectFenced(
          BrokerJournalDisconnectFencedPayload(
            operationID: fixtureUUID(507),
            expectedFence: source.fence,
            tombstonedAt: timestamp,
            deleteGenerations: deleteGenerations
          )
        ),
        timestamp: timestamp
      )
      try BrokerJournalTransitionValidator.validate(predecessor: source, successor: disconnect)

      if source.phase == .staging {
        let tombstone = BrokerJournalTombstoneProjection(
          connectionID: connectionID,
          fence: disconnect.fence,
          lastGenerationOrdinal: disconnect.lastGenerationOrdinal,
          tombstonedAt: timestamp
        )
        let terminal = BrokerJournalTerminalOperation.disconnect(
          BrokerJournalDisconnectTerminal(
            operationID: fixtureUUID(507),
            expectedFence: source.fence,
            tombstone: tombstone
          )
        )
        let stable = try modelRecord(
          revision: disconnect.revision + 1,
          connectionID: connectionID,
          fence: disconnect.fence,
          lastOrdinal: disconnect.lastGenerationOrdinal,
          payload: .tombstoned(BrokerJournalTombstonedPayload(tombstonedAt: timestamp)),
          timestamp: timestamp,
          terminalOperations: [terminal]
        )
        try BrokerJournalTransitionValidator.validate(
          predecessor: disconnect,
          successor: stable
        )
      }
    }
  }

  @Test
  func transitionValidatorRejectsEveryPhasePairOutsideTheClosedMatrix() throws {
    let timestamp = try JournalTimestamp(unixMilliseconds: 13_000)
    let connectionID = fixtureUUID(700)
    let phases: [BrokerJournalPhase] = [
      .vacant, .storePending, .staging, .readyCleanupPending, .ready,
      .stageCleanupPending, .abortCleanupPending, .disconnectFenced, .tombstoned,
    ]
    let predecessors: [BrokerJournalPhase?] = [nil] + phases.map(Optional.some)

    for predecessorPhase in predecessors {
      for successorPhase in phases where !isAllowedPhasePair(predecessorPhase, successorPhase) {
        let predecessor = try predecessorPhase.map {
          try genericRecord(
            phase: $0,
            revision: 1,
            connectionID: connectionID,
            timestamp: timestamp
          )
        }
        let successor = try genericRecord(
          phase: successorPhase,
          revision: predecessor == nil ? 1 : 2,
          connectionID: connectionID,
          timestamp: timestamp
        )
        #expect(throws: BrokerJournalError.casConflict) {
          try BrokerJournalTransitionValidator.validate(
            predecessor: predecessor,
            successor: successor
          )
        }
      }
    }
  }

  @Test
  func transitionValidatorRejectsSubstitutionAndEnforcesRevisionAndFIFOBoundaries() throws {
    let timestamp = try JournalTimestamp(unixMilliseconds: 14_000)
    let connectionID = fixtureUUID(800)
    let candidate = credentialGeneration(id: 801, ordinal: 2, timestamp: timestamp)
    let previous = readyGeneration(id: 802, ordinal: 1, timestamp: timestamp)
    let store = try modelRecord(
      revision: 10,
      connectionID: connectionID,
      fence: 2,
      lastOrdinal: 2,
      payload: .storePending(
        BrokerJournalStorePendingPayload(
          attemptID: fixtureUUID(803),
          operationID: fixtureUUID(804),
          expectedFence: 1,
          candidate: candidate,
          previousReady: previous,
          startedAt: timestamp
        )
      ),
      timestamp: timestamp
    )

    let substitutedStaging = try modelRecord(
      revision: 11,
      connectionID: connectionID,
      fence: 2,
      lastOrdinal: 2,
      payload: .staging(
        BrokerJournalStagingPayload(
          attemptID: fixtureUUID(805),
          operationID: fixtureUUID(804),
          expectedFence: 1,
          candidate: candidate,
          previousReady: previous,
          startedAt: timestamp
        )
      ),
      timestamp: timestamp
    )
    #expect(throws: BrokerJournalError.casConflict) {
      try BrokerJournalTransitionValidator.validate(
        predecessor: store,
        successor: substitutedStaging
      )
    }

    let wrongConnection = try modelRecord(
      revision: 11,
      connectionID: fixtureUUID(806),
      fence: 2,
      lastOrdinal: 2,
      payload: .staging(
        BrokerJournalStagingPayload(
          attemptID: fixtureUUID(803),
          operationID: fixtureUUID(804),
          expectedFence: 1,
          candidate: candidate,
          previousReady: previous,
          startedAt: timestamp
        )
      ),
      timestamp: timestamp
    )
    #expect(throws: BrokerJournalError.casConflict) {
      try BrokerJournalTransitionValidator.validate(predecessor: store, successor: wrongConnection)
    }

    let revisionOverflow = try modelRecord(
      revision: .max,
      connectionID: connectionID,
      fence: 0,
      lastOrdinal: 0,
      payload: .vacant(BrokerJournalVacantPayload()),
      timestamp: timestamp
    )
    let impossibleSuccessor = try modelRecord(
      revision: 1,
      connectionID: connectionID,
      fence: 1,
      lastOrdinal: 1,
      payload: .storePending(
        BrokerJournalStorePendingPayload(
          attemptID: fixtureUUID(807),
          operationID: fixtureUUID(808),
          expectedFence: 0,
          candidate: credentialGeneration(id: 809, ordinal: 1, timestamp: timestamp),
          previousReady: nil,
          startedAt: timestamp
        )
      ),
      timestamp: timestamp
    )
    #expect(throws: BrokerJournalError.revisionOverflow) {
      try BrokerJournalTransitionValidator.validate(
        predecessor: revisionOverflow,
        successor: impossibleSuccessor
      )
    }

    let history = (0..<64).map { value in
      BrokerJournalTerminalOperation.stageFailure(
        BrokerJournalStageFailureTerminal(
          operationID: fixtureUUID(900 + value),
          expectedFence: 0,
          error: .cancelled
        )
      )
    }
    let cleanupOperationID = fixtureUUID(970)
    let cleanup = try modelRecord(
      revision: 20,
      connectionID: connectionID,
      fence: 65,
      lastOrdinal: 65,
      payload: .stageCleanupPending(
        BrokerJournalStageCleanupPendingPayload(
          attemptID: fixtureUUID(971),
          operationID: cleanupOperationID,
          expectedFence: 64,
          candidate: credentialGeneration(id: 972, ordinal: 65, timestamp: timestamp),
          restoredReady: nil,
          error: .storeUnavailable
        )
      ),
      timestamp: timestamp,
      terminalOperations: history
    )
    let appended = BrokerJournalTerminalOperation.stageFailure(
      BrokerJournalStageFailureTerminal(
        operationID: cleanupOperationID,
        expectedFence: 64,
        error: .storeUnavailable
      )
    )
    let correctFIFO = Array(history.dropFirst()) + [appended]
    let stable = try modelRecord(
      revision: 21,
      connectionID: connectionID,
      fence: 65,
      lastOrdinal: 65,
      payload: .vacant(BrokerJournalVacantPayload()),
      timestamp: timestamp,
      terminalOperations: correctFIFO
    )
    try BrokerJournalTransitionValidator.validate(predecessor: cleanup, successor: stable)

    let wrongFIFO = Array(history.dropLast()) + [appended]
    let wrongStable = try modelRecord(
      revision: 21,
      connectionID: connectionID,
      fence: 65,
      lastOrdinal: 65,
      payload: .vacant(BrokerJournalVacantPayload()),
      timestamp: timestamp,
      terminalOperations: wrongFIFO
    )
    #expect(throws: BrokerJournalError.casConflict) {
      try BrokerJournalTransitionValidator.validate(
        predecessor: cleanup,
        successor: wrongStable
      )
    }
  }
}

private func fixtureUUID(_ value: Int) -> UUID {
  UUID(uuidString: String(format: "00000000-0000-4000-8000-%012d", value))!
}

private func credentialGeneration(
  id: Int,
  ordinal: UInt64,
  timestamp: JournalTimestamp
) -> BrokerJournalCredentialGeneration {
  BrokerJournalCredentialGeneration(
    generationID: fixtureUUID(id),
    ordinal: ordinal,
    createdAt: timestamp
  )
}

private func readyGeneration(
  id: Int,
  ordinal: UInt64,
  timestamp: JournalTimestamp
) -> BrokerJournalReadyGeneration {
  BrokerJournalReadyGeneration(
    generation: credentialGeneration(id: id, ordinal: ordinal, timestamp: timestamp),
    committedAt: timestamp
  )
}

private func modelRecord(
  revision: UInt64 = 1,
  connectionID: UUID = fixtureUUID(1),
  fence: UInt64,
  lastOrdinal: UInt64,
  payload: BrokerJournalPayload,
  timestamp: JournalTimestamp,
  terminalOperations: [BrokerJournalTerminalOperation] = []
) throws -> BrokerJournalRecord {
  try BrokerJournalRecord(
    revision: revision,
    connectionID: connectionID,
    providerBinding: .openAI,
    fence: fence,
    lastGenerationOrdinal: lastOrdinal,
    changedAt: timestamp,
    payload: payload,
    terminalOperations: terminalOperations
  )
}

private func genericRecord(
  phase: BrokerJournalPhase,
  revision: UInt64,
  connectionID: UUID,
  timestamp: JournalTimestamp
) throws -> BrokerJournalRecord {
  let previous = readyGeneration(id: 2_001, ordinal: 1, timestamp: timestamp)
  let candidate = credentialGeneration(id: 2_002, ordinal: 2, timestamp: timestamp)
  let ready = BrokerJournalReadyGeneration(generation: candidate, committedAt: timestamp)
  let payload: BrokerJournalPayload
  let fence: UInt64
  let lastOrdinal: UInt64
  switch phase {
  case .vacant:
    payload = .vacant(BrokerJournalVacantPayload())
    fence = 2
    lastOrdinal = 2
  case .storePending:
    payload = .storePending(
      BrokerJournalStorePendingPayload(
        attemptID: fixtureUUID(2_003),
        operationID: fixtureUUID(2_004),
        expectedFence: 1,
        candidate: candidate,
        previousReady: previous,
        startedAt: timestamp
      )
    )
    fence = 2
    lastOrdinal = 2
  case .staging:
    payload = .staging(
      BrokerJournalStagingPayload(
        attemptID: fixtureUUID(2_003),
        operationID: fixtureUUID(2_004),
        expectedFence: 1,
        candidate: candidate,
        previousReady: previous,
        startedAt: timestamp
      )
    )
    fence = 2
    lastOrdinal = 2
  case .readyCleanupPending:
    payload = .readyCleanupPending(
      BrokerJournalReadyCleanupPendingPayload(
        attemptID: fixtureUUID(2_003),
        operationID: fixtureUUID(2_004),
        expectedFence: 2,
        ready: ready,
        previousReady: previous
      )
    )
    fence = 2
    lastOrdinal = 2
  case .ready:
    payload = .ready(BrokerJournalReadyPayload(ready: ready))
    fence = 2
    lastOrdinal = 2
  case .stageCleanupPending:
    payload = .stageCleanupPending(
      BrokerJournalStageCleanupPendingPayload(
        attemptID: fixtureUUID(2_003),
        operationID: fixtureUUID(2_004),
        expectedFence: 1,
        candidate: candidate,
        restoredReady: previous,
        error: .cancelled
      )
    )
    fence = 2
    lastOrdinal = 2
  case .abortCleanupPending:
    payload = .abortCleanupPending(
      BrokerJournalAbortCleanupPendingPayload(
        attemptID: fixtureUUID(2_003),
        operationID: fixtureUUID(2_004),
        expectedFence: 2,
        candidate: candidate,
        restoredReady: previous
      )
    )
    fence = 2
    lastOrdinal = 2
  case .disconnectFenced:
    payload = .disconnectFenced(
      BrokerJournalDisconnectFencedPayload(
        operationID: fixtureUUID(2_004),
        expectedFence: 2,
        tombstonedAt: timestamp,
        deleteGenerations: [candidate, previous.generation]
      )
    )
    fence = 3
    lastOrdinal = 2
  case .tombstoned:
    payload = .tombstoned(BrokerJournalTombstonedPayload(tombstonedAt: timestamp))
    fence = 3
    lastOrdinal = 2
  }
  return try modelRecord(
    revision: revision,
    connectionID: connectionID,
    fence: fence,
    lastOrdinal: lastOrdinal,
    payload: payload,
    timestamp: timestamp
  )
}

private func isAllowedPhasePair(
  _ predecessor: BrokerJournalPhase?,
  _ successor: BrokerJournalPhase
) -> Bool {
  guard let predecessor else {
    return successor == .storePending
  }
  switch (predecessor, successor) {
  case (.vacant, .storePending), (.vacant, .disconnectFenced),
    (.ready, .storePending), (.ready, .disconnectFenced),
    (.storePending, .staging), (.storePending, .vacant),
    (.storePending, .ready), (.storePending, .stageCleanupPending),
    (.staging, .stageCleanupPending), (.staging, .readyCleanupPending),
    (.staging, .ready), (.staging, .abortCleanupPending),
    (.staging, .disconnectFenced), (.readyCleanupPending, .ready),
    (.stageCleanupPending, .vacant), (.stageCleanupPending, .ready),
    (.abortCleanupPending, .vacant), (.abortCleanupPending, .ready),
    (.disconnectFenced, .tombstoned):
    return true
  default:
    return false
  }
}
