import Foundation

public let nativeFieldMaximumCount = 64
public let nativeTextMaximumUTF8ByteCount = 256
public let nativeNonceByteCount = 32

public struct FieldTable: Equatable, Sendable {
  public struct Field: Equatable, Sendable {
    public let tag: UInt16

    private let valueStorage: [UInt8]

    public var value: Data {
      Data(valueStorage)
    }

    public init(tag: UInt16, value: Data) throws {
      guard value.count <= nativeFrameMaximumPayloadByteCount else {
        throw NativeProtocolError.invalidFieldTable
      }
      self.tag = tag
      self.valueStorage = Array(value)
    }

    fileprivate init(validatedTag tag: UInt16, valueBytes: [UInt8]) {
      self.tag = tag
      self.valueStorage = Array(valueBytes)
    }

    fileprivate func copied() -> Field {
      Field(validatedTag: tag, valueBytes: valueStorage)
    }

    fileprivate var storedValueBytes: [UInt8] {
      Array(valueStorage)
    }
  }

  private let fieldsStorage: [Field]

  public var fields: [Field] {
    fieldsStorage.map { $0.copied() }
  }

  public init(fields: [Field]) throws {
    do {
      guard fields.count <= nativeFieldMaximumCount else {
        throw NativeProtocolError.invalidFieldTable
      }

      var encodedByteCount = 2
      var previousTag: UInt16 = 0
      var storedFields: [Field] = []
      storedFields.reserveCapacity(fields.count)

      for field in fields {
        guard field.tag != 0, field.tag > previousTag else {
          throw NativeProtocolError.invalidFieldTable
        }
        let valueBytes = field.storedValueBytes
        guard
          encodedByteCount <= nativeFrameMaximumPayloadByteCount,
          6 <= nativeFrameMaximumPayloadByteCount - encodedByteCount,
          valueBytes.count <= nativeFrameMaximumPayloadByteCount - encodedByteCount - 6
        else {
          throw NativeProtocolError.invalidFieldTable
        }
        encodedByteCount += 6 + valueBytes.count
        storedFields.append(
          Field(validatedTag: field.tag, valueBytes: valueBytes)
        )
        previousTag = field.tag
      }

      self.fieldsStorage = storedFields
    } catch {
      throw NativeProtocolError.invalidFieldTable
    }
  }

  private init(validatedFields: [Field]) {
    self.fieldsStorage = validatedFields.map { $0.copied() }
  }

  public func encoded() -> Data {
    let snapshots = fieldsStorage.map { field in
      (tag: field.tag, valueBytes: field.storedValueBytes)
    }
    var bytes: [UInt8] = []
    let byteCount =
      2
      + snapshots.reduce(0) {
        $0 + 6 + $1.valueBytes.count
      }
    bytes.reserveCapacity(byteCount)
    nativeAppendUInt16(UInt16(snapshots.count), to: &bytes)
    for snapshot in snapshots {
      nativeAppendUInt16(snapshot.tag, to: &bytes)
      nativeAppendUInt32(UInt32(snapshot.valueBytes.count), to: &bytes)
      bytes.append(contentsOf: snapshot.valueBytes)
    }
    return Data(bytes)
  }

  public static func decode(_ payload: Data) throws -> FieldTable {
    do {
      guard
        payload.count >= 2,
        payload.count <= nativeFrameMaximumPayloadByteCount
      else {
        throw NativeProtocolError.invalidFieldTable
      }

      let bytes = Array(payload)
      guard let rawFieldCount = nativeReadUInt16(bytes, at: 0) else {
        throw NativeProtocolError.invalidFieldTable
      }
      let fieldCount = Int(rawFieldCount)
      guard fieldCount <= nativeFieldMaximumCount else {
        throw NativeProtocolError.invalidFieldTable
      }

      var decodedFields: [Field] = []
      decodedFields.reserveCapacity(fieldCount)
      var offset = 2
      var previousTag: UInt16 = 0

      for _ in 0..<fieldCount {
        guard
          offset <= bytes.count,
          6 <= bytes.count - offset,
          let tag = nativeReadUInt16(bytes, at: offset),
          let rawValueByteCount = nativeReadUInt32(bytes, at: offset + 2),
          tag != 0,
          tag > previousTag,
          rawValueByteCount <= UInt32(nativeFrameMaximumPayloadByteCount)
        else {
          throw NativeProtocolError.invalidFieldTable
        }

        offset += 6
        let valueByteCount = Int(rawValueByteCount)
        guard
          offset <= bytes.count,
          valueByteCount <= bytes.count - offset
        else {
          throw NativeProtocolError.invalidFieldTable
        }

        let valueEnd = offset + valueByteCount
        let valueBytes = Array(bytes[offset..<valueEnd])
        decodedFields.append(
          Field(validatedTag: tag, valueBytes: valueBytes)
        )
        offset = valueEnd
        previousTag = tag
      }

      guard offset == bytes.count else {
        throw NativeProtocolError.invalidFieldTable
      }
      return FieldTable(validatedFields: decodedFields)
    } catch {
      throw NativeProtocolError.invalidFieldTable
    }
  }

