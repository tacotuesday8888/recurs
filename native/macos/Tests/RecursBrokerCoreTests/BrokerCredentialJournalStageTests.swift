import Foundation
import Testing

@testable import RecursBrokerCore

@Suite("Broker credential journal stage")
struct BrokerCredentialJournalStageTests {
  @Test
  func freshStageWritesAheadStoresThenDurablyPublishesStaging() async throws {
    let fixture = try JournalStageActorFixture()
    let journal = try InMemoryBrokerJournalStore()
    let store = InMemoryCredentialStore()
    let harness = try await fixture.harness(store: store, journal: journal)

    let attempt = try await harness.state.stage(
      connectionID: fixture.connectionID,
      operationID: fixture.operationID,
      expectedFence: 0,
      secret: SecretBytes(Data("journal-stage-canary".utf8))
    )

    #expect(attempt.connectionID == fixture.connectionID)
    #expect(attempt.attemptID == fixture.attemptID)
    #expect(attempt.candidate.generationID == fixture.generationID)
    #expect(attempt.fence == 1)
    #expect(attempt.candidate.ordinal == 1)
    #expect(await harness.state.projection(for: fixture.connectionID) == .staging(attempt))
    #expect(await store.contains(journalStageStoreKey(fixture.connectionID, attempt.candidate)))
    let selected = try #require(try await journal.load(connectionID: fixture.connectionID))
    #expect(selected.record.phase == .staging)
    #expect(
      await journal.events() == [
        .list,
        .compareAndSwap(fixture.connectionID),
        .compareAndSwap(fixture.connectionID),
        .load(fixture.connectionID),
      ]
    )
    #expect(harness.generationIDs.count() == 1)
    #expect(harness.attemptIDs.count() == 1)
    #expect(harness.clock.count() == 2)
  }

  @Test
  func definiteStoreFailureDurablyRestoresStableAuthorityAndReplays() async throws {
    let fixture = try JournalStageActorFixture()
    let journal = try InMemoryBrokerJournalStore()
    let store = InMemoryCredentialStore()
    await store.failNext(at: .storeBeforeSideEffect)
    let harness = try await fixture.harness(store: store, journal: journal)

    await expectJournalStageError(.storeUnavailable) {
      try await harness.state.stage(
        connectionID: fixture.connectionID,
        operationID: fixture.operationID,
        expectedFence: 0,
        secret: SecretBytes(Data("definite-store-failure".utf8))
      )
    }

    let selected = try #require(try await journal.load(connectionID: fixture.connectionID))
    #expect(selected.record.phase == .vacant)
    guard case .stageFailure(let terminal) = selected.record.terminalOperations.last else {
      Issue.record("expected persisted stage failure")
      return
    }
    #expect(terminal.operationID == fixture.operationID)
    #expect(terminal.error == .storeUnavailable)
    #expect(await store.retainedCount() == 0)
    let eventsBeforeReplay = await journal.events()

    await expectJournalStageError(.storeUnavailable) {
      try await harness.state.resumeStage(
        connectionID: fixture.connectionID,
        operationID: fixture.operationID,
        expectedFence: 0
      )
    }
    #expect(await journal.events() == eventsBeforeReplay)
  }

  @Test
  func failedStagingCASRetainsCleanupIntentForNormalResumeStage() async throws {
    let fixture = try JournalStageActorFixture()
    let journal = try InMemoryBrokerJournalStore()
    let store = InMemoryCredentialStore()
    await store.pauseNext(at: .storeAfterSideEffect)
    let harness = try await fixture.harness(store: store, journal: journal)
    let operation = Task {
      try await harness.state.stage(
        connectionID: fixture.connectionID,
        operationID: fixture.operationID,
        expectedFence: 0,
        secret: SecretBytes(Data("staging-cas-failure".utf8))
      )
    }
    await store.waitUntilPaused(at: .storeAfterSideEffect)
    await journal.failNext(.storageUnavailable, at: .compareAndSwapBeforeSideEffect)
    await journal.failNext(.storageUnavailable, at: .compareAndSwapBeforeSideEffect)
    await store.releaseOne(at: .storeAfterSideEffect)

    await expectJournalStageTaskError(.cleanupPending, operation)

    await expectJournalStageError(.storeUnavailable) {
      try await harness.state.resumeStage(
        connectionID: fixture.connectionID,
        operationID: fixture.operationID,
        expectedFence: 0
      )
    }
    let selected = try #require(try await journal.load(connectionID: fixture.connectionID))
    #expect(selected.record.phase == .vacant)
    #expect(await store.retainedCount() == 0)
    let candidateKey = CredentialStoreKey(
      connectionID: fixture.connectionID,
      generationID: fixture.generationID,
      generationOrdinal: 1
    )
    #expect(await store.deleteCallCount(for: candidateKey) == 1)
  }

  @Test
  func writeAheadCompletesBeforeStoreAndStagingCASCompletesBeforePublication() async throws {
    let fixture = try JournalStageActorFixture()
    let journal = try InMemoryBrokerJournalStore()
    let store = InMemoryCredentialStore()
    await journal.pauseNext(at: .compareAndSwapAfterSideEffect)
    let harness = try await fixture.harness(store: store, journal: journal)
    let operation = Task {
      try await harness.state.stage(
        connectionID: fixture.connectionID,
        operationID: fixture.operationID,
        expectedFence: 0,
        secret: SecretBytes(Data("write-ahead-order".utf8))
      )
    }
    await journal.waitUntilPaused(at: .compareAndSwapAfterSideEffect)

    #expect((await store.inspection()).storeCallCounts.isEmpty)
    #expect(await harness.state.projection(for: fixture.connectionID) == nil)
    #expect(
      (try await journal.load(connectionID: fixture.connectionID))?.record.phase == .storePending)

    await journal.pauseNext(at: .compareAndSwapBeforeSideEffect)
    await journal.releaseOne(at: .compareAndSwapAfterSideEffect)
    await journal.waitUntilPaused(at: .compareAndSwapBeforeSideEffect)

    #expect(await store.retainedCount() == 1)
    #expect(await harness.state.projection(for: fixture.connectionID) == nil)
    #expect(
      (try await journal.load(connectionID: fixture.connectionID))?.record.phase == .storePending)

    await journal.releaseOne(at: .compareAndSwapBeforeSideEffect)
    let attempt = try await operation.value
    #expect(await harness.state.projection(for: fixture.connectionID) == .staging(attempt))
  }

  @Test
  func cancellationAfterSelectedStagingNeverPublishesAndDurablyCleansCandidate() async throws {
    let fixture = try JournalStageActorFixture()
    let journal = try InMemoryBrokerJournalStore()
    let store = InMemoryCredentialStore()
    await store.pauseNext(at: .storeAfterSideEffect)
    let harness = try await fixture.harness(store: store, journal: journal)
    let operation = Task {
      try await harness.state.stage(
        connectionID: fixture.connectionID,
        operationID: fixture.operationID,
        expectedFence: 0,
        secret: SecretBytes(Data("cancel-after-staging".utf8))
      )
    }
    await store.waitUntilPaused(at: .storeAfterSideEffect)
    await journal.pauseNext(at: .compareAndSwapAfterSideEffect)
    await store.releaseOne(at: .storeAfterSideEffect)
    await journal.waitUntilPaused(at: .compareAndSwapAfterSideEffect)

    #expect((try await journal.load(connectionID: fixture.connectionID))?.record.phase == .staging)
    #expect(await harness.state.projection(for: fixture.connectionID) == nil)
    operation.cancel()
    await journal.releaseOne(at: .compareAndSwapAfterSideEffect)

    await expectJournalStageTaskError(.cancelled, operation)
    #expect(await harness.state.projection(for: fixture.connectionID) == nil)
    #expect((try await journal.load(connectionID: fixture.connectionID))?.record.phase == .vacant)
    #expect(await store.retainedCount() == 0)
  }

  @Test
  func cancellationDuringFailedStagingCASPersistsCancelledResult() async throws {
    let fixture = try JournalStageActorFixture()
    let journal = try InMemoryBrokerJournalStore()
    let store = InMemoryCredentialStore()
    await store.pauseNext(at: .storeAfterSideEffect)
    let harness = try await fixture.harness(store: store, journal: journal)
    let operation = Task {
      try await harness.state.stage(
        connectionID: fixture.connectionID,
        operationID: fixture.operationID,
        expectedFence: 0,
        secret: SecretBytes(Data("cancel-during-failed-staging-cas".utf8))
      )
    }
    await store.waitUntilPaused(at: .storeAfterSideEffect)
    await journal.pauseNext(at: .compareAndSwapBeforeSideEffect)
    await journal.failNext(.storageUnavailable, at: .compareAndSwapBeforeSideEffect)
    await store.releaseOne(at: .storeAfterSideEffect)
    await journal.waitUntilPaused(at: .compareAndSwapBeforeSideEffect)

    operation.cancel()
    await journal.releaseOne(at: .compareAndSwapBeforeSideEffect)

    await expectJournalStageTaskError(.cancelled, operation)
    #expect(await harness.state.projection(for: fixture.connectionID) == nil)
    #expect((try await journal.load(connectionID: fixture.connectionID))?.record.phase == .vacant)
    #expect(await store.retainedCount() == 0)
  }

  @Test
  func unknownAfterSelectedFirstCASReconcilesAndCompletesStage() async throws {
    let fixture = try JournalStageActorFixture()
    let journal = try InMemoryBrokerJournalStore()
    await journal.failNext(.mutationOutcomeUnknown, at: .compareAndSwapAfterSideEffect)
    let store = InMemoryCredentialStore()
    let harness = try await fixture.harness(store: store, journal: journal)

    let attempt = try await harness.state.stage(
      connectionID: fixture.connectionID,
      operationID: fixture.operationID,
      expectedFence: 0,
      secret: SecretBytes(Data("selected-first-cas-unknown".utf8))
    )

    let candidateKey = journalStageStoreKey(fixture.connectionID, attempt.candidate)
    #expect(await store.storeCallCount(for: candidateKey) == 1)
    #expect(await store.contains(candidateKey))
    #expect(await harness.state.projection(for: fixture.connectionID) == .staging(attempt))
    #expect(
      (try await journal.load(connectionID: fixture.connectionID))?.record.phase == .staging)
    #expect(
      await journal.events() == [
        .list,
        .compareAndSwap(fixture.connectionID),
        .load(fixture.connectionID),
        .compareAndSwap(fixture.connectionID),
        .load(fixture.connectionID),
      ]
    )
  }

  @Test
  func unknownFirstCASDoesNotPromoteSameRecordWithDifferentTag() async throws {
    let fixture = try JournalStageActorFixture()
    let journal = try InMemoryBrokerJournalStore()
    await journal.pauseNext(at: .loadBeforeReturn)
    await journal.failNext(.mutationOutcomeUnknown, at: .compareAndSwapAfterSideEffect)
    let store = InMemoryCredentialStore()
    let harness = try await fixture.harness(store: store, journal: journal)
    let alias = UncheckedSecretAlias(SecretBytes(Data("first-cas-tag-substitution".utf8)))
    let operation = Task {
      try await harness.state.stage(
        connectionID: fixture.connectionID,
        operationID: fixture.operationID,
        expectedFence: 0,
        secret: alias.value
      )
    }
    await journal.waitUntilPaused(at: .loadBeforeReturn)
    let selected = try #require(try await journal.load(connectionID: fixture.connectionID))
    await journal.replaceExternally(try fixture.withDifferentTag(selected))

    await journal.releaseOne(at: .loadBeforeReturn)

    await expectJournalStageTaskError(.cleanupPending, operation)
    #expect(alias.isErased())
    #expect((await store.inspection()).storeCallCounts.isEmpty)
    #expect(await harness.state.projection(for: fixture.connectionID) == nil)
  }

  @Test
  func unknownBeforeUnselectedFirstCASLoadsExactPreviousThenFailsDefinitely() async throws {
    let fixture = try JournalStageActorFixture()
    let journal = try InMemoryBrokerJournalStore()
    await journal.failNext(.mutationOutcomeUnknown, at: .compareAndSwapBeforeSideEffect)
    let store = InMemoryCredentialStore()
    let harness = try await fixture.harness(store: store, journal: journal)
    let alias = UncheckedSecretAlias(SecretBytes(Data("unselected-first-cas-unknown".utf8)))

    await expectJournalStageError(.storeUnavailable) {
      try await harness.state.stage(
        connectionID: fixture.connectionID,
        operationID: fixture.operationID,
        expectedFence: 0,
        secret: alias.value
      )
    }

    #expect(alias.isErased())
    #expect((await store.inspection()).storeCallCounts.isEmpty)
    #expect(await harness.state.projection(for: fixture.connectionID) == nil)
    #expect(
      await journal.events() == [
        .list,
        .compareAndSwap(fixture.connectionID),
        .load(fixture.connectionID),
      ]
    )
  }

  @Test
  func unknownStoreOutcomeDurablyDeletesCandidateBeforeReturningFixedFailure() async throws {
    let fixture = try JournalStageActorFixture()
    let journal = try InMemoryBrokerJournalStore()
    let store = InMemoryCredentialStore()
    await store.failNext(at: .storeAfterSideEffect)
    let harness = try await fixture.harness(store: store, journal: journal)

    await expectJournalStageError(.storeUnavailable) {
      try await harness.state.stage(
        connectionID: fixture.connectionID,
        operationID: fixture.operationID,
        expectedFence: 0,
        secret: SecretBytes(Data("unknown-store-outcome".utf8))
      )
    }

    #expect(await store.retainedCount() == 0)
    #expect((try await journal.load(connectionID: fixture.connectionID))?.record.phase == .vacant)
    let candidateKey = CredentialStoreKey(
      connectionID: fixture.connectionID,
      generationID: fixture.generationID,
      generationOrdinal: 1
    )
    #expect(await store.deleteCallCount(for: candidateKey) == 1)
  }

  @Test
  func invalidPostPendingTimestampPausesExactCleanupIntentForResume() async throws {
    let fixture = try JournalStageActorFixture()
    let journal = try InMemoryBrokerJournalStore()
    let store = InMemoryCredentialStore()
    let harness = try await fixture.harness(
      store: store,
      journal: journal,
      dates: [
        fixture.firstDate,
        Date(timeIntervalSince1970: .infinity),
        fixture.secondDate,
        fixture.secondDate.addingTimeInterval(1),
      ]
    )

    await expectJournalStageError(.cleanupPending) {
      try await harness.state.stage(
        connectionID: fixture.connectionID,
        operationID: fixture.operationID,
        expectedFence: 0,
        secret: SecretBytes(Data("invalid-post-pending-clock".utf8))
      )
    }

    #expect(
      (try await journal.load(connectionID: fixture.connectionID))?.record.phase == .storePending)
    #expect(await store.retainedCount() == 1)
    await expectJournalStageError(.storeUnavailable) {
      try await harness.state.resumeStage(
        connectionID: fixture.connectionID,
        operationID: fixture.operationID,
        expectedFence: 0
      )
    }
    #expect((try await journal.load(connectionID: fixture.connectionID))?.record.phase == .vacant)
    #expect(await store.retainedCount() == 0)
  }

  @Test
  func cancellationAfterStorePendingErasesBeforeStoreAndPersistsCancelledReplay() async throws {
    let fixture = try JournalStageActorFixture()
    let journal = try InMemoryBrokerJournalStore()
    await journal.pauseNext(at: .compareAndSwapAfterSideEffect)
    let store = InMemoryCredentialStore()
    let harness = try await fixture.harness(store: store, journal: journal)
    let alias = UncheckedSecretAlias(SecretBytes(Data("cancel-after-pending".utf8)))
    let operation = Task {
      try await harness.state.stage(
        connectionID: fixture.connectionID,
        operationID: fixture.operationID,
        expectedFence: 0,
        secret: alias.value
      )
    }
    await journal.waitUntilPaused(at: .compareAndSwapAfterSideEffect)
    operation.cancel()
    await journal.releaseOne(at: .compareAndSwapAfterSideEffect)

    await expectJournalStageTaskError(.cancelled, operation)

    #expect(alias.isErased())
    #expect((await store.inspection()).storeCallCounts.isEmpty)
    let selected = try #require(try await journal.load(connectionID: fixture.connectionID))
    #expect(selected.record.phase == .vacant)
    guard case .stageFailure(let terminal) = selected.record.terminalOperations.last else {
      Issue.record("expected cancelled replay")
      return
    }
    #expect(terminal.error == .cancelled)
  }

  @Test
  func failedFinalCleanupCASRemainsResumableWithoutRepeatingSuccessfulDelete() async throws {
    let fixture = try JournalStageActorFixture()
    let journal = try InMemoryBrokerJournalStore()
    let store = InMemoryCredentialStore()
    await store.failNext(at: .storeAfterSideEffect)
    await store.pauseNext(at: .deleteBeforeSideEffect)
    let harness = try await fixture.harness(store: store, journal: journal)
    let operation = Task {
      try await harness.state.stage(
        connectionID: fixture.connectionID,
        operationID: fixture.operationID,
        expectedFence: 0,
        secret: SecretBytes(Data("final-cas-retry".utf8))
      )
    }
    await store.waitUntilPaused(at: .deleteBeforeSideEffect)
    await journal.failNext(.storageUnavailable, at: .compareAndSwapBeforeSideEffect)
    await store.releaseOne(at: .deleteBeforeSideEffect)

    await expectJournalStageTaskError(.cleanupPending, operation)
    let candidateKey = CredentialStoreKey(
      connectionID: fixture.connectionID,
      generationID: fixture.generationID,
      generationOrdinal: 1
    )
    #expect(await store.deleteCallCount(for: candidateKey) == 1)

    await expectJournalStageError(.storeUnavailable) {
      try await harness.state.resumeStage(
        connectionID: fixture.connectionID,
        operationID: fixture.operationID,
        expectedFence: 0
      )
    }
    #expect(await store.deleteCallCount(for: candidateKey) == 1)
    #expect((try await journal.load(connectionID: fixture.connectionID))?.record.phase == .vacant)
  }

  @Test
  func unknownAfterSelectedStagingCASReconcilesAndPublishes() async throws {
    let fixture = try JournalStageActorFixture()
    let journal = try InMemoryBrokerJournalStore()
    let store = InMemoryCredentialStore()
    await store.pauseNext(at: .storeAfterSideEffect)
    let harness = try await fixture.harness(store: store, journal: journal)
    let operation = Task {
      try await harness.state.stage(
        connectionID: fixture.connectionID,
        operationID: fixture.operationID,
        expectedFence: 0,
        secret: SecretBytes(Data("raw-staging-unknown".utf8))
      )
    }
    await store.waitUntilPaused(at: .storeAfterSideEffect)
    await journal.failNext(.mutationOutcomeUnknown, at: .compareAndSwapAfterSideEffect)
    await store.releaseOne(at: .storeAfterSideEffect)

    let attempt = try await operation.value
    #expect(await harness.state.projection(for: fixture.connectionID) == .staging(attempt))
    #expect((try await journal.load(connectionID: fixture.connectionID))?.record.phase == .staging)
    let candidateKey = journalStageStoreKey(fixture.connectionID, attempt.candidate)
    #expect(await store.contains(candidateKey))
    #expect(await store.deleteCallCount(for: candidateKey) == 0)
  }

  @Test
  func unknownStagingCASDoesNotPublishSameRecordWithDifferentTag() async throws {
    let fixture = try JournalStageActorFixture()
    let journal = try InMemoryBrokerJournalStore()
    let store = InMemoryCredentialStore()
    await store.pauseNext(at: .storeAfterSideEffect)
    let harness = try await fixture.harness(store: store, journal: journal)
    let operation = Task {
      try await harness.state.stage(
        connectionID: fixture.connectionID,
        operationID: fixture.operationID,
        expectedFence: 0,
        secret: SecretBytes(Data("staging-tag-substitution".utf8))
      )
    }
    await store.waitUntilPaused(at: .storeAfterSideEffect)
    await journal.pauseNext(at: .loadBeforeReturn)
    await journal.failNext(.mutationOutcomeUnknown, at: .compareAndSwapAfterSideEffect)
    await store.releaseOne(at: .storeAfterSideEffect)
    await journal.waitUntilPaused(at: .loadBeforeReturn)
    let selected = try #require(try await journal.load(connectionID: fixture.connectionID))
    await journal.replaceExternally(try fixture.withDifferentTag(selected))

    await journal.releaseOne(at: .loadBeforeReturn)

    await expectJournalStageTaskError(.cleanupPending, operation)
    let candidateKey = CredentialStoreKey(
      connectionID: fixture.connectionID,
      generationID: fixture.generationID,
      generationOrdinal: 1
    )
    #expect(await store.contains(candidateKey))
    #expect(await store.deleteCallCount(for: candidateKey) == 0)
    #expect(await harness.state.projection(for: fixture.connectionID) == nil)
  }

  @Test
  func failedStagingReconciliationLoadIsExactlyResumable() async throws {
    let fixture = try JournalStageActorFixture()
    let journal = try InMemoryBrokerJournalStore()
    let store = InMemoryCredentialStore()
    await store.pauseNext(at: .storeAfterSideEffect)
    let harness = try await fixture.harness(store: store, journal: journal)
    let operation = Task {
      try await harness.state.stage(
        connectionID: fixture.connectionID,
        operationID: fixture.operationID,
        expectedFence: 0,
        secret: SecretBytes(Data("resumable-staging-reconciliation".utf8))
      )
    }
    await store.waitUntilPaused(at: .storeAfterSideEffect)
    await journal.failNext(.mutationOutcomeUnknown, at: .compareAndSwapAfterSideEffect)
    await journal.failNext(.storageUnavailable, at: .loadBeforeReturn)
    await store.releaseOne(at: .storeAfterSideEffect)

    await expectJournalStageTaskError(.cleanupPending, operation)
    let attempt = try await harness.state.resumeStage(
      connectionID: fixture.connectionID,
      operationID: fixture.operationID,
      expectedFence: 0
    )

    #expect(await harness.state.projection(for: fixture.connectionID) == .staging(attempt))
    let candidateKey = journalStageStoreKey(fixture.connectionID, attempt.candidate)
    #expect(await store.contains(candidateKey))
    #expect(await store.deleteCallCount(for: candidateKey) == 0)
  }

  @Test(arguments: [false, true])
  func cancellationRemainsStickyAcrossFailedStagingReconciliation(
    _ stagingWasSelected: Bool
  ) async throws {
    let fixture = try JournalStageActorFixture()
    let journal = try InMemoryBrokerJournalStore()
    let store = InMemoryCredentialStore()
    await store.pauseNext(at: .storeAfterSideEffect)
    let harness = try await fixture.harness(store: store, journal: journal)
    let operation = Task {
      try await harness.state.stage(
        connectionID: fixture.connectionID,
        operationID: fixture.operationID,
        expectedFence: 0,
        secret: SecretBytes(Data("sticky-staging-cancellation".utf8))
      )
    }
    await store.waitUntilPaused(at: .storeAfterSideEffect)
    await journal.pauseNext(at: .loadBeforeReturn)
    await journal.failNext(
      stagingWasSelected ? .mutationOutcomeUnknown : .storageUnavailable,
      at: stagingWasSelected
        ? .compareAndSwapAfterSideEffect : .compareAndSwapBeforeSideEffect
    )
    await journal.failNext(.storageUnavailable, at: .loadBeforeReturn)
    await store.releaseOne(at: .storeAfterSideEffect)
    await journal.waitUntilPaused(at: .loadBeforeReturn)

    operation.cancel()
    await journal.releaseOne(at: .loadBeforeReturn)
    await expectJournalStageTaskError(.cleanupPending, operation)

    await expectJournalStageError(.cancelled) {
      try await harness.state.resumeStage(
        connectionID: fixture.connectionID,
        operationID: fixture.operationID,
        expectedFence: 0
      )
    }
    let candidateKey = CredentialStoreKey(
      connectionID: fixture.connectionID,
      generationID: fixture.generationID,
      generationOrdinal: 1
    )
    #expect(await store.deleteCallCount(for: candidateKey) == 1)
    #expect(!(await store.contains(candidateKey)))
    #expect(await harness.state.projection(for: fixture.connectionID) == nil)
    #expect((try await journal.load(connectionID: fixture.connectionID))?.record.phase == .vacant)
  }

  @Test
  func unrelatedStagingReconciliationIsExactlyResumableAfterAuthorityRestores() async throws {
    let fixture = try JournalStageActorFixture()
    let journal = try InMemoryBrokerJournalStore()
    let store = InMemoryCredentialStore()
    await store.pauseNext(at: .storeAfterSideEffect)
    let harness = try await fixture.harness(store: store, journal: journal)
    let operation = Task {
      try await harness.state.stage(
        connectionID: fixture.connectionID,
        operationID: fixture.operationID,
        expectedFence: 0,
        secret: SecretBytes(Data("unrelated-staging-reconciliation".utf8))
      )
    }
    await store.waitUntilPaused(at: .storeAfterSideEffect)
    await journal.pauseNext(at: .loadBeforeReturn)
    await journal.failNext(.mutationOutcomeUnknown, at: .compareAndSwapAfterSideEffect)
    await store.releaseOne(at: .storeAfterSideEffect)
    await journal.waitUntilPaused(at: .loadBeforeReturn)
    let intended = try #require(try await journal.load(connectionID: fixture.connectionID))
    await journal.replaceExternally(try fixture.readySnapshot())
    await journal.releaseOne(at: .loadBeforeReturn)

    await expectJournalStageTaskError(.cleanupPending, operation)
    await journal.replaceExternally(intended)
    let attempt = try await harness.state.resumeStage(
      connectionID: fixture.connectionID,
      operationID: fixture.operationID,
      expectedFence: 0
    )

    #expect(await harness.state.projection(for: fixture.connectionID) == .staging(attempt))
  }

  @Test
  func cancellationDuringUnknownSelectedStagingCASDurablyCleansCandidate() async throws {
    let fixture = try JournalStageActorFixture()
    let journal = try InMemoryBrokerJournalStore()
    let store = InMemoryCredentialStore()
    await store.pauseNext(at: .storeAfterSideEffect)
    let harness = try await fixture.harness(store: store, journal: journal)
    let operation = Task {
      try await harness.state.stage(
        connectionID: fixture.connectionID,
        operationID: fixture.operationID,
        expectedFence: 0,
        secret: SecretBytes(Data("cancel-selected-staging-unknown".utf8))
      )
    }
    await store.waitUntilPaused(at: .storeAfterSideEffect)
    await journal.pauseNext(at: .compareAndSwapAfterSideEffect)
    await journal.failNext(.mutationOutcomeUnknown, at: .compareAndSwapAfterSideEffect)
    await store.releaseOne(at: .storeAfterSideEffect)
    await journal.waitUntilPaused(at: .compareAndSwapAfterSideEffect)

    operation.cancel()
    await journal.releaseOne(at: .compareAndSwapAfterSideEffect)

    await expectJournalStageTaskError(.cancelled, operation)
    let candidateKey = CredentialStoreKey(
      connectionID: fixture.connectionID,
      generationID: fixture.generationID,
      generationOrdinal: 1
    )
    #expect(await store.deleteCallCount(for: candidateKey) == 1)
    #expect(!(await store.contains(candidateKey)))
    #expect(await harness.state.projection(for: fixture.connectionID) == nil)
    #expect((try await journal.load(connectionID: fixture.connectionID))?.record.phase == .vacant)
  }

  @Test(arguments: JournalStageActorFixture.severeJournalErrors)
  func severeStagingCASFailureStopsBeforeReconciliationOrCleanup(
    _ failure: BrokerJournalError
  ) async throws {
    let fixture = try JournalStageActorFixture()
    let journal = try InMemoryBrokerJournalStore()
    let store = InMemoryCredentialStore()
    await store.pauseNext(at: .storeAfterSideEffect)
    let harness = try await fixture.harness(store: store, journal: journal)
    let operation = Task {
      try await harness.state.stage(
        connectionID: fixture.connectionID,
        operationID: fixture.operationID,
        expectedFence: 0,
        secret: SecretBytes(Data("severe-staging-cas".utf8))
      )
    }
    await store.waitUntilPaused(at: .storeAfterSideEffect)
    await journal.failNext(failure, at: .compareAndSwapBeforeSideEffect)
    await journal.resetEvents()
    await store.releaseOne(at: .storeAfterSideEffect)

    await expectJournalStageTaskError(.cleanupPending, operation)
    let candidateKey = CredentialStoreKey(
      connectionID: fixture.connectionID,
      generationID: fixture.generationID,
      generationOrdinal: 1
    )
    #expect(await store.contains(candidateKey))
    #expect(await store.deleteCallCount(for: candidateKey) == 0)
    #expect(await harness.state.projection(for: fixture.connectionID) == nil)
    #expect(await journal.events() == [.compareAndSwap(fixture.connectionID)])

    await expectJournalStageJournalError(.storageUnavailable) {
      try await harness.state.authoritativeProjection(for: fixture.connectionID)
    }
    #expect(await journal.events() == [.compareAndSwap(fixture.connectionID)])

    let rejected = UncheckedSecretAlias(SecretBytes(Data("poisoned-stage".utf8)))
    await expectJournalStageError(.storeUnavailable) {
      try await harness.state.stage(
        connectionID: journalStageActorUUID(90),
        operationID: journalStageActorUUID(91),
        expectedFence: 0,
        secret: rejected.value
      )
    }
    #expect(rejected.isErased())
    #expect(await journal.events() == [.compareAndSwap(fixture.connectionID)])
  }

  @Test
  func severeFailureAfterSelectedStagingDefersCandidateCleanupToRestart() async throws {
    let fixture = try JournalStageActorFixture()
    let journal = try InMemoryBrokerJournalStore()
    let store = InMemoryCredentialStore()
    await store.pauseNext(at: .storeAfterSideEffect)
    let harness = try await fixture.harness(store: store, journal: journal)
    let operation = Task {
      try await harness.state.stage(
        connectionID: fixture.connectionID,
        operationID: fixture.operationID,
        expectedFence: 0,
        secret: SecretBytes(Data("severe-selected-staging".utf8))
      )
    }
    await store.waitUntilPaused(at: .storeAfterSideEffect)
    await journal.failNext(.authenticationFailed, at: .compareAndSwapAfterSideEffect)
    await store.releaseOne(at: .storeAfterSideEffect)

    await expectJournalStageTaskError(.cleanupPending, operation)
    let candidateKey = CredentialStoreKey(
      connectionID: fixture.connectionID,
      generationID: fixture.generationID,
      generationOrdinal: 1
    )
    #expect(await store.contains(candidateKey))
    #expect(await store.deleteCallCount(for: candidateKey) == 0)
    #expect((try await journal.load(connectionID: fixture.connectionID))?.record.phase == .staging)

    let recoveryClock = LockedSequence([
      fixture.secondDate,
      fixture.secondDate.addingTimeInterval(1),
    ])
    let restarted = try await BrokerCredentialState.recoveringForTests(
      store: store,
      journal: journal,
      clock: recoveryClock.next
    )

    #expect(!(await store.contains(candidateKey)))
    #expect(await store.deleteCallCount(for: candidateKey) == 1)
    #expect((try await journal.load(connectionID: fixture.connectionID))?.record.phase == .vacant)
    await expectJournalStageError(.attemptNotCurrent) {
      try await restarted.resumeStage(
        connectionID: fixture.connectionID,
        operationID: fixture.operationID,
        expectedFence: 0
      )
    }
  }

  @Test
  func severeStagingReconciliationFailurePoisonsBeforeCleanupIO() async throws {
    let fixture = try JournalStageActorFixture()
    let journal = try InMemoryBrokerJournalStore()
    let store = InMemoryCredentialStore()
    await store.pauseNext(at: .storeAfterSideEffect)
    let harness = try await fixture.harness(store: store, journal: journal)
    let operation = Task {
      try await harness.state.stage(
        connectionID: fixture.connectionID,
        operationID: fixture.operationID,
        expectedFence: 0,
        secret: SecretBytes(Data("severe-staging-reconciliation".utf8))
      )
    }
    await store.waitUntilPaused(at: .storeAfterSideEffect)
    await journal.failNext(.storageUnavailable, at: .compareAndSwapBeforeSideEffect)
    await journal.failNext(.authenticationFailed, at: .loadBeforeReturn)
    await journal.resetEvents()
    await store.releaseOne(at: .storeAfterSideEffect)

    await expectJournalStageTaskError(.cleanupPending, operation)
    let candidateKey = CredentialStoreKey(
      connectionID: fixture.connectionID,
      generationID: fixture.generationID,
      generationOrdinal: 1
    )
    #expect(await store.contains(candidateKey))
    #expect(await store.deleteCallCount(for: candidateKey) == 0)
    #expect(
      await journal.events() == [
        .compareAndSwap(fixture.connectionID),
        .load(fixture.connectionID),
      ]
    )
    await expectJournalStageJournalError(.storageUnavailable) {
      try await harness.state.authoritativeProjection(for: fixture.connectionID)
    }
    #expect(
      await journal.events() == [
        .compareAndSwap(fixture.connectionID),
        .load(fixture.connectionID),
      ]
    )
  }

  @Test
  func reconnectStageRetainsPreviousReadyUntilDurableStagingPublication() async throws {
    let fixture = try JournalStageActorFixture()
    let ready = try fixture.readySnapshot()
    let journal = try InMemoryBrokerJournalStore(snapshots: [ready])
    let store = InMemoryCredentialStore()
    let harness = try await fixture.harness(store: store, journal: journal)

    let attempt = try await harness.state.stage(
      connectionID: fixture.connectionID,
      operationID: fixture.operationID,
      expectedFence: 1,
      secret: SecretBytes(Data("reconnect-stage".utf8))
    )

    guard case .ready(let priorPayload) = ready.record.payload else {
      Issue.record("expected ready predecessor")
      return
    }
    #expect(attempt.fence == 2)
    #expect(attempt.candidate.ordinal == 2)
    #expect(
      attempt.previousReady
        == (try BrokerJournalRecordAdapter.readyGeneration(from: priorPayload.ready))
    )
    #expect(await harness.state.projection(for: fixture.connectionID) == .staging(attempt))
    #expect((try await journal.load(connectionID: fixture.connectionID))?.record.phase == .staging)
  }

  @Test
  func activeJournalStageBlocksOnlyItsConnection() async throws {
    let fixture = try JournalStageActorFixture()
    let otherConnection = journalStageActorUUID(50)
    let journal = try InMemoryBrokerJournalStore()
    let store = InMemoryCredentialStore()
    await journal.pauseNext(at: .compareAndSwapBeforeSideEffect)
    let harness = try await fixture.harness(store: store, journal: journal)
    let first = Task {
      try await harness.state.stage(
        connectionID: fixture.connectionID,
        operationID: fixture.operationID,
        expectedFence: 0,
        secret: SecretBytes(Data("blocked-first".utf8))
      )
    }
    await journal.waitUntilPaused(at: .compareAndSwapBeforeSideEffect)

    let rejected = UncheckedSecretAlias(SecretBytes(Data("same-connection".utf8)))
    await expectJournalStageError(.operationInProgress) {
      try await harness.state.stage(
        connectionID: fixture.connectionID,
        operationID: journalStageActorUUID(51),
        expectedFence: 0,
        secret: rejected.value
      )
    }
    #expect(rejected.isErased())

    let independent = try await harness.state.stage(
      connectionID: otherConnection,
      operationID: journalStageActorUUID(52),
      expectedFence: 0,
      secret: SecretBytes(Data("other-connection".utf8))
    )
    #expect(independent.connectionID == otherConnection)

    await journal.releaseOne(at: .compareAndSwapBeforeSideEffect)
    _ = try await first.value
  }

  @Test
  func definiteFirstCASFailureErasesAndConsumesNoAuthority() async throws {
    let fixture = try JournalStageActorFixture()
    let journal = try InMemoryBrokerJournalStore()
    await journal.failNext(.storageUnavailable, at: .compareAndSwapBeforeSideEffect)
    let store = InMemoryCredentialStore()
    let harness = try await fixture.harness(store: store, journal: journal)
    let alias = UncheckedSecretAlias(SecretBytes(Data("first-cas-definite".utf8)))

    await expectJournalStageError(.storeUnavailable) {
      try await harness.state.stage(
        connectionID: fixture.connectionID,
        operationID: fixture.operationID,
        expectedFence: 0,
        secret: alias.value
      )
    }

    #expect(alias.isErased())
    #expect(try await journal.load(connectionID: fixture.connectionID) == nil)
    #expect((await store.inspection()).storeCallCounts.isEmpty)
    #expect(await harness.state.projection(for: fixture.connectionID) == nil)
  }

  @Test
  func staleAuthenticationTagCannotAuthorizePausedResolutionRetry() async throws {
    let fixture = try JournalStageActorFixture()
    let journal = try InMemoryBrokerJournalStore()
    let store = InMemoryCredentialStore()
    await store.pauseNext(at: .storeAfterSideEffect)
    let harness = try await fixture.harness(store: store, journal: journal)
    let operation = Task {
      try await harness.state.stage(
        connectionID: fixture.connectionID,
        operationID: fixture.operationID,
        expectedFence: 0,
        secret: SecretBytes(Data("stale-resolution-tag".utf8))
      )
    }
    await store.waitUntilPaused(at: .storeAfterSideEffect)
    await journal.failNext(.storageUnavailable, at: .compareAndSwapBeforeSideEffect)
    await journal.failNext(.storageUnavailable, at: .compareAndSwapBeforeSideEffect)
    await store.releaseOne(at: .storeAfterSideEffect)
    await expectJournalStageTaskError(.cleanupPending, operation)

    let selected = try #require(try await journal.load(connectionID: fixture.connectionID))
    let stale = BrokerJournalSnapshot(
      record: selected.record,
      authenticationTag: try JournalAuthenticationTag(bytes: Array(repeating: 0xfe, count: 32))
    )
    await journal.replaceExternally(stale)

    await expectJournalStageError(.cleanupPending) {
      try await harness.state.resumeStage(
        connectionID: fixture.connectionID,
        operationID: fixture.operationID,
        expectedFence: 0
      )
    }
    #expect(await store.retainedCount() == 1)
    #expect((try await journal.load(connectionID: fixture.connectionID)) == stale)
  }

  @Test
  func cancellationDuringStoreCleansPossibleSideEffectAndPersistsCancelledResult() async throws {
    let fixture = try JournalStageActorFixture()
    let journal = try InMemoryBrokerJournalStore()
    let store = InMemoryCredentialStore()
    await store.pauseNext(at: .storeBeforeSideEffect)
    let harness = try await fixture.harness(store: store, journal: journal)
    let operation = Task {
      try await harness.state.stage(
        connectionID: fixture.connectionID,
        operationID: fixture.operationID,
        expectedFence: 0,
        secret: SecretBytes(Data("cancel-during-store".utf8))
      )
    }
    await store.waitUntilPaused(at: .storeBeforeSideEffect)
    operation.cancel()
    await store.releaseOne(at: .storeBeforeSideEffect)

    await expectJournalStageTaskError(.cancelled, operation)

    #expect(await store.retainedCount() == 0)
    let selected = try #require(try await journal.load(connectionID: fixture.connectionID))
    #expect(selected.record.phase == .vacant)
    guard case .stageFailure(let terminal) = selected.record.terminalOperations.last else {
      Issue.record("expected cancelled terminal")
      return
    }
    #expect(terminal.error == .cancelled)
  }

  @Test
  func invalidInitialTimestampFailsBeforeDurableAuthorityOrStoreOwnership() async throws {
    let fixture = try JournalStageActorFixture()
    let journal = try InMemoryBrokerJournalStore()
    let store = InMemoryCredentialStore()
    let harness = try await fixture.harness(
      store: store,
      journal: journal,
      dates: [Date(timeIntervalSince1970: .infinity)]
    )
    let alias = UncheckedSecretAlias(SecretBytes(Data("invalid-initial-clock".utf8)))

    await expectJournalStageError(.storeUnavailable) {
      try await harness.state.stage(
        connectionID: fixture.connectionID,
        operationID: fixture.operationID,
        expectedFence: 0,
        secret: alias.value
      )
    }

    #expect(alias.isErased())
    #expect(try await journal.load(connectionID: fixture.connectionID) == nil)
    #expect((await store.inspection()).storeCallCounts.isEmpty)
    #expect(await harness.state.projection(for: fixture.connectionID) == nil)
  }
}

