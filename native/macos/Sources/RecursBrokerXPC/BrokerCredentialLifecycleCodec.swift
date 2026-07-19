import Foundation

public let brokerCredentialMalformedRequestID = UInt64.max
public let brokerCredentialMaximumSecretBytes = 4_096

package struct BrokerCredentialLifecycleCodecError:
  Error,
  Sendable,
  Equatable,
  CustomStringConvertible
{
  package let requestID: UInt64?

  package var description: String {
    "invalid credential lifecycle frame"
  }
}

public enum BrokerCredentialStageModelCatalogBehavior: UInt8, Sendable, Equatable {
  case modelsRoute = 1
  case unavailable = 2
}

public struct BrokerCredentialStageBindingDescriptor: Sendable, Equatable {
  public let activationProfileID: String
  public let customBaseURL: String?
  public let customModelCatalogBehavior: BrokerCredentialStageModelCatalogBehavior?

  public init(
    activationProfileID: String,
    customBaseURL: String? = nil,
    customModelCatalogBehavior: BrokerCredentialStageModelCatalogBehavior? = nil
  ) throws {
    try validateVisibleASCII(
      activationProfileID,
      maximumByteCount: maximumActivationProfileIDBytes
    )
    switch (customBaseURL, customModelCatalogBehavior) {
    case (nil, nil):
      break
    case (let baseURL?, _?):
      try validateVisibleASCII(
        baseURL,
        maximumByteCount: maximumCustomBaseURLBytes
      )
    default:
      throw codecError()
    }
    self.activationProfileID = activationProfileID
    self.customBaseURL = customBaseURL
    self.customModelCatalogBehavior = customModelCatalogBehavior
  }
}

public struct BrokerCredentialStageRequest: Sendable, Equatable {
  public let requestID: UInt64
  public let connectionID: UUID
  public let operationID: UUID
  public let expectedFence: UInt64
  public let providerBinding: BrokerCredentialStageBindingDescriptor

  public init(
    requestID: UInt64,
    connectionID: UUID,
    operationID: UUID,
    expectedFence: UInt64,
    providerBinding: BrokerCredentialStageBindingDescriptor
  ) throws {
    try validateClientRequestID(requestID)
    try validateUUID(connectionID)
    try validateUUID(operationID)
    self.requestID = requestID
    self.connectionID = connectionID
    self.operationID = operationID
    self.expectedFence = expectedFence
    self.providerBinding = providerBinding
  }

  public func encode() throws -> Data {
    try validateClientRequestID(requestID)
    try validateUUID(connectionID)
    try validateUUID(operationID)
    let profileBytes = Array(providerBinding.activationProfileID.utf8)
    let baseBytes = providerBinding.customBaseURL.map { Array($0.utf8) }
    var body: [UInt8] = []
    body.reserveCapacity(52 + profileBytes.count + (baseBytes?.count ?? 0))
    append(requestID, to: &body)
    append(connectionID, to: &body)
    append(operationID, to: &body)
    append(expectedFence, to: &body)
    body.append(UInt8(profileBytes.count))
    body.append(contentsOf: profileBytes)
    append(UInt16(baseBytes?.count ?? 0), to: &body)
    if let baseBytes {
      body.append(contentsOf: baseBytes)
    }
    body.append(providerBinding.customModelCatalogBehavior?.rawValue ?? 0)
    return try encodeFrame(kind: 1, body: body)
  }

