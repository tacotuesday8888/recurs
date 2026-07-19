import Foundation
import Testing

@testable import RecursBrokerService

struct BrokerDirectContinuationRecordCodecTests {
  @Test
  func roundTripsARecordWithoutExposingOutputInDescriptions() throws {
    let codec = BrokerDirectContinuationRecordCodec()
    let record = try continuationRecord()

    let encoded = try codec.encode(record)
    let decoded = try codec.decode(encoded)

    #expect(decoded == record)
    #expect(String(describing: decoded.handle) == "Broker direct continuation handle.")
  }

  @Test
  func rejectsUnknownFieldsAndNonCanonicalRecords() throws {
    let codec = BrokerDirectContinuationRecordCodec()
    let record = try continuationRecord()
    let encoded = try codec.encode(record)
    var object = try #require(
      JSONSerialization.jsonObject(with: encoded) as? [String: Any]
    )
    object["unexpected"] = true

    #expect(throws: BrokerDirectContinuationRecordCodecError.invalidRecord) {
      _ = try codec.decode(JSONSerialization.data(withJSONObject: object))
    }
    #expect(throws: BrokerDirectContinuationRecordCodecError.invalidRecord) {
      _ = try codec.decode(
        Data(
          repeating: 0x61,
          count: BrokerDirectContinuationRecordCodec.maximumEncodedByteCount + 1
        )
      )
    }
  }
}

private func continuationRecord() throws -> BrokerDirectContinuationRecord {
  let output = try BrokerOpenAIResponsesPrivateOutput(
    decoderItemJSON: Data(
      #"{"id":"reasoning-1","type":"reasoning","status":"completed","summary":[],"encrypted_content":"opaque"}"#
        .utf8
    )
  )
  let binding = BrokerDirectContinuationWriteBinding(
    authorizationID: "authorization-1",
    sessionID: "session-1",
    connectionID: "71000000-0000-4000-8000-000000000001",
    adapterID: "openai-responses",
    modelID: "gpt-5.6-sol",
    backendFingerprint: "sha256:\(String(repeating: "a", count: 64))",
    turnID: "turn-1",
    expectedSessionRecordSequence: 3,
    expiresAt: Date(timeIntervalSince1970: 200)
  )
  return BrokerDirectContinuationRecord(
    handle: BrokerDirectContinuationHandle(
      id: "81000000-0000-4000-8000-000000000001",
      storageClass: .persistentBroker,
      recursSessionID: binding.sessionID,
      connectionID: binding.connectionID,
      adapterID: binding.adapterID,
      modelID: binding.modelID,
      backendFingerprint: binding.backendFingerprint,
      stateVersion: 1,
      originTurnID: binding.turnID,
      continuationSequence: 1,
      status: .committed
    ),
    binding: binding,
    outputItems: [output],
    createdAt: Date(timeIntervalSince1970: 100)
  )
}
