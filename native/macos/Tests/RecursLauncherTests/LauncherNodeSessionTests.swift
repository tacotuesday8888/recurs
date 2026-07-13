import Foundation
import RecursBrokerXPC
import RecursNativeProtocol
import RecursNativeSecurity
import Testing

@testable import RecursLauncher

@Suite("Launcher node session")
struct LauncherNodeSessionTests {
  private let nonce = Data((0..<nativeNonceByteCount).map(UInt8.init))

  @Test
  func onlyTheExactRawSetupInvocationOwnsManualSecretCaptureAuthority() {
    #expect(isExactOpenAISetupInvocation(["setup", "openai"]))
    for arguments in [
      ["setup"],
      ["setup", "openai", "--json"],
      ["setup", "anthropic"],
      ["run", "setup", "openai"],
    ] {
      #expect(!isExactOpenAISetupInvocation(arguments))
    }
  }

  @Test
  func fragmentedHelloLazilyOpensOneBrokerAndPreservesNodeRequestID() async throws {
    let system = ScriptedSessionBrokerConnection()
    let factory = try makeBrokerFactory(system)
    let output = RecordingSessionOutput()
    let session = LauncherNodeSession(
      brokerConnectionFactory: { () throws(BrokerConnectionError) -> BrokerConnection in
        try factory.make()
      },
      output: output
    )
    let hello = try helloFrame(requestID: 41)

    #expect(!(await session.isAwaitingFrameCompletion()))
    await session.receive(Data())
    #expect(!(await session.isAwaitingFrameCompletion()))
    for byte in hello.dropLast() {
      await session.receive(Data([byte]))
      #expect(await session.isAwaitingFrameCompletion())
    }
    #expect(factory.makeCount == 0)
    #expect(system.exchangeFrames.isEmpty)

    await session.receive(Data([try #require(hello.last)]))
    #expect(!(await session.isAwaitingFrameCompletion()))
    await eventually("hello response") { await output.snapshot().written.count == 1 }

    let snapshot = await output.snapshot()
    let frame = try decodeSingleFrame(try #require(snapshot.written.first))
    let result = try HelloResultMessage.decode(frame)
    #expect(frame.requestID == 41)
    #expect(result.echoedNonce == nonce)
    #expect(factory.makeCount == 1)
    #expect(system.exchangeFrames.map(\.type) == [.hello])
    #expect(system.exchangeFrames.map(\.requestID) == [1])

    await session.close()
    #expect(!(await session.isAwaitingFrameCompletion()))
    await session.finish()
    await session.close()
    await eventually("session close") { await output.snapshot().closeCount == 1 }
    #expect(system.invalidationCount == 1)
  }

  @Test
  func batchedHelloAndHealthRequestsRunSeriallyInFIFOOrder() async throws {
    let system = ScriptedSessionBrokerConnection()
    let factory = try makeBrokerFactory(system)
    let output = RecordingSessionOutput()
    let session = LauncherNodeSession(
      brokerConnectionFactory: { () throws(BrokerConnectionError) -> BrokerConnection in
        try factory.make()
      },
      output: output
    )
    let input = concatenate([
      try helloFrame(requestID: 10),
      try HealthMessage().encodedFrame(requestID: 11),
      try HealthMessage().encodedFrame(requestID: 12),
      try HealthMessage().encodedFrame(requestID: 13),
    ])

    await session.receive(input)
    #expect(!(await session.isAwaitingFrameCompletion()))
    await eventually("first health begins") {
      let writtenCount = await output.snapshot().written.count
      return system.exchangeFrames.count == 2 && system.pendingHealthCount == 1
        && writtenCount == 1
    }
    #expect(system.exchangeFrames.map(\.type) == [.hello, .health])

    try system.replyNextHealth(keychain: .available)
    await eventually("second health begins") {
      let writtenCount = await output.snapshot().written.count
      return system.exchangeFrames.count == 3 && system.pendingHealthCount == 1
        && writtenCount == 2
    }
    try system.replyNextHealth(keychain: .locked)
    await eventually("third health begins") {
      let writtenCount = await output.snapshot().written.count
      return system.exchangeFrames.count == 4 && system.pendingHealthCount == 1
        && writtenCount == 3
    }
    try system.replyNextHealth(keychain: .unavailable)
    await eventually("all health responses") {
      await output.snapshot().written.count == 4
    }

    let frames = try decodeFrames((await output.snapshot()).written)
    #expect(frames.map(\.type) == [.helloResult, .healthResult, .healthResult, .healthResult])
    #expect(frames.map(\.requestID) == [10, 11, 12, 13])
    #expect(system.exchangeFrames.map(\.requestID) == [1, 2, 3, 4])
    #expect(factory.makeCount == 1)
    await session.close()
  }

  @Test
  func authorizedBeginCapturesTheSecretNativelyAndReturnsOnlyRedactedIdentity() async throws {
    let canary = "NODE_MUST_NEVER_SEE_THIS_PROVIDER_SECRET"
    let system = ScriptedSessionBrokerConnection()
    let factory = try makeBrokerFactory(system)
    let output = RecordingSessionOutput()
    let capture = LauncherOpenAISecretCapture(
      capture: { TTYSecret(Array(canary.utf8)) },
      cancelAndWait: {}
    )
    let session = LauncherNodeSession(
      brokerConnectionFactory: { () throws(BrokerConnectionError) -> BrokerConnection in
        try factory.make()
      },
      output: output,
      openAISecretCapture: capture
    )

    await session.receive(try helloFrame(requestID: 1))
    await eventually("handshake") { await output.snapshot().written.count == 1 }
    await session.receive(
      try OpenAIOnboardingRequestMessage.begin.encodedFrame(requestID: 2)
    )
    await eventually("redacted onboarding begun") {
      await output.snapshot().written.count == 2
    }

    let snapshot = await output.snapshot()
    let begunFrame = try decodeSingleFrame(try #require(snapshot.written.last))
    let begun = try OpenAIOnboardingBegunMessage.decode(begunFrame)
    #expect(begun.connectionID == system.onboardingConnectionID)
    #expect(begun.credentialIdentityFingerprint == system.onboardingFingerprint)
    #expect(system.receivedOnboardingSecretBytes == [Array(canary.utf8)])
    #expect(concatenate(snapshot.attempted).range(of: Data(canary.utf8)) == nil)
    #expect(Array(Mirror(reflecting: begun).children).count == 2)
    await session.close()
  }

  @Test
  func verifyPageAndFinalizePreserveTheClosedOnboardingStateMachine() async throws {
    let system = ScriptedSessionBrokerConnection()
    let factory = try makeBrokerFactory(system)
    let output = RecordingSessionOutput()
    let session = LauncherNodeSession(
      brokerConnectionFactory: { () throws(BrokerConnectionError) -> BrokerConnection in
        try factory.make()
      },
      output: output,
      openAISecretCapture: LauncherOpenAISecretCapture(
        capture: { TTYSecret([0x61]) },
        cancelAndWait: {}
      )
    )

    await session.receive(try helloFrame(requestID: 1))
    await eventually("handshake") { await output.snapshot().written.count == 1 }
    await session.receive(
      try OpenAIOnboardingRequestMessage.begin.encodedFrame(requestID: 2)
    )
    await eventually("begin") { await output.snapshot().written.count == 2 }
    await session.receive(
      try OpenAIOnboardingRequestMessage.verify.encodedFrame(requestID: 3)
    )
    await eventually("verify") { await output.snapshot().written.count == 3 }
    await session.receive(
      try OpenAIOnboardingRequestMessage.catalogPage(cursor: 2)
        .encodedFrame(requestID: 4)
    )
    await eventually("catalog page") { await output.snapshot().written.count == 4 }
    await session.receive(
      try OpenAIOnboardingRequestMessage.finalize(exactModelID: "gpt-5.3")
        .encodedFrame(requestID: 5)
    )
    await eventually("commit") { await output.snapshot().written.count == 5 }

    let frames = try decodeFrames((await output.snapshot()).written)
    let firstPage = try OpenAIOnboardingCatalogPageMessage.decode(frames[2])
    let finalPage = try OpenAIOnboardingCatalogPageMessage.decode(frames[3])
    let committed = try OpenAIOnboardingCommittedMessage.decode(frames[4])
    #expect(firstPage.modelIDs == ["gpt-5.1", "gpt-5.2"])
    #expect(firstPage.nextCursor == 2)
    #expect(finalPage.modelIDs == ["gpt-5.3"])
    #expect(finalPage.nextCursor == nil)
    #expect(committed.connectionID == system.onboardingConnectionID)
    #expect(committed.selectedModelID == "gpt-5.3")
    #expect(committed.verifiedModelCount == 3)
    #expect(frames.map(\.requestID) == [1, 2, 3, 4, 5])
    await session.close()
  }

  @Test
  func reconciliationNeedsNoSetupAuthorizationAndExposesOnlyAFixedStatus() async throws {
    let system = ScriptedSessionBrokerConnection()
    let factory = try makeBrokerFactory(system)
    let output = RecordingSessionOutput()
    let session = LauncherNodeSession(
      brokerConnectionFactory: { () throws(BrokerConnectionError) -> BrokerConnection in
        try factory.make()
      },
      output: output
    )

    await session.receive(try helloFrame(requestID: 1))
    await eventually("handshake") { await output.snapshot().written.count == 1 }
    await session.receive(
      try OpenAIOnboardingRequestMessage.reconcile(
        connectionID: system.onboardingConnectionID,
        credentialIdentityFingerprint: system.onboardingFingerprint
      ).encodedFrame(requestID: 2)
    )
    await eventually("reconciliation") { await output.snapshot().written.count == 2 }

    let frame = try decodeSingleFrame(
      try #require((await output.snapshot()).written.last)
    )
    #expect(
      try OpenAIOnboardingReconciliationMessage.decode(frame).status
        == .readyOpenAI
    )
    #expect(system.receivedOnboardingSecretBytes.isEmpty)
    await session.close()
  }

  @Test
  func beginWithoutTheExactSetupAuthorizationIsRejectedBeforeSecretCapture() async throws {
    let system = ScriptedSessionBrokerConnection()
    let factory = try makeBrokerFactory(system)
    let output = RecordingSessionOutput()
    let session = LauncherNodeSession(
      brokerConnectionFactory: { () throws(BrokerConnectionError) -> BrokerConnection in
        try factory.make()
      },
      output: output
    )

    await session.receive(try helloFrame(requestID: 1))
    await eventually("handshake") { await output.snapshot().written.count == 1 }
    await session.receive(
      try OpenAIOnboardingRequestMessage.begin.encodedFrame(requestID: 2)
    )
    await eventually("authorization rejection") {
      await output.snapshot().written.count == 2
    }

    let failureFrame = try decodeSingleFrame(
      try #require((await output.snapshot()).written.last)
    )
    #expect(
      try OpenAIOnboardingFailureMessage.decode(failureFrame).code
        == .operationUnavailable
    )
    #expect(system.receivedOnboardingSecretBytes.isEmpty)
    #expect((await output.snapshot()).closeCount == 0)
    await session.close()
  }

  @Test
  func everyTTYFailureMapsToOneFixedOnboardingFailure() async throws {
    let mappings: [(TTYSecretCaptureError, OpenAIOnboardingFailureCode)] = [
      (.userPresenceRequired, .operationUnavailable),
      (.automationDenied, .operationUnavailable),
      (.terminalUnavailable, .authorityUnavailable),
      (.invalidTerminalMode, .operationUnavailable),
      (.alreadyUsed, .busy),
      (.cancelled, .cancelled),
      (.emptySecret, .invalidRequest),
      (.invalidSecret, .invalidRequest),
      (.secretTooLong, .invalidRequest),
      (.inputOutputFailure, .authorityUnavailable),
      (.terminalRestoreFailure, .cleanupFailed),
    ]

    for (failure, expected) in mappings {
      let system = ScriptedSessionBrokerConnection()
      let factory = try makeBrokerFactory(system)
      let output = RecordingSessionOutput()
      let session = LauncherNodeSession(
        brokerConnectionFactory: {
          () throws(BrokerConnectionError) -> BrokerConnection in
          try factory.make()
        },
        output: output,
        openAISecretCapture: LauncherOpenAISecretCapture(
          capture: { () async throws(TTYSecretCaptureError) -> TTYSecret in
            throw failure
          },
          cancelAndWait: {}
        )
      )

      await session.receive(try helloFrame(requestID: 1))
      await eventually("handshake") { await output.snapshot().written.count == 1 }
      await session.receive(
        try OpenAIOnboardingRequestMessage.begin.encodedFrame(requestID: 2)
      )
      await eventually("TTY failure") {
        await output.snapshot().closeCount == 1
      }
      await session.close()

      let frames = try decodeFrames((await output.snapshot()).written)
      #expect(frames.count == 2)
      #expect(try OpenAIOnboardingFailureMessage.decode(frames[1]).code == expected)
      #expect(system.receivedOnboardingSecretBytes.isEmpty)
      #expect((await output.snapshot()).closeCount == 1)
      #expect(system.invalidationCount == 1)
    }
  }

  @Test
  func onboardingOutputFailureClosesWithoutExposingTheSecretOrNativeError() async throws {
    let secretCanary = "ONBOARDING_OUTPUT_SECRET_CANARY"
    let errorCanary = "ONBOARDING_OUTPUT_ERROR_CANARY"
    let system = ScriptedSessionBrokerConnection()
    let factory = try makeBrokerFactory(system)
    let output = RecordingSessionOutput(
      failOnAttempt: 2,
      canary: errorCanary
    )
    let session = LauncherNodeSession(
      brokerConnectionFactory: { () throws(BrokerConnectionError) -> BrokerConnection in
        try factory.make()
      },
      output: output,
      openAISecretCapture: LauncherOpenAISecretCapture(
        capture: { TTYSecret(Array(secretCanary.utf8)) },
        cancelAndWait: {}
      )
    )

    await session.receive(try helloFrame(requestID: 1))
    await eventually("handshake") { await output.snapshot().written.count == 1 }
    await session.receive(
      try OpenAIOnboardingRequestMessage.begin.encodedFrame(requestID: 2)
    )
    await eventually("onboarding output failure") {
      await output.snapshot().closeCount == 1
    }
    await session.close()

    let snapshot = await output.snapshot()
    let attempted = concatenate(snapshot.attempted)
    #expect(snapshot.attempted.count == 2)
    #expect(snapshot.written.count == 1)
    #expect(attempted.range(of: Data(secretCanary.utf8)) == nil)
    #expect(attempted.range(of: Data(errorCanary.utf8)) == nil)
    #expect(snapshot.closeCount == 1)
    #expect(system.invalidationCount == 1)
  }

  @Test
  func invalidOrderingReturnsFixedFailuresWithoutAdvancingTheSetupState() async throws {
    let system = ScriptedSessionBrokerConnection()
    let factory = try makeBrokerFactory(system)
    let output = RecordingSessionOutput()
    let session = LauncherNodeSession(
      brokerConnectionFactory: { () throws(BrokerConnectionError) -> BrokerConnection in
        try factory.make()
      },
      output: output,
      openAISecretCapture: LauncherOpenAISecretCapture(
        capture: { TTYSecret([0x63]) },
        cancelAndWait: {}
      )
    )

    await session.receive(try helloFrame(requestID: 1))
    await eventually("handshake") { await output.snapshot().written.count == 1 }
    await session.receive(
      try OpenAIOnboardingRequestMessage.verify.encodedFrame(requestID: 2)
    )
    await eventually("pre-begin rejection") { await output.snapshot().written.count == 2 }
    await session.receive(
      try OpenAIOnboardingRequestMessage.begin.encodedFrame(requestID: 3)
    )
    await eventually("begin") { await output.snapshot().written.count == 3 }
    await session.receive(
      try OpenAIOnboardingRequestMessage.catalogPage(cursor: 2)
        .encodedFrame(requestID: 4)
    )
    await eventually("pre-verify rejection") { await output.snapshot().written.count == 4 }
    await session.receive(
      try OpenAIOnboardingRequestMessage.verify.encodedFrame(requestID: 5)
    )
    await eventually("verify") { await output.snapshot().written.count == 5 }
    await session.receive(
      try OpenAIOnboardingRequestMessage.abort.encodedFrame(requestID: 6)
    )
    await eventually("abort") { await output.snapshot().written.count == 6 }
    await session.receive(
      try OpenAIOnboardingRequestMessage.verify.encodedFrame(requestID: 7)
    )
    await eventually("post-terminal rejection") {
      await output.snapshot().written.count == 7
    }

    let frames = try decodeFrames((await output.snapshot()).written)
    #expect(try OpenAIOnboardingFailureMessage.decode(frames[1]).code == .sessionNotReady)
    #expect(
      try OpenAIOnboardingBegunMessage.decode(frames[2]).connectionID
        == system.onboardingConnectionID)
    #expect(try OpenAIOnboardingFailureMessage.decode(frames[3]).code == .sessionNotReady)
    #expect(try OpenAIOnboardingCatalogPageMessage.decode(frames[4]).nextCursor == 2)
    _ = try OpenAIOnboardingAbortedMessage.decode(frames[5])
    #expect(try OpenAIOnboardingFailureMessage.decode(frames[6]).code == .operationUnavailable)
    #expect((await output.snapshot()).closeCount == 0)
    await session.close()
  }

  @Test
  func cancellingActiveSecretCaptureWaitsForRestorationAndSuppressesLateWork() async throws {
    let captureHarness = PausedOpenAISecretCapture()
    let system = ScriptedSessionBrokerConnection()
    let factory = try makeBrokerFactory(system)
    let output = RecordingSessionOutput()
    let session = LauncherNodeSession(
      brokerConnectionFactory: { () throws(BrokerConnectionError) -> BrokerConnection in
        try factory.make()
      },
      output: output,
      openAISecretCapture: LauncherOpenAISecretCapture(
        capture: { () async throws(TTYSecretCaptureError) -> TTYSecret in
          try await captureHarness.capture()
        },
        cancelAndWait: { await captureHarness.cancelAndWait() }
      )
    )

    await session.receive(try helloFrame(requestID: 1))
    await eventually("handshake") { await output.snapshot().written.count == 1 }
    await session.receive(
      try OpenAIOnboardingRequestMessage.begin.encodedFrame(requestID: 2)
    )
    await captureHarness.waitUntilStarted()
    await session.receive(
      try CancelMessage(targetRequestID: 2).encodedFrame(requestID: 3)
    )
    await session.close()

    #expect(captureHarness.isRestored())
    #expect(system.receivedOnboardingSecretBytes.isEmpty)
    #expect((await output.snapshot()).written.count == 1)
    #expect((await output.snapshot()).closeCount == 1)
    #expect(system.invalidationCount == 1)
    await session.close()
  }

  @Test
  func overlappingOnboardingIsRejectedBusyWithoutStartingAnotherBrokerOperation() async throws {
    let captureHarness = PausedOpenAISecretCapture()
    let system = ScriptedSessionBrokerConnection()
    let factory = try makeBrokerFactory(system)
    let output = RecordingSessionOutput()
    let session = LauncherNodeSession(
      brokerConnectionFactory: { () throws(BrokerConnectionError) -> BrokerConnection in
        try factory.make()
      },
      output: output,
      openAISecretCapture: LauncherOpenAISecretCapture(
        capture: { () async throws(TTYSecretCaptureError) -> TTYSecret in
          try await captureHarness.capture()
        },
        cancelAndWait: { await captureHarness.cancelAndWait() }
      )
    )

    await session.receive(try helloFrame(requestID: 1))
    await eventually("handshake") { await output.snapshot().written.count == 1 }
    await session.receive(
      try OpenAIOnboardingRequestMessage.begin.encodedFrame(requestID: 2)
    )
    await captureHarness.waitUntilStarted()
    await session.receive(
      try OpenAIOnboardingRequestMessage.verify.encodedFrame(requestID: 3)
    )
    await eventually("busy rejection") { await output.snapshot().written.count == 2 }

    let busyFrame = try decodeSingleFrame(
      try #require((await output.snapshot()).written.last)
    )
    #expect(busyFrame.requestID == 3)
    #expect(
      try OpenAIOnboardingFailureMessage.decode(busyFrame).code == .busy
    )
    #expect(system.receivedOnboardingSecretBytes.isEmpty)

    await session.receive(
      try CancelMessage(targetRequestID: 2).encodedFrame(requestID: 4)
    )
    await session.close()
    #expect((await output.snapshot()).closeCount == 1)
    #expect(system.invalidationCount == 1)
  }

  @Test
  func closeWaitsForAnInFlightBusyRejectionWriter() async throws {
    let captureHarness = PausedOpenAISecretCapture()
    let system = ScriptedSessionBrokerConnection()
    let factory = try makeBrokerFactory(system)
    let output = PausedSecondWriteSessionOutput()
    let closeFinished = AsyncFlag()
    let session = LauncherNodeSession(
      brokerConnectionFactory: { () throws(BrokerConnectionError) -> BrokerConnection in
        try factory.make()
      },
      output: output,
      openAISecretCapture: LauncherOpenAISecretCapture(
        capture: { () async throws(TTYSecretCaptureError) -> TTYSecret in
          try await captureHarness.capture()
        },
        cancelAndWait: { await captureHarness.cancelAndWait() }
      )
    )

    await session.receive(try helloFrame(requestID: 1))
    await eventually("handshake") { await output.writtenCount == 1 }
    await session.receive(
      try OpenAIOnboardingRequestMessage.begin.encodedFrame(requestID: 2)
    )
    await captureHarness.waitUntilStarted()
    await session.receive(
      try OpenAIOnboardingRequestMessage.verify.encodedFrame(requestID: 3)
    )
    await output.waitUntilSecondWriteStarts()

    let closeTask = Task {
      await session.close()
      await closeFinished.set()
    }
    await output.waitUntilClosed()
    for _ in 0..<100 { await Task.yield() }
    #expect(!(await closeFinished.value))

    await output.releaseSecondWrite()
    await closeTask.value
    #expect(await closeFinished.value)
    #expect(await output.writtenCount == 1)
    #expect(system.invalidationCount == 1)
  }

  @Test
  func closeWaitsForAnInFlightHealthReplyWriter() async throws {
    let system = ScriptedSessionBrokerConnection()
    let factory = try makeBrokerFactory(system)
    let output = PausedSecondWriteSessionOutput()
    let closeFinished = AsyncFlag()
    let session = LauncherNodeSession(
      brokerConnectionFactory: { () throws(BrokerConnectionError) -> BrokerConnection in
        try factory.make()
      },
      output: output
    )

    await session.receive(try helloFrame(requestID: 1))
    await eventually("handshake") { await output.writtenCount == 1 }
    await session.receive(try HealthMessage().encodedFrame(requestID: 2))
    await eventually("health begins") { system.pendingHealthCount == 1 }
    try system.replyNextHealth()
    await output.waitUntilSecondWriteStarts()

    let closeTask = Task {
      await session.close()
      await closeFinished.set()
    }
    await output.waitUntilClosed()
    for _ in 0..<100 { await Task.yield() }
    #expect(!(await closeFinished.value))

    await output.releaseSecondWrite()
    await closeTask.value
    #expect(await closeFinished.value)
    #expect(await output.writtenCount == 1)
    #expect(system.invalidationCount == 1)
  }

  @Test
  func activeHealthReplyWaitsForItsBusyOnboardingRejection() async throws {
    let system = ScriptedSessionBrokerConnection()
    let factory = try makeBrokerFactory(system)
    let output = PausedSecondWriteSessionOutput()
    let session = LauncherNodeSession(
      brokerConnectionFactory: { () throws(BrokerConnectionError) -> BrokerConnection in
        try factory.make()
      },
      output: output
    )

    await session.receive(try helloFrame(requestID: 1))
    await eventually("handshake") { await output.writtenCount == 1 }
    await session.receive(try HealthMessage().encodedFrame(requestID: 2))
    await eventually("health begins") { system.pendingHealthCount == 1 }
    await session.receive(
      try OpenAIOnboardingRequestMessage.begin.encodedFrame(requestID: 3)
    )
    await output.waitUntilSecondWriteStarts()

    try system.replyNextHealth()
    for _ in 0..<100 { await Task.yield() }
    #expect(await output.attemptedCount == 2)
    #expect(await output.writtenCount == 1)

    await output.releaseSecondWrite()
    await eventually("ordered busy and health replies") {
      await output.writtenCount == 3
    }
    let frames = try decodeFrames(await output.writtenFrames)
    #expect(frames.map(\.type) == [.helloResult, .openAIOnboardingFailure, .healthResult])
    #expect(frames.map(\.requestID) == [1, 3, 2])
    await session.close()
  }

  @Test
  func busyOnboardingRejectionWaitsForAnActiveHealthReplyWriter() async throws {
    let system = ScriptedSessionBrokerConnection()
    let factory = try makeBrokerFactory(system)
    let output = PausedSecondWriteSessionOutput()
    let session = LauncherNodeSession(
      brokerConnectionFactory: { () throws(BrokerConnectionError) -> BrokerConnection in
        try factory.make()
      },
      output: output
    )

    await session.receive(try helloFrame(requestID: 1))
    await eventually("handshake") { await output.writtenCount == 1 }
    await session.receive(try HealthMessage().encodedFrame(requestID: 2))
    await eventually("health begins") { system.pendingHealthCount == 1 }
    try system.replyNextHealth()
    await output.waitUntilSecondWriteStarts()

    await session.receive(
      try OpenAIOnboardingRequestMessage.begin.encodedFrame(requestID: 3)
    )
    for _ in 0..<100 { await Task.yield() }
    #expect(await output.attemptedCount == 2)
    #expect(await output.writtenCount == 1)

    await output.releaseSecondWrite()
    await eventually("ordered health and busy replies") {
      await output.writtenCount == 3
    }
    let frames = try decodeFrames(await output.writtenFrames)
    #expect(frames.map(\.type) == [.helloResult, .healthResult, .openAIOnboardingFailure])
    #expect(frames.map(\.requestID) == [1, 2, 3])
    await session.close()
  }

  @Test
  func nextOnboardingReplyWaitsForAnActiveBeginReplyWriter() async throws {
    let system = ScriptedSessionBrokerConnection()
    let factory = try makeBrokerFactory(system)
    let output = PausedSecondWriteSessionOutput()
    let session = LauncherNodeSession(
      brokerConnectionFactory: { () throws(BrokerConnectionError) -> BrokerConnection in
        try factory.make()
      },
      output: output,
      openAISecretCapture: LauncherOpenAISecretCapture(
        capture: { TTYSecret([0x61]) },
        cancelAndWait: {}
      )
    )

    await session.receive(try helloFrame(requestID: 1))
    await eventually("handshake") { await output.writtenCount == 1 }
    await session.receive(
      try OpenAIOnboardingRequestMessage.begin.encodedFrame(requestID: 2)
    )
    await output.waitUntilSecondWriteStarts()

    await session.receive(
      try OpenAIOnboardingRequestMessage.verify.encodedFrame(requestID: 3)
    )
    for _ in 0..<100 { await Task.yield() }
    #expect(await output.attemptedCount == 2)
    #expect(await output.writtenCount == 1)

    await output.releaseSecondWrite()
    await eventually("ordered begin and verify replies") {
      await output.writtenCount == 3
    }
    let frames = try decodeFrames(await output.writtenFrames)
    #expect(
      frames.map(\.type) == [.helloResult, .openAIOnboardingBegun, .openAIOnboardingCatalogPage])
    #expect(frames.map(\.requestID) == [1, 2, 3])
    await session.close()
  }

