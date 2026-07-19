import Foundation
import Testing

@testable import RecursBrokerCore

@Suite("Broker credential state")
struct BrokerCredentialStateTests {
  @Test
  func pureStateMachineOwnsBootstrapProjectionWithoutAStore() throws {
    let connectionID = fixtureUUID(0)
    let generation = CredentialGeneration(
      generationID: fixtureUUID(1),
      ordinal: 1,
      createdAt: fixtureDate
    )
    let ready = ReadyProjection(
      connectionID: connectionID,
      fence: 1,
      ready: ReadyGeneration(generation: generation, committedAt: fixtureDate),
      lastGenerationOrdinal: 1
    )

    let machine = try BrokerCredentialStateMachine(bootstrap: [.ready(ready)])

    #expect(machine.projection(for: connectionID) == .ready(ready))
    #expect(machine.projection(for: fixtureUUID(2)) == nil)
  }

  @Test
  func stagePersistsOneHiddenGenerationThenCommitPublishesIt() async throws {
    let store = InMemoryCredentialStore()
    let connectionID = UUID(uuidString: "00000000-0000-0000-0000-000000000001")!
    let generationID = UUID(uuidString: "00000000-0000-0000-0000-000000000002")!
    let attemptID = UUID(uuidString: "00000000-0000-0000-0000-000000000003")!
    let operationID = UUID(uuidString: "00000000-0000-0000-0000-000000000004")!
    let now = Date(timeIntervalSince1970: 1_700_000_000)
    let state = try BrokerCredentialState(
      store: store,
      clock: { now },
      generationIDSource: { generationID },
      attemptIDSource: { attemptID }
    )

    let attempt = try await state.stage(
      connectionID: connectionID,
      operationID: operationID,
      expectedFence: 0,
      secret: SecretBytes(Data("canary-never-project".utf8))
    )

    #expect(attempt.connectionID == connectionID)
    #expect(attempt.attemptID == attemptID)
    #expect(attempt.fence == 1)
    #expect(attempt.candidate.generationID == generationID)
    #expect(attempt.candidate.ordinal == 1)
    #expect(attempt.previousReady == nil)
    #expect(await store.retainedCount() == 1)
    #expect(String(reflecting: attempt).contains("canary-never-project") == false)

    let ready = try await state.commit(
      connectionID: connectionID,
      attemptID: attemptID,
      operationID: UUID(),
      expectedFence: 1
    )
    #expect(ready.ready.generation == attempt.candidate)
    #expect(ready.fence == 1)
    #expect(await store.retainedCount() == 1)
  }

  @Test
  func secretBytesEraseIdempotentlyAndNeverDescribeTheirContents() {
    let canary = "secret-canary-4471"
    let secret = SecretBytes(Data(canary.utf8))
    #expect(String(describing: secret) == "<redacted>")
    #expect(String(reflecting: secret) == "<redacted>")

    secret.erase()
    secret.erase()
    let erased = secret.withUnsafeBytes { $0.isEmpty }
    #expect(erased)

    let probe = BufferDeallocationProbe()
    var deinitializing: SecretBytes? = SecretBytes(probe.makeData(Array(canary.utf8)))
    #expect(deinitializing != nil)
    deinitializing = nil
    #expect(probe.observedZeroization() == true)
  }

  @Test
  func secretReflectionAndRecursiveStoreDumpExposeNoBytesOrLength() async throws {
    let canary = "mirror-canary-593847201"
    let canaryBytes = Array(canary.utf8)
    let secret = SecretBytes(Data(canaryBytes))

    #expect(Array(Mirror(reflecting: secret).children).isEmpty)
    #expect(secret.playgroundDescription as? String == "<redacted>")
    var secretDump = ""
    dump(secret, to: &secretDump)
    expectNoReflectedSecret(secretDump, canary: canary, bytes: canaryBytes)

    let store = InMemoryCredentialStore()
    let key = CredentialStoreKey(
      connectionID: fixtureUUID(15),
      generationID: fixtureUUID(16),
      generationOrdinal: 1
    )
    try await store.store(secret, for: key)
    #expect(Array(Mirror(reflecting: store).children).isEmpty)
    var storeDump = ""
    dump(store, to: &storeDump)
    expectNoReflectedSecret(storeDump, canary: canary, bytes: canaryBytes)

    let inspection = await store.inspection()
    var inspectionDump = ""
    dump(inspection, to: &inspectionDump)
    expectNoReflectedSecret(inspectionDump, canary: canary, bytes: canaryBytes)
    try await store.deleteIfPresent(key)
  }

  @Test
  func projectionsErrorsAndStoreInspectionAreCanaryFree() async throws {
    let canary = "secret-canary-encoded-9912"
    let generation = CredentialGeneration(
      generationID: fixtureUUID(20),
      ordinal: 1,
      createdAt: fixtureDate
    )
    let readyGeneration = ReadyGeneration(generation: generation, committedAt: fixtureDate)
    let projections: [CredentialProjection] = [
      .staging(
        StagingAttempt(
          connectionID: fixtureUUID(21),
          attemptID: fixtureUUID(22),
          fence: 1,
          candidate: generation,
          previousReady: readyGeneration,
          startedAt: fixtureDate
        )
      ),
      .ready(
        ReadyProjection(
          connectionID: fixtureUUID(21),
          fence: 1,
          ready: readyGeneration,
          lastGenerationOrdinal: 1
        )
      ),
      .tombstoned(
        TombstoneProjection(
          connectionID: fixtureUUID(21),
          fence: 2,
          lastGenerationOrdinal: 1,
          tombstonedAt: fixtureDate
        )
      ),
    ]
    for projection in projections {
      let surfaces = [
        String(describing: projection),
        String(reflecting: projection),
        String(decoding: try JSONEncoder().encode(projection), as: UTF8.self),
      ]
      #expect(surfaces.allSatisfy { !$0.contains(canary) })
    }
    #expect(projections[0].usableReady == readyGeneration)
    #expect(projections[1].usableReady == readyGeneration)
    #expect(projections[2].usableReady == nil)

    let errors: [BrokerStateError] = [
      .cancelled, .connectionNotFound, .connectionTombstoned, .staleFence,
      .fenceOverflow, .generationOverflow, .invalidTransition, .attemptNotCurrent,
      .operationIDConflict, .operationInProgress, .storeUnavailable, .cleanupPending,
      .invalidBootstrap,
    ]
    for error in errors {
      let surfaces = [
        String(describing: error),
        String(reflecting: error),
        error.localizedDescription,
      ]
      #expect(surfaces.allSatisfy { !$0.contains(canary) })
      #expect(Set(surfaces).count == 1)
    }

    let inspection = await InMemoryCredentialStore().inspection()
    #expect(!String(describing: inspection).contains(canary))
    #expect(!String(reflecting: inspection).contains(canary))
  }

