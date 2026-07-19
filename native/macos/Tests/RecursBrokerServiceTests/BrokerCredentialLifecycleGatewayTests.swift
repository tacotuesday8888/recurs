import Foundation
import RecursBrokerXPC
import Testing

@testable import RecursBrokerCore
@testable import RecursBrokerService

@Suite(.serialized)
struct BrokerCredentialLifecycleGatewayTests {
  private let connectionID = UUID(uuidString: "40000000-0000-4000-8000-000000000001")!
  private let operationID = UUID(uuidString: "50000000-0000-4000-8000-000000000001")!
  private let attemptID = UUID(uuidString: "60000000-0000-4000-8000-000000000001")!

  @Test
  func helloGateConsumesIDsAndDispatchesEveryLifecycleOperation() async throws {
    let authority = GatewayAuthority()
    let gateway = BrokerCredentialLifecycleGateway(authority: authority)

    let denied = LockedReplyProbe()
    gateway.submitControl(
      try BrokerCredentialControlRequest.projection(
        requestID: 1,
        connectionID: connectionID
      ).encode(),
      reply: denied.receive
    )
    #expect(try decoded(denied.wait()) == .failure(requestID: 1, .sessionNotReady))

    gateway.authorizeAfterHello()
    let replay = LockedReplyProbe()
    gateway.submitControl(
      try BrokerCredentialControlRequest.projection(
        requestID: 1,
        connectionID: connectionID
      ).encode(),
      reply: replay.receive
    )
    #expect(try decoded(replay.wait()) == .failure(requestID: 1, .invalidRequest))

    let projected = LockedReplyProbe()
    gateway.submitControl(
      try BrokerCredentialControlRequest.projection(
        requestID: 2,
        connectionID: connectionID
      ).encode(),
      reply: projected.receive
    )
    #expect(
      try decoded(projected.wait())
        == .projection(
          requestID: 2,
          try BrokerCredentialRedactedProjection(
            state: .vacant,
            fence: 0,
            hasUsableReady: false,
            attemptID: nil
          )
        )
    )

