import Foundation
import Security
import Testing

@testable import RecursBrokerCore
@testable import RecursNativeSecurity

@Suite("Keychain credential identity fingerprinter")
struct KeychainCredentialIdentityFingerprinterTests {
  @Test
  func createsADistinctKeyAndUsesTheExactVersionedHMAC() throws {
    let keychain = FingerprintKeychainSimulator()
    let configuration = try fingerprintConfiguration()
    let fingerprinter = KeychainCredentialIdentityFingerprinter(
      client: keychain.client,
      configuration: configuration,
      randomBytes: { Data(UInt8.min...31) }
    )

    let first = try fingerprint(
      using: fingerprinter,
      credential: Data("sk-test".utf8),
      binding: .openAI
    )
    let second = try fingerprint(
      using: fingerprinter,
      credential: Data("sk-test".utf8),
      binding: .openAI
    )

    #expect(
      first.rawValue == "sha256:362aac0a620c6890385df7905998ec6eeb75d830147de21b4d0984e10ca1609d"
    )
    #expect(second == first)
    #expect(keychain.addCallCount == 1)
    #expect(fingerprinter.description == "<credential-identity-fingerprinter>")
    #expect(fingerprinter.debugDescription == "<credential-identity-fingerprinter>")
    #expect(Array(Mirror(reflecting: fingerprinter).children).isEmpty)

