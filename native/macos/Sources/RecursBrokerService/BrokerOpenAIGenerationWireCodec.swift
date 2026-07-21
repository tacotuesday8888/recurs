import CoreFoundation
import Foundation

enum BrokerOpenAIGenerationWireError: Error, Sendable, Equatable {
  case invalidMessage
}

struct BrokerOpenAIGenerationWireCodec: Sendable {
  private static let maximumRequestByteCount = 8 * 1_024 * 1_024 - 8
  private static let maximumEventByteCount = 1_048_576

  static func decodeRequest(
    _ data: Data
  ) throws(BrokerOpenAIGenerationWireError) -> BrokerOpenAIGenerationRequest {
    do {
      let object = try BrokerStrictJSON.object(
        from: data,
        maximumByteCount: maximumRequestByteCount
      )
      try exactKeys(
        object,
        [
          "format", "connectionId", "authorizationId", "sessionId", "turnId",
          "adapterId", "modelId", "backendFingerprint", "expectedSessionRecordSequence",
          "authorizationExpiresAt", "input", "tools", "maxOutputTokens",
        ])
      guard integer(object["format"]) == 1,
        let connectionText = object["connectionId"] as? String,
        connectionText == connectionText.lowercased(),
        let connectionID = UUID(uuidString: connectionText),
        connectionID.uuidString.lowercased() == connectionText,
        let authorizationID = object["authorizationId"] as? String,
        let sessionID = object["sessionId"] as? String,
        let turnID = object["turnId"] as? String,
        let adapterID = object["adapterId"] as? String,
        ["openai-responses", "anthropic-messages", "openai-chat-completions"].contains(adapterID),
        let modelID = object["modelId"] as? String,
        let backendFingerprint = object["backendFingerprint"] as? String,
        let sequence = unsignedInteger(object["expectedSessionRecordSequence"]),
        let expiresText = object["authorizationExpiresAt"] as? String,
        let expiresAt = date(expiresText),
        let rawInput = object["input"] as? [[String: Any]],
        (1...BrokerOpenAIResponsesRequest.maximumInputItemCount).contains(rawInput.count),
        let rawTools = object["tools"] as? [[String: Any]],
        rawTools.count <= BrokerOpenAIResponsesRequest.maximumToolCount,
        let maxOutputTokens = integer(object["maxOutputTokens"])
      else { throw BrokerOpenAIGenerationWireError.invalidMessage }

      let input = try rawInput.map(decodeInput)
      var imageBytes = 0
      var acceptsImage = false
      for item in input {
        switch item {
        case .message(let role, _):
          acceptsImage = role == .user
        case .image(_, let data):
          guard acceptsImage else { throw BrokerOpenAIGenerationWireError.invalidMessage }
          let (next, overflowed) = imageBytes.addingReportingOverflow(data.count)
          guard !overflowed, next <= BrokerImageInput.maximumTotalByteCount else {
            throw BrokerOpenAIGenerationWireError.invalidMessage
          }
          imageBytes = next
        default:
          acceptsImage = false
        }
      }
      let tools = try rawTools.map(decodeTool)
      for item in input {
        guard case .continuation(let handle) = item else { continue }
        guard handle.recursSessionID == sessionID,
          handle.connectionID == connectionText,
          handle.adapterID == adapterID,
          handle.modelID == modelID,
          handle.backendFingerprint == backendFingerprint
        else { throw BrokerOpenAIGenerationWireError.invalidMessage }
      }
      return BrokerOpenAIGenerationRequest(
        connectionID: connectionID,
        authorizationID: authorizationID,
        sessionID: sessionID,
        turnID: turnID,
        adapterID: adapterID,
        modelID: modelID,
        backendFingerprint: backendFingerprint,
        expectedSessionRecordSequence: sequence,
        authorizationExpiresAt: expiresAt,
        input: input,
        tools: tools,
        maxOutputTokens: maxOutputTokens
      )
    } catch {
      throw .invalidMessage
    }
  }