private struct JournalStageActorFixture {
  static let severeJournalErrors: [BrokerJournalError] = [
    .invalidRecord,
    .nonCanonical,
    .unsupportedVersion,
    .authenticationFailed,
    .rollbackDetected,
  ]

  let connectionID = journalStageActorUUID(1)
  let operationID = journalStageActorUUID(2)
  let generationID = journalStageActorUUID(3)
  let attemptID = journalStageActorUUID(4)
  let firstDate: Date
  let secondDate: Date

  init() throws {
    firstDate = try JournalTimestamp(
      canonicalText: "2026-07-13T01:00:00.000Z"
    ).date
    secondDate = try JournalTimestamp(
      canonicalText: "2026-07-13T01:00:01.000Z"
    ).date
  }

  func harness(
    store: any CredentialStore,
    journal: any BrokerJournalStore,
    dates: [Date]? = nil
  ) async throws -> JournalStageActorHarness {
    let generationIDs = LockedSequence([
      generationID,
      journalStageActorUUID(30),
      journalStageActorUUID(31),
    ])
    let attemptIDs = LockedSequence([
      attemptID,
      journalStageActorUUID(40),
      journalStageActorUUID(41),
    ])
    let clock = LockedSequence(
      dates
        ?? (0..<16).map { offset in
          secondDate.addingTimeInterval(Double(offset))
        }
    )
    let state = try await BrokerCredentialState.recoveringForTests(
      store: store,
      journal: journal,
      clock: clock.next,
      generationIDSource: generationIDs.next,
      attemptIDSource: attemptIDs.next
    )
    return JournalStageActorHarness(
      state: state,
      generationIDs: generationIDs,
      attemptIDs: attemptIDs,
      clock: clock
    )
  }