  @Test
  func healthDuringSecretCaptureFailsClosedAndRestoresCapture() async throws {
    let captureHarness = PausedOpenAISecretCapture()
    let system = ScriptedSessionBrokerConnection()
    let factory = try makeBrokerFactory(system)
    let output = RecordingSessionOutput()
    let session = LauncherNodeSession(
      brokerConnectionFactory: { () throws(BrokerConnectionError) -> BrokerConnection in
        try factory.make()
      },
      output: output,
      openAISecretCapture: LauncherOpenAISecretCapture(
        capture: { () async throws(TTYSecretCaptureError) -> TTYSecret in
          try await captureHarness.capture()
        },
        cancelAndWait: { await captureHarness.cancelAndWait() }
      )
    )

    await session.receive(try helloFrame(requestID: 1))
    await eventually("handshake") { await output.snapshot().written.count == 1 }
    await session.receive(
      try OpenAIOnboardingRequestMessage.begin.encodedFrame(requestID: 2)
    )
    await captureHarness.waitUntilStarted()

    await session.receive(try HealthMessage().encodedFrame(requestID: 3))
    for _ in 0..<100 { await Task.yield() }
    #expect((await output.snapshot()).closeCount == 1)

    await session.close()
    #expect(captureHarness.isRestored())
    #expect(system.receivedOnboardingSecretBytes.isEmpty)
    #expect((await output.snapshot()).written.count == 1)
    #expect(system.invalidationCount == 1)
  }

