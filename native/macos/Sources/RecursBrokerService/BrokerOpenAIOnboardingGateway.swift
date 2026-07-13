import Foundation
import RecursBrokerCore
import RecursBrokerXPC

protocol BrokerOpenAIOnboardingSessionProtocol: Sendable {
  func verify() async throws(BrokerOpenAIOnboardingError) -> BrokerOpenAIModelCatalog

  func finalize(
    exactModelID: String,
    operationID: UUID
  ) async throws(BrokerOpenAIOnboardingError) -> BrokerOpenAIOnboardingReceipt

  func close() async throws(BrokerOpenAIOnboardingError)
}

extension BrokerOpenAIOnboardingSession: BrokerOpenAIOnboardingSessionProtocol {}

protocol BrokerOpenAIOnboardingSessionFactory: Sendable {
  func makeSession(
    context: BrokerOpenAIOnboardingStagingContext,
    abortOperationID: UUID
  ) throws(BrokerOpenAIOnboardingError) -> any BrokerOpenAIOnboardingSessionProtocol
}

final class BrokerOpenAIOnboardingGateway: @unchecked Sendable {
  private struct Entry {
    let task: Task<Void, Never>
    let gate: OnboardingReplyGate
  }

  private struct SessionBinding: Sendable {
    let session: any BrokerOpenAIOnboardingSessionProtocol
    let connectionID: UUID
    let recoveryTokens: BrokerOpenAIOnboardingRecoveryTokens
    var catalog: BrokerOpenAIModelCatalog?
    var nextCursor: UInt16?
    var isTerminal = false
  }

  private struct GeneratedIdentity: Sendable {
    let connectionID: UUID
    let stageOperationID: UUID
    let recoveryTokens: BrokerOpenAIOnboardingRecoveryTokens
  }

  private enum Admission {
    case accepted
    case rejected(BrokerOpenAIOnboardingFailureCode)
  }

  private let authority: any BrokerCredentialLifecycleAuthority
  private let factory: any BrokerOpenAIOnboardingSessionFactory
  private let makeUUID: @Sendable () -> UUID
  private let lock = NSLock()
  private var isAuthorized = false
  private var isClosed = false
  private var greatestSeenRequestID: UInt64 = 0
  private var entry: Entry?
  private var pendingReplyGate: OnboardingReplyGate?
  private var binding: SessionBinding?

  init(
    authority: any BrokerCredentialLifecycleAuthority,
    factory: any BrokerOpenAIOnboardingSessionFactory,
    makeUUID: @escaping @Sendable () -> UUID = { UUID() }
  ) {
    self.authority = authority
    self.factory = factory
    self.makeUUID = makeUUID
  }

  func authorizeAfterHello() {
    lock.withLock {
      guard !isClosed else { return }
      isAuthorized = true
    }
  }

  func submitBegin(
    _ requestData: Data,
    secret: consuming Data,
    reply: @escaping @Sendable (Data) -> Void
  ) {
    let secretBox = OnboardingSecretBox(SecretBytes(secret))
    let request: BrokerOpenAIOnboardingRequest
    do {
      request = try BrokerOpenAIOnboardingRequest.decode(requestData)
    } catch let error as BrokerOpenAIOnboardingCodecError {
      secretBox.erase()
      rejectMalformed(requestID: error.requestID, reply: reply)
      return
    } catch {
      secretBox.erase()
      rejectMalformed(requestID: nil, reply: reply)
      return
    }

    let gate = OnboardingReplyGate(requestID: request.requestID, reply: reply)
    var rejection: BrokerOpenAIOnboardingFailureCode?
    lock.lock()
    switch admit(requestID: request.requestID) {
    case .rejected(let code):
      rejection = code
    case .accepted:
      guard case .begin = request else {
        rejection = .invalidRequest
        break
      }
      guard (1...brokerCredentialMaximumSecretBytes).contains(secretBox.byteCount) else {
        rejection = .invalidRequest
        break
      }
      guard binding == nil else {
        rejection = .operationUnavailable
        break
      }
      let task = Task { [weak self, gate, secretBox] in
        guard let self else {
          secretBox.erase()
          gate.complete(Self.failure(requestID: request.requestID, code: .cancelled))
          return
        }
        await self.runBegin(requestID: request.requestID, secretBox: secretBox, gate: gate)
      }
      entry = Entry(task: task, gate: gate)
    }
    lock.unlock()

    if let rejection {
      secretBox.erase()
      gate.complete(Self.failure(requestID: request.requestID, code: rejection))
    }
  }

