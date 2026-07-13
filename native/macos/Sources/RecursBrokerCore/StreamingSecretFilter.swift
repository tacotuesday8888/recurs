import Darwin
import Foundation

package enum StreamingSecretFilterError:
  Error,
  Sendable,
  Equatable,
  CustomStringConvertible,
  CustomDebugStringConvertible,
  LocalizedError
{
  case emptyPattern
  case patternLimitExceeded
  case credentialEchoDetected
  case alreadyFinished
  case cancelled

  private var fixedDescription: String {
    switch self {
    case .emptyPattern:
      "The secret filter pattern is empty."
    case .patternLimitExceeded:
      "The secret filter pattern limit was exceeded."
    case .credentialEchoDetected:
      "A provider response contained credential material."
    case .alreadyFinished:
      "The secret filter has already finished."
    case .cancelled:
      "The secret filter was cancelled."
    }
  }

  package var description: String { fixedDescription }
  package var debugDescription: String { fixedDescription }
  package var errorDescription: String? { fixedDescription }
}

package final class StreamingSecretFilter: @unchecked Sendable, CustomReflectable {
  private static let maximumPatternCount = 8
  private static let maximumAggregatePatternByteCount = 65_536

  private enum TerminalState {
    case active
    case finished
    case cancelled
    case credentialEchoDetected
  }

  private let lock = NSLock()
  private var patterns: [WipingByteBuffer]
  private var failureTables: [[Int]]
  private var matchLengths: [Int]
  private let lookbehind: WipingRingBuffer
  private var state = TerminalState.active

  package init(patterns suppliedPatterns: [SecretBytes]) throws(StreamingSecretFilterError) {
    defer {
      for pattern in suppliedPatterns {
        pattern.erase()
      }
    }
    guard !suppliedPatterns.isEmpty else {
      throw .emptyPattern
    }
    guard suppliedPatterns.count <= Self.maximumPatternCount else {
      throw .patternLimitExceeded
    }

    var copied: [WipingByteBuffer] = []
    copied.reserveCapacity(suppliedPatterns.count)
    var aggregateByteCount = 0
    var maximumPatternByteCount = 0
    for pattern in suppliedPatterns {
      let byteCount = pattern.withUnsafeBytes(\.count)
      guard byteCount > 0 else {
        throw .emptyPattern
      }
      let (nextAggregateByteCount, overflowed) = aggregateByteCount.addingReportingOverflow(
        byteCount
      )
      guard
        !overflowed,
        nextAggregateByteCount <= Self.maximumAggregatePatternByteCount
      else {
        throw .patternLimitExceeded
      }

      let candidate = pattern.withUnsafeBytes(WipingByteBuffer.init(copying:))
      if copied.contains(where: { $0.elementsEqual(candidate) }) {
        candidate.wipe()
        continue
      }
      copied.append(candidate)
      aggregateByteCount = nextAggregateByteCount
      maximumPatternByteCount = max(maximumPatternByteCount, byteCount)
    }

    patterns = copied
    failureTables = copied.map(Self.failureTable)
    matchLengths = [Int](repeating: 0, count: copied.count)
    lookbehind = WipingRingBuffer(capacity: maximumPatternByteCount)
  }

  deinit {
    eraseStorageLocked()
  }

  package nonisolated var customMirror: Mirror {
    let children: [(label: String?, value: Any)] = []
    return Mirror(self, children: children, displayStyle: .class)
  }

  var bufferedByteCount: Int {
    lock.lock()
    defer { lock.unlock() }
    return state == .active ? lookbehind.count : 0
  }

  var storageOperationCount: Int {
    lock.lock()
    defer { lock.unlock() }
    return lookbehind.operationCount
  }

  package func process(_ chunk: Data) throws(StreamingSecretFilterError) -> Data {
    lock.lock()
    defer { lock.unlock() }
    try requireActiveLocked()
    guard !chunk.isEmpty else { return Data() }

    var output: [UInt8] = []
    output.reserveCapacity(chunk.count)
    for byte in chunk {
      for index in patterns.indices {
        let pattern = patterns[index]
        var length = matchLengths[index]
        while length > 0, pattern.byte(at: length) != byte {
          length = failureTables[index][length - 1]
        }
        if pattern.byte(at: length) == byte {
          length += 1
        }
        if length == pattern.count {
          Self.erase(&output)
          state = .credentialEchoDetected
          eraseStorageLocked()
          throw .credentialEchoDetected
        }
        matchLengths[index] = length
      }

      lookbehind.append(byte)
      let retainedCount = matchLengths.max() ?? 0
      lookbehind.removeFirst(
        lookbehind.count - retainedCount,
        appendingTo: &output
      )
    }
    return Data(output)
  }

  package func finish() throws(StreamingSecretFilterError) -> Data {
    lock.lock()
    defer { lock.unlock() }
    try requireActiveLocked()
    let output = lookbehind.data()
    state = .finished
    eraseStorageLocked()
    return output
  }

  package func cancel() {
    lock.lock()
    defer { lock.unlock() }
    guard state == .active else { return }
    state = .cancelled
    eraseStorageLocked()
  }

  private func requireActiveLocked() throws(StreamingSecretFilterError) {
    switch state {
    case .active:
      return
    case .finished:
      throw .alreadyFinished
    case .cancelled:
      throw .cancelled
    case .credentialEchoDetected:
      throw .credentialEchoDetected
    }
  }

  private func eraseStorageLocked() {
    for pattern in patterns {
      pattern.wipe()
    }
    lookbehind.wipe()
    Self.erase(&failureTables)
    Self.erase(&matchLengths)
  }

  private static func failureTable(_ pattern: WipingByteBuffer) -> [Int] {
    var table = [Int](repeating: 0, count: pattern.count)
    var prefixLength = 0
    guard pattern.count > 1 else { return table }
    for index in 1..<pattern.count {
      while prefixLength > 0, pattern.byte(at: prefixLength) != pattern.byte(at: index) {
        prefixLength = table[prefixLength - 1]
      }
      if pattern.byte(at: prefixLength) == pattern.byte(at: index) {
        prefixLength += 1
      }
      table[index] = prefixLength
    }
    return table
  }

  private static func erase(_ bytes: inout [UInt8]) {
    bytes.withUnsafeMutableBufferPointer { buffer in
      buffer.initialize(repeating: 0)
    }
    bytes.removeAll(keepingCapacity: false)
  }

  private static func erase(_ values: inout [Int]) {
    values.withUnsafeMutableBufferPointer { buffer in
      buffer.initialize(repeating: 0)
    }
    values.removeAll(keepingCapacity: false)
  }

  private static func erase(_ tables: inout [[Int]]) {
    for index in tables.indices {
      erase(&tables[index])
    }
    tables.removeAll(keepingCapacity: false)
  }
}

