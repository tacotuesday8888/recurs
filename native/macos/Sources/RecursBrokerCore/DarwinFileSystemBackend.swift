import Foundation

package enum DarwinFileSystemBackendError: Error, Sendable, Equatable {
  case notFound
  case alreadyExists
  case interrupted
  case wouldBlock
  case symlink
  case notDirectory
  case durabilityUnknown
  case unavailable
}

package enum DarwinNodeKind: Sendable, Equatable {
  case directory
  case regularFile
  case symbolicLink
  case other
}

package struct DarwinNodeMetadata: Sendable, Equatable {
  package let kind: DarwinNodeKind
  package let owner: UInt32
  package let mode: UInt16
  package let linkCount: UInt64
  package let device: UInt64
  package let inode: UInt64
  package let size: UInt64
  package let hasExtendedACL: Bool

  package init(
    kind: DarwinNodeKind,
    owner: UInt32,
    mode: UInt16,
    linkCount: UInt64,
    device: UInt64,
    inode: UInt64,
    size: UInt64,
    hasExtendedACL: Bool
  ) {
    self.kind = kind
    self.owner = owner
    self.mode = mode
    self.linkCount = linkCount
    self.device = device
    self.inode = inode
    self.size = size
    self.hasExtendedACL = hasExtendedACL
  }
}

package struct DarwinFileSystemIdentity: Sendable, Equatable {
  package let isLocal: Bool
  package let typeName: String

  package init(isLocal: Bool, typeName: String) {
    self.isLocal = isLocal
    self.typeName = typeName
  }
}

package protocol DarwinFileSystemBackend: Sendable {
  func openRootDirectory() throws(DarwinFileSystemBackendError) -> Int32
  func openDirectory(at descriptor: Int32, component: String)
    throws(DarwinFileSystemBackendError) -> Int32
  func createDirectory(at descriptor: Int32, component: String, mode: UInt16)
    throws(DarwinFileSystemBackendError)
  func openReadOnlyFile(at descriptor: Int32, basename: String)
    throws(DarwinFileSystemBackendError) -> Int32
  func openReadWriteFile(at descriptor: Int32, basename: String)
    throws(DarwinFileSystemBackendError) -> Int32
  func createExclusiveFile(at descriptor: Int32, basename: String, mode: UInt16)
    throws(DarwinFileSystemBackendError) -> Int32
  func setMode(descriptor: Int32, mode: UInt16) throws(DarwinFileSystemBackendError)
  func metadata(descriptor: Int32) throws(DarwinFileSystemBackendError) -> DarwinNodeMetadata
  func fileSystemIdentity(descriptor: Int32)
    throws(DarwinFileSystemBackendError) -> DarwinFileSystemIdentity
  func directoryEntries(descriptor: Int32) throws(DarwinFileSystemBackendError) -> [String]
  func read(descriptor: Int32, maximumCount: Int)
    throws(DarwinFileSystemBackendError) -> Data
  func write(descriptor: Int32, data: Data)
    throws(DarwinFileSystemBackendError) -> Int
  func fullSync(descriptor: Int32) throws(DarwinFileSystemBackendError)
  func syncDirectory(descriptor: Int32) throws(DarwinFileSystemBackendError)
  func rename(
    in descriptor: Int32,
    from sourceBasename: String,
    to destinationBasename: String
  ) throws(DarwinFileSystemBackendError)
  func unlink(at descriptor: Int32, basename: String) throws(DarwinFileSystemBackendError)
  func lockExclusiveNonblocking(descriptor: Int32) throws(DarwinFileSystemBackendError)
  func unlock(descriptor: Int32)
  func close(descriptor: Int32)
}