  @Test
  func exactly64ActiveAndQueuedHealthRequestsAreAllowedBut65Closes() async throws {
    let system = ScriptedSessionBrokerConnection()
    let factory = try makeBrokerFactory(system)
    let output = RecordingSessionOutput()
    let session = LauncherNodeSession(
      brokerConnectionFactory: { () throws(BrokerConnectionError) -> BrokerConnection in
        try factory.make()
      },
      output: output
    )

    await session.receive(try helloFrame(requestID: 1))
    await eventually("handshake") { await output.snapshot().written.count == 1 }
    await session.receive(
      try concatenate((2...65).map { try HealthMessage().encodedFrame(requestID: UInt32($0)) })
    )
    await eventually("bounded health work") { system.pendingHealthCount == 1 }
    #expect(system.exchangeFrames.filter { $0.type == .health }.count == 1)
    #expect((await output.snapshot()).closeCount == 0)

    await session.receive(try HealthMessage().encodedFrame(requestID: 66))
    await eventually("overflow closes") { await output.snapshot().closeCount == 1 }
    #expect(system.invalidationCount == 1)

    try system.replyNextHealth()
    await eventually("late broker completion settles") { system.pendingHealthCount == 0 }
    await Task.yield()
    #expect((await output.snapshot()).written.count == 1)
  }

