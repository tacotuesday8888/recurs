import Foundation
import RecursBrokerXPC
import RecursNativeProtocol
import RecursNativeSecurity
import Testing

@testable import RecursLauncher

@Suite("Launcher OpenAI onboarding client")
struct BrokerOpenAIOnboardingClientTests {
  @Test
  func beginConsumesTheTTYSecretAndReturnsOnlyRedactedSetupIdentity() async throws {
    let connectionID = UUID(uuidString: "71000000-0000-4000-8000-000000000001")!
    let recoveryTokens = try BrokerOpenAIOnboardingRecoveryTokens(
      commitOperationID: UUID(uuidString: "72000000-0000-4000-8000-000000000001")!,
      abortOperationID: UUID(uuidString: "73000000-0000-4000-8000-000000000001")!
    )
    let fingerprint = "sha256:" + String(repeating: "a", count: 64)
    let system = ScriptedOpenAIOnboardingConnection { request in
      guard case .begin(let requestID) = request else {
        return .failure(requestID: request.requestID, .invalidRequest)
      }
      return .begun(
        requestID: requestID,
        connectionID: connectionID,
        recoveryTokens: recoveryTokens,
        credentialIdentityFingerprint: fingerprint
      )
    }
    let connection = try await readyConnection(system)
    let secret = TTYSecret(Array("opaque-api-key".utf8))
    let secretObserver = secret

    let begun = try await connection.beginOpenAIOnboarding(secret: secret)

    #expect(begun.connectionID == connectionID)
    #expect(begun.recoveryTokens == recoveryTokens)
    #expect(begun.credentialIdentityFingerprint == fingerprint)
    #expect(begun.description == "<openai-onboarding-begun>")
    #expect(begun.debugDescription == "<openai-onboarding-begun>")
    #expect(Array(Mirror(reflecting: begun).children).isEmpty)
    #expect(begun.playgroundDescription as? String == "<openai-onboarding-begun>")
    #expect(!((begun as Any) is any Encodable))
    #expect(system.onboardingRequestIDs == [1])
    #expect(system.receivedSecretBytes == [Array("opaque-api-key".utf8)])
    #expect(secretObserver.withUnsafeBytes { $0.isEmpty })
  }

  @Test
  func controlsUseASeparateMonotonicSequenceAndEnforceExactReplyKinds() async throws {
    let connectionID = UUID(uuidString: "74000000-0000-4000-8000-000000000001")!
    let recoveryTokens = try BrokerOpenAIOnboardingRecoveryTokens(
      commitOperationID: UUID(uuidString: "75000000-0000-4000-8000-000000000001")!,
      abortOperationID: UUID(uuidString: "76000000-0000-4000-8000-000000000001")!
    )
    let firstPage = try BrokerOpenAIOnboardingCatalogPage(
      cursor: 0,
      totalModelCount: 3,
      nextCursor: 2,
      catalogRequestID: "catalog-request",
      modelIDs: ["gpt-5.1", "gpt-5.2"]
    )
    let finalPage = try BrokerOpenAIOnboardingCatalogPage(
      cursor: 2,
      totalModelCount: 3,
      nextCursor: nil,
      catalogRequestID: "catalog-request",
      modelIDs: ["gpt-5.3"]
    )
    let receipt = try BrokerOpenAIOnboardingCommitReceipt(
      connectionID: connectionID,
      selectedModelID: "gpt-5.3",
      verifiedModelCount: 3,
      catalogRequestID: "catalog-request"
    )
    let system = ScriptedOpenAIOnboardingConnection { request in
      switch request {
      case .begin(let requestID):
        .begun(
          requestID: requestID,
          connectionID: connectionID,
          recoveryTokens: recoveryTokens,
          credentialIdentityFingerprint: "sha256:" + String(repeating: "b", count: 64)
        )
      case .verify(let requestID):
        .catalogPage(requestID: requestID, firstPage)
      case .catalogPage(let requestID, cursor: 2):
        .catalogPage(requestID: requestID, finalPage)
      case .finalize(let requestID, exactModelID: "gpt-5.3"):
        .committed(requestID: requestID, receipt)
      default:
        .failure(requestID: request.requestID, .invalidRequest)
      }
    }
    let connection = try await readyConnection(
      system,
      initialOnboardingRequestID: 41
    )
    _ = try await connection.beginOpenAIOnboarding(secret: TTYSecret([0x41]))

    let verified = try await connection.controlOpenAIOnboarding(.verify)
    let paged = try await connection.controlOpenAIOnboarding(.catalogPage(cursor: 2))
    let committed = try await connection.controlOpenAIOnboarding(
      .finalize(exactModelID: "gpt-5.3")
    )

    #expect(verified == .catalogPage(firstPage))
    #expect(paged == .catalogPage(finalPage))
    #expect(committed == .committed(receipt))
    #expect(system.onboardingRequestIDs == [41, 42, 43, 44])
  }

