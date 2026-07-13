import Foundation

public let brokerOpenAIOnboardingMalformedRequestID = UInt64.max
public let brokerOpenAIOnboardingMaximumModelIDsPerPage = 128
public let brokerOpenAIOnboardingMaximumModelIDBytes = 256
public let brokerOpenAIOnboardingMaximumModelCount = 4_096
public let brokerOpenAIOnboardingMaximumReplyBytes = 34 * 1_024

package struct BrokerOpenAIOnboardingCodecError:
  Error,
  Sendable,
  Equatable,
  CustomStringConvertible
{
  package let requestID: UInt64?

  package var description: String {
    "invalid OpenAI onboarding frame"
  }
}

public enum BrokerOpenAIOnboardingRequest: Sendable, Equatable {
  case begin(requestID: UInt64)
  case verify(requestID: UInt64)
  case catalogPage(requestID: UInt64, cursor: UInt16)
  case finalize(requestID: UInt64, exactModelID: String)
  case abort(requestID: UInt64)

  public var requestID: UInt64 {
    switch self {
    case .begin(let requestID), .verify(let requestID),
      .catalogPage(let requestID, _), .finalize(let requestID, _),
      .abort(let requestID):
      requestID
    }
  }

  public func encode() throws -> Data {
    try validateClientRequestID(requestID)
    var body: [UInt8] = []
    append(requestID, to: &body)
    let kind: UInt16
    switch self {
    case .begin:
      kind = 1
    case .verify:
      kind = 2
    case .catalogPage(_, let cursor):
      try validateCatalogCursor(cursor)
      kind = 3
      append(cursor, to: &body)
    case .finalize(_, let exactModelID):
      kind = 4
      appendCounted(try validatedModelIDBytes(exactModelID), to: &body)
    case .abort:
      kind = 5
    }
    return try encodeFrame(
      kind: kind,
      body: body,
      maximumByteCount: maximumRequestBytes
    )
  }

  public static func decode(_ data: Data) throws -> BrokerOpenAIOnboardingRequest {
    let frame = try decodeFrame(
      data,
      allowedKinds: [1, 2, 3, 4, 5],
      maximumByteCount: maximumRequestBytes
    )
    var reader = ByteReader(frame.body)
    let requestID = try reader.readUInt64()
    try validateClientRequestID(requestID)
    return try withRequestID(requestID) {
      switch frame.kind {
      case 1:
        guard frame.body.count == 8 else { throw codecError() }
        try reader.finish()
        return .begin(requestID: requestID)
      case 2:
        guard frame.body.count == 8 else { throw codecError() }
        try reader.finish()
        return .verify(requestID: requestID)
      case 3:
        guard frame.body.count == 10 else { throw codecError() }
        let cursor = try reader.readUInt16()
        try validateCatalogCursor(cursor)
        try reader.finish()
        return .catalogPage(requestID: requestID, cursor: cursor)
      case 4:
        let exactModelID = try reader.readModelID()
        try reader.finish()
        return .finalize(requestID: requestID, exactModelID: exactModelID)
      case 5:
        guard frame.body.count == 8 else { throw codecError() }
        try reader.finish()
        return .abort(requestID: requestID)
      default:
        throw codecError()
      }
    }
  }
}

public struct BrokerOpenAIOnboardingCatalogPage: Sendable, Equatable {
  public let cursor: UInt16
  public let totalModelCount: UInt16
  public let nextCursor: UInt16?
  public let catalogRequestID: String?
  public let modelIDs: [String]

