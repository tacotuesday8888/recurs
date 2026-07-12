import Foundation

package struct BrokerJournalSnapshot: Sendable, Hashable {
  package let record: BrokerJournalRecord
  package let authenticationTag: JournalAuthenticationTag

  package init(
    record: BrokerJournalRecord,
    authenticationTag: JournalAuthenticationTag
  ) {
    self.record = record
    self.authenticationTag = authenticationTag
  }
}

package protocol BrokerJournalAuthenticator: Actor {
  func authenticate(
    previousTag: JournalAuthenticationTag,
    canonicalRecord: Data
  ) async throws(BrokerJournalError) -> JournalAuthenticationTag

  func verify(
    previousTag: JournalAuthenticationTag,
    canonicalRecord: Data,
    tag: JournalAuthenticationTag
  ) async throws(BrokerJournalError)

  func anchor(
    for connectionID: UUID
  ) async throws(BrokerJournalError) -> BrokerJournalAnchor?

  func listAnchors() async throws(BrokerJournalError) -> [BrokerJournalAnchor]

  func compareAndSwapAnchor(
    expected: BrokerJournalAnchor?,
    replacement: BrokerJournalAnchor
  ) async throws(BrokerJournalError)
}

package protocol BrokerJournalStore: Actor {
  func list() async throws(BrokerJournalError) -> [BrokerJournalSnapshot]

  func load(
    connectionID: UUID
  ) async throws(BrokerJournalError) -> BrokerJournalSnapshot?

  func compareAndSwap(
    expected: BrokerJournalSnapshot?,
    replacement: BrokerJournalRecord
  ) async throws(BrokerJournalError) -> BrokerJournalSnapshot
}