    let add = try #require(keychain.calls.first { $0.operation == .add })
    assertIdentityKeyQuery(add.query, configuration: configuration)
    #expect(add.query.stringValue(for: kSecAttrAccount) == "hmac-sha256.v1")
    #expect(
      add.query.dataValue(for: kSecAttrGeneric)
        == Data("credential-identity-key.v1".utf8)
    )
    #expect(add.query.dataValue(for: kSecValueData) == Data(UInt8.min...31))
    #expect(
      keychain.calls.allSatisfy {
        $0.query.stringValue(for: kSecAttrService)
          != "com.recurs.cli.broker-journal-key.v1"
      }
    )
  }

  @Test
  func credentialBindingAndInstallationKeyEachChangeTheFingerprint() throws {
    let firstKeychain = FingerprintKeychainSimulator()
    let first = KeychainCredentialIdentityFingerprinter(
      client: firstKeychain.client,
      configuration: try fingerprintConfiguration(),
      randomBytes: { Data(repeating: 1, count: 32) }
    )
    let credential = Data("credential-a".utf8)
    let values = try [
      fingerprint(using: first, credential: credential, binding: .openAI),
      fingerprint(using: first, credential: Data("credential-b".utf8), binding: .openAI),
      fingerprint(using: first, credential: credential, binding: .anthropic),
      fingerprint(
        using: first,
        credential: credential,
        binding: .customOpenAICompatible(baseURL: "https://gateway.vendor.dev/v1")
      ),
    ]
    #expect(Set(values).count == values.count)

    let second = KeychainCredentialIdentityFingerprinter(
      client: FingerprintKeychainSimulator().client,
      configuration: try fingerprintConfiguration(),
      randomBytes: { Data(repeating: 2, count: 32) }
    )
    let otherInstallation = try fingerprint(
      using: second,
      credential: credential,
      binding: .openAI
    )
    #expect(otherInstallation != values[0])
  }

  @Test
  func emptyAndOversizedCredentialsFailBeforeKeychainUse() throws {
    let keychain = FingerprintKeychainSimulator()
    let fingerprinter = KeychainCredentialIdentityFingerprinter(
      client: keychain.client,
      configuration: try fingerprintConfiguration(),
      randomBytes: { throw FingerprintTestError.unexpectedRandomness }
    )

    for credential in [
      Data(),
      Data(
        repeating: 0x41,
        count: CredentialIdentityFingerprint.maximumCredentialByteCount + 1
      ),
    ] {
      #expect(throws: CredentialIdentityFingerprintError.invalidCredential) {
        _ = try fingerprint(
          using: fingerprinter,
          credential: credential,
          binding: .openAI
        )
      }
    }
    #expect(keychain.calls.isEmpty)
  }

  @Test
  func malformedOrUnavailableKeychainAndRandomnessFailClosed() throws {
    let configuration = try fingerprintConfiguration()

    for malformed in [
      FingerprintKeychainItem(
        data: Data(repeating: 0, count: 32),
        marker: Data("credential-identity-key.v1".utf8)
      ),
      FingerprintKeychainItem(
        data: Data(repeating: 1, count: 31),
        marker: Data("credential-identity-key.v1".utf8)
      ),
      FingerprintKeychainItem(
        data: Data(repeating: 1, count: 32),
        marker: Data("wrong-marker".utf8)
      ),
    ] {
      let keychain = FingerprintKeychainSimulator(item: malformed)
      let fingerprinter = KeychainCredentialIdentityFingerprinter(
        client: keychain.client,
        configuration: configuration,
        randomBytes: { Data(repeating: 2, count: 32) }
      )
      #expect(throws: CredentialIdentityFingerprintError.keyMalformed) {
        _ = try fingerprint(
          using: fingerprinter,
          credential: Data("private".utf8),
          binding: .openAI
        )
      }
      #expect(keychain.addCallCount == 0)
    }

    let duplicateResults = FingerprintKeychainSimulator(
      item: FingerprintKeychainItem(
        data: Data(repeating: 1, count: 32),
        marker: Data("credential-identity-key.v1".utf8)
      ),
      duplicateCopyResult: true
    )
    let duplicateFingerprinter = KeychainCredentialIdentityFingerprinter(
      client: duplicateResults.client,
      configuration: configuration,
      randomBytes: { Data(repeating: 2, count: 32) }
    )
    #expect(throws: CredentialIdentityFingerprintError.keyMalformed) {
      _ = try fingerprint(
        using: duplicateFingerprinter,
        credential: Data("private".utf8),
        binding: .openAI
      )
    }
    #expect(duplicateResults.addCallCount == 0)

    let unavailable = FingerprintKeychainSimulator(copyStatus: errSecInteractionNotAllowed)
    let unavailableFingerprinter = KeychainCredentialIdentityFingerprinter(
      client: unavailable.client,
      configuration: configuration,
      randomBytes: { Data(repeating: 2, count: 32) }
    )
    #expect(throws: CredentialIdentityFingerprintError.keyUnavailable) {
      _ = try fingerprint(
        using: unavailableFingerprinter,
        credential: Data("private".utf8),
        binding: .openAI
      )
    }

    for randomBytes in [
      { Data(repeating: 0, count: 32) },
      { Data(repeating: 1, count: 31) },
      { throw FingerprintTestError.unexpectedRandomness },
    ] as [@Sendable () throws -> Data] {
      let keychain = FingerprintKeychainSimulator()
      let fingerprinter = KeychainCredentialIdentityFingerprinter(
        client: keychain.client,
        configuration: configuration,
        randomBytes: randomBytes
      )
      #expect(throws: CredentialIdentityFingerprintError.keyUnavailable) {
        _ = try fingerprint(
          using: fingerprinter,
          credential: Data("private".utf8),
          binding: .openAI
        )
      }
      #expect(keychain.addCallCount == 0)
    }
  }

  @Test
  func uncertainAndConcurrentCreationSelectTheSingleStoredKey() async throws {
    let configuration = try fingerprintConfiguration()
    let uncertain = FingerprintKeychainSimulator(
      nextAdd: FingerprintAddBehavior(status: -9_999, appliesSideEffect: true)
    )
    let uncertainFingerprinter = KeychainCredentialIdentityFingerprinter(
      client: uncertain.client,
      configuration: configuration,
      randomBytes: { Data(repeating: 7, count: 32) }
    )
    _ = try fingerprint(
      using: uncertainFingerprinter,
      credential: Data("private".utf8),
      binding: .openAI
    )

    let missing = FingerprintKeychainSimulator(
      nextAdd: FingerprintAddBehavior(status: -9_999, appliesSideEffect: false)
    )
    let missingFingerprinter = KeychainCredentialIdentityFingerprinter(
      client: missing.client,
      configuration: configuration,
      randomBytes: { Data(repeating: 7, count: 32) }
    )
    #expect(throws: CredentialIdentityFingerprintError.keyUnavailable) {
      _ = try fingerprint(
        using: missingFingerprinter,
        credential: Data("private".utf8),
        binding: .openAI
      )
    }

    let concurrent = FingerprintKeychainSimulator(initialReadParties: 2)
    let first = KeychainCredentialIdentityFingerprinter(
      client: concurrent.client,
      configuration: configuration,
      randomBytes: { Data(repeating: 1, count: 32) }
    )
    let second = KeychainCredentialIdentityFingerprinter(
      client: concurrent.client,
      configuration: configuration,
      randomBytes: { Data(repeating: 2, count: 32) }
    )
    let credential = Data("private".utf8)
    let firstTask = Task.detached {
      try fingerprint(using: first, credential: credential, binding: .openAI)
    }
    let secondTask = Task.detached {
      try fingerprint(using: second, credential: credential, binding: .openAI)
    }
    let results = try await [firstTask.value, secondTask.value]

    #expect(results[0] == results[1])
    #expect(concurrent.addCallCount == 2)
    #expect(concurrent.storedItemCount == 1)
  }
}

private func fingerprintConfiguration() throws -> KeychainStoreConfiguration {
  try KeychainStoreConfiguration(accessGroup: "ABCDEFGHIJ.com.recurs.credentials")
}

private func fingerprint(
  using fingerprinter: KeychainCredentialIdentityFingerprinter,
  credential: Data,
  binding: ProviderProfileBinding
) throws -> CredentialIdentityFingerprint {
  try credential.withUnsafeBytes {
    try fingerprinter.fingerprint(credential: $0, binding: binding)
  }
}

