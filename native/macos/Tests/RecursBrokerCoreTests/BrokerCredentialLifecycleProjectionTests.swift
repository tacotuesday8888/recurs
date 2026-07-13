import Foundation
import Testing

@testable import RecursBrokerCore

@Suite("Broker credential lifecycle projection")
struct BrokerCredentialLifecycleProjectionTests {
  @Test
  func missingAndFenceZeroVacantRemainDistinct() async throws {
    let fixture = try CredentialLifecycleFixture()
    let state = try BrokerCredentialState(
      store: InMemoryCredentialStore(),
      bootstrap: [
        .vacant(
          connectionID: fixture.primaryID,
          fence: 0,
          lastGenerationOrdinal: 0
        )
      ]
    )

    #expect(
      await state.lifecycleProjection(for: fixture.primaryID)
        == .vacant(connectionID: fixture.primaryID, fence: 0)
    )
    #expect(
      await state.lifecycleProjection(for: fixture.secondaryID)
        == .missing(connectionID: fixture.secondaryID)
    )
  }

  @Test
  func initialStagingAndDurableAbortExposeOnlyLifecycleState() async throws {
    let fixture = try CredentialLifecycleFixture()
    let harness = try await fixture.harness(record: nil)
    let attempt = try await harness.state.stage(
      connectionID: fixture.primaryID,
      operationID: fixture.stageOperationID,
      expectedFence: 0,
      secret: SecretBytes(Data("initial-stage-secret".utf8))
    )

    #expect(
      await harness.state.lifecycleProjection(for: fixture.primaryID)
        == .staging(
          connectionID: fixture.primaryID,
          fence: attempt.fence,
          attemptID: attempt.attemptID,
          hasUsableReady: false
        )
    )

    _ = try await harness.state.abort(
      connectionID: fixture.primaryID,
      attemptID: attempt.attemptID,
      operationID: fixture.abortOperationID,
      expectedFence: attempt.fence
    )
    let expected = CredentialLifecycleProjection.vacant(
      connectionID: fixture.primaryID,
      fence: attempt.fence
    )
    #expect(await harness.state.lifecycleProjection(for: fixture.primaryID) == expected)

    await harness.journal.resetEvents()
    let storeBefore = await harness.store.inspection()
    #expect(
      try await harness.state.authoritativeLifecycleProjection(for: fixture.primaryID)
        == expected
    )
    #expect(await harness.journal.events() == [.load(fixture.primaryID)])
    let storeAfter = await harness.store.inspection()
    #expect(storeAfter.loadCallCounts == storeBefore.loadCallCounts)
    #expect(storeAfter.storeCallCounts == storeBefore.storeCallCounts)
    #expect(storeAfter.deleteCallCounts == storeBefore.deleteCallCounts)
  }

  @Test
  func readyReconnectStagingAndTombstoneMapWithoutGenerationMetadata() async throws {
    let fixture = try CredentialLifecycleFixture()
    let ready = fixture.readyProjection(
      connectionID: fixture.primaryID,
      generationID: fixture.readyGenerationID,
      ordinal: 7,
      timestamp: fixture.firstTimestamp.date
    )
    let reconnect = try BrokerCredentialState(
      store: InMemoryCredentialStore(),
      bootstrap: [.ready(ready)],
      clock: { fixture.secondTimestamp.date },
      generationIDSource: { fixture.candidateGenerationID },
      attemptIDSource: { fixture.attemptID }
    )

    #expect(
      await reconnect.lifecycleProjection(for: fixture.primaryID)
        == .ready(connectionID: fixture.primaryID, fence: 7)
    )
    let attempt = try await reconnect.stage(
      connectionID: fixture.primaryID,
      operationID: fixture.stageOperationID,
      expectedFence: 7,
      secret: SecretBytes(Data("reconnect-stage-secret".utf8))
    )
    #expect(
      await reconnect.lifecycleProjection(for: fixture.primaryID)
        == .staging(
          connectionID: fixture.primaryID,
          fence: 8,
          attemptID: attempt.attemptID,
          hasUsableReady: true
        )
    )

    let disconnect = try BrokerCredentialState(
      store: InMemoryCredentialStore(),
      bootstrap: [.ready(ready)],
      clock: { fixture.secondTimestamp.date }
    )
    _ = try await disconnect.disconnect(
      connectionID: fixture.primaryID,
      operationID: fixture.disconnectOperationID,
      expectedFence: 7
    )
    #expect(
      await disconnect.lifecycleProjection(for: fixture.primaryID)
        == .tombstoned(connectionID: fixture.primaryID, fence: 8)
    )
  }

  @Test
  func equalityReflectionAndDescriptionsExcludeEncodedPrivateCanaries() async throws {
    let fixture = try CredentialLifecycleFixture()
    let fence: UInt64 = 9_876_543_211
    let firstOrdinal = fence - 1
    let secondOrdinal = fence - 2
    let firstRecord = try fixture.readyRecord(
      connectionID: fixture.primaryID,
      fence: fence,
      generationID: fixture.readyGenerationID,
      generationOrdinal: firstOrdinal,
      timestamp: fixture.firstTimestamp
    )
    let secondRecord = try fixture.readyRecord(
      connectionID: fixture.primaryID,
      fence: fence,
      generationID: fixture.alternateGenerationID,
      generationOrdinal: secondOrdinal,
      timestamp: fixture.secondTimestamp
    )
    let first = try await fixture.harness(record: firstRecord, tagByte: 0xa7)
    let second = try await fixture.harness(record: secondRecord, tagByte: 0x5c)

    let firstProjection = await first.state.lifecycleProjection(for: fixture.primaryID)
    let secondProjection = await second.state.lifecycleProjection(for: fixture.primaryID)
    #expect(firstProjection == .ready(connectionID: fixture.primaryID, fence: fence))
    #expect(firstProjection == secondProjection)

    let firstGeneration = CredentialGeneration(
      generationID: fixture.readyGenerationID,
      ordinal: firstOrdinal,
      createdAt: fixture.firstTimestamp.date
    )
    let secondGeneration = CredentialGeneration(
      generationID: fixture.alternateGenerationID,
      ordinal: secondOrdinal,
      createdAt: fixture.secondTimestamp.date
    )
    let firstKey = CredentialStoreKey(
      connectionID: fixture.primaryID,
      generationID: firstGeneration.generationID,
      generationOrdinal: firstGeneration.ordinal
    )
    let secondKey = CredentialStoreKey(
      connectionID: fixture.primaryID,
      generationID: secondGeneration.generationID,
      generationOrdinal: secondGeneration.ordinal
    )
    let encoder = JSONEncoder()
    let encodedCanaries = try [firstGeneration, secondGeneration].map {
      String(decoding: try encoder.encode($0), as: UTF8.self)
    } + [firstKey, secondKey].map {
      String(decoding: try encoder.encode($0), as: UTF8.self)
    }
    let firstTag = Array(repeating: UInt8(0xa7), count: 32)
    let secondTag = Array(repeating: UInt8(0x5c), count: 32)
    let forbidden = encodedCanaries + [
      fixture.readyGenerationID.uuidString,
      fixture.alternateGenerationID.uuidString,
      String(firstOrdinal),
      String(secondOrdinal),
      String(describing: fixture.firstTimestamp.date),
      String(describing: fixture.secondTimestamp.date),
      String(reflecting: firstKey),
      String(reflecting: secondKey),
      Data(firstTag).base64EncodedString(),
      Data(secondTag).base64EncodedString(),
      firstTag.map { String(format: "%02x", $0) }.joined(),
      secondTag.map { String(format: "%02x", $0) }.joined(),
      String(reflecting: ObjectIdentifier(first.store)),
      String(reflecting: ObjectIdentifier(second.store)),
      "generationID",
      "ordinal",
      "createdAt",
      "committedAt",
      "CredentialStoreKey",
      "JournalAuthenticationTag",
      "InMemoryCredentialStore",
    ]
    let surfaces = lifecycleProjectionSurfaces(firstProjection)
      + lifecycleProjectionSurfaces(secondProjection)
    for canary in forbidden {
      #expect(
        surfaces.allSatisfy {
          !$0.localizedCaseInsensitiveContains(canary)
        },
        "Lifecycle projection leaked private canary: \(canary)"
      )
    }
  }

  @Test
  func authoritativeJournalMismatchFailsAfterOneLoadWithoutStoreIO() async throws {
    let fixture = try CredentialLifecycleFixture()
    let record = try fixture.vacantRecord(connectionID: fixture.primaryID, fence: 0)
    let harness = try await fixture.harness(record: record, tagByte: 0x31)
    await harness.journal.replaceExternally(
      try fixture.snapshot(record, tagByte: 0xee)
    )
    await harness.journal.resetEvents()
    let storeBefore = await harness.store.inspection()

    do {
      _ = try await harness.state.authoritativeLifecycleProjection(for: fixture.primaryID)
      Issue.record("Expected authoritative lifecycle projection to reject the journal mismatch.")
    } catch let error {
      #expect(error == .casConflict)
    }

    #expect(await harness.journal.events() == [.load(fixture.primaryID)])
    let storeAfter = await harness.store.inspection()
    #expect(storeAfter.loadCallCounts == storeBefore.loadCallCounts)
    #expect(storeAfter.storeCallCounts == storeBefore.storeCallCounts)
    #expect(storeAfter.deleteCallCounts == storeBefore.deleteCallCounts)
    #expect(
      await harness.state.lifecycleProjection(for: fixture.primaryID)
        == .vacant(connectionID: fixture.primaryID, fence: 0)
    )
  }
}