  func submitControl(
    _ requestData: Data,
    reply: @escaping @Sendable (Data) -> Void
  ) {
    let request: BrokerOpenAIOnboardingRequest
    do {
      request = try BrokerOpenAIOnboardingRequest.decode(requestData)
    } catch let error as BrokerOpenAIOnboardingCodecError {
      rejectMalformed(requestID: error.requestID, reply: reply)
      return
    } catch {
      rejectMalformed(requestID: nil, reply: reply)
      return
    }

    let gate = OnboardingReplyGate(requestID: request.requestID, reply: reply)
    var rejection: BrokerOpenAIOnboardingFailureCode?
    lock.lock()
    switch admit(requestID: request.requestID) {
    case .rejected(let code):
      rejection = code
    case .accepted:
      guard case .begin = request else {
        guard let binding else {
          rejection = .sessionNotReady
          break
        }
        if let code = Self.validate(request, against: binding) {
          rejection = code
          break
        }
        let task = Task { [weak self, gate, request, binding] in
          guard let self else {
            gate.complete(Self.failure(requestID: request.requestID, code: .cancelled))
            return
          }
          await self.runControl(request, binding: binding, gate: gate)
        }
        entry = Entry(task: task, gate: gate)
        break
      }
      rejection = .invalidRequest
    }
    lock.unlock()

    if let rejection {
      gate.complete(Self.failure(requestID: request.requestID, code: rejection))
    }
  }

  func close() {
    shutdown(discardReply: false)
  }

  func transportTeardown() {
    shutdown(discardReply: true)
  }

  private func admit(requestID: UInt64) -> Admission {
    guard requestID > greatestSeenRequestID else { return .rejected(.invalidRequest) }
    greatestSeenRequestID = requestID
    guard !isClosed else { return .rejected(.cancelled) }
    guard isAuthorized else { return .rejected(.sessionNotReady) }
    guard entry == nil else { return .rejected(.busy) }
    return .accepted
  }

  private static func validate(
    _ request: BrokerOpenAIOnboardingRequest,
    against binding: SessionBinding
  ) -> BrokerOpenAIOnboardingFailureCode? {
    guard !binding.isTerminal else { return .operationUnavailable }
    switch request {
    case .begin:
      return .invalidRequest
    case .verify:
      return binding.catalog == nil ? nil : .operationUnavailable
    case .catalogPage(_, let cursor):
      guard binding.catalog != nil else { return .sessionNotReady }
      return binding.nextCursor == cursor ? nil : .invalidRequest
    case .finalize:
      return binding.catalog == nil ? .sessionNotReady : nil
    case .abort:
      return nil
    }
  }

  private func rejectMalformed(
    requestID: UInt64?,
    reply: @escaping @Sendable (Data) -> Void
  ) {
    guard let requestID else {
      reply(
        Self.failure(
          requestID: brokerOpenAIOnboardingMalformedRequestID,
          code: .invalidRequest
        )
      )
      return
    }
    lock.withLock {
      if requestID > greatestSeenRequestID {
        greatestSeenRequestID = requestID
      }
    }
    reply(Self.failure(requestID: requestID, code: .invalidRequest))
  }

