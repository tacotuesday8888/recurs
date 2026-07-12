import Foundation

struct BrokerJournalCanonicalJSONWriter {
  private(set) var bytes: [UInt8] = []

  mutating func append(_ value: String) {
    bytes.append(contentsOf: value.utf8)
  }

  mutating func append(_ value: Data) {
    bytes.append(contentsOf: value)
  }

  mutating func appendJSONString(_ value: String) {
    bytes.append(0x22)
    bytes.append(contentsOf: value.utf8)
    bytes.append(0x22)
  }

  mutating func appendUInt64(_ value: UInt64) {
    append(String(value))
  }

  var data: Data { Data(bytes) }
}

struct BrokerJournalCanonicalJSONCursor {
  private let bytes: [UInt8]
  private(set) var index = 0
  private var depth = 0

  init(data: Data) {
    bytes = Array(data)
  }

  mutating func beginObject() throws(BrokerJournalError) {
    try expect("{")
    depth += 1
    guard depth <= 12 else { throw .nonCanonical }
  }

  mutating func endObject() throws(BrokerJournalError) {
    try expect("}")
    depth -= 1
    guard depth >= 0 else { throw .nonCanonical }
  }

  mutating func beginArray() throws(BrokerJournalError) {
    try expect("[")
    depth += 1
    guard depth <= 12 else { throw .nonCanonical }
  }

  mutating func endArray() throws(BrokerJournalError) {
    try expect("]")
    depth -= 1
    guard depth >= 0 else { throw .nonCanonical }
  }

  mutating func expect(_ value: String) throws(BrokerJournalError) {
    let expected = Array(value.utf8)
    guard index + expected.count <= bytes.count else { throw .nonCanonical }
    for byte in expected {
      guard bytes[index] == byte else { throw .nonCanonical }
      index += 1
    }
  }

  mutating func consume(_ value: String) -> Bool {
    let expected = Array(value.utf8)
    guard index + expected.count <= bytes.count else { return false }
    for offset in expected.indices where bytes[index + offset] != expected[offset] {
      return false
    }
    index += expected.count
    return true
  }

  func isNext(_ value: String) -> Bool {
    let expected = Array(value.utf8)
    guard index + expected.count <= bytes.count else { return false }
    for offset in expected.indices where bytes[index + offset] != expected[offset] {
      return false
    }
    return true
  }

  mutating func parseString() throws(BrokerJournalError) -> String {
    try expect("\"")
    let start = index
    while index < bytes.count {
      let byte = bytes[index]
      if byte == 0x22 {
        let valueBytes = bytes[start..<index]
        index += 1
        guard valueBytes.allSatisfy({ $0 >= 0x20 && $0 < 0x7f && $0 != 0x5c }) else {
          throw .nonCanonical
        }
        return String(decoding: valueBytes, as: UTF8.self)
      }
      guard byte >= 0x20, byte < 0x7f, byte != 0x5c else { throw .nonCanonical }
      index += 1
    }
    throw .nonCanonical
  }

  mutating func parseUInt64() throws(BrokerJournalError) -> UInt64 {
    guard index < bytes.count, bytes[index] >= 0x30, bytes[index] <= 0x39 else {
      throw .nonCanonical
    }
    if bytes[index] == 0x30 {
      index += 1
      if index < bytes.count, bytes[index] >= 0x30, bytes[index] <= 0x39 {
        throw .nonCanonical
      }
      return 0
    }

    var value: UInt64 = 0
    while index < bytes.count, bytes[index] >= 0x30, bytes[index] <= 0x39 {
      let digit = UInt64(bytes[index] - 0x30)
      let (multiplied, multiplicationOverflow) = value.multipliedReportingOverflow(by: 10)
      let (advanced, additionOverflow) = multiplied.addingReportingOverflow(digit)
      guard !multiplicationOverflow, !additionOverflow else { throw .invalidRecord }
      value = advanced
      index += 1
    }
    return value
  }

