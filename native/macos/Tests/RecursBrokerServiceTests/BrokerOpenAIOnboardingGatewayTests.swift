import Foundation
import RecursBrokerXPC
import Testing

@testable import RecursBrokerCore
@testable import RecursBrokerService

@Suite(.serialized)
struct BrokerOpenAIOnboardingGatewayTests {
  @Test
  func helloEndpointAndRequestIDGatesAreSharedAndMonotonic() throws {
    let system = makeSystem()

    let denied = OnboardingReplyProbe()
    system.gateway.submitBegin(
      try BrokerOpenAIOnboardingRequest.begin(requestID: 1).encode(),
      secret: Data("denied-secret".utf8),
      reply: denied.receive
    )
    #expect(try decoded(denied.wait()) == .failure(requestID: 1, .sessionNotReady))

    system.gateway.authorizeAfterHello()
    let replay = OnboardingReplyProbe()
    system.gateway.submitControl(
      try BrokerOpenAIOnboardingRequest.verify(requestID: 1).encode(),
      reply: replay.receive
    )
    #expect(try decoded(replay.wait()) == .failure(requestID: 1, .invalidRequest))

    let wrongBeginEndpoint = OnboardingReplyProbe()
    system.gateway.submitBegin(
      try BrokerOpenAIOnboardingRequest.verify(requestID: 2).encode(),
      secret: Data("wrong-endpoint-secret".utf8),
      reply: wrongBeginEndpoint.receive
    )
    #expect(
      try decoded(wrongBeginEndpoint.wait()) == .failure(requestID: 2, .invalidRequest)
    )

