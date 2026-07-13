import Foundation
import RecursNativeProtocol

package protocol LauncherNodeSessionOutput: Sendable {
  func write(_ frame: Data) async throws
  func close() async
}

package actor LauncherNodeSession {
  private enum Phase: Sendable {
    case awaitingHello
    case handshaking
    case ready
    case closed
  }

  private enum ActiveRequest: Sendable, Equatable {
    case hello(UInt32)
    case health(UInt32)

    var requestID: UInt32 {
      switch self {
      case .hello(let requestID), .health(let requestID):
        requestID
      }
    }
  }

  private static let maximumHealthWorkCount = 64

  private let brokerConnectionFactory:
    @Sendable () throws(BrokerConnectionError) -> BrokerConnection
  private let output: any LauncherNodeSessionOutput

  private var phase = Phase.awaitingHello
  private var decoder = NativeFrameDecoder()
  private var greatestSeenRequestID: UInt32?
  private var brokerConnection: BrokerConnection?
  private var activeRequest: ActiveRequest?
  private var activeTask: Task<Void, Never>?
  private var queuedHealthRequestIDs: [UInt32] = []
  private var cleanupStarted = false

  package init(
    brokerConnectionFactory: @escaping @Sendable () throws(BrokerConnectionError) -> BrokerConnection,
    output: any LauncherNodeSessionOutput
  ) {
    self.brokerConnectionFactory = brokerConnectionFactory
    self.output = output
  }

  package func receive(_ chunk: Data) {
    guard phase != .closed else {
      return
    }

    do {
      let frames = try decoder.push(chunk)
      for frame in frames {
        guard phase != .closed else {
          return
        }
        try receive(frame)
      }
    } catch {
      failClosed()
    }
  }

  package func finish() {
    guard phase != .closed else {
      return
    }
    do {
      try decoder.finish()
    } catch {
      failClosed()
      return
    }
    failClosed()
  }

  package func close() {
    failClosed()
  }

  private func receive(_ frame: NativeFrame) throws {
    if let greatestSeenRequestID {
      guard frame.requestID > greatestSeenRequestID else {
        throw NativeProtocolError.invalidMessage
      }
    }
    greatestSeenRequestID = frame.requestID

    switch phase {
    case .awaitingHello:
      guard frame.type == .hello else {
        throw NativeProtocolError.invalidMessage
      }
      let hello = try HelloMessage.decode(frame)
      startHandshake(hello, requestID: frame.requestID)

    case .handshaking:
      try receiveWhileHandshaking(frame)

    case .ready:
      try receiveWhileReady(frame)

    case .closed:
      return
    }
  }

  private func receiveWhileHandshaking(_ frame: NativeFrame) throws {
    switch frame.type {
    case .health:
      _ = try HealthMessage.decode(frame)
      try enqueueHealth(requestID: frame.requestID)
    case .cancel:
      try cancel(try CancelMessage.decode(frame))
    default:
      throw NativeProtocolError.invalidMessage
    }
  }

  private func receiveWhileReady(_ frame: NativeFrame) throws {
    switch frame.type {
    case .health:
      _ = try HealthMessage.decode(frame)
      try enqueueHealth(requestID: frame.requestID)
      startNextHealthIfNeeded()
    case .cancel:
      try cancel(try CancelMessage.decode(frame))
    default:
      throw NativeProtocolError.invalidMessage
    }
  }

  private func enqueueHealth(requestID: UInt32) throws {
    guard healthWorkCount < Self.maximumHealthWorkCount else {
      throw NativeProtocolError.invalidMessage
    }
    queuedHealthRequestIDs.append(requestID)
  }

  private var healthWorkCount: Int {
    queuedHealthRequestIDs.count + (isHealthActive ? 1 : 0)
  }

  private var isHealthActive: Bool {
    if case .health = activeRequest {
      return true
    }
    return false
  }

  private func cancel(_ message: CancelMessage) throws {
    if activeRequest?.requestID == message.targetRequestID {
      failClosed()
      return
    }
    if let index = queuedHealthRequestIDs.firstIndex(of: message.targetRequestID) {
      queuedHealthRequestIDs.remove(at: index)
      return
    }
    throw NativeProtocolError.invalidMessage
  }

  private func startHandshake(_ hello: HelloMessage, requestID: UInt32) {
    phase = .handshaking
    activeRequest = .hello(requestID)

    let connection: BrokerConnection
    do {
      connection = try brokerConnectionFactory()
      brokerConnection = connection
    } catch let failure {
      activeTask = Task { [weak self] in
        guard !Task.isCancelled else {
          return
        }
        await self?.finishWithBrokerFailure(failure, requestID: requestID)
      }
      return
    }

    activeTask = Task { [weak self, connection] in
      guard !Task.isCancelled else {
        return
      }
      let result: Result<HelloResultMessage, BrokerConnectionError>
      do {
        result = .success(
          try await connection.handshake(
            engineVersion: hello.engineVersion,
            nonce: hello.nonce
          )
        )
      } catch let failure as BrokerConnectionError {
        result = .failure(failure)
      } catch {
        await self?.unknownBrokerFailure(requestID: requestID)
        return
      }
      await self?.handshakeCompleted(result, requestID: requestID)
    }
  }

  private func handshakeCompleted(
    _ result: Result<HelloResultMessage, BrokerConnectionError>,
    requestID: UInt32
  ) async {
    guard phase == .handshaking, activeRequest == .hello(requestID) else {
      return
    }

    switch result {
    case .success(let helloResult):
      do {
        let frame = try helloResult.encodedFrame(requestID: requestID)
        try await output.write(frame)
      } catch {
        failClosed()
        return
      }
      guard phase == .handshaking, activeRequest == .hello(requestID) else {
        return
      }
      activeRequest = nil
      activeTask = nil
      phase = .ready
      startNextHealthIfNeeded()

    case .failure(let failure):
      await finishWithBrokerFailure(failure, requestID: requestID)
    }
  }

  private func startNextHealthIfNeeded() {
    guard
      phase == .ready,
      activeRequest == nil,
      activeTask == nil,
      let connection = brokerConnection,
      !queuedHealthRequestIDs.isEmpty
    else {
      return
    }

    let requestID = queuedHealthRequestIDs.removeFirst()
    activeRequest = .health(requestID)
    activeTask = Task { [weak self, connection] in
      guard !Task.isCancelled else {
        return
      }
      let result: Result<HealthResultMessage, BrokerConnectionError>
      do {
        result = .success(try await connection.health())
      } catch let failure as BrokerConnectionError {
        result = .failure(failure)
      } catch {
        await self?.unknownBrokerFailure(requestID: requestID)
        return
      }
      await self?.healthCompleted(result, requestID: requestID)
    }
  }

  private func healthCompleted(
    _ result: Result<HealthResultMessage, BrokerConnectionError>,
    requestID: UInt32
  ) async {
    guard phase == .ready, activeRequest == .health(requestID) else {
      return
    }

    switch result {
    case .success(let healthResult):
      do {
        let frame = try healthResult.encodedFrame(requestID: requestID)
        try await output.write(frame)
      } catch {
        failClosed()
        return
      }
      guard phase == .ready, activeRequest == .health(requestID) else {
        return
      }
      activeRequest = nil
      activeTask = nil
      startNextHealthIfNeeded()

    case .failure(let failure):
      await finishWithBrokerFailure(failure, requestID: requestID)
    }
  }

  private func finishWithBrokerFailure(
    _ failure: BrokerConnectionError,
    requestID: UInt32
  ) async {
    guard phase != .closed, activeRequest?.requestID == requestID else {
      return
    }

    phase = .closed
    cleanupStarted = true
    queuedHealthRequestIDs.removeAll(keepingCapacity: false)
    activeRequest = nil
    activeTask = nil
    let connection = brokerConnection
    brokerConnection = nil

    do {
      try await output.write(
        mapFailure(failure).encodedFrame(requestID: requestID)
      )
    } catch {
      // The output is already terminal; never serialize native error details.
    }
    await connection?.close()
    await output.close()
  }

  private func unknownBrokerFailure(requestID: UInt32) {
    guard phase != .closed, activeRequest?.requestID == requestID else {
      return
    }
    failClosed()
  }

  private func failClosed() {
    guard !cleanupStarted else {
      phase = .closed
      return
    }

    phase = .closed
    cleanupStarted = true
    let task = activeTask
    activeTask = nil
    activeRequest = nil
    queuedHealthRequestIDs.removeAll(keepingCapacity: false)
    let connection = brokerConnection
    brokerConnection = nil
    task?.cancel()

    Task { [output] in
      await connection?.close()
      await output.close()
    }
  }

  private func mapFailure(_ failure: BrokerConnectionError) -> SafeFailureCode {
    switch failure {
    case .unsupportedPlatform:
      .unsupportedPlatform
    case .unsupportedOSVersion:
      .unsupportedOSVersion
    case .launcherUnavailable:
      .launcherUnavailable
    case .brokerUnavailable, .closed:
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