    let staged = LockedReplyProbe()
    let secretCanary = "secret-canary-9dbec5"
    var fragmentedSecret = Data("secret-".utf8)
    fragmentedSecret.append(Data("canary-".utf8))
    fragmentedSecret.append(Data("9dbec5".utf8))
    gateway.submitStage(
      metadata: try BrokerCredentialStageRequest(
        requestID: 3,
        connectionID: connectionID,
        operationID: operationID,
        expectedFence: 0,
        providerBinding: try builtInStageBinding()
      ).encode(),
      secret: fragmentedSecret,
      reply: staged.receive
    )
    let stagedData = staged.wait()
    #expect(!String(decoding: stagedData, as: UTF8.self).contains(secretCanary))
    #expect(
      try decoded(stagedData)
        == .staged(
          requestID: 3,
          try BrokerCredentialRedactedProjection(
            state: .staging,
            fence: 1,
            hasUsableReady: false,
            attemptID: attemptID
          )
        )
    )
    #expect(await authority.receivedExpectedSecret())
    #expect(await authority.receivedProviderBinding() == .openAI)

    let resumed = LockedReplyProbe()
    gateway.submitControl(
      try BrokerCredentialControlRequest.resumeStage(
        requestID: 4,
        connectionID: connectionID,
        operationID: operationID,
        expectedFence: 0
      ).encode(),
      reply: resumed.receive
    )
    #expect(try decoded(resumed.wait()).requestID == 4)

    let aborted = LockedReplyProbe()
    gateway.submitControl(
      try BrokerCredentialControlRequest.abort(
        requestID: 5,
        connectionID: connectionID,
        attemptID: attemptID,
        operationID: UUID(),
        expectedFence: 1
      ).encode(),
      reply: aborted.receive
    )
    #expect(
      try decoded(aborted.wait())
        == .mutation(
          requestID: 5,
          try BrokerCredentialRedactedProjection(
            state: .vacant,
            fence: 1,
            hasUsableReady: false,
            attemptID: nil
          )
        )
    )

    let disconnected = LockedReplyProbe()
    gateway.submitControl(
      try BrokerCredentialControlRequest.disconnect(
        requestID: 6,
        connectionID: connectionID,
        operationID: UUID(),
        expectedFence: 1
      ).encode(),
      reply: disconnected.receive
    )
    #expect(try decoded(disconnected.wait()).requestID == 6)

    let reserved = LockedReplyProbe()
    gateway.submitControl(
      try BrokerCredentialControlRequest.reservedOperation(requestID: 7).encode(),
      reply: reserved.receive
    )
    #expect(try decoded(reserved.wait()) == .failure(requestID: 7, .operationUnavailable))
    #expect(await authority.callCount() == 5)
  }

  @Test
  func stageMapsEverySupportedDescriptorToTheExactCoreBinding() async throws {
    let cases: [(BrokerCredentialStageBindingDescriptor, ProviderProfileBinding)] = [
      (
        try BrokerCredentialStageBindingDescriptor(activationProfileID: "openai_api_v1"),
        .openAI
      ),
      (
        try BrokerCredentialStageBindingDescriptor(activationProfileID: "anthropic_api_v1"),
        .anthropic
      ),
      (
        try BrokerCredentialStageBindingDescriptor(activationProfileID: "kimi_code_v1"),
        .kimiCode
      ),
      (
        try BrokerCredentialStageBindingDescriptor(
          activationProfileID: "custom_openai_compatible_v1",
          customBaseURL: "https://gateway.vendor.dev/v1",
          customModelCatalogBehavior: .modelsRoute
        ),
        try .customOpenAICompatible(
          baseURL: "https://gateway.vendor.dev/v1",
          modelCatalogBehavior: .modelsRoute
        )
      ),
      (
        try BrokerCredentialStageBindingDescriptor(
          activationProfileID: "custom_openai_compatible_v1",
          customBaseURL: "https://inference.vendor.net/base",
          customModelCatalogBehavior: .unavailable
        ),
        try .customOpenAICompatible(
          baseURL: "https://inference.vendor.net/base",
          modelCatalogBehavior: .unavailable
        )
      ),
    ]

    for (offset, fixture) in cases.enumerated() {
      let authority = GatewayAuthority()
      let gateway = BrokerCredentialLifecycleGateway(authority: authority)
      gateway.authorizeAfterHello()
      let reply = LockedReplyProbe()
      gateway.submitStage(
        metadata: try BrokerCredentialStageRequest(
          requestID: UInt64(offset + 1),
          connectionID: connectionID,
          operationID: operationID,
          expectedFence: 0,
          providerBinding: fixture.0
        ).encode(),
        secret: Data("secret-canary-9dbec5".utf8),
        reply: reply.receive
      )
      #expect(try decoded(reply.wait()).requestID == UInt64(offset + 1))
      #expect(await authority.receivedProviderBinding() == fixture.1)
      #expect(await authority.callCount() == 1)
    }
  }

  @Test
  func invalidProviderBindingIsRejectedBeforeAdmissionAndConsumesItsID() async throws {
    let invalid = [
      try BrokerCredentialStageBindingDescriptor(
        activationProfileID: "future_profile_v1"
      ),
      try BrokerCredentialStageBindingDescriptor(
        activationProfileID: "openai_api_v1",
        customBaseURL: "https://gateway.vendor.dev/v1",
        customModelCatalogBehavior: .modelsRoute
      ),
      try BrokerCredentialStageBindingDescriptor(
        activationProfileID: "custom_openai_compatible_v1"
      ),
      try BrokerCredentialStageBindingDescriptor(
        activationProfileID: "custom_openai_compatible_v1",
        customBaseURL: "https://127.0.0.1/v1",
        customModelCatalogBehavior: .unavailable
      ),
      try BrokerCredentialStageBindingDescriptor(
        activationProfileID: "custom_openai_compatible_v1",
        customBaseURL: "https://api.openai.com/v1",
        customModelCatalogBehavior: .modelsRoute
      ),
      try BrokerCredentialStageBindingDescriptor(
        activationProfileID: "custom_openai_compatible_v1",
        customBaseURL: "https://gateway.vendor.dev/v1/",
        customModelCatalogBehavior: .modelsRoute
      ),
    ]

    for descriptor in invalid {
      let authority = GatewayAuthority()
      let gateway = BrokerCredentialLifecycleGateway(authority: authority)
      let rejected = LockedReplyProbe()
      gateway.submitStage(
        metadata: try BrokerCredentialStageRequest(
          requestID: 1,
          connectionID: connectionID,
          operationID: operationID,
          expectedFence: 0,
          providerBinding: descriptor
        ).encode(),
        secret: Data("secret-canary-9dbec5".utf8),
        reply: rejected.receive
      )
      let rejectedData = rejected.wait()
      #expect(try decoded(rejectedData) == .failure(requestID: 1, .invalidRequest))
      let rejectedText = String(decoding: rejectedData, as: UTF8.self)
      #expect(!rejectedText.contains(descriptor.activationProfileID))
      if let customBaseURL = descriptor.customBaseURL {
        #expect(!rejectedText.contains(customBaseURL))
      }
      #expect(await authority.callCount() == 0)

      gateway.authorizeAfterHello()
      let replay = LockedReplyProbe()
      gateway.submitControl(
        try BrokerCredentialControlRequest.projection(
          requestID: 1,
          connectionID: connectionID
        ).encode(),
        reply: replay.receive
      )
      #expect(try decoded(replay.wait()) == .failure(requestID: 1, .invalidRequest))
      #expect(await authority.callCount() == 0)
    }
  }

  @Test
  func malformedFramesEchoOnlyCanonicalIDsAndConsumeThem() throws {
    let authority = GatewayAuthority()
    let gateway = BrokerCredentialLifecycleGateway(authority: authority)
    gateway.authorizeAfterHello()

    let unframed = LockedReplyProbe()
    gateway.submitControl(Data([0, 1, 2]), reply: unframed.receive)
    #expect(
      try decoded(unframed.wait())
        == .failure(requestID: brokerCredentialMalformedRequestID, .invalidRequest)
    )

    var lateMalformed = try BrokerCredentialControlRequest.projection(
      requestID: 9,
      connectionID: connectionID
    ).encode()
    lateMalformed.replaceSubrange(20..<36, with: repeatElement(UInt8(0), count: 16))
    let malformed = LockedReplyProbe()
    gateway.submitControl(lateMalformed, reply: malformed.receive)
    #expect(try decoded(malformed.wait()) == .failure(requestID: 9, .invalidRequest))

    let replay = LockedReplyProbe()
    gateway.submitControl(
      try BrokerCredentialControlRequest.projection(
        requestID: 9,
        connectionID: connectionID
      ).encode(),
      reply: replay.receive
    )
    #expect(try decoded(replay.wait()) == .failure(requestID: 9, .invalidRequest))
  }

  @Test
  func boundedAdmissionAndCloseCancelExactlyOnce() async throws {
    let authority = GatewayAuthority(suspendProjection: true)
    let gateway = BrokerCredentialLifecycleGateway(authority: authority)
    gateway.authorizeAfterHello()
    let accepted = (1...BrokerCredentialLifecycleGateway.maximumInflightRequests).map { _ in
      LockedReplyProbe()
    }

    for (offset, probe) in accepted.enumerated() {
      gateway.submitControl(
        try BrokerCredentialControlRequest.projection(
          requestID: UInt64(offset + 1),
          connectionID: connectionID
        ).encode(),
        reply: probe.receive
      )
    }
    let reservedID = UInt64(BrokerCredentialLifecycleGateway.maximumInflightRequests + 1)
    let reserved = LockedReplyProbe()
    gateway.submitControl(
      try BrokerCredentialControlRequest.reservedOperation(requestID: reservedID).encode(),
      reply: reserved.receive
    )
    #expect(
      try decoded(reserved.wait()) == .failure(requestID: reservedID, .operationUnavailable)
    )

    let overflowID = reservedID + 1
    let overflow = LockedReplyProbe()
    gateway.submitControl(
      try BrokerCredentialControlRequest.projection(
        requestID: overflowID,
        connectionID: connectionID
      ).encode(),
      reply: overflow.receive
    )
    #expect(try decoded(overflow.wait()) == .failure(requestID: overflowID, .capacityExceeded))

    let overflowReplay = LockedReplyProbe()
    gateway.submitControl(
      try BrokerCredentialControlRequest.projection(
        requestID: overflowID,
        connectionID: connectionID
      ).encode(),
      reply: overflowReplay.receive
    )
    #expect(
      try decoded(overflowReplay.wait()) == .failure(requestID: overflowID, .invalidRequest)
    )

    #expect(
      await authority.waitForCallCount(
        BrokerCredentialLifecycleGateway.maximumInflightRequests
      )
    )
    gateway.close()
    for (offset, probe) in accepted.enumerated() {
      #expect(try decoded(probe.wait()) == .failure(requestID: UInt64(offset + 1), .cancelled))
      #expect(probe.count == 1)
    }
    gateway.close()
    #expect(accepted.allSatisfy { $0.count == 1 })
    #expect(await authority.callCount() == BrokerCredentialLifecycleGateway.maximumInflightRequests)
  }

  @Test
  func closeOwnsRepliesAfterClearingInflightEntries() async throws {
    let authority = GatewayAuthority(suspendProjection: true)
    let gateway = BrokerCredentialLifecycleGateway(authority: authority)
    let replies = BlockingReplyProbe()
    gateway.authorizeAfterHello()

    for requestID in UInt64(1)...2 {
      gateway.submitControl(
        try BrokerCredentialControlRequest.projection(
          requestID: requestID,
          connectionID: connectionID
        ).encode(),
        reply: replies.receive
      )
    }
    #expect(await authority.waitForCallCount(2))

    let close = Task.detached { gateway.close() }
    #expect(replies.waitForCount(1) == 1)

    let reentrant = LockedReplyProbe()
    gateway.submitControl(
      try BrokerCredentialControlRequest.reservedOperation(requestID: 3).encode(),
      reply: reentrant.receive
    )
    #expect(try decoded(reentrant.wait()) == .failure(requestID: 3, .cancelled))

    replies.releaseFirst()
    await close.value
    #expect(replies.waitForCount(2) == 2)
    #expect(replies.snapshot() == [.cancelled, .cancelled])
  }

  @Test(arguments: [
    GatewayFailure.state(.cancelled, .cancelled),
    GatewayFailure.state(.connectionNotFound, .notFound),
    .state(.connectionTombstoned, .disconnected),
    .state(.staleFence, .staleFence),
    .state(.fenceOverflow, .conflict),
    .state(.generationOverflow, .conflict),
    .state(.invalidTransition, .conflict),
    .state(.attemptNotCurrent, .conflict),
    .state(.operationIDConflict, .conflict),
    .state(.operationInProgress, .busy),
    .state(.storeUnavailable, .credentialStoreUnavailable),
    .state(.cleanupPending, .cleanupPending),
    .state(.invalidBootstrap, .authorityUnavailable),
    .journal(.casConflict, .conflict),
    .journal(.revisionOverflow, .conflict),
    .journal(.lockUnavailable, .credentialStoreUnavailable),
    .journal(.storageUnavailable, .credentialStoreUnavailable),
    .journal(.mutationOutcomeUnknown, .cleanupPending),
    .journal(.invalidRecord, .authorityUnavailable),
    .journal(.nonCanonical, .authorityUnavailable),
    .journal(.unsupportedVersion, .authorityUnavailable),
    .journal(.authenticationFailed, .authorityUnavailable),
    .journal(.rollbackDetected, .authorityUnavailable),
  ])
  func fixedErrorMapping(_ fixture: GatewayFailure) throws {
    let authority = GatewayAuthority(failure: fixture)
    let gateway = BrokerCredentialLifecycleGateway(authority: authority)
    gateway.authorizeAfterHello()
    let probe = LockedReplyProbe()
    switch fixture {
    case .state:
      gateway.submitControl(
        try BrokerCredentialControlRequest.resumeStage(
          requestID: 1,
          connectionID: connectionID,
          operationID: operationID,
          expectedFence: 0
        ).encode(),
        reply: probe.receive
      )
    case .journal:
      gateway.submitControl(
        try BrokerCredentialControlRequest.projection(
          requestID: 1,
          connectionID: connectionID
        ).encode(),
        reply: probe.receive
      )
    }
    #expect(try decoded(probe.wait()) == .failure(requestID: 1, fixture.code))

    if fixture.isSevere {
      let afterClose = LockedReplyProbe()
      gateway.submitControl(
        try BrokerCredentialControlRequest.projection(
          requestID: 2,
          connectionID: connectionID
        ).encode(),
        reply: afterClose.receive
      )
      #expect(try decoded(afterClose.wait()) == .failure(requestID: 2, .cancelled))
    }
  }

  @Test(arguments: [
    0,
    brokerCredentialMaximumSecretBytes + 1,
  ])
  func invalidStageLengthIsRejectedBeforeAuthorityAndConsumesItsID(
    _ byteCount: Int
  ) async throws {
    let authority = GatewayAuthority()
    let gateway = BrokerCredentialLifecycleGateway(authority: authority)
    gateway.authorizeAfterHello()
    let rejected = LockedReplyProbe()
    gateway.submitStage(
      metadata: try BrokerCredentialStageRequest(
        requestID: 1,
        connectionID: connectionID,
        operationID: operationID,
        expectedFence: 0,
        providerBinding: try builtInStageBinding()
      ).encode(),
      secret: Data(repeating: 0x5a, count: byteCount),
      reply: rejected.receive
    )
    #expect(try decoded(rejected.wait()) == .failure(requestID: 1, .invalidRequest))
    #expect(await authority.callCount() == 0)

    let replay = LockedReplyProbe()
    gateway.submitControl(
      try BrokerCredentialControlRequest.projection(
        requestID: 1,
        connectionID: connectionID
      ).encode(),
      reply: replay.receive
    )
    #expect(try decoded(replay.wait()) == .failure(requestID: 1, .invalidRequest))
  }

  private func decoded(_ data: Data) throws -> BrokerCredentialLifecycleReply {
    try BrokerCredentialLifecycleReply.decode(data)
  }

}