    let wrongControlEndpoint = OnboardingReplyProbe()
    system.gateway.submitControl(
      try BrokerOpenAIOnboardingRequest.begin(requestID: 3).encode(),
      reply: wrongControlEndpoint.receive
    )
    #expect(
      try decoded(wrongControlEndpoint.wait()) == .failure(requestID: 3, .invalidRequest)
    )

    let noSession = OnboardingReplyProbe()
    system.gateway.submitControl(
      try BrokerOpenAIOnboardingRequest.verify(requestID: 4).encode(),
      reply: noSession.receive
    )
    #expect(try decoded(noSession.wait()) == .failure(requestID: 4, .sessionNotReady))
    #expect(system.authority.stageCalls.isEmpty)
    #expect(system.factory.calls.isEmpty)
  }

  @Test
  func reconciliationFailsClosedByDefaultAndRequiresAFreshSession() throws {
    let fresh = makeSystem()
    fresh.gateway.authorizeAfterHello()
    let unresolved = OnboardingReplyProbe()
    fresh.gateway.submitReconciliation(
      try BrokerOpenAIActivationReconciliationRequest.reconcile(
        requestID: 1,
        connectionID: connectionID
      ).encode(),
      reply: unresolved.receive
    )
    #expect(
      try BrokerOpenAIActivationReconciliationReply.decode(unresolved.wait())
        == .status(requestID: 1, .unresolved)
    )

    let active = makeSystem()
    active.gateway.authorizeAfterHello()
    _ = submitBegin(active.gateway).wait()
    let rejected = OnboardingReplyProbe()
    active.gateway.submitReconciliation(
      try BrokerOpenAIActivationReconciliationRequest.reconcile(
        requestID: 2,
        connectionID: connectionID
      ).encode(),
      reply: rejected.receive
    )
    #expect(
      try BrokerOpenAIActivationReconciliationReply.decode(rejected.wait())
        == .failure(requestID: 2, .operationUnavailable)
    )
  }

  @Test
  func beginStagesOpenAIWithBrokerOwnedIdentityAndBuildsOneFreshSession() throws {
    let system = makeSystem()
    system.gateway.authorizeAfterHello()

    let begun = submitBegin(system.gateway)
    #expect(
      try decoded(begun.wait())
        == .begun(
          requestID: 1,
          connectionID: connectionID,
          recoveryTokens: try BrokerOpenAIOnboardingRecoveryTokens(
            commitOperationID: commitOperationID,
            abortOperationID: abortOperationID
          ),
          credentialIdentityFingerprint: credentialIdentityFingerprint.rawValue
        )
    )
    #expect(
      system.fingerprinter.calls == [
        FingerprintCall(
          credential: Data(secretCanary.utf8),
          binding: .openAI
        )
      ]
    )
    #expect(
      system.authority.stageCalls == [
        StageCall(
          connectionID: connectionID,
          providerBinding: .openAI,
          operationID: stageOperationID,
          expectedFence: 0,
          secret: Data(secretCanary.utf8),
          secretWasErased: true
        )
      ]
    )
    #expect(
      system.factory.calls == [
        FactoryCall(
          context: BrokerOpenAIOnboardingStagingContext(
            connectionID: connectionID,
            attemptID: attemptID,
            fence: 1,
            providerBinding: .openAI,
            expiresAt: Date(timeIntervalSince1970: 301)
          ),
          abortOperationID: abortOperationID
        )
      ]
    )

    let duplicateBegin = OnboardingReplyProbe()
    system.gateway.submitBegin(
      try BrokerOpenAIOnboardingRequest.begin(requestID: 2).encode(),
      secret: Data("second-secret".utf8),
      reply: duplicateBegin.receive
    )
    #expect(
      try decoded(duplicateBegin.wait()) == .failure(requestID: 2, .operationUnavailable)
    )
    #expect(system.authority.stageCalls.count == 1)
    #expect(system.factory.calls.count == 1)
  }

  @Test
  func invalidSecretsAndUnavailableAuthorityNeverBuildASession() throws {
    for (offset, secret) in [
      Data(),
      Data(repeating: 0x61, count: brokerCredentialMaximumSecretBytes + 1),
    ].enumerated() {
      let system = makeSystem()
      system.gateway.authorizeAfterHello()
      let reply = OnboardingReplyProbe()
      system.gateway.submitBegin(
        try BrokerOpenAIOnboardingRequest.begin(requestID: UInt64(offset + 1)).encode(),
        secret: secret,
        reply: reply.receive
      )
      #expect(
        try decoded(reply.wait())
          == .failure(requestID: UInt64(offset + 1), .invalidRequest)
      )
      #expect(system.authority.stageCalls.isEmpty)
      #expect(system.factory.calls.isEmpty)
    }

    let system = makeSystem(stageResult: .failure(.storeUnavailable))
    system.gateway.authorizeAfterHello()
    let unavailable = submitBegin(system.gateway)
    #expect(
      try decoded(unavailable.wait())
        == .failure(requestID: 1, .credentialStoreUnavailable)
    )
    #expect(system.authority.stageCalls.count == 1)
    #expect(system.authority.stageCalls[0].secretWasErased)
    #expect(system.factory.calls.isEmpty)
  }

  @Test(arguments: fingerprintFailureFixtures)
  func credentialIdentityFailuresEraseAndNeverStageTheSecret(
    _ fixture: FingerprintFailureFixture
  ) throws {
    let system = makeSystem(fingerprintResult: .failure(fixture.error))
    system.gateway.authorizeAfterHello()
    let secretMemory = SecretMemoryProbe(Data(secretCanary.utf8))
    let reply = OnboardingReplyProbe()

    system.gateway.submitBegin(
      try BrokerOpenAIOnboardingRequest.begin(requestID: 1).encode(),
      secret: secretMemory.consumeData(),
      reply: reply.receive
    )
    let encoded = reply.wait()

    #expect(try decoded(encoded) == .failure(requestID: 1, fixture.expectedCode))
    #expect(
      system.fingerprinter.calls == [
        FingerprintCall(
          credential: Data(secretCanary.utf8),
          binding: .openAI
        )
      ]
    )
    #expect(system.authority.stageCalls.isEmpty)
    #expect(system.factory.calls.isEmpty)
    #expect(!encoded.contains(Data(secretCanary.utf8)))
    #expect(secretMemory.isErased)
  }

  @Test
  func invalidGeneratedIdentityFailsBeforeStage() throws {
    let invalidSequences = [
      [zeroUUID, stageOperationID, commitOperationID, abortOperationID],
      [connectionID, zeroUUID, commitOperationID, abortOperationID],
      [connectionID, stageOperationID, commitOperationID, commitOperationID],
      [connectionID, stageOperationID, stageOperationID, abortOperationID],
      [connectionID, connectionID, commitOperationID, abortOperationID],
    ]

    for values in invalidSequences {
      let authority = OnboardingGatewayAuthority(result: .success)
      let session = GatewaySession(
        connectionID: connectionID,
        verifyResult: .success(
          BrokerOpenAIModelCatalog(modelIDs: ["gpt-5"], requestID: nil)
        ),
        finalizeResult: .success
      )
      let factory = GatewaySessionFactory(session: session)
      let source = OnboardingUUIDSource(values)
      let gateway = BrokerOpenAIOnboardingGateway(
        authority: authority,
        factory: factory,
        credentialIdentityFingerprinter: GatewayCredentialIdentityFingerprinter(),
        makeUUID: source.next
      )
      gateway.authorizeAfterHello()

      let reply = submitBegin(gateway)

      #expect(
        try decoded(reply.wait()) == .failure(requestID: 1, .authorityUnavailable)
      )
      #expect(authority.stageCalls.isEmpty)
      #expect(factory.calls.isEmpty)
    }
  }

  @Test
  func malformedSuccessfulStageIsCleanedOrRequiresReconciliation() throws {
    let mismatchedConnection = UUID(
      uuidString: "70000000-0000-4000-8000-000000000001"
    )!
    let cleanable = makeSystem(
      stageResult: .malformedAttempt(
        connectionID: mismatchedConnection,
        attemptID: attemptID,
        fence: 1
      )
    )
    cleanable.gateway.authorizeAfterHello()

    #expect(
      try decoded(submitBegin(cleanable.gateway).wait())
        == .failure(requestID: 1, .authorityUnavailable)
    )
    #expect(
      cleanable.authority.abortCalls == [
        LifecycleCall(
          connectionID: connectionID,
          attemptID: attemptID,
          operationID: abortOperationID,
          expectedFence: 1
        )
      ]
    )

    let unrecoverable = makeSystem(
      stageResult: .malformedAttempt(
        connectionID: connectionID,
        attemptID: zeroUUID,
        fence: 1
      )
    )
    unrecoverable.gateway.authorizeAfterHello()

    #expect(
      try decoded(submitBegin(unrecoverable.gateway).wait())
        == .failure(requestID: 1, .reconciliationRequired)
    )
    #expect(unrecoverable.authority.abortCalls.isEmpty)
  }

  @Test
  func factoryFailureCleansTheOwnedStagingAttempt() throws {
    let system = makeSystem(factoryFailure: .invalidContext)
    system.gateway.authorizeAfterHello()

    let reply = submitBegin(system.gateway)

    #expect(
      try decoded(reply.wait()) == .failure(requestID: 1, .authorityUnavailable)
    )
    #expect(
      system.authority.abortCalls == [
        LifecycleCall(
          connectionID: connectionID,
          attemptID: attemptID,
          operationID: abortOperationID,
          expectedFence: 1
        )
      ]
    )
    #expect(system.factory.calls.count == 1)
  }

  @Test
  func verificationReturnsExactSequentialCatalogPages() async throws {
    let models = (0..<260).map { String(format: "model-%03d", $0) }
    let catalog = BrokerOpenAIModelCatalog(modelIDs: models, requestID: "catalog-1")
    let system = makeSystem(verifyResult: .success(catalog))
    system.gateway.authorizeAfterHello()
    _ = submitBegin(system.gateway).wait()

    let first = submitControl(system.gateway, .verify(requestID: 2))
    let firstPage = try catalogPage(decoded(first.wait()))
    #expect(firstPage.cursor == 0)
    #expect(firstPage.totalModelCount == 260)
    #expect(firstPage.nextCursor == 128)
    #expect(firstPage.catalogRequestID == "catalog-1")
    #expect(firstPage.modelIDs == Array(models[0..<128]))

    let skipped = submitControl(
      system.gateway,
      .catalogPage(requestID: 3, cursor: 129)
    )
    #expect(try decoded(skipped.wait()) == .failure(requestID: 3, .invalidRequest))

    let second = submitControl(
      system.gateway,
      .catalogPage(requestID: 4, cursor: 128)
    )
    let secondPage = try catalogPage(decoded(second.wait()))
    #expect(secondPage.cursor == 128)
    #expect(secondPage.nextCursor == 256)
    #expect(secondPage.modelIDs == Array(models[128..<256]))

    let terminal = submitControl(
      system.gateway,
      .catalogPage(requestID: 5, cursor: 256)
    )
    let terminalPage = try catalogPage(decoded(terminal.wait()))
    #expect(terminalPage.cursor == 256)
    #expect(terminalPage.nextCursor == nil)
    #expect(terminalPage.modelIDs == Array(models[256..<260]))

    let repeated = submitControl(
      system.gateway,
      .catalogPage(requestID: 6, cursor: 256)
    )
    #expect(try decoded(repeated.wait()) == .failure(requestID: 6, .invalidRequest))
    let verifyCalls = await system.session.verifyCalls
    #expect(verifyCalls == 1)
  }

  @Test
  func oneInflightOperationIsBusyAndCloseCancelsThenFailsClosed() async throws {
    let pause = OnboardingPause()
    let catalog = BrokerOpenAIModelCatalog(modelIDs: ["gpt-5"], requestID: nil)
    let system = makeSystem(verifyResult: .paused(catalog, pause))
    system.gateway.authorizeAfterHello()
    _ = submitBegin(system.gateway).wait()

    let verification = submitControl(system.gateway, .verify(requestID: 2))
    await pause.waitUntilEntered()

    let busy = submitControl(system.gateway, .abort(requestID: 3))
    #expect(try decoded(busy.wait()) == .failure(requestID: 3, .busy))

    system.gateway.close()
    #expect(try decoded(verification.wait()) == .failure(requestID: 2, .cancelled))
    #expect(await system.session.waitForCloseFinishes(1))
    #expect(verification.count == 1)

    let afterClose = submitControl(system.gateway, .abort(requestID: 4))
    #expect(try decoded(afterClose.wait()) == .failure(requestID: 4, .cancelled))
    #expect(await system.session.closeStarts == 1)
  }

  @Test
  func transportTeardownSuppressesLateReplyButStillClosesSession() async throws {
    let pause = OnboardingPause()
    let catalog = BrokerOpenAIModelCatalog(modelIDs: ["gpt-5"], requestID: nil)
    let system = makeSystem(verifyResult: .paused(catalog, pause))
    system.gateway.authorizeAfterHello()
    _ = submitBegin(system.gateway).wait()

    let verification = submitControl(system.gateway, .verify(requestID: 2))
    await pause.waitUntilEntered()
    system.gateway.transportTeardown()

    #expect(await system.session.waitForCloseFinishes(1))
    try? await Task.sleep(for: .milliseconds(20))
    #expect(verification.count == 0)
  }

  @Test
  func postVerificationValidationReportsFailedCleanup() throws {
    let invalidCatalog = BrokerOpenAIModelCatalog(
      modelIDs: ["z-model", "a-model"],
      requestID: nil
    )
    let system = makeSystem(
      verifyResult: .success(invalidCatalog),
      closeError: .cleanupFailed
    )
    system.gateway.authorizeAfterHello()
    _ = submitBegin(system.gateway).wait()

    let reply = submitControl(system.gateway, .verify(requestID: 2))

    #expect(try decoded(reply.wait()) == .failure(requestID: 2, .cleanupFailed))
  }

  @Test
  func finalizeAndAbortUseOnlyBrokerOwnedRecoveryOperations() async throws {
    let catalog = BrokerOpenAIModelCatalog(
      modelIDs: ["gpt-5", "gpt-5-mini"],
      requestID: "catalog-finalize"
    )
    let finalized = makeSystem(verifyResult: .success(catalog))
    finalized.gateway.authorizeAfterHello()
    _ = submitBegin(finalized.gateway).wait()
    _ = submitControl(finalized.gateway, .verify(requestID: 2)).wait()

    let committed = submitControl(
      finalized.gateway,
      .finalize(requestID: 3, exactModelID: "gpt-5")
    )
    #expect(
      try decoded(committed.wait())
        == .committed(
          requestID: 3,
          try BrokerOpenAIOnboardingCommitReceipt(
            connectionID: connectionID,
            selectedModelID: "gpt-5",
            verifiedModelCount: 2,
            catalogRequestID: "catalog-finalize"
          )
        )
    )
    #expect(
      await finalized.session.finalizeCalls == [
        FinalizeCall(exactModelID: "gpt-5", operationID: commitOperationID)
      ]
    )

    let aborted = makeSystem(verifyResult: .success(catalog))
    aborted.gateway.authorizeAfterHello()
    _ = submitBegin(aborted.gateway).wait()
    let abortReply = submitControl(aborted.gateway, .abort(requestID: 2))
    #expect(try decoded(abortReply.wait()) == .aborted(requestID: 2))
    #expect(await aborted.session.closeStarts == 1)
    #expect(aborted.factory.calls[0].abortOperationID == abortOperationID)
    #expect(aborted.authority.abortCalls.isEmpty)
  }

  @Test
  func closeDuringCommitDelegatesToSessionCloseWithoutStartingAbort() async throws {
    let pause = OnboardingPause()
    let catalog = BrokerOpenAIModelCatalog(modelIDs: ["gpt-5"], requestID: nil)
    let system = makeSystem(
      verifyResult: .success(catalog),
      finalizeResult: .paused(pause)
    )
    system.gateway.authorizeAfterHello()
    _ = submitBegin(system.gateway).wait()
    _ = submitControl(system.gateway, .verify(requestID: 2)).wait()

    let committing = submitControl(
      system.gateway,
      .finalize(requestID: 3, exactModelID: "gpt-5")
    )
    await pause.waitUntilEntered()
    system.gateway.close()

    #expect(await system.session.waitForCloseStarts(1))
    #expect(await system.session.closeFinishes == 0)
    #expect(committing.count == 0)
    await pause.release()
    #expect(
      try decoded(committing.wait())
        == .committed(
          requestID: 3,
          try BrokerOpenAIOnboardingCommitReceipt(
            connectionID: connectionID,
            selectedModelID: "gpt-5",
            verifiedModelCount: 1,
            catalogRequestID: nil
          )
        )
    )
    #expect(await system.session.waitForCloseFinishes(1))
    #expect(system.authority.abortCalls.isEmpty)
    #expect(committing.count == 1)
  }

  @Test(arguments: sessionFailureFixtures)
  func sessionFailuresMapToFixedReplyCodes(_ fixture: SessionFailureFixture) throws {
    let system = makeSystem(verifyResult: .failure(fixture.error))
    system.gateway.authorizeAfterHello()
    _ = submitBegin(system.gateway).wait()

    let reply = submitControl(system.gateway, .verify(requestID: 2))

    #expect(
      try decoded(reply.wait()) == .failure(requestID: 2, fixture.expectedCode)
    )
  }

  @Test(arguments: stageFailureFixtures)
  func stageFailuresMapToFixedReplyCodes(_ fixture: StageFailureFixture) throws {
    let system = makeSystem(stageResult: .failure(fixture.error))
    system.gateway.authorizeAfterHello()

    let reply = submitBegin(system.gateway)

    #expect(
      try decoded(reply.wait()) == .failure(requestID: 1, fixture.expectedCode)
    )
    #expect(system.authority.stageCalls[0].secretWasErased)
    #expect(system.factory.calls.isEmpty)
  }

  private func makeSystem(
    stageResult: OnboardingGatewayAuthority.StageResult = .success,
    verifyResult: GatewaySession.VerifyResult = .success(
      BrokerOpenAIModelCatalog(modelIDs: ["gpt-5"], requestID: nil)
    ),
    finalizeResult: GatewaySession.FinalizeResult = .success,
    factoryFailure: BrokerOpenAIOnboardingError? = nil,
    closeError: BrokerOpenAIOnboardingError? = nil,
    fingerprintResult: GatewayCredentialIdentityFingerprinter.Result = .success
  ) -> GatewaySystem {
    let authority = OnboardingGatewayAuthority(result: stageResult)
    let session = GatewaySession(
      connectionID: connectionID,
      verifyResult: verifyResult,
      finalizeResult: finalizeResult,
      closeError: closeError
    )
    let factory = GatewaySessionFactory(session: session, failure: factoryFailure)
    let fingerprinter = GatewayCredentialIdentityFingerprinter(result: fingerprintResult)
    let source = OnboardingUUIDSource([
      connectionID, stageOperationID, commitOperationID, abortOperationID,
    ])
    return GatewaySystem(
      gateway: BrokerOpenAIOnboardingGateway(
        authority: authority,
        factory: factory,
        credentialIdentityFingerprinter: fingerprinter,
        makeUUID: source.next
      ),
      authority: authority,
      factory: factory,
      fingerprinter: fingerprinter,
      session: session
    )
  }
}

