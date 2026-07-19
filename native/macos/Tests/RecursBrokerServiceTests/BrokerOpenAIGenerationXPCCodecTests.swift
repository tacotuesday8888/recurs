import Foundation
import Testing

@testable import RecursBrokerXPC
@testable import RecursNativeProtocol

struct BrokerOpenAIGenerationXPCCodecTests {
  private let id = UUID(uuidString: "91000000-0000-4000-8000-000000000001")!

  @Test
  func exactBeginPollAndCancelMessagesRoundTrip() throws {
    #expect(
      try BrokerOpenAIGenerationXPCBeginReply.decode(
        BrokerOpenAIGenerationXPCBeginReply.begun(id).encode()
      ) == .begun(id)
    )
    #expect(
      try BrokerOpenAIGenerationXPCBeginReply.decode(
        BrokerOpenAIGenerationXPCBeginReply.failure(.rateLimited).encode()
      ) == .failure(.rateLimited)
    )
    let operation = BrokerOpenAIGenerationXPCOperation(operationID: id)
    #expect(try BrokerOpenAIGenerationXPCOperation.decode(operation.encode()) == operation)

    let event = Data(#"{"type":"text_delta","text":"done"}"#.utf8)
    for reply in [
      BrokerOpenAIGenerationXPCPollReply.idle,
      .event(event),
      .failure(.providerFailure),
    ] {
      #expect(try BrokerOpenAIGenerationXPCPollReply.decode(reply.encode()) == reply)
    }
    #expect(try BrokerOpenAIGenerationXPCCancelReply.decode(Data([1])))
  }

  @Test
  func malformedOrOversizedMessagesFailClosed() {
    for data in [Data(), Data([1, 0]), Data(repeating: 0, count: 1_048_578)] {
      #expect(throws: BrokerOpenAIGenerationXPCCodecError.invalidMessage) {
        _ = try BrokerOpenAIGenerationXPCPollReply.decode(data)
      }
    }
    #expect(throws: BrokerOpenAIGenerationXPCCodecError.invalidMessage) {
      _ = try BrokerOpenAIGenerationXPCOperation.decode(Data("not-a-uuid".utf8))
    }
  }
}
