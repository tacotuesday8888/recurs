import Foundation
import Testing

@testable import RecursBrokerCore
@testable import RecursBrokerService

@Suite
struct BrokerProviderRouteAuthorityTests {
  private let connectionID = UUID(uuidString: "a1000000-0000-4000-8000-000000000001")!
  private let now = Date(timeIntervalSince1970: 1_000)

  @Test
  func handlesAndReservationsAreOpaqueAndScopeIsExactBeforeRead() async throws {
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
      _ = try await authority.reserveCredentialUse(
        handle,
        expectedScope: .run,
        requestBytes: 1
      )
    }
    #expect(await reader.readCount == readsAfterIssue)

    let reservation = try await authority.reserveCredentialUse(
      handle,
      expectedScope: .setup,
      requestBytes: 1
    )
    #expect(Array(Mirror(reflecting: handle).children).isEmpty)
    #expect(Array(Mirror(reflecting: reservation).children).isEmpty)
    #expect(String(describing: handle) == "Broker provider route capability.")
    #expect(String(reflecting: handle) == "Broker provider route capability.")
    #expect(String(describing: reservation) == "<provider-route-reservation>")
    #expect(String(reflecting: reservation) == "<provider-route-reservation>")
    #expect(!((handle as Any) is any Encodable))
    #expect(!((handle as Any) is AnyHashable))
    #expect(!((reservation as Any) is any Encodable))
    #expect(!((reservation as Any) is AnyHashable))
  }

  @Test
  func reserveRejectsWrongProviderBeforeReadSecretOrBudgetDebit() async throws {
    let reader = RouteProjectionReader(
      projection: bound(.openAI, .staging(stagingAttempt()))
    )
    let credentialAuthority = RouteCredentialAuthority(reader: reader)
    let authority = routeAuthority(
      reader: reader,
      credentialAuthority: credentialAuthority
    )
    let handle = try await authority.issue(
      scope: .setup,
      connectionID: connectionID,
      expiresAt: now.addingTimeInterval(60),
      requestBudget: 1,
      byteBudget: 1
    )
    let readsAfterIssue = await reader.readCount

    await #expect(throws: BrokerProviderRouteAuthorityError.wrongProvider) {
      _ = try await authority.reserveCredentialUse(
        handle,
        expectedScope: .setup,
        expectedProviderBinding: .anthropic,
        requestBytes: 1
      )
    }
    #expect(await reader.readCount == readsAfterIssue)
    #expect(await credentialAuthority.purposes.isEmpty)
    #expect(await credentialAuthority.lastSecretIsErased() == nil)
    #expect(
      BrokerProviderRouteAuthorityError.wrongProvider.description
        == "The provider route binding is invalid."
    )

    let retry = try await authority.reserveCredentialUse(
      handle,
      expectedScope: .setup,
      expectedProviderBinding: .openAI,
      requestBytes: 1
    )
    await authority.cancel(handle)
    #expect(await credentialAuthority.cancelCount == 1)
    #expect(await credentialAuthority.releaseCount == 1)
    _ = retry
  }

  @Test
  func startRejectsWrongProviderBeforeProjectionOrCredentialStart() async throws {
    let reader = RouteProjectionReader(
      projection: bound(.openAI, .staging(stagingAttempt()))
    )
    let credentialAuthority = RouteCredentialAuthority(reader: reader)
    let authority = routeAuthority(
      reader: reader,
      credentialAuthority: credentialAuthority
    )
    let handle = try await issue(.setup, from: authority)
    let reservation = try await authority.reserveCredentialUse(
      handle,
      expectedScope: .setup,
      expectedProviderBinding: .openAI,
      requestBytes: 1
    )
    let readsAfterReserve = await reader.readCount
    let probe = RouteStartProbe()

    await #expect(throws: BrokerProviderRouteAuthorityError.wrongProvider) {
      _ = try await startRouteUse(
        reservation,
        handle: handle,
        authority: authority,
        providerBinding: .anthropic,
        probe: probe
      )
    }
    #expect(await reader.readCount == readsAfterReserve)
    #expect(probe.count == 0)
    #expect(await credentialAuthority.startCount == 0)
    #expect(await credentialAuthority.cancelCount == 1)
    #expect(await credentialAuthority.releaseCount == 1)
    #expect(await credentialAuthority.lastSecretIsErased() == true)
  }

  @Test
  func rejectedPreparationMapsInvalidCredentialWithoutStarting() async throws {
    let reader = RouteProjectionReader(
      projection: bound(.openAI, .staging(stagingAttempt()))
    )
    let credentialAuthority = RouteCredentialAuthority(reader: reader)
    let authority = routeAuthority(
      reader: reader,
      credentialAuthority: credentialAuthority
    )
    let handle = try await issue(.setup, from: authority)
    let reservation = try await authority.reserveCredentialUse(
      handle,
      expectedScope: .setup,
      expectedProviderBinding: .openAI,
      requestBytes: 1
    )
    let probe = RouteStartProbe()

    await #expect(throws: BrokerProviderRouteAuthorityError.invalidCredential) {
      _ = try await authority.startCredentialUse(
        reservation,
        capability: handle,
        expectedScope: .setup,
        expectedProviderBinding: .openAI,
        requestBytes: 1,
        prepare: { _ in CredentialUsePreparation<Bool>.rejected },
        start: probe.record
      )
    }
    #expect(probe.count == 0)
    #expect(await credentialAuthority.startCount == 0)
    #expect(await credentialAuthority.cancelCount == 1)
    #expect(await credentialAuthority.releaseCount == 1)
    #expect(await credentialAuthority.lastSecretIsErased() == true)
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
    let credentialAuthority = RouteCredentialAuthority(reader: reader)
    let authority = routeAuthority(
      reader: reader,
      credentialAuthority: credentialAuthority
    )

    let setup = try await issue(.setup, from: authority)
    let run = try await issue(.run, from: authority)
    let maintenance = try await issue(.maintenance, from: authority)

    _ = try await authority.reserveCredentialUse(
      setup,
      expectedScope: .setup,
      expectedProviderBinding: .anthropic,
      requestBytes: 1
    )
    _ = try await authority.reserveCredentialUse(
      run,
      expectedScope: .run,
      expectedProviderBinding: .anthropic,
      requestBytes: 1
    )
    _ = try await authority.reserveCredentialUse(
      maintenance,
      expectedScope: .maintenance,
      expectedProviderBinding: .anthropic,
      requestBytes: 1
    )
    #expect(
      await credentialAuthority.purposes
        == [.stagingCandidate, .usableReady, .usableReady]
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
      _ = try await authority.reserveCredentialUse(
        setup,
        expectedScope: .setup,
        expectedProviderBinding: .anthropic,
        requestBytes: 1
      )
    }
    _ = try await authority.reserveCredentialUse(
      run,
      expectedScope: .run,
      expectedProviderBinding: .anthropic,
      requestBytes: 1
    )
    _ = try await authority.reserveCredentialUse(
      maintenance,
      expectedScope: .maintenance,
      expectedProviderBinding: .anthropic,
      requestBytes: 1
    )
    #expect(
      await credentialAuthority.purposes
        == [
          .stagingCandidate, .usableReady, .usableReady,
          .usableReady, .usableReady,
        ]
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
      _ = try await authority.reserveCredentialUse(
        handle,
        expectedScope: scope,
        expectedProviderBinding: .kimiCode,
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
    _ = try await authority.reserveCredentialUse(
      run,
      expectedScope: .run,
      expectedProviderBinding: binding,
      requestBytes: 1
    )
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
        try await authority.reserveCredentialUse(
          handle,
          expectedScope: .setup,
          requestBytes: 1
        )
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
          try await authority.reserveCredentialUse(
            handle,
            expectedScope: scope,
            requestBytes: 1
          )
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
      let authority = BrokerProviderRouteAuthority(
        reader: reader,
        credentialAuthority: RouteCredentialAuthority(reader: reader),
        clock: clock.now
      )
      let handle = try await issue(.setup, from: authority)
      await reader.blockNextReads(1)
      let task = Task {
        try await authority.reserveCredentialUse(
          handle,
          expectedScope: .setup,
          requestBytes: 1
        )
      }
      await reader.waitUntilBlocked()

      var interruptionTask: Task<Void, Never>?
      switch interruption {
      case .capabilityCancellation:
        interruptionTask = Task { await authority.cancel(handle) }
      case .taskCancellation:
        task.cancel()
      case .expiry:
        clock.set(now.addingTimeInterval(61))
      case .close:
        interruptionTask = Task { await authority.close() }
      }
      await reader.releaseBlockedReads()
      await interruptionTask?.value

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
      let authority = BrokerProviderRouteAuthority(
        reader: reader,
        credentialAuthority: RouteCredentialAuthority(reader: reader),
        clock: clock.now
      )
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
  func setupIssuanceRejectsARestagedAttemptBeforeCreatingCapability() async throws {
    let original = stagingAttempt(fence: 1)
    let replacement = stagingAttempt(
      fence: 2,
      attemptID: UUID(uuidString: "a2000000-0000-4000-8000-000000000099")!
    )
    let reader = RouteProjectionReader(
      projection: bound(.openAI, .staging(original))
    )
    let authority = routeAuthority(reader: reader)
    await reader.blockNextReads(1)
    let issue = Task {
      try await authority.issueSetup(
        connectionID: connectionID,
        attemptID: original.attemptID,
        expectedFence: original.fence,
        expiresAt: now.addingTimeInterval(60),
        requestBudget: 1,
        byteBudget: 0
      )
    }
    await reader.waitUntilBlocked()

    await reader.setProjection(bound(.openAI, .staging(replacement)))
    await reader.releaseBlockedReads()

    await #expect(throws: BrokerProviderRouteAuthorityError.staleCapability) {
      _ = try await issue.value
    }
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
    _ = try await authority.reserveCredentialUse(
      requests,
      expectedScope: .setup,
      requestBytes: 1
    )
    let readsAfterRequest = await reader.readCount
    await #expect(throws: BrokerProviderRouteAuthorityError.requestBudgetExceeded) {
      _ = try await authority.reserveCredentialUse(
        requests,
        expectedScope: .setup,
        requestBytes: 1
      )
    }
    #expect(await reader.readCount == readsAfterRequest)

    let bytes = try await authority.issue(
      scope: .setup,
      connectionID: connectionID,
      expiresAt: now.addingTimeInterval(60),
      requestBudget: 3,
      byteBudget: .max
    )
    _ = try await authority.reserveCredentialUse(
      bytes,
      expectedScope: .setup,
      requestBytes: 1
    )
    let readsAfterByte = await reader.readCount
    await #expect(throws: BrokerProviderRouteAuthorityError.byteBudgetExceeded) {
      _ = try await authority.reserveCredentialUse(
        bytes,
        expectedScope: .setup,
        requestBytes: .max
      )
    }
    #expect(await reader.readCount == readsAfterByte)
  }

  @Test
  func credentialReserveFailureDoesNotDebitAndTheSinglePermitCanRetry() async throws {
    let reader = RouteProjectionReader(
      projection: bound(.openAI, .staging(stagingAttempt()))
    )
    let credentialAuthority = RouteCredentialAuthority(reader: reader)
    let authority = routeAuthority(
      reader: reader,
      credentialAuthority: credentialAuthority
    )
    let handle = try await authority.issue(
      scope: .setup,
      connectionID: connectionID,
      expiresAt: now.addingTimeInterval(60),
      requestBudget: 1,
      byteBudget: 1
    )

    await credentialAuthority.setReserveError(.credentialUnavailable)
    await #expect(throws: BrokerProviderRouteAuthorityError.authorityUnavailable) {
      _ = try await authority.reserveCredentialUse(
        handle,
        expectedScope: .setup,
        requestBytes: 1
      )
    }
    await credentialAuthority.setReserveError(nil)

    let reservation = try await authority.reserveCredentialUse(
      handle,
      expectedScope: .setup,
      requestBytes: 1
    )
    await #expect(throws: BrokerProviderRouteAuthorityError.requestBudgetExceeded) {
      _ = try await authority.reserveCredentialUse(
        handle,
        expectedScope: .setup,
        requestBytes: 0
      )
    }
    #expect(await credentialAuthority.purposes == [.stagingCandidate, .stagingCandidate])
    #expect(await credentialAuthority.cancelCount == 0)
    #expect(await credentialAuthority.releaseCount == 0)
    await authority.cancel(handle)
    _ = reservation
  }

  @Test
  func mismatchedCredentialReservationIsCleanedAndDoesNotDebit() async throws {
    for mismatch in [
      RouteCredentialAuthority.ReservationMismatch.identity,
      .providerBinding,
    ] {
      let reader = RouteProjectionReader(
        projection: bound(.openAI, .staging(stagingAttempt()))
      )
      let credentialAuthority = RouteCredentialAuthority(reader: reader)
      let authority = routeAuthority(
        reader: reader,
        credentialAuthority: credentialAuthority
      )
      let handle = try await authority.issue(
        scope: .setup,
        connectionID: connectionID,
        expiresAt: now.addingTimeInterval(60),
        requestBudget: 1,
        byteBudget: 1
      )

      await credentialAuthority.setMismatch(mismatch)
      await #expect(throws: BrokerProviderRouteAuthorityError.staleCapability) {
        _ = try await authority.reserveCredentialUse(
          handle,
          expectedScope: .setup,
          requestBytes: 1
        )
      }
      #expect(await credentialAuthority.cancelCount == 1)
      #expect(await credentialAuthority.releaseCount == 1)
      #expect(await credentialAuthority.lastSecretIsErased() == true)

      await credentialAuthority.setMismatch(nil)
      let retry = try await authority.reserveCredentialUse(
        handle,
        expectedScope: .setup,
        requestBytes: 1
      )
      _ = retry
      await authority.cancel(handle)
    }
  }

  @Test
  func postReservationProjectionMutationCleansSecretWithoutDebiting() async throws {
    let original = stagingAttempt()
    let reader = RouteProjectionReader(
      projection: bound(.openAI, .staging(original))
    )
    let credentialAuthority = RouteCredentialAuthority(reader: reader)
    let authority = routeAuthority(
      reader: reader,
      credentialAuthority: credentialAuthority
    )
    let handle = try await authority.issue(
      scope: .setup,
      connectionID: connectionID,
      expiresAt: now.addingTimeInterval(60),
      requestBudget: 1,
      byteBudget: 1
    )
    await credentialAuthority.pauseNextReservation()

    let task = Task {
      try await authority.reserveCredentialUse(
        handle,
        expectedScope: .setup,
        requestBytes: 1
      )
    }
    await credentialAuthority.waitUntilReservationPaused()
    await reader.setProjection(
      SetupMutation.candidate.apply(to: original, connectionID: connectionID))
    await credentialAuthority.releasePausedReservation()

    await #expect(throws: BrokerProviderRouteAuthorityError.staleCapability) {
      _ = try await task.value
    }
    #expect(await credentialAuthority.cancelCount == 1)
    #expect(await credentialAuthority.releaseCount == 1)
    #expect(await credentialAuthority.lastSecretIsErased() == true)

    await reader.setProjection(bound(.openAI, .staging(original)))
    let retry = try await authority.reserveCredentialUse(
      handle,
      expectedScope: .setup,
      requestBytes: 1
    )
    _ = retry
    await authority.cancel(handle)
  }

  @Test
  func interruptionAfterReservationAlwaysCleansBeforeAnyDebit() async throws {
    for interruption in Interruption.allCases {
      let clock = RouteTestClock(now)
      let reader = RouteProjectionReader(
        projection: bound(.openAI, .staging(stagingAttempt()))
      )
      let credentialAuthority = RouteCredentialAuthority(reader: reader)
      let authority = BrokerProviderRouteAuthority(
        reader: reader,
        credentialAuthority: credentialAuthority,
        clock: clock.now
      )
      let handle = try await authority.issue(
        scope: .setup,
        connectionID: connectionID,
        expiresAt: now.addingTimeInterval(60),
        requestBudget: 1,
        byteBudget: 1
      )
      await credentialAuthority.pauseNextReservation()
      if interruption == .taskCancellation {
        await credentialAuthority.cancelTaskBeforeReturningNextReservation()
      }
      let task = Task {
        try await authority.reserveCredentialUse(
          handle,
          expectedScope: .setup,
          requestBytes: 1
        )
      }
      await credentialAuthority.waitUntilReservationPaused()

      var interruptionTask: Task<Void, Never>?
      var revocationCommitted: RouteInvocationProbe?
      switch interruption {
      case .capabilityCancellation:
        let committed = RouteInvocationProbe()
        revocationCommitted = committed
        interruptionTask = Task {
          await authority.cancel(
            handle,
            onRevocationCommitted: committed.signal
          )
        }
      case .taskCancellation:
        // The injected authority cancels this task at the reservation return boundary.
        break
      case .expiry:
        clock.set(now.addingTimeInterval(61))
      case .close:
        let committed = RouteInvocationProbe()
        revocationCommitted = committed
        interruptionTask = Task {
          await authority.close(onRevocationCommitted: committed.signal)
        }
      }
      await revocationCommitted?.wait()
      await credentialAuthority.releasePausedReservation()
      await interruptionTask?.value

      await #expect(throws: interruption.expectedError) {
        _ = try await task.value
      }
      #expect(await credentialAuthority.cancelCount == 1)
      #expect(await credentialAuthority.releaseCount == 1)
      #expect(await credentialAuthority.lastSecretIsErased() == true)

      switch interruption {
      case .taskCancellation:
        let retry = try await authority.reserveCredentialUse(
          handle,
          expectedScope: .setup,
          requestBytes: 1
        )
        _ = retry
        await authority.cancel(handle)
      case .expiry:
        clock.set(now)
        let retry = try await authority.reserveCredentialUse(
          handle,
          expectedScope: .setup,
          requestBytes: 1
        )
        _ = retry
        await authority.cancel(handle)
      case .capabilityCancellation, .close:
        break
      }
    }
  }

  @Test
  func returnedReservationCannotStartAfterCancelCloseOrExpiry() async throws {
    for interruption in PostReturnInterruption.allCases {
      let clock = RouteTestClock(now)
      let reader = RouteProjectionReader(
        projection: bound(.openAI, .staging(stagingAttempt()))
      )
      let credentialAuthority = RouteCredentialAuthority(reader: reader)
      let authority = BrokerProviderRouteAuthority(
        reader: reader,
        credentialAuthority: credentialAuthority,
        clock: clock.now
      )
      let handle = try await authority.issue(
        scope: .setup,
        connectionID: connectionID,
        expiresAt: now.addingTimeInterval(60),
        requestBudget: 1,
        byteBudget: 1
      )
      let reservation: BrokerProviderRouteReservation =
        try await authority
        .reserveCredentialUse(handle, expectedScope: .setup, requestBytes: 1)
      let probe = RouteStartProbe()

      switch interruption {
      case .cancel:
        await authority.cancel(handle)
      case .close:
        await authority.close()
      case .expiry:
        clock.set(now.addingTimeInterval(61))
      }

      await #expect(throws: interruption.expectedError) {
        _ = try await startRouteUse(
          reservation,
          handle: handle,
          authority: authority,
          probe: probe
        )
      }
      #expect(probe.count == 0)
      #expect(await credentialAuthority.startCount == 0)
      #expect(await credentialAuthority.cancelCount == 1)
      #expect(await credentialAuthority.releaseCount == 1)
      #expect(await credentialAuthority.lastSecretIsErased() == true)
    }
  }

  @Test
  func droppingAnUnconsumedRouteReservationErasesAndAbandonsTheCredential() async throws {
    let reader = RouteProjectionReader(
      projection: bound(.openAI, .staging(stagingAttempt()))
    )
    let credentialAuthority = RouteCredentialAuthority(reader: reader)
    let authority = routeAuthority(
      reader: reader,
      credentialAuthority: credentialAuthority
    )
    let handle = try await issue(.setup, from: authority)
    var reservation: BrokerProviderRouteReservation? =
      try await authority
      .reserveCredentialUse(handle, expectedScope: .setup, requestBytes: 1)
    weak let weakReservation = reservation

    #expect(await credentialAuthority.lastSecretIsErased() == false)
    reservation = nil
    await credentialAuthority.waitUntilAbandoned()

    #expect(weakReservation == nil)
    #expect(await credentialAuthority.abandonCount == 1)
    #expect(await credentialAuthority.lastSecretIsErased() == true)
  }

  @Test
  func stableUseIDsIsolateAReplacementFromADroppedReservation() async throws {
    let reader = RouteProjectionReader(
      projection: bound(.openAI, .staging(stagingAttempt()))
    )
    let credentialAuthority = RouteCredentialAuthority(reader: reader)
    let useIDs = ScriptedRouteUseIDAllocator([41, 41, 42])
    let authority = BrokerProviderRouteAuthority(
      reader: reader,
      credentialAuthority: credentialAuthority,
      useIDAllocator: useIDs.next,
      clock: { now }
    )
    let droppedHandle = try await issue(.setup, from: authority)
    let replacementHandle = try await authority.issue(
      scope: .setup,
      connectionID: connectionID,
      expiresAt: now.addingTimeInterval(60),
      requestBudget: 1,
      byteBudget: 1
    )
    var dropped: BrokerProviderRouteReservation? =
      try await authority.reserveCredentialUse(
        droppedHandle,
        expectedScope: .setup,
        requestBytes: 1
      )
    weak let weakDropped = dropped
    #expect(weakDropped != nil)
    dropped = nil
    await credentialAuthority.waitUntilAbandoned()
    #expect(weakDropped == nil)

    let readsBeforeDuplicate = await reader.readCount
    await #expect(throws: BrokerProviderRouteAuthorityError.authorityUnavailable) {
      _ = try await authority.reserveCredentialUse(
        replacementHandle,
        expectedScope: .setup,
        requestBytes: 1
      )
    }
    #expect(await reader.readCount == readsBeforeDuplicate)
    #expect(await credentialAuthority.purposes == [.stagingCandidate])

    let replacement = try await authority.reserveCredentialUse(
      replacementHandle,
      expectedScope: .setup,
      requestBytes: 1
    )
    #expect(await credentialAuthority.lastSecretIsErased() == false)

    await authority.cancel(droppedHandle)
    #expect(await credentialAuthority.cancelCount == 0)
    #expect(await credentialAuthority.releaseCount == 0)
    #expect(await credentialAuthority.lastSecretIsErased() == false)

    let probe = RouteStartProbe()
    #expect(
      try await startRouteUse(
        replacement,
        handle: replacementHandle,
        authority: authority,
        probe: probe
      ) == .requestStarted
    )
    #expect(probe.count == 1)
    #expect(await credentialAuthority.startCount == 1)
    #expect(await credentialAuthority.cancelCount == 0)
    #expect(await credentialAuthority.releaseCount == 1)
    #expect(await credentialAuthority.lastSecretIsErased() == true)
  }

  @Test
  func exhaustedUseIDAllocatorFailsBeforeReadSecretOrBudgetDebit() async throws {
    let reader = RouteProjectionReader(
      projection: bound(.openAI, .staging(stagingAttempt()))
    )
    let credentialAuthority = RouteCredentialAuthority(reader: reader)
    let useIDs = ScriptedRouteUseIDAllocator([nil, 9])
    let authority = BrokerProviderRouteAuthority(
      reader: reader,
      credentialAuthority: credentialAuthority,
      useIDAllocator: useIDs.next,
      clock: { now }
    )
    let handle = try await authority.issue(
      scope: .setup,
      connectionID: connectionID,
      expiresAt: now.addingTimeInterval(60),
      requestBudget: 1,
      byteBudget: 1
    )
    let readsAfterIssue = await reader.readCount

    await #expect(throws: BrokerProviderRouteAuthorityError.authorityUnavailable) {
      _ = try await authority.reserveCredentialUse(
        handle,
        expectedScope: .setup,
        requestBytes: 1
      )
    }
    #expect(await reader.readCount == readsAfterIssue)
    #expect(await credentialAuthority.purposes.isEmpty)
    #expect(await credentialAuthority.cancelCount == 0)
    #expect(await credentialAuthority.releaseCount == 0)
    #expect(await credentialAuthority.lastSecretIsErased() == nil)

    let retry = try await authority.reserveCredentialUse(
      handle,
      expectedScope: .setup,
      requestBytes: 1
    )
    #expect(await credentialAuthority.purposes == [.stagingCandidate])
    #expect(await credentialAuthority.lastSecretIsErased() == false)
    await authority.cancel(handle)
    #expect(await credentialAuthority.cancelCount == 1)
    #expect(await credentialAuthority.releaseCount == 1)
    #expect(await credentialAuthority.lastSecretIsErased() == true)
    _ = retry
  }

  @Test
  func concurrentCancelAndCloseWaitForTheSameCredentialCleanup() async throws {
    for action in CleanupAction.allCases {
      let reader = RouteProjectionReader(
        projection: bound(.openAI, .staging(stagingAttempt()))
      )
      let credentialAuthority = RouteCredentialAuthority(reader: reader)
      let authority = routeAuthority(
        reader: reader,
        credentialAuthority: credentialAuthority
      )
      let handle = try await issue(.setup, from: authority)
      let reservation = try await authority.reserveCredentialUse(
        handle,
        expectedScope: .setup,
        requestBytes: 1
      )
      await credentialAuthority.pauseNextCleanup()

      let first = Task { await action.run(authority, handle: handle) }
      await credentialAuthority.waitUntilCleanupPaused()
      let completion = RouteCompletionProbe()
      let invocation = RouteInvocationProbe()
      let second = Task {
        invocation.signal()
        await action.run(authority, handle: handle)
        completion.finish()
      }
      await invocation.wait()
      await Task.yield()

      #expect(!completion.isFinished)
      #expect(await credentialAuthority.cancelCount == 1)
      #expect(await credentialAuthority.releaseCount == 0)
      #expect(await credentialAuthority.lastSecretIsErased() == false)

      await credentialAuthority.releasePausedCleanup()
      await first.value
      await second.value
      #expect(completion.isFinished)
      #expect(await credentialAuthority.cancelCount == 1)
      #expect(await credentialAuthority.releaseCount == 1)
      #expect(await credentialAuthority.lastSecretIsErased() == true)
      _ = reservation
    }
  }

  @Test
  func cancelAndCloseWaitForAnInFlightReserveToCleanItsCredential() async throws {
    for action in CleanupAction.allCases {
      let reader = RouteProjectionReader(
        projection: bound(.openAI, .staging(stagingAttempt()))
      )
      let credentialAuthority = RouteCredentialAuthority(reader: reader)
      let authority = routeAuthority(
        reader: reader,
        credentialAuthority: credentialAuthority
      )
      let handle = try await issue(.setup, from: authority)
      await credentialAuthority.pauseNextReservation()
      let reserve = Task {
        try await authority.reserveCredentialUse(
          handle,
          expectedScope: .setup,
          requestBytes: 1
        )
      }
      await credentialAuthority.waitUntilReservationPaused()

      let invocation = RouteInvocationProbe()
      let completion = RouteCompletionProbe()
      let interruption = Task {
        await action.run(
          authority,
          handle: handle,
          onRevocationCommitted: invocation.signal
        )
        completion.finish()
      }
      await invocation.wait()
      #expect(!completion.isFinished)
      #expect(await credentialAuthority.cancelCount == 0)
      #expect(await credentialAuthority.releaseCount == 0)
      #expect(await credentialAuthority.lastSecretIsErased() == false)

      await credentialAuthority.releasePausedReservation()
      await interruption.value
      await #expect(throws: action.expectedError) {
        _ = try await reserve.value
      }
      #expect(completion.isFinished)
      #expect(await credentialAuthority.cancelCount == 1)
      #expect(await credentialAuthority.releaseCount == 1)
      #expect(await credentialAuthority.lastSecretIsErased() == true)
    }
  }

  @Test
  func startRequiresTheExactReservedScopeAndChargedBytes() async throws {
    for mismatch in StartMismatch.allCases {
      let reader = RouteProjectionReader(
        projection: bound(.openAI, .staging(stagingAttempt()))
      )
      let credentialAuthority = RouteCredentialAuthority(reader: reader)
      let authority = routeAuthority(
        reader: reader,
        credentialAuthority: credentialAuthority
      )
      let handle = try await authority.issue(
        scope: .setup,
        connectionID: connectionID,
        expiresAt: now.addingTimeInterval(60),
        requestBudget: 1,
        byteBudget: 2
      )
      let reservation: BrokerProviderRouteReservation =
        try await authority
        .reserveCredentialUse(handle, expectedScope: .setup, requestBytes: 1)
      let probe = RouteStartProbe()

      await #expect(throws: mismatch.expectedError) {
        _ = try await startRouteUse(
          reservation,
          handle: handle,
          authority: authority,
          scope: mismatch.scope,
          requestBytes: mismatch.requestBytes,
          probe: probe
        )
      }
      #expect(probe.count == 0)
      #expect(await credentialAuthority.startCount == 0)
      #expect(await credentialAuthority.cancelCount == 1)
      #expect(await credentialAuthority.releaseCount == 1)
      #expect(await credentialAuthority.lastSecretIsErased() == true)
    }
  }

  @Test
  func startIsOneShotAndDoesNotDebitTheReservedBudgetAgain() async throws {
    let reader = RouteProjectionReader(
      projection: bound(.openAI, .staging(stagingAttempt()))
    )
    let credentialAuthority = RouteCredentialAuthority(reader: reader)
    let authority = routeAuthority(
      reader: reader,
      credentialAuthority: credentialAuthority
    )
    let handle = try await authority.issue(
      scope: .setup,
      connectionID: connectionID,
      expiresAt: now.addingTimeInterval(60),
      requestBudget: 1,
      byteBudget: 1
    )
    let reservation: BrokerProviderRouteReservation =
      try await authority
      .reserveCredentialUse(handle, expectedScope: .setup, requestBytes: 1)
    let probe = RouteStartProbe()
    await reader.blockNextReads(1)

    let first = Task {
      try await startRouteUse(
        reservation,
        handle: handle,
        authority: authority,
        probe: probe
      )
    }
    await reader.waitUntilBlocked()
    await #expect(throws: BrokerProviderRouteAuthorityError.invalidCapability) {
      _ = try await startRouteUse(
        reservation,
        handle: handle,
        authority: authority,
        probe: probe
      )
    }
    await reader.releaseBlockedReads()

    #expect(try await first.value == .requestStarted)
    await #expect(throws: BrokerProviderRouteAuthorityError.invalidCapability) {
      _ = try await startRouteUse(
        reservation,
        handle: handle,
        authority: authority,
        probe: probe
      )
    }
    await #expect(throws: BrokerProviderRouteAuthorityError.requestBudgetExceeded) {
      _ = try await authority.reserveCredentialUse(
        handle,
        expectedScope: .setup,
        requestBytes: 0
      )
    }
    #expect(probe.count == 1)
    #expect(await credentialAuthority.purposes == [.stagingCandidate])
    #expect(await credentialAuthority.startCount == 1)
    #expect(await credentialAuthority.cancelCount == 0)
    #expect(await credentialAuthority.releaseCount == 1)
    #expect(await credentialAuthority.lastSecretIsErased() == true)
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
      _ = try await authority.reserveCredentialUse(
        handle,
        expectedScope: .setup,
        requestBytes: 1
      )
    }

    let otherReader = RouteProjectionReader(
      projection: bound(.openAI, .staging(stagingAttempt()))
    )
    let other = routeAuthority(reader: otherReader)
    let readsBeforeForeignHandle = await otherReader.readCount
    await #expect(throws: BrokerProviderRouteAuthorityError.invalidCapability) {
      _ = try await other.reserveCredentialUse(
        handle,
        expectedScope: .setup,
        requestBytes: 1
      )
    }
    #expect(await otherReader.readCount == readsBeforeForeignHandle)

    let errors: [BrokerProviderRouteAuthorityError] = [
      .cancelled, .closed, .expired, .invalidCapability, .invalidCredential,
      .wrongScope, .wrongProvider, .wrongRequestBytes, .staleCapability,
      .authorityUnavailable, .routeUnavailable, .requestBudgetExceeded,
      .byteBudgetExceeded,
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
    reader: RouteProjectionReader,
    credentialAuthority: RouteCredentialAuthority? = nil
  ) -> BrokerProviderRouteAuthority {
    BrokerProviderRouteAuthority(
      reader: reader,
      credentialAuthority: credentialAuthority ?? RouteCredentialAuthority(reader: reader),
      clock: { now }
    )
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
  ) async -> Result<BrokerProviderRouteReservation, BrokerProviderRouteAuthorityError> {
    do {
      return .success(
        try await authority.reserveCredentialUse(
          handle,
          expectedScope: .setup,
          requestBytes: 1
        )
      )
    } catch let error {
      return .failure(error)
    }
  }

  private func startRouteUse(
    _ reservation: BrokerProviderRouteReservation,
    handle: BrokerProviderRouteCapability,
    authority: BrokerProviderRouteAuthority,
    scope: BrokerProviderRouteScope = .setup,
    providerBinding: ProviderProfileBinding = .openAI,
    requestBytes: UInt64 = 1,
    probe: RouteStartProbe
  ) async throws(BrokerProviderRouteAuthorityError) -> DeliveryState {
    try await authority.startCredentialUse(
      reservation,
      capability: handle,
      expectedScope: scope,
      expectedProviderBinding: providerBinding,
      requestBytes: requestBytes,
      prepare: { .prepared(!$0.isEmpty) },
      start: probe.record
    )
  }
}