private let connectionID = UUID(uuidString: "10000000-0000-4000-8000-000000000001")!
private let stageOperationID = UUID(
  uuidString: "20000000-0000-4000-8000-000000000001"
)!
private let commitOperationID = UUID(
  uuidString: "30000000-0000-4000-8000-000000000001"
)!
private let abortOperationID = UUID(
  uuidString: "40000000-0000-4000-8000-000000000001"
)!
private let attemptID = UUID(uuidString: "50000000-0000-4000-8000-000000000001")!
private let generationID = UUID(uuidString: "60000000-0000-4000-8000-000000000001")!
private let secretCanary = "onboarding-secret-canary-84f2"
private let credentialIdentityFingerprint = try! CredentialIdentityFingerprint(
  validating: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
)
private let zeroUUID = UUID(uuid: (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0))

private struct GatewaySystem {
  let gateway: BrokerOpenAIOnboardingGateway
  let authority: OnboardingGatewayAuthority
  let factory: GatewaySessionFactory
  let fingerprinter: GatewayCredentialIdentityFingerprinter
  let session: GatewaySession
}

private struct FingerprintCall: Sendable, Equatable {
  let credential: Data
  let binding: ProviderProfileBinding
}

private final class GatewayCredentialIdentityFingerprinter:
  @unchecked Sendable,
  CredentialIdentityFingerprinting
{
  enum Result: Sendable {
    case success
    case failure(CredentialIdentityFingerprintError)
  }

  private let lock = NSLock()
  private let result: Result
  private var storedCalls: [FingerprintCall] = []

  init(result: Result = .success) {
    self.result = result
  }

  var calls: [FingerprintCall] { lock.withLock { storedCalls } }

  func fingerprint(
    credential: UnsafeRawBufferPointer,
    binding: ProviderProfileBinding
  ) throws(CredentialIdentityFingerprintError) -> CredentialIdentityFingerprint {
    lock.withLock {
      storedCalls.append(
        FingerprintCall(credential: Data(credential), binding: binding)
      )
    }
    switch result {
    case .success:
      return credentialIdentityFingerprint
    case .failure(let error):
      throw error
    }
  }
}