  @Test
  func remoteInterfaceAllowsOnlyNSDataForEveryOnboardingArgumentAndReply() {
    let interface = makeBrokerRemoteObjectInterface()
    let exchange = #selector(BrokerXPCProtocol.exchange(_:reply:))
    assertNSDataOnly(interface.classes(for: exchange, argumentIndex: 0, ofReply: false))
    assertNSDataOnly(interface.classes(for: exchange, argumentIndex: 0, ofReply: true))
    let stage = #selector(
      BrokerCredentialLifecycleXPCProtocol.stageCredential(_:secret:reply:)
    )
    assertNSDataOnly(interface.classes(for: stage, argumentIndex: 0, ofReply: false))
    assertNSDataOnly(interface.classes(for: stage, argumentIndex: 1, ofReply: false))
    assertNSDataOnly(interface.classes(for: stage, argumentIndex: 0, ofReply: true))
    let lifecycleControl = #selector(
      BrokerCredentialLifecycleXPCProtocol.credentialControl(_:reply:)
    )
    assertNSDataOnly(
      interface.classes(for: lifecycleControl, argumentIndex: 0, ofReply: false)
    )
    assertNSDataOnly(
      interface.classes(for: lifecycleControl, argumentIndex: 0, ofReply: true)
    )
    let begin = #selector(
      BrokerOpenAIOnboardingXPCProtocol.beginOpenAIOnboarding(_:secret:reply:)
    )
    assertNSDataOnly(interface.classes(for: begin, argumentIndex: 0, ofReply: false))
    assertNSDataOnly(interface.classes(for: begin, argumentIndex: 1, ofReply: false))
    assertNSDataOnly(interface.classes(for: begin, argumentIndex: 0, ofReply: true))
    let control = #selector(
      BrokerOpenAIOnboardingXPCProtocol.openAIOnboardingControl(_:reply:)
    )
    assertNSDataOnly(interface.classes(for: control, argumentIndex: 0, ofReply: false))
    assertNSDataOnly(interface.classes(for: control, argumentIndex: 0, ofReply: true))
  }

  @Test(arguments: BrokerOpenAIOnboardingFailureCode.allCases)
  func mapsEveryFixedBrokerFailureAndFailsClosed(
    _ code: BrokerOpenAIOnboardingFailureCode
  ) async throws {
    let system = ScriptedOpenAIOnboardingConnection { request in
      .failure(requestID: request.requestID, code)
    }
    let connection = try await readyConnection(system)
    let secret = TTYSecret([0x41, 0x42])
    let secretObserver = secret

    await #expect(throws: expectedClientError(for: code)) {
      _ = try await connection.beginOpenAIOnboarding(secret: secret)
    }

    #expect(secretObserver.withUnsafeBytes { $0.isEmpty })
    #expect(system.onboardingRequestIDs == [1])
    #expect(system.invalidationCount == 1)
  }

  @Test
  func rejectsUncorrelatedWrongKindAndMalformedReplies() async throws {
    let replies: [@Sendable (UInt64) throws -> Data] = [
      { requestID in try begunReply(requestID: requestID + 1).encode() },
      { requestID in try BrokerOpenAIOnboardingReply.aborted(requestID: requestID).encode() },
      { _ in Data([0x00, 0x01, 0x02]) },
    ]

    for response in replies {
      let system = ScriptedOpenAIOnboardingConnection(rawHandler: { request in
        try response(request.requestID)
      })
      let connection = try await readyConnection(system)

      await #expect(throws: BrokerOpenAIOnboardingClientError.protocolMismatch) {
        _ = try await connection.beginOpenAIOnboarding(secret: TTYSecret([0x43]))
      }
      #expect(system.invalidationCount == 1)
    }
  }

  @Test
  func abortMakesTheOnboardingTransactionTerminal() async throws {
    let system = ScriptedOpenAIOnboardingConnection { request in
      switch request {
      case .begin(let requestID):
        try begunReply(requestID: requestID)
      case .abort(let requestID):
        .aborted(requestID: requestID)
      default:
        .failure(requestID: request.requestID, .invalidRequest)
      }
    }
    let connection = try await readyConnection(system)
    _ = try await connection.beginOpenAIOnboarding(secret: TTYSecret([0x44]))

    #expect(try await connection.controlOpenAIOnboarding(.abort) == .aborted)
    await #expect(throws: BrokerOpenAIOnboardingClientError.operationUnavailable) {
      _ = try await connection.controlOpenAIOnboarding(.abort)
    }

    #expect(system.onboardingRequestIDs == [1, 2])
    #expect(system.invalidationCount == 0)
  }

  @Test
  func controlBeforeBeginFailsTheConnectionClosed() async throws {
    let system = ScriptedOpenAIOnboardingConnection { request in
      .failure(requestID: request.requestID, .invalidRequest)
    }
    let connection = try await readyConnection(system)

    await #expect(throws: BrokerOpenAIOnboardingClientError.sessionNotReady) {
      _ = try await connection.controlOpenAIOnboarding(.verify)
    }
    await #expect(throws: BrokerOpenAIOnboardingClientError.closed) {
      _ = try await connection.beginOpenAIOnboarding(secret: TTYSecret([0x45]))
    }

    #expect(system.onboardingRequestIDs.isEmpty)
    #expect(system.invalidationCount == 1)
  }

  @Test
  func cancellationErasesTheSecretFailsClosedAndIgnoresALateReply() async throws {
    let system = ScriptedOpenAIOnboardingConnection(holdBegin: true) { request in
      try begunReply(requestID: request.requestID)
    }
    let connection = try await readyConnection(system)
    let secret = TTYSecret([0x46, 0x47])
    let secretObserver = secret
    let begin = Task {
      try await connection.beginOpenAIOnboarding(secret: secret)
    }
    await system.waitForHeldReply()

    begin.cancel()

    await #expect(throws: BrokerOpenAIOnboardingClientError.cancelled) {
      _ = try await begin.value
    }
    #expect(secretObserver.withUnsafeBytes { $0.isEmpty })
    #expect(system.invalidationCount == 1)
    try system.completeHeldReply(begunReply(requestID: 1))
    #expect(system.invalidationCount == 1)
  }

  @Test
  func explicitCloseCancelsTheActiveExchangeAndErasesTheSecret() async throws {
    let system = ScriptedOpenAIOnboardingConnection(holdBegin: true) { request in
      try begunReply(requestID: request.requestID)
    }
    let connection = try await readyConnection(system)
    let secret = TTYSecret([0x48, 0x49])
    let secretObserver = secret
    let begin = Task {
      try await connection.beginOpenAIOnboarding(secret: secret)
    }
    await system.waitForHeldReply()

    await connection.close()

    await #expect(throws: BrokerOpenAIOnboardingClientError.cancelled) {
      _ = try await begin.value
    }
    #expect(secretObserver.withUnsafeBytes { $0.isEmpty })
    #expect(system.invalidationCount == 1)
  }

  @Test
  func timeoutFailsClosedErasesTheSecretAndIgnoresALateReply() async throws {
    let system = ScriptedOpenAIOnboardingConnection(holdBegin: true) { request in
      try begunReply(requestID: request.requestID)
    }
    let connection = try await readyConnection(
      system,
      xpcReplyTimeout: .milliseconds(20)
    )
    let secret = TTYSecret([0x4a, 0x4b])
    let secretObserver = secret
    let begin = Task {
      try await connection.beginOpenAIOnboarding(secret: secret)
    }
    await system.waitForHeldReply()

    await #expect(throws: BrokerOpenAIOnboardingClientError.brokerUnavailable) {
      _ = try await begin.value
    }
    #expect(secretObserver.withUnsafeBytes { $0.isEmpty })
    #expect(system.invalidationCount == 1)
    try system.completeHeldReply(begunReply(requestID: 1))
    #expect(system.invalidationCount == 1)
  }

  @Test
  func concurrentBeginIsBusyAndStillErasesItsRejectedSecret() async throws {
    let system = ScriptedOpenAIOnboardingConnection(holdBegin: true) { request in
      try begunReply(requestID: request.requestID)
    }
    let connection = try await readyConnection(system)
    let first = Task {
      try await connection.beginOpenAIOnboarding(secret: TTYSecret([0x4c]))
    }
    await system.waitForHeldReply()
    let rejectedSecret = TTYSecret([0x4d])
    let rejectedObserver = rejectedSecret

    await #expect(throws: BrokerOpenAIOnboardingClientError.busy) {
      _ = try await connection.beginOpenAIOnboarding(secret: rejectedSecret)
    }
    #expect(rejectedObserver.withUnsafeBytes { $0.isEmpty })

    try system.completeHeldReply(begunReply(requestID: 1))
    _ = try await first.value
    #expect(system.onboardingRequestIDs == [1])
    #expect(system.invalidationCount == 0)
  }

  @Test
  func validatesSecretBoundsBeforeXPCAndErasesEveryInput() async throws {
    let oversizedSystem = ScriptedOpenAIOnboardingConnection { request in
      try begunReply(requestID: request.requestID)
    }
    let oversizedConnection = try await readyConnection(oversizedSystem)
    let oversized = TTYSecret(
      [UInt8](repeating: 0x4e, count: brokerCredentialMaximumSecretBytes + 1)
    )
    let oversizedObserver = oversized

    await #expect(throws: BrokerOpenAIOnboardingClientError.invalidRequest) {
      _ = try await oversizedConnection.beginOpenAIOnboarding(secret: oversized)
    }
    #expect(oversizedObserver.withUnsafeBytes { $0.isEmpty })
    #expect(oversizedSystem.onboardingRequestIDs.isEmpty)
    #expect(oversizedSystem.receivedSecretBytes.isEmpty)
    #expect(oversizedSystem.invalidationCount == 1)

    let maximumSystem = ScriptedOpenAIOnboardingConnection { request in
      try begunReply(requestID: request.requestID)
    }
    let maximumConnection = try await readyConnection(maximumSystem)
    let maximum = TTYSecret(
      [UInt8](repeating: 0x4f, count: brokerCredentialMaximumSecretBytes)
    )
    let maximumObserver = maximum

    _ = try await maximumConnection.beginOpenAIOnboarding(secret: maximum)
    #expect(maximumObserver.withUnsafeBytes { $0.isEmpty })
    #expect(maximumSystem.receivedSecretBytes.map(\.count) == [brokerCredentialMaximumSecretBytes])
  }

  @Test
  func requestIDExhaustionAndInvalidControlFailBeforeAnotherXPC() async throws {
    let exhaustedSystem = ScriptedOpenAIOnboardingConnection { request in
      try begunReply(requestID: request.requestID)
    }
    let exhaustedConnection = try await readyConnection(
      exhaustedSystem,
      initialOnboardingRequestID: brokerOpenAIOnboardingMalformedRequestID - 1
    )
    _ = try await exhaustedConnection.beginOpenAIOnboarding(secret: TTYSecret([0x50]))

    await #expect(throws: BrokerOpenAIOnboardingClientError.protocolMismatch) {
      _ = try await exhaustedConnection.controlOpenAIOnboarding(.verify)
    }
    #expect(exhaustedSystem.onboardingRequestIDs == [UInt64.max - 1])
    #expect(exhaustedSystem.invalidationCount == 1)

    let invalidSystem = ScriptedOpenAIOnboardingConnection { request in
      try begunReply(requestID: request.requestID)
    }
    let invalidConnection = try await readyConnection(invalidSystem)
    _ = try await invalidConnection.beginOpenAIOnboarding(secret: TTYSecret([0x51]))

    await #expect(throws: BrokerOpenAIOnboardingClientError.invalidRequest) {
      _ = try await invalidConnection.controlOpenAIOnboarding(.catalogPage(cursor: 0))
    }
    #expect(invalidSystem.onboardingRequestIDs == [1])
    #expect(invalidSystem.invalidationCount == 1)
  }

  @Test
  func controlRejectsAReplyKindThatDoesNotMatchTheRequest() async throws {
    let system = ScriptedOpenAIOnboardingConnection { request in
      switch request {
      case .begin(let requestID):
        try begunReply(requestID: requestID)
      case .verify(let requestID):
        .aborted(requestID: requestID)
      default:
        .failure(requestID: request.requestID, .invalidRequest)
      }
    }
    let connection = try await readyConnection(system)
    _ = try await connection.beginOpenAIOnboarding(secret: TTYSecret([0x52]))

    await #expect(throws: BrokerOpenAIOnboardingClientError.protocolMismatch) {
      _ = try await connection.controlOpenAIOnboarding(.verify)
    }
    #expect(system.invalidationCount == 1)
  }
}

