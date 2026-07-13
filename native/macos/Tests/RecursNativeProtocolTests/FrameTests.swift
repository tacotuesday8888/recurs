import Foundation
import Testing

@testable import RecursNativeProtocol

@Suite("Native authority protocol")
struct FrameTests {
  private let nonce = Data((0..<32).map(UInt8.init))

  @Test
  func testWireConstantsEnumsAndFixedErrors() {
    #expect(nativeAuthorityProtocolVersion == 1)
    #expect(nativeFrameMagic == 0x52_43_55_52)
    #expect(nativeFrameHeaderByteCount == 16)
    #expect(nativeFrameMaximumPayloadByteCount == 64 * 1024)
    #expect(nativeFieldMaximumCount == 64)
    #expect(nativeTextMaximumUTF8ByteCount == 256)
    #expect(nativeNonceByteCount == 32)

    #expect(NativeMessageType.hello.rawValue == 1)
    #expect(NativeMessageType.helloResult.rawValue == 2)
    #expect(NativeMessageType.health.rawValue == 3)
    #expect(NativeMessageType.healthResult.rawValue == 4)
    #expect(NativeMessageType.cancel.rawValue == 5)
    #expect(NativeMessageType.safeFailure.rawValue == 255)

    #expect(KeychainStatusCode.available.rawValue == 1)
    #expect(KeychainStatusCode.locked.rawValue == 2)
    #expect(KeychainStatusCode.unavailable.rawValue == 3)

    #expect(SafeFailureCode.unsupportedPlatform.rawValue == 1)
    #expect(SafeFailureCode.unsupportedOSVersion.rawValue == 2)
    #expect(SafeFailureCode.launcherUnavailable.rawValue == 3)
    #expect(SafeFailureCode.brokerUnavailable.rawValue == 4)
    #expect(SafeFailureCode.protocolMismatch.rawValue == 5)
    #expect(SafeFailureCode.peerIdentityUnverified.rawValue == 6)
    #expect(SafeFailureCode.productionSigningRequired.rawValue == 7)
    #expect(SafeFailureCode.keychainUnavailable.rawValue == 8)
    #expect(SafeFailureCode.unsupportedOperation.rawValue == 9)

    let descriptions: [(NativeProtocolError, String)] = [
      (.invalidFrame, "Invalid native authority frame."),
      (.truncatedFrame, "Truncated native authority frame."),
      (.decoderFinished, "Native authority decoder is finished."),
      (.decoderFailed, "Native authority decoder has failed."),
      (.invalidFieldTable, "Invalid native authority field table."),
      (.invalidField, "Invalid native authority field."),
      (.invalidMessage, "Invalid native authority message."),
    ]
    for (error, description) in descriptions {
      #expect(error.errorDescription == description)
      #expect(!(description.localizedCaseInsensitiveContains("credential")))
      #expect(!(description.localizedCaseInsensitiveContains("authorization")))
      #expect(!(description.localizedCaseInsensitiveContains("token")))
      #expect(!(description.localizedCaseInsensitiveContains("secret")))
    }
  }

  @Test
  func testGoldenFixturesDecodeAndReencodeAtEverySplitPoint() throws {
    let fixture = try loadFixture()
    #expect(fixture.schemaVersion == 1)
    #expect(
      fixture.frames.map(\.name)
        == ["hello", "helloResult", "health", "healthResult", "safeFailure"]
    )
    #expect(fixture.frames.map(\.requestID) == [1, 2, 3, 4, 5])

    let expectedTypes: [String: NativeMessageType] = [
      "hello": .hello,
      "helloResult": .helloResult,
      "health": .health,
      "healthResult": .healthResult,
      "safeFailure": .safeFailure,
    ]