  public init(
    cursor: UInt16,
    totalModelCount: UInt16,
    nextCursor: UInt16?,
    catalogRequestID: String?,
    modelIDs: [String]
  ) throws {
    guard
      (1...brokerOpenAIOnboardingMaximumModelCount).contains(Int(totalModelCount)),
      Int(cursor) < Int(totalModelCount),
      (1...brokerOpenAIOnboardingMaximumModelIDsPerPage).contains(modelIDs.count)
    else {
      throw codecError()
    }
    let end = Int(cursor) + modelIDs.count
    guard end <= Int(totalModelCount) else { throw codecError() }
    switch nextCursor {
    case .some(let next):
      guard Int(next) == end, next < totalModelCount else { throw codecError() }
    case .none:
      guard end == Int(totalModelCount) else { throw codecError() }
    }
    try validateCatalogRequestID(catalogRequestID)
    try validateSortedModelIDs(modelIDs)
    self.cursor = cursor
    self.totalModelCount = totalModelCount
    self.nextCursor = nextCursor
    self.catalogRequestID = catalogRequestID
    self.modelIDs = modelIDs
  }

  fileprivate func appendEncoded(to body: inout [UInt8]) throws {
    append(cursor, to: &body)
    append(totalModelCount, to: &body)
    append(nextCursor ?? UInt16.max, to: &body)
    if let catalogRequestID {
      appendCounted(Array(catalogRequestID.utf8), to: &body)
    } else {
      append(UInt16(0), to: &body)
    }
    append(UInt16(modelIDs.count), to: &body)
    for modelID in modelIDs {
      appendCounted(try validatedModelIDBytes(modelID), to: &body)
    }
  }

  fileprivate static func decode(from reader: inout ByteReader) throws -> Self {
    let cursor = try reader.readUInt16()
    let totalModelCount = try reader.readUInt16()
    let rawNextCursor = try reader.readUInt16()
    let catalogRequestID = try reader.readOptionalCatalogRequestID()
    let count = Int(try reader.readUInt16())
    guard (1...brokerOpenAIOnboardingMaximumModelIDsPerPage).contains(count) else {
      throw codecError()
    }
    var modelIDs: [String] = []
    modelIDs.reserveCapacity(count)
    for _ in 0..<count {
      modelIDs.append(try reader.readModelID())
    }
    return try Self(
      cursor: cursor,
      totalModelCount: totalModelCount,
      nextCursor: rawNextCursor == UInt16.max ? nil : rawNextCursor,
      catalogRequestID: catalogRequestID,
      modelIDs: modelIDs
    )
  }
}

public struct BrokerOpenAIOnboardingCommitReceipt: Sendable, Equatable {
  public let connectionID: UUID
  public let selectedModelID: String
  public let verifiedModelCount: UInt16
  public let catalogRequestID: String?

  public init(
    connectionID: UUID,
    selectedModelID: String,
    verifiedModelCount: UInt16,
    catalogRequestID: String?
  ) throws {
    try validateUUID(connectionID)
    guard (1...brokerOpenAIOnboardingMaximumModelCount).contains(Int(verifiedModelCount)) else {
      throw codecError()
    }
    _ = try validatedModelIDBytes(selectedModelID)
    try validateCatalogRequestID(catalogRequestID)
    self.connectionID = connectionID
    self.selectedModelID = selectedModelID
    self.verifiedModelCount = verifiedModelCount
    self.catalogRequestID = catalogRequestID
  }

  fileprivate func appendEncoded(to body: inout [UInt8]) throws {
    append(connectionID, to: &body)
    appendCounted(try validatedModelIDBytes(selectedModelID), to: &body)
    append(verifiedModelCount, to: &body)
    if let catalogRequestID {
      appendCounted(Array(catalogRequestID.utf8), to: &body)
    } else {
      append(UInt16(0), to: &body)
    }
  }

  fileprivate static func decode(from reader: inout ByteReader) throws -> Self {
    try Self(
      connectionID: reader.readUUID(),
      selectedModelID: reader.readModelID(),
      verifiedModelCount: reader.readUInt16(),
      catalogRequestID: reader.readOptionalCatalogRequestID()
    )
  }
}

public struct BrokerOpenAIOnboardingRecoveryTokens: Sendable, Equatable {
  public let commitOperationID: UUID
  public let abortOperationID: UUID

