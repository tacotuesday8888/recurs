import Foundation

public let nativeAuthorityProtocolVersion: UInt16 = 1
public let nativeFrameMagic: UInt32 = 0x52_43_55_52
public let nativeFrameHeaderByteCount = 16
public let nativeFrameMaximumPayloadByteCount = 8 * 1024 * 1024

private let nativeFrameMaximumByteCount =
  nativeFrameHeaderByteCount + nativeFrameMaximumPayloadByteCount

public enum NativeMessageType: UInt16, CaseIterable, Sendable {
  case hello = 1
  case helloResult = 2
  case health = 3
  case healthResult = 4
  case cancel = 5
  case openAIOnboardingRequest = 6
  case openAIOnboardingBegun = 7
  case openAIOnboardingCatalogPage = 8
  case openAIOnboardingCommitted = 9
  case openAIOnboardingAborted = 10
  case openAIOnboardingReconciliation = 11
  case openAIOnboardingFailure = 12
  case openAIGenerationRequest = 13
  case openAIGenerationEvent = 14
  case openAIGenerationFailure = 15
  case safeFailure = 255
}

public enum NativeProtocolError: Error, Equatable, Sendable, LocalizedError {
  case invalidFrame
  case truncatedFrame
  case decoderFinished
  case decoderFailed
  case invalidFieldTable
  case invalidField
  case invalidMessage

  public var errorDescription: String? {
    switch self {
    case .invalidFrame:
      "Invalid native authority frame."
    case .truncatedFrame:
      "Truncated native authority frame."
    case .decoderFinished:
      "Native authority decoder is finished."
    case .decoderFailed:
      "Native authority decoder has failed."
    case .invalidFieldTable:
      "Invalid native authority field table."
    case .invalidField:
      "Invalid native authority field."
    case .invalidMessage:
      "Invalid native authority message."
    }
  }
}

public struct NativeFrame: Equatable, Sendable {
  public let type: NativeMessageType
  public let requestID: UInt32

  private let payloadStorage: [UInt8]

  public var payload: Data {
    Data(payloadStorage)
  }

  public init(
    type: NativeMessageType,
    requestID: UInt32,
    payload: Data
  ) throws {
    guard requestID != 0, payload.count <= nativeFrameMaximumPayloadByteCount else {
      throw NativeProtocolError.invalidFrame
    }
    self.type = type
    self.requestID = requestID
    self.payloadStorage = Array(payload)
  }

  internal init(
    validatedType type: NativeMessageType,
    requestID: UInt32,
    payloadBytes: [UInt8]
  ) {
    self.type = type
    self.requestID = requestID
    self.payloadStorage = Array(payloadBytes)
  }

  public func encoded() throws -> Data {
    guard requestID != 0, payloadStorage.count <= nativeFrameMaximumPayloadByteCount else {
      throw NativeProtocolError.invalidFrame
    }

    var bytes: [UInt8] = []
    bytes.reserveCapacity(nativeFrameHeaderByteCount + payloadStorage.count)
    nativeAppendUInt32(nativeFrameMagic, to: &bytes)
    nativeAppendUInt16(nativeAuthorityProtocolVersion, to: &bytes)
    nativeAppendUInt16(type.rawValue, to: &bytes)
    nativeAppendUInt32(UInt32(payloadStorage.count), to: &bytes)
    nativeAppendUInt32(requestID, to: &bytes)
    bytes.append(contentsOf: payloadStorage)
    return Data(bytes)
  }
}

public struct NativeFrameDecoder: Sendable {
  private enum State: Sendable {
    case open
    case finished
    case failed
  }

  private var state = State.open
  private var bufferedBytes: [UInt8] = []
  private var bufferedHeader: NativeFrameHeader?

  public init() {}

  package var isAwaitingFrameCompletion: Bool {
    guard case .open = state else {
      return false
    }
    return !bufferedBytes.isEmpty
  }

  public mutating func push(_ chunk: Data) throws -> [NativeFrame] {
    try ensureOpen()
    guard !chunk.isEmpty else {
      return []
    }

    do {
      let input = Array(chunk)
      var frames: [NativeFrame] = []
      var offset = 0

      while offset < input.count || !bufferedBytes.isEmpty {
        if !bufferedBytes.isEmpty {
          if bufferedBytes.count < nativeFrameHeaderByteCount {
            let needed = nativeFrameHeaderByteCount - bufferedBytes.count
            let available = input.count - offset
            let take = min(needed, available)
            try appendBuffered(input, offset: offset, count: take)
            offset += take
            if bufferedBytes.count < nativeFrameHeaderByteCount {
              break
            }
          }

          let header: NativeFrameHeader
          if let existingHeader = bufferedHeader {
            header = existingHeader
          } else {
            header = try nativeParseFrameHeader(bufferedBytes, offset: 0)
            bufferedHeader = header
          }

          let needed = header.frameByteCount - bufferedBytes.count
          let available = input.count - offset
          let take = min(needed, available)
          try appendBuffered(input, offset: offset, count: take)
          offset += take
          if bufferedBytes.count < header.frameByteCount {
            break
          }

          frames.append(
            try nativeMakeFrame(from: bufferedBytes, offset: 0, header: header)
          )
          clearBuffered(releaseStorage: false)
          continue
        }

        let remaining = input.count - offset
        if remaining < nativeFrameHeaderByteCount {
          try appendBuffered(input, offset: offset, count: remaining)
          offset = input.count
          break
        }

        let header = try nativeParseFrameHeader(input, offset: offset)
        if remaining < header.frameByteCount {
          try appendBuffered(input, offset: offset, count: remaining)
          bufferedHeader = header
          offset = input.count
          break
        }

        frames.append(try nativeMakeFrame(from: input, offset: offset, header: header))
        offset += header.frameByteCount
      }

      return frames
    } catch {
      poison()
      throw NativeProtocolError.invalidFrame
    }
  }

