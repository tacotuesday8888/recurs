import Foundation

package enum SecureDirectoryError:
  Error,
  Sendable,
  Equatable,
  CustomStringConvertible,
  CustomDebugStringConvertible,
  LocalizedError,
  CustomReflectable
{
  case invalidComponent
  case unsafeAncestor
  case wrongOwner
  case wrongMode
  case extendedACL
  case symlink
  case notDirectory
  case notRegularFile
  case hardLink
  case deviceMismatch
  case unsupportedFilesystem
  case fileTooLarge
  case ioUnavailable
  case durabilityUnknown

  private var fixedDescription: String {
    switch self {
    case .invalidComponent: "A filesystem component is invalid."
    case .unsafeAncestor: "A filesystem ancestor is unsafe."
    case .wrongOwner: "A filesystem object has the wrong owner."
    case .wrongMode: "A filesystem object has unsafe permissions."
    case .extendedACL: "A filesystem object has an extended access list."
    case .symlink: "A symbolic link is not allowed."
    case .notDirectory: "A required filesystem object is not a directory."
    case .notRegularFile: "A required filesystem object is not a regular file."
    case .hardLink: "A filesystem object has additional hard links."
    case .deviceMismatch: "Filesystem objects are on different devices."
    case .unsupportedFilesystem: "The filesystem is unsupported."
    case .fileTooLarge: "A broker file exceeds its size limit."
    case .ioUnavailable: "Secure filesystem storage is unavailable."
    case .durabilityUnknown: "The durability outcome is unknown."
    }
  }

  package var description: String { fixedDescription }
  package var debugDescription: String { fixedDescription }
  package var errorDescription: String? { fixedDescription }
  package var customMirror: Mirror {
    Mirror(self, children: EmptyCollection<(label: String?, value: Any)>())
  }
}

package struct BrokerJournalSlotIdentity: Sendable, Hashable {
  package let connectionID: UUID
  package let parity: UInt8
}

package struct SecureDirectoryEntries: Sendable, Hashable {
  package let slotBasenames: [String]
  package let temporaryBasenames: [String]
  package let hasLockFile: Bool
}

package struct BrokerAuthorityLease: ~Copyable {
  private let descriptor: Int32
  private let backend: any DarwinFileSystemBackend

  init(descriptor: Int32, backend: any DarwinFileSystemBackend) {
    self.descriptor = descriptor
    self.backend = backend
  }

  package var isHeld: Bool { descriptor >= 0 }

  deinit {
    backend.unlock(descriptor: descriptor)
    backend.close(descriptor: descriptor)
  }
}

package final class SecureDirectory: @unchecked Sendable {
  package static let lockBasename = ".broker-journal-v1.lock"
  package static let maximumEnvelopeBytes = 65_536
  package static let maximumRecognizedEntries = 2_209
  package static let maximumAnchoredConnections = 1_024
  package static let maximumUnanchoredSlots = 128
  package static let maximumTemporaryFiles = 32

  let descriptor: Int32
  let owner: UInt32
  let device: UInt64
  let backend: any DarwinFileSystemBackend

  init(
    descriptor: Int32,
    owner: UInt32,
    device: UInt64,
    backend: any DarwinFileSystemBackend
  ) {
    self.descriptor = descriptor
    self.owner = owner
    self.device = device
    self.backend = backend
  }

  deinit {
    backend.close(descriptor: descriptor)
  }

  package static func validateComponent(_ component: String) throws(SecureDirectoryError) {
    guard
      !component.isEmpty,
      component != ".",
      component != "..",
      !component.contains("/"),
      !component.contains("\0"),
      component.utf8.count <= 255
    else {
      throw .invalidComponent
    }
  }

  package static func slotIdentity(for basename: String)
    throws(SecureDirectoryError) -> BrokerJournalSlotIdentity?
  {
    try validateComponent(basename)
    let parity: UInt8
    let uuidText: Substring
    if basename.hasSuffix(".0.rcbj") {
      parity = 0
      uuidText = basename.dropLast(7)
    } else if basename.hasSuffix(".1.rcbj") {
      parity = 1
      uuidText = basename.dropLast(7)
    } else {
      return nil
    }
    guard
      uuidText.count == 36,
      String(uuidText) == String(uuidText).lowercased(),
      let identifier = UUID(uuidString: String(uuidText)),
      identifier.uuidString.lowercased() == uuidText
    else {
      throw .invalidComponent
    }
    return BrokerJournalSlotIdentity(connectionID: identifier, parity: parity)
  }

  package static func isTemporaryBasename(_ basename: String) throws(SecureDirectoryError) -> Bool {
    try validateComponent(basename)
    guard basename.hasPrefix(".tmp."), basename.hasSuffix(".rcbj") else { return false }
    let uuidText = basename.dropFirst(5).dropLast(5)
    guard
      uuidText.count == 36,
      String(uuidText) == String(uuidText).lowercased(),
      let identifier = UUID(uuidString: String(uuidText)),
      identifier.uuidString.lowercased() == uuidText
    else {
      throw .invalidComponent
    }
    return true
  }
}