  @Test
  func allPreStoreValidationExitsEraseTheSuppliedSecret() async throws {
    let store = InMemoryCredentialStore()
    let harness = try makeHarness(store: store)
    let connectionID = fixtureUUID(30)

    let stale = UncheckedSecretAlias(SecretBytes(Data("stale-secret".utf8)))
    await expectBrokerError(.staleFence) {
      try await harness.state.stage(
        connectionID: connectionID,
        operationID: fixtureUUID(31),
        expectedFence: 9,
        secret: stale.value
      )
    }
    #expect(stale.isErased())

    let first = try await harness.state.stage(
      connectionID: connectionID,
      operationID: fixtureUUID(32),
      expectedFence: 0,
      secret: SecretBytes(Data("stored-secret".utf8))
    )
    let invalid = UncheckedSecretAlias(SecretBytes(Data("invalid-secret".utf8)))
    await expectBrokerError(.invalidTransition) {
      try await harness.state.stage(
        connectionID: connectionID,
        operationID: fixtureUUID(33),
        expectedFence: first.fence,
        secret: invalid.value
      )
    }
    #expect(invalid.isErased())

    _ = try await harness.state.disconnect(
      connectionID: connectionID,
      operationID: fixtureUUID(34),
      expectedFence: first.fence
    )
    let tombstoned = UncheckedSecretAlias(SecretBytes(Data("tombstone-secret".utf8)))
    await expectBrokerError(.connectionTombstoned) {
      try await harness.state.stage(
        connectionID: connectionID,
        operationID: fixtureUUID(35),
        expectedFence: 99,
        secret: tombstoned.value
      )
    }
    #expect(tombstoned.isErased())

    let overflowState = try BrokerCredentialState(
      store: store,
      bootstrap: [
        .vacant(
          connectionID: fixtureUUID(36),
          fence: UInt64.max - 1,
          lastGenerationOrdinal: UInt64.max - 1
        )
      ],
      clock: { fixtureDate },
      generationIDSource: { fixtureUUID(37) },
      attemptIDSource: { fixtureUUID(38) }
    )
    let overflow = UncheckedSecretAlias(SecretBytes(Data("overflow-secret".utf8)))
    await expectBrokerError(.fenceOverflow) {
      try await overflowState.stage(
        connectionID: fixtureUUID(36),
        operationID: fixtureUUID(39),
        expectedFence: UInt64.max - 1,
        secret: overflow.value
      )
    }
    #expect(overflow.isErased())
  }

  @Test
  func cancellationBeforeReservationErasesWithoutConsumingCounters() async throws {
    let harness = try makeHarness(store: InMemoryCredentialStore())
    let gate = AsyncGate()
    let alias = UncheckedSecretAlias(SecretBytes(Data("cancelled-secret".utf8)))
    let task = Task {
      await gate.wait()
      return try await harness.state.stage(
        connectionID: fixtureUUID(40),
        operationID: fixtureUUID(41),
        expectedFence: 0,
        secret: alias.value
      )
    }
    task.cancel()
    await gate.release()
    await expectTaskError(.cancelled, task)
    #expect(alias.isErased())
    #expect(await harness.state.projection(for: fixtureUUID(40)) == nil)
    #expect(harness.generationIDs.count() == 0)
    #expect(harness.attemptIDs.count() == 0)
    #expect(harness.clock.count() == 0)
  }

  @Test
  func activeStoreHidesCandidateAndRejectsEveryConcurrentMutation() async throws {
    let store = InMemoryCredentialStore()
    await store.pauseNext(at: .storeBeforeSideEffect)
    let harness = try makeHarness(store: store)
    let connectionID = fixtureUUID(50)
    let first = Task {
      try await harness.state.stage(
        connectionID: connectionID,
        operationID: fixtureUUID(51),
        expectedFence: 0,
        secret: SecretBytes(Data("first-pending".utf8))
      )
    }
    await store.waitUntilPaused(at: .storeBeforeSideEffect)
    #expect(await harness.state.projection(for: connectionID) == nil)

    let rejected = UncheckedSecretAlias(SecretBytes(Data("rejected-pending".utf8)))
    await expectBrokerError(.operationInProgress) {
      try await harness.state.stage(
        connectionID: connectionID,
        operationID: fixtureUUID(52),
        expectedFence: 1,
        secret: rejected.value
      )
    }
    #expect(rejected.isErased())
    await expectBrokerError(.operationInProgress) {
      try await harness.state.disconnect(
        connectionID: connectionID,
        operationID: fixtureUUID(53),
        expectedFence: 1
      )
    }
    await expectBrokerError(.operationInProgress) {
      try await harness.state.resumeStage(
        connectionID: connectionID,
        operationID: fixtureUUID(51),
        expectedFence: 99
      )
    }

    await store.releaseOne(at: .storeBeforeSideEffect)
    let attempt = try await first.value
    #expect(attempt.fence == 1)
    #expect(await harness.state.projection(for: connectionID) == .staging(attempt))
  }

  @Test
  func aBlockedStoreDoesNotBlockAnotherConnection() async throws {
    let store = InMemoryCredentialStore()
    await store.pauseNext(at: .storeBeforeSideEffect)
    let harness = try makeHarness(store: store)
    let blocked = Task {
      try await harness.state.stage(
        connectionID: fixtureUUID(60),
        operationID: fixtureUUID(61),
        expectedFence: 0,
        secret: SecretBytes(Data("blocked".utf8))
      )
    }
    await store.waitUntilPaused(at: .storeBeforeSideEffect)
    let independent = try await harness.state.stage(
      connectionID: fixtureUUID(62),
      operationID: fixtureUUID(63),
      expectedFence: 0,
      secret: SecretBytes(Data("independent".utf8))
    )
    #expect(independent.fence == 1)
    await store.releaseOne(at: .storeBeforeSideEffect)
    _ = try await blocked.value
  }

  @Test
  func knownStoreFailureErasesAndMemoizesWithoutDeleting() async throws {
    let store = InMemoryCredentialStore()
    await store.failNext(at: .storeBeforeSideEffect)
    let harness = try makeHarness(store: store)
    let connectionID = fixtureUUID(70)
    let operationID = fixtureUUID(71)
    let alias = UncheckedSecretAlias(SecretBytes(Data("known-failure".utf8)))

    await expectBrokerError(.storeUnavailable) {
      try await harness.state.stage(
        connectionID: connectionID,
        operationID: operationID,
        expectedFence: 0,
        secret: alias.value
      )
    }
    #expect(alias.isErased())
    #expect(await store.retainedCount() == 0)
    let inspection = await store.inspection()
    #expect(inspection.storeCallCounts.values.reduce(0, +) == 1)
    #expect(inspection.deleteCallCounts.isEmpty)

    await expectBrokerError(.storeUnavailable) {
      try await harness.state.resumeStage(
        connectionID: connectionID,
        operationID: operationID,
        expectedFence: 0
      )
    }
    #expect((await store.inspection()).storeCallCounts.values.reduce(0, +) == 1)
  }

  @Test
  func unknownStoreOutcomeCleansTheCandidateBeforeReturning() async throws {
    let store = InMemoryCredentialStore()
    await store.failNext(at: .storeAfterSideEffect)
    let harness = try makeHarness(store: store)
    let alias = UncheckedSecretAlias(SecretBytes(Data("unknown-failure".utf8)))
    await expectBrokerError(.storeUnavailable) {
      try await harness.state.stage(
        connectionID: fixtureUUID(80),
        operationID: fixtureUUID(81),
        expectedFence: 0,
        secret: alias.value
      )
    }
    #expect(alias.isErased())
    #expect(await store.retainedCount() == 0)
    let inspection = await store.inspection()
    #expect(inspection.storeCallCounts.values.reduce(0, +) == 1)
    #expect(inspection.deleteCallCounts.values.reduce(0, +) == 1)
  }