  mutating func finish() throws(BrokerJournalError) {
    guard index == bytes.count, depth == 0 else { throw .nonCanonical }
  }
}

enum BrokerJournalNonSecretScanner {
  static func validate(_ data: Data) throws(BrokerJournalError) {
    guard data.count <= SecureDirectory.maximumEnvelopeBytes else {
      throw .invalidRecord
    }
    var scanner = Scanner(data: data)
    try scanner.parseValue(depth: 0)
    guard scanner.isAtEnd else { throw .invalidRecord }
  }

  private struct Scanner {
    private let bytes: [UInt8]
    private var index = 0

    init(data: Data) {
      bytes = Array(data)
    }

    var isAtEnd: Bool { index == bytes.count }

    mutating func parseValue(depth: Int) throws(BrokerJournalError) {
      guard index < bytes.count else { throw .invalidRecord }
      switch bytes[index] {
      case 0x7b:
        try parseObject(depth: depth)
      case 0x5b:
        try parseArray(depth: depth)
      case 0x22:
        let value = try parseString()
        guard !NonSecretPolicy.looksLikeSecretValue(value) else {
          throw .invalidRecord
        }
      case 0x6e:
        try expect("null")
      case 0x30...0x39:
        try parseUnsignedInteger()
      default:
        throw .invalidRecord
      }
    }

    private mutating func parseObject(depth: Int) throws(BrokerJournalError) {
      let nextDepth = depth + 1
      guard nextDepth <= 12 else { throw .invalidRecord }
      try expect("{")
      if consume("}") { return }
      while true {
        let key = try parseString()
        guard !NonSecretPolicy.isForbiddenKey(key) else {
          throw .invalidRecord
        }
        try expect(":")
        try parseValue(depth: nextDepth)
        if consume("}") { return }
        try expect(",")
      }
    }

    private mutating func parseArray(depth: Int) throws(BrokerJournalError) {
      let nextDepth = depth + 1
      guard nextDepth <= 12 else { throw .invalidRecord }
      try expect("[")
      if consume("]") { return }
      while true {
        try parseValue(depth: nextDepth)
        if consume("]") { return }
        try expect(",")
      }
    }

    private mutating func parseString() throws(BrokerJournalError) -> String {
      try expect("\"")
      let start = index
      while index < bytes.count {
        let byte = bytes[index]
        if byte == 0x22 {
          let valueBytes = bytes[start..<index]
          index += 1
          guard let value = String(bytes: valueBytes, encoding: .utf8) else {
            throw .invalidRecord
          }
          return value
        }
        guard byte >= 0x20, byte != 0x5c else { throw .invalidRecord }
        index += 1
      }
      throw .invalidRecord
    }

    private mutating func parseUnsignedInteger() throws(BrokerJournalError) {
      guard index < bytes.count else { throw .invalidRecord }
      if bytes[index] == 0x30 {
        index += 1
        guard index == bytes.count || !(0x30...0x39).contains(bytes[index]) else {
          throw .invalidRecord
        }
        return
      }
      guard (0x31...0x39).contains(bytes[index]) else { throw .invalidRecord }
      var value: UInt64 = 0
      while index < bytes.count, (0x30...0x39).contains(bytes[index]) {
        let digit = UInt64(bytes[index] - 0x30)
        let (multiplied, multiplicationOverflow) = value.multipliedReportingOverflow(by: 10)
        let (advanced, additionOverflow) = multiplied.addingReportingOverflow(digit)
        guard !multiplicationOverflow, !additionOverflow else { throw .invalidRecord }
        value = advanced
        index += 1
      }
    }

    private mutating func expect(_ value: String) throws(BrokerJournalError) {
      guard consume(value) else { throw .invalidRecord }
    }

    private mutating func consume(_ value: String) -> Bool {
      let expected = Array(value.utf8)
      guard index + expected.count <= bytes.count else { return false }
      for offset in expected.indices where bytes[index + offset] != expected[offset] {
        return false
      }
      index += expected.count
      return true
    }
  }
}