  private func runBegin(
    requestID: UInt64,
    secretBox: OnboardingSecretBox,
    gate: OnboardingReplyGate
  ) async {
    guard !Task.isCancelled else {
      secretBox.erase()
      complete(requestID: requestID, gate: gate, code: .cancelled)
      return
    }

    let identity: GeneratedIdentity
    do {
      identity = try generatedIdentity()
    } catch {
      secretBox.erase()
      complete(requestID: requestID, gate: gate, code: .authorityUnavailable)
      return
    }
    guard let secret = secretBox.take(), !Task.isCancelled else {
      secretBox.erase()
      complete(requestID: requestID, gate: gate, code: .cancelled)
      return
    }

    let attempt: StagingAttempt
    do {
      attempt = try await authority.stage(
        connectionID: identity.connectionID,
        providerBinding: .openAI,
        operationID: identity.stageOperationID,
        expectedFence: 0,
        secret: secret
      )
    } catch let error {
      complete(requestID: requestID, gate: gate, code: Self.map(error))
      return
    }

    guard attempt.attemptID != zeroUUID, attempt.fence > 0 else {
      complete(requestID: requestID, gate: gate, code: .reconciliationRequired)
      return
    }
    let context = BrokerOpenAIOnboardingStagingContext(
      connectionID: identity.connectionID,
      attemptID: attempt.attemptID,
      fence: attempt.fence,
      providerBinding: .openAI
    )
    guard attempt.connectionID == identity.connectionID, attempt.fence == 1 else {
      let cleaned = await cleanup(
        context: context,
        abortOperationID: identity.recoveryTokens.abortOperationID
      )
      complete(
        requestID: requestID,
        gate: gate,
        code: cleaned ? .authorityUnavailable : .cleanupFailed
      )
      return
    }

    let session: any BrokerOpenAIOnboardingSessionProtocol
    do {
      session = try factory.makeSession(
        context: context,
        abortOperationID: identity.recoveryTokens.abortOperationID
      )
    } catch let error {
      let cleaned = await cleanup(
        context: context,
        abortOperationID: identity.recoveryTokens.abortOperationID
      )
      complete(
        requestID: requestID,
        gate: gate,
        code: cleaned ? Self.map(error) : .cleanupFailed
      )
      return
    }

    if Task.isCancelled {
      let code = await close(session, afterSuccess: .cancelled)
      complete(requestID: requestID, gate: gate, code: code)
      return
    }

    let binding = SessionBinding(
      session: session,
      connectionID: identity.connectionID,
      recoveryTokens: identity.recoveryTokens,
      catalog: nil,
      nextCursor: nil
    )
    let reply = BrokerOpenAIOnboardingReply.begun(
      requestID: requestID,
      connectionID: identity.connectionID,
      recoveryTokens: identity.recoveryTokens
    )
    guard let encoded = try? reply.encode() else {
      let code = await close(session, afterSuccess: .authorityUnavailable)
      complete(requestID: requestID, gate: gate, code: code)
      return
    }
    guard install(binding, requestID: requestID, gate: gate) else {
      let code = await close(session, afterSuccess: .cancelled)
      complete(requestID: requestID, gate: gate, code: code)
      return
    }
    deliver(encoded, through: gate)
  }

  private func runControl(
    _ request: BrokerOpenAIOnboardingRequest,
    binding: SessionBinding,
    gate: OnboardingReplyGate
  ) async {
    guard !Task.isCancelled else {
      complete(requestID: request.requestID, gate: gate, code: .cancelled)
      return
    }
    switch request {
    case .verify(let requestID):
      await runVerify(requestID: requestID, binding: binding, gate: gate)
    case .catalogPage(let requestID, let cursor):
      await runCatalogPage(requestID: requestID, cursor: cursor, binding: binding, gate: gate)
    case .finalize(let requestID, let exactModelID):
      await runFinalize(
        requestID: requestID,
        exactModelID: exactModelID,
        binding: binding,
        gate: gate
      )
    case .abort(let requestID):
      await runAbort(requestID: requestID, binding: binding, gate: gate)
    case .begin(let requestID):
      complete(requestID: requestID, gate: gate, code: .invalidRequest)
    }
  }

  private func runVerify(
    requestID: UInt64,
    binding: SessionBinding,
    gate: OnboardingReplyGate
  ) async {
    do {
      let catalog = try await binding.session.verify()
      guard !Task.isCancelled else {
        complete(requestID: requestID, gate: gate, code: .cancelled)
        return
      }
      let page = try Self.page(catalog: catalog, cursor: 0)
      complete(
        requestID: requestID,
        gate: gate,
        reply: .catalogPage(requestID: requestID, page)
      ) { state in
        state.catalog = catalog
        state.nextCursor = page.nextCursor
      }
    } catch let error as BrokerOpenAIOnboardingError {
      completeSessionFailure(requestID: requestID, gate: gate, error: error)
    } catch {
      let code = await close(binding.session, afterSuccess: .authorityUnavailable)
      complete(requestID: requestID, gate: gate, code: code, terminal: true)
    }
  }

