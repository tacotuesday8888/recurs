import Darwin
import Dispatch
import Foundation
import RecursNativeProtocol
import RecursNativeSecurity
import Testing

@testable import RecursLauncher

@Suite("Launcher node socket")
struct LauncherNodeSocketTests {
  @Test
  func ownedSocketEnablesCloseOnExecAndNoSigpipe() async throws {
    var descriptors = [Int32](repeating: -1, count: 2)
    #expect(socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors) == 0)
    let owned = descriptors[0]
    let peer = descriptors[1]
    defer { _ = Darwin.close(peer) }

    let socket = try LauncherNodeSocket(ownedDescriptor: owned)

    #expect(fcntl(owned, F_GETFD) & FD_CLOEXEC != 0)
    var noSigpipe: Int32 = 0
    var optionLength = socklen_t(MemoryLayout.size(ofValue: noSigpipe))
    #expect(
      getsockopt(
        owned,
        SOL_SOCKET,
        SO_NOSIGPIPE,
        &noSigpipe,
        &optionLength
      ) == 0
    )
    #expect(noSigpipe == 1)

    var receiveTimeout = timeval()
    optionLength = socklen_t(MemoryLayout<timeval>.size)
    #expect(
      getsockopt(
        owned,
        SOL_SOCKET,
        SO_RCVTIMEO,
        &receiveTimeout,
        &optionLength
      ) == 0
    )
    #expect(receiveTimeout.tv_sec == 0)
    #expect(receiveTimeout.tv_usec == 250_000)

    var sendTimeout = timeval()
    optionLength = socklen_t(MemoryLayout<timeval>.size)
    #expect(
      getsockopt(
        owned,
        SOL_SOCKET,
        SO_SNDTIMEO,
        &sendTimeout,
        &optionLength
      ) == 0
    )
    #expect(sendTimeout.tv_sec == 5)
    #expect(sendTimeout.tv_usec == 0)

    await socket.close()
    #expect(fcntl(owned, F_GETFD) == -1)
  }

  @Test
  func realSocketServesFragmentedAndCoalescedFrames() async throws {
    var descriptors = [Int32](repeating: -1, count: 2)
    #expect(socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors) == 0)
    let socket = try LauncherNodeSocket(ownedDescriptor: descriptors[0])
    let peer = descriptors[1]
    defer { _ = Darwin.close(peer) }
    try setReceiveTimeout(peer, seconds: 2)

    let session = try readySession(output: socket)
    let serving = Task { await serve(session: session, socket: socket) }
    let hello = try helloFrame(requestID: 1)
    let firstHealth = try HealthMessage().encodedFrame(requestID: 2)
    let secondHealth = try HealthMessage().encodedFrame(requestID: 3)

    try sendAll(Data(hello.prefix(7)), to: peer)
    try sendAll(
      concatenate([
        Data(hello.dropFirst(7)),
        firstHealth,
        secondHealth,
      ]),
      to: peer
    )

    let responses = try readFrames(from: peer, expectedCount: 3)
    #expect(responses.map(\.type) == [.helloResult, .healthResult, .healthResult])
    #expect(responses.map(\.requestID) == [1, 2, 3])

    _ = Darwin.shutdown(peer, SHUT_WR)
    await serving.value
  }

  @Test
  func readRetriesInterruptedAndDistinguishesIdleDataAndEnd() async throws {
    let recorder = SocketSystemRecorder(reads: [
      .failure(.interrupted),
      .failure(.wouldBlock),
      .success(Data([1, 2, 3])),
      .success(Data()),
    ])
    let socket = try LauncherNodeSocket(
      ownedDescriptor: 41,
      system: recorder.system()
    )

    #expect(try await socket.read(maximumByteCount: 8) == .idle)
    #expect(
      try await socket.read(maximumByteCount: 8) == .data(Data([1, 2, 3]))
    )
    #expect(try await socket.read(maximumByteCount: 8) == .end)
    #expect(recorder.snapshot.receiveMaximums == [8, 8, 8, 8])

    await socket.close()
    #expect(recorder.snapshot.shutdowns == [41])
    #expect(recorder.snapshot.closes == [41])
  }

  @Test
  func readRejectsUnboundedSizesAndHostileOversizedResults() async throws {
    let recorder = SocketSystemRecorder(reads: [.success(Data(repeating: 1, count: 9))])
    let socket = try LauncherNodeSocket(
      ownedDescriptor: 50,
      system: recorder.system()
    )

    await #expect(throws: LauncherNodeSocketError.invalidReadSize) {
      try await socket.read(maximumByteCount: 0)
    }
    await #expect(throws: LauncherNodeSocketError.invalidReadSize) {
      try await socket.read(
        maximumByteCount:
          nativeFrameHeaderByteCount + nativeFrameMaximumPayloadByteCount + 1
      )
    }
    await #expect(throws: LauncherNodeSocketError.readFailed) {
      try await socket.read(maximumByteCount: 8)
    }
    await socket.close()
  }

  @Test
  func writeRetriesInterruptedAndCompletesShortWrites() async throws {
    let recorder = SocketSystemRecorder(sends: [
      .failure(.interrupted),
      .success(2),
      .success(4),
    ])
    let socket = try LauncherNodeSocket(
      ownedDescriptor: 42,
      system: recorder.system()
    )

    try await socket.write(Data("abcdef".utf8))

    #expect(
      recorder.snapshot.sent == [
        Data("abcdef".utf8),
        Data("abcdef".utf8),
        Data("cdef".utf8),
      ]
    )
    await socket.close()
  }

  @Test
  func writeTimeoutAndBrokenPeerFailWithoutSigpipe() async throws {
    for failure in [
      LauncherNodeSocketCallFailure.wouldBlock,
      LauncherNodeSocketCallFailure.failed,
    ] {
      let recorder = SocketSystemRecorder(sends: [.failure(failure)])
      let socket = try LauncherNodeSocket(
        ownedDescriptor: 43,
        system: recorder.system()
      )
      await #expect(throws: LauncherNodeSocketError.writeFailed) {
        try await socket.write(Data([1]))
      }
      await socket.close()
    }

    var descriptors = [Int32](repeating: -1, count: 2)
    #expect(socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors) == 0)
    let socket = try LauncherNodeSocket(ownedDescriptor: descriptors[0])
    _ = Darwin.close(descriptors[1])
    await #expect(throws: LauncherNodeSocketError.writeFailed) {
      try await socket.write(Data([1]))
    }
    await socket.close()
  }

  @Test
  func failedInitializationLeavesDescriptorWithCaller() {
    let recorder = SocketSystemRecorder()
    let system = recorder.system(setNoSigpipe: { _ in .failure(.failed) })

    #expect(throws: LauncherNodeSocketError.configurationFailed) {
      try LauncherNodeSocket(ownedDescriptor: 44, system: system)
    }
    #expect(recorder.snapshot.shutdowns.isEmpty)
    #expect(recorder.snapshot.closes.isEmpty)
  }

  @Test
  func closeWakesBlockedReadAndRawClosesOnlyAfterBorrowReturns() async throws {
    let entered = DispatchSemaphore(value: 0)
    let released = DispatchSemaphore(value: 0)
    let recorder = SocketSystemRecorder()
    let system = recorder.system(
      receive: { _, _ in
        recorder.record(event: "receive-enter")
        entered.signal()
        _ = released.wait(timeout: .now() + 2)
        recorder.record(event: "receive-return")
        return .failure(.failed)
      },
      shutdown: { _ in
        recorder.record(event: "shutdown")
        released.signal()
      }
    )
    let socket = try LauncherNodeSocket(ownedDescriptor: 45, system: system)
    let reading = Task {
      try await socket.read(maximumByteCount: 8)
    }

    let didEnter = await Task.detached {
      waitForSemaphore(entered)
    }.value
    #expect(didEnter)
    await withTaskGroup(of: Void.self) { group in
      for _ in 0..<16 {
        group.addTask { await socket.close() }
      }
    }
    _ = await reading.result

    let snapshot = recorder.snapshot
    #expect(snapshot.shutdowns == [45])
    #expect(snapshot.closes == [45])
    #expect(snapshot.events == ["receive-enter", "shutdown", "receive-return", "close"])
  }

  @Test
  func idleChannelHasNoDeadlineButPartialFrameUsesNonSlidingDeadline() async throws {
    let idleRecorder = SocketSystemRecorder(reads: [
      .failure(.wouldBlock),
      .failure(.wouldBlock),
      .success(Data()),
    ])
    let idleSocket = try LauncherNodeSocket(
      ownedDescriptor: 46,
      system: idleRecorder.system()
    )
    let idleClock = ScriptedClock([0, 6_000_000_000, 6_000_000_001])
    await serve(
      session: unavailableSession(output: idleSocket),
      socket: idleSocket,
      clock: idleClock.value
    )
    #expect(idleRecorder.snapshot.receiveMaximums.count == 3)

    let hello = try helloFrame(requestID: 1)
    let partialRecorder = SocketSystemRecorder(reads: [
      .success(Data(hello.prefix(1))),
      .failure(.wouldBlock),
      .success(Data(hello.dropFirst(1).prefix(1))),
      .failure(.wouldBlock),
      .success(Data([0xff])),
    ])
    let partialSocket = try LauncherNodeSocket(
      ownedDescriptor: 47,
      system: partialRecorder.system()
    )
    let partialClock = ScriptedClock([
      0,
      4_000_000_000,
      4_500_000_000,
      5_000_000_000,
    ])
    await serve(
      session: unavailableSession(output: partialSocket),
      socket: partialSocket,
      clock: partialClock.value
    )
    #expect(partialRecorder.snapshot.receiveMaximums.count == 4)
    #expect(partialRecorder.snapshot.remainingReads == 1)
  }

  @Test
  func completedFrameBoundaryStartsFreshDeadlineForPartialTail() async throws {
    let hello = try helloFrame(requestID: 1)
    let health = try HealthMessage().encodedFrame(requestID: 2)
    let recorder = SocketSystemRecorder(reads: [
      .success(Data(hello.prefix(5))),
      .success(
        concatenate([
          Data(hello.dropFirst(5)),
          Data(health.prefix(1)),
        ])),
      .failure(.wouldBlock),
      .failure(.wouldBlock),
      .success(Data([0xff])),
    ])
    let socket = try LauncherNodeSocket(
      ownedDescriptor: 48,
      system: recorder.system()
    )
    let clock = ScriptedClock([
      0,
      4_900_000_000,
      5_100_000_000,
      9_900_000_000,
    ])

    await serve(
      session: try readySession(output: socket),
      socket: socket,
      clock: clock.value
    )

    #expect(recorder.snapshot.receiveMaximums.count == 4)
    #expect(recorder.snapshot.remainingReads == 1)
  }

  @Test
  func truncatedAndOversizedInputFailClosedWithoutOpeningBroker() async throws {
    let truncated = try helloFrame(requestID: 1)
    let oversized = oversizedFrameHeader(requestID: 1)

    for input in [Data(truncated.prefix(8)), oversized] {
      let recorder = SocketSystemRecorder(reads: [
        .success(input),
        .success(Data()),
      ])
      let socket = try LauncherNodeSocket(
        ownedDescriptor: 49,
        system: recorder.system()
      )
      let factory = ThrowingBrokerFactory()
      let session = LauncherNodeSession(
        brokerConnectionFactory: {
          () throws(BrokerConnectionError) -> BrokerConnection in
          try factory.make()
        },
        output: socket
      )

      await serve(session: session, socket: socket)

      #expect(factory.makeCount == 0)
      #expect(recorder.snapshot.closes == [49])
    }
  }
}