    for golden in fixture.frames {
      let bytes = try #require(Data(strictHex: golden.hex))
      for split in 0...bytes.count {
        var decoder = NativeFrameDecoder()
        let prefix = Data(bytes.prefix(split))
        let suffix = Data(bytes.dropFirst(split))
        let frames = try decoder.push(prefix) + decoder.push(suffix)
        try decoder.finish()

        let frame = try #require(frames.only)
        #expect(frame.type == expectedTypes[golden.name])
        #expect(frame.requestID == golden.requestID)
        #expect(try frame.encoded() == bytes)
      }
    }
  }

  @Test
  func testGoldenFixturesHaveExactSemanticValuesAndSemanticEncodings() throws {
    let fixture = try loadFixture()
    let frames = try Dictionary(
      uniqueKeysWithValues: fixture.frames.map { golden in
        let bytes = try #require(Data(strictHex: golden.hex))
        return (golden.name, try decodeSingleFrame(bytes))
      })

    let hello = try HelloMessage.decode(try #require(frames["hello"]))
    #expect(hello.engineVersion == "0.1.0")
    #expect(hello.nonce == nonce)

    let helloResult = try HelloResultMessage.decode(try #require(frames["helloResult"]))
    #expect(helloResult.launcherVersion == "0.1.0")
    #expect(helloResult.brokerVersion == "0.1.0")
    #expect(helloResult.echoedNonce == nonce)
    #expect(helloResult.productionSigned)
    #expect(helloResult.persistentCredentials)
    #expect(helloResult.minimumMacosVersion == "14.4")

    let health = try #require(frames["health"])
    #expect(try FieldTable.decode(health.payload).fields == [])

    let healthResult = try HealthResultMessage.decode(try #require(frames["healthResult"]))
    #expect(healthResult.keychain == .available)
    #expect(healthResult.peerVerified)

    #expect(
      try SafeFailureCode.decode(try #require(frames["safeFailure"]))
        == .protocolMismatch
    )

    let byName = Dictionary(uniqueKeysWithValues: fixture.frames.map { ($0.name, $0.hex) })
    #expect(
      try HelloMessage(engineVersion: "0.1.0", nonce: nonce)
        .encodedFrame(requestID: 1).hex
        == byName["hello"]
    )
    #expect(
      try HelloResultMessage(
        launcherVersion: "0.1.0",
        brokerVersion: "0.1.0",
        echoedNonce: nonce,
        productionSigned: true,
        persistentCredentials: true,
        minimumMacosVersion: "14.4"
      ).encodedFrame(requestID: 2).hex
        == byName["helloResult"]
    )
    #expect(try makeHealthFrame(requestID: 3).hex == byName["health"])
    #expect(
      try HealthResultMessage(keychain: .available, peerVerified: true)
        .encodedFrame(requestID: 4).hex
        == byName["healthResult"]
    )
    #expect(
      try SafeFailureCode.protocolMismatch.encodedFrame(requestID: 5).hex
        == byName["safeFailure"]
    )
    #expect(
      try makeCancelFrame(requestID: 9, targetRequestID: 7).hex
        == "52435552000100050000000c00000009000100010000000400000007"
    )
  }

  @Test
  func testTypedHealthAndCancelRequestsRoundTripWithExactEncodings() throws {
    let health = HealthMessage()
    let encodedHealth = try health.encodedFrame(requestID: 3)
    #expect(encodedHealth.hex == "524355520001000300000002000000030000")
    #expect(try HealthMessage.decode(decodeSingleFrame(encodedHealth)) == health)
    #expect(try makeHealthFrame(requestID: 3) == encodedHealth)

    let cancel = try CancelMessage(targetRequestID: 7)
    let encodedCancel = try cancel.encodedFrame(requestID: 9)
    #expect(
      encodedCancel.hex
        == "52435552000100050000000c00000009000100010000000400000007"
    )
    #expect(try CancelMessage.decode(decodeSingleFrame(encodedCancel)) == cancel)
    #expect(
      try makeCancelFrame(requestID: 9, targetRequestID: 7) == encodedCancel
    )
  }

  @Test
  func testTypedHealthRequestRejectsEveryMalformedCategory() throws {
    let malformed = [
      try semanticFrame(type: .cancel, fields: []),
      try semanticFrame(type: .health, fields: [(1, Data())]),
      try NativeFrame(type: .health, requestID: 1, payload: Data()),
      try NativeFrame(type: .health, requestID: 1, payload: Data([0, 0, 0])),
    ]

    for frame in malformed {
      expectProtocolError(.invalidMessage) { try HealthMessage.decode(frame) }
    }
    expectProtocolError(.invalidMessage) {
      try HealthMessage().encodedFrame(requestID: 0)
    }
    expectProtocolError(.invalidMessage) { try makeHealthFrame(requestID: 0) }
  }

  @Test
  func testTypedCancelRequestRejectsEveryMalformedCategory() throws {
    expectProtocolError(.invalidMessage) {
      try CancelMessage(targetRequestID: 0)
    }

    let malformed = [
      try semanticFrame(type: .health, fields: [(1, uint32(7))]),
      try semanticFrame(type: .cancel, fields: []),
      try semanticFrame(type: .cancel, fields: [(1, uint32(0))]),
      try semanticFrame(type: .cancel, fields: [(1, uint16(7))]),
      try semanticFrame(type: .cancel, fields: [(1, uint32(7)), (2, Data())]),
      try NativeFrame(type: .cancel, requestID: 1, payload: Data()),
    ]

    for frame in malformed {
      expectProtocolError(.invalidMessage) { try CancelMessage.decode(frame) }
    }
    expectProtocolError(.invalidMessage) {
      try CancelMessage(targetRequestID: 7).encodedFrame(requestID: 0)
    }
    expectProtocolError(.invalidMessage) {
      try makeCancelFrame(requestID: 0, targetRequestID: 7)
    }
  }

  @Test
  func testDecoderRejectsMalformedHeadersAndPermanentlyPoisons() throws {
    let malformed: [Data] = [
      rawFrame(type: 3, requestID: 1, payload: uint16(0), magic: 0x52_43_55_53),
      rawFrame(type: 3, requestID: 1, payload: uint16(0), protocolVersion: 2),
      rawFrame(type: 3, requestID: 0, payload: uint16(0)),
      rawFrame(type: 6, requestID: 1, payload: uint16(0)),
      rawFrame(type: 0, requestID: 1, payload: uint16(0)),
      rawFrame(
        type: 3,
        requestID: 1,
        payload: Data(),
        advertisedPayloadLength: UInt32(nativeFrameMaximumPayloadByteCount + 1)
      ),
    ]

    for bytes in malformed {
      var decoder = NativeFrameDecoder()
      expectProtocolError(.invalidFrame) { try decoder.push(bytes) }
      expectProtocolError(.decoderFailed) { try decoder.push(Data()) }
      expectProtocolError(.decoderFailed) { try decoder.finish() }
    }
  }

  @Test
  func testDecoderPoisonsWhenMalformedHeaderCompletesAcrossPushes() throws {
    let bytes = rawFrame(type: 3, requestID: 1, payload: uint16(0), protocolVersion: 2)
    var decoder = NativeFrameDecoder()
    #expect(try decoder.push(Data(bytes.prefix(5))) == [])
    expectProtocolError(.invalidFrame) { try decoder.push(Data(bytes.dropFirst(5))) }
    expectProtocolError(.decoderFailed) { try decoder.push(Data()) }
  }

  @Test
  func testDecoderIsNotAwaitingCompletionWithoutBufferedPartialBytes() throws {
    let first = rawFrame(type: 3, requestID: 1, payload: uint16(0))
    let second = rawFrame(type: 3, requestID: 2, payload: uint16(0))
    var decoder = NativeFrameDecoder()

    #expect(!decoder.isAwaitingFrameCompletion)
    #expect(try decoder.push(Data()) == [])
    #expect(!decoder.isAwaitingFrameCompletion)
    #expect(try decoder.push(first).map(\.requestID) == [1])
    #expect(!decoder.isAwaitingFrameCompletion)
    #expect(try decoder.push(concatenate(first, second)).map(\.requestID) == [1, 2])
    #expect(!decoder.isAwaitingFrameCompletion)
  }

  @Test
  func testDecoderAwaitsAtEveryPartialSplitOnlyUntilCompletion() throws {
    let bytes = rawFrame(type: 3, requestID: 7, payload: uint16(0))

    for split in 1..<bytes.count {
      var decoder = NativeFrameDecoder()
      #expect(try decoder.push(Data(bytes.prefix(split))) == [])
      #expect(decoder.isAwaitingFrameCompletion)

      #expect(try decoder.push(Data(bytes.dropFirst(split))).map(\.requestID) == [7])
      #expect(!decoder.isAwaitingFrameCompletion)
    }
  }

  @Test
  func testDecoderCompletionStateIsFalseAfterFinishAndFailure() throws {
    var finishedDecoder = NativeFrameDecoder()
    try finishedDecoder.finish()
    #expect(!finishedDecoder.isAwaitingFrameCompletion)
    expectProtocolError(.decoderFinished) { try finishedDecoder.push(Data()) }
    expectProtocolError(.decoderFinished) { try finishedDecoder.finish() }

    let malformed = rawFrame(
      type: 3,
      requestID: 1,
      payload: uint16(0),
      protocolVersion: 2
    )
    var failedDecoder = NativeFrameDecoder()
    #expect(try failedDecoder.push(Data(malformed.prefix(5))) == [])
    #expect(failedDecoder.isAwaitingFrameCompletion)
    expectProtocolError(.invalidFrame) {
      try failedDecoder.push(Data(malformed.dropFirst(5)))
    }
    #expect(!failedDecoder.isAwaitingFrameCompletion)
    expectProtocolError(.decoderFailed) { try failedDecoder.push(Data()) }
    expectProtocolError(.decoderFailed) { try failedDecoder.finish() }
  }

  @Test
  func testDecoderSealsCleanlyAndEmptyPushIsANoOp() throws {
    var decoder = NativeFrameDecoder()
    #expect(try decoder.push(Data()) == [])
    #expect(try decoder.push(Data()) == [])
    try decoder.finish()
    expectProtocolError(.decoderFinished) { try decoder.finish() }
    expectProtocolError(.decoderFinished) { try decoder.push(Data()) }
    expectProtocolError(.decoderFinished) { try decoder.push(Data([1])) }
  }

  @Test
  func testDecoderFailsClosedForTruncatedStreamsThenRemainsFailed() throws {
    let bytes = rawFrame(type: 3, requestID: 1, payload: uint16(0))
    for length in [1, nativeFrameHeaderByteCount - 1, nativeFrameHeaderByteCount + 1] {
      var decoder = NativeFrameDecoder()
      #expect(try decoder.push(Data(bytes.prefix(length))) == [])
      expectProtocolError(.truncatedFrame) { try decoder.finish() }
      expectProtocolError(.decoderFailed) { try decoder.finish() }
      expectProtocolError(.decoderFailed) { try decoder.push(Data()) }
    }
  }

  @Test
  func testDecoderTreatsTrailingBytesAsATruncatedNextFrame() throws {
    let complete = rawFrame(type: 3, requestID: 1, payload: uint16(0))
    var decoder = NativeFrameDecoder()
    #expect(try decoder.push(concatenate(complete, Data([0xca]))).count == 1)
    expectProtocolError(.truncatedFrame) { try decoder.finish() }
  }

  @Test
  func testDecoderReturnsMultipleFramesWithoutTrackingTerminalRequestIDs() throws {
    let terminal = rawFrame(
      type: NativeMessageType.healthResult.rawValue,
      requestID: 8,
      payload: rawFieldTable([
        (1, uint16(1)),
        (2, Data([1])),
      ])
    )
    var decoder = NativeFrameDecoder()
    let frames = try decoder.push(concatenate(terminal, terminal))
    try decoder.finish()

    #expect(frames.map(\.requestID) == [8, 8])
    #expect(frames.map(\.type) == [.healthResult, .healthResult])
  }

  @Test
  func testDecoderAndFrameGettersCopyCallerOwnedBytes() throws {
    let bytes = rawFrame(type: 3, requestID: 11, payload: uint16(0))
    var prefix = Data(bytes.prefix(8))
    var suffix = Data(bytes.dropFirst(8))
    var decoder = NativeFrameDecoder()

    #expect(try decoder.push(prefix) == [])
    prefix.resetBytes(in: prefix.startIndex..<prefix.endIndex)
    let frames = try decoder.push(suffix)
    suffix.resetBytes(in: suffix.startIndex..<suffix.endIndex)
    try decoder.finish()

    let frame = try #require(frames.only)
    #expect(frame.requestID == 11)
    #expect(frame.payload == uint16(0))
    var firstRead = frame.payload
    firstRead.resetBytes(in: firstRead.startIndex..<firstRead.endIndex)
    #expect(frame.payload == uint16(0))
  }

  @Test
  func testDecoderAcceptsExactMaximumAndOneByteFragmentationIsBounded() throws {
    var payload = Data(repeating: 0, count: nativeFrameMaximumPayloadByteCount)
    payload[payload.startIndex] = 0xa5
    payload[payload.index(before: payload.endIndex)] = 0x5a
    let wire = try NativeFrame(type: .health, requestID: 16, payload: payload).encoded()

    var decoder = NativeFrameDecoder()
    var decoded: [NativeFrame] = []
    for byte in wire {
      decoded.append(contentsOf: try decoder.push(Data([byte])))
    }
    try decoder.finish()

    let frame = try #require(decoded.only)
    #expect(frame.payload.count == nativeFrameMaximumPayloadByteCount)
    #expect(frame.payload.first == 0xa5)
    #expect(frame.payload.last == 0x5a)

    expectProtocolError(.invalidFrame) {
      try NativeFrame(
        type: .health,
        requestID: 1,
        payload: Data(repeating: 0, count: nativeFrameMaximumPayloadByteCount + 1)
      )
    }
  }

  @Test
  func testExactRequestAndFieldTableMaximumsRoundTrip() throws {
    let maximumValue = Data(
      repeating: 0xa5,
      count: nativeFrameMaximumPayloadByteCount - 8
    )
    let table = try FieldTable(fields: [
      FieldTable.Field(tag: UInt16.max, value: maximumValue)
    ])
    let encodedTable = table.encoded()
    #expect(encodedTable.count == nativeFrameMaximumPayloadByteCount)
    #expect(try FieldTable.decode(encodedTable).fields[0].value == maximumValue)

    let wire = try NativeFrame(
      type: .health,
      requestID: UInt32.max,
      payload: encodedTable
    ).encoded()
    let frame = try decodeSingleFrame(wire)
    #expect(frame.requestID == UInt32.max)
    #expect(try frame.encoded() == wire)
  }

  @Test
  func testBigEndianScalarsRoundTripAndRejectWrongWidths() throws {
    #expect(FieldTable.encodeUInt16(0xabcd).hex == "abcd")
    #expect(try FieldTable.decodeUInt16(Data([0xab, 0xcd])) == 0xabcd)
    #expect(FieldTable.encodeUInt32(0x89ab_cdef).hex == "89abcdef")
    #expect(
      try FieldTable.decodeUInt32(Data([0x89, 0xab, 0xcd, 0xef]))
        == 0x89ab_cdef
    )
    #expect(FieldTable.encodeUInt64(0x0123_4567_89ab_cdef).hex == "0123456789abcdef")
    #expect(
      try FieldTable.decodeUInt64(Data([0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]))
        == 0x0123_4567_89ab_cdef
    )
    #expect(
      try FieldTable.decodeUInt64(FieldTable.encodeUInt64(UInt64.max))
        == UInt64.max
    )

    expectProtocolError(.invalidField) { try FieldTable.decodeUInt16(Data([1])) }
    expectProtocolError(.invalidField) { try FieldTable.decodeUInt32(Data(repeating: 0, count: 5)) }
    expectProtocolError(.invalidField) { try FieldTable.decodeUInt64(Data(repeating: 0, count: 7)) }
  }

  @Test
  func testBooleanAndNonceCodecsAreExactAndCopy() throws {
    #expect(FieldTable.encodeBoolean(false) == Data([0]))
    #expect(FieldTable.encodeBoolean(true) == Data([1]))
    #expect(!(try FieldTable.decodeBoolean(Data([0]))))
    #expect(try FieldTable.decodeBoolean(Data([1])))
    expectProtocolError(.invalidField) { try FieldTable.decodeBoolean(Data()) }
    expectProtocolError(.invalidField) { try FieldTable.decodeBoolean(Data([2])) }
    expectProtocolError(.invalidField) { try FieldTable.decodeBoolean(Data([0, 1])) }

    var source = nonce
    let encoded = try FieldTable.encodeNonce(source)
    source.resetBytes(in: source.startIndex..<source.endIndex)
    #expect(encoded == nonce)
    var decoded = try FieldTable.decodeNonce(encoded)
    decoded.resetBytes(in: decoded.startIndex..<decoded.endIndex)
    #expect(try FieldTable.decodeNonce(encoded) == nonce)

    expectProtocolError(.invalidField) {
      try FieldTable.encodeNonce(Data(repeating: 0, count: nativeNonceByteCount - 1))
    }
    expectProtocolError(.invalidField) {
      try FieldTable.encodeNonce(Data(repeating: 0, count: nativeNonceByteCount + 1))
    }
    expectProtocolError(.invalidField) {
      try FieldTable.decodeNonce(Data(repeating: 0, count: nativeNonceByteCount - 1))
    }
  }

  @Test
  func testTextCodecIsFatalByteBoundedAndPreservesBOM() throws {
    #expect(
      try FieldTable.decodeVersionText(FieldTable.encodeVersionText("0.1.0"))
        == "0.1.0"
    )
    let bom = try #require(Data(strictHex: "efbbbf302e312e30"))
    #expect(try FieldTable.decodeVersionText(bom) == "\u{feff}0.1.0")
    #expect(try FieldTable.encodeVersionText("\u{feff}0.1.0") == bom)
    #expect(
      try FieldTable.decodeVersionText(FieldTable.encodeVersionText("release-🚀"))
        == "release-🚀"
    )
    let exactMaximum = String(repeating: "é", count: 128)
    #expect(
      try FieldTable.decodeVersionText(FieldTable.encodeVersionText(exactMaximum))
        == exactMaximum
    )

    expectProtocolError(.invalidField) { try FieldTable.encodeVersionText("") }
    expectProtocolError(.invalidField) {
      try FieldTable.encodeVersionText(String(repeating: "a", count: 257))
    }
    expectProtocolError(.invalidField) { try FieldTable.decodeVersionText(Data()) }
    expectProtocolError(.invalidField) {
      try FieldTable.decodeVersionText(try #require(Data(strictHex: "c0af")))
    }
    expectProtocolError(.invalidField) {
      try FieldTable.decodeVersionText(Data(repeating: 0x61, count: 257))
    }

    let canaryBytes = concatenate(Data([0xc0, 0xaf]), Data("SECRET_CANARY".utf8))
    let error = expectProtocolError(.invalidField) {
      try FieldTable.decodeVersionText(canaryBytes)
    }
    #expect(!(error.localizedDescription.contains("SECRET_CANARY")))
  }

  @Test
  func testFieldTablesEncodeDecodeAscendingFieldsAndCopyValues() throws {
    var firstValue = Data([1, 2, 3])
    let table = try FieldTable(fields: [
      FieldTable.Field(tag: 1, value: firstValue),
      FieldTable.Field(tag: UInt16.max, value: Data()),
    ])
    firstValue.resetBytes(in: firstValue.startIndex..<firstValue.endIndex)
    #expect(table.encoded().hex == "0002000100000003010203ffff00000000")

    var encoded = table.encoded()
    let decoded = try FieldTable.decode(encoded)
    encoded.resetBytes(in: encoded.startIndex..<encoded.endIndex)
    #expect(decoded.fields.count == 2)
    var exposedFields = decoded.fields
    exposedFields.removeAll()
    #expect(decoded.fields.count == 2)
    #expect(decoded.fields[0].tag == 1)
    #expect(decoded.fields[0].value == Data([1, 2, 3]))
    var exposed = decoded.fields[0].value
    exposed.resetBytes(in: exposed.startIndex..<exposed.endIndex)
    #expect(decoded.fields[0].value == Data([1, 2, 3]))
  }

  @Test
  func testFieldTablesAcceptExactly64Fields() throws {
    let fields = try (1...64).map {
      try FieldTable.Field(tag: UInt16($0), value: Data())
    }
    #expect(try FieldTable.decode(FieldTable(fields: fields).encoded()).fields.count == 64)
  }

  @Test
  func testFieldTableDecoderRejectsEveryMalformedCategory() throws {
    let malformed: [Data] = [
      rawFieldTable([(0, Data())]),
      rawFieldTable([(1, Data()), (1, Data())]),
      rawFieldTable([(2, Data()), (1, Data())]),
      uint16(65),
      Data([0]),
      concatenate(uint16(1), uint16(1), Data([0])),
      concatenate(uint16(1), uint16(1), uint32(2), Data([1])),
      concatenate(uint16(0), Data([0])),
      Data(repeating: 0, count: nativeFrameMaximumPayloadByteCount + 1),
    ]

    for bytes in malformed {
      expectProtocolError(.invalidFieldTable) { try FieldTable.decode(bytes) }
    }
  }

  @Test
  func testFieldTableEncoderRejectsEveryMalformedCategory() throws {
    expectProtocolError(.invalidFieldTable) {
      try FieldTable(fields: [FieldTable.Field(tag: 0, value: Data())])
    }
    expectProtocolError(.invalidFieldTable) {
      try FieldTable(fields: [
        FieldTable.Field(tag: 1, value: Data()),
        FieldTable.Field(tag: 1, value: Data()),
      ])
    }
    expectProtocolError(.invalidFieldTable) {
      try FieldTable(fields: [
        FieldTable.Field(tag: 2, value: Data()),
        FieldTable.Field(tag: 1, value: Data()),
      ])
    }
    expectProtocolError(.invalidFieldTable) {
      let fields = try (1...65).map {
        try FieldTable.Field(tag: UInt16($0), value: Data())
      }
      return try FieldTable(fields: fields)
    }
    expectProtocolError(.invalidFieldTable) {
      try FieldTable.Field(
        tag: 1,
        value: Data(repeating: 0, count: nativeFrameMaximumPayloadByteCount + 1)
      )
    }
    expectProtocolError(.invalidFieldTable) {
      try FieldTable(fields: [
        FieldTable.Field(
          tag: 1,
          value: Data(repeating: 0, count: nativeFrameMaximumPayloadByteCount)
        )
      ])
    }
  }

  @Test
  func testSemanticDecodersMapOnlyFixedKeychainAndSafeFailureValues() throws {
    let keychainValues: [KeychainStatusCode] = [.available, .locked, .unavailable]
    for code in UInt16(1)...3 {
      let frame = try semanticFrame(
        type: .healthResult,
        fields: [(1, uint16(code)), (2, Data([UInt8(code % 2)]))]
      )
      let result = try HealthResultMessage.decode(frame)
      #expect(result.keychain == keychainValues[Int(code - 1)])
      #expect(result.peerVerified == (code % 2 == 1))
    }
    let invalidKeychain = try semanticFrame(
      type: .healthResult,
      fields: [(1, uint16(4)), (2, Data([1]))]
    )
    expectProtocolError(.invalidMessage) {
      try HealthResultMessage.decode(invalidKeychain)
    }

    let failures: [SafeFailureCode] = [
      .unsupportedPlatform,
      .unsupportedOSVersion,
      .launcherUnavailable,
      .brokerUnavailable,
      .protocolMismatch,
      .peerIdentityUnverified,
      .productionSigningRequired,
      .keychainUnavailable,
      .unsupportedOperation,
    ]
    for code in UInt16(1)...9 {
      let frame = try semanticFrame(type: .safeFailure, fields: [(1, uint16(code))])
      #expect(try SafeFailureCode.decode(frame) == failures[Int(code - 1)])
    }
    for code in [UInt16(0), 10, UInt16.max] {
      let frame = try semanticFrame(type: .safeFailure, fields: [(1, uint16(code))])
      expectProtocolError(.invalidMessage) { try SafeFailureCode.decode(frame) }
    }
  }

  @Test
  func testHelloResultRequiresExactMinimumMacosVersion() throws {
    for version in ["", "14.3", "14.4.0", "15.0"] {
      let frame = try semanticFrame(
        type: .helloResult,
        fields: helloResultFields(
          minimumMacosVersion: Data(version.utf8)
        ))
      expectProtocolError(.invalidMessage) { try HelloResultMessage.decode(frame) }
    }
  }

  @Test
  func testSemanticDecodersRejectUnknownMissingDuplicateAndWrongLengthFields() throws {
    let cases: [(NativeMessageType, [(UInt16, Data)], (NativeFrame) throws -> Void)] = [
      (.hello, helloFields(), { _ = try HelloMessage.decode($0) }),
      (.helloResult, helloResultFields(), { _ = try HelloResultMessage.decode($0) }),
      (
        .healthResult,
        [(1, uint16(1)), (2, Data([1]))],
        { _ = try HealthResultMessage.decode($0) }
      ),
      (.safeFailure, [(1, uint16(5))], { _ = try SafeFailureCode.decode($0) }),
    ]

    for (type, validFields, decode) in cases {
      let unknown = try NativeFrame(
        type: type,
        requestID: 1,
        payload: rawFieldTable(validFields + [(UInt16.max, Data())])
      )
      expectProtocolError(.invalidMessage) { try decode(unknown) }

      let missing = try NativeFrame(
        type: type,
        requestID: 1,
        payload: rawFieldTable(Array(validFields.dropFirst()))
      )
      expectProtocolError(.invalidMessage) { try decode(missing) }

      let duplicate = try NativeFrame(
        type: type,
        requestID: 1,
        payload: rawFieldTable([validFields[0], validFields[0]] + validFields.dropFirst())
      )
      expectProtocolError(.invalidMessage) { try decode(duplicate) }

      var wrongLengthFields = validFields
      wrongLengthFields[0] = (validFields[0].0, Data())
      let wrongLength = try NativeFrame(
        type: type,
        requestID: 1,
        payload: rawFieldTable(wrongLengthFields)
      )
      expectProtocolError(.invalidMessage) { try decode(wrongLength) }
    }
  }

  @Test
  func testSemanticDecodersRejectWrongFrameTypesAndMalformedScalars() throws {
    let helloAsHealth = try NativeFrame(
      type: .healthResult,
      requestID: 1,
      payload: rawFieldTable(helloFields())
    )
    let healthAsFailure = try semanticFrame(
      type: .safeFailure,
      fields: [(1, uint16(1)), (2, Data([1]))]
    )
    let failureAsHello = try semanticFrame(type: .helloResult, fields: [(1, uint16(5))])
    expectProtocolError(.invalidMessage) { try HelloMessage.decode(helloAsHealth) }
    expectProtocolError(.invalidMessage) { try HealthResultMessage.decode(healthAsFailure) }
    expectProtocolError(.invalidMessage) { try SafeFailureCode.decode(failureAsHello) }

    for tag in [UInt16(4), 5] {
      let fields = helloResultFields().map { field in
        field.0 == tag ? (tag, Data([2])) : field
      }
      let frame = try semanticFrame(type: .helloResult, fields: fields)
      expectProtocolError(.invalidMessage) { try HelloResultMessage.decode(frame) }
    }

    let malformedNonce = try semanticFrame(
      type: .helloResult,
      fields: helloResultFields().map { field in
        field.0 == 3 ? (3, Data(repeating: 0, count: 31)) : field
      }
    )
    expectProtocolError(.invalidMessage) { try HelloResultMessage.decode(malformedNonce) }

    let invalidUTF8 = try semanticFrame(
      type: .helloResult,
      fields: helloResultFields().map { field in
        field.0 == 1 ? (1, Data([0xc0, 0xaf])) : field
      }
    )
    expectProtocolError(.invalidMessage) { try HelloResultMessage.decode(invalidUTF8) }

    let malformedPeer = try semanticFrame(
      type: .healthResult,
      fields: [(1, uint16(1)), (2, Data([2]))]
    )
    expectProtocolError(.invalidMessage) { try HealthResultMessage.decode(malformedPeer) }
  }

  @Test
  func testSemanticEncodersValidateInputsAndProtectNonceStorage() throws {
    expectProtocolError(.invalidFrame) {
      try HelloMessage(engineVersion: "0.1.0", nonce: nonce).encodedFrame(requestID: 0)
    }
    expectProtocolError(.invalidField) {
      try HelloMessage(engineVersion: "", nonce: nonce)
    }
    expectProtocolError(.invalidField) {
      try HelloMessage(engineVersion: "0.1.0", nonce: Data(repeating: 0, count: 31))
    }
    expectProtocolError(.invalidMessage) { try makeHealthFrame(requestID: 0) }
    expectProtocolError(.invalidMessage) {
      try makeCancelFrame(requestID: 1, targetRequestID: 0)
    }

    let result = try HelloResultMessage(
      launcherVersion: "0.1.0",
      brokerVersion: "0.1.0",
      echoedNonce: nonce,
      productionSigned: true,
      persistentCredentials: true,
      minimumMacosVersion: "14.4"
    )
    var exposed = result.echoedNonce
    exposed.resetBytes(in: exposed.startIndex..<exposed.endIndex)
    #expect(result.echoedNonce == nonce)

    let decoded = try HelloResultMessage.decode(
      semanticFrame(type: .helloResult, fields: helloResultFields())
    )
    var decodedNonce = decoded.echoedNonce
    decodedNonce.resetBytes(in: decodedNonce.startIndex..<decodedNonce.endIndex)
    #expect(decoded.echoedNonce == nonce)
  }

  private func helloFields() -> [(UInt16, Data)] {
    [(1, Data("0.1.0".utf8)), (2, nonce)]
  }

  private func helloResultFields(
    minimumMacosVersion: Data = Data("14.4".utf8)
  ) -> [(UInt16, Data)] {
    [
      (1, Data("0.1.0".utf8)),
      (2, Data("0.1.0".utf8)),
      (3, nonce),
      (4, Data([1])),
      (5, Data([1])),
      (6, minimumMacosVersion),
    ]
  }

  private func semanticFrame(
    type: NativeMessageType,
    fields: [(UInt16, Data)]
  ) throws -> NativeFrame {
    try NativeFrame(type: type, requestID: 1, payload: rawFieldTable(fields))
  }

  private func decodeSingleFrame(_ bytes: Data) throws -> NativeFrame {
    var decoder = NativeFrameDecoder()
    let frames = try decoder.push(bytes)
    try decoder.finish()
    return try #require(frames.only)
  }

  private func loadFixture() throws -> GoldenFixture {
    let url = try #require(
      Bundle.module.url(forResource: "frames", withExtension: "json")
    )
    return try JSONDecoder().decode(GoldenFixture.self, from: Data(contentsOf: url))
  }

  @discardableResult
  private func expectProtocolError<T>(
    _ expected: NativeProtocolError,
    _ operation: () throws -> T
  ) -> NativeProtocolError {
    do {
      _ = try operation()
      Issue.record("Expected \(expected)")
    } catch let error as NativeProtocolError {
      #expect(error == expected)
      let rendered = error.localizedDescription
      #expect(!rendered.localizedCaseInsensitiveContains("SECRET_CANARY"))
      #expect(!rendered.localizedCaseInsensitiveContains("credential"))
      #expect(!rendered.localizedCaseInsensitiveContains("authorization"))
      #expect(!rendered.localizedCaseInsensitiveContains("token"))
      return error
    } catch {
      Issue.record("Unexpected error type: \(type(of: error))")
    }
    return expected
  }
}