private struct CredentialLifecycleFixture: Sendable {
  let primaryID = credentialLifecycleUUID(1)
  let secondaryID = credentialLifecycleUUID(2)
  let stageOperationID = credentialLifecycleUUID(10)
  let abortOperationID = credentialLifecycleUUID(11)
  let disconnectOperationID = credentialLifecycleUUID(12)
  let attemptID = credentialLifecycleUUID(20)
  let readyGenerationID = credentialLifecycleUUID(30)
  let candidateGenerationID = credentialLifecycleUUID(31)
  let alternateGenerationID = credentialLifecycleUUID(32)
  let firstTimestamp: JournalTimestamp
  let secondTimestamp: JournalTimestamp

  init() throws {
    firstTimestamp = try JournalTimestamp(canonicalText: "2026-07-13T03:14:15.926Z")
    secondTimestamp = try JournalTimestamp(canonicalText: "2026-07-13T04:27:18.281Z")
  }

  func readyProjection(
    connectionID: UUID,
    generationID: UUID,
    ordinal: UInt64,
    timestamp: Date
  ) -> ReadyProjection {
    ReadyProjection(
      connectionID: connectionID,
      fence: ordinal,
      ready: ReadyGeneration(
        generation: CredentialGeneration(
          generationID: generationID,
          ordinal: ordinal,
          createdAt: timestamp
        ),
        committedAt: timestamp
      ),
      lastGenerationOrdinal: ordinal
    )
  }

