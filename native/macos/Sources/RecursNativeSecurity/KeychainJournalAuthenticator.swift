import CryptoKit
import Foundation
import RecursBrokerCore
import Security

package actor KeychainJournalAuthenticator:
  BrokerJournalAuthenticator,
  CustomReflectable
{
  private static let authenticationKeyByteCount = 32
  private static let maximumAnchorCount = 1_024
  private static let domainSeparator = Data("recurs.broker-journal.v1".utf8)
  private static let keyService = "com.recurs.cli.broker-journal-key.v1"
  private static let anchorService = "com.recurs.cli.broker-journal-anchors.v1"
  private static let keyAccount = "hmac-sha256.v1"
  private static let keyMarker = Data("journal-authentication-key.v1".utf8)
  private static let anchorMagic = Data("RCA1".utf8)
  private static let anchorEncodedByteCount = 4 + 16 + 8 + JournalAuthenticationTag.byteCount

  private let client: KeychainClient
  private let configuration: KeychainStoreConfiguration
  private let randomBytes: @Sendable () throws -> Data

  package init(configuration: KeychainStoreConfiguration) {
    self.client = .live
    self.configuration = configuration
    self.randomBytes = {
      var data = Data(repeating: 0, count: Self.authenticationKeyByteCount)
      let status = data.withUnsafeMutableBytes { bytes in
        SecRandomCopyBytes(kSecRandomDefault, bytes.count, bytes.baseAddress!)
      }
      guard status == errSecSuccess else {
        throw BrokerJournalError.storageUnavailable
      }
      return data
    }
  }

  init(
    client: KeychainClient,
    configuration: KeychainStoreConfiguration,
    randomBytes: @escaping @Sendable () throws -> Data
  ) {
    self.client = client
    self.configuration = configuration
    self.randomBytes = randomBytes
  }

  package nonisolated var customMirror: Mirror {
    let children: [(label: String?, value: Any)] = []
    return Mirror(self, children: children, displayStyle: .class)
  }

  package func authenticate(
    previousTag: JournalAuthenticationTag,
    canonicalRecord: Data
  ) async throws(BrokerJournalError) -> JournalAuthenticationTag {
    let key = try authenticationKey()
    let input = Self.authenticationInput(
      previousTag: previousTag,
      canonicalRecord: canonicalRecord
    )
    return try JournalAuthenticationTag(
      bytes: Array(HMAC<SHA256>.authenticationCode(for: input, using: key))
    )
  }

  package func verify(
    previousTag: JournalAuthenticationTag,
    canonicalRecord: Data,
    tag: JournalAuthenticationTag
  ) async throws(BrokerJournalError) {
    let key = try authenticationKey()
    let input = Self.authenticationInput(
      previousTag: previousTag,
      canonicalRecord: canonicalRecord
    )
    guard
      HMAC<SHA256>.isValidAuthenticationCode(
        tag.copiedBytes(),
        authenticating: input,
        using: key
      )
    else {
      throw .authenticationFailed
    }
  }

  package func anchor(
    for connectionID: UUID
  ) async throws(BrokerJournalError) -> BrokerJournalAnchor? {
    try loadAnchor(for: connectionID)
  }

  package func listAnchors() async throws(BrokerJournalError) -> [BrokerJournalAnchor] {
    try loadAnchors()
  }

  package func compareAndSwapAnchor(
    expected: BrokerJournalAnchor?,
    replacement: BrokerJournalAnchor
  ) async throws(BrokerJournalError) {
    let current = try loadAnchor(for: replacement.connectionID)
    guard current == expected else {
      throw .casConflict
    }
    try Self.validateTransition(expected: expected, replacement: replacement)

    let replacementData = Self.encode(replacement)
    let status: OSStatus
    if let expected {
      let expectedData = Self.encode(expected)
      let query = anchorBaseQuery(generic: expectedData).adding([
        kSecAttrAccount: Self.anchorAccount(replacement.connectionID)
      ])
      let attributes = KeychainQuery(attributes: [
        kSecValueData as String: replacementData,
        kSecAttrGeneric as String: replacementData,
      ])
      status = client.update(query, attributes)
    } else {
      guard try loadAnchors().count < Self.maximumAnchorCount else {
        throw .rollbackDetected
      }
      status = client.add(
        anchorBaseQuery(generic: replacementData).adding([
          kSecAttrAccount: Self.anchorAccount(replacement.connectionID),
          kSecValueData: replacementData,
        ])
      )
    }

    guard status != errSecSuccess else {
      return
    }
    try reconcileMutation(
      expected: expected,
      replacement: replacement
    )
  }

  private func authenticationKey() throws(BrokerJournalError) -> SymmetricKey {
    if var existing = try loadAuthenticationKeyData() {
      defer { eraseData(&existing) }
      return try Self.symmetricKey(existing)
    }
    guard try loadAnchors().isEmpty else {
      throw .rollbackDetected
    }

    var candidate: Data
    do {
      candidate = try randomBytes()
    } catch {
      throw .storageUnavailable
    }
    guard candidate.count == Self.authenticationKeyByteCount else {
      eraseData(&candidate)
      throw .storageUnavailable
    }
    defer { eraseData(&candidate) }
    let status = client.add(
      authenticationKeyBaseQuery().adding([
        kSecAttrAccount: Self.keyAccount,
        kSecValueData: candidate,
      ])
    )
    if status == errSecSuccess {
      return SymmetricKey(data: candidate)
    }
    guard var selected = try loadAuthenticationKeyData() else {
      throw .storageUnavailable
    }
    defer { eraseData(&selected) }
    return try Self.symmetricKey(selected)
  }

  private func loadAuthenticationKeyData() throws(BrokerJournalError) -> Data? {
    let result = client.copyMatching(
      authenticationKeyBaseQuery(includeMarker: false).adding([
        kSecAttrAccount: Self.keyAccount,
        kSecReturnData: true,
        kSecReturnAttributes: true,
        kSecMatchLimit: kSecMatchLimitOne,
      ])
    )
    switch result.status {
    case errSecItemNotFound:
      return nil
    case errSecSuccess:
      guard
        result.items.count == 1,
        result.items[0].account == Self.keyAccount,
        result.items[0].data.count == Self.authenticationKeyByteCount,
        result.items[0].generic == Self.keyMarker
      else {
        throw .rollbackDetected
      }
      return result.items[0].data
    default:
      throw .storageUnavailable
    }
  }

  private static func symmetricKey(_ data: Data) throws(BrokerJournalError) -> SymmetricKey {
    guard data.count == authenticationKeyByteCount else {
      throw .rollbackDetected
    }
    return SymmetricKey(data: data)
  }

  private static func authenticationInput(
    previousTag: JournalAuthenticationTag,
    canonicalRecord: Data
  ) -> Data {
    var input = domainSeparator
    input.append(0)
    input.append(contentsOf: previousTag.copiedBytes())
    input.append(canonicalRecord)
    return input
  }

  private func loadAnchor(
    for connectionID: UUID
  ) throws(BrokerJournalError) -> BrokerJournalAnchor? {
    let account = Self.anchorAccount(connectionID)
    let result = client.copyMatching(
      anchorBaseQuery().adding([
        kSecAttrAccount: account,
        kSecReturnData: true,
        kSecReturnAttributes: true,
        kSecMatchLimit: kSecMatchLimitOne,
      ])
    )
    switch result.status {
    case errSecItemNotFound:
      return nil
    case errSecSuccess:
      guard result.items.count == 1, result.items[0].account == account else {
        throw .rollbackDetected
      }
      return try Self.decode(result.items[0], expectedConnectionID: connectionID)
    default:
      throw .storageUnavailable
    }
  }

  private func loadAnchors() throws(BrokerJournalError) -> [BrokerJournalAnchor] {
    let result = client.copyMatching(
      anchorBaseQuery().adding([
        kSecReturnData: true,
        kSecReturnAttributes: true,
        kSecMatchLimit: kSecMatchLimitAll,
      ])
    )
    switch result.status {
    case errSecItemNotFound:
      return []
    case errSecSuccess:
      break
    default:
      throw .storageUnavailable
    }
    guard result.items.count <= Self.maximumAnchorCount else {
      throw .rollbackDetected
    }

    var connectionIDs: Set<UUID> = []
    var anchors: [BrokerJournalAnchor] = []
    anchors.reserveCapacity(result.items.count)
    for item in result.items {
      guard
        let connectionID = UUID(uuidString: item.account),
        Self.anchorAccount(connectionID) == item.account,
        connectionIDs.insert(connectionID).inserted
      else {
        throw .rollbackDetected
      }
      anchors.append(try Self.decode(item, expectedConnectionID: connectionID))
    }
    return anchors.sorted {
      Self.anchorAccount($0.connectionID) < Self.anchorAccount($1.connectionID)
    }
  }

  private func reconcileMutation(
    expected: BrokerJournalAnchor?,
    replacement: BrokerJournalAnchor
  ) throws(BrokerJournalError) {
    let selected: BrokerJournalAnchor?
    do {
      selected = try loadAnchor(for: replacement.connectionID)
    } catch let error {
      switch error {
      case .storageUnavailable:
        throw .mutationOutcomeUnknown
      default:
        throw error
      }
    }
    if selected == replacement {
      return
    }
    if selected == expected {
      throw .storageUnavailable
    }
    throw .casConflict
  }

  private static func validateTransition(
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

  private static func encode(_ anchor: BrokerJournalAnchor) -> Data {
    var data = anchorMagic
    var uuid = anchor.connectionID.uuid
    withUnsafeBytes(of: &uuid) { data.append(contentsOf: $0) }
    var revision = anchor.revision.bigEndian
    withUnsafeBytes(of: &revision) { data.append(contentsOf: $0) }
    data.append(contentsOf: anchor.authenticationTag.copiedBytes())
    return data
  }

  private static func decode(
    _ item: KeychainItem,
    expectedConnectionID: UUID
  ) throws(BrokerJournalError) -> BrokerJournalAnchor {
    let data = item.data
    guard
      item.generic == data,
      data.count == anchorEncodedByteCount,
      data.prefix(anchorMagic.count) == anchorMagic
    else {
      throw .rollbackDetected
    }
    let bytes = Array(data)
    let connectionID = UUID(
      uuid: (
        bytes[4], bytes[5], bytes[6], bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11],
        bytes[12], bytes[13], bytes[14], bytes[15],
        bytes[16], bytes[17], bytes[18], bytes[19]
      )
    )
    guard connectionID == expectedConnectionID else {
      throw .rollbackDetected
    }
    var revision: UInt64 = 0
    for byte in bytes[20..<28] {
      revision = revision << 8 | UInt64(byte)
    }
    do {
      return try BrokerJournalAnchor(
        connectionID: connectionID,
        revision: revision,
        authenticationTag: JournalAuthenticationTag(bytes: bytes[28..<60])
      )
    } catch {
      throw .rollbackDetected
    }
  }

  private func authenticationKeyBaseQuery(
    includeMarker: Bool = true
  ) -> KeychainQuery {
    KeychainQuery.base(
      configuration: configuration,
      service: Self.keyService,
      generic: includeMarker ? Self.keyMarker : nil
    )
  }

  private func anchorBaseQuery(generic: Data? = nil) -> KeychainQuery {
    KeychainQuery.base(
      configuration: configuration,
      service: Self.anchorService,
      generic: generic
    )
  }

  private static func anchorAccount(_ connectionID: UUID) -> String {
    connectionID.uuidString.lowercased()
  }
}
