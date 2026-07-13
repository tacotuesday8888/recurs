import Foundation

public enum KeychainStatusCode: UInt16, CaseIterable, Sendable {
  case available = 1
  case locked = 2
  case unavailable = 3
}

public enum SafeFailureCode: UInt16, CaseIterable, Sendable {
  case unsupportedPlatform = 1
  case unsupportedOSVersion = 2
  case launcherUnavailable = 3
  case brokerUnavailable = 4
  case protocolMismatch = 5
  case peerIdentityUnverified = 6
  case productionSigningRequired = 7
  case keychainUnavailable = 8
  case unsupportedOperation = 9
}

public struct HelloMessage: Equatable, Sendable {
  public let engineVersion: String

  private let nonceStorage: [UInt8]

  public var nonce: Data {
    Data(nonceStorage)
  }

  public init(engineVersion: String, nonce: Data) throws {
    _ = try FieldTable.encodeVersionText(engineVersion)
    let storedNonce = try FieldTable.encodeNonce(nonce)
    self.engineVersion = engineVersion
    self.nonceStorage = Array(storedNonce)
  }

  private init(
    validatedEngineVersion engineVersion: String,
    nonceBytes: [UInt8]
  ) {
    self.engineVersion = engineVersion
    self.nonceStorage = Array(nonceBytes)
  }

  public static func decode(_ frame: NativeFrame) throws -> HelloMessage {
    try withInvalidMessage {
      let fields = try requireFields(frame, type: .hello, tags: [1, 2])
      let engineVersion = try FieldTable.decodeVersionText(fields[0].value)
      let nonce = try FieldTable.decodeNonce(fields[1].value)
      return HelloMessage(
        validatedEngineVersion: engineVersion,
        nonceBytes: Array(nonce)
      )
    }
  }

  public func encodedFrame(requestID: UInt32) throws -> Data {
    let table = try FieldTable(fields: [
      FieldTable.Field(
        tag: 1,
        value: try FieldTable.encodeVersionText(engineVersion)
      ),
      FieldTable.Field(tag: 2, value: Data(nonceStorage)),
    ])
    return try NativeFrame(
      type: .hello,
      requestID: requestID,
      payload: table.encoded()
    ).encoded()
  }
}

public struct HelloResultMessage: Equatable, Sendable {
  public let launcherVersion: String
  public let brokerVersion: String
  public let productionSigned: Bool
  public let persistentCredentials: Bool
  public let minimumMacosVersion: String

  private let echoedNonceStorage: [UInt8]

  public var echoedNonce: Data {
    Data(echoedNonceStorage)
  }

  public init(
    launcherVersion: String,
    brokerVersion: String,
    echoedNonce: Data,
    productionSigned: Bool,
    persistentCredentials: Bool,
    minimumMacosVersion: String
  ) throws {
    guard minimumMacosVersion == "14.4" else {
      throw NativeProtocolError.invalidMessage
    }
    _ = try FieldTable.encodeVersionText(launcherVersion)
    _ = try FieldTable.encodeVersionText(brokerVersion)
    _ = try FieldTable.encodeVersionText(minimumMacosVersion)
    let storedNonce = try FieldTable.encodeNonce(echoedNonce)

    self.launcherVersion = launcherVersion
    self.brokerVersion = brokerVersion
    self.echoedNonceStorage = Array(storedNonce)
    self.productionSigned = productionSigned
    self.persistentCredentials = persistentCredentials
    self.minimumMacosVersion = minimumMacosVersion
  }

  private init(
    validatedLauncherVersion launcherVersion: String,
    brokerVersion: String,
    echoedNonceBytes: [UInt8],
    productionSigned: Bool,
    persistentCredentials: Bool
  ) {
    self.launcherVersion = launcherVersion
    self.brokerVersion = brokerVersion
    self.echoedNonceStorage = Array(echoedNonceBytes)
    self.productionSigned = productionSigned
    self.persistentCredentials = persistentCredentials
    self.minimumMacosVersion = "14.4"
  }

  public static func decode(_ frame: NativeFrame) throws -> HelloResultMessage {
    try withInvalidMessage {
      let fields = try requireFields(
        frame,
        type: .helloResult,
        tags: [1, 2, 3, 4, 5, 6]
      )
      let launcherVersion = try FieldTable.decodeVersionText(fields[0].value)
      let brokerVersion = try FieldTable.decodeVersionText(fields[1].value)
      let echoedNonce = try FieldTable.decodeNonce(fields[2].value)
      let productionSigned = try FieldTable.decodeBoolean(fields[3].value)
      let persistentCredentials = try FieldTable.decodeBoolean(fields[4].value)
      let minimumMacosVersion = try FieldTable.decodeVersionText(fields[5].value)
      guard minimumMacosVersion == "14.4" else {
        throw NativeProtocolError.invalidMessage
      }

      return HelloResultMessage(
        validatedLauncherVersion: launcherVersion,
        brokerVersion: brokerVersion,
        echoedNonceBytes: Array(echoedNonce),
        productionSigned: productionSigned,
        persistentCredentials: persistentCredentials
      )
    }
  }

