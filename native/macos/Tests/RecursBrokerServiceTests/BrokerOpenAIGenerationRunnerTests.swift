import Foundation
import Testing

@testable import RecursBrokerService

struct BrokerOpenAIGenerationRunnerTests {
  @Test
  func replaysActiveStateRunsOnceAndCommitsTheNextHandle() async throws {
    let records = GenerationMemoryRecords()
    let continuations = BrokerDirectContinuationAuthority(
      records: records,
      idSource: GenerationIDs([
        UUID(uuidString: "81000000-0000-4000-8000-000000000001")!,
        UUID(uuidString: "81000000-0000-4000-8000-000000000002")!,
      ]).next,
      clock: { Date(timeIntervalSince1970: 100) }
    )
    let previousBinding = generationWriteBinding(turnID: "turn-1", sequence: 3)
    let previousOutput = try generationPrivateOutput("reasoning-1")
    let previous = try await continuations.put(
      binding: previousBinding,
      previous: nil,
      outputItems: [previousOutput]
    )
    let route = GenerationRoute()
    let transport = GenerationTransport(
      completion: BrokerOpenAIResponsesCompletion(
        responseID: "response-2",
        outputItems: [try generationPrivateOutput("reasoning-2")],
        usage: BrokerOpenAIResponsesUsage(
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          cachedInputTokens: 2,
          cacheWriteTokens: nil,
          reasoningTokens: 3
        ),
        stopReason: .complete,
        outcome: .output
      )
    )
    let runner = BrokerOpenAIGenerationRunner(
      route: route,
      transport: transport,
      continuations: continuations,
      clock: { Date(timeIntervalSince1970: 100) }
    )
    let events = GenerationEvents()

    let result = try await runner.run(
      BrokerOpenAIGenerationRequest(
        connectionID: UUID(uuidString: previous.connectionID)!,
        authorizationID: "authorization-2",
        sessionID: previous.recursSessionID,
        turnID: "turn-2",
        adapterID: previous.adapterID,
        modelID: previous.modelID,
        backendFingerprint: previous.backendFingerprint,
        expectedSessionRecordSequence: 4,
        authorizationExpiresAt: Date(timeIntervalSince1970: 200),
        input: [
          .message(role: .user, text: "continue"),
          .continuation(previous),
        ],
        tools: [],
        maxOutputTokens: 1_024
      ),
      onEvent: events.append
    )

    #expect(result.continuation.continuationSequence == 2)
    #expect(result.completion.responseID == "response-2")
    #expect(await route.issueCount == 1)
    #expect(await route.cancelCount == 1)
    let sent = try #require(await transport.request)
    #expect(
      sent.input == [
        .message(role: .user, text: "continue"),
        .privateOutput(previousOutput),
      ]
    )
    #expect(events.values == [.textDelta("done")])
  }

  @Test
  func cancelsTheRouteAndDoesNotCommitWhenTransportFails() async throws {
    let records = GenerationMemoryRecords()
    let continuations = BrokerDirectContinuationAuthority(records: records)
    let route = GenerationRoute()
    let transport = GenerationTransport(error: .rateLimited)
    let runner = BrokerOpenAIGenerationRunner(
      route: route,
      transport: transport,
      continuations: continuations,
      clock: { Date(timeIntervalSince1970: 100) }
    )
    let events = GenerationEvents()

    await #expect(throws: BrokerOpenAIGenerationError.rateLimited) {
      _ = try await runner.run(
        BrokerOpenAIGenerationRequest(
          connectionID: UUID(uuidString: "71000000-0000-4000-8000-000000000001")!,
          authorizationID: "authorization-1",
          sessionID: "session-1",
          turnID: "turn-1",
          adapterID: "openai-responses",
          modelID: "gpt-5.6-sol",
          backendFingerprint: "sha256:\(String(repeating: "a", count: 64))",
          expectedSessionRecordSequence: 3,
          authorizationExpiresAt: Date(timeIntervalSince1970: 200),
          input: [.message(role: .user, text: "hello")],
          tools: [],
          maxOutputTokens: 1_024
        ),
        onEvent: events.append
      )
    }
    #expect(await route.cancelCount == 1)
    #expect(await records.count == 0)
    #expect(events.values == [.textDelta("partial")])
  }

  @Test
  func anthropicMapsTheSharedRequestAndCommitsOpaqueEmptyState() async throws {
    let records = GenerationMemoryRecords()
    let continuations = BrokerDirectContinuationAuthority(
      records: records,
      idSource: GenerationIDs([
        UUID(uuidString: "82000000-0000-4000-8000-000000000001")!
      ]).next,
      clock: { Date(timeIntervalSince1970: 100) }
    )
    let route = GenerationRoute()
    let completion = BrokerOpenAIResponsesCompletion(
      responseID: "msg-1",
      outputItems: [],
      usage: BrokerOpenAIResponsesUsage(
        inputTokens: 3,
        outputTokens: 2,
        totalTokens: 5,
        cachedInputTokens: 0,
        cacheWriteTokens: nil,
        reasoningTokens: 0
      ),
      stopReason: .toolCalls,
      outcome: .output
    )
    let transport = AnthropicGenerationTransport(completion: completion)
    let runner = BrokerAnthropicGenerationRunner(
      route: route,
      transport: transport,
      continuations: continuations,
      clock: { Date(timeIntervalSince1970: 100) }
    )
    let request = BrokerOpenAIGenerationRequest(
      connectionID: UUID(uuidString: "72000000-0000-4000-8000-000000000001")!,
      authorizationID: "authorization-1",
      sessionID: "session-1",
      turnID: "turn-1",
      adapterID: "anthropic-messages",
      modelID: "claude-test",
      backendFingerprint: "sha256:\(String(repeating: "b", count: 64))",
      expectedSessionRecordSequence: 1,
      authorizationExpiresAt: Date(timeIntervalSince1970: 200),
      input: [
        .message(role: .system, text: "Be precise."),
        .message(role: .user, text: "Read it"),
        .functionCall(
          callID: "toolu-1",
          name: "read_file",
          argumentsJSON: Data(#"{"path":"a.ts"}"#.utf8)
        ),
        .functionCallOutput(callID: "toolu-1", output: "contents"),
      ],
      tools: [
        try BrokerOpenAIResponsesFunctionTool(
          name: "read_file",
          description: "Read a file",
          parametersJSON: Data(#"{"type":"object"}"#.utf8)
        )
      ],
      maxOutputTokens: 1_024
    )

    let result = try await runner.run(request, onEvent: { _ in })

    #expect(result.completion == completion)
    #expect(result.continuation.adapterID == "anthropic-messages")
    #expect(await route.issueCount == 1)
    #expect(await route.cancelCount == 1)
    let sent = try #require(await transport.request)
    #expect(
      sent.input == [
        .message(role: .system, text: "Be precise."),
        .message(role: .user, text: "Read it"),
        .toolUse(
          callID: "toolu-1",
          name: "read_file",
          argumentsJSON: Data(#"{"path":"a.ts"}"#.utf8)
        ),
        .toolResult(callID: "toolu-1", output: "contents"),
      ])
    #expect(await records.count == 1)
  }
}

private final class GenerationCapability: Sendable {}

private actor GenerationRoute: BrokerOpenAIGenerationRouteIssuing {
  typealias Capability = GenerationCapability
  private(set) var issueCount = 0
  private(set) var cancelCount = 0

  func issueRun(
    connectionID: UUID,
    expiresAt: Date,
    requestBudget: UInt64,
    byteBudget: UInt64
  ) -> GenerationCapability {
    issueCount += 1
    return GenerationCapability()
  }

  func cancel(_ capability: GenerationCapability) {
    cancelCount += 1
  }
}

private actor GenerationTransport: BrokerOpenAIGenerationTransporting {
  typealias Capability = GenerationCapability
  private let completion: BrokerOpenAIResponsesCompletion?
  private let error: BrokerOpenAIResponsesError?
  private(set) var request: BrokerOpenAIResponsesRequest?

  init(completion: BrokerOpenAIResponsesCompletion) {
    self.completion = completion
    error = nil
  }

  init(error: BrokerOpenAIResponsesError) {
    completion = nil
    self.error = error
  }

  func stream(
    _ request: BrokerOpenAIResponsesRequest,
    capability: GenerationCapability,
    onEvent: @escaping @Sendable (BrokerOpenAIResponsesEvent) -> Void
  ) throws -> BrokerOpenAIResponsesCompletion {
    self.request = request
    if let error {
      onEvent(.textDelta("partial"))
      onEvent(.done(.complete))
      throw error
    }
    onEvent(.textDelta("done"))
    onEvent(.done(.complete))
    return completion!
  }
}

private actor AnthropicGenerationTransport: BrokerAnthropicGenerationTransporting {
  typealias Capability = GenerationCapability
  private let completion: BrokerOpenAIResponsesCompletion
  private(set) var request: BrokerAnthropicMessagesRequest?

  init(completion: BrokerOpenAIResponsesCompletion) { self.completion = completion }

  func stream(
    _ request: BrokerAnthropicMessagesRequest,
    capability: GenerationCapability,
    onEvent: @escaping @Sendable (BrokerOpenAIResponsesEvent) -> Void
  ) throws -> BrokerOpenAIResponsesCompletion {
    self.request = request
    onEvent(.done(completion.stopReason))
    return completion
  }
}

private actor GenerationMemoryRecords: BrokerDirectContinuationRecordStoring {
  private var values: [String: BrokerDirectContinuationRecord] = [:]
  var count: Int { values.count }

  func insert(_ record: BrokerDirectContinuationRecord) throws {
    guard values[record.handle.id] == nil else {
      throw BrokerDirectContinuationRecordError.conflict
    }
    values[record.handle.id] = record
  }

  func read(id: String) -> BrokerDirectContinuationRecord? { values[id] }
  func remove(id: String) { values[id] = nil }
}

private final class GenerationIDs: @unchecked Sendable {
  private let lock = NSLock()
  private var values: [UUID]

  init(_ values: [UUID]) { self.values = values }

  func next() -> UUID? {
    lock.withLock { values.isEmpty ? nil : values.removeFirst() }
  }
}

private final class GenerationEvents: @unchecked Sendable {
  private let lock = NSLock()
  private var stored: [BrokerOpenAIResponsesEvent] = []

  var values: [BrokerOpenAIResponsesEvent] { lock.withLock { stored } }
  func append(_ event: BrokerOpenAIResponsesEvent) { lock.withLock { stored.append(event) } }
}

private func generationWriteBinding(
  turnID: String,
  sequence: UInt64
) -> BrokerDirectContinuationWriteBinding {
  BrokerDirectContinuationWriteBinding(
    authorizationID: "authorization-1",
    sessionID: "session-1",
    connectionID: "71000000-0000-4000-8000-000000000001",
    adapterID: "openai-responses",
    modelID: "gpt-5.6-sol",
    backendFingerprint: "sha256:\(String(repeating: "a", count: 64))",
    turnID: turnID,
    expectedSessionRecordSequence: sequence,
    expiresAt: Date(timeIntervalSince1970: 200)
  )
}

private func generationPrivateOutput(
  _ id: String
) throws -> BrokerOpenAIResponsesPrivateOutput {
  try BrokerOpenAIResponsesPrivateOutput(
    decoderItemJSON: Data(
      #"{"id":"\#(id)","type":"reasoning","status":"completed","summary":[],"encrypted_content":"opaque"}"#
        .utf8
    )
  )
}
