import Foundation

enum BrokerOpenAIResponsesRequestError:
  Error, Sendable, Equatable, CustomStringConvertible, LocalizedError
{
  case invalidRequest
  case invalidJSON
  case requestTooLarge

  private var fixedDescription: String {
    switch self {
    case .invalidRequest:
      "The OpenAI Responses request is invalid."
    case .invalidJSON:
      "The OpenAI Responses request contains invalid JSON."
    case .requestTooLarge:
      "The OpenAI Responses request exceeded its size limit."
    }
  }

  var description: String { fixedDescription }
  var errorDescription: String? { fixedDescription }
}

enum BrokerOpenAIResponsesMessageRole: String, Sendable, Equatable {
  case developer
  case system
  case user
  case assistant
}

struct BrokerOpenAIResponsesPrivateOutput: Sendable, Equatable {
  fileprivate let encodedItem: Data

  var encodedByteCount: Int { encodedItem.count }
  var encodedItemCopy: Data { encodedItem }

  init(decoderItemJSON: Data) throws {
    let decoded = try BrokerStrictJSON.object(
      from: decoderItemJSON,
      maximumByteCount: BrokerOpenAIResponsesRequest.maximumTextByteCount
    )
    guard let item = Self.canonicalReplayItem(decoded) else {
      throw BrokerOpenAIResponsesRequestError.invalidRequest
    }
    do {
      encodedItem = try JSONSerialization.data(
        withJSONObject: item,
        options: [.sortedKeys, .withoutEscapingSlashes]
      )
    } catch {
      throw BrokerOpenAIResponsesRequestError.invalidJSON
    }
  }

  func decodedObject() throws -> [String: Any] {
    try BrokerStrictJSON.object(
      from: encodedItem,
      maximumByteCount: BrokerOpenAIResponsesRequest.maximumTextByteCount
    )
  }

  private static func canonicalReplayItem(_ item: [String: Any]) -> [String: Any]? {
    guard let id = item["id"] as? String, validIdentifier(id),
      let status = item["status"] as? String, ["completed", "incomplete"].contains(status),
      let type = item["type"] as? String
    else { return nil }
    var canonical: [String: Any] = ["id": id, "status": status, "type": type]
    switch type {
    case "message":
      guard item["role"] as? String == "assistant",
        let content = item["content"] as? [[String: Any]], (1...128).contains(content.count)
      else { return nil }
      var byteCount = 0
      var canonicalContent: [[String: Any]] = []
      for part in content {
        let text: String
        switch part["type"] as? String {
        case "output_text":
          guard let value = part["text"] as? String else { return nil }
          text = value
          canonicalContent.append([
            "annotations": [], "text": value, "type": "output_text",
          ])
        case "refusal":
          guard let value = part["refusal"] as? String else { return nil }
          text = value
          canonicalContent.append(["refusal": value, "type": "refusal"])
        default:
          return nil
        }
        let (next, overflowed) = byteCount.addingReportingOverflow(text.utf8.count)
        guard !overflowed, next <= BrokerOpenAIResponsesRequest.maximumTextByteCount else {
          return nil
        }
        byteCount = next
      }
      guard status == "completed" || byteCount > 0 else { return nil }
      canonical["role"] = "assistant"
      canonical["content"] = canonicalContent
      if let phase = item["phase"], !(phase is NSNull) {
        guard let phase = phase as? String, ["commentary", "final_answer"].contains(phase) else {
          return nil
        }
        canonical["phase"] = phase
      }
    case "function_call":
      guard status == "completed", let callID = item["call_id"] as? String,
        validIdentifier(callID),
        let name = item["name"] as? String,
        BrokerOpenAIResponsesFunctionTool.validName(name),
        let arguments = item["arguments"] as? String
      else { return nil }
      guard
        (try? BrokerStrictJSON.object(
          from: Data(arguments.utf8),
          maximumByteCount: BrokerOpenAIResponsesRequest.maximumTextByteCount
        )) != nil
      else { return nil }
      canonical["arguments"] = arguments
      canonical["call_id"] = callID
      canonical["name"] = name
    case "reasoning":
      guard let summary = item["summary"] as? [[String: Any]], summary.count <= 128 else {
        return nil
      }
      var byteCount = 0
      var canonicalSummary: [[String: Any]] = []
      for part in summary {
        guard part["type"] as? String == "summary_text", let text = part["text"] as? String else {
          return nil
        }
        let (next, overflowed) = byteCount.addingReportingOverflow(text.utf8.count)
        guard !overflowed, next <= BrokerOpenAIResponsesRequest.maximumTextByteCount else {
          return nil
        }
        byteCount = next
        canonicalSummary.append(["text": text, "type": "summary_text"])
      }
      var isNonempty = byteCount > 0
      guard let encrypted = item["encrypted_content"] else {
        guard status == "completed" || isNonempty else { return nil }
        canonical["summary"] = canonicalSummary
        return canonical
      }
      if encrypted is NSNull {
        canonical["encrypted_content"] = NSNull()
      } else {
        guard let encrypted = encrypted as? String,
          encrypted.utf8.count <= BrokerOpenAIResponsesRequest.maximumTextByteCount
        else { return nil }
        canonical["encrypted_content"] = encrypted
        isNonempty = isNonempty || !encrypted.isEmpty
      }
      guard status == "completed" || isNonempty else { return nil }
      canonical["summary"] = canonicalSummary
    default:
      return nil
    }
    return canonical
  }

