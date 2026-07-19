import CoreFoundation
import Foundation

struct BrokerAnthropicMessagesStreamDecoder {
  static let maximumResponseByteCount = 32 * 1_024 * 1_024
  static let maximumEventByteCount = 1 * 1_024 * 1_024
  static let maximumEventCount = 8_192

  private enum Block: Equatable {
    case text
    case tool(callID: String, name: String, json: String)
  }

  private var buffer = Data()
  private var receivedBytes = 0
  private var eventCount = 0
  private var responseID: String?
  private var inputTokens: Int?
  private var cachedInputTokens = 0
  private var cacheWriteTokens: Int?
  private var blocks: [Block] = []
  private var activeIndex: Int?
  private var stopReason: BrokerOpenAIResponsesStopReason?
  private var finalUsage: BrokerOpenAIResponsesUsage?
  private var terminal: BrokerOpenAIResponsesCompletion?
  private var failed = false

  mutating func receive(_ chunk: Data) throws(BrokerAnthropicMessagesError)
    -> [BrokerOpenAIResponsesEvent]
  {
    guard !failed, terminal == nil || chunk.isEmpty else { throw fail(.invalidStream) }
    let (next, overflowed) = receivedBytes.addingReportingOverflow(chunk.count)
    guard !overflowed, next <= Self.maximumResponseByteCount else { throw fail(.responseTooLarge) }
    receivedBytes = next
    buffer.append(chunk)

    var emitted: [BrokerOpenAIResponsesEvent] = []
    while let boundary = Self.boundary(in: buffer) {
      let block = Data(buffer.prefix(boundary.start))
      buffer.removeFirst(boundary.end)
      guard !block.isEmpty, block.count <= Self.maximumEventByteCount,
        eventCount < Self.maximumEventCount
      else { throw fail(.responseTooLarge) }
      eventCount += 1
      do {
        emitted.append(contentsOf: try consume(block))
      } catch let error as BrokerAnthropicMessagesError {
        throw fail(error)
      } catch {
        throw fail(.invalidStream)
      }
    }
    guard buffer.count <= Self.maximumEventByteCount else { throw fail(.responseTooLarge) }
    return emitted
  }

  mutating func finish() throws(BrokerAnthropicMessagesError) -> BrokerOpenAIResponsesCompletion {
    guard !failed, buffer.isEmpty, let terminal else { throw fail(.invalidStream) }
    return terminal
  }

  private mutating func consume(_ block: Data) throws -> [BrokerOpenAIResponsesEvent] {
    guard let text = String(data: block, encoding: .utf8) else {
      throw BrokerAnthropicMessagesError.invalidStream
    }
    let normalized = text.replacingOccurrences(of: "\r\n", with: "\n")
    guard !normalized.contains("\r") else { throw BrokerAnthropicMessagesError.invalidStream }
    let lines = normalized.split(separator: "\n", omittingEmptySubsequences: false)
    guard lines.count == 2, lines[0].hasPrefix("event: "), lines[1].hasPrefix("data: ") else {
      throw BrokerAnthropicMessagesError.invalidStream
    }
    let name = String(lines[0].dropFirst(7))
    let payload = Data(lines[1].dropFirst(6).utf8)
    let object = try BrokerStrictJSON.object(
      from: payload, maximumByteCount: Self.maximumEventByteCount)
    guard object["type"] as? String == name else {
      throw BrokerAnthropicMessagesError.invalidStream
    }

    switch name {
    case "message_start": return try messageStart(object)
    case "content_block_start": return try contentStart(object)
    case "content_block_delta": return try contentDelta(object)
    case "content_block_stop": return try contentStop(object)
    case "message_delta": return try messageDelta(object)
    case "message_stop": return try messageStop(object)
    case "ping":
      try exactKeys(object, ["type"])
      guard responseID != nil, terminal == nil else {
        throw BrokerAnthropicMessagesError.invalidStream
      }
      return []
    case "error": throw BrokerAnthropicMessagesError.providerFailure
    default: throw BrokerAnthropicMessagesError.invalidStream
    }
  }

