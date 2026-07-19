import Foundation

package enum BrokerJournalError:
  Error,
  Sendable,
  Equatable,
  CustomStringConvertible,
  CustomDebugStringConvertible,
  LocalizedError
{
  case invalidRecord
  case nonCanonical
  case unsupportedVersion
  case authenticationFailed
  case rollbackDetected
  case revisionOverflow
  case casConflict
  case lockUnavailable
  case storageUnavailable
  case mutationOutcomeUnknown

  private var fixedDescription: String {
    switch self {
    case .invalidRecord:
      "The broker journal record is invalid."
    case .nonCanonical:
      "The broker journal encoding is not canonical."
    case .unsupportedVersion:
      "The broker journal version is unsupported."
    case .authenticationFailed:
      "Broker journal authentication failed."
    case .rollbackDetected:
      "Broker journal rollback was detected."
    case .revisionOverflow:
      "The broker journal revision cannot advance."
    case .casConflict:
      "The broker journal changed concurrently."
    case .lockUnavailable:
      "The broker journal lock is unavailable."
    case .storageUnavailable:
      "Broker journal storage is unavailable."
    case .mutationOutcomeUnknown:
      "The broker journal mutation outcome is unknown."
    }
  }

  package var description: String {
    fixedDescription
  }

  package var debugDescription: String {
    fixedDescription
  }

  package var errorDescription: String? {
    fixedDescription
  }
}

package struct JournalTimestamp: Sendable, Hashable {
  package static let minimumUnixMilliseconds: Int64 = -62_135_596_800_000
  package static let maximumUnixMilliseconds: Int64 = 253_402_300_799_999

  private static let millisecondsPerSecond: Int64 = 1_000
  private static let millisecondsPerMinute: Int64 = 60_000
  private static let millisecondsPerHour: Int64 = 3_600_000
  private static let millisecondsPerDay: Int64 = 86_400_000

  package let unixMilliseconds: Int64

  package init(unixMilliseconds: Int64) throws(BrokerJournalError) {
    guard
      unixMilliseconds >= Self.minimumUnixMilliseconds,
      unixMilliseconds <= Self.maximumUnixMilliseconds
    else {
      throw .invalidRecord
    }
    self.unixMilliseconds = unixMilliseconds
  }

  package init(canonicalText: String) throws(BrokerJournalError) {
    let bytes = Array(canonicalText.utf8)
    guard
      bytes.count == 24,
      bytes[4] == 45,
      bytes[7] == 45,
      bytes[10] == 84,
      bytes[13] == 58,
      bytes[16] == 58,
      bytes[19] == 46,
      bytes[23] == 90,
      let year = Self.decimal(bytes, at: 0, count: 4),
      let month = Self.decimal(bytes, at: 5, count: 2),
      let day = Self.decimal(bytes, at: 8, count: 2),
      let hour = Self.decimal(bytes, at: 11, count: 2),
      let minute = Self.decimal(bytes, at: 14, count: 2),
      let second = Self.decimal(bytes, at: 17, count: 2),
      let millisecond = Self.decimal(bytes, at: 20, count: 3),
      year >= 1,
      year <= 9_999,
      month >= 1,
      month <= 12,
      day >= 1,
      day <= Self.daysInMonth(year: year, month: month),
      hour < 24,
      minute < 60,
      second < 60
    else {
      throw .invalidRecord
    }

    let days = Self.daysSinceUnixEpoch(year: year, month: month, day: day)
    let unixMilliseconds =
      days * Self.millisecondsPerDay
      + hour * Self.millisecondsPerHour
      + minute * Self.millisecondsPerMinute
      + second * Self.millisecondsPerSecond
      + millisecond
    try self.init(unixMilliseconds: unixMilliseconds)
  }

  package init(date: Date) throws(BrokerJournalError) {
    let seconds = date.timeIntervalSince1970
    guard seconds.isFinite else {
      throw .invalidRecord
    }
    let milliseconds = (seconds * 1_000).rounded(.down)
    guard
      milliseconds.isFinite,
      milliseconds >= Double(Self.minimumUnixMilliseconds),
      milliseconds <= Double(Self.maximumUnixMilliseconds)
    else {
      throw .invalidRecord
    }
    try self.init(unixMilliseconds: Int64(milliseconds))
  }

  package var date: Date {
    Date(timeIntervalSince1970: Double(unixMilliseconds) / 1_000)
  }

  package var canonicalText: String {
    var day = unixMilliseconds / Self.millisecondsPerDay
    var withinDay = unixMilliseconds % Self.millisecondsPerDay
    if withinDay < 0 {
      day -= 1
      withinDay += Self.millisecondsPerDay
    }

    let civil = Self.civilDate(daysSinceUnixEpoch: day)
    let hour = withinDay / Self.millisecondsPerHour
    withinDay %= Self.millisecondsPerHour
    let minute = withinDay / Self.millisecondsPerMinute
    withinDay %= Self.millisecondsPerMinute
    let second = withinDay / Self.millisecondsPerSecond
    let millisecond = withinDay % Self.millisecondsPerSecond

    var bytes: [UInt8] = []
    bytes.reserveCapacity(24)
    Self.appendDecimal(civil.year, width: 4, to: &bytes)
    bytes.append(45)
    Self.appendDecimal(civil.month, width: 2, to: &bytes)
    bytes.append(45)
    Self.appendDecimal(civil.day, width: 2, to: &bytes)
    bytes.append(84)
    Self.appendDecimal(hour, width: 2, to: &bytes)
    bytes.append(58)
    Self.appendDecimal(minute, width: 2, to: &bytes)
    bytes.append(58)
    Self.appendDecimal(second, width: 2, to: &bytes)
    bytes.append(46)
    Self.appendDecimal(millisecond, width: 3, to: &bytes)
    bytes.append(90)
    return String(decoding: bytes, as: UTF8.self)
  }

  private static func decimal(
    _ bytes: [UInt8],
    at start: Int,
    count: Int
  ) -> Int64? {
    var value: Int64 = 0
    for index in start..<(start + count) {
      let byte = bytes[index]
      guard byte >= 48, byte <= 57 else {
        return nil
      }
      value = value * 10 + Int64(byte - 48)
    }
    return value
  }

  private static func appendDecimal(_ value: Int64, width: Int, to bytes: inout [UInt8]) {
    var divisor: Int64 = 1
    for _ in 1..<width {
      divisor *= 10
    }
    var remainder = value
    for _ in 0..<width {
      bytes.append(UInt8(remainder / divisor) + 48)
      remainder %= divisor
      if divisor > 1 {
        divisor /= 10
      }
    }
  }

  private static func daysInMonth(year: Int64, month: Int64) -> Int64 {
    switch month {
    case 2:
      let isLeap =
        year.isMultiple(of: 4)
        && (!year.isMultiple(of: 100) || year.isMultiple(of: 400))
      return isLeap ? 29 : 28
    case 4, 6, 9, 11:
      return 30
    default:
      return 31
    }
  }

  private static func daysSinceUnixEpoch(year: Int64, month: Int64, day: Int64) -> Int64 {
    let adjustedYear = year - (month <= 2 ? 1 : 0)
    let era = adjustedYear / 400
    let yearOfEra = adjustedYear - era * 400
    let adjustedMonth = month + (month > 2 ? -3 : 9)
    let dayOfYear = (153 * adjustedMonth + 2) / 5 + day - 1
    let dayOfEra = yearOfEra * 365 + yearOfEra / 4 - yearOfEra / 100 + dayOfYear
    return era * 146_097 + dayOfEra - 719_468
  }

  private static func civilDate(
    daysSinceUnixEpoch: Int64
  ) -> (year: Int64, month: Int64, day: Int64) {
    let shiftedDays = daysSinceUnixEpoch + 719_468
    let era = shiftedDays / 146_097
    let dayOfEra = shiftedDays - era * 146_097
    let yearOfEra =
      (dayOfEra - dayOfEra / 1_460 + dayOfEra / 36_524 - dayOfEra / 146_096) / 365
    var year = yearOfEra + era * 400
    let dayOfYear = dayOfEra - (365 * yearOfEra + yearOfEra / 4 - yearOfEra / 100)
    let monthPrime = (5 * dayOfYear + 2) / 153
    let day = dayOfYear - (153 * monthPrime + 2) / 5 + 1
    let month = monthPrime + (monthPrime < 10 ? 3 : -9)
    year += month <= 2 ? 1 : 0
    return (year, month, day)
  }
}

