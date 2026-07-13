import Foundation
import Testing

@testable import RecursBrokerCore
@testable import RecursBrokerService

@Suite("Broker OpenAI onboarding session")
struct BrokerOpenAIOnboardingSessionTests {
  private let now = Date(timeIntervalSince1970: 1_800_000_000)

  @Test
  func verifiesOnceThenCommitsTheExactSelectedModelOnce() async throws {
    let catalog = BrokerOpenAIModelCatalog(
      modelIDs: ["gpt-5", "gpt-5-mini"],
      requestID: "request-123"
    )
    let fetcher = OnboardingCatalogFetcher(result: .success(catalog))
    let authority = OnboardingAuthority(commitResult: .success(readyProjection))
    let session = try makeSession(authority: authority, fetcher: fetcher)

    #expect(try await session.verify() == catalog)
    #expect(try await session.verify() == catalog)
    let receipt = try await session.finalize(
      exactModelID: "gpt-5",
      operationID: commitOperationID
    )
    #expect(
      try await session.finalize(
        exactModelID: "gpt-5",
        operationID: commitOperationID
      ) == receipt
    )
    try await session.close()
    try await session.abort()

    #expect(receipt.ready == readyProjection)
    #expect(receipt.selectedModelID == "gpt-5")
    #expect(receipt.catalogRequestID == "request-123")
    #expect(receipt.verifiedModelCount == 2)
    #expect(await fetcher.fetchCount == 1)
    #expect(await fetcher.lastContext == context)
    #expect(await fetcher.lastExpiresAt == now.addingTimeInterval(60))
    #expect(
      await authority.commitCalls == [
        LifecycleCall(
          connectionID: context.connectionID,
          attemptID: context.attemptID,
          operationID: commitOperationID,
          expectedFence: context.fence
        )
      ])
    #expect(await authority.abortCalls.isEmpty)
  }

  @Test
  func modelSelectionUsesExactCatalogMembershipAndFailsClosed() async throws {
    let fetcher = OnboardingCatalogFetcher(
      result: .success(
        BrokerOpenAIModelCatalog(modelIDs: ["GPT-5", "gpt-5"], requestID: nil)
      )
    )
    let authority = OnboardingAuthority(commitResult: .success(readyProjection))
    let session = try makeSession(authority: authority, fetcher: fetcher)
    _ = try await session.verify()

    await #expect(throws: BrokerOpenAIOnboardingError.invalidModel) {
      _ = try await session.finalize(
        exactModelID: "gpt-5 ",
        operationID: commitOperationID
      )
    }

    #expect(await authority.commitCalls.isEmpty)
    #expect(await authority.abortCalls == [expectedAbortCall])
  }

  @Test
  func oversizedModelSelectionIsRejectedBeforeCommit() async throws {
    let fetcher = OnboardingCatalogFetcher(
      result: .success(BrokerOpenAIModelCatalog(modelIDs: ["gpt-5"], requestID: nil))
    )
    let authority = OnboardingAuthority(commitResult: .success(readyProjection))
    let session = try makeSession(authority: authority, fetcher: fetcher)
    _ = try await session.verify()

    await #expect(throws: BrokerOpenAIOnboardingError.invalidModel) {
      _ = try await session.finalize(
        exactModelID: String(repeating: "x", count: 257),
        operationID: commitOperationID
      )
    }

    #expect(await authority.commitCalls.isEmpty)
    #expect(await authority.abortCalls == [expectedAbortCall])
  }

  @Test
  func verificationFailureAbortsTheOwnedAttemptAndDoesNotReflectItsError() async throws {
    let canary = "secret-provider-error-canary"
    let fetcher = OnboardingCatalogFetcher(result: .failure(.provider(canary)))
    let authority = OnboardingAuthority(commitResult: .success(readyProjection))
    let session = try makeSession(authority: authority, fetcher: fetcher)

    do {
      _ = try await session.verify()
      Issue.record("Expected verification to fail.")
    } catch let error {
      #expect(error == .verificationFailed)
      #expect(!error.description.contains(canary))
    }

    #expect(await authority.abortCalls == [expectedAbortCall])
    #expect(await authority.commitCalls.isEmpty)
  }

  @Test
  func cancellingVerificationCancelsFetchThenAwaitsAbort() async throws {
    let fetcher = OnboardingCatalogFetcher(result: .suspended)
    let authority = OnboardingAuthority(commitResult: .success(readyProjection))
    let session = try makeSession(authority: authority, fetcher: fetcher)
    let verification = Task { try await session.verify() }
    await fetcher.waitUntilFetched()

    verification.cancel()

    await #expect(throws: BrokerOpenAIOnboardingError.cancelled) {
      _ = try await verification.value
    }
    #expect(await fetcher.observedCancellation)
    #expect(await authority.abortCalls == [expectedAbortCall])
  }

  @Test
  func closeAbortsAnUnverifiedStagingAttemptIdempotently() async throws {
    let authority = OnboardingAuthority(commitResult: .success(readyProjection))
    let session = try makeSession(
      authority: authority,
      fetcher: OnboardingCatalogFetcher(result: .success(emptyCatalog))
    )

    try await session.close()
    try await session.close()
    try await session.abort()

    #expect(await authority.abortCalls == [expectedAbortCall])
    #expect(await authority.commitCalls.isEmpty)
  }

  @Test
  func closeAbortsAnAlreadyVerifiedAttempt() async throws {
    let authority = OnboardingAuthority(commitResult: .success(readyProjection))
    let session = try makeSession(
      authority: authority,
      fetcher: OnboardingCatalogFetcher(
        result: .success(BrokerOpenAIModelCatalog(modelIDs: ["gpt-5"], requestID: nil))
      )
    )
    _ = try await session.verify()

    try await session.close()

    #expect(await authority.abortCalls == [expectedAbortCall])
    #expect(await authority.commitCalls.isEmpty)
  }

  @Test
  func closeDuringPausedCommitWaitsForCommitAndNeverRacesAbort() async throws {
    let pause = OnboardingPause()
    let authority = OnboardingAuthority(
      commitResult: .paused(readyProjection, pause)
    )
    let session = try makeSession(
      authority: authority,
      fetcher: OnboardingCatalogFetcher(
        result: .success(BrokerOpenAIModelCatalog(modelIDs: ["gpt-5"], requestID: nil))
      )
    )
    _ = try await session.verify()
    let finalize = Task {
      try await session.finalize(
        exactModelID: "gpt-5",
        operationID: commitOperationID
      )
    }
    await pause.waitUntilEntered()

    let close = Task { try await session.close() }
    try await Task.sleep(for: .milliseconds(20))
    #expect(await authority.abortCalls.isEmpty)
    await pause.release()

    #expect(try await finalize.value.ready == readyProjection)
    try await close.value
    #expect(await authority.commitCalls.count == 1)
    #expect(await authority.abortCalls.isEmpty)
  }

  @Test
  func callerCancellationAfterCommitStartsCannotUndoCommittedReceipt() async throws {
    let pause = OnboardingPause()
    let authority = OnboardingAuthority(
      commitResult: .paused(readyProjection, pause)
    )
    let session = try makeSession(
      authority: authority,
      fetcher: OnboardingCatalogFetcher(
        result: .success(BrokerOpenAIModelCatalog(modelIDs: ["gpt-5"], requestID: nil))
      )
    )
    _ = try await session.verify()
    let finalize = Task {
      try await session.finalize(
        exactModelID: "gpt-5",
        operationID: commitOperationID
      )
    }
    await pause.waitUntilEntered()

    finalize.cancel()
    await pause.release()

    #expect(try await finalize.value.ready == readyProjection)
    #expect(await authority.commitCalls.count == 1)
    #expect(await authority.abortCalls.isEmpty)
  }

  @Test
  func provenPrelinearizationCommitFailureRunsOneOwnedAbort() async throws {
    let authority = OnboardingAuthority(commitResult: .failure(.invalidTransition))
    let session = try makeSession(
      authority: authority,
      fetcher: OnboardingCatalogFetcher(
        result: .success(BrokerOpenAIModelCatalog(modelIDs: ["gpt-5"], requestID: nil))
      )
    )
    _ = try await session.verify()

    await #expect(throws: BrokerOpenAIOnboardingError.commitFailed) {
      _ = try await session.finalize(
        exactModelID: "gpt-5",
        operationID: commitOperationID
      )
    }

    #expect(await authority.commitCalls.count == 1)
    #expect(await authority.abortCalls == [expectedAbortCall])
  }

  @Test
  func storeUnavailableCommitFailureRunsOneOwnedAbort() async throws {
    let authority = OnboardingAuthority(commitResult: .failure(.storeUnavailable))
    let session = try makeSession(
      authority: authority,
      fetcher: OnboardingCatalogFetcher(
        result: .success(BrokerOpenAIModelCatalog(modelIDs: ["gpt-5"], requestID: nil))
      )
    )
    _ = try await session.verify()

    await #expect(throws: BrokerOpenAIOnboardingError.commitFailed) {
      _ = try await session.finalize(
        exactModelID: "gpt-5",
        operationID: commitOperationID
      )
    }

    #expect(await authority.commitCalls.count == 1)
    #expect(await authority.abortCalls == [expectedAbortCall])
  }

  @Test
  func concurrentCommitOutcomeRequiresReconciliationWithoutAbort() async throws {
    let authority = OnboardingAuthority(commitResult: .failure(.operationInProgress))
    let session = try makeSession(
      authority: authority,
      fetcher: OnboardingCatalogFetcher(
        result: .success(BrokerOpenAIModelCatalog(modelIDs: ["gpt-5"], requestID: nil))
      )
    )
    _ = try await session.verify()

    await #expect(throws: BrokerOpenAIOnboardingError.reconciliationRequired) {
      _ = try await session.finalize(
        exactModelID: "gpt-5",
        operationID: commitOperationID
      )
    }

    #expect(await authority.commitCalls.count == 1)
    #expect(await authority.abortCalls.isEmpty)
  }

  @Test
  func invalidBootstrapCommitOutcomeRequiresReconciliationWithoutAbort() async throws {
    let authority = OnboardingAuthority(commitResult: .failure(.invalidBootstrap))
    let session = try makeSession(
      authority: authority,
      fetcher: OnboardingCatalogFetcher(
        result: .success(BrokerOpenAIModelCatalog(modelIDs: ["gpt-5"], requestID: nil))
      )
    )
    _ = try await session.verify()

    await #expect(throws: BrokerOpenAIOnboardingError.reconciliationRequired) {
      _ = try await session.finalize(
        exactModelID: "gpt-5",
        operationID: commitOperationID
      )
    }

    #expect(await authority.commitCalls.count == 1)
    #expect(await authority.abortCalls.isEmpty)
  }

  @Test
  func uncertainCommitOutcomeNeverRacesAbortOrClaimsRollback() async throws {
    let authority = OnboardingAuthority(commitResult: .failure(.cleanupPending))
    let session = try makeSession(
      authority: authority,
      fetcher: OnboardingCatalogFetcher(
        result: .success(BrokerOpenAIModelCatalog(modelIDs: ["gpt-5"], requestID: nil))
      )
    )
    _ = try await session.verify()

    await #expect(throws: BrokerOpenAIOnboardingError.reconciliationRequired) {
      _ = try await session.finalize(
        exactModelID: "gpt-5",
        operationID: commitOperationID
      )
    }
    await #expect(throws: BrokerOpenAIOnboardingError.reconciliationRequired) {
      try await session.close()
    }

    #expect(await authority.commitCalls.count == 1)
    #expect(await authority.abortCalls.isEmpty)
  }

  @Test
  func cachedCatalogCannotCommitAfterTheSetupSessionExpires() async throws {
    let clock = OnboardingClock(now)
    let authority = OnboardingAuthority(commitResult: .success(readyProjection))
    let session = try makeSession(
      authority: authority,
      fetcher: OnboardingCatalogFetcher(
        result: .success(BrokerOpenAIModelCatalog(modelIDs: ["gpt-5"], requestID: nil))
      ),
      clock: clock
    )
    _ = try await session.verify()
    clock.advance(by: 61)

    await #expect(throws: BrokerOpenAIOnboardingError.expired) {
      _ = try await session.finalize(
        exactModelID: "gpt-5",
        operationID: commitOperationID
      )
    }

    #expect(await authority.commitCalls.isEmpty)
    #expect(await authority.abortCalls == [expectedAbortCall])
  }

  @Test
  func abortFailureIsFixedAndTerminalWithoutRepeatedCleanup() async throws {
    let authority = OnboardingAuthority(
      commitResult: .success(readyProjection),
      abortFailure: .storeUnavailable
    )
    let session = try makeSession(
      authority: authority,
      fetcher: OnboardingCatalogFetcher(result: .success(emptyCatalog))
    )

    await #expect(throws: BrokerOpenAIOnboardingError.cleanupFailed) {
      try await session.close()
    }
    await #expect(throws: BrokerOpenAIOnboardingError.cleanupFailed) {
      try await session.close()
    }

    #expect(await authority.abortCalls == [expectedAbortCall])
  }

  @Test
  func finalizeBeforeVerificationFailsClosed() async throws {
    let authority = OnboardingAuthority(commitResult: .success(readyProjection))
    let session = try makeSession(
      authority: authority,
      fetcher: OnboardingCatalogFetcher(result: .success(emptyCatalog))
    )

    await #expect(throws: BrokerOpenAIOnboardingError.invalidState) {
      _ = try await session.finalize(
        exactModelID: "gpt-5",
        operationID: commitOperationID
      )
    }

    #expect(await authority.abortCalls == [expectedAbortCall])
    #expect(await authority.commitCalls.isEmpty)
    await #expect(throws: BrokerOpenAIOnboardingError.invalidState) {
      _ = try await session.verify()
    }
  }

  @Test
  func reservedAbortOperationCannotBeReusedForCommit() async throws {
    let authority = OnboardingAuthority(commitResult: .success(readyProjection))
    let session = try makeSession(
      authority: authority,
      fetcher: OnboardingCatalogFetcher(
        result: .success(BrokerOpenAIModelCatalog(modelIDs: ["gpt-5"], requestID: nil))
      )
    )
    _ = try await session.verify()

    await #expect(throws: BrokerOpenAIOnboardingError.invalidState) {
      _ = try await session.finalize(
        exactModelID: "gpt-5",
        operationID: abortOperationID
      )
    }

    #expect(await authority.commitCalls.isEmpty)
    #expect(await authority.abortCalls == [expectedAbortCall])
  }

  @Test
  func constructionRejectsNonOpenAIOwnershipContext() async {
    let authority = OnboardingAuthority(commitResult: .success(readyProjection))

    #expect(throws: BrokerOpenAIOnboardingError.invalidContext) {
      _ = try BrokerOpenAIOnboardingSession(
        context: BrokerOpenAIOnboardingStagingContext(
          connectionID: context.connectionID,
          attemptID: context.attemptID,
          fence: context.fence,
          providerBinding: .anthropic
        ),
        abortOperationID: abortOperationID,
        authority: authority,
        catalogFetcher: OnboardingCatalogFetcher(result: .success(emptyCatalog)),
        clock: { self.now }
      )
    }
    #expect(await authority.abortCalls.isEmpty)
  }

  private func makeSession(
    authority: OnboardingAuthority,
    fetcher: OnboardingCatalogFetcher,
    clock: OnboardingClock? = nil
  ) throws -> BrokerOpenAIOnboardingSession {
    let selectedClock = clock ?? OnboardingClock(now)
    return try BrokerOpenAIOnboardingSession(
      context: context,
      abortOperationID: abortOperationID,
      authority: authority,
      catalogFetcher: fetcher,
      clock: { selectedClock.now }
    )
  }
}