private final class SecretMemoryProbe {
  private let pointer: UnsafeMutableRawPointer
  private let byteCount: Int

  init(_ data: Data) {
    byteCount = data.count
    pointer = .allocate(byteCount: byteCount, alignment: 1)
    data.withUnsafeBytes { source in
      pointer.copyMemory(from: source.baseAddress!, byteCount: byteCount)
    }
  }

  deinit {
    pointer.initializeMemory(as: UInt8.self, repeating: 0, count: byteCount)
    pointer.deallocate()
  }

  var isErased: Bool {
    let bytes = UnsafeRawBufferPointer(start: pointer, count: byteCount)
    return bytes.allSatisfy { $0 == 0 }
  }

  func consumeData() -> Data {
    Data(bytesNoCopy: pointer, count: byteCount, deallocator: .none)
  }
}

private struct StageCall: Sendable, Equatable {
  let connectionID: UUID
  let providerBinding: ProviderProfileBinding
  let operationID: UUID
  let expectedFence: UInt64
  let secret: Data
  let secretWasErased: Bool
}

private final class OnboardingGatewayAuthority:
  @unchecked Sendable,
  BrokerCredentialLifecycleAuthority
{
  enum StageResult: Sendable {
    case success
    case malformedAttempt(connectionID: UUID, attemptID: UUID, fence: UInt64)
    case failure(BrokerStateError)
  }

  private let lock = NSLock()
  private let result: StageResult
  private var storedStageCalls: [StageCall] = []
  private var storedAbortCalls: [LifecycleCall] = []

  init(result: StageResult) {
    self.result = result
  }

  var stageCalls: [StageCall] { lock.withLock { storedStageCalls } }
  var abortCalls: [LifecycleCall] { lock.withLock { storedAbortCalls } }

  func authoritativeLifecycleProjection(
    for connectionID: UUID
  ) async throws(BrokerJournalError) -> CredentialLifecycleProjection {
    .staging(
      connectionID: connectionID,
      fence: 1,
      attemptID: attemptID,
      hasUsableReady: false
    )
  }

  func stage(
    connectionID: UUID,
    providerBinding: ProviderProfileBinding,
    operationID: UUID,
    expectedFence: UInt64,
    secret: sending SecretBytes
  ) async throws(BrokerStateError) -> StagingAttempt {
    let copiedSecret = secret.withUnsafeBytes { Data($0) }
    secret.erase()
    let erased = secret.withUnsafeBytes { $0.isEmpty }
    lock.withLock {
      storedStageCalls.append(
        StageCall(
          connectionID: connectionID,
          providerBinding: providerBinding,
          operationID: operationID,
          expectedFence: expectedFence,
          secret: copiedSecret,
          secretWasErased: erased
        )
      )
    }
    if case .failure(let error) = result { throw error }
    let returnedIdentity: (connectionID: UUID, attemptID: UUID, fence: UInt64) =
      switch result {
      case .success, .failure:
        (connectionID, attemptID, 1)
      case .malformedAttempt(let returnedConnectionID, let returnedAttemptID, let fence):
        (returnedConnectionID, returnedAttemptID, fence)
      }
    return StagingAttempt(
      connectionID: returnedIdentity.connectionID,
      attemptID: returnedIdentity.attemptID,
      fence: returnedIdentity.fence,
      candidate: CredentialGeneration(
        generationID: generationID,
        ordinal: 1,
        createdAt: Date(timeIntervalSince1970: 1)
      ),
      previousReady: nil,
      startedAt: Date(timeIntervalSince1970: 1)
    )
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
    throw .invalidTransition
  }

  func abort(
    connectionID: UUID,
    attemptID: UUID,
    operationID: UUID,
    expectedFence: UInt64
  ) async throws(BrokerStateError) -> ReadyProjection? {
    lock.withLock {
      storedAbortCalls.append(
        LifecycleCall(
          connectionID: connectionID,
          attemptID: attemptID,
          operationID: operationID,
          expectedFence: expectedFence
        )
      )
    }
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

private struct FactoryCall: Sendable, Equatable {
  let context: BrokerOpenAIOnboardingStagingContext
  let abortOperationID: UUID
}

private final class GatewaySessionFactory:
  @unchecked Sendable,
  BrokerOpenAIOnboardingSessionFactory
{
  private let lock = NSLock()
  private let session: GatewaySession
  private let failure: BrokerOpenAIOnboardingError?
  private var storedCalls: [FactoryCall] = []

  init(session: GatewaySession, failure: BrokerOpenAIOnboardingError? = nil) {
    self.session = session
    self.failure = failure
  }

  var calls: [FactoryCall] { lock.withLock { storedCalls } }

  func makeSession(
    context: BrokerOpenAIOnboardingStagingContext,
    abortOperationID: UUID
  ) throws(BrokerOpenAIOnboardingError) -> any BrokerOpenAIOnboardingSessionProtocol {
    lock.withLock {
      storedCalls.append(FactoryCall(context: context, abortOperationID: abortOperationID))
    }
    if let failure { throw failure }
    return session
  }
}

private struct FinalizeCall: Sendable, Equatable {
  let exactModelID: String
  let operationID: UUID
}

private actor GatewaySession: BrokerOpenAIOnboardingSessionProtocol {
  enum VerifyResult: Sendable {
    case success(BrokerOpenAIModelCatalog)
    case failure(BrokerOpenAIOnboardingError)
    case paused(BrokerOpenAIModelCatalog, OnboardingPause)
  }

  enum FinalizeResult: Sendable {
    case success
    case failure(BrokerOpenAIOnboardingError)
    case paused(OnboardingPause)
  }

  private let connectionID: UUID
  private let verifyResult: VerifyResult
  private let finalizeResult: FinalizeResult
  private let closeError: BrokerOpenAIOnboardingError?
  private(set) var verifyCalls = 0
  private(set) var finalizeCalls: [FinalizeCall] = []
  private(set) var closeStarts = 0
  private(set) var closeFinishes = 0
  private var verifyActive = false
  private var finalizeActive = false

  init(
    connectionID: UUID,
    verifyResult: VerifyResult,
    finalizeResult: FinalizeResult,
    closeError: BrokerOpenAIOnboardingError? = nil
  ) {
    self.connectionID = connectionID
    self.verifyResult = verifyResult
    self.finalizeResult = finalizeResult
    self.closeError = closeError
  }

  func verify() async throws(BrokerOpenAIOnboardingError) -> BrokerOpenAIModelCatalog {
    verifyCalls += 1
    verifyActive = true
    defer { verifyActive = false }
    switch verifyResult {
    case .success(let catalog):
      return catalog
    case .failure(let error):
      throw error
    case .paused(let catalog, let pause):
      await pause.wait()
      if Task.isCancelled { throw .cancelled }
      return catalog
    }
  }

  func finalize(
    exactModelID: String,
    operationID: UUID
  ) async throws(BrokerOpenAIOnboardingError) -> BrokerOpenAIOnboardingReceipt {
    finalizeCalls.append(
      FinalizeCall(exactModelID: exactModelID, operationID: operationID)
    )
    finalizeActive = true
    defer { finalizeActive = false }
    switch finalizeResult {
    case .success:
      break
    case .failure(let error):
      throw error
    case .paused(let pause):
      await pause.wait()
    }
    let catalog: BrokerOpenAIModelCatalog
    switch verifyResult {
    case .success(let value), .paused(let value, _):
      catalog = value
    case .failure:
      throw .invalidState
    }
    return BrokerOpenAIOnboardingReceipt(
      ready: readyProjection(connectionID: connectionID),
      selectedModelID: exactModelID,
      catalogRequestID: catalog.requestID,
      verifiedModelCount: catalog.modelIDs.count
    )
  }

  func close() async throws(BrokerOpenAIOnboardingError) {
    closeStarts += 1
    if verifyActive, case .paused(_, let pause) = verifyResult {
      await pause.release()
    }
    if finalizeActive, case .paused(let pause) = finalizeResult {
      await pause.wait()
    }
    if let closeError { throw closeError }
    closeFinishes += 1
  }

  func waitForCloseStarts(_ expected: Int) async -> Bool {
    await waitUntil { closeStarts >= expected }
  }

  func waitForCloseFinishes(_ expected: Int) async -> Bool {
    await waitUntil { closeFinishes >= expected }
  }

  private func waitUntil(_ condition: () -> Bool) async -> Bool {
    let deadline = ContinuousClock.now.advanced(by: .seconds(3))
    while !condition() {
      guard ContinuousClock.now < deadline else { return false }
      await Task.yield()
    }
    return true
  }
}

private actor OnboardingPause {
  private var entered = false
  private var released = false
  private var waiters: [CheckedContinuation<Void, Never>] = []

  func wait() async {
    entered = true
    guard !released else { return }
    await withCheckedContinuation { waiters.append($0) }
  }

  func waitUntilEntered() async {
    while !entered { await Task.yield() }
  }

  func release() {
    released = true
    let selected = waiters
    waiters.removeAll()
    for waiter in selected { waiter.resume() }
  }
}

private final class OnboardingUUIDSource: @unchecked Sendable {
  private let lock = NSLock()
  private var values: [UUID]

  init(_ values: [UUID]) {
    self.values = values
  }

  func next() -> UUID {
    lock.withLock {
      guard !values.isEmpty else {
        return UUID(uuid: (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0))
      }
      return values.removeFirst()
    }
  }
}

private final class OnboardingReplyProbe: @unchecked Sendable {
  private let condition = NSCondition()
  private var values: [Data] = []

  var count: Int { condition.withLock { values.count } }

  func receive(_ value: Data) {
    condition.withLock {
      values.append(value)
      condition.broadcast()
    }
  }

  func wait(timeout: TimeInterval = 3) -> Data {
    condition.lock()
    defer { condition.unlock() }
    let deadline = Date().addingTimeInterval(timeout)
    while values.isEmpty, condition.wait(until: deadline) {}
    guard let first = values.first else {
      Issue.record("Timed out waiting for an onboarding gateway reply")
      return Data()
    }
    return first
  }
}

struct SessionFailureFixture: Sendable, CustomTestStringConvertible {
  let error: BrokerOpenAIOnboardingError
  let expectedCode: BrokerOpenAIOnboardingFailureCode
  var testDescription: String { String(describing: expectedCode) }
}

struct StageFailureFixture: Sendable, CustomTestStringConvertible {
  let error: BrokerStateError
  let expectedCode: BrokerOpenAIOnboardingFailureCode
  var testDescription: String { "\(error) → \(expectedCode)" }
}

struct FingerprintFailureFixture: Sendable, CustomTestStringConvertible {
  let error: CredentialIdentityFingerprintError
  let expectedCode: BrokerOpenAIOnboardingFailureCode
  var testDescription: String { "\(error) → \(expectedCode)" }
}

private let sessionFailureFixtures = [
  SessionFailureFixture(error: .cancelled, expectedCode: .cancelled),
  SessionFailureFixture(error: .expired, expectedCode: .expired),
  SessionFailureFixture(error: .invalidContext, expectedCode: .authorityUnavailable),
  SessionFailureFixture(error: .invalidModel, expectedCode: .invalidModel),
  SessionFailureFixture(error: .invalidState, expectedCode: .operationUnavailable),
  SessionFailureFixture(error: .noCompatibleModels, expectedCode: .noCompatibleModels),
  SessionFailureFixture(error: .verificationFailed, expectedCode: .verificationFailed),
  SessionFailureFixture(error: .commitFailed, expectedCode: .commitFailed),
  SessionFailureFixture(error: .cleanupFailed, expectedCode: .cleanupFailed),
  SessionFailureFixture(
    error: .reconciliationRequired,
    expectedCode: .reconciliationRequired
  ),
]

private let stageFailureFixtures = [
  StageFailureFixture(error: .cancelled, expectedCode: .cancelled),
  StageFailureFixture(error: .connectionNotFound, expectedCode: .authorityUnavailable),
  StageFailureFixture(error: .connectionTombstoned, expectedCode: .authorityUnavailable),
  StageFailureFixture(error: .staleFence, expectedCode: .authorityUnavailable),
  StageFailureFixture(error: .fenceOverflow, expectedCode: .authorityUnavailable),
  StageFailureFixture(error: .generationOverflow, expectedCode: .authorityUnavailable),
  StageFailureFixture(error: .invalidTransition, expectedCode: .authorityUnavailable),
  StageFailureFixture(error: .attemptNotCurrent, expectedCode: .authorityUnavailable),
  StageFailureFixture(error: .operationIDConflict, expectedCode: .authorityUnavailable),
  StageFailureFixture(error: .operationInProgress, expectedCode: .busy),
  StageFailureFixture(error: .storeUnavailable, expectedCode: .credentialStoreUnavailable),
  StageFailureFixture(error: .cleanupPending, expectedCode: .cleanupFailed),
  StageFailureFixture(error: .invalidBootstrap, expectedCode: .authorityUnavailable),
]

private let fingerprintFailureFixtures = [
  FingerprintFailureFixture(
    error: .keyUnavailable,
    expectedCode: .credentialStoreUnavailable
  ),
  FingerprintFailureFixture(
    error: .keyMalformed,
    expectedCode: .credentialStoreUnavailable
  ),
  FingerprintFailureFixture(error: .invalidCredential, expectedCode: .authorityUnavailable),
  FingerprintFailureFixture(error: .invalidBinding, expectedCode: .authorityUnavailable),
  FingerprintFailureFixture(error: .invalidFingerprint, expectedCode: .authorityUnavailable),
]

private func submitBegin(
  _ gateway: BrokerOpenAIOnboardingGateway,
  requestID: UInt64 = 1
) -> OnboardingReplyProbe {
  let probe = OnboardingReplyProbe()
  do {
    gateway.submitBegin(
      try BrokerOpenAIOnboardingRequest.begin(requestID: requestID).encode(),
      secret: Data(secretCanary.utf8),
      reply: probe.receive
    )
  } catch {
    Issue.record("Failed to construct a valid begin request")
  }
  return probe
}

private func submitControl(
  _ gateway: BrokerOpenAIOnboardingGateway,
  _ request: BrokerOpenAIOnboardingRequest
) -> OnboardingReplyProbe {
  let probe = OnboardingReplyProbe()
  do {
    gateway.submitControl(try request.encode(), reply: probe.receive)
  } catch {
    Issue.record("Failed to construct a valid control request")
  }
  return probe
}

private func decoded(_ data: Data) throws -> BrokerOpenAIOnboardingReply {
  try BrokerOpenAIOnboardingReply.decode(data)
}

private func catalogPage(
  _ reply: BrokerOpenAIOnboardingReply
) throws -> BrokerOpenAIOnboardingCatalogPage {
  guard case .catalogPage(_, let page) = reply else {
    throw TestFixtureError.unexpectedReply
  }
  return page
}

private func readyProjection(connectionID: UUID) -> ReadyProjection {
  ReadyProjection(
    connectionID: connectionID,
    fence: 1,
    ready: ReadyGeneration(
      generation: CredentialGeneration(
        generationID: generationID,
        ordinal: 1,
        createdAt: Date(timeIntervalSince1970: 1)
      ),
      committedAt: Date(timeIntervalSince1970: 2)
    ),
    lastGenerationOrdinal: 1
  )
}

private struct LifecycleCall: Sendable, Equatable {
  let connectionID: UUID
  let attemptID: UUID
  let operationID: UUID
  let expectedFence: UInt64
}

private enum TestFixtureError: Error {
  case unexpectedReply
}
