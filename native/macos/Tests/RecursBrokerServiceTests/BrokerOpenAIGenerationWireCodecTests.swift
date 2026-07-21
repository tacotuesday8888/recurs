import Foundation
import Testing

@testable import RecursBrokerService

struct BrokerOpenAIGenerationWireCodecTests {
  @Test
  func decodesCanonicalBoundedImageInputsAfterAUserMessage() throws {
    let body = Data(
      #"{"format":1,"connectionId":"71000000-0000-4000-8000-000000000001","authorizationId":"authorization-2","sessionId":"session-1","turnId":"turn-2","adapterId":"openai-responses","modelId":"model","backendFingerprint":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","expectedSessionRecordSequence":4,"authorizationExpiresAt":"2026-07-15T00:00:00.000Z","input":[{"kind":"message","role":"user","text":"inspect"},{"kind":"image","mediaType":"image/png","data":"iVBORw0KGgo="}],"tools":[],"maxOutputTokens":128}"#.utf8
    )

    let request = try BrokerOpenAIGenerationWireCodec.decodeRequest(body)
    #expect(request.input.count == 2)
    guard case .image(let mediaType, let data) = request.input[1] else {
      Issue.record("Expected normalized image input")
      return
    }
    #expect(mediaType == "image/png")
    #expect(data == Data([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  }

  @Test
  func decodesTheExactEngineRequestIntoBrokerTypes() throws {
    let body = Data(
      #"{"format":1,"connectionId":"71000000-0000-4000-8000-000000000001","authorizationId":"authorization-2","sessionId":"session-1","turnId":"turn-2","adapterId":"openai-responses","modelId":"gpt-5.6-sol","backendFingerprint":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","expectedSessionRecordSequence":4,"authorizationExpiresAt":"2026-07-15T00:00:00.000Z","input":[{"kind":"message","role":"user","text":"continue"},{"kind":"continuation","handle":{"kind":"direct","id":"81000000-0000-4000-8000-000000000001","storageClass":"persistent_broker","recursSessionId":"session-1","connectionId":"71000000-0000-4000-8000-000000000001","adapterId":"openai-responses","modelId":"gpt-5.6-sol","backendFingerprint":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","stateVersion":1,"originTurnId":"turn-1","continuationSequence":1,"status":"committed"}}],"tools":[{"name":"read_file","description":"Read one file","inputSchema":{"type":"object"}}],"maxOutputTokens":8192}"#
        .utf8
    )

    let request = try BrokerOpenAIGenerationWireCodec.decodeRequest(body)

    #expect(request.connectionID.uuidString.lowercased() == "71000000-0000-4000-8000-000000000001")
    #expect(request.authorizationID == "authorization-2")
    #expect(request.expectedSessionRecordSequence == 4)
    #expect(request.input.count == 2)
    #expect(request.tools.map(\.name) == ["read_file"])
  }

  @Test
  func encodesNormalizedEventsThenProviderStateAndTerminal() throws {
    let codec = BrokerOpenAIGenerationWireCodec()
    let handle = wireHandle()
    let text = try decodedJSON(codec.encode(.textDelta("done")))
    let refusal = try decodedJSON(codec.encode(.refusalDelta("cannot")))
    let usage = try decodedJSON(
      codec.encode(
        .usage(
          .init(
            inputTokens: 12, outputTokens: 4, totalTokens: 16,
            cachedInputTokens: 7, cacheWriteTokens: 2, reasoningTokens: 3))))
    let state = try decodedJSON(codec.encodeProviderState(handle))
    let done = try decodedJSON(codec.encodeDone(.toolCalls))

    #expect(text["type"] as? String == "text_delta")
    #expect(refusal["type"] as? String == "text_delta")
    #expect(usage["cachedInputTokens"] as? Int == 7)
    #expect(usage["cacheWriteInputTokens"] as? Int == 2)
    #expect(usage["reasoningTokens"] as? Int == 3)
    #expect(state["type"] as? String == "provider_state")
    #expect(done["stopReason"] as? String == "tool_calls")
    #expect(
      String(data: try codec.encodeProviderState(handle), encoding: .utf8)?.contains("opaque")
        == false)
  }

  @Test
  func acceptsEveryNativeBrokerGenerationAdapter() throws {
    let openAI =
      #"{"format":1,"connectionId":"71000000-0000-4000-8000-000000000001","authorizationId":"authorization-2","sessionId":"session-1","turnId":"turn-2","adapterId":"openai-responses","modelId":"model","backendFingerprint":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","expectedSessionRecordSequence":4,"authorizationExpiresAt":"2026-07-15T00:00:00.000Z","input":[{"kind":"message","role":"user","text":"continue"}],"tools":[],"maxOutputTokens":128}"#
    for adapter in ["openai-responses", "anthropic-messages", "openai-chat-completions"] {
      let body = openAI.replacingOccurrences(of: "openai-responses", with: adapter)
      #expect(
        try BrokerOpenAIGenerationWireCodec.decodeRequest(Data(body.utf8)).adapterID == adapter)
    }
  }

  @Test
  func rejectsUnknownFieldsDuplicateKeysAndMismatchedHandleBindings() {
    for body in [
      #"{"format":1,"format":1}"#,
      #"{"format":1,"unexpected":true}"#,
    ] {
      #expect(throws: BrokerOpenAIGenerationWireError.invalidMessage) {
        _ = try BrokerOpenAIGenerationWireCodec.decodeRequest(Data(body.utf8))
      }
    }
  }
}

private func wireHandle() -> BrokerDirectContinuationHandle {
  BrokerDirectContinuationHandle(
    id: "81000000-0000-4000-8000-000000000001",
    storageClass: .persistentBroker,
    recursSessionID: "session-1",
    connectionID: "71000000-0000-4000-8000-000000000001",
    adapterID: "openai-responses",
    modelID: "gpt-5.6-sol",
    backendFingerprint: "sha256:\(String(repeating: "a", count: 64))",
    stateVersion: 1,
    originTurnID: "turn-1",
    continuationSequence: 1,
    status: .committed
  )
}

private func decodedJSON(_ data: Data) throws -> [String: Any] {
  try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
}
