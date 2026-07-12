import Foundation
import Testing

@testable import RecursBrokerCore

@Suite("Broker journal store contracts")
struct BrokerJournalStoreContractTests {
  @Test
  func snapshotIsAnImmutableRecordAndAuthenticationTagValue() throws {
    let record = try vacantRecord()
    let tag = try JournalAuthenticationTag(bytes: [UInt8](repeating: 0x5a, count: 32))
    let snapshot = BrokerJournalSnapshot(record: record, authenticationTag: tag)

    #expect(snapshot.record == record)
    #expect(snapshot.authenticationTag == tag)
    #expect(Set([snapshot, snapshot]).count == 1)
  }

  @Test
  func actorProtocolsAcceptTheExactRequiredMethodSurfaces() async throws {
    let connectionID = UUID(uuidString: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")!
    let record = try vacantRecord(connectionID: connectionID)
    let authenticator: any BrokerJournalAuthenticator = ContractAuthenticator()
    let store: any BrokerJournalStore = ContractStore(record: record)

    let tag = try await authenticator.authenticate(
      previousTag: .zero,
      canonicalRecord: Data("record".utf8)
    )
    try await authenticator.verify(
      previousTag: .zero,
      canonicalRecord: Data("record".utf8),
      tag: tag
    )
    #expect(try await authenticator.anchor(for: connectionID) == nil)
    #expect(try await authenticator.listAnchors().isEmpty)
    try await authenticator.compareAndSwapAnchor(
      expected: nil,
      replacement: BrokerJournalAnchor(
        connectionID: connectionID,
        revision: 1,
        authenticationTag: tag
      )
    )

    #expect(try await store.list().isEmpty)
    #expect(try await store.load(connectionID: connectionID) == nil)
    #expect(
      try await store.compareAndSwap(expected: nil, replacement: record).record == record
    )
  }

  private func vacantRecord(
    connectionID: UUID = UUID(uuidString: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")!
  ) throws -> BrokerJournalRecord {
    try BrokerJournalRecord(
      revision: 1,
      connectionID: connectionID,
      fence: 0,
      lastGenerationOrdinal: 0,
      changedAt: JournalTimestamp(canonicalText: "2026-07-13T00:00:00.000Z"),
      payload: .vacant(BrokerJournalVacantPayload())
    )
  }
}

private actor ContractAuthenticator: BrokerJournalAuthenticator {
  func authenticate(
    previousTag: JournalAuthenticationTag,
    canonicalRecord: Data
  ) async throws(BrokerJournalError) -> JournalAuthenticationTag {
    .zero
  }

  func verify(
    previousTag: JournalAuthenticationTag,
    canonicalRecord: Data,
    tag: JournalAuthenticationTag
  ) async throws(BrokerJournalError) {}

  func anchor(
    for connectionID: UUID
  ) async throws(BrokerJournalError) -> BrokerJournalAnchor? {
    nil
  }

  func listAnchors() async throws(BrokerJournalError) -> [BrokerJournalAnchor] {
    []
  }

  func compareAndSwapAnchor(
    expected: BrokerJournalAnchor?,
    replacement: BrokerJournalAnchor
  ) async throws(BrokerJournalError) {}
}

private actor ContractStore: BrokerJournalStore {
  let record: BrokerJournalRecord

  init(record: BrokerJournalRecord) {
    self.record = record
  }

  func list() async throws(BrokerJournalError) -> [BrokerJournalSnapshot] {
    []
  }

  func load(
    connectionID: UUID
  ) async throws(BrokerJournalError) -> BrokerJournalSnapshot? {
    nil
  }

  func compareAndSwap(
    expected: BrokerJournalSnapshot?,
    replacement: BrokerJournalRecord
  ) async throws(BrokerJournalError) -> BrokerJournalSnapshot {
    BrokerJournalSnapshot(record: record, authenticationTag: .zero)
  }
}