private func builtInStageBinding() throws -> BrokerCredentialStageBindingDescriptor {
  try BrokerCredentialStageBindingDescriptor(activationProfileID: "openai_api_v1")
}

enum GatewayFailure: Sendable, CustomTestStringConvertible {
  case state(BrokerStateError, BrokerCredentialLifecycleFailureCode)
  case journal(BrokerJournalError, BrokerCredentialLifecycleFailureCode)

  var code: BrokerCredentialLifecycleFailureCode {
    switch self {
    case .state(_, let code), .journal(_, let code): code
    }
  }

  var isSevere: Bool {
    switch self {
    case .state(.invalidBootstrap, _): true
    case .journal(let error, _):
      [
        .invalidRecord, .nonCanonical, .unsupportedVersion, .authenticationFailed,
        .rollbackDetected,
      ]
      .contains(error)
    default: false
    }
  }

  var testDescription: String { String(describing: code) }
}

private struct GatewayAuthority: BrokerCredentialLifecycleAuthority {
  private let suspendProjection: Bool
  private let failure: GatewayFailure?
  private let state = GatewayAuthorityState()

  init(suspendProjection: Bool = false, failure: GatewayFailure? = nil) {
    self.suspendProjection = suspendProjection
    self.failure = failure
  }

  func authoritativeLifecycleProjection(
    for connectionID: UUID
  ) async throws(BrokerJournalError) -> CredentialLifecycleProjection {
    await state.recordCall()
    if case .journal(let error, _) = failure { throw error }
    if suspendProjection {
      do {
        try await Task.sleep(for: .seconds(60))
      } catch {
        throw .storageUnavailable
      }
    }
    return .vacant(connectionID: connectionID, fence: 0)
  }