  public init(commitOperationID: UUID, abortOperationID: UUID) throws {
    try validateUUID(commitOperationID)
    try validateUUID(abortOperationID)
    guard commitOperationID != abortOperationID else { throw codecError() }
    self.commitOperationID = commitOperationID
    self.abortOperationID = abortOperationID
  }

  fileprivate func appendEncoded(to body: inout [UInt8]) {
    append(commitOperationID, to: &body)
    append(abortOperationID, to: &body)
  }

  fileprivate static func decode(from reader: inout ByteReader) throws -> Self {
    try Self(
      commitOperationID: reader.readUUID(),
      abortOperationID: reader.readUUID()
    )
  }
}

public enum BrokerOpenAIOnboardingFailureCode: UInt16, Sendable, CaseIterable {
  case invalidRequest = 1
  case sessionNotReady = 2
  case busy = 3
  case cancelled = 4
  case expired = 5
  case verificationFailed = 6
  case invalidModel = 7
  case noCompatibleModels = 8
  case commitFailed = 9
  case credentialStoreUnavailable = 10
  case cleanupFailed = 11
  case reconciliationRequired = 12
  case authorityUnavailable = 13
  case operationUnavailable = 14
}

public enum BrokerOpenAIOnboardingReply: Sendable, Equatable {
  case begun(
    requestID: UInt64,
    connectionID: UUID,
    recoveryTokens: BrokerOpenAIOnboardingRecoveryTokens,
    credentialIdentityFingerprint: String
  )
  case catalogPage(requestID: UInt64, BrokerOpenAIOnboardingCatalogPage)
  case committed(requestID: UInt64, BrokerOpenAIOnboardingCommitReceipt)
  case aborted(requestID: UInt64)
  case failure(requestID: UInt64, BrokerOpenAIOnboardingFailureCode)

  public var requestID: UInt64 {
    switch self {
    case .begun(let requestID, _, _, _), .catalogPage(let requestID, _),
      .committed(let requestID, _), .aborted(let requestID),
      .failure(let requestID, _):
      requestID
    }
  }

  public func encode() throws -> Data {
    var body: [UInt8] = []
    let kind: UInt16
    switch self {
    case .begun(
      let requestID,
      let connectionID,
      let recoveryTokens,
      let credentialIdentityFingerprint
    ):
      try validateClientRequestID(requestID)
      try validateUUID(connectionID)
      kind = 101
      append(requestID, to: &body)
      append(connectionID, to: &body)
      recoveryTokens.appendEncoded(to: &body)
      body.append(
        contentsOf: try validatedCredentialIdentityFingerprintBytes(
          credentialIdentityFingerprint
        )
      )
    case .catalogPage(let requestID, let page):
      try validateClientRequestID(requestID)
      kind = 102
      append(requestID, to: &body)
      try page.appendEncoded(to: &body)
    case .committed(let requestID, let receipt):
      try validateClientRequestID(requestID)
      kind = 103
      append(requestID, to: &body)
      try receipt.appendEncoded(to: &body)
    case .aborted(let requestID):
      try validateClientRequestID(requestID)
      kind = 104
      append(requestID, to: &body)
    case .failure(let requestID, let code):
      try validateFailureRequestID(requestID, code: code)
      kind = 255
      append(requestID, to: &body)
      append(code.rawValue, to: &body)
    }
    return try encodeFrame(
      kind: kind,
      body: body,
      maximumByteCount: brokerOpenAIOnboardingMaximumReplyBytes
    )
  }

