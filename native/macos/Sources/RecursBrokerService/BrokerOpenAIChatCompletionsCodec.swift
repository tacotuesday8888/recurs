import CoreFoundation
import Foundation

enum BrokerOpenAIChatCompletionsError: Error, Sendable, Equatable {
  case invalidRequest
  case requestTooLarge
  case invalidStream
  case responseTooLarge
  case contentFiltered
  case providerFailure
}

enum BrokerOpenAIChatCompletionsInput: Sendable, Equatable {
  case message(role: BrokerOpenAIResponsesMessageRole, text: String)
  case toolUse(callID: String, name: String, argumentsJSON: Data)
  case toolResult(callID: String, output: String)
}

struct BrokerOpenAIChatCompletionsRequest: Sendable, Equatable {
  static let maximumBodyByteCount = 4 * 1_024 * 1_024
  let model: String
  let input: [BrokerOpenAIChatCompletionsInput]
  let tools: [BrokerOpenAIResponsesFunctionTool]
  let maxOutputTokens: Int

  init(
    model: String,
    input: [BrokerOpenAIChatCompletionsInput],
    tools: [BrokerOpenAIResponsesFunctionTool],
    maxOutputTokens: Int
  ) throws {
    guard !model.isEmpty, model.utf8.count <= 256,
      (1...BrokerOpenAIResponsesRequest.maximumInputItemCount).contains(input.count),
      tools.count <= BrokerOpenAIResponsesRequest.maximumToolCount,
      (1...BrokerOpenAIResponsesRequest.maximumOutputTokenCount).contains(maxOutputTokens)
    else { throw BrokerOpenAIChatCompletionsError.invalidRequest }
    self.model = model
    self.input = input
    self.tools = tools
    self.maxOutputTokens = maxOutputTokens
    _ = try encodedBody()
  }

  func encodedBody() throws(BrokerOpenAIChatCompletionsError) -> Data {
    do {
      var messages: [[String: Any]] = []
      for item in input {
        switch item {
        case .message(let role, let text):
          guard !text.isEmpty,
            text.utf8.count <= BrokerOpenAIResponsesRequest.maximumTextByteCount
          else { throw BrokerOpenAIChatCompletionsError.invalidRequest }
          messages.append([
            "role": role == .developer
              ? BrokerOpenAIResponsesMessageRole.system.rawValue : role.rawValue,
            "content": text,
          ])
        case .toolUse(let callID, let name, let argumentsJSON):
          guard validID(callID), BrokerOpenAIResponsesFunctionTool.validName(name) else {
            throw BrokerOpenAIChatCompletionsError.invalidRequest
          }
          let arguments = try BrokerStrictJSON.object(
            from: argumentsJSON,
            maximumByteCount: BrokerOpenAIResponsesRequest.maximumTextByteCount
          )
          let canonical = try JSONSerialization.data(
            withJSONObject: arguments,
            options: [.sortedKeys, .withoutEscapingSlashes]
          )
          messages.append([
            "role": "assistant",
            "content": NSNull(),
            "tool_calls": [
              [
                "id": callID,
                "type": "function",
                "function": [
                  "name": name, "arguments": String(decoding: canonical, as: UTF8.self),
                ],
              ]
            ],
          ])
        case .toolResult(let callID, let output):
          guard validID(callID), !output.isEmpty,
            output.utf8.count <= BrokerOpenAIResponsesRequest.maximumTextByteCount
          else { throw BrokerOpenAIChatCompletionsError.invalidRequest }
          messages.append(["role": "tool", "tool_call_id": callID, "content": output])
        }
      }
      var body: [String: Any] = [
        "model": model,
        "messages": messages,
        "max_tokens": maxOutputTokens,
        "stream": true,
        "stream_options": ["include_usage": true],
      ]
      if !tools.isEmpty {
        body["tools"] = try tools.map { tool in
          [
            "type": "function",
            "function": [
              "name": tool.name,
              "description": tool.description,
              "parameters": try BrokerStrictJSON.object(
                from: tool.parametersJSON,
                maximumByteCount: BrokerOpenAIResponsesFunctionTool.maximumSchemaByteCount
              ),
            ],
          ] as [String: Any]
        }
      }
      let encoded = try JSONSerialization.data(
        withJSONObject: body,
        options: [.sortedKeys, .withoutEscapingSlashes]
      )
      guard encoded.count <= Self.maximumBodyByteCount else {
        throw BrokerOpenAIChatCompletionsError.requestTooLarge
      }
      return encoded
    } catch let error as BrokerOpenAIChatCompletionsError {
      throw error
    } catch {
      throw .invalidRequest
    }
  }
}

