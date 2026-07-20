import Foundation
import Testing

@testable import RecursBrokerService

struct BrokerOpenAIResponsesStreamTests {
  @Test
  func validatesAndNormalizesAChunkedTextResponse() throws {
    let itemAdded =
      #"{"id":"msg_1","type":"message","status":"in_progress","role":"assistant","content":[]}"#
    let itemDone =
      #"{"id":"msg_1","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"Hello","annotations":[]}] }"#
    let stream = [
      sse(
        "response.created",
        #"{"type":"response.created","sequence_number":1,"response":{"id":"resp_1","status":"in_progress","output":[]}}"#
      ),
      sse(
        "response.in_progress",
        #"{"type":"response.in_progress","sequence_number":2,"response":{"id":"resp_1","status":"in_progress","output":[]}}"#
      ),
      sse(
        "response.output_item.added",
        #"{"type":"response.output_item.added","sequence_number":3,"output_index":0,"item":\#(itemAdded)}"#
      ),
      sse(
        "response.content_part.added",
        #"{"type":"response.content_part.added","sequence_number":4,"item_id":"msg_1","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}"#
      ),
      sse(
        "response.output_text.delta",
        #"{"type":"response.output_text.delta","sequence_number":5,"item_id":"msg_1","output_index":0,"content_index":0,"delta":"Hel"}"#
      ),
      sse(
        "response.output_text.delta",
        #"{"type":"response.output_text.delta","sequence_number":6,"item_id":"msg_1","output_index":0,"content_index":0,"delta":"lo"}"#
      ),
      sse(
        "response.output_text.done",
        #"{"type":"response.output_text.done","sequence_number":7,"item_id":"msg_1","output_index":0,"content_index":0,"text":"Hello"}"#
      ),
      sse(
        "response.content_part.done",
        #"{"type":"response.content_part.done","sequence_number":8,"item_id":"msg_1","output_index":0,"content_index":0,"part":{"type":"output_text","text":"Hello","annotations":[]}}"#
      ),
      sse(
        "response.output_item.done",
        #"{"type":"response.output_item.done","sequence_number":9,"output_index":0,"item":\#(itemDone)}"#
      ),
      sse(
        "response.completed",
        #"{"type":"response.completed","sequence_number":10,"response":{"id":"resp_1","status":"completed","output":[\#(itemDone)],"usage":{"input_tokens":12,"output_tokens":3,"total_tokens":15,"input_tokens_details":{"cached_tokens":4,"cache_write_tokens":2},"output_tokens_details":{"reasoning_tokens":1}}}}"#
      ),
    ].joined()

    var decoder = BrokerOpenAIResponsesStreamDecoder()
    let bytes = Data(stream.utf8)
    let split = bytes.count / 3
    let events = try [
      bytes[..<split],
      bytes[split..<(split * 2)],
      bytes[(split * 2)...],
    ].flatMap { try decoder.receive(Data($0)) }
    let completion = try decoder.finish()

    #expect(
      events == [
        .textDelta("Hel"),
        .textDelta("lo"),
        .usage(
          BrokerOpenAIResponsesUsage(
            inputTokens: 12,
            outputTokens: 3,
            totalTokens: 15,
            cachedInputTokens: 4,
            cacheWriteTokens: 2,
            reasoningTokens: 1
          )
        ),
        .done(.complete),
      ])
    #expect(completion.responseID == "resp_1")
    #expect(completion.stopReason == .complete)
    #expect(completion.outputItems.count == 1)

