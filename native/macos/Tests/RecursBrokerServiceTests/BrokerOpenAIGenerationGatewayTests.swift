import Foundation
import Testing

@testable import RecursBrokerService

struct BrokerOpenAIGenerationGatewayTests {
  @Test
  func gatesBeforeHelloThenStreamsStateBeforeDone() async throws {
    let runner = GatewayRunner()
    let gateway = BrokerOpenAIGenerationGateway(
      runner: runner,
      idSource: { UUID(uuidString: "91000000-0000-4000-8000-000000000001")! }
    )
    #expect(gateway.begin(gatewayRequestBody()) == .failure(.routeUnavailable))

    gateway.authorizeAfterHello()
    let begun = gateway.begin(gatewayRequestBody())
    let operationID = try #require(begun.operationID)
    var results: [BrokerOpenAIGenerationPoll] = []
    while results.last?.isTerminal != true {
      let next = gateway.poll(operationID)
      if next != .idle { results.append(next) }
      await Task.yield()
    }

    let bodies = results.compactMap(\.eventBody)
    let types = try bodies.map { body in
      let object = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
      return try #require(object["type"] as? String)
    }
    #expect(types == ["text_delta", "provider_state", "done"])
    #expect(gateway.poll(operationID) == .failure(.invalidRequest))
  }

  @Test
  func cancellationIsTerminalAndCloseRejectsNewWork() async throws {
    let runner = GatewayRunner(suspend: true)
    let gateway = BrokerOpenAIGenerationGateway(runner: runner)
    gateway.authorizeAfterHello()
    let operationID = try #require(gateway.begin(gatewayRequestBody()).operationID)

    gateway.cancel(operationID)

    #expect(gateway.poll(operationID) == .failure(.cancelled))
    gateway.close()
    #expect(gateway.begin(gatewayRequestBody()) == .failure(.routeUnavailable))
  }
}

private final class GatewayRunner: BrokerOpenAIGenerationRunning, @unchecked Sendable {
  private let suspend: Bool

  init(suspend: Bool = false) { self.suspend = suspend }

  func run(
    _ request: BrokerOpenAIGenerationRequest,
    onEvent: @escaping @Sendable (BrokerOpenAIResponsesEvent) -> Void
  ) async throws -> BrokerOpenAIGenerationResult {
    if suspend {
      try await Task.sleep(for: .seconds(60))
    }
    onEvent(.textDelta("done"))
    return BrokerOpenAIGenerationResult(
      completion: BrokerOpenAIResponsesCompletion(
        responseID: "response-1",
        outputItems: [try gatewayPrivateOutput()],
        usage: nil,
        stopReason: .complete,
        outcome: .output
      ),
      continuation: gatewayHandle()
    )
  }
}

private func gatewayRequestBody() -> Data {
  Data(
    #"{"format":1,"connectionId":"71000000-0000-4000-8000-000000000001","authorizationId":"authorization-1","sessionId":"session-1","turnId":"turn-1","adapterId":"openai-responses","modelId":"gpt-5.6-sol","backendFingerprint":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","expectedSessionRecordSequence":3,"authorizationExpiresAt":"2026-07-15T00:00:00.000Z","input":[{"kind":"message","role":"user","text":"hello"}],"tools":[],"maxOutputTokens":8192}"#
      .utf8
  )
}

private func gatewayHandle() -> BrokerDirectContinuationHandle {
  BrokerDirectContinuationHandle(
    id: "81000000-0000-4000-8000-000000000001",
    storageClass: .persistentBroker,
    recursSessionID: "session-1",
    connectionID: "71000000-0000-4000-8000-000000000001",
    adapterID: "openai-responses",
    modelID: "gpt-5.6-sol",
    backendFingerprint: "sha256:\(String(repeating: "a", count: 64))",
    stateVersion: 1,
    originTurnID: "turn-1",
    continuationSequence: 1,
    status: .committed
  )
}

private func gatewayPrivateOutput() throws -> BrokerOpenAIResponsesPrivateOutput {
  try BrokerOpenAIResponsesPrivateOutput(
    decoderItemJSON: Data(
      #"{"id":"reasoning-1","type":"reasoning","status":"completed","summary":[],"encrypted_content":"opaque"}"#
        .utf8
    )
  )
}
