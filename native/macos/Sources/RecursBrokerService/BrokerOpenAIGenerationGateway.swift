import Foundation
import RecursNativeProtocol

enum BrokerOpenAIGenerationBegin: Sendable, Equatable {
  case begun(UUID)
  case failure(OpenAIGenerationFailureCode)

  var operationID: UUID? {
    guard case .begun(let id) = self else { return nil }
    return id
  }
}

enum BrokerOpenAIGenerationPoll: Sendable, Equatable {
  case idle
  case event(Data)
  case failure(OpenAIGenerationFailureCode)

  var eventBody: Data? {
    guard case .event(let body) = self else { return nil }
    return body
  }

  var isTerminal: Bool {
    switch self {
    case .failure:
      true
    case .event(let body):
      (try? JSONSerialization.jsonObject(with: body) as? [String: Any])?["type"]
        as? String == "done"
    case .idle:
      false
    }
  }
}

final class BrokerOpenAIGenerationGateway: @unchecked Sendable {
  private static let maximumQueuedEventCount = 8_192
  private static let maximumQueuedByteCount = 34 * 1_024 * 1_024

  private struct Queued {
    let value: BrokerOpenAIGenerationPoll
    let byteCount: Int
    let terminal: Bool
  }

  private final class Active: @unchecked Sendable {
    let id: UUID
    var task: Task<Void, Never>?
    var queue: [Queued] = []
    var queuedByteCount = 0
    var terminalQueued = false

    init(id: UUID) { self.id = id }
  }

  private let lock = NSLock()
  private let runner: any BrokerOpenAIGenerationRunning
  private let codec = BrokerOpenAIGenerationWireCodec()
  private let idSource: @Sendable () -> UUID?
  private var authorized = false
  private var closed = false
  private var active: Active?

  init(
    runner: any BrokerOpenAIGenerationRunning,
    idSource: @escaping @Sendable () -> UUID? = { UUID() }
  ) {
    self.runner = runner
    self.idSource = idSource
  }

  deinit { active?.task?.cancel() }

  func authorizeAfterHello() {
    lock.withLock {
      guard !closed else { return }
      authorized = true
    }
  }

  func begin(_ body: Data) -> BrokerOpenAIGenerationBegin {
    guard lock.withLock({ authorized && !closed && active == nil }) else {
      return .failure(.routeUnavailable)
    }
    let request: BrokerOpenAIGenerationRequest
    do {
      request = try BrokerOpenAIGenerationWireCodec.decodeRequest(body)
    } catch {
      return .failure(.invalidRequest)
    }
    guard let id = idSource() else { return .failure(.routeUnavailable) }
    let operation = Active(id: id)
    guard
      lock.withLock({ () -> Bool in
        guard authorized, !closed, active == nil else { return false }
        active = operation
        return true
      })
    else { return .failure(.routeUnavailable) }

    let task = Task { [weak self, runner] in
      guard let self else { return }
      do {
        let result = try await runner.run(request) { [weak self] event in
          self?.receive(event, operationID: id)
        }
        self.complete(result, operationID: id)
      } catch let error as BrokerOpenAIGenerationError {
        self.fail(Self.map(error), operationID: id)
      } catch is CancellationError {
        self.fail(.cancelled, operationID: id)
      } catch {
        self.fail(.providerFailure, operationID: id)
      }
    }
    lock.withLock {
      guard active === operation, !operation.terminalQueued else {
        task.cancel()
        return
      }
      operation.task = task
    }
    return .begun(id)
  }

  func poll(_ operationID: UUID) -> BrokerOpenAIGenerationPoll {
    lock.withLock {
      guard let operation = active, operation.id == operationID else {
        return .failure(.invalidRequest)
      }
      guard !operation.queue.isEmpty else { return .idle }
      let queued = operation.queue.removeFirst()
      operation.queuedByteCount -= queued.byteCount
      if queued.terminal { active = nil }
      return queued.value
    }
  }

  func cancel(_ operationID: UUID) {
    let task = lock.withLock { () -> Task<Void, Never>? in
      guard let operation = active, operation.id == operationID,
        !operation.terminalQueued
      else { return nil }
      operation.queue.removeAll(keepingCapacity: false)
      operation.queuedByteCount = 0
      operation.terminalQueued = true
      operation.queue.append(Queued(value: .failure(.cancelled), byteCount: 0, terminal: true))
      return operation.task
    }
    task?.cancel()
  }

  func close() {
    let task = lock.withLock { () -> Task<Void, Never>? in
      guard !closed else { return nil }
      closed = true
      authorized = false
      let task = active?.task
      active = nil
      return task
    }
    task?.cancel()
  }

  private func receive(_ event: BrokerOpenAIResponsesEvent, operationID: UUID) {
    guard case .done = event else {
      do {
        enqueue(.event(try codec.encode(event)), terminal: false, operationID: operationID)
      } catch {
        fail(.invalidResponse, operationID: operationID)
      }
      return
    }
  }

  private func complete(_ result: BrokerOpenAIGenerationResult, operationID: UUID) {
    do {
      let state = try codec.encodeProviderState(result.continuation)
      let done = try codec.encodeDone(result.completion.stopReason)
      enqueue(.event(state), terminal: false, operationID: operationID)
      enqueue(.event(done), terminal: true, operationID: operationID)
    } catch {
      fail(.invalidResponse, operationID: operationID)
    }
  }

  private func fail(_ code: OpenAIGenerationFailureCode, operationID: UUID) {
    enqueue(.failure(code), terminal: true, operationID: operationID)
  }

  private func enqueue(
    _ value: BrokerOpenAIGenerationPoll,
    terminal: Bool,
    operationID: UUID
  ) {
    let byteCount = value.eventBody?.count ?? 0
    let task = lock.withLock { () -> Task<Void, Never>? in
      guard let operation = active, operation.id == operationID,
        !operation.terminalQueued
      else { return nil }
      let (nextBytes, overflowed) = operation.queuedByteCount.addingReportingOverflow(byteCount)
      guard !overflowed,
        operation.queue.count < Self.maximumQueuedEventCount,
        nextBytes <= Self.maximumQueuedByteCount
      else {
        operation.queue.removeAll(keepingCapacity: false)
        operation.queuedByteCount = 0
        operation.terminalQueued = true
        operation.queue.append(
          Queued(value: .failure(.responseTooLarge), byteCount: 0, terminal: true)
        )
        return operation.task
      }
      operation.queue.append(Queued(value: value, byteCount: byteCount, terminal: terminal))
      operation.queuedByteCount = nextBytes
      operation.terminalQueued = terminal
      return nil
    }
    task?.cancel()
  }

  private static func map(
    _ error: BrokerOpenAIGenerationError
  ) -> OpenAIGenerationFailureCode {
    switch error {
    case .cancelled: .cancelled
    case .invalidRequest, .invalidContinuation: .invalidRequest
    case .requestTooLarge: .requestTooLarge
    case .persistenceUnavailable: .providerFailure
    case .invalidCredential: .invalidCredential
    case .authenticationRejected: .authenticationRejected
    case .rateLimited: .rateLimited
    case .providerUnavailable: .providerUnavailable
    case .requestRejected: .requestRejected
    case .contentFiltered: .contentFiltered
    case .providerFailure: .providerFailure
    case .credentialEchoDetected: .credentialEchoDetected
    case .invalidResponse: .invalidResponse
    case .responseTooLarge: .responseTooLarge
    case .deliveryUncertain: .deliveryUncertain
    case .routeUnavailable: .routeUnavailable
    }
  }
}
