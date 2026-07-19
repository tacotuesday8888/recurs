import Darwin
import Foundation
import Testing

@testable import RecursLauncher

@Suite("TTY secret capture", .serialized)
struct TTYSecretCaptureTests {
  @Test
  func requiresAnExplicitUserPresentNonAutomatedTerminal() throws {
    #expect(throws: TTYSecretCaptureError.userPresenceRequired) {
      _ = try TTYSecretCaptureSession.open(
        manualUserPresent: false,
        automation: false
      )
    }
    #expect(throws: TTYSecretCaptureError.automationDenied) {
      _ = try TTYSecretCaptureSession.open(
        manualUserPresent: true,
        automation: true
      )
    }
  }

  @Test
  func capturesOpaqueBytesWithEchoDisabledAndRestoresTheTerminal() async throws {
    let terminal = try TestPseudoTerminal()
    let before = try terminal.attributes()
    let session = try TTYSecretCaptureSession(
      terminalDescriptor: terminal.duplicateSlave(),
      foregroundCheck: { _ in true }
    )

    let capture = Task { try await session.capture() }
    #expect(try terminal.readPrompt() == "Provider credential: ")

    let hidden = try terminal.attributes()
    #expect(hidden.c_lflag & tcflag_t(ECHO) == 0)
    #expect(hidden.c_lflag & tcflag_t(ECHONL) == 0)
    #expect(hidden.c_lflag & tcflag_t(ICANON) == before.c_lflag & tcflag_t(ICANON))
    #expect(hidden.c_lflag & tcflag_t(ISIG) == before.c_lflag & tcflag_t(ISIG))

    try terminal.writeInput(Array("opaque-test-value\n".utf8))
    let secret = try await capture.value
    #expect(secret.description == "<redacted>")
    #expect(secret.debugDescription == "<redacted>")
    #expect(Array(Mirror(reflecting: secret).children).isEmpty)
    #expect(secret.playgroundDescription as? String == "<redacted>")
    #expect(!((secret as Any) is any Encodable))
    #expect(!((secret as Any) is AnyHashable))
    #expect(secret.withUnsafeBytes { Array($0) } == Array("opaque-test-value".utf8))
    #expect(try terminal.readOutput(count: 2) == [0x0d, 0x0a])
    #expect(try terminal.attributeBytes() == termiosBytes(before))

    secret.erase()
    #expect(secret.withUnsafeBytes { $0.isEmpty })
  }

  @Test
  func cancellationRestoresTheTerminalWithoutReturningBytes() async throws {
    let terminal = try TestPseudoTerminal()
    let before = try terminal.attributeBytes()
    let session = try TTYSecretCaptureSession(
      terminalDescriptor: terminal.duplicateSlave(),
      foregroundCheck: { _ in true }
    )

    let capture = Task { try await session.capture() }
    _ = try terminal.readPrompt()
    session.cancel()

    await #expect(throws: TTYSecretCaptureError.cancelled) {
      _ = try await capture.value
    }
    #expect(try terminal.attributeBytes() == before)
  }

  @Test
  func invalidInputRestoresTheTerminalBeforeReturningAFixedError() async throws {
    let cases: [([UInt8], TTYSecretCaptureError)] = [
      ([0x0a], .emptySecret),
      ([0x61, 0x00, 0x0a], .invalidSecret),
    ]
    for (input, expected) in cases {
      let terminal = try TestPseudoTerminal()
      let before = try terminal.attributeBytes()
      let session = try TTYSecretCaptureSession(
        terminalDescriptor: terminal.duplicateSlave(),
        foregroundCheck: { _ in true }
      )
      let capture = Task { try await session.capture() }
      _ = try terminal.readPrompt()
      try terminal.writeInput(input)
      await #expect(throws: expected) {
        _ = try await capture.value
      }
      #expect(try terminal.readOutput(count: 2) == [0x0d, 0x0a])
      #expect(try terminal.attributeBytes() == before)
    }
  }

  @Test
  func taskAndPreCaptureCancellationAreStickyAndRestoreTheTerminal() async throws {
    let terminal = try TestPseudoTerminal()
    let before = try terminal.attributeBytes()
    let session = try TTYSecretCaptureSession(
      terminalDescriptor: terminal.duplicateSlave(),
      foregroundCheck: { _ in true }
    )
    let capture = Task { try await session.capture() }
    _ = try terminal.readPrompt()
    capture.cancel()
    await #expect(throws: TTYSecretCaptureError.cancelled) {
      _ = try await capture.value
    }
    #expect(try terminal.attributeBytes() == before)

    let preCancelled = try TTYSecretCaptureSession(
      terminalDescriptor: terminal.duplicateSlave(),
      foregroundCheck: { _ in true }
    )
    preCancelled.cancel()
    await #expect(throws: TTYSecretCaptureError.cancelled) {
      _ = try await preCancelled.capture()
    }
  }

  @Test
  func rejectsNonForegroundTTYAndMarksTheOwnedTerminalCloseOnExec() async throws {
    let terminal = try TestPseudoTerminal()
    let rejectedDescriptor = try terminal.duplicateSlave()
    let rejected = try TTYSecretCaptureSession(
      terminalDescriptor: rejectedDescriptor,
      foregroundCheck: { _ in false }
    )
    await #expect(throws: TTYSecretCaptureError.invalidTerminalMode) {
      _ = try await rejected.capture()
    }
    #expect(fcntl(rejectedDescriptor, F_GETFD) & FD_CLOEXEC != 0)

    let inheritedDescriptor = try terminal.duplicateSlave()
    #expect(fcntl(inheritedDescriptor, F_GETFD) & FD_CLOEXEC == 0)
    let accepted = try TTYSecretCaptureSession(
      terminalDescriptor: inheritedDescriptor,
      foregroundCheck: { _ in true }
    )
    #expect(fcntl(inheritedDescriptor, F_GETFD) & FD_CLOEXEC != 0)
    accepted.cancel()
  }

  @Test
  func accumulatorRejectsEmptyNulAndOversizedSecretsWithoutStringConversion() throws {
    var empty = TTYSecretAccumulator(maximumBytes: 4)
    #expect(throws: TTYSecretCaptureError.emptySecret) {
      _ = try empty.append([0x0a])
    }

    var nul = TTYSecretAccumulator(maximumBytes: 4)
    #expect(throws: TTYSecretCaptureError.invalidSecret) {
      _ = try nul.append([0x61, 0x00, 0x0a])
    }

    var oversized = TTYSecretAccumulator(maximumBytes: 4)
    #expect(throws: TTYSecretCaptureError.secretTooLong) {
      _ = try oversized.append([0x61, 0x62, 0x63, 0x64, 0x65])
    }

    var split = TTYSecretAccumulator(maximumBytes: 8)
    #expect(try split.append([0x61, 0x62]) == nil)
    let completed = try split.append([0x63, 0x0d, 0x0a])
    let bytes = try #require(completed)
    #expect(bytes == [0x61, 0x62, 0x63])
  }
}