private final class WipingByteBuffer {
  private let pointer: UnsafeMutableRawPointer
  let count: Int

  init(copying source: UnsafeRawBufferPointer) {
    precondition(!source.isEmpty)
    count = source.count
    pointer = .allocate(byteCount: source.count, alignment: MemoryLayout<UInt8>.alignment)
    pointer.copyMemory(from: source.baseAddress!, byteCount: source.count)
  }

  deinit {
    wipe()
    pointer.deallocate()
  }

  func byte(at index: Int) -> UInt8 {
    precondition(index >= 0 && index < count)
    return pointer.load(fromByteOffset: index, as: UInt8.self)
  }

  func elementsEqual(_ other: WipingByteBuffer) -> Bool {
    guard count == other.count else { return false }
    for index in 0..<count where byte(at: index) != other.byte(at: index) {
      return false
    }
    return true
  }

  func wipe() {
    _ = memset_s(pointer, count, 0, count)
  }
}

private final class WipingRingBuffer {
  private let pointer: UnsafeMutableRawPointer
  private let capacity: Int
  private var head = 0
  private(set) var count = 0
  private(set) var operationCount = 0

  init(capacity: Int) {
    precondition(capacity > 0)
    self.capacity = capacity
    pointer = .allocate(byteCount: capacity, alignment: MemoryLayout<UInt8>.alignment)
    _ = memset_s(pointer, capacity, 0, capacity)
  }

  deinit {
    wipe()
    pointer.deallocate()
  }

  func append(_ byte: UInt8) {
    precondition(count < capacity)
    let offset = (head + count) % capacity
    pointer.storeBytes(of: byte, toByteOffset: offset, as: UInt8.self)
    count += 1
    if operationCount < Int.max {
      operationCount += 1
    }
  }

  func removeFirst(_ amount: Int, appendingTo output: inout [UInt8]) {
    precondition(amount >= 0 && amount <= count)
    for _ in 0..<amount {
      output.append(pointer.load(fromByteOffset: head, as: UInt8.self))
      pointer.storeBytes(of: UInt8.zero, toByteOffset: head, as: UInt8.self)
      head = (head + 1) % capacity
      count -= 1
      if operationCount < Int.max {
        operationCount += 1
      }
    }
    if count == 0 {
      head = 0
    }
  }

  func data() -> Data {
    var result = Data(capacity: count)
    for index in 0..<count {
      result.append(pointer.load(fromByteOffset: (head + index) % capacity, as: UInt8.self))
    }
    return result
  }

  func wipe() {
    _ = memset_s(pointer, capacity, 0, capacity)
    head = 0
    count = 0
  }
}
