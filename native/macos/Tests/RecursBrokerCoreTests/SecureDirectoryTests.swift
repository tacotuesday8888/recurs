import Foundation
import Testing

@testable import RecursBrokerCore

@Suite("Secure broker directory")
struct SecureDirectoryTests {
  private let journalPath = "Library/Application Support/com.recurs.cli/broker/journal-v1"

  private func opened(
    _ backend: ScriptedDarwinFileSystemBackend
  ) throws -> SecureDirectory {
    try SecureDirectory.openJournalDirectory(
      trustedHomeDescriptor: backend.rootDescriptor,
      currentUID: backend.currentUID,
      backend: backend
    )
  }

  @Test
  func errorsArePayloadFreeAndRedacted() {
    let errors: [SecureDirectoryError] = [
      .invalidComponent, .unsafeAncestor, .wrongOwner, .wrongMode, .extendedACL,
      .symlink, .notDirectory, .notRegularFile, .hardLink, .deviceMismatch,
      .unsupportedFilesystem, .fileTooLarge, .ioUnavailable, .durabilityUnknown,
    ]

    #expect(Set(errors.map(\.description)).count == errors.count)
    for error in errors {
      #expect(error.description == error.debugDescription)
      #expect(error.errorDescription == error.description)
      #expect(Mirror(reflecting: error).children.isEmpty)
    }
  }

