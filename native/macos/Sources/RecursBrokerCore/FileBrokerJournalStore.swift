import Foundation

package actor FileBrokerJournalStore {
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
