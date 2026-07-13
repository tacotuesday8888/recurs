import Darwin
import Dispatch
import Foundation
import RecursNativeProtocol

package enum LauncherNodeSocketRead: Sendable, Equatable {
  case data(Data)
  case idle
  case end
}

enum LauncherNodeSocketError: Error, Sendable, Equatable {
  case invalidDescriptor
  case configurationFailed
  case invalidReadSize
  case closed
  case readFailed
  case writeFailed
}

enum LauncherNodeSocketCallFailure: Error, Sendable, Equatable {
  case interrupted
  case wouldBlock
  case failed
}

struct LauncherNodeSocketSystem: @unchecked Sendable {
  let descriptorFlags: @Sendable (Int32) -> Result<Int32, LauncherNodeSocketCallFailure>
  let setDescriptorFlags: @Sendable (Int32, Int32) -> Result<Void, LauncherNodeSocketCallFailure>
  let setNoSigpipe: @Sendable (Int32) -> Result<Void, LauncherNodeSocketCallFailure>
  let setReceiveTimeout: @Sendable (Int32) -> Result<Void, LauncherNodeSocketCallFailure>
  let setSendTimeout: @Sendable (Int32) -> Result<Void, LauncherNodeSocketCallFailure>
  let receive: @Sendable (Int32, Int) -> Result<Data, LauncherNodeSocketCallFailure>
  let send: @Sendable (Int32, Data) -> Result<Int, LauncherNodeSocketCallFailure>
  let shutdown: @Sendable (Int32) -> Void
  let close: @Sendable (Int32) -> Void

  init(
    descriptorFlags:
      @escaping @Sendable (Int32) -> Result<
        Int32, LauncherNodeSocketCallFailure
      >,
    setDescriptorFlags:
      @escaping @Sendable (Int32, Int32) -> Result<
        Void, LauncherNodeSocketCallFailure
      >,
    setNoSigpipe:
      @escaping @Sendable (Int32) -> Result<
        Void, LauncherNodeSocketCallFailure
      >,
    setReceiveTimeout:
      @escaping @Sendable (Int32) -> Result<
        Void, LauncherNodeSocketCallFailure
      >,
    setSendTimeout:
      @escaping @Sendable (Int32) -> Result<
        Void, LauncherNodeSocketCallFailure
      >,
    receive:
      @escaping @Sendable (Int32, Int) -> Result<
        Data, LauncherNodeSocketCallFailure
      >,
    send:
      @escaping @Sendable (Int32, Data) -> Result<
        Int, LauncherNodeSocketCallFailure
      >,
    shutdown: @escaping @Sendable (Int32) -> Void,
    close: @escaping @Sendable (Int32) -> Void
  ) {
    self.descriptorFlags = descriptorFlags
    self.setDescriptorFlags = setDescriptorFlags
    self.setNoSigpipe = setNoSigpipe
    self.setReceiveTimeout = setReceiveTimeout
    self.setSendTimeout = setSendTimeout
    self.receive = receive
    self.send = send
    self.shutdown = shutdown
    self.close = close
  }

  static let live = LauncherNodeSocketSystem(
    descriptorFlags: { descriptor in
      let result = fcntl(descriptor, F_GETFD)
      return result == -1 ? .failure(callFailure()) : .success(result)
    },
    setDescriptorFlags: { descriptor, flags in
      fcntl(descriptor, F_SETFD, flags) == -1
        ? .failure(callFailure()) : .success(())
    },
    setNoSigpipe: { descriptor in
      var enabled: Int32 = 1
      let optionLength = socklen_t(MemoryLayout<Int32>.size)
      let result = withUnsafePointer(to: &enabled) { pointer in
        setsockopt(
          descriptor,
          SOL_SOCKET,
          SO_NOSIGPIPE,
          pointer,
          optionLength
        )
      }
      return result == -1 ? .failure(callFailure()) : .success(())
    },
    setReceiveTimeout: { descriptor in
      var timeout = timeval(tv_sec: 0, tv_usec: 250_000)
      let optionLength = socklen_t(MemoryLayout<timeval>.size)
      let result = withUnsafePointer(to: &timeout) { pointer in
        setsockopt(
          descriptor,
          SOL_SOCKET,
          SO_RCVTIMEO,
          pointer,
          optionLength
        )
      }
      return result == -1 ? .failure(callFailure()) : .success(())
    },
    setSendTimeout: { descriptor in
      var timeout = timeval(tv_sec: 5, tv_usec: 0)
      let optionLength = socklen_t(MemoryLayout<timeval>.size)
      let result = withUnsafePointer(to: &timeout) { pointer in
        setsockopt(
          descriptor,
          SOL_SOCKET,
          SO_SNDTIMEO,
          pointer,
          optionLength
        )
      }
      return result == -1 ? .failure(callFailure()) : .success(())
    },
    receive: { descriptor, maximumByteCount in
      var bytes = Data(count: maximumByteCount)
      let count = bytes.withUnsafeMutableBytes { buffer in
        Darwin.recv(descriptor, buffer.baseAddress, buffer.count, 0)
      }
      guard count >= 0 else {
        return .failure(callFailure())
      }
      bytes.count = count
      return .success(bytes)
    },
    send: { descriptor, bytes in
      let count = bytes.withUnsafeBytes { buffer in
        Darwin.send(descriptor, buffer.baseAddress, buffer.count, 0)
      }
      return count < 0 ? .failure(callFailure()) : .success(count)
    },
    shutdown: { descriptor in
      _ = Darwin.shutdown(descriptor, SHUT_RDWR)
    },
    close: { descriptor in
      _ = Darwin.close(descriptor)
    }
  )
}

