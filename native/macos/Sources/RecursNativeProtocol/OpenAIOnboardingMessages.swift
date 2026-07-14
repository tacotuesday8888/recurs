import Foundation

public let openAIOnboardingMaximumModelIDsPerPage = 128
public let openAIOnboardingMaximumModelCount = 4_096
public let openAIOnboardingMaximumModelIDUTF8ByteCount = 256
public let openAIOnboardingMaximumCatalogRequestIDUTF8ByteCount = 256

public protocol NativeOpenAIOnboardingMessage: Equatable, Sendable {
  static func decode(_ frame: NativeFrame) throws -> Self
  func encodedFrame(requestID: UInt32) throws -> Data
}

public enum OpenAIOnboardingRequestMessage: NativeOpenAIOnboardingMessage {
  case begin
  case beginAnthropic
  case verify
  case catalogPage(cursor: UInt16)
  case finalize(exactModelID: String)
  case abort
  case reconcile(
    connectionID: UUID,
    credentialIdentityFingerprint: String
  )

  public static func decode(
    _ frame: NativeFrame
  ) throws -> OpenAIOnboardingRequestMessage {
    try openAIOnboardingInvalidMessage {
      guard frame.type == .openAIOnboardingRequest else {
        throw NativeProtocolError.invalidMessage
      }
      let fields = try FieldTable.decode(frame.payload).fields
      guard let kindField = fields.first, kindField.tag == 1 else {
        throw NativeProtocolError.invalidMessage
      }
      let kind = try FieldTable.decodeUInt16(kindField.value)
      switch kind {
      case 1:
        try requireOpenAIOnboardingTags(fields, [1])
        return .begin
      case 7:
        try requireOpenAIOnboardingTags(fields, [1])
        return .beginAnthropic
      case 2:
        try requireOpenAIOnboardingTags(fields, [1])
        return .verify
      case 3:
        try requireOpenAIOnboardingTags(fields, [1, 2])
        let cursor = try FieldTable.decodeUInt16(fields[1].value)
        try validateOpenAIOnboardingCatalogCursor(cursor)
        return .catalogPage(cursor: cursor)
      case 4:
        try requireOpenAIOnboardingTags(fields, [1, 2])
        return .finalize(
          exactModelID: try decodeOpenAIOnboardingModelID(fields[1].value)
        )
      case 5:
        try requireOpenAIOnboardingTags(fields, [1])
        return .abort
      case 6:
        try requireOpenAIOnboardingTags(fields, [1, 2, 3])
        return .reconcile(
          connectionID: try decodeOpenAIOnboardingUUID(fields[1].value),
          credentialIdentityFingerprint:
            try decodeOpenAIOnboardingFingerprint(fields[2].value)
        )
      default:
        throw NativeProtocolError.invalidMessage
      }
    }
  }

  public func encodedFrame(requestID: UInt32) throws -> Data {
    try openAIOnboardingInvalidMessage {
      let fields: [FieldTable.Field]
      switch self {
      case .begin:
        fields = [try openAIOnboardingKindField(1)]
      case .beginAnthropic:
        fields = [try openAIOnboardingKindField(7)]
      case .verify:
        fields = [try openAIOnboardingKindField(2)]
      case .catalogPage(let cursor):
        try validateOpenAIOnboardingCatalogCursor(cursor)
        fields = [
          try openAIOnboardingKindField(3),
          try FieldTable.Field(tag: 2, value: FieldTable.encodeUInt16(cursor)),
        ]
      case .finalize(let exactModelID):
        fields = [
          try openAIOnboardingKindField(4),
          try FieldTable.Field(
            tag: 2,
            value: encodeOpenAIOnboardingModelID(exactModelID)
          ),
        ]
      case .abort:
        fields = [try openAIOnboardingKindField(5)]
      case .reconcile(
        let connectionID,
        let credentialIdentityFingerprint
      ):
        fields = [
          try openAIOnboardingKindField(6),
          try FieldTable.Field(
            tag: 2,
            value: encodeOpenAIOnboardingUUID(connectionID)
          ),
          try FieldTable.Field(
            tag: 3,
            value: encodeOpenAIOnboardingFingerprint(
              credentialIdentityFingerprint
            )
          ),
        ]
      }
      return try NativeFrame(
        type: .openAIOnboardingRequest,
        requestID: requestID,
        payload: FieldTable(fields: fields).encoded()
      ).encoded()
    }
  }
}