    let replay = try BrokerOpenAIResponsesRequest(
      model: "gpt-test",
      input: [.privateOutput(completion.outputItems[0])],
      tools: [],
      maxOutputTokens: 32
    )
    let replayBody = try JSONSerialization.jsonObject(with: replay.encodedBody()) as? [String: Any]
    let replayInput = replayBody?["input"] as? [[String: Any]]
    #expect(replayInput?.first?["id"] as? String == "msg_1")
  }

  @Test
  func assemblesOneCompleteFunctionCallByCallID() throws {
    let added =
      #"{"id":"fc_1","type":"function_call","status":"in_progress","call_id":"call_1","name":"read_file","arguments":""}"#
    let done =
      #"{"id":"fc_1","type":"function_call","status":"completed","call_id":"call_1","name":"read_file","arguments":"{\"path\":\"a\"}"}"#
    let stream = [
      sse(
        "response.created",
        #"{"type":"response.created","sequence_number":1,"response":{"id":"resp_2","status":"in_progress","output":[]}}"#
      ),
      sse(
        "response.output_item.added",
        #"{"type":"response.output_item.added","sequence_number":2,"output_index":0,"item":\#(added)}"#
      ),
      sse(
        "response.function_call_arguments.delta",
        #"{"type":"response.function_call_arguments.delta","sequence_number":3,"item_id":"fc_1","output_index":0,"delta":"{\"path\":"}"#
      ),
      sse(
        "response.function_call_arguments.delta",
        #"{"type":"response.function_call_arguments.delta","sequence_number":4,"item_id":"fc_1","output_index":0,"delta":"\"a\"}"}"#
      ),
      sse(
        "response.function_call_arguments.done",
        #"{"type":"response.function_call_arguments.done","sequence_number":5,"item_id":"fc_1","output_index":0,"name":"read_file","arguments":"{\"path\":\"a\"}"}"#
      ),
      sse(
        "response.output_item.done",
        #"{"type":"response.output_item.done","sequence_number":6,"output_index":0,"item":\#(done)}"#
      ),
      sse(
        "response.completed",
        #"{"type":"response.completed","sequence_number":7,"response":{"id":"resp_2","status":"completed","output":[\#(done)],"usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3,"input_tokens_details":{"cached_tokens":0},"output_tokens_details":{"reasoning_tokens":0}}}}"#
      ),
    ].joined()

    var decoder = BrokerOpenAIResponsesStreamDecoder()
    let events = try decoder.receive(Data(stream.utf8))
    _ = try decoder.finish()

    #expect(
      events.first
        == .toolCall(
          BrokerOpenAIResponsesToolCall(
            callID: "call_1",
            name: "read_file",
            argumentsJSON: Data(#"{"path":"a"}"#.utf8)
          )
        ))
    #expect(events.last == .done(.toolCalls))
  }

  @Test
  func rejectsAmbiguousUnknownOrUnterminatedStreams() throws {
    let badStreams = [
      sse(
        "response.created",
        #"{"type":"response.created","sequence_number":1,"sequence_number":2,"response":{"id":"r","status":"in_progress","output":[]}}"#
      ),
      sse(
        "response.created",
        #"{"type":"response.created","sequence_number":true,"response":{"id":"r","status":"in_progress","output":[]}}"#
      ),
      sse(
        "response.created",
        #"{"type":"response.created","sequence_number":1.5,"response":{"id":"r","status":"in_progress","output":[]}}"#
      ),
      sse(
        "response.created",
        #"{"type":"response.completed","sequence_number":1,"response":{"id":"r","status":"in_progress","output":[]}}"#
      ),
      sse("future.event", #"{"type":"future.event","sequence_number":1}"#),
      "event: response.created\ndata: [DONE]\n\n",
    ]
    for stream in badStreams {
      var decoder = BrokerOpenAIResponsesStreamDecoder()
      #expect(throws: BrokerOpenAIResponsesStreamError.invalidStream) {
        _ = try decoder.receive(Data(stream.utf8))
      }
    }

    var unterminated = BrokerOpenAIResponsesStreamDecoder()
    _ = try unterminated.receive(
      Data(
        sse(
          "response.created",
          #"{"type":"response.created","sequence_number":1,"response":{"id":"r","status":"in_progress","output":[]}}"#
        ).utf8
      )
    )
    #expect(throws: BrokerOpenAIResponsesStreamError.invalidStream) {
      _ = try unterminated.finish()
    }
  }

  @Test
  func rejectsSequenceLifecycleAndCorrelationAmbiguityAndPoisonsTheDecoder() throws {
    let inProgress = sse(
      "response.in_progress",
      #"{"type":"response.in_progress","sequence_number":1,"response":{"id":"r","status":"in_progress","output":[]}}"#
    )
    let gap =
      created(id: "r", sequence: 1)
      + sse(
        "response.in_progress",
        #"{"type":"response.in_progress","sequence_number":3,"response":{"id":"r","status":"in_progress","output":[]}}"#
      )
    let overflow =
      created(id: "r", sequence: Int.max)
      + sse(
        "response.in_progress",
        #"{"type":"response.in_progress","sequence_number":0,"response":{"id":"r","status":"in_progress","output":[]}}"#
      )
    for stream in [inProgress, gap, overflow] {
      var decoder = BrokerOpenAIResponsesStreamDecoder()
      #expect(throws: BrokerOpenAIResponsesStreamError.invalidStream) {
        _ = try decoder.receive(Data(stream.utf8))
      }
    }

    let added =
      #"{"id":"m","type":"message","status":"in_progress","role":"assistant","content":[]}"#
    var poisoned = BrokerOpenAIResponsesStreamDecoder()
    let wrongID =
      created(id: "r", sequence: 1)
      + sse(
        "response.output_item.added",
        #"{"type":"response.output_item.added","sequence_number":2,"output_index":0,"item":\#(added)}"#
      )
      + sse(
        "response.content_part.added",
        #"{"type":"response.content_part.added","sequence_number":3,"item_id":"wrong","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}"#
      )
    #expect(throws: BrokerOpenAIResponsesStreamError.invalidStream) {
      _ = try poisoned.receive(Data(wrongID.utf8))
    }
    #expect(throws: BrokerOpenAIResponsesStreamError.invalidStream) {
      _ = try poisoned.receive(Data(created(id: "fresh", sequence: 1).utf8))
    }
  }

  @Test
  func acceptsCRLFButRejectsFatalUTF8PostTerminalAndFinalMismatch() throws {
    let complete = emptyCompletedStream(id: "r", usage: nil)
    var lf = BrokerOpenAIResponsesStreamDecoder()
    #expect(try lf.receive(Data(complete.utf8)) == [.done(.complete)])
    var crlf = BrokerOpenAIResponsesStreamDecoder()
    let events = try crlf.receive(
      Data(complete.replacingOccurrences(of: "\n", with: "\r\n").utf8)
    )
    #expect(events == [.done(.complete)])
    #expect(try crlf.finish().usage == nil)

    var invalidUTF8 = BrokerOpenAIResponsesStreamDecoder()
    var bytes = Data("event: response.created\ndata: ".utf8)
    bytes.append(0xff)
    bytes.append(Data("\n\n".utf8))
    #expect(throws: BrokerOpenAIResponsesStreamError.invalidStream) {
      _ = try invalidUTF8.receive(bytes)
    }

    var postTerminal = BrokerOpenAIResponsesStreamDecoder()
    #expect(throws: BrokerOpenAIResponsesStreamError.invalidStream) {
      _ = try postTerminal.receive(Data((complete + created(id: "later", sequence: 3)).utf8))
    }

    let mismatch =
      created(id: "r", sequence: 1)
      + sse(
        "response.completed",
        #"{"type":"response.completed","sequence_number":2,"response":{"id":"r","status":"completed","output":[{}]}}"#
      )
    var finalMismatch = BrokerOpenAIResponsesStreamDecoder()
    #expect(throws: BrokerOpenAIResponsesStreamError.invalidStream) {
      _ = try finalMismatch.receive(Data(mismatch.utf8))
    }
  }

  @Test
  func preservesReasoningPrivatelyAndMapsTerminalKindsWithoutLeakingFailureDetails() throws {
    let added = #"{"id":"rs_1","type":"reasoning","status":"in_progress","summary":[]}"#
    let done =
      #"{"id":"rs_1","type":"reasoning","status":"completed","summary":[{"type":"summary_text","text":"why"}],"encrypted_content":"opaque-private-state"}"#
    let reasoning = [
      created(id: "rr", sequence: 1),
      sse(
        "response.output_item.added",
        #"{"type":"response.output_item.added","sequence_number":2,"output_index":0,"item":\#(added)}"#
      ),
      sse(
        "response.reasoning_summary_part.added",
        #"{"type":"response.reasoning_summary_part.added","sequence_number":3,"item_id":"rs_1","output_index":0,"summary_index":0,"part":{"type":"summary_text","text":""}}"#
      ),
      sse(
        "response.reasoning_summary_text.delta",
        #"{"type":"response.reasoning_summary_text.delta","sequence_number":4,"item_id":"rs_1","output_index":0,"summary_index":0,"delta":"why"}"#
      ),
      sse(
        "response.reasoning_summary_text.done",
        #"{"type":"response.reasoning_summary_text.done","sequence_number":5,"item_id":"rs_1","output_index":0,"summary_index":0,"text":"why"}"#
      ),
      sse(
        "response.reasoning_summary_part.done",
        #"{"type":"response.reasoning_summary_part.done","sequence_number":6,"item_id":"rs_1","output_index":0,"summary_index":0,"part":{"type":"summary_text","text":"why"}}"#
      ),
      sse(
        "response.output_item.done",
        #"{"type":"response.output_item.done","sequence_number":7,"output_index":0,"item":\#(done)}"#
      ),
      sse(
        "response.completed",
        #"{"type":"response.completed","sequence_number":8,"response":{"id":"rr","status":"completed","output":[\#(done)]}}"#
      ),
    ].joined()
    var decoder = BrokerOpenAIResponsesStreamDecoder()
    #expect(
      try decoder.receive(Data(reasoning.utf8)) == [
        .reasoningDelta("why"), .done(.complete),
      ])
    let completion = try decoder.finish()
    let replay = try BrokerOpenAIResponsesRequest(
      model: "gpt-test",
      input: [.privateOutput(try #require(completion.outputItems.first))],
      tools: [],
      maxOutputTokens: 16
    )
    let body = try #require(
      JSONSerialization.jsonObject(with: replay.encodedBody()) as? [String: Any]
    )
    let input = try #require(body["input"] as? [[String: Any]])
    #expect(input[0]["encrypted_content"] as? String == "opaque-private-state")

    let incomplete =
      created(id: "limit", sequence: 1)
      + sse(
        "response.incomplete",
        #"{"type":"response.incomplete","sequence_number":2,"response":{"id":"limit","status":"incomplete","output":[],"incomplete_details":{"reason":"max_output_tokens"}}}"#
      )
    var limited = BrokerOpenAIResponsesStreamDecoder()
    #expect(try limited.receive(Data(incomplete.utf8)) == [.done(.maxOutputTokens)])
    #expect(try limited.finish().stopReason == .maxOutputTokens)

    let terminalFailures: [(String, BrokerOpenAIResponsesStreamError)] = [
      (
        created(id: "filter", sequence: 1)
          + sse(
            "response.incomplete",
            #"{"type":"response.incomplete","sequence_number":2,"response":{"id":"filter","status":"incomplete","output":[],"incomplete_details":{"reason":"content_filter"}}}"#
          ),
        .contentFiltered
      ),
      (
        created(id: "failed", sequence: 1)
          + sse(
            "response.failed",
            #"{"type":"response.failed","sequence_number":2,"response":{"id":"failed","status":"failed","error":{"code":"server_error","message":"private"}}}"#
          ),
        .providerFailure
      ),
      (
        created(id: "error", sequence: 1)
          + sse(
            "error",
            #"{"type":"error","sequence_number":2,"code":"server_error","message":"private"}"#),
        .providerFailure
      ),
    ]
    for (stream, expected) in terminalFailures {
      var failed = BrokerOpenAIResponsesStreamDecoder()
      #expect(throws: expected) { _ = try failed.receive(Data(stream.utf8)) }
    }
  }

  @Test
  func supportsQueuedMultipartRefusalsReasoningAndCompleteUsage() throws {
    let messageAdded =
      #"{"id":"msg","type":"message","status":"in_progress","role":"assistant","content":[]}"#
    let messageDone =
      #"{"id":"msg","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"first","annotations":[]},{"type":"refusal","refusal":"no"}]}"#
    let reasoningAdded =
      #"{"id":"reasoning","type":"reasoning","status":"in_progress","summary":[]}"#
    let reasoningDone =
      #"{"id":"reasoning","type":"reasoning","status":"completed","summary":[{"type":"summary_text","text":"A"},{"type":"summary_text","text":"B"}],"encrypted_content":null}"#
    let stream = [
      sse(
        "response.created",
        #"{"type":"response.created","sequence_number":1,"response":{"id":"queued","status":"queued","output":[]}}"#
      ),
      sse(
        "response.queued",
        #"{"type":"response.queued","sequence_number":2,"response":{"id":"queued","status":"queued","output":[]}}"#
      ),
      sse(
        "response.in_progress",
        #"{"type":"response.in_progress","sequence_number":3,"response":{"id":"queued","status":"in_progress","output":[]}}"#
      ),
      sse(
        "response.output_item.added",
        #"{"type":"response.output_item.added","sequence_number":4,"output_index":0,"item":\#(messageAdded)}"#
      ),
      sse(
        "response.content_part.added",
        #"{"type":"response.content_part.added","sequence_number":5,"item_id":"msg","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}"#
      ),
      sse(
        "response.output_text.delta",
        #"{"type":"response.output_text.delta","sequence_number":6,"item_id":"msg","output_index":0,"content_index":0,"delta":"first"}"#
      ),
      sse(
        "response.output_text.done",
        #"{"type":"response.output_text.done","sequence_number":7,"item_id":"msg","output_index":0,"content_index":0,"text":"first"}"#
      ),
      sse(
        "response.content_part.done",
        #"{"type":"response.content_part.done","sequence_number":8,"item_id":"msg","output_index":0,"content_index":0,"part":{"type":"output_text","text":"first","annotations":[]}}"#
      ),
      sse(
        "response.content_part.added",
        #"{"type":"response.content_part.added","sequence_number":9,"item_id":"msg","output_index":0,"content_index":1,"part":{"type":"refusal","refusal":""}}"#
      ),
      sse(
        "response.refusal.delta",
        #"{"type":"response.refusal.delta","sequence_number":10,"item_id":"msg","output_index":0,"content_index":1,"delta":"no"}"#
      ),
      sse(
        "response.refusal.done",
        #"{"type":"response.refusal.done","sequence_number":11,"item_id":"msg","output_index":0,"content_index":1,"refusal":"no"}"#
      ),
      sse(
        "response.content_part.done",
        #"{"type":"response.content_part.done","sequence_number":12,"item_id":"msg","output_index":0,"content_index":1,"part":{"type":"refusal","refusal":"no"}}"#
      ),
      sse(
        "response.output_item.done",
        #"{"type":"response.output_item.done","sequence_number":13,"output_index":0,"item":\#(messageDone)}"#
      ),
      sse(
        "response.output_item.added",
        #"{"type":"response.output_item.added","sequence_number":14,"output_index":1,"item":\#(reasoningAdded)}"#
      ),
      reasoningPartEvent("added", sequence: 15, summaryIndex: 0, text: ""),
      reasoningTextEvent("delta", sequence: 16, summaryIndex: 0, key: "delta", text: "A"),
      reasoningTextEvent("done", sequence: 17, summaryIndex: 0, key: "text", text: "A"),
      reasoningPartEvent("done", sequence: 18, summaryIndex: 0, text: "A"),
      reasoningPartEvent("added", sequence: 19, summaryIndex: 1, text: ""),
      reasoningTextEvent("delta", sequence: 20, summaryIndex: 1, key: "delta", text: "B"),
      reasoningTextEvent("done", sequence: 21, summaryIndex: 1, key: "text", text: "B"),
      reasoningPartEvent("done", sequence: 22, summaryIndex: 1, text: "B"),
      sse(
        "response.output_item.done",
        #"{"type":"response.output_item.done","sequence_number":23,"output_index":1,"item":\#(reasoningDone)}"#
      ),
      sse(
        "response.completed",
        #"{"type":"response.completed","sequence_number":24,"response":{"id":"queued","status":"completed","output":[\#(messageDone),\#(reasoningDone)],"usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15,"input_tokens_details":{"cached_tokens":2,"cache_write_tokens":3},"output_tokens_details":{"reasoning_tokens":2}}}}"#
      ),
    ].joined()

    var decoder = BrokerOpenAIResponsesStreamDecoder()
    let events = try decoder.receive(Data(stream.utf8))
    let completion = try decoder.finish()

    #expect(
      events == [
        .textDelta("first"),
        .refusalDelta("no"),
        .reasoningDelta("A"),
        .reasoningDelta("B"),
        .usage(
          .init(
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
            cachedInputTokens: 2,
            cacheWriteTokens: 3,
            reasoningTokens: 2
          )
        ),
        .done(.complete),
      ])
    #expect(completion.outcome == .refusal("no"))
    #expect(completion.outputItems.count == 2)

    let replay = try BrokerOpenAIResponsesRequest(
      model: "gpt-test",
      input: completion.outputItems.map(BrokerOpenAIResponsesInputItem.privateOutput),
      tools: [],
      maxOutputTokens: 16
    )
    let body = try #require(
      JSONSerialization.jsonObject(with: replay.encodedBody()) as? [String: Any]
    )
    let input = try #require(body["input"] as? [[String: Any]])
    #expect(input.count == 2)
    #expect(input[1]["encrypted_content"] is NSNull)
  }

  @Test
  func preservesNonemptyPartialMessagesAndReasoningWithoutExecutingPartialCalls() throws {
    let message =
      #"{"id":"msg","type":"message","status":"in_progress","role":"assistant","content":[]}"#
    let call =
      #"{"id":"call","type":"function_call","status":"in_progress","call_id":"call_1","name":"read_file","arguments":""}"#
    let reasoning =
      #"{"id":"reasoning","type":"reasoning","status":"in_progress","summary":[]}"#
    let partialMessage =
      #"{"id":"msg","type":"message","status":"incomplete","role":"assistant","content":[{"type":"output_text","text":"partial","annotations":[]}]}"#
    let partialCall =
      #"{"id":"call","type":"function_call","status":"incomplete","call_id":"call_1","name":"read_file","arguments":"{\"path\":"}"#
    let partialReasoning =
      #"{"id":"reasoning","type":"reasoning","status":"incomplete","summary":[{"type":"summary_text","text":"why"}],"encrypted_content":null}"#
    let stream = [
      created(id: "partial", sequence: 1),
      sse(
        "response.output_item.added",
        #"{"type":"response.output_item.added","sequence_number":2,"output_index":0,"item":\#(message)}"#
      ),
      sse(
        "response.content_part.added",
        #"{"type":"response.content_part.added","sequence_number":3,"item_id":"msg","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}"#
      ),
      sse(
        "response.output_text.delta",
        #"{"type":"response.output_text.delta","sequence_number":4,"item_id":"msg","output_index":0,"content_index":0,"delta":"partial"}"#
      ),
      sse(
        "response.output_item.added",
        #"{"type":"response.output_item.added","sequence_number":5,"output_index":1,"item":\#(call)}"#
      ),
      sse(
        "response.function_call_arguments.delta",
        #"{"type":"response.function_call_arguments.delta","sequence_number":6,"item_id":"call","output_index":1,"delta":"{\"path\":"}"#
      ),
      sse(
        "response.output_item.added",
        #"{"type":"response.output_item.added","sequence_number":7,"output_index":2,"item":\#(reasoning)}"#
      ),
      reasoningPartEvent("added", sequence: 8, outputIndex: 2, summaryIndex: 0, text: ""),
      reasoningTextEvent(
        "delta",
        sequence: 9,
        outputIndex: 2,
        summaryIndex: 0,
        key: "delta",
        text: "why"
      ),
      sse(
        "response.output_item.done",
        #"{"type":"response.output_item.done","sequence_number":10,"output_index":0,"item":\#(partialMessage)}"#
      ),
      sse(
        "response.output_item.done",
        #"{"type":"response.output_item.done","sequence_number":11,"output_index":1,"item":\#(partialCall)}"#
      ),
      sse(
        "response.output_item.done",
        #"{"type":"response.output_item.done","sequence_number":12,"output_index":2,"item":\#(partialReasoning)}"#
      ),
      sse(
        "response.incomplete",
        #"{"type":"response.incomplete","sequence_number":13,"response":{"id":"partial","status":"incomplete","output":[\#(partialMessage),\#(partialCall),\#(partialReasoning)],"incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":4,"output_tokens":1,"total_tokens":5,"input_tokens_details":{"cached_tokens":0},"output_tokens_details":{"reasoning_tokens":1}}}}"#
      ),
    ].joined()

    var decoder = BrokerOpenAIResponsesStreamDecoder()
    let events = try decoder.receive(Data(stream.utf8))
    let completion = try decoder.finish()

    #expect(
      events == [
        .textDelta("partial"),
        .reasoningDelta("why"),
        .usage(
          .init(
            inputTokens: 4,
            outputTokens: 1,
            totalTokens: 5,
            cachedInputTokens: 0,
            cacheWriteTokens: nil,
            reasoningTokens: 1
          )
        ),
        .done(.maxOutputTokens),
      ])
    #expect(!events.contains { if case .toolCall = $0 { true } else { false } })
    #expect(completion.outputItems.count == 2)
    #expect(completion.outcome == .output)

    let replay = try BrokerOpenAIResponsesRequest(
      model: "gpt-test",
      input: completion.outputItems.map(BrokerOpenAIResponsesInputItem.privateOutput),
      tools: [],
      maxOutputTokens: 16
    )
    let body = try #require(
      JSONSerialization.jsonObject(with: replay.encodedBody()) as? [String: Any]
    )
    let input = try #require(body["input"] as? [[String: Any]])
    #expect(input.map { $0["status"] as? String } == ["incomplete", "incomplete"])
    #expect(input.map { $0["type"] as? String } == ["message", "reasoning"])
  }

  @Test
  func ordersParallelCallsAndRejectsDuplicateCallsOrMismatchedDoneValues() throws {
    let call0 =
      #"{"id":"fc_0","type":"function_call","status":"in_progress","call_id":"call_0","name":"tool","arguments":""}"#
    let call1 =
      #"{"id":"fc_1","type":"function_call","status":"in_progress","call_id":"call_1","name":"tool","arguments":""}"#
    let done0 =
      #"{"id":"fc_0","type":"function_call","status":"completed","call_id":"call_0","name":"tool","arguments":"{}"}"#
    let done1 =
      #"{"id":"fc_1","type":"function_call","status":"completed","call_id":"call_1","name":"tool","arguments":"{}"}"#
    let parallel = [
      created(id: "parallel", sequence: 1),
      sse(
        "response.output_item.added",
        #"{"type":"response.output_item.added","sequence_number":2,"output_index":0,"item":\#(call0)}"#
      ),
      sse(
        "response.output_item.added",
        #"{"type":"response.output_item.added","sequence_number":3,"output_index":1,"item":\#(call1)}"#
      ),
      sse(
        "response.function_call_arguments.delta",
        #"{"type":"response.function_call_arguments.delta","sequence_number":4,"item_id":"fc_1","output_index":1,"delta":"{}"}"#
      ),
      sse(
        "response.function_call_arguments.delta",
        #"{"type":"response.function_call_arguments.delta","sequence_number":5,"item_id":"fc_0","output_index":0,"delta":"{}"}"#
      ),
      sse(
        "response.function_call_arguments.done",
        #"{"type":"response.function_call_arguments.done","sequence_number":6,"item_id":"fc_1","output_index":1,"name":"tool","arguments":"{}"}"#
      ),
      sse(
        "response.function_call_arguments.done",
        #"{"type":"response.function_call_arguments.done","sequence_number":7,"item_id":"fc_0","output_index":0,"name":"tool","arguments":"{}"}"#
      ),
      sse(
        "response.output_item.done",
        #"{"type":"response.output_item.done","sequence_number":8,"output_index":1,"item":\#(done1)}"#
      ),
      sse(
        "response.output_item.done",
        #"{"type":"response.output_item.done","sequence_number":9,"output_index":0,"item":\#(done0)}"#
      ),
      sse(
        "response.completed",
        #"{"type":"response.completed","sequence_number":10,"response":{"id":"parallel","status":"completed","output":[\#(done0),\#(done1)]}}"#
      ),
    ].joined()
    var decoder = BrokerOpenAIResponsesStreamDecoder()
    let events = try decoder.receive(Data(parallel.utf8))
    #expect(
      events == [
        .toolCall(.init(callID: "call_0", name: "tool", argumentsJSON: Data("{}".utf8))),
        .toolCall(.init(callID: "call_1", name: "tool", argumentsJSON: Data("{}".utf8))),
        .done(.toolCalls),
      ])
    _ = try decoder.finish()

    let duplicate =
      created(id: "dup", sequence: 1)
      + sse(
        "response.output_item.added",
        #"{"type":"response.output_item.added","sequence_number":2,"output_index":0,"item":\#(call0)}"#
      )
      + sse(
        "response.output_item.added",
        #"{"type":"response.output_item.added","sequence_number":3,"output_index":1,"item":{"id":"fc_x","type":"function_call","status":"in_progress","call_id":"call_0","name":"tool","arguments":""}}"#
      )
    var duplicateDecoder = BrokerOpenAIResponsesStreamDecoder()
    #expect(throws: BrokerOpenAIResponsesStreamError.invalidStream) {
      _ = try duplicateDecoder.receive(Data(duplicate.utf8))
    }

    let mismatch =
      created(id: "mismatch", sequence: 1)
      + sse(
        "response.output_item.added",
        #"{"type":"response.output_item.added","sequence_number":2,"output_index":0,"item":\#(call0)}"#
      )
      + sse(
        "response.function_call_arguments.delta",
        #"{"type":"response.function_call_arguments.delta","sequence_number":3,"item_id":"fc_0","output_index":0,"delta":"{}"}"#
      )
      + sse(
        "response.function_call_arguments.done",
        #"{"type":"response.function_call_arguments.done","sequence_number":4,"item_id":"fc_0","output_index":0,"name":"tool","arguments":"{\"different\":true}"}"#
      )
    var mismatchDecoder = BrokerOpenAIResponsesStreamDecoder()
    #expect(throws: BrokerOpenAIResponsesStreamError.invalidStream) {
      _ = try mismatchDecoder.receive(Data(mismatch.utf8))
    }
  }

  @Test
  func boundsOutputItemsAndIndexedPartsWithinTheEventBudget() throws {
    #expect(BrokerOpenAIResponsesStreamDecoder.maximumOutputItemCount == 128)
    #expect(BrokerOpenAIResponsesStreamDecoder.maximumPartCountPerItem == 128)
    #expect(BrokerOpenAIResponsesStreamDecoder.maximumTotalPartCount == 1_024)
    #expect(
      BrokerOpenAIResponsesRequest.maximumOutputTokenCount
        == BrokerOpenAIResponsesStreamDecoder.maximumEventCount
    )

    var perItem = [created(id: "per-item", sequence: 1)]
    perItem.append(
      sse(
        "response.output_item.added",
        #"{"type":"response.output_item.added","sequence_number":2,"output_index":0,"item":{"id":"msg","type":"message","status":"in_progress","role":"assistant","content":[]}}"#
      ))
    for part in 0...BrokerOpenAIResponsesStreamDecoder.maximumPartCountPerItem {
      perItem.append(
        sse(
          "response.content_part.added",
          #"{"type":"response.content_part.added","sequence_number":\#(part + 3),"item_id":"msg","output_index":0,"content_index":\#(part),"part":{"type":"output_text","text":"","annotations":[]}}"#
        ))
    }
    var perItemDecoder = BrokerOpenAIResponsesStreamDecoder()
    #expect(throws: BrokerOpenAIResponsesStreamError.responseTooLarge) {
      _ = try perItemDecoder.receive(Data(perItem.joined().utf8))
    }

    var total = [created(id: "total", sequence: 1)]
    var sequence = 2
    for item in 0..<9 {
      total.append(
        sse(
          "response.output_item.added",
          #"{"type":"response.output_item.added","sequence_number":\#(sequence),"output_index":\#(item),"item":{"id":"msg_\#(item)","type":"message","status":"in_progress","role":"assistant","content":[]}}"#
        ))
      sequence += 1
      let count = item < 8 ? BrokerOpenAIResponsesStreamDecoder.maximumPartCountPerItem : 1
      for part in 0..<count {
        total.append(
          sse(
            "response.content_part.added",
            #"{"type":"response.content_part.added","sequence_number":\#(sequence),"item_id":"msg_\#(item)","output_index":\#(item),"content_index":\#(part),"part":{"type":"output_text","text":"","annotations":[]}}"#
          ))
        sequence += 1
      }
    }
    var totalDecoder = BrokerOpenAIResponsesStreamDecoder()
    #expect(throws: BrokerOpenAIResponsesStreamError.responseTooLarge) {
      _ = try totalDecoder.receive(Data(total.joined().utf8))
    }
  }

  @Test
  func enforcesUsageEventCallAndArgumentBounds() throws {
    for usage in [
      #""usage":{"input_tokens":-1,"output_tokens":0,"total_tokens":0,"input_tokens_details":{"cached_tokens":0},"output_tokens_details":{"reasoning_tokens":0}}"#,
      #""usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2,"input_tokens_details":{"cached_tokens":2},"output_tokens_details":{"reasoning_tokens":0}}"#,
      #""usage":{"input_tokens":1,"output_tokens":1,"total_tokens":3,"input_tokens_details":{"cached_tokens":0},"output_tokens_details":{"reasoning_tokens":0}}"#,
      #""usage":{"input_tokens":2,"output_tokens":1,"total_tokens":3,"input_tokens_details":{"cached_tokens":1,"cache_write_tokens":2},"output_tokens_details":{"reasoning_tokens":0}}"#,
    ] {
      let stream =
        created(id: "usage", sequence: 1)
        + sse(
          "response.completed",
          #"{"type":"response.completed","sequence_number":2,"response":{"id":"usage","status":"completed","output":[],\#(usage)}}"#
        )
      var decoder = BrokerOpenAIResponsesStreamDecoder()
      #expect(throws: BrokerOpenAIResponsesStreamError.invalidStream) {
        _ = try decoder.receive(Data(stream.utf8))
      }
    }

    var oversizedEvent = BrokerOpenAIResponsesStreamDecoder()
    #expect(throws: BrokerOpenAIResponsesStreamError.responseTooLarge) {
      _ = try oversizedEvent.receive(
        Data(repeating: 0x61, count: BrokerOpenAIResponsesStreamDecoder.maximumEventByteCount + 1)
      )
    }

    var callEvents = [created(id: "calls", sequence: 1)]
    for index in 0...BrokerOpenAIResponsesStreamDecoder.maximumToolCallCount {
      callEvents.append(
        sse(
          "response.output_item.added",
          #"{"type":"response.output_item.added","sequence_number":\#(index + 2),"output_index":\#(index),"item":{"id":"fc_\#(index)","type":"function_call","status":"in_progress","call_id":"call_\#(index)","name":"tool","arguments":""}}"#
        )
      )
    }
    var calls = BrokerOpenAIResponsesStreamDecoder()
    #expect(throws: BrokerOpenAIResponsesStreamError.invalidStream) {
      _ = try calls.receive(Data(callEvents.joined().utf8))
    }

    let first = String(repeating: "a", count: 600_000)
    let second = String(repeating: "b", count: 600_000)
    let added =
      #"{"id":"fc","type":"function_call","status":"in_progress","call_id":"call","name":"tool","arguments":""}"#
    let argumentStream =
      created(id: "args", sequence: 1)
      + sse(
        "response.output_item.added",
        #"{"type":"response.output_item.added","sequence_number":2,"output_index":0,"item":\#(added)}"#
      )
      + sse(
        "response.function_call_arguments.delta",
        #"{"type":"response.function_call_arguments.delta","sequence_number":3,"item_id":"fc","output_index":0,"delta":"\#(first)"}"#
      )
      + sse(
        "response.function_call_arguments.delta",
        #"{"type":"response.function_call_arguments.delta","sequence_number":4,"item_id":"fc","output_index":0,"delta":"\#(second)"}"#
      )
    var arguments = BrokerOpenAIResponsesStreamDecoder()
    #expect(throws: BrokerOpenAIResponsesStreamError.responseTooLarge) {
      _ = try arguments.receive(Data(argumentStream.utf8))
    }

    var eventEvents = [created(id: "events", sequence: 1)]
    let message =
      #"{"id":"m","type":"message","status":"in_progress","role":"assistant","content":[]}"#
    eventEvents.append(
      sse(
        "response.output_item.added",
        #"{"type":"response.output_item.added","sequence_number":2,"output_index":0,"item":\#(message)}"#
      ))
    eventEvents.append(
      sse(
        "response.content_part.added",
        #"{"type":"response.content_part.added","sequence_number":3,"item_id":"m","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}"#
      ))
    for sequence in 4...(BrokerOpenAIResponsesStreamDecoder.maximumEventCount + 1) {
      eventEvents.append(
        sse(
          "response.output_text.delta",
          #"{"type":"response.output_text.delta","sequence_number":\#(sequence),"item_id":"m","output_index":0,"content_index":0,"delta":""}"#
        ))
    }
    var eventBound = BrokerOpenAIResponsesStreamDecoder()
    #expect(throws: BrokerOpenAIResponsesStreamError.responseTooLarge) {
      _ = try eventBound.receive(Data(eventEvents.joined().utf8))
    }
  }

  private func sse(_ event: String, _ json: String) -> String {
    "event: \(event)\ndata: \(json)\n\n"
  }

  private func reasoningPartEvent(
    _ phase: String,
    sequence: Int,
    outputIndex: Int = 1,
    summaryIndex: Int,
    text: String
  ) -> String {
    sse(
      "response.reasoning_summary_part.\(phase)",
      #"{"type":"response.reasoning_summary_part.\#(phase)","sequence_number":\#(sequence),"item_id":"reasoning","output_index":\#(outputIndex),"summary_index":\#(summaryIndex),"part":{"type":"summary_text","text":"\#(text)"}}"#
    )
  }

  private func reasoningTextEvent(
    _ phase: String,
    sequence: Int,
    outputIndex: Int = 1,
    summaryIndex: Int,
    key: String,
    text: String
  ) -> String {
    sse(
      "response.reasoning_summary_text.\(phase)",
      #"{"type":"response.reasoning_summary_text.\#(phase)","sequence_number":\#(sequence),"item_id":"reasoning","output_index":\#(outputIndex),"summary_index":\#(summaryIndex),"\#(key)":"\#(text)"}"#
    )
  }

  private func created(id: String, sequence: Int) -> String {
    sse(
      "response.created",
      #"{"type":"response.created","sequence_number":\#(sequence),"response":{"id":"\#(id)","status":"in_progress","output":[]}}"#
    )
  }

  private func emptyCompletedStream(
    id: String,
    usage: BrokerOpenAIResponsesUsage?
  ) -> String {
    let usageJSON: String
    if let usage {
      let cached = usage.cachedInputTokens ?? 0
      let reasoning = usage.reasoningTokens ?? 0
      usageJSON =
        #", "usage":{"input_tokens":\#(usage.inputTokens),"output_tokens":\#(usage.outputTokens),"total_tokens":\#(usage.totalTokens),"input_tokens_details":{"cached_tokens":\#(cached)\#(usage.cacheWriteTokens.map { ",\"cache_write_tokens\":\($0)" } ?? "")},"output_tokens_details":{"reasoning_tokens":\#(reasoning)}}"#
    } else {
      usageJSON = ""
    }
    return created(id: id, sequence: 1)
      + sse(
        "response.completed",
        #"{"type":"response.completed","sequence_number":2,"response":{"id":"\#(id)","status":"completed","output":[]\#(usageJSON)}}"#
      )
  }
}