  func readySnapshot() throws -> BrokerJournalSnapshot {
    let generation = BrokerJournalCredentialGeneration(
      generationID: journalStageActorUUID(60),
      ordinal: 1,
      createdAt: try JournalTimestamp(date: firstDate)
    )
    let record = try BrokerJournalRecord(
      revision: 1,
      connectionID: connectionID,
      fence: 1,
      lastGenerationOrdinal: 1,
      changedAt: try JournalTimestamp(date: firstDate),
      payload: .ready(
        BrokerJournalReadyPayload(
          ready: BrokerJournalReadyGeneration(
            generation: generation,
            committedAt: try JournalTimestamp(date: firstDate)
          )
        )
      )
    )
    return BrokerJournalSnapshot(
      record: record,
      authenticationTag: try JournalAuthenticationTag(bytes: Array(repeating: 0x60, count: 32))
    )
  }

  func withDifferentTag(
    _ snapshot: BrokerJournalSnapshot
  ) throws -> BrokerJournalSnapshot {
    BrokerJournalSnapshot(
      record: snapshot.record,
      authenticationTag: try JournalAuthenticationTag(bytes: Array(repeating: 0xef, count: 32))
    )
  }
}

private struct JournalStageActorHarness {
  let state: BrokerCredentialState
  let generationIDs: LockedSequence<UUID>
  let attemptIDs: LockedSequence<UUID>
  let clock: LockedSequence<Date>
}

