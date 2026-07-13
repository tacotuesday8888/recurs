import Foundation
import Testing

@testable import RecursBrokerCore

@Suite("Authenticated broker journal provider binding")
struct BrokerJournalProviderBindingTests {
  private let connectionID = UUID(uuidString: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")!

  @Test
  func builtInAndCustomBindingsUseIndependentExactSchemaV2Bytes() throws {
    let builtIn = try record(binding: .openAI)
    #expect(
      try BrokerJournalCodec.canonicalRecordData(for: builtIn)
        == Data(
          #"{"schemaVersion":2,"revision":1,"connectionID":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","providerBinding":{"providerID":"openai-api","activationProfileID":"openai_api_v1","customEndpoint":null},"phase":"vacant","fence":0,"lastGenerationOrdinal":0,"changedAt":"2026-07-13T00:00:00.000Z","payload":{},"terminalOperations":[]}"#
            .utf8
        )
    )

    let custom = try ProviderProfileBinding.customOpenAICompatible(
      baseURL: "https://gateway.acme.ai:8443/tenant/v1",
      modelCatalogBehavior: .unavailable
    )
    let customRecord = try record(binding: custom)
    #expect(
      try BrokerJournalCodec.canonicalRecordData(for: customRecord)
        == Data(
          #"{"schemaVersion":2,"revision":1,"connectionID":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","providerBinding":{"providerID":"custom-openai-compatible","activationProfileID":"custom_openai_compatible_v1","customEndpoint":{"host":"gateway.acme.ai","port":8443,"basePath":"/tenant/v1","modelCatalogBehavior":"unavailable"}},"phase":"vacant","fence":0,"lastGenerationOrdinal":0,"changedAt":"2026-07-13T00:00:00.000Z","payload":{},"terminalOperations":[]}"#
            .utf8
        )
    )
    #expect(try BrokerJournalCodec.decode(envelope(for: customRecord)).record == customRecord)

