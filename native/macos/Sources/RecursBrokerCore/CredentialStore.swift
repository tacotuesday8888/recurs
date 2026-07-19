import Foundation

package struct CredentialStoreKey: Sendable, Hashable, Codable {
  package let connectionID: UUID
  package let generationID: UUID
  package let generationOrdinal: UInt64

  package init(
    connectionID: UUID,
    generationID: UUID,
    generationOrdinal: UInt64
  ) {
    self.connectionID = connectionID
    self.generationID = generationID
    self.generationOrdinal = generationOrdinal
  }
}

package enum CredentialStoreError: Error, Sendable, Equatable {
  case unavailable
  case mutationOutcomeUnknown
}

package protocol CredentialStore: Actor {
  func store(
    _ secret: sending SecretBytes,
    for key: CredentialStoreKey
  ) async throws(CredentialStoreError)

  func load(
    for key: CredentialStoreKey
  ) async throws(CredentialStoreError) -> sending SecretBytes

  func deleteIfPresent(
    _ key: CredentialStoreKey
  ) async throws(CredentialStoreError)
}
