import Foundation
import RecursBrokerXPC
import RecursNativeProtocol
import RecursNativeSecurity
import Testing

@testable import RecursLauncher

@Suite("Launcher credential lifecycle client")
struct BrokerCredentialLifecycleClientTests {
  @Test
  func stageBeforeAuthenticatedHelloErasesTheSecretAndFailsClosed() async throws {
    let system = ScriptedLifecycleConnection()
    let connection = BrokerConnection(
      validatedPeerRequirement: try testBrokerRequirement(),
      connectionFactory: LifecycleConnectionFactory(connection: system)
    )
    let secret = TTYSecret([0x40, 0x41])
    let secretObserver = secret

    await #expect(throws: BrokerCredentialLifecycleClientError.sessionNotReady) {
      _ = try await connection.stageCredential(
        connectionID: UUID(),
        operationID: UUID(),
        expectedFence: 0,
        providerBinding: try BrokerCredentialStageBindingDescriptor(
          activationProfileID: "openai_api_v1"
        ),
        secret: secret
      )
    }
    await #expect(throws: BrokerConnectionError.closed) {
      _ = try await connection.handshake(
        engineVersion: NativeComponentVersion.current,
        nonce: Data(repeating: 0x5a, count: nativeNonceByteCount)
      )
    }

    #expect(secretObserver.withUnsafeBytes { $0.isEmpty })
    #expect(system.lifecycleRequestIDs.isEmpty)
    #expect(system.invalidationCount == 1)
  }

  @Test
  func stageRejectsAnOversizedSecretBeforeXPCAndErasesIt() async throws {
    let system = ScriptedLifecycleConnection()
    let connection = try await readyConnection(system)
    let secret = TTYSecret(
      [UInt8](repeating: 0x41, count: brokerCredentialMaximumSecretBytes + 1)
    )
    let secretObserver = secret

    await #expect(throws: BrokerCredentialLifecycleClientError.invalidRequest) {
      _ = try await connection.stageCredential(
        connectionID: UUID(),
        operationID: UUID(),
        expectedFence: 0,
        providerBinding: try BrokerCredentialStageBindingDescriptor(
          activationProfileID: "openai_api_v1"
        ),
        secret: secret
      )
    }

    #expect(secretObserver.withUnsafeBytes { $0.isEmpty })
    #expect(system.lifecycleRequestIDs.isEmpty)
    #expect(system.invalidationCount == 1)
  }

  @Test
  func stageAcceptsExactlyTheMaximumSecretSizeAndErasesIt() async throws {
    let system = ScriptedLifecycleConnection(
      stageReply: { request in
        .staged(
          requestID: request.requestID,
          try BrokerCredentialRedactedProjection(
            state: .staging,
            fence: 1,
            hasUsableReady: false,
            attemptID: UUID()
          )
        )
      }
    )
    let connection = try await readyConnection(system)
    let secret = TTYSecret(
      [UInt8](repeating: 0x41, count: brokerCredentialMaximumSecretBytes)
    )
    let secretObserver = secret

    let projection = try await connection.stageCredential(
      connectionID: UUID(),
      operationID: UUID(),
      expectedFence: 0,
      providerBinding: try BrokerCredentialStageBindingDescriptor(
        activationProfileID: "openai_api_v1"
      ),
      secret: secret
    )

    #expect(projection.state == .staging)
    #expect(
      system.receivedSecretBytes.map(\.count) == [brokerCredentialMaximumSecretBytes]
    )
    #expect(secretObserver.withUnsafeBytes { $0.isEmpty })
    #expect(system.invalidationCount == 0)
  }

  @Test
  func stageAndControlUseAnIndependentMonotonicRequestSequence() async throws {
    let attemptID = UUID()
    let system = ScriptedLifecycleConnection(
      stageReply: { request in
        .staged(
          requestID: request.requestID,
          try BrokerCredentialRedactedProjection(
            state: .staging,
            fence: 1,
            hasUsableReady: false,
            attemptID: attemptID
          )
        )
      },
      controlReply: { request in
        guard case .projection(let requestID, _) = request else {
          return .failure(requestID: request.requestID, .invalidRequest)
        }
        return .projection(
          requestID: requestID,
          try BrokerCredentialRedactedProjection(
            state: .ready,
            fence: 2,
            hasUsableReady: true,
            attemptID: nil
          )
        )
      }
    )
    let connection = try await readyConnection(system)
    _ = try await connection.health()
    let secret = TTYSecret([0x41, 0x42, 0x43])
    let secretObserver = secret

    let staged = try await connection.stageCredential(
      connectionID: UUID(),
      operationID: UUID(),
      expectedFence: 0,
      providerBinding: try BrokerCredentialStageBindingDescriptor(
        activationProfileID: "openai_api_v1"
      ),
      secret: secret
    )
    let projected = try await connection.controlCredential(
      .projection(connectionID: UUID())
    )

    #expect(staged.state == .staging)
    #expect(staged.attemptID == attemptID)
    #expect(projected.state == .ready)
    #expect(system.nativeRequestIDs == [1, 2])
    #expect(system.lifecycleRequestIDs == [1, 2])
    #expect(system.receivedSecretBytes == [[0x41, 0x42, 0x43]])
    #expect(secretObserver.withUnsafeBytes { $0.isEmpty })
  }

  @Test
  func mapsEveryFixedBrokerFailureWithoutNativeText() async throws {
    let fixtures: [(BrokerCredentialLifecycleFailureCode, BrokerCredentialLifecycleClientError)] = [
      (.invalidRequest, .invalidRequest),
      (.sessionNotReady, .sessionNotReady),
      (.capacityExceeded, .capacityExceeded),
      (.cancelled, .cancelled),
      (.notFound, .notFound),
      (.disconnected, .disconnected),
      (.staleFence, .staleFence),
      (.conflict, .conflict),
      (.busy, .busy),
      (.credentialStoreUnavailable, .credentialStoreUnavailable),
      (.cleanupPending, .cleanupPending),
      (.operationUnavailable, .operationUnavailable),
      (.authorityUnavailable, .authorityUnavailable),
    ]

    for (code, expected) in fixtures {
      let system = ScriptedLifecycleConnection(
        controlReply: { request in
          .failure(requestID: request.requestID, code)
        }
      )
      let connection = try await readyConnection(system)

      await #expect(throws: expected) {
        _ = try await connection.controlCredential(.reservedOperation)
      }
    }
  }

  @Test
  func rejectsUncorrelatedOrWrongKindRepliesAndFailsClosed() async throws {
    let responses:
      [@Sendable (BrokerCredentialStageRequest) throws -> BrokerCredentialLifecycleReply] = [
        { request in
          .staged(
            requestID: request.requestID + 1,
            try BrokerCredentialRedactedProjection(
              state: .staging,
              fence: 1,
              hasUsableReady: false,
              attemptID: UUID()
            )
          )
        },
        { request in
          .projection(
            requestID: request.requestID,
            try BrokerCredentialRedactedProjection(
              state: .ready,
              fence: 1,
              hasUsableReady: true,
              attemptID: nil
            )
          )
        },
      ]

    for response in responses {
      let system = ScriptedLifecycleConnection(stageReply: response)
      let connection = try await readyConnection(system)
      let secret = TTYSecret([0x44, 0x45])
      let secretObserver = secret

      await #expect(throws: BrokerCredentialLifecycleClientError.protocolMismatch) {
        _ = try await connection.stageCredential(
          connectionID: UUID(),
          operationID: UUID(),
          expectedFence: 0,
          providerBinding: try BrokerCredentialStageBindingDescriptor(
            activationProfileID: "anthropic_api_v1"
          ),
          secret: secret
        )
      }
      await #expect(throws: BrokerCredentialLifecycleClientError.closed) {
        _ = try await connection.controlCredential(.reservedOperation)
      }
      #expect(secretObserver.withUnsafeBytes { $0.isEmpty })
      #expect(system.invalidationCount == 1)
    }
  }

  @Test
  func permitsOnlyOneLifecycleOperationAtATime() async throws {
    let system = ScriptedLifecycleConnection(holdStageReply: true)
    let connection = try await readyConnection(system)
    let secret = TTYSecret([0x46, 0x47])
    let stage = Task {
      try await connection.stageCredential(
        connectionID: UUID(),
        operationID: UUID(),
        expectedFence: 0,
        providerBinding: try BrokerCredentialStageBindingDescriptor(
          activationProfileID: "kimi_code_v1"
        ),
        secret: secret
      )
    }
    await system.waitForHeldStage()

    await #expect(throws: BrokerCredentialLifecycleClientError.busy) {
      _ = try await connection.controlCredential(.reservedOperation)
    }
    try system.completeHeldStage(
      .staged(
        requestID: 1,
        BrokerCredentialRedactedProjection(
          state: .staging,
          fence: 1,
          hasUsableReady: false,
          attemptID: UUID()
        )
      )
    )

    #expect(try await stage.value.state == .staging)
    #expect(system.lifecycleRequestIDs == [1])
    #expect(system.invalidationCount == 0)
  }

  @Test
  func cancellationErasesTheSecretAndFailsTheConnectionClosed() async throws {
    let system = ScriptedLifecycleConnection(holdStageReply: true)
    let connection = try await readyConnection(system)
    let secret = TTYSecret([0x48, 0x49])
    let secretObserver = secret
    let stage = Task {
      try await connection.stageCredential(
        connectionID: UUID(),
        operationID: UUID(),
        expectedFence: 0,
        providerBinding: try BrokerCredentialStageBindingDescriptor(
          activationProfileID: "openai_api_v1"
        ),
        secret: secret
      )
    }
    await system.waitForHeldStage()

    stage.cancel()

    await #expect(throws: BrokerCredentialLifecycleClientError.cancelled) {
      _ = try await stage.value
    }
    await #expect(throws: BrokerCredentialLifecycleClientError.closed) {
      _ = try await connection.controlCredential(.reservedOperation)
    }
    #expect(secretObserver.withUnsafeBytes { $0.isEmpty })
    #expect(system.invalidationCount == 1)

    try system.completeHeldStage(
      .failure(requestID: 1, .cancelled)
    )
    #expect(system.invalidationCount == 1)
  }

  @Test
  func explicitCloseCancelsTheActiveLifecycleExchange() async throws {
    let system = ScriptedLifecycleConnection(holdStageReply: true)
    let connection = try await readyConnection(system)
    let secret = TTYSecret([0x4a, 0x4b])
    let secretObserver = secret
    let stage = Task {
      try await connection.stageCredential(
        connectionID: UUID(),
        operationID: UUID(),
        expectedFence: 0,
        providerBinding: try BrokerCredentialStageBindingDescriptor(
          activationProfileID: "openai_api_v1"
        ),
        secret: secret
      )
    }
    await system.waitForHeldStage()

    await connection.close()

    await #expect(throws: BrokerCredentialLifecycleClientError.cancelled) {
      _ = try await stage.value
    }
    #expect(secretObserver.withUnsafeBytes { $0.isEmpty })
    #expect(system.invalidationCount == 1)

    try system.completeHeldStage(.failure(requestID: 1, .cancelled))
    #expect(system.invalidationCount == 1)
  }

  @Test
  func lifecycleTimeoutFailsClosedAndDiscardsALateReply() async throws {
    let system = ScriptedLifecycleConnection(holdStageReply: true)
    let connection = try await readyConnection(
      system,
      xpcReplyTimeout: .milliseconds(10)
    )
    let secret = TTYSecret([0x4c, 0x4d])
    let secretObserver = secret
    let stage = Task {
      try await connection.stageCredential(
        connectionID: UUID(),
        operationID: UUID(),
        expectedFence: 0,
        providerBinding: try BrokerCredentialStageBindingDescriptor(
          activationProfileID: "openai_api_v1"
        ),
        secret: secret
      )
    }
    await system.waitForHeldStage()

    await #expect(throws: BrokerCredentialLifecycleClientError.brokerUnavailable) {
      _ = try await stage.value
    }
    #expect(secretObserver.withUnsafeBytes { $0.isEmpty })
    #expect(system.invalidationCount == 1)

    try system.completeHeldStage(.failure(requestID: 1, .cancelled))
    #expect(system.invalidationCount == 1)
  }

  @Test
  func lifecycleRequestIDExhaustionFailsBeforeAnotherXPC() async throws {
    let system = ScriptedLifecycleConnection(
      controlReply: { request in
        .projection(
          requestID: request.requestID,
          try BrokerCredentialRedactedProjection(
            state: .ready,
            fence: 1,
            hasUsableReady: true,
            attemptID: nil
          )
        )
      }
    )
    let connection = try await readyConnection(
      system,
      initialLifecycleRequestID: UInt64.max - 1
    )

    _ = try await connection.controlCredential(.projection(connectionID: UUID()))
    await #expect(throws: BrokerCredentialLifecycleClientError.protocolMismatch) {
      _ = try await connection.controlCredential(.projection(connectionID: UUID()))
    }

    #expect(system.lifecycleRequestIDs == [UInt64.max - 1])
    #expect(system.invalidationCount == 1)
  }
}

