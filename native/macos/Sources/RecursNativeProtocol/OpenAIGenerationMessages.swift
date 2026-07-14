import Foundation

public enum OpenAIGenerationFailureCode: UInt16, CaseIterable, Sendable {
  case cancelled = 1
  case invalidRequest = 2
  case requestTooLarge = 3
  case invalidCredential = 4
  case routeUnavailable = 5
  case deliveryUncertain = 6
  case invalidResponse = 7
  case responseTooLarge = 8
  case authenticationRejected = 9
  case rateLimited = 10
  case providerUnavailable = 11
  case requestRejected = 12
  case contentFiltered = 13
  case providerFailure = 14
  case credentialEchoDetected = 15
}

public struct OpenAIGenerationRequestMessage: Equatable, Sendable {
  private static let maximumBodyByteCount = nativeFrameMaximumPayloadByteCount - 8
  private let storage: [UInt8]

  public var body: Data { Data(storage) }

  public init(body: Data) throws {
    self.storage = try Self.validated(body)
  }

  private init(validatedBytes: [UInt8]) {
    storage = validatedBytes
  }

  public static func decode(_ frame: NativeFrame) throws -> OpenAIGenerationRequestMessage {
    try openAIGenerationInvalidMessage {
      let fields = try requireOpenAIGenerationFields(
        frame,
        type: .openAIGenerationRequest,
        tags: [1]
      )
      return OpenAIGenerationRequestMessage(
        validatedBytes: try validated(fields[0].value)
      )
    }
  }

  public func encodedFrame(requestID: UInt32) throws -> Data {
    try NativeFrame(
      type: .openAIGenerationRequest,
      requestID: requestID,
      payload: try FieldTable(fields: [
        FieldTable.Field(tag: 1, value: Data(storage))
      ]).encoded()
    ).encoded()
  }

  private static func validated(_ body: Data) throws -> [UInt8] {
    guard (1...maximumBodyByteCount).contains(body.count) else {
      throw NativeProtocolError.invalidMessage
    }
    return Array(body)
  }
}

public struct OpenAIGenerationEventMessage: Equatable, Sendable {
  private static let maximumBodyByteCount = 1_048_576
  private let storage: [UInt8]

  public var body: Data { Data(storage) }

  public init(body: Data) throws {
    storage = try Self.validated(body)
  }

  private init(validatedBytes: [UInt8]) {
    storage = validatedBytes
  }

  public static func decode(_ frame: NativeFrame) throws -> OpenAIGenerationEventMessage {
    try openAIGenerationInvalidMessage {
      let fields = try requireOpenAIGenerationFields(
        frame,
        type: .openAIGenerationEvent,
        tags: [1]
      )
      return OpenAIGenerationEventMessage(
        validatedBytes: try validated(fields[0].value)
      )
    }
  }

  public func encodedFrame(requestID: UInt32) throws -> Data {
    try NativeFrame(
      type: .openAIGenerationEvent,
      requestID: requestID,
      payload: try FieldTable(fields: [
        FieldTable.Field(tag: 1, value: Data(storage))
      ]).encoded()
    ).encoded()
  }

  private static func validated(_ body: Data) throws -> [UInt8] {
    guard (1...maximumBodyByteCount).contains(body.count) else {
      throw NativeProtocolError.invalidMessage
    }
    return Array(body)
  }
}

public struct OpenAIGenerationFailureMessage: Equatable, Sendable {
  public let code: OpenAIGenerationFailureCode

  public init(code: OpenAIGenerationFailureCode) {
    self.code = code
  }

  public static func decode(_ frame: NativeFrame) throws -> OpenAIGenerationFailureMessage {
    try openAIGenerationInvalidMessage {
      let fields = try requireOpenAIGenerationFields(
        frame,
        type: .openAIGenerationFailure,
        tags: [1]
      )
      let raw = try FieldTable.decodeUInt16(fields[0].value)
      guard let code = OpenAIGenerationFailureCode(rawValue: raw) else {
        throw NativeProtocolError.invalidMessage
      }
      return OpenAIGenerationFailureMessage(code: code)
    }
  }

  public func encodedFrame(requestID: UInt32) throws -> Data {
    try NativeFrame(
      type: .openAIGenerationFailure,
      requestID: requestID,
      payload: try FieldTable(fields: [
        FieldTable.Field(tag: 1, value: FieldTable.encodeUInt16(code.rawValue))
      ]).encoded()
    ).encoded()
  }
}

private func requireOpenAIGenerationFields(
  _ frame: NativeFrame,
  type: NativeMessageType,
  tags: [UInt16]
) throws -> [FieldTable.Field] {
  guard frame.type == type else { throw NativeProtocolError.invalidMessage }
  let fields = try FieldTable.decode(frame.payload).fields
  guard fields.map(\.tag) == tags else { throw NativeProtocolError.invalidMessage }
  return fields
}

private func openAIGenerationInvalidMessage<Value>(
  _ body: () throws -> Value
) throws -> Value {
  do {
    return try body()
  } catch {
    throw NativeProtocolError.invalidMessage
  }
}
