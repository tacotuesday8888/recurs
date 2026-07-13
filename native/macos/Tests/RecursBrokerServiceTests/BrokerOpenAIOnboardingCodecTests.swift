import Foundation
import RecursBrokerXPC
import Testing

@Suite
struct BrokerOpenAIOnboardingCodecTests {
  private let connectionID = UUID(
    uuidString: "11111111-2222-4333-8444-555555555555"
  )!
  private let commitOperationID = UUID(
    uuidString: "22222222-3333-4444-8555-666666666666"
  )!
  private let abortOperationID = UUID(
    uuidString: "33333333-4444-4555-8666-777777777777"
  )!
  private let credentialIdentityFingerprint =
    "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

  @Test
  func everyRequestUsesTheFrozenFrameAndRoundTrips() throws {
    let requests: [(BrokerOpenAIOnboardingRequest, UInt16, Int)] = [
      (.begin(requestID: 1), 1, 20),
      (.verify(requestID: 2), 2, 20),
      (.catalogPage(requestID: 3, cursor: 128), 3, 22),
      (.finalize(requestID: 4, exactModelID: "gpt-5"), 4, 27),
      (.abort(requestID: 5), 5, 20),
    ]

    for (request, kind, byteCount) in requests {
      let encoded = try request.encode()
      #expect(encoded.count == byteCount)
      #expect(Array(encoded.prefix(4)) == [0x52, 0x43, 0x4f, 0x41])
      #expect(readUInt16(encoded, at: 4) == 1)
      #expect(readUInt16(encoded, at: 6) == kind)
      #expect(readUInt32(encoded, at: 8) == UInt32(byteCount - 12))
      #expect(try BrokerOpenAIOnboardingRequest.decode(encoded) == request)
    }
  }

  @Test
  func catalogPageEnforcesCanonicalCursorAndModelSequence() throws {
    let page = try BrokerOpenAIOnboardingCatalogPage(
      cursor: 0,
      totalModelCount: 3,
      nextCursor: 2,
      catalogRequestID: "req_catalog_1",
      modelIDs: ["gpt-4.1", "gpt-5"]
    )
    #expect(page.modelIDs == ["gpt-4.1", "gpt-5"])

    let terminal = try BrokerOpenAIOnboardingCatalogPage(
      cursor: 2,
      totalModelCount: 3,
      nextCursor: nil,
      catalogRequestID: nil,
      modelIDs: ["o3"]
    )
    #expect(terminal.nextCursor == nil)

    let invalidPages: [() throws -> BrokerOpenAIOnboardingCatalogPage] = [
      {
        try .init(
          cursor: 0,
          totalModelCount: 0,
          nextCursor: nil,
          catalogRequestID: nil,
          modelIDs: []
        )
      },
      {
        try .init(
          cursor: 0,
          totalModelCount: 1,
          nextCursor: nil,
          catalogRequestID: nil,
          modelIDs: []
        )
      },
      {
        try .init(
          cursor: 1,
          totalModelCount: 1,
          nextCursor: nil,
          catalogRequestID: nil,
          modelIDs: ["gpt-5"]
        )
      },
      {
        try .init(
          cursor: 0,
          totalModelCount: 3,
          nextCursor: 1,
          catalogRequestID: nil,
          modelIDs: ["gpt-4.1", "gpt-5"]
        )
      },
      {
        try .init(
          cursor: 0,
          totalModelCount: 3,
          nextCursor: nil,
          catalogRequestID: nil,
          modelIDs: ["gpt-4.1", "gpt-5"]
        )
      },
      {
        try .init(
          cursor: 0,
          totalModelCount: 2,
          nextCursor: nil,
          catalogRequestID: nil,
          modelIDs: ["gpt-5", "gpt-4.1"]
        )
      },
      {
        try .init(
          cursor: 0,
          totalModelCount: 2,
          nextCursor: nil,
          catalogRequestID: nil,
          modelIDs: ["gpt-5", "gpt-5"]
        )
      },
      {
        try .init(
          cursor: 0,
          totalModelCount: 1,
          nextCursor: nil,
          catalogRequestID: nil,
          modelIDs: ["bad\nmodel"]
        )
      },
    ]
    for makePage in invalidPages {
      expectFailure { _ = try makePage() }
    }
  }

