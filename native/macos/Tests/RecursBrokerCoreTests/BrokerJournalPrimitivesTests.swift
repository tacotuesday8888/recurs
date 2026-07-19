import Foundation
import Testing

@testable import RecursBrokerCore

@Suite("Broker journal primitives")
struct BrokerJournalPrimitivesTests {
  @Test
  func timestampAcceptsTheExactCanonicalBounds() throws {
    let minimum = try JournalTimestamp(
      canonicalText: "0001-01-01T00:00:00.000Z"
    )
    let maximum = try JournalTimestamp(
      canonicalText: "9999-12-31T23:59:59.999Z"
    )

    #expect(minimum.unixMilliseconds == -62_135_596_800_000)
    #expect(maximum.unixMilliseconds == 253_402_300_799_999)
    #expect(minimum.canonicalText == "0001-01-01T00:00:00.000Z")
    #expect(maximum.canonicalText == "9999-12-31T23:59:59.999Z")
  }

  @Test
  func timestampUsesFloorBasedNegativeMillisecondsAndGregorianLeapRules() throws {
    let beforeEpoch = try JournalTimestamp(unixMilliseconds: -1)
    let epoch = try JournalTimestamp(unixMilliseconds: 0)
    let leapDay = try JournalTimestamp(
      canonicalText: "2000-02-29T12:34:56.007Z"
    )

    #expect(beforeEpoch.canonicalText == "1969-12-31T23:59:59.999Z")
    #expect(epoch.canonicalText == "1970-01-01T00:00:00.000Z")
    #expect(leapDay.canonicalText == "2000-02-29T12:34:56.007Z")
    #expect(try JournalTimestamp(canonicalText: beforeEpoch.canonicalText) == beforeEpoch)
  }