  @Test
  func cancellationAfterStoreSideEffectCleansThenMemoizesCancellation() async throws {
    let store = InMemoryCredentialStore()
    await store.pauseNext(at: .storeAfterSideEffect)
    let harness = try makeHarness(store: store)
    let connectionID = fixtureUUID(90)
    let operationID = fixtureUUID(91)
    let alias = UncheckedSecretAlias(SecretBytes(Data("cancel-after-store".utf8)))
    let task = Task {
      try await harness.state.stage(
        connectionID: connectionID,
        operationID: operationID,
        expectedFence: 0,
        secret: alias.value
      )
    }
    await store.waitUntilPaused(at: .storeAfterSideEffect)
    task.cancel()
    await store.releaseOne(at: .storeAfterSideEffect)
    await expectTaskError(.cancelled, task)
    #expect(alias.isErased())
    #expect(await store.retainedCount() == 0)
    #expect(await harness.state.projection(for: connectionID) == nil)
    await expectBrokerError(.cancelled) {
      try await harness.state.resumeStage(
        connectionID: connectionID,
        operationID: operationID,
        expectedFence: 0
      )
    }
  }

  @Test
  func pausedStageCleanupRequiresExactResumeAndNeverAcceptsReplacementBytes() async throws {
    let store = InMemoryCredentialStore()
    await store.failNext(at: .storeAfterSideEffect)
    await store.failNext(at: .deleteBeforeSideEffect)
    let harness = try makeHarness(store: store)
    let connectionID = fixtureUUID(100)
    let operationID = fixtureUUID(101)
    await expectBrokerError(.cleanupPending) {
      try await harness.state.stage(
        connectionID: connectionID,
        operationID: operationID,
        expectedFence: 0,
        secret: SecretBytes(Data("possibly-stored".utf8))
      )
    }
    #expect(await store.retainedCount() == 1)
    #expect(await harness.state.projection(for: connectionID) == nil)

    await expectBrokerError(.cleanupPending) {
      try await harness.state.resumeStage(
        connectionID: connectionID,
        operationID: fixtureUUID(102),
        expectedFence: 1
      )
    }
    await expectBrokerError(.cleanupPending) {
      try await harness.state.resumeStage(
        connectionID: connectionID,
        operationID: operationID,
        expectedFence: 1
      )
    }

    let replacement = UncheckedSecretAlias(SecretBytes(Data("must-not-substitute".utf8)))
    await expectBrokerError(.storeUnavailable) {
      try await harness.state.stage(
        connectionID: connectionID,
        operationID: operationID,
        expectedFence: 0,
        secret: replacement.value
      )
    }
    #expect(replacement.isErased())
    #expect(await store.retainedCount() == 0)
    let inspection = await store.inspection()
    #expect(inspection.storeCallCounts.values.reduce(0, +) == 1)
    #expect(inspection.deleteCallCounts.values.reduce(0, +) == 2)
  }

  @Test
  func reconnectKeepsTheOldReadyGenerationUsableUntilCommit() async throws {
    let store = InMemoryCredentialStore()
    let harness = try makeHarness(store: store)
    let connectionID = fixtureUUID(110)
    let first = try await harness.state.stage(
      connectionID: connectionID,
      operationID: fixtureUUID(111),
      expectedFence: 0,
      secret: SecretBytes(Data("old-generation".utf8))
    )
    let oldReady = try await harness.state.commit(
      connectionID: connectionID,
      attemptID: first.attemptID,
      operationID: fixtureUUID(112),
      expectedFence: 1
    )

    await store.pauseNext(at: .storeBeforeSideEffect)
    let reconnect = Task {
      try await harness.state.stage(
        connectionID: connectionID,
        operationID: fixtureUUID(113),
        expectedFence: 1,
        secret: SecretBytes(Data("new-generation".utf8))
      )
    }
    await store.waitUntilPaused(at: .storeBeforeSideEffect)
    #expect(
      await harness.state.projection(for: connectionID)
        == .ready(
          ReadyProjection(
            connectionID: connectionID,
            fence: 2,
            ready: oldReady.ready,
            lastGenerationOrdinal: 2
          )
        )
    )