private struct SocketSystemSnapshot: Sendable {
  let receiveMaximums: [Int]
  let remainingReads: Int
  let sent: [Data]
  let shutdowns: [Int32]
  let closes: [Int32]
  let events: [String]
}

private final class SocketSystemRecorder: @unchecked Sendable {
  private let lock = NSLock()
  private var reads: [Result<Data, LauncherNodeSocketCallFailure>]
  private var sends: [Result<Int, LauncherNodeSocketCallFailure>]
  private var receiveMaximums: [Int] = []
  private var sent: [Data] = []
  private var shutdowns: [Int32] = []
  private var closes: [Int32] = []
  private var events: [String] = []

  init(
    reads: [Result<Data, LauncherNodeSocketCallFailure>] = [],
    sends: [Result<Int, LauncherNodeSocketCallFailure>] = []
  ) {
    self.reads = reads
    self.sends = sends
  }

  var snapshot: SocketSystemSnapshot {
    lock.withLock {
      SocketSystemSnapshot(
        receiveMaximums: receiveMaximums,
        remainingReads: reads.count,
        sent: sent,
        shutdowns: shutdowns,
        closes: closes,
        events: events
      )
    }
  }

  func record(event: String) {
    lock.withLock { events.append(event) }
  }

  func system(
    setNoSigpipe: (
      @Sendable (Int32) -> Result<
        Void, LauncherNodeSocketCallFailure
      >
    )? = nil,
    receive: (
      @Sendable (Int32, Int) -> Result<
        Data, LauncherNodeSocketCallFailure
      >
    )? = nil,
    shutdown: (@Sendable (Int32) -> Void)? = nil
  ) -> LauncherNodeSocketSystem {
    LauncherNodeSocketSystem(
      descriptorFlags: { _ in .success(0) },
      setDescriptorFlags: { _, _ in .success(()) },
      setNoSigpipe: setNoSigpipe ?? { _ in .success(()) },
      setReceiveTimeout: { _ in .success(()) },
      setSendTimeout: { _ in .success(()) },
      receive: { [self] descriptor, maximumByteCount in
        lock.withLock { receiveMaximums.append(maximumByteCount) }
        if let receive {
          return receive(descriptor, maximumByteCount)
        }
        return lock.withLock {
          reads.isEmpty ? .success(Data()) : reads.removeFirst()
        }
      },
      send: { [self] _, bytes in
        lock.withLock {
          sent.append(bytes)
          return sends.isEmpty ? .success(bytes.count) : sends.removeFirst()
        }
      },
      shutdown: { [self] descriptor in
        lock.withLock { shutdowns.append(descriptor) }
        shutdown?(descriptor)
      },
      close: { [self] descriptor in
        lock.withLock {
          closes.append(descriptor)
          events.append("close")
        }
      }
    )
  }
}

