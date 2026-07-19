import Foundation
import Testing

@testable import RecursNativeProtocol

@Suite("Native OpenAI onboarding protocol")
struct OpenAIOnboardingMessagesTests {
  private let connectionID = UUID(
    uuidString: "11111111-2222-4333-8444-555555555555"
  )!
  private let fingerprint =
    "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

  @Test
  func requestUnionRoundTripsEveryClosedVariant() throws {
    let connectionID = try #require(
      UUID(uuidString: "11111111-2222-4333-8444-555555555555")
    )
    let fingerprint =
      "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    let requests: [OpenAIOnboardingRequestMessage] = [
      .begin,
      .verify,
      .catalogPage(cursor: 128),
      .finalize(exactModelID: "gpt-5"),
      .abort,
      .reconcile(
        connectionID: connectionID,
        credentialIdentityFingerprint: fingerprint
      ),
    ]

    for (offset, request) in requests.enumerated() {
      let requestID = UInt32(offset + 1)
      let frame = try decodeSingleFrame(
        request.encodedFrame(requestID: requestID)
      )
      #expect(frame.requestID == requestID)
      #expect(try OpenAIOnboardingRequestMessage.decode(frame) == request)
    }
  }

  @Test
  func fixedResultsAndEverySafeFailureRoundTrip() throws {
    let page = try OpenAIOnboardingCatalogPageMessage(
      cursor: 0,
      totalModelCount: 3,
      nextCursor: 2,
      catalogRequestID: "req_catalog_1",
      modelIDs: ["gpt-4.1", "gpt-5"]
    )
    let committed = try OpenAIOnboardingCommittedMessage(
      connectionID: connectionID,
      selectedModelID: "gpt-5",
      verifiedModelCount: 3,
      catalogRequestID: "req_catalog_1"
    )

    try expectRoundTrip(
      OpenAIOnboardingBegunMessage(
        connectionID: connectionID,
        credentialIdentityFingerprint: fingerprint
      ),
      requestID: 10
    )
    try expectRoundTrip(page, requestID: 11)
    try expectRoundTrip(committed, requestID: 12)
    try expectRoundTrip(OpenAIOnboardingAbortedMessage(), requestID: 13)
    for status in OpenAIOnboardingReconciliationStatusCode.allCases {
      try expectRoundTrip(
        OpenAIOnboardingReconciliationMessage(status: status),
        requestID: 14 + UInt32(status.rawValue)
      )
    }
    for code in OpenAIOnboardingFailureCode.allCases {
      try expectRoundTrip(
        OpenAIOnboardingFailureMessage(code: code),
        requestID: 20 + UInt32(code.rawValue)
      )
    }
  }

  @Test
  func begunExposesOnlyConnectionAndCredentialBoundIdentity() throws {
    let begun = try OpenAIOnboardingBegunMessage(
      connectionID: connectionID,
      credentialIdentityFingerprint: fingerprint
    )

    #expect(
      Array(Mirror(reflecting: begun).children.compactMap(\.label))
        == ["connectionID", "credentialIdentityFingerprint"]
    )
    #expect(begun.connectionID == connectionID)
    #expect(begun.credentialIdentityFingerprint == fingerprint)
  }

  @Test
  func wireEnumsAndBoundsAreFrozenToTheBrokerContract() {
    #expect(NativeMessageType.openAIOnboardingRequest.rawValue == 6)
    #expect(NativeMessageType.openAIOnboardingBegun.rawValue == 7)
    #expect(NativeMessageType.openAIOnboardingCatalogPage.rawValue == 8)
    #expect(NativeMessageType.openAIOnboardingCommitted.rawValue == 9)
    #expect(NativeMessageType.openAIOnboardingAborted.rawValue == 10)
    #expect(NativeMessageType.openAIOnboardingReconciliation.rawValue == 11)
    #expect(NativeMessageType.openAIOnboardingFailure.rawValue == 12)
    #expect(openAIOnboardingMaximumModelIDsPerPage == 128)
    #expect(openAIOnboardingMaximumModelCount == 4_096)
    #expect(openAIOnboardingMaximumModelIDUTF8ByteCount == 256)
    #expect(openAIOnboardingMaximumCatalogRequestIDUTF8ByteCount == 256)
    #expect(
      OpenAIOnboardingReconciliationStatusCode.allCases.map(\.rawValue)
        == [1, 2, 3]
    )
    #expect(
      OpenAIOnboardingFailureCode.allCases.map(\.rawValue)
        == Array(1...14)
    )
  }

  @Test
  func exactCatalogAndTextBoundsRoundTripUnderTheFrameLimit() throws {
    let modelIDs = (0..<openAIOnboardingMaximumModelIDsPerPage).map {
      String(format: "m%03d", $0) + String(repeating: "x", count: 252)
    }
    let page = try OpenAIOnboardingCatalogPageMessage(
      cursor: 3_968,
      totalModelCount: 4_096,
      nextCursor: nil,
      catalogRequestID: String(repeating: "r", count: 256),
      modelIDs: modelIDs
    )
    let encoded = try page.encodedFrame(requestID: UInt32.max)

    #expect(encoded.count <= nativeFrameHeaderByteCount + 64 * 1_024)
    #expect(
      try OpenAIOnboardingCatalogPageMessage.decode(
        decodeSingleFrame(encoded)
      ) == page
    )
    let exactUTF8 = String(repeating: "é", count: 128)
    let request = OpenAIOnboardingRequestMessage.finalize(
      exactModelID: exactUTF8
    )
    #expect(
      try OpenAIOnboardingRequestMessage.decode(
        decodeSingleFrame(request.encodedFrame(requestID: 1))
      ) == request
    )
    let lastPageRequest = OpenAIOnboardingRequestMessage.catalogPage(
      cursor: 4_095
    )
    #expect(
      try OpenAIOnboardingRequestMessage.decode(
        decodeSingleFrame(lastPageRequest.encodedFrame(requestID: 2))
      ) == lastPageRequest
    )
  }

  @Test
  func constructorsRejectEveryNoncanonicalBoundAndSequence() throws {
    let invalidPages: [() throws -> Void] = [
      {
        _ = try OpenAIOnboardingCatalogPageMessage(
          cursor: 0, totalModelCount: 0, nextCursor: nil,
          catalogRequestID: nil, modelIDs: []
        )
      },
      {
        _ = try OpenAIOnboardingCatalogPageMessage(
          cursor: 0, totalModelCount: 1, nextCursor: nil,
          catalogRequestID: nil, modelIDs: []
        )
      },
      {
        _ = try OpenAIOnboardingCatalogPageMessage(
          cursor: 0, totalModelCount: 129, nextCursor: nil,
          catalogRequestID: nil,
          modelIDs: (0..<129).map { String(format: "m%03d", $0) }
        )
      },
      {
        _ = try OpenAIOnboardingCatalogPageMessage(
          cursor: 0, totalModelCount: 4_097, nextCursor: nil,
          catalogRequestID: nil, modelIDs: ["gpt-5"]
        )
      },
      {
        _ = try OpenAIOnboardingCatalogPageMessage(
          cursor: 1, totalModelCount: 1, nextCursor: nil,
          catalogRequestID: nil, modelIDs: ["gpt-5"]
        )
      },
      {
        _ = try OpenAIOnboardingCatalogPageMessage(
          cursor: 0, totalModelCount: 3, nextCursor: 1,
          catalogRequestID: nil, modelIDs: ["gpt-4.1", "gpt-5"]
        )
      },
      {
        _ = try OpenAIOnboardingCatalogPageMessage(
          cursor: 0, totalModelCount: 3, nextCursor: nil,
          catalogRequestID: nil, modelIDs: ["gpt-4.1", "gpt-5"]
        )
      },
      {
        _ = try OpenAIOnboardingCatalogPageMessage(
          cursor: 0, totalModelCount: 2, nextCursor: nil,
          catalogRequestID: nil, modelIDs: ["gpt-5", "gpt-4.1"]
        )
      },
      {
        _ = try OpenAIOnboardingCatalogPageMessage(
          cursor: 0, totalModelCount: 2, nextCursor: nil,
          catalogRequestID: nil, modelIDs: ["gpt-5", "gpt-5"]
        )
      },
      {
        _ = try OpenAIOnboardingCatalogPageMessage(
          cursor: 0, totalModelCount: 1, nextCursor: nil,
          catalogRequestID: "request id", modelIDs: ["gpt-5"]
        )
      },
      {
        _ = try OpenAIOnboardingCatalogPageMessage(
          cursor: 0, totalModelCount: 1, nextCursor: nil,
          catalogRequestID: String(repeating: "r", count: 257),
          modelIDs: ["gpt-5"]
        )
      },
    ]
    for invalid in invalidPages {
      expectInvalid(invalid)
    }

    for modelID in [
      "", "bad\nmodel", "bad\u{7f}model", String(repeating: "x", count: 257),
    ] {
      expectInvalid {
        _ = try OpenAIOnboardingRequestMessage.finalize(
          exactModelID: modelID
        ).encodedFrame(requestID: 1)
      }
    }
    for cursor in [UInt16(0), UInt16(4_096), UInt16.max] {
      expectInvalid {
        _ = try OpenAIOnboardingRequestMessage.catalogPage(cursor: cursor)
          .encodedFrame(requestID: 1)
      }
    }
    for rejected in [
      "", "sha256:" + String(repeating: "0", count: 63),
      "sha256:" + String(repeating: "A", count: 64),
      "sha256:" + String(repeating: "g", count: 64),
    ] {
      expectInvalid {
        _ = try OpenAIOnboardingBegunMessage(
          connectionID: connectionID,
          credentialIdentityFingerprint: rejected
        )
      }
    }
    expectInvalid {
      _ = try OpenAIOnboardingBegunMessage(
        connectionID: UUID(
          uuid: (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
        ),
        credentialIdentityFingerprint: fingerprint
      )
    }
    for verifiedModelCount in [UInt16(0), UInt16(4_097)] {
      expectInvalid {
        _ = try OpenAIOnboardingCommittedMessage(
          connectionID: connectionID,
          selectedModelID: "gpt-5",
          verifiedModelCount: verifiedModelCount,
          catalogRequestID: nil
        )
      }
    }
  }

  @Test
  func semanticDecodersRejectWrongUnknownDuplicateAndTrailingFields() throws {
    let malformedRequests = [
      try semanticFrame(type: .health, fields: [(1, u16(1))]),
      try semanticFrame(type: .openAIOnboardingRequest, fields: []),
      try semanticFrame(
        type: .openAIOnboardingRequest,
        fields: [(1, u16(99))]
      ),
      try semanticFrame(
        type: .openAIOnboardingRequest,
        fields: [(1, u16(1)), (2, Data())]
      ),
      try semanticFrame(
        type: .openAIOnboardingRequest,
        fields: [(1, Data([1]))]
      ),
      try NativeFrame(
        type: .openAIOnboardingRequest,
        requestID: 1,
        payload: rawFieldTable([(1, u16(1)), (1, u16(1))])
      ),
      try NativeFrame(
        type: .openAIOnboardingRequest,
        requestID: 1,
        payload: Data([0, 0, 0])
      ),
    ]
    for frame in malformedRequests {
      expectInvalid { _ = try OpenAIOnboardingRequestMessage.decode(frame) }
    }

    let wrongResultFields: [(NativeMessageType, NativeFrame)] = [
      (
        .openAIOnboardingBegun,
        try semanticFrame(
          type: .openAIOnboardingBegun,
          fields: [(1, Data(repeating: 1, count: 16))]
        )
      ),
      (
        .openAIOnboardingAborted,
        try semanticFrame(
          type: .openAIOnboardingAborted,
          fields: [(1, Data())]
        )
      ),
      (
        .openAIOnboardingReconciliation,
        try semanticFrame(
          type: .openAIOnboardingReconciliation,
          fields: [(1, u16(4))]
        )
      ),
      (
        .openAIOnboardingFailure,
        try semanticFrame(
          type: .openAIOnboardingFailure,
          fields: [(1, u16(15))]
        )
      ),
    ]
    for (type, frame) in wrongResultFields {
      switch type {
      case .openAIOnboardingBegun:
        expectInvalid { _ = try OpenAIOnboardingBegunMessage.decode(frame) }
      case .openAIOnboardingAborted:
        expectInvalid { _ = try OpenAIOnboardingAbortedMessage.decode(frame) }
      case .openAIOnboardingReconciliation:
        expectInvalid {
          _ = try OpenAIOnboardingReconciliationMessage.decode(frame)
        }
      case .openAIOnboardingFailure:
        expectInvalid { _ = try OpenAIOnboardingFailureMessage.decode(frame) }
      default:
        Issue.record("Unexpected test case")
      }
    }

    let encodedModelID = Data("gpt-5".utf8)
    var nestedTrailing = Data(u16(1))
    nestedTrailing.append(u16(5))
    nestedTrailing.append(encodedModelID)
    nestedTrailing.append(0)
    var nestedTruncated = Data(u16(1))
    nestedTruncated.append(u16(6))
    nestedTruncated.append(encodedModelID)
    var nestedMissingItem = Data(u16(2))
    nestedMissingItem.append(u16(5))
    nestedMissingItem.append(encodedModelID)
    var nestedInvalidUTF8 = Data(u16(1))
    nestedInvalidUTF8.append(u16(2))
    nestedInvalidUTF8.append(contentsOf: [0xc0, 0xaf])
    for malformedModelIDs in [
      nestedTrailing,
      nestedTruncated,
      nestedMissingItem,
      nestedInvalidUTF8,
    ] {
      let catalog = try semanticFrame(
        type: .openAIOnboardingCatalogPage,
        fields: [
          (1, u16(0)),
          (2, u16(1)),
          (3, u16(UInt16.max)),
          (4, Data()),
          (5, malformedModelIDs),
        ]
      )
      expectInvalid {
        _ = try OpenAIOnboardingCatalogPageMessage.decode(catalog)
      }
    }

    var validModelIDs = Data(u16(1))
    validModelIDs.append(u16(5))
    validModelIDs.append(encodedModelID)
    let oversizedCatalogRequestID = try semanticFrame(
      type: .openAIOnboardingCatalogPage,
      fields: [
        (1, u16(0)),
        (2, u16(1)),
        (3, u16(UInt16.max)),
        (4, Data(repeating: 0x72, count: 257)),
        (5, validModelIDs),
      ]
    )
    expectInvalid {
      _ = try OpenAIOnboardingCatalogPageMessage.decode(
        oversizedCatalogRequestID
      )
    }

    for verifiedModelCount in [UInt16(0), UInt16(4_097)] {
      let committed = try semanticFrame(
        type: .openAIOnboardingCommitted,
        fields: [
          (1, Data(repeating: 1, count: 16)),
          (2, encodedModelID),
          (3, u16(verifiedModelCount)),
          (4, Data()),
        ]
      )
      expectInvalid {
        _ = try OpenAIOnboardingCommittedMessage.decode(committed)
      }
    }
  }

  @Test
  func invalidUTF8AndFailureRenderingNeverLeakInputProse() throws {
    let invalidUTF8 = try semanticFrame(
      type: .openAIOnboardingRequest,
      fields: [(1, u16(4)), (2, Data([0xc0, 0xaf]))]
    )
    let error = expectInvalid {
      _ = try OpenAIOnboardingRequestMessage.decode(invalidUTF8)
    }
    #expect(error.localizedDescription == "Invalid native authority message.")
    let failure = try OpenAIOnboardingFailureMessage(
      code: .verificationFailed
    ).encodedFrame(requestID: 1)
    let rendered = String(decoding: failure, as: UTF8.self)
    #expect(!rendered.contains("verification"))
    #expect(!rendered.contains("failed"))
  }

  @Test
  func canonicalCrossLanguageFixtureRoundTripsAtEverySplitPoint() throws {
    let fixture = try loadOnboardingFixture()
    let expectedNames = [
      "begin", "verify", "catalogPageRequest", "finalize", "abort",
      "reconcile", "begun", "catalogPage", "committed", "aborted",
      "reconciliation", "failure",
    ]
    #expect(fixture.schemaVersion == 1)
    #expect(fixture.frames.map(\.name) == expectedNames)
    #expect(fixture.frames.map(\.requestID) == Array(101...112))
    #expect(
      zip(fixture.frames, fixture.frames.dropFirst()).allSatisfy { pair in
        pair.0.requestID < pair.1.requestID
      })
    let expectedTypes: [String: NativeMessageType] = [
      "begin": .openAIOnboardingRequest,
      "verify": .openAIOnboardingRequest,
      "catalogPageRequest": .openAIOnboardingRequest,
      "finalize": .openAIOnboardingRequest,
      "abort": .openAIOnboardingRequest,
      "reconcile": .openAIOnboardingRequest,
      "begun": .openAIOnboardingBegun,
      "catalogPage": .openAIOnboardingCatalogPage,
      "committed": .openAIOnboardingCommitted,
      "aborted": .openAIOnboardingAborted,
      "reconciliation": .openAIOnboardingReconciliation,
      "failure": .openAIOnboardingFailure,
    ]

    for golden in fixture.frames {
      let bytes = try #require(Data(onboardingHex: golden.hex))
      for split in 0...bytes.count {
        var decoder = NativeFrameDecoder()
        let frames =
          try decoder.push(Data(bytes.prefix(split)))
          + decoder.push(Data(bytes.dropFirst(split)))
        try decoder.finish()
        let frame = try #require(frames.first)
        #expect(frames.count == 1)
        #expect(frame.type == expectedTypes[golden.name])
        #expect(frame.requestID == golden.requestID)
        #expect(try frame.encoded() == bytes)
      }
      let frame = try decodeSingleFrame(bytes)
      let reencoded: Data
      switch golden.name {
      case "begin", "verify", "catalogPageRequest", "finalize", "abort",
        "reconcile":
        reencoded = try OpenAIOnboardingRequestMessage.decode(frame)
          .encodedFrame(requestID: golden.requestID)
      case "begun":
        reencoded = try OpenAIOnboardingBegunMessage.decode(frame)
          .encodedFrame(requestID: golden.requestID)
      case "catalogPage":
        reencoded = try OpenAIOnboardingCatalogPageMessage.decode(frame)
          .encodedFrame(requestID: golden.requestID)
      case "committed":
        reencoded = try OpenAIOnboardingCommittedMessage.decode(frame)
          .encodedFrame(requestID: golden.requestID)
      case "aborted":
        reencoded = try OpenAIOnboardingAbortedMessage.decode(frame)
          .encodedFrame(requestID: golden.requestID)
      case "reconciliation":
        reencoded = try OpenAIOnboardingReconciliationMessage.decode(frame)
          .encodedFrame(requestID: golden.requestID)
      case "failure":
        reencoded = try OpenAIOnboardingFailureMessage.decode(frame)
          .encodedFrame(requestID: golden.requestID)
      default:
        throw NativeProtocolError.invalidMessage
      }
      #expect(reencoded == bytes)
    }

    let byName = Dictionary(
      uniqueKeysWithValues: fixture.frames.map { ($0.name, $0) }
    )
    let begun = try OpenAIOnboardingBegunMessage.decode(
      decodeSingleFrame(
        try #require(Data(onboardingHex: byName["begun"]?.hex ?? ""))
      )
    )
    #expect(begun.connectionID == connectionID)
    #expect(begun.credentialIdentityFingerprint == fingerprint)
    let page = try OpenAIOnboardingCatalogPageMessage.decode(
      decodeSingleFrame(
        try #require(Data(onboardingHex: byName["catalogPage"]?.hex ?? ""))
      )
    )
    #expect(page.modelIDs == ["gpt-4.1", "gpt-5"])
    #expect(page.nextCursor == 2)
    #expect(page.catalogRequestID == "req_catalog_1")
  }

  private func decodeSingleFrame(_ bytes: Data) throws -> NativeFrame {
    var decoder = NativeFrameDecoder()
    let frames = try decoder.push(bytes)
    try decoder.finish()
    return try #require(frames.first)
  }

  private func expectRoundTrip<Message: NativeOpenAIOnboardingMessage>(
    _ message: Message,
    requestID: UInt32
  ) throws where Message: Equatable {
    let frame = try decodeSingleFrame(message.encodedFrame(requestID: requestID))
    #expect(frame.requestID == requestID)
    #expect(try Message.decode(frame) == message)
  }

  private func semanticFrame(
    type: NativeMessageType,
    fields: [(UInt16, Data)]
  ) throws -> NativeFrame {
    try NativeFrame(
      type: type,
      requestID: 1,
      payload: rawFieldTable(fields)
    )
  }

  private func loadOnboardingFixture() throws -> OnboardingGoldenFixture {
    let url = try #require(
      Bundle.module.url(
        forResource: "openai-onboarding",
        withExtension: "json"
      )
    )
    return try JSONDecoder().decode(
      OnboardingGoldenFixture.self,
      from: Data(contentsOf: url)
    )
  }

  @discardableResult
  private func expectInvalid(
    _ operation: () throws -> Void
  ) -> NativeProtocolError {
    do {
      try operation()
      Issue.record("Expected invalid onboarding message")
    } catch let error as NativeProtocolError {
      #expect(error == .invalidMessage)
      #expect(error.localizedDescription == "Invalid native authority message.")
      return error
    } catch {
      Issue.record("Expected fixed native protocol error")
    }
    return .invalidMessage
  }
}