    let customWithoutPort = try ProviderProfileBinding.customOpenAICompatible(
      baseURL: "https://gateway.acme.ai/tenant/v1"
    )
    let customWithoutPortRecord = try record(binding: customWithoutPort)
    #expect(
      try BrokerJournalCodec.canonicalRecordData(for: customWithoutPortRecord)
        == Data(
          #"{"schemaVersion":2,"revision":1,"connectionID":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","providerBinding":{"providerID":"custom-openai-compatible","activationProfileID":"custom_openai_compatible_v1","customEndpoint":{"host":"gateway.acme.ai","port":null,"basePath":"/tenant/v1","modelCatalogBehavior":"models_route"}},"phase":"vacant","fence":0,"lastGenerationOrdinal":0,"changedAt":"2026-07-13T00:00:00.000Z","payload":{},"terminalOperations":[]}"#
            .utf8
        )
    )
    #expect(
      try BrokerJournalCodec.decode(envelope(for: customWithoutPortRecord)).record
        == customWithoutPortRecord
    )
  }

  @Test
  func v1AndUnknownSchemaVersionsFailBeforeRecordDecoding() throws {
    let encoded = try envelope(for: record(binding: .openAI))
    for version in ["1", "3", "18446744073709551615"] {
      let hostile = try replacing(
        #""schemaVersion":2"#,
        with: #""schemaVersion":\#(version)"#,
        in: encoded
      )
      #expect(throws: BrokerJournalError.unsupportedVersion) {
        try BrokerJournalCodec.decode(hostile)
      }
    }
  }

  @Test
  func unknownMismatchedAndMalformedBindingFieldsFailClosed() throws {
    let builtIn = try envelope(for: record(binding: .openAI))
    let customBinding = try ProviderProfileBinding.customOpenAICompatible(
      baseURL: "https://gateway.acme.ai:8443/tenant/v1",
      modelCatalogBehavior: .unavailable
    )
    let custom = try envelope(for: record(binding: customBinding))
    let customObject =
      #"{"host":"gateway.acme.ai","port":8443,"basePath":"/tenant/v1","modelCatalogBehavior":"unavailable"}"#
    let customWithoutFields = try replacing(
      #""activationProfileID":"openai_api_v1""#,
      with: #""activationProfileID":"custom_openai_compatible_v1""#,
      in: replacing(
        #""providerID":"openai-api""#,
        with: #""providerID":"custom-openai-compatible""#,
        in: builtIn
      )
    )

    let hostile: [Data] = try [
      replacing(
        #""providerID":"openai-api""#,
        with: #""providerID":"anthropic-api""#,
        in: builtIn
      ),
      replacing(
        #""activationProfileID":"openai_api_v1""#,
        with: #""activationProfileID":"openai_api_v2""#,
        in: builtIn
      ),
      replacing(
        #""customEndpoint":null"#,
        with: #""customEndpoint":\#(customObject)"#,
        in: builtIn
      ),
      customWithoutFields,
      replacing(
        #""host":"gateway.acme.ai""#,
        with: #""host":"api.openai.com""#,
        in: custom
      ),
      replacing(#""port":8443"#, with: #""port":65536"#, in: custom),
      replacing(
        #""modelCatalogBehavior":"unavailable""#,
        with: #""modelCatalogBehavior":"future""#,
        in: custom
      ),
    ]

    for bytes in hostile {
      #expect(throws: BrokerJournalError.invalidRecord) {
        try BrokerJournalCodec.decode(bytes)
      }
    }
  }

  @Test
  func bindingObjectsRequireTheirExactCanonicalShape() throws {
    let builtIn = try envelope(for: record(binding: .openAI))
    let customBinding = try ProviderProfileBinding.customOpenAICompatible(
      baseURL: "https://gateway.acme.ai:8443/tenant/v1",
      modelCatalogBehavior: .unavailable
    )
    let custom = try envelope(for: record(binding: customBinding))
    let canonicalBuiltIn =
      #""providerBinding":{"providerID":"openai-api","activationProfileID":"openai_api_v1","customEndpoint":null}"#
    let reorderedBuiltIn =
      #""providerBinding":{"activationProfileID":"openai_api_v1","providerID":"openai-api","customEndpoint":null}"#

    let hostile = try [
      replacing(canonicalBuiltIn, with: reorderedBuiltIn, in: builtIn),
      replacing(#","customEndpoint":null"#, with: "", in: builtIn),
      replacing(
        #""host":"gateway.acme.ai","port":8443"#,
        with: #""port":8443,"host":"gateway.acme.ai""#,
        in: custom
      ),
    ]

    for bytes in hostile {
      #expect(throws: BrokerJournalError.nonCanonical) {
        try BrokerJournalCodec.decode(bytes)
      }
    }
  }

  @Test
  func adapterPersistsOneBindingAndEverySuccessorCopiesIt() throws {
    let timestamp = try self.timestamp()
    let pending = try BrokerJournalRecordAdapter.makeStorePending(
      predecessor: nil,
      connectionID: connectionID,
      providerBinding: .openAI,
      attemptID: uuid(1),
      operationID: uuid(2),
      candidateGenerationID: uuid(3),
      capturedAt: timestamp
    )
    let staging = try BrokerJournalRecordAdapter.makeStaging(
      predecessor: pending,
      changedAt: timestamp
    )
    let committed = try BrokerJournalRecordAdapter.makeCommitAuthority(
      predecessor: staging,
      operationID: uuid(4),
      capturedAt: timestamp
    )
    let abortPending = try BrokerJournalRecordAdapter.makeAbortCleanupPending(
      predecessor: staging,
      operationID: uuid(5),
      changedAt: timestamp
    )
    let aborted = try BrokerJournalRecordAdapter.makeStableAbort(
      predecessor: abortPending,
      changedAt: timestamp
    )
    let disconnectPending = try BrokerJournalRecordAdapter.makeDisconnectFenced(
      predecessor: staging,
      operationID: uuid(6),
      capturedAt: timestamp
    )
    let tombstoned = try BrokerJournalRecordAdapter.makeTombstoned(
      predecessor: disconnectPending,
      changedAt: timestamp
    )
    let stageCleanup = try BrokerJournalRecordAdapter.makeStageCleanupPending(
      predecessor: pending,
      error: .cancelled,
      changedAt: timestamp
    )
    let stageFailed = try BrokerJournalRecordAdapter.makeStableStageFailure(
      predecessor: stageCleanup,
      changedAt: timestamp
    )
    let storeFailed = try BrokerJournalRecordAdapter.makeStableStoreFailure(
      predecessor: pending,
      changedAt: timestamp
    )

    for selected in [
      pending, staging, committed, abortPending, aborted, disconnectPending, tombstoned,
      stageCleanup, stageFailed, storeFailed,
    ] {
      #expect(selected.providerBinding == .openAI)
      #expect(selected.schemaVersion == 2)
    }
  }

  @Test
  func reconnectAndTransitionRejectAnyBindingMutation() throws {
    let timestamp = try self.timestamp()
    let ready = try readyRecord(binding: .openAI)

    #expect(throws: BrokerJournalError.invalidRecord) {
      try BrokerJournalRecordAdapter.makeStorePending(
        predecessor: ready,
        connectionID: connectionID,
        providerBinding: .anthropic,
        attemptID: uuid(10),
        operationID: uuid(11),
        candidateGenerationID: uuid(12),
        capturedAt: timestamp
      )
    }

    let pending = try BrokerJournalRecordAdapter.makeStorePending(
      predecessor: ready,
      connectionID: connectionID,
      providerBinding: .openAI,
      attemptID: uuid(10),
      operationID: uuid(11),
      candidateGenerationID: uuid(12),
      capturedAt: timestamp
    )
    guard case .storePending(let payload) = pending.payload else {
      Issue.record("expected store-pending payload")
      return
    }
    let mutated = try BrokerJournalRecord(
      revision: pending.revision + 1,
      connectionID: pending.connectionID,
      providerBinding: .anthropic,
      fence: pending.fence,
      lastGenerationOrdinal: pending.lastGenerationOrdinal,
      changedAt: timestamp,
      payload: .staging(
        BrokerJournalStagingPayload(
          attemptID: payload.attemptID,
          operationID: payload.operationID,
          expectedFence: payload.expectedFence,
          candidate: payload.candidate,
          previousReady: payload.previousReady,
          startedAt: payload.startedAt
        )
      ),
      terminalOperations: pending.terminalOperations
    )
    #expect(throws: BrokerJournalError.casConflict) {
      try BrokerJournalTransitionValidator.validate(predecessor: pending, successor: mutated)
    }
  }

  private func record(binding: ProviderProfileBinding) throws -> BrokerJournalRecord {
    try BrokerJournalRecord(
      revision: 1,
      connectionID: connectionID,
      providerBinding: binding,
      fence: 0,
      lastGenerationOrdinal: 0,
      changedAt: timestamp(),
      payload: .vacant(BrokerJournalVacantPayload())
    )
  }

  private func readyRecord(binding: ProviderProfileBinding) throws -> BrokerJournalRecord {
    let timestamp = try self.timestamp()
    let generation = BrokerJournalCredentialGeneration(
      generationID: uuid(20),
      ordinal: 1,
      createdAt: timestamp
    )
    return try BrokerJournalRecord(
      revision: 1,
      connectionID: connectionID,
      providerBinding: binding,
      fence: 1,
      lastGenerationOrdinal: 1,
      changedAt: timestamp,
      payload: .ready(
        BrokerJournalReadyPayload(
          ready: BrokerJournalReadyGeneration(generation: generation, committedAt: timestamp)
        )
      )
    )
  }

  private func envelope(for record: BrokerJournalRecord) throws -> Data {
    try BrokerJournalCodec.encode(
      BrokerJournalEnvelope(previousAuthTag: .zero, authTag: .zero, record: record)
    )
  }

  private func replacing(_ target: String, with replacement: String, in data: Data) throws
    -> Data
  {
    var result = data
    let range = try #require(result.range(of: Data(target.utf8)))
    result.replaceSubrange(range, with: replacement.utf8)
    return result
  }

  private func timestamp() throws -> JournalTimestamp {
    try JournalTimestamp(canonicalText: "2026-07-13T00:00:00.000Z")
  }

  private func uuid(_ suffix: Int) -> UUID {
    UUID(uuidString: String(format: "00000000-0000-4000-8000-%012d", suffix))!
  }
}
