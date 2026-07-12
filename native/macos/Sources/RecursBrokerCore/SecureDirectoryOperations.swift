import Foundation

extension SecureDirectory {
  private static var userComponents: [String] { ["Library", "Application Support"] }
  private static var privateComponents: [String] { ["com.recurs.cli", "broker", "journal-v1"] }

  package static func openJournalDirectory(
    trustedHomeDescriptor: Int32,
    currentUID: UInt32,
    backend: any DarwinFileSystemBackend = LiveDarwinFileSystemBackend()
  ) throws(SecureDirectoryError) -> SecureDirectory {
    let rootMetadata = try mapBackend { try backend.metadata(descriptor: trustedHomeDescriptor) }
    try validateUserAncestor(rootMetadata, currentUID: currentUID)
    let fileSystem = try mapBackend {
      try backend.fileSystemIdentity(descriptor: trustedHomeDescriptor)
    }
    try validateFileSystem(fileSystem)

    var parent = trustedHomeDescriptor
    var ownedParent: Int32?
    do {
      for component in userComponents {
        let next = try openExistingDirectory(
          parent: parent,
          component: component,
          currentUID: currentUID,
          expectedDevice: rootMetadata.device,
          exactPrivateMode: false,
          backend: backend
        )
        if let ownedParent { backend.close(descriptor: ownedParent) }
        ownedParent = next
        parent = next
      }
      for component in privateComponents {
        let next = try openOrCreatePrivateDirectory(
          parent: parent,
          component: component,
          currentUID: currentUID,
          expectedDevice: rootMetadata.device,
          backend: backend
        )
        if let ownedParent { backend.close(descriptor: ownedParent) }
        ownedParent = next
        parent = next
      }
      guard let finalDescriptor = ownedParent else { throw SecureDirectoryError.ioUnavailable }
      ownedParent = nil
      return SecureDirectory(
        descriptor: finalDescriptor,
        owner: currentUID,
        device: rootMetadata.device,
        backend: backend
      )
    } catch let error as SecureDirectoryError {
      if let ownedParent { backend.close(descriptor: ownedParent) }
      throw error
    } catch {
      if let ownedParent { backend.close(descriptor: ownedParent) }
      throw .ioUnavailable
    }
  }

  private static func validateUserAncestor(
    _ metadata: DarwinNodeMetadata,
    currentUID: UInt32
  ) throws(SecureDirectoryError) {
    guard metadata.kind == .directory else { throw .notDirectory }
    guard metadata.owner == currentUID else { throw .wrongOwner }
    guard metadata.mode & 0o022 == 0 else { throw .unsafeAncestor }
  }

  private static func validateFileSystem(_ identity: DarwinFileSystemIdentity)
    throws(SecureDirectoryError)
  {
    guard identity.isLocal, identity.typeName == "apfs" else {
      throw .unsupportedFilesystem
    }
  }

  private static func openExistingDirectory(
    parent: Int32,
    component: String,
    currentUID: UInt32,
    expectedDevice: UInt64,
    exactPrivateMode: Bool,
    backend: any DarwinFileSystemBackend
  ) throws(SecureDirectoryError) -> Int32 {
    try validateComponent(component)
    let descriptor: Int32
    do {
      descriptor = try backend.openDirectory(at: parent, component: component)
    } catch let error {
      switch error {
      case .symlink: throw .symlink
      case .notDirectory: throw .notDirectory
      default: throw .ioUnavailable
      }
    }
    do {
      try validateDirectoryDescriptor(
        descriptor,
        currentUID: currentUID,
        expectedDevice: expectedDevice,
        exactPrivateMode: exactPrivateMode,
        backend: backend
      )
      return descriptor
    } catch {
      backend.close(descriptor: descriptor)
      throw error
    }
  }