private final class ScriptedClock: @unchecked Sendable {
  private let lock = NSLock()
  private var values: [UInt64]
  private var last: UInt64

  init(_ values: [UInt64]) {
    self.values = values
    self.last = values.last ?? 0
  }

  var value: LauncherNodeServeClock {
    LauncherNodeServeClock { [self] in
      lock.withLock {
        guard !values.isEmpty else { return last }
        let value = values.removeFirst()
        last = value
        return value
      }
    }
  }
}

private final class ThrowingBrokerFactory: @unchecked Sendable {
  private let lock = NSLock()
  private var makeCountStorage = 0

  var makeCount: Int {
    lock.withLock { makeCountStorage }
  }

  func make() throws(BrokerConnectionError) -> BrokerConnection {
    lock.withLock { makeCountStorage += 1 }
    throw .brokerUnavailable
  }
}

private struct ImmediateBrokerConnectionFactory: BrokerXPCConnectionFactory {
  let connection: ImmediateBrokerConnection

  func makeConnection() -> any BrokerXPCConnectionHandling {
    connection
  }
}

private final class ImmediateBrokerConnection: BrokerXPCConnectionHandling,
  @unchecked Sendable
{
  func installRemoteInterface() {}
  func setCodeSigningRequirement(_: String) {}
  func activate() {}

  func exchange(
    _ encoded: Data,
    reply: @escaping @Sendable (Result<Data, BrokerXPCExchangeError>) -> Void
  ) {
    do {
      let frame = try decodeSingleFrame(encoded)
      switch frame.type {
      case .hello:
        let hello = try HelloMessage.decode(frame)
        reply(
          .success(
            try HelloResultMessage(
              launcherVersion: hello.engineVersion,
              brokerVersion: hello.engineVersion,
              echoedNonce: hello.nonce,
              productionSigned: true,
              persistentCredentials: true,
              minimumMacosVersion: "14.4"
            ).encodedFrame(requestID: frame.requestID)
          ))
      case .health:
        _ = try HealthMessage.decode(frame)
        reply(
          .success(
            try HealthResultMessage(
              keychain: .available,
              peerVerified: true
            ).encodedFrame(requestID: frame.requestID)
          ))
      default:
        reply(.failure(.brokerUnavailable))
      }
    } catch {
      reply(.failure(.brokerUnavailable))
    }
  }

  func invalidate() {}
}

