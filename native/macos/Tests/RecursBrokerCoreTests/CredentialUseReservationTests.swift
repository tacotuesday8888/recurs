import Foundation
import Testing

@testable import RecursBrokerCore

@Suite("Broker credential-use reservation")
struct CredentialUseReservationTests {
  @Test
  func purposeSelectsStagingCandidateOrPreviousReadyWithoutCallerGeneration() async throws {
    let fixture = try CredentialUseFixture()
    let harness = try await fixture.harness()
    let candidateSecret = Array("RECURS_STAGING_CANDIDATE_SECRET_8A31".utf8)
    let attempt = try await harness.state.stage(
      connectionID: fixture.connectionID,
      operationID: fixture.stageOperationID,
      expectedFence: 1,
      secret: SecretBytes(Data(candidateSecret))
    )
    let candidateKey = CredentialStoreKey(
      connectionID: fixture.connectionID,
      generationID: attempt.candidate.generationID,
      generationOrdinal: attempt.candidate.ordinal
    )

    let setup = try await harness.state.reserveCredentialUse(
      connectionID: fixture.connectionID,
      expectedBinding: .openAI,
      purpose: .stagingCandidate
    )
    let run = try await harness.state.reserveCredentialUse(
      connectionID: fixture.connectionID,
      expectedBinding: .openAI,
      purpose: .usableReady
    )
    let setupProbe = StartProbe()
    let runProbe = StartProbe()

    #expect(
      try await harness.state.startCredentialUse(
        setup,
        prepare: { .prepared($0.elementsEqual(candidateSecret)) },
        start: setupProbe.record
      ) == .requestStarted
    )
    #expect(
      try await harness.state.startCredentialUse(
        run,
        prepare: { .prepared($0.elementsEqual(fixture.secret)) },
        start: runProbe.record
      ) == .requestStarted
    )
    #expect(setupProbe.snapshot() == (1, true))
    #expect(runProbe.snapshot() == (1, true))
    #expect(await harness.store.loadCallCount(for: candidateKey) == 1)
    #expect(await harness.store.loadCallCount(for: fixture.readyKey) == 1)
    #expect(await harness.store.lastLoadedCopyIsErased(for: candidateKey) == true)
    #expect(await harness.store.lastLoadedCopyIsErased(for: fixture.readyKey) == true)
    await harness.state.releaseCredentialUse(setup)
    await harness.state.releaseCredentialUse(run)
  }

  @Test
  func mismatchedExpectedBindingFailsBeforeJournalOrCredentialLoad() async throws {
    let fixture = try CredentialUseFixture()
    let harness = try await fixture.harness()
    await harness.journal.resetEvents()

    await expectCredentialUseError(.invalidReservation) {
      try await harness.state.reserveCredentialUse(
        connectionID: fixture.connectionID,
        expectedBinding: .anthropic
      )
    }

    #expect(await harness.journal.events().isEmpty)
    #expect(await harness.store.loadCallCount(for: fixture.readyKey) == 0)
  }

  @Test
  func unchangedAuthorityLoadsBetweenTwoExactAnchorsAndStartsOnce() async throws {
    let fixture = try CredentialUseFixture()
    let harness = try await fixture.harness()
    await harness.journal.resetEvents()

    let reservation = try await harness.state.reserveCredentialUse(
      connectionID: fixture.connectionID
    )

    #expect(
      await harness.journal.events()
        == [.load(fixture.connectionID), .load(fixture.connectionID)]
    )
    #expect(await harness.store.loadCallCount(for: fixture.readyKey) == 1)

    let probe = StartProbe()
    let state = try await harness.state.startCredentialUse(
      reservation,
      prepare: { bytes in .prepared(bytes.elementsEqual(fixture.secret)) },
      start: probe.record
    )
    #expect(state == .requestStarted)
    #expect(probe.snapshot() == (1, true))
    #expect(await harness.store.lastLoadedCopyIsErased(for: fixture.readyKey) == true)
    await expectCredentialUseError(.invalidDeliveryTransition) {
      try await harness.state.startCredentialUse(
        reservation,
        prepare: { _ in .prepared(false) },
        start: probe.record
      )
    }
    #expect(probe.snapshot() == (1, true))
    await harness.state.cancelCredentialUse(reservation)
    await harness.state.releaseCredentialUse(reservation)
    await harness.state.releaseCredentialUse(reservation)
  }

  @Test
  func rejectedPreparationTerminatesNotSentCredentialWithoutStarting() async throws {
    let fixture = try CredentialUseFixture()
    let harness = try await fixture.harness()
    let reservation = try await harness.state.reserveCredentialUse(
      connectionID: fixture.connectionID
    )
    let probe = StartProbe()

    await expectCredentialUseError(.invalidCredential) {
      try await harness.state.startCredentialUse(
        reservation,
        prepare: { _ in CredentialUsePreparation<Bool>.rejected },
        start: probe.record
      )
    }
    #expect(probe.snapshot() == (0, nil))
    #expect(await harness.store.lastLoadedCopyIsErased(for: fixture.readyKey) == true)

    await expectCredentialUseError(.invalidCredential) {
      try await harness.state.startCredentialUse(
        reservation,
        prepare: { _ in .prepared(true) },
        start: probe.record
      )
    }
    #expect(CredentialUseError.invalidCredential.description == "The credential is invalid.")
    #expect(
      CredentialUseError.invalidCredential.debugDescription
        == CredentialUseError.invalidCredential.description
    )
    #expect(
      CredentialUseError.invalidCredential.errorDescription
        == CredentialUseError.invalidCredential.description
    )
    #expect(probe.snapshot() == (0, nil))
    await harness.state.releaseCredentialUse(reservation)
  }

  @Test
  func preparedRequestCarriesBrokerSeededSecretFilterAcrossSendableBoundary() async throws {
    let fixture = try CredentialUseFixture()
    let harness = try await fixture.harness()
    let reservation = try await harness.state.reserveCredentialUse(
      connectionID: fixture.connectionID
    )
    let probe = PreparedRequestProbe()

    let delivery = try await harness.state.startCredentialUse(
      reservation,
      prepare: { credentialBytes in
        let credential = Data(credentialBytes)
        var authorization = Data("Bearer ".utf8)
        authorization.append(credential)
        return .prepared(
          PreparedProviderRequest(
            filter: try! StreamingSecretFilter(
              patterns: [SecretBytes(credential), SecretBytes(authorization)]
            )
          )
        )
      },
      start: probe.record
    )

    #expect(delivery == .requestStarted)
    let filter = try #require(probe.filter())
    #expect(throws: StreamingSecretFilterError.credentialEchoDetected) {
      _ = try filter.process(Data(fixture.secret))
    }
    await harness.state.releaseCredentialUse(reservation)
  }

  @Test
  func poisonedConnectionCannotStartAnOtherwiseUnchangedReservation() async throws {
    let fixture = try CredentialUseFixture()
    let harness = try await fixture.harness()
    let reservation = try await harness.state.reserveCredentialUse(
      connectionID: fixture.connectionID
    )
    await harness.journal.replaceExternally(try fixture.snapshot(tagByte: 0xef))
    await expectBrokerJournalError(.casConflict) {
      try await harness.state.authoritativeProjection(for: fixture.connectionID)
    }

    let probe = StartProbe()
    await expectCredentialUseError(.invalidReservation) {
      try await harness.state.startCredentialUse(
        reservation,
        prepare: { _ in .prepared(false) },
        start: probe.record
      )
    }
    #expect(probe.snapshot() == (0, nil))
    #expect(await harness.store.lastLoadedCopyIsErased(for: fixture.readyKey) == true)
  }

  @Test
  func taskCancelledAfterReservationCannotCrossTheStartBoundary() async throws {
    let fixture = try CredentialUseFixture()
    let harness = try await fixture.harness()
    let reservation = try await harness.state.reserveCredentialUse(
      connectionID: fixture.connectionID
    )
    let gate = AsyncGate()
    let probe = StartProbe()
    let start = Task {
      await gate.wait()
      return try await harness.state.startCredentialUse(
        reservation,
        prepare: { _ in .prepared(false) },
        start: probe.record
      )
    }
    start.cancel()
    await gate.release()

    await expectCredentialUseTaskError(.cancelled, start)
    #expect(probe.snapshot() == (0, nil))
    #expect(await harness.store.lastLoadedCopyIsErased(for: fixture.readyKey) == true)
  }

  @Test
  func releaseBeforeSendErasesAndInvalidatesIdempotently() async throws {
    let fixture = try CredentialUseFixture()
    let harness = try await fixture.harness()
    let reservation = try await harness.state.reserveCredentialUse(
      connectionID: fixture.connectionID
    )
    await harness.state.releaseCredentialUse(reservation)
    await harness.state.releaseCredentialUse(reservation)

    #expect(await harness.store.lastLoadedCopyIsErased(for: fixture.readyKey) == true)
    await expectCredentialUseError(.invalidReservation) {
      try await harness.state.startCredentialUse(
        reservation,
        prepare: { _ in .prepared(false) },
        start: { _ in }
      )
    }
  }

  @Test
  func droppingReturnedReservationSynchronouslyErasesAndEventuallyCleansBookkeeping()
    async throws
  {
    let fixture = try CredentialUseFixture()
    let harness = try await fixture.harness()
    weak var weakReservation: CredentialUseReservation?
    weak var weakLifetime: CredentialUseLifetime?
    let zeroizationProbe: BufferDeallocationProbe

    do {
      let reservation = try await harness.state.reserveCredentialUse(
        connectionID: fixture.connectionID
      )
      weakReservation = reservation
      weakLifetime = reservation.lifetime
      zeroizationProbe = try #require(
        await harness.store.lastLoadedCopyProbe(for: fixture.readyKey)
      )
    }

    #expect(weakReservation == nil)
    #expect(zeroizationProbe.observedZeroization() == true)
    for _ in 0..<100 where weakLifetime != nil {
      await Task.yield()
    }
    #expect(weakLifetime == nil)
  }

  @Test
  func concurrentStartReleaseAndLastReferenceDropHaveOneSafeOutcome() async throws {
    for _ in 0..<8 {
      let fixture = try CredentialUseFixture()
      let harness = try await fixture.harness()
      let probe = StartProbe()
      var reservation: CredentialUseReservation? = try await harness.state.reserveCredentialUse(
        connectionID: fixture.connectionID
      )
      weak let weakReservation: CredentialUseReservation? = reservation
      let startTask = makeConcurrentStartTask(
        state: harness.state,
        reservation: try #require(reservation),
        expectedSecret: fixture.secret,
        probe: probe
      )
      let releaseTask = makeConcurrentReleaseTask(
        state: harness.state,
        reservation: try #require(reservation)
      )

      reservation = nil
      let outcome = await startTask.value
      await releaseTask.value

      switch outcome {
      case .success(let delivery):
        #expect(delivery == .requestStarted)
        #expect(probe.snapshot() == (1, true))
      case .failure(let error):
        #expect(error == .invalidReservation)
        #expect(probe.snapshot() == (0, nil))
      }
      #expect(await harness.store.lastLoadedCopyIsErased(for: fixture.readyKey) == true)
      for _ in 0..<100 where weakReservation != nil {
        await Task.yield()
      }
      #expect(weakReservation == nil)
    }
  }

  @Test
  func changedAuthenticationTagFailsBeforeCredentialLoad() async throws {
    let fixture = try CredentialUseFixture()
    let harness = try await fixture.harness()
    await harness.journal.resetEvents()
    await harness.journal.pauseNext(at: .loadBeforeReturn)
    let reserve = Task {
      try await harness.state.reserveCredentialUse(connectionID: fixture.connectionID)
    }
    await harness.journal.waitUntilPaused(at: .loadBeforeReturn)
    await harness.journal.replaceExternally(try fixture.snapshot(tagByte: 0xef))
    await harness.journal.releaseOne(at: .loadBeforeReturn)

    await expectCredentialUseTaskError(.authorityUnavailable, reserve)
    #expect(await harness.store.loadCallCount(for: fixture.readyKey) == 0)

    await harness.journal.replaceExternally(try fixture.snapshot(tagByte: 0x41))
    await expectCredentialUseError(.authorityUnavailable) {
      try await harness.state.reserveCredentialUse(connectionID: fixture.connectionID)
    }
  }

  @Test
  func disconnectBeforeCredentialLoadPreventsStoreAccess() async throws {
    let fixture = try CredentialUseFixture()
    let harness = try await fixture.harness()
    await harness.journal.pauseNext(at: .loadBeforeReturn)
    let reserve = Task {
      try await harness.state.reserveCredentialUse(connectionID: fixture.connectionID)
    }
    await harness.journal.waitUntilPaused(at: .loadBeforeReturn)

    _ = try await harness.state.disconnect(
      connectionID: fixture.connectionID,
      operationID: fixture.disconnectOperationID,
      expectedFence: 1
    )
    await harness.journal.releaseOne(at: .loadBeforeReturn)

    await expectCredentialUseTaskError(.connectionTombstoned, reserve)
    #expect(await harness.store.loadCallCount(for: fixture.readyKey) == 0)
  }

  @Test
  func generationCommitBeforeCredentialLoadPreventsStoreAccess() async throws {
    let fixture = try CredentialUseFixture()
    let harness = try await fixture.harness()
    let attempt = try await harness.state.stage(
      connectionID: fixture.connectionID,
      operationID: fixture.stageOperationID,
      expectedFence: 1,
      secret: SecretBytes(Data("RECURS_CANDIDATE_SECRET_7F21".utf8))
    )
    await harness.journal.pauseNext(at: .loadBeforeReturn)
    let reserve = Task {
      try await harness.state.reserveCredentialUse(connectionID: fixture.connectionID)
    }
    await harness.journal.waitUntilPaused(at: .loadBeforeReturn)

    _ = try await harness.state.commit(
      connectionID: fixture.connectionID,
      attemptID: attempt.attemptID,
      operationID: fixture.commitOperationID,
      expectedFence: attempt.fence
    )
    await harness.journal.releaseOne(at: .loadBeforeReturn)

    await expectCredentialUseTaskError(.invalidReservation, reserve)
    #expect(await harness.store.loadCallCount(for: fixture.readyKey) == 0)
  }

  @Test
  func changedSecondAnchorErasesLoadedCredentialAndPoisonsAuthority() async throws {
    let fixture = try CredentialUseFixture()
    let harness = try await fixture.harness()
    await harness.store.pauseNext(at: .loadAfterCopy)
    let reserve = Task {
      try await harness.state.reserveCredentialUse(connectionID: fixture.connectionID)
    }
    await harness.store.waitUntilPaused(at: .loadAfterCopy)
    await harness.journal.pauseNext(at: .loadBeforeReturn)
    await harness.store.releaseOne(at: .loadAfterCopy)
    await harness.journal.waitUntilPaused(at: .loadBeforeReturn)
    await harness.journal.replaceExternally(try fixture.snapshot(tagByte: 0xef))
    await harness.journal.releaseOne(at: .loadBeforeReturn)

    await expectCredentialUseTaskError(.authorityUnavailable, reserve)
    #expect(await harness.store.lastLoadedCopyIsErased(for: fixture.readyKey) == true)
  }

  @Test
  func disconnectDuringLoadedStoreCopyErasesAndPreventsSend() async throws {
    let fixture = try CredentialUseFixture()
    let harness = try await fixture.harness()
    await harness.store.pauseNext(at: .loadAfterCopy)
    let reserve = Task {
      try await harness.state.reserveCredentialUse(connectionID: fixture.connectionID)
    }
    await harness.store.waitUntilPaused(at: .loadAfterCopy)

    _ = try await harness.state.disconnect(
      connectionID: fixture.connectionID,
      operationID: fixture.disconnectOperationID,
      expectedFence: 1
    )
    await harness.store.releaseOne(at: .loadAfterCopy)

    await expectCredentialUseTaskError(.connectionTombstoned, reserve)
    #expect(await harness.store.lastLoadedCopyIsErased(for: fixture.readyKey) == true)
  }

  @Test
  func disconnectAfterReservationRevokesBeforePrepareOrStart() async throws {
    let fixture = try CredentialUseFixture()
    let harness = try await fixture.harness()
    let reservation = try await harness.state.reserveCredentialUse(
      connectionID: fixture.connectionID
    )

    _ = try await harness.state.disconnect(
      connectionID: fixture.connectionID,
      operationID: fixture.disconnectOperationID,
      expectedFence: 1
    )

    let probe = StartProbe()
    await expectCredentialUseError(.connectionTombstoned) {
      try await harness.state.startCredentialUse(
        reservation,
        prepare: { _ in .prepared(false) },
        start: probe.record
      )
    }
    #expect(probe.snapshot() == (0, nil))
    #expect(await harness.store.lastLoadedCopyIsErased(for: fixture.readyKey) == true)
  }

  @Test
  func stageAfterReservationRevokesBeforePrepareOrStart() async throws {
    let fixture = try CredentialUseFixture()
    let harness = try await fixture.harness()
    let reservation = try await harness.state.reserveCredentialUse(
      connectionID: fixture.connectionID
    )

    _ = try await harness.state.stage(
      connectionID: fixture.connectionID,
      operationID: fixture.stageOperationID,
      expectedFence: 1,
      secret: SecretBytes(Data("RECURS_CANDIDATE_SECRET_7F21".utf8))
    )

    let probe = StartProbe()
    await expectCredentialUseError(.invalidReservation) {
      try await harness.state.startCredentialUse(
        reservation,
        prepare: { _ in .prepared(false) },
        start: probe.record
      )
    }
    #expect(probe.snapshot() == (0, nil))
    #expect(await harness.store.lastLoadedCopyIsErased(for: fixture.readyKey) == true)
  }

  @Test
  func generationCommitAfterReservationRevokesBeforePrepareOrStart() async throws {
    let fixture = try CredentialUseFixture()
    let harness = try await fixture.harness()
    let attempt = try await harness.state.stage(
      connectionID: fixture.connectionID,
      operationID: fixture.stageOperationID,
      expectedFence: 1,
      secret: SecretBytes(Data("RECURS_CANDIDATE_SECRET_7F21".utf8))
    )
    let reservation = try await harness.state.reserveCredentialUse(
      connectionID: fixture.connectionID
    )

    _ = try await harness.state.commit(
      connectionID: fixture.connectionID,
      attemptID: attempt.attemptID,
      operationID: fixture.commitOperationID,
      expectedFence: attempt.fence
    )

    let probe = StartProbe()
    await expectCredentialUseError(.invalidReservation) {
      try await harness.state.startCredentialUse(
        reservation,
        prepare: { _ in .prepared(false) },
        start: probe.record
      )
    }
    #expect(probe.snapshot() == (0, nil))
    #expect(await harness.store.lastLoadedCopyIsErased(for: fixture.readyKey) == true)
  }

  @Test
  func cancellationBeforeSendIsIdempotentAndAfterSendIsAdvisory() async throws {
    let fixture = try CredentialUseFixture()
    let before = try await fixture.harness()
    let cancelled = try await before.state.reserveCredentialUse(
      connectionID: fixture.connectionID
    )
    await before.state.cancelCredentialUse(cancelled)
    await before.state.cancelCredentialUse(cancelled)
    let cancelledProbe = StartProbe()
    await expectCredentialUseError(.cancelled) {
      try await before.state.startCredentialUse(
        cancelled,
        prepare: { _ in .prepared(false) },
        start: cancelledProbe.record
      )
    }
    #expect(cancelledProbe.snapshot() == (0, nil))
    #expect(await before.store.lastLoadedCopyIsErased(for: fixture.readyKey) == true)

    let after = try await fixture.harness()
    let started = try await after.state.reserveCredentialUse(connectionID: fixture.connectionID)
    let startedProbe = StartProbe()
    #expect(
      try await after.state.startCredentialUse(
        started,
        prepare: { bytes in .prepared(bytes.elementsEqual(fixture.secret)) },
        start: startedProbe.record
      ) == .requestStarted
    )
    await after.state.cancelCredentialUse(started)
    await after.state.cancelCredentialUse(started)
    await expectCredentialUseError(.invalidDeliveryTransition) {
      try await after.state.startCredentialUse(
        started,
        prepare: { _ in .prepared(false) },
        start: startedProbe.record
      )
    }
    #expect(startedProbe.snapshot() == (1, true))
  }

  @Test
  func taskCancellationDuringLoadErasesReturnedCopy() async throws {
    let fixture = try CredentialUseFixture()
    let harness = try await fixture.harness()
    await harness.store.pauseNext(at: .loadAfterCopy)
    let reserve = Task {
      try await harness.state.reserveCredentialUse(connectionID: fixture.connectionID)
    }
    await harness.store.waitUntilPaused(at: .loadAfterCopy)
    reserve.cancel()
    await harness.store.releaseOne(at: .loadAfterCopy)

    await expectCredentialUseTaskError(.cancelled, reserve)
    #expect(await harness.store.lastLoadedCopyIsErased(for: fixture.readyKey) == true)
  }

  @Test
  func stagingLoadsOnlyPreviousReadyAndCommitRevokesItDuringLoad() async throws {
    let fixture = try CredentialUseFixture()
    let harness = try await fixture.harness()
    let attempt = try await harness.state.stage(
      connectionID: fixture.connectionID,
      operationID: fixture.stageOperationID,
      expectedFence: 1,
      secret: SecretBytes(Data("RECURS_CANDIDATE_SECRET_7F21".utf8))
    )
    let candidateKey = CredentialStoreKey(
      connectionID: fixture.connectionID,
      generationID: attempt.candidate.generationID,
      generationOrdinal: attempt.candidate.ordinal
    )

    await harness.store.pauseNext(at: .loadAfterCopy)
    let reserve = Task {
      try await harness.state.reserveCredentialUse(connectionID: fixture.connectionID)
    }
    await harness.store.waitUntilPaused(at: .loadAfterCopy)
    #expect(await harness.store.loadCallCount(for: fixture.readyKey) == 1)
    #expect(await harness.store.loadCallCount(for: candidateKey) == 0)

    _ = try await harness.state.commit(
      connectionID: fixture.connectionID,
      attemptID: attempt.attemptID,
      operationID: fixture.commitOperationID,
      expectedFence: attempt.fence
    )
    await harness.store.releaseOne(at: .loadAfterCopy)

    await expectCredentialUseTaskError(.invalidReservation, reserve)
    #expect(await harness.store.lastLoadedCopyIsErased(for: fixture.readyKey) == true)
  }

  @Test
  func multipleSameConnectionLeasesAreIndependentUntilLifecycleRevocation() async throws {
    let fixture = try CredentialUseFixture()
    let harness = try await fixture.harness()
    let first = try await harness.state.reserveCredentialUse(connectionID: fixture.connectionID)
    let second = try await harness.state.reserveCredentialUse(connectionID: fixture.connectionID)

    _ = try await harness.state.disconnect(
      connectionID: fixture.connectionID,
      operationID: fixture.disconnectOperationID,
      expectedFence: 1
    )

    let probe = StartProbe()
    for reservation in [first, second] {
      await expectCredentialUseError(.connectionTombstoned) {
        try await harness.state.startCredentialUse(
          reservation,
          prepare: { _ in .prepared(false) },
          start: probe.record
        )
      }
    }
    #expect(probe.snapshot() == (0, nil))
    #expect(await harness.store.allLoadedCopiesAreErased(for: fixture.readyKey))
  }

  @Test
  func rejectedLifecycleMutationDoesNotRevokeAnUnchangedLease() async throws {
    let fixture = try CredentialUseFixture()
    let harness = try await fixture.harness()
    let reservation = try await harness.state.reserveCredentialUse(
      connectionID: fixture.connectionID
    )

    await expectBrokerStateError(.staleFence) {
      try await harness.state.disconnect(
        connectionID: fixture.connectionID,
        operationID: fixture.disconnectOperationID,
        expectedFence: 0
      )
    }

    let probe = StartProbe()
    #expect(
      try await harness.state.startCredentialUse(
        reservation,
        prepare: { bytes in .prepared(bytes.elementsEqual(fixture.secret)) },
        start: probe.record
      ) == .requestStarted
    )
    #expect(probe.snapshot() == (1, true))
  }

  @Test
  func storeFailureLeavesNoReservationAndCanBeRetried() async throws {
    let fixture = try CredentialUseFixture()
    let harness = try await fixture.harness()
    await harness.store.failNext(at: .loadBeforeCopy)

    await expectCredentialUseError(.credentialUnavailable) {
      try await harness.state.reserveCredentialUse(connectionID: fixture.connectionID)
    }

    let retry = try await harness.state.reserveCredentialUse(
      connectionID: fixture.connectionID
    )
    await harness.state.cancelCredentialUse(retry)
  }

  @Test
  func reservationHasNoInspectableCapabilityMaterial() async throws {
    let fixture = try CredentialUseFixture()
    let harness = try await fixture.harness()
    let reservation = try await harness.state.reserveCredentialUse(
      connectionID: fixture.connectionID
    )

    #expect(reservation.description == "<credential-use-reservation>")
    #expect(reservation.debugDescription == "<credential-use-reservation>")
    #expect(Array(Mirror(reflecting: reservation).children).isEmpty)
    #expect(!String(reflecting: reservation).contains("4C91"))
    await harness.state.cancelCredentialUse(reservation)
  }
}

