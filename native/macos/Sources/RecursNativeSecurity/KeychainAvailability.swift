import Foundation
import Security

package enum KeychainAvailabilityStatus: Sendable, Equatable {
  case available
  case locked
  case unavailable
}

package struct DataProtectionKeychainAvailabilityProbe: Sendable {
  private static let service = "com.recurs.cli.availability.v1"
  private static let account = "availability.v1"
  private static let marker = Data("availability.v1".utf8)
  private static let value = Data("available.v1".utf8)

  private let client: KeychainClient
  private let configuration: KeychainStoreConfiguration

  package init(configuration: KeychainStoreConfiguration) {
    self.client = .live
    self.configuration = configuration
  }

  init(
    client: KeychainClient,
    configuration: KeychainStoreConfiguration
  ) {
    self.client = client
    self.configuration = configuration
  }

  package func status() -> KeychainAvailabilityStatus {
    let addStatus = client.add(
      baseQuery().adding([kSecValueData: Self.value])
    )
    switch addStatus {
    case errSecSuccess, errSecDuplicateItem:
      break
    case errSecInteractionNotAllowed:
      return .locked
    default:
      return .unavailable
    }

    let result = client.copyMatching(
      baseQuery().adding([
        kSecReturnData: true,
        kSecReturnAttributes: true,
        kSecMatchLimit: kSecMatchLimitOne,
      ])
    )
    switch result.status {
    case errSecInteractionNotAllowed:
      return .locked
    case errSecSuccess:
      guard
        result.items
          == [
            KeychainItem(
              account: Self.account,
              data: Self.value,
              generic: Self.marker
            )
          ]
      else {
        return .unavailable
      }
      return .available
    default:
      return .unavailable
    }
  }

  private func baseQuery() -> KeychainQuery {
    KeychainQuery.base(
      configuration: configuration,
      service: Self.service,
      generic: Self.marker
    ).adding([kSecAttrAccount: Self.account])
  }
}
