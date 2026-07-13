import Foundation
import RecursBrokerCore
import RecursBrokerXPC

package final class BrokerCredentialLifecycleGateway: @unchecked Sendable {
  package static let maximumInflightRequests = 8
  package static let maximumSecretBytes = 4_096

  private struct Entry {
    let task: Task<Void, Never>
    let gate: ReplyGate
  }

  private enum Admission {
    case accepted
    case rejected(BrokerCredentialLifecycleFailureCode)
  }

  private let authority: any BrokerCredentialLifecycleAuthority
  private let lock = NSLock()
  private var isAuthorized = false
  private var isClosed = false
  private var greatestSeenRequestID: UInt64 = 0
  private var entries: [UInt64: Entry] = [:]

  package init(authority: any BrokerCredentialLifecycleAuthority) {
    self.authority = authority
  }

  package func authorizeAfterHello() {
    lock.withLock {
      guard !isClosed else { return }
      isAuthorized = true
    }
  }

  package func submitStage(
    metadata: Data,
    secret: consuming Data,
    reply: @escaping @Sendable (Data) -> Void
  ) {
    let secretBox = SecretTransferBox(SecretBytes(secret))
    let request: BrokerCredentialStageRequest
    do {
      request = try BrokerCredentialStageRequest.decode(metadata)
    } catch let error as BrokerCredentialLifecycleCodecError {
      secretBox.erase()
      rejectMalformed(requestID: error.requestID, reply: reply)
      return
    } catch {
      secretBox.erase()
      rejectMalformed(requestID: nil, reply: reply)
      return
    }

    let gate = ReplyGate(requestID: request.requestID, reply: reply)
    var rejection: BrokerCredentialLifecycleFailureCode?
    lock.lock()
    switch admit(requestID: request.requestID, requiresCapacity: true) {
    case .rejected(let code):
      rejection = code
    case .accepted:
      guard secretBox.byteCount <= Self.maximumSecretBytes else {
        rejection = .invalidRequest
        break
      }
      let task = Task { [weak self, secretBox, gate, request] in
        guard let self else {
          secretBox.erase()
          gate.complete(Self.failure(requestID: request.requestID, code: .cancelled))
          return
        }
        await self.runStage(request, secretBox: secretBox, gate: gate)
      }
      entries[request.requestID] = Entry(task: task, gate: gate)
    }
    lock.unlock()

    if let rejection {
      secretBox.erase()
      gate.complete(Self.failure(requestID: request.requestID, code: rejection))
    }
  }

  package func submitControl(
    _ requestData: Data,
    reply: @escaping @Sendable (Data) -> Void
  ) {
    let request: BrokerCredentialControlRequest
    do {
      request = try BrokerCredentialControlRequest.decode(requestData)
    } catch let error as BrokerCredentialLifecycleCodecError {
      rejectMalformed(requestID: error.requestID, reply: reply)
      return
    } catch {
      rejectMalformed(requestID: nil, reply: reply)
      return
    }

    let requestID = request.requestID
    let requiresCapacity: Bool
    if case .reservedOperation = request {
      requiresCapacity = false
    } else {
      requiresCapacity = true
    }
    let gate = ReplyGate(requestID: requestID, reply: reply)
    var rejection: BrokerCredentialLifecycleFailureCode?
    lock.lock()
    switch admit(requestID: requestID, requiresCapacity: requiresCapacity) {
    case .rejected(let code):
      rejection = code
    case .accepted:
      if case .reservedOperation = request {
        rejection = .operationUnavailable
      } else {
        let task = Task { [weak self, gate, request] in
          guard let self else {
            gate.complete(Self.failure(requestID: requestID, code: .cancelled))
            return
          }
          await self.runControl(request, gate: gate)
        }
        entries[requestID] = Entry(task: task, gate: gate)
      }
    }
    lock.unlock()

    if let rejection {
      gate.complete(Self.failure(requestID: requestID, code: rejection))
    }
  }

  package func close() {
    let owned: [Entry] = lock.withLock {
      guard !isClosed else { return [] }
      isClosed = true
      isAuthorized = false
      let owned = Array(entries.values)
      entries.removeAll(keepingCapacity: false)
      return owned
    }
    for entry in owned {
      entry.task.cancel()
    }
    for entry in owned {
      entry.gate.complete(Self.failure(requestID: entry.gate.requestID, code: .cancelled))
    }
  }

  private func admit(requestID: UInt64, requiresCapacity: Bool) -> Admission {
    guard requestID > greatestSeenRequestID else { return .rejected(.invalidRequest) }
    greatestSeenRequestID = requestID
    guard !isClosed else { return .rejected(.cancelled) }
    guard isAuthorized else { return .rejected(.sessionNotReady) }
    guard !requiresCapacity || entries.count < Self.maximumInflightRequests else {
      return .rejected(.capacityExceeded)
    }
    return .accepted
  }

  private func rejectMalformed(
    requestID: UInt64?,
    reply: @escaping @Sendable (Data) -> Void
  ) {
    guard let requestID else {
      reply(Self.failure(requestID: brokerCredentialMalformedRequestID, code: .invalidRequest))
      return
    }
    lock.withLock {
      if requestID > greatestSeenRequestID {
        greatestSeenRequestID = requestID
      }
    }
    reply(Self.failure(requestID: requestID, code: .invalidRequest))
  }

  private func runStage(
    _ request: BrokerCredentialStageRequest,
    secretBox: SecretTransferBox,
    gate: ReplyGate
  ) async {
    guard !Task.isCancelled, let secret = secretBox.take() else {
      secretBox.erase()
      finish(requestID: request.requestID, gate: gate, code: .cancelled)
      return
    }
    guard !Task.isCancelled else {
      secret.erase()
      finish(requestID: request.requestID, gate: gate, code: .cancelled)
      return
    }
    do {
      let attempt = try await authority.stage(
        connectionID: request.connectionID,
        operationID: request.operationID,
        expectedFence: request.expectedFence,
        secret: secret
      )
      guard !Task.isCancelled else {
        finish(requestID: request.requestID, gate: gate, code: .cancelled)
        return
      }
      let projection = try BrokerCredentialRedactedProjection(
        state: .staging,
        fence: attempt.fence,
        hasUsableReady: attempt.previousReady != nil,
        attemptID: attempt.attemptID
      )
      finish(
        requestID: request.requestID,
        gate: gate,
        reply: .staged(requestID: request.requestID, projection)
      )
    } catch let error as BrokerStateError {
      finish(requestID: request.requestID, gate: gate, stateError: error)
    } catch {
      finishSevere(requestID: request.requestID, gate: gate)
    }
  }

  private func runControl(
    _ request: BrokerCredentialControlRequest,
    gate: ReplyGate
  ) async {
    guard !Task.isCancelled else {
      finish(requestID: request.requestID, gate: gate, code: .cancelled)
      return
    }
    switch request {
    case .projection(let requestID, let connectionID):
      guard !Task.isCancelled else {
        finish(requestID: requestID, gate: gate, code: .cancelled)
        return
      }
      do {
        let value = try await authority.authoritativeLifecycleProjection(for: connectionID)
        guard !Task.isCancelled else {
          finish(requestID: requestID, gate: gate, code: .cancelled)
          return
        }
        let projection = try Self.redacted(value)
        finish(
          requestID: requestID,
          gate: gate,
          reply: .projection(requestID: requestID, projection)
        )
      } catch let error as BrokerJournalError {
        finish(requestID: requestID, gate: gate, journalError: error)
      } catch {
        finishSevere(requestID: requestID, gate: gate)
      }
    case .resumeStage(let requestID, let connectionID, let operationID, let expectedFence):
      guard !Task.isCancelled else {
        finish(requestID: requestID, gate: gate, code: .cancelled)
        return
      }
      do {
        let attempt = try await authority.resumeStage(
          connectionID: connectionID,
          operationID: operationID,
          expectedFence: expectedFence
        )
        guard !Task.isCancelled else {
          finish(requestID: requestID, gate: gate, code: .cancelled)
          return
        }
        let projection = try BrokerCredentialRedactedProjection(
          state: .staging,
          fence: attempt.fence,
          hasUsableReady: attempt.previousReady != nil,
          attemptID: attempt.attemptID
        )
        finish(requestID: requestID, gate: gate, reply: .staged(requestID: requestID, projection))
      } catch let error as BrokerStateError {
        finish(requestID: requestID, gate: gate, stateError: error)
      } catch {
        finishSevere(requestID: requestID, gate: gate)
      }
    case .abort(
      let requestID,
      let connectionID,
      let attemptID,
      let operationID,
      let expectedFence
    ):
      guard !Task.isCancelled else {
        finish(requestID: requestID, gate: gate, code: .cancelled)
        return
      }
      do {
        let ready = try await authority.abort(
          connectionID: connectionID,
          attemptID: attemptID,
          operationID: operationID,
          expectedFence: expectedFence
        )
        guard !Task.isCancelled else {
          finish(requestID: requestID, gate: gate, code: .cancelled)
          return
        }
        let projection = try BrokerCredentialRedactedProjection(
          state: ready == nil ? .vacant : .ready,
          fence: ready?.fence ?? expectedFence,
          hasUsableReady: ready != nil,
          attemptID: nil
        )
        finish(requestID: requestID, gate: gate, reply: .mutation(requestID: requestID, projection))
      } catch let error as BrokerStateError {
        finish(requestID: requestID, gate: gate, stateError: error)
      } catch {
        finishSevere(requestID: requestID, gate: gate)
      }
    case .disconnect(let requestID, let connectionID, let operationID, let expectedFence):
      guard !Task.isCancelled else {
        finish(requestID: requestID, gate: gate, code: .cancelled)
        return
      }
      do {
        let tombstone = try await authority.disconnect(
          connectionID: connectionID,
          operationID: operationID,
          expectedFence: expectedFence
        )
        guard !Task.isCancelled else {
          finish(requestID: requestID, gate: gate, code: .cancelled)
          return
        }
        let projection = try BrokerCredentialRedactedProjection(
          state: .tombstoned,
          fence: tombstone.fence,
          hasUsableReady: false,
          attemptID: nil
        )
        finish(requestID: requestID, gate: gate, reply: .mutation(requestID: requestID, projection))
      } catch let error as BrokerStateError {
        finish(requestID: requestID, gate: gate, stateError: error)
      } catch {
        finishSevere(requestID: requestID, gate: gate)
      }
    case .reservedOperation(let requestID):
      finish(requestID: requestID, gate: gate, code: .operationUnavailable)
    }
  }

  private func finish(
    requestID: UInt64,
    gate: ReplyGate,
    stateError: BrokerStateError
  ) {
    let mapped = Self.map(stateError)
    if mapped.closes {
      finishSevere(requestID: requestID, gate: gate)
    } else {
      finish(requestID: requestID, gate: gate, code: mapped.code)
    }
  }

  private func finish(
    requestID: UInt64,
    gate: ReplyGate,
    journalError: BrokerJournalError
  ) {
    let mapped = Self.map(journalError)
    if mapped.closes {
      finishSevere(requestID: requestID, gate: gate)
    } else {
      finish(requestID: requestID, gate: gate, code: mapped.code)
    }
  }

  private func finishSevere(requestID: UInt64, gate: ReplyGate) {
    let transition: (replyCurrent: Bool, cancel: [Entry]) = lock.withLock {
      guard entries[requestID]?.gate === gate else { return (false, []) }
      entries.removeValue(forKey: requestID)
      isClosed = true
      isAuthorized = false
      let cancel = Array(entries.values)
      entries.removeAll(keepingCapacity: false)
      return (true, cancel)
    }
    guard transition.replyCurrent else { return }
    for entry in transition.cancel {
      entry.task.cancel()
    }
    gate.complete(Self.failure(requestID: requestID, code: .authorityUnavailable))
    for entry in transition.cancel {
      entry.gate.complete(Self.failure(requestID: entry.gate.requestID, code: .cancelled))
    }
  }

  private func finish(
    requestID: UInt64,
    gate: ReplyGate,
    code: BrokerCredentialLifecycleFailureCode
  ) {
    finish(
      requestID: requestID,
      gate: gate,
      encoded: Self.failure(requestID: requestID, code: code)
    )
  }

  private func finish(
    requestID: UInt64,
    gate: ReplyGate,
    reply: BrokerCredentialLifecycleReply
  ) {
    guard let encoded = try? reply.encode() else {
      finishSevere(requestID: requestID, gate: gate)
      return
    }
    finish(requestID: requestID, gate: gate, encoded: encoded)
  }

  private func finish(requestID: UInt64, gate: ReplyGate, encoded: Data) {
    let ownsReply = lock.withLock {
      guard entries[requestID]?.gate === gate else { return false }
      entries.removeValue(forKey: requestID)
      return true
    }
    guard ownsReply else { return }
    gate.complete(encoded)
  }

  private static func redacted(
    _ projection: CredentialLifecycleProjection
  ) throws -> BrokerCredentialRedactedProjection {
    switch projection {
    case .missing:
      try BrokerCredentialRedactedProjection(
        state: .missing, fence: 0, hasUsableReady: false, attemptID: nil)
    case .vacant(_, let fence):
      try BrokerCredentialRedactedProjection(
        state: .vacant, fence: fence, hasUsableReady: false, attemptID: nil)
    case .staging(_, let fence, let attemptID, let hasUsableReady):
      try BrokerCredentialRedactedProjection(
        state: .staging,
        fence: fence,
        hasUsableReady: hasUsableReady,
        attemptID: attemptID
      )
    case .ready(_, let fence):
      try BrokerCredentialRedactedProjection(
        state: .ready, fence: fence, hasUsableReady: true, attemptID: nil)
    case .tombstoned(_, let fence):
      try BrokerCredentialRedactedProjection(
        state: .tombstoned, fence: fence, hasUsableReady: false, attemptID: nil)
    }
  }

  private static func failure(
    requestID: UInt64,
    code: BrokerCredentialLifecycleFailureCode
  ) -> Data {
    // The codec accepts the malformed sentinel only for invalid-request replies.
    (try? BrokerCredentialLifecycleReply.failure(requestID: requestID, code).encode()) ?? Data()
  }

  private static func map(
    _ error: BrokerStateError
  ) -> (code: BrokerCredentialLifecycleFailureCode, closes: Bool) {
    switch error {
    case .cancelled: (.cancelled, false)
    case .connectionNotFound: (.notFound, false)
    case .connectionTombstoned: (.disconnected, false)
    case .staleFence: (.staleFence, false)
    case .operationInProgress: (.busy, false)
    case .storeUnavailable: (.credentialStoreUnavailable, false)
    case .cleanupPending: (.cleanupPending, false)
    case .fenceOverflow, .generationOverflow, .invalidTransition, .attemptNotCurrent,
      .operationIDConflict:
      (.conflict, false)
    case .invalidBootstrap: (.authorityUnavailable, true)
    }
  }

  private static func map(
    _ error: BrokerJournalError
  ) -> (code: BrokerCredentialLifecycleFailureCode, closes: Bool) {
    switch error {
    case .casConflict, .revisionOverflow: (.conflict, false)
    case .lockUnavailable, .storageUnavailable: (.credentialStoreUnavailable, false)
    case .mutationOutcomeUnknown: (.cleanupPending, false)
    case .invalidRecord, .nonCanonical, .unsupportedVersion, .authenticationFailed,
      .rollbackDetected:
      (.authorityUnavailable, true)
    }
  }
}

private final class ReplyGate: @unchecked Sendable {
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
}

private final class SecretTransferBox: @unchecked Sendable {
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
