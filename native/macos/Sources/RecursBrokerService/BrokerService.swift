import Foundation
import RecursBrokerXPC
import RecursNativeProtocol

let brokerMalformedFrameRequestID = UInt32.max

package enum BrokerServiceConfigurationError: Error, Equatable, Sendable {
  case invalidConfiguration
}

package struct BrokerServiceConfiguration: Sendable {
  let launcherVersion: String
  let brokerVersion: String
  let productionSigned: Bool
  let persistentCredentials: Bool
  let keychainStatus: @Sendable () -> KeychainStatusCode

  package init(
    launcherVersion: String,
    brokerVersion: String,
    productionSigned: Bool,
    persistentCredentials: Bool,
    keychain: KeychainStatusCode
  ) throws {
    try self.init(
      launcherVersion: launcherVersion,
      brokerVersion: brokerVersion,
      productionSigned: productionSigned,
      persistentCredentials: persistentCredentials,
      initialKeychain: keychain,
      keychainStatus: { keychain }
    )
  }

  package init(
    launcherVersion: String,
    brokerVersion: String,
    productionSigned: Bool,
    persistentCredentials: Bool,
    initialKeychain: KeychainStatusCode,
    keychainStatus: @escaping @Sendable () -> KeychainStatusCode
  ) throws {
    do {
      _ = try FieldTable.encodeVersionText(launcherVersion)
      _ = try FieldTable.encodeVersionText(brokerVersion)
    } catch {
      throw BrokerServiceConfigurationError.invalidConfiguration
    }
    guard
      !persistentCredentials
        || (productionSigned && initialKeychain != .unavailable)
    else {
      throw BrokerServiceConfigurationError.invalidConfiguration
    }

    self.launcherVersion = launcherVersion
    self.brokerVersion = brokerVersion
    self.productionSigned = productionSigned
    self.persistentCredentials = persistentCredentials
    self.keychainStatus = keychainStatus
  }

  package static func productionHandshakeHealthOnly(
    launcherVersion: String,
    brokerVersion: String,
    initialKeychain: KeychainStatusCode,
    keychainStatus: @escaping @Sendable () -> KeychainStatusCode
  ) throws -> BrokerServiceConfiguration {
    try BrokerServiceConfiguration(
      launcherVersion: launcherVersion,
      brokerVersion: brokerVersion,
      productionSigned: true,
      persistentCredentials: false,
      initialKeychain: initialKeychain,
      keychainStatus: keychainStatus
    )
  }
}

package struct BrokerServiceSession: Sendable {
  private enum Phase: Sendable {
    case awaitingHello
    case ready
    case failed
  }

  private let configuration: BrokerServiceConfiguration
  private var phase = Phase.awaitingHello
  private var greatestRequestID: UInt32 = 0

  package init(configuration: BrokerServiceConfiguration) {
    self.configuration = configuration
  }

  package mutating func exchange(_ frame: Data) -> Data {
    var failureRequestID = brokerMalformedFrameRequestID
    do {
      var decoder = NativeFrameDecoder()
      let frames = try decoder.push(frame)
      try decoder.finish()
      guard frames.count == 1 else {
        phase = .failed
        return safeFailure(
          .protocolMismatch,
          requestID: brokerMalformedFrameRequestID
        )
      }

      let request = frames[0]
      failureRequestID = request.requestID
      guard phase != .failed, request.requestID > greatestRequestID else {
        phase = .failed
        return safeFailure(.protocolMismatch, requestID: request.requestID)
      }
      greatestRequestID = request.requestID

      switch request.type {
      case .hello:
        guard phase == .awaitingHello else {
          phase = .failed
          return safeFailure(.protocolMismatch, requestID: request.requestID)
        }
        let hello = try HelloMessage.decode(request)
        guard hello.engineVersion == configuration.launcherVersion else {
          phase = .failed
          return safeFailure(.protocolMismatch, requestID: request.requestID)
        }
        let response = try HelloResultMessage(
          launcherVersion: configuration.launcherVersion,
          brokerVersion: configuration.brokerVersion,
          echoedNonce: hello.nonce,
          productionSigned: configuration.productionSigned,
          persistentCredentials: configuration.persistentCredentials,
          minimumMacosVersion: "14.4"
        ).encodedFrame(requestID: request.requestID)
        phase = .ready
        return response
      case .health:
        guard
          phase == .ready,
          try FieldTable.decode(request.payload).fields.isEmpty
        else {
          phase = .failed
          return safeFailure(.protocolMismatch, requestID: request.requestID)
        }
        return try HealthResultMessage(
          keychain: configuration.keychainStatus(),
          peerVerified: true
        ).encodedFrame(requestID: request.requestID)
      default:
        return safeFailure(.unsupportedOperation, requestID: request.requestID)
      }
    } catch {
      phase = .failed
      return safeFailure(
        .protocolMismatch,
        requestID: failureRequestID
      )
    }
  }

  private func safeFailure(_ code: SafeFailureCode, requestID: UInt32) -> Data {
    (try? code.encodedFrame(requestID: requestID)) ?? Data()
  }
}

package final class BrokerService: NSObject, BrokerXPCProtocol, @unchecked Sendable {
  private let lock = NSLock()
  private var session: BrokerServiceSession

  package init(configuration: BrokerServiceConfiguration) {
    self.session = BrokerServiceSession(configuration: configuration)
    super.init()
  }

  package func exchange(_ frame: Data, reply: @escaping (Data) -> Void) {
    let response = lock.withLock {
      session.exchange(frame)
    }
    reply(response)
  }
}