  public static func decode(_ data: Data) throws -> BrokerOpenAIOnboardingReply {
    let frame = try decodeFrame(
      data,
      allowedKinds: [101, 102, 103, 104, 255],
      maximumByteCount: brokerOpenAIOnboardingMaximumReplyBytes
    )
    var reader = ByteReader(frame.body)
    let rawRequestID = try reader.readUInt64()
    let requestContext = isClientRequestID(rawRequestID) ? rawRequestID : nil
    return try withRequestID(requestContext) {
      if frame.kind == 255 {
        guard frame.body.count == 10 else { throw codecError() }
        let rawCode = try reader.readUInt16()
        guard let code = BrokerOpenAIOnboardingFailureCode(rawValue: rawCode) else {
          throw codecError()
        }
        try reader.finish()
        try validateFailureRequestID(rawRequestID, code: code)
        return .failure(requestID: rawRequestID, code)
      }

      try validateClientRequestID(rawRequestID)
      switch frame.kind {
      case 101:
        guard frame.body.count == 127 else { throw codecError() }
        let connectionID = try reader.readUUID()
        let recoveryTokens = try BrokerOpenAIOnboardingRecoveryTokens.decode(from: &reader)
        let credentialIdentityFingerprint =
          try reader.readCredentialIdentityFingerprint()
        try reader.finish()
        return .begun(
          requestID: rawRequestID,
          connectionID: connectionID,
          recoveryTokens: recoveryTokens,
          credentialIdentityFingerprint: credentialIdentityFingerprint
        )
      case 102:
        let page = try BrokerOpenAIOnboardingCatalogPage.decode(from: &reader)
        try reader.finish()
        return .catalogPage(requestID: rawRequestID, page)
      case 103:
        let receipt = try BrokerOpenAIOnboardingCommitReceipt.decode(from: &reader)
        try reader.finish()
        return .committed(requestID: rawRequestID, receipt)
      case 104:
        guard frame.body.count == 8 else { throw codecError() }
        try reader.finish()
        return .aborted(requestID: rawRequestID)
      default:
        throw codecError()
      }
    }
  }
}

public enum BrokerOpenAIActivationReconciliationRequest: Sendable, Equatable {
  case reconcile(requestID: UInt64, connectionID: UUID)

  public var requestID: UInt64 {
    switch self {
    case .reconcile(let requestID, _):
      requestID
    }
  }

  public func encode() throws -> Data {
    switch self {
    case .reconcile(let requestID, let connectionID):
      try validateClientRequestID(requestID)
      try validateUUID(connectionID)
      var body: [UInt8] = []
      body.reserveCapacity(24)
      append(requestID, to: &body)
      append(connectionID, to: &body)
      return try encodeReconciliationFrame(kind: 1, body: body)
    }
  }

  public static func decode(
    _ data: Data
  ) throws -> BrokerOpenAIActivationReconciliationRequest {
    let frame = try decodeReconciliationFrame(data, allowedKinds: [1])
    guard frame.body.count == 24 else { throw codecError() }
    var reader = ByteReader(frame.body)
    let requestID = try reader.readUInt64()
    try validateClientRequestID(requestID)
    return try withRequestID(requestID) {
      let connectionID = try reader.readUUID()
      try reader.finish()
      return .reconcile(requestID: requestID, connectionID: connectionID)
    }
  }
}

public enum BrokerOpenAIActivationReconciliationStatus: UInt16, Sendable, CaseIterable {
  case readyOpenAI = 1
  case absent = 2
  case unresolved = 3
}

public enum BrokerOpenAIActivationReconciliationReply: Sendable, Equatable {
  case status(requestID: UInt64, BrokerOpenAIActivationReconciliationStatus)
  case failure(requestID: UInt64, BrokerOpenAIOnboardingFailureCode)

  public var requestID: UInt64 {
    switch self {
    case .status(let requestID, _), .failure(let requestID, _):
      requestID
    }
  }

  public func encode() throws -> Data {
    var body: [UInt8] = []
    body.reserveCapacity(10)
    let kind: UInt16
    switch self {
    case .status(let requestID, let status):
      try validateClientRequestID(requestID)
      kind = 101
      append(requestID, to: &body)
      append(status.rawValue, to: &body)
    case .failure(let requestID, let code):
      try validateFailureRequestID(requestID, code: code)
      kind = 255
      append(requestID, to: &body)
      append(code.rawValue, to: &body)
    }
    return try encodeReconciliationFrame(kind: kind, body: body)
  }

