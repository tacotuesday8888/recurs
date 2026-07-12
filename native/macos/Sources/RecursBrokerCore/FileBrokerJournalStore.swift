import Foundation

package actor FileBrokerJournalStore: BrokerJournalStore {
  package static let maximumPendingOperationCount = 1_024

  private struct OperationGateWaiter {
    let continuation: CheckedContinuation<Bool, Never>
    var previousToken: UInt64?
    var nextToken: UInt64?
  }

  private let directory: SecureDirectory
  private let authenticator: any BrokerJournalAuthenticator
  private let authorityLease: BrokerAuthorityLease
  private var operationGateIsHeld = false
  private var operationGateWaiters: [UInt64: OperationGateWaiter] = [:]
  private var operationGateHeadToken: UInt64?
  private var operationGateTailToken: UInt64?
  private var nextOperationGateToken: UInt64 = 0

  private init(
    directory: SecureDirectory,
    authenticator: any BrokerJournalAuthenticator,
    authorityLease: consuming BrokerAuthorityLease
  ) {
    self.directory = directory
    self.authenticator = authenticator
    self.authorityLease = consume authorityLease
  }

  package static func open(
    directory: SecureDirectory,
    authenticator: any BrokerJournalAuthenticator
  ) throws(BrokerJournalError) -> FileBrokerJournalStore {
    let authorityLease: BrokerAuthorityLease
    do {
      authorityLease = try directory.acquireAuthorityLease()
    } catch {
      throw .lockUnavailable
    }
    return FileBrokerJournalStore(
      directory: directory,
      authenticator: authenticator,
      authorityLease: consume authorityLease
    )
  }

  package func load(
    connectionID: UUID
  ) async throws(BrokerJournalError) -> BrokerJournalSnapshot? {
    try await enterOperationGate()
    defer { leaveOperationGate() }

    guard let anchor = try await authenticator.anchor(for: connectionID) else {
      return nil
    }
    return try await loadSelected(anchor: anchor, connectionID: connectionID)
  }

  private func loadSelected(
    anchor: BrokerJournalAnchor,
    connectionID: UUID
  ) async throws(BrokerJournalError) -> BrokerJournalSnapshot {
    guard anchor.connectionID == connectionID else {
      throw .rollbackDetected
    }

    let basename =
      "\(connectionID.uuidString.lowercased()).\(anchor.revision % 2).rcbj"
    let selectedData: Data
    do {
      guard let data = try directory.readBoundedFileIfPresent(basename: basename) else {
        throw BrokerJournalError.rollbackDetected
      }
      selectedData = data
    } catch let error as BrokerJournalError {
      throw error
    } catch let error as SecureDirectoryError {
      switch error {
      case .fileTooLarge:
        throw .invalidRecord
      default:
        throw .storageUnavailable
      }
    } catch {
      throw .storageUnavailable
    }

    let envelope = try BrokerJournalCodec.decode(selectedData)
    guard
      envelope.record.connectionID == connectionID,
      envelope.record.revision == anchor.revision
    else {
      throw .rollbackDetected
    }
    guard envelope.authTag == anchor.authenticationTag else {
      throw .authenticationFailed
    }
    if anchor.revision == 1, envelope.previousAuthTag != .zero {
      throw .authenticationFailed
    }
    let canonicalRecord = try BrokerJournalCodec.canonicalRecordData(for: envelope.record)
    try await authenticator.verify(
      previousTag: envelope.previousAuthTag,
      canonicalRecord: canonicalRecord,
      tag: envelope.authTag
    )
    return BrokerJournalSnapshot(
      record: envelope.record,
      authenticationTag: envelope.authTag
    )
  }

  package func list() async throws(BrokerJournalError) -> [BrokerJournalSnapshot] {
    try await enterOperationGate()
    defer { leaveOperationGate() }

    let anchors = try await authenticator.listAnchors()
    let selectedBasenames = try validateAnchorIndexAndSelectedBasenames(anchors)
    let entries: SecureDirectoryEntries
    do {
      entries = try directory.enumerateRecognizedEntries(
        selectedSlotBasenames: selectedBasenames
      )
    } catch {
      throw .storageUnavailable
    }

    var snapshots: [BrokerJournalSnapshot] = []
    snapshots.reserveCapacity(anchors.count)
    for anchor in anchors {
      snapshots.append(
        try await loadSelected(
          anchor: anchor,
          connectionID: anchor.connectionID
        )
      )
    }
    for temporary in entries.temporaryBasenames {
      do {
        try directory.removeVerifiedTemporary(
          basename: temporary,
          selectedSlotBasenames: selectedBasenames
        )
      } catch {
        throw .storageUnavailable
      }
    }
    return snapshots
  }

  package func compareAndSwap(
    expected: BrokerJournalSnapshot?,
    replacement: BrokerJournalRecord
  ) async throws(BrokerJournalError) -> BrokerJournalSnapshot {
    try await enterOperationGate()
    defer { leaveOperationGate() }

    let authorityConnectionID = expected?.record.connectionID ?? replacement.connectionID
    let currentAnchor = try await authenticator.anchor(for: authorityConnectionID)
    let currentSnapshot: BrokerJournalSnapshot?
    if let expected {
      guard let currentAnchor else { throw .casConflict }
      let loaded = try await loadSelected(
        anchor: currentAnchor,
        connectionID: authorityConnectionID
      )
      guard loaded == expected else { throw .casConflict }
      currentSnapshot = loaded
    } else {
      guard currentAnchor == nil else { throw .casConflict }
      currentSnapshot = nil
    }

    try BrokerJournalTransitionValidator.validate(
      predecessor: currentSnapshot?.record,
      successor: replacement
    )
    let previousTag = currentSnapshot?.authenticationTag ?? .zero
    let canonicalRecord = try BrokerJournalCodec.canonicalRecordData(for: replacement)
    let authenticationTag = try await authenticator.authenticate(
      previousTag: previousTag,
      canonicalRecord: canonicalRecord
    )
    let intendedAnchor = try BrokerJournalAnchor(
      connectionID: replacement.connectionID,
      revision: replacement.revision,
      authenticationTag: authenticationTag
    )
    let intendedSnapshot = BrokerJournalSnapshot(
      record: replacement,
      authenticationTag: authenticationTag
    )
    let envelopeData = try BrokerJournalCodec.encode(
      BrokerJournalEnvelope(
        previousAuthTag: previousTag,
        authTag: authenticationTag,
        record: replacement
      )
    )
    let intendedBasename =
      "\(replacement.connectionID.uuidString.lowercased()).\(replacement.revision % 2).rcbj"
    do {
      try directory.writeAtomically(envelopeData, toSlotBasename: intendedBasename)
    } catch let error {
      switch error {
      case .fileTooLarge:
        throw .invalidRecord
      case .durabilityUnknown:
        return try await reconcileAnchorFailure(
          originalError: .storageUnavailable,
          previousAnchor: currentAnchor,
          previousSnapshot: currentSnapshot,
          intendedAnchor: intendedAnchor,
          intendedSnapshot: intendedSnapshot,
          intendedEnvelopeData: envelopeData,
          intendedBasename: intendedBasename
        )
      default:
        throw .storageUnavailable
      }
    }

    guard
      try await loadSelected(
        anchor: intendedAnchor,
        connectionID: replacement.connectionID
      ) == intendedSnapshot
    else {
      throw .rollbackDetected
    }
    let selectedAnchor: BrokerJournalAnchor?
    do {
      try await authenticator.compareAndSwapAnchor(
        expected: currentAnchor,
        replacement: intendedAnchor
      )
      selectedAnchor = try await authenticator.anchor(for: replacement.connectionID)
    } catch let error {
      return try await reconcileAnchorFailure(
        originalError: error,
        previousAnchor: currentAnchor,
        previousSnapshot: currentSnapshot,
        intendedAnchor: intendedAnchor,
        intendedSnapshot: intendedSnapshot,
        intendedEnvelopeData: envelopeData,
        intendedBasename: intendedBasename
      )
    }
    guard selectedAnchor == intendedAnchor else {
      return try await reconcileAnchorFailure(
        originalError: .mutationOutcomeUnknown,
        previousAnchor: currentAnchor,
        previousSnapshot: currentSnapshot,
        intendedAnchor: intendedAnchor,
        intendedSnapshot: intendedSnapshot,
        intendedEnvelopeData: envelopeData,
        intendedBasename: intendedBasename
      )
    }
    return try await verifyOrRepairIntendedSelection(
      anchor: intendedAnchor,
      snapshot: intendedSnapshot,
      envelopeData: envelopeData,
      basename: intendedBasename
    )
  }

  private func reconcileAnchorFailure(
    originalError: BrokerJournalError,
    previousAnchor: BrokerJournalAnchor?,
    previousSnapshot: BrokerJournalSnapshot?,
    intendedAnchor: BrokerJournalAnchor,
    intendedSnapshot: BrokerJournalSnapshot,
    intendedEnvelopeData: Data,
    intendedBasename: String
  ) async throws(BrokerJournalError) -> BrokerJournalSnapshot {
    let observedAnchor: BrokerJournalAnchor?
    do {
      observedAnchor = try await authenticator.anchor(for: intendedAnchor.connectionID)
    } catch {
      throw originalError == .casConflict ? .casConflict : .mutationOutcomeUnknown
    }

    if observedAnchor == intendedAnchor {
      return try await verifyOrRepairIntendedSelection(
        anchor: intendedAnchor,
        snapshot: intendedSnapshot,
        envelopeData: intendedEnvelopeData,
        basename: intendedBasename
      )
    }

    if observedAnchor == previousAnchor {
      let previousIsExact: Bool
      if let previousAnchor, let previousSnapshot {
        do {
          previousIsExact =
            try await loadSelected(
              anchor: previousAnchor,
              connectionID: previousAnchor.connectionID
            ) == previousSnapshot
        } catch {
          throw originalError == .casConflict ? .casConflict : .mutationOutcomeUnknown
        }
      } else {
        previousIsExact = previousAnchor == nil && previousSnapshot == nil
      }
      guard previousIsExact else {
        throw originalError == .casConflict ? .casConflict : .mutationOutcomeUnknown
      }
      if let previousAnchor {
        let authorityAfterPreviousVerification: BrokerJournalAnchor?
        do {
          authorityAfterPreviousVerification = try await authenticator.anchor(
            for: previousAnchor.connectionID
          )
        } catch {
          throw originalError == .casConflict ? .casConflict : .mutationOutcomeUnknown
        }
        guard authorityAfterPreviousVerification == previousAnchor else {
          throw originalError == .casConflict ? .casConflict : .mutationOutcomeUnknown
        }
      }
      switch originalError {
      case .storageUnavailable, .casConflict:
        throw originalError
      default:
        throw .mutationOutcomeUnknown
      }
    }

    throw originalError == .casConflict ? .casConflict : .mutationOutcomeUnknown
  }

  private func verifyOrRepairIntendedSelection(
    anchor: BrokerJournalAnchor,
    snapshot: BrokerJournalSnapshot,
    envelopeData: Data,
    basename: String
  ) async throws(BrokerJournalError) -> BrokerJournalSnapshot {
    do {
      let selected = try await loadSelected(
        anchor: anchor,
        connectionID: anchor.connectionID
      )
      guard selected == snapshot else { throw BrokerJournalError.rollbackDetected }
      return try await requireIntendedAuthorityAfterVerification(
        selected,
        anchor: anchor
      )
    } catch let error as BrokerJournalError {
      switch error {
      case .rollbackDetected, .invalidRecord, .nonCanonical, .unsupportedVersion,
        .authenticationFailed:
        // Selected bytes can be lost or damaged after the external anchor CAS
        // succeeds. Repair only while that exact anchor remains authoritative.
        break
      default:
        throw error
      }
    } catch {
      throw .mutationOutcomeUnknown
    }

    let authorityBeforeRepair: BrokerJournalAnchor?
    do {
      authorityBeforeRepair = try await authenticator.anchor(for: anchor.connectionID)
    } catch {
      throw .mutationOutcomeUnknown
    }
    guard authorityBeforeRepair == anchor else { throw .mutationOutcomeUnknown }

    do {
      try directory.writeAtomically(envelopeData, toSlotBasename: basename)
    } catch .fileTooLarge {
      throw .invalidRecord
    } catch .durabilityUnknown {
      let exactBytesPersisted: Bool
      do {
        exactBytesPersisted =
          try directory.readBoundedFileIfPresent(basename: basename) == envelopeData
      } catch {
        throw .mutationOutcomeUnknown
      }
      guard exactBytesPersisted else { throw .mutationOutcomeUnknown }
    } catch {
      throw .mutationOutcomeUnknown
    }

    let repaired = try await loadSelected(
      anchor: anchor,
      connectionID: anchor.connectionID
    )
    guard repaired == snapshot else { throw .rollbackDetected }
    return try await requireIntendedAuthorityAfterVerification(
      repaired,
      anchor: anchor
    )
  }

  private func requireIntendedAuthorityAfterVerification(
    _ selected: BrokerJournalSnapshot,
    anchor: BrokerJournalAnchor
  ) async throws(BrokerJournalError) -> BrokerJournalSnapshot {
    let authorityAfterVerification: BrokerJournalAnchor?
    do {
      authorityAfterVerification = try await authenticator.anchor(for: anchor.connectionID)
    } catch {
      throw .mutationOutcomeUnknown
    }
    guard authorityAfterVerification == anchor else { throw .mutationOutcomeUnknown }
    return selected
  }

  private func validateAnchorIndexAndSelectedBasenames(
    _ anchors: [BrokerJournalAnchor]
  ) throws(BrokerJournalError) -> Set<String> {
    guard anchors.count <= SecureDirectory.maximumAnchoredConnections else {
      throw .rollbackDetected
    }
    var previousConnectionID: String?
    var connectionIDs: Set<UUID> = []
    var basenames: Set<String> = []
    for anchor in anchors {
      let connectionID = anchor.connectionID.uuidString.lowercased()
      guard
        connectionIDs.insert(anchor.connectionID).inserted,
        previousConnectionID.map({ $0 < connectionID }) ?? true
      else {
        throw .rollbackDetected
      }
      previousConnectionID = connectionID
      basenames.insert("\(connectionID).\(anchor.revision % 2).rcbj")
    }
    return basenames
  }

  package func pendingOperationCount() -> Int {
    operationGateWaiters.count
  }

  private func enterOperationGate() async throws(BrokerJournalError) {
    guard !Task.isCancelled else { throw .storageUnavailable }
    if !operationGateIsHeld {
      operationGateIsHeld = true
      return
    }

    guard operationGateWaiters.count < Self.maximumPendingOperationCount else {
      throw .storageUnavailable
    }
    let token = try allocateOperationGateToken()
    let entered: Bool = await withTaskCancellationHandler {
      await withCheckedContinuation { continuation in
        appendOperationGateWaiter(token: token, continuation: continuation)
        if Task.isCancelled {
          cancelOperationGateWaiter(token: token)
        }
      }
    } onCancel: {
      Task {
        await self.cancelOperationGateWaiter(token: token)
      }
    }
    guard entered else { throw .storageUnavailable }
    guard !Task.isCancelled else {
      leaveOperationGate()
      throw .storageUnavailable
    }
  }

  private func leaveOperationGate() {
    guard
      let headToken = operationGateHeadToken,
      let waiter = unlinkOperationGateWaiter(token: headToken)
    else {
      operationGateIsHeld = false
      return
    }
    waiter.continuation.resume(returning: true)
  }

  private func allocateOperationGateToken() throws(BrokerJournalError) -> UInt64 {
    let token = nextOperationGateToken
    let (next, overflow) = token.addingReportingOverflow(1)
    guard !overflow else { throw .storageUnavailable }
    nextOperationGateToken = next
    return token
  }

  private func appendOperationGateWaiter(
    token: UInt64,
    continuation: CheckedContinuation<Bool, Never>
  ) {
    let previousToken = operationGateTailToken
    operationGateWaiters[token] = OperationGateWaiter(
      continuation: continuation,
      previousToken: previousToken,
      nextToken: nil
    )
    if let previousToken, var previous = operationGateWaiters[previousToken] {
      previous.nextToken = token
      operationGateWaiters[previousToken] = previous
    } else {
      operationGateHeadToken = token
    }
    operationGateTailToken = token
  }

  private func cancelOperationGateWaiter(token: UInt64) {
    guard let waiter = unlinkOperationGateWaiter(token: token) else { return }
    waiter.continuation.resume(returning: false)
  }

  private func unlinkOperationGateWaiter(token: UInt64) -> OperationGateWaiter? {
    guard let waiter = operationGateWaiters.removeValue(forKey: token) else {
      return nil
    }
    if let previousToken = waiter.previousToken,
      var previous = operationGateWaiters[previousToken]
    {
      previous.nextToken = waiter.nextToken
      operationGateWaiters[previousToken] = previous
    } else {
      operationGateHeadToken = waiter.nextToken
    }
    if let nextToken = waiter.nextToken, var next = operationGateWaiters[nextToken] {
      next.previousToken = waiter.previousToken
      operationGateWaiters[nextToken] = next
    } else {
      operationGateTailToken = waiter.previousToken
    }
    return waiter
  }
}
