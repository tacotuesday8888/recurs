import Foundation
import RecursBrokerCore
import RecursBrokerXPC
import RecursNativeProtocol

let brokerMalformedFrameRequestID = UInt32.max

enum BrokerServiceConfigurationError: Error, Equatable, Sendable {
  case invalidConfiguration
}

struct BrokerServiceConfiguration: Sendable {
  let launcherVersion: String
  let brokerVersion: String
  let productionSigned: Bool
  let keychainStatus: @Sendable () -> KeychainStatusCode
  private let credentialAuthority: (any BrokerCredentialLifecycleAuthority)?

  init(
    launcherVersion: String,
    brokerVersion: String,
    productionSigned: Bool,
    keychain: KeychainStatusCode
  ) throws {
    try self.init(
      launcherVersion: launcherVersion,
      brokerVersion: brokerVersion,
      productionSigned: productionSigned,
      keychainStatus: { keychain },
      credentialAuthority: nil
    )
  }

  init(
    launcherVersion: String,
    brokerVersion: String,
    productionSigned: Bool,
    keychainStatus: @escaping @Sendable () -> KeychainStatusCode
  ) throws {
    try self.init(
      launcherVersion: launcherVersion,
      brokerVersion: brokerVersion,
      productionSigned: productionSigned,
      keychainStatus: keychainStatus,
      credentialAuthority: nil
    )
  }

  private init(
    launcherVersion: String,
    brokerVersion: String,
    productionSigned: Bool,
    keychainStatus: @escaping @Sendable () -> KeychainStatusCode,
    credentialAuthority: (any BrokerCredentialLifecycleAuthority)?
  ) throws {
    do {
      _ = try FieldTable.encodeVersionText(launcherVersion)
      _ = try FieldTable.encodeVersionText(brokerVersion)
    } catch {
      throw BrokerServiceConfigurationError.invalidConfiguration
    }
    self.launcherVersion = launcherVersion
    self.brokerVersion = brokerVersion
    self.productionSigned = productionSigned
    self.keychainStatus = keychainStatus
    self.credentialAuthority = credentialAuthority
  }

  static func recoveredCredentialService(
    launcherVersion: String,
    brokerVersion: String,
    authority: any BrokerCredentialLifecycleAuthority,
    keychainStatus: @escaping @Sendable () -> KeychainStatusCode
  ) throws -> BrokerServiceConfiguration {
    try BrokerServiceConfiguration(
      launcherVersion: launcherVersion,
      brokerVersion: brokerVersion,
      productionSigned: true,
      keychainStatus: keychainStatus,
      credentialAuthority: authority
    )
  }

  static func healthOnlyForTesting(
    launcherVersion: String,
    brokerVersion: String,
    productionSigned: Bool,
    keychainStatus: @escaping @Sendable () -> KeychainStatusCode
  ) throws -> BrokerServiceConfiguration {
    try BrokerServiceConfiguration(
      launcherVersion: launcherVersion,
      brokerVersion: brokerVersion,
      productionSigned: productionSigned,
      keychainStatus: keychainStatus,
      credentialAuthority: nil
    )
  }

  var exportsCredentialLifecycle: Bool {
    credentialAuthority != nil
  }

  func makeCredentialLifecycleGateway() -> BrokerCredentialLifecycleGateway? {
    credentialAuthority.map(BrokerCredentialLifecycleGateway.init(authority:))
  }
}

enum BrokerServiceLifecycleAction: Sendable {
  case none
  case authorize
  case close
}

struct BrokerServiceExchange: Sendable {
  let response: Data
  let lifecycleAction: BrokerServiceLifecycleAction
}

struct BrokerServiceSession: Sendable {
  private enum Phase: Sendable {
    case awaitingHello
    case ready
    case failed
  }

  private let configuration: BrokerServiceConfiguration
  private var phase = Phase.awaitingHello
  private var greatestRequestID: UInt32 = 0

  init(configuration: BrokerServiceConfiguration) {
    self.configuration = configuration
  }

