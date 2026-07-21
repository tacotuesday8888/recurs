import Foundation
import Testing

@testable import RecursBrokerService

struct BrokerOpenAIResponsesRequestTests {
  @Test
  func encodesValidatedImagesInsideThePrecedingUserMessage() throws {
    let png = Data([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    let request = try BrokerOpenAIResponsesRequest(
      model: "gpt-test",
      input: [
        .message(role: .user, text: "Inspect this screenshot"),
        .image(mediaType: "image/png", data: png),
      ],
      tools: [],
      maxOutputTokens: 16
    )

    let body = try #require(
      JSONSerialization.jsonObject(with: request.encodedBody()) as? [String: Any]
    )
    let input = try #require(body["input"] as? [[String: Any]])
    #expect(input.count == 1)
    let content = try #require(input[0]["content"] as? [[String: Any]])
    #expect(content[0]["type"] as? String == "input_text")
    #expect(content[1]["type"] as? String == "input_image")
    #expect(
      content[1]["image_url"] as? String
        == "data:image/png;base64,\(png.base64EncodedString())"
    )

    #expect(throws: BrokerOpenAIResponsesRequestError.invalidRequest) {
      _ = try BrokerOpenAIResponsesRequest(
        model: "gpt-test",
        input: [.image(mediaType: "image/png", data: png)],
        tools: [],
        maxOutputTokens: 16
      )
    }
  }

  @Test
  func encodesTheBoundedFixedResponsesContract() throws {
    let request = try BrokerOpenAIResponsesRequest(
      model: "gpt-5.1-codex-mini",
      input: [
        .message(role: .user, text: "Fix the failing test."),
        .functionCall(
          callID: "call_1",
          name: "read_file",
          argumentsJSON: Data(#"{"path":"a"}"#.utf8)
        ),
        .functionCallOutput(callID: "call_1", output: "passed"),
      ],
      tools: [
        BrokerOpenAIResponsesFunctionTool(
          name: "read_file",
          description: "Read one workspace file.",
          parametersJSON: Data(
            #"{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}"#
              .utf8
          )
        )
      ],
      maxOutputTokens: 4_096
    )

    let body = try request.encodedBody()
    let object = try #require(
      JSONSerialization.jsonObject(with: body) as? [String: Any]
    )

    #expect(
      Set(object.keys) == [
        "include", "input", "max_output_tokens", "model", "parallel_tool_calls", "store",
        "stream", "tool_choice", "tools",
      ])
    #expect(object["model"] as? String == "gpt-5.1-codex-mini")
    #expect(object["stream"] as? Bool == true)
    #expect(object["store"] as? Bool == false)
    #expect(object["parallel_tool_calls"] as? Bool == true)
    #expect(object["tool_choice"] as? String == "auto")
    #expect(object["max_output_tokens"] as? Int == 4_096)
    #expect(object["include"] as? [String] == ["reasoning.encrypted_content"])

    let input = try #require(object["input"] as? [[String: Any]])
    #expect(input.count == 3)
    #expect(input[0]["type"] as? String == "message")
    #expect(input[0]["role"] as? String == "user")
    #expect(input[0]["content"] as? String == "Fix the failing test.")
    #expect(input[1]["type"] as? String == "function_call")
    #expect(input[1]["call_id"] as? String == "call_1")
    #expect(input[2]["type"] as? String == "function_call_output")
    #expect(input[2]["call_id"] as? String == "call_1")
    #expect(input[2]["output"] as? String == "passed")

    let tools = try #require(object["tools"] as? [[String: Any]])
    #expect(tools.count == 1)
    #expect(tools[0]["type"] as? String == "function")
    #expect(tools[0]["name"] as? String == "read_file")
    #expect(tools[0]["strict"] == nil)
    #expect((tools[0]["parameters"] as? [String: Any])?["type"] as? String == "object")
  }

  @Test
  func preservesOnlyValidAssistantMessagePhasesForStatelessReplay() throws {
    let commentary = try BrokerOpenAIResponsesPrivateOutput(
      decoderItemJSON: Data(
        #"{"id":"msg","type":"message","status":"completed","role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"working","annotations":[]}]}"#
          .utf8
      )
    )
    let request = try BrokerOpenAIResponsesRequest(
      model: "gpt-test",
      input: [.privateOutput(commentary)],
      tools: [],
      maxOutputTokens: 16
    )
    let body = try #require(
      JSONSerialization.jsonObject(with: request.encodedBody()) as? [String: Any]
    )
    let input = try #require(body["input"] as? [[String: Any]])
    #expect(input.first?["phase"] as? String == "commentary")

    #expect(throws: BrokerOpenAIResponsesRequestError.invalidRequest) {
      _ = try BrokerOpenAIResponsesPrivateOutput(
        decoderItemJSON: Data(
          #"{"id":"msg","type":"message","status":"completed","role":"assistant","phase":"hidden","content":[{"type":"output_text","text":"working","annotations":[]}]}"#
            .utf8
        )
      )
    }
  }

  @Test
  func rejectsUnboundedOrAmbiguousInputsBeforeEncoding() throws {
    #expect(
      BrokerOpenAIResponsesRequest.maximumOutputTokenCount
        == BrokerOpenAIResponsesStreamDecoder.maximumEventCount
    )

    #expect(throws: BrokerOpenAIResponsesRequestError.invalidRequest) {
      _ = try BrokerOpenAIResponsesRequest(
        model: " ",
        input: [.message(role: .user, text: "hello")],
        tools: [],
        maxOutputTokens: 1
      )
    }
    #expect(throws: BrokerOpenAIResponsesRequestError.invalidRequest) {
      _ = try BrokerOpenAIResponsesRequest(
        model: "gpt-test",
        input: [.functionCallOutput(callID: "orphan", output: "result")],
        tools: [],
        maxOutputTokens: 1
      )
    }
    #expect(throws: BrokerOpenAIResponsesRequestError.invalidRequest) {
      _ = try BrokerOpenAIResponsesRequest(
        model: "gpt-test",
        input: [.functionCall(callID: "missing", name: "tool", argumentsJSON: Data("{}".utf8))],
        tools: [],
        maxOutputTokens: 1
      )
    }
    #expect(throws: BrokerOpenAIResponsesRequestError.invalidRequest) {
      _ = try BrokerOpenAIResponsesRequest(
        model: "gpt-test",
        input: [.message(role: .user, text: "hello")],
        tools: [],
        maxOutputTokens: BrokerOpenAIResponsesRequest.maximumOutputTokenCount + 1
      )
    }
    #expect(throws: BrokerOpenAIResponsesRequestError.invalidJSON) {
      _ = try BrokerOpenAIResponsesRequest(
        model: "gpt-test",
        input: [.message(role: .user, text: "hello")],
        tools: [
          BrokerOpenAIResponsesFunctionTool(
            name: "ambiguous",
            description: "bad schema",
            parametersJSON: Data(#"{"type":"object","type":"array"}"#.utf8)
          )
        ],
        maxOutputTokens: 1
      )
    }
    let duplicateTool = try BrokerOpenAIResponsesFunctionTool(
      name: "same_name",
      description: "one",
      parametersJSON: Data(#"{"type":"object"}"#.utf8)
    )
    #expect(throws: BrokerOpenAIResponsesRequestError.invalidRequest) {
      _ = try BrokerOpenAIResponsesRequest(
        model: "gpt-test",
        input: [.message(role: .user, text: "hello")],
        tools: [duplicateTool, duplicateTool],
        maxOutputTokens: 1
      )
    }
    #expect(throws: BrokerOpenAIResponsesRequestError.invalidRequest) {
      _ = try BrokerOpenAIResponsesRequest(
        model: "gpt-test",
        input: [
          .functionCall(callID: "call_1", name: "tool", argumentsJSON: Data("{}".utf8)),
          .functionCall(callID: "call_1", name: "tool", argumentsJSON: Data("{}".utf8)),
        ],
        tools: [],
        maxOutputTokens: 1
      )
    }
  }

  @Test
  func rejectsAggregateBodyGrowthAndUnvalidatedPrivateItemsDuringInitialization() throws {
    let repeated = String(repeating: "x", count: 10_000)
    let manyItems = (0..<900).map { index in
      BrokerOpenAIResponsesInputItem.message(
        role: .user,
        text: "\(index)-\(repeated)"
      )
    }
    #expect(throws: BrokerOpenAIResponsesRequestError.requestTooLarge) {
      _ = try BrokerOpenAIResponsesRequest(
        model: "gpt-test",
        input: manyItems,
        tools: [],
        maxOutputTokens: 1
      )
    }

    #expect(throws: BrokerOpenAIResponsesRequestError.invalidRequest) {
      _ = try BrokerOpenAIResponsesPrivateOutput(
        decoderItemJSON: Data(#"{"type":"future_item","id":"item_1"}"#.utf8)
      )
    }

    let reasoning = try BrokerOpenAIResponsesPrivateOutput(
      decoderItemJSON: Data(
        #"{"id":"rs_1","type":"reasoning","status":"completed","summary":[],"encrypted_content":null}"#
          .utf8
      )
    )
    let replay = try BrokerOpenAIResponsesRequest(
      model: "gpt-test",
      input: [.privateOutput(reasoning)],
      tools: [],
      maxOutputTokens: 1
    )
    let body = try #require(
      JSONSerialization.jsonObject(with: replay.encodedBody()) as? [String: Any]
    )
    let input = try #require(body["input"] as? [[String: Any]])
    #expect(input[0]["encrypted_content"] is NSNull)

    let canonicalMessage = try BrokerOpenAIResponsesPrivateOutput(
      decoderItemJSON: Data(
        #"{"id":"msg_1","type":"message","status":"completed","role":"assistant","unexpected":"drop","content":[{"type":"output_text","text":"ok","annotations":[{"type":"future"}],"extra":true}]}"#
          .utf8
      )
    )
    let canonicalReplay = try BrokerOpenAIResponsesRequest(
      model: "gpt-test",
      input: [.privateOutput(canonicalMessage)],
      tools: [],
      maxOutputTokens: 1
    )
    let canonicalBody = try #require(
      JSONSerialization.jsonObject(with: canonicalReplay.encodedBody()) as? [String: Any]
    )
    let canonicalInput = try #require(canonicalBody["input"] as? [[String: Any]])
    #expect(Set(canonicalInput[0].keys) == ["content", "id", "role", "status", "type"])
    let content = try #require(canonicalInput[0]["content"] as? [[String: Any]])
    #expect(Set(content[0].keys) == ["annotations", "text", "type"])
    #expect((content[0]["annotations"] as? [Any])?.isEmpty == true)

    let function = try BrokerOpenAIResponsesPrivateOutput(
      decoderItemJSON: Data(
        #"{"id":"fc_1","type":"function_call","status":"completed","call_id":"call_1","name":"tool","arguments":"{}"}"#
          .utf8
      )
    )
    _ = try BrokerOpenAIResponsesRequest(
      model: "gpt-test",
      input: [.privateOutput(function), .functionCallOutput(callID: "call_1", output: "ok")],
      tools: [],
      maxOutputTokens: 1
    )
  }
}