private func makeConcurrentStartTask(
  state: BrokerCredentialState,
  reservation: CredentialUseReservation,
  expectedSecret: [UInt8],
  probe: StartProbe
) -> Task<Result<DeliveryState, CredentialUseError>, Never> {
  Task {
    do {
      return .success(
        try await state.startCredentialUse(
          reservation,
          prepare: { bytes in .prepared(bytes.elementsEqual(expectedSecret)) },
          start: probe.record
        )
      )
    } catch let error as CredentialUseError {
      return .failure(error)
    } catch {
      preconditionFailure("Unexpected credential-use error type.")
    }
  }
}

private struct PreparedProviderRequest: Sendable {
  let filter: StreamingSecretFilter
}

private final class PreparedRequestProbe: @unchecked Sendable {
  private let lock = NSLock()
  private var prepared: PreparedProviderRequest?

  func record(_ request: PreparedProviderRequest) {
    lock.lock()
    prepared = request
    lock.unlock()
  }

  func filter() -> StreamingSecretFilter? {
    lock.lock()
    defer { lock.unlock() }
    return prepared?.filter
  }
}

private func makeConcurrentReleaseTask(
  state: BrokerCredentialState,
  reservation: CredentialUseReservation
) -> Task<Void, Never> {
  Task {
    await state.releaseCredentialUse(reservation)
  }
}

