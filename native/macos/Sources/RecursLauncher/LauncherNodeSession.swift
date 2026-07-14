import Foundation
import RecursBrokerXPC
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
    case openAIOnboarding(UInt32, OpenAIOnboardingRequestMessage)
    case openAIGeneration(UInt32)

    var requestID: UInt32 {
      switch self {
      case .hello(let requestID), .health(let requestID):
        requestID
      case .openAIOnboarding(let requestID, _):
        requestID
      case .openAIGeneration(let requestID):
        requestID
      }
    }
  }

  private enum OpenAIOnboardingState: Sendable, Equatable {
    case fresh
    case awaitingVerification
    case catalog(nextCursor: UInt16?)
    case terminal
  }

  private enum OpenAIOnboardingCompletion: Sendable {
    case success(Data, nextState: OpenAIOnboardingState)
    case rejected(OpenAIOnboardingFailureCode)
    case failure(OpenAIOnboardingFailureCode)
  }

  private static let maximumHealthWorkCount = 64

  private let brokerConnectionFactory:
    @Sendable () throws(BrokerConnectionError) -> BrokerConnection
  private let outputGate: LauncherNodeSessionOutputGate
  private let openAISecretCapture: LauncherOpenAISecretCapture?

  private var phase = Phase.awaitingHello
  private var decoder = NativeFrameDecoder()
  private var greatestSeenRequestID: UInt32?
  private var brokerConnection: BrokerConnection?
  private var activeRequest: ActiveRequest?
  private var activeTask: Task<Void, Never>?
  private var concurrentRejectionRequestID: UInt32?
  private var concurrentRejectionTask: Task<Void, Never>?
  private var queuedHealthRequestIDs: [UInt32] = []
  private var openAIOnboardingState = OpenAIOnboardingState.fresh
  private var cleanupStarted = false
  private var cleanupTask: Task<Void, Never>?

  package init(
    brokerConnectionFactory:
      @escaping @Sendable () throws(BrokerConnectionError) -> BrokerConnection,
    output: any LauncherNodeSessionOutput,
    openAISecretCapture: LauncherOpenAISecretCapture? = nil
  ) {
    self.brokerConnectionFactory = brokerConnectionFactory
    outputGate = LauncherNodeSessionOutputGate(output: output)
    self.openAISecretCapture = openAISecretCapture
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

  package func close() async {
    failClosed()
    await cleanupTask?.value
  }

  package func isAwaitingFrameCompletion() -> Bool {
    guard phase != .closed else {
      return false
    }
    return decoder.isAwaitingFrameCompletion
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
      guard
        openAIOnboardingState == .fresh,
        !isOpenAIOnboardingActive
      else {
        throw NativeProtocolError.invalidMessage
      }
      _ = try HealthMessage.decode(frame)
      try enqueueHealth(requestID: frame.requestID)
      startNextHealthIfNeeded()
    case .openAIOnboardingRequest:
      try startOpenAIOnboarding(
        try OpenAIOnboardingRequestMessage.decode(frame),
        requestID: frame.requestID
      )
    case .openAIGenerationRequest:
      try startOpenAIGeneration(
        try OpenAIGenerationRequestMessage.decode(frame),
        requestID: frame.requestID
      )
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

  private var isOpenAIOnboardingActive: Bool {
    if case .openAIOnboarding = activeRequest {
      return true
    }
    return false
  }

  private func cancel(_ message: CancelMessage) throws {
    if activeRequest?.requestID == message.targetRequestID {
      if case .openAIGeneration = activeRequest {
        activeTask?.cancel()
        return
      }
      failClosed()
      return
    }
    if let index = queuedHealthRequestIDs.firstIndex(of: message.targetRequestID) {
      queuedHealthRequestIDs.remove(at: index)
      return
    }
    throw NativeProtocolError.invalidMessage
  }

  private func startOpenAIGeneration(
    _ request: OpenAIGenerationRequestMessage,
    requestID: UInt32
  ) throws {
    guard openAIOnboardingState == .fresh else {
      throw NativeProtocolError.invalidMessage
    }
    guard activeRequest == nil, activeTask == nil, queuedHealthRequestIDs.isEmpty,
      let connection = brokerConnection
    else {
      try writeOpenAIGenerationRejection(.routeUnavailable, requestID: requestID)
      return
    }
    activeRequest = .openAIGeneration(requestID)
    let operation = LauncherOpenAIGenerationOperation()
    activeTask = Task { [weak self, connection, outputGate, operation] in
      do {
        let operationID = try await connection.beginOpenAIGeneration(request.body)
        operation.set(operationID)
        while !Task.isCancelled {
          switch try await connection.pollOpenAIGeneration(operationID) {
          case .idle:
            try await Task.sleep(for: .milliseconds(20))
          case .event(let body, let terminal):
            try await outputGate.write(
              OpenAIGenerationEventMessage(body: body).encodedFrame(requestID: requestID)
            )
            if terminal {
              await self?.openAIGenerationCompleted(requestID: requestID)
              return
            }
          }
        }
        throw CancellationError()
      } catch let failure as BrokerOpenAIGenerationClientError {
        if Task.isCancelled, let operationID = operation.value {
          await Task.detached {
            try? await connection.cancelOpenAIGeneration(operationID)
          }.value
        }
        await self?.openAIGenerationFailed(
          Self.mapOpenAIGenerationFailure(failure),
          requestID: requestID
        )
      } catch {
        if let operationID = operation.value {
          await Task.detached {
            try? await connection.cancelOpenAIGeneration(operationID)
          }.value
        }
        await self?.openAIGenerationFailed(
          Task.isCancelled ? .cancelled : .routeUnavailable,
          requestID: requestID
        )
      }
    }
  }

  private func writeOpenAIGenerationRejection(
    _ code: OpenAIGenerationFailureCode,
    requestID: UInt32
  ) throws {
    guard concurrentRejectionTask == nil else { throw NativeProtocolError.invalidMessage }
    concurrentRejectionRequestID = requestID
    concurrentRejectionTask = Task { [weak self, outputGate] in
      let succeeded =
        (try? await outputGate.write(
          OpenAIGenerationFailureMessage(code: code).encodedFrame(requestID: requestID)
        )) != nil
      await self?.concurrentOpenAIOnboardingRejectionCompleted(
        succeeded: succeeded,
        requestID: requestID
      )
    }
  }

  private func openAIGenerationCompleted(requestID: UInt32) {
    guard phase == .ready, activeRequest == .openAIGeneration(requestID) else { return }
    activeRequest = nil
    activeTask = nil
    startNextHealthIfNeeded()
  }

  private func openAIGenerationFailed(
    _ code: OpenAIGenerationFailureCode,
    requestID: UInt32
  ) async {
    guard phase == .ready, activeRequest == .openAIGeneration(requestID) else { return }
    do {
      try await outputGate.write(
        OpenAIGenerationFailureMessage(code: code).encodedFrame(requestID: requestID)
      )
      activeRequest = nil
      activeTask = nil
      startNextHealthIfNeeded()
    } catch {
      failClosed()
    }
  }

  private func startOpenAIOnboarding(
    _ request: OpenAIOnboardingRequestMessage,
    requestID: UInt32
  ) throws {
    guard activeRequest == nil, activeTask == nil, queuedHealthRequestIDs.isEmpty else {
      try startConcurrentOpenAIOnboardingRejection(
        .busy,
        requestID: requestID
      )
      return
    }
    guard let connection = brokerConnection else {
      throw NativeProtocolError.invalidMessage
    }

    let preflightFailure: OpenAIOnboardingFailureCode? =
      switch request {
      case .begin:
        if openAIOnboardingState != .fresh || openAISecretCapture == nil {
          .operationUnavailable
        } else {
          nil
        }
      case .verify:
        switch openAIOnboardingState {
        case .fresh: .sessionNotReady
        case .awaitingVerification: nil
        case .catalog, .terminal: .operationUnavailable
        }
      case .catalogPage(let cursor):
        switch openAIOnboardingState {
        case .fresh: .sessionNotReady
        case .catalog(nextCursor: .some(let expected)) where cursor == expected: nil
        case .awaitingVerification: .sessionNotReady
        case .catalog: .invalidRequest
        case .terminal: .operationUnavailable
        }
      case .finalize:
        switch openAIOnboardingState {
        case .fresh: .sessionNotReady
        case .awaitingVerification: .sessionNotReady
        case .catalog: nil
        case .terminal: .operationUnavailable
        }
      case .abort:
        switch openAIOnboardingState {
        case .fresh: .sessionNotReady
        case .awaitingVerification, .catalog: nil
        case .terminal: .operationUnavailable
        }
      case .reconcile:
        openAIOnboardingState == .fresh ? nil : .operationUnavailable
      }

    activeRequest = .openAIOnboarding(requestID, request)
    let capture = openAISecretCapture
    activeTask = Task { [weak self, connection, capture] in
      guard !Task.isCancelled else { return }
      let completion: OpenAIOnboardingCompletion
      if let preflightFailure {
        completion = .rejected(preflightFailure)
      } else {
        completion = await Self.performOpenAIOnboarding(
          request,
          requestID: requestID,
          connection: connection,
          capture: capture
        )
      }
      await self?.openAIOnboardingCompleted(
        completion,
        request: request,
        requestID: requestID
      )
    }
  }

  private func startConcurrentOpenAIOnboardingRejection(
    _ code: OpenAIOnboardingFailureCode,
    requestID: UInt32
  ) throws {
    guard phase == .ready, concurrentRejectionTask == nil else {
      throw NativeProtocolError.invalidMessage
    }
    concurrentRejectionRequestID = requestID
    concurrentRejectionTask = Task { [weak self, outputGate] in
      let succeeded: Bool
      do {
        try await outputGate.write(
          OpenAIOnboardingFailureMessage(code: code)
            .encodedFrame(requestID: requestID)
        )
        succeeded = true
      } catch {
        succeeded = false
      }
      await self?.concurrentOpenAIOnboardingRejectionCompleted(
        succeeded: succeeded,
        requestID: requestID
      )
    }
  }

  private func concurrentOpenAIOnboardingRejectionCompleted(
    succeeded: Bool,
    requestID: UInt32
  ) {
    guard
      phase == .ready,
      concurrentRejectionRequestID == requestID
    else {
      return
    }
    concurrentRejectionRequestID = nil
    concurrentRejectionTask = nil
    if !succeeded { failClosed() }
  }

  private nonisolated static func performOpenAIOnboarding(
    _ request: OpenAIOnboardingRequestMessage,
    requestID: UInt32,
    connection: BrokerConnection,
    capture: LauncherOpenAISecretCapture?
  ) async -> OpenAIOnboardingCompletion {
    do {
      switch request {
      case .begin:
        guard let capture else { return .failure(.authorityUnavailable) }
        let secret = try await capture.capture()
        if Task.isCancelled {
          secret.erase()
          return .failure(.cancelled)
        }
        let begun = try await connection.beginOpenAIOnboarding(secret: secret)
        let encoded = try OpenAIOnboardingBegunMessage(
          connectionID: begun.connectionID,
          credentialIdentityFingerprint: begun.credentialIdentityFingerprint
        ).encodedFrame(requestID: requestID)
        return .success(encoded, nextState: .awaitingVerification)

      case .verify:
        return try await encodeOpenAIOnboardingControl(
          connection.controlOpenAIOnboarding(.verify),
          requestID: requestID
        )

      case .catalogPage(let cursor):
        return try await encodeOpenAIOnboardingControl(
          connection.controlOpenAIOnboarding(.catalogPage(cursor: cursor)),
          requestID: requestID
        )

      case .finalize(let exactModelID):
        return try await encodeOpenAIOnboardingControl(
          connection.controlOpenAIOnboarding(.finalize(exactModelID: exactModelID)),
          requestID: requestID
        )

      case .abort:
        return try await encodeOpenAIOnboardingControl(
          connection.controlOpenAIOnboarding(.abort),
          requestID: requestID
        )

      case .reconcile(let connectionID, _):
        let status = try await connection.reconcileOpenAIActivation(
          connectionID: connectionID
        )
        let encoded = try OpenAIOnboardingReconciliationMessage(
          status: mapReconciliationStatus(status)
        ).encodedFrame(requestID: requestID)
        return .success(encoded, nextState: .fresh)
      }
    } catch let failure as TTYSecretCaptureError {
      return .failure(mapTTYFailure(failure))
    } catch let failure as BrokerOpenAIOnboardingClientError {
      if Task.isCancelled { return .failure(.cancelled) }
      return .failure(mapOpenAIClientFailure(failure))
    } catch {
      return .failure(Task.isCancelled ? .cancelled : .authorityUnavailable)
    }
  }

  private nonisolated static func encodeOpenAIOnboardingControl(
    _ result: BrokerOpenAIOnboardingControlResult,
    requestID: UInt32
  ) throws -> OpenAIOnboardingCompletion {
    switch result {
    case .catalogPage(let page):
      let encoded = try OpenAIOnboardingCatalogPageMessage(
        cursor: page.cursor,
        totalModelCount: page.totalModelCount,
        nextCursor: page.nextCursor,
        catalogRequestID: page.catalogRequestID,
        modelIDs: page.modelIDs
      ).encodedFrame(requestID: requestID)
      return .success(encoded, nextState: .catalog(nextCursor: page.nextCursor))
    case .committed(let receipt):
      let encoded = try OpenAIOnboardingCommittedMessage(
        connectionID: receipt.connectionID,
        selectedModelID: receipt.selectedModelID,
        verifiedModelCount: receipt.verifiedModelCount,
        catalogRequestID: receipt.catalogRequestID
      ).encodedFrame(requestID: requestID)
      return .success(encoded, nextState: .terminal)
    case .aborted:
      let encoded = try OpenAIOnboardingAbortedMessage()
        .encodedFrame(requestID: requestID)
      return .success(encoded, nextState: .terminal)
    }
  }

  private func openAIOnboardingCompleted(
    _ completion: OpenAIOnboardingCompletion,
    request: OpenAIOnboardingRequestMessage,
    requestID: UInt32
  ) async {
    guard
      phase == .ready,
      activeRequest == .openAIOnboarding(requestID, request)
    else {
      return
    }

    if let concurrentRejectionTask {
      await concurrentRejectionTask.value
      guard
        phase == .ready,
        activeRequest == .openAIOnboarding(requestID, request)
      else {
        return
      }
    }

    switch completion {
    case .success(let frame, let nextState):
      activeRequest = nil
      activeTask = nil
      openAIOnboardingState = nextState
      if case .reconcile = request {
        startNextHealthIfNeeded()
      }
      do {
        try await outputGate.write(frame)
      } catch {
        failClosed()
      }

    case .rejected(let code):
      let frame: Data
      do {
        frame = try OpenAIOnboardingFailureMessage(code: code)
          .encodedFrame(requestID: requestID)
      } catch {
        failClosed()
        return
      }
      activeRequest = nil
      activeTask = nil
      startNextHealthIfNeeded()
      do {
        try await outputGate.write(frame)
      } catch {
        failClosed()
      }

    case .failure(let code):
      await finishWithOpenAIOnboardingFailure(code, requestID: requestID)
    }
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
      let frame: Data
      do {
        frame = try helloResult.encodedFrame(requestID: requestID)
      } catch {
        failClosed()
        return
      }
      activeRequest = nil
      activeTask = nil
      phase = .ready
      startNextHealthIfNeeded()
      do {
        try await outputGate.write(frame)
      } catch {
        failClosed()
      }

    case .failure(let failure):
      await finishWithBrokerFailure(failure, requestID: requestID)
    }
  }

  private func startNextHealthIfNeeded() {
    guard
      phase == .ready,
      openAIOnboardingState == .fresh,
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

    if let concurrentRejectionTask {
      await concurrentRejectionTask.value
      guard phase == .ready, activeRequest == .health(requestID) else {
        return
      }
    }

    switch result {
    case .success(let healthResult):
      let frame: Data
      do {
        frame = try healthResult.encodedFrame(requestID: requestID)
      } catch {
        failClosed()
        return
      }
      activeRequest = nil
      activeTask = nil
      startNextHealthIfNeeded()
      do {
        try await outputGate.write(frame)
      } catch {
        failClosed()
      }

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
    let capture = openAISecretCapture
    let concurrentRejection = concurrentRejectionTask
    concurrentRejectionRequestID = nil
    concurrentRejectionTask = nil
    concurrentRejection?.cancel()
    let code = mapFailure(failure)
    let cleanup = Task { [outputGate] in
      do {
        try await outputGate.write(code.encodedFrame(requestID: requestID))
      } catch {
        // The output is already terminal; never serialize native error details.
      }
      await capture?.cancelAndWait()
      await connection?.close()
      await outputGate.close()
      await concurrentRejection?.value
    }
    cleanupTask = cleanup
    await cleanup.value
  }

  private func finishWithOpenAIOnboardingFailure(
    _ code: OpenAIOnboardingFailureCode,
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
    let capture = openAISecretCapture
    let concurrentRejection = concurrentRejectionTask
    concurrentRejectionRequestID = nil
    concurrentRejectionTask = nil
    concurrentRejection?.cancel()
    let cleanup = Task { [outputGate] in
      do {
        try await outputGate.write(
          OpenAIOnboardingFailureMessage(code: code)
            .encodedFrame(requestID: requestID)
        )
      } catch {
        // The output is already terminal; never serialize native error details.
      }
      await capture?.cancelAndWait()
      await connection?.close()
      await outputGate.close()
      await concurrentRejection?.value
    }
    cleanupTask = cleanup
    await cleanup.value
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
    let capture = openAISecretCapture
    let concurrentRejection = concurrentRejectionTask
    concurrentRejectionRequestID = nil
    concurrentRejectionTask = nil
    task?.cancel()
    concurrentRejection?.cancel()

    cleanupTask = Task { [outputGate] in
      await capture?.cancelAndWait()
      await connection?.close()
      await outputGate.close()
      await concurrentRejection?.value
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

  private nonisolated static func mapTTYFailure(
    _ failure: TTYSecretCaptureError
  ) -> OpenAIOnboardingFailureCode {
    switch failure {
    case .userPresenceRequired, .automationDenied, .invalidTerminalMode:
      .operationUnavailable
    case .alreadyUsed:
      .busy
    case .cancelled:
      .cancelled
    case .emptySecret, .invalidSecret, .secretTooLong:
      .invalidRequest
    case .terminalRestoreFailure:
      .cleanupFailed
    case .terminalUnavailable, .inputOutputFailure:
      .authorityUnavailable
    }
  }

  private nonisolated static func mapOpenAIClientFailure(
    _ failure: BrokerOpenAIOnboardingClientError
  ) -> OpenAIOnboardingFailureCode {
    switch failure {
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
    case .authorityUnavailable, .brokerUnavailable, .protocolMismatch, .closed:
      .authorityUnavailable
    case .operationUnavailable: .operationUnavailable
    }
  }

  private nonisolated static func mapReconciliationStatus(
    _ status: BrokerOpenAIActivationReconciliationStatus
  ) -> OpenAIOnboardingReconciliationStatusCode {
    switch status {
    case .readyOpenAI: .readyOpenAI
    case .absent: .absent
    case .unresolved: .unresolved
    }
  }

  private nonisolated static func mapOpenAIGenerationFailure(
    _ failure: BrokerOpenAIGenerationClientError
  ) -> OpenAIGenerationFailureCode {
    switch failure {
    case .rejected(let code): code
    case .cancelled: .cancelled
    case .brokerUnavailable, .protocolMismatch, .closed, .busy: .routeUnavailable
    }
  }
}

private final class LauncherOpenAIGenerationOperation: @unchecked Sendable {
  private let lock = NSLock()
  private var storage: UUID?

  var value: UUID? { lock.withLock { storage } }

  func set(_ value: UUID) {
    lock.withLock { storage = value }
  }
}

private enum LauncherNodeSessionOutputGateError: Error {
  case closed
}

private actor LauncherNodeSessionOutputGate {
  private final class WriteToken: @unchecked Sendable {}

  private let output: any LauncherNodeSessionOutput
  private var writerOwned = false
  private var closing = false
  private var admissionWaiters: [CheckedContinuation<Bool, Never>] = []
  private var activeWrite: (token: WriteToken, task: Task<Void, Error>)?

  init(output: any LauncherNodeSessionOutput) {
    self.output = output
  }

  func write(_ frame: Data) async throws {
    guard await acquire() else {
      throw LauncherNodeSessionOutputGateError.closed
    }
    guard !closing else {
      releaseUnstartedAdmission()
      throw LauncherNodeSessionOutputGateError.closed
    }
    guard !Task.isCancelled else {
      releaseUnstartedAdmission()
      throw CancellationError()
    }

    let token = WriteToken()
    let task = Task { [output] in
      guard !Task.isCancelled else { throw CancellationError() }
      try await output.write(frame)
    }
    activeWrite = (token, task)
    defer { release(token: token) }
    try await withTaskCancellationHandler {
      try await task.value
    } onCancel: {
      task.cancel()
    }
  }

  func close() async {
    if !closing {
      closing = true
      let waiters = admissionWaiters
      admissionWaiters.removeAll(keepingCapacity: false)
      for waiter in waiters { waiter.resume(returning: false) }
    }
    let task = activeWrite?.task
    task?.cancel()
    await output.close()
    _ = try? await task?.value
  }

  private func acquire() async -> Bool {
    guard !closing else { return false }
    guard writerOwned else {
      writerOwned = true
      return true
    }
    return await withCheckedContinuation { continuation in
      admissionWaiters.append(continuation)
    }
  }

  private func release(token: WriteToken) {
    guard activeWrite?.token === token else { return }
    activeWrite = nil
    releaseUnstartedAdmission()
  }

  private func releaseUnstartedAdmission() {
    if !closing, !admissionWaiters.isEmpty {
      admissionWaiters.removeFirst().resume(returning: true)
      return
    }
    writerOwned = false
  }
}