  func encode(
    _ event: BrokerOpenAIResponsesEvent
  ) throws(BrokerOpenAIGenerationWireError) -> Data {
    let object: [String: Any]
    do {
      switch event {
      case .textDelta(let text), .refusalDelta(let text):
        object = ["type": "text_delta", "text": text]
      case .reasoningDelta(let text):
        object = ["type": "reasoning_delta", "text": text]
      case .toolCall(let call):
        object = [
          "type": "tool_call",
          "call": [
            "id": call.callID,
            "name": call.name,
            "arguments": try BrokerStrictJSON.object(
              from: call.argumentsJSON,
              maximumByteCount: BrokerOpenAIResponsesStreamDecoder.maximumAccumulatedValueByteCount
            ),
          ],
        ]
      case .usage(let usage):
        var usageObject: [String: Any] = [
          "type": "usage",
          "inputTokens": usage.inputTokens,
          "outputTokens": usage.outputTokens,
        ]
        if let cached = usage.cachedInputTokens {
          usageObject["cachedInputTokens"] = cached
        }
        if let write = usage.cacheWriteTokens {
          usageObject["cacheWriteInputTokens"] = write
        }
        if let reasoning = usage.reasoningTokens {
          usageObject["reasoningTokens"] = reasoning
        }
        object = usageObject
      case .done(let reason):
        return try encodeDone(reason)
      }
      return try Self.encode(object)
    } catch {
      throw .invalidMessage
    }
  }

  func encodeProviderState(
    _ handle: BrokerDirectContinuationHandle
  ) throws(BrokerOpenAIGenerationWireError) -> Data {
    do {
      return try Self.encode([
        "type": "provider_state",
        "handle": Self.encode(handle),
      ])
    } catch {
      throw .invalidMessage
    }
  }

  func encodeDone(
    _ reason: BrokerOpenAIResponsesStopReason
  ) throws(BrokerOpenAIGenerationWireError) -> Data {
    do {
      let stopReason: String =
        switch reason {
        case .complete: "complete"
        case .toolCalls: "tool_calls"
        case .maxOutputTokens: "length"
        }
      return try Self.encode([
        "type": "done",
        "stopReason": stopReason,
      ])
    } catch {
      throw .invalidMessage
    }
  }

  private static func decodeInput(
    _ object: [String: Any]
  ) throws -> BrokerOpenAIGenerationInput {
    guard let kind = object["kind"] as? String else {
      throw BrokerOpenAIGenerationWireError.invalidMessage
    }
    switch kind {
    case "message":
      try exactKeys(object, ["kind", "role", "text"])
      guard let roleText = object["role"] as? String,
        let role = BrokerOpenAIResponsesMessageRole(rawValue: roleText),
        role != .developer,
        let text = object["text"] as? String
      else { throw BrokerOpenAIGenerationWireError.invalidMessage }
      return .message(role: role, text: text)
    case "image":
      try exactKeys(object, ["kind", "mediaType", "data"])
      guard let mediaType = object["mediaType"] as? String,
        let encoded = object["data"] as? String,
        let data = Data(base64Encoded: encoded),
        BrokerImageInput.valid(mediaType: mediaType, data: data),
        data.base64EncodedString() == encoded
      else { throw BrokerOpenAIGenerationWireError.invalidMessage }
      return .image(mediaType: mediaType, data: data)
    case "function_call":
      try exactKeys(object, ["kind", "callId", "name", "arguments"])
      guard let callID = object["callId"] as? String,
        let name = object["name"] as? String,
        let arguments = object["arguments"] as? [String: Any]
      else { throw BrokerOpenAIGenerationWireError.invalidMessage }
      return .functionCall(
        callID: callID,
        name: name,
        argumentsJSON: try canonical(arguments)
      )
    case "function_call_output":
      try exactKeys(object, ["kind", "callId", "output"])
      guard let callID = object["callId"] as? String,
        let output = object["output"] as? String
      else { throw BrokerOpenAIGenerationWireError.invalidMessage }
      return .functionCallOutput(callID: callID, output: output)
    case "continuation":
      try exactKeys(object, ["kind", "handle"])
      guard let handle = object["handle"] as? [String: Any] else {
        throw BrokerOpenAIGenerationWireError.invalidMessage
      }
      return .continuation(try decodeHandle(handle))
    default:
      throw BrokerOpenAIGenerationWireError.invalidMessage
    }
  }