extension BrokerProviderRouteAuthority {
  fileprivate func reserveCredentialUse(
    _ handle: BrokerProviderRouteCapability,
    expectedScope: BrokerProviderRouteScope,
    requestBytes: UInt64
  ) async throws(BrokerProviderRouteAuthorityError) -> BrokerProviderRouteReservation {
    try await reserveCredentialUse(
      handle,
      expectedScope: expectedScope,
      expectedProviderBinding: .openAI,
      requestBytes: requestBytes
    )
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

private enum Interruption: CaseIterable, Equatable {
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

private enum PostReturnInterruption: CaseIterable {
  case cancel
  case close
  case expiry

  var expectedError: BrokerProviderRouteAuthorityError {
    switch self {
    case .cancel: .cancelled
    case .close: .closed
    case .expiry: .expired
    }
  }
}

private enum StartMismatch: CaseIterable {
  case scope
  case requestBytes

  var scope: BrokerProviderRouteScope { self == .scope ? .run : .setup }
  var requestBytes: UInt64 { self == .requestBytes ? 2 : 1 }
  var expectedError: BrokerProviderRouteAuthorityError {
    self == .scope ? .wrongScope : .wrongRequestBytes
  }
}

private enum CleanupAction: CaseIterable {
  case cancel
  case close

  var expectedError: BrokerProviderRouteAuthorityError {
    self == .cancel ? .cancelled : .closed
  }

  func run(
    _ authority: BrokerProviderRouteAuthority,
    handle: BrokerProviderRouteCapability,
    onRevocationCommitted: @Sendable () -> Void = {}
  ) async {
    switch self {
    case .cancel:
      await authority.cancel(
        handle,
        onRevocationCommitted: onRevocationCommitted
      )
    case .close:
      await authority.close(
        onRevocationCommitted: onRevocationCommitted
      )
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

private actor RouteCredentialAuthority: BrokerProviderCredentialUseAuthority {
  enum ReservationMismatch {
    case identity
    case providerBinding
  }

  private let reader: RouteProjectionReader
  private var reserveError: CredentialUseError?
  private var mismatch: ReservationMismatch?
  private var shouldPauseNextReservation = false
  private var shouldCancelTaskBeforeReturningReservation = false
  private var isReservationPaused = false
  private var pauseArrivalContinuations: [CheckedContinuation<Void, Never>] = []
  private var pauseReleaseContinuations: [CheckedContinuation<Void, Never>] = []
  private var shouldPauseNextCleanup = false
  private var isCleanupPaused = false
  private var cleanupArrivalContinuations: [CheckedContinuation<Void, Never>] = []
  private var cleanupReleaseContinuations: [CheckedContinuation<Void, Never>] = []
  private var abandonContinuations: [CheckedContinuation<Void, Never>] = []
  private var secrets: [SecretBytes] = []
  private(set) var purposes: [CredentialUsePurpose] = []
  private(set) var startCount = 0
  private(set) var cancelCount = 0
  private(set) var releaseCount = 0
  private(set) var abandonCount = 0

  init(reader: RouteProjectionReader) {
    self.reader = reader
  }

  func reserveCredentialUse(
    connectionID: UUID,
    expectedBinding: ProviderProfileBinding,
    purpose: CredentialUsePurpose
  ) async throws(CredentialUseError) -> CredentialUseReservation {
    purposes.append(purpose)
    if let reserveError { throw reserveError }

    let bound: BrokerCredentialBoundProjection
    let projection: CredentialProjection
    do {
      guard
        let loaded = try await reader.authoritativeBoundProjection(for: connectionID),
        let loadedProjection = loaded.projection
      else {
        throw CredentialUseError.noUsableCredential
      }
      bound = loaded
      projection = loadedProjection
    } catch let error as CredentialUseError {
      throw error
    } catch {
      throw .authorityUnavailable
    }
    guard bound.providerBinding == expectedBinding else {
      throw .invalidReservation
    }

    var identity = try Self.identity(
      connectionID: connectionID,
      projection: projection,
      purpose: purpose
    )
    var binding = expectedBinding
    switch mismatch {
    case .identity:
      identity = Self.mismatched(identity)
    case .providerBinding:
      binding = expectedBinding == .anthropic ? .openAI : .anthropic
    case nil:
      break
    }

    let lifetime = CredentialUseLifetime { [weak self] _ in
      guard let self else { return }
      Task { await self.recordAbandon() }
    }
    let secret = SecretBytes(Data("ROUTE_TEST_SECRET_5D72".utf8))
    guard lifetime.install(secret) else { throw .credentialUnavailable }
    secrets.append(secret)
    let reservation = CredentialUseReservation(
      lifetime: lifetime,
      identity: identity,
      providerBinding: binding
    )

    if shouldPauseNextReservation {
      shouldPauseNextReservation = false
      isReservationPaused = true
      let arrivals = pauseArrivalContinuations
      pauseArrivalContinuations.removeAll()
      for continuation in arrivals { continuation.resume() }
      await withCheckedContinuation { pauseReleaseContinuations.append($0) }
      isReservationPaused = false
    }
    if shouldCancelTaskBeforeReturningReservation {
      shouldCancelTaskBeforeReturningReservation = false
      withUnsafeCurrentTask { $0?.cancel() }
    }
    return reservation
  }

  func startCredentialUse<Prepared: Sendable>(
    _ reservation: CredentialUseReservation,
    prepare: @Sendable (UnsafeRawBufferPointer) -> CredentialUsePreparation<Prepared>,
    start: @Sendable (Prepared) -> Void
  ) throws(CredentialUseError) -> DeliveryState {
    guard
      let preparation = reservation.lifetime.withSecret({ secret in
        secret.withUnsafeBytes(prepare)
      })
    else {
      throw .invalidReservation
    }
    reservation.lifetime.eraseSecret()
    guard case .prepared(let prepared) = preparation else {
      throw .invalidCredential
    }
    startCount += 1
    start(prepared)
    return .requestStarted
  }

  func cancelCredentialUse(_ reservation: CredentialUseReservation) async {
    cancelCount += 1
    if shouldPauseNextCleanup {
      shouldPauseNextCleanup = false
      isCleanupPaused = true
      let arrivals = cleanupArrivalContinuations
      cleanupArrivalContinuations.removeAll()
      for continuation in arrivals { continuation.resume() }
      await withCheckedContinuation { cleanupReleaseContinuations.append($0) }
      isCleanupPaused = false
    }
    reservation.lifetime.eraseSecret()
  }

  func releaseCredentialUse(_ reservation: CredentialUseReservation) {
    releaseCount += 1
    reservation.lifetime.release()
  }

  func setReserveError(_ error: CredentialUseError?) {
    reserveError = error
  }

  func setMismatch(_ value: ReservationMismatch?) {
    mismatch = value
  }

  func pauseNextReservation() {
    shouldPauseNextReservation = true
  }

  func cancelTaskBeforeReturningNextReservation() {
    shouldCancelTaskBeforeReturningReservation = true
  }

  func waitUntilReservationPaused() async {
    guard !isReservationPaused else { return }
    await withCheckedContinuation { pauseArrivalContinuations.append($0) }
  }

  func releasePausedReservation() {
    let releases = pauseReleaseContinuations
    pauseReleaseContinuations.removeAll()
    for continuation in releases { continuation.resume() }
  }

  func pauseNextCleanup() {
    shouldPauseNextCleanup = true
  }

  func waitUntilCleanupPaused() async {
    guard !isCleanupPaused else { return }
    await withCheckedContinuation { cleanupArrivalContinuations.append($0) }
  }

  func releasePausedCleanup() {
    let releases = cleanupReleaseContinuations
    cleanupReleaseContinuations.removeAll()
    for continuation in releases { continuation.resume() }
  }

  func lastSecretIsErased() -> Bool? {
    secrets.last?.withUnsafeBytes { $0.isEmpty }
  }

  func waitUntilAbandoned() async {
    guard abandonCount == 0 else { return }
    await withCheckedContinuation { abandonContinuations.append($0) }
  }

  private func recordAbandon() {
    abandonCount += 1
    let continuations = abandonContinuations
    abandonContinuations.removeAll()
    for continuation in continuations { continuation.resume() }
  }

  private static func identity(
    connectionID: UUID,
    projection: CredentialProjection,
    purpose: CredentialUsePurpose
  ) throws(CredentialUseError) -> CredentialUseIdentity {
    switch purpose {
    case .stagingCandidate:
      guard case .staging(let attempt) = projection,
        attempt.connectionID == connectionID
      else {
        throw .noUsableCredential
      }
      return .stagingCandidate(
        connectionID: connectionID,
        fence: attempt.fence,
        attemptID: attempt.attemptID,
        generation: attempt.candidate
      )
    case .usableReady:
      switch projection {
      case .staging(let attempt):
        guard attempt.connectionID == connectionID, let ready = attempt.previousReady else {
          throw .noUsableCredential
        }
        return .usableReady(
          connectionID: connectionID,
          fence: attempt.fence,
          generation: ready
        )
      case .ready(let ready):
        guard ready.connectionID == connectionID else { throw .noUsableCredential }
        return .usableReady(
          connectionID: connectionID,
          fence: ready.fence,
          generation: ready.ready
        )
      case .tombstoned:
        throw .noUsableCredential
      }
    }
  }

  private static func mismatched(_ identity: CredentialUseIdentity) -> CredentialUseIdentity {
    switch identity {
    case .stagingCandidate(let connectionID, let fence, let attemptID, let generation):
      return .stagingCandidate(
        connectionID: connectionID,
        fence: fence &+ 1,
        attemptID: attemptID,
        generation: generation
      )
    case .usableReady(let connectionID, let fence, let generation):
      return .usableReady(
        connectionID: connectionID,
        fence: fence &+ 1,
        generation: generation
      )
    }
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

private final class ScriptedRouteUseIDAllocator: @unchecked Sendable {
  private let lock = NSLock()
  private var values: [UInt64?]

  init(_ values: [UInt64?]) {
    self.values = values
  }

  func next() -> UInt64? {
    lock.withLock {
      guard !values.isEmpty else { return nil }
      return values.removeFirst()
    }
  }
}

private final class RouteStartProbe: @unchecked Sendable {
  private let lock = NSLock()
  private var starts = 0

  var count: Int {
    lock.withLock { starts }
  }

  func record(_ prepared: Bool) {
    lock.withLock {
      if prepared { starts += 1 }
    }
  }
}

private final class RouteCompletionProbe: @unchecked Sendable {
  private let lock = NSLock()
  private var finished = false

  var isFinished: Bool {
    lock.withLock { finished }
  }

  func finish() {
    lock.withLock { finished = true }
  }
}

private final class RouteInvocationProbe: @unchecked Sendable {
  private let lock = NSLock()
  private var isSignalled = false
  private var continuations: [CheckedContinuation<Void, Never>] = []

  func signal() {
    lock.lock()
    isSignalled = true
    let selected = continuations
    continuations.removeAll()
    lock.unlock()
    for continuation in selected { continuation.resume() }
  }

  func wait() async {
    await withCheckedContinuation { continuation in
      lock.lock()
      if isSignalled {
        lock.unlock()
        continuation.resume()
      } else {
        continuations.append(continuation)
        lock.unlock()
      }
    }
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