  private func runCatalogPage(
    requestID: UInt64,
    cursor: UInt16,
    binding: SessionBinding,
    gate: OnboardingReplyGate
  ) async {
    guard let catalog = binding.catalog else {
      complete(requestID: requestID, gate: gate, code: .sessionNotReady)
      return
    }
    do {
      let page = try Self.page(catalog: catalog, cursor: Int(cursor))
      complete(
        requestID: requestID,
        gate: gate,
        reply: .catalogPage(requestID: requestID, page)
      ) { state in
        state.nextCursor = page.nextCursor
      }
    } catch {
      let code = await close(binding.session, afterSuccess: .authorityUnavailable)
      complete(requestID: requestID, gate: gate, code: code, terminal: true)
    }
  }

  private func runFinalize(
    requestID: UInt64,
    exactModelID: String,
    binding: SessionBinding,
    gate: OnboardingReplyGate
  ) async {
    let receipt: BrokerOpenAIOnboardingReceipt
    do {
      receipt = try await binding.session.finalize(
        exactModelID: exactModelID,
        operationID: binding.recoveryTokens.commitOperationID
      )
    } catch let error {
      completeSessionFailure(requestID: requestID, gate: gate, error: error)
      return
    }

    do {
      guard let catalog = binding.catalog else {
        throw OnboardingGatewayError.invalidReceipt
      }
      let redacted = try Self.redactedReceipt(
        receipt,
        expectedConnectionID: binding.connectionID,
        expectedModelID: exactModelID,
        expectedCatalog: catalog
      )
      complete(
        requestID: requestID,
        gate: gate,
        reply: .committed(requestID: requestID, redacted),
        terminal: true
      )
    } catch {
      complete(requestID: requestID, gate: gate, code: .reconciliationRequired, terminal: true)
    }
  }

  private func runAbort(
    requestID: UInt64,
    binding: SessionBinding,
    gate: OnboardingReplyGate
  ) async {
    do {
      try await binding.session.close()
      guard !Task.isCancelled else {
        complete(requestID: requestID, gate: gate, code: .cancelled)
        return
      }
      complete(
        requestID: requestID,
        gate: gate,
        reply: .aborted(requestID: requestID),
        terminal: true
      )
    } catch let error {
      complete(
        requestID: requestID,
        gate: gate,
        code: Self.mapClose(error),
        terminal: true
      )
    }
  }

  private func generatedIdentity() throws -> GeneratedIdentity {
    let connectionID = makeUUID()
    let stageOperationID = makeUUID()
    let commitOperationID = makeUUID()
    let abortOperationID = makeUUID()
    let identifiers = [connectionID, stageOperationID, commitOperationID, abortOperationID]
    guard
      identifiers.allSatisfy({ $0 != zeroUUID }),
      Set(identifiers).count == identifiers.count
    else {
      throw OnboardingGatewayError.invalidGeneratedIdentity
    }
    return GeneratedIdentity(
      connectionID: connectionID,
      stageOperationID: stageOperationID,
      recoveryTokens: try BrokerOpenAIOnboardingRecoveryTokens(
        commitOperationID: commitOperationID,
        abortOperationID: abortOperationID
      )
    )
  }

  private func cleanup(
    context: BrokerOpenAIOnboardingStagingContext,
    abortOperationID: UUID
  ) async -> Bool {
    let authority = authority
    return await Task.detached {
      do {
        _ = try await authority.abort(
          connectionID: context.connectionID,
          attemptID: context.attemptID,
          operationID: abortOperationID,
          expectedFence: context.fence
        )
        return true
      } catch {
        return false
      }
    }.value
  }