  public static func encodeUInt16(_ value: UInt16) -> Data {
    var bytes: [UInt8] = []
    bytes.reserveCapacity(2)
    nativeAppendUInt16(value, to: &bytes)
    return Data(bytes)
  }

  public static func decodeUInt16(_ value: Data) throws -> UInt16 {
    try withInvalidField {
      guard value.count == 2 else {
        throw NativeProtocolError.invalidField
      }
      let bytes = Array(value)
      guard let decoded = nativeReadUInt16(bytes, at: 0) else {
        throw NativeProtocolError.invalidField
      }
      return decoded
    }
  }

  public static func encodeUInt32(_ value: UInt32) -> Data {
    var bytes: [UInt8] = []
    bytes.reserveCapacity(4)
    nativeAppendUInt32(value, to: &bytes)
    return Data(bytes)
  }

  public static func decodeUInt32(_ value: Data) throws -> UInt32 {
    try withInvalidField {
      guard value.count == 4 else {
        throw NativeProtocolError.invalidField
      }
      let bytes = Array(value)
      guard let decoded = nativeReadUInt32(bytes, at: 0) else {
        throw NativeProtocolError.invalidField
      }
      return decoded
    }
  }

  public static func encodeUInt64(_ value: UInt64) -> Data {
    var bytes: [UInt8] = []
    bytes.reserveCapacity(8)
    nativeAppendUInt64(value, to: &bytes)
    return Data(bytes)
  }

  public static func decodeUInt64(_ value: Data) throws -> UInt64 {
    try withInvalidField {
      guard value.count == 8 else {
        throw NativeProtocolError.invalidField
      }
      let bytes = Array(value)
      guard let decoded = nativeReadUInt64(bytes, at: 0) else {
        throw NativeProtocolError.invalidField
      }
      return decoded
    }
  }

  public static func encodeBoolean(_ value: Bool) -> Data {
    Data([value ? 1 : 0])
  }

  public static func decodeBoolean(_ value: Data) throws -> Bool {
    try withInvalidField {
      guard value.count == 1 else {
        throw NativeProtocolError.invalidField
      }
      let bytes = Array(value)
      switch bytes[0] {
      case 0:
        return false
      case 1:
        return true
      default:
        throw NativeProtocolError.invalidField
      }
    }
  }

  public static func encodeNonce(_ value: Data) throws -> Data {
    try withInvalidField {
      guard value.count == nativeNonceByteCount else {
        throw NativeProtocolError.invalidField
      }
      return Data(Array(value))
    }
  }

  public static func decodeNonce(_ value: Data) throws -> Data {
    try withInvalidField {
      guard value.count == nativeNonceByteCount else {
        throw NativeProtocolError.invalidField
      }
      return Data(Array(value))
    }
  }

  public static func encodeVersionText(_ value: String) throws -> Data {
    try withInvalidField {
      let bytes = Array(value.utf8.prefix(nativeTextMaximumUTF8ByteCount + 1))
      guard
        !bytes.isEmpty,
        bytes.count <= nativeTextMaximumUTF8ByteCount
      else {
        throw NativeProtocolError.invalidField
      }
      return Data(bytes)
    }
  }

  public static func decodeVersionText(_ value: Data) throws -> String {
    try withInvalidField {
      guard
        value.count >= 1,
        value.count <= nativeTextMaximumUTF8ByteCount
      else {
        throw NativeProtocolError.invalidField
      }

      let bytes = Array(value)
      guard String(data: Data(bytes), encoding: .utf8) != nil else {
        throw NativeProtocolError.invalidField
      }
      let decoded = String(decoding: bytes, as: UTF8.self)
      guard !decoded.isEmpty else {
        throw NativeProtocolError.invalidField
      }
      return decoded
    }
  }

  private static func withInvalidField<T>(
    _ operation: () throws -> T
  ) throws -> T {
    do {
      return try operation()
    } catch {
      throw NativeProtocolError.invalidField
    }
  }
}