struct BrokerOpenAIChatCompletionsStreamDecoder {
  static let maximumResponseByteCount = 32 * 1_024 * 1_024
  static let maximumEventByteCount = 1 * 1_024 * 1_024
  static let maximumEventCount = 8_192

  private struct ToolState {
    let id: String
    let name: String
    var arguments: String
    var emitted = false
  }

  private var buffer = Data()
  private var receivedBytes = 0
  private var eventCount = 0
  private var responseID: String?
  private var model: String?
  private var tools: [Int: ToolState] = [:]
  private var stopReason: BrokerOpenAIResponsesStopReason?
  private var usage: BrokerOpenAIResponsesUsage?
  private var sawDone = false
  private var failed = false

  mutating func receive(_ chunk: Data) throws(BrokerOpenAIChatCompletionsError)
    -> [BrokerOpenAIResponsesEvent]
  {
    guard !failed, !sawDone || chunk.isEmpty else { throw fail(.invalidStream) }
    let (next, overflowed) = receivedBytes.addingReportingOverflow(chunk.count)
    guard !overflowed, next <= Self.maximumResponseByteCount else {
      throw fail(.responseTooLarge)
    }
    receivedBytes = next
    buffer.append(chunk)
    var events: [BrokerOpenAIResponsesEvent] = []
    while let boundary = boundary(in: buffer) {
      let block = Data(buffer.prefix(boundary.start))
      buffer.removeFirst(boundary.end)
      guard !block.isEmpty, block.count <= Self.maximumEventByteCount,
        eventCount < Self.maximumEventCount
      else { throw fail(.responseTooLarge) }
      eventCount += 1
      do { events.append(contentsOf: try consume(block)) } catch let error
        as BrokerOpenAIChatCompletionsError
      { throw fail(error) } catch { throw fail(.invalidStream) }
    }
    guard buffer.count <= Self.maximumEventByteCount else { throw fail(.responseTooLarge) }
    return events
  }

  mutating func finish() throws(BrokerOpenAIChatCompletionsError)
    -> BrokerOpenAIResponsesCompletion
  {
    guard !failed, buffer.isEmpty, sawDone, let responseID, let stopReason, let usage,
      tools.values.allSatisfy(\.emitted)
    else { throw fail(.invalidStream) }
    return BrokerOpenAIResponsesCompletion(
      responseID: responseID,
      outputItems: [],
      usage: usage,
      stopReason: stopReason,
      outcome: .output
    )
  }

  private mutating func consume(_ block: Data) throws -> [BrokerOpenAIResponsesEvent] {
    guard let line = String(data: block, encoding: .utf8), line.hasPrefix("data: "),
      !line.dropFirst(6).contains("\n"), !line.contains("\r")
    else { throw BrokerOpenAIChatCompletionsError.invalidStream }
    let payload = String(line.dropFirst(6))
    if payload == "[DONE]" {
      guard stopReason != nil, usage != nil, !sawDone else {
        throw BrokerOpenAIChatCompletionsError.invalidStream
      }
      sawDone = true
      return [.done(stopReason!)]
    }
    guard !sawDone else { throw BrokerOpenAIChatCompletionsError.invalidStream }
    let object = try BrokerStrictJSON.object(
      from: Data(payload.utf8),
      maximumByteCount: Self.maximumEventByteCount
    )
    guard let id = object["id"] as? String, validID(id),
      object["object"] as? String == "chat.completion.chunk",
      let selectedModel = object["model"] as? String, !selectedModel.isEmpty,
      let choices = object["choices"] as? [[String: Any]]
    else { throw BrokerOpenAIChatCompletionsError.invalidStream }
    let rawUsage = object["usage"] ?? NSNull()
    if let responseID {
      guard responseID == id, model == selectedModel else {
        throw BrokerOpenAIChatCompletionsError.invalidStream
      }
    } else {
      responseID = id
      model = selectedModel
    }
    var events: [BrokerOpenAIResponsesEvent] = []
    for choice in choices {
      guard integer(choice["index"]) == 0, let delta = choice["delta"] as? [String: Any]
      else { throw BrokerOpenAIChatCompletionsError.invalidStream }
      if let role = delta["role"] as? String, role != "assistant" {
        throw BrokerOpenAIChatCompletionsError.invalidStream
      }
      if let content = delta["content"], !(content is NSNull) {
        guard let content = content as? String else {
          throw BrokerOpenAIChatCompletionsError.invalidStream
        }
        if !content.isEmpty { events.append(.textDelta(content)) }
      }
      if let calls = delta["tool_calls"] as? [[String: Any]] {
        for call in calls { try consumeToolDelta(call) }
      }
      if let finish = choice["finish_reason"], !(finish is NSNull) {
        guard stopReason == nil, let finish = finish as? String else {
          throw BrokerOpenAIChatCompletionsError.invalidStream
        }
        switch finish {
        case "stop": stopReason = .complete
        case "tool_calls": stopReason = .toolCalls
        case "length": stopReason = .maxOutputTokens
        case "content_filter": throw BrokerOpenAIChatCompletionsError.contentFiltered
        default: throw BrokerOpenAIChatCompletionsError.providerFailure
        }
        if finish == "tool_calls" {
          for index in tools.keys.sorted() {
            guard var tool = tools[index], !tool.emitted else { continue }
            let arguments = try canonicalObject(Data(tool.arguments.utf8))
            tool.emitted = true
            tools[index] = tool
            events.append(
              .toolCall(
                .init(
                  callID: tool.id,
                  name: tool.name,
                  argumentsJSON: arguments
                )))
          }
        }
      }
    }
    if !(rawUsage is NSNull) {
      guard usage == nil, let value = rawUsage as? [String: Any],
        let input = integer(value["prompt_tokens"]), input >= 0,
        let output = integer(value["completion_tokens"]), output >= 0,
        let total = integer(value["total_tokens"]), total == input + output
      else { throw BrokerOpenAIChatCompletionsError.invalidStream }
      let normalized = BrokerOpenAIResponsesUsage(
        inputTokens: input,
        outputTokens: output,
        totalTokens: total,
        cachedInputTokens: 0,
        cacheWriteTokens: nil,
        reasoningTokens: 0
      )
      usage = normalized
      events.append(.usage(normalized))
    }
    return events
  }