  public static func decode(
    _ data: Data
  ) throws -> BrokerOpenAIActivationReconciliationReply {
    let frame = try decodeReconciliationFrame(data, allowedKinds: [101, 255])
    guard frame.body.count == 10 else { throw codecError() }
    var reader = ByteReader(frame.body)
    let rawRequestID = try reader.readUInt64()
    let requestContext = isClientRequestID(rawRequestID) ? rawRequestID : nil
    return try withRequestID(requestContext) {
      let rawValue = try reader.readUInt16()
      try reader.finish()
      switch frame.kind {
      case 101:
        try validateClientRequestID(rawRequestID)
        guard let status = BrokerOpenAIActivationReconciliationStatus(rawValue: rawValue) else {
          throw codecError()
        }
        return .status(requestID: rawRequestID, status)
      case 255:
        guard let code = BrokerOpenAIOnboardingFailureCode(rawValue: rawValue) else {
          throw codecError()
        }
        try validateFailureRequestID(rawRequestID, code: code)
        return .failure(requestID: rawRequestID, code)
      default:
        throw codecError()
      }
    }
  }
}

private let magic: UInt32 = 0x5243_4f41
private let version: UInt16 = 1
private let headerByteCount = 12
private let maximumRequestBytes = 512
private let reconciliationMagic: UInt32 = 0x5243_434f
private let reconciliationVersion: UInt16 = 1
private let maximumReconciliationFrameBytes = 36
private let zeroUUID = UUID(
  uuid: (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
)

private struct Frame {
  let kind: UInt16
  let body: [UInt8]
}

private struct ByteReader {
  private let bytes: [UInt8]
  private var offset = 0

  init(_ bytes: [UInt8]) {
    self.bytes = bytes
  }

  mutating func readUInt16() throws -> UInt16 {
    guard bytes.count - offset >= 2 else { throw codecError() }
    defer { offset += 2 }
    return (UInt16(bytes[offset]) << 8) | UInt16(bytes[offset + 1])
  }

  mutating func readUInt64() throws -> UInt64 {
    guard bytes.count - offset >= 8 else { throw codecError() }
    var value: UInt64 = 0
    for byte in bytes[offset..<(offset + 8)] {
      value = (value << 8) | UInt64(byte)
    }
    offset += 8
    return value
  }

  mutating func readUUID() throws -> UUID {
    guard bytes.count - offset >= 16 else { throw codecError() }
    let value = UUID(
      uuid: (
        bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3],
        bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7],
        bytes[offset + 8], bytes[offset + 9], bytes[offset + 10], bytes[offset + 11],
        bytes[offset + 12], bytes[offset + 13], bytes[offset + 14], bytes[offset + 15]
      )
    )
    offset += 16
    try validateUUID(value)
    return value
  }

  mutating func readModelID() throws -> String {
    let value = try readCountedString(
      maximumByteCount: brokerOpenAIOnboardingMaximumModelIDBytes
    )
    _ = try validatedModelIDBytes(value)
    return value
  }

  mutating func readCredentialIdentityFingerprint() throws -> String {
    let value = try readString(count: credentialIdentityFingerprintByteCount)
    _ = try validatedCredentialIdentityFingerprintBytes(value)
    return value
  }

  mutating func readOptionalCatalogRequestID() throws -> String? {
    let count = Int(try readUInt16())
    guard count <= 256 else { throw codecError() }
    if count == 0 { return nil }
    let value = try readString(count: count)
    try validateCatalogRequestID(value)
    return value
  }

  private mutating func readCountedString(
    maximumByteCount: Int
  ) throws -> String {
    let count = Int(try readUInt16())
    guard (1...maximumByteCount).contains(count) else { throw codecError() }
    return try readString(count: count)
  }

  private mutating func readString(count: Int) throws -> String {
    guard count <= bytes.count - offset else { throw codecError() }
    let selected = Array(bytes[offset..<(offset + count)])
    offset += count
    guard let value = String(bytes: selected, encoding: .utf8) else {
      throw codecError()
    }
    return value
  }

  func finish() throws {
    guard offset == bytes.count else { throw codecError() }
  }
}

