import Foundation
import Security
import Testing

@testable import RecursBrokerCore
@testable import RecursNativeSecurity

@Suite("Keychain journal authenticator")
struct KeychainJournalAuthenticatorTests {
  @Test
  func createsOneRandomKeyAndUsesTheExactDomainSeparatedHMAC() async throws {
    let keychain = LockedKeychainSimulator()
    let configuration = try KeychainStoreConfiguration(
      accessGroup: "ABCDEFGHIJ.com.recurs.credentials"
    )
    let authenticator = KeychainJournalAuthenticator(
      client: keychain.client,
      configuration: configuration,
      randomBytes: { Data(UInt8.min...31) }
    )
    let canonicalRecord = Data(#"{"schemaVersion":1}"#.utf8)

    let tag = try await authenticator.authenticate(
      previousTag: .zero,
      canonicalRecord: canonicalRecord
    )
    #expect(
      tag.lowercaseHex == "5ffa82a2a891cb18a0382bb2ad919bc9e87bada74e9f8e00ada2cc87ad03177f"
    )
    try await authenticator.verify(
      previousTag: .zero,
      canonicalRecord: canonicalRecord,
      tag: tag
    )
    await #expect(throws: BrokerJournalError.authenticationFailed) {
      try await authenticator.verify(
        previousTag: .zero,
        canonicalRecord: canonicalRecord + Data([0]),
        tag: tag
      )
    }