  private mutating func messageStart(_ object: [String: Any]) throws -> [BrokerOpenAIResponsesEvent]
  {
    try exactKeys(object, ["type", "message"])
    guard responseID == nil, let message = object["message"] as? [String: Any] else {
      throw BrokerAnthropicMessagesError.invalidStream
    }
    try exactKeys(
      message,
      ["id", "type", "role", "content", "model", "stop_reason", "stop_sequence", "usage"]
    )
    guard let id = message["id"] as? String, validIdentifier(id),
      message["type"] as? String == "message", message["role"] as? String == "assistant",
      let content = message["content"] as? [Any], content.isEmpty,
      let model = message["model"] as? String, validIdentifier(model),
      message["stop_reason"] is NSNull, message["stop_sequence"] is NSNull,
      let usage = message["usage"] as? [String: Any],
      let input = integer(usage["input_tokens"]), input >= 0,
      let output = integer(usage["output_tokens"]), output >= 0
    else { throw BrokerAnthropicMessagesError.invalidStream }
    try usageKeys(usage)
    responseID = id
    inputTokens = input
    cachedInputTokens = try optionalNonnegative(usage, "cache_read_input_tokens")
    let write = try optionalNonnegative(usage, "cache_creation_input_tokens")
    cacheWriteTokens = write == 0 ? nil : write
    return []
  }

  private mutating func contentStart(_ object: [String: Any]) throws -> [BrokerOpenAIResponsesEvent]
  {
    try exactKeys(object, ["type", "index", "content_block"])
    guard responseID != nil, stopReason == nil, activeIndex == nil,
      let index = integer(object["index"]), index == blocks.count,
      let content = object["content_block"] as? [String: Any],
      let type = content["type"] as? String
    else { throw BrokerAnthropicMessagesError.invalidStream }
    switch type {
    case "text":
      try exactKeys(content, ["type", "text"])
      guard content["text"] as? String == "" else {
        throw BrokerAnthropicMessagesError.invalidStream
      }
      blocks.append(.text)
    case "tool_use":
      try exactKeys(content, ["type", "id", "name", "input"])
      guard let id = content["id"] as? String, validIdentifier(id),
        let name = content["name"] as? String,
        BrokerOpenAIResponsesFunctionTool.validName(name),
        let input = content["input"] as? [String: Any], input.isEmpty
      else { throw BrokerAnthropicMessagesError.invalidStream }
      blocks.append(.tool(callID: id, name: name, json: ""))
    default: throw BrokerAnthropicMessagesError.invalidStream
    }
    activeIndex = index
    return []
  }

  private mutating func contentDelta(_ object: [String: Any]) throws -> [BrokerOpenAIResponsesEvent]
  {
    try exactKeys(object, ["type", "index", "delta"])
    guard let index = integer(object["index"]), activeIndex == index,
      blocks.indices.contains(index), let delta = object["delta"] as? [String: Any],
      let type = delta["type"] as? String
    else { throw BrokerAnthropicMessagesError.invalidStream }
    switch (blocks[index], type) {
    case (.text, "text_delta"):
      try exactKeys(delta, ["type", "text"])
      guard let text = delta["text"] as? String,
        text.utf8.count <= BrokerOpenAIResponsesRequest.maximumTextByteCount
      else { throw BrokerAnthropicMessagesError.invalidStream }
      return text.isEmpty ? [] : [.textDelta(text)]
    case (.tool(let id, let name, let existing), "input_json_delta"):
      try exactKeys(delta, ["type", "partial_json"])
      guard let fragment = delta["partial_json"] as? String else {
        throw BrokerAnthropicMessagesError.invalidStream
      }
      let joined = existing + fragment
      guard joined.utf8.count <= BrokerOpenAIResponsesRequest.maximumTextByteCount else {
        throw BrokerAnthropicMessagesError.responseTooLarge
      }
      blocks[index] = .tool(callID: id, name: name, json: joined)
      return []
    default: throw BrokerAnthropicMessagesError.invalidStream
    }
  }

  private mutating func contentStop(_ object: [String: Any]) throws -> [BrokerOpenAIResponsesEvent]
  {
    try exactKeys(object, ["type", "index"])
    guard let index = integer(object["index"]), activeIndex == index,
      blocks.indices.contains(index)
    else { throw BrokerAnthropicMessagesError.invalidStream }
    activeIndex = nil
    guard case .tool(let id, let name, let json) = blocks[index] else { return [] }
    let arguments = try canonicalObject(Data(json.utf8))
    return [
      .toolCall(
        BrokerOpenAIResponsesToolCall(
          callID: id,
          name: name,
          argumentsJSON: arguments
        ))
    ]
  }

