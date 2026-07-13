import Foundation
import Testing

@testable import RecursBrokerCore
@testable import RecursBrokerService

@Suite
struct BrokerProviderRouteAuthorityTests {
  private let connectionID = UUID(uuidString: "a1000000-0000-4000-8000-000000000001")!
  private let now = Date(timeIntervalSince1970: 1_000)

  @Test
  func handlesAndReceiptsAreOpaqueAndScopeIsExactBeforeRead() async throws {
    let reader = RouteProjectionReader(
      projection: bound(.openAI, .staging(stagingAttempt()))
    )
    let authority = routeAuthority(reader: reader)
    let handle = try await authority.issue(
      scope: .setup,
      connectionID: connectionID,
      expiresAt: now.addingTimeInterval(60),
      requestBudget: 2,
      byteBudget: 8
    )
    let readsAfterIssue = await reader.readCount

    await #expect(throws: BrokerProviderRouteAuthorityError.wrongScope) {
      _ = try await authority.authorize(
        handle,
        expectedScope: .run,
        requestBytes: 1
      )
    }
    #expect(await reader.readCount == readsAfterIssue)

    let receipt = try await authority.authorize(
      handle,
      expectedScope: .setup,
      requestBytes: 1
    )
    #expect(Array(Mirror(reflecting: handle).children).isEmpty)
    #expect(Array(Mirror(reflecting: receipt).children).isEmpty)
    #expect(String(describing: handle) == "Broker provider route capability.")
    #expect(String(reflecting: handle) == "Broker provider route capability.")
    #expect(String(describing: receipt) == "Broker provider route authorization receipt.")
    #expect(String(reflecting: receipt) == "Broker provider route authorization receipt.")
    #expect(!((handle as Any) is any Encodable))
    #expect(!((handle as Any) is AnyHashable))
    #expect(!((receipt as Any) is any Encodable))
    #expect(!((receipt as Any) is AnyHashable))
  }

  @Test
  func reconnectScopesBindCandidateOrUsableReadyExactly() async throws {
    let prior = readyGeneration(ordinal: 1)
    let reconnect = stagingAttempt(
      fence: 2,
      candidate: generation(ordinal: 2),
      previousReady: prior
    )
    let reader = RouteProjectionReader(projection: bound(.anthropic, .staging(reconnect)))
    let authority = routeAuthority(reader: reader)

    let setup = try await issue(.setup, from: authority)
    let run = try await issue(.run, from: authority)
    let maintenance = try await issue(.maintenance, from: authority)

    _ = try await authority.authorize(setup, expectedScope: .setup, requestBytes: 1)
    _ = try await authority.authorize(run, expectedScope: .run, requestBytes: 1)
    _ = try await authority.authorize(
      maintenance,
      expectedScope: .maintenance,
      requestBytes: 1
    )

    await reader.setProjection(
      bound(
        .anthropic,
        .staging(
          stagingAttempt(
            fence: 2,
            candidate: generation(ordinal: 3),
            previousReady: prior
          )
        )
      )
    )
    await #expect(throws: BrokerProviderRouteAuthorityError.staleCapability) {
      _ = try await authority.authorize(setup, expectedScope: .setup, requestBytes: 1)
    }
    _ = try await authority.authorize(run, expectedScope: .run, requestBytes: 1)
    _ = try await authority.authorize(
      maintenance,
      expectedScope: .maintenance,
      requestBytes: 1
    )

    let noReadyReader = RouteProjectionReader(
      projection: bound(.openAI, .staging(stagingAttempt(previousReady: nil)))
    )
    let noReadyAuthority = routeAuthority(reader: noReadyReader)
    _ = try await issue(.setup, from: noReadyAuthority)
    await #expect(throws: BrokerProviderRouteAuthorityError.authorityUnavailable) {
      _ = try await issue(.run, from: noReadyAuthority)
    }
    await #expect(throws: BrokerProviderRouteAuthorityError.authorityUnavailable) {
      _ = try await issue(.maintenance, from: noReadyAuthority)
    }
  }

  @Test
  func stableReadySupportsOnlyRunAndMaintenance() async throws {
    let ready = ReadyProjection(
      connectionID: connectionID,
      fence: 1,
      ready: readyGeneration(),
      lastGenerationOrdinal: 1
    )
    let reader = RouteProjectionReader(projection: bound(.kimiCode, .ready(ready)))
    let authority = routeAuthority(reader: reader)

    await #expect(throws: BrokerProviderRouteAuthorityError.authorityUnavailable) {
      _ = try await issue(.setup, from: authority)
    }
    for scope in [BrokerProviderRouteScope.run, .maintenance] {
      let handle = try await issue(scope, from: authority)
      _ = try await authority.authorize(
        handle,
        expectedScope: scope,
        requestBytes: 1
      )
    }
  }

  @Test
  func endpointBindingDerivesHardRoutesAndMissingCatalogFailsClosed() async throws {
    let binding = try ProviderProfileBinding.customOpenAICompatible(
      baseURL: "https://inference.vendor.dev/v1",
      modelCatalogBehavior: .unavailable
    )
    let reader = RouteProjectionReader(
      projection: bound(binding, .staging(stagingAttempt(previousReady: readyGeneration())))
    )
    let authority = routeAuthority(reader: reader)

    await #expect(throws: BrokerProviderRouteAuthorityError.routeUnavailable) {
      _ = try await issue(.setup, from: authority)
    }
    await #expect(throws: BrokerProviderRouteAuthorityError.routeUnavailable) {
      _ = try await issue(.maintenance, from: authority)
    }
    let run = try await issue(.run, from: authority)
    _ = try await authority.authorize(run, expectedScope: .run, requestBytes: 1)
  }

  @Test
  func setupRechecksBindingFenceAttemptAndCandidateAfterAwait() async throws {
    for mutation in SetupMutation.allCases {
      let original = stagingAttempt()
      let reader = RouteProjectionReader(projection: bound(.openAI, .staging(original)))
      let authority = routeAuthority(reader: reader)
      let handle = try await issue(.setup, from: authority)
      await reader.blockNextReads(1)

      let task = Task {
        try await authority.authorize(handle, expectedScope: .setup, requestBytes: 1)
      }
      await reader.waitUntilBlocked()
      await reader.setProjection(mutation.apply(to: original, connectionID: connectionID))
      await reader.releaseBlockedReads()

      await #expect(throws: BrokerProviderRouteAuthorityError.staleCapability) {
        _ = try await task.value
      }
    }
  }

  @Test
  func usableReadyScopesRecheckBindingFenceAndReadyButNeverCandidate() async throws {
    let prior = readyGeneration(ordinal: 1)
    let original = stagingAttempt(
      fence: 2,
      candidate: generation(ordinal: 2),
      previousReady: prior
    )

    for scope in [BrokerProviderRouteScope.run, .maintenance] {
      for mutation in RunMutation.allCases {
        let reader = RouteProjectionReader(projection: bound(.openAI, .staging(original)))
        let authority = routeAuthority(reader: reader)
        let handle = try await issue(scope, from: authority)
        await reader.blockNextReads(1)

        let task = Task {
          try await authority.authorize(handle, expectedScope: scope, requestBytes: 1)
        }
        await reader.waitUntilBlocked()
        await reader.setProjection(mutation.apply(to: original, connectionID: connectionID))
        await reader.releaseBlockedReads()

        if mutation == .candidate {
          _ = try await task.value
        } else {
          await #expect(throws: BrokerProviderRouteAuthorityError.staleCapability) {
            _ = try await task.value
          }
        }
      }
    }
  }

  @Test
  func cancellationTaskCancellationExpiryAndCloseWinAcrossAwait() async throws {
    for interruption in Interruption.allCases {
      let clock = RouteTestClock(now)
      let reader = RouteProjectionReader(
        projection: bound(.openAI, .staging(stagingAttempt()))
      )
      let authority = BrokerProviderRouteAuthority(reader: reader, clock: clock.now)
      let handle = try await issue(.setup, from: authority)
      await reader.blockNextReads(1)
      let task = Task {
        try await authority.authorize(handle, expectedScope: .setup, requestBytes: 1)
      }
      await reader.waitUntilBlocked()

      switch interruption {
      case .capabilityCancellation:
        await authority.cancel(handle)
      case .taskCancellation:
        task.cancel()
      case .expiry:
        clock.set(now.addingTimeInterval(61))
      case .close:
        await authority.close()
      }
      await reader.releaseBlockedReads()

      await #expect(throws: interruption.expectedError) {
        _ = try await task.value
      }
    }
  }

  @Test
  func issuanceRechecksTaskCancellationExpiryAndCloseAcrossAwaitAndBeforeRead() async throws {
    for interruption in IssuanceInterruption.allCases {
      let clock = RouteTestClock(now)
      let reader = RouteProjectionReader(
        projection: bound(.openAI, .staging(stagingAttempt()))
      )
      let authority = BrokerProviderRouteAuthority(reader: reader, clock: clock.now)
      await reader.blockNextReads(1)
      let task = Task {
        try await authority.issue(
          scope: .setup,
          connectionID: connectionID,
          expiresAt: now.addingTimeInterval(60),
          requestBudget: 1,
          byteBudget: 1
        )
      }
      await reader.waitUntilBlocked()
      switch interruption {
      case .taskCancellation:
        task.cancel()
      case .expiry:
        clock.set(now.addingTimeInterval(61))
      case .close:
        await authority.close()
      }
      await reader.releaseBlockedReads()
      await #expect(throws: interruption.expectedError) {
        _ = try await task.value
      }
    }

    let reader = RouteProjectionReader(
      projection: bound(.openAI, .staging(stagingAttempt()))
    )
    let expired = routeAuthority(reader: reader)
    await #expect(throws: BrokerProviderRouteAuthorityError.expired) {
      _ = try await expired.issue(
        scope: .setup,
        connectionID: connectionID,
        expiresAt: now,
        requestBudget: 1,
        byteBudget: 1
      )
    }
    let closed = routeAuthority(reader: reader)
    await closed.close()
    await #expect(throws: BrokerProviderRouteAuthorityError.closed) {
      _ = try await issue(.setup, from: closed)
    }
    let cancelled = routeAuthority(reader: reader)
    let cancelledTask = Task {
      withUnsafeCurrentTask { $0?.cancel() }
      return try await issue(.setup, from: cancelled)
    }
    await #expect(throws: BrokerProviderRouteAuthorityError.cancelled) {
      _ = try await cancelledTask.value
    }
    #expect(await reader.readCount == 0)
  }

  @Test
  func requestAndCheckedByteBudgetsFailBeforeAnotherRead() async throws {
    let reader = RouteProjectionReader(
      projection: bound(.openAI, .staging(stagingAttempt()))
    )
    let authority = routeAuthority(reader: reader)
    let requests = try await authority.issue(
      scope: .setup,
      connectionID: connectionID,
      expiresAt: now.addingTimeInterval(60),
      requestBudget: 1,
      byteBudget: 8
    )
    _ = try await authority.authorize(requests, expectedScope: .setup, requestBytes: 1)
    let readsAfterRequest = await reader.readCount
    await #expect(throws: BrokerProviderRouteAuthorityError.requestBudgetExceeded) {
      _ = try await authority.authorize(requests, expectedScope: .setup, requestBytes: 1)
    }
    #expect(await reader.readCount == readsAfterRequest)

    let bytes = try await authority.issue(
      scope: .setup,
      connectionID: connectionID,
      expiresAt: now.addingTimeInterval(60),
      requestBudget: 3,
      byteBudget: .max
    )
    _ = try await authority.authorize(bytes, expectedScope: .setup, requestBytes: 1)
    let readsAfterByte = await reader.readCount
    await #expect(throws: BrokerProviderRouteAuthorityError.byteBudgetExceeded) {
      _ = try await authority.authorize(bytes, expectedScope: .setup, requestBytes: .max)
    }
    #expect(await reader.readCount == readsAfterByte)
  }

  @Test
  func concurrentFinalPermitIsDebitedAtomically() async throws {
    for race in BudgetRace.allCases {
      let reader = RouteProjectionReader(
        projection: bound(.openAI, .staging(stagingAttempt()))
      )
      let authority = routeAuthority(reader: reader)
      let handle = try await authority.issue(
        scope: .setup,
        connectionID: connectionID,
        expiresAt: now.addingTimeInterval(60),
        requestBudget: race.requestBudget,
        byteBudget: race.byteBudget
      )
      await reader.blockNextReads(2)

      let first = Task { await authorizationResult(authority, handle) }
      let second = Task { await authorizationResult(authority, handle) }
      await reader.waitUntilBlocked()
      await reader.releaseBlockedReads()
      let results = await [first.value, second.value]

      #expect(results.filter(\.isSuccess).count == 1)
      #expect(results.compactMap(\.failure) == [race.expectedError])
    }
  }

  @Test
  func journalFailuresAndForeignHandlesFailWithFixedSafeErrors() async throws {
    let reader = RouteProjectionReader(
      projection: bound(.openAI, .staging(stagingAttempt()))
    )
    let authority = routeAuthority(reader: reader)
    let handle = try await issue(.setup, from: authority)
    await reader.setFailure(.authenticationFailed)

    await #expect(throws: BrokerProviderRouteAuthorityError.authorityUnavailable) {
      _ = try await authority.authorize(handle, expectedScope: .setup, requestBytes: 1)
    }

    let otherReader = RouteProjectionReader(
      projection: bound(.openAI, .staging(stagingAttempt()))
    )
    let other = routeAuthority(reader: otherReader)
    let readsBeforeForeignHandle = await otherReader.readCount
    await #expect(throws: BrokerProviderRouteAuthorityError.invalidCapability) {
      _ = try await other.authorize(handle, expectedScope: .setup, requestBytes: 1)
    }
    #expect(await otherReader.readCount == readsBeforeForeignHandle)

    let errors: [BrokerProviderRouteAuthorityError] = [
      .cancelled, .closed, .expired, .invalidCapability, .wrongScope,
      .staleCapability, .authorityUnavailable, .routeUnavailable,
      .requestBudgetExceeded, .byteBudgetExceeded,
    ]
    for error in errors {
      #expect(error.description == error.debugDescription)
      #expect(error.errorDescription == error.description)
      #expect(!error.description.contains(connectionID.uuidString))
      #expect(!error.description.contains("openai"))
      #expect(!error.description.contains("https"))
    }
  }

  private func routeAuthority(
    reader: RouteProjectionReader
  ) -> BrokerProviderRouteAuthority {
    BrokerProviderRouteAuthority(reader: reader, clock: { now })
  }

  private func issue(
    _ scope: BrokerProviderRouteScope,
    from authority: BrokerProviderRouteAuthority
  ) async throws -> BrokerProviderRouteCapability {
    try await authority.issue(
      scope: scope,
      connectionID: connectionID,
      expiresAt: now.addingTimeInterval(60),
      requestBudget: 4,
      byteBudget: 64
    )
  }

  private func bound(
    _ binding: ProviderProfileBinding,
    _ projection: CredentialProjection
  ) -> BrokerCredentialBoundProjection {
    BrokerCredentialBoundProjection(providerBinding: binding, projection: projection)
  }

  private func stagingAttempt(
    fence: UInt64 = 1,
    candidate: CredentialGeneration? = nil,
    previousReady: ReadyGeneration? = nil,
    attemptID: UUID = UUID(uuidString: "a2000000-0000-4000-8000-000000000001")!
  ) -> StagingAttempt {
    StagingAttempt(
      connectionID: connectionID,
      attemptID: attemptID,
      fence: fence,
      candidate: candidate ?? generation(ordinal: fence),
      previousReady: previousReady,
      startedAt: now
    )
  }

  private func generation(ordinal: UInt64 = 1) -> CredentialGeneration {
    CredentialGeneration(
      generationID: UUID(
        uuidString: String(format: "a3000000-0000-4000-8000-%012llu", ordinal)
      )!,
      ordinal: ordinal,
      createdAt: now
    )
  }

  private func readyGeneration(ordinal: UInt64 = 1) -> ReadyGeneration {
    ReadyGeneration(generation: generation(ordinal: ordinal), committedAt: now)
  }

  private func authorizationResult(
    _ authority: BrokerProviderRouteAuthority,
    _ handle: BrokerProviderRouteCapability
  ) async -> Result<BrokerProviderRouteAuthorizationReceipt, BrokerProviderRouteAuthorityError> {
    do {
      return .success(
        try await authority.authorize(handle, expectedScope: .setup, requestBytes: 1)
      )
    } catch let error {
      return .failure(error)
    }
  }
}