    let calls = keychain.calls()
    #expect(calls.filter { $0.operation == .add }.count == 1)
    let keyAdd = try #require(calls.first { $0.operation == .add })
    assertJournalBaseQuery(
      keyAdd.query,
      service: "com.recurs.cli.broker-journal-key.v1",
      accessGroup: configuration.accessGroup
    )
    #expect(keyAdd.query.dataValue(for: kSecValueData) == Data(UInt8.min...31))
    #expect(keyAdd.query.boolValue(for: kSecReturnRef) == nil)
    #expect(keyAdd.query.boolValue(for: kSecReturnPersistentRef) == nil)
    #expect(Array(Mirror(reflecting: authenticator).children).isEmpty)
  }

  @Test
  func missingKeyWithExistingAuthorityAndInvalidRandomnessFailClosed() async throws {
    let configuration = try KeychainStoreConfiguration(
      accessGroup: "ABCDEFGHIJ.com.recurs.credentials"
    )
    let existingAuthority = LockedKeychainSimulator()
    let connectionID = UUID(uuidString: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")!
    let encodedAnchor = independentAnchorEncoding(
      connectionID: connectionID,
      revision: 1,
      byte: 1
    )
    existingAuthority.put(
      service: "com.recurs.cli.broker-journal-anchors.v1",
      account: connectionID.uuidString.lowercased(),
      data: encodedAnchor,
      generic: encodedAnchor
    )
    let rollbackAuthenticator = KeychainJournalAuthenticator(
      client: existingAuthority.client,
      configuration: configuration,
      randomBytes: { Data(repeating: 7, count: 32) }
    )
    await #expect(throws: BrokerJournalError.rollbackDetected) {
      _ = try await rollbackAuthenticator.authenticate(
        previousTag: .zero,
        canonicalRecord: Data([1])
      )
    }
    #expect(existingAuthority.calls().allSatisfy { $0.operation != .add })

    let shortRandom = LockedKeychainSimulator()
    let shortRandomAuthenticator = KeychainJournalAuthenticator(
      client: shortRandom.client,
      configuration: configuration,
      randomBytes: { Data(repeating: 7, count: 31) }
    )
    await #expect(throws: BrokerJournalError.storageUnavailable) {
      _ = try await shortRandomAuthenticator.authenticate(
        previousTag: .zero,
        canonicalRecord: Data([1])
      )
    }
    #expect(shortRandom.calls().allSatisfy { $0.operation != .add })

    let throwingRandom = LockedKeychainSimulator()
    let throwingRandomAuthenticator = KeychainJournalAuthenticator(
      client: throwingRandom.client,
      configuration: configuration,
      randomBytes: { throw BrokerJournalError.storageUnavailable }
    )
    await #expect(throws: BrokerJournalError.storageUnavailable) {
      _ = try await throwingRandomAuthenticator.authenticate(
        previousTag: .zero,
        canonicalRecord: Data([1])
      )
    }
    #expect(throwingRandom.calls().allSatisfy { $0.operation != .add })

    let malformedKey = LockedKeychainSimulator()
    malformedKey.put(
      service: "com.recurs.cli.broker-journal-key.v1",
      account: "hmac-sha256.v1",
      data: Data(repeating: 7, count: 32),
      generic: Data("wrong-key-type".utf8)
    )
    let malformedKeyAuthenticator = KeychainJournalAuthenticator(
      client: malformedKey.client,
      configuration: configuration,
      randomBytes: { Data(repeating: 8, count: 32) }
    )
    await #expect(throws: BrokerJournalError.rollbackDetected) {
      _ = try await malformedKeyAuthenticator.authenticate(
        previousTag: .zero,
        canonicalRecord: Data([1])
      )
    }
    #expect(malformedKey.calls().allSatisfy { $0.operation != .add })
  }

  @Test
  func uncertainKeyAndAnchorCreationAreReconciledByFixedRereads() async throws {
    let configuration = try KeychainStoreConfiguration(
      accessGroup: "ABCDEFGHIJ.com.recurs.credentials"
    )

    let appliedKey = LockedKeychainSimulator()
    appliedKey.scriptNextAdd(status: -9_999, appliesSideEffect: true)
    let appliedKeyAuthenticator = KeychainJournalAuthenticator(
      client: appliedKey.client,
      configuration: configuration,
      randomBytes: { Data(UInt8.min...31) }
    )
    _ = try await appliedKeyAuthenticator.authenticate(
      previousTag: .zero,
      canonicalRecord: Data([1])
    )

    let missingKey = LockedKeychainSimulator()
    missingKey.scriptNextAdd(status: -9_999, appliesSideEffect: false)
    let missingKeyAuthenticator = KeychainJournalAuthenticator(
      client: missingKey.client,
      configuration: configuration,
      randomBytes: { Data(UInt8.min...31) }
    )
    await #expect(throws: BrokerJournalError.storageUnavailable) {
      _ = try await missingKeyAuthenticator.authenticate(
        previousTag: .zero,
        canonicalRecord: Data([1])
      )
    }

    let connectionID = UUID(uuidString: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")!
    let revisionOne = try journalAnchor(connectionID: connectionID, revision: 1, byte: 1)
    let appliedAnchor = LockedKeychainSimulator()
    appliedAnchor.scriptNextAdd(status: -9_999, appliesSideEffect: true)
    let appliedAnchorAuthenticator = KeychainJournalAuthenticator(
      client: appliedAnchor.client,
      configuration: configuration,
      randomBytes: { Data(repeating: 7, count: 32) }
    )
    try await appliedAnchorAuthenticator.compareAndSwapAnchor(
      expected: nil,
      replacement: revisionOne
    )
    #expect(try await appliedAnchorAuthenticator.anchor(for: connectionID) == revisionOne)

    let missingAnchor = LockedKeychainSimulator()
    missingAnchor.scriptNextAdd(status: -9_999, appliesSideEffect: false)
    let missingAnchorAuthenticator = KeychainJournalAuthenticator(
      client: missingAnchor.client,
      configuration: configuration,
      randomBytes: { Data(repeating: 7, count: 32) }
    )
    await #expect(throws: BrokerJournalError.storageUnavailable) {
      try await missingAnchorAuthenticator.compareAndSwapAnchor(
        expected: nil,
        replacement: revisionOne
      )
    }
    #expect(try await missingAnchorAuthenticator.anchor(for: connectionID) == nil)

    let unrelatedAnchor = LockedKeychainSimulator()
    let unrelatedData = independentAnchorEncoding(
      connectionID: connectionID,
      revision: 1,
      byte: 9
    )
    unrelatedAnchor.scriptNextAdd(
      status: -9_999,
      appliesSideEffect: true,
      replacementData: unrelatedData
    )
    let unrelatedAnchorAuthenticator = KeychainJournalAuthenticator(
      client: unrelatedAnchor.client,
      configuration: configuration,
      randomBytes: { Data(repeating: 7, count: 32) }
    )
    await #expect(throws: BrokerJournalError.casConflict) {
      try await unrelatedAnchorAuthenticator.compareAndSwapAnchor(
        expected: nil,
        replacement: revisionOne
      )
    }

    let unreadableAnchor = LockedKeychainSimulator()
    unreadableAnchor.scriptNextAdd(
      status: -9_999,
      appliesSideEffect: false,
      reconciliationReadStatus: errSecNotAvailable
    )
    let unreadableAnchorAuthenticator = KeychainJournalAuthenticator(
      client: unreadableAnchor.client,
      configuration: configuration,
      randomBytes: { Data(repeating: 7, count: 32) }
    )
    await #expect(throws: BrokerJournalError.mutationOutcomeUnknown) {
      try await unreadableAnchorAuthenticator.compareAndSwapAnchor(
        expected: nil,
        replacement: revisionOne
      )
    }
  }

  @Test
  func concurrentKeyCreationSelectsOneKeyWithoutSplitBrain() async throws {
    let keychain = RacingAuthenticationKeychain()
    let configuration = try KeychainStoreConfiguration(
      accessGroup: "ABCDEFGHIJ.com.recurs.credentials"
    )
    let first = KeychainJournalAuthenticator(
      client: keychain.client,
      configuration: configuration,
      randomBytes: { Data(repeating: 1, count: 32) }
    )
    let second = KeychainJournalAuthenticator(
      client: keychain.client,
      configuration: configuration,
      randomBytes: { Data(repeating: 2, count: 32) }
    )
    let record = Data(#"{"schemaVersion":1}"#.utf8)

    async let firstTag = first.authenticate(previousTag: .zero, canonicalRecord: record)
    async let secondTag = second.authenticate(previousTag: .zero, canonicalRecord: record)
    let (selectedFirst, selectedSecond) = try await (firstTag, secondTag)

    #expect(selectedFirst == selectedSecond)
    #expect(keychain.selectedKeyCount() == 1)
    #expect(
      try await first.authenticate(previousTag: .zero, canonicalRecord: record) == selectedFirst)
    #expect(
      try await second.authenticate(previousTag: .zero, canonicalRecord: record) == selectedFirst
    )
  }

  @Test
  func anchorsAreConnectionBoundSortedAndAdvanceByExactCAS() async throws {
    let keychain = LockedKeychainSimulator()
    let configuration = try KeychainStoreConfiguration(
      accessGroup: "ABCDEFGHIJ.com.recurs.credentials"
    )
    let authenticator = KeychainJournalAuthenticator(
      client: keychain.client,
      configuration: configuration,
      randomBytes: { Data(repeating: 7, count: 32) }
    )
    let highID = UUID(uuidString: "ffffffff-ffff-4fff-8fff-ffffffffffff")!
    let lowID = UUID(uuidString: "00000000-0000-4000-8000-000000000001")!
    let highOne = try journalAnchor(connectionID: highID, revision: 1, byte: 1)
    let lowOne = try journalAnchor(connectionID: lowID, revision: 1, byte: 2)
    let highTwo = try journalAnchor(connectionID: highID, revision: 2, byte: 3)

    try await authenticator.compareAndSwapAnchor(expected: nil, replacement: highOne)
    try await authenticator.compareAndSwapAnchor(expected: nil, replacement: lowOne)
    #expect(try await authenticator.anchor(for: highID) == highOne)
    #expect(
      try await authenticator.listAnchors().map(\.connectionID) == [lowID, highID]
    )
    try await authenticator.compareAndSwapAnchor(expected: highOne, replacement: highTwo)
    #expect(try await authenticator.anchor(for: highID) == highTwo)

    await #expect(throws: BrokerJournalError.casConflict) {
      try await authenticator.compareAndSwapAnchor(expected: highOne, replacement: highTwo)
    }
    let wrongTagAtRevisionOne = try journalAnchor(
      connectionID: highID,
      revision: 1,
      byte: 9
    )
    let updateCountBeforeWrongExpected = keychain.calls().filter {
      $0.operation == .update
    }.count
    await #expect(throws: BrokerJournalError.casConflict) {
      try await authenticator.compareAndSwapAnchor(
        expected: wrongTagAtRevisionOne,
        replacement: highTwo
      )
    }
    #expect(
      keychain.calls().filter { $0.operation == .update }.count
        == updateCountBeforeWrongExpected
    )
    let skipped = try journalAnchor(connectionID: highID, revision: 4, byte: 4)
    await #expect(throws: BrokerJournalError.casConflict) {
      try await authenticator.compareAndSwapAnchor(expected: highTwo, replacement: skipped)
    }

    let invalidInitialID = UUID(uuidString: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff")!
    let invalidInitial = try journalAnchor(
      connectionID: invalidInitialID,
      revision: 2,
      byte: 4
    )
    await #expect(throws: BrokerJournalError.casConflict) {
      try await authenticator.compareAndSwapAnchor(expected: nil, replacement: invalidInitial)
    }

    let maximumID = UUID(uuidString: "cccccccc-dddd-4eee-8fff-000000000001")!
    let maximum = try journalAnchor(connectionID: maximumID, revision: .max, byte: 5)
    let maximumData = independentAnchorEncoding(
      connectionID: maximumID,
      revision: .max,
      byte: 5
    )
    keychain.put(
      service: "com.recurs.cli.broker-journal-anchors.v1",
      account: maximumID.uuidString.lowercased(),
      data: maximumData,
      generic: maximumData
    )
    await #expect(throws: BrokerJournalError.revisionOverflow) {
      try await authenticator.compareAndSwapAnchor(expected: maximum, replacement: maximum)
    }

    let anchorCalls = keychain.calls().filter {
      $0.query.stringValue(for: kSecAttrService)
        == "com.recurs.cli.broker-journal-anchors.v1"
    }
    #expect(!anchorCalls.isEmpty)
    for call in anchorCalls {
      assertJournalBaseQuery(
        call.query,
        service: "com.recurs.cli.broker-journal-anchors.v1",
        accessGroup: configuration.accessGroup
      )
      #expect(call.query.boolValue(for: kSecReturnRef) == nil)
      #expect(call.query.boolValue(for: kSecReturnPersistentRef) == nil)
    }
    let update = try #require(anchorCalls.first { $0.operation == .update })
    #expect(update.query.dataValue(for: kSecAttrGeneric) != nil)
    #expect(update.query.dataValue(for: kSecValueData) == nil)
    #expect(
      update.attributes?.dataValue(for: kSecAttrGeneric)
        == update.attributes?.dataValue(for: kSecValueData))
  }

  @Test
  func uncertainAnchorMutationReconcilesOnlyExactReplacementOrPrevious() async throws {
    let connectionID = UUID(uuidString: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")!
    let revisionOne = try journalAnchor(connectionID: connectionID, revision: 1, byte: 1)
    let revisionTwo = try journalAnchor(connectionID: connectionID, revision: 2, byte: 2)
    let configuration = try KeychainStoreConfiguration(
      accessGroup: "ABCDEFGHIJ.com.recurs.credentials"
    )

    let applied = LockedKeychainSimulator()
    let appliedAuthenticator = KeychainJournalAuthenticator(
      client: applied.client,
      configuration: configuration,
      randomBytes: { Data(repeating: 7, count: 32) }
    )
    try await appliedAuthenticator.compareAndSwapAnchor(expected: nil, replacement: revisionOne)
    applied.scriptNextUpdate(status: -9_999, appliesSideEffect: true)
    try await appliedAuthenticator.compareAndSwapAnchor(
      expected: revisionOne,
      replacement: revisionTwo
    )
    #expect(try await appliedAuthenticator.anchor(for: connectionID) == revisionTwo)

    let notApplied = LockedKeychainSimulator()
    let notAppliedAuthenticator = KeychainJournalAuthenticator(
      client: notApplied.client,
      configuration: configuration,
      randomBytes: { Data(repeating: 7, count: 32) }
    )
    try await notAppliedAuthenticator.compareAndSwapAnchor(
      expected: nil,
      replacement: revisionOne
    )
    notApplied.scriptNextUpdate(status: -9_999, appliesSideEffect: false)
    await #expect(throws: BrokerJournalError.storageUnavailable) {
      try await notAppliedAuthenticator.compareAndSwapAnchor(
        expected: revisionOne,
        replacement: revisionTwo
      )
    }
    #expect(try await notAppliedAuthenticator.anchor(for: connectionID) == revisionOne)

    let unrelated = LockedKeychainSimulator()
    let unrelatedAuthenticator = KeychainJournalAuthenticator(
      client: unrelated.client,
      configuration: configuration,
      randomBytes: { Data(repeating: 7, count: 32) }
    )
    try await unrelatedAuthenticator.compareAndSwapAnchor(
      expected: nil,
      replacement: revisionOne
    )
    let unrelatedData = independentAnchorEncoding(
      connectionID: connectionID,
      revision: 2,
      byte: 9
    )
    unrelated.scriptNextUpdate(
      status: -9_999,
      appliesSideEffect: true,
      replacementData: unrelatedData
    )
    await #expect(throws: BrokerJournalError.casConflict) {
      try await unrelatedAuthenticator.compareAndSwapAnchor(
        expected: revisionOne,
        replacement: revisionTwo
      )
    }

    let unreadable = LockedKeychainSimulator()
    let unreadableAuthenticator = KeychainJournalAuthenticator(
      client: unreadable.client,
      configuration: configuration,
      randomBytes: { Data(repeating: 7, count: 32) }
    )
    try await unreadableAuthenticator.compareAndSwapAnchor(
      expected: nil,
      replacement: revisionOne
    )
    unreadable.scriptNextUpdate(
      status: -9_999,
      appliesSideEffect: false,
      reconciliationReadStatus: errSecNotAvailable
    )
    await #expect(throws: BrokerJournalError.mutationOutcomeUnknown) {
      try await unreadableAuthenticator.compareAndSwapAnchor(
        expected: revisionOne,
        replacement: revisionTwo
      )
    }

    let malformed = LockedKeychainSimulator()
    let malformedAuthenticator = KeychainJournalAuthenticator(
      client: malformed.client,
      configuration: configuration,
      randomBytes: { Data(repeating: 7, count: 32) }
    )
    try await malformedAuthenticator.compareAndSwapAnchor(
      expected: nil,
      replacement: revisionOne
    )
    malformed.scriptNextUpdate(
      status: -9_999,
      appliesSideEffect: true,
      replacementData: Data([0])
    )
    await #expect(throws: BrokerJournalError.rollbackDetected) {
      try await malformedAuthenticator.compareAndSwapAnchor(
        expected: revisionOne,
        replacement: revisionTwo
      )
    }
  }

  @Test
  func exactAnchorLimitAllowsTheLastAuthorityAndRejectsTheNextBeforeAdd() async throws {
    let configuration = try KeychainStoreConfiguration(
      accessGroup: "ABCDEFGHIJ.com.recurs.credentials"
    )
    let keychain = LockedKeychainSimulator()
    for index in 0..<1_023 {
      let connectionID = UUID(
        uuidString: String(format: "00000000-0000-4000-8000-%012llx", UInt64(index))
      )!
      let data = independentAnchorEncoding(
        connectionID: connectionID,
        revision: 1,
        byte: UInt8(truncatingIfNeeded: index)
      )
      keychain.put(
        service: "com.recurs.cli.broker-journal-anchors.v1",
        account: connectionID.uuidString.lowercased(),
        data: data,
        generic: data
      )
    }
    let authenticator = KeychainJournalAuthenticator(
      client: keychain.client,
      configuration: configuration,
      randomBytes: { Data(repeating: 7, count: 32) }
    )
    let lastID = UUID(uuidString: "ffffffff-ffff-4fff-8fff-fffffffffff0")!
    let last = try journalAnchor(connectionID: lastID, revision: 1, byte: 1)
    try await authenticator.compareAndSwapAnchor(expected: nil, replacement: last)
    #expect(try await authenticator.listAnchors().count == 1_024)

    let addCountAtLimit = keychain.calls().filter {
      $0.operation == .add
        && $0.query.stringValue(for: kSecAttrService)
          == "com.recurs.cli.broker-journal-anchors.v1"
    }.count
    let overflowID = UUID(uuidString: "ffffffff-ffff-4fff-8fff-fffffffffff1")!
    let overflow = try journalAnchor(connectionID: overflowID, revision: 1, byte: 2)
    await #expect(throws: BrokerJournalError.rollbackDetected) {
      try await authenticator.compareAndSwapAnchor(expected: nil, replacement: overflow)
    }
    #expect(
      keychain.calls().filter {
        $0.operation == .add
          && $0.query.stringValue(for: kSecAttrService)
            == "com.recurs.cli.broker-journal-anchors.v1"
      }.count == addCountAtLimit
    )
  }

  @Test
  func malformedDuplicateAndOverflowAnchorAuthorityFailClosed() async throws {
    let configuration = try KeychainStoreConfiguration(
      accessGroup: "ABCDEFGHIJ.com.recurs.credentials"
    )
    let malformed = LockedKeychainSimulator()
    malformed.put(
      service: "com.recurs.cli.broker-journal-anchors.v1",
      account: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      data: Data([1]),
      generic: Data([1])
    )
    let malformedAuthenticator = KeychainJournalAuthenticator(
      client: malformed.client,
      configuration: configuration,
      randomBytes: { Data(repeating: 7, count: 32) }
    )
    await #expect(throws: BrokerJournalError.rollbackDetected) {
      _ = try await malformedAuthenticator.listAnchors()
    }

    let typedMismatch = LockedKeychainSimulator()
    let typedMismatchID = UUID(uuidString: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff")!
    let validData = independentAnchorEncoding(
      connectionID: typedMismatchID,
      revision: 1,
      byte: 2
    )
    typedMismatch.put(
      service: "com.recurs.cli.broker-journal-anchors.v1",
      account: typedMismatchID.uuidString.lowercased(),
      data: validData,
      generic: Data([0])
    )
    let typedMismatchAuthenticator = KeychainJournalAuthenticator(
      client: typedMismatch.client,
      configuration: configuration,
      randomBytes: { Data(repeating: 7, count: 32) }
    )
    await #expect(throws: BrokerJournalError.rollbackDetected) {
      _ = try await typedMismatchAuthenticator.listAnchors()
    }

    let duplicateID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    let duplicateData = independentAnchorEncoding(
      connectionID: UUID(uuidString: duplicateID)!,
      revision: 1,
      byte: 1
    )
    let duplicateClient = KeychainClient(
      add: { _ in errSecSuccess },
      copyMatching: { query in
        guard
          query.stringValue(for: kSecAttrService)
            == "com.recurs.cli.broker-journal-anchors.v1"
        else {
          return KeychainCopyResult(status: errSecItemNotFound, items: [])
        }
        return KeychainCopyResult(
          status: errSecSuccess,
          items: [
            KeychainItem(account: duplicateID, data: duplicateData, generic: duplicateData),
            KeychainItem(account: duplicateID, data: duplicateData, generic: duplicateData),
          ]
        )
      },
      update: { _, _ in errSecSuccess },
      delete: { _ in errSecSuccess }
    )
    let duplicateAuthenticator = KeychainJournalAuthenticator(
      client: duplicateClient,
      configuration: configuration,
      randomBytes: { Data(repeating: 7, count: 32) }
    )
    await #expect(throws: BrokerJournalError.rollbackDetected) {
      _ = try await duplicateAuthenticator.listAnchors()
    }

    let overflowClient = KeychainClient(
      add: { _ in errSecSuccess },
      copyMatching: { query in
        guard
          query.stringValue(for: kSecAttrService)
            == "com.recurs.cli.broker-journal-anchors.v1"
        else {
          return KeychainCopyResult(status: errSecItemNotFound, items: [])
        }
        return KeychainCopyResult(
          status: errSecSuccess,
          items: (0...1_024).map { index in
            KeychainItem(
              account: String(format: "00000000-0000-4000-8000-%012llx", UInt64(index)),
              data: Data([1])
            )
          }
        )
      },
      update: { _, _ in errSecSuccess },
      delete: { _ in errSecSuccess }
    )
    let overflowAuthenticator = KeychainJournalAuthenticator(
      client: overflowClient,
      configuration: configuration,
      randomBytes: { Data(repeating: 7, count: 32) }
    )
    await #expect(throws: BrokerJournalError.rollbackDetected) {
      _ = try await overflowAuthenticator.listAnchors()
    }
  }

  @Test
  func keyAndAnchorReadFailuresMapToFixedStorageUnavailable() async throws {
    let configuration = try KeychainStoreConfiguration(
      accessGroup: "ABCDEFGHIJ.com.recurs.credentials"
    )
    let client = KeychainClient(
      add: { _ in errSecNotAvailable },
      copyMatching: { _ in KeychainCopyResult(status: errSecNotAvailable, items: []) },
      update: { _, _ in errSecNotAvailable },
      delete: { _ in errSecNotAvailable }
    )
    let authenticator = KeychainJournalAuthenticator(
      client: client,
      configuration: configuration,
      randomBytes: { Data(repeating: 7, count: 32) }
    )
    await #expect(throws: BrokerJournalError.storageUnavailable) {
      _ = try await authenticator.authenticate(
        previousTag: .zero,
        canonicalRecord: Data([1])
      )
    }
    let connectionID = UUID(uuidString: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")!
    await #expect(throws: BrokerJournalError.storageUnavailable) {
      _ = try await authenticator.anchor(for: connectionID)
    }
    await #expect(throws: BrokerJournalError.storageUnavailable) {
      _ = try await authenticator.listAnchors()
    }
  }
}