private func readySession(
  output: any LauncherNodeSessionOutput
) throws -> LauncherNodeSession {
  let requirement = try PeerRequirement.fromValidatedSignedMetadata(
    for: .broker,
    metadata: [
      "RecursTeamIdentifier": "ABCDE12345",
      "RecursLauncherIdentifier": "com.recurs.cli.launcher",
      "RecursBrokerIdentifier": "com.recurs.cli.broker",
      "RecursProductionSigned": true,
    ]
  )
  let connection = BrokerConnection(
    validatedPeerRequirement: requirement,
    connectionFactory: ImmediateBrokerConnectionFactory(
      connection: ImmediateBrokerConnection()
    )
  )
  return LauncherNodeSession(
    brokerConnectionFactory: { connection },
    output: output
  )
}

private func unavailableSession(
  output: any LauncherNodeSessionOutput
) -> LauncherNodeSession {
  LauncherNodeSession(
    brokerConnectionFactory: {
      () throws(BrokerConnectionError) -> BrokerConnection in
      throw .brokerUnavailable
    },
    output: output
  )
}

private func helloFrame(requestID: UInt32) throws -> Data {
  try HelloMessage(
    engineVersion: NativeComponentVersion.current,
    nonce: Data((0..<nativeNonceByteCount).map(UInt8.init))
  ).encodedFrame(requestID: requestID)
}

