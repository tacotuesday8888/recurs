import Foundation
import RecursNativeProtocol
import RecursNativeSecurity
import Testing

@testable import RecursLauncher

@Suite("Launcher node session")
struct LauncherNodeSessionTests {
  private let nonce = Data((0..<nativeNonceByteCount).map(UInt8.init))

  @Test
  func fragmentedHelloLazilyOpensOneBrokerAndPreservesNodeRequestID() async throws {
    let system = ScriptedSessionBrokerConnection()
    let factory = try makeBrokerFactory(system)
    let output = RecordingSessionOutput()
    let session = LauncherNodeSession(
      brokerConnectionFactory: { () throws(BrokerConnectionError) -> BrokerConnection in
        try factory.make()
      },
      output: output
    )
    let hello = try helloFrame(requestID: 41)

    #expect(!(await session.isAwaitingFrameCompletion()))
    await session.receive(Data())
    #expect(!(await session.isAwaitingFrameCompletion()))
    for byte in hello.dropLast() {
      await session.receive(Data([byte]))
      #expect(await session.isAwaitingFrameCompletion())
    }
    #expect(factory.makeCount == 0)
    #expect(system.exchangeFrames.isEmpty)

    await session.receive(Data([try #require(hello.last)]))
    #expect(!(await session.isAwaitingFrameCompletion()))
    await eventually("hello response") { await output.snapshot().written.count == 1 }

    let snapshot = await output.snapshot()
    let frame = try decodeSingleFrame(try #require(snapshot.written.first))
    let result = try HelloResultMessage.decode(frame)
    #expect(frame.requestID == 41)
    #expect(result.echoedNonce == nonce)
    #expect(factory.makeCount == 1)
    #expect(system.exchangeFrames.map(\.type) == [.hello])
    #expect(system.exchangeFrames.map(\.requestID) == [1])

    await session.close()
    #expect(!(await session.isAwaitingFrameCompletion()))
    await session.finish()
    await session.close()
    await eventually("session close") { await output.snapshot().closeCount == 1 }
    #expect(system.invalidationCount == 1)
  }

  @Test
  func batchedHelloAndHealthRequestsRunSeriallyInFIFOOrder() async throws {
    let system = ScriptedSessionBrokerConnection()
    let factory = try makeBrokerFactory(system)
    let output = RecordingSessionOutput()
    let session = LauncherNodeSession(
      brokerConnectionFactory: { () throws(BrokerConnectionError) -> BrokerConnection in
        try factory.make()
      },
      output: output
    )
    let input = concatenate([
      try helloFrame(requestID: 10),
      try HealthMessage().encodedFrame(requestID: 11),
      try HealthMessage().encodedFrame(requestID: 12),
      try HealthMessage().encodedFrame(requestID: 13),
    ])

    await session.receive(input)
    #expect(!(await session.isAwaitingFrameCompletion()))
    await eventually("first health begins") {
      let writtenCount = await output.snapshot().written.count
      return system.exchangeFrames.count == 2 && system.pendingHealthCount == 1
        && writtenCount == 1
    }
    #expect(system.exchangeFrames.map(\.type) == [.hello, .health])

    try system.replyNextHealth(keychain: .available)
    await eventually("second health begins") {
      let writtenCount = await output.snapshot().written.count
      return system.exchangeFrames.count == 3 && system.pendingHealthCount == 1
        && writtenCount == 2
    }
    try system.replyNextHealth(keychain: .locked)
    await eventually("third health begins") {
      let writtenCount = await output.snapshot().written.count
      return system.exchangeFrames.count == 4 && system.pendingHealthCount == 1
        && writtenCount == 3
    }
    try system.replyNextHealth(keychain: .unavailable)
    await eventually("all health responses") {
      await output.snapshot().written.count == 4
    }

    let frames = try decodeFrames((await output.snapshot()).written)
    #expect(frames.map(\.type) == [.helloResult, .healthResult, .healthResult, .healthResult])
    #expect(frames.map(\.requestID) == [10, 11, 12, 13])
    #expect(system.exchangeFrames.map(\.requestID) == [1, 2, 3, 4])
    #expect(factory.makeCount == 1)
    await session.close()
  }

  @Test
  func exactly64ActiveAndQueuedHealthRequestsAreAllowedBut65Closes() async throws {
    let system = ScriptedSessionBrokerConnection()
    let factory = try makeBrokerFactory(system)
    let output = RecordingSessionOutput()
    let session = LauncherNodeSession(
      brokerConnectionFactory: { () throws(BrokerConnectionError) -> BrokerConnection in
        try factory.make()
      },
      output: output
    )

    await session.receive(try helloFrame(requestID: 1))
    await eventually("handshake") { await output.snapshot().written.count == 1 }
    await session.receive(
      try concatenate((2...65).map { try HealthMessage().encodedFrame(requestID: UInt32($0)) })
    )
    await eventually("bounded health work") { system.pendingHealthCount == 1 }
    #expect(system.exchangeFrames.filter { $0.type == .health }.count == 1)
    #expect((await output.snapshot()).closeCount == 0)

    await session.receive(try HealthMessage().encodedFrame(requestID: 66))
    await eventually("overflow closes") { await output.snapshot().closeCount == 1 }
    #expect(system.invalidationCount == 1)

    try system.replyNextHealth()
    await eventually("late broker completion settles") { system.pendingHealthCount == 0 }
    await Task.yield()
    #expect((await output.snapshot()).written.count == 1)
  }

  @Test
  func nodeRequestIDsMustBeStrictlyIncreasing() async throws {
    for invalidRequestID in [UInt32(10), 9] {
      let system = ScriptedSessionBrokerConnection()
      let factory = try makeBrokerFactory(system)
      let output = RecordingSessionOutput()
      let session = LauncherNodeSession(
        brokerConnectionFactory: { () throws(BrokerConnectionError) -> BrokerConnection in
          try factory.make()
        },
        output: output
      )

      await session.receive(try helloFrame(requestID: 10))
      await eventually("handshake") { await output.snapshot().written.count == 1 }
      await session.receive(
        try HealthMessage().encodedFrame(requestID: invalidRequestID)
      )
      await eventually("non-increasing request closes") {
        await output.snapshot().closeCount == 1
      }

      #expect(system.exchangeFrames.map(\.type) == [.hello])
      #expect(system.invalidationCount == 1)
    }
  }

  @Test
  func everyBrokerFailureMapsToOneFixedSafeFailure() async throws {
    let mappings: [(BrokerConnectionError, SafeFailureCode)] = [
      (.unsupportedPlatform, .unsupportedPlatform),
      (.unsupportedOSVersion, .unsupportedOSVersion),
      (.launcherUnavailable, .launcherUnavailable),
      (.brokerUnavailable, .brokerUnavailable),
      (.protocolMismatch, .protocolMismatch),
      (.peerIdentityUnverified, .peerIdentityUnverified),
      (.productionSigningRequired, .productionSigningRequired),
      (.keychainUnavailable, .keychainUnavailable),
      (.unsupportedOperation, .unsupportedOperation),
      (.closed, .brokerUnavailable),
    ]

    for (offset, mapping) in mappings.enumerated() {
      let factory = RecordingBrokerFactory(failure: mapping.0)
      let output = RecordingSessionOutput()
      let session = LauncherNodeSession(
        brokerConnectionFactory: { () throws(BrokerConnectionError) -> BrokerConnection in
          try factory.make()
        },
        output: output
      )
      let requestID = UInt32(offset + 1)

      await session.receive(try helloFrame(requestID: requestID))
      await eventually("fixed failure response") { await output.snapshot().closeCount == 1 }

      let snapshot = await output.snapshot()
      let frame = try decodeSingleFrame(try #require(snapshot.written.only))
      #expect(frame.requestID == requestID)
      #expect(try SafeFailureCode.decode(frame) == mapping.1)
      #expect(factory.makeCount == 1)
      #expect(snapshot.closeCount == 1)
    }
  }

  @Test
  func cancellingQueuedHealthRemovesOnlyThatRequest() async throws {
    let system = ScriptedSessionBrokerConnection()
    let factory = try makeBrokerFactory(system)
    let output = RecordingSessionOutput()
    let session = LauncherNodeSession(
      brokerConnectionFactory: { () throws(BrokerConnectionError) -> BrokerConnection in
        try factory.make()
      },
      output: output
    )

    await session.receive(concatenate([
      try helloFrame(requestID: 1),
      try HealthMessage().encodedFrame(requestID: 2),
      try HealthMessage().encodedFrame(requestID: 3),
    ]))
    await eventually("first health pending") { system.pendingHealthCount == 1 }
    await session.receive(
      try CancelMessage(targetRequestID: 3).encodedFrame(requestID: 4)
    )
    try system.replyNextHealth()
    await eventually("uncancelled health response") {
      await output.snapshot().written.count == 2
    }
    #expect(system.exchangeFrames.map(\.type) == [.hello, .health])
    #expect((await output.snapshot()).closeCount == 0)

    await session.receive(try HealthMessage().encodedFrame(requestID: 5))
    await eventually("later health pending") { system.pendingHealthCount == 1 }
    try system.replyNextHealth(keychain: .locked)
    await eventually("later health response") { await output.snapshot().written.count == 3 }
    let frames = try decodeFrames((await output.snapshot()).written)
    #expect(frames.map(\.requestID) == [1, 2, 5])
    await session.close()
  }

  @Test
  func cancellingActiveHealthIsTerminalAndSuppressesLateXPC() async throws {
    let system = ScriptedSessionBrokerConnection()
    let factory = try makeBrokerFactory(system)
    let output = RecordingSessionOutput()
    let session = LauncherNodeSession(
      brokerConnectionFactory: { () throws(BrokerConnectionError) -> BrokerConnection in
        try factory.make()
      },
      output: output
    )

    await session.receive(concatenate([
      try helloFrame(requestID: 1),
      try HealthMessage().encodedFrame(requestID: 2),
    ]))
    await eventually("active health") { system.pendingHealthCount == 1 }
    await session.receive(
      try CancelMessage(targetRequestID: 2).encodedFrame(requestID: 3)
    )
    await eventually("active cancellation closes") {
      await output.snapshot().closeCount == 1
    }

    await session.close()
    await session.finish()
    await session.receive(try HealthMessage().encodedFrame(requestID: 4))
    try system.replyNextHealth()
    await eventually("late response delivered") { system.pendingHealthCount == 0 }
    await Task.yield()

    let snapshot = await output.snapshot()
    #expect(snapshot.written.count == 1)
    #expect(snapshot.closeCount == 1)
    #expect(system.invalidationCount == 1)
  }

  @Test
  func cancellingActiveHandshakeBeforeItRunsCancelsBrokerTask() async throws {
    let system = ScriptedSessionBrokerConnection()
    let factory = try makeBrokerFactory(system)
    let output = RecordingSessionOutput()
    let session = LauncherNodeSession(
      brokerConnectionFactory: { () throws(BrokerConnectionError) -> BrokerConnection in
        try factory.make()
      },
      output: output
    )

    await session.receive(concatenate([
      try helloFrame(requestID: 1),
      try CancelMessage(targetRequestID: 1).encodedFrame(requestID: 2),
    ]))
    await eventually("handshake cancellation closes") {
      await output.snapshot().closeCount == 1
    }
    await Task.yield()

    #expect(system.exchangeFrames.isEmpty)
    #expect((await output.snapshot()).written.isEmpty)
    #expect((await output.snapshot()).closeCount == 1)
    #expect(system.invalidationCount == 1)
  }

  @Test
  func malformedAndWrongPhaseFramesFailClosedBeforeBrokerOpen() async throws {
    let malformedHello = try NativeFrame(
      type: .hello,
      requestID: 1,
      payload: Data([0, 0])
    ).encoded()
    let inputs = [
      Data(repeating: 0, count: nativeFrameHeaderByteCount),
      malformedHello,
      try HealthMessage().encodedFrame(requestID: 1),
      try CancelMessage(targetRequestID: 1).encodedFrame(requestID: 2),
    ]

    for input in inputs {
      let system = ScriptedSessionBrokerConnection()
      let factory = try makeBrokerFactory(system)
      let output = RecordingSessionOutput()
      let session = LauncherNodeSession(
        brokerConnectionFactory: { () throws(BrokerConnectionError) -> BrokerConnection in
          try factory.make()
        },
        output: output
      )

      await session.receive(input)
      await eventually("invalid input closes") { await output.snapshot().closeCount == 1 }
      #expect(factory.makeCount == 0)
      #expect(system.invalidationCount == 0)
      #expect((await output.snapshot()).written.isEmpty)
    }
  }

  @Test
  func secondHelloAndUnknownCancellationFailClosedInReadyPhase() async throws {
    for invalidFrame in [
      try helloFrame(requestID: 2),
      try CancelMessage(targetRequestID: 99).encodedFrame(requestID: 2),
    ] {
      let system = ScriptedSessionBrokerConnection()
      let factory = try makeBrokerFactory(system)
      let output = RecordingSessionOutput()
      let session = LauncherNodeSession(
        brokerConnectionFactory: { () throws(BrokerConnectionError) -> BrokerConnection in
          try factory.make()
        },
        output: output
      )

      await session.receive(try helloFrame(requestID: 1))
      await eventually("ready") { await output.snapshot().written.count == 1 }
      await session.receive(invalidFrame)
      await eventually("ready phase violation closes") {
        await output.snapshot().closeCount == 1
      }
      #expect(factory.makeCount == 1)
      #expect(system.invalidationCount == 1)
    }
  }

  @Test
  func truncatedEOFClosesExactlyOnceWithoutOpeningBroker() async throws {
    let system = ScriptedSessionBrokerConnection()
    let factory = try makeBrokerFactory(system)
    let output = RecordingSessionOutput()
    let session = LauncherNodeSession(
      brokerConnectionFactory: { () throws(BrokerConnectionError) -> BrokerConnection in
        try factory.make()
      },
      output: output
    )
    let hello = try helloFrame(requestID: 1)

    #expect(!(await session.isAwaitingFrameCompletion()))
    await session.receive(Data(hello.prefix(nativeFrameHeaderByteCount + 1)))
    #expect(await session.isAwaitingFrameCompletion())
    await session.finish()
    #expect(!(await session.isAwaitingFrameCompletion()))
    await session.finish()
    await session.close()
    #expect(!(await session.isAwaitingFrameCompletion()))
    await eventually("truncated close") { await output.snapshot().closeCount == 1 }

    #expect(factory.makeCount == 0)
    #expect(system.invalidationCount == 0)
    #expect((await output.snapshot()).written.isEmpty)
  }

  @Test
  func outputFailureClosesWithoutLeakingNativeErrorText() async throws {
    let canary = "NATIVE_ERROR_SECRET_CANARY"
    let system = ScriptedSessionBrokerConnection()
    let factory = try makeBrokerFactory(system)
    let output = RecordingSessionOutput(failOnAttempt: 1, canary: canary)
    let session = LauncherNodeSession(
      brokerConnectionFactory: { () throws(BrokerConnectionError) -> BrokerConnection in
        try factory.make()
      },
      output: output
    )

    await session.receive(try helloFrame(requestID: 1))
    await eventually("output failure closes") { await output.snapshot().closeCount == 1 }
    await session.close()

    let snapshot = await output.snapshot()
    let attemptedBytes = concatenate(snapshot.attempted)
    #expect(snapshot.attempted.count == 1)
    #expect(snapshot.written.isEmpty)
    #expect(attemptedBytes.range(of: Data(canary.utf8)) == nil)
    #expect(snapshot.closeCount == 1)
    #expect(system.invalidationCount == 1)
  }

  private func helloFrame(requestID: UInt32) throws -> Data {
    try HelloMessage(engineVersion: "0.1.0", nonce: nonce)
      .encodedFrame(requestID: requestID)
  }
}

private struct SessionOutputSnapshot: Sendable {
  let attempted: [Data]
  let written: [Data]
  let closeCount: Int
}

private actor RecordingSessionOutput: LauncherNodeSessionOutput {
  private let failOnAttempt: Int?
  private let canary: String
  private var attempted: [Data] = []
  private var written: [Data] = []
  private var closeCount = 0

  init(failOnAttempt: Int? = nil, canary: String = "") {
    self.failOnAttempt = failOnAttempt
    self.canary = canary
  }

  func write(_ frame: Data) async throws {
    attempted.append(frame)
    if attempted.count == failOnAttempt {
      throw CanarySessionOutputError(canary: canary)
    }
    written.append(frame)
  }

  func close() async {
    closeCount += 1
  }

  func snapshot() -> SessionOutputSnapshot {
    SessionOutputSnapshot(
      attempted: attempted,
      written: written,
      closeCount: closeCount
    )
  }
}

private struct CanarySessionOutputError: Error, LocalizedError, Sendable {
  let canary: String
  var errorDescription: String? { canary }
}

private final class RecordingBrokerFactory: @unchecked Sendable {
  private enum Mode: Sendable {
    case build(@Sendable () -> BrokerConnection)
    case fail(BrokerConnectionError)
  }

  private let mode: Mode
  private let lock = NSLock()
  private var makeCountStorage = 0
  private var connection: BrokerConnection?

  init(builder: @escaping @Sendable () -> BrokerConnection) {
    mode = .build(builder)
  }

  init(failure: BrokerConnectionError) {
    mode = .fail(failure)
  }

  var makeCount: Int {
    lock.withLock { makeCountStorage }
  }

  func make() throws(BrokerConnectionError) -> BrokerConnection {
    lock.lock()
    defer { lock.unlock() }
    makeCountStorage += 1
    if let connection {
      return connection
    }
    switch mode {
    case .build(let builder):
      let built = builder()
      connection = built
      return built
    case .fail(let failure):
      throw failure
    }
  }
}

private struct ScriptedSessionBrokerConnectionFactory: BrokerXPCConnectionFactory {
  let connection: ScriptedSessionBrokerConnection

  func makeConnection() -> any BrokerXPCConnectionHandling {
    connection
  }
}

private final class ScriptedSessionBrokerConnection: BrokerXPCConnectionHandling,
  @unchecked Sendable
{
  private struct Pending: @unchecked Sendable {
    let frame: NativeFrame
    let reply: @Sendable (Result<Data, BrokerXPCExchangeError>) -> Void
  }

  private let lock = NSLock()
  private var frames: [NativeFrame] = []
  private var pending: [Pending] = []
  private var invalidations = 0

  var exchangeFrames: [NativeFrame] {
    lock.withLock { frames }
  }

  var pendingHealthCount: Int {
    lock.withLock { pending.filter { $0.frame.type == .health }.count }
  }

  var invalidationCount: Int {
    lock.withLock { invalidations }
  }

  func installRemoteInterface() {}
  func setCodeSigningRequirement(_: String) {}
  func activate() {}

  func exchange(
    _ encoded: Data,
    reply: @escaping @Sendable (Result<Data, BrokerXPCExchangeError>) -> Void
  ) {
    do {
      let frame = try decodeSingleFrame(encoded)
      lock.withLock { frames.append(frame) }
      switch frame.type {
      case .hello:
        let hello = try HelloMessage.decode(frame)
        let response = try HelloResultMessage(
          launcherVersion: hello.engineVersion,
          brokerVersion: hello.engineVersion,
          echoedNonce: hello.nonce,
          productionSigned: true,
          persistentCredentials: true,
          minimumMacosVersion: "14.4"
        ).encodedFrame(requestID: frame.requestID)
        reply(.success(response))
      case .health:
        _ = try HealthMessage.decode(frame)
        lock.withLock { pending.append(Pending(frame: frame, reply: reply)) }
      default:
        reply(.failure(.brokerUnavailable))
      }
    } catch {
      reply(.failure(.brokerUnavailable))
    }
  }

  func invalidate() {
    lock.withLock { invalidations += 1 }
  }

  func replyNextHealth(
    keychain: KeychainStatusCode = .available,
    peerVerified: Bool = true
  ) throws {
    let item: Pending? = lock.withLock {
      guard let index = self.pending.firstIndex(where: { $0.frame.type == .health }) else {
        return nil
      }
      return self.pending.remove(at: index)
    }
    let replyItem = try #require(item)
    replyItem.reply(.success(
      try HealthResultMessage(keychain: keychain, peerVerified: peerVerified)
        .encodedFrame(requestID: replyItem.frame.requestID)
    ))
  }
}

private func makeBrokerFactory(
  _ system: ScriptedSessionBrokerConnection
) throws -> RecordingBrokerFactory {
  let requirement = try PeerRequirement.fromValidatedSignedMetadata(
    for: .broker,
    metadata: [
      "RecursTeamIdentifier": "ABCDE12345",
      "RecursLauncherIdentifier": "com.recurs.cli.launcher",
      "RecursBrokerIdentifier": "com.recurs.cli.broker",
      "RecursProductionSigned": true,
    ]
  )
  return RecordingBrokerFactory {
    BrokerConnection(
      validatedPeerRequirement: requirement,
      connectionFactory: ScriptedSessionBrokerConnectionFactory(connection: system)
    )
  }
}

private func eventually(
  _ description: String,
  condition: () async -> Bool
) async {
  let clock = ContinuousClock()
  let deadline = clock.now.advanced(by: .seconds(2))
  while clock.now < deadline {
    if await condition() {
      return
    }
    await Task.yield()
  }
  Issue.record("Timed out waiting for \(description)")
}

private func decodeSingleFrame(_ data: Data) throws -> NativeFrame {
  var decoder = NativeFrameDecoder()
  let frames = try decoder.push(data)
  try decoder.finish()
  return try #require(frames.only)
}

private func decodeFrames(_ data: [Data]) throws -> [NativeFrame] {
  try data.map(decodeSingleFrame)
}

private func concatenate(_ parts: [Data]) -> Data {
  var result = Data()
  result.reserveCapacity(parts.reduce(0) { $0 + $1.count })
  for part in parts {
    result.append(part)
  }
  return result
}

private extension Collection {
  var only: Element? {
    count == 1 ? first : nil
  }
}