private func journalAnchor(
  connectionID: UUID,
  revision: UInt64,
  byte: UInt8
) throws -> BrokerJournalAnchor {
  try BrokerJournalAnchor(
    connectionID: connectionID,
    revision: revision,
    authenticationTag: JournalAuthenticationTag(bytes: [UInt8](repeating: byte, count: 32))
  )
}

private func independentAnchorEncoding(
  connectionID: UUID,
  revision: UInt64,
  byte: UInt8
) -> Data {
  var data = Data("RCA1".utf8)
  var uuid = connectionID.uuid
  withUnsafeBytes(of: &uuid) { data.append(contentsOf: $0) }
  var bigEndianRevision = revision.bigEndian
  withUnsafeBytes(of: &bigEndianRevision) { data.append(contentsOf: $0) }
  data.append(contentsOf: [UInt8](repeating: byte, count: 32))
  return data
}

private func assertJournalBaseQuery(
  _ query: KeychainQuery,
  service: String,
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
  #expect(query.stringValue(for: kSecAttrService) == service, sourceLocation: sourceLocation)
  #expect(
    query.stringValue(for: kSecAttrAccessGroup) == accessGroup, sourceLocation: sourceLocation)
  #expect(query.boolValue(for: kSecReturnRef) == nil, sourceLocation: sourceLocation)
  #expect(query.boolValue(for: kSecReturnPersistentRef) == nil, sourceLocation: sourceLocation)
}

