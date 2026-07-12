import Darwin
import Foundation

@_silgen_name("flock")
private func recursFlock(_ descriptor: Int32, _ operation: Int32) -> Int32

package struct LiveDarwinFileSystemBackend: DarwinFileSystemBackend, Sendable {
  package init() {}

  private func mappedErrno(_ value: Int32 = errno) -> DarwinFileSystemBackendError {
    switch value {
    case ENOENT: .notFound
    case EEXIST: .alreadyExists
    case EINTR: .interrupted
    case EWOULDBLOCK: .wouldBlock
    case ELOOP: .symlink
    case ENOTDIR: .notDirectory
    default: .unavailable
    }
  }

  package func openRootDirectory() throws(DarwinFileSystemBackendError) -> Int32 {
    let result = Darwin.open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard result >= 0 else { throw mappedErrno() }
    return result
  }

  package func openDirectory(at descriptor: Int32, component: String)
    throws(DarwinFileSystemBackendError) -> Int32
  {
    let result = Darwin.openat(
      descriptor,
      component,
      O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
    )
    guard result >= 0 else { throw mappedErrno() }
    return result
  }

  package func createDirectory(at descriptor: Int32, component: String, mode: UInt16)
    throws(DarwinFileSystemBackendError)
  {
    guard Darwin.mkdirat(descriptor, component, mode_t(mode)) == 0 else {
      throw mappedErrno()
    }
  }

  package func openReadOnlyFile(at descriptor: Int32, basename: String)
    throws(DarwinFileSystemBackendError) -> Int32
  {
    let result = Darwin.openat(descriptor, basename, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
    guard result >= 0 else { throw mappedErrno() }
    return result
  }

  package func openReadWriteFile(at descriptor: Int32, basename: String)
    throws(DarwinFileSystemBackendError) -> Int32
  {
    let result = Darwin.openat(descriptor, basename, O_RDWR | O_NOFOLLOW | O_CLOEXEC)
    guard result >= 0 else { throw mappedErrno() }
    return result
  }

  package func createExclusiveFile(at descriptor: Int32, basename: String, mode: UInt16)
    throws(DarwinFileSystemBackendError) -> Int32
  {
    let result = Darwin.openat(
      descriptor,
      basename,
      O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
      mode_t(mode)
    )
    guard result >= 0 else { throw mappedErrno() }
    return result
  }

  package func createExclusiveLockFile(at descriptor: Int32, basename: String, mode: UInt16)
    throws(DarwinFileSystemBackendError) -> Int32
  {
    let result = Darwin.openat(
      descriptor,
      basename,
      O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
      mode_t(mode)
    )
    guard result >= 0 else { throw mappedErrno() }
    return result
  }

  package func setMode(descriptor: Int32, mode: UInt16) throws(DarwinFileSystemBackendError) {
    guard Darwin.fchmod(descriptor, mode_t(mode)) == 0 else { throw mappedErrno() }
  }

  package func metadata(descriptor: Int32)
    throws(DarwinFileSystemBackendError) -> DarwinNodeMetadata
  {
    var value = stat()
    guard Darwin.fstat(descriptor, &value) == 0 else { throw mappedErrno() }
    let kind: DarwinNodeKind =
      switch value.st_mode & S_IFMT {
      case S_IFDIR: .directory
      case S_IFREG: .regularFile
      case S_IFLNK: .symbolicLink
      default: .other
      }
    return DarwinNodeMetadata(
      kind: kind,
      owner: value.st_uid,
      mode: UInt16(value.st_mode & 0o7777),
      linkCount: UInt64(value.st_nlink),
      device: UInt64(value.st_dev),
      inode: UInt64(value.st_ino),
      size: value.st_size < 0 ? 0 : UInt64(value.st_size),
      hasExtendedACL: try hasExtendedACL(descriptor: descriptor)
    )
  }

  private func hasExtendedACL(descriptor: Int32) throws(DarwinFileSystemBackendError) -> Bool {
    errno = 0
    guard let acl = acl_get_fd_np(descriptor, ACL_TYPE_EXTENDED) else {
      if errno == ENOENT { return false }
      throw mappedErrno()
    }
    defer { acl_free(UnsafeMutableRawPointer(acl)) }
    var entry: acl_entry_t?
    let result = acl_get_entry(acl, Int32(ACL_FIRST_ENTRY.rawValue), &entry)
    if result == 1 { return true }
    if result == 0 { return false }
    throw mappedErrno()
  }

  package func fileSystemIdentity(descriptor: Int32)
    throws(DarwinFileSystemBackendError) -> DarwinFileSystemIdentity
  {
    var value = statfs()
    guard Darwin.fstatfs(descriptor, &value) == 0 else { throw mappedErrno() }
    let typeName = withUnsafePointer(to: &value.f_fstypename) { pointer in
      pointer.withMemoryRebound(to: CChar.self, capacity: 16) { String(cString: $0) }
    }
    return DarwinFileSystemIdentity(
      isLocal: (UInt32(value.f_flags) & UInt32(MNT_LOCAL)) != 0,
      typeName: typeName
    )
  }

  package func openDirectoryForEnumeration(at descriptor: Int32)
    throws(DarwinFileSystemBackendError) -> Int32
  {
    let result = Darwin.openat(
      descriptor,
      ".",
      O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC
    )
    guard result >= 0 else { throw mappedErrno() }
    return result
  }

  package func directoryEntries(consuming descriptor: Int32)
    throws(DarwinFileSystemBackendError) -> [String]
  {
    guard let directory = fdopendir(descriptor) else {
      Darwin.close(descriptor)
      throw mappedErrno()
    }
    defer { closedir(directory) }

    var entries: [String] = []
    errno = 0
    while let entry = readdir(directory) {
      let name = withUnsafePointer(to: &entry.pointee.d_name) { pointer in
        pointer.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) {
          String(cString: $0)
        }
      }
      entries.append(name)
      errno = 0
    }
    guard errno == 0 else { throw mappedErrno() }
    return entries
  }

  package func read(descriptor: Int32, maximumCount: Int)
    throws(DarwinFileSystemBackendError) -> Data
  {
    var bytes = [UInt8](repeating: 0, count: maximumCount)
    let count = bytes.withUnsafeMutableBytes { buffer in
      Darwin.read(descriptor, buffer.baseAddress, maximumCount)
    }
    guard count >= 0 else { throw mappedErrno() }
    return Data(bytes.prefix(count))
  }

  package func write(descriptor: Int32, data: Data)
    throws(DarwinFileSystemBackendError) -> Int
  {
    let count: Int = data.withUnsafeBytes { bytes in
      guard let baseAddress = bytes.baseAddress else { return 0 }
      return Darwin.write(descriptor, baseAddress, bytes.count)
    }
    guard count >= 0 else { throw mappedErrno() }
    return count
  }

  package func fullSync(descriptor: Int32) throws(DarwinFileSystemBackendError) {
    guard Darwin.fcntl(descriptor, F_FULLFSYNC) == 0 else { throw .durabilityUnknown }
  }

  package func syncDirectory(descriptor: Int32) throws(DarwinFileSystemBackendError) {
    guard Darwin.fsync(descriptor) == 0 else { throw .durabilityUnknown }
  }

  package func rename(
    in descriptor: Int32,
    from sourceBasename: String,
    to destinationBasename: String
  ) throws(DarwinFileSystemBackendError) {
    guard Darwin.renameat(descriptor, sourceBasename, descriptor, destinationBasename) == 0 else {
      throw mappedErrno()
    }
  }

  package func renameExclusive(
    in descriptor: Int32,
    from sourceBasename: String,
    to destinationBasename: String
  ) throws(DarwinFileSystemBackendError) {
    guard
      Darwin.renameatx_np(
        descriptor,
        sourceBasename,
        descriptor,
        destinationBasename,
        UInt32(RENAME_EXCL)
      ) == 0
    else {
      throw mappedErrno()
    }
  }

  package func unlink(at descriptor: Int32, basename: String)
    throws(DarwinFileSystemBackendError)
  {
    guard Darwin.unlinkat(descriptor, basename, 0) == 0 else { throw mappedErrno() }
  }

  package func lockExclusiveNonblocking(descriptor: Int32)
    throws(DarwinFileSystemBackendError)
  {
    guard recursFlock(descriptor, LOCK_EX | LOCK_NB) == 0 else { throw mappedErrno() }
  }

  package func unlock(descriptor: Int32) {
    _ = recursFlock(descriptor, LOCK_UN)
  }

  package func close(descriptor: Int32) {
    _ = Darwin.close(descriptor)
  }
}