private struct CredentialUseFixture: Sendable {
  let connectionID = credentialUseUUID(1)
  let generationID = credentialUseUUID(2)
  let disconnectOperationID = credentialUseUUID(3)
  let stageOperationID = credentialUseUUID(4)
  let commitOperationID = credentialUseUUID(5)
  let secret = Array("RECURS_CREDENTIAL_USE_SECRET_4C91".utf8)
  let time: JournalTimestamp

  init() throws {
    time = try JournalTimestamp(canonicalText: "2026-07-13T04:00:00.000Z")
  }

  var readyKey: CredentialStoreKey {
    CredentialStoreKey(
      connectionID: connectionID,
      generationID: generationID,
      generationOrdinal: 1
    )
  }

  func harness() async throws -> CredentialUseHarness {
    let initial = try snapshot(tagByte: 0x41)
    let journal = try InMemoryBrokerJournalStore(snapshots: [initial])
    let store = InMemoryCredentialStore()
    try await store.store(SecretBytes(Data(secret)), for: readyKey)
    let state = try await BrokerCredentialState.recovering(
      store: store,
      journal: journal,
      clock: { time.date },
      generationIDSource: { credentialUseUUID(10) },
      attemptIDSource: { credentialUseUUID(11) }
    )
    return CredentialUseHarness(state: state, journal: journal, store: store)
  }

