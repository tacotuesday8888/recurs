import Foundation

@testable import RecursBrokerCore

final class ScriptedDarwinFileSystemBackend: DarwinFileSystemBackend, @unchecked Sendable {
  enum Operation: Hashable {
    case openDirectory
    case openRoot
    case createDirectory
    case openReadOnly
    case openReadWrite
    case createFile
    case setMode
    case metadata
    case fileSystem
    case entries
    case read
    case write
    case fullSync
    case directorySync
    case rename
    case unlink
    case lock
  }

  final class Node {
    var kind: DarwinNodeKind
    var owner: UInt32
    var mode: UInt16
    var linkCount: UInt64
    var device: UInt64
    var inode: UInt64
    var hasExtendedACL = false
    var isLocal = true
    var fileSystemType = "apfs"
    var content = Data()
    var children: [String: Node] = [:]
    var locked = false

    init(
      kind: DarwinNodeKind,
      owner: UInt32,
      mode: UInt16,
      linkCount: UInt64 = 1,
      device: UInt64,
      inode: UInt64
    ) {
      self.kind = kind
      self.owner = owner
      self.mode = mode
      self.linkCount = linkCount
      self.device = device
      self.inode = inode
    }
  }

  private struct Handle {
    let node: Node
    var offset: Int
  }

  let rootDescriptor: Int32 = 10
  let currentUID: UInt32 = 501
  private(set) var calls: [Operation] = []
  private(set) var closedDescriptors: [Int32] = []
  private(set) var unlinkedBasenames: [String] = []
  private(set) var renamedPairs: [(String, String)] = []
  var maximumReadCount = Int.max
  var maximumWriteCount = Int.max
  var afterOpenReadOnly: ((Int) -> Void)?
  var afterRead: ((Int) -> Void)?
  var beforeFullSync: (() -> Void)?
  var afterFullSync: (() -> Void)?
  private(set) var openReadOnlyCount = 0
  private(set) var readCount = 0

  private var nextDescriptor: Int32 = 11
  private var nextInode: UInt64 = 100
  private var handles: [Int32: Handle] = [:]
  private var failures: [Operation: [DarwinFileSystemBackendError]] = [:]

  init(systemHomePath: String? = nil) {
    let root = Node(
      kind: .directory,
      owner: systemHomePath == nil ? currentUID : 0,
      mode: systemHomePath == nil ? 0o700 : 0o755,
      device: 7,
      inode: 1
    )
    handles[rootDescriptor] = Handle(node: root, offset: 0)
    if let systemHomePath {
      let components = systemHomePath.split(separator: "/").map(String.init)
      var prefix = ""
      for (index, component) in components.enumerated() {
        prefix = prefix.isEmpty ? component : "\(prefix)/\(component)"
        _ = addDirectory(
          prefix,
          owner: index == components.count - 1 ? currentUID : 0,
          mode: index == components.count - 1 ? 0o700 : 0o755
        )
      }
      _ = addDirectory("\(systemHomePath)/Library", mode: 0o700)
      _ = addDirectory("\(systemHomePath)/Library/Application Support", mode: 0o700)
    } else {
      _ = addDirectory("Library", mode: 0o700)
      _ = addDirectory("Library/Application Support", mode: 0o700)
    }
  }

  func failNext(_ operation: Operation, with error: DarwinFileSystemBackendError) {
    failures[operation, default: []].append(error)
  }

  @discardableResult
  func addDirectory(
    _ path: String,
    owner: UInt32? = nil,
    mode: UInt16 = 0o700,
    device: UInt64 = 7
  ) -> Node {
    let components = path.split(separator: "/").map(String.init)
    var current = handles[rootDescriptor]!.node
    for component in components {
      if let child = current.children[component] {
        current = child
      } else {
        let child = Node(
          kind: .directory,
          owner: owner ?? currentUID,
          mode: mode,
          device: device,
          inode: allocateInode()
        )
        current.children[component] = child
        current = child
      }
    }
    return current
  }

  @discardableResult
  func addFile(
    _ path: String,
    data: Data = Data(),
    owner: UInt32? = nil,
    mode: UInt16 = 0o600,
    linkCount: UInt64 = 1,
    device: UInt64 = 7,
    kind: DarwinNodeKind = .regularFile
  ) -> Node {
    let components = path.split(separator: "/").map(String.init)
    let parentPath = components.dropLast().joined(separator: "/")
    let parent = addDirectory(parentPath)
    let node = Node(
      kind: kind,
      owner: owner ?? currentUID,
      mode: mode,
      linkCount: linkCount,
      device: device,
      inode: allocateInode()
    )
    node.content = data
    parent.children[components.last!] = node
    return node
  }

