import CoreFoundation
import Foundation

enum BrokerOpenAIResponsesStreamError:
  Error, Sendable, Equatable, CustomStringConvertible, LocalizedError
{
  case invalidStream
  case responseTooLarge
  case contentFiltered
  case providerFailure

  private var fixedDescription: String {
    switch self {
    case .invalidStream:
      "OpenAI returned an invalid Responses stream."
    case .responseTooLarge:
      "OpenAI returned a Responses stream that exceeded its size limit."
    case .contentFiltered:
      "OpenAI stopped the response because of its content filter."
    case .providerFailure:
      "OpenAI failed to complete the response."
    }
  }

  var description: String { fixedDescription }
  var errorDescription: String? { fixedDescription }
}

struct BrokerOpenAIResponsesUsage: Sendable, Equatable {
  let inputTokens: Int
  let outputTokens: Int
  let totalTokens: Int
  let cachedInputTokens: Int
  let cacheWriteTokens: Int?
  let reasoningTokens: Int
}

struct BrokerOpenAIResponsesToolCall: Sendable, Equatable {
  let callID: String
  let name: String
  let argumentsJSON: Data
}

enum BrokerOpenAIResponsesStopReason: Sendable, Equatable {
  case complete
  case toolCalls
  case maxOutputTokens
}

enum BrokerOpenAIResponsesOutcome: Sendable, Equatable {
  case output
  case refusal(String)
}

enum BrokerOpenAIResponsesEvent: Sendable, Equatable {
  case textDelta(String)
  case reasoningDelta(String)
  case refusalDelta(String)
  case toolCall(BrokerOpenAIResponsesToolCall)
  case usage(BrokerOpenAIResponsesUsage)
  case done(BrokerOpenAIResponsesStopReason)
}

struct BrokerOpenAIResponsesCompletion: Sendable, Equatable {
  let responseID: String
  let outputItems: [BrokerOpenAIResponsesPrivateOutput]
  let usage: BrokerOpenAIResponsesUsage?
  let stopReason: BrokerOpenAIResponsesStopReason
  let outcome: BrokerOpenAIResponsesOutcome
}

struct BrokerOpenAIResponsesStreamDecoder {
  static let maximumResponseByteCount = 33_554_432
  static let maximumEventByteCount = 1_048_576
  static let maximumEventCount = 8_192
  static let maximumOutputItemCount = 128
  static let maximumToolCallCount = 128
  static let maximumPartCountPerItem = 128
  static let maximumTotalPartCount = 1_024
  static let maximumAccumulatedValueByteCount = 1_048_576

  private enum Lifecycle {
    case queued
    case inProgress
  }

  private enum ItemKind: String {
    case message
    case functionCall = "function_call"
    case reasoning
  }

  private enum PartKind: String {
    case outputText = "output_text"
    case refusal
    case summaryText = "summary_text"

    var valueKey: String {
      self == .refusal ? "refusal" : "text"
    }
  }

  private struct PartState {
    let kind: PartKind
    var value = ""
    var byteCount = 0
    var valueDone = false
    var partDone = false
  }

  private struct ItemState {
    let id: String
    let kind: ItemKind
    var callID: String?
    var name: String?
    var functionValue = ""
    var functionByteCount = 0
    var functionDone = false
    var parts: [PartState] = []
    var doneItem: [String: Any]?
  }

  private var buffer = Data()
  private var boundaryScanOffset = 0
  private var receivedByteCount = 0
  private var eventCount = 0
  private var lastSequenceNumber: Int?
  private var responseID: String?
  private var lifecycle: Lifecycle?
  private var sawQueuedEvent = false
  private var sawInProgressEvent = false
  private var totalPartCount = 0
  private var items: [ItemState] = []
  private var terminal: BrokerOpenAIResponsesCompletion?
  private var failed = false