package final class LauncherNodeSocket: LauncherNodeSessionOutput,
  @unchecked Sendable
{
  private struct State {
    var descriptor: Int32?
    var borrowCount = 0
    var closing = false
    var shutdownInProgress = false
    var rawCloseInProgress = false
    var closed = false
    var closeWaiters: [CheckedContinuation<Void, Never>] = []
  }

  private static let maximumReadByteCount =
    nativeFrameHeaderByteCount + nativeFrameMaximumPayloadByteCount

  private let system: LauncherNodeSocketSystem
  private let lock = NSLock()
  private var state: State

  package convenience init(ownedDescriptor: Int32) throws {
    try self.init(ownedDescriptor: ownedDescriptor, system: .live)
  }

  init(
    ownedDescriptor: Int32,
    system: LauncherNodeSocketSystem
  ) throws {
    guard ownedDescriptor >= 0 else {
      throw LauncherNodeSocketError.invalidDescriptor
    }

    let flags = try Self.configure {
      system.descriptorFlags(ownedDescriptor)
    }
    try Self.configure {
      system.setDescriptorFlags(ownedDescriptor, flags | FD_CLOEXEC)
    }
    try Self.configure { system.setNoSigpipe(ownedDescriptor) }
    try Self.configure { system.setReceiveTimeout(ownedDescriptor) }
    try Self.configure { system.setSendTimeout(ownedDescriptor) }

    self.system = system
    self.state = State(descriptor: ownedDescriptor)
  }

  deinit {
    let descriptor = lock.withLock { () -> Int32? in
      guard !state.closed, state.borrowCount == 0, let descriptor = state.descriptor else {
        return nil
      }
      state.descriptor = nil
      state.closed = true
      return descriptor
    }
    if let descriptor {
      system.shutdown(descriptor)
      system.close(descriptor)
    }
  }

  package func read(
    maximumByteCount: Int
  ) async throws -> LauncherNodeSocketRead {
    guard
      maximumByteCount > 0,
      maximumByteCount <= Self.maximumReadByteCount
    else {
      throw LauncherNodeSocketError.invalidReadSize
    }

    return try withBorrow { descriptor in
      while true {
        switch system.receive(descriptor, maximumByteCount) {
        case .success(let bytes):
          guard bytes.count <= maximumByteCount else {
            throw LauncherNodeSocketError.readFailed
          }
          return bytes.isEmpty ? .end : .data(bytes)
        case .failure(.interrupted):
          continue
        case .failure(.wouldBlock):
          return .idle
        case .failure(.failed):
          throw LauncherNodeSocketError.readFailed
        }
      }
    }
  }

  package func write(_ frame: Data) async throws {
    guard !frame.isEmpty else {
      return
    }

    try withBorrow { descriptor in
      var offset = 0
      while offset < frame.count {
        let remaining = Data(frame[offset...])
        switch system.send(descriptor, remaining) {
        case .success(let count):
          guard count > 0, count <= remaining.count else {
            throw LauncherNodeSocketError.writeFailed
          }
          offset += count
        case .failure(.interrupted):
          continue
        case .failure(.wouldBlock), .failure(.failed):
          throw LauncherNodeSocketError.writeFailed
        }
      }
    }
  }

  package func close() async {
    let descriptorToShutdown = lock.withLock { () -> Int32? in
      guard !state.closed, !state.closing, let descriptor = state.descriptor else {
        return nil
      }
      state.closing = true
      state.shutdownInProgress = true
      return descriptor
    }

    if let descriptorToShutdown {
      system.shutdown(descriptorToShutdown)
      let descriptorToClose = lock.withLock { () -> Int32? in
        state.shutdownInProgress = false
        return claimRawCloseIfReady()
      }
      if let descriptorToClose {
        performRawClose(descriptorToClose)
      }
    } else {
      let descriptorToClose = lock.withLock { claimRawCloseIfReady() }
      if let descriptorToClose {
        performRawClose(descriptorToClose)
      }
    }

    await waitUntilClosed()
  }

  private static func configure<Value>(
    _ operation: () -> Result<Value, LauncherNodeSocketCallFailure>
  ) throws -> Value {
    while true {
      switch operation() {
      case .success(let value):
        return value
      case .failure(.interrupted):
        continue
      case .failure(.wouldBlock), .failure(.failed):
        throw LauncherNodeSocketError.configurationFailed
      }
    }
  }

  private func withBorrow<Value>(
    _ operation: (Int32) throws -> Value
  ) throws -> Value {
    let descriptor = try lock.withLock { () throws -> Int32 in
      guard
        !state.closing,
        !state.closed,
        let descriptor = state.descriptor
      else {
        throw LauncherNodeSocketError.closed
      }
      state.borrowCount += 1
      return descriptor
    }
    defer { releaseBorrow() }
    return try operation(descriptor)
  }

  private func releaseBorrow() {
    let descriptorToClose = lock.withLock { () -> Int32? in
      precondition(state.borrowCount > 0)
      state.borrowCount -= 1
      return claimRawCloseIfReady()
    }
    if let descriptorToClose {
      performRawClose(descriptorToClose)
    }
  }

  private func claimRawCloseIfReady() -> Int32? {
    guard
      state.closing,
      !state.shutdownInProgress,
      !state.rawCloseInProgress,
      !state.closed,
      state.borrowCount == 0,
      let descriptor = state.descriptor
    else {
      return nil
    }
    state.descriptor = nil
    state.rawCloseInProgress = true
    return descriptor
  }

  private func performRawClose(_ descriptor: Int32) {
    system.close(descriptor)
    let waiters = lock.withLock { () -> [CheckedContinuation<Void, Never>] in
      state.rawCloseInProgress = false
      state.closed = true
      let waiters = state.closeWaiters
      state.closeWaiters.removeAll(keepingCapacity: false)
      return waiters
    }
    for waiter in waiters {
      waiter.resume()
    }
  }

  private func waitUntilClosed() async {
    await withCheckedContinuation { continuation in
      let alreadyClosed = lock.withLock { () -> Bool in
        if state.closed {
          return true
        }
        state.closeWaiters.append(continuation)
        return false
      }
      if alreadyClosed {
        continuation.resume()
      }
    }
  }
}

