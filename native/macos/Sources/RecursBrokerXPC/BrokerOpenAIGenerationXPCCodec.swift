import Foundation
import RecursNativeProtocol

package enum BrokerOpenAIGenerationXPCCodecError: Error, Sendable, Equatable {
  case invalidMessage
}

package enum BrokerOpenAIGenerationXPCBeginReply: Sendable, Equatable {
  case begun(UUID)
  case failure(OpenAIGenerationFailureCode)

  package func encode() -> Data {
    switch self {
    case .begun(let id):
      Data([1]) + Data(id.uuidString.lowercased().utf8)
    case .failure(let code):
      Data([2, UInt8(code.rawValue >> 8), UInt8(code.rawValue & 0xff)])
    }
  }

  package static func decode(
    _ data: Data
  ) throws(BrokerOpenAIGenerationXPCCodecError) -> BrokerOpenAIGenerationXPCBeginReply {
    let bytes = [UInt8](data)
    guard let kind = bytes.first else { throw .invalidMessage }
    switch kind {
    case 1:
      guard bytes.count == 37,
        let text = String(bytes: bytes.dropFirst(), encoding: .utf8),
        let id = canonicalUUID(text)
      else { throw .invalidMessage }
      return .begun(id)
    case 2:
      return .failure(try failureCode(bytes))
    default:
      throw .invalidMessage
    }
  }
}

package struct BrokerOpenAIGenerationXPCOperation: Sendable, Equatable {
  package let operationID: UUID

  package init(operationID: UUID) { self.operationID = operationID }

  package func encode() -> Data {
    Data(operationID.uuidString.lowercased().utf8)
  }

  package static func decode(
    _ data: Data
  ) throws(BrokerOpenAIGenerationXPCCodecError) -> BrokerOpenAIGenerationXPCOperation {
    guard data.count == 36,
      let text = String(data: data, encoding: .utf8),
      let id = canonicalUUID(text)
    else { throw .invalidMessage }
    return BrokerOpenAIGenerationXPCOperation(operationID: id)
  }
}

package enum BrokerOpenAIGenerationXPCPollReply: Sendable, Equatable {
  case idle
  case event(Data)
  case failure(OpenAIGenerationFailureCode)

  package func encode() throws(BrokerOpenAIGenerationXPCCodecError) -> Data {
    switch self {
    case .idle:
      return Data([1])
    case .event(let body):
      guard (1...1_048_576).contains(body.count) else { throw .invalidMessage }
      return Data([2]) + body
    case .failure(let code):
      return Data([3, UInt8(code.rawValue >> 8), UInt8(code.rawValue & 0xff)])
    }
  }

  package static func decode(
    _ data: Data
  ) throws(BrokerOpenAIGenerationXPCCodecError) -> BrokerOpenAIGenerationXPCPollReply {
    let bytes = [UInt8](data)
    guard let kind = bytes.first else { throw .invalidMessage }
    switch kind {
    case 1:
      guard bytes.count == 1 else { throw .invalidMessage }
      return .idle
    case 2:
      guard (2...1_048_577).contains(bytes.count) else { throw .invalidMessage }
      return .event(Data(bytes.dropFirst()))
    case 3:
      return .failure(try failureCode(bytes))
    default:
      throw .invalidMessage
    }
  }
}

package enum BrokerOpenAIGenerationXPCCancelReply {
  package static let accepted = Data([1])

  package static func decode(
    _ data: Data
  ) throws(BrokerOpenAIGenerationXPCCodecError) -> Bool {
    guard data == accepted else { throw .invalidMessage }
    return true
  }
}

private func canonicalUUID(_ text: String) -> UUID? {
  guard text == text.lowercased(), let id = UUID(uuidString: text),
    id.uuidString.lowercased() == text
  else { return nil }
  return id
}

private func failureCode(
  _ bytes: [UInt8]
) throws(BrokerOpenAIGenerationXPCCodecError) -> OpenAIGenerationFailureCode {
  guard bytes.count == 3,
    let code = OpenAIGenerationFailureCode(
      rawValue: (UInt16(bytes[1]) << 8) | UInt16(bytes[2])
    )
  else { throw .invalidMessage }
  return code
}