  private static func validIdentifier(_ value: String) -> Bool {
    (1...256).contains(value.utf8.count)
      && value.unicodeScalars.allSatisfy { $0.value >= 0x21 && $0.value <= 0x7e }
  }
}

enum BrokerOpenAIResponsesInputItem: Sendable, Equatable {
  case message(role: BrokerOpenAIResponsesMessageRole, text: String)
  case image(mediaType: String, data: Data)
  case functionCall(callID: String, name: String, argumentsJSON: Data)
  case functionCallOutput(callID: String, output: String)
  case privateOutput(BrokerOpenAIResponsesPrivateOutput)
}

struct BrokerOpenAIResponsesFunctionTool: Sendable, Equatable {
  static let maximumSchemaByteCount = 65_536

  let name: String
  let description: String
  let parametersJSON: Data

  init(name: String, description: String, parametersJSON: Data) throws {
    guard Self.validName(name), description.utf8.count <= 1_024 else {
      throw BrokerOpenAIResponsesRequestError.invalidRequest
    }
    let parameters = try BrokerStrictJSON.object(
      from: parametersJSON,
      maximumByteCount: Self.maximumSchemaByteCount
    )
    self.name = name
    self.description = description
    do {
      self.parametersJSON = try JSONSerialization.data(
        withJSONObject: parameters,
        options: [.sortedKeys, .withoutEscapingSlashes]
      )
    } catch {
      throw BrokerOpenAIResponsesRequestError.invalidJSON
    }
  }

  static func validName(_ value: String) -> Bool {
    guard (1...64).contains(value.utf8.count) else { return false }
    return value.utf8.allSatisfy {
      (0x30...0x39).contains($0) || (0x41...0x5a).contains($0)
        || (0x61...0x7a).contains($0) || $0 == 0x5f || $0 == 0x2d
    }
  }
}

struct BrokerOpenAIResponsesRequest: Sendable, Equatable {
  static let maximumOutputTokenCount = 8_192
  static let maximumBodyByteCount = 8 * 1_024 * 1_024
  static let maximumInputItemCount = 1_024
  static let maximumToolCount = 128
  static let maximumTextByteCount = 1_048_576

  let model: String
  let input: [BrokerOpenAIResponsesInputItem]
  let tools: [BrokerOpenAIResponsesFunctionTool]
  let maxOutputTokens: Int