  mutating func exchange(_ frame: Data) -> BrokerServiceExchange {
    var failureRequestID = brokerMalformedFrameRequestID
    do {
      var decoder = NativeFrameDecoder()
      let frames = try decoder.push(frame)
      try decoder.finish()
      guard frames.count == 1 else {
        return terminalFailure(
          .protocolMismatch,
          requestID: brokerMalformedFrameRequestID
        )
      }

      let request = frames[0]
      failureRequestID = request.requestID
      guard phase != .failed, request.requestID > greatestRequestID else {
        return terminalFailure(.protocolMismatch, requestID: request.requestID)
      }
      greatestRequestID = request.requestID

      switch request.type {
      case .hello:
        guard phase == .awaitingHello else {
          return terminalFailure(.protocolMismatch, requestID: request.requestID)
        }
        let hello = try HelloMessage.decode(request)
        guard hello.engineVersion == configuration.launcherVersion else {
          return terminalFailure(.protocolMismatch, requestID: request.requestID)
        }
        let response = try HelloResultMessage(
          launcherVersion: configuration.launcherVersion,
          brokerVersion: configuration.brokerVersion,
          echoedNonce: hello.nonce,
          productionSigned: configuration.productionSigned,
          persistentCredentials: configuration.exportsCredentialLifecycle,
          minimumMacosVersion: "14.4"
        ).encodedFrame(requestID: request.requestID)
        phase = .ready
        return BrokerServiceExchange(response: response, lifecycleAction: .authorize)
      case .health:
        guard
          phase == .ready,
          try FieldTable.decode(request.payload).fields.isEmpty
        else {
          return terminalFailure(.protocolMismatch, requestID: request.requestID)
        }
        return BrokerServiceExchange(
          response: try HealthResultMessage(
            keychain: configuration.keychainStatus(),
            peerVerified: true
          ).encodedFrame(requestID: request.requestID),
          lifecycleAction: .none
        )
      default:
        return BrokerServiceExchange(
          response: safeFailure(.unsupportedOperation, requestID: request.requestID),
          lifecycleAction: .none
        )
      }
    } catch {
      return terminalFailure(
        .protocolMismatch,
        requestID: failureRequestID
      )
    }
  }

  private mutating func terminalFailure(
    _ code: SafeFailureCode,
    requestID: UInt32
  ) -> BrokerServiceExchange {
    phase = .failed
    return BrokerServiceExchange(
      response: safeFailure(code, requestID: requestID),
      lifecycleAction: .close
    )
  }

  private func safeFailure(_ code: SafeFailureCode, requestID: UInt32) -> Data {
    (try? code.encodedFrame(requestID: requestID)) ?? Data()
  }
}

final class BrokerService: NSObject, BrokerCredentialLifecycleXPCProtocol,
  @unchecked Sendable
{
  private let lock = NSLock()
  private var session: BrokerServiceSession
  private let credentialGateway: BrokerCredentialLifecycleGateway?

  init(configuration: BrokerServiceConfiguration) {
    self.session = BrokerServiceSession(configuration: configuration)
    self.credentialGateway = configuration.makeCredentialLifecycleGateway()
    super.init()
  }

  func exchange(_ frame: Data, reply: @escaping @Sendable (Data) -> Void) {
    let exchange = lock.withLock {
      session.exchange(frame)
    }
    switch exchange.lifecycleAction {
    case .none:
      break
    case .authorize:
      credentialGateway?.authorizeAfterHello()
    case .close:
      credentialGateway?.close()
    }
    reply(exchange.response)
  }

  func stageCredential(
    _ metadata: Data,
    secret: Data,
    reply: @escaping @Sendable (Data) -> Void
  ) {
    let ownedSecretData = secret.withUnsafeBytes { Data($0) }
    guard let credentialGateway else {
      let ownedSecret = SecretBytes(ownedSecretData)
      let byteCount = ownedSecret.withUnsafeBytes(\.count)
      ownedSecret.erase()
      reply(Self.unavailableStage(metadata, secretByteCount: byteCount))
      return
    }
    credentialGateway.submitStage(metadata: metadata, secret: ownedSecretData, reply: reply)
  }

  func credentialControl(
    _ request: Data,
    reply: @escaping @Sendable (Data) -> Void
  ) {
    guard let credentialGateway else {
      reply(Self.unavailableControl(request))
      return
    }
    credentialGateway.submitControl(request, reply: reply)
  }

  func close() {
    credentialGateway?.close()
  }

  func transportTeardown() {
    credentialGateway?.transportTeardown()
  }

  private static func unavailableStage(_ data: Data, secretByteCount: Int) -> Data {
    do {
      let request = try BrokerCredentialStageRequest.decode(data)
      guard (1...brokerCredentialMaximumSecretBytes).contains(secretByteCount)
      else {
        return lifecycleFailure(requestID: request.requestID, code: .invalidRequest)
      }
      return lifecycleFailure(requestID: request.requestID, code: .operationUnavailable)
    } catch let error as BrokerCredentialLifecycleCodecError {
      return lifecycleFailure(
        requestID: error.requestID ?? brokerCredentialMalformedRequestID,
        code: .invalidRequest
      )
    } catch {
      return lifecycleFailure(
        requestID: brokerCredentialMalformedRequestID,
        code: .invalidRequest
      )
    }
  }

  private static func unavailableControl(_ data: Data) -> Data {
    do {
      let request = try BrokerCredentialControlRequest.decode(data)
      return lifecycleFailure(requestID: request.requestID, code: .operationUnavailable)
    } catch let error as BrokerCredentialLifecycleCodecError {
      return lifecycleFailure(
        requestID: error.requestID ?? brokerCredentialMalformedRequestID,
        code: .invalidRequest
      )
    } catch {
      return lifecycleFailure(
        requestID: brokerCredentialMalformedRequestID,
        code: .invalidRequest
      )
    }
  }

  private static func lifecycleFailure(
    requestID: UInt64,
    code: BrokerCredentialLifecycleFailureCode
  ) -> Data {
    (try? BrokerCredentialLifecycleReply.failure(requestID: requestID, code).encode()) ?? Data()
  }
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
