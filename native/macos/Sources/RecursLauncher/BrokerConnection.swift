import Foundation
import RecursBrokerXPC
import RecursNativeProtocol
import RecursNativeSecurity

package enum BrokerConnectionError: Error, Equatable, Sendable {
  case unsupportedPlatform
  case unsupportedOSVersion
  case launcherUnavailable
  case brokerUnavailable
  case protocolMismatch
  case peerIdentityUnverified
  case productionSigningRequired
  case keychainUnavailable
  case unsupportedOperation
  case closed
}

package enum BrokerXPCExchangeError: Error, Equatable, Sendable {
  case brokerUnavailable
  case cancelled
}

package protocol BrokerXPCConnectionHandling: AnyObject, Sendable {
  func installRemoteInterface()
  func setCodeSigningRequirement(_ requirement: String)
  func activate()
  func exchange(
    _ frame: Data,
    reply: @escaping @Sendable (Result<Data, BrokerXPCExchangeError>) -> Void
  )
  func stageCredential(
    _ metadata: Data,
    secret: Data,
    reply: @escaping @Sendable (Result<Data, BrokerXPCExchangeError>) -> Void
  )
  func credentialControl(
    _ request: Data,
    reply: @escaping @Sendable (Result<Data, BrokerXPCExchangeError>) -> Void
  )
  func invalidate()
}

extension BrokerXPCConnectionHandling {
  func stageCredential(
    _: Data,
    secret _: Data,
    reply: @escaping @Sendable (Result<Data, BrokerXPCExchangeError>) -> Void
  ) {
    reply(.failure(.brokerUnavailable))
  }

  func credentialControl(
    _: Data,
    reply: @escaping @Sendable (Result<Data, BrokerXPCExchangeError>) -> Void
  ) {
    reply(.failure(.brokerUnavailable))
  }
}

package protocol BrokerXPCConnectionFactory: Sendable {
  func makeConnection() -> any BrokerXPCConnectionHandling
}

