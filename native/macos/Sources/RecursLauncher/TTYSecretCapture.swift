import Darwin
import Foundation
import RecursBrokerXPC

package enum TTYSecretCaptureError: Error, Equatable, Sendable {
  case userPresenceRequired
  case automationDenied
  case terminalUnavailable
  case invalidTerminalMode
  case alreadyUsed
  case cancelled
  case emptySecret
  case invalidSecret
  case secretTooLong
  case inputOutputFailure
  case terminalRestoreFailure
}

package final class TTYSecret:
  @unchecked Sendable,
  CustomStringConvertible,
  CustomDebugStringConvertible,
  CustomReflectable,
  CustomPlaygroundDisplayConvertible
{
  private let lock = NSLock()
  private var storage: [UInt8]

  init(_ bytes: consuming [UInt8]) {
    storage = bytes
  }

  deinit {
    erase()
  }

  package func withUnsafeBytes<Result>(
    _ body: (UnsafeRawBufferPointer) throws -> Result
  ) rethrows -> Result {
    try lock.withLock {
      try storage.withUnsafeBytes(body)
    }
  }

  package func erase() {
    lock.withLock {
      _ = storage.withUnsafeMutableBytes { bytes in
        bytes.initializeMemory(as: UInt8.self, repeating: 0)
      }
      storage.removeAll(keepingCapacity: false)
    }
  }

  package var description: String { "<redacted>" }
  package var debugDescription: String { "<redacted>" }
  package var customMirror: Mirror {
    Mirror(
      self,
      children: EmptyCollection<(label: String?, value: Any)>(),
      displayStyle: .class
    )
  }
  package var playgroundDescription: Any { "<redacted>" }
}

struct TTYSecretAccumulator {
  private let maximumBytes: Int
  private var storage: [UInt8] = []

  init(maximumBytes: Int) {
    precondition(maximumBytes > 0)
    self.maximumBytes = maximumBytes
    storage.reserveCapacity(maximumBytes)
  }

  mutating func append<Bytes: Collection>(
    _ chunk: Bytes
  ) throws(TTYSecretCaptureError) -> [UInt8]? where Bytes.Element == UInt8 {
    let newline = chunk.firstIndex(of: 0x0a)
    let payload = newline.map { chunk[..<$0] } ?? chunk[...]
    guard !payload.contains(0) else {
      erase()
      throw .invalidSecret
    }
    guard payload.count <= maximumBytes - storage.count else {
      erase()
      throw .secretTooLong
    }
    storage.append(contentsOf: payload)
    guard newline != nil else { return nil }
    if storage.last == 0x0d {
      storage[storage.count - 1] = 0
      storage.removeLast()
    }
    guard !storage.isEmpty else {
      erase()
      throw .emptySecret
    }
    let result = storage
    storage = []
    return result
  }

  fileprivate mutating func erase() {
    _ = storage.withUnsafeMutableBytes { bytes in
      bytes.initializeMemory(as: UInt8.self, repeating: 0)
    }
    storage.removeAll(keepingCapacity: false)
  }
}

// The process coordinator owns this; onboarding intentionally does not expose it.
final class TTYSecretCaptureSession: @unchecked Sendable {
  private enum Phase {
    case open
    case capturing
    case complete
  }

  private static let prompt = Array("Provider credential: ".utf8)

  private let lock = NSLock()
  private let terminalDescriptor: Int32
  private let cancellationReadDescriptor: Int32
  private let cancellationWriteDescriptor: Int32
  private let foregroundCheck: @Sendable (Int32) -> Bool
  private var phase = Phase.open
  private var isCancelled = false

  static func open(
    manualUserPresent: Bool,
    automation: Bool
  ) throws(TTYSecretCaptureError) -> TTYSecretCaptureSession {
    guard manualUserPresent else { throw .userPresenceRequired }
    guard !automation else { throw .automationDenied }
    let descriptor = Darwin.open(
      "/dev/tty",
      O_RDWR | O_NOCTTY | O_CLOEXEC
    )
    guard descriptor >= 0 else { throw .terminalUnavailable }
    return try TTYSecretCaptureSession(terminalDescriptor: descriptor)
  }