  public static func decode(_ data: Data) throws -> BrokerCredentialStageRequest {
    let frame = try decodeFrame(data, allowedKinds: [1])
    var reader = ByteReader(frame.body)
    let requestID = try reader.readClientRequestID()
    return try withRequestID(requestID) {
      let connectionID = try reader.readUUID()
      let operationID = try reader.readUUID()
      let expectedFence = try reader.readUInt64()
      let profileID = try reader.readVisibleASCII(
        count: Int(try reader.readUInt8()),
        maximumByteCount: maximumActivationProfileIDBytes
      )
      let customBaseLength = Int(try reader.readUInt16())
      let customBaseURL: String?
      if customBaseLength == 0 {
        customBaseURL = nil
      } else {
        customBaseURL = try reader.readVisibleASCII(
          count: customBaseLength,
          maximumByteCount: maximumCustomBaseURLBytes
        )
      }
      let catalogRawValue = try reader.readUInt8()
      let catalog: BrokerCredentialStageModelCatalogBehavior?
      if catalogRawValue == 0 {
        catalog = nil
      } else {
        guard
          let parsed = BrokerCredentialStageModelCatalogBehavior(rawValue: catalogRawValue)
        else {
          throw codecError()
        }
        catalog = parsed
      }
      try reader.finish()
      return try BrokerCredentialStageRequest(
        requestID: requestID,
        connectionID: connectionID,
        operationID: operationID,
        expectedFence: expectedFence,
        providerBinding: BrokerCredentialStageBindingDescriptor(
          activationProfileID: profileID,
          customBaseURL: customBaseURL,
          customModelCatalogBehavior: catalog
        )
      )
    }
  }
}

public enum BrokerCredentialControlRequest: Sendable, Equatable {
  case projection(requestID: UInt64, connectionID: UUID)
  case resumeStage(
    requestID: UInt64,
    connectionID: UUID,
    operationID: UUID,
    expectedFence: UInt64
  )
  case reservedOperation(requestID: UInt64)
  case abort(
    requestID: UInt64,
    connectionID: UUID,
    attemptID: UUID,
    operationID: UUID,
    expectedFence: UInt64
  )
  case disconnect(
    requestID: UInt64,
    connectionID: UUID,
    operationID: UUID,
    expectedFence: UInt64
  )

  public func encode() throws -> Data {
    var body: [UInt8] = []
    let kind: UInt16
    switch self {
    case .projection(let requestID, let connectionID):
      try validateClientRequestID(requestID)
      try validateUUID(connectionID)
      kind = 2
      body.reserveCapacity(24)
      append(requestID, to: &body)
      append(connectionID, to: &body)
    case .resumeStage(let requestID, let connectionID, let operationID, let expectedFence):
      try validateClientRequestID(requestID)
      try validateUUID(connectionID)
      try validateUUID(operationID)
      kind = 3
      body.reserveCapacity(48)
      append(requestID, to: &body)
      append(connectionID, to: &body)
      append(operationID, to: &body)
      append(expectedFence, to: &body)
    case .reservedOperation(let requestID):
      try validateClientRequestID(requestID)
      kind = 4
      body.reserveCapacity(8)
      append(requestID, to: &body)
    case .abort(
      let requestID,
      let connectionID,
      let attemptID,
      let operationID,
      let expectedFence
    ):
      try validateClientRequestID(requestID)
      try validateUUID(connectionID)
      try validateUUID(attemptID)
      try validateUUID(operationID)
      kind = 5
      body.reserveCapacity(64)
      append(requestID, to: &body)
      append(connectionID, to: &body)
      append(attemptID, to: &body)
      append(operationID, to: &body)
      append(expectedFence, to: &body)
    case .disconnect(let requestID, let connectionID, let operationID, let expectedFence):
      try validateClientRequestID(requestID)
      try validateUUID(connectionID)
      try validateUUID(operationID)
      kind = 6
      body.reserveCapacity(48)
      append(requestID, to: &body)
      append(connectionID, to: &body)
      append(operationID, to: &body)
      append(expectedFence, to: &body)
    }
    return try encodeFrame(kind: kind, body: body)
  }

