import Darwin
import Foundation

extension SecureDirectory {
  package static func openJournalDirectory(
    trustedRootDescriptor: Int32,
    homeComponents: [String],
    currentUID: UInt32,
    backend: any DarwinFileSystemBackend
  ) throws(SecureDirectoryError) -> SecureDirectory {
    guard !homeComponents.isEmpty else { throw .invalidComponent }
    for component in homeComponents { try validateComponent(component) }

    let rootMetadata = try mapBootstrapBackend {
      try backend.metadata(descriptor: trustedRootDescriptor)
    }
    try validateSystemAncestor(rootMetadata)
    try validateBootstrapFileSystem(
      try mapBootstrapBackend {
        try backend.fileSystemIdentity(descriptor: trustedRootDescriptor)
      }
    )

    var parent = trustedRootDescriptor
    var ownedParent: Int32?
    do {
      for (index, component) in homeComponents.enumerated() {
        let descriptor: Int32
        do {
          descriptor = try backend.openDirectory(at: parent, component: component)
        } catch .symlink {
          throw SecureDirectoryError.symlink
        } catch .notDirectory {
          throw SecureDirectoryError.notDirectory
        } catch {
          throw SecureDirectoryError.ioUnavailable
        }

        do {
          let metadata = try mapBootstrapBackend {
            try backend.metadata(descriptor: descriptor)
          }
          if index == homeComponents.count - 1 {
            try validateHomeAncestor(metadata, currentUID: currentUID)
          } else {
            try validateSystemAncestor(metadata)
          }
          try validateBootstrapFileSystem(
            try mapBootstrapBackend {
              try backend.fileSystemIdentity(descriptor: descriptor)
            }
          )
        } catch {
          backend.close(descriptor: descriptor)
          throw error
        }

        if let ownedParent { backend.close(descriptor: ownedParent) }
        ownedParent = descriptor
        parent = descriptor
      }

      guard let homeDescriptor = ownedParent else { throw SecureDirectoryError.ioUnavailable }
      let directory = try openJournalDirectory(
        trustedHomeDescriptor: homeDescriptor,
        currentUID: currentUID,
        backend: backend
      )
      backend.close(descriptor: homeDescriptor)
      ownedParent = nil
      return directory
    } catch let error as SecureDirectoryError {
      if let ownedParent { backend.close(descriptor: ownedParent) }
      throw error
    } catch {
      if let ownedParent { backend.close(descriptor: ownedParent) }
      throw .ioUnavailable
    }
  }

  package static func openLiveJournalDirectory() throws(SecureDirectoryError) -> SecureDirectory {
    let backend = LiveDarwinFileSystemBackend()
    let currentUID = Darwin.getuid()
    let homeComponents = try resolvedHomeComponents(for: currentUID)
    let rootDescriptor: Int32
    do {
      rootDescriptor = try backend.openRootDirectory()
    } catch {
      throw .ioUnavailable
    }
    defer { backend.close(descriptor: rootDescriptor) }
    return try openJournalDirectory(
      trustedRootDescriptor: rootDescriptor,
      homeComponents: homeComponents,
      currentUID: currentUID,
      backend: backend
    )
  }

  private static func resolvedHomeComponents(for userID: UInt32)
    throws(SecureDirectoryError) -> [String]
  {
    let configuredSize = Darwin.sysconf(_SC_GETPW_R_SIZE_MAX)
    let bufferSize = configuredSize > 0 ? min(Int(configuredSize), 1_048_576) : 16_384
    var entry = passwd()
    var result: UnsafeMutablePointer<passwd>?
    var buffer = [CChar](repeating: 0, count: bufferSize)
    let path: String? = buffer.withUnsafeMutableBufferPointer { pointer in
      let status = Darwin.getpwuid_r(
        userID,
        &entry,
        pointer.baseAddress,
        pointer.count,
        &result
      )
      guard status == 0, result != nil, let home = entry.pw_dir else { return nil }
      return String(validatingCString: home)
    }
    guard let path, path.first == "/", path.count > 1 else { throw .ioUnavailable }
    let remainder = path.dropFirst()
    let components = remainder.split(separator: "/", omittingEmptySubsequences: false)
      .map(String.init)
    guard !components.isEmpty, components.allSatisfy({ !$0.isEmpty }) else {
      throw .invalidComponent
    }
    for component in components { try validateComponent(component) }
    return components
  }

  private static func validateSystemAncestor(_ metadata: DarwinNodeMetadata)
    throws(SecureDirectoryError)
  {
    guard metadata.kind == .directory else { throw .notDirectory }
    guard metadata.owner == 0 else { throw .wrongOwner }
    guard metadata.mode & 0o022 == 0 else { throw .unsafeAncestor }
  }

  private static func validateHomeAncestor(
    _ metadata: DarwinNodeMetadata,
    currentUID: UInt32
  ) throws(SecureDirectoryError) {
    guard metadata.kind == .directory else { throw .notDirectory }
    guard metadata.owner == currentUID else { throw .wrongOwner }
    guard metadata.mode & 0o022 == 0 else { throw .unsafeAncestor }
  }

  private static func validateBootstrapFileSystem(_ identity: DarwinFileSystemIdentity)
    throws(SecureDirectoryError)
  {
    guard identity.isLocal, identity.typeName == "apfs" else {
      throw .unsupportedFilesystem
    }
  }

  private static func mapBootstrapBackend<T>(_ operation: () throws -> T)
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