private let context = BrokerOpenAIOnboardingStagingContext(
  connectionID: UUID(uuidString: "10000000-0000-4000-8000-000000000100")!,
  attemptID: UUID(uuidString: "20000000-0000-4000-8000-000000000100")!,
  fence: 4,
  providerBinding: .openAI
)
private let abortOperationID = UUID(
  uuidString: "30000000-0000-4000-8000-000000000100"
)!
private let commitOperationID = UUID(
  uuidString: "30000000-0000-4000-8000-000000000101"
)!
private let emptyCatalog = BrokerOpenAIModelCatalog(modelIDs: [], requestID: nil)
private let readyProjection = ReadyProjection(
  connectionID: context.connectionID,
  fence: context.fence,
  ready: ReadyGeneration(
    generation: CredentialGeneration(
      generationID: UUID(uuidString: "40000000-0000-4000-8000-000000000100")!,
      ordinal: 3,
      createdAt: Date(timeIntervalSince1970: 1_800_000_000)
    ),
    committedAt: Date(timeIntervalSince1970: 1_800_000_001)
  ),
  lastGenerationOrdinal: 3
)
private let expectedAbortCall = LifecycleCall(
  connectionID: context.connectionID,
  attemptID: context.attemptID,
  operationID: abortOperationID,
  expectedFence: context.fence
)

