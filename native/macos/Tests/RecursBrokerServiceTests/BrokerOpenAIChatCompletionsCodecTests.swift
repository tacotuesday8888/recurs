import Foundation
import Testing

@testable import RecursBrokerService

struct BrokerOpenAIChatCompletionsCodecTests {
  @Test
  func encodesValidatedImagesAsChatContentParts() throws {
    let png = Data([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    let request = try BrokerOpenAIChatCompletionsRequest(
      model: "vision-model",
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
    let messages = try #require(body["messages"] as? [[String: Any]])
    let content = try #require(messages[0]["content"] as? [[String: Any]])
    #expect(content[0]["type"] as? String == "text")
    #expect(content[1]["type"] as? String == "image_url")
  }

  @Test
  func encodesToolsAndDecodesTextToolUsageAndTerminal() throws {
    let request = try BrokerOpenAIChatCompletionsRequest(
      model: "kimi-k2.5",
      input: [
        .message(role: .system, text: "Be precise."),
        .message(role: .user, text: "Read it"),
        .toolUse(
          callID: "call_1", name: "read_file", argumentsJSON: Data(#"{"path":"a.ts"}"#.utf8)),
        .toolResult(callID: "call_1", output: "contents"),
      ],
      tools: [
        try BrokerOpenAIResponsesFunctionTool(
          name: "read_file",
          description: "Read a file",
          parametersJSON: Data(#"{"type":"object"}"#.utf8)
        )
      ],
      maxOutputTokens: 8_192
    )
    let body = try #require(
      JSONSerialization.jsonObject(with: request.encodedBody()) as? [String: Any]
    )
    #expect(body["stream"] as? Bool == true)
    #expect((body["messages"] as? [[String: Any]])?.count == 4)

    var decoder = BrokerOpenAIChatCompletionsStreamDecoder()
    let chunks = [
      event(
        #"{"id":"chat_1","object":"chat.completion.chunk","created":1,"model":"kimi-k2.5","choices":[{"index":0,"delta":{"role":"assistant","content":"hi","tool_calls":[{"index":0,"id":"call_2","type":"function","function":{"name":"read_file","arguments":"{\"path\":"}}]},"finish_reason":null}],"usage":null}"#
      ),
      event(
        #"{"id":"chat_1","object":"chat.completion.chunk","created":1,"model":"kimi-k2.5","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"b.ts\"}"}}]},"finish_reason":"tool_calls"}],"usage":null}"#
      ),
      event(
        #"{"id":"chat_1","object":"chat.completion.chunk","created":1,"model":"kimi-k2.5","choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6,"prompt_tokens_details":{"cached_tokens":3},"completion_tokens_details":{"reasoning_tokens":1}}}"#
      ),
      event("[DONE]"),
    ]
    var events: [BrokerOpenAIResponsesEvent] = []
    for chunk in chunks { events.append(contentsOf: try decoder.receive(chunk)) }
    let completion = try decoder.finish()

    #expect(
      events == [
        .textDelta("hi"),
        .toolCall(
          .init(
            callID: "call_2",
            name: "read_file",
            argumentsJSON: Data(#"{"path":"b.ts"}"#.utf8)
          )),
        .usage(
          .init(
            inputTokens: 4,
            outputTokens: 2,
            totalTokens: 6,
            cachedInputTokens: 3,
            cacheWriteTokens: nil,
            reasoningTokens: 1
          )),
        .done(.toolCalls),
      ])
    #expect(completion.responseID == "chat_1")
  }

  @Test
  func rejectsMalformedAndTruncatedStreams() throws {
    var malformed = BrokerOpenAIChatCompletionsStreamDecoder()
    #expect(throws: BrokerOpenAIChatCompletionsError.invalidStream) {
      _ = try malformed.receive(event(#"{"object":"wrong"}"#))
    }
    var truncated = BrokerOpenAIChatCompletionsStreamDecoder()
    _ = try truncated.receive(
      event(
        #"{"id":"chat_1","object":"chat.completion.chunk","model":"m","choices":[],"usage":null}"#))
    #expect(throws: BrokerOpenAIChatCompletionsError.invalidStream) {
      _ = try truncated.finish()
    }
  }

  private func event(_ value: String) -> Data {
    Data("data: \(value)\n\n".utf8)
  }
}
