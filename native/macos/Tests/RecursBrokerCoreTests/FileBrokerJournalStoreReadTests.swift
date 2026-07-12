import Foundation
import Testing

@testable import RecursBrokerCore

@Suite("File broker journal store read path")
struct FileBrokerJournalStoreReadTests {
  @Test
  func listEnumeratesEvenWhenAnchorsAreEmptyAndIgnoresOrphanSlots() async throws {
    let backend = ScriptedDarwinFileSystemBackend()
    let directory = try openedDirectory(backend)
    backend.addFile(
      "\(journalPath)/\(uuid(201).uuidString.lowercased()).0.rcbj",
      data: Data("untrusted-orphan".utf8)
    )
    let store = try FileBrokerJournalStore.open(
      directory: directory,
      authenticator: DeterministicBrokerJournalAuthenticator()
    )

    #expect(try await store.list().isEmpty)
    #expect(backend.calls.contains(.entries))
  }

  @Test
  func listReturnsUnsortedSuppliedAnchorsAsCanonicalSortedSnapshots() async throws {
    let backend = ScriptedDarwinFileSystemBackend()
    let directory = try openedDirectory(backend)
    let low = try await anchoredSlot(connectionID: uuid(202), revision: 1)
    let high = try await anchoredSlot(connectionID: uuid(203), revision: 2)
    install(low, in: backend)
    install(high, in: backend)
    backend.addFile(
      "\(journalPath)/\(high.anchor.connectionID.uuidString.lowercased()).1.rcbj",
      data: Data("inactive".utf8)
    )
    backend.addFile(
      "\(journalPath)/\(uuid(204).uuidString.lowercased()).0.rcbj",
      data: Data("unanchored".utf8)
    )
    let store = try FileBrokerJournalStore.open(
      directory: directory,
      authenticator: DeterministicBrokerJournalAuthenticator(anchors: [high.anchor, low.anchor])
    )

    #expect(
      try await store.list() == [
        BrokerJournalSnapshot(record: low.record, authenticationTag: low.anchor.authenticationTag),
        BrokerJournalSnapshot(
          record: high.record,
          authenticationTag: high.anchor.authenticationTag
        ),
      ]
    )
  }

  @Test
  func listRejectsUnexpectedDirectoryEntries() async throws {
    let backend = ScriptedDarwinFileSystemBackend()
    let directory = try openedDirectory(backend)
    backend.addFile("\(journalPath)/unexpected")
    let store = try FileBrokerJournalStore.open(
      directory: directory,
      authenticator: DeterministicBrokerJournalAuthenticator()
    )

    await #expect(throws: BrokerJournalError.storageUnavailable) {
      _ = try await store.list()
    }
  }

  @Test
  func listValidatesAllSelectedAuthorityBeforeRemovingTemporaries() async throws {
    let missingBackend = ScriptedDarwinFileSystemBackend()
    let missingDirectory = try openedDirectory(missingBackend)
    let missing = try await anchoredSlot(connectionID: uuid(205), revision: 1)
    let missingTemporary = temporaryBasename(205)
    missingBackend.addFile("\(journalPath)/\(missingTemporary)")
    let missingStore = try FileBrokerJournalStore.open(
      directory: missingDirectory,
      authenticator: DeterministicBrokerJournalAuthenticator(anchors: [missing.anchor])
    )
    await #expect(throws: BrokerJournalError.rollbackDetected) {
      _ = try await missingStore.list()
    }
    #expect(missingBackend.node("\(journalPath)/\(missingTemporary)") != nil)

    let mismatchBackend = ScriptedDarwinFileSystemBackend()
    let mismatchDirectory = try openedDirectory(mismatchBackend)
    let mismatch = try await anchoredSlot(
      connectionID: uuid(206),
      revision: 1,
      recordConnectionID: uuid(207)
    )
    install(mismatch, in: mismatchBackend)
    let mismatchTemporary = temporaryBasename(206)
    mismatchBackend.addFile("\(journalPath)/\(mismatchTemporary)")
    let mismatchStore = try FileBrokerJournalStore.open(
      directory: mismatchDirectory,
      authenticator: DeterministicBrokerJournalAuthenticator(anchors: [mismatch.anchor])
    )
    await #expect(throws: BrokerJournalError.rollbackDetected) {
      _ = try await mismatchStore.list()
    }
    #expect(mismatchBackend.node("\(journalPath)/\(mismatchTemporary)") != nil)
  }

  @Test
  func listRemovesVerifiedTemporariesOnlyAfterAllSnapshotsValidate() async throws {
    let backend = ScriptedDarwinFileSystemBackend()
    let directory = try openedDirectory(backend)
    let selected = try await anchoredSlot(connectionID: uuid(208), revision: 1)
    install(selected, in: backend)
    let temporary = temporaryBasename(208)
    backend.addFile("\(journalPath)/\(temporary)")
    let store = try FileBrokerJournalStore.open(
      directory: directory,
      authenticator: DeterministicBrokerJournalAuthenticator(anchors: [selected.anchor])
    )

    #expect(try await store.list().count == 1)
    #expect(backend.node("\(journalPath)/\(temporary)") == nil)
  }

  @Test
  func listRejectsDuplicateOverflowAndUnsortedAuthenticatorResults() async throws {
    let first = try await anchoredSlot(connectionID: uuid(209), revision: 1)
    let second = try await anchoredSlot(connectionID: uuid(210), revision: 1)
    let duplicate = try BrokerJournalAnchor(
      connectionID: first.anchor.connectionID,
      revision: 2,
      authenticationTag: second.anchor.authenticationTag
    )
    let overflow = try (0...SecureDirectory.maximumAnchoredConnections).map { index in
      try BrokerJournalAnchor(
        connectionID: UUID(
          uuidString: "00000000-0000-4000-8000-\(String(format: "%012llx", UInt64(index)))"
        )!,
        revision: 1,
        authenticationTag: .zero
      )
    }
    let hostileCases = [
      [first.anchor, duplicate],
      overflow,
      [second.anchor, first.anchor],
    ]
    for anchors in hostileCases {
      let backend = ScriptedDarwinFileSystemBackend()
      let store = try FileBrokerJournalStore.open(
        directory: openedDirectory(backend),
        authenticator: HostileListAuthenticator(anchors: anchors)
      )
      await #expect(throws: BrokerJournalError.rollbackDetected) {
        _ = try await store.list()
      }
      #expect(!backend.calls.contains(.entries))
    }
  }

  @Test
  func listSharesTheGateWithLoadAndReleasesItAfterErrors() async throws {
    let backend = ScriptedDarwinFileSystemBackend()
    let directory = try openedDirectory(backend)
    let authenticator = DeterministicBrokerJournalAuthenticator()
    let store = try FileBrokerJournalStore.open(
      directory: directory,
      authenticator: authenticator
    )
    let loadID = uuid(211)

    await authenticator.pauseNext(at: .anchorListBeforeReturn)
    let firstList = Task { try await store.list() }
    await authenticator.waitUntilPaused(at: .anchorListBeforeReturn)
    let load = Task { try await store.load(connectionID: loadID) }
    for _ in 0..<20 { await Task.yield() }
    let secondList = Task { try await store.list() }
    for _ in 0..<20 { await Task.yield() }

    #expect(await authenticator.anchorListCount() == 1)
    #expect(await authenticator.anchorLookupCount() == 0)
    await authenticator.releaseOne(at: .anchorListBeforeReturn)
    #expect(try await firstList.value.isEmpty)
    #expect(try await load.value == nil)
    #expect(try await secondList.value.isEmpty)
    #expect(
      await authenticator.authorityReadEvents()
        == [.listAnchors, .anchor(loadID), .listAnchors]
    )

    await authenticator.failNext(at: .anchorListBeforeReturn)
    await #expect(throws: BrokerJournalError.storageUnavailable) {
      _ = try await store.list()
    }
    #expect(try await store.load(connectionID: uuid(212)) == nil)
  }

  @Test
  func selectedRevisionOneOddSlotLoadsAnAuthenticatedSnapshot() async throws {
    let fixture = try await selectedFixture(anchorRevision: 1)

    #expect(try await fixture.store.load(connectionID: fixture.connectionID) == fixture.snapshot)
    #expect(fixture.basename.hasSuffix(".1.rcbj"))
  }

  @Test
  func selectedRevisionTwoEvenSlotIgnoresTheOppositeOrphan() async throws {
    let fixture = try await selectedFixture(anchorRevision: 2)
    fixture.backend.addFile(
      "\(journalPath)/\(fixture.connectionID.uuidString.lowercased()).1.rcbj",
      data: try orphanEnvelope(connectionID: fixture.connectionID)
    )

    #expect(try await fixture.store.load(connectionID: fixture.connectionID) == fixture.snapshot)
    #expect(fixture.basename.hasSuffix(".0.rcbj"))
  }

  @Test
  func missingAnchorSelectedSlotIsRollbackDetected() async throws {
    let fixture = try await selectedFixture(anchorRevision: 1, writeSelectedSlot: false)

    await #expect(throws: BrokerJournalError.rollbackDetected) {
      _ = try await fixture.store.load(connectionID: fixture.connectionID)
    }
  }

  @Test
  func selectedRecordMustMatchAnchorConnectionAndRevision() async throws {
    let wrongConnection = try await selectedFixture(
      anchorRevision: 1,
      recordConnectionID: uuid(101)
    )
    await #expect(throws: BrokerJournalError.rollbackDetected) {
      _ = try await wrongConnection.store.load(connectionID: wrongConnection.connectionID)
    }

    let wrongRevision = try await selectedFixture(anchorRevision: 2, recordRevision: 1)
    await #expect(throws: BrokerJournalError.rollbackDetected) {
      _ = try await wrongRevision.store.load(connectionID: wrongRevision.connectionID)
    }
  }

  @Test
  func selectedEnvelopeMustMatchAnchorAndAuthenticationChain() async throws {
    let tagMismatch = try await selectedFixture(anchorRevision: 1, tagMode: .envelopeMismatch)
    await #expect(throws: BrokerJournalError.authenticationFailed) {
      _ = try await tagMismatch.store.load(connectionID: tagMismatch.connectionID)
    }

    let invalidAuthentication = try await selectedFixture(
      anchorRevision: 1,
      tagMode: .invalidAuthentication
    )
    await #expect(throws: BrokerJournalError.authenticationFailed) {
      _ = try await invalidAuthentication.store.load(
        connectionID: invalidAuthentication.connectionID
      )
    }

    let nonzeroInitialPrevious = try await selectedFixture(
      anchorRevision: 1,
      previousTag: try tag(byte: 9)
    )
    await #expect(throws: BrokerJournalError.authenticationFailed) {
      _ = try await nonzeroInitialPrevious.store.load(
        connectionID: nonzeroInitialPrevious.connectionID
      )
    }
  }

  @Test
  func selectedEnvelopePreservesCanonicalCodecErrors() async throws {
    let noncanonical = try await selectedFixture(anchorRevision: 1)
    let noncanonicalNode = try #require(noncanonical.backend.node(noncanonical.selectedPath))
    noncanonicalNode.content.insert(0x20, at: noncanonicalNode.content.index(after: 0))
    await #expect(throws: BrokerJournalError.nonCanonical) {
      _ = try await noncanonical.store.load(connectionID: noncanonical.connectionID)
    }

    let unsupported = try await selectedFixture(anchorRevision: 1)
    let unsupportedNode = try #require(unsupported.backend.node(unsupported.selectedPath))
    let schema = try #require(unsupportedNode.content.range(of: Data(#""schemaVersion":1"#.utf8)))
    unsupportedNode.content.replaceSubrange(schema, with: Data(#""schemaVersion":2"#.utf8))
    await #expect(throws: BrokerJournalError.unsupportedVersion) {
      _ = try await unsupported.store.load(connectionID: unsupported.connectionID)
    }
  }

  @Test
  func selectedFileErrorsMapAtTheStoreBoundary() async throws {
    let oversized = try await selectedFixture(anchorRevision: 1)
    let oversizedNode = try #require(oversized.backend.node(oversized.selectedPath))
    oversizedNode.content = Data(
      repeating: 0,
      count: SecureDirectory.maximumEnvelopeBytes + 1
    )
    await #expect(throws: BrokerJournalError.invalidRecord) {
      _ = try await oversized.store.load(connectionID: oversized.connectionID)
    }

    let unsafe = try await selectedFixture(anchorRevision: 1)
    let unsafeNode = try #require(unsafe.backend.node(unsafe.selectedPath))
    unsafeNode.mode = 0o640
    await #expect(throws: BrokerJournalError.storageUnavailable) {
      _ = try await unsafe.store.load(connectionID: unsafe.connectionID)
    }
  }

  @Test
  func loadReturnsNilForAnAbsentAnchorWithoutReadingTheDirectory() async throws {
    let backend = ScriptedDarwinFileSystemBackend()
    let directory = try openedDirectory(backend)
    let store = try FileBrokerJournalStore.open(
      directory: directory,
      authenticator: DeterministicBrokerJournalAuthenticator()
    )
    let readsBeforeLoad = backend.openReadOnlyCount
    let enumerationsBeforeLoad = backend.calls.filter { $0 == .entries }.count

    #expect(try await store.load(connectionID: uuid(1)) == nil)
    #expect(backend.openReadOnlyCount == readsBeforeLoad)
    #expect(backend.calls.filter { $0 == .entries }.count == enumerationsBeforeLoad)
  }

  @Test
  func absentAnchorIgnoresAValidCanonicalOrphanSlot() async throws {
    let backend = ScriptedDarwinFileSystemBackend()
    let directory = try openedDirectory(backend)
    let connectionID = uuid(2)
    backend.addFile(
      "\(journalPath)/\(connectionID.uuidString.lowercased()).1.rcbj",
      data: try orphanEnvelope(connectionID: connectionID)
    )
    let store = try FileBrokerJournalStore.open(
      directory: directory,
      authenticator: DeterministicBrokerJournalAuthenticator()
    )
    let readsBeforeLoad = backend.openReadOnlyCount
    let enumerationsBeforeLoad = backend.calls.filter { $0 == .entries }.count

    #expect(try await store.load(connectionID: connectionID) == nil)
    #expect(backend.openReadOnlyCount == readsBeforeLoad)
    #expect(backend.calls.filter { $0 == .entries }.count == enumerationsBeforeLoad)
  }

  @Test
  func loadGateBlocksAuthenticatorEntryAndResumesWaitersFIFO() async throws {
    let backend = ScriptedDarwinFileSystemBackend()
    let directory = try openedDirectory(backend)
    let authenticator = DeterministicBrokerJournalAuthenticator()
    let store = try FileBrokerJournalStore.open(
      directory: directory,
      authenticator: authenticator
    )
    let firstID = uuid(3)
    let secondID = uuid(4)
    let thirdID = uuid(5)

    await authenticator.pauseNext(at: .anchorLookupBeforeReturn)
    let first = Task { try await store.load(connectionID: firstID) }
    await authenticator.waitUntilPaused(at: .anchorLookupBeforeReturn)

    let second = Task { try await store.load(connectionID: secondID) }
    for _ in 0..<20 { await Task.yield() }
    let third = Task { try await store.load(connectionID: thirdID) }
    for _ in 0..<20 { await Task.yield() }

    #expect(await authenticator.anchorLookupCount() == 1)
    await authenticator.releaseOne(at: .anchorLookupBeforeReturn)
    #expect(try await first.value == nil)
    #expect(try await second.value == nil)
    #expect(try await third.value == nil)
    #expect(
      await authenticator.anchorLookupConnectionIDs() == [firstID, secondID, thirdID]
    )
  }

  @Test
  func loadGateReleasesAfterAuthenticatorError() async throws {
    let backend = ScriptedDarwinFileSystemBackend()
    let directory = try openedDirectory(backend)
    let authenticator = DeterministicBrokerJournalAuthenticator()
    let store = try FileBrokerJournalStore.open(
      directory: directory,
      authenticator: authenticator
    )

    await authenticator.failNext(at: .anchorLookupBeforeReturn)
    await #expect(throws: BrokerJournalError.storageUnavailable) {
      _ = try await store.load(connectionID: uuid(6))
    }
    #expect(try await store.load(connectionID: uuid(7)) == nil)
    #expect(await authenticator.anchorLookupCount() == 2)
  }

  @Test
  func firstStoreAcquiresAndHoldsTheDirectoryAuthorityLease() throws {
    let backend = ScriptedDarwinFileSystemBackend()
    let directory = try openedDirectory(backend)
    let store = try FileBrokerJournalStore.open(
      directory: directory,
      authenticator: DeterministicBrokerJournalAuthenticator()
    )

    #expect(backend.node("\(journalPath)/\(SecureDirectory.lockBasename)")?.locked == true)
    withExtendedLifetime(store) {}
  }

  @Test
  func secondStoreForTheSameDirectoryFailsWithLockUnavailable() throws {
    let backend = ScriptedDarwinFileSystemBackend()
    let directory = try openedDirectory(backend)
    let first = try FileBrokerJournalStore.open(
      directory: directory,
      authenticator: DeterministicBrokerJournalAuthenticator()
    )

    #expect(throws: BrokerJournalError.lockUnavailable) {
      _ = try FileBrokerJournalStore.open(
        directory: directory,
        authenticator: DeterministicBrokerJournalAuthenticator()
      )
    }
    withExtendedLifetime(first) {}
  }

  @Test
  func releasingAStoreAllowsALaterStoreToAcquireTheLease() throws {
    let backend = ScriptedDarwinFileSystemBackend()
    let directory = try openedDirectory(backend)
    var first: FileBrokerJournalStore? = try FileBrokerJournalStore.open(
      directory: directory,
      authenticator: DeterministicBrokerJournalAuthenticator()
    )
    #expect(first != nil)

    first = nil
    #expect(backend.node("\(journalPath)/\(SecureDirectory.lockBasename)")?.locked == false)

    let later = try FileBrokerJournalStore.open(
      directory: directory,
      authenticator: DeterministicBrokerJournalAuthenticator()
    )
    #expect(backend.node("\(journalPath)/\(SecureDirectory.lockBasename)")?.locked == true)
    withExtendedLifetime(later) {}
  }

  @Test
  func everySecureDirectoryLeaseFailureMapsToLockUnavailable() throws {
    let backend = ScriptedDarwinFileSystemBackend()
    let directory = try openedDirectory(backend)
    backend.addFile(
      "\(journalPath)/\(SecureDirectory.lockBasename)",
      data: Data([1])
    )

    #expect(throws: BrokerJournalError.lockUnavailable) {
      _ = try FileBrokerJournalStore.open(
        directory: directory,
        authenticator: DeterministicBrokerJournalAuthenticator()
      )
    }
  }

  private var journalPath: String {
    "Library/Application Support/com.recurs.cli/broker/journal-v1"
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

  private func orphanEnvelope(connectionID: UUID) throws -> Data {
    let record = try BrokerJournalRecord(
      revision: 1,
      connectionID: connectionID,
      fence: 0,
      lastGenerationOrdinal: 0,
      changedAt: JournalTimestamp(canonicalText: "2026-07-13T00:00:00.000Z"),
      payload: .vacant(BrokerJournalVacantPayload())
    )
    return try BrokerJournalCodec.encode(
      BrokerJournalEnvelope(
        previousAuthTag: .zero,
        authTag: try JournalAuthenticationTag(bytes: [UInt8](repeating: 1, count: 32)),
        record: record
      )
    )
  }

  private func uuid(_ value: Int) -> UUID {
    UUID(uuidString: String(format: "00000000-0000-4000-8000-%012d", value))!
  }

  private enum FixtureTagMode {
    case correct
    case envelopeMismatch
    case invalidAuthentication
  }

  private struct SelectedFixture {
    let backend: ScriptedDarwinFileSystemBackend
    let store: FileBrokerJournalStore
    let connectionID: UUID
    let record: BrokerJournalRecord
    let authenticationTag: JournalAuthenticationTag
    let basename: String

    var snapshot: BrokerJournalSnapshot {
      BrokerJournalSnapshot(record: record, authenticationTag: authenticationTag)
    }

    var selectedPath: String {
      "Library/Application Support/com.recurs.cli/broker/journal-v1/\(basename)"
    }
  }

  private struct AnchoredSlot {
    let anchor: BrokerJournalAnchor
    let record: BrokerJournalRecord
    let basename: String
    let data: Data
  }

  private func selectedFixture(
    anchorRevision: UInt64,
    recordConnectionID: UUID? = nil,
    recordRevision: UInt64? = nil,
    previousTag: JournalAuthenticationTag? = nil,
    tagMode: FixtureTagMode = .correct,
    writeSelectedSlot: Bool = true
  ) async throws -> SelectedFixture {
    let backend = ScriptedDarwinFileSystemBackend()
    let directory = try openedDirectory(backend)
    let connectionID = uuid(100)
    let record = try BrokerJournalRecord(
      revision: recordRevision ?? anchorRevision,
      connectionID: recordConnectionID ?? connectionID,
      fence: 0,
      lastGenerationOrdinal: 0,
      changedAt: JournalTimestamp(canonicalText: "2026-07-13T00:00:00.000Z"),
      payload: .vacant(BrokerJournalVacantPayload())
    )
    let selectedPreviousTag = try previousTag ?? (anchorRevision == 1 ? .zero : tag(byte: 8))
    let signer = DeterministicBrokerJournalAuthenticator()
    let correctTag = try await signer.authenticate(
      previousTag: selectedPreviousTag,
      canonicalRecord: BrokerJournalCodec.canonicalRecordData(for: record)
    )
    let invalidTag = try tag(byte: 0xee)
    let anchorTag = tagMode == .invalidAuthentication ? invalidTag : correctTag
    let envelopeTag = tagMode == .envelopeMismatch ? invalidTag : anchorTag
    let anchor = try BrokerJournalAnchor(
      connectionID: connectionID,
      revision: anchorRevision,
      authenticationTag: anchorTag
    )
    let authenticator = DeterministicBrokerJournalAuthenticator(anchors: [anchor])
    let basename =
      "\(connectionID.uuidString.lowercased()).\(anchorRevision % 2).rcbj"
    if writeSelectedSlot {
      backend.addFile(
        "\(journalPath)/\(basename)",
        data: try BrokerJournalCodec.encode(
          BrokerJournalEnvelope(
            previousAuthTag: selectedPreviousTag,
            authTag: envelopeTag,
            record: record
          )
        )
      )
    }
    return SelectedFixture(
      backend: backend,
      store: try FileBrokerJournalStore.open(
        directory: directory,
        authenticator: authenticator
      ),
      connectionID: connectionID,
      record: record,
      authenticationTag: anchorTag,
      basename: basename
    )
  }

  private func tag(byte: UInt8) throws -> JournalAuthenticationTag {
    try JournalAuthenticationTag(
      bytes: [UInt8](repeating: byte, count: JournalAuthenticationTag.byteCount)
    )
  }

  private func anchoredSlot(
    connectionID: UUID,
    revision: UInt64,
    recordConnectionID: UUID? = nil
  ) async throws -> AnchoredSlot {
    let record = try BrokerJournalRecord(
      revision: revision,
      connectionID: recordConnectionID ?? connectionID,
      fence: 0,
      lastGenerationOrdinal: 0,
      changedAt: JournalTimestamp(canonicalText: "2026-07-13T00:00:00.000Z"),
      payload: .vacant(BrokerJournalVacantPayload())
    )
    let previousTag = try revision == 1 ? .zero : tag(byte: 7)
    let signer = DeterministicBrokerJournalAuthenticator()
    let authenticationTag = try await signer.authenticate(
      previousTag: previousTag,
      canonicalRecord: BrokerJournalCodec.canonicalRecordData(for: record)
    )
    let anchor = try BrokerJournalAnchor(
      connectionID: connectionID,
      revision: revision,
      authenticationTag: authenticationTag
    )
    let basename = "\(connectionID.uuidString.lowercased()).\(revision % 2).rcbj"
    return AnchoredSlot(
      anchor: anchor,
      record: record,
      basename: basename,
      data: try BrokerJournalCodec.encode(
        BrokerJournalEnvelope(
          previousAuthTag: previousTag,
          authTag: authenticationTag,
          record: record
        )
      )
    )
  }

  private func install(
    _ slot: AnchoredSlot,
    in backend: ScriptedDarwinFileSystemBackend
  ) {
    backend.addFile("\(journalPath)/\(slot.basename)", data: slot.data)
  }

  private func temporaryBasename(_ value: Int) -> String {
    ".tmp.00000000-0000-4000-8000-\(String(format: "%012d", value)).rcbj"
  }
}

private actor HostileListAuthenticator: BrokerJournalAuthenticator {
  let anchors: [BrokerJournalAnchor]

  init(anchors: [BrokerJournalAnchor]) {
    self.anchors = anchors
  }

  func authenticate(
    previousTag: JournalAuthenticationTag,
    canonicalRecord: Data
  ) async throws(BrokerJournalError) -> JournalAuthenticationTag {
    .zero
  }

  func verify(
    previousTag: JournalAuthenticationTag,
    canonicalRecord: Data,
    tag: JournalAuthenticationTag
  ) async throws(BrokerJournalError) {}

  func anchor(
    for connectionID: UUID
  ) async throws(BrokerJournalError) -> BrokerJournalAnchor? {
    nil
  }

  func listAnchors() async throws(BrokerJournalError) -> [BrokerJournalAnchor] {
    anchors
  }

  func compareAndSwapAnchor(
    expected: BrokerJournalAnchor?,
    replacement: BrokerJournalAnchor
  ) async throws(BrokerJournalError) {}
}