  public static func decode(_ data: Data) throws -> BrokerCredentialControlRequest {
    let frame = try decodeFrame(data, allowedKinds: [2, 3, 4, 5, 6])
    var reader = ByteReader(frame.body)
    let requestID = try reader.readClientRequestID()
    return try withRequestID(requestID) {
      switch frame.kind {
      case 2:
        guard frame.body.count == 24 else { throw codecError() }
        let connectionID = try reader.readUUID()
        try reader.finish()
        return .projection(requestID: requestID, connectionID: connectionID)
      case 3:
        guard frame.body.count == 48 else { throw codecError() }
        let connectionID = try reader.readUUID()
        let operationID = try reader.readUUID()
        let expectedFence = try reader.readUInt64()
        try reader.finish()
        return .resumeStage(
          requestID: requestID,
          connectionID: connectionID,
          operationID: operationID,
          expectedFence: expectedFence
        )
      case 4:
        guard frame.body.count == 8 else { throw codecError() }
        try reader.finish()
        return .reservedOperation(requestID: requestID)
      case 5:
        guard frame.body.count == 64 else { throw codecError() }
        let connectionID = try reader.readUUID()
        let attemptID = try reader.readUUID()
        let operationID = try reader.readUUID()
        let expectedFence = try reader.readUInt64()
        try reader.finish()
        return .abort(
          requestID: requestID,
          connectionID: connectionID,
          attemptID: attemptID,
          operationID: operationID,
          expectedFence: expectedFence
        )
      case 6:
        guard frame.body.count == 48 else { throw codecError() }
        let connectionID = try reader.readUUID()
        let operationID = try reader.readUUID()
        let expectedFence = try reader.readUInt64()
        try reader.finish()
        return .disconnect(
          requestID: requestID,
          connectionID: connectionID,
          operationID: operationID,
          expectedFence: expectedFence
        )
      default:
        throw codecError()
      }
    }
  }
}

public enum BrokerCredentialRedactedState: UInt8, Sendable {
  case missing = 1
  case vacant = 2
  case staging = 3
  case ready = 4
  case tombstoned = 5
}

public enum BrokerCredentialLifecycleFailureCode: UInt16, Sendable {
  case invalidRequest = 1
  case sessionNotReady = 2
  case capacityExceeded = 3
  case cancelled = 4
  case notFound = 5
  case disconnected = 6
  case staleFence = 7
  case conflict = 8
  case busy = 9
  case credentialStoreUnavailable = 10
  case cleanupPending = 11
  case operationUnavailable = 12
  case authorityUnavailable = 13
}

public struct BrokerCredentialRedactedProjection: Sendable, Equatable {
  public let state: BrokerCredentialRedactedState
  public let fence: UInt64
  public let hasUsableReady: Bool
  public let attemptID: UUID?

  public init(
    state: BrokerCredentialRedactedState,
    fence: UInt64,
    hasUsableReady: Bool,
    attemptID: UUID?
  ) throws {
    switch state {
    case .missing:
      guard fence == 0, !hasUsableReady, attemptID == nil else { throw codecError() }
    case .vacant:
      guard !hasUsableReady, attemptID == nil else { throw codecError() }
    case .staging:
      guard fence > 0, let attemptID else { throw codecError() }
      try validateUUID(attemptID)
    case .ready:
      guard fence > 0, hasUsableReady, attemptID == nil else { throw codecError() }
    case .tombstoned:
      guard fence > 0, !hasUsableReady, attemptID == nil else { throw codecError() }
    }
    self.state = state
    self.fence = fence
    self.hasUsableReady = hasUsableReady
    self.attemptID = attemptID
  }
}

public enum BrokerCredentialLifecycleReply: Sendable, Equatable {
  case projection(requestID: UInt64, BrokerCredentialRedactedProjection)
  case staged(requestID: UInt64, BrokerCredentialRedactedProjection)
  case mutation(requestID: UInt64, BrokerCredentialRedactedProjection)
  case failure(requestID: UInt64, BrokerCredentialLifecycleFailureCode)