  @Test
  func modelAndCatalogIdentifiersUseExactUTF8Bounds() throws {
    let maximumModel = String(repeating: "é", count: 128)
    let bytePolicyModel = "model-\u{85}-id"
    let maximumRequestID = String(repeating: "r", count: 256)
    let page = try BrokerOpenAIOnboardingCatalogPage(
      cursor: 0,
      totalModelCount: 2,
      nextCursor: nil,
      catalogRequestID: maximumRequestID,
      modelIDs: [bytePolicyModel, maximumModel]
    )
    #expect(page.modelIDs == [bytePolicyModel, maximumModel])

    let invalidModels = [
      "",
      String(repeating: "x", count: 257),
      "bad\u{0}model",
      "bad\u{1f}model",
      "bad\u{7f}model",
    ]
    for model in invalidModels {
      expectFailure {
        _ = try BrokerOpenAIOnboardingRequest.finalize(
          requestID: 1,
          exactModelID: model
        ).encode()
      }
    }

    for requestID in [
      "",
      String(repeating: "r", count: 257),
      "request id",
      "request\n",
      "réquest",
    ] {
      expectFailure {
        _ = try BrokerOpenAIOnboardingCatalogPage(
          cursor: 0,
          totalModelCount: 1,
          nextCursor: nil,
          catalogRequestID: requestID,
          modelIDs: ["gpt-5"]
        )
      }
    }
  }

  @Test
  func catalogPagesStayUnderTheFixedReplyBound() throws {
    let modelIDs = (0..<brokerOpenAIOnboardingMaximumModelIDsPerPage).map {
      String(format: "m%03d", $0) + String(repeating: "x", count: 252)
    }
    let page = try BrokerOpenAIOnboardingCatalogPage(
      cursor: 0,
      totalModelCount: UInt16(modelIDs.count),
      nextCursor: nil,
      catalogRequestID: String(repeating: "r", count: 256),
      modelIDs: modelIDs
    )
    let reply = BrokerOpenAIOnboardingReply.catalogPage(
      requestID: 8,
      page
    )

    let encoded = try reply.encode()

    #expect(encoded.count <= brokerOpenAIOnboardingMaximumReplyBytes)
    #expect(try BrokerOpenAIOnboardingReply.decode(encoded) == reply)
    expectFailure {
      _ = try BrokerOpenAIOnboardingCatalogPage(
        cursor: 0,
        totalModelCount: 129,
        nextCursor: nil,
        catalogRequestID: nil,
        modelIDs: modelIDs + ["z"]
      )
    }
  }

  @Test
  func everyReplyKindAndFailureCodeRoundTripsWithoutProse() throws {
    let page = try BrokerOpenAIOnboardingCatalogPage(
      cursor: 0,
      totalModelCount: 2,
      nextCursor: nil,
      catalogRequestID: "req_1",
      modelIDs: ["gpt-4.1", "gpt-5"]
    )
    let receipt = try BrokerOpenAIOnboardingCommitReceipt(
      connectionID: connectionID,
      selectedModelID: "gpt-5",
      verifiedModelCount: 2,
      catalogRequestID: "req_1"
    )
    let recoveryTokens = try BrokerOpenAIOnboardingRecoveryTokens(
      commitOperationID: commitOperationID,
      abortOperationID: abortOperationID
    )
    let replies: [(BrokerOpenAIOnboardingReply, UInt16, Int)] = [
      (
        .begun(
          requestID: 1,
          connectionID: connectionID,
          recoveryTokens: recoveryTokens,
          credentialIdentityFingerprint: credentialIdentityFingerprint
        ),
        101,
        139
      ),
      (.catalogPage(requestID: 2, page), 102, 51),
      (.committed(requestID: 3, receipt), 103, 52),
      (.aborted(requestID: 4), 104, 20),
    ]
    for (reply, kind, byteCount) in replies {
      let encoded = try reply.encode()
      #expect(encoded.count == byteCount)
      #expect(readUInt16(encoded, at: 6) == kind)
      #expect(try BrokerOpenAIOnboardingReply.decode(encoded) == reply)
    }

    let codes: [BrokerOpenAIOnboardingFailureCode] = [
      .invalidRequest,
      .sessionNotReady,
      .busy,
      .cancelled,
      .expired,
      .verificationFailed,
      .invalidModel,
      .noCompatibleModels,
      .commitFailed,
      .credentialStoreUnavailable,
      .cleanupFailed,
      .reconciliationRequired,
      .authorityUnavailable,
      .operationUnavailable,
    ]
    for (offset, code) in codes.enumerated() {
      let reply = BrokerOpenAIOnboardingReply.failure(
        requestID: UInt64(offset + 10),
        code
      )
      let encoded = try reply.encode()
      #expect(encoded.count == 22)
      #expect(readUInt16(encoded, at: 6) == 255)
      #expect(readUInt16(encoded, at: 20) == code.rawValue)
      #expect(try BrokerOpenAIOnboardingReply.decode(encoded) == reply)
      #expect(!String(decoding: encoded, as: UTF8.self).contains("failed"))
    }
  }