  mutating func receive(_ chunk: Data) throws -> [BrokerOpenAIResponsesEvent] {
    guard !failed, terminal == nil || chunk.isEmpty else { throw fail(.invalidStream) }
    let (nextCount, overflowed) = receivedByteCount.addingReportingOverflow(chunk.count)
    guard !overflowed, nextCount <= Self.maximumResponseByteCount else {
      throw fail(.responseTooLarge)
    }
    receivedByteCount = nextCount
    buffer.append(chunk)

    var emitted: [BrokerOpenAIResponsesEvent] = []
    var consumedOffset = 0
    var searchOffset = boundaryScanOffset
    while let boundary = Self.nextBoundary(in: buffer, from: searchOffset) {
      let start = buffer.index(buffer.startIndex, offsetBy: consumedOffset)
      let end = buffer.index(buffer.startIndex, offsetBy: boundary.start)
      let block = Data(buffer[start..<end])
      guard block.count <= Self.maximumEventByteCount, eventCount < Self.maximumEventCount else {
        throw fail(.responseTooLarge)
      }
      eventCount += 1
      do {
        emitted.append(contentsOf: try consume(block))
      } catch let error as BrokerOpenAIResponsesStreamError {
        throw fail(error)
      } catch {
        throw fail(.invalidStream)
      }
      consumedOffset = boundary.end
      searchOffset = boundary.end
    }
    if consumedOffset > 0 {
      let consumedEnd = buffer.index(buffer.startIndex, offsetBy: consumedOffset)
      buffer.removeSubrange(buffer.startIndex..<consumedEnd)
    }
    boundaryScanOffset = max(0, buffer.count - 3)
    guard buffer.count <= Self.maximumEventByteCount else { throw fail(.responseTooLarge) }
    return emitted
  }

  mutating func finish() throws -> BrokerOpenAIResponsesCompletion {
    guard !failed, buffer.isEmpty, let terminal else { throw fail(.invalidStream) }
    return terminal
  }

  private mutating func consume(_ block: Data) throws -> [BrokerOpenAIResponsesEvent] {
    guard terminal == nil, let text = String(data: block, encoding: .utf8) else {
      throw fail(.invalidStream)
    }
    let normalized = text.replacingOccurrences(of: "\r\n", with: "\n")
    guard !normalized.contains("\r") else { throw fail(.invalidStream) }
    let lines = normalized.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    guard lines.count == 2, lines[0].hasPrefix("event: "), lines[1].hasPrefix("data: ") else {
      throw fail(.invalidStream)
    }
    let eventName = String(lines[0].dropFirst(7))
    let payload = String(lines[1].dropFirst(6))
    guard !eventName.isEmpty, payload != "[DONE]" else { throw fail(.invalidStream) }

    let object: [String: Any]
    do {
      object = try BrokerStrictJSON.object(
        from: Data(payload.utf8),
        maximumByteCount: Self.maximumEventByteCount
      )
    } catch {
      throw fail(.invalidStream)
    }
    guard string(object, "type") == eventName,
      let sequence = integer(object, "sequence_number"), sequence >= 0
    else { throw fail(.invalidStream) }
    if let lastSequenceNumber {
      let (expected, overflowed) = lastSequenceNumber.addingReportingOverflow(1)
      guard !overflowed, sequence == expected else { throw fail(.invalidStream) }
    }
    lastSequenceNumber = sequence

    switch eventName {
    case "response.created":
      return try consumeCreated(object)
    case "response.queued":
      return try consumeQueued(object)
    case "response.in_progress":
      return try consumeInProgress(object)
    case "response.output_item.added":
      return try consumeItemAdded(object)
    case "response.content_part.added":
      return try consumePart(object, indexKey: "content_index", itemKind: .message, done: false)
    case "response.output_text.delta":
      return try consumePartDelta(
        object,
        indexKey: "content_index",
        partKind: .outputText,
        event: BrokerOpenAIResponsesEvent.textDelta
      )
    case "response.output_text.done":
      return try consumePartValueDone(
        object,
        indexKey: "content_index",
        partKind: .outputText,
        valueKey: "text"
      )
    case "response.refusal.delta":
      return try consumePartDelta(
        object,
        indexKey: "content_index",
        partKind: .refusal,
        event: BrokerOpenAIResponsesEvent.refusalDelta
      )
    case "response.refusal.done":
      return try consumePartValueDone(
        object,
        indexKey: "content_index",
        partKind: .refusal,
        valueKey: "refusal"
      )
    case "response.content_part.done":
      return try consumePart(object, indexKey: "content_index", itemKind: .message, done: true)
    case "response.function_call_arguments.delta":
      return try consumeFunctionDelta(object)
    case "response.function_call_arguments.done":
      return try consumeFunctionDone(object)
    case "response.reasoning_summary_part.added":
      return try consumePart(object, indexKey: "summary_index", itemKind: .reasoning, done: false)
    case "response.reasoning_summary_text.delta":
      return try consumePartDelta(
        object,
        indexKey: "summary_index",
        partKind: .summaryText,
        event: BrokerOpenAIResponsesEvent.reasoningDelta
      )
    case "response.reasoning_summary_text.done":
      return try consumePartValueDone(
        object,
        indexKey: "summary_index",
        partKind: .summaryText,
        valueKey: "text"
      )
    case "response.reasoning_summary_part.done":
      return try consumePart(object, indexKey: "summary_index", itemKind: .reasoning, done: true)
    case "response.output_item.done":
      return try consumeItemDone(object)
    case "response.completed":
      return try consumeTerminal(object, status: "completed")
    case "response.incomplete":
      return try consumeTerminal(object, status: "incomplete")
    case "response.failed", "error":
      throw fail(.providerFailure)
    default:
      throw fail(.invalidStream)
    }
  }

