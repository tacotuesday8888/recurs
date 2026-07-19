import Foundation

enum BrokerAnthropicMessagesError: Error, Sendable, Equatable {
  case invalidRequest
  case requestTooLarge
  case invalidStream
  case responseTooLarge
  case authenticationRejected
  case rateLimited
  case providerUnavailable
  case requestRejected
  case contentFiltered
  case providerFailure
  case deliveryUncertain
}

enum BrokerAnthropicMessagesInput: Sendable, Equatable {
  case message(role: BrokerOpenAIResponsesMessageRole, text: String)
  case toolUse(callID: String, name: String, argumentsJSON: Data)
  case toolResult(callID: String, output: String)
}

struct BrokerAnthropicMessagesTool: Sendable, Equatable {
  let name: String
  let description: String
  let inputSchemaJSON: Data

  init(name: String, description: String, inputSchemaJSON: Data) throws {
    guard BrokerOpenAIResponsesFunctionTool.validName(name),
      description.utf8.count <= 1_024
    else { throw BrokerAnthropicMessagesError.invalidRequest }
    let schema: [String: Any]
    do {
      schema = try BrokerStrictJSON.object(
        from: inputSchemaJSON,
        maximumByteCount: BrokerOpenAIResponsesFunctionTool.maximumSchemaByteCount
      )
      self.inputSchemaJSON = try JSONSerialization.data(
        withJSONObject: schema,
        options: [.sortedKeys, .withoutEscapingSlashes]
      )
    } catch {
      throw BrokerAnthropicMessagesError.invalidRequest
    }
    self.name = name
    self.description = description
  }
}

struct BrokerAnthropicMessagesRequest: Sendable, Equatable {
  static let maximumBodyByteCount = 4 * 1_024 * 1_024
  static let maximumInputCount = 1_024
  static let maximumToolCount = 128

  let model: String
  let input: [BrokerAnthropicMessagesInput]
  let tools: [BrokerAnthropicMessagesTool]
  let maxOutputTokens: Int

  init(
    model: String,
    input: [BrokerAnthropicMessagesInput],
    tools: [BrokerAnthropicMessagesTool],
    maxOutputTokens: Int
  ) throws {
    guard Self.validIdentifier(model), (1...Self.maximumInputCount).contains(input.count),
      tools.count <= Self.maximumToolCount,
      (1...BrokerOpenAIResponsesRequest.maximumOutputTokenCount).contains(maxOutputTokens)
    else { throw BrokerAnthropicMessagesError.invalidRequest }
    self.model = model
    self.input = input
    self.tools = tools
    self.maxOutputTokens = maxOutputTokens
    _ = try encodedBody()
  }

  func encodedBody() throws(BrokerAnthropicMessagesError) -> Data {
    do {
      var system: [String] = []
      var messages: [[String: Any]] = []
      var sawConversation = false
      for item in input {
        switch item {
        case .message(.system, let text), .message(.developer, let text):
          guard !sawConversation, Self.validText(text) else {
            throw BrokerAnthropicMessagesError.invalidRequest
          }
          system.append(text)
        case .message(let role, let text):
          guard role == .user || role == .assistant, Self.validText(text) else {
            throw BrokerAnthropicMessagesError.invalidRequest
          }
          sawConversation = true
          try Self.append(
            role: role == .user ? "user" : "assistant",
            block: ["type": "text", "text": text],
            to: &messages
          )
        case .toolUse(let callID, let name, let argumentsJSON):
          guard Self.validIdentifier(callID), BrokerOpenAIResponsesFunctionTool.validName(name)
          else { throw BrokerAnthropicMessagesError.invalidRequest }
          let arguments = try BrokerStrictJSON.object(
            from: argumentsJSON,
            maximumByteCount: BrokerOpenAIResponsesRequest.maximumTextByteCount
          )
          sawConversation = true
          try Self.append(
            role: "assistant",
            block: ["type": "tool_use", "id": callID, "name": name, "input": arguments],
            to: &messages
          )
        case .toolResult(let callID, let output):
          guard Self.validIdentifier(callID), Self.validText(output) else {
            throw BrokerAnthropicMessagesError.invalidRequest
          }
          sawConversation = true
          if messages.last?["role"] as? String == "user" {
            guard let content = messages.last?["content"] as? [[String: Any]],
              content.allSatisfy({ $0["type"] as? String == "tool_result" })
            else { throw BrokerAnthropicMessagesError.invalidRequest }
          }
          try Self.append(
            role: "user",
            block: ["type": "tool_result", "tool_use_id": callID, "content": output],
            to: &messages
          )
        }
      }
      guard sawConversation, messages.first?["role"] as? String == "user" else {
        throw BrokerAnthropicMessagesError.invalidRequest
      }
      var body: [String: Any] = [
        "max_tokens": maxOutputTokens,
        "messages": messages,
        "model": model,
        "stream": true,
      ]
      if !system.isEmpty { body["system"] = system.joined(separator: "\n\n") }
      if !tools.isEmpty {
        body["tools"] = try tools.map { tool in
          [
            "name": tool.name,
            "description": tool.description,
            "input_schema": try BrokerStrictJSON.object(
              from: tool.inputSchemaJSON,
              maximumByteCount: BrokerOpenAIResponsesFunctionTool.maximumSchemaByteCount
            ),
          ] as [String: Any]
        }
      }
      let encoded = try JSONSerialization.data(
        withJSONObject: body,
        options: [.sortedKeys, .withoutEscapingSlashes]
      )
      guard encoded.count <= Self.maximumBodyByteCount else {
        throw BrokerAnthropicMessagesError.requestTooLarge
      }
      return encoded
    } catch let error as BrokerAnthropicMessagesError {
      throw error
    } catch {
      throw .invalidRequest
    }
  }

  private static func append(
    role: String,
    block: [String: Any],
    to messages: inout [[String: Any]]
  ) throws {
    if messages.last?["role"] as? String == role {
      guard var content = messages[messages.count - 1]["content"] as? [[String: Any]],
        content.count < maximumInputCount
      else { throw BrokerAnthropicMessagesError.invalidRequest }
      content.append(block)
      messages[messages.count - 1]["content"] = content
    } else {
      messages.append(["role": role, "content": [block]])
    }
  }

  private static func validIdentifier(_ value: String) -> Bool {
    (1...256).contains(value.utf8.count)
      && value.unicodeScalars.allSatisfy { $0.value >= 0x21 && $0.value <= 0x7e }
  }

  private static func validText(_ value: String) -> Bool {
    !value.isEmpty && value.utf8.count <= BrokerOpenAIResponsesRequest.maximumTextByteCount
  }
}