  public mutating func finish() throws {
    try ensureOpen()
    guard bufferedBytes.isEmpty else {
      poison()
      throw NativeProtocolError.truncatedFrame
    }
    clearBuffered(releaseStorage: true)
    state = .finished
  }

  private func ensureOpen() throws {
    switch state {
    case .open:
      return
    case .finished:
      throw NativeProtocolError.decoderFinished
    case .failed:
      throw NativeProtocolError.decoderFailed
    }
  }

  private mutating func appendBuffered(
    _ source: [UInt8],
    offset: Int,
    count: Int
  ) throws {
    guard
      offset >= 0,
      count >= 0,
      offset <= source.count,
      count <= source.count - offset,
      bufferedBytes.count <= nativeFrameMaximumByteCount,
      count <= nativeFrameMaximumByteCount - bufferedBytes.count
    else {
      throw NativeProtocolError.invalidFrame
    }
    guard count > 0 else {
      return
    }

    if bufferedBytes.isEmpty {
      bufferedBytes.reserveCapacity(nativeFrameMaximumByteCount)
    }
    bufferedBytes.append(contentsOf: source[offset..<(offset + count)])
  }

  private mutating func clearBuffered(releaseStorage: Bool) {
    for index in bufferedBytes.indices {
      bufferedBytes[index] = 0
    }
    bufferedBytes.removeAll(keepingCapacity: !releaseStorage)
    bufferedHeader = nil
  }

  private mutating func poison() {
    clearBuffered(releaseStorage: true)
    state = .failed
  }
}

private struct NativeFrameHeader: Sendable {
  let type: NativeMessageType
  let requestID: UInt32
  let payloadByteCount: Int
  let frameByteCount: Int
}

private func nativeParseFrameHeader(
  _ bytes: [UInt8],
  offset: Int
) throws -> NativeFrameHeader {
  guard
    offset >= 0,
    offset <= bytes.count,
    nativeFrameHeaderByteCount <= bytes.count - offset,
    let magic = nativeReadUInt32(bytes, at: offset),
    let protocolVersion = nativeReadUInt16(bytes, at: offset + 4),
    let rawType = nativeReadUInt16(bytes, at: offset + 6),
    let rawPayloadByteCount = nativeReadUInt32(bytes, at: offset + 8),
    let requestID = nativeReadUInt32(bytes, at: offset + 12),
    magic == nativeFrameMagic,
    protocolVersion == nativeAuthorityProtocolVersion,
    let type = NativeMessageType(rawValue: rawType),
    requestID != 0,
    rawPayloadByteCount <= UInt32(nativeFrameMaximumPayloadByteCount)
  else {
    throw NativeProtocolError.invalidFrame
  }

  let payloadByteCount = Int(rawPayloadByteCount)
  return NativeFrameHeader(
    type: type,
    requestID: requestID,
    payloadByteCount: payloadByteCount,
    frameByteCount: nativeFrameHeaderByteCount + payloadByteCount
  )
}

private func nativeMakeFrame(
  from bytes: [UInt8],
  offset: Int,
  header: NativeFrameHeader
) throws -> NativeFrame {
  guard
    offset >= 0,
    offset <= bytes.count,
    header.frameByteCount <= bytes.count - offset
  else {
    throw NativeProtocolError.invalidFrame
  }

  let payloadOffset = offset + nativeFrameHeaderByteCount
  let payloadEnd = payloadOffset + header.payloadByteCount
  let payloadBytes = Array(bytes[payloadOffset..<payloadEnd])
  return NativeFrame(
    validatedType: header.type,
    requestID: header.requestID,
    payloadBytes: payloadBytes
  )
}

internal func nativeReadUInt16(_ bytes: [UInt8], at offset: Int) -> UInt16? {
  guard offset >= 0, offset <= bytes.count, 2 <= bytes.count - offset else {
    return nil
  }
  return (UInt16(bytes[offset]) << 8)
    | UInt16(bytes[offset + 1])
}

internal func nativeReadUInt32(_ bytes: [UInt8], at offset: Int) -> UInt32? {
  guard offset >= 0, offset <= bytes.count, 4 <= bytes.count - offset else {
    return nil
  }
  return (UInt32(bytes[offset]) << 24)
    | (UInt32(bytes[offset + 1]) << 16)
    | (UInt32(bytes[offset + 2]) << 8)
    | UInt32(bytes[offset + 3])
}

internal func nativeReadUInt64(_ bytes: [UInt8], at offset: Int) -> UInt64? {
  guard offset >= 0, offset <= bytes.count, 8 <= bytes.count - offset else {
    return nil
  }
  var value: UInt64 = 0
  for index in 0..<8 {
    value = (value << 8) | UInt64(bytes[offset + index])
  }
  return value
}

internal func nativeAppendUInt16(_ value: UInt16, to bytes: inout [UInt8]) {
  bytes.append(UInt8((value >> 8) & 0xff))
  bytes.append(UInt8(value & 0xff))
}

internal func nativeAppendUInt32(_ value: UInt32, to bytes: inout [UInt8]) {
  bytes.append(UInt8((value >> 24) & 0xff))
  bytes.append(UInt8((value >> 16) & 0xff))
  bytes.append(UInt8((value >> 8) & 0xff))
  bytes.append(UInt8(value & 0xff))
}

internal func nativeAppendUInt64(_ value: UInt64, to bytes: inout [UInt8]) {
  for shift in stride(from: 56, through: 0, by: -8) {
    bytes.append(UInt8((value >> UInt64(shift)) & 0xff))
  }
}