  init(
    model: String,
    input: [BrokerOpenAIResponsesInputItem],
    tools: [BrokerOpenAIResponsesFunctionTool],
    maxOutputTokens: Int
  ) throws {
    guard Self.validModel(model), (1...Self.maximumInputItemCount).contains(input.count),
      tools.count <= Self.maximumToolCount,
      Set(tools.map(\.name)).count == tools.count,
      (1...Self.maximumOutputTokenCount).contains(maxOutputTokens)
    else {
      throw BrokerOpenAIResponsesRequestError.invalidRequest
    }
    var functionCallIDs = Set<String>()
    var functionOutputIDs = Set<String>()
    var acceptsImage = false
    var budget = BodyBudget(maximumByteCount: Self.maximumBodyByteCount)
    try budget.add(overhead: 1_024)
    try budget.add(jsonString: model)
    for item in input {
      try Self.validate(item)
      try budget.add(item)
      switch item {
      case .message(let role, _):
        acceptsImage = role == .user
      case .image:
        guard acceptsImage else {
          throw BrokerOpenAIResponsesRequestError.invalidRequest
        }
      case .functionCall(let callID, _, _):
        acceptsImage = false
        guard functionCallIDs.insert(callID).inserted else {
          throw BrokerOpenAIResponsesRequestError.invalidRequest
        }
      case .functionCallOutput(let callID, _):
        acceptsImage = false
        guard functionOutputIDs.insert(callID).inserted else {
          throw BrokerOpenAIResponsesRequestError.invalidRequest
        }
      case .privateOutput(let output):
        acceptsImage = false
        let object = try output.decodedObject()
        if object["type"] as? String == "function_call" {
          guard let callID = object["call_id"] as? String,
            functionCallIDs.insert(callID).inserted
          else { throw BrokerOpenAIResponsesRequestError.invalidRequest }
        }
      }
    }
    guard functionCallIDs == functionOutputIDs else {
      throw BrokerOpenAIResponsesRequestError.invalidRequest
    }
    for tool in tools {
      try budget.add(tool)
    }
    self.model = model
    self.input = input
    self.tools = tools
    self.maxOutputTokens = maxOutputTokens
  }

  func encodedBody() throws -> Data {
    let encodedInput = try Self.encodeInput(input)
    let encodedTools = try tools.map { tool -> [String: Any] in
      [
        "type": "function",
        "name": tool.name,
        "description": tool.description,
        "parameters": try BrokerStrictJSON.object(
          from: tool.parametersJSON,
          maximumByteCount: BrokerOpenAIResponsesFunctionTool.maximumSchemaByteCount
        ),
      ]
    }
    let object: [String: Any] = [
      "model": model,
      "input": encodedInput,
      "tools": encodedTools,
      "tool_choice": "auto",
      "parallel_tool_calls": true,
      "stream": true,
      "store": false,
      "include": ["reasoning.encrypted_content"],
      "max_output_tokens": maxOutputTokens,
    ]
    guard JSONSerialization.isValidJSONObject(object) else {
      throw BrokerOpenAIResponsesRequestError.invalidJSON
    }
    let data: Data
    do {
      data = try JSONSerialization.data(
        withJSONObject: object,
        options: [.sortedKeys, .withoutEscapingSlashes]
      )
    } catch {
      throw BrokerOpenAIResponsesRequestError.invalidJSON
    }
    guard data.count <= Self.maximumBodyByteCount else {
      throw BrokerOpenAIResponsesRequestError.requestTooLarge
    }
    return data
  }

  private static func validModel(_ value: String) -> Bool {
    guard (1...256).contains(value.utf8.count), value == value.trimmingCharacters(in: .whitespaces)
    else { return false }
    return value.unicodeScalars.allSatisfy { $0.value >= 0x21 && $0.value <= 0x7e }
  }

  private static func validate(_ item: BrokerOpenAIResponsesInputItem) throws {
    switch item {
    case .message(_, let text), .functionCallOutput(_, let text):
      guard text.utf8.count <= maximumTextByteCount else {
        throw BrokerOpenAIResponsesRequestError.requestTooLarge
      }
      if case .functionCallOutput(let callID, _) = item {
        try validateIdentifier(callID, maximumByteCount: 256)
      }
    case .functionCall(let callID, let name, let argumentsJSON):
      try validateIdentifier(callID, maximumByteCount: 256)
      guard BrokerOpenAIResponsesFunctionTool.validName(name) else {
        throw BrokerOpenAIResponsesRequestError.invalidRequest
      }
      _ = try BrokerStrictJSON.object(
        from: argumentsJSON,
        maximumByteCount: maximumTextByteCount
      )
    case .privateOutput(let output):
      _ = try output.decodedObject()
    case .image(let mediaType, let data):
      guard BrokerImageInput.valid(mediaType: mediaType, data: data)
      else { throw BrokerOpenAIResponsesRequestError.invalidRequest }
    }
  }

  private static func validateIdentifier(_ value: String, maximumByteCount: Int) throws {
    guard (1...maximumByteCount).contains(value.utf8.count),
      value.unicodeScalars.allSatisfy({ $0.value >= 0x21 && $0.value <= 0x7e })
    else {
      throw BrokerOpenAIResponsesRequestError.invalidRequest
    }
  }