public struct OpenAIOnboardingBegunMessage:
  NativeOpenAIOnboardingMessage
{
  public let connectionID: UUID
  public let credentialIdentityFingerprint: String

  public init(
    connectionID: UUID,
    credentialIdentityFingerprint: String
  ) throws {
    _ = try encodeOpenAIOnboardingUUID(connectionID)
    _ = try encodeOpenAIOnboardingFingerprint(
      credentialIdentityFingerprint
    )
    self.connectionID = connectionID
    self.credentialIdentityFingerprint = credentialIdentityFingerprint
  }

  public static func decode(
    _ frame: NativeFrame
  ) throws -> OpenAIOnboardingBegunMessage {
    try openAIOnboardingInvalidMessage {
      let fields = try requireOpenAIOnboardingFields(
        frame,
        type: .openAIOnboardingBegun,
        tags: [1, 2]
      )
      return try Self(
        connectionID: decodeOpenAIOnboardingUUID(fields[0].value),
        credentialIdentityFingerprint:
          decodeOpenAIOnboardingFingerprint(fields[1].value)
      )
    }
  }

  public func encodedFrame(requestID: UInt32) throws -> Data {
    try encodeOpenAIOnboardingMessage(
      type: .openAIOnboardingBegun,
      requestID: requestID,
      fields: [
        try FieldTable.Field(
          tag: 1,
          value: encodeOpenAIOnboardingUUID(connectionID)
        ),
        try FieldTable.Field(
          tag: 2,
          value: encodeOpenAIOnboardingFingerprint(
            credentialIdentityFingerprint
          )
        ),
      ]
    )
  }
}

public struct OpenAIOnboardingCatalogPageMessage:
  NativeOpenAIOnboardingMessage
{
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
    try validateOpenAIOnboardingCatalogPage(
      cursor: cursor,
      totalModelCount: totalModelCount,
      nextCursor: nextCursor,
      catalogRequestID: catalogRequestID,
      modelIDs: modelIDs
    )
    self.cursor = cursor
    self.totalModelCount = totalModelCount
    self.nextCursor = nextCursor
    self.catalogRequestID = catalogRequestID
    self.modelIDs = modelIDs
  }

  public static func decode(
    _ frame: NativeFrame
  ) throws -> OpenAIOnboardingCatalogPageMessage {
    try openAIOnboardingInvalidMessage {
      let fields = try requireOpenAIOnboardingFields(
        frame,
        type: .openAIOnboardingCatalogPage,
        tags: [1, 2, 3, 4, 5]
      )
      let rawNextCursor = try FieldTable.decodeUInt16(fields[2].value)
      return try Self(
        cursor: FieldTable.decodeUInt16(fields[0].value),
        totalModelCount: FieldTable.decodeUInt16(fields[1].value),
        nextCursor: rawNextCursor == UInt16.max ? nil : rawNextCursor,
        catalogRequestID:
          decodeOpenAIOnboardingCatalogRequestID(fields[3].value),
        modelIDs: decodeOpenAIOnboardingModelIDs(fields[4].value)
      )
    }
  }

  public func encodedFrame(requestID: UInt32) throws -> Data {
    try validateOpenAIOnboardingCatalogPage(
      cursor: cursor,
      totalModelCount: totalModelCount,
      nextCursor: nextCursor,
      catalogRequestID: catalogRequestID,
      modelIDs: modelIDs
    )
    return try encodeOpenAIOnboardingMessage(
      type: .openAIOnboardingCatalogPage,
      requestID: requestID,
      fields: [
        try FieldTable.Field(tag: 1, value: FieldTable.encodeUInt16(cursor)),
        try FieldTable.Field(
          tag: 2,
          value: FieldTable.encodeUInt16(totalModelCount)
        ),
        try FieldTable.Field(
          tag: 3,
          value: FieldTable.encodeUInt16(nextCursor ?? UInt16.max)
        ),
        try FieldTable.Field(
          tag: 4,
          value: encodeOpenAIOnboardingCatalogRequestID(catalogRequestID)
        ),
        try FieldTable.Field(
          tag: 5,
          value: encodeOpenAIOnboardingModelIDs(modelIDs)
        ),
      ]
    )
  }
}