  @Test
  func timestampRejectsOutOfRangeAndNoncanonicalInput() {
    #expect(throws: BrokerJournalError.invalidRecord) {
      _ = try JournalTimestamp(
        unixMilliseconds: JournalTimestamp.minimumUnixMilliseconds - 1
      )
    }
    #expect(throws: BrokerJournalError.invalidRecord) {
      _ = try JournalTimestamp(
        unixMilliseconds: JournalTimestamp.maximumUnixMilliseconds + 1
      )
    }

    let invalidTexts = [
      "",
      "0000-01-01T00:00:00.000Z",
      "10000-01-01T00:00:00.000Z",
      "2024-00-01T00:00:00.000Z",
      "2024-13-01T00:00:00.000Z",
      "2024-01-00T00:00:00.000Z",
      "2024-04-31T00:00:00.000Z",
      "1900-02-29T00:00:00.000Z",
      "2100-02-29T00:00:00.000Z",
      "2024-01-01T24:00:00.000Z",
      "2024-01-01T00:60:00.000Z",
      "2024-01-01T00:00:60.000Z",
      "2024-01-01t00:00:00.000Z",
      "2024-01-01T00:00:00.000z",
      "2024-01-01T00:00:00Z",
      "2024-01-01T00:00:00.000+00:00",
      " 2024-01-01T00:00:00.000Z",
      "２０２４-01-01T00:00:00.000Z",
    ]
    for text in invalidTexts {
      #expect(throws: BrokerJournalError.invalidRecord) {
        _ = try JournalTimestamp(canonicalText: text)
      }
    }
  }

  @Test
  func timestampCapturesDateOnceByFlooringAndRejectsUnsafeDates() throws {
    #expect(
      try JournalTimestamp(date: Date(timeIntervalSince1970: -0.000_1))
        .unixMilliseconds == -1
    )
    #expect(
      try JournalTimestamp(date: Date(timeIntervalSince1970: 0.000_9))
        .unixMilliseconds == 0
    )

    let captured = try JournalTimestamp(unixMilliseconds: 1_700_000_000_123)
    #expect(abs(captured.date.timeIntervalSince1970 - 1_700_000_000.123) < 0.000_001)

    for interval in [Double.nan, Double.infinity, -Double.infinity] {
      #expect(throws: BrokerJournalError.invalidRecord) {
        _ = try JournalTimestamp(date: Date(timeIntervalSince1970: interval))
      }
    }
    #expect(throws: BrokerJournalError.invalidRecord) {
      _ = try JournalTimestamp(
        date: Date(
          timeIntervalSince1970: Double(JournalTimestamp.minimumUnixMilliseconds - 1) / 1_000
        )
      )
    }
    #expect(throws: BrokerJournalError.invalidRecord) {
      _ = try JournalTimestamp(
        date: Date(
          timeIntervalSince1970: Double(JournalTimestamp.maximumUnixMilliseconds + 1) / 1_000
        )
      )
    }
  }

  @Test
  func authenticationTagCopiesExactlyThirtyTwoBytesAndUsesLowercaseHex() throws {
    var source = Array(UInt8(0)..<UInt8(32))
    let tag = try JournalAuthenticationTag(bytes: source)
    let expectedHex =
      "000102030405060708090a0b0c0d0e0f"
      + "101112131415161718191a1b1c1d1e1f"

    source[0] = 255
    #expect(tag.lowercaseHex == expectedHex)
    #expect(try JournalAuthenticationTag(lowercaseHex: expectedHex) == tag)

    var copied = tag.copiedBytes()
    copied[1] = 255
    #expect(tag.copiedBytes()[1] == 1)

    #expect(Array(Mirror(reflecting: tag).children).isEmpty)
    #expect(!String(describing: tag).contains(expectedHex))
    #expect(!String(reflecting: tag).contains(expectedHex))
  }

  @Test
  func authenticationTagRejectsEveryNoncanonicalShape() throws {
    #expect(JournalAuthenticationTag.zero.lowercaseHex == String(repeating: "0", count: 64))
    for count in [0, 31, 33] {
      #expect(throws: BrokerJournalError.invalidRecord) {
        _ = try JournalAuthenticationTag(bytes: [UInt8](repeating: 0, count: count))
      }
    }
    for text in [
      String(repeating: "0", count: 63),
      String(repeating: "0", count: 65),
      String(repeating: "A", count: 64),
      String(repeating: "g", count: 64),
      String(repeating: "０", count: 64),
    ] {
      #expect(throws: BrokerJournalError.invalidRecord) {
        _ = try JournalAuthenticationTag(lowercaseHex: text)
      }
    }
  }

  @Test
  func timestampIntegerCodecRoundTripsAcrossTheFullRange() throws {
    let span =
      UInt64(
        JournalTimestamp.maximumUnixMilliseconds - JournalTimestamp.minimumUnixMilliseconds
      ) + 1
    var state: UInt64 = 0x6a09_e667_f3bc_c909
    var mismatch: String?

    for iteration in 0..<100_000 {
      state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
      let milliseconds = JournalTimestamp.minimumUnixMilliseconds + Int64(state % span)
      let timestamp = try JournalTimestamp(unixMilliseconds: milliseconds)
      let parsed = try JournalTimestamp(canonicalText: timestamp.canonicalText)
      if parsed != timestamp {
        mismatch = "round trip \(iteration): \(milliseconds) -> \(timestamp.canonicalText)"
        break
      }
    }

    #expect(mismatch == nil, Comment(rawValue: mismatch ?? "all timestamps round-tripped"))
  }

  @Test
  func anchorRequiresANonzeroRevisionAndRetainsExactIdentity() throws {
    let connectionID = UUID(uuidString: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")!
    let anchor = try BrokerJournalAnchor(
      connectionID: connectionID,
      revision: 7,
      authenticationTag: .zero
    )

    #expect(anchor.connectionID == connectionID)
    #expect(anchor.revision == 7)
    #expect(anchor.authenticationTag == .zero)
    #expect(throws: BrokerJournalError.invalidRecord) {
      _ = try BrokerJournalAnchor(
        connectionID: connectionID,
        revision: 0,
        authenticationTag: .zero
      )
    }
  }

  @Test
  func journalErrorsAreExactPayloadFreeAndFixedAcrossAllTextSurfaces() {
    let expected: [(BrokerJournalError, String)] = [
      (.invalidRecord, "The broker journal record is invalid."),
      (.nonCanonical, "The broker journal encoding is not canonical."),
      (.unsupportedVersion, "The broker journal version is unsupported."),
      (.authenticationFailed, "Broker journal authentication failed."),
      (.rollbackDetected, "Broker journal rollback was detected."),
      (.revisionOverflow, "The broker journal revision cannot advance."),
      (.casConflict, "The broker journal changed concurrently."),
      (.lockUnavailable, "The broker journal lock is unavailable."),
      (.storageUnavailable, "Broker journal storage is unavailable."),
      (.mutationOutcomeUnknown, "The broker journal mutation outcome is unknown."),
    ]

    #expect(expected.count == 10)
    for (error, description) in expected {
      #expect(Array(Mirror(reflecting: error).children).isEmpty)
      #expect(String(describing: error) == description)
      #expect(String(reflecting: error) == description)
      #expect(error.localizedDescription == description)
      #expect(!description.contains("/"))
      #expect(!description.lowercased().contains("errno"))
      #expect(!description.contains("decoder-canary"))
    }
  }
}
