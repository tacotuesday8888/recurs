import Foundation
import RecursBrokerCore
import RecursBrokerXPC
import RecursNativeProtocol

let brokerMalformedFrameRequestID = UInt32.max

enum BrokerServiceConfigurationError: Error, Equatable, Sendable {
  case invalidConfiguration
}

struct BrokerServiceOpenAIOnboardingDependencies: Sendable {
  let sessionFactory: any BrokerOpenAIOnboardingSessionFactory
  let credentialIdentityFingerprinter: any CredentialIdentityFingerprinting
}

struct BrokerServiceOpenAIGenerationDependencies: Sendable {
  let runner: any BrokerOpenAIGenerationRunning
}

struct BrokerServiceConfiguration: Sendable {
  let launcherVersion: String
  let brokerVersion: String
  let productionSigned: Bool
  let keychainStatus: @Sendable () -> KeychainStatusCode
  private let credentialAuthority: (any BrokerCredentialLifecycleAuthority)?
  private let openAIOnboarding: BrokerServiceOpenAIOnboardingDependencies?
  private let openAIGeneration: BrokerServiceOpenAIGenerationDependencies?

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
      credentialAuthority: nil,
      openAIOnboarding: nil,
      openAIGeneration: nil
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
      credentialAuthority: nil,
      openAIOnboarding: nil,
      openAIGeneration: nil
    )
  }

  private init(
    launcherVersion: String,
    brokerVersion: String,
    productionSigned: Bool,
    keychainStatus: @escaping @Sendable () -> KeychainStatusCode,
    credentialAuthority: (any BrokerCredentialLifecycleAuthority)?,
    openAIOnboarding: BrokerServiceOpenAIOnboardingDependencies?,
    openAIGeneration: BrokerServiceOpenAIGenerationDependencies?
  ) throws {
    do {
      _ = try FieldTable.encodeVersionText(launcherVersion)
      _ = try FieldTable.encodeVersionText(brokerVersion)
    } catch {
      throw BrokerServiceConfigurationError.invalidConfiguration
    }
    guard
      (openAIOnboarding == nil && openAIGeneration == nil)
        || (productionSigned && credentialAuthority != nil)
    else {
      throw BrokerServiceConfigurationError.invalidConfiguration
    }
    self.launcherVersion = launcherVersion
    self.brokerVersion = brokerVersion
    self.productionSigned = productionSigned
    self.keychainStatus = keychainStatus
    self.credentialAuthority = credentialAuthority
    self.openAIOnboarding = openAIOnboarding
    self.openAIGeneration = openAIGeneration
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
      credentialAuthority: authority,
      openAIOnboarding: nil,
      openAIGeneration: nil
    )
  }

  static func recoveredOpenAIService(
    launcherVersion: String,
    brokerVersion: String,
    authority: any BrokerCredentialLifecycleAuthority,
    sessionFactory: any BrokerOpenAIOnboardingSessionFactory,
    credentialIdentityFingerprinter: any CredentialIdentityFingerprinting,
    generationRunner: (any BrokerOpenAIGenerationRunning)? = nil,
    keychainStatus: @escaping @Sendable () -> KeychainStatusCode
  ) throws -> BrokerServiceConfiguration {
    try BrokerServiceConfiguration(
      launcherVersion: launcherVersion,
      brokerVersion: brokerVersion,
      productionSigned: true,
      keychainStatus: keychainStatus,
      credentialAuthority: authority,
      openAIOnboarding: BrokerServiceOpenAIOnboardingDependencies(
        sessionFactory: sessionFactory,
        credentialIdentityFingerprinter: credentialIdentityFingerprinter
      ),
      openAIGeneration: generationRunner.map(BrokerServiceOpenAIGenerationDependencies.init)
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
      credentialAuthority: nil,
      openAIOnboarding: nil,
      openAIGeneration: nil
    )
  }

  var exportsCredentialLifecycle: Bool {
    credentialAuthority != nil
  }

  var exportsOpenAIOnboarding: Bool {
    openAIOnboarding != nil
  }

  var exportsOpenAIGeneration: Bool { openAIGeneration != nil }

  func makeCredentialLifecycleGateway() -> BrokerCredentialLifecycleGateway? {
    credentialAuthority.map(BrokerCredentialLifecycleGateway.init(authority:))
  }

  func makeOpenAIOnboardingGateway() -> BrokerOpenAIOnboardingGateway? {
    guard let credentialAuthority, let openAIOnboarding else { return nil }
    return BrokerOpenAIOnboardingGateway(
      authority: credentialAuthority,
      factory: openAIOnboarding.sessionFactory,
      credentialIdentityFingerprinter: openAIOnboarding.credentialIdentityFingerprinter
    )
  }

  func makeOpenAIGenerationGateway() -> BrokerOpenAIGenerationGateway? {
    openAIGeneration.map { BrokerOpenAIGenerationGateway(runner: $0.runner) }
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

final class BrokerService: NSObject, BrokerOpenAIGenerationXPCProtocol,
  @unchecked Sendable
{
  private let lock = NSLock()
  private var session: BrokerServiceSession
  private let credentialGateway: BrokerCredentialLifecycleGateway?
  private let openAIOnboardingGateway: BrokerOpenAIOnboardingGateway?
  private let openAIGenerationGateway: BrokerOpenAIGenerationGateway?

  init(configuration: BrokerServiceConfiguration) {
    self.session = BrokerServiceSession(configuration: configuration)
    self.credentialGateway = configuration.makeCredentialLifecycleGateway()
    self.openAIOnboardingGateway = configuration.makeOpenAIOnboardingGateway()
    self.openAIGenerationGateway = configuration.makeOpenAIGenerationGateway()
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
      openAIOnboardingGateway?.authorizeAfterHello()
      openAIGenerationGateway?.authorizeAfterHello()
    case .close:
      credentialGateway?.close()
      openAIOnboardingGateway?.close()
      openAIGenerationGateway?.close()
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

  func beginOpenAIOnboarding(
    _ request: Data,
    secret: Data,
    reply: @escaping @Sendable (Data) -> Void
  ) {
    let ownedSecretData = secret.withUnsafeBytes { Data($0) }
    guard let openAIOnboardingGateway else {
      let ownedSecret = SecretBytes(ownedSecretData)
      let byteCount = ownedSecret.withUnsafeBytes(\.count)
      ownedSecret.erase()
      reply(Self.unavailableOpenAIBegin(request, secretByteCount: byteCount))
      return
    }
    openAIOnboardingGateway.submitBegin(request, secret: ownedSecretData, reply: reply)
  }

  func openAIOnboardingControl(
    _ request: Data,
    reply: @escaping @Sendable (Data) -> Void
  ) {
    guard let openAIOnboardingGateway else {
      reply(Self.unavailableOpenAIControl(request))
      return
    }
    openAIOnboardingGateway.submitControl(request, reply: reply)
  }

  func reconcileOpenAIActivation(
    _ request: Data,
    reply: @escaping @Sendable (Data) -> Void
  ) {
    guard let openAIOnboardingGateway else {
      reply(Self.unavailableOpenAIReconciliation(request))
      return
    }
    openAIOnboardingGateway.submitReconciliation(request, reply: reply)
  }

  func beginOpenAIGeneration(
    _ request: Data,
    reply: @escaping @Sendable (Data) -> Void
  ) {
    let result = openAIGenerationGateway?.begin(request) ?? .failure(.routeUnavailable)
    switch result {
    case .begun(let id):
      reply(BrokerOpenAIGenerationXPCBeginReply.begun(id).encode())
    case .failure(let code):
      reply(BrokerOpenAIGenerationXPCBeginReply.failure(code).encode())
    }
  }

  func pollOpenAIGeneration(
    _ operation: Data,
    reply: @escaping @Sendable (Data) -> Void
  ) {
    guard let gateway = openAIGenerationGateway,
      let decoded = try? BrokerOpenAIGenerationXPCOperation.decode(operation)
    else {
      reply((try? BrokerOpenAIGenerationXPCPollReply.failure(.invalidRequest).encode()) ?? Data())
      return
    }
    let result: BrokerOpenAIGenerationXPCPollReply =
      switch gateway.poll(decoded.operationID) {
      case .idle: .idle
      case .event(let body): .event(body)
      case .failure(let code): .failure(code)
      }
    reply((try? result.encode()) ?? Data())
  }

  func cancelOpenAIGeneration(
    _ operation: Data,
    reply: @escaping @Sendable (Data) -> Void
  ) {
    guard let gateway = openAIGenerationGateway,
      let decoded = try? BrokerOpenAIGenerationXPCOperation.decode(operation)
    else {
      reply(Data())
      return
    }
    gateway.cancel(decoded.operationID)
    reply(BrokerOpenAIGenerationXPCCancelReply.accepted)
  }

  func close() {
    credentialGateway?.close()
    openAIOnboardingGateway?.close()
    openAIGenerationGateway?.close()
  }

  func transportTeardown() {
    credentialGateway?.transportTeardown()
    openAIOnboardingGateway?.transportTeardown()
    openAIGenerationGateway?.close()
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

  private static func unavailableOpenAIBegin(
    _ data: Data,
    secretByteCount: Int
  ) -> Data {
    do {
      let request = try BrokerOpenAIOnboardingRequest.decode(data)
      guard
        case .begin = request,
        (1...brokerCredentialMaximumSecretBytes).contains(secretByteCount)
      else {
        return openAIFailure(requestID: request.requestID, code: .invalidRequest)
      }
      return openAIFailure(requestID: request.requestID, code: .operationUnavailable)
    } catch let error as BrokerOpenAIOnboardingCodecError {
      return openAIFailure(
        requestID: error.requestID ?? brokerOpenAIOnboardingMalformedRequestID,
        code: .invalidRequest
      )
    } catch {
      return openAIFailure(
        requestID: brokerOpenAIOnboardingMalformedRequestID,
        code: .invalidRequest
      )
    }
  }

  private static func unavailableOpenAIControl(_ data: Data) -> Data {
    do {
      let request = try BrokerOpenAIOnboardingRequest.decode(data)
      guard case .begin = request else {
        return openAIFailure(requestID: request.requestID, code: .operationUnavailable)
      }
      return openAIFailure(requestID: request.requestID, code: .invalidRequest)
    } catch let error as BrokerOpenAIOnboardingCodecError {
      return openAIFailure(
        requestID: error.requestID ?? brokerOpenAIOnboardingMalformedRequestID,
        code: .invalidRequest
      )
    } catch {
      return openAIFailure(
        requestID: brokerOpenAIOnboardingMalformedRequestID,
        code: .invalidRequest
      )
    }
  }

  private static func unavailableOpenAIReconciliation(_ data: Data) -> Data {
    do {
      let request = try BrokerOpenAIActivationReconciliationRequest.decode(data)
      return openAIReconciliationFailure(
        requestID: request.requestID,
        code: .operationUnavailable
      )
    } catch let error as BrokerOpenAIOnboardingCodecError {
      return openAIReconciliationFailure(
        requestID: error.requestID ?? brokerOpenAIOnboardingMalformedRequestID,
        code: .invalidRequest
      )
    } catch {
      return openAIReconciliationFailure(
        requestID: brokerOpenAIOnboardingMalformedRequestID,
        code: .invalidRequest
      )
    }
  }

  private static func openAIFailure(
    requestID: UInt64,
    code: BrokerOpenAIOnboardingFailureCode
  ) -> Data {
    (try? BrokerOpenAIOnboardingReply.failure(requestID: requestID, code).encode()) ?? Data()
  }

  private static func openAIReconciliationFailure(
    requestID: UInt64,
    code: BrokerOpenAIOnboardingFailureCode
  ) -> Data {
    (try? BrokerOpenAIActivationReconciliationReply.failure(
      requestID: requestID,
      code
    ).encode()) ?? Data()
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