  private mutating func consumeCreated(
    _ event: [String: Any]
  ) throws -> [BrokerOpenAIResponsesEvent] {
    guard responseID == nil, let response = dictionary(event, "response"),
      let id = string(response, "id"), validIdentifier(id, maximumByteCount: 256),
      let status = string(response, "status"), emptyArray(response, "output")
    else { throw fail(.invalidStream) }
    switch status {
    case "queued": lifecycle = .queued
    case "in_progress": lifecycle = .inProgress
    default: throw fail(.invalidStream)
    }
    responseID = id
    return []
  }

  private mutating func consumeQueued(
    _ event: [String: Any]
  ) throws -> [BrokerOpenAIResponsesEvent] {
    guard lifecycle == .queued, !sawQueuedEvent, items.isEmpty,
      let response = dictionary(event, "response"),
      validResponseIdentity(response, status: "queued"), emptyArray(response, "output")
    else { throw fail(.invalidStream) }
    sawQueuedEvent = true
    return []
  }

  private mutating func consumeInProgress(
    _ event: [String: Any]
  ) throws -> [BrokerOpenAIResponsesEvent] {
    guard responseID != nil, !sawInProgressEvent, items.isEmpty,
      let response = dictionary(event, "response"),
      validResponseIdentity(response, status: "in_progress"), emptyArray(response, "output")
    else { throw fail(.invalidStream) }
    lifecycle = .inProgress
    sawInProgressEvent = true
    return []
  }

  private mutating func consumeItemAdded(
    _ event: [String: Any]
  ) throws -> [BrokerOpenAIResponsesEvent] {
    guard lifecycle == .inProgress, let index = integer(event, "output_index"),
      index == items.count, index < Self.maximumOutputItemCount,
      let item = dictionary(event, "item"),
      let id = string(item, "id"), validIdentifier(id, maximumByteCount: 256),
      !items.contains(where: { $0.id == id }), string(item, "status") == "in_progress",
      let type = string(item, "type"), let kind = ItemKind(rawValue: type)
    else { throw fail(.invalidStream) }

    var state = ItemState(id: id, kind: kind)
    switch kind {
    case .message:
      guard string(item, "role") == "assistant", emptyArray(item, "content") else {
        throw fail(.invalidStream)
      }
    case .functionCall:
      guard let callID = string(item, "call_id"),
        validIdentifier(callID, maximumByteCount: 256),
        !items.contains(where: { $0.callID == callID }),
        let name = string(item, "name"), BrokerOpenAIResponsesFunctionTool.validName(name),
        string(item, "arguments") == "",
        items.lazy.filter({ $0.kind == .functionCall }).count < Self.maximumToolCallCount
      else { throw fail(.invalidStream) }
      state.callID = callID
      state.name = name
    case .reasoning:
      guard emptyArray(item, "summary") else { throw fail(.invalidStream) }
    }
    items.append(state)
    return []
  }