    await store.releaseOne(at: .storeBeforeSideEffect)
    let second = try await reconnect.value
    #expect(second.candidate.ordinal == 2)
    #expect(second.previousReady == oldReady.ready)
    #expect(CredentialProjection.staging(second).usableReady == oldReady.ready)
    let newReady = try await harness.state.commit(
      connectionID: connectionID,
      attemptID: second.attemptID,
      operationID: fixtureUUID(114),
      expectedFence: 2
    )
    #expect(newReady.ready.generation == second.candidate)
    #expect(await store.retainedCount() == 1)
    let oldKey = storeKey(connectionID, first.candidate)
    let newKey = storeKey(connectionID, second.candidate)
    #expect(!(await store.contains(oldKey)))
    #expect(await store.contains(newKey))
  }

  @Test
  func abortRevokesTheCandidateBeforeCleanupAndReplaysWithoutDeletingTwice() async throws {
    let store = InMemoryCredentialStore()
    let harness = try makeHarness(store: store)
    let connectionID = fixtureUUID(120)
    let attempt = try await harness.state.stage(
      connectionID: connectionID,
      operationID: fixtureUUID(121),
      expectedFence: 0,
      secret: SecretBytes(Data("abort-me".utf8))
    )
    let operationID = fixtureUUID(122)
    let result = try await harness.state.abort(
      connectionID: connectionID,
      attemptID: attempt.attemptID,
      operationID: operationID,
      expectedFence: 1
    )
    #expect(result == nil)
    #expect(await harness.state.projection(for: connectionID) == nil)
    #expect(await store.retainedCount() == 0)
    let key = storeKey(connectionID, attempt.candidate)
    #expect(await store.deleteCallCount(for: key) == 1)

    let replay = try await harness.state.abort(
      connectionID: connectionID,
      attemptID: attempt.attemptID,
      operationID: operationID,
      expectedFence: 1
    )
    #expect(replay == nil)
    #expect(await store.deleteCallCount(for: key) == 1)

    let next = try await harness.state.stage(
      connectionID: connectionID,
      operationID: fixtureUUID(123),
      expectedFence: 1,
      secret: SecretBytes(Data("ordinal-not-reused".utf8))
    )
    #expect(next.fence == 2)
    #expect(next.candidate.ordinal == 2)
  }

  @Test
  func commitCleanupFailureNeverRollsBackAndExactRetryIsIdempotent() async throws {
    let store = InMemoryCredentialStore()
    let harness = try makeHarness(store: store)
    let connectionID = fixtureUUID(130)
    let first = try await harness.state.stage(
      connectionID: connectionID,
      operationID: fixtureUUID(131),
      expectedFence: 0,
      secret: SecretBytes(Data("old".utf8))
    )
    _ = try await harness.state.commit(
      connectionID: connectionID,
      attemptID: first.attemptID,
      operationID: fixtureUUID(132),
      expectedFence: 1
    )
    let second = try await harness.state.stage(
      connectionID: connectionID,
      operationID: fixtureUUID(133),
      expectedFence: 1,
      secret: SecretBytes(Data("new".utf8))
    )
    await store.failNext(at: .deleteAfterSideEffect)
    let commitOperation = fixtureUUID(134)
    await expectBrokerError(.cleanupPending) {
      try await harness.state.commit(
        connectionID: connectionID,
        attemptID: second.attemptID,
        operationID: commitOperation,
        expectedFence: 2
      )
    }
    let authoritative = await harness.state.projection(for: connectionID)
    guard case .ready(let authoritativeReady) = authoritative else {
      Issue.record("Commit did not remain authoritative while cleanup was pending.")
      return
    }
    #expect(authoritativeReady.fence == 2)
    #expect(authoritativeReady.lastGenerationOrdinal == 2)
    #expect(authoritativeReady.ready.generation == second.candidate)

    await expectBrokerError(.cleanupPending) {
      try await harness.state.disconnect(
        connectionID: connectionID,
        operationID: fixtureUUID(135),
        expectedFence: 2
      )
    }
    let ready = try await harness.state.commit(
      connectionID: connectionID,
      attemptID: second.attemptID,
      operationID: commitOperation,
      expectedFence: 2
    )
    #expect(ready.ready.generation == second.candidate)
    #expect(await store.retainedCount() == 1)
    #expect(await store.deleteCallCount(for: storeKey(connectionID, first.candidate)) == 2)
    let replay = try await harness.state.commit(
      connectionID: connectionID,
      attemptID: second.attemptID,
      operationID: commitOperation,
      expectedFence: 2
    )
    #expect(replay == ready)
    #expect(await store.deleteCallCount(for: storeKey(connectionID, first.candidate)) == 2)
  }

  @Test
  func abortCleanupFailureKeepsCandidateRevokedUntilExactRetry() async throws {
    let store = InMemoryCredentialStore()
    let harness = try makeHarness(store: store)
    let connectionID = fixtureUUID(136)
    let attempt = try await harness.state.stage(
      connectionID: connectionID,
      operationID: fixtureUUID(137),
      expectedFence: 0,
      secret: SecretBytes(Data("abort-cleanup".utf8))
    )
    await store.failNext(at: .deleteBeforeSideEffect)
    let operationID = fixtureUUID(138)
    await expectBrokerError(.cleanupPending) {
      try await harness.state.abort(
        connectionID: connectionID,
        attemptID: attempt.attemptID,
        operationID: operationID,
        expectedFence: 1
      )
    }
    #expect(await harness.state.projection(for: connectionID) == nil)
    #expect(await store.retainedCount() == 1)
    let rejected = UncheckedSecretAlias(SecretBytes(Data("while-abort-paused".utf8)))
    await expectBrokerError(.cleanupPending) {
      try await harness.state.stage(
        connectionID: connectionID,
        operationID: fixtureUUID(139),
        expectedFence: 1,
        secret: rejected.value
      )
    }
    #expect(rejected.isErased())
    let result = try await harness.state.abort(
      connectionID: connectionID,
      attemptID: attempt.attemptID,
      operationID: operationID,
      expectedFence: 1
    )
    #expect(result == nil)
    #expect(await store.retainedCount() == 0)
  }

  @Test
  func disconnectPublishesItsTombstoneBeforeDeletionAndBlocksLateCommit() async throws {
    let store = InMemoryCredentialStore()
    let harness = try makeHarness(store: store)
    let connectionID = fixtureUUID(140)
    let attempt = try await harness.state.stage(
      connectionID: connectionID,
      operationID: fixtureUUID(141),
      expectedFence: 0,
      secret: SecretBytes(Data("disconnect".utf8))
    )
    await store.pauseNext(at: .deleteBeforeSideEffect)
    let operationID = fixtureUUID(142)
    let disconnect = Task {
      try await harness.state.disconnect(
        connectionID: connectionID,
        operationID: operationID,
        expectedFence: 1
      )
    }
    await store.waitUntilPaused(at: .deleteBeforeSideEffect)
    let projected = await harness.state.projection(for: connectionID)
    #expect(projected?.usableReady == nil)
    guard case .tombstoned(let tombstone) = projected else {
      Issue.record("Disconnect did not publish a tombstone before deletion.")
      await store.releaseOne(at: .deleteBeforeSideEffect)
      _ = try await disconnect.value
      return
    }
    #expect(tombstone.fence == 2)

    await expectBrokerError(.operationInProgress) {
      try await harness.state.commit(
        connectionID: connectionID,
        attemptID: attempt.attemptID,
        operationID: fixtureUUID(143),
        expectedFence: 1
      )
    }
    await store.releaseOne(at: .deleteBeforeSideEffect)
    let completed = try await disconnect.value
    #expect(completed == tombstone)
    #expect(await store.retainedCount() == 0)
    await expectBrokerError(.connectionTombstoned) {
      try await harness.state.commit(
        connectionID: connectionID,
        attemptID: attempt.attemptID,
        operationID: fixtureUUID(144),
        expectedFence: 1
      )
    }
    let replay = try await harness.state.disconnect(
      connectionID: connectionID,
      operationID: operationID,
      expectedFence: 1
    )
    #expect(replay == completed)
  }

  @Test
  func disconnectCleanupFailureKeepsTheTombstoneAndExactRetryFinishes() async throws {
    let store = InMemoryCredentialStore()
    let harness = try makeHarness(store: store)
    let connectionID = fixtureUUID(145)
    let attempt = try await harness.state.stage(
      connectionID: connectionID,
      operationID: fixtureUUID(146),
      expectedFence: 0,
      secret: SecretBytes(Data("disconnect-cleanup".utf8))
    )
    _ = try await harness.state.commit(
      connectionID: connectionID,
      attemptID: attempt.attemptID,
      operationID: fixtureUUID(147),
      expectedFence: 1
    )
    await store.failNext(at: .deleteBeforeSideEffect)
    let operationID = fixtureUUID(148)
    await expectBrokerError(.cleanupPending) {
      try await harness.state.disconnect(
        connectionID: connectionID,
        operationID: operationID,
        expectedFence: 1
      )
    }
    let projection = await harness.state.projection(for: connectionID)
    guard case .tombstoned(let tombstone) = projection else {
      Issue.record("Disconnect cleanup failure rolled back the tombstone.")
      return
    }
    #expect(tombstone.fence == 2)
    #expect(await store.retainedCount() == 1)
    let completed = try await harness.state.disconnect(
      connectionID: connectionID,
      operationID: operationID,
      expectedFence: 1
    )
    #expect(completed == tombstone)
    #expect(await store.retainedCount() == 0)
  }

  @Test
  func cancellationAfterCommitLinearizationIsAdvisory() async throws {
    let store = InMemoryCredentialStore()
    let harness = try makeHarness(store: store)
    let connectionID = fixtureUUID(155)
    let first = try await harness.state.stage(
      connectionID: connectionID,
      operationID: fixtureUUID(156),
      expectedFence: 0,
      secret: SecretBytes(Data("old-advisory".utf8))
    )
    _ = try await harness.state.commit(
      connectionID: connectionID,
      attemptID: first.attemptID,
      operationID: fixtureUUID(157),
      expectedFence: 1
    )
    let second = try await harness.state.stage(
      connectionID: connectionID,
      operationID: fixtureUUID(158),
      expectedFence: 1,
      secret: SecretBytes(Data("new-advisory".utf8))
    )
    await store.pauseNext(at: .deleteBeforeSideEffect)
    let commit = Task {
      try await harness.state.commit(
        connectionID: connectionID,
        attemptID: second.attemptID,
        operationID: fixtureUUID(159),
        expectedFence: 2
      )
    }
    await store.waitUntilPaused(at: .deleteBeforeSideEffect)
    commit.cancel()
    await store.releaseOne(at: .deleteBeforeSideEffect)
    let ready = try await commit.value
    #expect(ready.ready.generation == second.candidate)
    #expect(await store.retainedCount() == 1)
  }

  @Test
  func disconnectFromStagingDeletesCandidateThenPreviousReady() async throws {
    let store = InMemoryCredentialStore()
    let harness = try makeHarness(store: store)
    let connectionID = fixtureUUID(150)
    let first = try await harness.state.stage(
      connectionID: connectionID,
      operationID: fixtureUUID(151),
      expectedFence: 0,
      secret: SecretBytes(Data("old".utf8))
    )
    _ = try await harness.state.commit(
      connectionID: connectionID,
      attemptID: first.attemptID,
      operationID: fixtureUUID(152),
      expectedFence: 1
    )
    let second = try await harness.state.stage(
      connectionID: connectionID,
      operationID: fixtureUUID(153),
      expectedFence: 1,
      secret: SecretBytes(Data("candidate".utf8))
    )
    await store.pauseNext(at: .deleteBeforeSideEffect)
    let disconnect = Task {
      try await harness.state.disconnect(
        connectionID: connectionID,
        operationID: fixtureUUID(154),
        expectedFence: 2
      )
    }
    await store.waitUntilPaused(at: .deleteBeforeSideEffect)
    #expect(await store.deleteCallCount(for: storeKey(connectionID, second.candidate)) == 1)
    #expect(await store.deleteCallCount(for: storeKey(connectionID, first.candidate)) == 0)
    await store.releaseOne(at: .deleteBeforeSideEffect)
    _ = try await disconnect.value
    #expect(await store.deleteCallCount(for: storeKey(connectionID, first.candidate)) == 1)
    #expect(await store.retainedCount() == 0)
  }

  @Test
  func concurrentFirstCommitsHaveExactlyOneWinner() async throws {
    let harness = try makeHarness(store: InMemoryCredentialStore())
    let connectionID = fixtureUUID(160)
    let attempt = try await harness.state.stage(
      connectionID: connectionID,
      operationID: fixtureUUID(161),
      expectedFence: 0,
      secret: SecretBytes(Data("race".utf8))
    )
    let first = Task {
      try await harness.state.commit(
        connectionID: connectionID,
        attemptID: attempt.attemptID,
        operationID: fixtureUUID(162),
        expectedFence: 1
      )
    }
    let second = Task {
      try await harness.state.commit(
        connectionID: connectionID,
        attemptID: attempt.attemptID,
        operationID: fixtureUUID(163),
        expectedFence: 1
      )
    }
    let outcomes = await [capture(first), capture(second)]
    #expect(outcomes.filter(\.isSuccess).count == 1)
    #expect(outcomes.compactMap(\.failure) == [.attemptNotCurrent])
  }

  @Test
  func restartBootstrapInvalidatesVolatileAttemptAuthority() async throws {
    let store = InMemoryCredentialStore()
    let original = try makeHarness(store: store)
    let connectionID = fixtureUUID(170)
    let stageOperation = fixtureUUID(171)
    let attempt = try await original.state.stage(
      connectionID: connectionID,
      operationID: stageOperation,
      expectedFence: 0,
      secret: SecretBytes(Data("orphan-after-restart".utf8))
    )
    let restarted = try makeHarness(
      store: store,
      bootstrap: [
        .vacant(connectionID: connectionID, fence: 1, lastGenerationOrdinal: 1)
      ]
    )
    await expectBrokerError(.attemptNotCurrent) {
      try await restarted.state.commit(
        connectionID: connectionID,
        attemptID: attempt.attemptID,
        operationID: fixtureUUID(172),
        expectedFence: 1
      )
    }
    await expectBrokerError(.attemptNotCurrent) {
      try await restarted.state.resumeStage(
        connectionID: connectionID,
        operationID: stageOperation,
        expectedFence: 1
      )
    }
    #expect(await store.retainedCount() == 1)
    let replacement = try await restarted.state.stage(
      connectionID: connectionID,
      operationID: fixtureUUID(173),
      expectedFence: 1,
      secret: SecretBytes(Data("new-incarnation".utf8))
    )
    #expect(replacement.fence == 2)
    #expect(replacement.candidate.ordinal == 2)
  }

  @Test
  func bootstrapValidationIsAllOrNothingAndAcceptsOnlyCanonicalStates() async throws {
    let vacantID = fixtureUUID(180)
    let readyID = fixtureUUID(181)
    let tombstoneID = fixtureUUID(182)
    let generation = CredentialGeneration(
      generationID: fixtureUUID(183),
      ordinal: 1,
      createdAt: fixtureDate
    )
    let ready = ReadyProjection(
      connectionID: readyID,
      fence: 2,
      ready: ReadyGeneration(generation: generation, committedAt: fixtureDate),
      lastGenerationOrdinal: 2
    )
    let tombstone = TombstoneProjection(
      connectionID: tombstoneID,
      fence: 3,
      lastGenerationOrdinal: 2,
      tombstonedAt: fixtureDate
    )
    let state = try BrokerCredentialState(
      store: InMemoryCredentialStore(),
      bootstrap: [
        .vacant(connectionID: vacantID, fence: 0, lastGenerationOrdinal: 0),
        .ready(ready),
        .tombstoned(tombstone),
      ]
    )
    #expect(await state.projection(for: vacantID) == nil)
    #expect(await state.projection(for: readyID) == .ready(ready))
    #expect(await state.projection(for: tombstoneID) == .tombstoned(tombstone))

    let nonfinite = Date(timeIntervalSinceReferenceDate: .nan)
    let invalid: [[CredentialBootstrap]] = [
      [
        .vacant(connectionID: vacantID, fence: 0, lastGenerationOrdinal: 0),
        .vacant(connectionID: vacantID, fence: 1, lastGenerationOrdinal: 1),
      ],
      [.vacant(connectionID: vacantID, fence: 1, lastGenerationOrdinal: 0)],
      [
        .vacant(
          connectionID: vacantID,
          fence: UInt64.max,
          lastGenerationOrdinal: UInt64.max
        )
      ],
      [
        .ready(
          ReadyProjection(
            connectionID: readyID,
            fence: 2,
            ready: ready.ready,
            lastGenerationOrdinal: 1
          )
        )
      ],
      [
        .ready(
          ReadyProjection(
            connectionID: readyID,
            fence: 1,
            ready: ReadyGeneration(
              generation: CredentialGeneration(
                generationID: fixtureUUID(184),
                ordinal: 0,
                createdAt: fixtureDate
              ),
              committedAt: fixtureDate
            ),
            lastGenerationOrdinal: 1
          )
        )
      ],
      [
        .ready(
          ReadyProjection(
            connectionID: readyID,
            fence: 1,
            ready: ReadyGeneration(
              generation: CredentialGeneration(
                generationID: fixtureUUID(185),
                ordinal: 2,
                createdAt: fixtureDate
              ),
              committedAt: fixtureDate
            ),
            lastGenerationOrdinal: 1
          )
        )
      ],
      [
        .ready(
          ReadyProjection(
            connectionID: readyID,
            fence: 1,
            ready: ReadyGeneration(
              generation: CredentialGeneration(
                generationID: fixtureUUID(186),
                ordinal: 1,
                createdAt: nonfinite
              ),
              committedAt: fixtureDate
            ),
            lastGenerationOrdinal: 1
          )
        )
      ],
      [
        .ready(
          ReadyProjection(
            connectionID: readyID,
            fence: 1,
            ready: ReadyGeneration(
              generation: CredentialGeneration(
                generationID: fixtureUUID(187),
                ordinal: 1,
                createdAt: fixtureDate
              ),
              committedAt: nonfinite
            ),
            lastGenerationOrdinal: 1
          )
        )
      ],
      [
        .tombstoned(
          TombstoneProjection(
            connectionID: tombstoneID,
            fence: 2,
            lastGenerationOrdinal: 2,
            tombstonedAt: fixtureDate
          )
        )
      ],
      [
        .tombstoned(
          TombstoneProjection(
            connectionID: tombstoneID,
            fence: UInt64.max,
            lastGenerationOrdinal: UInt64.max,
            tombstonedAt: fixtureDate
          )
        )
      ],
      [
        .tombstoned(
          TombstoneProjection(
            connectionID: tombstoneID,
            fence: 1,
            lastGenerationOrdinal: 0,
            tombstonedAt: nonfinite
          )
        )
      ],
    ]
    let generationSource = LockedSequence([fixtureUUID(188)])
    let attemptSource = LockedSequence([fixtureUUID(189)])
    let clock = LockedSequence([fixtureDate])
    for bootstrap in invalid {
      do {
        _ = try BrokerCredentialState(
          store: InMemoryCredentialStore(),
          bootstrap: bootstrap,
          clock: { clock.next() },
          generationIDSource: { generationSource.next() },
          attemptIDSource: { attemptSource.next() }
        )
        Issue.record("Invalid bootstrap unexpectedly succeeded.")
      } catch {
        #expect(error == .invalidBootstrap)
      }
    }
    #expect(generationSource.count() == 0)
    #expect(attemptSource.count() == 0)
    #expect(clock.count() == 0)
  }

  @Test
  func operationMatrixUsesCancellationMissingTombstoneFenceThenTransitionPrecedence() async throws {
    let harness = try makeHarness(store: InMemoryCredentialStore())
    let missing = fixtureUUID(190)
    await expectBrokerError(.connectionNotFound) {
      try await harness.state.commit(
        connectionID: missing,
        attemptID: fixtureUUID(191),
        operationID: fixtureUUID(192),
        expectedFence: 0
      )
    }
    await expectBrokerError(.connectionNotFound) {
      try await harness.state.abort(
        connectionID: missing,
        attemptID: fixtureUUID(191),
        operationID: fixtureUUID(193),
        expectedFence: 0
      )
    }
    await expectBrokerError(.connectionNotFound) {
      try await harness.state.disconnect(
        connectionID: missing,
        operationID: fixtureUUID(194),
        expectedFence: 0
      )
    }

    let gate = AsyncGate()
    let cancelled = Task {
      await gate.wait()
      return try await harness.state.disconnect(
        connectionID: missing,
        operationID: fixtureUUID(195),
        expectedFence: 0
      )
    }
    cancelled.cancel()
    await gate.release()
    await expectTaskError(.cancelled, cancelled)

    let connectionID = fixtureUUID(196)
    let attempt = try await harness.state.stage(
      connectionID: connectionID,
      operationID: fixtureUUID(197),
      expectedFence: 0,
      secret: SecretBytes(Data("matrix".utf8))
    )
    await expectBrokerError(.staleFence) {
      try await harness.state.commit(
        connectionID: connectionID,
        attemptID: fixtureUUID(198),
        operationID: fixtureUUID(199),
        expectedFence: 0
      )
    }
    await expectBrokerError(.attemptNotCurrent) {
      try await harness.state.commit(
        connectionID: connectionID,
        attemptID: fixtureUUID(198),
        operationID: fixtureUUID(200),
        expectedFence: 1
      )
    }
    _ = try await harness.state.disconnect(
      connectionID: connectionID,
      operationID: fixtureUUID(201),
      expectedFence: attempt.fence
    )
    await expectBrokerError(.connectionTombstoned) {
      try await harness.state.abort(
        connectionID: connectionID,
        attemptID: attempt.attemptID,
        operationID: fixtureUUID(202),
        expectedFence: 0
      )
    }
  }

  @Test
  func disconnectMayConsumeTheFinalFenceButStagePreservesIt() async throws {
    let store = InMemoryCredentialStore()
    let connectionID = fixtureUUID(210)
    let generationSource = LockedSequence([fixtureUUID(211)])
    let attemptSource = LockedSequence([fixtureUUID(212)])
    let clock = LockedSequence([fixtureDate])
    let state = try BrokerCredentialState(
      store: store,
      bootstrap: [
        .vacant(
          connectionID: connectionID,
          fence: UInt64.max - 1,
          lastGenerationOrdinal: UInt64.max - 1
        )
      ],
      clock: { clock.next() },
      generationIDSource: { generationSource.next() },
      attemptIDSource: { attemptSource.next() }
    )
    let secret = UncheckedSecretAlias(SecretBytes(Data("final-fence".utf8)))
    await expectBrokerError(.fenceOverflow) {
      try await state.stage(
        connectionID: connectionID,
        operationID: fixtureUUID(213),
        expectedFence: UInt64.max - 1,
        secret: secret.value
      )
    }
    #expect(secret.isErased())
    #expect(generationSource.count() == 0)
    #expect(attemptSource.count() == 0)
    #expect(clock.count() == 0)

    let tombstone = try await state.disconnect(
      connectionID: connectionID,
      operationID: fixtureUUID(214),
      expectedFence: UInt64.max - 1
    )
    #expect(tombstone.fence == UInt64.max)
    #expect(clock.count() == 1)
  }

  @Test
  func terminalMemoPrecedesActiveAndPausedReservationsIncludingCancellation() async throws {
    let store = InMemoryCredentialStore()
    let harness = try makeHarness(store: store)
    let connectionID = fixtureUUID(220)
    let firstStageOperation = fixtureUUID(221)
    let first = try await harness.state.stage(
      connectionID: connectionID,
      operationID: firstStageOperation,
      expectedFence: 0,
      secret: SecretBytes(Data("first".utf8))
    )
    _ = try await harness.state.commit(
      connectionID: connectionID,
      attemptID: first.attemptID,
      operationID: fixtureUUID(222),
      expectedFence: 1
    )

    await store.pauseNext(at: .storeBeforeSideEffect)
    let secondStageOperation = fixtureUUID(223)
    let secondTask = Task {
      try await harness.state.stage(
        connectionID: connectionID,
        operationID: secondStageOperation,
        expectedFence: 1,
        secret: SecretBytes(Data("second".utf8))
      )
    }
    await store.waitUntilPaused(at: .storeBeforeSideEffect)
    #expect(
      try await harness.state.resumeStage(
        connectionID: connectionID,
        operationID: firstStageOperation,
        expectedFence: 0
      ) == first
    )
    await expectBrokerError(.operationIDConflict) {
      try await harness.state.resumeStage(
        connectionID: connectionID,
        operationID: firstStageOperation,
        expectedFence: 999
      )
    }
    let replacement = UncheckedSecretAlias(SecretBytes(Data("memo-replacement".utf8)))
    #expect(
      try await harness.state.stage(
        connectionID: connectionID,
        operationID: firstStageOperation,
        expectedFence: 0,
        secret: replacement.value
      ) == first
    )
    #expect(replacement.isErased())
    let conflictingReplacement = UncheckedSecretAlias(
      SecretBytes(Data("memo-conflict-replacement".utf8))
    )
    await expectBrokerError(.operationIDConflict) {
      try await harness.state.stage(
        connectionID: connectionID,
        operationID: firstStageOperation,
        expectedFence: 999,
        secret: conflictingReplacement.value
      )
    }
    #expect(conflictingReplacement.isErased())

    let memoGate = AsyncGate()
    let cancelledMemoReplay = Task {
      await memoGate.wait()
      return try await harness.state.resumeStage(
        connectionID: connectionID,
        operationID: firstStageOperation,
        expectedFence: 0
      )
    }
    cancelledMemoReplay.cancel()
    await memoGate.release()
    #expect(try await cancelledMemoReplay.value == first)

    let activeGate = AsyncGate()
    let cancelledDuringActive = Task {
      await activeGate.wait()
      return try await harness.state.disconnect(
        connectionID: connectionID,
        operationID: fixtureUUID(224),
        expectedFence: 2
      )
    }
    cancelledDuringActive.cancel()
    await activeGate.release()
    await expectTaskError(.operationInProgress, cancelledDuringActive)

    await store.releaseOne(at: .storeBeforeSideEffect)
    let second = try await secondTask.value
    await store.failNext(at: .deleteBeforeSideEffect)
    let commitOperation = fixtureUUID(225)
    await expectBrokerError(.cleanupPending) {
      try await harness.state.commit(
        connectionID: connectionID,
        attemptID: second.attemptID,
        operationID: commitOperation,
        expectedFence: 2
      )
    }

    #expect(
      try await harness.state.resumeStage(
        connectionID: connectionID,
        operationID: secondStageOperation,
        expectedFence: 1
      ) == second
    )
    let pausedMemoGate = AsyncGate()
    let cancelledPausedMemoReplay = Task {
      await pausedMemoGate.wait()
      return try await harness.state.resumeStage(
        connectionID: connectionID,
        operationID: secondStageOperation,
        expectedFence: 1
      )
    }
    cancelledPausedMemoReplay.cancel()
    await pausedMemoGate.release()
    #expect(try await cancelledPausedMemoReplay.value == second)
    await expectBrokerError(.operationIDConflict) {
      try await harness.state.resumeStage(
        connectionID: connectionID,
        operationID: secondStageOperation,
        expectedFence: 2
      )
    }

    let pausedGate = AsyncGate()
    let cancelledDuringPause = Task {
      await pausedGate.wait()
      return try await harness.state.disconnect(
        connectionID: connectionID,
        operationID: fixtureUUID(226),
        expectedFence: 2
      )
    }
    cancelledDuringPause.cancel()
    await pausedGate.release()
    await expectTaskError(.cleanupPending, cancelledDuringPause)

    let completed = try await harness.state.commit(
      connectionID: connectionID,
      attemptID: second.attemptID,
      operationID: commitOperation,
      expectedFence: 2
    )
    #expect(completed.ready.generation == second.candidate)
  }

  @Test
  func terminalMemoRetainsExactlyTheLatest64OperationsFIFO() async throws {
    let store = InMemoryCredentialStore()
    let harness = try makeHarness(store: store)
    let connectionID = fixtureUUID(230)
    var attempts: [StagingAttempt] = []
    for index in 0..<65 {
      let attempt = try await harness.state.stage(
        connectionID: connectionID,
        operationID: fixtureUUID(3_000 + index * 2),
        expectedFence: UInt64(index),
        secret: SecretBytes(Data("memo-canary-\(index)".utf8))
      )
      _ = try await harness.state.abort(
        connectionID: connectionID,
        attemptID: attempt.attemptID,
        operationID: fixtureUUID(3_001 + index * 2),
        expectedFence: UInt64(index + 1)
      )
      attempts.append(attempt)
    }
    let storeCalls = (await store.inspection()).storeCallCounts.values.reduce(0, +)
    #expect(storeCalls == 65)
    let generationCalls = harness.generationIDs.count()
    let attemptCalls = harness.attemptIDs.count()
    let clockCalls = harness.clock.count()
    #expect((generationCalls, attemptCalls, clockCalls) == (65, 65, 130))

    // Stage and abort alternate terminal insertions. Cycle 32's stage is
    // insertion 64 and must be evicted after 130 total insertions.
    let evictedSecret = UncheckedSecretAlias(SecretBytes(Data("evicted".utf8)))
    await expectBrokerError(.staleFence) {
      try await harness.state.stage(
        connectionID: connectionID,
        operationID: fixtureUUID(3_000 + 32 * 2),
        expectedFence: 32,
        secret: evictedSecret.value
      )
    }
    #expect(evictedSecret.isErased())
    #expect((await store.inspection()).storeCallCounts.values.reduce(0, +) == storeCalls)
    #expect(harness.generationIDs.count() == generationCalls)
    #expect(harness.attemptIDs.count() == attemptCalls)
    #expect(harness.clock.count() == clockCalls)

    // Cycle 33's stage is insertion 66, the first retained stage result.
    let retainedSecret = UncheckedSecretAlias(SecretBytes(Data("retained".utf8)))
    let replay = try await harness.state.stage(
      connectionID: connectionID,
      operationID: fixtureUUID(3_000 + 33 * 2),
      expectedFence: 33,
      secret: retainedSecret.value
    )
    #expect(replay == attempts[33])
    #expect(retainedSecret.isErased())
    #expect((await store.inspection()).storeCallCounts.values.reduce(0, +) == storeCalls)
    #expect(harness.generationIDs.count() == generationCalls)
    #expect(harness.attemptIDs.count() == attemptCalls)
    #expect(harness.clock.count() == clockCalls)
  }

  @Test
  func testStoreOwnsErasesAndReportsOnlyMetadataAcrossEveryOutcome() async throws {
    let store = InMemoryCredentialStore()
    let connectionID = fixtureUUID(240)
    let firstKey = CredentialStoreKey(
      connectionID: connectionID,
      generationID: fixtureUUID(241),
      generationOrdinal: 1
    )
    let first = UncheckedSecretAlias(SecretBytes(Data("store-success".utf8)))
    try await store.store(first.value, for: firstKey)
    #expect(!first.isErased())
    #expect(await store.contains(firstKey))
    let loaded = try await store.load(for: firstKey)
    #expect(String(reflecting: loaded) == "<redacted>")
    loaded.erase()
    try await store.deleteIfPresent(firstKey)
    #expect(first.isErased())

    let unavailableKey = CredentialStoreKey(
      connectionID: connectionID,
      generationID: fixtureUUID(242),
      generationOrdinal: 2
    )
    let unavailable = UncheckedSecretAlias(SecretBytes(Data("store-unavailable".utf8)))
    await store.failNext(at: .storeBeforeSideEffect)
    await expectStoreError(.unavailable) {
      try await store.store(unavailable.value, for: unavailableKey)
    }
    #expect(unavailable.isErased())
    #expect(!(await store.contains(unavailableKey)))

    let unknownKey = CredentialStoreKey(
      connectionID: connectionID,
      generationID: fixtureUUID(243),
      generationOrdinal: 3
    )
    let unknown = UncheckedSecretAlias(SecretBytes(Data("store-unknown".utf8)))
    await store.failNext(at: .storeAfterSideEffect)
    await expectStoreError(.mutationOutcomeUnknown) {
      try await store.store(unknown.value, for: unknownKey)
    }
    #expect(!unknown.isErased())
    #expect(await store.contains(unknownKey))
    await store.failNext(at: .deleteAfterSideEffect)
    await expectStoreError(.mutationOutcomeUnknown) {
      try await store.deleteIfPresent(unknownKey)
    }
    #expect(unknown.isErased())
    #expect(!(await store.contains(unknownKey)))
    try await store.deleteIfPresent(unknownKey)

    let inspection = await store.inspection()
    #expect(inspection.retainedCount == 0)
    #expect(!String(reflecting: inspection).contains("store-success"))
    #expect(!String(reflecting: inspection).contains("store-unavailable"))
    #expect(!String(reflecting: inspection).contains("store-unknown"))
  }
}