  public func encode() throws -> Data {
    switch self {
    case .projection(let requestID, let projection):
      try validateClientRequestID(requestID)
      return try encodeProjectionReply(kind: 101, requestID: requestID, projection: projection)
    case .staged(let requestID, let projection):
      try validateClientRequestID(requestID)
      guard projection.state == .staging else { throw codecError() }
      return try encodeProjectionReply(kind: 102, requestID: requestID, projection: projection)
    case .mutation(let requestID, let projection):
      try validateClientRequestID(requestID)
      guard [.vacant, .ready, .tombstoned].contains(projection.state) else {
        throw codecError()
      }
      return try encodeProjectionReply(kind: 103, requestID: requestID, projection: projection)
    case .failure(let requestID, let code):
      try validateFailureRequestID(requestID, code: code)
      var body: [UInt8] = []
      body.reserveCapacity(10)
      append(requestID, to: &body)
      append(code.rawValue, to: &body)
      return try encodeFrame(kind: 255, body: body)
    }
  }

  public static func decode(_ data: Data) throws -> BrokerCredentialLifecycleReply {
    let frame = try decodeFrame(data, allowedKinds: [101, 102, 103, 255])
    var reader = ByteReader(frame.body)
    let rawRequestID = try reader.readUInt64()
    let requestContext = isClientRequestID(rawRequestID) ? rawRequestID : nil
    return try withRequestID(requestContext) {
      if frame.kind == 255 {
        guard frame.body.count == 10 else { throw codecError() }
        let rawCode = try reader.readUInt16()
        guard let code = BrokerCredentialLifecycleFailureCode(rawValue: rawCode) else {
          throw codecError()
        }
        try reader.finish()
        try validateFailureRequestID(rawRequestID, code: code)
        return .failure(requestID: rawRequestID, code)
      }

      try validateClientRequestID(rawRequestID)
      let projection = try decodeProjection(from: &reader)
      try reader.finish()
      switch frame.kind {
      case 101:
        return .projection(requestID: rawRequestID, projection)
      case 102:
        guard projection.state == .staging else { throw codecError() }
        return .staged(requestID: rawRequestID, projection)
      case 103:
        guard [.vacant, .ready, .tombstoned].contains(projection.state) else {
          throw codecError()
        }
        return .mutation(requestID: rawRequestID, projection)
      default:
        throw codecError()
      }
    }
  }
}