  func stage(
    connectionID: UUID,
    providerBinding: ProviderProfileBinding,
    operationID: UUID,
    expectedFence: UInt64,
    secret: sending SecretBytes
  ) async throws(BrokerStateError) -> StagingAttempt {
    await state.recordCall()
    if case .state(let error, _) = failure {
      secret.erase()
      throw error
    }
    let matchesExpected = secret.withUnsafeBytes {
      Data($0) == Data("secret-canary-9dbec5".utf8)
    }
    secret.erase()
    await state.recordSecretMatch(matchesExpected)
    await state.recordProviderBinding(providerBinding)
    return stagingAttempt(connectionID: connectionID, fence: expectedFence + 1)
  }

  func resumeStage(
    connectionID: UUID,
    operationID: UUID,
    expectedFence: UInt64
  ) async throws(BrokerStateError) -> StagingAttempt {
    await state.recordCall()
    if case .state(let error, _) = failure { throw error }
    return stagingAttempt(connectionID: connectionID, fence: expectedFence + 1)
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
    await state.recordCall()
    if case .state(let error, _) = failure { throw error }
    return nil
  }

  func disconnect(
    connectionID: UUID,
    operationID: UUID,
    expectedFence: UInt64
  ) async throws(BrokerStateError) -> TombstoneProjection {
    await state.recordCall()
    if case .state(let error, _) = failure { throw error }
    return TombstoneProjection(
      connectionID: connectionID,
      fence: expectedFence + 1,
      lastGenerationOrdinal: expectedFence,
      tombstonedAt: Date(timeIntervalSince1970: 1)
    )
  }

