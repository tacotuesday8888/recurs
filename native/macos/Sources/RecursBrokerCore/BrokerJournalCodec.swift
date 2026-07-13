import Foundation

package struct BrokerJournalEnvelope: Sendable, Hashable {
  package let previousAuthTag: JournalAuthenticationTag
  package let authTag: JournalAuthenticationTag
  package let record: BrokerJournalRecord

  package init(
    previousAuthTag: JournalAuthenticationTag,
    authTag: JournalAuthenticationTag,
    record: BrokerJournalRecord
  ) {
    self.previousAuthTag = previousAuthTag
    self.authTag = authTag
    self.record = record
  }
}

package enum BrokerJournalCodec {
  package static func canonicalRecordData(
    for record: BrokerJournalRecord
  ) throws(BrokerJournalError) -> Data {
    var writer = BrokerJournalCanonicalJSONWriter()
    writer.append("{")
    appendKey("schemaVersion", to: &writer)
    writer.appendUInt64(record.schemaVersion)
    writer.append(",")
    appendKey("revision", to: &writer)
    writer.appendUInt64(record.revision)
    writer.append(",")
    appendKey("connectionID", to: &writer)
    writer.appendJSONString(canonicalUUID(record.connectionID))
    writer.append(",")
    appendKey("providerBinding", to: &writer)
    try appendProviderBinding(record.providerBinding, to: &writer)
    writer.append(",")
    appendKey("phase", to: &writer)
    writer.appendJSONString(phaseName(record.phase))
    writer.append(",")
    appendKey("fence", to: &writer)
    writer.appendUInt64(record.fence)
    writer.append(",")
    appendKey("lastGenerationOrdinal", to: &writer)
    writer.appendUInt64(record.lastGenerationOrdinal)
    writer.append(",")
    appendKey("changedAt", to: &writer)
    writer.appendJSONString(record.changedAt.canonicalText)
    writer.append(",")
    appendKey("payload", to: &writer)
    appendPayload(record.payload, to: &writer)
    writer.append(",")
    appendKey("terminalOperations", to: &writer)
    appendTerminalOperations(record.terminalOperations, to: &writer)
    writer.append("}")
    let result = writer.data
    try BrokerJournalNonSecretScanner.validate(result)
    return result
  }

  private static func appendKey(
    _ key: String,
    to writer: inout BrokerJournalCanonicalJSONWriter
  ) {
    writer.appendJSONString(key)
    writer.append(":")
  }

  private static func appendUUID(
    _ value: UUID,
    to writer: inout BrokerJournalCanonicalJSONWriter
  ) {
    writer.appendJSONString(canonicalUUID(value))
  }

  private static func appendTimestamp(
    _ value: JournalTimestamp,
    to writer: inout BrokerJournalCanonicalJSONWriter
  ) {
    writer.appendJSONString(value.canonicalText)
  }

  private static func appendProviderBinding(
    _ binding: ProviderProfileBinding,
    to writer: inout BrokerJournalCanonicalJSONWriter
  ) throws(BrokerJournalError) {
    writer.append("{")
    appendKey("providerID", to: &writer)
    writer.appendJSONString(binding.providerID)
    writer.append(",")
    appendKey("activationProfileID", to: &writer)
    writer.appendJSONString(binding.activationProfileID.rawValue)
    writer.append(",")
    appendKey("customEndpoint", to: &writer)

    switch binding.activationProfileID {
    case .openaiApiV1, .anthropicApiV1, .kimiCodeV1:
      guard
        binding.customHost == nil,
        binding.customPort == nil,
        binding.customBasePath == nil,
        binding.customModelCatalogBehavior == nil
      else {
        throw .invalidRecord
      }
      writer.append("null")

    case .customOpenaiCompatibleV1:
      guard
        let host = binding.customHost,
        let basePath = binding.customBasePath,
        let catalogBehavior = binding.customModelCatalogBehavior
      else {
        throw .invalidRecord
      }
      writer.append("{")
      appendKey("host", to: &writer)
      writer.appendJSONString(host)
      writer.append(",")
      appendKey("port", to: &writer)
      if let port = binding.customPort {
        writer.appendUInt64(UInt64(port))
      } else {
        writer.append("null")
      }
      writer.append(",")
      appendKey("basePath", to: &writer)
      writer.appendJSONString(basePath)
      writer.append(",")
      appendKey("modelCatalogBehavior", to: &writer)
      writer.appendJSONString(catalogBehavior.rawValue)
      writer.append("}")
    }
    writer.append("}")
  }

  private static func appendCredentialGeneration(
    _ value: BrokerJournalCredentialGeneration,
    to writer: inout BrokerJournalCanonicalJSONWriter
  ) {
    writer.append("{")
    appendKey("generationID", to: &writer)
    appendUUID(value.generationID, to: &writer)
    writer.append(",")
    appendKey("ordinal", to: &writer)
    writer.appendUInt64(value.ordinal)
    writer.append(",")
    appendKey("createdAt", to: &writer)
    appendTimestamp(value.createdAt, to: &writer)
    writer.append("}")
  }

  private static func appendReadyGeneration(
    _ value: BrokerJournalReadyGeneration,
    to writer: inout BrokerJournalCanonicalJSONWriter
  ) {
    writer.append("{")
    appendKey("generation", to: &writer)
    appendCredentialGeneration(value.generation, to: &writer)
    writer.append(",")
    appendKey("committedAt", to: &writer)
    appendTimestamp(value.committedAt, to: &writer)
    writer.append("}")
  }

  private static func appendReadyProjection(
    _ value: BrokerJournalReadyProjection,
    to writer: inout BrokerJournalCanonicalJSONWriter
  ) {
    writer.append("{")
    appendKey("connectionID", to: &writer)
    appendUUID(value.connectionID, to: &writer)
    writer.append(",")
    appendKey("fence", to: &writer)
    writer.appendUInt64(value.fence)
    writer.append(",")
    appendKey("ready", to: &writer)
    appendReadyGeneration(value.ready, to: &writer)
    writer.append(",")
    appendKey("lastGenerationOrdinal", to: &writer)
    writer.appendUInt64(value.lastGenerationOrdinal)
    writer.append("}")
  }

  private static func appendTombstoneProjection(
    _ value: BrokerJournalTombstoneProjection,
    to writer: inout BrokerJournalCanonicalJSONWriter
  ) {
    writer.append("{")
    appendKey("connectionID", to: &writer)
    appendUUID(value.connectionID, to: &writer)
    writer.append(",")
    appendKey("fence", to: &writer)
    writer.appendUInt64(value.fence)
    writer.append(",")
    appendKey("lastGenerationOrdinal", to: &writer)
    writer.appendUInt64(value.lastGenerationOrdinal)
    writer.append(",")
    appendKey("tombstonedAt", to: &writer)
    appendTimestamp(value.tombstonedAt, to: &writer)
    writer.append("}")
  }

  private static func appendOptionalReadyGeneration(
    _ value: BrokerJournalReadyGeneration?,
    to writer: inout BrokerJournalCanonicalJSONWriter
  ) {
    if let value {
      appendReadyGeneration(value, to: &writer)
    } else {
      writer.append("null")
    }
  }

  private static func appendPayload(
    _ payload: BrokerJournalPayload,
    to writer: inout BrokerJournalCanonicalJSONWriter
  ) {
    writer.append("{")
    switch payload {
    case .vacant:
      break
    case .storePending(let value):
      appendStagePayload(
        attemptID: value.attemptID,
        operationID: value.operationID,
        expectedFence: value.expectedFence,
        candidate: value.candidate,
        previousReady: value.previousReady,
        startedAt: value.startedAt,
        to: &writer
      )
    case .staging(let value):
      appendStagePayload(
        attemptID: value.attemptID,
        operationID: value.operationID,
        expectedFence: value.expectedFence,
        candidate: value.candidate,
        previousReady: value.previousReady,
        startedAt: value.startedAt,
        to: &writer
      )
    case .readyCleanupPending(let value):
      appendAttemptAndOperation(value.attemptID, value.operationID, to: &writer)
      writer.append(",")
      appendKey("expectedFence", to: &writer)
      writer.appendUInt64(value.expectedFence)
      writer.append(",")
      appendKey("ready", to: &writer)
      appendReadyGeneration(value.ready, to: &writer)
      writer.append(",")
      appendKey("previousReady", to: &writer)
      appendReadyGeneration(value.previousReady, to: &writer)
    case .ready(let value):
      appendKey("ready", to: &writer)
      appendReadyGeneration(value.ready, to: &writer)
    case .stageCleanupPending(let value):
      appendAttemptAndOperation(value.attemptID, value.operationID, to: &writer)
      writer.append(",")
      appendKey("expectedFence", to: &writer)
      writer.appendUInt64(value.expectedFence)
      writer.append(",")
      appendKey("candidate", to: &writer)
      appendCredentialGeneration(value.candidate, to: &writer)
      writer.append(",")
      appendKey("restoredReady", to: &writer)
      appendOptionalReadyGeneration(value.restoredReady, to: &writer)
      writer.append(",")
      appendKey("error", to: &writer)
      writer.appendJSONString(stageErrorName(value.error))
    case .abortCleanupPending(let value):
      appendAttemptAndOperation(value.attemptID, value.operationID, to: &writer)
      writer.append(",")
      appendKey("expectedFence", to: &writer)
      writer.appendUInt64(value.expectedFence)
      writer.append(",")
      appendKey("candidate", to: &writer)
      appendCredentialGeneration(value.candidate, to: &writer)
      writer.append(",")
      appendKey("restoredReady", to: &writer)
      appendOptionalReadyGeneration(value.restoredReady, to: &writer)
    case .disconnectFenced(let value):
      appendKey("operationID", to: &writer)
      appendUUID(value.operationID, to: &writer)
      writer.append(",")
      appendKey("expectedFence", to: &writer)
      writer.appendUInt64(value.expectedFence)
      writer.append(",")
      appendKey("tombstonedAt", to: &writer)
      appendTimestamp(value.tombstonedAt, to: &writer)
      writer.append(",")
      appendKey("deleteGenerations", to: &writer)
      appendCredentialGenerations(value.deleteGenerations, to: &writer)
    case .tombstoned(let value):
      appendKey("tombstonedAt", to: &writer)
      appendTimestamp(value.tombstonedAt, to: &writer)
    }
    writer.append("}")
  }

  private static func appendStagePayload(
    attemptID: UUID,
    operationID: UUID,
    expectedFence: UInt64,
    candidate: BrokerJournalCredentialGeneration,
    previousReady: BrokerJournalReadyGeneration?,
    startedAt: JournalTimestamp,
    to writer: inout BrokerJournalCanonicalJSONWriter
  ) {
    appendAttemptAndOperation(attemptID, operationID, to: &writer)
    writer.append(",")
    appendKey("expectedFence", to: &writer)
    writer.appendUInt64(expectedFence)
    writer.append(",")
    appendKey("candidate", to: &writer)
    appendCredentialGeneration(candidate, to: &writer)
    writer.append(",")
    appendKey("previousReady", to: &writer)
    appendOptionalReadyGeneration(previousReady, to: &writer)
    writer.append(",")
    appendKey("startedAt", to: &writer)
    appendTimestamp(startedAt, to: &writer)
  }

  private static func appendAttemptAndOperation(
    _ attemptID: UUID,
    _ operationID: UUID,
    to writer: inout BrokerJournalCanonicalJSONWriter
  ) {
    appendKey("attemptID", to: &writer)
    appendUUID(attemptID, to: &writer)
    writer.append(",")
    appendKey("operationID", to: &writer)
    appendUUID(operationID, to: &writer)
  }

  private static func appendCredentialGenerations(
    _ values: [BrokerJournalCredentialGeneration],
    to writer: inout BrokerJournalCanonicalJSONWriter
  ) {
    writer.append("[")
    for (index, value) in values.enumerated() {
      if index > 0 { writer.append(",") }
      appendCredentialGeneration(value, to: &writer)
    }
    writer.append("]")
  }

  private static func appendTerminalOperations(
    _ values: [BrokerJournalTerminalOperation],
    to writer: inout BrokerJournalCanonicalJSONWriter
  ) {
    writer.append("[")
    for (index, value) in values.enumerated() {
      if index > 0 { writer.append(",") }
      appendTerminalOperation(value, to: &writer)
    }
    writer.append("]")
  }

  private static func appendTerminalOperation(
    _ operation: BrokerJournalTerminalOperation,
    to writer: inout BrokerJournalCanonicalJSONWriter
  ) {
    writer.append("{")
    appendKey("operationID", to: &writer)
    appendUUID(operation.operationID, to: &writer)
    writer.append(",")
    appendKey("kind", to: &writer)
    writer.appendJSONString(terminalKindName(operation.kind))
    writer.append(",")
    appendKey("expectedFence", to: &writer)
    writer.appendUInt64(operation.expectedFence)
    switch operation {
    case .stageFailure(let value):
      writer.append(",")
      appendKey("result", to: &writer)
      writer.append("{")
      appendKey("error", to: &writer)
      writer.appendJSONString(stageErrorName(value.error))
      writer.append("}")
    case .commit(let value):
      writer.append(",")
      appendKey("attemptID", to: &writer)
      appendUUID(value.attemptID, to: &writer)
      writer.append(",")
      appendKey("result", to: &writer)
      writer.append("{")
      appendKey("ready", to: &writer)
      appendReadyProjection(value.ready, to: &writer)
      writer.append("}")
    case .abort(let value):
      writer.append(",")
      appendKey("attemptID", to: &writer)
      appendUUID(value.attemptID, to: &writer)
      writer.append(",")
      appendKey("result", to: &writer)
      writer.append("{")
      appendKey("restoredReady", to: &writer)
      if let restoredReady = value.restoredReady {
        appendReadyProjection(restoredReady, to: &writer)
      } else {
        writer.append("null")
      }
      writer.append("}")
    case .disconnect(let value):
      writer.append(",")
      appendKey("result", to: &writer)
      writer.append("{")
      appendKey("tombstone", to: &writer)
      appendTombstoneProjection(value.tombstone, to: &writer)
      writer.append("}")
    }
    writer.append("}")
  }

  private static func phaseName(_ phase: BrokerJournalPhase) -> String {
    switch phase {
    case .vacant: "vacant"
    case .storePending: "storePending"
    case .staging: "staging"
    case .readyCleanupPending: "readyCleanupPending"
    case .ready: "ready"
    case .stageCleanupPending: "stageCleanupPending"
    case .abortCleanupPending: "abortCleanupPending"
    case .disconnectFenced: "disconnectFenced"
    case .tombstoned: "tombstoned"
    }
  }

  private static func terminalKindName(_ kind: BrokerJournalTerminalKind) -> String {
    switch kind {
    case .stageFailure: "stageFailure"
    case .commit: "commit"
    case .abort: "abort"
    case .disconnect: "disconnect"
    }
  }

  private static func stageErrorName(_ error: BrokerJournalStageError) -> String {
    switch error {
    case .cancelled: "cancelled"
    case .storeUnavailable: "storeUnavailable"
    case .attemptNotCurrent: "attemptNotCurrent"
    }
  }

  package static func encode(
    _ envelope: BrokerJournalEnvelope
  ) throws(BrokerJournalError) -> Data {
    let record = try canonicalRecordData(for: envelope.record)
    return try canonicalEnvelopeData(
      previousAuthTag: envelope.previousAuthTag,
      authTag: envelope.authTag,
      canonicalRecord: record
    )
  }

  private static func canonicalEnvelopeData(
    previousAuthTag: JournalAuthenticationTag,
    authTag: JournalAuthenticationTag,
    canonicalRecord: Data
  ) throws(BrokerJournalError) -> Data {
    var writer = BrokerJournalCanonicalJSONWriter()
    writer.append("{")
    writer.appendJSONString("previousAuthTag")
    writer.append(":")
    writer.appendJSONString(previousAuthTag.lowercaseHex)
    writer.append(",")
    writer.appendJSONString("authTag")
    writer.append(":")
    writer.appendJSONString(authTag.lowercaseHex)
    writer.append(",")
    writer.appendJSONString("record")
    writer.append(":")
    writer.append(canonicalRecord)
    writer.append("}")
    let result = writer.data
    guard result.count <= SecureDirectory.maximumEnvelopeBytes else { throw .invalidRecord }
    return result
  }

  package static func decode(_ data: Data) throws(BrokerJournalError) -> BrokerJournalEnvelope {
    guard data.count <= SecureDirectory.maximumEnvelopeBytes else { throw .invalidRecord }
    var cursor = BrokerJournalCanonicalJSONCursor(data: data)
    try cursor.beginObject()
    try cursor.expect("\"previousAuthTag\":")
    let previousAuthTag = try JournalAuthenticationTag(lowercaseHex: cursor.parseString())
    try cursor.expect(",\"authTag\":")
    let authTag = try JournalAuthenticationTag(lowercaseHex: cursor.parseString())
    try cursor.expect(",\"record\":")
    let record = try decodeRecord(from: &cursor)
    try cursor.endObject()
    try cursor.finish()

    let canonicalRecord = try canonicalRecordData(for: record)

    let envelope = BrokerJournalEnvelope(
      previousAuthTag: previousAuthTag,
      authTag: authTag,
      record: record
    )
    guard
      try canonicalEnvelopeData(
        previousAuthTag: previousAuthTag,
        authTag: authTag,
        canonicalRecord: canonicalRecord
      ) == data
    else {
      throw .nonCanonical
    }
    return envelope
  }

  private static func decodeRecord(
    from cursor: inout BrokerJournalCanonicalJSONCursor
  ) throws(BrokerJournalError) -> BrokerJournalRecord {
    try cursor.beginObject()
    try cursor.expect("\"schemaVersion\":")
    let schemaVersion = try cursor.parseUInt64()
    guard schemaVersion == 2 else { throw .unsupportedVersion }
    try cursor.expect(",\"revision\":")
    let revision = try cursor.parseUInt64()
    try cursor.expect(",\"connectionID\":")
    let connectionID = try parseCanonicalUUID(cursor.parseString())
    try cursor.expect(",\"providerBinding\":")
    let providerBinding = try decodeProviderBinding(from: &cursor)
    try cursor.expect(",\"phase\":")
    let phase = try parsePhase(cursor.parseString())
    try cursor.expect(",\"fence\":")
    let fence = try cursor.parseUInt64()
    try cursor.expect(",\"lastGenerationOrdinal\":")
    let lastGenerationOrdinal = try cursor.parseUInt64()
    try cursor.expect(",\"changedAt\":")
    let changedAt = try JournalTimestamp(canonicalText: cursor.parseString())
    try cursor.expect(",\"payload\":")
    let payload = try decodePayload(phase: phase, from: &cursor)
    try cursor.expect(",\"terminalOperations\":")
    let terminalOperations = try decodeTerminalOperations(from: &cursor)
    try cursor.endObject()
    return try BrokerJournalRecord(
      revision: revision,
      connectionID: connectionID,
      providerBinding: providerBinding,
      fence: fence,
      lastGenerationOrdinal: lastGenerationOrdinal,
      changedAt: changedAt,
      payload: payload,
      terminalOperations: terminalOperations
    )
  }

  private struct DecodedCustomEndpoint {
    let host: String
    let port: UInt64?
    let basePath: String
    let modelCatalogBehavior: String
  }

  private static func decodeProviderBinding(
    from cursor: inout BrokerJournalCanonicalJSONCursor
  ) throws(BrokerJournalError) -> ProviderProfileBinding {
    try cursor.beginObject()
    try cursor.expect("\"providerID\":")
    let providerID = try cursor.parseString()
    try cursor.expect(",\"activationProfileID\":")
    let activationProfileID = try cursor.parseString()
    try cursor.expect(",\"customEndpoint\":")
    let customEndpoint: DecodedCustomEndpoint?
    if cursor.consume("null") {
      customEndpoint = nil
    } else {
      try cursor.beginObject()
      try cursor.expect("\"host\":")
      let host = try cursor.parseString()
      try cursor.expect(",\"port\":")
      let port = cursor.consume("null") ? nil : try cursor.parseUInt64()
      try cursor.expect(",\"basePath\":")
      let basePath = try cursor.parseString()
      try cursor.expect(",\"modelCatalogBehavior\":")
      let modelCatalogBehavior = try cursor.parseString()
      try cursor.endObject()
      customEndpoint = DecodedCustomEndpoint(
        host: host,
        port: port,
        basePath: basePath,
        modelCatalogBehavior: modelCatalogBehavior
      )
    }
    try cursor.endObject()

    do {
      return try ProviderProfileBinding.validatingStoredFields(
        providerID: providerID,
        activationProfileID: activationProfileID,
        customHost: customEndpoint?.host,
        customPort: customEndpoint?.port,
        customBasePath: customEndpoint?.basePath,
        customModelCatalogBehavior: customEndpoint?.modelCatalogBehavior
      )
    } catch {
      throw .invalidRecord
    }
  }

  private static func decodePayload(
    phase: BrokerJournalPhase,
    from cursor: inout BrokerJournalCanonicalJSONCursor
  ) throws(BrokerJournalError) -> BrokerJournalPayload {
    try cursor.beginObject()
    let payload: BrokerJournalPayload
    switch phase {
    case .vacant:
      payload = .vacant(BrokerJournalVacantPayload())
    case .storePending:
      let stage = try decodeStagePayload(from: &cursor)
      payload = .storePending(
        BrokerJournalStorePendingPayload(
          attemptID: stage.attemptID,
          operationID: stage.operationID,
          expectedFence: stage.expectedFence,
          candidate: stage.candidate,
          previousReady: stage.previousReady,
          startedAt: stage.startedAt
        )
      )
    case .staging:
      let stage = try decodeStagePayload(from: &cursor)
      payload = .staging(
        BrokerJournalStagingPayload(
          attemptID: stage.attemptID,
          operationID: stage.operationID,
          expectedFence: stage.expectedFence,
          candidate: stage.candidate,
          previousReady: stage.previousReady,
          startedAt: stage.startedAt
        )
      )
    case .readyCleanupPending:
      let identifiers = try decodeAttemptAndOperation(from: &cursor)
      try cursor.expect(",\"expectedFence\":")
      let expectedFence = try cursor.parseUInt64()
      try cursor.expect(",\"ready\":")
      let ready = try decodeReadyGeneration(from: &cursor)
      try cursor.expect(",\"previousReady\":")
      let previousReady = try decodeReadyGeneration(from: &cursor)
      payload = .readyCleanupPending(
        BrokerJournalReadyCleanupPendingPayload(
          attemptID: identifiers.attemptID,
          operationID: identifiers.operationID,
          expectedFence: expectedFence,
          ready: ready,
          previousReady: previousReady
        )
      )
    case .ready:
      try cursor.expect("\"ready\":")
      payload = .ready(
        BrokerJournalReadyPayload(ready: try decodeReadyGeneration(from: &cursor))
      )
    case .stageCleanupPending:
      let identifiers = try decodeAttemptAndOperation(from: &cursor)
      try cursor.expect(",\"expectedFence\":")
      let expectedFence = try cursor.parseUInt64()
      try cursor.expect(",\"candidate\":")
      let candidate = try decodeCredentialGeneration(from: &cursor)
      try cursor.expect(",\"restoredReady\":")
      let restoredReady = try decodeOptionalReadyGeneration(from: &cursor)
      try cursor.expect(",\"error\":")
      let error = try parseStageError(cursor.parseString())
      payload = .stageCleanupPending(
        BrokerJournalStageCleanupPendingPayload(
          attemptID: identifiers.attemptID,
          operationID: identifiers.operationID,
          expectedFence: expectedFence,
          candidate: candidate,
          restoredReady: restoredReady,
          error: error
        )
      )
    case .abortCleanupPending:
      let identifiers = try decodeAttemptAndOperation(from: &cursor)
      try cursor.expect(",\"expectedFence\":")
      let expectedFence = try cursor.parseUInt64()
      try cursor.expect(",\"candidate\":")
      let candidate = try decodeCredentialGeneration(from: &cursor)
      try cursor.expect(",\"restoredReady\":")
      let restoredReady = try decodeOptionalReadyGeneration(from: &cursor)
      payload = .abortCleanupPending(
        BrokerJournalAbortCleanupPendingPayload(
          attemptID: identifiers.attemptID,
          operationID: identifiers.operationID,
          expectedFence: expectedFence,
          candidate: candidate,
          restoredReady: restoredReady
        )
      )
    case .disconnectFenced:
      try cursor.expect("\"operationID\":")
      let operationID = try parseCanonicalUUID(cursor.parseString())
      try cursor.expect(",\"expectedFence\":")
      let expectedFence = try cursor.parseUInt64()
      try cursor.expect(",\"tombstonedAt\":")
      let tombstonedAt = try JournalTimestamp(canonicalText: cursor.parseString())
      try cursor.expect(",\"deleteGenerations\":")
      let deleteGenerations = try decodeCredentialGenerations(from: &cursor)
      payload = .disconnectFenced(
        BrokerJournalDisconnectFencedPayload(
          operationID: operationID,
          expectedFence: expectedFence,
          tombstonedAt: tombstonedAt,
          deleteGenerations: deleteGenerations
        )
      )
    case .tombstoned:
      try cursor.expect("\"tombstonedAt\":")
      payload = .tombstoned(
        BrokerJournalTombstonedPayload(
          tombstonedAt: try JournalTimestamp(canonicalText: cursor.parseString())
        )
      )
    }
    try cursor.endObject()
    return payload
  }

  private struct DecodedStagePayload {
    let attemptID: UUID
    let operationID: UUID
    let expectedFence: UInt64
    let candidate: BrokerJournalCredentialGeneration
    let previousReady: BrokerJournalReadyGeneration?
    let startedAt: JournalTimestamp
  }

  private static func decodeStagePayload(
    from cursor: inout BrokerJournalCanonicalJSONCursor
  ) throws(BrokerJournalError) -> DecodedStagePayload {
    let identifiers = try decodeAttemptAndOperation(from: &cursor)
    try cursor.expect(",\"expectedFence\":")
    let expectedFence = try cursor.parseUInt64()
    try cursor.expect(",\"candidate\":")
    let candidate = try decodeCredentialGeneration(from: &cursor)
    try cursor.expect(",\"previousReady\":")
    let previousReady = try decodeOptionalReadyGeneration(from: &cursor)
    try cursor.expect(",\"startedAt\":")
    let startedAt = try JournalTimestamp(canonicalText: cursor.parseString())
    return DecodedStagePayload(
      attemptID: identifiers.attemptID,
      operationID: identifiers.operationID,
      expectedFence: expectedFence,
      candidate: candidate,
      previousReady: previousReady,
      startedAt: startedAt
    )
  }

  private static func decodeAttemptAndOperation(
    from cursor: inout BrokerJournalCanonicalJSONCursor
  ) throws(BrokerJournalError) -> (attemptID: UUID, operationID: UUID) {
    try cursor.expect("\"attemptID\":")
    let attemptID = try parseCanonicalUUID(cursor.parseString())
    try cursor.expect(",\"operationID\":")
    let operationID = try parseCanonicalUUID(cursor.parseString())
    return (attemptID, operationID)
  }

  private static func decodeCredentialGeneration(
    from cursor: inout BrokerJournalCanonicalJSONCursor
  ) throws(BrokerJournalError) -> BrokerJournalCredentialGeneration {
    try cursor.beginObject()
    try cursor.expect("\"generationID\":")
    let generationID = try parseCanonicalUUID(cursor.parseString())
    try cursor.expect(",\"ordinal\":")
    let ordinal = try cursor.parseUInt64()
    try cursor.expect(",\"createdAt\":")
    let createdAt = try JournalTimestamp(canonicalText: cursor.parseString())
    try cursor.endObject()
    return BrokerJournalCredentialGeneration(
      generationID: generationID,
      ordinal: ordinal,
      createdAt: createdAt
    )
  }

  private static func decodeReadyGeneration(
    from cursor: inout BrokerJournalCanonicalJSONCursor
  ) throws(BrokerJournalError) -> BrokerJournalReadyGeneration {
    try cursor.beginObject()
    try cursor.expect("\"generation\":")
    let generation = try decodeCredentialGeneration(from: &cursor)
    try cursor.expect(",\"committedAt\":")
    let committedAt = try JournalTimestamp(canonicalText: cursor.parseString())
    try cursor.endObject()
    return BrokerJournalReadyGeneration(generation: generation, committedAt: committedAt)
  }

  private static func decodeOptionalReadyGeneration(
    from cursor: inout BrokerJournalCanonicalJSONCursor
  ) throws(BrokerJournalError) -> BrokerJournalReadyGeneration? {
    if cursor.consume("null") { return nil }
    return try decodeReadyGeneration(from: &cursor)
  }

  private static func decodeReadyProjection(
    from cursor: inout BrokerJournalCanonicalJSONCursor
  ) throws(BrokerJournalError) -> BrokerJournalReadyProjection {
    try cursor.beginObject()
    try cursor.expect("\"connectionID\":")
    let connectionID = try parseCanonicalUUID(cursor.parseString())
    try cursor.expect(",\"fence\":")
    let fence = try cursor.parseUInt64()
    try cursor.expect(",\"ready\":")
    let ready = try decodeReadyGeneration(from: &cursor)
    try cursor.expect(",\"lastGenerationOrdinal\":")
    let lastGenerationOrdinal = try cursor.parseUInt64()
    try cursor.endObject()
    return BrokerJournalReadyProjection(
      connectionID: connectionID,
      fence: fence,
      ready: ready,
      lastGenerationOrdinal: lastGenerationOrdinal
    )
  }

  private static func decodeOptionalReadyProjection(
    from cursor: inout BrokerJournalCanonicalJSONCursor
  ) throws(BrokerJournalError) -> BrokerJournalReadyProjection? {
    if cursor.consume("null") { return nil }
    return try decodeReadyProjection(from: &cursor)
  }

  private static func decodeTombstoneProjection(
    from cursor: inout BrokerJournalCanonicalJSONCursor
  ) throws(BrokerJournalError) -> BrokerJournalTombstoneProjection {
    try cursor.beginObject()
    try cursor.expect("\"connectionID\":")
    let connectionID = try parseCanonicalUUID(cursor.parseString())
    try cursor.expect(",\"fence\":")
    let fence = try cursor.parseUInt64()
    try cursor.expect(",\"lastGenerationOrdinal\":")
    let lastGenerationOrdinal = try cursor.parseUInt64()
    try cursor.expect(",\"tombstonedAt\":")
    let tombstonedAt = try JournalTimestamp(canonicalText: cursor.parseString())
    try cursor.endObject()
    return BrokerJournalTombstoneProjection(
      connectionID: connectionID,
      fence: fence,
      lastGenerationOrdinal: lastGenerationOrdinal,
      tombstonedAt: tombstonedAt
    )
  }

  private static func decodeCredentialGenerations(
    from cursor: inout BrokerJournalCanonicalJSONCursor
  ) throws(BrokerJournalError) -> [BrokerJournalCredentialGeneration] {
    try cursor.beginArray()
    var values: [BrokerJournalCredentialGeneration] = []
    if cursor.isNext("]") {
      try cursor.endArray()
      return values
    }
    while true {
      guard values.count < 2 else { throw .invalidRecord }
      values.append(try decodeCredentialGeneration(from: &cursor))
      if cursor.consume(",") { continue }
      try cursor.endArray()
      return values
    }
  }

  private static func decodeTerminalOperations(
    from cursor: inout BrokerJournalCanonicalJSONCursor
  ) throws(BrokerJournalError) -> [BrokerJournalTerminalOperation] {
    try cursor.beginArray()
    var values: [BrokerJournalTerminalOperation] = []
    if cursor.isNext("]") {
      try cursor.endArray()
      return values
    }
    while true {
      guard values.count < 64 else { throw .invalidRecord }
      values.append(try decodeTerminalOperation(from: &cursor))
      if cursor.consume(",") { continue }
      try cursor.endArray()
      return values
    }
  }

  private static func decodeTerminalOperation(
    from cursor: inout BrokerJournalCanonicalJSONCursor
  ) throws(BrokerJournalError) -> BrokerJournalTerminalOperation {
    try cursor.beginObject()
    try cursor.expect("\"operationID\":")
    let operationID = try parseCanonicalUUID(cursor.parseString())
    try cursor.expect(",\"kind\":")
    let kind = try parseTerminalKind(cursor.parseString())
    try cursor.expect(",\"expectedFence\":")
    let expectedFence = try cursor.parseUInt64()
    let operation: BrokerJournalTerminalOperation
    switch kind {
    case .stageFailure:
      try cursor.expect(",\"result\":")
      try cursor.beginObject()
      try cursor.expect("\"error\":")
      let error = try parseStageError(cursor.parseString())
      try cursor.endObject()
      operation = .stageFailure(
        BrokerJournalStageFailureTerminal(
          operationID: operationID,
          expectedFence: expectedFence,
          error: error
        )
      )
    case .commit:
      try cursor.expect(",\"attemptID\":")
      let attemptID = try parseCanonicalUUID(cursor.parseString())
      try cursor.expect(",\"result\":")
      try cursor.beginObject()
      try cursor.expect("\"ready\":")
      let ready = try decodeReadyProjection(from: &cursor)
      try cursor.endObject()
      operation = .commit(
        BrokerJournalCommitTerminal(
          operationID: operationID,
          expectedFence: expectedFence,
          attemptID: attemptID,
          ready: ready
        )
      )
    case .abort:
      try cursor.expect(",\"attemptID\":")
      let attemptID = try parseCanonicalUUID(cursor.parseString())
      try cursor.expect(",\"result\":")
      try cursor.beginObject()
      try cursor.expect("\"restoredReady\":")
      let restoredReady = try decodeOptionalReadyProjection(from: &cursor)
      try cursor.endObject()
      operation = .abort(
        BrokerJournalAbortTerminal(
          operationID: operationID,
          expectedFence: expectedFence,
          attemptID: attemptID,
          restoredReady: restoredReady
        )
      )
    case .disconnect:
      try cursor.expect(",\"result\":")
      try cursor.beginObject()
      try cursor.expect("\"tombstone\":")
      let tombstone = try decodeTombstoneProjection(from: &cursor)
      try cursor.endObject()
      operation = .disconnect(
        BrokerJournalDisconnectTerminal(
          operationID: operationID,
          expectedFence: expectedFence,
          tombstone: tombstone
        )
      )
    }
    try cursor.endObject()
    return operation
  }

  private static func parsePhase(_ value: String) throws(BrokerJournalError) -> BrokerJournalPhase {
    switch value {
    case "vacant": .vacant
    case "storePending": .storePending
    case "staging": .staging
    case "readyCleanupPending": .readyCleanupPending
    case "ready": .ready
    case "stageCleanupPending": .stageCleanupPending
    case "abortCleanupPending": .abortCleanupPending
    case "disconnectFenced": .disconnectFenced
    case "tombstoned": .tombstoned
    default: throw .invalidRecord
    }
  }

  private static func parseTerminalKind(
    _ value: String
  ) throws(BrokerJournalError) -> BrokerJournalTerminalKind {
    switch value {
    case "stageFailure": .stageFailure
    case "commit": .commit
    case "abort": .abort
    case "disconnect": .disconnect
    default: throw .invalidRecord
    }
  }

  private static func parseStageError(
    _ value: String
  ) throws(BrokerJournalError) -> BrokerJournalStageError {
    switch value {
    case "cancelled": .cancelled
    case "storeUnavailable": .storeUnavailable
    case "attemptNotCurrent": .attemptNotCurrent
    default: throw .invalidRecord
    }
  }

  private static func canonicalUUID(_ value: UUID) -> String {
    value.uuidString.lowercased()
  }

  private static func parseCanonicalUUID(_ value: String) throws(BrokerJournalError) -> UUID {
    guard
      value.utf8.count == 36,
      value == value.lowercased(),
      let identifier = UUID(uuidString: value),
      canonicalUUID(identifier) == value
    else {
      throw .invalidRecord
    }
    return identifier
  }

}
