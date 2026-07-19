import Foundation
import Testing

@testable import RecursBrokerCore

@Suite("Deterministic broker journal authenticator")
struct DeterministicBrokerJournalAuthenticatorTests {
  @Test
  func authenticationUsesTheExactDomainPreviousTagRecordByteOrder() async throws {
    let authenticator = DeterministicBrokerJournalAuthenticator()
    let previousTag = try JournalAuthenticationTag(bytes: Array(UInt8.min...31))
    let canonicalRecord = Data(#"{"schemaVersion":1}"#.utf8)

    let tag = try await authenticator.authenticate(
      previousTag: previousTag,
      canonicalRecord: canonicalRecord
    )

    #expect(
      tag.lowercaseHex == "20e1d38f25c413622d0cdb63b7bdf6d5b25ddf10335fb64cd212126b6dfaf8b1"
    )
  }

  @Test
  func verificationAcceptsOnlyTheExactAuthenticationInput() async throws {
    let authenticator = DeterministicBrokerJournalAuthenticator()
    let canonicalRecord = Data(#"{"schemaVersion":1}"#.utf8)
    let tag = try await authenticator.authenticate(
      previousTag: .zero,
      canonicalRecord: canonicalRecord
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
    await #expect(throws: BrokerJournalError.authenticationFailed) {
      try await authenticator.verify(
        previousTag: try JournalAuthenticationTag(bytes: [1] + [UInt8](repeating: 0, count: 31)),
        canonicalRecord: canonicalRecord,
        tag: tag
      )
    }
  }

  @Test
  func anchorLookupAndListingAreUniqueBoundedAndCanonicallySorted() async throws {
    let high = try anchor("ffffffff-ffff-4fff-8fff-ffffffffffff", revision: 3, byte: 3)
    let low = try anchor("00000000-0000-4000-8000-000000000001", revision: 1, byte: 1)
    let middle = try anchor("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", revision: 2, byte: 2)
    let authenticator = DeterministicBrokerJournalAuthenticator(
      anchors: [high, low, middle]
    )

    #expect(try await authenticator.anchor(for: middle.connectionID) == middle)
    #expect(
      try await authenticator.listAnchors().map(\.connectionID)
        == [low.connectionID, middle.connectionID, high.connectionID]
    )
  }

  @Test
  func duplicateAndOverflowAnchorFixturesAreRejected() async throws {
    let duplicateOne = try anchor(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      revision: 1,
      byte: 1
    )
    let duplicateTwo = try anchor(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      revision: 2,
      byte: 2
    )
    let duplicateAuthenticator = DeterministicBrokerJournalAuthenticator(
      anchors: [duplicateOne, duplicateTwo]
    )
    await #expect(throws: BrokerJournalError.rollbackDetected) {
      _ = try await duplicateAuthenticator.listAnchors()
    }

    let overflow = try (0...1_024).map { index in
      try anchor(
        "00000000-0000-4000-8000-\(String(format: "%012llx", UInt64(index)))",
        revision: 1,
        byte: UInt8(truncatingIfNeeded: index)
      )
    }
    let maximumAuthenticator = DeterministicBrokerJournalAuthenticator(
      anchors: Array(overflow.dropLast())
    )
    #expect(try await maximumAuthenticator.listAnchors().count == 1_024)