  init(
    terminalDescriptor: Int32,
    foregroundCheck: @escaping @Sendable (Int32) -> Bool = {
      tcgetpgrp($0) == getpgrp()
    }
  ) throws(TTYSecretCaptureError) {
    guard terminalDescriptor >= 0, isatty(terminalDescriptor) == 1 else {
      if terminalDescriptor >= 0 { _ = Darwin.close(terminalDescriptor) }
      throw .terminalUnavailable
    }

    guard Self.setCloseOnExec(terminalDescriptor) else {
      _ = Darwin.close(terminalDescriptor)
      throw .terminalUnavailable
    }

    var descriptors = [Int32](repeating: -1, count: 2)
    guard Darwin.pipe(&descriptors) == 0 else {
      _ = Darwin.close(terminalDescriptor)
      throw .terminalUnavailable
    }
    guard
      terminalDescriptor < FD_SETSIZE,
      descriptors[0] < FD_SETSIZE,
      fcntl(descriptors[0], F_SETFD, FD_CLOEXEC) == 0,
      fcntl(descriptors[1], F_SETFD, FD_CLOEXEC) == 0
    else {
      _ = Darwin.close(descriptors[0])
      _ = Darwin.close(descriptors[1])
      _ = Darwin.close(terminalDescriptor)
      throw .terminalUnavailable
    }

    self.terminalDescriptor = terminalDescriptor
    cancellationReadDescriptor = descriptors[0]
    cancellationWriteDescriptor = descriptors[1]
    self.foregroundCheck = foregroundCheck
  }

  deinit {
    _ = Darwin.close(terminalDescriptor)
    _ = Darwin.close(cancellationReadDescriptor)
    _ = Darwin.close(cancellationWriteDescriptor)
  }

  func cancel() {
    let shouldSignal = lock.withLock { () -> Bool in
      guard phase != .complete, !isCancelled else { return false }
      isCancelled = true
      return true
    }
    guard shouldSignal else { return }
    var byte: UInt8 = 1
    while Darwin.write(cancellationWriteDescriptor, &byte, 1) < 0 {
      if errno != EINTR { break }
    }
  }

  func capture() async throws(TTYSecretCaptureError) -> TTYSecret {
    do {
      return try await withTaskCancellationHandler {
        if Task.isCancelled { cancel() }
        return try await Task.detached { [self] in
          try captureBlocking()
        }.value
      } onCancel: { [self] in
        cancel()
      }
    } catch let error as TTYSecretCaptureError {
      throw error
    } catch {
      throw .inputOutputFailure
    }
  }

  private func captureBlocking() throws(TTYSecretCaptureError) -> TTYSecret {
    let claimed = lock.withLock { () -> Bool in
      guard phase == .open else { return false }
      guard !isCancelled else {
        phase = .complete
        return false
      }
      phase = .capturing
      return true
    }
    guard claimed else {
      let cancelled = lock.withLock { isCancelled }
      throw cancelled ? .cancelled : .alreadyUsed
    }
    var completed = false
    defer {
      if !completed {
        lock.withLock { phase = .complete }
      }
    }

    var original = termios()
    guard tcgetattr(terminalDescriptor, &original) == 0 else {
      throw .terminalUnavailable
    }
    guard
      original.c_lflag & tcflag_t(ICANON) != 0,
      original.c_lflag & tcflag_t(ISIG) != 0
    else {
      throw .invalidTerminalMode
    }
    guard foregroundCheck(terminalDescriptor) else {
      throw .invalidTerminalMode
    }

    var hidden = original
    hidden.c_lflag &= ~tcflag_t(ECHO | ECHONL)
    guard Self.setAttributes(&hidden, on: terminalDescriptor) else {
      throw .terminalUnavailable
    }

    let result: Result<TTYSecret, TTYSecretCaptureError>
    do {
      try Self.writeAll(Self.prompt, to: terminalDescriptor)
      var bytes = try readSecret()
      if lock.withLock({ isCancelled }) {
        Self.erase(&bytes)
        throw TTYSecretCaptureError.cancelled
      }
      result = .success(TTYSecret(bytes))
    } catch let error as TTYSecretCaptureError {
      result = .failure(error)
    } catch {
      result = .failure(.inputOutputFailure)
    }

    guard Self.setAttributes(&original, on: terminalDescriptor) else {
      if case .success(let secret) = result { secret.erase() }
      throw .terminalRestoreFailure
    }
    do {
      try Self.writeAll([0x0a], to: terminalDescriptor)
    } catch {
      if case .success(let secret) = result { secret.erase() }
      throw .inputOutputFailure
    }
    switch result {
    case .failure(let error):
      throw error
    case .success(let secret):
      let mayReturn = lock.withLock { () -> Bool in
        guard !isCancelled else {
          phase = .complete
          return false
        }
        phase = .complete
        return true
      }
      completed = true
      guard mayReturn else {
        secret.erase()
        throw .cancelled
      }
      return secret
    }
  }

