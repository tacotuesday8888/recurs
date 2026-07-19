import Darwin
import Foundation
import RecursNativeSecurity

actor FileBrokerDirectContinuationRecordStore: BrokerDirectContinuationRecordStoring {
  private static let suffix = ".rcdc"
  private static let maximumSealedByteCount =
    BrokerDirectContinuationRecordCodec.maximumEncodedByteCount + 28

  private let directoryDescriptor: Int32
  private let cryptography: any ContinuationRecordCryptographic
  private let codec = BrokerDirectContinuationRecordCodec()

  init(
    directoryURL: URL,
    cryptography: any ContinuationRecordCryptographic
  ) throws(BrokerDirectContinuationRecordError) {
    let descriptor = Darwin.open(directoryURL.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    guard descriptor >= 0 else { throw .unavailable }
    do {
      try Self.validateDirectory(descriptor)
    } catch {
      Darwin.close(descriptor)
      throw .unavailable
    }
    directoryDescriptor = descriptor
    self.cryptography = cryptography
  }

  static func production(
    configuration: KeychainStoreConfiguration
  ) throws(BrokerDirectContinuationRecordError) -> FileBrokerDirectContinuationRecordStore {
    let directory = FileManager.default.homeDirectoryForCurrentUser
      .appending(path: "Library/Application Support/com.recurs.cli/broker/continuations-v1")
    do {
      try FileManager.default.createDirectory(
        at: directory,
        withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700]
      )
      try FileManager.default.setAttributes(
        [.posixPermissions: 0o700],
        ofItemAtPath: directory.path
      )
    } catch {
      throw .unavailable
    }
    return try FileBrokerDirectContinuationRecordStore(
      directoryURL: directory,
      cryptography: ContinuationRecordCryptography.production(configuration: configuration)
    )
  }

  deinit {
    Darwin.close(directoryDescriptor)
  }

  func insert(
    _ record: BrokerDirectContinuationRecord
  ) async throws(BrokerDirectContinuationRecordError) {
    let basename = try Self.basename(record.handle.id)
    let plaintext: Data
    let sealed: Data
    do {
      plaintext = try codec.encode(record)
      sealed = try await cryptography.seal(
        plaintext,
        authenticating: Self.context(record.handle.id)
      )
    } catch {
      throw .unavailable
    }
    guard sealed.count <= Self.maximumSealedByteCount else { throw .unavailable }

    let temporary = ".tmp.\(UUID().uuidString.lowercased())\(Self.suffix)"
    let descriptor = Darwin.openat(
      directoryDescriptor,
      temporary,
      O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW,
      mode_t(0o600)
    )
    guard descriptor >= 0 else { throw .unavailable }
    var renamed = false
    defer {
      Darwin.close(descriptor)
      if !renamed { _ = Darwin.unlinkat(directoryDescriptor, temporary, 0) }
    }
    guard Darwin.fchmod(descriptor, mode_t(0o600)) == 0,
      Self.writeAll(sealed, to: descriptor),
      Darwin.fsync(descriptor) == 0
    else { throw .unavailable }
    let renameStatus = Darwin.renameatx_np(
      directoryDescriptor,
      temporary,
      directoryDescriptor,
      basename,
      UInt32(RENAME_EXCL)
    )
    guard renameStatus == 0 else {
      if errno == EEXIST { throw .conflict }
      throw .unavailable
    }
    renamed = true
    guard Darwin.fsync(directoryDescriptor) == 0 else { throw .unavailable }
  }

  func read(
    id: String
  ) async throws(BrokerDirectContinuationRecordError) -> BrokerDirectContinuationRecord? {
    let basename = try Self.basename(id)
    let descriptor = Darwin.openat(directoryDescriptor, basename, O_RDONLY | O_NOFOLLOW)
    guard descriptor >= 0 else {
      if errno == ENOENT { return nil }
      throw .unavailable
    }
    defer { Darwin.close(descriptor) }
    let sealed = try Self.readValidatedFile(descriptor)
    do {
      let plaintext = try await cryptography.open(sealed, authenticating: Self.context(id))
      let record = try codec.decode(plaintext)
      guard record.handle.id == id else { throw BrokerDirectContinuationRecordError.unavailable }
      return record
    } catch {
      throw .unavailable
    }
  }

  func remove(id: String) async throws(BrokerDirectContinuationRecordError) {
    guard try await read(id: id) != nil else { return }
    let basename = try Self.basename(id)
    guard Darwin.unlinkat(directoryDescriptor, basename, 0) == 0 else {
      if errno == ENOENT { return }
      throw .unavailable
    }
    guard Darwin.fsync(directoryDescriptor) == 0 else { throw .unavailable }
  }

  private static func basename(
    _ id: String
  ) throws(BrokerDirectContinuationRecordError) -> String {
    guard id == id.lowercased(), UUID(uuidString: id)?.uuidString.lowercased() == id else {
      throw .unavailable
    }
    return id + suffix
  }

  private static func context(_ id: String) -> Data {
    Data("recurs.direct-continuation.v1\0\(id)".utf8)
  }

  private static func validateDirectory(_ descriptor: Int32) throws {
    var metadata = stat()
    guard Darwin.fstat(descriptor, &metadata) == 0,
      metadata.st_uid == Darwin.getuid(),
      metadata.st_mode & S_IFMT == S_IFDIR,
      metadata.st_mode & 0o777 == 0o700
    else { throw BrokerDirectContinuationRecordError.unavailable }
  }

  private static func readValidatedFile(
    _ descriptor: Int32
  ) throws(BrokerDirectContinuationRecordError) -> Data {
    var initial = stat()
    guard Darwin.fstat(descriptor, &initial) == 0,
      initial.st_uid == Darwin.getuid(),
      initial.st_mode & S_IFMT == S_IFREG,
      initial.st_mode & 0o777 == 0o600,
      initial.st_nlink == 1,
      initial.st_size > 0,
      initial.st_size <= maximumSealedByteCount
    else { throw .unavailable }
    var result = Data(repeating: 0, count: Int(initial.st_size))
    let totalByteCount = result.count
    var offset = 0
    while offset < totalByteCount {
      let count = result.withUnsafeMutableBytes { bytes in
        Darwin.read(
          descriptor,
          bytes.baseAddress!.advanced(by: offset),
          totalByteCount - offset
        )
      }
      if count < 0, errno == EINTR { continue }
      guard count > 0 else { throw .unavailable }
      offset += count
    }
    var final = stat()
    guard Darwin.fstat(descriptor, &final) == 0,
      initial.st_dev == final.st_dev,
      initial.st_ino == final.st_ino,
      initial.st_size == final.st_size
    else { throw .unavailable }
    return result
  }

  private static func writeAll(_ data: Data, to descriptor: Int32) -> Bool {
    var offset = 0
    return data.withUnsafeBytes { bytes in
      while offset < data.count {
        let count = Darwin.write(
          descriptor,
          bytes.baseAddress!.advanced(by: offset),
          data.count - offset
        )
        if count < 0, errno == EINTR { continue }
        guard count > 0 else { return false }
        offset += count
      }
      return true
    }
  }
}