  @Test
  func recoveryTokensRejectZeroAndDuplicateOperationIDs() throws {
    let zeroUUID = UUID(uuid: (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0))
    let tokens = try BrokerOpenAIOnboardingRecoveryTokens(
      commitOperationID: commitOperationID,
      abortOperationID: abortOperationID
    )
    #expect(tokens.commitOperationID == commitOperationID)
    #expect(tokens.abortOperationID == abortOperationID)

    for makeTokens in [
      {
        try BrokerOpenAIOnboardingRecoveryTokens(
          commitOperationID: zeroUUID,
          abortOperationID: self.abortOperationID
        )
      },
      {
        try BrokerOpenAIOnboardingRecoveryTokens(
          commitOperationID: self.commitOperationID,
          abortOperationID: zeroUUID
        )
      },
      {
        try BrokerOpenAIOnboardingRecoveryTokens(
          commitOperationID: self.commitOperationID,
          abortOperationID: self.commitOperationID
        )
      },
    ] {
      expectFailure { _ = try makeTokens() }
    }
  }

  @Test
  func begunReplyRequiresOneCanonicalCredentialIdentityFingerprint() throws {
    let recoveryTokens = try BrokerOpenAIOnboardingRecoveryTokens(
      commitOperationID: commitOperationID,
      abortOperationID: abortOperationID
    )
    let valid = BrokerOpenAIOnboardingReply.begun(
      requestID: 1,
      connectionID: connectionID,
      recoveryTokens: recoveryTokens,
      credentialIdentityFingerprint: credentialIdentityFingerprint
    )
    let encoded = try valid.encode()
    #expect(try BrokerOpenAIOnboardingReply.decode(encoded) == valid)
    #expect(encoded.count == 139)

    for rejected in [
      "",
      "sha256:" + String(repeating: "0", count: 63),
      "sha256:" + String(repeating: "0", count: 65),
      "sha256:" + String(repeating: "A", count: 64),
      "sha256:" + String(repeating: "g", count: 64),
      "sha512:" + String(repeating: "0", count: 64),
    ] {
      expectFailure {
        _ = try BrokerOpenAIOnboardingReply.begun(
          requestID: 1,
          connectionID: connectionID,
          recoveryTokens: recoveryTokens,
          credentialIdentityFingerprint: rejected
        ).encode()
      }
    }

    var noncanonical = encoded
    noncanonical[68] = Character("S").asciiValue!
    expectFailure { _ = try BrokerOpenAIOnboardingReply.decode(noncanonical) }
  }

  @Test
  func commitReceiptRejectsInvalidRedactedMetadata() throws {
    let zeroUUID = UUID(uuid: (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0))
    let invalid: [() throws -> BrokerOpenAIOnboardingCommitReceipt] = [
      {
        try .init(
          connectionID: zeroUUID,
          selectedModelID: "gpt-5",
          verifiedModelCount: 1,
          catalogRequestID: nil
        )
      },
      {
        try .init(
          connectionID: self.connectionID,
          selectedModelID: "gpt-5",
          verifiedModelCount: 0,
          catalogRequestID: nil
        )
      },
      {
        try .init(
          connectionID: self.connectionID,
          selectedModelID: "bad\nmodel",
          verifiedModelCount: 1,
          catalogRequestID: nil
        )
      },
    ]
    for makeReceipt in invalid {
      expectFailure { _ = try makeReceipt() }
    }
  }

