import Foundation
import Security
import Testing

@testable import RecursBrokerCore
@testable import RecursNativeSecurity

@Suite("Data Protection Keychain credential store")
struct KeychainStoreTests {
  @Test
  func configurationRejectsMissingOrMalformedSigningIdentity() throws {
    #expect(throws: KeychainStoreConfigurationError.invalidAccessGroup) {
      _ = try KeychainStoreConfiguration(accessGroup: "")
    }
    #expect(throws: KeychainStoreConfigurationError.invalidAccessGroup) {
      _ = try KeychainStoreConfiguration(accessGroup: "   \n")
    }
    #expect(throws: KeychainStoreConfigurationError.productionSigningRequired) {
      _ = try KeychainStoreConfiguration.production(
        applicationIdentifierPrefix: nil,
        credentialAccessGroup: "com.recurs.credentials"
      )
    }
    #expect(throws: KeychainStoreConfigurationError.productionSigningRequired) {
      _ = try KeychainStoreConfiguration.production(
        applicationIdentifierPrefix: "ABCDEFGHIJ.",
        credentialAccessGroup: nil
      )
    }
    #expect(throws: KeychainStoreConfigurationError.productionSigningRequired) {
      _ = try KeychainStoreConfiguration.production(
        applicationIdentifierPrefix: "bad prefix.",
        credentialAccessGroup: "com.recurs.credentials"
      )
    }
    for suffix in [".com.recurs", "com..recurs", "-com.recurs", "com.recurs-"] {
      #expect(throws: KeychainStoreConfigurationError.productionSigningRequired) {
        _ = try KeychainStoreConfiguration.production(
          applicationIdentifierPrefix: "ABCDEFGHIJ.",
          credentialAccessGroup: suffix
        )
      }
    }

    let configuration = try KeychainStoreConfiguration.production(
      applicationIdentifierPrefix: "ABCDEFGHIJ.",
      credentialAccessGroup: "com.recurs.credentials"
    )
    #expect(configuration.accessGroup == "ABCDEFGHIJ.com.recurs.credentials")
  }

  @Test
  func storeLoadAndDeleteUseOnlyTheExactDataProtectionQuery() async throws {
    let connectionID = UUID(uuidString: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")!
    let generationID = UUID(uuidString: "11111111-2222-4333-8444-555555555555")!
    let key = CredentialStoreKey(
      connectionID: connectionID,
      generationID: generationID,
      generationOrdinal: 7
    )
    let recorder = KeychainQueryRecorder(
      copyResults: [
        KeychainCopyResult(
          status: errSecSuccess,
          items: [
            KeychainItem(
              account:
                "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/11111111-2222-4333-8444-555555555555/7",
              data: Data([9, 8, 7]),
              generic: Data("credential.v1".utf8)
            )
          ]
        )
      ]
    )
    let configuration = try KeychainStoreConfiguration(
      accessGroup: "ABCDEFGHIJ.com.recurs.credentials"
    )
    let store = DataProtectionCredentialStore(
      client: recorder.client,
      configuration: configuration
    )

    try await store.store(SecretBytes(Data([1, 2, 3])), for: key)
    let loaded = try await store.load(for: key)
    let loadedBytes = loaded.withUnsafeBytes { Data($0) }
    loaded.erase()
    try await store.deleteIfPresent(key)

    #expect(loadedBytes == Data([9, 8, 7]))
    let calls = recorder.calls()
    #expect(calls.map(\.operation) == [.add, .copy, .delete])
    for (index, call) in calls.enumerated() {
      assertBaseQuery(
        call.query,
        accessGroup: "ABCDEFGHIJ.com.recurs.credentials"
      )
      #expect(
        call.query.stringValue(for: kSecAttrAccount)
          == "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/11111111-2222-4333-8444-555555555555/7"
      )
      #expect(
        call.query.dataValue(for: kSecAttrGeneric)
          == (index == 2 ? nil : Data("credential.v1".utf8))
      )
    }
    #expect(calls[0].query.dataValue(for: kSecValueData) == Data([1, 2, 3]))
    #expect(calls[1].query.boolValue(for: kSecReturnData) == true)
    #expect(calls[1].query.boolValue(for: kSecReturnAttributes) == true)
    #expect(calls[1].query.stringValue(for: kSecMatchLimit) == kSecMatchLimitOne as String)
  }

  @Test
  func statusesMapToFixedStoreErrorsAndMissingDeleteIsIdempotent() async throws {
    let key = CredentialStoreKey(
      connectionID: UUID(uuidString: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")!,
      generationID: UUID(uuidString: "11111111-2222-4333-8444-555555555555")!,
      generationOrdinal: 1
    )
    let configuration = try KeychainStoreConfiguration(
      accessGroup: "ABCDEFGHIJ.com.recurs.credentials"
    )

    for status in [
      errSecDuplicateItem,
      errSecInteractionNotAllowed,
      errSecNotAvailable,
      errSecAuthFailed,
    ] {
      let recorder = KeychainQueryRecorder(addStatuses: [status])
      let store = DataProtectionCredentialStore(
        client: recorder.client,
        configuration: configuration
      )
      await #expect(throws: CredentialStoreError.unavailable) {
        try await store.store(SecretBytes(Data([1])), for: key)
      }
    }

    let unexpectedAdd = KeychainQueryRecorder(addStatuses: [-9_999])
    let uncertainStore = DataProtectionCredentialStore(
      client: unexpectedAdd.client,
      configuration: configuration
    )
    await #expect(throws: CredentialStoreError.mutationOutcomeUnknown) {
      try await uncertainStore.store(SecretBytes(Data([1])), for: key)
    }

    let missingRead = KeychainQueryRecorder(
      copyResults: [KeychainCopyResult(status: errSecItemNotFound, items: [])]
    )
    let missingStore = DataProtectionCredentialStore(
      client: missingRead.client,
      configuration: configuration
    )
    await #expect(throws: CredentialStoreError.unavailable) {
      _ = try await missingStore.load(for: key)
    }
    for status in [errSecInteractionNotAllowed, errSecNotAvailable, errSecAuthFailed, -9_999] {
      let failedRead = KeychainQueryRecorder(
        copyResults: [KeychainCopyResult(status: status, items: [])]
      )
      let failedReadStore = DataProtectionCredentialStore(
        client: failedRead.client,
        configuration: configuration
      )
      await #expect(throws: CredentialStoreError.unavailable) {
        _ = try await failedReadStore.load(for: key)
      }
    }

    let malformedRead = KeychainQueryRecorder(
      copyResults: [KeychainCopyResult(status: errSecSuccess, items: [])]
    )
    let malformedStore = DataProtectionCredentialStore(
      client: malformedRead.client,
      configuration: configuration
    )
    await #expect(throws: CredentialStoreError.unavailable) {
      _ = try await malformedStore.load(for: key)
    }

    let missingDelete = KeychainQueryRecorder(deleteStatuses: [errSecItemNotFound])
    let idempotentStore = DataProtectionCredentialStore(
      client: missingDelete.client,
      configuration: configuration
    )
    try await idempotentStore.deleteIfPresent(key)

    for status in [errSecInteractionNotAllowed, errSecNotAvailable, errSecAuthFailed] {
      let failedDelete = KeychainQueryRecorder(deleteStatuses: [status])
      let failedDeleteStore = DataProtectionCredentialStore(
        client: failedDelete.client,
        configuration: configuration
      )
      await #expect(throws: CredentialStoreError.unavailable) {
        try await failedDeleteStore.deleteIfPresent(key)
      }
    }

    let unexpectedDelete = KeychainQueryRecorder(deleteStatuses: [-9_999])
    let uncertainDeleteStore = DataProtectionCredentialStore(
      client: unexpectedDelete.client,
      configuration: configuration
    )
    await #expect(throws: CredentialStoreError.mutationOutcomeUnknown) {
      try await uncertainDeleteStore.deleteIfPresent(key)
    }
  }

  @Test
  func completeCredentialKeyTupleProducesInjectiveCanonicalAccounts() async throws {
    let configuration = try KeychainStoreConfiguration(
      accessGroup: "ABCDEFGHIJ.com.recurs.credentials"
    )
    let recorder = KeychainQueryRecorder(
      addStatuses: Array(repeating: errSecSuccess, count: 5)
    )
    let store = DataProtectionCredentialStore(
      client: recorder.client,
      configuration: configuration
    )
    let connectionID = UUID(uuidString: "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE")!
    let secondConnectionID = UUID(uuidString: "BBBBBBBB-CCCC-4DDD-8EEE-FFFFFFFFFFFF")!
    let firstGeneration = UUID(uuidString: "11111111-2222-4333-8444-555555555555")!
    let secondGeneration = UUID(uuidString: "66666666-7777-4888-8999-AAAAAAAAAAAA")!

    try await store.store(
      SecretBytes(Data([1])),
      for: CredentialStoreKey(
        connectionID: connectionID,
        generationID: firstGeneration,
        generationOrdinal: 1
      )
    )
    try await store.store(
      SecretBytes(Data([2])),
      for: CredentialStoreKey(
        connectionID: connectionID,
        generationID: secondGeneration,
        generationOrdinal: 1
      )
    )
    try await store.store(
      SecretBytes(Data([3])),
      for: CredentialStoreKey(
        connectionID: connectionID,
        generationID: secondGeneration,
        generationOrdinal: 2
      )
    )
    try await store.store(
      SecretBytes(Data([4])),
      for: CredentialStoreKey(
        connectionID: secondConnectionID,
        generationID: secondGeneration,
        generationOrdinal: 0
      )
    )
    try await store.store(
      SecretBytes(Data([5])),
      for: CredentialStoreKey(
        connectionID: secondConnectionID,
        generationID: secondGeneration,
        generationOrdinal: .max
      )
    )

    let accounts = recorder.calls().compactMap { call in
      call.operation == .add ? call.query.stringValue(for: kSecAttrAccount) : nil
    }
    #expect(accounts.count == 5)
    #expect(Set(accounts).count == 5)
    #expect(accounts.allSatisfy { $0 == $0.lowercased() })
    #expect(accounts[0].hasSuffix("/11111111-2222-4333-8444-555555555555/1"))
    #expect(accounts[1].hasSuffix("/66666666-7777-4888-8999-aaaaaaaaaaaa/1"))
    #expect(accounts[2].hasSuffix("/66666666-7777-4888-8999-aaaaaaaaaaaa/2"))
    #expect(accounts[3].hasPrefix("bbbbbbbb-cccc-4ddd-8eee-ffffffffffff/"))
    #expect(accounts[3].hasSuffix("/0"))
    #expect(accounts[4].hasSuffix("/18446744073709551615"))
  }

  @Test
  func deleteTargetsExactCredentialIdentityEvenWhenItsTypeMarkerIsCorrupt() async throws {
    let configuration = try KeychainStoreConfiguration(
      accessGroup: "ABCDEFGHIJ.com.recurs.credentials"
    )
    let client = KeychainClient(
      add: { _ in errSecSuccess },
      copyMatching: { _ in KeychainCopyResult(status: errSecItemNotFound, items: []) },
      update: { _, _ in errSecSuccess },
      delete: { query in
        query.dataValue(for: kSecAttrGeneric) == nil ? errSecSuccess : errSecItemNotFound
      }
    )
    let store = DataProtectionCredentialStore(
      client: client,
      configuration: configuration
    )

    try await store.deleteIfPresent(
      CredentialStoreKey(
        connectionID: UUID(uuidString: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")!,
        generationID: UUID(uuidString: "11111111-2222-4333-8444-555555555555")!,
        generationOrdinal: 1
      )
    )
  }

  @Test
  func copyDecoderRejectsEveryIncompleteOrMixedSecurityResult() {
    let first: [String: Any] = [
      kSecAttrAccount as String: "first",
      kSecValueData as String: Data([1]),
      kSecAttrGeneric as String: Data([2]),
    ]
    let second: [String: Any] = [
      kSecAttrAccount as String: "second",
      kSecValueData as String: Data([3]),
    ]
    #expect(
      KeychainClient.decodeItems(first as CFDictionary)
        == [KeychainItem(account: "first", data: Data([1]), generic: Data([2]))]
    )
    #expect(
      KeychainClient.decodeItems([first, second] as CFArray)
        == [
          KeychainItem(account: "first", data: Data([1]), generic: Data([2])),
          KeychainItem(account: "second", data: Data([3])),
        ]
    )
    #expect(KeychainClient.decodeItems(nil) == nil)
    #expect(KeychainClient.decodeItems(Data([1]) as CFData) == nil)
    #expect(
      KeychainClient.decodeItems(
        [kSecAttrAccount as String: "missing-data"] as CFDictionary
      ) == nil
    )
    #expect(
      KeychainClient.decodeItems(
        [first, [kSecValueData as String: Data([4])]] as CFArray
      ) == nil
    )
  }

  @Test
  func consumedSecretsEraseAfterSuccessfulAndFailedAdds() async throws {
    let configuration = try KeychainStoreConfiguration(
      accessGroup: "ABCDEFGHIJ.com.recurs.credentials"
    )
    let key = CredentialStoreKey(
      connectionID: UUID(uuidString: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")!,
      generationID: UUID(uuidString: "11111111-2222-4333-8444-555555555555")!,
      generationOrdinal: 1
    )

    let successfulSecret = KeychainSecretAlias(SecretBytes(Data([1, 2, 3])))
    let successfulRecorder = KeychainQueryRecorder()
    let successfulStore = DataProtectionCredentialStore(
      client: successfulRecorder.client,
      configuration: configuration
    )
    try await successfulStore.store(successfulSecret.value, for: key)
    #expect(successfulSecret.isErased())

    let failedSecret = KeychainSecretAlias(SecretBytes(Data([4, 5, 6])))
    let failedRecorder = KeychainQueryRecorder(addStatuses: [errSecDuplicateItem])
    let failedStore = DataProtectionCredentialStore(
      client: failedRecorder.client,
      configuration: configuration
    )
    await #expect(throws: CredentialStoreError.unavailable) {
      try await failedStore.store(failedSecret.value, for: key)
    }
    #expect(failedSecret.isErased())
  }
}