  private static func encode(_ item: BrokerOpenAIResponsesInputItem) throws -> [String: Any] {
    switch item {
    case .message(let role, let text):
      ["type": "message", "role": role.rawValue, "content": text]
    case .functionCall(let callID, let name, let argumentsJSON):
      [
        "type": "function_call",
        "call_id": callID,
        "name": name,
        "arguments": String(decoding: argumentsJSON, as: UTF8.self),
      ]
    case .functionCallOutput(let callID, let output):
      ["type": "function_call_output", "call_id": callID, "output": output]
    case .privateOutput(let output):
      try output.decodedObject()
    case .image:
      throw BrokerOpenAIResponsesRequestError.invalidRequest
    }
  }

  private static func encodeInput(
    _ input: [BrokerOpenAIResponsesInputItem]
  ) throws -> [[String: Any]] {
    var encoded: [[String: Any]] = []
    for item in input {
      guard case .image(let mediaType, let data) = item else {
        encoded.append(try encode(item))
        continue
      }
      guard !encoded.isEmpty,
        encoded[encoded.count - 1]["type"] as? String == "message",
        encoded[encoded.count - 1]["role"] as? String == "user"
      else { throw BrokerOpenAIResponsesRequestError.invalidRequest }
      var message = encoded.removeLast()
      let image: [String: Any] = [
        "type": "input_image",
        "image_url": "data:\(mediaType);base64,\(data.base64EncodedString())",
      ]
      if let text = message["content"] as? String {
        message["content"] = [
          ["type": "input_text", "text": text],
          image,
        ]
      } else if var content = message["content"] as? [[String: Any]] {
        content.append(image)
        message["content"] = content
      } else {
        throw BrokerOpenAIResponsesRequestError.invalidRequest
      }
      encoded.append(message)
    }
    return encoded
  }

  private struct BodyBudget {
    private var remaining: Int

    init(maximumByteCount: Int) {
      remaining = maximumByteCount
    }

    mutating func add(_ item: BrokerOpenAIResponsesInputItem) throws {
      try add(overhead: 128)
      switch item {
      case .message(_, let text):
        try add(jsonString: text)
      case .image(let mediaType, let data):
        try add(jsonString: mediaType)
        try add(jsonString: data.base64EncodedString())
      case .functionCall(let callID, let name, let argumentsJSON):
        try add(jsonString: callID)
        try add(jsonString: name)
        try add(jsonString: String(decoding: argumentsJSON, as: UTF8.self))
      case .functionCallOutput(let callID, let output):
        try add(jsonString: callID)
        try add(jsonString: output)
      case .privateOutput(let output):
        try add(overhead: output.encodedItem.count)
      }
    }

    mutating func add(_ tool: BrokerOpenAIResponsesFunctionTool) throws {
      try add(overhead: 256)
      try add(jsonString: tool.name)
      try add(jsonString: tool.description)
      try add(overhead: tool.parametersJSON.count)
    }

    mutating func add(jsonString value: String) throws {
      try add(overhead: 2)
      for scalar in value.unicodeScalars {
        switch scalar.value {
        case 0x22, 0x5c:
          try add(overhead: 2)
        case 0x08, 0x09, 0x0a, 0x0c, 0x0d:
          try add(overhead: 2)
        case 0x00...0x1f:
          try add(overhead: 6)
        default:
          try add(overhead: scalar.utf8.count)
        }
      }
    }

    mutating func add(overhead: Int) throws {
      guard overhead >= 0, overhead <= remaining else {
        throw BrokerOpenAIResponsesRequestError.requestTooLarge
      }
      remaining -= overhead
    }
  }
}

enum BrokerStrictJSON {
  static func object(
    from data: Data,
    maximumByteCount: Int
  ) throws -> [String: Any] {
    guard !data.isEmpty, data.count <= maximumByteCount, String(data: data, encoding: .utf8) != nil
    else {
      throw BrokerOpenAIResponsesRequestError.invalidJSON
    }
    var parser = Parser(bytes: Array(data))
    guard parser.validate(),
      let object = try? JSONSerialization.jsonObject(with: data, options: []),
      let dictionary = object as? [String: Any]
    else {
      throw BrokerOpenAIResponsesRequestError.invalidJSON
    }
    return dictionary
  }

  private struct Parser {
    let bytes: [UInt8]
    var index = 0
    var valueCount = 0

    mutating func validate() -> Bool {
      skipWhitespace()
      guard parseValue(depth: 0) else { return false }
      skipWhitespace()
      return index == bytes.count
    }