package struct JournalAuthenticationTag:
  Sendable,
  Hashable,
  CustomStringConvertible,
  CustomDebugStringConvertible,
  CustomReflectable
{
  package static let byteCount = 32
  package static let zero = JournalAuthenticationTag(
    uncheckedBytes: [UInt8](repeating: 0, count: byteCount)
  )

  private let storage: [UInt8]

  package init<Bytes: Collection>(bytes: Bytes) throws(BrokerJournalError)
  where Bytes.Element == UInt8 {
    let copied = Array(bytes)
    guard copied.count == Self.byteCount else {
      throw .invalidRecord
    }
    storage = copied
  }

  package init(lowercaseHex: String) throws(BrokerJournalError) {
    let encoded = Array(lowercaseHex.utf8)
    guard encoded.count == Self.byteCount * 2 else {
      throw .invalidRecord
    }

    var decoded: [UInt8] = []
    decoded.reserveCapacity(Self.byteCount)
    for index in stride(from: 0, to: encoded.count, by: 2) {
      guard
        let high = Self.hexNibble(encoded[index]),
        let low = Self.hexNibble(encoded[index + 1])
      else {
        throw .invalidRecord
      }
      decoded.append(high << 4 | low)
    }
    storage = decoded
  }

  private init(uncheckedBytes: [UInt8]) {
    storage = uncheckedBytes
  }

  package var lowercaseHex: String {
    let digits = Array("0123456789abcdef".utf8)
    var encoded: [UInt8] = []
    encoded.reserveCapacity(Self.byteCount * 2)
    for byte in storage {
      encoded.append(digits[Int(byte >> 4)])
      encoded.append(digits[Int(byte & 0x0f)])
    }
    return String(decoding: encoded, as: UTF8.self)
  }

  package func copiedBytes() -> [UInt8] {
    Array(storage)
  }

  package var description: String {
    "<journal-authentication-tag>"
  }

  package var debugDescription: String {
    description
  }

  package var customMirror: Mirror {
    let children: [(label: String?, value: Any)] = []
    return Mirror(self, children: children, displayStyle: .struct)
  }

  private static func hexNibble(_ byte: UInt8) -> UInt8? {
    switch byte {
    case 48...57:
      byte - 48
    case 97...102:
      byte - 87
    default:
      nil
    }
  }
}

package struct BrokerJournalAnchor: Sendable, Hashable {
  package let connectionID: UUID
  package let revision: UInt64
  package let authenticationTag: JournalAuthenticationTag

  package init(
    connectionID: UUID,
    revision: UInt64,
    authenticationTag: JournalAuthenticationTag
  ) throws(BrokerJournalError) {
    guard revision > 0 else {
      throw .invalidRecord
    }
    self.connectionID = connectionID
    self.revision = revision
    self.authenticationTag = authenticationTag
  }
}