  private mutating func consumePart(
    _ event: [String: Any],
    indexKey: String,
    itemKind: ItemKind,
    done: Bool
  ) throws -> [BrokerOpenAIResponsesEvent] {
    let itemIndex = try correlatedIndex(event)
    guard items[itemIndex].kind == itemKind, let partIndex = integer(event, indexKey),
      let part = dictionary(event, "part"), let rawType = string(part, "type"),
      let partKind = PartKind(rawValue: rawType),
      itemKind == .message ? partKind != .summaryText : partKind == .summaryText,
      let value = string(part, partKind.valueKey)
    else { throw fail(.invalidStream) }

    if done {
      guard items[itemIndex].parts.indices.contains(partIndex),
        items[itemIndex].parts[partIndex].kind == partKind,
        items[itemIndex].parts[partIndex].valueDone,
        !items[itemIndex].parts[partIndex].partDone,
        items[itemIndex].parts[partIndex].value == value
      else { throw fail(.invalidStream) }
      items[itemIndex].parts[partIndex].partDone = true
      return []
    }

    guard partIndex == items[itemIndex].parts.count, value.isEmpty,
      partIndex < Self.maximumPartCountPerItem, totalPartCount < Self.maximumTotalPartCount
    else { throw fail(.responseTooLarge) }
    items[itemIndex].parts.append(PartState(kind: partKind))
    totalPartCount += 1
    return []
  }

  private mutating func consumePartDelta(
    _ event: [String: Any],
    indexKey: String,
    partKind: PartKind,
    event makeEvent: (String) -> BrokerOpenAIResponsesEvent
  ) throws -> [BrokerOpenAIResponsesEvent] {
    let (itemIndex, partIndex) = try correlatedPart(event, indexKey: indexKey, kind: partKind)
    guard !items[itemIndex].parts[partIndex].valueDone,
      !items[itemIndex].parts[partIndex].partDone,
      let delta = string(event, "delta")
    else { throw fail(.invalidStream) }
    try append(delta, toItem: itemIndex, part: partIndex)
    return [makeEvent(delta)]
  }

  private mutating func consumePartValueDone(
    _ event: [String: Any],
    indexKey: String,
    partKind: PartKind,
    valueKey: String
  ) throws -> [BrokerOpenAIResponsesEvent] {
    let (itemIndex, partIndex) = try correlatedPart(event, indexKey: indexKey, kind: partKind)
    guard !items[itemIndex].parts[partIndex].valueDone,
      !items[itemIndex].parts[partIndex].partDone,
      string(event, valueKey) == items[itemIndex].parts[partIndex].value
    else { throw fail(.invalidStream) }
    items[itemIndex].parts[partIndex].valueDone = true
    return []
  }

  private mutating func consumeFunctionDelta(
    _ event: [String: Any]
  ) throws -> [BrokerOpenAIResponsesEvent] {
    let index = try correlatedIndex(event)
    guard items[index].kind == .functionCall, !items[index].functionDone,
      let delta = string(event, "delta")
    else { throw fail(.invalidStream) }
    let (next, overflowed) = items[index].functionByteCount.addingReportingOverflow(
      delta.utf8.count
    )
    guard !overflowed, next <= Self.maximumAccumulatedValueByteCount else {
      throw fail(.responseTooLarge)
    }
    items[index].functionValue += delta
    items[index].functionByteCount = next
    return []
  }

