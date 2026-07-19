import Foundation

@testable import RecursBrokerCore

enum InMemoryBrokerJournalStoreBarrier: Sendable, Hashable {
  case listBeforeReturn
  case loadBeforeReturn
  case compareAndSwapBeforeSideEffect
  case compareAndSwapAfterSideEffect
}

enum InMemoryBrokerJournalStoreEvent: Sendable, Equatable {
  case list
  case load(UUID)
  case compareAndSwap(UUID)
}

actor InMemoryBrokerJournalStore: BrokerJournalStore {
  static let maximumSnapshotCount = 1_024

  private var snapshots: [UUID: BrokerJournalSnapshot]
  private var recordedEvents: [InMemoryBrokerJournalStoreEvent] = []
  private var pauseBudgets: [InMemoryBrokerJournalStoreBarrier: Int] = [:]
  private var failures: [InMemoryBrokerJournalStoreBarrier: [BrokerJournalError]] = [:]
  private var parked: [InMemoryBrokerJournalStoreBarrier: [CheckedContinuation<Void, Never>]] = [:]
  private var arrivalWaiters:
    [InMemoryBrokerJournalStoreBarrier: [CheckedContinuation<Void, Never>]] = [:]

  init(snapshots: [BrokerJournalSnapshot] = []) throws(BrokerJournalError) {
    guard snapshots.count <= Self.maximumSnapshotCount else {
      throw .rollbackDetected
    }
    var indexed: [UUID: BrokerJournalSnapshot] = [:]
    indexed.reserveCapacity(snapshots.count)
    for snapshot in snapshots {
      guard indexed.updateValue(snapshot, forKey: snapshot.record.connectionID) == nil else {
        throw .rollbackDetected
      }
    }
    self.snapshots = indexed
  }

  func list() async throws(BrokerJournalError) -> [BrokerJournalSnapshot] {
    recordedEvents.append(.list)
    await pauseIfRequested(at: .listBeforeReturn)
    if let error = consumeFailure(at: .listBeforeReturn) {
      throw error
    }
    guard snapshots.count <= Self.maximumSnapshotCount else {
      throw .rollbackDetected
    }
    return snapshots.values.sorted {
      $0.record.connectionID.uuidString.lowercased()
        < $1.record.connectionID.uuidString.lowercased()
    }
  }

  func load(
    connectionID: UUID
  ) async throws(BrokerJournalError) -> BrokerJournalSnapshot? {
    recordedEvents.append(.load(connectionID))
    await pauseIfRequested(at: .loadBeforeReturn)
    if let error = consumeFailure(at: .loadBeforeReturn) {
      throw error
    }
    return snapshots[connectionID]
  }

  func compareAndSwap(
    expected: BrokerJournalSnapshot?,
    replacement: BrokerJournalRecord
  ) async throws(BrokerJournalError) -> BrokerJournalSnapshot {
    let connectionID = replacement.connectionID
    recordedEvents.append(.compareAndSwap(connectionID))
    guard snapshots[connectionID] == expected else {
      throw .casConflict
    }
    try validateCreationCapacity(expected: expected)
    try BrokerJournalTransitionValidator.validate(
      predecessor: expected?.record,
      successor: replacement
    )

    await pauseIfRequested(at: .compareAndSwapBeforeSideEffect)
    if let error = consumeFailure(at: .compareAndSwapBeforeSideEffect) {
      throw error
    }
    guard snapshots[connectionID] == expected else {
      throw .casConflict
    }
    try validateCreationCapacity(expected: expected)

    let result = BrokerJournalSnapshot(
      record: replacement,
      authenticationTag: try Self.authenticationTag(for: replacement)
    )
    snapshots[connectionID] = result

    await pauseIfRequested(at: .compareAndSwapAfterSideEffect)
    if let error = consumeFailure(at: .compareAndSwapAfterSideEffect) {
      throw error
    }
    return result
  }

  func reconcileCompareAndSwap(
    expected: BrokerJournalSnapshot?,
    replacement: BrokerJournalRecord
  ) async throws(BrokerJournalError) -> BrokerJournalCASReconciliation {
    let connectionID = replacement.connectionID
    recordedEvents.append(.load(connectionID))
    try BrokerJournalTransitionValidator.validate(
      predecessor: expected?.record,
      successor: replacement
    )
    await pauseIfRequested(at: .loadBeforeReturn)
    if let error = consumeFailure(at: .loadBeforeReturn) {
      throw error
    }
    let selected = snapshots[connectionID]
    if selected == expected {
      return .expected
    }
    let intended = BrokerJournalSnapshot(
      record: replacement,
      authenticationTag: try Self.authenticationTag(for: replacement)
    )
    if selected == intended {
      return .replacement(intended)
    }
    return .unrelated
  }

  func events() -> [InMemoryBrokerJournalStoreEvent] {
    recordedEvents
  }

  func resetEvents() {
    recordedEvents.removeAll(keepingCapacity: true)
  }

  func replaceExternally(_ snapshot: BrokerJournalSnapshot) {
    snapshots[snapshot.record.connectionID] = snapshot
  }

  func removeExternally(connectionID: UUID) {
    snapshots.removeValue(forKey: connectionID)
  }

  func pauseNext(at point: InMemoryBrokerJournalStoreBarrier) {
    pauseBudgets[point, default: 0] += 1
  }

  func failNext(
    _ error: BrokerJournalError,
    at point: InMemoryBrokerJournalStoreBarrier
  ) {
    failures[point, default: []].append(error)
  }

  func waitUntilPaused(at point: InMemoryBrokerJournalStoreBarrier) async {
    if parked[point]?.isEmpty == false {
      return
    }
    await withCheckedContinuation { continuation in
      arrivalWaiters[point, default: []].append(continuation)
    }
  }

  func releaseOne(at point: InMemoryBrokerJournalStoreBarrier) {
    guard var continuations = parked[point], !continuations.isEmpty else {
      preconditionFailure("No journal-store operation is paused at the requested point.")
    }
    let continuation = continuations.removeFirst()
    parked[point] = continuations
    continuation.resume()
  }

  private func pauseIfRequested(at point: InMemoryBrokerJournalStoreBarrier) async {
    guard let budget = pauseBudgets[point], budget > 0 else {
      return
    }
    pauseBudgets[point] = budget - 1
    await withCheckedContinuation { continuation in
      parked[point, default: []].append(continuation)
      let waiters = arrivalWaiters.removeValue(forKey: point) ?? []
      for waiter in waiters {
        waiter.resume()
      }
    }
  }

  private func consumeFailure(
    at point: InMemoryBrokerJournalStoreBarrier
  ) -> BrokerJournalError? {
    guard var queued = failures[point], !queued.isEmpty else {
      return nil
    }
    let error = queued.removeFirst()
    failures[point] = queued
    return error
  }

  private func validateCreationCapacity(
    expected: BrokerJournalSnapshot?
  ) throws(BrokerJournalError) {
    guard expected == nil, snapshots.count >= Self.maximumSnapshotCount else {
      return
    }
    throw .rollbackDetected
  }

  private static func authenticationTag(
    for record: BrokerJournalRecord
  ) throws(BrokerJournalError) -> JournalAuthenticationTag {
    var bytes = [UInt8](repeating: 0, count: 32)
    var revision = record.revision.bigEndian
    withUnsafeBytes(of: &revision) { rawBytes in
      for index in rawBytes.indices {
        bytes[index] = rawBytes[index]
        bytes[index + rawBytes.count] = rawBytes[index]
        bytes[index + rawBytes.count * 2] = rawBytes[index]
        bytes[index + rawBytes.count * 3] = rawBytes[index]
      }
    }
    return try JournalAuthenticationTag(bytes: bytes)
  }
}
