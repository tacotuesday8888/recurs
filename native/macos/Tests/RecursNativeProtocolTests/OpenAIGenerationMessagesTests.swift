import Foundation
import Testing

@testable import RecursNativeProtocol

struct OpenAIGenerationMessagesTests {
  @Test
  func requestAndEventBodiesRoundTripAsOpaqueOwnedBytes() throws {
    let requestBody = Data(#"{"model":"gpt-5.6-sol"}"#.utf8)
    let requestFrame = try decodeOne(
      OpenAIGenerationRequestMessage(body: requestBody).encodedFrame(requestID: 41)
    )
    let request = try OpenAIGenerationRequestMessage.decode(requestFrame)
    #expect(request.body == requestBody)

    let eventBody = Data(#"{"type":"text_delta","text":"done"}"#.utf8)
    let eventFrame = try decodeOne(
      OpenAIGenerationEventMessage(body: eventBody).encodedFrame(requestID: 41)
    )
    #expect(try OpenAIGenerationEventMessage.decode(eventFrame).body == eventBody)
  }

  @Test
  func failureCodesAreExactAndBodiesAreBounded() throws {
    for code in OpenAIGenerationFailureCode.allCases {
      let frame = try decodeOne(
        OpenAIGenerationFailureMessage(code: code).encodedFrame(requestID: 42)
      )
      #expect(try OpenAIGenerationFailureMessage.decode(frame).code == code)
    }
    #expect(throws: NativeProtocolError.invalidMessage) {
      _ = try OpenAIGenerationRequestMessage(body: Data())
    }
    #expect(throws: NativeProtocolError.invalidMessage) {
      _ = try OpenAIGenerationRequestMessage(
        body: Data(repeating: 0, count: nativeFrameMaximumPayloadByteCount)
      )
    }
  }
}

private func decodeOne(_ encoded: Data) throws -> NativeFrame {
  var decoder = NativeFrameDecoder()
  let frames = try decoder.push(encoded)
  try decoder.finish()
  return try #require(frames.first)
}