private struct OnboardingGoldenFixture: Decodable {
  let schemaVersion: Int
  let frames: [OnboardingGoldenFrame]
}

private struct OnboardingGoldenFrame: Decodable {
  let name: String
  let requestID: UInt32
  let hex: String

  private enum CodingKeys: String, CodingKey {
    case name
    case requestID = "requestId"
    case hex
  }
}

extension Data {
  fileprivate init?(onboardingHex: String) {
    guard !onboardingHex.isEmpty, onboardingHex.count.isMultiple(of: 2) else {
      return nil
    }
    var bytes: [UInt8] = []
    bytes.reserveCapacity(onboardingHex.count / 2)
    var index = onboardingHex.startIndex
    while index < onboardingHex.endIndex {
      let next = onboardingHex.index(index, offsetBy: 2)
      guard let byte = UInt8(onboardingHex[index..<next], radix: 16) else {
        return nil
      }
      bytes.append(byte)
      index = next
    }
    self.init(bytes)
  }
}

private func u16(_ value: UInt16) -> Data {
  FieldTable.encodeUInt16(value)
}

private func u32(_ value: UInt32) -> Data {
  FieldTable.encodeUInt32(value)
}

private func rawFieldTable(_ fields: [(UInt16, Data)]) -> Data {
  var bytes = Data(u16(UInt16(fields.count)))
  for (tag, value) in fields {
    bytes.append(u16(tag))
    bytes.append(u32(UInt32(value.count)))
    bytes.append(value)
  }
  return bytes
}