private let credentialLifecycleMagic: UInt32 = 0x5243_434c
private let credentialLifecycleVersion: UInt16 = 1
private let maximumActivationProfileIDBytes = 64
private let maximumCustomBaseURLBytes = 2_048
private let maximumCredentialLifecycleBodyBytes = 2_164
private let zeroUUID = UUID(
  uuid: (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
)

private struct CredentialLifecycleFrame {
  let kind: UInt16
  let body: [UInt8]
}

private struct ByteReader {
  private let bytes: [UInt8]
  private var offset = 0

  init(_ bytes: [UInt8]) {
    self.bytes = bytes
  }

  mutating func readUInt8() throws -> UInt8 {
    guard offset < bytes.count else { throw codecError() }
    defer { offset += 1 }
    return bytes[offset]
  }

  mutating func readUInt16() throws -> UInt16 {
    guard bytes.count - offset >= 2 else { throw codecError() }
    defer { offset += 2 }
    return (UInt16(bytes[offset]) << 8) | UInt16(bytes[offset + 1])
  }

  mutating func readVisibleASCII(
    count: Int,
    maximumByteCount: Int
  ) throws -> String {
    guard
      (1...maximumByteCount).contains(count),
      bytes.count - offset >= count
    else {
      throw codecError()
    }
    let value = Array(bytes[offset..<(offset + count)])
    guard value.allSatisfy({ (0x21...0x7e).contains($0) }) else {
      throw codecError()
    }
    offset += count
    return String(decoding: value, as: UTF8.self)
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

  mutating func readClientRequestID() throws -> UInt64 {
    let value = try readUInt64()
    try validateClientRequestID(value)
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

  func finish() throws {
    guard offset == bytes.count else { throw codecError() }
  }
}

private func codecError(requestID: UInt64? = nil) -> BrokerCredentialLifecycleCodecError {
  BrokerCredentialLifecycleCodecError(requestID: requestID)
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
  requestID > 0 && requestID < brokerCredentialMalformedRequestID
}

private func validateClientRequestID(_ requestID: UInt64) throws {
  guard isClientRequestID(requestID) else { throw codecError() }
}

private func validateFailureRequestID(
  _ requestID: UInt64,
  code: BrokerCredentialLifecycleFailureCode
) throws {
  guard
    isClientRequestID(requestID)
      || (requestID == brokerCredentialMalformedRequestID && code == .invalidRequest)
  else {
    throw codecError()
  }
}

private func validateUUID(_ value: UUID) throws {
  guard value != zeroUUID else { throw codecError() }
}

private func validateVisibleASCII(
  _ value: String,
  maximumByteCount: Int
) throws {
  let bytes = Array(value.utf8)
  guard
    (1...maximumByteCount).contains(bytes.count),
    bytes.allSatisfy({ (0x21...0x7e).contains($0) })
  else {
    throw codecError()
  }
}

private func encodeFrame(kind: UInt16, body: [UInt8]) throws -> Data {
  guard body.count <= maximumCredentialLifecycleBodyBytes else { throw codecError() }
  var bytes: [UInt8] = []
  bytes.reserveCapacity(12 + body.count)
  append(credentialLifecycleMagic, to: &bytes)
  append(credentialLifecycleVersion, to: &bytes)
  append(kind, to: &bytes)
  append(UInt32(body.count), to: &bytes)
  bytes.append(contentsOf: body)
  return Data(bytes)
}

private func decodeFrame(
  _ data: Data,
  allowedKinds: Set<UInt16>
) throws -> CredentialLifecycleFrame {
  guard data.count >= 12, data.count <= 12 + maximumCredentialLifecycleBodyBytes else {
    throw codecError()
  }
  let bytes = [UInt8](data)
  let magic = readUInt32(bytes, at: 0)
  let version = readUInt16(bytes, at: 4)
  let kind = readUInt16(bytes, at: 6)
  let bodyLength = Int(readUInt32(bytes, at: 8))
  guard
    magic == credentialLifecycleMagic,
    version == credentialLifecycleVersion,
    allowedKinds.contains(kind),
    bodyLength <= maximumCredentialLifecycleBodyBytes,
    bytes.count == 12 + bodyLength
  else {
    throw codecError()
  }
  return CredentialLifecycleFrame(kind: kind, body: Array(bytes.dropFirst(12)))
}

private func encodeProjectionReply(
  kind: UInt16,
  requestID: UInt64,
  projection: BrokerCredentialRedactedProjection
) throws -> Data {
  let canonical = try BrokerCredentialRedactedProjection(
    state: projection.state,
    fence: projection.fence,
    hasUsableReady: projection.hasUsableReady,
    attemptID: projection.attemptID
  )
  var body: [UInt8] = []
  body.reserveCapacity(canonical.attemptID == nil ? 18 : 34)
  append(requestID, to: &body)
  body.append(canonical.state.rawValue)
  append(canonical.fence, to: &body)
  body.append(canonical.hasUsableReady ? 1 : 0)
  if let attemptID = canonical.attemptID {
    append(attemptID, to: &body)
  }
  return try encodeFrame(kind: kind, body: body)
}

private func decodeProjection(
  from reader: inout ByteReader
) throws -> BrokerCredentialRedactedProjection {
  let rawState = try reader.readUInt8()
  guard let state = BrokerCredentialRedactedState(rawValue: rawState) else {
    throw codecError()
  }
  let fence = try reader.readUInt64()
  let rawUsable = try reader.readUInt8()
  guard rawUsable <= 1 else { throw codecError() }
  let attemptID = state == .staging ? try reader.readUUID() : nil
  return try BrokerCredentialRedactedProjection(
    state: state,
    fence: fence,
    hasUsableReady: rawUsable == 1,
    attemptID: attemptID
  )
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