    mutating func parseValue(depth: Int) -> Bool {
      guard depth <= 64, valueCount < 65_536, index < bytes.count else { return false }
      valueCount += 1
      switch bytes[index] {
      case 0x7b: return parseObject(depth: depth)
      case 0x5b: return parseArray(depth: depth)
      case 0x22: return parseString() != nil
      case 0x74: return consume("true")
      case 0x66: return consume("false")
      case 0x6e: return consume("null")
      case 0x2d, 0x30...0x39: return parseNumber()
      default: return false
      }
    }

    mutating func parseObject(depth: Int) -> Bool {
      index += 1
      skipWhitespace()
      if consumeByte(0x7d) { return true }
      var keys = Set<String>()
      while true {
        guard let key = parseString(), keys.insert(key).inserted else { return false }
        skipWhitespace()
        guard consumeByte(0x3a) else { return false }
        skipWhitespace()
        guard parseValue(depth: depth + 1) else { return false }
        skipWhitespace()
        if consumeByte(0x7d) { return true }
        guard consumeByte(0x2c) else { return false }
        skipWhitespace()
      }
    }

    mutating func parseArray(depth: Int) -> Bool {
      index += 1
      skipWhitespace()
      if consumeByte(0x5d) { return true }
      while true {
        guard parseValue(depth: depth + 1) else { return false }
        skipWhitespace()
        if consumeByte(0x5d) { return true }
        guard consumeByte(0x2c) else { return false }
        skipWhitespace()
      }
    }

    mutating func parseString() -> String? {
      guard consumeByte(0x22) else { return nil }
      let start = index - 1
      while index < bytes.count {
        let byte = bytes[index]
        index += 1
        if byte == 0x22 {
          let data = Data(bytes[start..<index])
          return (try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]))
            as? String
        }
        guard byte >= 0x20 else { return nil }
        if byte == 0x5c {
          guard index < bytes.count else { return nil }
          let escaped = bytes[index]
          index += 1
          if escaped == 0x75 {
            guard index + 4 <= bytes.count,
              bytes[index..<(index + 4)].allSatisfy(Self.isHexDigit)
            else { return nil }
            index += 4
          } else if ![0x22, 0x5c, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74].contains(escaped) {
            return nil
          }
        }
      }
      return nil
    }

    mutating func parseNumber() -> Bool {
      _ = consumeByte(0x2d)
      guard index < bytes.count else { return false }
      if consumeByte(0x30) {
        if index < bytes.count, (0x30...0x39).contains(bytes[index]) { return false }
      } else {
        guard consumeDigits(firstMustBeNonzero: true) else { return false }
      }
      if consumeByte(0x2e) {
        guard consumeDigits(firstMustBeNonzero: false) else { return false }
      }
      if index < bytes.count, bytes[index] == 0x65 || bytes[index] == 0x45 {
        index += 1
        if index < bytes.count, bytes[index] == 0x2b || bytes[index] == 0x2d { index += 1 }
        guard consumeDigits(firstMustBeNonzero: false) else { return false }
      }
      return true
    }

    mutating func consumeDigits(firstMustBeNonzero: Bool) -> Bool {
      guard index < bytes.count else { return false }
      if firstMustBeNonzero {
        guard (0x31...0x39).contains(bytes[index]) else { return false }
      } else {
        guard (0x30...0x39).contains(bytes[index]) else { return false }
      }
      index += 1
      while index < bytes.count, (0x30...0x39).contains(bytes[index]) { index += 1 }
      return true
    }

    mutating func skipWhitespace() {
      while index < bytes.count, [0x20, 0x09, 0x0a, 0x0d].contains(bytes[index]) { index += 1 }
    }

    mutating func consume(_ literal: StaticString) -> Bool {
      let expected = Array(String(describing: literal).utf8)
      guard index + expected.count <= bytes.count,
        bytes[index..<(index + expected.count)].elementsEqual(expected)
      else { return false }
      index += expected.count
      return true
    }

    mutating func consumeByte(_ byte: UInt8) -> Bool {
      guard index < bytes.count, bytes[index] == byte else { return false }
      index += 1
      return true
    }

    static func isHexDigit(_ byte: UInt8) -> Bool {
      (0x30...0x39).contains(byte) || (0x41...0x46).contains(byte)
        || (0x61...0x66).contains(byte)
    }
  }
}