private let fixtureDate = Date(timeIntervalSince1970: 1_700_000_000)

private struct StateHarness {
  let state: BrokerCredentialState
  let generationIDs: LockedSequence<UUID>
  let attemptIDs: LockedSequence<UUID>
  let clock: LockedSequence<Date>
}

private func makeHarness(
  store: any CredentialStore,
  bootstrap: [CredentialBootstrap] = []
) throws(BrokerStateError) -> StateHarness {
  let generationIDs = LockedSequence((1...200).map { fixtureUUID(10_000 + $0) })
  let attemptIDs = LockedSequence((1...200).map { fixtureUUID(20_000 + $0) })
  let clock = LockedSequence(Array(repeating: fixtureDate, count: 600))
  return StateHarness(
    state: try BrokerCredentialState(
      store: store,
      bootstrap: bootstrap,
      clock: { clock.next() },
      generationIDSource: { generationIDs.next() },
      attemptIDSource: { attemptIDs.next() }
    ),
    generationIDs: generationIDs,
    attemptIDs: attemptIDs,
    clock: clock
  )
}

private func fixtureUUID(_ value: Int) -> UUID {
  UUID(
    uuidString: String(
      format: "00000000-0000-0000-0000-%012llx",
      UInt64(value)
    )
  )!
}