  private func close(
    _ session: any BrokerOpenAIOnboardingSessionProtocol,
    afterSuccess code: BrokerOpenAIOnboardingFailureCode
  ) async -> BrokerOpenAIOnboardingFailureCode {
    do {
      try await session.close()
      return code
    } catch let error {
      return Self.mapClose(error)
    }
  }

  private func install(
    _ selected: SessionBinding,
    requestID: UInt64,
    gate: OnboardingReplyGate
  ) -> Bool {
    lock.withLock {
      guard !isClosed, entry?.gate === gate, gate.requestID == requestID else { return false }
      entry = nil
      pendingReplyGate = gate
      binding = selected
      return true
    }
  }

  private func completeSessionFailure(
    requestID: UInt64,
    gate: OnboardingReplyGate,
    error: BrokerOpenAIOnboardingError
  ) {
    complete(
      requestID: requestID,
      gate: gate,
      code: Self.map(error),
      terminal: true
    )
  }

  private func complete(
    requestID: UInt64,
    gate: OnboardingReplyGate,
    code: BrokerOpenAIOnboardingFailureCode,
    terminal: Bool = false
  ) {
    complete(
      requestID: requestID,
      gate: gate,
      encoded: Self.failure(requestID: requestID, code: code),
      terminal: terminal
    )
  }

  private func complete(
    requestID: UInt64,
    gate: OnboardingReplyGate,
    reply: BrokerOpenAIOnboardingReply,
    terminal: Bool = false,
    update: (inout SessionBinding) -> Void = { _ in }
  ) {
    guard let encoded = try? reply.encode() else {
      complete(
        requestID: requestID,
        gate: gate,
        code: .authorityUnavailable,
        terminal: true
      )
      return
    }
    complete(
      requestID: requestID,
      gate: gate,
      encoded: encoded,
      terminal: terminal,
      update: update
    )
  }

  private func complete(
    requestID: UInt64,
    gate: OnboardingReplyGate,
    encoded: Data,
    terminal: Bool = false,
    update: (inout SessionBinding) -> Void = { _ in }
  ) {
    let ownsReply = lock.withLock {
      guard entry?.gate === gate, gate.requestID == requestID else { return false }
      entry = nil
      pendingReplyGate = gate
      if var selected = binding {
        update(&selected)
        if terminal { selected.isTerminal = true }
        binding = selected
      }
      return true
    }
    guard ownsReply else { return }
    deliver(encoded, through: gate)
  }

  private func shutdown(discardReply: Bool) {
    let selected: (Entry?, OnboardingReplyGate?, SessionBinding?) = lock.withLock {
      guard !isClosed else { return (nil, nil, nil) }
      isClosed = true
      isAuthorized = false
      let selected = (entry, pendingReplyGate, binding)
      if discardReply {
        selected.0?.gate.discard()
        selected.1?.discard()
      }
      return selected
    }
    selected.0?.task.cancel()
    if let binding = selected.2 {
      Task.detached {
        _ = try? await binding.session.close()
      }
    }
  }

  private func deliver(_ encoded: Data, through gate: OnboardingReplyGate) {
    gate.complete(encoded)
    lock.withLock {
      if pendingReplyGate === gate { pendingReplyGate = nil }
    }
  }

  private static func page(
    catalog: BrokerOpenAIModelCatalog,
    cursor: Int
  ) throws -> BrokerOpenAIOnboardingCatalogPage {
    guard
      !catalog.modelIDs.isEmpty,
      catalog.modelIDs.count <= brokerOpenAIOnboardingMaximumModelCount,
      cursor >= 0,
      cursor < catalog.modelIDs.count
    else {
      throw OnboardingGatewayError.invalidCatalog
    }
    let end = min(
      cursor + brokerOpenAIOnboardingMaximumModelIDsPerPage,
      catalog.modelIDs.count
    )
    return try BrokerOpenAIOnboardingCatalogPage(
      cursor: UInt16(cursor),
      totalModelCount: UInt16(catalog.modelIDs.count),
      nextCursor: end == catalog.modelIDs.count ? nil : UInt16(end),
      catalogRequestID: catalog.requestID,
      modelIDs: Array(catalog.modelIDs[cursor..<end])
    )
  }