private final class ScriptedLifecycleConnection: BrokerXPCConnectionHandling,
  @unchecked Sendable
{
  typealias StageReply =
    @Sendable (BrokerCredentialStageRequest) throws ->
    BrokerCredentialLifecycleReply
  typealias ControlReply =
    @Sendable (BrokerCredentialControlRequest) throws ->
    BrokerCredentialLifecycleReply

  private let lock = NSLock()
  private let stageReply: StageReply?
  private let controlReply: ControlReply?
  private let holdStageReply: Bool
  private var nativeRequestIDStorage: [UInt32] = []
  private var lifecycleRequestIDStorage: [UInt64] = []
  private var secretStorage: [[UInt8]] = []
  private var heldStage: (UInt64, @Sendable (Result<Data, BrokerXPCExchangeError>) -> Void)?
  private var heldStageWaiters: [CheckedContinuation<Void, Never>] = []
  private var invalidationStorage = 0

  init(
    stageReply: StageReply? = nil,
    controlReply: ControlReply? = nil,
    holdStageReply: Bool = false
  ) {
    self.stageReply = stageReply
    self.controlReply = controlReply
    self.holdStageReply = holdStageReply
  }

  var nativeRequestIDs: [UInt32] { lock.withLock { nativeRequestIDStorage } }
  var lifecycleRequestIDs: [UInt64] { lock.withLock { lifecycleRequestIDStorage } }
  var receivedSecretBytes: [[UInt8]] { lock.withLock { secretStorage } }
  var invalidationCount: Int { lock.withLock { invalidationStorage } }

  func installRemoteInterface() {}
  func setCodeSigningRequirement(_: String) {}
  func activate() {}

  func exchange(
    _ frame: Data,
    reply: @escaping @Sendable (Result<Data, BrokerXPCExchangeError>) -> Void
  ) {
    do {
      let decoded = try decodeSingleNativeFrame(frame)
      lock.withLock { nativeRequestIDStorage.append(decoded.requestID) }
      switch decoded.type {
      case .hello:
        let hello = try HelloMessage.decode(decoded)
        reply(
          .success(
            try HelloResultMessage(
              launcherVersion: NativeComponentVersion.current,
              brokerVersion: NativeComponentVersion.current,
              echoedNonce: hello.nonce,
              productionSigned: true,
              persistentCredentials: true,
              minimumMacosVersion: "14.4"
            ).encodedFrame(requestID: decoded.requestID)
          )
        )
      case .health:
        reply(
          .success(
            try HealthResultMessage(
              keychain: .available,
              peerVerified: true
            ).encodedFrame(requestID: decoded.requestID)
          )
        )
      default:
        reply(.failure(.brokerUnavailable))
      }
    } catch {
      reply(.failure(.brokerUnavailable))
    }
  }

  func stageCredential(
    _ metadata: Data,
    secret: Data,
    reply: @escaping @Sendable (Result<Data, BrokerXPCExchangeError>) -> Void
  ) {
    do {
      let request = try BrokerCredentialStageRequest.decode(metadata)
      var waiters: [CheckedContinuation<Void, Never>] = []
      lock.withLock {
        lifecycleRequestIDStorage.append(request.requestID)
        secretStorage.append(Array(secret))
        if holdStageReply {
          heldStage = (request.requestID, reply)
          waiters = heldStageWaiters
          heldStageWaiters.removeAll(keepingCapacity: false)
        }
      }
      for waiter in waiters { waiter.resume() }
      if holdStageReply { return }
      guard let stageReply else {
        reply(.failure(.brokerUnavailable))
        return
      }
      reply(.success(try stageReply(request).encode()))
    } catch {
      reply(.failure(.brokerUnavailable))
    }
  }

  func credentialControl(
    _ requestData: Data,
    reply: @escaping @Sendable (Result<Data, BrokerXPCExchangeError>) -> Void
  ) {
    do {
      let request = try BrokerCredentialControlRequest.decode(requestData)
      lock.withLock { lifecycleRequestIDStorage.append(request.requestID) }
      guard let controlReply else {
        reply(.failure(.brokerUnavailable))
        return
      }
      reply(.success(try controlReply(request).encode()))
    } catch {
      reply(.failure(.brokerUnavailable))
    }
  }

  func invalidate() {
    lock.withLock { invalidationStorage += 1 }
  }

  func waitForHeldStage() async {
    await withCheckedContinuation { continuation in
      let resumeNow = lock.withLock { () -> Bool in
        guard heldStage == nil else { return true }
        heldStageWaiters.append(continuation)
        return false
      }
      if resumeNow { continuation.resume() }
    }
  }

  func completeHeldStage(_ response: BrokerCredentialLifecycleReply) throws {
    let callback = lock.withLock {
      let value = heldStage
      heldStage = nil
      return value
    }
    let (requestID, reply) = try #require(callback)
    #expect(response.requestID == requestID)
    reply(.success(try response.encode()))
  }
}