  @Test
  func nodeRequestIDsMustBeStrictlyIncreasing() async throws {
    for invalidRequestID in [UInt32(10), 9] {
      let system = ScriptedSessionBrokerConnection()
      let factory = try makeBrokerFactory(system)
      let output = RecordingSessionOutput()
      let session = LauncherNodeSession(
        brokerConnectionFactory: { () throws(BrokerConnectionError) -> BrokerConnection in
          try factory.make()
        },
        output: output
      )

      await session.receive(try helloFrame(requestID: 10))
      await eventually("handshake") { await output.snapshot().written.count == 1 }
      await session.receive(
        try HealthMessage().encodedFrame(requestID: invalidRequestID)
      )
      await eventually("non-increasing request closes") {
        await output.snapshot().closeCount == 1
      }

      #expect(system.exchangeFrames.map(\.type) == [.hello])
      #expect(system.invalidationCount == 1)
    }
  }

  @Test
  func everyBrokerFailureMapsToOneFixedSafeFailure() async throws {
    let mappings: [(BrokerConnectionError, SafeFailureCode)] = [
      (.unsupportedPlatform, .unsupportedPlatform),
      (.unsupportedOSVersion, .unsupportedOSVersion),
      (.launcherUnavailable, .launcherUnavailable),
      (.brokerUnavailable, .brokerUnavailable),
      (.protocolMismatch, .protocolMismatch),
      (.peerIdentityUnverified, .peerIdentityUnverified),
      (.productionSigningRequired, .productionSigningRequired),
      (.keychainUnavailable, .keychainUnavailable),
      (.unsupportedOperation, .unsupportedOperation),
      (.closed, .brokerUnavailable),
    ]

    for (offset, mapping) in mappings.enumerated() {
      let factory = RecordingBrokerFactory(failure: mapping.0)
      let output = RecordingSessionOutput()
      let session = LauncherNodeSession(
        brokerConnectionFactory: { () throws(BrokerConnectionError) -> BrokerConnection in
          try factory.make()
        },
        output: output
      )
      let requestID = UInt32(offset + 1)

      await session.receive(try helloFrame(requestID: requestID))
      await eventually("fixed failure response") { await output.snapshot().closeCount == 1 }

      let snapshot = await output.snapshot()
      let frame = try decodeSingleFrame(try #require(snapshot.written.only))
      #expect(frame.requestID == requestID)
      #expect(try SafeFailureCode.decode(frame) == mapping.1)
      #expect(factory.makeCount == 1)
      #expect(snapshot.closeCount == 1)
    }
  }

  @Test
  func cancellingQueuedHealthRemovesOnlyThatRequest() async throws {
    let system = ScriptedSessionBrokerConnection()
    let factory = try makeBrokerFactory(system)
    let output = RecordingSessionOutput()
    let session = LauncherNodeSession(
      brokerConnectionFactory: { () throws(BrokerConnectionError) -> BrokerConnection in
        try factory.make()
      },
      output: output
    )

    await session.receive(
      concatenate([
        try helloFrame(requestID: 1),
        try HealthMessage().encodedFrame(requestID: 2),
        try HealthMessage().encodedFrame(requestID: 3),
      ]))
    await eventually("first health pending") { system.pendingHealthCount == 1 }
    await session.receive(
      try CancelMessage(targetRequestID: 3).encodedFrame(requestID: 4)
    )
    try system.replyNextHealth()
    await eventually("uncancelled health response") {
      await output.snapshot().written.count == 2
    }
    #expect(system.exchangeFrames.map(\.type) == [.hello, .health])
    #expect((await output.snapshot()).closeCount == 0)

    await session.receive(try HealthMessage().encodedFrame(requestID: 5))
    await eventually("later health pending") { system.pendingHealthCount == 1 }
    try system.replyNextHealth(keychain: .locked)
    await eventually("later health response") { await output.snapshot().written.count == 3 }
    let frames = try decodeFrames((await output.snapshot()).written)
    #expect(frames.map(\.requestID) == [1, 2, 5])
    await session.close()
  }

  @Test
  func cancellingActiveHealthIsTerminalAndSuppressesLateXPC() async throws {
    let system = ScriptedSessionBrokerConnection()
    let factory = try makeBrokerFactory(system)
    let output = RecordingSessionOutput()
    let session = LauncherNodeSession(
      brokerConnectionFactory: { () throws(BrokerConnectionError) -> BrokerConnection in
        try factory.make()
      },
      output: output
    )

    await session.receive(
      concatenate([
        try helloFrame(requestID: 1),
        try HealthMessage().encodedFrame(requestID: 2),
      ]))
    await eventually("active health") { system.pendingHealthCount == 1 }
    await session.receive(
      try CancelMessage(targetRequestID: 2).encodedFrame(requestID: 3)
    )
    await eventually("active cancellation closes") {
      await output.snapshot().closeCount == 1
    }

    await session.close()
    await session.finish()
    await session.receive(try HealthMessage().encodedFrame(requestID: 4))
    try system.replyNextHealth()
    await eventually("late response delivered") { system.pendingHealthCount == 0 }
    await Task.yield()

    let snapshot = await output.snapshot()
    #expect(snapshot.written.count == 1)
    #expect(snapshot.closeCount == 1)
    #expect(system.invalidationCount == 1)
  }

  @Test
  func cancellingActiveHandshakeBeforeItRunsCancelsBrokerTask() async throws {
    let system = ScriptedSessionBrokerConnection()
    let factory = try makeBrokerFactory(system)
    let output = RecordingSessionOutput()
    let session = LauncherNodeSession(
      brokerConnectionFactory: { () throws(BrokerConnectionError) -> BrokerConnection in
        try factory.make()
      },
      output: output
    )

    await session.receive(
      concatenate([
        try helloFrame(requestID: 1),
        try CancelMessage(targetRequestID: 1).encodedFrame(requestID: 2),
      ]))
    await eventually("handshake cancellation closes") {
      await output.snapshot().closeCount == 1
    }
    await Task.yield()

    #expect(system.exchangeFrames.isEmpty)
    #expect((await output.snapshot()).written.isEmpty)
    #expect((await output.snapshot()).closeCount == 1)
    #expect(system.invalidationCount == 1)
  }

  @Test
  func malformedAndWrongPhaseFramesFailClosedBeforeBrokerOpen() async throws {
    let malformedHello = try NativeFrame(
      type: .hello,
      requestID: 1,
      payload: Data([0, 0])
    ).encoded()
    let inputs = [
      Data(repeating: 0, count: nativeFrameHeaderByteCount),
      malformedHello,
      try HealthMessage().encodedFrame(requestID: 1),
      try CancelMessage(targetRequestID: 1).encodedFrame(requestID: 2),
    ]

    for input in inputs {
      let system = ScriptedSessionBrokerConnection()
      let factory = try makeBrokerFactory(system)
      let output = RecordingSessionOutput()
      let session = LauncherNodeSession(
        brokerConnectionFactory: { () throws(BrokerConnectionError) -> BrokerConnection in
          try factory.make()
        },
        output: output
      )

      await session.receive(input)
      await eventually("invalid input closes") { await output.snapshot().closeCount == 1 }
      #expect(factory.makeCount == 0)
      #expect(system.invalidationCount == 0)
      #expect((await output.snapshot()).written.isEmpty)
    }
  }

  @Test
  func secondHelloAndUnknownCancellationFailClosedInReadyPhase() async throws {
    for invalidFrame in [
      try helloFrame(requestID: 2),
      try CancelMessage(targetRequestID: 99).encodedFrame(requestID: 2),
    ] {
      let system = ScriptedSessionBrokerConnection()
      let factory = try makeBrokerFactory(system)
      let output = RecordingSessionOutput()
      let session = LauncherNodeSession(
        brokerConnectionFactory: { () throws(BrokerConnectionError) -> BrokerConnection in
          try factory.make()
        },
        output: output
      )

      await session.receive(try helloFrame(requestID: 1))
      await eventually("ready") { await output.snapshot().written.count == 1 }
      await session.receive(invalidFrame)
      await eventually("ready phase violation closes") {
        await output.snapshot().closeCount == 1
      }
      #expect(factory.makeCount == 1)
      #expect(system.invalidationCount == 1)
    }
  }

  @Test
  func truncatedEOFClosesExactlyOnceWithoutOpeningBroker() async throws {
    let system = ScriptedSessionBrokerConnection()
    let factory = try makeBrokerFactory(system)
    let output = RecordingSessionOutput()
    let session = LauncherNodeSession(
      brokerConnectionFactory: { () throws(BrokerConnectionError) -> BrokerConnection in
        try factory.make()
      },
      output: output
    )
    let hello = try helloFrame(requestID: 1)

    #expect(!(await session.isAwaitingFrameCompletion()))
    await session.receive(Data(hello.prefix(nativeFrameHeaderByteCount + 1)))
    #expect(await session.isAwaitingFrameCompletion())
    await session.finish()
    #expect(!(await session.isAwaitingFrameCompletion()))
    await session.finish()
    await session.close()
    #expect(!(await session.isAwaitingFrameCompletion()))
    await eventually("truncated close") { await output.snapshot().closeCount == 1 }

    #expect(factory.makeCount == 0)
    #expect(system.invalidationCount == 0)
    #expect((await output.snapshot()).written.isEmpty)
  }

  @Test
  func outputFailureClosesWithoutLeakingNativeErrorText() async throws {
    let canary = "NATIVE_ERROR_SECRET_CANARY"
    let system = ScriptedSessionBrokerConnection()
    let factory = try makeBrokerFactory(system)
    let output = RecordingSessionOutput(failOnAttempt: 1, canary: canary)
    let session = LauncherNodeSession(
      brokerConnectionFactory: { () throws(BrokerConnectionError) -> BrokerConnection in
        try factory.make()
      },
      output: output
    )

    await session.receive(try helloFrame(requestID: 1))
    await eventually("output failure closes") { await output.snapshot().closeCount == 1 }
    await session.close()

    let snapshot = await output.snapshot()
    let attemptedBytes = concatenate(snapshot.attempted)
    #expect(snapshot.attempted.count == 1)
    #expect(snapshot.written.isEmpty)
    #expect(attemptedBytes.range(of: Data(canary.utf8)) == nil)
    #expect(snapshot.closeCount == 1)
    #expect(system.invalidationCount == 1)
  }

  private func helloFrame(requestID: UInt32) throws -> Data {
    try HelloMessage(engineVersion: "0.1.0", nonce: nonce)
      .encodedFrame(requestID: requestID)
  }
}

private struct SessionOutputSnapshot: Sendable {
  let attempted: [Data]
  let written: [Data]
  let closeCount: Int
}

private actor RecordingSessionOutput: LauncherNodeSessionOutput {
  private let failOnAttempt: Int?
  private let canary: String
  private var attempted: [Data] = []
  private var written: [Data] = []
  private var closeCount = 0

  init(failOnAttempt: Int? = nil, canary: String = "") {
    self.failOnAttempt = failOnAttempt
    self.canary = canary
  }

  func write(_ frame: Data) async throws {
    attempted.append(frame)
    if attempted.count == failOnAttempt {
      throw CanarySessionOutputError(canary: canary)
    }
    written.append(frame)
  }

  func close() async {
    closeCount += 1
  }

  func snapshot() -> SessionOutputSnapshot {
    SessionOutputSnapshot(
      attempted: attempted,
      written: written,
      closeCount: closeCount
    )
  }
}

private actor AsyncFlag {
  private(set) var value = false

  func set() {
    value = true
  }
}

private actor PausedSecondWriteSessionOutput: LauncherNodeSessionOutput {
  private var attemptCount = 0
  private var frames: [Data] = []
  private var closed = false
  private var secondWriteContinuation: CheckedContinuation<Void, Never>?
  private var secondWriteWaiters: [CheckedContinuation<Void, Never>] = []
  private var closeWaiters: [CheckedContinuation<Void, Never>] = []

  var writtenCount: Int { frames.count }
  var writtenFrames: [Data] { frames }
  var attemptedCount: Int { attemptCount }

  func write(_ frame: Data) async throws {
    attemptCount += 1
    if attemptCount == 2 {
      let waiters = secondWriteWaiters
      secondWriteWaiters.removeAll(keepingCapacity: false)
      for waiter in waiters { waiter.resume() }
      await withCheckedContinuation { continuation in
        secondWriteContinuation = continuation
      }
    }
    guard !closed else { throw PausedSessionOutputError.closed }
    frames.append(frame)
  }

  func close() async {
    closed = true
    let waiters = closeWaiters
    closeWaiters.removeAll(keepingCapacity: false)
    for waiter in waiters { waiter.resume() }
  }

  func waitUntilSecondWriteStarts() async {
    await withCheckedContinuation { continuation in
      if attemptCount >= 2 {
        continuation.resume()
      } else {
        secondWriteWaiters.append(continuation)
      }
    }
  }

  func waitUntilClosed() async {
    await withCheckedContinuation { continuation in
      if closed {
        continuation.resume()
      } else {
        closeWaiters.append(continuation)
      }
    }
  }

  func releaseSecondWrite() {
    let continuation = secondWriteContinuation
    secondWriteContinuation = nil
    continuation?.resume()
  }
}

private enum PausedSessionOutputError: Error {
  case closed
}

private struct CanarySessionOutputError: Error, LocalizedError, Sendable {
  let canary: String
  var errorDescription: String? { canary }
}

private final class PausedOpenAISecretCapture: @unchecked Sendable {
  private let lock = NSLock()
  private var continuation: CheckedContinuation<Result<TTYSecret, TTYSecretCaptureError>, Never>?
  private var startedWaiters: [CheckedContinuation<Void, Never>] = []
  private var restoredWaiters: [CheckedContinuation<Void, Never>] = []
  private var cancelled = false
  private var restored = false