private final class LockedKeychainSimulator: @unchecked Sendable {
  private struct StorageKey: Hashable {
    let service: String
    let account: String
  }

  private struct StoredItem {
    let data: Data
    let generic: Data?
  }

  private struct MutationScript {
    let status: OSStatus
    let appliesSideEffect: Bool
    let replacementData: Data?
    let reconciliationReadStatus: OSStatus?
  }

  private let lock = NSLock()
  private var storage: [StorageKey: StoredItem] = [:]
  private var recordedCalls: [JournalKeychainCall] = []
  private var addScripts: [MutationScript] = []
  private var copyStatuses: [OSStatus] = []
  private var updateScripts: [MutationScript] = []

  lazy var client = KeychainClient(
    add: { [unowned self] query in
      withLock {
        recordedCalls.append(JournalKeychainCall(operation: .add, query: query))
        guard let identity = identity(for: query), let data = query.dataValue(for: kSecValueData)
        else {
          return errSecParam
        }
        guard storage[identity] == nil else {
          return errSecDuplicateItem
        }
        let script = addScripts.isEmpty ? nil : addScripts.removeFirst()
        if script?.appliesSideEffect != false {
          let selectedData = script?.replacementData ?? data
          storage[identity] = StoredItem(
            data: selectedData,
            generic: script?.replacementData ?? query.dataValue(for: kSecAttrGeneric)
          )
        }
        if let reconciliationReadStatus = script?.reconciliationReadStatus {
          copyStatuses.append(reconciliationReadStatus)
        }
        return script?.status ?? errSecSuccess
      }
    },
    copyMatching: { [unowned self] query in
      withLock {
        recordedCalls.append(JournalKeychainCall(operation: .copy, query: query))
        if !copyStatuses.isEmpty {
          return KeychainCopyResult(status: copyStatuses.removeFirst(), items: [])
        }
        guard let service = query.stringValue(for: kSecAttrService) else {
          return KeychainCopyResult(status: errSecParam, items: [])
        }
        let requestedAccount = query.stringValue(for: kSecAttrAccount)
        let requestedGeneric = query.dataValue(for: kSecAttrGeneric)
        let items = storage.compactMap { key, item -> KeychainItem? in
          guard key.service == service else { return nil }
          guard requestedAccount == nil || requestedAccount == key.account else { return nil }
          guard requestedGeneric == nil || requestedGeneric == item.generic else { return nil }
          return KeychainItem(account: key.account, data: item.data, generic: item.generic)
        }.sorted { $0.account < $1.account }
        guard !items.isEmpty else {
          return KeychainCopyResult(status: errSecItemNotFound, items: [])
        }
        if query.stringValue(for: kSecMatchLimit) == kSecMatchLimitOne as String {
          return KeychainCopyResult(status: errSecSuccess, items: [items[0]])
        }
        return KeychainCopyResult(status: errSecSuccess, items: items)
      }
    },
    update: { [unowned self] query, attributes in
      withLock {
        recordedCalls.append(
          JournalKeychainCall(operation: .update, query: query, attributes: attributes)
        )
        guard
          let identity = identity(for: query),
          let existing = storage[identity],
          query.dataValue(for: kSecAttrGeneric) == existing.generic,
          let replacement = attributes.dataValue(for: kSecValueData)
        else {
          return errSecItemNotFound
        }
        let script = updateScripts.isEmpty ? nil : updateScripts.removeFirst()
        if script?.appliesSideEffect != false {
          let selectedData = script?.replacementData ?? replacement
          storage[identity] = StoredItem(
            data: selectedData,
            generic: script?.replacementData ?? attributes.dataValue(for: kSecAttrGeneric)
          )
        }
        if let reconciliationReadStatus = script?.reconciliationReadStatus {
          copyStatuses.append(reconciliationReadStatus)
        }
        return script?.status ?? errSecSuccess
      }
    },
    delete: { [unowned self] query in
      withLock {
        recordedCalls.append(JournalKeychainCall(operation: .delete, query: query))
        guard let identity = identity(for: query) else { return errSecParam }
        return storage.removeValue(forKey: identity) == nil ? errSecItemNotFound : errSecSuccess
      }
    }
  )

