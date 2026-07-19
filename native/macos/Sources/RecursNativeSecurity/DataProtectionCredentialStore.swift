import Foundation
import RecursBrokerCore
import Security

package actor DataProtectionCredentialStore: CredentialStore {
  private static let credentialMarker = Data("credential.v1".utf8)

  private let client: KeychainClient
  private let configuration: KeychainStoreConfiguration

  package init(configuration: KeychainStoreConfiguration) {
    self.client = .live
    self.configuration = configuration
  }

  init(client: KeychainClient, configuration: KeychainStoreConfiguration) {
    self.client = client
    self.configuration = configuration
  }

  package func store(
    _ secret: sending SecretBytes,
    for key: CredentialStoreKey
  ) async throws(CredentialStoreError) {
    defer { secret.erase() }
    var data = secret.withUnsafeBytes { Data($0) }
    defer { eraseData(&data) }
    let status = client.add(
      credentialQuery(for: key).adding([
        kSecValueData: data
      ])
    )
    switch status {
    case errSecSuccess:
      return
    case errSecDuplicateItem, errSecInteractionNotAllowed, errSecNotAvailable,
      errSecAuthFailed:
      throw .unavailable
    default:
      throw .mutationOutcomeUnknown
    }
  }

  package func load(
    for key: CredentialStoreKey
  ) async throws(CredentialStoreError) -> sending SecretBytes {
    let account = Self.account(for: key)
    let result = client.copyMatching(
      credentialQuery(for: key).adding([
        kSecReturnData: true,
        kSecReturnAttributes: true,
        kSecMatchLimit: kSecMatchLimitOne,
      ])
    )
    guard result.status == errSecSuccess else {
      throw .unavailable
    }
    guard
      result.items.count == 1,
      result.items[0].account == account,
      result.items[0].generic == Self.credentialMarker
    else {
      throw .unavailable
    }
    return SecretBytes(result.items[0].data)
  }

  package func deleteIfPresent(
    _ key: CredentialStoreKey
  ) async throws(CredentialStoreError) {
    let status = client.delete(credentialQuery(for: key, includeMarker: false))
    switch status {
    case errSecSuccess, errSecItemNotFound:
      return
    case errSecInteractionNotAllowed, errSecNotAvailable, errSecAuthFailed:
      throw .unavailable
    default:
      throw .mutationOutcomeUnknown
    }
  }

  private func credentialQuery(
    for key: CredentialStoreKey,
    includeMarker: Bool = true
  ) -> KeychainQuery {
    KeychainQuery.base(
      configuration: configuration,
      service: "com.recurs.cli.credentials.v1",
      generic: includeMarker ? Self.credentialMarker : nil
    ).adding([kSecAttrAccount: Self.account(for: key)])
  }

  private static func account(for key: CredentialStoreKey) -> String {
    [
      key.connectionID.uuidString.lowercased(),
      key.generationID.uuidString.lowercased(),
      String(key.generationOrdinal),
    ].joined(separator: "/")
  }
}