  func receivedExpectedSecret() async -> Bool { await state.receivedExpectedSecret() }
  func receivedProviderBinding() async -> ProviderProfileBinding? {
    await state.receivedProviderBinding()
  }
  func callCount() async -> Int { await state.callCount() }

  func waitForCallCount(
    _ expected: Int,
    timeout: Duration = .seconds(3)
  ) async -> Bool {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: timeout)
    while await state.callCount() < expected {
      guard clock.now < deadline else { return false }
      try? await Task.sleep(for: .milliseconds(10))
    }
    return true
  }

  private nonisolated func stagingAttempt(connectionID: UUID, fence: UInt64) -> StagingAttempt {
    StagingAttempt(
      connectionID: connectionID,
      attemptID: UUID(uuidString: "60000000-0000-4000-8000-000000000001")!,
      fence: fence,
      candidate: CredentialGeneration(
        generationID: UUID(uuidString: "70000000-0000-4000-8000-000000000001")!,
        ordinal: fence,
        createdAt: Date(timeIntervalSince1970: 1)
      ),
      previousReady: nil,
      startedAt: Date(timeIntervalSince1970: 1)
    )
  }
}

private actor GatewayAuthorityState {
  private var calls = 0
  private var matchedExpectedSecret = false
  private var providerBinding: ProviderProfileBinding?

  func recordCall() { calls += 1 }
  func recordSecretMatch(_ matches: Bool) { matchedExpectedSecret = matches }
  func recordProviderBinding(_ value: ProviderProfileBinding) { providerBinding = value }
  func receivedExpectedSecret() -> Bool { matchedExpectedSecret }
  func receivedProviderBinding() -> ProviderProfileBinding? { providerBinding }
  func callCount() -> Int { calls }
}