private func assertBaseQuery(
  _ query: KeychainQuery,
  accessGroup: String,
  sourceLocation: SourceLocation = #_sourceLocation
) {
  #expect(
    query.stringValue(for: kSecClass) == kSecClassGenericPassword as String,
    sourceLocation: sourceLocation)
  #expect(
    query.boolValue(for: kSecUseDataProtectionKeychain) == true, sourceLocation: sourceLocation)
  #expect(query.boolValue(for: kSecAttrSynchronizable) == false, sourceLocation: sourceLocation)
  #expect(
    query.stringValue(for: kSecAttrAccessible)
      == kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String,
    sourceLocation: sourceLocation
  )
  #expect(
    query.stringValue(for: kSecAttrService) == "com.recurs.cli.credentials.v1",
    sourceLocation: sourceLocation
  )
  #expect(
    query.stringValue(for: kSecAttrAccessGroup) == accessGroup, sourceLocation: sourceLocation)
  #expect(query.boolValue(for: kSecReturnRef) == nil, sourceLocation: sourceLocation)
  #expect(query.boolValue(for: kSecReturnPersistentRef) == nil, sourceLocation: sourceLocation)
}

private final class KeychainSecretAlias: @unchecked Sendable {
  let value: SecretBytes

  init(_ value: SecretBytes) {
    self.value = value
  }