private func readyConnection(
  _ system: ScriptedLifecycleConnection,
  initialLifecycleRequestID: UInt64 = 1,
  xpcReplyTimeout: Duration = .seconds(5)
) async throws -> BrokerConnection {
  let connection = BrokerConnection(
    validatedPeerRequirement: try testBrokerRequirement(),
    connectionFactory: LifecycleConnectionFactory(connection: system),
    initialLifecycleRequestID: initialLifecycleRequestID,
    xpcReplyTimeout: xpcReplyTimeout
  )
  _ = try await connection.handshake(
    engineVersion: NativeComponentVersion.current,
    nonce: Data(repeating: 0x5a, count: nativeNonceByteCount)
  )
  return connection
}

private struct LifecycleConnectionFactory: BrokerXPCConnectionFactory {
  let connection: ScriptedLifecycleConnection
  func makeConnection() -> any BrokerXPCConnectionHandling { connection }
}

private func testBrokerRequirement() throws -> PeerRequirement {
  try PeerRequirement.fromValidatedSignedMetadata(
    for: .broker,
    metadata: [
      "RecursTeamIdentifier": "ABCDE12345",
      "RecursLauncherIdentifier": "com.recurs.cli.launcher",
      "RecursBrokerIdentifier": "com.recurs.cli.broker",
      "RecursProductionSigned": true,
    ]
  )
}

private func decodeSingleNativeFrame(_ data: Data) throws -> NativeFrame {
  var decoder = NativeFrameDecoder()
  let frames = try decoder.push(data)
  try decoder.finish()
  return try #require(frames.count == 1 ? frames.first : nil)
}

extension BrokerCredentialControlRequest {
  fileprivate var requestID: UInt64 {
    switch self {
    case .projection(let requestID, _), .reservedOperation(let requestID),
      .resumeStage(let requestID, _, _, _), .abort(let requestID, _, _, _, _),
      .disconnect(let requestID, _, _, _):
      requestID
    }
  }
}

extension BrokerCredentialLifecycleReply {
  fileprivate var requestID: UInt64 {
    switch self {
    case .projection(let requestID, _), .staged(let requestID, _),
      .mutation(let requestID, _), .failure(let requestID, _):
      requestID
    }
  }
}