private enum SetupMutation: CaseIterable {
  case binding
  case fence
  case attempt
  case candidate

  func apply(
    to attempt: StagingAttempt,
    connectionID: UUID
  ) -> BrokerCredentialBoundProjection {
    let binding: ProviderProfileBinding = self == .binding ? .anthropic : .openAI
    let selected = StagingAttempt(
      connectionID: connectionID,
      attemptID: self == .attempt
        ? UUID(uuidString: "a2000000-0000-4000-8000-000000000099")! : attempt.attemptID,
      fence: self == .fence ? attempt.fence + 1 : attempt.fence,
      candidate: self == .candidate
        ? CredentialGeneration(
          generationID: UUID(uuidString: "a3000000-0000-4000-8000-000000000099")!,
          ordinal: attempt.candidate.ordinal,
          createdAt: attempt.candidate.createdAt
        ) : attempt.candidate,
      previousReady: attempt.previousReady,
      startedAt: attempt.startedAt
    )
    return BrokerCredentialBoundProjection(
      providerBinding: binding,
      projection: .staging(selected)
    )
  }
}

private enum RunMutation: CaseIterable, Equatable {
  case binding
  case candidate
  case fence
  case usableReady

  func apply(
    to attempt: StagingAttempt,
    connectionID: UUID
  ) -> BrokerCredentialBoundProjection {
    let selected = StagingAttempt(
      connectionID: connectionID,
      attemptID: attempt.attemptID,
      fence: self == .fence ? attempt.fence + 1 : attempt.fence,
      candidate: self == .candidate
        ? CredentialGeneration(
          generationID: UUID(uuidString: "a3000000-0000-4000-8000-000000000098")!,
          ordinal: attempt.candidate.ordinal,
          createdAt: attempt.candidate.createdAt
        ) : attempt.candidate,
      previousReady: self == .usableReady
        ? ReadyGeneration(
          generation: CredentialGeneration(
            generationID: UUID(uuidString: "a3000000-0000-4000-8000-000000000097")!,
            ordinal: attempt.previousReady?.generation.ordinal ?? 1,
            createdAt: attempt.previousReady?.generation.createdAt ?? Date(timeIntervalSince1970: 1)
          ),
          committedAt: attempt.previousReady?.committedAt ?? Date(timeIntervalSince1970: 1)
        ) : attempt.previousReady,
      startedAt: attempt.startedAt
    )
    return BrokerCredentialBoundProjection(
      providerBinding: self == .binding ? .anthropic : .openAI,
      projection: .staging(selected)
    )
  }
}