  func node(_ path: String) -> Node? {
    var current = handles[rootDescriptor]?.node
    for component in path.split(separator: "/").map(String.init) {
      current = current?.children[component]
    }
    return current
  }

  var activeOwnedDescriptorCount: Int {
    handles.keys.filter { $0 != rootDescriptor }.count
  }

  @discardableResult
  func replaceDirectory(_ path: String) -> Node {
    replaceNode(path, kind: .directory, mode: 0o700)
  }

  @discardableResult
  func replaceFile(_ path: String, data: Data = Data()) -> Node {
    let node = replaceNode(path, kind: .regularFile, mode: 0o600)
    node.content = data
    return node
  }

  private func replaceNode(_ path: String, kind: DarwinNodeKind, mode: UInt16) -> Node {
    let components = path.split(separator: "/").map(String.init)
    let parentPath = components.dropLast().joined(separator: "/")
    let parent = addDirectory(parentPath)
    let node = Node(
      kind: kind,
      owner: currentUID,
      mode: mode,
      device: parent.device,
      inode: allocateInode()
    )
    parent.children[components.last!] = node
    return node
  }

  private func allocateInode() -> UInt64 {
    defer { nextInode += 1 }
    return nextInode
  }

  private func scripted(_ operation: Operation) throws(DarwinFileSystemBackendError) {
    calls.append(operation)
    guard var queue = failures[operation], !queue.isEmpty else { return }
    let error = queue.removeFirst()
    failures[operation] = queue
    throw error
  }

  private func handle(_ descriptor: Int32) throws(DarwinFileSystemBackendError) -> Handle {
    guard let handle = handles[descriptor] else { throw .unavailable }
    return handle
  }

  private func allocateHandle(_ node: Node) -> Int32 {
    let descriptor = nextDescriptor
    nextDescriptor += 1
    handles[descriptor] = Handle(node: node, offset: 0)
    return descriptor
  }

  func openDirectory(at descriptor: Int32, component: String)
    throws(DarwinFileSystemBackendError) -> Int32
  {
    try scripted(.openDirectory)
    let parent = try handle(descriptor).node
    guard let node = parent.children[component] else { throw .notFound }
    if node.kind == .symbolicLink { throw .symlink }
    guard node.kind == .directory else { throw .notDirectory }
    return allocateHandle(node)
  }

  func openRootDirectory() throws(DarwinFileSystemBackendError) -> Int32 {
    try scripted(.openRoot)
    return allocateHandle(try handle(rootDescriptor).node)
  }

  func createDirectory(at descriptor: Int32, component: String, mode: UInt16)
    throws(DarwinFileSystemBackendError)
  {
    try scripted(.createDirectory)
    let parent = try handle(descriptor).node
    guard parent.children[component] == nil else { throw .alreadyExists }
    parent.children[component] = Node(
      kind: .directory,
      owner: currentUID,
      mode: mode,
      device: parent.device,
      inode: allocateInode()
    )
  }

  func openReadOnlyFile(at descriptor: Int32, basename: String)
    throws(DarwinFileSystemBackendError) -> Int32
  {
    try scripted(.openReadOnly)
    let result = try openFile(at: descriptor, basename: basename)
    openReadOnlyCount += 1
    afterOpenReadOnly?(openReadOnlyCount)
    return result
  }

  func openReadWriteFile(at descriptor: Int32, basename: String)
    throws(DarwinFileSystemBackendError) -> Int32
  {
    try scripted(.openReadWrite)
    return try openFile(at: descriptor, basename: basename)
  }

  private func openFile(at descriptor: Int32, basename: String)
    throws(DarwinFileSystemBackendError) -> Int32
  {
    let parent = try handle(descriptor).node
    guard let node = parent.children[basename] else { throw .notFound }
    if node.kind == .symbolicLink { throw .symlink }
    return allocateHandle(node)
  }