package actor BrokerConnection {
  private enum Phase: Sendable, Equatable {
    case open
    case handshaking
    case ready
    case checkingHealth
    case stagingCredential
    case controllingCredential
    case closed
  }

  private let connection: any BrokerXPCConnectionHandling
  private let xpcReplyTimeout: Duration
  private var phase = Phase.open
  private var nextRequestID: UInt32? = 1
  private var nextLifecycleRequestID: UInt64?
  private var activeLifecycleReply: TimedBrokerXPCReply?

  package static func open() throws(BrokerConnectionError) -> BrokerConnection {
    let requirement: PeerRequirement
    do {
      requirement = try PeerRequirement.production(
        for: .broker,
        authenticatedAs: .launcher
      )
    } catch {
      throw .productionSigningRequired
    }

    return BrokerConnection(
      validatedPeerRequirement: requirement,
      connectionFactory: SystemBrokerXPCConnectionFactory()
    )
  }

  package init(
    validatedPeerRequirement requirement: PeerRequirement,
    connectionFactory: any BrokerXPCConnectionFactory
  ) {
    self.init(
      validatedPeerRequirement: requirement,
      connectionFactory: connectionFactory,
      initialLifecycleRequestID: 1,
      xpcReplyTimeout: .seconds(5)
    )
  }

  init(
    validatedPeerRequirement requirement: PeerRequirement,
    connectionFactory: any BrokerXPCConnectionFactory,
    initialLifecycleRequestID: UInt64,
    xpcReplyTimeout: Duration
  ) {
    precondition(
      initialLifecycleRequestID > 0
        && initialLifecycleRequestID < brokerCredentialMalformedRequestID
    )
    precondition(xpcReplyTimeout > .zero)
    let connection = connectionFactory.makeConnection()
    connection.installRemoteInterface()
    connection.setCodeSigningRequirement(requirement.requirementString)
    connection.activate()
    self.connection = connection
    self.xpcReplyTimeout = xpcReplyTimeout
    nextLifecycleRequestID = initialLifecycleRequestID
  }

  deinit {
    if phase != .closed {
      connection.invalidate()
    }
  }

  package func handshake(
    engineVersion: String,
    nonce: Data
  ) async throws(BrokerConnectionError) -> HelloResultMessage {
    guard phase == .open else {
      let failure = phase == .closed ? BrokerConnectionError.closed : .protocolMismatch
      failClosed()
      throw failure
    }
    phase = .handshaking

    do {
      let requestID = try claimRequestID()
      let request: Data
      do {
        request = try HelloMessage(
          engineVersion: engineVersion,
          nonce: nonce
        ).encodedFrame(requestID: requestID)
      } catch {
        throw BrokerConnectionError.protocolMismatch
      }
      let response: Data
      do {
        response = try await exchange(request)
      } catch {
        throw BrokerConnectionError.brokerUnavailable
      }
      guard phase == .handshaking else {
        throw BrokerConnectionError.closed
      }
      let frame = try Self.decodeResponse(response, requestID: requestID)
      let result: HelloResultMessage
      do {
        result = try HelloResultMessage.decode(frame)
      } catch {
        throw BrokerConnectionError.protocolMismatch
      }
      guard
        result.launcherVersion == engineVersion,
        result.brokerVersion == engineVersion
      else {
        throw BrokerConnectionError.protocolMismatch
      }
      guard result.echoedNonce == nonce else {
        throw BrokerConnectionError.protocolMismatch
      }
      guard result.productionSigned, result.persistentCredentials else {
        throw BrokerConnectionError.productionSigningRequired
      }
      phase = .ready
      return result
    } catch let failure as BrokerConnectionError {
      failClosed()
      throw failure
    } catch {
      failClosed()
      throw .brokerUnavailable
    }
  }

  package func health() async throws(BrokerConnectionError) -> HealthResultMessage {
    guard phase == .ready else {
      let failure = phase == .closed ? BrokerConnectionError.closed : .protocolMismatch
      failClosed()
      throw failure
    }
    phase = .checkingHealth

    do {
      let requestID = try claimRequestID()
      let request: Data
      do {
        request = try makeHealthFrame(requestID: requestID)
      } catch {
        throw BrokerConnectionError.protocolMismatch
      }
      let response: Data
      do {
        response = try await exchange(request)
      } catch {
        throw BrokerConnectionError.brokerUnavailable
      }
      guard phase == .checkingHealth else {
        throw BrokerConnectionError.closed
      }
      let frame = try Self.decodeResponse(response, requestID: requestID)
      let result: HealthResultMessage
      do {
        result = try HealthResultMessage.decode(frame)
      } catch {
        throw BrokerConnectionError.protocolMismatch
      }
      guard result.peerVerified else {
        throw BrokerConnectionError.peerIdentityUnverified
      }
      phase = .ready
      return result
    } catch let failure as BrokerConnectionError {
      failClosed()
      throw failure
    } catch {
      failClosed()
      throw .brokerUnavailable
    }
  }

  package func stageCredential(
    connectionID: UUID,
    operationID: UUID,
    expectedFence: UInt64,
    providerBinding: BrokerCredentialStageBindingDescriptor,
    secret: consuming TTYSecret
  ) async throws(BrokerCredentialLifecycleClientError) -> BrokerCredentialRedactedProjection {
    defer { secret.erase() }
    let requestID = try beginLifecycleOperation(.stagingCredential)
    var transientSecret = secret.withUnsafeBytes { Data($0) }
    defer { Self.erase(&transientSecret) }

    do {
      guard
        (1...brokerCredentialMaximumSecretBytes).contains(transientSecret.count)
      else {
        throw BrokerCredentialLifecycleClientError.invalidRequest
      }
      let metadata: Data
      do {
        metadata = try BrokerCredentialStageRequest(
          requestID: requestID,
          connectionID: connectionID,
          operationID: operationID,
          expectedFence: expectedFence,
          providerBinding: providerBinding
        ).encode()
      } catch {
        throw BrokerCredentialLifecycleClientError.protocolMismatch
      }

      let response = try await lifecycleExchange { [connection] reply in
        connection.stageCredential(metadata, secret: transientSecret, reply: reply)
      }
      guard phase == .stagingCredential else {
        throw BrokerCredentialLifecycleClientError.closed
      }
      guard !Task.isCancelled else {
        throw BrokerCredentialLifecycleClientError.cancelled
      }
      let projection = try Self.decodeLifecycleReply(
        response,
        requestID: requestID,
        expected: .staged
      )
      phase = .ready
      return projection
    } catch let failure as BrokerCredentialLifecycleClientError {
      failClosed()
      throw failure
    } catch {
      failClosed()
      throw .brokerUnavailable
    }
  }

  package func controlCredential(
    _ operation: BrokerCredentialLifecycleControl
  ) async throws(BrokerCredentialLifecycleClientError) -> BrokerCredentialRedactedProjection {
    let requestID = try beginLifecycleOperation(.controllingCredential)

    do {
      let request: Data
      do {
        request = try operation.request(requestID: requestID).encode()
      } catch {
        throw BrokerCredentialLifecycleClientError.protocolMismatch
      }
      let response = try await lifecycleExchange { [connection] reply in
        connection.credentialControl(request, reply: reply)
      }
      guard phase == .controllingCredential else {
        throw BrokerCredentialLifecycleClientError.closed
      }
      guard !Task.isCancelled else {
        throw BrokerCredentialLifecycleClientError.cancelled
      }
      let projection = try Self.decodeLifecycleReply(
        response,
        requestID: requestID,
        expected: operation.expectedReply
      )
      phase = .ready
      return projection
    } catch let failure as BrokerCredentialLifecycleClientError {
      failClosed()
      throw failure
    } catch {
      failClosed()
      throw .brokerUnavailable
    }
  }

  package func close() {
    failClosed()
  }

  private func claimRequestID() throws(BrokerConnectionError) -> UInt32 {
    guard let requestID = nextRequestID else {
      throw .protocolMismatch
    }
    nextRequestID = requestID == UInt32.max ? nil : requestID + 1
    return requestID
  }

  private func beginLifecycleOperation(
    _ operationPhase: Phase
  ) throws(BrokerCredentialLifecycleClientError) -> UInt64 {
    switch phase {
    case .ready:
      break
    case .open, .handshaking:
      failClosed()
      throw .sessionNotReady
    case .closed:
      throw .closed
    case .checkingHealth, .stagingCredential, .controllingCredential:
      throw .busy
    }
    guard let requestID = nextLifecycleRequestID else {
      failClosed()
      throw .protocolMismatch
    }
    nextLifecycleRequestID = requestID == UInt64.max - 1 ? nil : requestID + 1
    phase = operationPhase
    return requestID
  }

  private func failClosed() {
    guard phase != .closed else {
      return
    }
    phase = .closed
    nextRequestID = nil
    nextLifecycleRequestID = nil
    let lifecycleReply = activeLifecycleReply
    activeLifecycleReply = nil
    lifecycleReply?.cancel()
    connection.invalidate()
  }

  private func exchange(_ frame: Data) async throws -> Data {
    try await withCheckedThrowingContinuation { continuation in
      let reply = TimedBrokerXPCReply(timeout: xpcReplyTimeout)
      guard reply.install(continuation) else { return }
      reply.armTimeout()
      connection.exchange(frame) { result in
        reply.resolve(result)
      }
    }
  }

  private func lifecycleExchange(
    _ start: (@escaping @Sendable (Result<Data, BrokerXPCExchangeError>) -> Void) -> Void
  ) async throws(BrokerCredentialLifecycleClientError) -> Data {
    let reply = TimedBrokerXPCReply(timeout: xpcReplyTimeout)
    activeLifecycleReply = reply
    defer {
      if activeLifecycleReply === reply {
        activeLifecycleReply = nil
      }
    }
    do {
      return try await withTaskCancellationHandler {
        try await withCheckedThrowingContinuation { continuation in
          guard reply.install(continuation) else { return }
          reply.armTimeout()
          guard !Task.isCancelled else {
            reply.cancel()
            return
          }
          start(reply.resolve)
        }
      } onCancel: {
        reply.cancel()
      }
    } catch let failure as BrokerXPCExchangeError {
      switch failure {
      case .brokerUnavailable:
        throw .brokerUnavailable
      case .cancelled:
        throw .cancelled
      }
    } catch {
      throw .brokerUnavailable
    }
  }

  private static func decodeLifecycleReply(
    _ data: Data,
    requestID: UInt64,
    expected: BrokerCredentialLifecycleControl.ExpectedReply
  ) throws(BrokerCredentialLifecycleClientError) -> BrokerCredentialRedactedProjection {
    let reply: BrokerCredentialLifecycleReply
    do {
      reply = try BrokerCredentialLifecycleReply.decode(data)
    } catch {
      throw .protocolMismatch
    }

    switch reply {
    case .projection(let replyID, let projection):
      guard replyID == requestID, expected == .projection else {
        throw .protocolMismatch
      }
      return projection
    case .staged(let replyID, let projection):
      guard replyID == requestID, expected == .staged else {
        throw .protocolMismatch
      }
      return projection
    case .mutation(let replyID, let projection):
      guard replyID == requestID, expected == .mutation else {
        throw .protocolMismatch
      }
      return projection
    case .failure(let replyID, let code):
      guard replyID == requestID else {
        throw .protocolMismatch
      }
      throw BrokerCredentialLifecycleClientError(code)
    }
  }

  private static func erase(_ data: inout Data) {
    _ = data.withUnsafeMutableBytes { (bytes: UnsafeMutableRawBufferPointer) in
      bytes.initializeMemory(as: UInt8.self, repeating: 0)
    }
    data.removeAll(keepingCapacity: false)
  }

  private static func decodeResponse(
    _ encoded: Data,
    requestID: UInt32
  ) throws(BrokerConnectionError) -> NativeFrame {
    let frame: NativeFrame
    do {
      var decoder = NativeFrameDecoder()
      let frames = try decoder.push(encoded)
      try decoder.finish()
      guard frames.count == 1, let decoded = frames.first else {
        throw BrokerConnectionError.protocolMismatch
      }
      frame = decoded
    } catch let failure as BrokerConnectionError {
      throw failure
    } catch {
      throw .protocolMismatch
    }

    guard frame.requestID == requestID else {
      throw .protocolMismatch
    }
    if frame.type == .safeFailure {
      do {
        throw mapSafeFailure(try SafeFailureCode.decode(frame))
      } catch let failure as BrokerConnectionError {
        throw failure
      } catch {
        throw .protocolMismatch
      }
    }
    return frame
  }

  private static func mapSafeFailure(_ code: SafeFailureCode) -> BrokerConnectionError {
    switch code {
    case .unsupportedPlatform:
      .unsupportedPlatform
    case .unsupportedOSVersion:
      .unsupportedOSVersion
    case .launcherUnavailable:
      .launcherUnavailable
    case .brokerUnavailable:
      .brokerUnavailable
    case .protocolMismatch:
      .protocolMismatch
    case .peerIdentityUnverified:
      .peerIdentityUnverified
    case .productionSigningRequired:
      .productionSigningRequired
    case .keychainUnavailable:
      .keychainUnavailable
    case .unsupportedOperation:
      .unsupportedOperation
    }
  }
}