private enum IssuanceInterruption: CaseIterable {
  case taskCancellation
  case expiry
  case close

  var expectedError: BrokerProviderRouteAuthorityError {
    switch self {
    case .taskCancellation: .cancelled
    case .expiry: .expired
    case .close: .closed
    }
  }
}

private enum BudgetRace: CaseIterable, Equatable {
  case request
  case byte

  var requestBudget: UInt64 { self == .request ? 1 : 2 }
  var byteBudget: UInt64 { self == .byte ? 1 : 2 }

  var expectedError: BrokerProviderRouteAuthorityError {
    self == .request ? .requestBudgetExceeded : .byteBudgetExceeded
  }
}

private enum Interruption: CaseIterable {
  case capabilityCancellation
  case taskCancellation
  case expiry
  case close

  var expectedError: BrokerProviderRouteAuthorityError {
    switch self {
    case .capabilityCancellation, .taskCancellation: .cancelled
    case .expiry: .expired
    case .close: .closed
    }
  }
}

private actor RouteProjectionReader: BrokerProviderRouteProjectionReader {
  private(set) var readCount = 0
  private var projection: BrokerCredentialBoundProjection?
  private var failure: BrokerJournalError?
  private var targetBlockedReads = 0
  private var blockedReads = 0
  private var blockedContinuations: [CheckedContinuation<Void, Never>] = []
  private var arrivalContinuations: [CheckedContinuation<Void, Never>] = []

  init(projection: BrokerCredentialBoundProjection?) {
    self.projection = projection
  }

  func authoritativeBoundProjection(
    for connectionID: UUID
  ) async throws(BrokerJournalError) -> BrokerCredentialBoundProjection? {
    _ = connectionID
    readCount += 1
    if blockedReads < targetBlockedReads {
      blockedReads += 1
      if blockedReads == targetBlockedReads {
        let arrivals = arrivalContinuations
        arrivalContinuations.removeAll()
        for continuation in arrivals { continuation.resume() }
      }
      await withCheckedContinuation { continuation in
        blockedContinuations.append(continuation)
      }
    }
    if let failure { throw failure }
    return projection
  }

  func setProjection(_ value: BrokerCredentialBoundProjection?) {
    projection = value
  }

  func setFailure(_ value: BrokerJournalError?) {
    failure = value
  }

  func blockNextReads(_ count: Int) {
    targetBlockedReads = count
    blockedReads = 0
  }

  func waitUntilBlocked() async {
    guard blockedReads < targetBlockedReads else { return }
    await withCheckedContinuation { arrivalContinuations.append($0) }
  }

  func releaseBlockedReads() {
    targetBlockedReads = 0
    blockedReads = 0
    let blocked = blockedContinuations
    blockedContinuations.removeAll()
    for continuation in blocked { continuation.resume() }
  }
}

private final class RouteTestClock: @unchecked Sendable {
  private let lock = NSLock()
  private var value: Date

  init(_ value: Date) {
    self.value = value
  }

  func now() -> Date {
    lock.withLock { value }
  }

  func set(_ value: Date) {
    lock.withLock { self.value = value }
  }
}

extension Result where Failure == BrokerProviderRouteAuthorityError {
  fileprivate var isSuccess: Bool {
    if case .success = self { true } else { false }
  }

  fileprivate var failure: Failure? {
    if case .failure(let error) = self { error } else { nil }
  }
}
