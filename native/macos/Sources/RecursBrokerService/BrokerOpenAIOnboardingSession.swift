import Foundation
import RecursBrokerCore

let brokerOpenAIOnboardingSetupLifetime: TimeInterval = 300

struct BrokerOpenAIOnboardingStagingContext: Sendable, Equatable {
  let connectionID: UUID
  let attemptID: UUID
  let fence: UInt64
  let providerBinding: ProviderProfileBinding
}

struct BrokerOpenAIOnboardingReceipt: Sendable, Equatable {
  let ready: ReadyProjection
  let selectedModelID: String
  let catalogRequestID: String?
  let verifiedModelCount: Int
}

enum BrokerOpenAIOnboardingError:
  Error,
  Sendable,
  Equatable,
  CustomStringConvertible,
  CustomDebugStringConvertible,
  LocalizedError
{
  case cancelled
  case expired
  case invalidContext
  case invalidModel
  case invalidState
  case noCompatibleModels
  case verificationFailed
  case commitFailed
  case cleanupFailed
  case reconciliationRequired

  private var fixedDescription: String {
    switch self {
    case .cancelled:
      "OpenAI setup was cancelled."
    case .expired:
      "The OpenAI setup session expired."
    case .invalidContext:
      "The OpenAI setup context is invalid."
    case .invalidModel:
      "The selected model was not in the verified OpenAI catalog."
    case .invalidState:
      "The OpenAI setup operation is not valid in the current state."
    case .noCompatibleModels:
      "OpenAI returned no compatible models for this credential."
    case .verificationFailed:
      "The OpenAI credential could not be verified."
    case .commitFailed:
      "The verified OpenAI credential was not committed."
    case .cleanupFailed:
      "OpenAI setup cleanup did not complete."
    case .reconciliationRequired:
      "The OpenAI credential commit outcome requires broker reconciliation."
    }
  }

  var description: String { fixedDescription }
  var debugDescription: String { fixedDescription }
  var errorDescription: String? { fixedDescription }
}

protocol BrokerOpenAISetupCatalogFetching: Sendable {
  func fetchSetupCatalog(
    context: BrokerOpenAIOnboardingStagingContext,
    expiresAt: Date
  ) async throws -> BrokerOpenAIModelCatalog
}