private func storeKey(
  _ connectionID: UUID,
  _ generation: CredentialGeneration
) -> CredentialStoreKey {
  CredentialStoreKey(
    connectionID: connectionID,
    generationID: generation.generationID,
    generationOrdinal: generation.ordinal
  )
}

private struct CapturedBrokerOutcome {
  let isSuccess: Bool
  let failure: BrokerStateError?
}

private func capture<Value>(
  _ task: Task<Value, any Error>
) async -> CapturedBrokerOutcome {
  do {
    _ = try await task.value
    return CapturedBrokerOutcome(isSuccess: true, failure: nil)
  } catch let error as BrokerStateError {
    return CapturedBrokerOutcome(isSuccess: false, failure: error)
  } catch {
    Issue.record("Unexpected error type: \(String(reflecting: error))")
    return CapturedBrokerOutcome(isSuccess: false, failure: nil)
  }
}

private func expectBrokerError<Value>(
  _ expected: BrokerStateError,
  _ operation: () async throws -> Value
) async {
  do {
    _ = try await operation()
    Issue.record("Expected broker error \(expected).")
  } catch let error as BrokerStateError {
    #expect(error == expected)
  } catch {
    Issue.record("Unexpected error type: \(String(reflecting: error))")
  }
}

private func expectTaskError<Value>(
  _ expected: BrokerStateError,
  _ task: Task<Value, any Error>
) async {
  do {
    _ = try await task.value
    Issue.record("Expected task to fail with \(expected).")
  } catch let error as BrokerStateError {
    #expect(error == expected)
  } catch {
    Issue.record("Unexpected error type: \(String(reflecting: error))")
  }
}

