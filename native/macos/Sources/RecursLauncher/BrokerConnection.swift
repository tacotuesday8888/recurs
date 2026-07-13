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
}

package protocol BrokerXPCConnectionHandling: AnyObject, Sendable {
  func installRemoteInterface()
  func setCodeSigningRequirement(_ requirement: String)
  func activate()
  func exchange(
    _ frame: Data,
    reply: @escaping @Sendable (Result<Data, BrokerXPCExchangeError>) -> Void
  )
  func invalidate()
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
    case closed
  }

  private let connection: any BrokerXPCConnectionHandling
  private var phase = Phase.open
  private var nextRequestID: UInt32? = 1

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
    let connection = connectionFactory.makeConnection()
    connection.installRemoteInterface()
    connection.setCodeSigningRequirement(requirement.requirementString)
    connection.activate()
    self.connection = connection
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

  private func failClosed() {
    guard phase != .closed else {
      return
    }
    phase = .closed
    nextRequestID = nil
    connection.invalidate()
  }

  private func exchange(_ frame: Data) async throws -> Data {
    try await withCheckedThrowingContinuation { continuation in
      let reply = TimedBrokerXPCReply(continuation: continuation)
      reply.armTimeout()
      connection.exchange(frame) { result in
        reply.resolve(result)
      }
    }
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
    let interface = NSXPCInterface(with: BrokerXPCProtocol.self)
    let selector = #selector(BrokerXPCProtocol.exchange(_:reply:))
    let dataClasses = NSSet(object: NSData.self) as! Set<AnyHashable>
    interface.setClasses(
      dataClasses,
      for: selector,
      argumentIndex: 0,
      ofReply: false
    )
    interface.setClasses(
      dataClasses,
      for: selector,
      argumentIndex: 0,
      ofReply: true
    )
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

  func invalidate() {
    connection.invalidate()
  }
}

private final class TimedBrokerXPCReply: @unchecked Sendable {
  private static let timeout: Duration = .seconds(5)

  private let lock = NSLock()
  private var continuation: CheckedContinuation<Data, any Error>?
  private var timeoutTask: Task<Void, Never>?

  init(continuation: CheckedContinuation<Data, any Error>) {
    self.continuation = continuation
  }

  func armTimeout() {
    let task = Task { [self] in
      try? await Task.sleep(for: Self.timeout)
      guard !Task.isCancelled else {
        return
      }
      resolve(.failure(.brokerUnavailable))
    }

    lock.lock()
    if continuation == nil {
      lock.unlock()
      task.cancel()
      return
    }
    timeoutTask = task
    lock.unlock()
  }

  func resolve(_ result: Result<Data, BrokerXPCExchangeError>) {
    let continuation: CheckedContinuation<Data, any Error>?
    let timeoutTask: Task<Void, Never>?
    lock.lock()
    continuation = self.continuation
    self.continuation = nil
    timeoutTask = self.timeoutTask
    self.timeoutTask = nil
    lock.unlock()

    guard let continuation else {
      return
    }
    timeoutTask?.cancel()
    switch result {
    case .success(let response):
      continuation.resume(returning: response)
    case .failure(let failure):
      continuation.resume(throwing: failure)
    }
  }
}