  private static func openOrCreatePrivateDirectory(
    parent: Int32,
    component: String,
    currentUID: UInt32,
    expectedDevice: UInt64,
    backend: any DarwinFileSystemBackend
  ) throws(SecureDirectoryError) -> Int32 {
    try validateComponent(component)
    let descriptor: Int32
    do {
      descriptor = try backend.openDirectory(at: parent, component: component)
    } catch let error {
      switch error {
      case .notFound:
        do {
          try backend.createDirectory(at: parent, component: component, mode: 0o700)
        } catch .alreadyExists {
          // A racing creator is accepted only after the same descriptor checks.
        } catch {
          throw .ioUnavailable
        }
        do {
          descriptor = try backend.openDirectory(at: parent, component: component)
        } catch .symlink {
          throw .symlink
        } catch .notDirectory {
          throw .notDirectory
        } catch {
          throw .ioUnavailable
        }
      case .symlink: throw .symlink
      case .notDirectory: throw .notDirectory
      default: throw .ioUnavailable
      }
    }
    do {
      try validateDirectoryDescriptor(
        descriptor,
        currentUID: currentUID,
        expectedDevice: expectedDevice,
        exactPrivateMode: true,
        backend: backend
      )
      return descriptor
    } catch {
      backend.close(descriptor: descriptor)
      throw error
    }
  }

  private static func validateDirectoryDescriptor(
    _ descriptor: Int32,
    currentUID: UInt32,
    expectedDevice: UInt64,
    exactPrivateMode: Bool,
    backend: any DarwinFileSystemBackend
  ) throws(SecureDirectoryError) {
    let metadata = try mapBackend { try backend.metadata(descriptor: descriptor) }
    guard metadata.kind == .directory else { throw .notDirectory }
    guard metadata.owner == currentUID else { throw .wrongOwner }
    if exactPrivateMode {
      guard metadata.mode == 0o700 else { throw .wrongMode }
      guard !metadata.hasExtendedACL else { throw .extendedACL }
    } else {
      guard metadata.mode & 0o022 == 0 else { throw .unsafeAncestor }
    }
    guard metadata.device == expectedDevice else { throw .deviceMismatch }
    try validateFileSystem(
      try mapBackend { try backend.fileSystemIdentity(descriptor: descriptor) }
    )
  }

  package func enumerateRecognizedEntries(selectedSlotBasenames: Set<String>)
    throws(SecureDirectoryError) -> SecureDirectoryEntries
  {
    var selectedConnections = Set<UUID>()
    for basename in selectedSlotBasenames {
      guard let identity = try Self.slotIdentity(for: basename) else {
        throw .invalidComponent
      }
      selectedConnections.insert(identity.connectionID)
    }
    guard selectedConnections.count <= Self.maximumAnchoredConnections else {
      throw .fileTooLarge
    }

    let rawEntries = try Self.mapBackend {
      try backend.directoryEntries(descriptor: descriptor)
    }
    var slots: [String] = []
    var temporaries: [String] = []
    var hasLock = false
    var unanchoredCount = 0
    var countedEntries = 0

    for basename in rawEntries where basename != "." && basename != ".." {
      countedEntries += 1
      guard countedEntries <= Self.maximumRecognizedEntries else { throw .fileTooLarge }
      if basename == Self.lockBasename {
        guard !hasLock else { throw .invalidComponent }
        hasLock = true
      } else if let slot = try Self.slotIdentity(for: basename) {
        slots.append(basename)
        if !selectedConnections.contains(slot.connectionID) {
          unanchoredCount += 1
          guard unanchoredCount <= Self.maximumUnanchoredSlots else { throw .fileTooLarge }
        }
      } else if try Self.isTemporaryBasename(basename) {
        temporaries.append(basename)
        guard temporaries.count <= Self.maximumTemporaryFiles else { throw .fileTooLarge }
      } else {
        throw .invalidComponent
      }
    }
    return SecureDirectoryEntries(
      slotBasenames: slots.sorted(),
      temporaryBasenames: temporaries.sorted(),
      hasLockFile: hasLock
    )
  }