  func isErased() -> Bool {
    value.withUnsafeBytes(\.isEmpty)
  }
}

private final class KeychainQueryRecorder: @unchecked Sendable {
  private let lock = NSLock()
  private var recordedCalls: [RecordedKeychainCall] = []
  private var addStatuses: [OSStatus]
  private var copyResults: [KeychainCopyResult]
  private var deleteStatuses: [OSStatus]

  init(
    addStatuses: [OSStatus] = [errSecSuccess],
    copyResults: [KeychainCopyResult] = [],
    deleteStatuses: [OSStatus] = [errSecSuccess]
  ) {
    self.addStatuses = addStatuses
    self.copyResults = copyResults
    self.deleteStatuses = deleteStatuses
  }

  lazy var client = KeychainClient(
    add: { [unowned self] query in
      withLock {
        recordedCalls.append(RecordedKeychainCall(operation: .add, query: query))
        return addStatuses.isEmpty ? errSecSuccess : addStatuses.removeFirst()
      }
    },
    copyMatching: { [unowned self] query in
      withLock {
        recordedCalls.append(RecordedKeychainCall(operation: .copy, query: query))
        return copyResults.isEmpty
          ? KeychainCopyResult(status: errSecItemNotFound, items: [])
          : copyResults.removeFirst()
      }
    },
    update: { [unowned self] query, _ in
      withLock {
        recordedCalls.append(RecordedKeychainCall(operation: .update, query: query))
        return errSecSuccess
      }
    },
    delete: { [unowned self] query in
      withLock {
        recordedCalls.append(RecordedKeychainCall(operation: .delete, query: query))
        return deleteStatuses.isEmpty ? errSecSuccess : deleteStatuses.removeFirst()
      }
    }
  )

  func calls() -> [RecordedKeychainCall] {
    withLock { recordedCalls }
  }

  private func withLock<Result>(_ body: () -> Result) -> Result {
    lock.lock()
    defer { lock.unlock() }
    return body()
  }
}

private enum RecordedKeychainOperation: Sendable {
  case add
  case copy
  case update
  case delete
}

private struct RecordedKeychainCall: @unchecked Sendable {
  let operation: RecordedKeychainOperation
  let query: KeychainQuery
}