  func capture() async throws(TTYSecretCaptureError) -> TTYSecret {
    let result = await withTaskCancellationHandler {
      await withCheckedContinuation { continuation in
        let resumeCancelled = lock.withLock { () -> Bool in
          if cancelled { return true }
          self.continuation = continuation
          let waiters = startedWaiters
          startedWaiters.removeAll(keepingCapacity: false)
          for waiter in waiters { waiter.resume() }
          return false
        }
        if resumeCancelled {
          continuation.resume(returning: .failure(.cancelled))
        }
      }
    } onCancel: { [self] in
      cancel()
    }
    finishRestoration()
    return try result.get()
  }

  func waitUntilStarted() async {
    await withCheckedContinuation { continuation in
      let resumeNow = lock.withLock { () -> Bool in
        if self.continuation != nil || cancelled { return true }
        startedWaiters.append(continuation)
        return false
      }
      if resumeNow { continuation.resume() }
    }
  }

  func cancelAndWait() async {
    cancel()
    await withCheckedContinuation { continuation in
      let resumeNow = lock.withLock { () -> Bool in
        if restored { return true }
        restoredWaiters.append(continuation)
        return false
      }
      if resumeNow { continuation.resume() }
    }
  }

  func isRestored() -> Bool {
    lock.withLock { restored }
  }