  private mutating func consumeFunctionDone(
    _ event: [String: Any]
  ) throws -> [BrokerOpenAIResponsesEvent] {
    let index = try correlatedIndex(event)
    guard items[index].kind == .functionCall, !items[index].functionDone,
      string(event, "name") == items[index].name,
      string(event, "arguments") == items[index].functionValue
    else { throw fail(.invalidStream) }
    try requireJSONObject(items[index].functionValue)
    items[index].functionDone = true
    return []
  }

  private mutating func consumeItemDone(
    _ event: [String: Any]
  ) throws -> [BrokerOpenAIResponsesEvent] {
    guard let index = integer(event, "output_index"), items.indices.contains(index),
      items[index].doneItem == nil, let item = dictionary(event, "item"),
      let status = string(item, "status"), ["completed", "incomplete"].contains(status),
      status == "incomplete" || isComplete(items[index]),
      matches(item, state: items[index], status: status)
    else { throw fail(.invalidStream) }
    items[index].doneItem = item
    return []
  }

  private mutating func consumeTerminal(
    _ event: [String: Any],
    status: String
  ) throws -> [BrokerOpenAIResponsesEvent] {
    guard lifecycle == .inProgress, let response = dictionary(event, "response"),
      validResponseIdentity(response, status: status), let id = responseID
    else { throw fail(.invalidStream) }

    let stopReason: BrokerOpenAIResponsesStopReason
    if status == "completed" {
      stopReason = items.contains(where: { $0.kind == .functionCall }) ? .toolCalls : .complete
    } else {
      guard let details = dictionary(response, "incomplete_details"),
        let reason = string(details, "reason")
      else { throw fail(.invalidStream) }
      switch reason {
      case "max_output_tokens": stopReason = .maxOutputTokens
      case "content_filter": throw fail(.contentFiltered)
      default: throw fail(.invalidStream)
      }
    }

    guard let output = response["output"] as? [[String: Any]], output.count == items.count else {
      throw fail(.invalidStream)
    }
    for (item, state) in zip(output, items) {
      if let doneItem = state.doneItem {
        guard NSDictionary(dictionary: item).isEqual(to: doneItem),
          status == "incomplete" || string(doneItem, "status") == "completed"
        else {
          throw fail(.invalidStream)
        }
      } else {
        guard status == "incomplete", matches(item, state: state, status: "incomplete") else {
          throw fail(.invalidStream)
        }
      }
    }
    if status == "completed", items.contains(where: { $0.doneItem == nil }) {
      throw fail(.invalidStream)
    }

    let usage: BrokerOpenAIResponsesUsage?
    if response["usage"] == nil || response["usage"] is NSNull {
      usage = nil
    } else {
      guard let parsed = parseUsage(response) else { throw fail(.invalidStream) }
      usage = parsed
    }

    var replayItems: [BrokerOpenAIResponsesPrivateOutput] = []
    for (item, state) in zip(output, items) {
      let shouldReplay =
        string(item, "status") == "completed"
        || (state.kind != .functionCall && isNonempty(item))
      guard shouldReplay else { continue }
      do {
        let encoded = try JSONSerialization.data(
          withJSONObject: item,
          options: [.sortedKeys, .withoutEscapingSlashes]
        )
        replayItems.append(try BrokerOpenAIResponsesPrivateOutput(decoderItemJSON: encoded))
      } catch {
        throw fail(.invalidStream)
      }
    }

    let refusal = output.compactMap(refusalText).joined()
    let hasRefusal = output.contains { refusalText($0) != nil }
    let outcome: BrokerOpenAIResponsesOutcome = hasRefusal ? .refusal(refusal) : .output
    let completion = BrokerOpenAIResponsesCompletion(
      responseID: id,
      outputItems: replayItems,
      usage: usage,
      stopReason: stopReason,
      outcome: outcome
    )
    terminal = completion

    var emitted = items.compactMap { state -> BrokerOpenAIResponsesToolCall? in
      guard state.kind == .functionCall, let doneItem = state.doneItem,
        string(doneItem, "status") == "completed",
        let callID = state.callID, let name = state.name
      else { return nil }
      return BrokerOpenAIResponsesToolCall(
        callID: callID,
        name: name,
        argumentsJSON: Data(state.functionValue.utf8)
      )
    }.map(BrokerOpenAIResponsesEvent.toolCall)
    if let usage { emitted.append(.usage(usage)) }
    emitted.append(.done(stopReason))
    return emitted
  }