  private mutating func messageDelta(_ object: [String: Any]) throws -> [BrokerOpenAIResponsesEvent]
  {
    try exactKeys(object, ["type", "delta", "usage"])
    guard responseID != nil, activeIndex == nil, stopReason == nil,
      let delta = object["delta"] as? [String: Any],
      let usage = object["usage"] as? [String: Any]
    else { throw BrokerAnthropicMessagesError.invalidStream }
    try exactKeys(delta, ["stop_reason", "stop_sequence"])
    guard delta["stop_sequence"] is NSNull, let raw = delta["stop_reason"] as? String,
      let inputTokens, let outputTokens = integer(usage["output_tokens"]), outputTokens >= 0
    else { throw BrokerAnthropicMessagesError.invalidStream }
    try exactKeys(usage, ["output_tokens"])
    let reason: BrokerOpenAIResponsesStopReason
    switch raw {
    case "end_turn", "stop_sequence": reason = .complete
    case "tool_use": reason = .toolCalls
    case "max_tokens": reason = .maxOutputTokens
    case "refusal": throw BrokerAnthropicMessagesError.contentFiltered
    default: throw BrokerAnthropicMessagesError.providerFailure
    }
    let (total, overflowed) = inputTokens.addingReportingOverflow(outputTokens)
    guard !overflowed else { throw BrokerAnthropicMessagesError.invalidStream }
    let normalized = BrokerOpenAIResponsesUsage(
      inputTokens: inputTokens,
      outputTokens: outputTokens,
      totalTokens: total,
      cachedInputTokens: cachedInputTokens,
      cacheWriteTokens: cacheWriteTokens,
      reasoningTokens: 0
    )
    stopReason = reason
    finalUsage = normalized
    return [.usage(normalized)]
  }

  private mutating func messageStop(_ object: [String: Any]) throws -> [BrokerOpenAIResponsesEvent]
  {
    try exactKeys(object, ["type"])
    guard let responseID, let stopReason, let finalUsage, activeIndex == nil,
      terminal == nil
    else { throw BrokerAnthropicMessagesError.invalidStream }
    terminal = BrokerOpenAIResponsesCompletion(
      responseID: responseID,
      outputItems: [],
      usage: finalUsage,
      stopReason: stopReason,
      outcome: .output
    )
    return [.done(stopReason)]
  }

  private mutating func fail(_ error: BrokerAnthropicMessagesError) -> BrokerAnthropicMessagesError
  {
    failed = true
    buffer.removeAll(keepingCapacity: false)
    return error
  }

  private static func boundary(in data: Data) -> (start: Int, end: Int)? {
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
}

private func exactKeys(_ object: [String: Any], _ expected: Set<String>) throws {
  guard Set(object.keys) == expected else { throw BrokerAnthropicMessagesError.invalidStream }
}

private func usageKeys(_ usage: [String: Any]) throws {
  let allowed: Set<String> = [
    "input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens",
  ]
  guard Set(usage.keys).isSubset(of: allowed), usage["input_tokens"] != nil,
    usage["output_tokens"] != nil
  else { throw BrokerAnthropicMessagesError.invalidStream }
}

private func optionalNonnegative(_ object: [String: Any], _ key: String) throws -> Int {
  guard let value = object[key] else { return 0 }
  guard let integer = integer(value), integer >= 0 else {
    throw BrokerAnthropicMessagesError.invalidStream
  }
  return integer
}

private func integer(_ value: Any?) -> Int? {
  guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else {
    return nil
  }
  let double = number.doubleValue
  guard double.isFinite, double.rounded() == double,
    double >= Double(Int.min), double <= Double(Int.max)
  else { return nil }
  return Int(double)
}

private func validIdentifier(_ value: String) -> Bool {
  (1...256).contains(value.utf8.count)
    && value.unicodeScalars.allSatisfy { $0.value >= 0x21 && $0.value <= 0x7e }
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