  package func readBoundedFile(basename: String) throws(SecureDirectoryError) -> Data {
    try Self.validateComponent(basename)
    let fileDescriptor = try openReadOnly(basename: basename)
    defer { backend.close(descriptor: fileDescriptor) }
    let initial = try validatedRegularFile(descriptor: fileDescriptor)
    guard initial.size <= UInt64(Self.maximumEnvelopeBytes) else { throw .fileTooLarge }

    var result = Data()
    result.reserveCapacity(Int(initial.size))
    while result.count <= Self.maximumEnvelopeBytes {
      let chunk: Data
      do {
        chunk = try backend.read(
          descriptor: fileDescriptor,
          maximumCount: min(8_192, Self.maximumEnvelopeBytes + 1 - result.count)
        )
      } catch .interrupted {
        continue
      } catch {
        throw .ioUnavailable
      }
      if chunk.isEmpty { break }
      result.append(chunk)
      guard result.count <= Self.maximumEnvelopeBytes else { throw .fileTooLarge }
    }
    let final = try validatedRegularFile(descriptor: fileDescriptor)
    guard
      final.device == initial.device,
      final.inode == initial.inode,
      final.size == initial.size,
      result.count == Int(initial.size)
    else {
      throw .ioUnavailable
    }
    return result
  }

  package func removeVerifiedTemporary(
    basename: String,
    selectedSlotBasenames: Set<String>
  ) throws(SecureDirectoryError) {
    guard try Self.isTemporaryBasename(basename) else { throw .invalidComponent }
    guard !selectedSlotBasenames.contains(basename) else { throw .invalidComponent }
    let firstDescriptor = try openReadOnly(basename: basename)
    defer { backend.close(descriptor: firstDescriptor) }
    let first = try validatedRegularFile(descriptor: firstDescriptor)

    let secondDescriptor = try openReadOnly(basename: basename)
    defer { backend.close(descriptor: secondDescriptor) }
    let second = try validatedRegularFile(descriptor: secondDescriptor)
    guard first.device == second.device, first.inode == second.inode else {
      throw .ioUnavailable
    }
    do {
      try backend.unlink(at: descriptor, basename: basename)
    } catch {
      throw .ioUnavailable
    }
  }

  package func writeAtomically(
    _ data: Data,
    toSlotBasename slotBasename: String,
    temporaryID: UUID = UUID()
  ) throws(SecureDirectoryError) {
    guard data.count <= Self.maximumEnvelopeBytes else { throw .fileTooLarge }
    guard try Self.slotIdentity(for: slotBasename) != nil else { throw .invalidComponent }
    let temporaryBasename = ".tmp.\(temporaryID.uuidString.lowercased()).rcbj"
    guard try Self.isTemporaryBasename(temporaryBasename) else { throw .invalidComponent }

    let fileDescriptor: Int32
    do {
      fileDescriptor = try backend.createExclusiveFile(
        at: descriptor,
        basename: temporaryBasename,
        mode: 0o600
      )
    } catch {
      throw .ioUnavailable
    }

    var renamed = false
    var verifiedTemporary: DarwinNodeMetadata?
    defer {
      if !renamed, let verifiedTemporary {
        removeTemporaryIfIdentityMatches(
          basename: temporaryBasename,
          expected: verifiedTemporary
        )
      }
      backend.close(descriptor: fileDescriptor)
    }
    do {
      try backend.setMode(descriptor: fileDescriptor, mode: 0o600)
      verifiedTemporary = try validatedRegularFile(descriptor: fileDescriptor)
      var offset = 0
      while offset < data.count {
        let written: Int
        do {
          written = try backend.write(
            descriptor: fileDescriptor,
            data: data.subdata(in: offset..<data.count)
          )
        } catch .interrupted {
          continue
        } catch {
          throw SecureDirectoryError.ioUnavailable
        }
        guard written > 0, written <= data.count - offset else {
          throw SecureDirectoryError.ioUnavailable
        }
        offset += written
      }
      do {
        try backend.fullSync(descriptor: fileDescriptor)
      } catch .durabilityUnknown {
        throw SecureDirectoryError.durabilityUnknown
      } catch {
        throw SecureDirectoryError.ioUnavailable
      }
      guard
        let verifiedTemporary,
        nameHasIdentity(basename: temporaryBasename, expected: verifiedTemporary)
      else {
        throw SecureDirectoryError.ioUnavailable
      }
      do {
        try backend.rename(
          in: descriptor,
          from: temporaryBasename,
          to: slotBasename
        )
        renamed = true
      } catch .durabilityUnknown {
        throw SecureDirectoryError.durabilityUnknown
      } catch {
        throw SecureDirectoryError.ioUnavailable
      }
      do {
        try backend.syncDirectory(descriptor: descriptor)
      } catch {
        throw SecureDirectoryError.durabilityUnknown
      }
    } catch let error as SecureDirectoryError {
      throw error
    } catch {
      throw .ioUnavailable
    }

    let verified = try readBoundedFile(basename: slotBasename)
    guard verified == data else { throw .durabilityUnknown }
  }