private func codecError(
  requestID: UInt64? = nil
) -> BrokerOpenAIOnboardingCodecError {
  BrokerOpenAIOnboardingCodecError(requestID: requestID)
}

private func withRequestID<Value>(
  _ requestID: UInt64?,
  _ operation: () throws -> Value
) throws -> Value {
  do {
    return try operation()
  } catch {
    throw codecError(requestID: requestID)
  }
}

private func isClientRequestID(_ requestID: UInt64) -> Bool {
  requestID > 0 && requestID < brokerOpenAIOnboardingMalformedRequestID
}

private func validateClientRequestID(_ requestID: UInt64) throws {
  guard isClientRequestID(requestID) else { throw codecError() }
}

private func validateFailureRequestID(
  _ requestID: UInt64,
  code: BrokerOpenAIOnboardingFailureCode
) throws {
  guard
    isClientRequestID(requestID)
      || (requestID == brokerOpenAIOnboardingMalformedRequestID && code == .invalidRequest)
  else {
    throw codecError()
  }
}

private func validateCatalogCursor(_ cursor: UInt16) throws {
  guard cursor > 0, Int(cursor) < brokerOpenAIOnboardingMaximumModelCount else {
    throw codecError()
  }
}

private func validateUUID(_ value: UUID) throws {
  guard value != zeroUUID else { throw codecError() }
}

private func validatedModelIDBytes(_ value: String) throws -> [UInt8] {
  let bytes = Array(value.utf8)
  guard
    (1...brokerOpenAIOnboardingMaximumModelIDBytes).contains(bytes.count),
    !bytes.contains(where: { $0 < 0x20 || $0 == 0x7f })
  else {
    throw codecError()
  }
  return bytes
}

private let credentialIdentityFingerprintByteCount = 71

private func validatedCredentialIdentityFingerprintBytes(
  _ value: String
) throws -> [UInt8] {
  let bytes = Array(value.utf8)
  guard
    bytes.count == credentialIdentityFingerprintByteCount,
    bytes.prefix(7).elementsEqual("sha256:".utf8),
    bytes.dropFirst(7).allSatisfy({
      (0x30...0x39).contains($0) || (0x61...0x66).contains($0)
    })
  else {
    throw codecError()
  }
  return bytes
}

private func validateSortedModelIDs(_ values: [String]) throws {
  var previous: [UInt8]?
  for value in values {
    let bytes = try validatedModelIDBytes(value)
    if let previous, !previous.lexicographicallyPrecedes(bytes) {
      throw codecError()
    }
    previous = bytes
  }
}

private func validateCatalogRequestID(_ value: String?) throws {
  guard let value else { return }
  let bytes = Array(value.utf8)
  guard
    (1...256).contains(bytes.count),
    bytes.allSatisfy({ (0x21...0x7e).contains($0) })
  else {
    throw codecError()
  }
}

private func encodeFrame(
  kind: UInt16,
  body: [UInt8],
  maximumByteCount: Int
) throws -> Data {
  guard
    maximumByteCount >= headerByteCount,
    body.count <= maximumByteCount - headerByteCount
  else {
    throw codecError()
  }
  var bytes: [UInt8] = []
  bytes.reserveCapacity(headerByteCount + body.count)
  append(magic, to: &bytes)
  append(version, to: &bytes)
  append(kind, to: &bytes)
  append(UInt32(body.count), to: &bytes)
  bytes.append(contentsOf: body)
  return Data(bytes)
}