private struct GoldenFixture: Decodable {
  let schemaVersion: Int
  let frames: [GoldenFrame]
}

private struct GoldenFrame: Decodable {
  let name: String
  let requestID: UInt32
  let hex: String

  private enum CodingKeys: String, CodingKey {
    case name
    case requestID = "requestId"
    case hex
  }
}

extension Collection {
  fileprivate var only: Element? {
    count == 1 ? first : nil
  }
}

extension Data {
  fileprivate init?(strictHex: String) {
    guard !strictHex.isEmpty, strictHex.count.isMultiple(of: 2) else {
      return nil
    }
    var bytes: [UInt8] = []
    bytes.reserveCapacity(strictHex.count / 2)
    var index = strictHex.startIndex
    while index < strictHex.endIndex {
      let next = strictHex.index(index, offsetBy: 2)
      guard let byte = UInt8(strictHex[index..<next], radix: 16) else {
        return nil
      }
      bytes.append(byte)
      index = next
    }
    self.init(bytes)
  }

  fileprivate var hex: String {
    map { String(format: "%02x", $0) }.joined()
  }
}

private func concatenate(_ parts: Data...) -> Data {
  var result = Data()
  result.reserveCapacity(parts.reduce(0) { $0 + $1.count })
  for part in parts {
    result.append(part)
  }
  return result
}