  private func matches(
    _ item: [String: Any],
    state: ItemState,
    status: String
  ) -> Bool {
    guard string(item, "id") == state.id, string(item, "type") == state.kind.rawValue,
      string(item, "status") == status
    else { return false }
    switch state.kind {
    case .message:
      guard string(item, "role") == "assistant", let content = item["content"] as? [[String: Any]]
      else { return false }
      return matches(content, parts: state.parts)
    case .functionCall:
      return string(item, "call_id") == state.callID && string(item, "name") == state.name
        && string(item, "arguments") == state.functionValue
    case .reasoning:
      guard let summary = item["summary"] as? [[String: Any]] else { return false }
      return matches(summary, parts: state.parts)
    }
  }

  private func matches(_ objects: [[String: Any]], parts: [PartState]) -> Bool {
    guard objects.count == parts.count else { return false }
    return zip(objects, parts).allSatisfy { object, part in
      string(object, "type") == part.kind.rawValue
        && string(object, part.kind.valueKey) == part.value
    }
  }

  private func isComplete(_ state: ItemState) -> Bool {
    switch state.kind {
    case .functionCall:
      state.functionDone
    case .message, .reasoning:
      state.parts.allSatisfy { $0.valueDone && $0.partDone }
    }
  }

  private func isNonempty(_ item: [String: Any]) -> Bool {
    if let content = item["content"] as? [[String: Any]],
      content.contains(where: {
        ($0["text"] as? String)?.isEmpty == false || ($0["refusal"] as? String)?.isEmpty == false
      })
    {
      return true
    }
    if let summary = item["summary"] as? [[String: Any]],
      summary.contains(where: { ($0["text"] as? String)?.isEmpty == false })
    {
      return true
    }
    return (item["encrypted_content"] as? String)?.isEmpty == false
  }

  private func refusalText(_ item: [String: Any]) -> String? {
    guard let content = item["content"] as? [[String: Any]] else { return nil }
    let refusals = content.compactMap { part -> String? in
      guard string(part, "type") == PartKind.refusal.rawValue else { return nil }
      return string(part, "refusal")
    }
    return refusals.isEmpty ? nil : refusals.joined()
  }

  private func validResponseIdentity(_ response: [String: Any], status: String) -> Bool {
    string(response, "id") == responseID && string(response, "status") == status
  }

  private func correlatedIndex(_ event: [String: Any]) throws -> Int {
    guard let index = integer(event, "output_index"), items.indices.contains(index),
      string(event, "item_id") == items[index].id, items[index].doneItem == nil
    else { throw BrokerOpenAIResponsesStreamError.invalidStream }
    return index
  }

  private func correlatedPart(
    _ event: [String: Any],
    indexKey: String,
    kind: PartKind
  ) throws -> (Int, Int) {
    let itemIndex = try correlatedIndex(event)
    guard let partIndex = integer(event, indexKey),
      items[itemIndex].parts.indices.contains(partIndex),
      items[itemIndex].parts[partIndex].kind == kind
    else { throw BrokerOpenAIResponsesStreamError.invalidStream }
    return (itemIndex, partIndex)
  }

  private mutating func append(_ value: String, toItem itemIndex: Int, part partIndex: Int) throws {
    let (next, overflowed) = items[itemIndex].parts[partIndex].byteCount.addingReportingOverflow(
      value.utf8.count
    )
    guard !overflowed, next <= Self.maximumAccumulatedValueByteCount else {
      throw fail(.responseTooLarge)
    }
    items[itemIndex].parts[partIndex].value += value
    items[itemIndex].parts[partIndex].byteCount = next
  }