private final class ScriptedOpenAIOnboardingConnection:
  BrokerXPCConnectionHandling,
  @unchecked Sendable
{
  typealias ReplyHandler =
    @Sendable (BrokerOpenAIOnboardingRequest) throws -> BrokerOpenAIOnboardingReply
  typealias RawHandler = @Sendable (BrokerOpenAIOnboardingRequest) throws -> Data

  private let lock = NSLock()
  private let handler: RawHandler
  private let holdBegin: Bool
  private var onboardingRequestIDStorage: [UInt64] = []
  private var secretStorage: [[UInt8]] = []
  private var heldReply:
    (requestID: UInt64, reply: @Sendable (Result<Data, BrokerXPCExchangeError>) -> Void)?
  private var heldReplyWaiters: [CheckedContinuation<Void, Never>] = []
  private var invalidationStorage = 0

  init(
    holdBegin: Bool = false,
    handler: @escaping ReplyHandler
  ) {
    self.holdBegin = holdBegin
    self.handler = { try handler($0).encode() }
  }

  init(
    holdBegin: Bool = false,
    rawHandler: @escaping RawHandler
  ) {
    self.holdBegin = holdBegin
    self.handler = rawHandler
  }

  var onboardingRequestIDs: [UInt64] {
    lock.withLock { onboardingRequestIDStorage }
  }

  var receivedSecretBytes: [[UInt8]] {
    lock.withLock { secretStorage }
  }

  var invalidationCount: Int {
    lock.withLock { invalidationStorage }
  }

  func installRemoteInterface() {}
  func setCodeSigningRequirement(_: String) {}
  func activate() {}

  func exchange(
    _ frame: Data,
    reply: @escaping @Sendable (Result<Data, BrokerXPCExchangeError>) -> Void
  ) {
    do {
      let decoded = try decodeSingleNativeFrame(frame)
      guard case .hello = decoded.type else {
        reply(.failure(.brokerUnavailable))
        return
      }
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
    } catch {
      reply(.failure(.brokerUnavailable))
    }
  }

  func beginOpenAIOnboarding(
    _ requestData: Data,
    secret: Data,
    reply: @escaping @Sendable (Result<Data, BrokerXPCExchangeError>) -> Void
  ) {
    do {
      let request = try BrokerOpenAIOnboardingRequest.decode(requestData)
      lock.withLock {
        onboardingRequestIDStorage.append(request.requestID)
        secretStorage.append(Array(secret))
      }
      if holdBegin {
        let waiters = lock.withLock { () -> [CheckedContinuation<Void, Never>] in
          heldReply = (request.requestID, reply)
          let selected = heldReplyWaiters
          heldReplyWaiters.removeAll(keepingCapacity: false)
          return selected
        }
        for waiter in waiters { waiter.resume() }
        return
      }
      reply(.success(try handler(request)))
    } catch {
      reply(.failure(.brokerUnavailable))
    }
  }

  func openAIOnboardingControl(
    _ requestData: Data,
    reply: @escaping @Sendable (Result<Data, BrokerXPCExchangeError>) -> Void
  ) {
    do {
      let request = try BrokerOpenAIOnboardingRequest.decode(requestData)
      lock.withLock { onboardingRequestIDStorage.append(request.requestID) }
      reply(.success(try handler(request)))
    } catch {
      reply(.failure(.brokerUnavailable))
    }
  }

  func invalidate() {
    lock.withLock { invalidationStorage += 1 }
  }

  func waitForHeldReply() async {
    await withCheckedContinuation { continuation in
      let resumeNow = lock.withLock { () -> Bool in
        guard heldReply == nil else { return true }
        heldReplyWaiters.append(continuation)
        return false
      }
      if resumeNow { continuation.resume() }
    }
  }

  func completeHeldReply(_ response: BrokerOpenAIOnboardingReply) throws {
    let selected = lock.withLock {
      let value = heldReply
      heldReply = nil
      return value
    }
    let held = try #require(selected)
    #expect(held.requestID == response.requestID)
    held.reply(.success(try response.encode()))
  }
}

