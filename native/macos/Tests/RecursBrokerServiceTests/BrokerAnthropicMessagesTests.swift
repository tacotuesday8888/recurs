import Foundation
import Testing

@testable import RecursBrokerService

struct BrokerAnthropicMessagesTests {
  @Test
  func requestEncodesSystemMessagesToolsAndToolResultsExactly() throws {
    let request = try BrokerAnthropicMessagesRequest(
      model: "claude-opus-4-6",
      input: [
        .message(role: .system, text: "Be precise."),
        .message(role: .user, text: "Read it"),
        .toolUse(
          callID: "toolu_1", name: "read_file", argumentsJSON: Data(#"{"path":"a.ts"}"#.utf8)),
        .toolResult(callID: "toolu_1", output: "contents"),
      ],
      tools: [
        try BrokerAnthropicMessagesTool(
          name: "read_file",
          description: "Read one file",
          inputSchemaJSON: Data(#"{"type":"object"}"#.utf8)
        )
      ],
      maxOutputTokens: 8_192
    )

    let object = try #require(
      JSONSerialization.jsonObject(with: request.encodedBody()) as? [String: Any]
    )
    #expect(object["model"] as? String == "claude-opus-4-6")
    #expect(object["system"] as? String == "Be precise.")
    #expect(object["stream"] as? Bool == true)
    let messages = try #require(object["messages"] as? [[String: Any]])
    #expect(messages.map { $0["role"] as? String } == ["user", "assistant", "user"])
    let result = try #require(messages[2]["content"] as? [[String: Any]])
    #expect(result[0]["type"] as? String == "tool_result")
    #expect(result[0]["tool_use_id"] as? String == "toolu_1")
  }

  @Test
  func streamDecodesTextToolUsageAndTerminalSequence() throws {
    var decoder = BrokerAnthropicMessagesStreamDecoder()
    let blocks = [
      event(
        "message_start",
        #"{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-opus-4-6","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":12,"output_tokens":1,"cache_read_input_tokens":4,"cache_creation_input_tokens":2}}}"#
      ),
      event(
        "content_block_start",
        #"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#),
      event(
        "content_block_delta",
        #"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}"#),
      event("content_block_stop", #"{"type":"content_block_stop","index":0}"#),
      event(
        "content_block_start",
        #"{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"read_file","input":{}}}"#
      ),
      event(
        "content_block_delta",
        #"{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"path\":\"a.ts\"}"}}"#
      ),
      event("content_block_stop", #"{"type":"content_block_stop","index":1}"#),
      event(
        "message_delta",
        #"{"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":9}}"#
      ),
      event("message_stop", #"{"type":"message_stop"}"#),
    ]
    var emitted: [BrokerOpenAIResponsesEvent] = []
    for block in blocks { emitted.append(contentsOf: try decoder.receive(block)) }
    let completion = try decoder.finish()

    #expect(
      emitted == [
        .textDelta("hello"),
        .toolCall(
          BrokerOpenAIResponsesToolCall(
            callID: "toolu_1",
            name: "read_file",
            argumentsJSON: Data(#"{"path":"a.ts"}"#.utf8)
          )),
        .usage(
          BrokerOpenAIResponsesUsage(
            inputTokens: 18,
            outputTokens: 9,
            totalTokens: 27,
            cachedInputTokens: 4,
            cacheWriteTokens: 2,
            reasoningTokens: nil
          )),
        .done(.toolCalls),
      ])
    #expect(completion.responseID == "msg_1")
    #expect(completion.stopReason == .toolCalls)
  }

  @Test
  func malformedOrderingAndUnknownEventsFailClosed() throws {
    var decoder = BrokerAnthropicMessagesStreamDecoder()
    #expect(throws: BrokerAnthropicMessagesError.invalidStream) {
      _ = try decoder.receive(event("ping", #"{"type":"unknown"}"#))
    }
    var truncated = BrokerAnthropicMessagesStreamDecoder()
    _ = try truncated.receive(
      event(
        "message_start",
        #"{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-opus-4-6","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}"#
      ))
    #expect(throws: BrokerAnthropicMessagesError.invalidStream) {
      _ = try truncated.finish()
    }
  }

  @Test
  func rejectsToolResultAppendedAfterUserText() throws {
    #expect(throws: BrokerAnthropicMessagesError.invalidRequest) {
      _ = try BrokerAnthropicMessagesRequest(
        model: "claude-test",
        input: [
          .message(role: .user, text: "hello"),
          .toolResult(callID: "toolu_1", output: "result"),
        ],
        tools: [],
        maxOutputTokens: 128
      )
    }
  }

  private func event(_ name: String, _ json: String) -> Data {
    Data("event: \(name)\ndata: \(json)\n\n".utf8)
  }
}