  func snapshot(tagByte: UInt8) throws -> BrokerJournalSnapshot {
    BrokerJournalSnapshot(
      record: try readyRecord(),
      authenticationTag: try JournalAuthenticationTag(bytes: Array(repeating: tagByte, count: 32))
    )
  }

  private func readyRecord() throws -> BrokerJournalRecord {
    let generation = BrokerJournalCredentialGeneration(
      generationID: generationID,
      ordinal: 1,
      createdAt: time
    )
    return try BrokerJournalRecord(
      revision: 1,
      connectionID: connectionID,
      providerBinding: .openAI,
      fence: 1,
      lastGenerationOrdinal: 1,
      changedAt: time,
      payload: .ready(
        BrokerJournalReadyPayload(
          ready: BrokerJournalReadyGeneration(generation: generation, committedAt: time)
        )
      )
    )
  }
}

private struct CredentialUseHarness: Sendable {
  let state: BrokerCredentialState
  let journal: InMemoryBrokerJournalStore
  let store: InMemoryCredentialStore
}

private final class StartProbe: @unchecked Sendable {
  private let lock = NSLock()
  private var count = 0
  private var prepared: Bool?

  func record(_ prepared: Bool) {
    lock.lock()
    count += 1
    self.prepared = prepared
    lock.unlock()
  }