actor BrokerOpenAIOnboardingSession {
  private struct VerifiedCatalog: Sendable {
    let catalog: BrokerOpenAIModelCatalog
    let exactModelIDs: Set<Data>
  }

  private enum VerificationResolution: Sendable {
    case verified(VerifiedCatalog)
    case aborted(BrokerOpenAIOnboardingError)
    case cleanupFailed
  }

  private struct VerificationOperation: Sendable {
    let task: Task<VerificationResolution, Never>
  }

  private struct AbortOperation: Sendable {
    let reason: BrokerOpenAIOnboardingError
    let task: Task<Bool, Never>
  }

  private struct CommitOperation: Sendable {
    let exactModelID: String
    let operationID: UUID
    let task: Task<Terminal, Never>
  }

  private enum Terminal: Sendable {
    case committed(BrokerOpenAIOnboardingReceipt, operationID: UUID)
    case aborted(BrokerOpenAIOnboardingError)
    case cleanupFailed
    case reconciliationRequired
  }

  private enum Phase: Sendable {
    case staged
    case verifying(VerificationOperation)
    case verified(VerifiedCatalog)
    case aborting(AbortOperation)
    case committing(CommitOperation)
    case terminal(Terminal)
  }

  private let context: BrokerOpenAIOnboardingStagingContext
  private let abortOperationID: UUID
  private let authority: any BrokerCredentialLifecycleAuthority
  private let catalogFetcher: any BrokerOpenAISetupCatalogFetching
  private let clock: @Sendable () -> Date
  private let expiresAt: Date
  private var phase = Phase.staged

  init(
    context: BrokerOpenAIOnboardingStagingContext,
    abortOperationID: UUID,
    authority: any BrokerCredentialLifecycleAuthority,
    catalogFetcher: any BrokerOpenAISetupCatalogFetching,
    clock: @escaping @Sendable () -> Date = { Date() }
  ) throws(BrokerOpenAIOnboardingError) {
    guard context.providerBinding == .openAI, context.fence > 0 else {
      throw .invalidContext
    }
    self.context = context
    self.abortOperationID = abortOperationID
    self.authority = authority
    self.catalogFetcher = catalogFetcher
    self.clock = clock
    expiresAt = clock().addingTimeInterval(brokerOpenAIOnboardingSetupLifetime)
  }

  func verify() async throws(BrokerOpenAIOnboardingError) -> BrokerOpenAIModelCatalog {
    if Task.isCancelled {
      try await failClosed(.cancelled)
    }
    while true {
      switch phase {
      case .staged:
        guard clock() < expiresAt else {
          try await failClosed(.expired)
        }
        phase = .verifying(startVerification())
      case .verifying(let operation):
        let resolution = await withTaskCancellationHandler {
          await operation.task.value
        } onCancel: {
          operation.task.cancel()
        }
        if Task.isCancelled {
          try await failClosed(.cancelled)
        }
        applyVerification(resolution)
      case .verified(let verified):
        guard clock() < expiresAt else {
          try await failClosed(.expired)
        }
        return verified.catalog
      case .aborting(let operation):
        await settleAbort(operation)
      case .committing, .terminal(.committed):
        throw .invalidState
      case .terminal(.aborted(let error)):
        throw error
      case .terminal(.cleanupFailed):
        throw .cleanupFailed
      case .terminal(.reconciliationRequired):
        throw .reconciliationRequired
      }
    }
  }

  func finalize(
    exactModelID: String,
    operationID: UUID
  ) async throws(BrokerOpenAIOnboardingError) -> BrokerOpenAIOnboardingReceipt {
    if Task.isCancelled {
      try await failClosed(.cancelled)
    }
    while true {
      switch phase {
      case .staged, .verifying:
        try await failClosed(.invalidState)
      case .verified(let verified):
        guard operationID != abortOperationID else {
          try await failClosed(.invalidState)
        }
        guard clock() < expiresAt else {
          try await failClosed(.expired)
        }
        guard
          (1...256).contains(exactModelID.utf8.count),
          verified.exactModelIDs.contains(Data(exactModelID.utf8))
        else {
          try await failClosed(.invalidModel)
        }
        phase = .committing(
          startCommit(
            verified: verified,
            exactModelID: exactModelID,
            operationID: operationID
          )
        )
      case .committing(let operation):
        let isExactReplay =
          operation.exactModelID == exactModelID && operation.operationID == operationID
        await settleCommit(operation)
        if !isExactReplay, case .terminal(.committed) = phase {
          throw .invalidState
        }
      case .aborting(let operation):
        await settleAbort(operation)
      case .terminal(.committed(let receipt, let committedOperationID)):
        guard
          receipt.selectedModelID == exactModelID,
          committedOperationID == operationID
        else {
          throw .invalidState
        }
        return receipt
      case .terminal(.aborted(let error)):
        throw error
      case .terminal(.cleanupFailed):
        throw .cleanupFailed
      case .terminal(.reconciliationRequired):
        throw .reconciliationRequired
      }
    }
  }

  func abort() async throws(BrokerOpenAIOnboardingError) {
    try await close()
  }

  func close() async throws(BrokerOpenAIOnboardingError) {
    while true {
      switch phase {
      case .staged, .verified:
        beginAbort(reason: .cancelled)
      case .verifying(let operation):
        operation.task.cancel()
        let resolution = await operation.task.value
        applyVerification(resolution, overridingFailureWith: .cancelled)
        if case .verified = phase {
          beginAbort(reason: .cancelled)
        }
      case .aborting(let operation):
        await settleAbort(operation)
      case .committing(let operation):
        await settleCommit(operation)
      case .terminal(.committed), .terminal(.aborted):
        return
      case .terminal(.cleanupFailed):
        throw .cleanupFailed
      case .terminal(.reconciliationRequired):
        throw .reconciliationRequired
      }
    }
  }

  private func startVerification() -> VerificationOperation {
    let authority = authority
    let catalogFetcher = catalogFetcher
    let clock = clock
    let context = context
    let abortOperationID = abortOperationID
    let expiresAt = expiresAt
    let task = Task.detached { () -> VerificationResolution in
      let failure: BrokerOpenAIOnboardingError
      do {
        guard clock() < expiresAt else { throw BrokerOpenAIOnboardingError.expired }
        let catalog = try await catalogFetcher.fetchSetupCatalog(
          context: context,
          expiresAt: expiresAt
        )
        try Task.checkCancellation()
        guard clock() < expiresAt else { throw BrokerOpenAIOnboardingError.expired }
        guard !catalog.modelIDs.isEmpty else {
          throw BrokerOpenAIOnboardingError.noCompatibleModels
        }
        guard let verified = Self.validated(catalog) else {
          throw BrokerOpenAIOnboardingError.verificationFailed
        }
        return .verified(verified)
      } catch let error as BrokerOpenAIOnboardingError {
        failure = error
      } catch let error as BrokerOpenAIModelCatalogError where error == .cancelled {
        failure = .cancelled
      } catch is CancellationError {
        failure = .cancelled
      } catch {
        failure = Task.isCancelled ? .cancelled : .verificationFailed
      }
      let cleaned = await Self.performAbort(
        authority: authority,
        context: context,
        operationID: abortOperationID
      )
      return cleaned ? .aborted(failure) : .cleanupFailed
    }
    return VerificationOperation(task: task)
  }

  private func startCommit(
    verified: VerifiedCatalog,
    exactModelID: String,
    operationID: UUID
  ) -> CommitOperation {
    let authority = authority
    let context = context
    let abortOperationID = abortOperationID
    let task = Task.detached { () -> Terminal in
      do {
        let ready = try await authority.commit(
          connectionID: context.connectionID,
          attemptID: context.attemptID,
          operationID: operationID,
          expectedFence: context.fence
        )
        return .committed(
          BrokerOpenAIOnboardingReceipt(
            ready: ready,
            selectedModelID: exactModelID,
            catalogRequestID: verified.catalog.requestID,
            verifiedModelCount: verified.catalog.modelIDs.count
          ),
          operationID: operationID
        )
      } catch let error as BrokerStateError {
        guard Self.isProvenPrelinearization(error) else {
          return .reconciliationRequired
        }
        let cleaned = await Self.performAbort(
          authority: authority,
          context: context,
          operationID: abortOperationID
        )
        return cleaned ? .aborted(.commitFailed) : .cleanupFailed
      } catch {
        return .reconciliationRequired
      }
    }
    return CommitOperation(
      exactModelID: exactModelID,
      operationID: operationID,
      task: task
    )
  }

  private func beginAbort(reason: BrokerOpenAIOnboardingError) {
    let authority = authority
    let context = context
    let abortOperationID = abortOperationID
    let task = Task.detached {
      await Self.performAbort(
        authority: authority,
        context: context,
        operationID: abortOperationID
      )
    }
    phase = .aborting(AbortOperation(reason: reason, task: task))
  }

  private func failClosed(
    _ requestedError: BrokerOpenAIOnboardingError
  ) async throws(BrokerOpenAIOnboardingError) -> Never {
    while true {
      switch phase {
      case .staged, .verified:
        beginAbort(reason: requestedError)
      case .verifying(let operation):
        operation.task.cancel()
        let resolution = await operation.task.value
        applyVerification(resolution, overridingFailureWith: requestedError)
        if case .verified = phase {
          beginAbort(reason: requestedError)
        }
      case .aborting(let operation):
        await settleAbort(operation)
      case .committing(let operation):
        await settleCommit(operation)
      case .terminal(.committed):
        throw .invalidState
      case .terminal(.aborted(let error)):
        throw error
      case .terminal(.cleanupFailed):
        throw .cleanupFailed
      case .terminal(.reconciliationRequired):
        throw .reconciliationRequired
      }
    }
  }

  private func applyVerification(
    _ resolution: VerificationResolution,
    overridingFailureWith override: BrokerOpenAIOnboardingError? = nil
  ) {
    guard case .verifying = phase else { return }
    switch resolution {
    case .verified(let verified):
      if let override {
        beginAbort(reason: override)
      } else {
        phase = .verified(verified)
      }
    case .aborted(let error):
      phase = .terminal(.aborted(override ?? error))
    case .cleanupFailed:
      phase = .terminal(.cleanupFailed)
    }
  }

  private func settleAbort(_ operation: AbortOperation) async {
    let cleaned = await operation.task.value
    guard case .aborting = phase else { return }
    phase = .terminal(cleaned ? .aborted(operation.reason) : .cleanupFailed)
  }

  private func settleCommit(_ operation: CommitOperation) async {
    let terminal = await operation.task.value
    guard case .committing = phase else { return }
    phase = .terminal(terminal)
  }

  private static func performAbort(
    authority: any BrokerCredentialLifecycleAuthority,
    context: BrokerOpenAIOnboardingStagingContext,
    operationID: UUID
  ) async -> Bool {
    await Task.detached {
      do {
        _ = try await authority.abort(
          connectionID: context.connectionID,
          attemptID: context.attemptID,
          operationID: operationID,
          expectedFence: context.fence
        )
        return true
      } catch {
        return false
      }
    }.value
  }

  private static func validated(
    _ catalog: BrokerOpenAIModelCatalog
  ) -> VerifiedCatalog? {
    guard !catalog.modelIDs.isEmpty, catalog.modelIDs.count <= 4_096 else { return nil }
    if let requestID = catalog.requestID {
      guard
        (1...256).contains(requestID.utf8.count),
        requestID.utf8.allSatisfy({ (0x21...0x7e).contains($0) })
      else {
        return nil
      }
    }
    var exactModelIDs = Set<Data>()
    var previous: Data?
    for modelID in catalog.modelIDs {
      guard (1...256).contains(modelID.utf8.count) else { return nil }
      let bytes = Data(modelID.utf8)
      guard
        !bytes.contains(where: { $0 < 0x20 || $0 == 0x7f }),
        exactModelIDs.insert(bytes).inserted
      else {
        return nil
      }
      if let previous, !previous.lexicographicallyPrecedes(bytes) {
        return nil
      }
      previous = bytes
    }
    return VerifiedCatalog(catalog: catalog, exactModelIDs: exactModelIDs)
  }

  private static func isProvenPrelinearization(_ error: BrokerStateError) -> Bool {
    switch error {
    case .cancelled, .connectionNotFound, .connectionTombstoned, .staleFence,
      .fenceOverflow, .generationOverflow, .invalidTransition, .attemptNotCurrent,
      .operationIDConflict, .storeUnavailable:
      true
    case .cleanupPending, .operationInProgress, .invalidBootstrap:
      false
    }
  }
}