public struct OpenAIOnboardingCommittedMessage:
  NativeOpenAIOnboardingMessage
{
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
    _ = try encodeOpenAIOnboardingUUID(connectionID)
    _ = try encodeOpenAIOnboardingModelID(selectedModelID)
    guard
      (1...openAIOnboardingMaximumModelCount).contains(
        Int(verifiedModelCount)
      )
    else {
      throw NativeProtocolError.invalidMessage
    }
    _ = try encodeOpenAIOnboardingCatalogRequestID(catalogRequestID)
    self.connectionID = connectionID
    self.selectedModelID = selectedModelID
    self.verifiedModelCount = verifiedModelCount
    self.catalogRequestID = catalogRequestID
  }

  public static func decode(
    _ frame: NativeFrame
  ) throws -> OpenAIOnboardingCommittedMessage {
    try openAIOnboardingInvalidMessage {
      let fields = try requireOpenAIOnboardingFields(
        frame,
        type: .openAIOnboardingCommitted,
        tags: [1, 2, 3, 4]
      )
      return try Self(
        connectionID: decodeOpenAIOnboardingUUID(fields[0].value),
        selectedModelID: decodeOpenAIOnboardingModelID(fields[1].value),
        verifiedModelCount: FieldTable.decodeUInt16(fields[2].value),
        catalogRequestID:
          decodeOpenAIOnboardingCatalogRequestID(fields[3].value)
      )
    }
  }

  public func encodedFrame(requestID: UInt32) throws -> Data {
    try encodeOpenAIOnboardingMessage(
      type: .openAIOnboardingCommitted,
      requestID: requestID,
      fields: [
        try FieldTable.Field(
          tag: 1,
          value: encodeOpenAIOnboardingUUID(connectionID)
        ),
        try FieldTable.Field(
          tag: 2,
          value: encodeOpenAIOnboardingModelID(selectedModelID)
        ),
        try FieldTable.Field(
          tag: 3,
          value: FieldTable.encodeUInt16(verifiedModelCount)
        ),
        try FieldTable.Field(
          tag: 4,
          value: encodeOpenAIOnboardingCatalogRequestID(catalogRequestID)
        ),
      ]
    )
  }
}

public struct OpenAIOnboardingAbortedMessage:
  NativeOpenAIOnboardingMessage
{
  public init() {}

  public static func decode(
    _ frame: NativeFrame
  ) throws -> OpenAIOnboardingAbortedMessage {
    try openAIOnboardingInvalidMessage {
      _ = try requireOpenAIOnboardingFields(
        frame,
        type: .openAIOnboardingAborted,
        tags: []
      )
      return Self()
    }
  }

  public func encodedFrame(requestID: UInt32) throws -> Data {
    try encodeOpenAIOnboardingMessage(
      type: .openAIOnboardingAborted,
      requestID: requestID,
      fields: []
    )
  }
}

public enum OpenAIOnboardingReconciliationStatusCode:
  UInt16,
  CaseIterable,
  Sendable
{
  case readyOpenAI = 1
  case absent = 2
  case unresolved = 3
}

public struct OpenAIOnboardingReconciliationMessage:
  NativeOpenAIOnboardingMessage
{
  public let status: OpenAIOnboardingReconciliationStatusCode

  public init(status: OpenAIOnboardingReconciliationStatusCode) {
    self.status = status
  }

  public static func decode(
    _ frame: NativeFrame
  ) throws -> OpenAIOnboardingReconciliationMessage {
    try openAIOnboardingInvalidMessage {
      let fields = try requireOpenAIOnboardingFields(
        frame,
        type: .openAIOnboardingReconciliation,
        tags: [1]
      )
      guard
        let status = OpenAIOnboardingReconciliationStatusCode(
          rawValue: try FieldTable.decodeUInt16(fields[0].value)
        )
      else {
        throw NativeProtocolError.invalidMessage
      }
      return Self(status: status)
    }
  }

  public func encodedFrame(requestID: UInt32) throws -> Data {
    try encodeOpenAIOnboardingMessage(
      type: .openAIOnboardingReconciliation,
      requestID: requestID,
      fields: [
        try FieldTable.Field(
          tag: 1,
          value: FieldTable.encodeUInt16(status.rawValue)
        )
      ]
    )
  }
}