private func expectStoreError<Value>(
  _ expected: CredentialStoreError,
  _ operation: () async throws -> Value
) async {
  do {
    _ = try await operation()
    Issue.record("Expected store error \(expected).")
  } catch let error as CredentialStoreError {
    #expect(error == expected)
  } catch {
    Issue.record("Unexpected error type: \(String(reflecting: error))")
  }
}

private func expectNoReflectedSecret(
  _ surface: String,
  canary: String,
  bytes: [UInt8]
) {
  let decimalBytes = bytes.map(String.init).joined(separator: ", ")
  let compactDecimalBytes = bytes.map(String.init).joined(separator: ",")
  let hexBytes = bytes.map { String(format: "%02x", $0) }.joined()
  let numericLeaves = surface.split(separator: "\n").compactMap { line -> UInt8? in
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    guard trimmed.hasPrefix("- ") else {
      return nil
    }
    return UInt8(trimmed.dropFirst(2))
  }
  #expect(!surface.contains(canary))
  #expect(!surface.contains("\(bytes.count) bytes"))
  #expect(!surface.contains(decimalBytes))
  #expect(!surface.contains(compactDecimalBytes))
  #expect(!surface.lowercased().contains(hexBytes))
  #expect(!numericLeaves.containsContiguous(bytes))
}

extension Collection where Element: Equatable {
  fileprivate func containsContiguous<Needle: Collection>(_ needle: Needle) -> Bool
  where Needle.Element == Element {
    guard !needle.isEmpty else {
      return true
    }
    return indices.contains { start in
      var haystackIndex = start
      var needleIndex = needle.startIndex
      while needleIndex != needle.endIndex, haystackIndex != endIndex {
        guard self[haystackIndex] == needle[needleIndex] else {
          return false
        }
        formIndex(after: &haystackIndex)
        needle.formIndex(after: &needleIndex)
      }
      return needleIndex == needle.endIndex
    }
  }
}