  private static func decodeTool(
    _ object: [String: Any]
  ) throws -> BrokerOpenAIResponsesFunctionTool {
    try exactKeys(object, ["name", "description", "inputSchema"])
    guard let name = object["name"] as? String,
      let description = object["description"] as? String,
      let schema = object["inputSchema"] as? [String: Any]
    else { throw BrokerOpenAIGenerationWireError.invalidMessage }
    return try BrokerOpenAIResponsesFunctionTool(
      name: name,
      description: description,
      parametersJSON: canonical(schema)
    )
  }

  private static func decodeHandle(
    _ object: [String: Any]
  ) throws -> BrokerDirectContinuationHandle {
    try exactKeys(
      object,
      [
        "kind", "id", "storageClass", "recursSessionId", "connectionId", "adapterId",
        "modelId", "backendFingerprint", "stateVersion", "originTurnId",
        "continuationSequence", "status",
      ])
    guard object["kind"] as? String == "direct",
      object["storageClass"] as? String == "persistent_broker",
      object["status"] as? String == "committed",
      let id = object["id"] as? String,
      id == id.lowercased(), UUID(uuidString: id)?.uuidString.lowercased() == id,
      let sessionID = object["recursSessionId"] as? String,
      let connectionID = object["connectionId"] as? String,
      let adapterID = object["adapterId"] as? String,
      let modelID = object["modelId"] as? String,
      let fingerprint = object["backendFingerprint"] as? String,
      integer(object["stateVersion"]) == Int(BrokerDirectContinuationAuthority.stateVersion),
      let originTurnID = object["originTurnId"] as? String,
      let sequence = unsignedInteger(object["continuationSequence"]), sequence > 0
    else { throw BrokerOpenAIGenerationWireError.invalidMessage }
    return BrokerDirectContinuationHandle(
      id: id,
      storageClass: .persistentBroker,
      recursSessionID: sessionID,
      connectionID: connectionID,
      adapterID: adapterID,
      modelID: modelID,
      backendFingerprint: fingerprint,
      stateVersion: BrokerDirectContinuationAuthority.stateVersion,
      originTurnID: originTurnID,
      continuationSequence: sequence,
      status: .committed
    )
  }

  private static func encode(_ handle: BrokerDirectContinuationHandle) -> [String: Any] {
    [
      "kind": "direct",
      "id": handle.id,
      "storageClass": handle.storageClass.rawValue,
      "recursSessionId": handle.recursSessionID,
      "connectionId": handle.connectionID,
      "adapterId": handle.adapterID,
      "modelId": handle.modelID,
      "backendFingerprint": handle.backendFingerprint,
      "stateVersion": handle.stateVersion,
      "originTurnId": handle.originTurnID,
      "continuationSequence": handle.continuationSequence,
      "status": handle.status.rawValue,
    ]
  }

  private static func encode(_ object: [String: Any]) throws -> Data {
    guard JSONSerialization.isValidJSONObject(object) else {
      throw BrokerOpenAIGenerationWireError.invalidMessage
    }
    let data = try JSONSerialization.data(
      withJSONObject: object,
      options: [.sortedKeys, .withoutEscapingSlashes]
    )
    guard data.count <= maximumEventByteCount else {
      throw BrokerOpenAIGenerationWireError.invalidMessage
    }
    return data
  }

  private static func canonical(_ object: [String: Any]) throws -> Data {
    guard JSONSerialization.isValidJSONObject(object) else {
      throw BrokerOpenAIGenerationWireError.invalidMessage
    }
    return try JSONSerialization.data(
      withJSONObject: object,
      options: [.sortedKeys, .withoutEscapingSlashes]
    )
  }

  private static func exactKeys(_ object: [String: Any], _ expected: Set<String>) throws {
    guard Set(object.keys) == expected else { throw BrokerOpenAIGenerationWireError.invalidMessage }
  }

  private static func integer(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber,
      CFGetTypeID(number) != CFBooleanGetTypeID()
    else { return nil }
    let double = number.doubleValue
    guard double.isFinite, double.rounded() == double,
      double >= Double(Int.min), double <= Double(Int.max)
    else { return nil }
    return Int(double)
  }

  private static func unsignedInteger(_ value: Any?) -> UInt64? {
    guard let integer = integer(value), integer >= 0 else { return nil }
    return UInt64(integer)
  }

  private static func date(_ value: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    guard let date = formatter.date(from: value), formatter.string(from: date) == value else {
      return nil
    }
    return date
  }
}