private struct SystemBrokerXPCConnectionFactory: BrokerXPCConnectionFactory {
  func makeConnection() -> any BrokerXPCConnectionHandling {
    SystemBrokerXPCConnection()
  }
}

private final class SystemBrokerXPCConnection: BrokerXPCConnectionHandling,
  @unchecked Sendable
{
  private static let machServiceName = "com.recurs.cli.broker"

  private let connection = NSXPCConnection(
    machServiceName: machServiceName,
    options: []
  )

  func installRemoteInterface() {
    let interface = NSXPCInterface(with: BrokerCredentialLifecycleXPCProtocol.self)
    let dataClasses = NSSet(object: NSData.self) as! Set<AnyHashable>
    let exchange = #selector(BrokerXPCProtocol.exchange(_:reply:))
    interface.setClasses(dataClasses, for: exchange, argumentIndex: 0, ofReply: false)
    interface.setClasses(dataClasses, for: exchange, argumentIndex: 0, ofReply: true)
    let stage = #selector(
      BrokerCredentialLifecycleXPCProtocol.stageCredential(_:secret:reply:)
    )
    interface.setClasses(dataClasses, for: stage, argumentIndex: 0, ofReply: false)
    interface.setClasses(dataClasses, for: stage, argumentIndex: 1, ofReply: false)
    interface.setClasses(dataClasses, for: stage, argumentIndex: 0, ofReply: true)
    let control = #selector(
      BrokerCredentialLifecycleXPCProtocol.credentialControl(_:reply:)
    )
    interface.setClasses(dataClasses, for: control, argumentIndex: 0, ofReply: false)
    interface.setClasses(dataClasses, for: control, argumentIndex: 0, ofReply: true)
    connection.remoteObjectInterface = interface
  }

  func setCodeSigningRequirement(_ requirement: String) {
    connection.setCodeSigningRequirement(requirement)
  }

  func activate() {
    connection.activate()
  }

  func exchange(
    _ frame: Data,
    reply: @escaping @Sendable (Result<Data, BrokerXPCExchangeError>) -> Void
  ) {
    let remoteObject = connection.remoteObjectProxyWithErrorHandler { _ in
      reply(.failure(.brokerUnavailable))
    }
    guard let proxy = remoteObject as? BrokerXPCProtocol else {
      reply(.failure(.brokerUnavailable))
      return
    }
    proxy.exchange(frame) { response in
      reply(.success(response))
    }
  }

  func stageCredential(
    _ metadata: Data,
    secret: Data,
    reply: @escaping @Sendable (Result<Data, BrokerXPCExchangeError>) -> Void
  ) {
    let remoteObject = connection.remoteObjectProxyWithErrorHandler { _ in
      reply(.failure(.brokerUnavailable))
    }
    guard let proxy = remoteObject as? BrokerCredentialLifecycleXPCProtocol else {
      reply(.failure(.brokerUnavailable))
      return
    }
    proxy.stageCredential(metadata, secret: secret) { response in
      reply(.success(response))
    }
  }

  func credentialControl(
    _ request: Data,
    reply: @escaping @Sendable (Result<Data, BrokerXPCExchangeError>) -> Void
  ) {
    let remoteObject = connection.remoteObjectProxyWithErrorHandler { _ in
      reply(.failure(.brokerUnavailable))
    }
    guard let proxy = remoteObject as? BrokerCredentialLifecycleXPCProtocol else {
      reply(.failure(.brokerUnavailable))
      return
    }
    proxy.credentialControl(request) { response in
      reply(.success(response))
    }
  }

  func invalidate() {
    connection.invalidate()
  }
}