  private func cancel() {
    let continuation = lock.withLock {
      () -> CheckedContinuation<Result<TTYSecret, TTYSecretCaptureError>, Never>? in
      guard !cancelled else { return nil }
      cancelled = true
      let selected = self.continuation
      self.continuation = nil
      return selected
    }
    continuation?.resume(returning: .failure(.cancelled))
  }

  private func finishRestoration() {
    let waiters = lock.withLock { () -> [CheckedContinuation<Void, Never>] in
      restored = true
      let selected = restoredWaiters
      restoredWaiters.removeAll(keepingCapacity: false)
      return selected
    }
    for waiter in waiters { waiter.resume() }
  }
}

private final class RecordingBrokerFactory: @unchecked Sendable {
  private enum Mode: Sendable {
    case build(@Sendable () -> BrokerConnection)
    case fail(BrokerConnectionError)
  }

  private let mode: Mode
  private let lock = NSLock()
  private var makeCountStorage = 0
  private var connection: BrokerConnection?

  init(builder: @escaping @Sendable () -> BrokerConnection) {
    mode = .build(builder)
  }

  init(failure: BrokerConnectionError) {
    mode = .fail(failure)
  }

  var makeCount: Int {
    lock.withLock { makeCountStorage }
  }

  func make() throws(BrokerConnectionError) -> BrokerConnection {
    lock.lock()
    defer { lock.unlock() }
    makeCountStorage += 1
    if let connection {
      return connection
    }
    switch mode {
    case .build(let builder):
      let built = builder()
      connection = built
      return built
    case .fail(let failure):
      throw failure
    }
  }
}

private struct ScriptedSessionBrokerConnectionFactory: BrokerXPCConnectionFactory {
  let connection: ScriptedSessionBrokerConnection

