import Foundation

package actor FileBrokerJournalStore {
  private let directory: SecureDirectory
  private let authenticator: any BrokerJournalAuthenticator
  private let authorityLease: BrokerAuthorityLease
  private var operationGateIsHeld = false
  private var operationGateWaiters: [CheckedContinuation<Void, Never>] = []

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
    await enterOperationGate()
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
    await enterOperationGate()
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

  private func enterOperationGate() async {
    if !operationGateIsHeld {
      operationGateIsHeld = true
      return
    }
    await withCheckedContinuation { continuation in
      operationGateWaiters.append(continuation)
    }
  }

  private func leaveOperationGate() {
    guard !operationGateWaiters.isEmpty else {
      operationGateIsHeld = false
      return
    }
    operationGateWaiters.removeFirst().resume()
  }
}
