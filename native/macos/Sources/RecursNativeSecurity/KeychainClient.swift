import Foundation
import Security

package enum KeychainStoreConfigurationError: Error, Sendable, Equatable {
  case invalidAccessGroup
  case productionSigningRequired
}

package struct KeychainStoreConfiguration: Sendable, Equatable {
  let accessGroup: String

  init(accessGroup: String) throws(KeychainStoreConfigurationError) {
    guard Self.isValidAccessGroup(accessGroup) else {
      throw .invalidAccessGroup
    }
    self.accessGroup = accessGroup
  }

  package static func production(
    bundle: Bundle = .main
  ) throws(KeychainStoreConfigurationError) -> KeychainStoreConfiguration {
    try production(
      applicationIdentifierPrefix: bundle.object(
        forInfoDictionaryKey: "AppIdentifierPrefix"
      ) as? String,
      credentialAccessGroup: bundle.object(
        forInfoDictionaryKey: "RecursCredentialAccessGroup"
      ) as? String
    )
  }

  static func production(
    applicationIdentifierPrefix: String?,
    credentialAccessGroup: String?
  ) throws(KeychainStoreConfigurationError) -> KeychainStoreConfiguration {
    guard
      let applicationIdentifierPrefix,
      let credentialAccessGroup,
      isValidApplicationIdentifierPrefix(applicationIdentifierPrefix),
      isValidGroupSuffix(credentialAccessGroup)
    else {
      throw .productionSigningRequired
    }
    do {
      return try KeychainStoreConfiguration(
        accessGroup: applicationIdentifierPrefix + credentialAccessGroup
      )
    } catch {
      throw .productionSigningRequired
    }
  }

  private static func isValidAccessGroup(_ value: String) -> Bool {
    guard let separator = value.firstIndex(of: ".") else {
      return false
    }
    let prefix = String(value[...separator])
    let suffix = String(value[value.index(after: separator)...])
    return isValidApplicationIdentifierPrefix(prefix) && isValidGroupSuffix(suffix)
  }

  private static func isValidApplicationIdentifierPrefix(_ value: String) -> Bool {
    let bytes = Array(value.utf8)
    guard bytes.count == 11, bytes.last == Character(".").asciiValue else {
      return false
    }
    return bytes.dropLast().allSatisfy {
      (Character("A").asciiValue!...Character("Z").asciiValue!).contains($0)
        || (Character("0").asciiValue!...Character("9").asciiValue!).contains($0)
    }
  }

  private static func isValidGroupSuffix(_ value: String) -> Bool {
    let bytes = Array(value.utf8)
    guard !bytes.isEmpty, bytes.count <= 255 else {
      return false
    }
    var componentLength = 0
    var previousWasHyphen = false
    for byte in bytes {
      if byte == Character(".").asciiValue {
        guard componentLength > 0, !previousWasHyphen else {
          return false
        }
        componentLength = 0
        previousWasHyphen = false
        continue
      }
      let isAlphaNumeric =
        (Character("A").asciiValue!...Character("Z").asciiValue!).contains(byte)
        || (Character("a").asciiValue!...Character("z").asciiValue!).contains(byte)
        || (Character("0").asciiValue!...Character("9").asciiValue!).contains(byte)
      let isHyphen = byte == Character("-").asciiValue
      guard isAlphaNumeric || isHyphen, !(componentLength == 0 && isHyphen) else {
        return false
      }
      componentLength += 1
      previousWasHyphen = isHyphen
    }
    return componentLength > 0 && !previousWasHyphen
  }
}

struct KeychainQuery: @unchecked Sendable {
  fileprivate let attributes: [String: Any]

  init(attributes: [String: Any]) {
    self.attributes = attributes
  }

  static func base(
    configuration: KeychainStoreConfiguration,
    service: String,
    generic: Data? = nil
  ) -> KeychainQuery {
    var attributes: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword as String,
      kSecUseDataProtectionKeychain as String: true,
      kSecAttrSynchronizable as String: false,
      kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String,
      kSecAttrService as String: service,
      kSecAttrAccessGroup as String: configuration.accessGroup,
    ]
    if let generic {
      attributes[kSecAttrGeneric as String] = generic
    }
    return KeychainQuery(attributes: attributes)
  }

  func adding(_ additions: [CFString: Any]) -> KeychainQuery {
    var replacement = attributes
    for (key, value) in additions {
      replacement[key as String] = value
    }
    return KeychainQuery(attributes: replacement)
  }

  func stringValue(for key: CFString) -> String? {
    attributes[key as String] as? String
  }

  func boolValue(for key: CFString) -> Bool? {
    attributes[key as String] as? Bool
  }

  func dataValue(for key: CFString) -> Data? {
    attributes[key as String] as? Data
  }

  fileprivate var securityDictionary: CFDictionary {
    attributes as CFDictionary
  }
}

struct KeychainItem: Sendable, Equatable {
  let account: String
  let data: Data
  let generic: Data?

  init(account: String, data: Data, generic: Data? = nil) {
    self.account = account
    self.data = data
    self.generic = generic
  }
}

struct KeychainCopyResult: Sendable, Equatable {
  let status: OSStatus
  let items: [KeychainItem]
}

struct KeychainClient: Sendable {
  typealias Add = @Sendable (KeychainQuery) -> OSStatus
  typealias CopyMatching = @Sendable (KeychainQuery) -> KeychainCopyResult
  typealias Update = @Sendable (KeychainQuery, KeychainQuery) -> OSStatus
  typealias Delete = @Sendable (KeychainQuery) -> OSStatus

  let add: Add
  let copyMatching: CopyMatching
  let update: Update
  let delete: Delete

  init(
    add: @escaping Add,
    copyMatching: @escaping CopyMatching,
    update: @escaping Update,
    delete: @escaping Delete
  ) {
    self.add = add
    self.copyMatching = copyMatching
    self.update = update
    self.delete = delete
  }

  static let live = KeychainClient(
    add: { query in
      SecItemAdd(query.securityDictionary, nil)
    },
    copyMatching: { query in
      var rawResult: CFTypeRef?
      let status = SecItemCopyMatching(query.securityDictionary, &rawResult)
      guard status == errSecSuccess else {
        return KeychainCopyResult(status: status, items: [])
      }
      guard let items = Self.decodeItems(rawResult) else {
        return KeychainCopyResult(status: errSecDecode, items: [])
      }
      return KeychainCopyResult(status: status, items: items)
    },
    update: { query, attributes in
      SecItemUpdate(query.securityDictionary, attributes.securityDictionary)
    },
    delete: { query in
      SecItemDelete(query.securityDictionary)
    }
  )

  static func decodeItems(_ rawResult: CFTypeRef?) -> [KeychainItem]? {
    guard let rawResult else {
      return nil
    }
    if let dictionary = rawResult as? [String: Any] {
      return decodeItem(dictionary).map { [$0] }
    }
    guard let dictionaries = rawResult as? [[String: Any]] else {
      return nil
    }
    var items: [KeychainItem] = []
    items.reserveCapacity(dictionaries.count)
    for dictionary in dictionaries {
      guard let item = decodeItem(dictionary) else {
        return nil
      }
      items.append(item)
    }
    return items
  }

  private static func decodeItem(_ dictionary: [String: Any]) -> KeychainItem? {
    guard
      let account = dictionary[kSecAttrAccount as String] as? String,
      let data = dictionary[kSecValueData as String] as? Data
    else {
      return nil
    }
    return KeychainItem(
      account: account,
      data: data,
      generic: dictionary[kSecAttrGeneric as String] as? Data
    )
  }
}