  func snapshot() -> (Int, Bool?) {
    lock.lock()
    defer { lock.unlock() }
    return (count, prepared)
  }
}

private func credentialUseUUID(_ value: UInt64) -> UUID {
  UUID(
    uuidString: String(format: "00000000-0000-4000-8000-%012llx", value)
  )!
}

private func expectCredentialUseError<Value>(
  _ expected: CredentialUseError,
  _ operation: () async throws -> Value
) async {
  do {
    _ = try await operation()
    Issue.record("Expected credential-use error \(expected).")
  } catch let error as CredentialUseError {
    #expect(error == expected)
  } catch {
    Issue.record("Unexpected error type: \(String(reflecting: error))")
  }
}

private func expectCredentialUseTaskError<Value>(
  _ expected: CredentialUseError,
  _ task: Task<Value, any Error>
) async {
  await expectCredentialUseError(expected) {
    try await task.value
  }
}

private func expectBrokerStateError<Value>(
  _ expected: BrokerStateError,
  _ operation: () async throws -> Value
) async {
  do {
    _ = try await operation()
    Issue.record("Expected broker-state error \(expected).")
  } catch let error as BrokerStateError {
    #expect(error == expected)
  } catch {
    Issue.record("Unexpected error type: \(String(reflecting: error))")
  }
}

private func expectBrokerJournalError<Value>(
  _ expected: BrokerJournalError,
  _ operation: () async throws -> Value
) async {
  do {
    _ = try await operation()
    Issue.record("Expected broker-journal error \(expected).")
  } catch let error as BrokerJournalError {
    #expect(error == expected)
  } catch {
    Issue.record("Unexpected error type: \(String(reflecting: error))")
  }
}