private struct LifecycleCall: Sendable, Equatable {
  let connectionID: UUID
  let attemptID: UUID
  let operationID: UUID
  let expectedFence: UInt64
}

private enum OnboardingCatalogResult: Sendable {
  case success(BrokerOpenAIModelCatalog)
  case failure(OnboardingCatalogFailure)
  case suspended
}

private enum OnboardingCatalogFailure: Error, Sendable {
  case provider(String)
}

private actor OnboardingCatalogFetcher: BrokerOpenAISetupCatalogFetching {
  private let result: OnboardingCatalogResult
  private(set) var fetchCount = 0
  private(set) var lastContext: BrokerOpenAIOnboardingStagingContext?
  private(set) var lastExpiresAt: Date?
  private(set) var observedCancellation = false

  init(result: OnboardingCatalogResult) {
    self.result = result
  }

  func fetchSetupCatalog(
    context: BrokerOpenAIOnboardingStagingContext,
    expiresAt: Date
  ) async throws -> BrokerOpenAIModelCatalog {
    fetchCount += 1
    lastContext = context
    lastExpiresAt = expiresAt
    switch result {
    case .success(let catalog):
      return catalog
    case .failure(let error):
      throw error
    case .suspended:
      do {
        try await Task.sleep(for: .seconds(60))
        throw OnboardingCatalogFailure.provider("unexpected release")
      } catch is CancellationError {
        observedCancellation = true
        throw CancellationError()
      }
    }
  }

  func waitUntilFetched() async {
    while fetchCount == 0 {
      await Task.yield()
    }
  }
}