  public func encodedFrame(requestID: UInt32) throws -> Data {
    let table = try FieldTable(fields: [
      FieldTable.Field(
        tag: 1,
        value: try FieldTable.encodeVersionText(launcherVersion)
      ),
      FieldTable.Field(
        tag: 2,
        value: try FieldTable.encodeVersionText(brokerVersion)
      ),
      FieldTable.Field(tag: 3, value: Data(echoedNonceStorage)),
      FieldTable.Field(tag: 4, value: FieldTable.encodeBoolean(productionSigned)),
      FieldTable.Field(tag: 5, value: FieldTable.encodeBoolean(persistentCredentials)),
      FieldTable.Field(
        tag: 6,
        value: try FieldTable.encodeVersionText(minimumMacosVersion)
      ),
    ])
    return try NativeFrame(
      type: .helloResult,
      requestID: requestID,
      payload: table.encoded()
    ).encoded()
  }
}

public struct HealthResultMessage: Equatable, Sendable {
  public let keychain: KeychainStatusCode
  public let peerVerified: Bool

  public init(keychain: KeychainStatusCode, peerVerified: Bool) {
    self.keychain = keychain
    self.peerVerified = peerVerified
  }

  public static func decode(_ frame: NativeFrame) throws -> HealthResultMessage {
    try withInvalidMessage {
      let fields = try requireFields(frame, type: .healthResult, tags: [1, 2])
      let rawKeychain = try FieldTable.decodeUInt16(fields[0].value)
      guard let keychain = KeychainStatusCode(rawValue: rawKeychain) else {
        throw NativeProtocolError.invalidMessage
      }
      let peerVerified = try FieldTable.decodeBoolean(fields[1].value)
      return HealthResultMessage(keychain: keychain, peerVerified: peerVerified)
    }
  }

  public func encodedFrame(requestID: UInt32) throws -> Data {
    let table = try FieldTable(fields: [
      FieldTable.Field(tag: 1, value: FieldTable.encodeUInt16(keychain.rawValue)),
      FieldTable.Field(tag: 2, value: FieldTable.encodeBoolean(peerVerified)),
    ])
    return try NativeFrame(
      type: .healthResult,
      requestID: requestID,
      payload: table.encoded()
    ).encoded()
  }
}

public func makeHealthFrame(requestID: UInt32) throws -> Data {
  let table = try FieldTable(fields: [])
  return try NativeFrame(
    type: .health,
    requestID: requestID,
    payload: table.encoded()
  ).encoded()
}

public func makeCancelFrame(
  requestID: UInt32,
  targetRequestID: UInt32
) throws -> Data {
  guard targetRequestID != 0 else {
    throw NativeProtocolError.invalidMessage
  }
  let table = try FieldTable(fields: [
    FieldTable.Field(tag: 1, value: FieldTable.encodeUInt32(targetRequestID))
  ])
  return try NativeFrame(
    type: .cancel,
    requestID: requestID,
    payload: table.encoded()
  ).encoded()
}

extension SafeFailureCode {
  public static func decode(_ frame: NativeFrame) throws -> SafeFailureCode {
    try withInvalidMessage {
      let fields = try requireFields(frame, type: .safeFailure, tags: [1])
      let rawCode = try FieldTable.decodeUInt16(fields[0].value)
      guard let code = SafeFailureCode(rawValue: rawCode) else {
        throw NativeProtocolError.invalidMessage
      }
      return code
    }
  }

  public func encodedFrame(requestID: UInt32) throws -> Data {
    let table = try FieldTable(fields: [
      FieldTable.Field(tag: 1, value: FieldTable.encodeUInt16(rawValue))
    ])
    return try NativeFrame(
      type: .safeFailure,
      requestID: requestID,
      payload: table.encoded()
    ).encoded()
  }
}

private func requireFields(
  _ frame: NativeFrame,
  type: NativeMessageType,
  tags: [UInt16]
) throws -> [FieldTable.Field] {
  guard frame.type == type else {
    throw NativeProtocolError.invalidMessage
  }
  let fields = try FieldTable.decode(frame.payload).fields
  guard fields.count == tags.count else {
    throw NativeProtocolError.invalidMessage
  }
  for (field, expectedTag) in zip(fields, tags) {
    guard field.tag == expectedTag else {
      throw NativeProtocolError.invalidMessage
    }
  }
  return fields
}

private func withInvalidMessage<T>(
  _ operation: () throws -> T
) throws -> T {
  do {
    return try operation()
  } catch {
    throw NativeProtocolError.invalidMessage
  }
}