struct LauncherNodeServeClock: Sendable {
  let nowNanoseconds: @Sendable () -> UInt64

  init(nowNanoseconds: @escaping @Sendable () -> UInt64) {
    self.nowNanoseconds = nowNanoseconds
  }

  static let live = LauncherNodeServeClock {
    DispatchTime.now().uptimeNanoseconds
  }
}

package func serve(
  session: LauncherNodeSession,
  socket: LauncherNodeSocket
) async {
  await serve(session: session, socket: socket, clock: .live)
}

func serve(
  session: LauncherNodeSession,
  socket: LauncherNodeSocket,
  clock: LauncherNodeServeClock
) async {
  let cleanup: @Sendable () async -> Void = {
    await session.close()
    await socket.close()
  }

  await withTaskCancellationHandler {
    do {
      try await serveLoop(session: session, socket: socket, clock: clock)
    } catch {
      // Transport details never cross the native protocol boundary.
    }
    await cleanup()
  } onCancel: {
    Task { await cleanup() }
  }
}

private func serveLoop(
  session: LauncherNodeSession,
  socket: LauncherNodeSocket,
  clock: LauncherNodeServeClock
) async throws {
  let maximumByteCount =
    nativeFrameHeaderByteCount + nativeFrameMaximumPayloadByteCount
  var partialFrameStartedAt: UInt64?

  while !Task.isCancelled {
    let read = try await socket.read(maximumByteCount: maximumByteCount)
    let observedAt = clock.nowNanoseconds()

    if let startedAt = partialFrameStartedAt,
      partialFrameExpired(startedAt: startedAt, observedAt: observedAt)
    {
      return
    }

    switch read {
    case .idle:
      continue
    case .end:
      await session.finish()
      return
    case .data(let bytes):
      partialFrameStartedAt = await feed(
        bytes,
        to: session,
        existingPartialFrameStartedAt: partialFrameStartedAt,
        observedAt: observedAt
      )
    }
  }
}

private func feed(
  _ bytes: Data,
  to session: LauncherNodeSession,
  existingPartialFrameStartedAt: UInt64?,
  observedAt: UInt64
) async -> UInt64? {
  guard existingPartialFrameStartedAt != nil else {
    await session.receive(bytes)
    return await session.isAwaitingFrameCompletion() ? observedAt : nil
  }

  var index = bytes.startIndex
  while index < bytes.endIndex {
    let nextIndex = bytes.index(after: index)
    await session.receive(Data([bytes[index]]))
    index = nextIndex

    if !(await session.isAwaitingFrameCompletion()) {
      if index < bytes.endIndex {
        await session.receive(Data(bytes[index...]))
      }
      return await session.isAwaitingFrameCompletion() ? observedAt : nil
    }
  }
  return existingPartialFrameStartedAt
}

private func partialFrameExpired(
  startedAt: UInt64,
  observedAt: UInt64
) -> Bool {
  guard observedAt >= startedAt else {
    return true
  }
  return observedAt - startedAt >= 5_000_000_000
}

private func callFailure() -> LauncherNodeSocketCallFailure {
  if errno == EINTR {
    return .interrupted
  }
  if errno == EAGAIN || errno == EWOULDBLOCK {
    return .wouldBlock
  }
  return .failed
}