public enum OpenAIOnboardingFailureCode:
  UInt16,
  CaseIterable,
  Sendable
{
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

public struct OpenAIOnboardingFailureMessage:
  NativeOpenAIOnboardingMessage
{
  public let code: OpenAIOnboardingFailureCode

  public init(code: OpenAIOnboardingFailureCode) {
    self.code = code
  }

  public static func decode(
    _ frame: NativeFrame
  ) throws -> OpenAIOnboardingFailureMessage {
    try openAIOnboardingInvalidMessage {
      let fields = try requireOpenAIOnboardingFields(
        frame,
        type: .openAIOnboardingFailure,
        tags: [1]
      )
      guard
        let code = OpenAIOnboardingFailureCode(
          rawValue: try FieldTable.decodeUInt16(fields[0].value)
        )
      else {
        throw NativeProtocolError.invalidMessage
      }
      return Self(code: code)
    }
  }

  public func encodedFrame(requestID: UInt32) throws -> Data {
    try encodeOpenAIOnboardingMessage(
      type: .openAIOnboardingFailure,
      requestID: requestID,
      fields: [
        try FieldTable.Field(
          tag: 1,
          value: FieldTable.encodeUInt16(code.rawValue)
        )
      ]
    )
  }
}

private let openAIOnboardingZeroUUID = UUID(
  uuid: (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
)

private func openAIOnboardingKindField(
  _ kind: UInt16
) throws -> FieldTable.Field {
  try FieldTable.Field(tag: 1, value: FieldTable.encodeUInt16(kind))
}

private func validateOpenAIOnboardingCatalogCursor(_ cursor: UInt16) throws {
  guard cursor > 0, Int(cursor) < openAIOnboardingMaximumModelCount else {
    throw NativeProtocolError.invalidMessage
  }
}

private func encodeOpenAIOnboardingModelID(_ value: String) throws -> Data {
  let bytes = Array(value.utf8)
  guard
    (1...openAIOnboardingMaximumModelIDUTF8ByteCount).contains(bytes.count),
    !bytes.contains(where: { $0 < 0x20 || $0 == 0x7f })
  else {
    throw NativeProtocolError.invalidMessage
  }
  return Data(bytes)
}

private func decodeOpenAIOnboardingModelID(_ value: Data) throws -> String {
  guard let decoded = String(data: value, encoding: .utf8) else {
    throw NativeProtocolError.invalidMessage
  }
  _ = try encodeOpenAIOnboardingModelID(decoded)
  return decoded
}

private func encodeOpenAIOnboardingUUID(_ value: UUID) throws -> Data {
  guard value != openAIOnboardingZeroUUID else {
    throw NativeProtocolError.invalidMessage
  }
  var uuid = value.uuid
  return withUnsafeBytes(of: &uuid) { Data($0) }
}

private func decodeOpenAIOnboardingUUID(_ value: Data) throws -> UUID {
  let bytes = [UInt8](value)
  guard bytes.count == 16 else { throw NativeProtocolError.invalidMessage }
  let decoded = UUID(
    uuid: (
      bytes[0], bytes[1], bytes[2], bytes[3],
      bytes[4], bytes[5], bytes[6], bytes[7],
      bytes[8], bytes[9], bytes[10], bytes[11],
      bytes[12], bytes[13], bytes[14], bytes[15]
    )
  )
  guard decoded != openAIOnboardingZeroUUID else {
    throw NativeProtocolError.invalidMessage
  }
  return decoded
}

private func encodeOpenAIOnboardingFingerprint(_ value: String) throws -> Data {
  let bytes = Array(value.utf8)
  guard
    bytes.count == 71,
    bytes.prefix(7).elementsEqual("sha256:".utf8),
    bytes.dropFirst(7).allSatisfy({
      (0x30...0x39).contains($0) || (0x61...0x66).contains($0)
    })
  else {
    throw NativeProtocolError.invalidMessage
  }
  return Data(bytes)
}

private func decodeOpenAIOnboardingFingerprint(_ value: Data) throws -> String {
  guard let decoded = String(data: value, encoding: .utf8) else {
    throw NativeProtocolError.invalidMessage
  }
  _ = try encodeOpenAIOnboardingFingerprint(decoded)
  return decoded
}

private func encodeOpenAIOnboardingCatalogRequestID(
  _ value: String?
) throws -> Data {
  guard let value else { return Data() }
  let bytes = Array(value.utf8)
  guard
    (1...openAIOnboardingMaximumCatalogRequestIDUTF8ByteCount).contains(
      bytes.count
    ),
    bytes.allSatisfy({ (0x21...0x7e).contains($0) })
  else {
    throw NativeProtocolError.invalidMessage
  }
  return Data(bytes)
}

private func decodeOpenAIOnboardingCatalogRequestID(
  _ value: Data
) throws -> String? {
  guard !value.isEmpty else { return nil }
  guard let decoded = String(data: value, encoding: .utf8) else {
    throw NativeProtocolError.invalidMessage
  }
  _ = try encodeOpenAIOnboardingCatalogRequestID(decoded)
  return decoded
}

private func validateOpenAIOnboardingCatalogPage(
  cursor: UInt16,
  totalModelCount: UInt16,
  nextCursor: UInt16?,
  catalogRequestID: String?,
  modelIDs: [String]
) throws {
  guard
    (1...openAIOnboardingMaximumModelCount).contains(Int(totalModelCount)),
    Int(cursor) < Int(totalModelCount),
    (1...openAIOnboardingMaximumModelIDsPerPage).contains(modelIDs.count)
  else {
    throw NativeProtocolError.invalidMessage
  }
  let end = Int(cursor) + modelIDs.count
  guard end <= Int(totalModelCount) else {
    throw NativeProtocolError.invalidMessage
  }
  if let nextCursor {
    guard Int(nextCursor) == end, nextCursor < totalModelCount else {
      throw NativeProtocolError.invalidMessage
    }
  } else {
    guard end == Int(totalModelCount) else {
      throw NativeProtocolError.invalidMessage
    }
  }
  _ = try encodeOpenAIOnboardingCatalogRequestID(catalogRequestID)
  var previous: [UInt8]?
  for modelID in modelIDs {
    let bytes = [UInt8](try encodeOpenAIOnboardingModelID(modelID))
    if let previous, !previous.lexicographicallyPrecedes(bytes) {
      throw NativeProtocolError.invalidMessage
    }
    previous = bytes
  }
}

private func encodeOpenAIOnboardingModelIDs(
  _ values: [String]
) throws -> Data {
  guard
    (1...openAIOnboardingMaximumModelIDsPerPage).contains(values.count)
  else {
    throw NativeProtocolError.invalidMessage
  }
  var encoded = [UInt8](FieldTable.encodeUInt16(UInt16(values.count)))
  for value in values {
    let bytes = [UInt8](try encodeOpenAIOnboardingModelID(value))
    encoded.append(contentsOf: FieldTable.encodeUInt16(UInt16(bytes.count)))
    encoded.append(contentsOf: bytes)
  }
  return Data(encoded)
}

private func decodeOpenAIOnboardingModelIDs(
  _ value: Data
) throws -> [String] {
  let bytes = [UInt8](value)
  guard bytes.count >= 2 else { throw NativeProtocolError.invalidMessage }
  let count = Int((UInt16(bytes[0]) << 8) | UInt16(bytes[1]))
  guard
    (1...openAIOnboardingMaximumModelIDsPerPage).contains(count)
  else {
    throw NativeProtocolError.invalidMessage
  }
  var offset = 2
  var values: [String] = []
  values.reserveCapacity(count)
  for _ in 0..<count {
    guard bytes.count - offset >= 2 else {
      throw NativeProtocolError.invalidMessage
    }
    let length = Int(
      (UInt16(bytes[offset]) << 8) | UInt16(bytes[offset + 1])
    )
    offset += 2
    guard length <= bytes.count - offset else {
      throw NativeProtocolError.invalidMessage
    }
    values.append(
      try decodeOpenAIOnboardingModelID(
        Data(bytes[offset..<(offset + length)])
      )
    )
    offset += length
  }
  guard offset == bytes.count else {
    throw NativeProtocolError.invalidMessage
  }
  return values
}

private func requireOpenAIOnboardingFields(
  _ frame: NativeFrame,
  type: NativeMessageType,
  tags: [UInt16]
) throws -> [FieldTable.Field] {
  guard frame.type == type else {
    throw NativeProtocolError.invalidMessage
  }
  let fields = try FieldTable.decode(frame.payload).fields
  try requireOpenAIOnboardingTags(fields, tags)
  return fields
}

private func encodeOpenAIOnboardingMessage(
  type: NativeMessageType,
  requestID: UInt32,
  fields: [FieldTable.Field]
) throws -> Data {
  try openAIOnboardingInvalidMessage {
    try NativeFrame(
      type: type,
      requestID: requestID,
      payload: FieldTable(fields: fields).encoded()
    ).encoded()
  }
}

private func requireOpenAIOnboardingTags(
  _ fields: [FieldTable.Field],
  _ tags: [UInt16]
) throws {
  guard fields.map(\.tag) == tags else {
    throw NativeProtocolError.invalidMessage
  }
}

private func openAIOnboardingInvalidMessage<Value>(
  _ body: () throws -> Value
) throws -> Value {
  do {
    return try body()
  } catch {
    throw NativeProtocolError.invalidMessage
  }
}