private func journalStageActorUUID(_ value: UInt64) -> UUID {
  UUID(
    uuidString: String(
      format: "00000000-0000-4000-8000-%012llx",
      value
    )
  )!
}

private func journalStageStoreKey(
  _ connectionID: UUID,
  _ generation: CredentialGeneration
) -> CredentialStoreKey {
  CredentialStoreKey(
    connectionID: connectionID,
    generationID: generation.generationID,
    generationOrdinal: generation.ordinal
  )
}

private func expectJournalStageError<Value>(
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

private func expectJournalStageTaskError<Value>(
  _ expected: BrokerStateError,
  _ task: Task<Value, any Error>
) async {
  do {
    _ = try await task.value
    Issue.record("Expected broker error \(expected).")
  } catch let error as BrokerStateError {
    #expect(error == expected)
  } catch {
    Issue.record("Unexpected error type: \(String(reflecting: error))")
  }
}

private func expectJournalStageJournalError<Value>(
  _ expected: BrokerJournalError,
  _ operation: () async throws -> Value
) async {
  do {
    _ = try await operation()
    Issue.record("Expected journal error \(expected).")
  } catch let error as BrokerJournalError {
    #expect(error == expected)
  } catch {
    Issue.record("Unexpected error type: \(String(reflecting: error))")
  }
}