private final class LockedReplyProbe: @unchecked Sendable {
  private let condition = NSCondition()
  private var values: [Data] = []

  var count: Int {
    condition.lock()
    defer { condition.unlock() }
    return values.count
  }

  func receive(_ data: Data) {
    condition.lock()
    values.append(data)
    condition.broadcast()
    condition.unlock()
  }

  func wait(timeout: TimeInterval = 3) -> Data {
    condition.lock()
    defer { condition.unlock() }
    let deadline = Date().addingTimeInterval(timeout)
    while values.isEmpty, condition.wait(until: deadline) {}
    guard let first = values.first else {
      Issue.record("Timed out waiting for a credential lifecycle reply")
      return Data()
    }
    return first
  }
}

private final class BlockingReplyProbe: @unchecked Sendable {
  private let condition = NSCondition()
  private var codes: [BrokerCredentialLifecycleFailureCode] = []
  private var firstMayReturn = false

  func receive(_ data: Data) {
    guard case .failure(_, let code) = try? BrokerCredentialLifecycleReply.decode(data) else {
      Issue.record("Expected a canonical close reply")
      return
    }
    condition.lock()
    codes.append(code)
    condition.broadcast()
    while codes.count == 1, !firstMayReturn { condition.wait() }
    condition.unlock()
  }

  func waitForCount(_ expected: Int, timeout: TimeInterval = 3) -> Int {
    condition.lock()
    defer { condition.unlock() }
    let deadline = Date().addingTimeInterval(timeout)
    while codes.count < expected, condition.wait(until: deadline) {}
    return codes.count
  }

  func releaseFirst() {
    condition.withLock {
      firstMayReturn = true
      condition.broadcast()
    }
  }

  func snapshot() -> [BrokerCredentialLifecycleFailureCode] {
    condition.withLock { codes }
  }
}

extension BrokerCredentialLifecycleReply {
  fileprivate var requestID: UInt64 {
    switch self {
    case .projection(let requestID, _), .staged(let requestID, _),
      .mutation(let requestID, _), .failure(let requestID, _):
      requestID
    }
  }
}