  private func requireJSONObject(_ value: String) throws {
    do {
      _ = try BrokerStrictJSON.object(
        from: Data(value.utf8),
        maximumByteCount: Self.maximumAccumulatedValueByteCount
      )
    } catch {
      throw BrokerOpenAIResponsesStreamError.invalidStream
    }
  }

  private func parseUsage(_ response: [String: Any]) -> BrokerOpenAIResponsesUsage? {
    guard let usage = dictionary(response, "usage"),
      let input = nonnegativeInteger(usage, "input_tokens"),
      let output = nonnegativeInteger(usage, "output_tokens"),
      let total = nonnegativeInteger(usage, "total_tokens"),
      let inputDetails = dictionary(usage, "input_tokens_details"),
      let cached = nonnegativeInteger(inputDetails, "cached_tokens"), cached <= input,
      let outputDetails = dictionary(usage, "output_tokens_details"),
      let reasoning = nonnegativeInteger(outputDetails, "reasoning_tokens"), reasoning <= output
    else { return nil }
    let (expectedTotal, totalOverflowed) = input.addingReportingOverflow(output)
    guard !totalOverflowed, total == expectedTotal else { return nil }

    let cacheWrite: Int?
    if inputDetails["cache_write_tokens"] == nil {
      cacheWrite = nil
    } else {
      guard let parsed = nonnegativeInteger(inputDetails, "cache_write_tokens"), parsed <= input
      else {
        return nil
      }
      let (cachedTotal, cacheOverflowed) = cached.addingReportingOverflow(parsed)
      guard !cacheOverflowed, cachedTotal <= input else { return nil }
      cacheWrite = parsed
    }
    return BrokerOpenAIResponsesUsage(
      inputTokens: input,
      outputTokens: output,
      totalTokens: total,
      cachedInputTokens: cached,
      cacheWriteTokens: cacheWrite,
      reasoningTokens: reasoning
    )
  }

  private mutating func fail(
    _ error: BrokerOpenAIResponsesStreamError
  ) -> BrokerOpenAIResponsesStreamError {
    failed = true
    buffer.removeAll(keepingCapacity: false)
    return error
  }

  private static func nextBoundary(
    in data: Data,
    from suppliedOffset: Int
  ) -> (start: Int, end: Int)? {
    guard data.count >= 2 else { return nil }
    let offset = max(0, min(suppliedOffset, data.count - 1))
    return data.withUnsafeBytes { rawBuffer in
      let bytes = rawBuffer.bindMemory(to: UInt8.self)
      for index in offset..<(bytes.count - 1) {
        if bytes[index] == 0x0a, bytes[index + 1] == 0x0a {
          return (index, index + 2)
        }
        if index + 3 < bytes.count, bytes[index] == 0x0d, bytes[index + 1] == 0x0a,
          bytes[index + 2] == 0x0d, bytes[index + 3] == 0x0a
        {
          return (index, index + 4)
        }
      }
      return nil
    }
  }
}

private func dictionary(_ object: [String: Any], _ key: String) -> [String: Any]? {
  object[key] as? [String: Any]
}

private func string(_ object: [String: Any], _ key: String) -> String? {
  object[key] as? String
}

private func integer(_ object: [String: Any], _ key: String) -> Int? {
  guard let number = object[key] as? NSNumber,
    CFGetTypeID(number) != CFBooleanGetTypeID(),
    let value = Int(number.stringValue)
  else { return nil }
  return value
}

private func nonnegativeInteger(_ object: [String: Any], _ key: String) -> Int? {
  guard let value = integer(object, key), value >= 0 else { return nil }
  return value
}

private func emptyArray(_ object: [String: Any], _ key: String) -> Bool {
  guard let value = object[key] as? [Any] else { return false }
  return value.isEmpty
}

private func validIdentifier(_ value: String, maximumByteCount: Int) -> Bool {
  (1...maximumByteCount).contains(value.utf8.count)
    && value.unicodeScalars.allSatisfy { $0.value >= 0x21 && $0.value <= 0x7e }
}