  @Test(arguments: ["", ".", "..", "a/b", "a\0b", String(repeating: "a", count: 256)])
  func rejectsUnsafeComponents(_ component: String) {
    #expect(throws: SecureDirectoryError.invalidComponent) {
      try SecureDirectory.validateComponent(component)
    }
  }

  @Test
  func recognizesOnlyCanonicalSlotAndTemporaryNames() throws {
    let id = UUID(uuidString: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")!
    #expect(try SecureDirectory.slotIdentity(for: "\(id.uuidString.lowercased()).0.rcbj") != nil)
    #expect(try SecureDirectory.slotIdentity(for: "\(id.uuidString.lowercased()).1.rcbj") != nil)
    #expect(try SecureDirectory.isTemporaryBasename(".tmp.\(id.uuidString.lowercased()).rcbj"))

    #expect(throws: SecureDirectoryError.invalidComponent) {
      _ = try SecureDirectory.slotIdentity(for: "\(id.uuidString).0.rcbj")
    }
    #expect(throws: SecureDirectoryError.invalidComponent) {
      _ = try SecureDirectory.isTemporaryBasename(".tmp.not-a-uuid.rcbj")
    }
  }

  @Test
  func opensFixedDescriptorRelativeTreeAndCreatesOnlyPrivateComponents() throws {
    let backend = ScriptedDarwinFileSystemBackend()
    do {
      _ = try opened(backend)
      #expect(backend.node(journalPath)?.kind == .directory)
      #expect(backend.node(journalPath)?.mode == 0o700)
      #expect(backend.calls.filter { $0 == .createDirectory }.count == 3)
    }
    #expect(backend.closedDescriptors.count == 5)
  }

  @Test
  func walksSystemOwnedHomeComponentsFromTrustedRoot() throws {
    let backend = ScriptedDarwinFileSystemBackend(systemHomePath: "Users/alice")
    do {
      _ = try SecureDirectory.openJournalDirectory(
        trustedRootDescriptor: backend.rootDescriptor,
        homeComponents: ["Users", "alice"],
        currentUID: backend.currentUID,
        backend: backend
      )
      #expect(
        backend.node("Users/alice/Library/Application Support/com.recurs.cli/broker/journal-v1")
          != nil
      )
    }
    #expect(backend.activeOwnedDescriptorCount == 0)
  }

  @Test
  func rootWalkRejectsUntrustedSystemOwnerAndUnsafeHomeComponents() throws {
    let backend = ScriptedDarwinFileSystemBackend(systemHomePath: "Users/alice")
    backend.node("Users")?.owner = backend.currentUID
    #expect(throws: SecureDirectoryError.wrongOwner) {
      _ = try SecureDirectory.openJournalDirectory(
        trustedRootDescriptor: backend.rootDescriptor,
        homeComponents: ["Users", "alice"],
        currentUID: backend.currentUID,
        backend: backend
      )
    }
    #expect(backend.activeOwnedDescriptorCount == 0)

    #expect(throws: SecureDirectoryError.invalidComponent) {
      _ = try SecureDirectory.openJournalDirectory(
        trustedRootDescriptor: backend.rootDescriptor,
        homeComponents: ["Users", ".."],
        currentUID: backend.currentUID,
        backend: backend
      )
    }
  }

  @Test(arguments: [
    SecureDirectoryError.wrongOwner,
    .unsafeAncestor,
    .wrongMode,
    .extendedACL,
    .deviceMismatch,
    .unsupportedFilesystem,
    .symlink,
    .notDirectory,
  ])
  func rejectsUnsafeDirectoryTopology(_ expected: SecureDirectoryError) throws {
    let backend = ScriptedDarwinFileSystemBackend()
    switch expected {
    case .wrongOwner:
      backend.node("Library")?.owner = 0
    case .unsafeAncestor:
      backend.node("Library")?.mode = 0o722
    case .wrongMode:
      backend.addDirectory("Library/Application Support/com.recurs.cli", mode: 0o755)
    case .extendedACL:
      backend.addDirectory("Library/Application Support/com.recurs.cli").hasExtendedACL = true
    case .deviceMismatch:
      backend.addDirectory("Library/Application Support/com.recurs.cli", device: 99)
    case .unsupportedFilesystem:
      backend.node("Library")?.fileSystemType = "nfs"
    case .symlink:
      backend.node("Library")?.kind = .symbolicLink
    case .notDirectory:
      backend.node("Library")?.kind = .regularFile
    default:
      Issue.record("Unhandled topology fixture")
    }
    #expect(throws: expected) { _ = try opened(backend) }
  }

  @Test
  func enumerationIsSortedBoundedAndRejectsUnknownOrAmbiguousNames() throws {
    let backend = ScriptedDarwinFileSystemBackend()
    let directory = try opened(backend)
    let connection = UUID(uuidString: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")!
    let selected = "\(connection.uuidString.lowercased()).1.rcbj"
    backend.addFile("\(journalPath)/\(selected)")
    backend.addFile("\(journalPath)/\(connection.uuidString.lowercased()).0.rcbj")
    backend.addFile("\(journalPath)/.broker-journal-v1.lock")
    let temp = ".tmp.11111111-2222-4333-8444-555555555555.rcbj"
    backend.addFile("\(journalPath)/\(temp)")

    let entries = try directory.enumerateRecognizedEntries(
      selectedSlotBasenames: [selected]
    )
    #expect(entries.slotBasenames == entries.slotBasenames.sorted())
    #expect(entries.temporaryBasenames == [temp])
    #expect(entries.hasLockFile)

    backend.addFile("\(journalPath)/unexpected")
    #expect(throws: SecureDirectoryError.invalidComponent) {
      _ = try directory.enumerateRecognizedEntries(selectedSlotBasenames: [selected])
    }
  }

  @Test
  func enumerationEnforcesTemporaryAndUnanchoredBounds() throws {
    let backend = ScriptedDarwinFileSystemBackend()
    let directory = try opened(backend)
    for value in 0...SecureDirectory.maximumTemporaryFiles {
      let id = String(format: "00000000-0000-4000-8000-%012d", value)
      backend.addFile("\(journalPath)/.tmp.\(id).rcbj")
    }
    #expect(throws: SecureDirectoryError.fileTooLarge) {
      _ = try directory.enumerateRecognizedEntries(selectedSlotBasenames: [])
    }

    let secondBackend = ScriptedDarwinFileSystemBackend()
    let secondDirectory = try opened(secondBackend)
    for value in 0...SecureDirectory.maximumUnanchoredSlots {
      let id = String(format: "10000000-0000-4000-8000-%012d", value)
      secondBackend.addFile("\(journalPath)/\(id).0.rcbj")
    }
    #expect(throws: SecureDirectoryError.fileTooLarge) {
      _ = try secondDirectory.enumerateRecognizedEntries(selectedSlotBasenames: [])
    }
  }

  @Test
  func retainedDescriptorIsConfinedWhenFinalParentNameIsReplaced() throws {
    let backend = ScriptedDarwinFileSystemBackend()
    let name = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.0.rcbj"
    let bytes = Data("old inode authority".utf8)
    backend.addFile("\(journalPath)/\(name)", data: bytes)
    let directory = try opened(backend)

    _ = backend.replaceDirectory(journalPath)

    #expect(backend.node("\(journalPath)/\(name)") == nil)
    #expect(try directory.readBoundedFile(basename: name) == bytes)
  }

  @Test(arguments: [
    SecureDirectoryError.wrongOwner,
    .wrongMode,
    .extendedACL,
    .hardLink,
    .deviceMismatch,
    .notRegularFile,
    .symlink,
    .fileTooLarge,
  ])
  func boundedReadRejectsUnsafeFiles(_ expected: SecureDirectoryError) throws {
    let backend = ScriptedDarwinFileSystemBackend()
    let directory = try opened(backend)
    let name = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.0.rcbj"
    let file = backend.addFile("\(journalPath)/\(name)", data: Data("ok".utf8))
    switch expected {
    case .wrongOwner: file.owner = 0
    case .wrongMode: file.mode = 0o644
    case .extendedACL: file.hasExtendedACL = true
    case .hardLink: file.linkCount = 2
    case .deviceMismatch: file.device = 8
    case .notRegularFile: file.kind = .directory
    case .symlink: file.kind = .symbolicLink
    case .fileTooLarge: file.content = Data(repeating: 0, count: 65_537)
    default: Issue.record("Unhandled read fixture")
    }
    #expect(throws: expected) { _ = try directory.readBoundedFile(basename: name) }
  }

  @Test
  func boundedReadRetriesInterruptionsAndPartialReads() throws {
    let backend = ScriptedDarwinFileSystemBackend()
    let directory = try opened(backend)
    let name = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.0.rcbj"
    let expected = Data("canonical journal bytes".utf8)
    backend.addFile("\(journalPath)/\(name)", data: expected)
    backend.maximumReadCount = 2
    backend.failNext(.read, with: .interrupted)
    #expect(try directory.readBoundedFile(basename: name) == expected)
    #expect(backend.calls.filter { $0 == .read }.count > 3)
  }

  @Test(arguments: ["inode", "size", "device", "link"])
  func boundedReadRejectsPostOpenMetadataChanges(_ mutation: String) throws {
    let backend = ScriptedDarwinFileSystemBackend()
    let directory = try opened(backend)
    let name = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.0.rcbj"
    let file = backend.addFile("\(journalPath)/\(name)", data: Data("bytes".utf8))
    backend.maximumReadCount = 2
    backend.afterRead = { count in
      guard count == 1 else { return }
      switch mutation {
      case "inode": file.inode += 1
      case "size": file.content.append(0)
      case "device": file.device += 1
      case "link": file.linkCount += 1
      default: break
      }
    }
    let expected: SecureDirectoryError =
      switch mutation {
      case "device": .deviceMismatch
      case "link": .hardLink
      default: .ioUnavailable
      }
    #expect(throws: expected) {
      _ = try directory.readBoundedFile(basename: name)
    }
  }

  @Test
  func atomicWriteLoopsThenSyncsRenamesDirectorySyncsAndVerifies() throws {
    let backend = ScriptedDarwinFileSystemBackend()
    let directory = try opened(backend)
    backend.maximumWriteCount = 2
    backend.maximumReadCount = 3
    backend.failNext(.write, with: .interrupted)
    let slot = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.1.rcbj"
    let bytes = Data("canonical journal bytes".utf8)

    try directory.writeAtomically(
      bytes,
      toSlotBasename: slot,
      temporaryID: UUID(uuidString: "11111111-2222-4333-8444-555555555555")!
    )

    #expect(backend.node("\(journalPath)/\(slot)")?.content == bytes)
    let fullSync = try #require(backend.calls.firstIndex(of: .fullSync))
    let rename = try #require(backend.calls.firstIndex(of: .rename))
    let directorySync = try #require(backend.calls.firstIndex(of: .directorySync))
    #expect(fullSync < rename)
    #expect(rename < directorySync)
  }

  @Test
  func failedPreRenameWriteRemovesOnlyVerifiedTemporary() throws {
    let backend = ScriptedDarwinFileSystemBackend()
    let directory = try opened(backend)
    backend.failNext(.fullSync, with: .durabilityUnknown)
    let temporaryID = UUID(uuidString: "11111111-2222-4333-8444-555555555555")!
    #expect(throws: SecureDirectoryError.durabilityUnknown) {
      try directory.writeAtomically(
        Data("bytes".utf8),
        toSlotBasename: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.0.rcbj",
        temporaryID: temporaryID
      )
    }
    #expect(
      backend.node("\(journalPath)/.tmp.\(temporaryID.uuidString.lowercased()).rcbj") == nil
    )
    #expect(backend.renamedPairs.isEmpty)
  }

  @Test
  func failedPreRenameWriteDoesNotUnlinkAReplacementName() throws {
    let backend = ScriptedDarwinFileSystemBackend()
    let directory = try opened(backend)
    let temporaryID = UUID(uuidString: "11111111-2222-4333-8444-555555555555")!
    let temporary = ".tmp.\(temporaryID.uuidString.lowercased()).rcbj"
    backend.beforeFullSync = {
      _ = backend.replaceFile("\(self.journalPath)/\(temporary)", data: Data("replacement".utf8))
    }
    backend.failNext(.fullSync, with: .durabilityUnknown)

    #expect(throws: SecureDirectoryError.durabilityUnknown) {
      try directory.writeAtomically(
        Data("original".utf8),
        toSlotBasename: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.0.rcbj",
        temporaryID: temporaryID
      )
    }
    #expect(backend.node("\(journalPath)/\(temporary)")?.content == Data("replacement".utf8))
    #expect(!backend.unlinkedBasenames.contains(temporary))
  }

  @Test
  func atomicWriteRejectsTemporaryNameReplacementBeforeRename() throws {
    let backend = ScriptedDarwinFileSystemBackend()
    let directory = try opened(backend)
    let temporaryID = UUID(uuidString: "11111111-2222-4333-8444-555555555555")!
    let temporary = ".tmp.\(temporaryID.uuidString.lowercased()).rcbj"
    backend.afterFullSync = {
      _ = backend.replaceFile("\(self.journalPath)/\(temporary)", data: Data("replacement".utf8))
    }

    #expect(throws: SecureDirectoryError.ioUnavailable) {
      try directory.writeAtomically(
        Data("original".utf8),
        toSlotBasename: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.0.rcbj",
        temporaryID: temporaryID
      )
    }
    #expect(backend.renamedPairs.isEmpty)
    #expect(backend.node("\(journalPath)/\(temporary)")?.content == Data("replacement".utf8))
  }

  @Test
  func postRenameDirectorySyncFailureNeverDeletesSelectedSlot() throws {
    let backend = ScriptedDarwinFileSystemBackend()
    let directory = try opened(backend)
    backend.failNext(.directorySync, with: .durabilityUnknown)
    let slot = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.0.rcbj"
    #expect(throws: SecureDirectoryError.durabilityUnknown) {
      try directory.writeAtomically(
        Data("bytes".utf8),
        toSlotBasename: slot,
        temporaryID: UUID(uuidString: "11111111-2222-4333-8444-555555555555")!
      )
    }
    #expect(backend.node("\(journalPath)/\(slot)")?.content == Data("bytes".utf8))
    #expect(!backend.unlinkedBasenames.contains(slot))
  }

  @Test
  func temporaryCleanupValidatesInodeAndRejectsAChangedName() throws {
    let backend = ScriptedDarwinFileSystemBackend()
    let directory = try opened(backend)
    let temp = ".tmp.11111111-2222-4333-8444-555555555555.rcbj"
    backend.addFile("\(journalPath)/\(temp)")
    try directory.removeVerifiedTemporary(
      basename: temp,
      selectedSlotBasenames: []
    )
    #expect(backend.node("\(journalPath)/\(temp)") == nil)

    let unsafe = ".tmp.22222222-2222-4333-8444-555555555555.rcbj"
    backend.addFile("\(journalPath)/\(unsafe)", linkCount: 2)
    #expect(throws: SecureDirectoryError.hardLink) {
      try directory.removeVerifiedTemporary(basename: unsafe, selectedSlotBasenames: [])
    }
  }

  @Test
  func temporaryCleanupRejectsNameReplacementBetweenIdentityChecks() throws {
    let backend = ScriptedDarwinFileSystemBackend()
    let directory = try opened(backend)
    let temp = ".tmp.11111111-2222-4333-8444-555555555555.rcbj"
    backend.addFile("\(journalPath)/\(temp)")
    backend.afterOpenReadOnly = { count in
      guard count == 1 else { return }
      _ = backend.replaceFile("\(self.journalPath)/\(temp)")
    }

    #expect(throws: SecureDirectoryError.ioUnavailable) {
      try directory.removeVerifiedTemporary(basename: temp, selectedSlotBasenames: [])
    }
    #expect(backend.node("\(journalPath)/\(temp)") != nil)
    #expect(!backend.unlinkedBasenames.contains(temp))
  }

  @Test
  func lockLeaseIsExactLifetimeAndExistingLockIsNeverChmodded() throws {
    let backend = ScriptedDarwinFileSystemBackend()
    let directory = try opened(backend)
    let activeBeforeLease = backend.activeOwnedDescriptorCount
    do {
      let lease = try directory.acquireAuthorityLease()
      let isHeld = lease.isHeld
      #expect(isHeld)
      #expect(backend.node("\(journalPath)/.broker-journal-v1.lock")?.locked == true)
      #expect(backend.node("\(journalPath)/.broker-journal-v1.lock")?.mode == 0o600)
      #expect(backend.activeOwnedDescriptorCount == activeBeforeLease + 1)
    }
    #expect(backend.node("\(journalPath)/.broker-journal-v1.lock")?.locked == false)
    #expect(backend.activeOwnedDescriptorCount == activeBeforeLease)

    let existingBackend = ScriptedDarwinFileSystemBackend()
    let existingDirectory = try opened(existingBackend)
    existingBackend.addFile("\(journalPath)/.broker-journal-v1.lock", mode: 0o640)
    let priorSetModeCalls = existingBackend.calls.filter { $0 == .setMode }.count
    #expect(throws: SecureDirectoryError.wrongMode) {
      _ = try existingDirectory.acquireAuthorityLease()
    }
    #expect(existingBackend.calls.filter { $0 == .setMode }.count == priorSetModeCalls)
  }

  @Test
  func lockContentionAndNonemptyLockFailClosed() throws {
    let backend = ScriptedDarwinFileSystemBackend()
    let directory = try opened(backend)
    backend.addFile("\(journalPath)/.broker-journal-v1.lock", data: Data([1]))
    #expect(throws: SecureDirectoryError.wrongMode) {
      _ = try directory.acquireAuthorityLease()
    }

    let contentionBackend = ScriptedDarwinFileSystemBackend()
    let contentionDirectory = try opened(contentionBackend)
    contentionBackend.addFile("\(journalPath)/.broker-journal-v1.lock")
    contentionBackend.failNext(.lock, with: .wouldBlock)
    #expect(throws: SecureDirectoryError.ioUnavailable) {
      _ = try contentionDirectory.acquireAuthorityLease()
    }
  }

  @Test
  func everyFailingOperationClosesItsOwnedDescriptor() throws {
    let topologyBackend = ScriptedDarwinFileSystemBackend()
    topologyBackend.addDirectory("Library/Application Support/com.recurs.cli", mode: 0o755)
    #expect(throws: SecureDirectoryError.wrongMode) {
      _ = try opened(topologyBackend)
    }
    #expect(topologyBackend.activeOwnedDescriptorCount == 0)

    let backend = ScriptedDarwinFileSystemBackend()
    let directory = try opened(backend)
    let baseline = backend.activeOwnedDescriptorCount
    let name = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.0.rcbj"
    backend.addFile("\(journalPath)/\(name)", owner: 0)
    #expect(throws: SecureDirectoryError.wrongOwner) {
      _ = try directory.readBoundedFile(basename: name)
    }
    #expect(backend.activeOwnedDescriptorCount == baseline)

    backend.failNext(.fullSync, with: .durabilityUnknown)
    #expect(throws: SecureDirectoryError.durabilityUnknown) {
      try directory.writeAtomically(
        Data("bytes".utf8),
        toSlotBasename: name,
        temporaryID: UUID(uuidString: "11111111-2222-4333-8444-555555555555")!
      )
    }
    #expect(backend.activeOwnedDescriptorCount == baseline)
  }
}