  @Test
  func constructorsAndDecodersRejectReservedRequestIDsAndInvalidCursors() throws {
    for requestID in [UInt64(0), brokerOpenAIOnboardingMalformedRequestID] {
      expectFailure {
        _ = try BrokerOpenAIOnboardingRequest.begin(requestID: requestID).encode()
      }
      expectFailure {
        let recoveryTokens = try BrokerOpenAIOnboardingRecoveryTokens(
          commitOperationID: self.commitOperationID,
          abortOperationID: self.abortOperationID
        )
        _ = try BrokerOpenAIOnboardingReply.begun(
          requestID: requestID,
          connectionID: connectionID,
          recoveryTokens: recoveryTokens,
          credentialIdentityFingerprint: credentialIdentityFingerprint
        ).encode()
      }
    }
    for cursor in [UInt16(0), UInt16(4_096), UInt16.max] {
      expectFailure {
        _ = try BrokerOpenAIOnboardingRequest.catalogPage(
          requestID: 1,
          cursor: cursor
        ).encode()
      }
    }

    let maximum = BrokerOpenAIOnboardingRequest.abort(
      requestID: brokerOpenAIOnboardingMalformedRequestID - 1
    )
    #expect(try BrokerOpenAIOnboardingRequest.decode(maximum.encode()) == maximum)

    expectFailure {
      let recoveryTokens = try BrokerOpenAIOnboardingRecoveryTokens(
        commitOperationID: self.commitOperationID,
        abortOperationID: self.abortOperationID
      )
      _ = try BrokerOpenAIOnboardingReply.begun(
        requestID: 1,
        connectionID: UUID(
          uuid: (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
        ),
        recoveryTokens: recoveryTokens,
        credentialIdentityFingerprint: credentialIdentityFingerprint
      ).encode()
    }
  }

  @Test
  func decodersRejectNoncanonicalFramesAndExposeOnlyValidatedRequestIDs() throws {
    let valid = try BrokerOpenAIOnboardingRequest.finalize(
      requestID: 19,
      exactModelID: "gpt-5"
    ).encode()
    var badMagic = valid
    badMagic[0] = 0
    var badVersion = valid
    badVersion[5] = 2
    var badKind = valid
    replaceUInt16(&badKind, at: 6, with: 99)
    var badLength = valid
    replaceUInt32(&badLength, at: 8, with: 1)
    var trailing = valid
    trailing.append(0)
    var zeroRequestID = valid
    replaceUInt64(&zeroRequestID, at: 12, with: 0)
    var invalidUTF8 = valid
    invalidUTF8[22] = 0xff

    for bytes in [
      Data(), Data(valid.prefix(11)), badMagic, badVersion, badKind,
      badLength, trailing, zeroRequestID,
    ] {
      do {
        _ = try BrokerOpenAIOnboardingRequest.decode(bytes)
        Issue.record("Expected malformed onboarding frame to fail")
      } catch let error as BrokerOpenAIOnboardingCodecError {
        #expect(error.requestID == nil)
        #expect(error.description == "invalid OpenAI onboarding frame")
      } catch {
        Issue.record("Expected the fixed onboarding codec error")
      }
    }

    do {
      _ = try BrokerOpenAIOnboardingRequest.decode(invalidUTF8)
      Issue.record("Expected invalid model UTF-8 to fail")
    } catch let error as BrokerOpenAIOnboardingCodecError {
      #expect(error.requestID == 19)
      #expect(error.description == "invalid OpenAI onboarding frame")
    } catch {
      Issue.record("Expected the fixed onboarding codec error")
    }

    expectFailure {
      _ = try BrokerOpenAIOnboardingRequest.decode(
        frame(kind: 5, body: Data(repeating: 0, count: 501))
      )
    }
    expectFailure {
      _ = try BrokerOpenAIOnboardingReply.decode(
        frame(kind: 101, body: Data(repeating: 0, count: 34 * 1_024 - 11))
      )
    }
  }

  @Test
  func protocolIsADataOnlyCredentialLifecycleExtension() {
    let value: any BrokerCredentialLifecycleXPCProtocol = OpenAIOnboardingXPCStub()
    #expect(value is any BrokerOpenAIOnboardingXPCProtocol)
    #expect(
      NSStringFromSelector(
        #selector(BrokerOpenAIOnboardingXPCProtocol.beginOpenAIOnboarding(_:secret:reply:))
      ) == "beginOpenAIOnboarding:secret:reply:"
    )
    #expect(
      NSStringFromSelector(
        #selector(BrokerOpenAIOnboardingXPCProtocol.openAIOnboardingControl(_:reply:))
      ) == "openAIOnboardingControl:reply:"
    )
  }
}