private enum OnboardingCommitResult: Sendable {
  case success(ReadyProjection)
  case failure(BrokerStateError)
  case paused(ReadyProjection, OnboardingPause)
}

private actor OnboardingAuthority: BrokerCredentialLifecycleAuthority {
  private let commitResult: OnboardingCommitResult
  private let abortFailure: BrokerStateError?
  private(set) var commitCalls: [LifecycleCall] = []
  private(set) var abortCalls: [LifecycleCall] = []

  init(
    commitResult: OnboardingCommitResult,
    abortFailure: BrokerStateError? = nil
  ) {
    self.commitResult = commitResult
    self.abortFailure = abortFailure
  }

  func authoritativeLifecycleProjection(
    for connectionID: UUID
  ) async throws(BrokerJournalError) -> CredentialLifecycleProjection {
    .staging(
      connectionID: connectionID,
      fence: context.fence,
      attemptID: context.attemptID,
      hasUsableReady: false
    )
  }

  nonisolated func stage(
    connectionID: UUID,
    providerBinding: ProviderProfileBinding,
    operationID: UUID,
    expectedFence: UInt64,
    secret: sending SecretBytes
  ) async throws(BrokerStateError) -> StagingAttempt {
    secret.erase()
    throw .invalidTransition
  }

  func resumeStage(
    connectionID: UUID,
    operationID: UUID,
    expectedFence: UInt64
  ) async throws(BrokerStateError) -> StagingAttempt {
    throw .invalidTransition
  }

  func commit(
    connectionID: UUID,
    attemptID: UUID,
    operationID: UUID,
    expectedFence: UInt64
  ) async throws(BrokerStateError) -> ReadyProjection {
    commitCalls.append(
      LifecycleCall(
        connectionID: connectionID,
        attemptID: attemptID,
        operationID: operationID,
        expectedFence: expectedFence
      )
    )
    switch commitResult {
    case .success(let ready):
      return ready
    case .failure(let error):
      throw error
    case .paused(let ready, let pause):
      await pause.enter()
      return ready
    }
  }

  func abort(
    connectionID: UUID,
    attemptID: UUID,
    operationID: UUID,
    expectedFence: UInt64
  ) async throws(BrokerStateError) -> ReadyProjection? {
    abortCalls.append(
      LifecycleCall(
        connectionID: connectionID,
        attemptID: attemptID,
        operationID: operationID,
        expectedFence: expectedFence
      )
    )
    if let abortFailure { throw abortFailure }
    return nil
  }

  func disconnect(
    connectionID: UUID,
    operationID: UUID,
    expectedFence: UInt64
  ) async throws(BrokerStateError) -> TombstoneProjection {
    throw .invalidTransition
  }
}

private final class OnboardingClock: @unchecked Sendable {
  private let lock = NSLock()
  private var current: Date

  init(_ current: Date) {
    self.current = current
  }

  var now: Date { lock.withLock { current } }

  func advance(by interval: TimeInterval) {
    lock.withLock {
      current = current.addingTimeInterval(interval)
    }
  }
}

private actor OnboardingPause {
  private var entered = false
  private var released = false
  private var enteredWaiters: [CheckedContinuation<Void, Never>] = []
  private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

  func enter() async {
    entered = true
    let selected = enteredWaiters
    enteredWaiters.removeAll()
    for waiter in selected { waiter.resume() }
    guard !released else { return }
    await withCheckedContinuation { continuation in
      releaseWaiters.append(continuation)
    }
  }

  func waitUntilEntered() async {
    guard !entered else { return }
    await withCheckedContinuation { continuation in
      enteredWaiters.append(continuation)
    }
  }

  func release() {
    released = true
    let selected = releaseWaiters
    releaseWaiters.removeAll()
    for waiter in selected { waiter.resume() }
  }
}