  func put(service: String, account: String, data: Data, generic: Data?) {
    withLock {
      storage[StorageKey(service: service, account: account)] = StoredItem(
        data: data,
        generic: generic
      )
    }
  }

  func scriptNextUpdate(
    status: OSStatus,
    appliesSideEffect: Bool,
    replacementData: Data? = nil,
    reconciliationReadStatus: OSStatus? = nil
  ) {
    withLock {
      updateScripts.append(
        MutationScript(
          status: status,
          appliesSideEffect: appliesSideEffect,
          replacementData: replacementData,
          reconciliationReadStatus: reconciliationReadStatus
        )
      )
    }
  }

  func scriptNextAdd(
    status: OSStatus,
    appliesSideEffect: Bool,
    replacementData: Data? = nil,
    reconciliationReadStatus: OSStatus? = nil
  ) {
    withLock {
      addScripts.append(
        MutationScript(
          status: status,
          appliesSideEffect: appliesSideEffect,
          replacementData: replacementData,
          reconciliationReadStatus: reconciliationReadStatus
        )
      )
    }
  }

  func calls() -> [JournalKeychainCall] {
    withLock { recordedCalls }
  }

  private func identity(for query: KeychainQuery) -> StorageKey? {
    guard
      let service = query.stringValue(for: kSecAttrService),
      let account = query.stringValue(for: kSecAttrAccount)
    else {
      return nil
    }
    return StorageKey(service: service, account: account)
  }

