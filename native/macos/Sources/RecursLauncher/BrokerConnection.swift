import Foundation
import RecursBrokerXPC
import RecursNativeProtocol
import RecursNativeSecurity

package enum BrokerOpenAIOnboardingProvider: Sendable {
  case openAI
  case anthropic
  case kimiCode
}

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

package enum BrokerOpenAIGenerationClientError: Error, Equatable, Sendable {
  case rejected(OpenAIGenerationFailureCode)
  case brokerUnavailable
  case protocolMismatch
  case cancelled
  case closed
  case busy
}

package enum BrokerOpenAIGenerationClientPoll: Sendable, Equatable {
  case idle
  case event(Data, terminal: Bool)
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
  func beginOpenAIOnboarding(
    _ request: Data,
    secret: Data,
    reply: @escaping @Sendable (Result<Data, BrokerXPCExchangeError>) -> Void
  )
  func openAIOnboardingControl(
    _ request: Data,
    reply: @escaping @Sendable (Result<Data, BrokerXPCExchangeError>) -> Void
  )
  func reconcileOpenAIActivation(
    _ request: Data,
    reply: @escaping @Sendable (Result<Data, BrokerXPCExchangeError>) -> Void
  )
  func beginOpenAIGeneration(
    _ request: Data,
    reply: @escaping @Sendable (Result<Data, BrokerXPCExchangeError>) -> Void
  )
  func pollOpenAIGeneration(
    _ operation: Data,
    reply: @escaping @Sendable (Result<Data, BrokerXPCExchangeError>) -> Void
  )
  func cancelOpenAIGeneration(
    _ operation: Data,
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

  func beginOpenAIOnboarding(
    _: Data,
    secret _: Data,
    reply: @escaping @Sendable (Result<Data, BrokerXPCExchangeError>) -> Void
  ) {
    reply(.failure(.brokerUnavailable))
  }

  func openAIOnboardingControl(
    _: Data,
    reply: @escaping @Sendable (Result<Data, BrokerXPCExchangeError>) -> Void
  ) {
    reply(.failure(.brokerUnavailable))
  }

  func reconcileOpenAIActivation(
    _: Data,
    reply: @escaping @Sendable (Result<Data, BrokerXPCExchangeError>) -> Void
  ) {
    reply(.failure(.brokerUnavailable))
  }

  func beginOpenAIGeneration(
    _: Data,
    reply: @escaping @Sendable (Result<Data, BrokerXPCExchangeError>) -> Void
  ) { reply(.failure(.brokerUnavailable)) }

  func pollOpenAIGeneration(
    _: Data,
    reply: @escaping @Sendable (Result<Data, BrokerXPCExchangeError>) -> Void
  ) { reply(.failure(.brokerUnavailable)) }

  func cancelOpenAIGeneration(
    _: Data,
    reply: @escaping @Sendable (Result<Data, BrokerXPCExchangeError>) -> Void
  ) { reply(.failure(.brokerUnavailable)) }
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
    case beginningOpenAIOnboarding
    case reconcilingOpenAIActivation
    case openAIOnboardingReady
    case controllingOpenAIOnboarding
    case openAIOnboardingTerminal
    case runningOpenAIGeneration
    case closed
  }

  private let connection: any BrokerXPCConnectionHandling
  private let xpcReplyTimeout: Duration
  private var phase = Phase.open
  private var nextRequestID: UInt32? = 1
  private var nextLifecycleRequestID: UInt64?
  private var nextOnboardingRequestID: UInt64?
  private var activeLifecycleReply: TimedBrokerXPCReply?
  private var activeOnboardingReply: TimedBrokerXPCReply?
  private var activeGenerationReply: TimedBrokerXPCReply?

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
      initialOnboardingRequestID: 1,
      xpcReplyTimeout: .seconds(5)
    )
  }

  init(
    validatedPeerRequirement requirement: PeerRequirement,
    connectionFactory: any BrokerXPCConnectionFactory,
    initialLifecycleRequestID: UInt64,
    initialOnboardingRequestID: UInt64 = 1,
    xpcReplyTimeout: Duration
  ) {
    precondition(
      initialLifecycleRequestID > 0
        && initialLifecycleRequestID < brokerCredentialMalformedRequestID
    )
    precondition(
      initialOnboardingRequestID > 0
        && initialOnboardingRequestID < brokerOpenAIOnboardingMalformedRequestID
    )
    precondition(xpcReplyTimeout > .zero)
    let connection = connectionFactory.makeConnection()
    connection.installRemoteInterface()
    connection.setCodeSigningRequirement(requirement.requirementString)
    connection.activate()
    self.connection = connection
    self.xpcReplyTimeout = xpcReplyTimeout
    nextLifecycleRequestID = initialLifecycleRequestID
    nextOnboardingRequestID = initialOnboardingRequestID
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

  package func beginOpenAIOnboarding(
    secret: consuming TTYSecret,
    provider: BrokerOpenAIOnboardingProvider = .openAI
  ) async throws(BrokerOpenAIOnboardingClientError) -> BrokerOpenAIOnboardingBegun {
    defer { secret.erase() }
    let requestID = try beginOpenAIOnboardingOperation()
    var transientSecret = secret.withUnsafeBytes { Data($0) }
    defer { Self.erase(&transientSecret) }

    do {
      guard
        (1...brokerCredentialMaximumSecretBytes).contains(transientSecret.count)
      else {
        throw BrokerOpenAIOnboardingClientError.invalidRequest
      }
      let request: Data
      do {
        let operation: BrokerOpenAIOnboardingRequest =
          switch provider {
          case .openAI: .begin(requestID: requestID)
          case .anthropic: .beginAnthropic(requestID: requestID)
          case .kimiCode: .beginKimi(requestID: requestID)
          }
        request = try operation.encode()
      } catch {
        throw BrokerOpenAIOnboardingClientError.protocolMismatch
      }
      let response = try await onboardingExchange { [connection] reply in
        connection.beginOpenAIOnboarding(request, secret: transientSecret, reply: reply)
      }
      guard phase == .beginningOpenAIOnboarding else {
        throw BrokerOpenAIOnboardingClientError.closed
      }
      guard !Task.isCancelled else {
        throw BrokerOpenAIOnboardingClientError.cancelled
      }
      let begun = try Self.decodeOpenAIBeginReply(response, requestID: requestID)
      phase = .openAIOnboardingReady
      return begun
    } catch let failure as BrokerOpenAIOnboardingClientError {
      failClosed()
      throw failure
    } catch {
      failClosed()
      throw .brokerUnavailable
    }
  }

  package func reconcileOpenAIActivation(
    connectionID: UUID
  ) async throws(BrokerOpenAIOnboardingClientError) -> BrokerOpenAIActivationReconciliationStatus {
    let requestID = try beginOpenAIReconciliationOperation()

    do {
      let request: Data
      do {
        request = try BrokerOpenAIActivationReconciliationRequest.reconcile(
          requestID: requestID,
          connectionID: connectionID
        ).encode()
      } catch {
        throw BrokerOpenAIOnboardingClientError.invalidRequest
      }
      let response = try await onboardingExchange { [connection] reply in
        connection.reconcileOpenAIActivation(request, reply: reply)
      }
      guard phase == .reconcilingOpenAIActivation else {
        throw BrokerOpenAIOnboardingClientError.closed
      }
      guard !Task.isCancelled else {
        throw BrokerOpenAIOnboardingClientError.cancelled
      }
      let status = try Self.decodeOpenAIReconciliationReply(
        response,
        requestID: requestID
      )
      phase = .ready
      return status
    } catch let failure as BrokerOpenAIOnboardingClientError {
      failClosed()
      throw failure
    } catch {
      failClosed()
      throw .brokerUnavailable
    }
  }

  package func controlOpenAIOnboarding(
    _ operation: BrokerOpenAIOnboardingControl
  ) async throws(BrokerOpenAIOnboardingClientError) -> BrokerOpenAIOnboardingControlResult {
    let requestID = try beginOpenAIOnboardingControlOperation()

    do {
      let request: Data
      do {
        request = try operation.request(requestID: requestID).encode()
      } catch {
        throw BrokerOpenAIOnboardingClientError.invalidRequest
      }
      let response = try await onboardingExchange { [connection] reply in
        connection.openAIOnboardingControl(request, reply: reply)
      }
      guard phase == .controllingOpenAIOnboarding else {
        throw BrokerOpenAIOnboardingClientError.closed
      }
      guard !Task.isCancelled else {
        throw BrokerOpenAIOnboardingClientError.cancelled
      }
      let result = try Self.decodeOpenAIControlReply(
        response,
        requestID: requestID,
        expected: operation.expectedReply
      )
      phase = operation.isTerminal ? .openAIOnboardingTerminal : .openAIOnboardingReady
      return result
    } catch let failure as BrokerOpenAIOnboardingClientError {
      failClosed()
      throw failure
    } catch {
      failClosed()
      throw .brokerUnavailable
    }
  }

  package func beginOpenAIGeneration(
    _ body: Data
  ) async throws(BrokerOpenAIGenerationClientError) -> UUID {
    guard phase == .ready else {
      throw phase == .closed ? .closed : .busy
    }
    phase = .runningOpenAIGeneration
    do {
      let response = try await generationExchange { [connection] reply in
        connection.beginOpenAIGeneration(body, reply: reply)
      }
      switch try BrokerOpenAIGenerationXPCBeginReply.decode(response) {
      case .begun(let id): return id
      case .failure(let code):
        phase = .ready
        throw BrokerOpenAIGenerationClientError.rejected(code)
      }
    } catch let failure as BrokerOpenAIGenerationClientError {
      if case .rejected = failure { throw failure }
      failClosed()
      throw failure
    } catch {
      failClosed()
      throw .protocolMismatch
    }
  }

  package func pollOpenAIGeneration(
    _ operationID: UUID
  ) async throws(BrokerOpenAIGenerationClientError) -> BrokerOpenAIGenerationClientPoll {
    guard phase == .runningOpenAIGeneration else {
      throw phase == .closed ? .closed : .protocolMismatch
    }
    do {
      let operation = BrokerOpenAIGenerationXPCOperation(operationID: operationID).encode()
      let response = try await generationExchange { [connection] reply in
        connection.pollOpenAIGeneration(operation, reply: reply)
      }
      switch try BrokerOpenAIGenerationXPCPollReply.decode(response) {
      case .idle: return .idle
      case .event(let body):
        let terminal = Self.isTerminalOpenAIGenerationEvent(body)
        if terminal { phase = .ready }
        return .event(body, terminal: terminal)
      case .failure(let code):
        phase = .ready
        throw BrokerOpenAIGenerationClientError.rejected(code)
      }
    } catch let failure as BrokerOpenAIGenerationClientError {
      if case .rejected = failure { throw failure }
      if failure == .cancelled { throw failure }
      failClosed()
      throw failure
    } catch {
      failClosed()
      throw .protocolMismatch
    }
  }

  package func cancelOpenAIGeneration(
    _ operationID: UUID
  ) async throws(BrokerOpenAIGenerationClientError) {
    guard phase == .runningOpenAIGeneration else { return }
    do {
      let operation = BrokerOpenAIGenerationXPCOperation(operationID: operationID).encode()
      let response = try await generationExchange { [connection] reply in
        connection.cancelOpenAIGeneration(operation, reply: reply)
      }
      _ = try BrokerOpenAIGenerationXPCCancelReply.decode(response)
      let terminal = try await generationExchange { [connection] reply in
        connection.pollOpenAIGeneration(operation, reply: reply)
      }
      guard try BrokerOpenAIGenerationXPCPollReply.decode(terminal) == .failure(.cancelled)
      else { throw BrokerOpenAIGenerationClientError.protocolMismatch }
      phase = .ready
    } catch let failure as BrokerOpenAIGenerationClientError {
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
    case .checkingHealth, .stagingCredential, .controllingCredential,
      .beginningOpenAIOnboarding, .reconcilingOpenAIActivation,
      .openAIOnboardingReady,
      .controllingOpenAIOnboarding, .runningOpenAIGeneration:
      throw .busy
    case .openAIOnboardingTerminal:
      throw .operationUnavailable
    }
    guard let requestID = nextLifecycleRequestID else {
      failClosed()
      throw .protocolMismatch
    }
    nextLifecycleRequestID = requestID == UInt64.max - 1 ? nil : requestID + 1
    phase = operationPhase
    return requestID
  }

  private func beginOpenAIOnboardingOperation()
    throws(BrokerOpenAIOnboardingClientError) -> UInt64
  {
    switch phase {
    case .ready:
      break
    case .open, .handshaking:
      failClosed()
      throw .sessionNotReady
    case .closed:
      throw .closed
    case .checkingHealth, .stagingCredential, .controllingCredential,
      .beginningOpenAIOnboarding, .reconcilingOpenAIActivation,
      .controllingOpenAIOnboarding, .runningOpenAIGeneration:
      throw .busy
    case .openAIOnboardingReady, .openAIOnboardingTerminal:
      throw .operationUnavailable
    }
    guard let requestID = nextOnboardingRequestID else {
      failClosed()
      throw .protocolMismatch
    }
    nextOnboardingRequestID =
      requestID == brokerOpenAIOnboardingMalformedRequestID - 1 ? nil : requestID + 1
    phase = .beginningOpenAIOnboarding
    return requestID
  }

  private func beginOpenAIOnboardingControlOperation()
    throws(BrokerOpenAIOnboardingClientError) -> UInt64
  {
    switch phase {
    case .openAIOnboardingReady:
      break
    case .open, .handshaking, .ready:
      failClosed()
      throw .sessionNotReady
    case .closed:
      throw .closed
    case .checkingHealth, .stagingCredential, .controllingCredential,
      .beginningOpenAIOnboarding, .reconcilingOpenAIActivation,
      .controllingOpenAIOnboarding, .runningOpenAIGeneration:
      throw .busy
    case .openAIOnboardingTerminal:
      throw .operationUnavailable
    }
    guard let requestID = nextOnboardingRequestID else {
      failClosed()
      throw .protocolMismatch
    }
    nextOnboardingRequestID =
      requestID == brokerOpenAIOnboardingMalformedRequestID - 1 ? nil : requestID + 1
    phase = .controllingOpenAIOnboarding
    return requestID
  }

  private func beginOpenAIReconciliationOperation()
    throws(BrokerOpenAIOnboardingClientError) -> UInt64
  {
    switch phase {
    case .ready:
      break
    case .open, .handshaking:
      failClosed()
      throw .sessionNotReady
    case .closed:
      throw .closed
    case .checkingHealth, .stagingCredential, .controllingCredential,
      .beginningOpenAIOnboarding, .reconcilingOpenAIActivation,
      .controllingOpenAIOnboarding, .runningOpenAIGeneration:
      throw .busy
    case .openAIOnboardingReady, .openAIOnboardingTerminal:
      throw .operationUnavailable
    }
    guard let requestID = nextOnboardingRequestID else {
      failClosed()
      throw .protocolMismatch
    }
    nextOnboardingRequestID =
      requestID == brokerOpenAIOnboardingMalformedRequestID - 1 ? nil : requestID + 1
    phase = .reconcilingOpenAIActivation
    return requestID
  }

  private func failClosed() {
    guard phase != .closed else {
      return
    }
    phase = .closed
    nextRequestID = nil
    nextLifecycleRequestID = nil
    nextOnboardingRequestID = nil
    let lifecycleReply = activeLifecycleReply
    activeLifecycleReply = nil
    let onboardingReply = activeOnboardingReply
    activeOnboardingReply = nil
    let generationReply = activeGenerationReply
    activeGenerationReply = nil
    lifecycleReply?.cancel()
    onboardingReply?.cancel()
    generationReply?.cancel()
    connection.invalidate()
  }

  private func exchange(_ frame: Data) async throws -> Data {
    let reply = TimedBrokerXPCReply(timeout: xpcReplyTimeout)
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        guard reply.install(continuation) else { return }
        reply.armTimeout()
        guard !Task.isCancelled else {
          reply.cancel()
          return
        }
        connection.exchange(frame) { result in
          reply.resolve(result)
        }
      }
    } onCancel: {
      reply.cancel()
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

  private func onboardingExchange(
    _ start: (@escaping @Sendable (Result<Data, BrokerXPCExchangeError>) -> Void) -> Void
  ) async throws(BrokerOpenAIOnboardingClientError) -> Data {
    let reply = TimedBrokerXPCReply(timeout: xpcReplyTimeout)
    activeOnboardingReply = reply
    defer {
      if activeOnboardingReply === reply {
        activeOnboardingReply = nil
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

  private func generationExchange(
    _ start: (@escaping @Sendable (Result<Data, BrokerXPCExchangeError>) -> Void) -> Void
  ) async throws(BrokerOpenAIGenerationClientError) -> Data {
    let reply = TimedBrokerXPCReply(timeout: xpcReplyTimeout)
    activeGenerationReply = reply
    defer { if activeGenerationReply === reply { activeGenerationReply = nil } }
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
      case .brokerUnavailable: throw .brokerUnavailable
      case .cancelled: throw .cancelled
      }
    } catch {
      throw .brokerUnavailable
    }
  }

  private static func decodeOpenAIBeginReply(
    _ data: Data,
    requestID: UInt64
  ) throws(BrokerOpenAIOnboardingClientError) -> BrokerOpenAIOnboardingBegun {
    let reply: BrokerOpenAIOnboardingReply
    do {
      reply = try BrokerOpenAIOnboardingReply.decode(data)
    } catch {
      throw .protocolMismatch
    }
    guard reply.requestID == requestID else { throw .protocolMismatch }
    switch reply {
    case .begun(
      _,
      let connectionID,
      let recoveryTokens,
      let credentialIdentityFingerprint
    ):
      return BrokerOpenAIOnboardingBegun(
        connectionID: connectionID,
        recoveryTokens: recoveryTokens,
        credentialIdentityFingerprint: credentialIdentityFingerprint
      )
    case .failure(_, let code):
      throw BrokerOpenAIOnboardingClientError(code)
    case .catalogPage, .committed, .aborted:
      throw .protocolMismatch
    }
  }

  private static func decodeOpenAIControlReply(
    _ data: Data,
    requestID: UInt64,
    expected: BrokerOpenAIOnboardingControl.ExpectedReply
  ) throws(BrokerOpenAIOnboardingClientError) -> BrokerOpenAIOnboardingControlResult {
    let reply: BrokerOpenAIOnboardingReply
    do {
      reply = try BrokerOpenAIOnboardingReply.decode(data)
    } catch {
      throw .protocolMismatch
    }
    guard reply.requestID == requestID else { throw .protocolMismatch }
    switch reply {
    case .catalogPage(_, let page):
      guard expected == .catalogPage else { throw .protocolMismatch }
      return .catalogPage(page)
    case .committed(_, let receipt):
      guard expected == .committed else { throw .protocolMismatch }
      return .committed(receipt)
    case .aborted:
      guard expected == .aborted else { throw .protocolMismatch }
      return .aborted
    case .failure(_, let code):
      throw BrokerOpenAIOnboardingClientError(code)
    case .begun:
      throw .protocolMismatch
    }
  }

  private static func decodeOpenAIReconciliationReply(
    _ data: Data,
    requestID: UInt64
  ) throws(BrokerOpenAIOnboardingClientError) -> BrokerOpenAIActivationReconciliationStatus {
    let reply: BrokerOpenAIActivationReconciliationReply
    do {
      reply = try BrokerOpenAIActivationReconciliationReply.decode(data)
    } catch {
      throw .protocolMismatch
    }
    guard reply.requestID == requestID else { throw .protocolMismatch }
    switch reply {
    case .status(_, let status):
      return status
    case .failure(_, let code):
      throw BrokerOpenAIOnboardingClientError(code)
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

  private static func isTerminalOpenAIGenerationEvent(_ body: Data) -> Bool {
    guard let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any]
    else { return false }
    return object["type"] as? String == "done"
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

func makeBrokerRemoteObjectInterface() -> NSXPCInterface {
  let interface = NSXPCInterface(with: BrokerOpenAIGenerationXPCProtocol.self)
  let dataClasses = NSSet(object: NSData.self) as! Set<AnyHashable>
  let registrations: [(Selector, Int, Bool)] = [
    (#selector(BrokerXPCProtocol.exchange(_:reply:)), 0, false),
    (#selector(BrokerXPCProtocol.exchange(_:reply:)), 0, true),
    (#selector(BrokerCredentialLifecycleXPCProtocol.stageCredential(_:secret:reply:)), 0, false),
    (#selector(BrokerCredentialLifecycleXPCProtocol.stageCredential(_:secret:reply:)), 1, false),
    (#selector(BrokerCredentialLifecycleXPCProtocol.stageCredential(_:secret:reply:)), 0, true),
    (#selector(BrokerCredentialLifecycleXPCProtocol.credentialControl(_:reply:)), 0, false),
    (#selector(BrokerCredentialLifecycleXPCProtocol.credentialControl(_:reply:)), 0, true),
    (#selector(BrokerOpenAIOnboardingXPCProtocol.beginOpenAIOnboarding(_:secret:reply:)), 0, false),
    (#selector(BrokerOpenAIOnboardingXPCProtocol.beginOpenAIOnboarding(_:secret:reply:)), 1, false),
    (#selector(BrokerOpenAIOnboardingXPCProtocol.beginOpenAIOnboarding(_:secret:reply:)), 0, true),
    (#selector(BrokerOpenAIOnboardingXPCProtocol.openAIOnboardingControl(_:reply:)), 0, false),
    (#selector(BrokerOpenAIOnboardingXPCProtocol.openAIOnboardingControl(_:reply:)), 0, true),
    (#selector(BrokerOpenAIOnboardingXPCProtocol.reconcileOpenAIActivation(_:reply:)), 0, false),
    (#selector(BrokerOpenAIOnboardingXPCProtocol.reconcileOpenAIActivation(_:reply:)), 0, true),
    (#selector(BrokerOpenAIGenerationXPCProtocol.beginOpenAIGeneration(_:reply:)), 0, false),
    (#selector(BrokerOpenAIGenerationXPCProtocol.beginOpenAIGeneration(_:reply:)), 0, true),
    (#selector(BrokerOpenAIGenerationXPCProtocol.pollOpenAIGeneration(_:reply:)), 0, false),
    (#selector(BrokerOpenAIGenerationXPCProtocol.pollOpenAIGeneration(_:reply:)), 0, true),
    (#selector(BrokerOpenAIGenerationXPCProtocol.cancelOpenAIGeneration(_:reply:)), 0, false),
    (#selector(BrokerOpenAIGenerationXPCProtocol.cancelOpenAIGeneration(_:reply:)), 0, true),
  ]
  for (selector, argumentIndex, ofReply) in registrations {
    interface.setClasses(
      dataClasses,
      for: selector,
      argumentIndex: argumentIndex,
      ofReply: ofReply
    )
  }
  return interface
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
    connection.remoteObjectInterface = makeBrokerRemoteObjectInterface()
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

  func beginOpenAIOnboarding(
    _ request: Data,
    secret: Data,
    reply: @escaping @Sendable (Result<Data, BrokerXPCExchangeError>) -> Void
  ) {
    let remoteObject = connection.remoteObjectProxyWithErrorHandler { _ in
      reply(.failure(.brokerUnavailable))
    }
    guard let proxy = remoteObject as? BrokerOpenAIOnboardingXPCProtocol else {
      reply(.failure(.brokerUnavailable))
      return
    }
    proxy.beginOpenAIOnboarding(request, secret: secret) { response in
      reply(.success(response))
    }
  }

  func openAIOnboardingControl(
    _ request: Data,
    reply: @escaping @Sendable (Result<Data, BrokerXPCExchangeError>) -> Void
  ) {
    let remoteObject = connection.remoteObjectProxyWithErrorHandler { _ in
      reply(.failure(.brokerUnavailable))
    }
    guard let proxy = remoteObject as? BrokerOpenAIOnboardingXPCProtocol else {
      reply(.failure(.brokerUnavailable))
      return
    }
    proxy.openAIOnboardingControl(request) { response in
      reply(.success(response))
    }
  }

  func reconcileOpenAIActivation(
    _ request: Data,
    reply: @escaping @Sendable (Result<Data, BrokerXPCExchangeError>) -> Void
  ) {
    let remoteObject = connection.remoteObjectProxyWithErrorHandler { _ in
      reply(.failure(.brokerUnavailable))
    }
    guard let proxy = remoteObject as? BrokerOpenAIOnboardingXPCProtocol else {
      reply(.failure(.brokerUnavailable))
      return
    }
    proxy.reconcileOpenAIActivation(request) { response in
      reply(.success(response))
    }
  }

  func beginOpenAIGeneration(
    _ request: Data,
    reply: @escaping @Sendable (Result<Data, BrokerXPCExchangeError>) -> Void
  ) {
    withGenerationProxy(reply) { proxy in
      proxy.beginOpenAIGeneration(request) { reply(.success($0)) }
    }
  }

  func pollOpenAIGeneration(
    _ operation: Data,
    reply: @escaping @Sendable (Result<Data, BrokerXPCExchangeError>) -> Void
  ) {
    withGenerationProxy(reply) { proxy in
      proxy.pollOpenAIGeneration(operation) { reply(.success($0)) }
    }
  }

  func cancelOpenAIGeneration(
    _ operation: Data,
    reply: @escaping @Sendable (Result<Data, BrokerXPCExchangeError>) -> Void
  ) {
    withGenerationProxy(reply) { proxy in
      proxy.cancelOpenAIGeneration(operation) { reply(.success($0)) }
    }
  }

  private func withGenerationProxy(
    _ reply: @escaping @Sendable (Result<Data, BrokerXPCExchangeError>) -> Void,
    body: (BrokerOpenAIGenerationXPCProtocol) -> Void
  ) {
    let remote = connection.remoteObjectProxyWithErrorHandler { _ in
      reply(.failure(.brokerUnavailable))
    }
    guard let proxy = remote as? BrokerOpenAIGenerationXPCProtocol else {
      reply(.failure(.brokerUnavailable))
      return
    }
    body(proxy)
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