  func vacantRecord(connectionID: UUID, fence: UInt64) throws -> BrokerJournalRecord {
    try BrokerJournalRecord(
      revision: 1,
      connectionID: connectionID,
      fence: fence,
      lastGenerationOrdinal: fence,
      changedAt: firstTimestamp,
      payload: .vacant(BrokerJournalVacantPayload())
    )
  }

  func readyRecord(
    connectionID: UUID,
    fence: UInt64,
    generationID: UUID,
    generationOrdinal: UInt64,
    timestamp: JournalTimestamp
  ) throws -> BrokerJournalRecord {
    try BrokerJournalRecord(
      revision: 1,
      connectionID: connectionID,
      fence: fence,
      lastGenerationOrdinal: fence,
      changedAt: timestamp,
      payload: .ready(
        BrokerJournalReadyPayload(
          ready: BrokerJournalReadyGeneration(
            generation: BrokerJournalCredentialGeneration(
              generationID: generationID,
              ordinal: generationOrdinal,
              createdAt: timestamp
            ),
            committedAt: timestamp
          )
        )
      )
    )
  }

  func snapshot(
    _ record: BrokerJournalRecord,
    tagByte: UInt8
  ) throws -> BrokerJournalSnapshot {
    BrokerJournalSnapshot(
      record: record,
      authenticationTag: try JournalAuthenticationTag(
        bytes: Array(repeating: tagByte, count: 32)
      )
    )
  }

  func harness(
    record: BrokerJournalRecord?,
    tagByte: UInt8 = 0x41
  ) async throws -> CredentialLifecycleHarness {
    let journal = try InMemoryBrokerJournalStore(
      snapshots: try record.map { [try snapshot($0, tagByte: tagByte)] } ?? []
    )
    let store = InMemoryCredentialStore()
    let state = try await BrokerCredentialState.recovering(
      store: store,
      journal: journal,
      clock: { firstTimestamp.date },
      generationIDSource: { candidateGenerationID },
      attemptIDSource: { attemptID }
    )
    return CredentialLifecycleHarness(state: state, journal: journal, store: store)
  }
}

private struct CredentialLifecycleHarness: Sendable {
  let state: BrokerCredentialState
  let journal: InMemoryBrokerJournalStore
  let store: InMemoryCredentialStore
}

private func lifecycleProjectionSurfaces(
  _ projection: CredentialLifecycleProjection
) -> [String] {
  var dumped = ""
  dump(projection, to: &dumped)
  let mirrored = Mirror(reflecting: projection).children.map {
    "\($0.label ?? "_")=\(String(reflecting: $0.value))"
  }.joined(separator: ";")
  return [
    String(describing: projection),
    String(reflecting: projection),
    dumped,
    mirrored,
  ]
}

private func credentialLifecycleUUID(_ value: Int) -> UUID {
  UUID(
    uuidString: String(
      format: "00000000-0000-4000-8000-%012llx",
      value
    )
  )!
}