private final class OpenAIOnboardingXPCStub: NSObject,
  BrokerOpenAIOnboardingXPCProtocol
{
  func exchange(_ frame: Data, reply: @escaping @Sendable (Data) -> Void) {
    reply(frame)
  }

  func stageCredential(
    _ metadata: Data,
    secret _: Data,
    reply: @escaping @Sendable (Data) -> Void
  ) {
    reply(metadata)
  }

  func credentialControl(
    _ request: Data,
    reply: @escaping @Sendable (Data) -> Void
  ) {
    reply(request)
  }

  func beginOpenAIOnboarding(
    _ request: Data,
    secret _: Data,
    reply: @escaping @Sendable (Data) -> Void
  ) {
    reply(request)
  }

  func openAIOnboardingControl(
    _ request: Data,
    reply: @escaping @Sendable (Data) -> Void
  ) {
    reply(request)
  }
}

private func expectFailure(_ operation: () throws -> Void) {
  do {
    try operation()
    Issue.record("Expected onboarding codec failure")
  } catch let error as BrokerOpenAIOnboardingCodecError {
    #expect(error.description == "invalid OpenAI onboarding frame")
  } catch {
    Issue.record("Expected the fixed onboarding codec error")
  }
}

private func readUInt16(_ data: Data, at offset: Int) -> UInt16 {
  let bytes = [UInt8](data)
  return (UInt16(bytes[offset]) << 8) | UInt16(bytes[offset + 1])
}

private func readUInt32(_ data: Data, at offset: Int) -> UInt32 {
  let bytes = [UInt8](data)
  return (UInt32(bytes[offset]) << 24)
    | (UInt32(bytes[offset + 1]) << 16)
    | (UInt32(bytes[offset + 2]) << 8)
    | UInt32(bytes[offset + 3])
}

private func replaceUInt16(_ data: inout Data, at offset: Int, with value: UInt16) {
  data[offset] = UInt8(value >> 8)
  data[offset + 1] = UInt8(value & 0xff)
}

private func replaceUInt32(_ data: inout Data, at offset: Int, with value: UInt32) {
  data[offset] = UInt8(value >> 24)
  data[offset + 1] = UInt8((value >> 16) & 0xff)
  data[offset + 2] = UInt8((value >> 8) & 0xff)
  data[offset + 3] = UInt8(value & 0xff)
}

private func replaceUInt64(_ data: inout Data, at offset: Int, with value: UInt64) {
  for index in 0..<8 {
    data[offset + index] = UInt8((value >> UInt64(56 - index * 8)) & 0xff)
  }
}

private func frame(kind: UInt16, body: Data) -> Data {
  var bytes = Data([0x52, 0x43, 0x4f, 0x41, 0, 1])
  bytes.append(UInt8(kind >> 8))
  bytes.append(UInt8(kind & 0xff))
  let count = UInt32(body.count)
  bytes.append(UInt8(count >> 24))
  bytes.append(UInt8((count >> 16) & 0xff))
  bytes.append(UInt8((count >> 8) & 0xff))
  bytes.append(UInt8(count & 0xff))
  bytes.append(body)
  return bytes
}