private func decodeFrame(
  _ data: Data,
  allowedKinds: Set<UInt16>,
  maximumByteCount: Int
) throws -> Frame {
  guard
    data.count >= headerByteCount,
    data.count <= maximumByteCount
  else {
    throw codecError()
  }
  let bytes = [UInt8](data)
  let bodyCount = Int(readUInt32(bytes, at: 8))
  guard
    readUInt32(bytes, at: 0) == magic,
    readUInt16(bytes, at: 4) == version,
    allowedKinds.contains(readUInt16(bytes, at: 6)),
    bodyCount <= maximumByteCount - headerByteCount,
    bytes.count == headerByteCount + bodyCount
  else {
    throw codecError()
  }
  return Frame(
    kind: readUInt16(bytes, at: 6),
    body: Array(bytes.dropFirst(headerByteCount))
  )
}

private func encodeReconciliationFrame(kind: UInt16, body: [UInt8]) throws -> Data {
  guard body.count <= maximumReconciliationFrameBytes - headerByteCount else {
    throw codecError()
  }
  var bytes: [UInt8] = []
  bytes.reserveCapacity(headerByteCount + body.count)
  append(reconciliationMagic, to: &bytes)
  append(reconciliationVersion, to: &bytes)
  append(kind, to: &bytes)
  append(UInt32(body.count), to: &bytes)
  bytes.append(contentsOf: body)
  return Data(bytes)
}

private func decodeReconciliationFrame(
  _ data: Data,
  allowedKinds: Set<UInt16>
) throws -> Frame {
  guard
    data.count >= headerByteCount,
    data.count <= maximumReconciliationFrameBytes
  else {
    throw codecError()
  }
  let bytes = [UInt8](data)
  let bodyCount = Int(readUInt32(bytes, at: 8))
  guard
    readUInt32(bytes, at: 0) == reconciliationMagic,
    readUInt16(bytes, at: 4) == reconciliationVersion,
    allowedKinds.contains(readUInt16(bytes, at: 6)),
    bodyCount <= maximumReconciliationFrameBytes - headerByteCount,
    bytes.count == headerByteCount + bodyCount
  else {
    throw codecError()
  }
  return Frame(
    kind: readUInt16(bytes, at: 6),
    body: Array(bytes.dropFirst(headerByteCount))
  )
}

private func appendCounted(_ value: [UInt8], to bytes: inout [UInt8]) {
  append(UInt16(value.count), to: &bytes)
  bytes.append(contentsOf: value)
}

private func append(_ value: UInt16, to bytes: inout [UInt8]) {
  bytes.append(UInt8(value >> 8))
  bytes.append(UInt8(value & 0xff))
}

private func append(_ value: UInt32, to bytes: inout [UInt8]) {
  bytes.append(UInt8(value >> 24))
  bytes.append(UInt8((value >> 16) & 0xff))
  bytes.append(UInt8((value >> 8) & 0xff))
  bytes.append(UInt8(value & 0xff))
}

private func append(_ value: UInt64, to bytes: inout [UInt8]) {
  for shift in stride(from: 56, through: 0, by: -8) {
    bytes.append(UInt8((value >> UInt64(shift)) & 0xff))
  }
}

private func append(_ value: UUID, to bytes: inout [UInt8]) {
  var uuid = value.uuid
  withUnsafeBytes(of: &uuid) { bytes.append(contentsOf: $0) }
}

private func readUInt16(_ bytes: [UInt8], at offset: Int) -> UInt16 {
  (UInt16(bytes[offset]) << 8) | UInt16(bytes[offset + 1])
}

private func readUInt32(_ bytes: [UInt8], at offset: Int) -> UInt32 {
  (UInt32(bytes[offset]) << 24)
    | (UInt32(bytes[offset + 1]) << 16)
    | (UInt32(bytes[offset + 2]) << 8)
    | UInt32(bytes[offset + 3])
}