private func sendAll(_ bytes: Data, to descriptor: Int32) throws {
  var offset = 0
  while offset < bytes.count {
    let written = bytes[offset...].withUnsafeBytes { buffer in
      Darwin.send(descriptor, buffer.baseAddress, buffer.count, 0)
    }
    guard written > 0 else {
      throw SocketTestFailure.systemCall
    }
    offset += written
  }
}

private func readFrames(
  from descriptor: Int32,
  expectedCount: Int
) throws -> [NativeFrame] {
  var decoder = NativeFrameDecoder()
  var frames: [NativeFrame] = []
  var storage = [UInt8](repeating: 0, count: 4_096)
  while frames.count < expectedCount {
    let count = Darwin.recv(descriptor, &storage, storage.count, 0)
    guard count > 0 else {
      throw SocketTestFailure.systemCall
    }
    frames.append(contentsOf: try decoder.push(Data(storage.prefix(count))))
  }
  return frames
}

private func setReceiveTimeout(
  _ descriptor: Int32,
  seconds: Int
) throws {
  var timeout = timeval(tv_sec: seconds, tv_usec: 0)
  let result = withUnsafePointer(to: &timeout) { pointer in
    setsockopt(
      descriptor,
      SOL_SOCKET,
      SO_RCVTIMEO,
      pointer,
      socklen_t(MemoryLayout<timeval>.size)
    )
  }
  guard result == 0 else {
    throw SocketTestFailure.systemCall
  }
}

private func decodeSingleFrame(_ data: Data) throws -> NativeFrame {
  var decoder = NativeFrameDecoder()
  let frames = try decoder.push(data)
  try decoder.finish()
  return try #require(frames.count == 1 ? frames[0] : nil)
}

private func concatenate(_ parts: [Data]) -> Data {
  var result = Data()
  for part in parts {
    result.append(part)
  }
  return result
}

private func oversizedFrameHeader(requestID: UInt32) -> Data {
  var bytes = Data()
  appendBigEndian(nativeFrameMagic, to: &bytes)
  appendBigEndian(nativeAuthorityProtocolVersion, to: &bytes)
  appendBigEndian(NativeMessageType.hello.rawValue, to: &bytes)
  appendBigEndian(UInt32(nativeFrameMaximumPayloadByteCount + 1), to: &bytes)
  appendBigEndian(requestID, to: &bytes)
  return bytes
}

private func appendBigEndian<T: FixedWidthInteger>(
  _ value: T,
  to data: inout Data
) {
  var encoded = value.bigEndian
  withUnsafeBytes(of: &encoded) { data.append(contentsOf: $0) }
}

private enum SocketTestFailure: Error {
  case systemCall
}

private func waitForSemaphore(_ semaphore: DispatchSemaphore) -> Bool {
  semaphore.wait(timeout: .now() + 2) == .success
}