  private func removeTemporaryIfIdentityMatches(
    basename: String,
    expected: DarwinNodeMetadata
  ) {
    guard nameHasIdentity(basename: basename, expected: expected) else { return }
    try? backend.unlink(at: descriptor, basename: basename)
  }

  private func nameHasIdentity(
    basename: String,
    expected: DarwinNodeMetadata
  ) -> Bool {
    guard
      let currentDescriptor = try? backend.openReadOnlyFile(
        at: descriptor,
        basename: basename
      )
    else {
      return false
    }
    defer { backend.close(descriptor: currentDescriptor) }
    guard
      let current = try? validatedRegularFile(descriptor: currentDescriptor),
      current.device == expected.device,
      current.inode == expected.inode
    else {
      return false
    }
    return true
  }

  package func acquireAuthorityLease() throws(SecureDirectoryError) -> BrokerAuthorityLease {
    let lockDescriptor: Int32
    var created = false
    do {
      lockDescriptor = try backend.createExclusiveFile(
        at: descriptor,
        basename: Self.lockBasename,
        mode: 0o600
      )
      created = true
    } catch .alreadyExists {
      do {
        lockDescriptor = try backend.openReadWriteFile(
          at: descriptor,
          basename: Self.lockBasename
        )
      } catch .symlink {
        throw .symlink
      } catch {
        throw .ioUnavailable
      }
    } catch {
      throw .ioUnavailable
    }
    do {
      if created { try backend.setMode(descriptor: lockDescriptor, mode: 0o600) }
      let metadata = try validatedRegularFile(descriptor: lockDescriptor)
      guard metadata.size == 0 else { throw SecureDirectoryError.wrongMode }
      do {
        try backend.lockExclusiveNonblocking(descriptor: lockDescriptor)
      } catch {
        throw SecureDirectoryError.ioUnavailable
      }
      return BrokerAuthorityLease(descriptor: lockDescriptor, backend: backend)
    } catch {
      backend.close(descriptor: lockDescriptor)
      if created { try? backend.unlink(at: descriptor, basename: Self.lockBasename) }
      if let error = error as? SecureDirectoryError { throw error }
      throw .ioUnavailable
    }
  }

  private func openReadOnly(basename: String) throws(SecureDirectoryError) -> Int32 {
    do {
      return try backend.openReadOnlyFile(at: descriptor, basename: basename)
    } catch .symlink { throw .symlink } catch { throw .ioUnavailable }
  }

  private func validatedRegularFile(descriptor: Int32)
    throws(SecureDirectoryError) -> DarwinNodeMetadata
  {
    let metadata = try Self.mapBackend { try backend.metadata(descriptor: descriptor) }
    switch metadata.kind {
    case .regularFile: break
    case .symbolicLink: throw .symlink
    default: throw .notRegularFile
    }
    guard metadata.owner == owner else { throw .wrongOwner }
    guard metadata.mode == 0o600 else { throw .wrongMode }
    guard metadata.linkCount == 1 else { throw .hardLink }
    guard metadata.device == device else { throw .deviceMismatch }
    guard !metadata.hasExtendedACL else { throw .extendedACL }
    return metadata
  }

  private static func mapBackend<T>(_ operation: () throws -> T)
    throws(SecureDirectoryError) -> T
  {
    do {
      return try operation()
    } catch let error as DarwinFileSystemBackendError {
      switch error {
      case .symlink: throw .symlink
      case .notDirectory: throw .notDirectory
      case .durabilityUnknown: throw .durabilityUnknown
      default: throw .ioUnavailable
      }
    } catch {
      throw .ioUnavailable
    }
  }
}