  func makeConnection() -> any BrokerXPCConnectionHandling {
    connection
  }
}

private final class ScriptedSessionBrokerConnection: BrokerXPCConnectionHandling,
  @unchecked Sendable
{
  private struct Pending: @unchecked Sendable {
    let frame: NativeFrame
    let reply: @Sendable (Result<Data, BrokerXPCExchangeError>) -> Void
  }

  private let lock = NSLock()
  private var frames: [NativeFrame] = []
  private var pending: [Pending] = []
  private var onboardingSecrets: [[UInt8]] = []
  private var invalidations = 0

  let onboardingConnectionID = UUID(
    uuidString: "7b000000-0000-4000-8000-000000000001"
  )!
  let onboardingFingerprint = "sha256:" + String(repeating: "d", count: 64)

  var exchangeFrames: [NativeFrame] {
    lock.withLock { frames }
  }

  var pendingHealthCount: Int {
    lock.withLock { pending.filter { $0.frame.type == .health }.count }
  }

  var invalidationCount: Int {
    lock.withLock { invalidations }
  }

  var receivedOnboardingSecretBytes: [[UInt8]] {
    lock.withLock { onboardingSecrets }
  }

  func installRemoteInterface() {}
  func setCodeSigningRequirement(_: String) {}
  func activate() {}

  func exchange(
    _ encoded: Data,
    reply: @escaping @Sendable (Result<Data, BrokerXPCExchangeError>) -> Void
  ) {
    do {
      let frame = try decodeSingleFrame(encoded)
      lock.withLock { frames.append(frame) }
      switch frame.type {
      case .hello:
        let hello = try HelloMessage.decode(frame)
        let response = try HelloResultMessage(
          launcherVersion: hello.engineVersion,
          brokerVersion: hello.engineVersion,
          echoedNonce: hello.nonce,
          productionSigned: true,
          persistentCredentials: true,
          minimumMacosVersion: "14.4"
        ).encodedFrame(requestID: frame.requestID)
        reply(.success(response))
      case .health:
        _ = try HealthMessage.decode(frame)
        lock.withLock { pending.append(Pending(frame: frame, reply: reply)) }
      default:
        reply(.failure(.brokerUnavailable))
      }
    } catch {
      reply(.failure(.brokerUnavailable))
    }
  }

  func beginOpenAIOnboarding(
    _ requestData: Data,
    secret: Data,
    reply: @escaping @Sendable (Result<Data, BrokerXPCExchangeError>) -> Void
  ) {
    do {
      let request = try BrokerOpenAIOnboardingRequest.decode(requestData)
      guard case .begin(let requestID) = request else {
        reply(.failure(.brokerUnavailable))
        return
      }
      lock.withLock { onboardingSecrets.append(Array(secret)) }
      let recoveryTokens = try BrokerOpenAIOnboardingRecoveryTokens(
        commitOperationID: UUID(
          uuidString: "7c000000-0000-4000-8000-000000000001"
        )!,
        abortOperationID: UUID(
          uuidString: "7d000000-0000-4000-8000-000000000001"
        )!
      )
      reply(
        .success(
          try BrokerOpenAIOnboardingReply.begun(
            requestID: requestID,
            connectionID: onboardingConnectionID,
            recoveryTokens: recoveryTokens,
            credentialIdentityFingerprint: onboardingFingerprint
          ).encode()
        )
      )
    } catch {
      reply(.failure(.brokerUnavailable))
    }
  }

  func openAIOnboardingControl(
    _ requestData: Data,
    reply: @escaping @Sendable (Result<Data, BrokerXPCExchangeError>) -> Void
  ) {
    do {
      let request = try BrokerOpenAIOnboardingRequest.decode(requestData)
      let response: BrokerOpenAIOnboardingReply
      switch request {
      case .verify(let requestID):
        response = .catalogPage(
          requestID: requestID,
          try BrokerOpenAIOnboardingCatalogPage(
            cursor: 0,
            totalModelCount: 3,
            nextCursor: 2,
            catalogRequestID: "catalog-request",
            modelIDs: ["gpt-5.1", "gpt-5.2"]
          )
        )
      case .catalogPage(let requestID, cursor: 2):
        response = .catalogPage(
          requestID: requestID,
          try BrokerOpenAIOnboardingCatalogPage(
            cursor: 2,
            totalModelCount: 3,
            nextCursor: nil,
            catalogRequestID: "catalog-request",
            modelIDs: ["gpt-5.3"]
          )
        )
      case .finalize(let requestID, exactModelID: "gpt-5.3"):
        response = .committed(
          requestID: requestID,
          try BrokerOpenAIOnboardingCommitReceipt(
            connectionID: onboardingConnectionID,
            selectedModelID: "gpt-5.3",
            verifiedModelCount: 3,
            catalogRequestID: "catalog-request"
          )
        )
      case .abort(let requestID):
        response = .aborted(requestID: requestID)
      default:
        response = .failure(requestID: request.requestID, .invalidRequest)
      }
      reply(.success(try response.encode()))
    } catch {
      reply(.failure(.brokerUnavailable))
    }
  }

  func reconcileOpenAIActivation(
    _ requestData: Data,
    reply: @escaping @Sendable (Result<Data, BrokerXPCExchangeError>) -> Void
  ) {
    do {
      let request = try BrokerOpenAIActivationReconciliationRequest.decode(requestData)
      guard case .reconcile(let requestID, let connectionID) = request else {
        reply(.failure(.brokerUnavailable))
        return
      }
      let status: BrokerOpenAIActivationReconciliationStatus =
        connectionID == onboardingConnectionID ? .readyOpenAI : .absent
      reply(
        .success(
          try BrokerOpenAIActivationReconciliationReply.status(
            requestID: requestID,
            status
          ).encode()
        )
      )
    } catch {
      reply(.failure(.brokerUnavailable))
    }
  }

  func invalidate() {
    lock.withLock { invalidations += 1 }
  }

  func replyNextHealth(
    keychain: KeychainStatusCode = .available,
    peerVerified: Bool = true
  ) throws {
    let item: Pending? = lock.withLock {
      guard let index = self.pending.firstIndex(where: { $0.frame.type == .health }) else {
        return nil
      }
      return self.pending.remove(at: index)
    }
    let replyItem = try #require(item)
    replyItem.reply(
      .success(
        try HealthResultMessage(keychain: keychain, peerVerified: peerVerified)
          .encodedFrame(requestID: replyItem.frame.requestID)
      ))
  }
}

private func makeBrokerFactory(
  _ system: ScriptedSessionBrokerConnection
) throws -> RecordingBrokerFactory {
  let requirement = try PeerRequirement.fromValidatedSignedMetadata(
    for: .broker,
    metadata: [
      "RecursTeamIdentifier": "ABCDE12345",
      "RecursLauncherIdentifier": "com.recurs.cli.launcher",
      "RecursBrokerIdentifier": "com.recurs.cli.broker",
      "RecursProductionSigned": true,
    ]
  )
  return RecordingBrokerFactory {
    BrokerConnection(
      validatedPeerRequirement: requirement,
      connectionFactory: ScriptedSessionBrokerConnectionFactory(connection: system)
    )
  }
}

private func eventually(
  _ description: String,
  condition: () async -> Bool
) async {
  let clock = ContinuousClock()
  let deadline = clock.now.advanced(by: .seconds(5))
  while clock.now < deadline {
    if await condition() {
      return
    }
    await Task.yield()
  }
  Issue.record("Timed out waiting for \(description)")
}

private func decodeSingleFrame(_ data: Data) throws -> NativeFrame {
  var decoder = NativeFrameDecoder()
  let frames = try decoder.push(data)
  try decoder.finish()
  return try #require(frames.only)
}

private func decodeFrames(_ data: [Data]) throws -> [NativeFrame] {
  try data.map(decodeSingleFrame)
}

private func concatenate(_ parts: [Data]) -> Data {
  var result = Data()
  result.reserveCapacity(parts.reduce(0) { $0 + $1.count })
  for part in parts {
    result.append(part)
  }
  return result
}

extension Collection {
  fileprivate var only: Element? {
    count == 1 ? first : nil
  }
}