  private func withLock<Result>(_ body: () -> Result) -> Result {
    lock.lock()
    defer { lock.unlock() }
    return body()
  }
}

private final class RacingAuthenticationKeychain: @unchecked Sendable {
  private static let keyService = "com.recurs.cli.broker-journal-key.v1"
  private static let anchorService = "com.recurs.cli.broker-journal-anchors.v1"
  private static let keyMarker = Data("journal-authentication-key.v1".utf8)

  private let condition = NSCondition()
  private var initialAbsentSnapshots = 0
  private var selectedKey: Data?

  lazy var client = KeychainClient(
    add: { [unowned self] query in
      condition.lock()
      defer { condition.unlock() }
      guard
        query.stringValue(for: kSecAttrService) == Self.keyService,
        let candidate = query.dataValue(for: kSecValueData),
        query.dataValue(for: kSecAttrGeneric) == Self.keyMarker
      else {
        return errSecParam
      }
      guard selectedKey == nil else {
        return errSecDuplicateItem
      }
      selectedKey = candidate
      return errSecSuccess
    },
    copyMatching: { [unowned self] query in
      let service = query.stringValue(for: kSecAttrService)
      if service == Self.anchorService {
        return KeychainCopyResult(status: errSecItemNotFound, items: [])
      }
      guard service == Self.keyService else {
        return KeychainCopyResult(status: errSecParam, items: [])
      }

      condition.lock()
      if selectedKey == nil, initialAbsentSnapshots < 2 {
        initialAbsentSnapshots += 1
        if initialAbsentSnapshots == 2 {
          condition.broadcast()
        } else {
          while initialAbsentSnapshots < 2 {
            condition.wait()
          }
        }
        condition.unlock()
        return KeychainCopyResult(status: errSecItemNotFound, items: [])
      }
      let key = selectedKey
      condition.unlock()
      guard let key else {
        return KeychainCopyResult(status: errSecItemNotFound, items: [])
      }
      return KeychainCopyResult(
        status: errSecSuccess,
        items: [
          KeychainItem(
            account: "hmac-sha256.v1",
            data: key,
            generic: Self.keyMarker
          )
        ]
      )
    },
    update: { _, _ in errSecParam },
    delete: { _ in errSecParam }
  )

  func selectedKeyCount() -> Int {
    condition.lock()
    defer { condition.unlock() }
    return selectedKey == nil ? 0 : 1
  }
}

private enum JournalKeychainOperation: Sendable {
  case add
  case copy
  case update
  case delete
}

private struct JournalKeychainCall: @unchecked Sendable {
  let operation: JournalKeychainOperation
  let query: KeychainQuery
  let attributes: KeychainQuery?

  init(
    operation: JournalKeychainOperation,
    query: KeychainQuery,
    attributes: KeychainQuery? = nil
  ) {
    self.operation = operation
    self.query = query
    self.attributes = attributes
  }
}