private final class TimedBrokerXPCReply: @unchecked Sendable {
  private let lock = NSLock()
  private let timeout: Duration
  private var continuation: CheckedContinuation<Data, any Error>?
  private var pendingResult: Result<Data, BrokerXPCExchangeError>?
  private var isSettled = false
  private var timeoutTask: Task<Void, Never>?

  init(timeout: Duration) {
    self.timeout = timeout
  }

  func install(_ continuation: CheckedContinuation<Data, any Error>) -> Bool {
    let pending: Result<Data, BrokerXPCExchangeError>? = lock.withLock {
      if isSettled, let pendingResult {
        self.pendingResult = nil
        return pendingResult
      }
      guard !isSettled else { return .failure(.brokerUnavailable) }
      self.continuation = continuation
      return nil
    }
    guard let pending else { return true }
    Self.resume(continuation, with: pending)
    return false
  }

  func armTimeout() {
    let task = Task { [self] in
      try? await Task.sleep(for: timeout)
      guard !Task.isCancelled else { return }
      resolve(.failure(.brokerUnavailable))
    }
    let shouldCancel = lock.withLock { () -> Bool in
      guard !isSettled, continuation != nil else { return true }
      timeoutTask = task
      return false
    }
    if shouldCancel { task.cancel() }
  }

  func cancel() {
    resolve(.failure(.cancelled))
  }

  func resolve(_ result: Result<Data, BrokerXPCExchangeError>) {
    let owned:
      (
        CheckedContinuation<Data, any Error>?,
        Task<Void, Never>?
      ) = lock.withLock {
        guard !isSettled else { return (nil, nil) }
        isSettled = true
        guard let continuation else {
          pendingResult = result
          return (nil, nil)
        }
        self.continuation = nil
        let timeoutTask = self.timeoutTask
        self.timeoutTask = nil
        return (continuation, timeoutTask)
      }
    guard let continuation = owned.0 else { return }
    owned.1?.cancel()
    Self.resume(continuation, with: result)
  }

  private static func resume(
    _ continuation: CheckedContinuation<Data, any Error>,
    with result: Result<Data, BrokerXPCExchangeError>
  ) {
    switch result {
    case .success(let data):
      continuation.resume(returning: data)
    case .failure(let failure):
      continuation.resume(throwing: failure)
    }
  }
}
