import CryptoKit
import Foundation

@testable import RecursBrokerCore

enum DeterministicJournalAuthenticatorBarrierPoint: Sendable, Hashable {
  case anchorListBeforeReturn
  case anchorLookupBeforeReturn
  case compareAndSwapBeforeSideEffect
  case compareAndSwapAfterSideEffect
  case verifyBeforeReturn
}

enum DeterministicJournalAuthenticatorReadEvent: Sendable, Hashable {
  case anchor(UUID)
  case listAnchors
  case verify
}

actor DeterministicBrokerJournalAuthenticator:
  BrokerJournalAuthenticator,
  CustomReflectable
{
  private static let domainSeparator = Data("recurs.broker-journal.v1".utf8)
  private static let maximumAnchorCount = 1_024

  private var anchors: [BrokerJournalAnchor]
  private var anchorLookupIDs: [UUID] = []
  private var anchorListCalls = 0
  private var verifyCalls = 0
  private var authorityReads: [DeterministicJournalAuthenticatorReadEvent] = []
  private var pauseBudgets: [DeterministicJournalAuthenticatorBarrierPoint: Int] = [:]
  private var failureBudgets: [DeterministicJournalAuthenticatorBarrierPoint: Int] = [:]
  private var parked:
    [DeterministicJournalAuthenticatorBarrierPoint: [CheckedContinuation<Void, Never>]] = [:]
  private var arrivalWaiters:
    [DeterministicJournalAuthenticatorBarrierPoint: [CheckedContinuation<Void, Never>]] = [:]

  init(anchors: [BrokerJournalAnchor] = []) {
    self.anchors = anchors
  }

  nonisolated var customMirror: Mirror {
    let children: [(label: String?, value: Any)] = []
    return Mirror(self, children: children, displayStyle: .class)
  }

  func authenticate(
    previousTag: JournalAuthenticationTag,
    canonicalRecord: Data
  ) async throws(BrokerJournalError) -> JournalAuthenticationTag {
    var input = Self.domainSeparator
    input.append(0)
    input.append(contentsOf: previousTag.copiedBytes())
    input.append(canonicalRecord)
    return try JournalAuthenticationTag(bytes: Array(SHA256.hash(data: input)))
  }

  func verify(
    previousTag: JournalAuthenticationTag,
    canonicalRecord: Data,
    tag: JournalAuthenticationTag
  ) async throws(BrokerJournalError) {
    verifyCalls += 1
    authorityReads.append(.verify)
    await pauseIfRequested(at: .verifyBeforeReturn)
    if consumeFailure(at: .verifyBeforeReturn) {
      throw .authenticationFailed
    }
    let expected = try await authenticate(
      previousTag: previousTag,
      canonicalRecord: canonicalRecord
    )
    guard expected == tag else {
      throw .authenticationFailed
    }
  }

  func verifyCount() -> Int {
    verifyCalls
  }

  func anchor(
    for connectionID: UUID
  ) async throws(BrokerJournalError) -> BrokerJournalAnchor? {
    anchorLookupIDs.append(connectionID)
    authorityReads.append(.anchor(connectionID))
    await pauseIfRequested(at: .anchorLookupBeforeReturn)
    if consumeFailure(at: .anchorLookupBeforeReturn) {
      throw .storageUnavailable
    }
    return try validatedAnchors().first { $0.connectionID == connectionID }
  }

  func anchorLookupCount() -> Int {
    anchorLookupIDs.count
  }

  func anchorLookupConnectionIDs() -> [UUID] {
    anchorLookupIDs
  }

  func listAnchors() async throws(BrokerJournalError) -> [BrokerJournalAnchor] {
    anchorListCalls += 1
    authorityReads.append(.listAnchors)
    await pauseIfRequested(at: .anchorListBeforeReturn)
    if consumeFailure(at: .anchorListBeforeReturn) {
      throw .storageUnavailable
    }
    return try validatedAnchors()
  }

  func anchorListCount() -> Int {
    anchorListCalls
  }

  func authorityReadEvents() -> [DeterministicJournalAuthenticatorReadEvent] {
    authorityReads
  }

  func compareAndSwapAnchor(
    expected: BrokerJournalAnchor?,
    replacement: BrokerJournalAnchor
  ) async throws(BrokerJournalError) {
    let initiallyValidated = try validatedAnchors()
    _ = try Self.exactExpectedIndex(
      expected: expected,
      replacement: replacement,
      in: initiallyValidated
    )
    try Self.validateReplacement(expected: expected, replacement: replacement)
    await pauseIfRequested(at: .compareAndSwapBeforeSideEffect)
    if consumeFailure(at: .compareAndSwapBeforeSideEffect) {
      throw .storageUnavailable
    }

    var validated = try validatedAnchors()
    if let index = try Self.exactExpectedIndex(
      expected: expected,
      replacement: replacement,
      in: validated
    ) {
      validated[index] = replacement
    } else {
      guard validated.count < Self.maximumAnchorCount else {
        throw .rollbackDetected
      }
      validated.append(replacement)
    }
    anchors = validated

    await pauseIfRequested(at: .compareAndSwapAfterSideEffect)
    if consumeFailure(at: .compareAndSwapAfterSideEffect) {
      throw .mutationOutcomeUnknown
    }
  }

  private static func exactExpectedIndex(
    expected: BrokerJournalAnchor?,
    replacement: BrokerJournalAnchor,
    in anchors: [BrokerJournalAnchor]
  ) throws(BrokerJournalError) -> Int? {
    guard let expected else {
      guard !anchors.contains(where: { $0.connectionID == replacement.connectionID }) else {
        throw .casConflict
      }
      return nil
    }
    guard
      let index = anchors.firstIndex(where: { $0.connectionID == expected.connectionID }),
      anchors[index] == expected
    else {
      throw .casConflict
    }
    return index
  }

  func pauseNext(at point: DeterministicJournalAuthenticatorBarrierPoint) {
    pauseBudgets[point, default: 0] += 1
  }

  func failNext(at point: DeterministicJournalAuthenticatorBarrierPoint) {
    failureBudgets[point, default: 0] += 1
  }

  func waitUntilPaused(at point: DeterministicJournalAuthenticatorBarrierPoint) async {
    if parked[point]?.isEmpty == false {
      return
    }
    await withCheckedContinuation { continuation in
      arrivalWaiters[point, default: []].append(continuation)
    }
  }

  func releaseOne(at point: DeterministicJournalAuthenticatorBarrierPoint) {
    guard var continuations = parked[point], !continuations.isEmpty else {
      preconditionFailure("No authenticator operation is paused at the requested point.")
    }
    let continuation = continuations.removeFirst()
    parked[point] = continuations
    continuation.resume()
  }

  private func validatedAnchors() throws(BrokerJournalError) -> [BrokerJournalAnchor] {
    guard anchors.count <= Self.maximumAnchorCount else {
      throw .rollbackDetected
    }

    var connectionIDs: Set<UUID> = []
    for anchor in anchors {
      guard connectionIDs.insert(anchor.connectionID).inserted else {
        throw .rollbackDetected
      }
    }
    return anchors.sorted {
      $0.connectionID.uuidString.lowercased() < $1.connectionID.uuidString.lowercased()
    }
  }

  private static func validateReplacement(
    expected: BrokerJournalAnchor?,
    replacement: BrokerJournalAnchor
  ) throws(BrokerJournalError) {
    guard let expected else {
      guard replacement.revision == 1 else {
        throw .casConflict
      }
      return
    }
    guard expected.connectionID == replacement.connectionID else {
      throw .casConflict
    }
    let (requiredRevision, overflow) = expected.revision.addingReportingOverflow(1)
    guard !overflow else {
      throw .revisionOverflow
    }
    guard replacement.revision == requiredRevision else {
      throw .casConflict
    }
  }

  private func consumeFailure(at point: DeterministicJournalAuthenticatorBarrierPoint) -> Bool {
    guard let count = failureBudgets[point], count > 0 else {
      return false
    }
    failureBudgets[point] = count - 1
    return true
  }

  private func pauseIfRequested(
    at point: DeterministicJournalAuthenticatorBarrierPoint
  ) async {
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