private final class TestPseudoTerminal {
  private let master: Int32
  private let slave: Int32

  init() throws {
    var master: Int32 = -1
    var slave: Int32 = -1
    guard openpty(&master, &slave, nil, nil, nil) == 0 else {
      throw TTYTestError.system
    }
    self.master = master
    self.slave = slave
  }

  deinit {
    _ = Darwin.close(master)
    _ = Darwin.close(slave)
  }

  func duplicateSlave() throws -> Int32 {
    let descriptor = Darwin.dup(slave)
    guard descriptor >= 0 else { throw TTYTestError.system }
    return descriptor
  }

  func attributes() throws -> termios {
    var value = termios()
    guard tcgetattr(slave, &value) == 0 else { throw TTYTestError.system }
    return value
  }

  func attributeBytes() throws -> [UInt8] {
    termiosBytes(try attributes())
  }

  func readPrompt() throws -> String {
    String(decoding: try readOutput(count: 21), as: UTF8.self)
  }

  func readOutput(count: Int) throws -> [UInt8] {
    var bytes = [UInt8](repeating: 0, count: count)
    var offset = 0
    while offset < count {
      let result = bytes.withUnsafeMutableBytes { storage in
        Darwin.read(master, storage.baseAddress!.advanced(by: offset), count - offset)
      }
      guard result > 0 else { throw TTYTestError.system }
      offset += result
    }
    return bytes
  }

  func writeInput(_ bytes: [UInt8]) throws {
    var offset = 0
    while offset < bytes.count {
      let result = bytes.withUnsafeBytes { storage in
        Darwin.write(master, storage.baseAddress!.advanced(by: offset), bytes.count - offset)
      }
      guard result > 0 else { throw TTYTestError.system }
      offset += result
    }
  }
}

private enum TTYTestError: Error {
  case system
}

private func termiosBytes(_ value: termios) -> [UInt8] {
  withUnsafeBytes(of: value) { Array($0) }
}