    let overflowAuthenticator = DeterministicBrokerJournalAuthenticator(anchors: overflow)
    await #expect(throws: BrokerJournalError.rollbackDetected) {
      _ = try await overflowAuthenticator.listAnchors()
    }
  }

  @Test
  func anchorCompareAndSwapRequiresTheExactExpectedAnchorAndRevision() async throws {
    let connectionID = UUID(uuidString: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")!
    let revisionOne = try BrokerJournalAnchor(
      connectionID: connectionID,
      revision: 1,
      authenticationTag: JournalAuthenticationTag(bytes: [UInt8](repeating: 1, count: 32))
    )
    let revisionTwo = try BrokerJournalAnchor(
      connectionID: connectionID,
      revision: 2,
      authenticationTag: JournalAuthenticationTag(bytes: [UInt8](repeating: 2, count: 32))
    )
    let authenticator = DeterministicBrokerJournalAuthenticator()

    try await authenticator.compareAndSwapAnchor(expected: nil, replacement: revisionOne)
    await #expect(throws: BrokerJournalError.casConflict) {
      try await authenticator.compareAndSwapAnchor(expected: nil, replacement: revisionOne)
    }
    await #expect(throws: BrokerJournalError.casConflict) {
      let wrongExpected = try BrokerJournalAnchor(
        connectionID: connectionID,
        revision: 1,
        authenticationTag: JournalAuthenticationTag(bytes: [UInt8](repeating: 9, count: 32))
      )
      try await authenticator.compareAndSwapAnchor(
        expected: wrongExpected,
        replacement: revisionTwo
      )
    }
    #expect(try await authenticator.anchor(for: connectionID) == revisionOne)

    try await authenticator.compareAndSwapAnchor(
      expected: revisionOne,
      replacement: revisionTwo
    )
    #expect(try await authenticator.anchor(for: connectionID) == revisionTwo)

    let skippedRevision = try BrokerJournalAnchor(
      connectionID: connectionID,
      revision: 4,
      authenticationTag: JournalAuthenticationTag(bytes: [UInt8](repeating: 4, count: 32))
    )
    await #expect(throws: BrokerJournalError.casConflict) {
      try await authenticator.compareAndSwapAnchor(
        expected: revisionTwo,
        replacement: skippedRevision
      )
    }
    #expect(try await authenticator.anchor(for: connectionID) == revisionTwo)
  }

  @Test
  func anchorCASChecksStoredExpectedIdentityBeforeRevisionOverflow() async throws {
    let connectionID = UUID(uuidString: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")!
    let nonexistentConnectionID = UUID(uuidString: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff")!
    let currentMaximum = try BrokerJournalAnchor(
      connectionID: connectionID,
      revision: .max,
      authenticationTag: JournalAuthenticationTag(bytes: [UInt8](repeating: 1, count: 32))
    )
    let staleMaximum = try BrokerJournalAnchor(
      connectionID: connectionID,
      revision: .max,
      authenticationTag: JournalAuthenticationTag(bytes: [UInt8](repeating: 2, count: 32))
    )
    let nonexistentMaximum = try BrokerJournalAnchor(
      connectionID: nonexistentConnectionID,
      revision: .max,
      authenticationTag: JournalAuthenticationTag(bytes: [UInt8](repeating: 3, count: 32))
    )
    let authenticator = DeterministicBrokerJournalAuthenticator(anchors: [currentMaximum])

    await #expect(throws: BrokerJournalError.casConflict) {
      try await authenticator.compareAndSwapAnchor(
        expected: staleMaximum,
        replacement: staleMaximum
      )
    }
    await #expect(throws: BrokerJournalError.casConflict) {
      try await authenticator.compareAndSwapAnchor(
        expected: nonexistentMaximum,
        replacement: nonexistentMaximum
      )
    }
    await #expect(throws: BrokerJournalError.revisionOverflow) {
      try await authenticator.compareAndSwapAnchor(
        expected: currentMaximum,
        replacement: currentMaximum
      )
    }
    #expect(try await authenticator.anchor(for: connectionID) == currentMaximum)
  }

  @Test
  func scriptedAnchorCASBarriersExposeTheExactSideEffectBoundary() async throws {
    let replacement = try anchor(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      revision: 1,
      byte: 1
    )
    let beforeAuthenticator = DeterministicBrokerJournalAuthenticator()
    await beforeAuthenticator.pauseNext(at: .compareAndSwapBeforeSideEffect)
    let beforeOperation = Task {
      try await beforeAuthenticator.compareAndSwapAnchor(
        expected: nil,
        replacement: replacement
      )
    }
    await beforeAuthenticator.waitUntilPaused(at: .compareAndSwapBeforeSideEffect)
    #expect(try await beforeAuthenticator.anchor(for: replacement.connectionID) == nil)
    await beforeAuthenticator.releaseOne(at: .compareAndSwapBeforeSideEffect)
    try await beforeOperation.value
    #expect(try await beforeAuthenticator.anchor(for: replacement.connectionID) == replacement)

    let afterAuthenticator = DeterministicBrokerJournalAuthenticator()
    await afterAuthenticator.pauseNext(at: .compareAndSwapAfterSideEffect)
    let afterOperation = Task {
      try await afterAuthenticator.compareAndSwapAnchor(
        expected: nil,
        replacement: replacement
      )
    }
    await afterAuthenticator.waitUntilPaused(at: .compareAndSwapAfterSideEffect)
    #expect(try await afterAuthenticator.anchor(for: replacement.connectionID) == replacement)
    await afterAuthenticator.releaseOne(at: .compareAndSwapAfterSideEffect)
    try await afterOperation.value
  }

  @Test
  func scriptedAnchorCASFailuresReportWhetherTheSideEffectOccurred() async throws {
    let replacement = try anchor(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      revision: 1,
      byte: 1
    )
    let beforeAuthenticator = DeterministicBrokerJournalAuthenticator()
    await beforeAuthenticator.failNext(at: .compareAndSwapBeforeSideEffect)
    await #expect(throws: BrokerJournalError.storageUnavailable) {
      try await beforeAuthenticator.compareAndSwapAnchor(
        expected: nil,
        replacement: replacement
      )
    }
    #expect(try await beforeAuthenticator.anchor(for: replacement.connectionID) == nil)

    let afterAuthenticator = DeterministicBrokerJournalAuthenticator()
    await afterAuthenticator.failNext(at: .compareAndSwapAfterSideEffect)
    await #expect(throws: BrokerJournalError.mutationOutcomeUnknown) {
      try await afterAuthenticator.compareAndSwapAnchor(
        expected: nil,
        replacement: replacement
      )
    }
    #expect(try await afterAuthenticator.anchor(for: replacement.connectionID) == replacement)
  }

  @Test
  func authenticatorReflectionDoesNotRetainOrExposeRecordOrKeyMaterial() async throws {
    let authenticator = DeterministicBrokerJournalAuthenticator()
    let canary = "credential-canary-must-not-be-retained"
    _ = try await authenticator.authenticate(
      previousTag: .zero,
      canonicalRecord: Data(canary.utf8)
    )

    #expect(Array(Mirror(reflecting: authenticator).children).isEmpty)
    #expect(!String(reflecting: authenticator).contains(canary))
  }

  private func anchor(
    _ connectionID: String,
    revision: UInt64,
    byte: UInt8
  ) throws -> BrokerJournalAnchor {
    try BrokerJournalAnchor(
      connectionID: UUID(uuidString: connectionID)!,
      revision: revision,
      authenticationTag: JournalAuthenticationTag(
        bytes: [UInt8](repeating: byte, count: JournalAuthenticationTag.byteCount)
      )
    )
  }
}
