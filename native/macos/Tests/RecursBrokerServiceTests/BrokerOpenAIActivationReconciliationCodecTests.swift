import Foundation
import RecursBrokerXPC
import Testing

@Suite
struct BrokerOpenAIActivationReconciliationCodecTests {
  private let connectionID = UUID(
    uuidString: "11111111-2222-4333-8444-555555555555"
  )!

  @Test
  func reconcileRequestUsesTheFrozenBoundedFrameAndRoundTrips() throws {
    let request = BrokerOpenAIActivationReconciliationRequest.reconcile(
      requestID: 7,
      connectionID: connectionID
    )

    let encoded = try request.encode()

    #expect(encoded.count == 36)
    #expect(Array(encoded.prefix(4)) == [0x52, 0x43, 0x43, 0x4f])
    #expect(readUInt16(encoded, at: 4) == 1)
    #expect(readUInt16(encoded, at: 6) == 1)
    #expect(readUInt32(encoded, at: 8) == 24)
    #expect(try BrokerOpenAIActivationReconciliationRequest.decode(encoded) == request)
  }

  @Test
  func everyFixedStatusAndFailureRoundTripsWithoutAuthorityTokens() throws {
    for (offset, status) in BrokerOpenAIActivationReconciliationStatus.allCases.enumerated() {
      let reply = BrokerOpenAIActivationReconciliationReply.status(
        requestID: UInt64(offset + 1),
        status
      )
      let encoded = try reply.encode()

      #expect(encoded.count == 22)
      #expect(Array(encoded.prefix(4)) == [0x52, 0x43, 0x43, 0x4f])
      #expect(readUInt16(encoded, at: 6) == 101)
      #expect(readUInt16(encoded, at: 20) == status.rawValue)
      #expect(try BrokerOpenAIActivationReconciliationReply.decode(encoded) == reply)
      assertContainsNoAuthorityTokens(reply, encoded: encoded)
    }

    for (offset, code) in BrokerOpenAIOnboardingFailureCode.allCases.enumerated() {
      let reply = BrokerOpenAIActivationReconciliationReply.failure(
        requestID: UInt64(offset + 20),
        code
      )
      let encoded = try reply.encode()

      #expect(encoded.count == 22)
      #expect(readUInt16(encoded, at: 6) == 255)
      #expect(try BrokerOpenAIActivationReconciliationReply.decode(encoded) == reply)
      assertContainsNoAuthorityTokens(reply, encoded: encoded)
    }
  }

  @Test
  func codecRejectsReservedIDsZeroUUIDsAndNoncanonicalFrames() throws {
    let zeroUUID = UUID(
      uuid: (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
    )
    for requestID in [UInt64(0), brokerOpenAIOnboardingMalformedRequestID] {
      expectCodecFailure {
        _ = try BrokerOpenAIActivationReconciliationRequest.reconcile(
          requestID: requestID,
          connectionID: connectionID
        ).encode()
      }
    }
    expectCodecFailure {
      _ = try BrokerOpenAIActivationReconciliationRequest.reconcile(
        requestID: 1,
        connectionID: zeroUUID
      ).encode()
    }

    let valid = try BrokerOpenAIActivationReconciliationRequest.reconcile(
      requestID: 9,
      connectionID: connectionID
    ).encode()
    var badMagic = valid
    badMagic[0] = 0
    var badVersion = valid
    badVersion[5] = 2
    var badKind = valid
    badKind[7] = 2
    var trailing = valid
    trailing.append(0)
    var zeroConnection = valid
    zeroConnection.replaceSubrange(20..<36, with: repeatElement(UInt8(0), count: 16))

    for malformed in [
      Data(), Data(valid.prefix(35)), badMagic, badVersion, badKind, trailing, zeroConnection,
    ] {
      expectCodecFailure {
        _ = try BrokerOpenAIActivationReconciliationRequest.decode(malformed)
      }
    }

    var unknownStatus = try BrokerOpenAIActivationReconciliationReply.status(
      requestID: 1,
      .unresolved
    ).encode()
    unknownStatus[20] = 0xff
    unknownStatus[21] = 0xff
    expectCodecFailure {
      _ = try BrokerOpenAIActivationReconciliationReply.decode(unknownStatus)
    }
  }
}

private func assertContainsNoAuthorityTokens(
  _ reply: BrokerOpenAIActivationReconciliationReply,
  encoded: Data
) {
  let reflected = String(reflecting: reply).lowercased()
  let bytes = String(decoding: encoded, as: UTF8.self).lowercased()
  for forbidden in ["attempt", "fence", "generation", "recovery", "uuid"] {
    #expect(!reflected.contains(forbidden))
    #expect(!bytes.contains(forbidden))
  }
}

private func expectCodecFailure(_ operation: () throws -> Void) {
  do {
    try operation()
    Issue.record("Expected reconciliation codec failure")
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