  private mutating func consumeToolDelta(_ call: [String: Any]) throws {
    guard let index = integer(call["index"]), index >= 0,
      let function = call["function"] as? [String: Any]
    else { throw BrokerOpenAIChatCompletionsError.invalidStream }
    if var state = tools[index] {
      guard call["id"] == nil, call["type"] == nil, function["name"] == nil,
        let fragment = function["arguments"] as? String,
        state.arguments.utf8.count + fragment.utf8.count
          <= BrokerOpenAIResponsesRequest.maximumTextByteCount
      else { throw BrokerOpenAIChatCompletionsError.invalidStream }
      state.arguments += fragment
      tools[index] = state
    } else {
      guard index == tools.count, let id = call["id"] as? String, validID(id),
        call["type"] as? String == "function",
        let name = function["name"] as? String,
        BrokerOpenAIResponsesFunctionTool.validName(name),
        let arguments = function["arguments"] as? String
      else { throw BrokerOpenAIChatCompletionsError.invalidStream }
      tools[index] = ToolState(id: id, name: name, arguments: arguments)
    }
  }

  private mutating func fail(_ error: BrokerOpenAIChatCompletionsError)
    -> BrokerOpenAIChatCompletionsError
  {
    failed = true
    buffer.removeAll(keepingCapacity: false)
    return error
  }
}

private func validID(_ value: String) -> Bool {
  (1...256).contains(value.utf8.count)
    && value.unicodeScalars.allSatisfy { $0.value >= 0x21 && $0.value <= 0x7e }
}

private func integer(_ value: Any?) -> Int? {
  guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else {
    return nil
  }
  let value = number.doubleValue
  guard value.isFinite, value.rounded(.towardZero) == value,
    value >= Double(Int.min), value <= Double(Int.max)
  else { return nil }
  return Int(value)
}

private func canonicalObject(_ data: Data) throws -> Data {
  let object = try BrokerStrictJSON.object(
    from: data,
    maximumByteCount: BrokerOpenAIResponsesRequest.maximumTextByteCount
  )
  return try JSONSerialization.data(
    withJSONObject: object,
    options: [.sortedKeys, .withoutEscapingSlashes]
  )
}

private func boundary(in data: Data) -> (start: Int, end: Int)? {
  let bytes = [UInt8](data)
  if bytes.count >= 2 {
    for index in 0...(bytes.count - 2) where bytes[index] == 10 && bytes[index + 1] == 10 {
      return (index, index + 2)
    }
  }
  if bytes.count >= 4 {
    for index in 0...(bytes.count - 4)
    where bytes[index...index + 3].elementsEqual([13, 10, 13, 10]) {
      return (index, index + 4)
    }
  }
  return nil
}