private func uint16(_ value: UInt16) -> Data {
  Data([
    UInt8((value >> 8) & 0xff),
    UInt8(value & 0xff),
  ])
}

private func uint32(_ value: UInt32) -> Data {
  Data([
    UInt8((value >> 24) & 0xff),
    UInt8((value >> 16) & 0xff),
    UInt8((value >> 8) & 0xff),
    UInt8(value & 0xff),
  ])
}

private func rawFieldTable(
  _ fields: [(UInt16, Data)],
  declaredCount: UInt16? = nil
) -> Data {
  var parts = [uint16(declaredCount ?? UInt16(fields.count))]
  for (tag, value) in fields {
    parts.append(uint16(tag))
    parts.append(uint32(UInt32(value.count)))
    parts.append(value)
  }
  return concatenate(parts)
}

private func concatenate(_ parts: [Data]) -> Data {
  var result = Data()
  result.reserveCapacity(parts.reduce(0) { $0 + $1.count })
  for part in parts {
    result.append(part)
  }
  return result
}

private func rawFrame(
  type: UInt16,
  requestID: UInt32,
  payload: Data,
  magic: UInt32 = 0x52_43_55_52,
  protocolVersion: UInt16 = 1,
  advertisedPayloadLength: UInt32? = nil
) -> Data {
  concatenate(
    uint32(magic),
    uint16(protocolVersion),
    uint16(type),
    uint32(advertisedPayloadLength ?? UInt32(payload.count)),
    uint32(requestID),
    payload
  )
}