  private func readSecret() throws(TTYSecretCaptureError) -> [UInt8] {
    var accumulator = TTYSecretAccumulator(
      maximumBytes: brokerCredentialMaximumSecretBytes
    )
    var buffer = [UInt8](repeating: 0, count: 512)
    defer {
      accumulator.erase()
      _ = buffer.withUnsafeMutableBytes { bytes in
        bytes.initializeMemory(as: UInt8.self, repeating: 0)
      }
    }

    while true {
      // Darwin's /dev/tty proxy is selectable but reports POLLNVAL to poll.
      var readDescriptors = fd_set()
      __darwin_fd_set(terminalDescriptor, &readDescriptors)
      __darwin_fd_set(cancellationReadDescriptor, &readDescriptors)
      let ready = Darwin.select(
        max(terminalDescriptor, cancellationReadDescriptor) + 1,
        &readDescriptors,
        nil,
        nil,
        nil
      )
      if ready < 0 {
        if errno == EINTR { continue }
        throw .inputOutputFailure
      }
      if __darwin_fd_isset(cancellationReadDescriptor, &readDescriptors) != 0 {
        throw .cancelled
      }
      guard __darwin_fd_isset(terminalDescriptor, &readDescriptors) != 0 else {
        throw .inputOutputFailure
      }
      let count = buffer.withUnsafeMutableBytes { bytes in
        Darwin.read(terminalDescriptor, bytes.baseAddress, bytes.count)
      }
      if count < 0 {
        if errno == EINTR { continue }
        throw .inputOutputFailure
      }
      guard count > 0 else { throw .inputOutputFailure }
      if let complete = try accumulator.append(buffer[..<count]) {
        return complete
      }
    }
  }

  private static func writeAll(
    _ bytes: [UInt8],
    to descriptor: Int32
  ) throws(TTYSecretCaptureError) {
    var offset = 0
    while offset < bytes.count {
      let count = bytes.withUnsafeBytes { storage in
        Darwin.write(
          descriptor,
          storage.baseAddress!.advanced(by: offset),
          bytes.count - offset
        )
      }
      if count < 0, errno == EINTR { continue }
      guard count > 0 else { throw .inputOutputFailure }
      offset += count
    }
  }

  private static func setAttributes(
    _ attributes: inout termios,
    on descriptor: Int32
  ) -> Bool {
    while tcsetattr(descriptor, TCSAFLUSH, &attributes) != 0 {
      if errno != EINTR { return false }
    }
    return true
  }

  private static func setCloseOnExec(_ descriptor: Int32) -> Bool {
    var flags: Int32
    repeat {
      flags = fcntl(descriptor, F_GETFD)
    } while flags < 0 && errno == EINTR
    guard flags >= 0 else { return false }
    while fcntl(descriptor, F_SETFD, flags | FD_CLOEXEC) != 0 {
      if errno != EINTR { return false }
    }
    return true
  }

  private static func erase(_ bytes: inout [UInt8]) {
    _ = bytes.withUnsafeMutableBytes { storage in
      storage.initializeMemory(as: UInt8.self, repeating: 0)
    }
    bytes.removeAll(keepingCapacity: false)
  }
}
