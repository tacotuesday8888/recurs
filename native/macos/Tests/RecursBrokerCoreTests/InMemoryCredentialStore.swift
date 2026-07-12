import Foundation

@testable import RecursBrokerCore

enum StoreBarrierPoint: Sendable, Hashable {
  case storeBeforeSideEffect
  case storeAfterSideEffect
  case deleteBeforeSideEffect
  case deleteAfterSideEffect
}

struct InMemoryCredentialStoreInspection: Sendable, CustomStringConvertible,
  CustomDebugStringConvertible
{
  let keys: Set<CredentialStoreKey>
  let retainedCount: Int
  let storeCallCounts: [CredentialStoreKey: Int]
  let loadCallCounts: [CredentialStoreKey: Int]
  let deleteCallCounts: [CredentialStoreKey: Int]

  var description: String {
    "InMemoryCredentialStoreInspection(retainedCount: \(retainedCount), keyCount: \(keys.count))"
  }

  var debugDescription: String {
    description
  }
}

actor InMemoryCredentialStore: CredentialStore {
  private var retained: [CredentialStoreKey: SecretBytes] = [:]
  private var storeCounts: [CredentialStoreKey: Int] = [:]
  private var loadCounts: [CredentialStoreKey: Int] = [:]
  private var deleteCounts: [CredentialStoreKey: Int] = [:]
  private var pauseBudgets: [StoreBarrierPoint: Int] = [:]
  private var failureBudgets: [StoreBarrierPoint: Int] = [:]
  private var parked: [StoreBarrierPoint: [CheckedContinuation<Void, Never>]] = [:]
  private var arrivalWaiters: [StoreBarrierPoint: [CheckedContinuation<Void, Never>]] = [:]

  func store(
    _ secret: sending SecretBytes,
    for key: CredentialStoreKey
  ) async throws(CredentialStoreError) {
    storeCounts[key, default: 0] += 1
    await pauseIfRequested(at: .storeBeforeSideEffect)
    if consumeFailure(at: .storeBeforeSideEffect) {
      secret.erase()
      throw .unavailable
    }

    retained.removeValue(forKey: key)?.erase()
    retained[key] = secret

    await pauseIfRequested(at: .storeAfterSideEffect)
    if consumeFailure(at: .storeAfterSideEffect) {
      throw .mutationOutcomeUnknown
    }
  }

  func load(
    for key: CredentialStoreKey
  ) async throws(CredentialStoreError) -> sending SecretBytes {
    loadCounts[key, default: 0] += 1
    guard let secret = retained[key] else {
      throw .unavailable
    }
    return SecretBytes(secret.withUnsafeBytes { Data($0) })
  }

  func deleteIfPresent(
    _ key: CredentialStoreKey
  ) async throws(CredentialStoreError) {
    deleteCounts[key, default: 0] += 1
    await pauseIfRequested(at: .deleteBeforeSideEffect)
    if consumeFailure(at: .deleteBeforeSideEffect) {
      throw .unavailable
    }

    retained.removeValue(forKey: key)?.erase()

    await pauseIfRequested(at: .deleteAfterSideEffect)
    if consumeFailure(at: .deleteAfterSideEffect) {
      throw .mutationOutcomeUnknown
    }
  }

  func pauseNext(at point: StoreBarrierPoint) {
    pauseBudgets[point, default: 0] += 1
  }

  func failNext(at point: StoreBarrierPoint) {
    failureBudgets[point, default: 0] += 1
  }

  func waitUntilPaused(at point: StoreBarrierPoint) async {
    if parked[point]?.isEmpty == false {
      return
    }
    await withCheckedContinuation { continuation in
      arrivalWaiters[point, default: []].append(continuation)
    }
  }

  func releaseOne(at point: StoreBarrierPoint) {
    guard var continuations = parked[point], !continuations.isEmpty else {
      preconditionFailure("No operation is paused at the requested point.")
    }
    let continuation = continuations.removeFirst()
    parked[point] = continuations
    continuation.resume()
  }

  func inspection() -> InMemoryCredentialStoreInspection {
    InMemoryCredentialStoreInspection(
      keys: Set(retained.keys),
      retainedCount: retained.count,
      storeCallCounts: storeCounts,
      loadCallCounts: loadCounts,
      deleteCallCounts: deleteCounts
    )
  }

  func contains(_ key: CredentialStoreKey) -> Bool {
    retained[key] != nil
  }

  func retainedCount() -> Int {
    retained.count
  }

  func storeCallCount(for key: CredentialStoreKey) -> Int {
    storeCounts[key, default: 0]
  }

  func deleteCallCount(for key: CredentialStoreKey) -> Int {
    deleteCounts[key, default: 0]
  }

  private func consumeFailure(at point: StoreBarrierPoint) -> Bool {
    guard let count = failureBudgets[point], count > 0 else {
      return false
    }
    failureBudgets[point] = count - 1
    return true
  }

  private func pauseIfRequested(at point: StoreBarrierPoint) async {
    guard let count = pauseBudgets[point], count > 0 else {
      return
    }
    pauseBudgets[point] = count - 1
    await withCheckedContinuation { continuation in
      parked[point, default: []].append(continuation)
      let waiters = arrivalWaiters.removeValue(forKey: point) ?? []
      for waiter in waiters {
        waiter.resume()
      }
    }
  }
}

final class LockedSequence<Element: Sendable>: @unchecked Sendable {
  private let lock = NSLock()
  private var values: [Element]
  private var index = 0
  private var callCount = 0

  init(_ values: [Element]) {
    precondition(!values.isEmpty)
    self.values = values
  }

  func next() -> Element {
    lock.lock()
    defer { lock.unlock() }
    precondition(index < values.count, "Deterministic source exhausted.")
    let value = values[index]
    index += 1
    callCount += 1
    return value
  }

  func count() -> Int {
    lock.lock()
    defer { lock.unlock() }
    return callCount
  }
}

actor AsyncGate {
  private var continuation: CheckedContinuation<Void, Never>?
  private var isReleased = false

  func wait() async {
    if isReleased {
      return
    }
    await withCheckedContinuation { continuation = $0 }
  }

  func release() {
    isReleased = true
    continuation?.resume()
    continuation = nil
  }
}

final class UncheckedSecretAlias: @unchecked Sendable {
  let value: SecretBytes

  init(_ value: SecretBytes) {
    self.value = value
  }

  func isErased() -> Bool {
    value.withUnsafeBytes(\.isEmpty)
  }
}

final class BufferDeallocationProbe: @unchecked Sendable {
  private let lock = NSLock()
  private var result: Bool?

  func makeData(_ bytes: [UInt8]) -> Data {
    let pointer = UnsafeMutableRawPointer.allocate(
      byteCount: bytes.count,
      alignment: MemoryLayout<UInt8>.alignment
    )
    pointer.copyMemory(from: bytes, byteCount: bytes.count)
    return Data(
      bytesNoCopy: pointer,
      count: bytes.count,
      deallocator: .custom { [self] pointer, count in
        let buffer = UnsafeRawBufferPointer(start: pointer, count: count)
        lock.lock()
        result = buffer.allSatisfy { $0 == 0 }
        lock.unlock()
        pointer.deallocate()
      }
    )
  }

  func observedZeroization() -> Bool? {
    lock.lock()
    defer { lock.unlock() }
    return result
  }
}