private func assertIdentityKeyQuery(
  _ query: KeychainQuery,
  configuration: KeychainStoreConfiguration
) {
  #expect(query.stringValue(for: kSecClass) == kSecClassGenericPassword as String)
  #expect(query.boolValue(for: kSecUseDataProtectionKeychain) == true)
  #expect(query.boolValue(for: kSecAttrSynchronizable) == false)
  #expect(
    query.stringValue(for: kSecAttrAccessible)
      == kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String
  )
  #expect(
    query.stringValue(for: kSecAttrService)
      == "com.recurs.cli.credential-identity-key.v1"
  )
  #expect(query.stringValue(for: kSecAttrAccessGroup) == configuration.accessGroup)
}

private enum FingerprintTestError: Error {
  case unexpectedRandomness
}

private struct FingerprintKeychainItem: Sendable {
  let data: Data
  let marker: Data
}

private struct FingerprintAddBehavior: Sendable {
  let status: OSStatus
  let appliesSideEffect: Bool
}

private struct FingerprintKeychainCall: @unchecked Sendable {
  enum Operation: Sendable {
    case add
    case copy
  }

  let operation: Operation
  let query: KeychainQuery
}

private final class FingerprintKeychainSimulator: @unchecked Sendable {
  private let lock = NSLock()
  private let initialReadGate: FingerprintReadGate?
  private var item: FingerprintKeychainItem?
  private var nextAdd: FingerprintAddBehavior?
  private let copyStatus: OSStatus?
  private let duplicateCopyResult: Bool
  private var recordedCalls: [FingerprintKeychainCall] = []

  init(
    item: FingerprintKeychainItem? = nil,
    copyStatus: OSStatus? = nil,
    duplicateCopyResult: Bool = false,
    nextAdd: FingerprintAddBehavior? = nil,
    initialReadParties: Int? = nil
  ) {
    self.item = item
    self.copyStatus = copyStatus
    self.duplicateCopyResult = duplicateCopyResult
    self.nextAdd = nextAdd
    self.initialReadGate = initialReadParties.map(FingerprintReadGate.init(parties:))
  }

  var client: KeychainClient {
    KeychainClient(
      add: { [self] in add($0) },
      copyMatching: { [self] in copy($0) },
      update: { _, _ in errSecParam },
      delete: { _ in errSecParam }
    )
  }

  var calls: [FingerprintKeychainCall] {
    lock.withLock { recordedCalls }
  }

  var addCallCount: Int {
    calls.count(where: { $0.operation == .add })
  }

  var storedItemCount: Int {
    lock.withLock { item == nil ? 0 : 1 }
  }

  private func add(_ query: KeychainQuery) -> OSStatus {
    lock.withLock {
      recordedCalls.append(FingerprintKeychainCall(operation: .add, query: query))
      let behavior = nextAdd
      nextAdd = nil
      if let behavior {
        if behavior.appliesSideEffect, item == nil {
          item = item(from: query)
        }
        return behavior.status
      }
      guard item == nil else { return errSecDuplicateItem }
      guard let newItem = item(from: query) else { return errSecParam }
      item = newItem
      return errSecSuccess
    }
  }

  private func copy(_ query: KeychainQuery) -> KeychainCopyResult {
    let result: KeychainCopyResult = lock.withLock {
      recordedCalls.append(FingerprintKeychainCall(operation: .copy, query: query))
      if let copyStatus {
        return KeychainCopyResult(status: copyStatus, items: [])
      }
      guard let item else {
        return KeychainCopyResult(status: errSecItemNotFound, items: [])
      }
      let keychainItem = KeychainItem(
        account: "hmac-sha256.v1",
        data: item.data,
        generic: item.marker
      )
      return KeychainCopyResult(
        status: errSecSuccess,
        items: duplicateCopyResult ? [keychainItem, keychainItem] : [keychainItem]
      )
    }
    if result.status == errSecItemNotFound {
      initialReadGate?.arriveAndWait()
    }
    return result
  }

  private func item(from query: KeychainQuery) -> FingerprintKeychainItem? {
    guard
      query.stringValue(for: kSecAttrAccount) == "hmac-sha256.v1",
      let data = query.dataValue(for: kSecValueData),
      let marker = query.dataValue(for: kSecAttrGeneric)
    else {
      return nil
    }
    return FingerprintKeychainItem(data: data, marker: marker)
  }
}

private final class FingerprintReadGate: @unchecked Sendable {
  private let condition = NSCondition()
  private let parties: Int
  private var arrivals = 0

  init(parties: Int) {
    self.parties = parties
  }

  func arriveAndWait() {
    condition.lock()
    arrivals += 1
    if arrivals == parties {
      condition.broadcast()
    } else {
      while arrivals < parties {
        condition.wait()
      }
    }
    condition.unlock()
  }
}
