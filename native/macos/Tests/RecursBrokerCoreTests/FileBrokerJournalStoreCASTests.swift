import Foundation
import Testing

@testable import RecursBrokerCore

@Suite("File broker journal store CAS")
struct FileBrokerJournalStoreCASTests {
  @Test
  func reconciliationAcceptsOnlyTheExactIntendedAuthenticationTag() async throws {
    let fixture = try await createdFixture(id: 49)
    let exactFixture = try await createdFixture(id: 50)

    #expect(
      try await fixture.store.reconcileCompareAndSwap(
        expected: fixture.current,
        replacement: fixture.staging
      ) == .expected
    )
    let exactSelected = try await exactFixture.store.compareAndSwap(
      expected: exactFixture.current,
      replacement: exactFixture.staging
    )
    #expect(
      try await exactFixture.store.reconcileCompareAndSwap(
        expected: exactFixture.current,
        replacement: exactFixture.staging
      ) == .replacement(exactSelected)
    )

    let alternatePreviousTag = try tag(byte: 0xa9)
    let alternateTag = try await fixture.authenticator.authenticate(
      previousTag: alternatePreviousTag,
      canonicalRecord: BrokerJournalCodec.canonicalRecordData(for: fixture.staging)
    )
    fixture.backend.replaceFile(
      fixture.stagingPath,
      data: try BrokerJournalCodec.encode(
        BrokerJournalEnvelope(
          previousAuthTag: alternatePreviousTag,
          authTag: alternateTag,
          record: fixture.staging
        )
      )
    )
    try await fixture.authenticator.compareAndSwapAnchor(
      expected: fixture.currentAnchor,
      replacement: BrokerJournalAnchor(
        connectionID: fixture.staging.connectionID,
        revision: fixture.staging.revision,
        authenticationTag: alternateTag
      )
    )

    #expect(
      try await fixture.store.reconcileCompareAndSwap(
        expected: fixture.current,
        replacement: fixture.staging
      ) == .unrelated
    )
  }

  @Test
  func unknownAnchorCASWithoutSideEffectCollapsesToDefiniteStorageFailure() async throws {
    let fixture = try await createdFixture(id: 48)
    let anchorCASCalls = await fixture.authenticator.anchorCASCount()
    await fixture.authenticator.failNext(at: .compareAndSwapUnknownBeforeSideEffect)

    await #expect(throws: BrokerJournalError.storageUnavailable) {
      _ = try await fixture.store.compareAndSwap(
        expected: fixture.current,
        replacement: fixture.staging
      )
    }

    #expect(
      try await fixture.authenticator.anchor(for: fixture.pending.connectionID)
        == fixture.currentAnchor
    )
    #expect(await fixture.authenticator.anchorCASCount() == anchorCASCalls + 1)
    #expect(
      try await fixture.store.load(connectionID: fixture.pending.connectionID)
        == fixture.current
    )
  }

  @Test
  func authorityAdvanceDuringAuthenticateCannotOverwriteCompetingSelectedSlot() async throws {
    let fixture = try await createdFixture(id: 46)
    let competitor = try stagingRecord(
      from: fixture.pending,
      revision: 2,
      changedAt: JournalTimestamp(canonicalText: "2026-07-13T00:00:00.001Z")
    )
    let signer = DeterministicBrokerJournalAuthenticator()
    let competitorTag = try await signer.authenticate(
      previousTag: fixture.current.authenticationTag,
      canonicalRecord: BrokerJournalCodec.canonicalRecordData(for: competitor)
    )
    let competitorEnvelope = try BrokerJournalCodec.encode(
      BrokerJournalEnvelope(
        previousAuthTag: fixture.current.authenticationTag,
        authTag: competitorTag,
        record: competitor
      )
    )
    let competitorAnchor = try BrokerJournalAnchor(
      connectionID: competitor.connectionID,
      revision: competitor.revision,
      authenticationTag: competitorTag
    )
    let competitorSnapshot = BrokerJournalSnapshot(
      record: competitor,
      authenticationTag: competitorTag
    )
    let writeCalls = fixture.backend.calls.filter { $0 == .write }.count
    let renameCalls = fixture.backend.renamedPairs.count
    await fixture.authenticator.pauseNext(at: .authenticateBeforeReturn)
    let operation = Task {
      try await fixture.store.compareAndSwap(
        expected: fixture.current,
        replacement: fixture.staging
      )
    }
    await fixture.authenticator.waitUntilPaused(at: .authenticateBeforeReturn)
    fixture.backend.replaceFile(fixture.stagingPath, data: competitorEnvelope)
    try await fixture.authenticator.compareAndSwapAnchor(
      expected: fixture.currentAnchor,
      replacement: competitorAnchor
    )
    await fixture.authenticator.releaseOne(at: .authenticateBeforeReturn)

    await #expect(throws: BrokerJournalError.casConflict) {
      _ = try await operation.value
    }

    #expect(fixture.backend.calls.filter { $0 == .write }.count == writeCalls)
    #expect(fixture.backend.renamedPairs.count == renameCalls)
    #expect(
      try await fixture.store.load(connectionID: competitor.connectionID)
        == competitorSnapshot
    )
  }

  @Test
  func missingIntendedSlotAfterAnchorCASIsRepairedFromRetainedEnvelope() async throws {
    let fixture = try await createdFixture(id: 39)
    await fixture.authenticator.pauseNext(at: .compareAndSwapAfterSideEffect)
    await fixture.authenticator.failNext(at: .compareAndSwapAfterSideEffect)
    let operation = Task {
      try await fixture.store.compareAndSwap(
        expected: fixture.current,
        replacement: fixture.staging
      )
    }
    await fixture.authenticator.waitUntilPaused(at: .compareAndSwapAfterSideEffect)
    try fixture.backend.unlink(
      at: fixture.backend.finalJournalDescriptor,
      basename: fixture.stagingBasename
    )
    await fixture.authenticator.releaseOne(at: .compareAndSwapAfterSideEffect)

    let result = try await operation.value

    #expect(result.record == fixture.staging)
    #expect(try await fixture.store.load(connectionID: fixture.pending.connectionID) == result)
    let repaired = try BrokerJournalCodec.decode(
      try #require(fixture.backend.node(fixture.stagingPath)?.content)
    )
    #expect(repaired.record == fixture.staging)
    #expect(repaired.previousAuthTag == fixture.current.authenticationTag)
  }

  @Test
  func corruptIntendedSlotAfterAnchorCASIsRepairedFromRetainedEnvelope() async throws {
    let fixture = try await createdFixture(id: 41)
    await fixture.authenticator.pauseNext(at: .compareAndSwapAfterSideEffect)
    await fixture.authenticator.failNext(at: .compareAndSwapAfterSideEffect)
    let operation = Task {
      try await fixture.store.compareAndSwap(
        expected: fixture.current,
        replacement: fixture.staging
      )
    }
    await fixture.authenticator.waitUntilPaused(at: .compareAndSwapAfterSideEffect)
    fixture.backend.node(fixture.stagingPath)?.content = Data([0xff])
    await fixture.authenticator.releaseOne(at: .compareAndSwapAfterSideEffect)

    let result = try await operation.value

    #expect(result.record == fixture.staging)
    #expect(try await fixture.store.load(connectionID: fixture.pending.connectionID) == result)
    let repaired = try BrokerJournalCodec.decode(
      try #require(fixture.backend.node(fixture.stagingPath)?.content)
    )
    #expect(repaired.record == fixture.staging)
    #expect(repaired.previousAuthTag == fixture.current.authenticationTag)
  }

  @Test
  func repairFullSyncUncertaintyWithSelectedBytesAbsentReturnsUnknown() async throws {
    let fixture = try await createdFixture(id: 42)
    let anchorCASCalls = await fixture.authenticator.anchorCASCount()
    await fixture.authenticator.pauseNext(at: .compareAndSwapAfterSideEffect)
    await fixture.authenticator.failNext(at: .compareAndSwapAfterSideEffect)
    let operation = Task {
      try await fixture.store.compareAndSwap(
        expected: fixture.current,
        replacement: fixture.staging
      )
    }
    await fixture.authenticator.waitUntilPaused(at: .compareAndSwapAfterSideEffect)
    let intendedEnvelope = try BrokerJournalCodec.decode(
      try #require(fixture.backend.node(fixture.stagingPath)?.content)
    )
    let intendedAnchor = try BrokerJournalAnchor(
      connectionID: fixture.staging.connectionID,
      revision: fixture.staging.revision,
      authenticationTag: intendedEnvelope.authTag
    )
    try fixture.backend.unlink(
      at: fixture.backend.finalJournalDescriptor,
      basename: fixture.stagingBasename
    )
    fixture.backend.failNext(.fullSync, with: .durabilityUnknown)
    await fixture.authenticator.releaseOne(at: .compareAndSwapAfterSideEffect)

    await #expect(throws: BrokerJournalError.mutationOutcomeUnknown) {
      _ = try await operation.value
    }

    #expect(
      try await fixture.authenticator.anchor(for: fixture.staging.connectionID)
        == intendedAnchor
    )
    #expect(await fixture.authenticator.anchorCASCount() == anchorCASCalls + 1)
    #expect(fixture.backend.node(fixture.stagingPath) == nil)
  }

  @Test
  func repairDirectorySyncUncertaintyWithExactSelectedBytesSucceeds() async throws {
    let fixture = try await createdFixture(id: 43)
    let anchorCASCalls = await fixture.authenticator.anchorCASCount()
    await fixture.authenticator.pauseNext(at: .compareAndSwapAfterSideEffect)
    await fixture.authenticator.failNext(at: .compareAndSwapAfterSideEffect)
    let operation = Task {
      try await fixture.store.compareAndSwap(
        expected: fixture.current,
        replacement: fixture.staging
      )
    }
    await fixture.authenticator.waitUntilPaused(at: .compareAndSwapAfterSideEffect)
    try fixture.backend.unlink(
      at: fixture.backend.finalJournalDescriptor,
      basename: fixture.stagingBasename
    )
    fixture.backend.failNext(.directorySync, with: .unavailable)
    await fixture.authenticator.releaseOne(at: .compareAndSwapAfterSideEffect)

    let result = try await operation.value

    #expect(result.record == fixture.staging)
    #expect(await fixture.authenticator.anchorCASCount() == anchorCASCalls + 1)
    #expect(try await fixture.store.load(connectionID: fixture.staging.connectionID) == result)
    let repaired = try BrokerJournalCodec.decode(
      try #require(fixture.backend.node(fixture.stagingPath)?.content)
    )
    #expect(repaired.record == fixture.staging)
    #expect(repaired.authTag == result.authenticationTag)
  }

  @Test
  func externalAnchorAdvanceDuringFinalRepairVerificationPreventsStaleSuccess() async throws {
    let fixture = try await createdFixture(id: 44)
    await fixture.authenticator.pauseNext(at: .compareAndSwapAfterSideEffect)
    await fixture.authenticator.failNext(at: .compareAndSwapAfterSideEffect)
    let operation = Task {
      try await fixture.store.compareAndSwap(
        expected: fixture.current,
        replacement: fixture.staging
      )
    }
    await fixture.authenticator.waitUntilPaused(at: .compareAndSwapAfterSideEffect)
    let intendedEnvelope = try BrokerJournalCodec.decode(
      try #require(fixture.backend.node(fixture.stagingPath)?.content)
    )
    let intendedAnchor = try BrokerJournalAnchor(
      connectionID: fixture.staging.connectionID,
      revision: fixture.staging.revision,
      authenticationTag: intendedEnvelope.authTag
    )
    fixture.backend.node(fixture.stagingPath)?.content = Data([0xff])
    await fixture.authenticator.pauseNext(at: .verifyBeforeReturn)
    await fixture.authenticator.releaseOne(at: .compareAndSwapAfterSideEffect)
    await fixture.authenticator.waitUntilPaused(at: .verifyBeforeReturn)
    let competingAnchor = try BrokerJournalAnchor(
      connectionID: fixture.staging.connectionID,
      revision: fixture.staging.revision + 1,
      authenticationTag: try tag(byte: 0xdd)
    )
    try await fixture.authenticator.compareAndSwapAnchor(
      expected: intendedAnchor,
      replacement: competingAnchor
    )
    await fixture.authenticator.releaseOne(at: .verifyBeforeReturn)

    await #expect(throws: BrokerJournalError.mutationOutcomeUnknown) {
      _ = try await operation.value
    }

    #expect(
      try await fixture.authenticator.anchor(for: fixture.staging.connectionID)
        == competingAnchor
    )
  }

  @Test
  func externalAnchorAdvanceDuringPreviousVerificationPreventsDefiniteStorageResult() async throws {
    let fixture = try await createdFixture(id: 45)
    await fixture.authenticator.pauseNext(at: .compareAndSwapBeforeSideEffect)
    await fixture.authenticator.failNext(at: .compareAndSwapBeforeSideEffect)
    let operation = Task {
      try await fixture.store.compareAndSwap(
        expected: fixture.current,
        replacement: fixture.staging
      )
    }
    await fixture.authenticator.waitUntilPaused(at: .compareAndSwapBeforeSideEffect)
    await fixture.authenticator.pauseNext(at: .verifyBeforeReturn)
    await fixture.authenticator.releaseOne(at: .compareAndSwapBeforeSideEffect)
    await fixture.authenticator.waitUntilPaused(at: .verifyBeforeReturn)
    let competingAnchor = try BrokerJournalAnchor(
      connectionID: fixture.staging.connectionID,
      revision: fixture.staging.revision,
      authenticationTag: try tag(byte: 0xde)
    )
    try await fixture.authenticator.compareAndSwapAnchor(
      expected: fixture.currentAnchor,
      replacement: competingAnchor
    )
    await fixture.authenticator.releaseOne(at: .verifyBeforeReturn)

    await #expect(throws: BrokerJournalError.mutationOutcomeUnknown) {
      _ = try await operation.value
    }

    #expect(
      try await fixture.authenticator.anchor(for: fixture.staging.connectionID)
        == competingAnchor
    )
  }

  @Test
  func intendedAnchorAdvanceDuringPreviousVerificationRedispatchesToSuccess() async throws {
    let fixture = try await createdFixture(id: 47)
    await fixture.authenticator.pauseNext(at: .compareAndSwapBeforeSideEffect)
    await fixture.authenticator.failNext(at: .compareAndSwapBeforeSideEffect)
    let operation = Task {
      try await fixture.store.compareAndSwap(
        expected: fixture.current,
        replacement: fixture.staging
      )
    }
    await fixture.authenticator.waitUntilPaused(at: .compareAndSwapBeforeSideEffect)
    let intendedEnvelope = try BrokerJournalCodec.decode(
      try #require(fixture.backend.node(fixture.stagingPath)?.content)
    )
    let intendedAnchor = try BrokerJournalAnchor(
      connectionID: fixture.staging.connectionID,
      revision: fixture.staging.revision,
      authenticationTag: intendedEnvelope.authTag
    )
    await fixture.authenticator.pauseNext(at: .verifyBeforeReturn)
    await fixture.authenticator.releaseOne(at: .compareAndSwapBeforeSideEffect)
    await fixture.authenticator.waitUntilPaused(at: .verifyBeforeReturn)
    try await fixture.authenticator.compareAndSwapAnchor(
      expected: fixture.currentAnchor,
      replacement: intendedAnchor
    )
    await fixture.authenticator.releaseOne(at: .verifyBeforeReturn)

    let result = try await operation.value

    #expect(result.record == fixture.staging)
    #expect(result.authenticationTag == intendedEnvelope.authTag)
    #expect(try await fixture.store.load(connectionID: fixture.staging.connectionID) == result)
  }

  @Test
  func preRenameFullSyncUncertaintyLeavesAbsentAuthorityAndSkipsAnchorCAS() async throws {
    let backend = ScriptedDarwinFileSystemBackend()
    let authenticator = DeterministicBrokerJournalAuthenticator()
    let store = try FileBrokerJournalStore.open(
      directory: openedDirectory(backend),
      authenticator: authenticator
    )
    let replacement = try initialStorePending(connectionID: uuid(35))
    backend.failNext(.fullSync, with: .durabilityUnknown)

    await #expect(throws: BrokerJournalError.storageUnavailable) {
      _ = try await store.compareAndSwap(expected: nil, replacement: replacement)
    }

    #expect(try await authenticator.anchor(for: replacement.connectionID) == nil)
    #expect(await authenticator.anchorCASCount() == 0)
    #expect(try await store.load(connectionID: replacement.connectionID) == nil)
  }

  @Test
  func postRenameDirectorySyncUncertaintyLeavesValidSuccessorInert() async throws {
    let fixture = try await createdFixture(id: 36)
    let anchorCASCalls = await fixture.authenticator.anchorCASCount()
    fixture.backend.failNext(.directorySync, with: .unavailable)

    await #expect(throws: BrokerJournalError.storageUnavailable) {
      _ = try await fixture.store.compareAndSwap(
        expected: fixture.current,
        replacement: fixture.staging
      )
    }

    #expect(
      try await fixture.authenticator.anchor(for: fixture.pending.connectionID)
        == fixture.currentAnchor
    )
    #expect(await fixture.authenticator.anchorCASCount() == anchorCASCalls)
    #expect(
      try await fixture.store.load(connectionID: fixture.pending.connectionID)
        == fixture.current
    )
    #expect(try await fixture.store.list() == [fixture.current])
    let inactive = try BrokerJournalCodec.decode(
      try #require(fixture.backend.node(fixture.stagingPath)?.content)
    )
    #expect(inactive.record == fixture.staging)
    #expect(inactive.previousAuthTag == fixture.current.authenticationTag)
  }

  @Test
  func anchorCASFailureBeforeSideEffectLeavesInactiveSuccessorUnselected() async throws {
    let fixture = try await createdFixture(id: 40)
    await fixture.authenticator.failNext(at: .compareAndSwapBeforeSideEffect)

    await #expect(throws: BrokerJournalError.storageUnavailable) {
      _ = try await fixture.store.compareAndSwap(
        expected: fixture.current,
        replacement: fixture.staging
      )
    }

    #expect(
      try await fixture.authenticator.anchor(for: fixture.pending.connectionID)
        == fixture.currentAnchor
    )
    #expect(
      try await fixture.store.load(connectionID: fixture.pending.connectionID)
        == fixture.current
    )
    let inactive = try BrokerJournalCodec.decode(
      try #require(fixture.backend.node(fixture.stagingPath)?.content)
    )
    #expect(inactive.record == fixture.staging)
    #expect(inactive.previousAuthTag == fixture.current.authenticationTag)
  }

  @Test
  func anchorCASFailureAfterSideEffectReconcilesIntendedSuccess() async throws {
    let fixture = try await createdFixture(id: 50)
    await fixture.authenticator.failNext(at: .compareAndSwapAfterSideEffect)

    let result = try await fixture.store.compareAndSwap(
      expected: fixture.current,
      replacement: fixture.staging
    )

    #expect(result.record == fixture.staging)
    #expect(try await fixture.store.load(connectionID: fixture.pending.connectionID) == result)
  }

  @Test
  func competingExternalAnchorDuringPausedCASRemainsSelectedAndReturnsConflict() async throws {
    let fixture = try await createdFixture(id: 60)
    await fixture.authenticator.pauseNext(at: .compareAndSwapBeforeSideEffect)
    let operation = Task {
      try await fixture.store.compareAndSwap(
        expected: fixture.current,
        replacement: fixture.staging
      )
    }
    await fixture.authenticator.waitUntilPaused(at: .compareAndSwapBeforeSideEffect)
    let competingAnchor = try BrokerJournalAnchor(
      connectionID: fixture.pending.connectionID,
      revision: fixture.staging.revision,
      authenticationTag: try tag(byte: 0xcc)
    )
    try await fixture.authenticator.compareAndSwapAnchor(
      expected: fixture.currentAnchor,
      replacement: competingAnchor
    )
    await fixture.authenticator.releaseOne(at: .compareAndSwapBeforeSideEffect)

    await #expect(throws: BrokerJournalError.casConflict) {
      _ = try await operation.value
    }
    #expect(
      try await fixture.authenticator.anchor(for: fixture.pending.connectionID)
        == competingAnchor
    )
  }

  @Test
  func transientPostCASAnchorLookupFailureReconcilesIntendedSuccess() async throws {
    let fixture = try await createdFixture(id: 70)
    await fixture.authenticator.pauseNext(at: .compareAndSwapAfterSideEffect)
    let operation = Task {
      try await fixture.store.compareAndSwap(
        expected: fixture.current,
        replacement: fixture.staging
      )
    }
    await fixture.authenticator.waitUntilPaused(at: .compareAndSwapAfterSideEffect)
    await fixture.authenticator.failNext(at: .anchorLookupBeforeReturn)
    await fixture.authenticator.releaseOne(at: .compareAndSwapAfterSideEffect)

    let result = try await operation.value
    #expect(result.record == fixture.staging)
    #expect(try await fixture.store.load(connectionID: fixture.pending.connectionID) == result)
  }

  @Test
  func storePendingUpdatesToStagingInEvenSlotWithExactPreviousTag() async throws {
    let backend = ScriptedDarwinFileSystemBackend()
    let directory = try openedDirectory(backend)
    let authenticator = DeterministicBrokerJournalAuthenticator()
    let store = try FileBrokerJournalStore.open(
      directory: directory,
      authenticator: authenticator
    )
    let pending = try initialStorePending(connectionID: uuid(10))
    let pendingSnapshot = try await store.compareAndSwap(expected: nil, replacement: pending)
    let staging = try stagingRecord(from: pending, revision: 2)

    let stagingSnapshot = try await store.compareAndSwap(
      expected: pendingSnapshot,
      replacement: staging
    )

    let oddBasename = "\(pending.connectionID.uuidString.lowercased()).1.rcbj"
    let evenBasename = "\(pending.connectionID.uuidString.lowercased()).0.rcbj"
    let odd = try BrokerJournalCodec.decode(
      try #require(backend.node("\(journalPath)/\(oddBasename)")?.content)
    )
    let even = try BrokerJournalCodec.decode(
      try #require(backend.node("\(journalPath)/\(evenBasename)")?.content)
    )
    #expect(odd.record == pending)
    #expect(even.previousAuthTag == pendingSnapshot.authenticationTag)
    #expect(even.record == staging)
    #expect(even.authTag == stagingSnapshot.authenticationTag)
    #expect(try await store.load(connectionID: pending.connectionID) == stagingSnapshot)
    #expect(try await store.list() == [stagingSnapshot])
    #expect(await authenticator.authenticateCount() == 2)
    #expect(await authenticator.anchorCASCount() == 2)
  }

  @Test
  func invalidCASInputsStopBeforeAuthenticationWriteOrAnchorCAS() async throws {
    let backend = ScriptedDarwinFileSystemBackend()
    let directory = try openedDirectory(backend)
    let authenticator = DeterministicBrokerJournalAuthenticator()
    let store = try FileBrokerJournalStore.open(
      directory: directory,
      authenticator: authenticator
    )
    let pending = try initialStorePending(connectionID: uuid(20))
    let current = try await store.compareAndSwap(expected: nil, replacement: pending)
    let validStaging = try stagingRecord(from: pending, revision: 2)
    let wrongExpected = BrokerJournalSnapshot(
      record: current.record,
      authenticationTag: try tag(byte: 0xee)
    )
    let wrongConnection = try stagingRecord(
      from: pending,
      revision: 2,
      connectionID: uuid(21)
    )
    let wrongRevision = try stagingRecord(from: pending, revision: 3)
    let disallowedPhase = try storePendingRecord(from: pending, revision: 2)
    let authenticateCalls = await authenticator.authenticateCount()
    let anchorCASCalls = await authenticator.anchorCASCount()
    let createCalls = backend.calls.filter { $0 == .createFile }.count
    let writeCalls = backend.calls.filter { $0 == .write }.count
    let renameCalls = backend.renamedPairs.count

    let hostileCases: [(BrokerJournalSnapshot, BrokerJournalRecord)] = [
      (wrongExpected, validStaging),
      (current, wrongConnection),
      (current, wrongRevision),
      (current, disallowedPhase),
    ]
    for hostile in hostileCases {
      await #expect(throws: BrokerJournalError.casConflict) {
        _ = try await store.compareAndSwap(
          expected: hostile.0,
          replacement: hostile.1
        )
      }
      #expect(await authenticator.authenticateCount() == authenticateCalls)
      #expect(await authenticator.anchorCASCount() == anchorCASCalls)
      #expect(backend.calls.filter { $0 == .createFile }.count == createCalls)
      #expect(backend.calls.filter { $0 == .write }.count == writeCalls)
      #expect(backend.renamedPairs.count == renameCalls)
    }
    #expect(try await store.load(connectionID: pending.connectionID) == current)
  }

  @Test
  func currentMaximumRevisionRejectsBeforeAuthenticationWriteOrAnchorCAS() async throws {
    let backend = ScriptedDarwinFileSystemBackend()
    let directory = try openedDirectory(backend)
    let maximum = try initialStorePending(connectionID: uuid(30), revision: .max)
    let previousTag = try tag(byte: 7)
    let signer = DeterministicBrokerJournalAuthenticator()
    let authenticationTag = try await signer.authenticate(
      previousTag: previousTag,
      canonicalRecord: BrokerJournalCodec.canonicalRecordData(for: maximum)
    )
    let anchor = try BrokerJournalAnchor(
      connectionID: maximum.connectionID,
      revision: maximum.revision,
      authenticationTag: authenticationTag
    )
    let authenticator = DeterministicBrokerJournalAuthenticator(anchors: [anchor])
    let current = BrokerJournalSnapshot(
      record: maximum,
      authenticationTag: authenticationTag
    )
    backend.addFile(
      "\(journalPath)/\(maximum.connectionID.uuidString.lowercased()).1.rcbj",
      data: try BrokerJournalCodec.encode(
        BrokerJournalEnvelope(
          previousAuthTag: previousTag,
          authTag: authenticationTag,
          record: maximum
        )
      )
    )
    let store = try FileBrokerJournalStore.open(
      directory: directory,
      authenticator: authenticator
    )
    let impossible = try stagingRecord(from: maximum, revision: 1)
    let authenticateCalls = await authenticator.authenticateCount()
    let anchorCASCalls = await authenticator.anchorCASCount()
    let createCalls = backend.calls.filter { $0 == .createFile }.count

    await #expect(throws: BrokerJournalError.revisionOverflow) {
      _ = try await store.compareAndSwap(expected: current, replacement: impossible)
    }
    #expect(await authenticator.authenticateCount() == authenticateCalls)
    #expect(await authenticator.anchorCASCount() == anchorCASCalls)
    #expect(backend.calls.filter { $0 == .createFile }.count == createCalls)
    #expect(try await store.load(connectionID: maximum.connectionID) == current)
  }

  @Test
  func absentAuthorityCreatesInitialStorePendingInOddSlot() async throws {
    let backend = ScriptedDarwinFileSystemBackend()
    let directory = try openedDirectory(backend)
    let authenticator = DeterministicBrokerJournalAuthenticator()
    let store = try FileBrokerJournalStore.open(
      directory: directory,
      authenticator: authenticator
    )
    let replacement = try initialStorePending(connectionID: uuid(1))

    let snapshot = try await store.compareAndSwap(
      expected: nil,
      replacement: replacement
    )

    #expect(snapshot.record == replacement)
    let oddBasename = "\(replacement.connectionID.uuidString.lowercased()).1.rcbj"
    let evenBasename = "\(replacement.connectionID.uuidString.lowercased()).0.rcbj"
    let oddData = try #require(backend.node("\(journalPath)/\(oddBasename)")?.content)
    #expect(backend.node("\(journalPath)/\(evenBasename)") == nil)
    let envelope = try BrokerJournalCodec.decode(oddData)
    #expect(envelope.previousAuthTag == .zero)
    #expect(envelope.authTag == snapshot.authenticationTag)
    #expect(envelope.record == replacement)
    let intendedAnchor = try BrokerJournalAnchor(
      connectionID: replacement.connectionID,
      revision: replacement.revision,
      authenticationTag: snapshot.authenticationTag
    )
    #expect(try await authenticator.anchor(for: replacement.connectionID) == intendedAnchor)
    #expect(try await store.load(connectionID: replacement.connectionID) == snapshot)
    #expect(try await store.list() == [snapshot])

    let protocolStore: any BrokerJournalStore = store
    #expect(try await protocolStore.load(connectionID: replacement.connectionID) == snapshot)
  }

  private var journalPath: String {
    "Library/Application Support/com.recurs.cli/broker/journal-v1"
  }

  private struct CreatedFixture {
    let backend: ScriptedDarwinFileSystemBackend
    let authenticator: DeterministicBrokerJournalAuthenticator
    let store: FileBrokerJournalStore
    let pending: BrokerJournalRecord
    let current: BrokerJournalSnapshot
    let currentAnchor: BrokerJournalAnchor
    let staging: BrokerJournalRecord

    var stagingPath: String {
      "\(journalPath)/\(stagingBasename)"
    }

    var stagingBasename: String {
      "\(pending.connectionID.uuidString.lowercased()).0.rcbj"
    }

    private var journalPath: String {
      "Library/Application Support/com.recurs.cli/broker/journal-v1"
    }
  }

  private func createdFixture(id: Int) async throws -> CreatedFixture {
    let backend = ScriptedDarwinFileSystemBackend()
    let authenticator = DeterministicBrokerJournalAuthenticator()
    let store = try FileBrokerJournalStore.open(
      directory: openedDirectory(backend),
      authenticator: authenticator
    )
    let pending = try initialStorePending(connectionID: uuid(id))
    let current = try await store.compareAndSwap(expected: nil, replacement: pending)
    return try CreatedFixture(
      backend: backend,
      authenticator: authenticator,
      store: store,
      pending: pending,
      current: current,
      currentAnchor: BrokerJournalAnchor(
        connectionID: pending.connectionID,
        revision: pending.revision,
        authenticationTag: current.authenticationTag
      ),
      staging: stagingRecord(from: pending, revision: 2)
    )
  }

  private func openedDirectory(
    _ backend: ScriptedDarwinFileSystemBackend
  ) throws -> SecureDirectory {
    try SecureDirectory.openJournalDirectory(
      trustedHomeDescriptor: backend.rootDescriptor,
      currentUID: backend.currentUID,
      backend: backend
    )
  }

  private func initialStorePending(
    connectionID: UUID,
    revision: UInt64 = 1
  ) throws -> BrokerJournalRecord {
    let timestamp = try JournalTimestamp(canonicalText: "2026-07-13T00:00:00.000Z")
    return try BrokerJournalRecord(
      revision: revision,
      connectionID: connectionID,
      fence: 1,
      lastGenerationOrdinal: 1,
      changedAt: timestamp,
      payload: .storePending(
        BrokerJournalStorePendingPayload(
          attemptID: uuid(2),
          operationID: uuid(3),
          expectedFence: 0,
          candidate: BrokerJournalCredentialGeneration(
            generationID: uuid(4),
            ordinal: 1,
            createdAt: timestamp
          ),
          previousReady: nil,
          startedAt: timestamp
        )
      )
    )
  }

  private func uuid(_ value: Int) -> UUID {
    UUID(uuidString: String(format: "00000000-0000-4000-8000-%012d", value))!
  }

  private func stagingRecord(
    from pending: BrokerJournalRecord,
    revision: UInt64,
    connectionID: UUID? = nil,
    changedAt: JournalTimestamp? = nil
  ) throws -> BrokerJournalRecord {
    guard case .storePending(let payload) = pending.payload else {
      throw BrokerJournalError.invalidRecord
    }
    return try BrokerJournalRecord(
      revision: revision,
      connectionID: connectionID ?? pending.connectionID,
      fence: pending.fence,
      lastGenerationOrdinal: pending.lastGenerationOrdinal,
      changedAt: changedAt ?? pending.changedAt,
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
      terminalOperations: pending.terminalOperations
    )
  }

  private func storePendingRecord(
    from pending: BrokerJournalRecord,
    revision: UInt64
  ) throws -> BrokerJournalRecord {
    guard case .storePending(let payload) = pending.payload else {
      throw BrokerJournalError.invalidRecord
    }
    return try BrokerJournalRecord(
      revision: revision,
      connectionID: pending.connectionID,
      fence: pending.fence,
      lastGenerationOrdinal: pending.lastGenerationOrdinal,
      changedAt: pending.changedAt,
      payload: .storePending(payload),
      terminalOperations: pending.terminalOperations
    )
  }

  private func tag(byte: UInt8) throws -> JournalAuthenticationTag {
    try JournalAuthenticationTag(
      bytes: [UInt8](repeating: byte, count: JournalAuthenticationTag.byteCount)
    )
  }
}