  private static func redactedReceipt(
    _ receipt: BrokerOpenAIOnboardingReceipt,
    expectedConnectionID: UUID,
    expectedModelID: String,
    expectedCatalog: BrokerOpenAIModelCatalog
  ) throws -> BrokerOpenAIOnboardingCommitReceipt {
    guard
      receipt.ready.connectionID == expectedConnectionID,
      Data(receipt.selectedModelID.utf8) == Data(expectedModelID.utf8),
      receipt.verifiedModelCount == expectedCatalog.modelIDs.count,
      receipt.catalogRequestID == expectedCatalog.requestID,
      let verifiedModelCount = UInt16(exactly: receipt.verifiedModelCount)
    else {
      throw OnboardingGatewayError.invalidReceipt
    }
    return try BrokerOpenAIOnboardingCommitReceipt(
      connectionID: expectedConnectionID,
      selectedModelID: receipt.selectedModelID,
      verifiedModelCount: verifiedModelCount,
      catalogRequestID: receipt.catalogRequestID
    )
  }

  private static func failure(
    requestID: UInt64,
    code: BrokerOpenAIOnboardingFailureCode
  ) -> Data {
    (try? BrokerOpenAIOnboardingReply.failure(requestID: requestID, code).encode()) ?? Data()
  }

  private static func map(
    _ error: BrokerOpenAIOnboardingError
  ) -> BrokerOpenAIOnboardingFailureCode {
    switch error {
    case .cancelled: .cancelled
    case .expired: .expired
    case .invalidContext: .authorityUnavailable
    case .invalidModel: .invalidModel
    case .invalidState: .operationUnavailable
    case .noCompatibleModels: .noCompatibleModels
    case .verificationFailed: .verificationFailed
    case .commitFailed: .commitFailed
    case .cleanupFailed: .cleanupFailed
    case .reconciliationRequired: .reconciliationRequired
    }
  }

  private static func mapClose(
    _ error: BrokerOpenAIOnboardingError
  ) -> BrokerOpenAIOnboardingFailureCode {
    error == .reconciliationRequired ? .reconciliationRequired : .cleanupFailed
  }

  private static func map(
    _ error: BrokerStateError
  ) -> BrokerOpenAIOnboardingFailureCode {
    switch error {
    case .cancelled: .cancelled
    case .operationInProgress: .busy
    case .storeUnavailable: .credentialStoreUnavailable
    case .cleanupPending: .cleanupFailed
    case .connectionNotFound, .connectionTombstoned, .staleFence, .fenceOverflow,
      .generationOverflow, .invalidTransition, .attemptNotCurrent, .operationIDConflict,
      .invalidBootstrap:
      .authorityUnavailable
    }
  }
}

private enum OnboardingGatewayError: Error {
  case invalidCatalog
  case invalidGeneratedIdentity
  case invalidReceipt
}

private let zeroUUID = UUID(
  uuid: (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
)

private final class OnboardingReplyGate: @unchecked Sendable {
  private let lock = NSLock()
  private var reply: (@Sendable (Data) -> Void)?
  let requestID: UInt64

  init(requestID: UInt64, reply: @escaping @Sendable (Data) -> Void) {
    self.requestID = requestID
    self.reply = reply
  }

  func complete(_ data: Data) {
    let callback: (@Sendable (Data) -> Void)? = lock.withLock {
      defer { reply = nil }
      return reply
    }
    callback?(data)
  }

  func discard() {
    lock.withLock { reply = nil }
  }
}

private final class OnboardingSecretBox: @unchecked Sendable {
  private let lock = NSLock()
  private var secret: SecretBytes?

  init(_ secret: consuming SecretBytes) {
    self.secret = secret
  }

  var byteCount: Int {
    lock.withLock { secret?.withUnsafeBytes(\.count) ?? 0 }
  }

  func take() -> sending SecretBytes? {
    lock.withLock {
      defer { secret = nil }
      return secret
    }
  }

  func erase() {
    lock.withLock {
      secret?.erase()
      secret = nil
    }
  }

  deinit {
    erase()
  }
}