  func createExclusiveFile(at descriptor: Int32, basename: String, mode: UInt16)
    throws(DarwinFileSystemBackendError) -> Int32
  {
    try scripted(.createFile)
    let parent = try handle(descriptor).node
    guard parent.children[basename] == nil else { throw .alreadyExists }
    let node = Node(
      kind: .regularFile,
      owner: currentUID,
      mode: mode,
      device: parent.device,
      inode: allocateInode()
    )
    parent.children[basename] = node
    return allocateHandle(node)
  }

  func setMode(descriptor: Int32, mode: UInt16) throws(DarwinFileSystemBackendError) {
    try scripted(.setMode)
    try handle(descriptor).node.mode = mode
  }

  func metadata(descriptor: Int32)
    throws(DarwinFileSystemBackendError) -> DarwinNodeMetadata
  {
    try scripted(.metadata)
    let node = try handle(descriptor).node
    return DarwinNodeMetadata(
      kind: node.kind,
      owner: node.owner,
      mode: node.mode,
      linkCount: node.linkCount,
      device: node.device,
      inode: node.inode,
      size: UInt64(node.content.count),
      hasExtendedACL: node.hasExtendedACL
    )
  }

  func fileSystemIdentity(descriptor: Int32)
    throws(DarwinFileSystemBackendError) -> DarwinFileSystemIdentity
  {
    try scripted(.fileSystem)
    let node = try handle(descriptor).node
    return DarwinFileSystemIdentity(isLocal: node.isLocal, typeName: node.fileSystemType)
  }

  func directoryEntries(descriptor: Int32)
    throws(DarwinFileSystemBackendError) -> [String]
  {
    try scripted(.entries)
    return [".", ".."] + (try handle(descriptor).node.children.keys.sorted())
  }

  func read(descriptor: Int32, maximumCount: Int)
    throws(DarwinFileSystemBackendError) -> Data
  {
    try scripted(.read)
    var handle = try handle(descriptor)
    let count = min(maximumCount, maximumReadCount, handle.node.content.count - handle.offset)
    guard count > 0 else { return Data() }
    let result = handle.node.content.subdata(in: handle.offset..<(handle.offset + count))
    handle.offset += count
    handles[descriptor] = handle
    readCount += 1
    afterRead?(readCount)
    return result
  }

  func write(descriptor: Int32, data: Data)
    throws(DarwinFileSystemBackendError) -> Int
  {
    try scripted(.write)
    var handle = try handle(descriptor)
    let count = min(maximumWriteCount, data.count)
    guard count > 0 else { return 0 }
    if handle.offset < handle.node.content.count {
      handle.node.content.replaceSubrange(
        handle.offset..<min(handle.node.content.count, handle.offset + count),
        with: data.prefix(count)
      )
    } else {
      handle.node.content.append(data.prefix(count))
    }
    handle.offset += count
    handles[descriptor] = handle
    return count
  }

  func fullSync(descriptor: Int32) throws(DarwinFileSystemBackendError) {
    beforeFullSync?()
    try scripted(.fullSync)
    _ = try handle(descriptor)
    afterFullSync?()
  }

  func syncDirectory(descriptor: Int32) throws(DarwinFileSystemBackendError) {
    try scripted(.directorySync)
    _ = try handle(descriptor)
  }

  func rename(
    in descriptor: Int32,
    from sourceBasename: String,
    to destinationBasename: String
  ) throws(DarwinFileSystemBackendError) {
    try scripted(.rename)
    let parent = try handle(descriptor).node
    guard let source = parent.children.removeValue(forKey: sourceBasename) else {
      throw .notFound
    }
    parent.children[destinationBasename] = source
    renamedPairs.append((sourceBasename, destinationBasename))
  }

  func unlink(at descriptor: Int32, basename: String) throws(DarwinFileSystemBackendError) {
    try scripted(.unlink)
    let parent = try handle(descriptor).node
    guard parent.children.removeValue(forKey: basename) != nil else { throw .notFound }
    unlinkedBasenames.append(basename)
  }

  func lockExclusiveNonblocking(descriptor: Int32) throws(DarwinFileSystemBackendError) {
    try scripted(.lock)
    let node = try handle(descriptor).node
    guard !node.locked else { throw .wouldBlock }
    node.locked = true
  }

  func unlock(descriptor: Int32) {
    try? handle(descriptor).node.locked = false
  }

  func close(descriptor: Int32) {
    closedDescriptors.append(descriptor)
    if descriptor != rootDescriptor { handles.removeValue(forKey: descriptor) }
  }
}
