import Foundation
import Testing

@testable import RecursBrokerCore

@Suite("Canonical broker journal codec")
struct BrokerJournalCodecTests {
  private let connectionID = UUID(uuidString: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")!

  private func vacantRecord() throws -> BrokerJournalRecord {
    try BrokerJournalRecord(
      revision: 1,
      connectionID: connectionID,
      fence: 0,
      lastGenerationOrdinal: 0,
      changedAt: JournalTimestamp(canonicalText: "2026-07-13T00:00:00.000Z"),
      payload: .vacant(BrokerJournalVacantPayload())
    )
  }

  @Test
  func vacantEnvelopeUsesExactGoldenBytesAndRoundTrips() throws {
    let envelope = BrokerJournalEnvelope(
      previousAuthTag: .zero,
      authTag: try JournalAuthenticationTag(bytes: [UInt8](repeating: 1, count: 32)),
      record: try vacantRecord()
    )
    let expected = expectedEnvelope()

    #expect(try BrokerJournalCodec.canonicalRecordData(for: envelope.record) == expectedRecord())
    #expect(try BrokerJournalCodec.encode(envelope) == expected)
    #expect(try BrokerJournalCodec.decode(expected) == envelope)
  }

  @Test
  func byteLevelNoncanonicalInputsAreRejected() throws {
    let canonical = expectedEnvelope()

    var bom = canonical
    bom.insert(contentsOf: [0xef, 0xbb, 0xbf], at: bom.startIndex)

    var invalidUTF8 = canonical
    let phaseRange = try #require(invalidUTF8.range(of: Data(#""vacant""#.utf8)))
    invalidUTF8[invalidUTF8.index(after: phaseRange.lowerBound)] = 0xff

    var whitespace = canonical
    whitespace.insert(0x20, at: whitespace.index(after: whitespace.startIndex))

    var trailing = canonical
    trailing.append(0x00)

    let hostileCases: [(name: String, bytes: Data)] = [
      ("UTF-8 BOM prefix", bom),
      ("invalid UTF-8 inside a JSON string", invalidUTF8),
      ("inserted insignificant whitespace", whitespace),
      ("trailing byte", trailing),
    ]
    for testCase in hostileCases {
      do {
        _ = try BrokerJournalCodec.decode(testCase.bytes)
        Issue.record("Accepted hostile input: \(testCase.name)")
      } catch let error {
        #expect(error == .nonCanonical, Comment(rawValue: testCase.name))
      }
    }
  }

  @Test
  func structurallyNoncanonicalInputsAreRejected() throws {
    let canonical = expectedEnvelope()

    var reordered = canonical
    let canonicalPrefix = Data(
      #"{"previousAuthTag":"0000000000000000000000000000000000000000000000000000000000000000","authTag":"0101010101010101010101010101010101010101010101010101010101010101","record":"#
        .utf8
    )
    let reorderedPrefix = Data(
      #"{"authTag":"0101010101010101010101010101010101010101010101010101010101010101","previousAuthTag":"0000000000000000000000000000000000000000000000000000000000000000","record":"#
        .utf8
    )
    let prefixRange = try #require(reordered.range(of: canonicalPrefix))
    reordered.replaceSubrange(prefixRange, with: reorderedPrefix)

    let revisionField = Data(#""revision":1,"#.utf8)
    let revisionRange = try #require(canonical.range(of: revisionField))

    var duplicate = canonical
    duplicate.insert(contentsOf: revisionField, at: revisionRange.upperBound)

    var unknown = canonical
    unknown.insert(
      contentsOf: Data(#""unknown":null,"#.utf8),
      at: revisionRange.upperBound
    )

    var missing = canonical
    missing.removeSubrange(revisionRange)

    let hostileCases: [(name: String, bytes: Data)] = [
      ("reordered top-level fields", reordered),
      ("duplicate record field", duplicate),
      ("unknown record field", unknown),
      ("missing required record field", missing),
    ]
    for testCase in hostileCases {
      do {
        _ = try BrokerJournalCodec.decode(testCase.bytes)
        Issue.record("Accepted hostile input: \(testCase.name)")
      } catch let error {
        #expect(error == .nonCanonical, Comment(rawValue: testCase.name))
      }
    }
  }

  @Test
  func hostileScalarValuesMapToExactErrors() throws {
    let canonical = expectedEnvelope()
    func replacing(_ field: String, with replacement: String) throws -> Data {
      var mutated = canonical
      let range = try #require(mutated.range(of: Data(field.utf8)))
      mutated.replaceSubrange(range, with: replacement.utf8)
      return mutated
    }

    let hostileCases: [(name: String, bytes: Data, error: BrokerJournalError)] = [
      (
        "revision with leading zero",
        try replacing(#""revision":1"#, with: #""revision":01"#),
        .nonCanonical
      ),
      (
        "revision with plus sign",
        try replacing(#""revision":1"#, with: #""revision":+1"#),
        .nonCanonical
      ),
      (
        "revision with minus sign",
        try replacing(#""revision":1"#, with: #""revision":-1"#),
        .nonCanonical
      ),
      (
        "revision exceeding UInt64",
        try replacing(
          #""revision":1"#,
          with: #""revision":18446744073709551616"#
        ),
        .invalidRecord
      ),
      (
        "uppercase UUID",
        try replacing(
          #""connectionID":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee""#,
          with: #""connectionID":"AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE""#
        ),
        .invalidRecord
      ),
      (
        "noncanonical timestamp",
        try replacing(
          #""changedAt":"2026-07-13T00:00:00.000Z""#,
          with: #""changedAt":"2026-07-13T00:00:00Z""#
        ),
        .invalidRecord
      ),
      (
        "unsupported schema version",
        try replacing(#""schemaVersion":1"#, with: #""schemaVersion":2"#),
        .unsupportedVersion
      ),
    ]
    for testCase in hostileCases {
      do {
        _ = try BrokerJournalCodec.decode(testCase.bytes)
        Issue.record("Accepted hostile input: \(testCase.name)")
      } catch let error {
        #expect(error == testCase.error, Comment(rawValue: testCase.name))
      }
    }
  }

  @Test
  func hostileSchemaShapesMapToExactErrors() throws {
    func encoded(_ record: BrokerJournalRecord) throws -> Data {
      try BrokerJournalCodec.encode(
        BrokerJournalEnvelope(
          previousAuthTag: .zero,
          authTag: try JournalAuthenticationTag(bytes: [UInt8](repeating: 3, count: 32)),
          record: record
        )
      )
    }
    func replacing(_ source: Data, _ field: String, with replacement: String) throws -> Data {
      var mutated = source
      let range = try #require(mutated.range(of: Data(field.utf8)))
      mutated.replaceSubrange(range, with: replacement.utf8)
      return mutated
    }

    let phases = try phaseRecords()
    let vacant = try encoded(phases[0])
    let stagingWithNull = try encoded(phases[2])
    let cleanupWithError = try encoded(phases[5])
    let terminals = try encoded(terminalRecords()[0])

    let hostileCases: [(name: String, bytes: Data, error: BrokerJournalError)] = [
      (
        "unknown phase",
        try replacing(vacant, #""phase":"vacant""#, with: #""phase":"future""#),
        .invalidRecord
      ),
      (
        "unknown terminal kind",
        try replacing(
          terminals,
          #""kind":"stageFailure""#,
          with: #""kind":"future""#
        ),
        .invalidRecord
      ),
      (
        "unknown stage error",
        try replacing(
          cleanupWithError,
          #""error":"attemptNotCurrent""#,
          with: #""error":"future""#
        ),
        .invalidRecord
      ),
      (
        "required null field omitted",
        try replacing(stagingWithNull, #","previousReady":null"#, with: ""),
        .nonCanonical
      ),
      (
        "required null replaced with wrong value",
        try replacing(
          stagingWithNull,
          #""previousReady":null"#,
          with: #""previousReady":false"#
        ),
        .nonCanonical
      ),
      (
        "payload replaced with array",
        try replacing(vacant, #""payload":{}"#, with: #""payload":[]"#),
        .nonCanonical
      ),
      (
        "terminal array replaced with object",
        try replacing(
          vacant,
          #""terminalOperations":[]"#,
          with: #""terminalOperations":{}"#
        ),
        .nonCanonical
      ),
      (
        "terminal result object replaced with array",
        try replacing(
          terminals,
          #""result":{"error":"cancelled"}"#,
          with: #""result":[]"#
        ),
        .nonCanonical
      ),
      (
        "array closing delimiter corrupted",
        try replacing(
          vacant,
          #""terminalOperations":[]"#,
          with: #""terminalOperations":[}"#
        ),
        .nonCanonical
      ),
      (
        "object closing delimiter corrupted",
        try replacing(vacant, #""payload":{}"#, with: #""payload":{]"#),
        .nonCanonical
      ),
    ]
    for testCase in hostileCases {
      do {
        _ = try BrokerJournalCodec.decode(testCase.bytes)
        Issue.record("Accepted hostile input: \(testCase.name)")
      } catch let error {
        #expect(error == testCase.error, Comment(rawValue: testCase.name))
      }
    }
  }

  @Test
  func hostileBoundsAndEnvelopeValuesMapToExactErrors() throws {
    func replacing(_ source: Data, _ field: String, with replacement: String) throws -> Data {
      var mutated = source
      let range = try #require(mutated.range(of: Data(field.utf8)))
      mutated.replaceSubrange(range, with: replacement.utf8)
      return mutated
    }
    func encoded(_ record: BrokerJournalRecord) throws -> Data {
      try BrokerJournalCodec.encode(
        BrokerJournalEnvelope(
          previousAuthTag: .zero,
          authTag: try JournalAuthenticationTag(bytes: [UInt8](repeating: 4, count: 32)),
          record: record
        )
      )
    }
    func tagField(_ name: String, _ value: String) -> String {
      "\"\(name)\":\"\(value)\""
    }

    let canonical = expectedEnvelope()
    let previousHex = String(repeating: "0", count: 64)
    let authHex = String(repeating: "01", count: 32)
    let previousField = tagField("previousAuthTag", previousHex)
    let authField = tagField("authTag", authHex)

    let terminalOperation =
      #"{"operationID":"00000000-0000-4000-8000-000000000022","kind":"stageFailure","expectedFence":0,"result":{"error":"cancelled"}}"#
    let terminalArray = Array(repeating: terminalOperation, count: 65).joined(separator: ",")
    let tooManyTerminals = try replacing(
      canonical,
      #""terminalOperations":[]"#,
      with: "\"terminalOperations\":[\(terminalArray)]"
    )

    let credentialGeneration =
      #"{"generationID":"00000000-0000-4000-8000-000000000011","ordinal":2,"createdAt":"2026-07-13T00:00:00.000Z"}"#
    let disconnect = try encoded(phaseRecords()[7])
    let tooManyGenerations = try replacing(
      disconnect,
      #"]},"terminalOperations":[]"#,
      with: ",\(credentialGeneration)]},\"terminalOperations\":[]"
    )

    let nestedPayload =
      "\"payload\":" + String(repeating: "{", count: 13)
      + String(repeating: "}", count: 13)

    let hostileCases: [(name: String, bytes: Data, error: BrokerJournalError)] = [
      (
        "previous tag wrong length",
        try replacing(
          canonical,
          previousField,
          with: tagField("previousAuthTag", String(previousHex.dropLast()))
        ),
        .invalidRecord
      ),
      (
        "auth tag wrong length",
        try replacing(
          canonical,
          authField,
          with: tagField("authTag", String(authHex.dropLast()))
        ),
        .invalidRecord
      ),
      (
        "previous tag uppercase",
        try replacing(
          canonical,
          previousField,
          with: tagField("previousAuthTag", "A" + String(previousHex.dropFirst()))
        ),
        .invalidRecord
      ),
      (
        "auth tag uppercase",
        try replacing(
          canonical,
          authField,
          with: tagField("authTag", "A" + String(authHex.dropFirst()))
        ),
        .invalidRecord
      ),
      (
        "previous tag nonhex",
        try replacing(
          canonical,
          previousField,
          with: tagField("previousAuthTag", "g" + String(previousHex.dropFirst()))
        ),
        .invalidRecord
      ),
      (
        "auth tag nonhex",
        try replacing(
          canonical,
          authField,
          with: tagField("authTag", "g" + String(authHex.dropFirst()))
        ),
        .invalidRecord
      ),
      (
        "envelope exceeds byte limit",
        Data(repeating: 0x20, count: SecureDirectory.maximumEnvelopeBytes + 1),
        .invalidRecord
      ),
      ("terminal array exceeds count limit", tooManyTerminals, .invalidRecord),
      ("deleteGenerations exceeds count limit", tooManyGenerations, .invalidRecord),
      (
        "impossible nested payload injection",
        try replacing(canonical, #""payload":{}"#, with: nestedPayload),
        .nonCanonical
      ),
    ]
    for testCase in hostileCases {
      do {
        _ = try BrokerJournalCodec.decode(testCase.bytes)
        Issue.record("Accepted hostile input: \(testCase.name)")
      } catch let error {
        #expect(error == testCase.error, Comment(rawValue: testCase.name))
      }
    }
  }

  @Test
  func allNinePhasesAndEveryTerminalVariantRoundTripCanonically() throws {
    let records = try phaseRecords() + terminalRecords()
    #expect(Set(records.map(\.phase)).count == 9)

    for record in records {
      let envelope = BrokerJournalEnvelope(
        previousAuthTag: .zero,
        authTag: try JournalAuthenticationTag(bytes: [UInt8](repeating: 2, count: 32)),
        record: record
      )
      let encoded = try BrokerJournalCodec.encode(envelope)
      #expect(encoded.count <= SecureDirectory.maximumEnvelopeBytes)
      #expect(try BrokerJournalCodec.decode(encoded) == envelope)
      #expect(try BrokerJournalCodec.encode(BrokerJournalCodec.decode(encoded)) == encoded)
    }
  }

  @Test
  func everyPhasePayloadAndTerminalVariantEncodesInCanonicalKeyOrder() throws {
    let records = try phaseRecords() + terminalRecords()
    let encoded = try records.map { record in
      String(decoding: try BrokerJournalCodec.canonicalRecordData(for: record), as: UTF8.self)
    }
    let phaseNames = [
      "vacant", "storePending", "staging", "readyCleanupPending", "ready",
      "stageCleanupPending", "abortCleanupPending", "disconnectFenced", "tombstoned",
    ]
    for phase in phaseNames {
      #expect(encoded.contains(where: { $0.contains(#""phase":"\#(phase)""#) }))
    }
    for fragment in [
      #""payload":{"attemptID":"#, #""previousReady":"#, #""restoredReady":"#,
      #""deleteGenerations":["#, #""kind":"stageFailure""#,
      #""kind":"commit""#, #""kind":"abort""#, #""kind":"disconnect""#,
    ] {
      #expect(encoded.contains(where: { $0.contains(fragment) }), Comment(rawValue: fragment))
    }
  }

  @Test
  func recordScannerRejectsForbiddenAndConfusableKeysAndSecretLikeValues() throws {
    let hostileRecords: [(name: String, bytes: Data)] = [
      ("forbidden key", Data(#"{"auth":"safe"}"#.utf8)),
      ("confusable key", Data(#"{"ｔｏｋｅｎ":"safe"}"#.utf8)),
      ("provider token", Data(#"{"value":"sk-proj-AAAAAAAAAAAAAAAA"}"#.utf8)),
      ("private key", Data(#"{"value":"-----BEGIN PRIVATE KEY-----"}"#.utf8)),
      (
        "long hex",
        Data(#"{"value":"0123456789abcdef0123456789abcdef0123456789abcdef"}"#.utf8)
      ),
    ]

    for hostile in hostileRecords {
      #expect(throws: BrokerJournalError.invalidRecord, Comment(rawValue: hostile.name)) {
        try BrokerJournalNonSecretScanner.validate(hostile.bytes)
      }
    }
  }

  @Test
  func recordScannerAcceptsEveryCanonicalPhaseAndTerminalRecord() throws {
    for record in try phaseRecords() + terminalRecords() {
      let canonical = try BrokerJournalCodec.canonicalRecordData(for: record)
      try BrokerJournalNonSecretScanner.validate(canonical)
    }
  }

  @Test
  func authenticationTagsAreExcludedFromTheRecordScanner() throws {
    let longHex = String(repeating: "01", count: JournalAuthenticationTag.byteCount)
    #expect(throws: BrokerJournalError.invalidRecord) {
      try BrokerJournalNonSecretScanner.validate(Data(#"{"value":"\#(longHex)"}"#.utf8))
    }

    let envelope = BrokerJournalEnvelope(
      previousAuthTag: try JournalAuthenticationTag(lowercaseHex: longHex),
      authTag: try JournalAuthenticationTag(lowercaseHex: longHex),
      record: try vacantRecord()
    )
    let encoded = try BrokerJournalCodec.encode(envelope)
    #expect(try BrokerJournalCodec.decode(encoded) == envelope)
  }

  private func expectedRecord() -> Data {
    Data(
      #"{"schemaVersion":1,"revision":1,"connectionID":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","phase":"vacant","fence":0,"lastGenerationOrdinal":0,"changedAt":"2026-07-13T00:00:00.000Z","payload":{},"terminalOperations":[]}"#
        .utf8
    )
  }

  private func expectedEnvelope() -> Data {
    Data(
      #"{"previousAuthTag":"0000000000000000000000000000000000000000000000000000000000000000","authTag":"0101010101010101010101010101010101010101010101010101010101010101","record":{"schemaVersion":1,"revision":1,"connectionID":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","phase":"vacant","fence":0,"lastGenerationOrdinal":0,"changedAt":"2026-07-13T00:00:00.000Z","payload":{},"terminalOperations":[]}}"#
        .utf8
    )
  }

  private func phaseRecords() throws -> [BrokerJournalRecord] {
    let timestamp = try JournalTimestamp(canonicalText: "2026-07-13T00:00:00.000Z")
    let previous = readyGeneration(id: 10, ordinal: 1, timestamp: timestamp)
    let candidate = generation(id: 11, ordinal: 2, timestamp: timestamp)
    let ready = BrokerJournalReadyGeneration(generation: candidate, committedAt: timestamp)
    let attemptID = uuid(12)
    let operationID = uuid(13)
    let fixtures: [(BrokerJournalPayload, UInt64, UInt64)] = [
      (.vacant(BrokerJournalVacantPayload()), 0, 0),
      (
        .storePending(
          BrokerJournalStorePendingPayload(
            attemptID: attemptID,
            operationID: operationID,
            expectedFence: 1,
            candidate: candidate,
            previousReady: previous,
            startedAt: timestamp
          )
        ),
        2,
        2
      ),
      (
        .staging(
          BrokerJournalStagingPayload(
            attemptID: attemptID,
            operationID: operationID,
            expectedFence: 1,
            candidate: candidate,
            previousReady: nil,
            startedAt: timestamp
          )
        ),
        2,
        2
      ),
      (
        .readyCleanupPending(
          BrokerJournalReadyCleanupPendingPayload(
            attemptID: attemptID,
            operationID: operationID,
            expectedFence: 2,
            ready: ready,
            previousReady: previous
          )
        ),
        2,
        2
      ),
      (.ready(BrokerJournalReadyPayload(ready: ready)), 2, 2),
      (
        .stageCleanupPending(
          BrokerJournalStageCleanupPendingPayload(
            attemptID: attemptID,
            operationID: operationID,
            expectedFence: 1,
            candidate: candidate,
            restoredReady: previous,
            error: .attemptNotCurrent
          )
        ),
        2,
        2
      ),
      (
        .abortCleanupPending(
          BrokerJournalAbortCleanupPendingPayload(
            attemptID: attemptID,
            operationID: operationID,
            expectedFence: 2,
            candidate: candidate,
            restoredReady: nil
          )
        ),
        2,
        2
      ),
      (
        .disconnectFenced(
          BrokerJournalDisconnectFencedPayload(
            operationID: operationID,
            expectedFence: 2,
            tombstonedAt: timestamp,
            deleteGenerations: [candidate, previous.generation]
          )
        ),
        3,
        2
      ),
      (.tombstoned(BrokerJournalTombstonedPayload(tombstonedAt: timestamp)), 3, 2),
    ]
    return try fixtures.enumerated().map { index, fixture in
      try BrokerJournalRecord(
        revision: UInt64(index + 1),
        connectionID: connectionID,
        fence: fixture.1,
        lastGenerationOrdinal: fixture.2,
        changedAt: timestamp,
        payload: fixture.0
      )
    }
  }

  private func terminalRecords() throws -> [BrokerJournalRecord] {
    let timestamp = try JournalTimestamp(canonicalText: "2026-07-13T00:00:00.000Z")
    let previous = readyGeneration(id: 20, ordinal: 1, timestamp: timestamp)
    let candidate = generation(id: 21, ordinal: 2, timestamp: timestamp)
    let current = BrokerJournalReadyGeneration(generation: candidate, committedAt: timestamp)
    let priorProjection = BrokerJournalReadyProjection(
      connectionID: connectionID,
      fence: 1,
      ready: previous,
      lastGenerationOrdinal: 1
    )
    let readyTerminals: [BrokerJournalTerminalOperation] = [
      .stageFailure(
        BrokerJournalStageFailureTerminal(
          operationID: uuid(22), expectedFence: 0, error: .cancelled
        )
      ),
      .stageFailure(
        BrokerJournalStageFailureTerminal(
          operationID: uuid(23), expectedFence: 0, error: .storeUnavailable
        )
      ),
      .stageFailure(
        BrokerJournalStageFailureTerminal(
          operationID: uuid(24), expectedFence: 0, error: .attemptNotCurrent
        )
      ),
      .commit(
        BrokerJournalCommitTerminal(
          operationID: uuid(25),
          expectedFence: 1,
          attemptID: uuid(26),
          ready: priorProjection
        )
      ),
      .abort(
        BrokerJournalAbortTerminal(
          operationID: uuid(27),
          expectedFence: 1,
          attemptID: uuid(28),
          restoredReady: priorProjection
        )
      ),
      .abort(
        BrokerJournalAbortTerminal(
          operationID: uuid(29),
          expectedFence: 2,
          attemptID: uuid(30),
          restoredReady: nil
        )
      ),
    ]
    let readyRecord = try BrokerJournalRecord(
      revision: 10,
      connectionID: connectionID,
      fence: 2,
      lastGenerationOrdinal: 2,
      changedAt: timestamp,
      payload: .ready(BrokerJournalReadyPayload(ready: current)),
      terminalOperations: readyTerminals
    )

    let tombstone = BrokerJournalTombstoneProjection(
      connectionID: connectionID,
      fence: 3,
      lastGenerationOrdinal: 2,
      tombstonedAt: timestamp
    )
    let tombstonedRecord = try BrokerJournalRecord(
      revision: 11,
      connectionID: connectionID,
      fence: 3,
      lastGenerationOrdinal: 2,
      changedAt: timestamp,
      payload: .tombstoned(BrokerJournalTombstonedPayload(tombstonedAt: timestamp)),
      terminalOperations: [
        .disconnect(
          BrokerJournalDisconnectTerminal(
            operationID: uuid(31), expectedFence: 2, tombstone: tombstone
          )
        )
      ]
    )
    return [readyRecord, tombstonedRecord]
  }

  private func generation(
    id: Int,
    ordinal: UInt64,
    timestamp: JournalTimestamp
  ) -> BrokerJournalCredentialGeneration {
    BrokerJournalCredentialGeneration(
      generationID: uuid(id), ordinal: ordinal, createdAt: timestamp
    )
  }

  private func readyGeneration(
    id: Int,
    ordinal: UInt64,
    timestamp: JournalTimestamp
  ) -> BrokerJournalReadyGeneration {
    BrokerJournalReadyGeneration(
      generation: generation(id: id, ordinal: ordinal, timestamp: timestamp),
      committedAt: timestamp
    )
  }

  private func uuid(_ value: Int) -> UUID {
    UUID(uuidString: String(format: "00000000-0000-4000-8000-%012d", value))!
  }
}