private func readyConnection(
  _ system: ScriptedOpenAIOnboardingConnection,
  initialOnboardingRequestID: UInt64 = 1,
  xpcReplyTimeout: Duration = .seconds(5)
) async throws -> BrokerConnection {
  let connection = BrokerConnection(
    validatedPeerRequirement: try testBrokerRequirement(),
    connectionFactory: OpenAIOnboardingConnectionFactory(connection: system),
    initialLifecycleRequestID: 1,
    initialOnboardingRequestID: initialOnboardingRequestID,
    xpcReplyTimeout: xpcReplyTimeout
  )
  _ = try await connection.handshake(
    engineVersion: NativeComponentVersion.current,
    nonce: Data(repeating: 0x5a, count: nativeNonceByteCount)
  )
  return connection
}

private struct OpenAIOnboardingConnectionFactory: BrokerXPCConnectionFactory {
  let connection: ScriptedOpenAIOnboardingConnection

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

private func assertNSDataOnly(_ classes: Set<AnyHashable>) {
  #expect(classes.count == 1)
  #expect((classes as NSSet).contains(NSData.self))
  #expect(!(classes as NSSet).contains(NSURL.self))
  #expect(!(classes as NSSet).contains(NSDictionary.self))
  #expect(!(classes as NSSet).contains(NSObject.self))
}

private func begunReply(requestID: UInt64) throws -> BrokerOpenAIOnboardingReply {
  .begun(
    requestID: requestID,
    connectionID: UUID(uuidString: "77000000-0000-4000-8000-000000000001")!,
    recoveryTokens: try BrokerOpenAIOnboardingRecoveryTokens(
      commitOperationID: UUID(uuidString: "78000000-0000-4000-8000-000000000001")!,
      abortOperationID: UUID(uuidString: "79000000-0000-4000-8000-000000000001")!
    ),
    credentialIdentityFingerprint: "sha256:" + String(repeating: "c", count: 64)
  )
}

private func expectedClientError(
  for code: BrokerOpenAIOnboardingFailureCode
) -> BrokerOpenAIOnboardingClientError {
  switch code {
  case .invalidRequest: .invalidRequest
  case .sessionNotReady: .sessionNotReady
  case .busy: .busy
  case .cancelled: .cancelled
  case .expired: .expired
  case .verificationFailed: .verificationFailed
  case .invalidModel: .invalidModel
  case .noCompatibleModels: .noCompatibleModels
  case .commitFailed: .commitFailed
  case .credentialStoreUnavailable: .credentialStoreUnavailable
  case .cleanupFailed: .cleanupFailed
  case .reconciliationRequired: .reconciliationRequired
  case .authorityUnavailable: .authorityUnavailable
  case .operationUnavailable: .operationUnavailable
  }
}
