import Foundation
import ObjectiveC
import RecursBrokerXPC
import RecursNativeProtocol
import Testing

@testable import RecursBrokerCore
@testable import RecursBrokerService

@Suite(.serialized)
struct BrokerCredentialLifecycleXPCTests {
  private let connectionID = UUID(uuidString: "40000000-0000-4000-8000-000000000011")!
  private let secondConnectionID = UUID(
    uuidString: "40000000-0000-4000-8000-000000000012")!
  private let operationID = UUID(uuidString: "50000000-0000-4000-8000-000000000011")!

  @Test
  func exportedProtocolsAndDataAllowlistsAreExact() throws {
    let baseProtocol: Protocol = BrokerXPCProtocol.self
    let lifecycleProtocol: Protocol = BrokerCredentialLifecycleXPCProtocol.self
    let onboardingProtocol: Protocol = BrokerOpenAIOnboardingXPCProtocol.self
    #expect(protocol_conformsToProtocol(lifecycleProtocol, baseProtocol))
    #expect(protocol_conformsToProtocol(onboardingProtocol, lifecycleProtocol))
    #expect(
      protocolSurface(declaredBy: baseProtocol)
        == ProtocolSurface(
          requiredInstance: [
            NSStringFromSelector(#selector(BrokerXPCProtocol.exchange(_:reply:)))
          ],
          optionalInstance: [],
          requiredClass: [],
          optionalClass: []
        )
    )
    #expect(
      protocolSurface(declaredBy: lifecycleProtocol)
        == ProtocolSurface(
          requiredInstance: [
            NSStringFromSelector(
              #selector(BrokerCredentialLifecycleXPCProtocol.credentialControl(_:reply:))),
            NSStringFromSelector(
              #selector(
                BrokerCredentialLifecycleXPCProtocol.stageCredential(_:secret:reply:))),
          ],
          optionalInstance: [],
          requiredClass: [],
          optionalClass: []
        )
    )
    #expect(
      protocolSurface(declaredBy: onboardingProtocol)
        == ProtocolSurface(
          requiredInstance: [
            NSStringFromSelector(
              #selector(
                BrokerOpenAIOnboardingXPCProtocol.beginOpenAIOnboarding(_:secret:reply:))),
            NSStringFromSelector(
              #selector(BrokerOpenAIOnboardingXPCProtocol.openAIOnboardingControl(_:reply:))),
            NSStringFromSelector(
              #selector(BrokerOpenAIOnboardingXPCProtocol.reconcileOpenAIActivation(_:reply:))),
          ],
          optionalInstance: [],
          requiredClass: [],
          optionalClass: []
        )
    )

    let authority = XPCFakeAuthority()
    let recovered = try recoveredConfiguration(authority: authority)
    let dynamicallyUnavailable = try? BrokerServiceConfiguration.recoveredCredentialService(
      launcherVersion: "0.1.0",
      brokerVersion: "0.1.0",
      authority: authority,
      keychainStatus: { .unavailable }
    )
    #expect(dynamicallyUnavailable != nil)
    let recoveredConnection = TestBrokerConnection()
    BrokerServiceListenerDelegate(
      exactPeerRequirement: "true",
      configuration: recovered
    ).configure(recoveredConnection)
    let composite = try #require(recoveredConnection.exportedInterface)
    #expect(protocol_isEqual(composite.protocol, lifecycleProtocol))
    assertExactDataAllowlists(composite, includesLifecycle: true)

    let openAI = try BrokerServiceConfiguration.recoveredOpenAIService(
      launcherVersion: "0.1.0",
      brokerVersion: "0.1.0",
      authority: authority,
      sessionFactory: XPCOpenAIOnboardingFactory(),
      credentialIdentityFingerprinter: XPCOpenAIIdentityFingerprinter(),
      keychainStatus: { .available }
    )
    let openAIConnection = TestBrokerConnection()
    BrokerServiceListenerDelegate(
      exactPeerRequirement: "true",
      configuration: openAI
    ).configure(openAIConnection)
    let onboarding = try #require(openAIConnection.exportedInterface)
    #expect(protocol_isEqual(onboarding.protocol, onboardingProtocol))
    assertExactDataAllowlists(
      onboarding,
      includesLifecycle: true,
      includesOnboarding: true
    )

    let healthOnly = try BrokerServiceConfiguration.healthOnlyForTesting(
      launcherVersion: "0.1.0",
      brokerVersion: "0.1.0",
      productionSigned: true,
      keychainStatus: { .available }
    )
    let healthConnection = TestBrokerConnection()
    BrokerServiceListenerDelegate(
      exactPeerRequirement: "true",
      configuration: healthOnly
    ).configure(healthConnection)
    let base = try #require(healthConnection.exportedInterface)
    #expect(protocol_isEqual(base.protocol, baseProtocol))
    assertExactDataAllowlists(base, includesLifecycle: false)
    #expect(
      healthConnection.events
        == ["requirement", "interface", "object", "interruption", "invalidation", "activate"]
    )
  }

  @Test
  func anonymousXPCExercisesOpenAIOnboardingBeginControlAndInvalidation() async throws {
    let authority = XPCFakeAuthority(expectedSecret: Data("openai-onboarding-secret".utf8))
    let factory = XPCOpenAIOnboardingFactory()
    let configuration = try BrokerServiceConfiguration.recoveredOpenAIService(
      launcherVersion: "0.1.0",
      brokerVersion: "0.1.0",
      authority: authority,
      sessionFactory: factory,
      credentialIdentityFingerprinter: XPCOpenAIIdentityFingerprinter(),
      keychainStatus: { .available }
    )
    let productionDelegate = BrokerServiceListenerDelegate(
      exactPeerRequirement: "true",
      configuration: configuration
    )
    let listenerDelegate = AnonymousListenerDelegate(wrapped: productionDelegate)
    let listener = NSXPCListener.anonymous()
    listener.delegate = listenerDelegate
    listener.activate()

    let connection = NSXPCConnection(listenerEndpoint: listener.endpoint)
    connection.remoteObjectInterface = makeClientOpenAIOnboardingInterface()
    let invalidated = LockedSignal()
    connection.invalidationHandler = invalidated.signal
    connection.activate()
    let remoteObject = connection.remoteObjectProxyWithErrorHandler { _ in }
    let proxy = try #require(remoteObject as? BrokerOpenAIOnboardingXPCProtocol)

    let hello = LockedDataProbe()
    proxy.exchange(try helloFrame(requestID: 1), reply: hello.receive)
    #expect(try HelloResultMessage.decode(decodeNativeFrame(hello.wait())).persistentCredentials)

    let reconciled = LockedDataProbe()
    proxy.reconcileOpenAIActivation(
      try BrokerOpenAIActivationReconciliationRequest.reconcile(
        requestID: 1,
        connectionID: connectionID
      ).encode(),
      reply: reconciled.receive
    )
    #expect(
      try BrokerOpenAIActivationReconciliationReply.decode(reconciled.wait())
        == .status(requestID: 1, .unresolved)
    )

    let begun = LockedDataProbe()
    proxy.beginOpenAIOnboarding(
      try BrokerOpenAIOnboardingRequest.begin(requestID: 2).encode(),
      secret: Data("openai-onboarding-secret".utf8),
      reply: begun.receive
    )
    guard
      case .begun(_, _, _, let fingerprint) =
        try BrokerOpenAIOnboardingReply.decode(begun.wait())
    else {
      Issue.record("Expected an OpenAI onboarding begun reply")
      return
    }
    #expect(fingerprint == XPCOpenAIIdentityFingerprinter.rawFingerprint)
    #expect(authority.receivedExpectedSecret)

    let verified = LockedDataProbe()
    proxy.openAIOnboardingControl(
      try BrokerOpenAIOnboardingRequest.verify(requestID: 3).encode(),
      reply: verified.receive
    )
    guard
      case .catalogPage(_, let page) =
        try BrokerOpenAIOnboardingReply.decode(verified.wait())
    else {
      Issue.record("Expected an OpenAI catalog page")
      return
    }
    #expect(page.modelIDs == ["gpt-5"])

    connection.invalidate()
    #expect(invalidated.wait())
    #expect(factory.session.waitUntilClosed())
    listener.invalidate()
    withExtendedLifetime((listener, listenerDelegate, connection, remoteObject, proxy)) {}
  }

  @Test
  func healthOnlyCallsFailClosedWithoutMutatingCallerAliases() throws {
    let configuration = try BrokerServiceConfiguration.healthOnlyForTesting(
      launcherVersion: "0.1.0",
      brokerVersion: "0.1.0",
      productionSigned: true,
      keychainStatus: { .available }
    )
    let service = BrokerService(configuration: configuration)
    let hello = LockedDataProbe()
    service.exchange(try helloFrame(requestID: 1), reply: hello.receive)
    let helloResult = try HelloResultMessage.decode(
      try decodeNativeFrame(hello.wait())
    )
    #expect(!helloResult.persistentCredentials)

    let inlineAlias = Data([0x73])
    let inlineTransfer = inlineAlias
    let inlineStage = LockedDataProbe()
    service.stageCredential(
      try stageRequest(requestID: 7).encode(),
      secret: inlineTransfer,
      reply: inlineStage.receive
    )
    #expect(inlineAlias == Data([0x73]))
    #expect(
      try decodeLifecycleReply(inlineStage.wait())
        == .failure(requestID: 7, .operationUnavailable)
    )

    let heapAlias = Data(
      repeating: 0xa5,
      count: brokerCredentialMaximumSecretBytes
    )
    let heapTransfer = heapAlias
    let heapStage = LockedDataProbe()
    service.stageCredential(
      try stageRequest(requestID: 8).encode(),
      secret: heapTransfer,
      reply: heapStage.receive
    )
    #expect(
      heapAlias
        == Data(repeating: 0xa5, count: brokerCredentialMaximumSecretBytes)
    )
    #expect(
      try decodeLifecycleReply(heapStage.wait())
        == .failure(requestID: 8, .operationUnavailable)
    )

    var malformedMetadata = try stageRequest(requestID: 9).encode()
    malformedMetadata.replaceSubrange(20..<36, with: repeatElement(UInt8(0), count: 16))
    let malformedAlias = Data("malformed-stage-canary".utf8)
    let malformedTransfer = malformedAlias
    let malformedStage = LockedDataProbe()
    service.stageCredential(
      malformedMetadata,
      secret: malformedTransfer,
      reply: malformedStage.receive
    )
    #expect(malformedAlias == Data("malformed-stage-canary".utf8))
    #expect(
      try decodeLifecycleReply(malformedStage.wait())
        == .failure(requestID: 9, .invalidRequest)
    )

    let validControl = LockedDataProbe()
    service.credentialControl(
      try BrokerCredentialControlRequest.projection(
        requestID: 10,
        connectionID: connectionID
      ).encode(),
      reply: validControl.receive
    )
    #expect(
      try decodeLifecycleReply(validControl.wait())
        == .failure(requestID: 10, .operationUnavailable)
    )

    let malformedControl = LockedDataProbe()
    service.credentialControl(Data([0xde, 0xad]), reply: malformedControl.receive)
    #expect(
      try decodeLifecycleReply(malformedControl.wait())
        == .failure(requestID: brokerCredentialMalformedRequestID, .invalidRequest)
    )
  }

  @Test(arguments: [
    0,
    brokerCredentialMaximumSecretBytes + 1,
  ])
  func healthOnlyRejectsInvalidSecretLength(_ byteCount: Int) throws {
    let service = BrokerService(
      configuration: try BrokerServiceConfiguration.healthOnlyForTesting(
        launcherVersion: "0.1.0",
        brokerVersion: "0.1.0",
        productionSigned: true,
        keychainStatus: { .available }
      )
    )
    let alias = Data(repeating: 0x5a, count: byteCount)
    let transfer = alias
    let reply = LockedDataProbe()
    service.stageCredential(
      try stageRequest(requestID: 1).encode(),
      secret: transfer,
      reply: reply.receive
    )

    #expect(alias == Data(repeating: 0x5a, count: byteCount))
    #expect(
      try decodeLifecycleReply(reply.wait())
        == .failure(requestID: 1, .invalidRequest)
    )
  }

  @Test
  func helloAndTerminalActionsPrecedeReentrantReplies() throws {
    let authority = XPCFakeAuthority()
    let service = BrokerService(configuration: try recoveredConfiguration(authority: authority))
    let helloReply = LockedDataProbe()
    let nestedHealth = LockedDataProbe()
    let nestedLifecycle = LockedDataProbe()
    let outerFinished = LockedSignal()
    let hello = try helloFrame(requestID: 1)
    let health = try makeHealthFrame(requestID: 2)
    let control = try BrokerCredentialControlRequest.projection(
      requestID: 1,
      connectionID: connectionID
    ).encode()

    DispatchQueue.global().async {
      service.exchange(hello) { data in
        helloReply.receive(data)
        service.exchange(health, reply: nestedHealth.receive)
        service.credentialControl(control, reply: nestedLifecycle.receive)
        outerFinished.signal()
      }
    }

    #expect(outerFinished.wait())
    #expect(
      try HelloResultMessage.decode(decodeNativeFrame(helloReply.wait())).persistentCredentials)
    #expect(try HealthResultMessage.decode(decodeNativeFrame(nestedHealth.wait())).peerVerified)
    #expect(
      try decodeLifecycleReply(nestedLifecycle.wait()).requestIDForTesting == 1
    )
    #expect(authority.callCount == 1)

    let blockingAuthority = XPCFakeAuthority(suspendProjection: true)
    let closingService = BrokerService(
      configuration: try recoveredConfiguration(authority: blockingAuthority)
    )
    let ready = LockedDataProbe()
    closingService.exchange(try helloFrame(requestID: 1), reply: ready.receive)
    _ = ready.wait()
    let lifecycle = LockedDataProbe()
    let order = LockedEventProbe()
    closingService.credentialControl(
      try BrokerCredentialControlRequest.projection(
        requestID: 1,
        connectionID: connectionID
      ).encode()
    ) { data in
      lifecycle.receive(data)
      order.record("lifecycle")
    }
    #expect(blockingAuthority.waitForCallCount(1))

    var malformedHealth = try makeHealthFrame(requestID: 2)
    malformedHealth.append(0)
    let terminal = LockedDataProbe()
    closingService.exchange(malformedHealth) { data in
      terminal.receive(data)
      order.record("health")
      let afterClose = LockedDataProbe()
      closingService.credentialControl(
        try! BrokerCredentialControlRequest.projection(
          requestID: 2,
          connectionID: self.connectionID
        ).encode(),
        reply: afterClose.receive
      )
      #expect(
        (try? self.decodeLifecycleReply(afterClose.wait()))
          == .failure(requestID: 2, .cancelled)
      )
    }
    #expect(order.snapshot().prefix(2) == ["lifecycle", "health"])
    #expect(
      try decodeLifecycleReply(lifecycle.wait())
        == .failure(requestID: 1, .cancelled)
    )
    #expect(try SafeFailureCode.decode(decodeNativeFrame(terminal.wait())) == .protocolMismatch)
    #expect(blockingAuthority.waitForCancellationCount(1))
    #expect(blockingAuthority.waitForProjectionCompletionCount(1))
    #expect(lifecycle.count == 1)
  }

  @Test
  func listenerCreatesIndependentGatewaysAndHandlersCloseOnlyTheirConnection() throws {
    let authority = XPCFakeAuthority(suspendProjection: true)
    let delegate = BrokerServiceListenerDelegate(
      exactPeerRequirement: "true",
      configuration: try recoveredConfiguration(authority: authority)
    )
    let firstConnection = TestBrokerConnection()
    let secondConnection = TestBrokerConnection()
    delegate.configure(firstConnection)
    delegate.configure(secondConnection)
    let first = try #require(firstConnection.exportedObject as? BrokerService)
    let second = try #require(secondConnection.exportedObject as? BrokerService)
    let firstHello = LockedDataProbe()
    let secondHello = LockedDataProbe()
    first.exchange(try helloFrame(requestID: 1), reply: firstHello.receive)
    second.exchange(try helloFrame(requestID: 1), reply: secondHello.receive)
    _ = firstHello.wait()
    _ = secondHello.wait()

    let firstReply = LockedDataProbe()
    let secondReply = LockedDataProbe()
    first.credentialControl(
      try BrokerCredentialControlRequest.projection(
        requestID: 1,
        connectionID: connectionID
      ).encode(),
      reply: firstReply.receive
    )
    second.credentialControl(
      try BrokerCredentialControlRequest.projection(
        requestID: 1,
        connectionID: secondConnectionID
      ).encode(),
      reply: secondReply.receive
    )
    #expect(authority.waitForCallCount(2))

    firstConnection.fireInvalidation()
    #expect(firstReply.count == 0)
    #expect(secondReply.count == 0)

    let firstAfterClose = LockedDataProbe()
    first.credentialControl(
      try BrokerCredentialControlRequest.reservedOperation(requestID: 2).encode(),
      reply: firstAfterClose.receive
    )
    #expect(
      try decodeLifecycleReply(firstAfterClose.wait())
        == .failure(requestID: 2, .cancelled)
    )
    secondConnection.fireInterruption()
    #expect(
      try decodeLifecycleReply(secondReply.wait())
        == .failure(requestID: 1, .cancelled)
    )
    #expect(firstReply.count == 0)
    #expect(secondReply.count == 1)
    #expect(authority.callCount == 2)

  }

  @Test
  func anonymousXPCExercisesInheritedHealthLifecycleDataAndInvalidation() throws {
    let authority = XPCFakeAuthority(
      suspendProjection: true,
      expectedSecret: Data("anonymous-xpc-secret".utf8)
    )
    let productionDelegate = BrokerServiceListenerDelegate(
      exactPeerRequirement: "true",
      configuration: try recoveredConfiguration(authority: authority)
    )
    let listenerDelegate = AnonymousListenerDelegate(wrapped: productionDelegate)
    let listener = NSXPCListener.anonymous()
    listener.delegate = listenerDelegate
    listener.activate()

    let connection = NSXPCConnection(listenerEndpoint: listener.endpoint)
    connection.remoteObjectInterface = makeClientLifecycleInterface()
    let clientInvalidated = LockedSignal()
    connection.invalidationHandler = clientInvalidated.signal
    let errors = LockedSignal()
    connection.activate()
    let remoteObject = connection.remoteObjectProxyWithErrorHandler { _ in errors.signal() }
    let proxy = try #require(remoteObject as? BrokerCredentialLifecycleXPCProtocol)

    let hello = LockedDataProbe()
    proxy.exchange(try helloFrame(requestID: 1), reply: hello.receive)
    #expect(listenerDelegate.waitForAcceptance())
    #expect(try HelloResultMessage.decode(decodeNativeFrame(hello.wait())).persistentCredentials)

    let emptyStage = LockedDataProbe()
    proxy.stageCredential(
      try stageRequest(requestID: 1).encode(),
      secret: Data(),
      reply: emptyStage.receive
    )
    #expect(
      try decodeLifecycleReply(emptyStage.wait())
        == .failure(requestID: 1, .invalidRequest)
    )
    #expect(authority.callCount == 0)

    let staged = LockedDataProbe()
    let customBaseURL = "https://gateway.vendor.dev/" + String(repeating: "a", count: 400)
    let customDescriptor = try BrokerCredentialStageBindingDescriptor(
      activationProfileID: "custom_openai_compatible_v1",
      customBaseURL: customBaseURL,
      customModelCatalogBehavior: .unavailable
    )
    let metadataAlias = try stageRequest(
      requestID: 2,
      providerBinding: customDescriptor
    ).encode()
    let metadataTransfer = metadataAlias
    let secretAlias = Data("anonymous-xpc-secret".utf8)
    let secretTransfer = secretAlias
    proxy.stageCredential(
      metadataTransfer,
      secret: secretTransfer,
      reply: staged.receive
    )
    let stagedData = staged.wait()
    if case .staged(requestID: 2, _) = try decodeLifecycleReply(stagedData) {
    } else {
      Issue.record("Expected a staged anonymous-XPC reply")
    }
    #expect(metadataAlias == metadataTransfer)
    #expect(secretAlias == Data("anonymous-xpc-secret".utf8))
    #expect(!String(decoding: stagedData, as: UTF8.self).contains(customBaseURL))
    #expect(!String(decoding: stagedData, as: UTF8.self).contains("custom_openai_compatible_v1"))
    let expectedProviderBinding = try ProviderProfileBinding.customOpenAICompatible(
      baseURL: customBaseURL,
      modelCatalogBehavior: .unavailable
    )
    #expect(authority.receivedProviderBinding == expectedProviderBinding)

    let control = LockedDataProbe()
    proxy.credentialControl(
      try BrokerCredentialControlRequest.projection(
        requestID: 3,
        connectionID: connectionID
      ).encode(),
      reply: control.receive
    )
    #expect(authority.waitForCallCount(2))
    #expect(authority.receivedExpectedSecret)

    connection.invalidate()
    #expect(clientInvalidated.wait())
    #expect(listenerDelegate.waitForInvalidation())
    #expect(authority.waitForCancellationCount(1))
    #expect(authority.waitForProjectionCompletionCount(1))
    #expect(authority.cancellationCount == 1)
    #expect(control.count == 0)
    #expect(errors.wait())
    #expect(errors.count == 1)
    listener.invalidate()
    withExtendedLifetime((listener, listenerDelegate, connection, remoteObject, proxy)) {}
  }

  private func recoveredConfiguration(
    authority: any BrokerCredentialLifecycleAuthority
  ) throws -> BrokerServiceConfiguration {
    try BrokerServiceConfiguration.recoveredCredentialService(
      launcherVersion: "0.1.0",
      brokerVersion: "0.1.0",
      authority: authority,
      keychainStatus: { .available }
    )
  }

  private func helloFrame(requestID: UInt32) throws -> Data {
    try HelloMessage(
      engineVersion: "0.1.0",
      nonce: Data(repeating: 0x42, count: nativeNonceByteCount)
    ).encodedFrame(requestID: requestID)
  }

  private func stageRequest(requestID: UInt64) throws -> BrokerCredentialStageRequest {
    try stageRequest(
      requestID: requestID,
      providerBinding: BrokerCredentialStageBindingDescriptor(
        activationProfileID: "openai_api_v1"
      )
    )
  }

  private func stageRequest(
    requestID: UInt64,
    providerBinding: BrokerCredentialStageBindingDescriptor
  ) throws -> BrokerCredentialStageRequest {
    try BrokerCredentialStageRequest(
      requestID: requestID,
      connectionID: connectionID,
      operationID: operationID,
      expectedFence: 0,
      providerBinding: providerBinding
    )
  }

  private func decodeLifecycleReply(_ data: Data) throws -> BrokerCredentialLifecycleReply {
    try BrokerCredentialLifecycleReply.decode(data)
  }
}

private struct ProtocolSurface: Equatable {
  let requiredInstance: Set<String>
  let optionalInstance: Set<String>
  let requiredClass: Set<String>
  let optionalClass: Set<String>
}

private func protocolSurface(declaredBy protocolValue: Protocol) -> ProtocolSurface {
  ProtocolSurface(
    requiredInstance: selectors(declaredBy: protocolValue, required: true, instance: true),
    optionalInstance: selectors(declaredBy: protocolValue, required: false, instance: true),
    requiredClass: selectors(declaredBy: protocolValue, required: true, instance: false),
    optionalClass: selectors(declaredBy: protocolValue, required: false, instance: false)
  )
}

private func selectors(
  declaredBy protocolValue: Protocol,
  required: Bool,
  instance: Bool
) -> Set<String> {
  var count: UInt32 = 0
  guard
    let descriptions = protocol_copyMethodDescriptionList(
      protocolValue,
      required,
      instance,
      &count
    )
  else { return [] }
  defer { free(descriptions) }
  return Set(
    (0..<Int(count)).compactMap { index in
      descriptions[index].name.map(NSStringFromSelector)
    }
  )
}

private func assertExactDataAllowlists(
  _ interface: NSXPCInterface,
  includesLifecycle: Bool,
  includesOnboarding: Bool = false
) {
  let exchange = #selector(BrokerXPCProtocol.exchange(_:reply:))
  assertNSDataOnly(interface.classes(for: exchange, argumentIndex: 0, ofReply: false))
  assertNSDataOnly(interface.classes(for: exchange, argumentIndex: 0, ofReply: true))
  guard includesLifecycle else { return }

  let stage = #selector(BrokerCredentialLifecycleXPCProtocol.stageCredential(_:secret:reply:))
  assertNSDataOnly(interface.classes(for: stage, argumentIndex: 0, ofReply: false))
  assertNSDataOnly(interface.classes(for: stage, argumentIndex: 1, ofReply: false))
  assertNSDataOnly(interface.classes(for: stage, argumentIndex: 0, ofReply: true))
  let control = #selector(BrokerCredentialLifecycleXPCProtocol.credentialControl(_:reply:))
  assertNSDataOnly(interface.classes(for: control, argumentIndex: 0, ofReply: false))
  assertNSDataOnly(interface.classes(for: control, argumentIndex: 0, ofReply: true))
  guard includesOnboarding else { return }

  let begin =
    #selector(BrokerOpenAIOnboardingXPCProtocol.beginOpenAIOnboarding(_:secret:reply:))
  assertNSDataOnly(interface.classes(for: begin, argumentIndex: 0, ofReply: false))
  assertNSDataOnly(interface.classes(for: begin, argumentIndex: 1, ofReply: false))
  assertNSDataOnly(interface.classes(for: begin, argumentIndex: 0, ofReply: true))
  let onboardingControl =
    #selector(BrokerOpenAIOnboardingXPCProtocol.openAIOnboardingControl(_:reply:))
  assertNSDataOnly(
    interface.classes(for: onboardingControl, argumentIndex: 0, ofReply: false)
  )
  assertNSDataOnly(
    interface.classes(for: onboardingControl, argumentIndex: 0, ofReply: true)
  )
  let reconciliation =
    #selector(BrokerOpenAIOnboardingXPCProtocol.reconcileOpenAIActivation(_:reply:))
  assertNSDataOnly(
    interface.classes(for: reconciliation, argumentIndex: 0, ofReply: false)
  )
  assertNSDataOnly(
    interface.classes(for: reconciliation, argumentIndex: 0, ofReply: true)
  )
}

private func assertNSDataOnly(_ classes: Set<AnyHashable>) {
  #expect(classes.count == 1)
  #expect((classes as NSSet).contains(NSData.self))
  #expect(!(classes as NSSet).contains(NSURL.self))
  #expect(!(classes as NSSet).contains(NSDictionary.self))
  #expect(!(classes as NSSet).contains(NSObject.self))
}

private func makeClientLifecycleInterface() -> NSXPCInterface {
  let interface = NSXPCInterface(with: BrokerCredentialLifecycleXPCProtocol.self)
  let dataClasses = NSSet(object: NSData.self) as! Set<AnyHashable>
  let registrations: [(Selector, Int, Bool)] = [
    (#selector(BrokerXPCProtocol.exchange(_:reply:)), 0, false),
    (#selector(BrokerXPCProtocol.exchange(_:reply:)), 0, true),
    (#selector(BrokerCredentialLifecycleXPCProtocol.stageCredential(_:secret:reply:)), 0, false),
    (#selector(BrokerCredentialLifecycleXPCProtocol.stageCredential(_:secret:reply:)), 1, false),
    (#selector(BrokerCredentialLifecycleXPCProtocol.stageCredential(_:secret:reply:)), 0, true),
    (#selector(BrokerCredentialLifecycleXPCProtocol.credentialControl(_:reply:)), 0, false),
    (#selector(BrokerCredentialLifecycleXPCProtocol.credentialControl(_:reply:)), 0, true),
  ]
  for (selector, index, reply) in registrations {
    interface.setClasses(dataClasses, for: selector, argumentIndex: index, ofReply: reply)
  }
  return interface
}

private func makeClientOpenAIOnboardingInterface() -> NSXPCInterface {
  let interface = NSXPCInterface(with: BrokerOpenAIOnboardingXPCProtocol.self)
  let dataClasses = NSSet(object: NSData.self) as! Set<AnyHashable>
  let registrations: [(Selector, Int, Bool)] = [
    (#selector(BrokerXPCProtocol.exchange(_:reply:)), 0, false),
    (#selector(BrokerXPCProtocol.exchange(_:reply:)), 0, true),
    (#selector(BrokerCredentialLifecycleXPCProtocol.stageCredential(_:secret:reply:)), 0, false),
    (#selector(BrokerCredentialLifecycleXPCProtocol.stageCredential(_:secret:reply:)), 1, false),
    (#selector(BrokerCredentialLifecycleXPCProtocol.stageCredential(_:secret:reply:)), 0, true),
    (#selector(BrokerCredentialLifecycleXPCProtocol.credentialControl(_:reply:)), 0, false),
    (#selector(BrokerCredentialLifecycleXPCProtocol.credentialControl(_:reply:)), 0, true),
    (
      #selector(BrokerOpenAIOnboardingXPCProtocol.beginOpenAIOnboarding(_:secret:reply:)),
      0,
      false
    ),
    (
      #selector(BrokerOpenAIOnboardingXPCProtocol.beginOpenAIOnboarding(_:secret:reply:)),
      1,
      false
    ),
    (
      #selector(BrokerOpenAIOnboardingXPCProtocol.beginOpenAIOnboarding(_:secret:reply:)),
      0,
      true
    ),
    (
      #selector(BrokerOpenAIOnboardingXPCProtocol.openAIOnboardingControl(_:reply:)),
      0,
      false
    ),
    (
      #selector(BrokerOpenAIOnboardingXPCProtocol.openAIOnboardingControl(_:reply:)),
      0,
      true
    ),
    (
      #selector(BrokerOpenAIOnboardingXPCProtocol.reconcileOpenAIActivation(_:reply:)),
      0,
      false
    ),
    (
      #selector(BrokerOpenAIOnboardingXPCProtocol.reconcileOpenAIActivation(_:reply:)),
      0,
      true
    ),
  ]
  for (selector, index, reply) in registrations {
    interface.setClasses(dataClasses, for: selector, argumentIndex: index, ofReply: reply)
  }
  return interface
}

private func decodeNativeFrame(_ data: Data) throws -> NativeFrame {
  var decoder = NativeFrameDecoder()
  let frames = try decoder.push(data)
  try decoder.finish()
  return try #require(frames.count == 1 ? frames[0] : nil)
}

final class TestBrokerConnection: BrokerServiceConnection, @unchecked Sendable {
  private let lock = NSLock()
  private var storedInterface: NSXPCInterface?
  private var storedObject: Any?
  private var storedInterruption: (() -> Void)?
  private var storedInvalidation: (() -> Void)?
  private var recordedEvents: [String] = []

  var exportedInterface: NSXPCInterface? {
    get { lock.withLock { storedInterface } }
    set {
      lock.withLock {
        storedInterface = newValue
        recordedEvents.append("interface")
      }
    }
  }

  var exportedObject: Any? {
    get { lock.withLock { storedObject } }
    set {
      lock.withLock {
        storedObject = newValue
        recordedEvents.append("object")
      }
    }
  }

  var interruptionHandler: (() -> Void)? {
    get { lock.withLock { storedInterruption } }
    set {
      lock.withLock {
        storedInterruption = newValue
        recordedEvents.append("interruption")
      }
    }
  }

  var invalidationHandler: (() -> Void)? {
    get { lock.withLock { storedInvalidation } }
    set {
      lock.withLock {
        storedInvalidation = newValue
        recordedEvents.append("invalidation")
      }
    }
  }

  var events: [String] { lock.withLock { recordedEvents } }

  func setCodeSigningRequirement(_ requirement: String) {
    lock.withLock { recordedEvents.append("requirement") }
  }

  func activate() {
    lock.withLock { recordedEvents.append("activate") }
  }

  func fireInterruption() {
    let handler = lock.withLock { storedInterruption }
    handler?()
  }

  func fireInvalidation() {
    let handler = lock.withLock { storedInvalidation }
    handler?()
  }
}

final class LockedDataProbe: @unchecked Sendable {
  private let condition = NSCondition()
  private var values: [Data] = []

  var count: Int {
    condition.withLock { values.count }
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
    guard let value = values.first else {
      Issue.record("Timed out waiting for data")
      return Data()
    }
    return value
  }
}

private final class LockedSignal: @unchecked Sendable {
  private let condition = NSCondition()
  private var signals = 0

  var count: Int { condition.withLock { signals } }

  func signal() {
    condition.lock()
    signals += 1
    condition.broadcast()
    condition.unlock()
  }

  func wait(timeout: TimeInterval = 3) -> Bool {
    condition.lock()
    defer { condition.unlock() }
    let deadline = Date().addingTimeInterval(timeout)
    while signals == 0, condition.wait(until: deadline) {}
    return signals > 0
  }
}

private final class LockedEventProbe: @unchecked Sendable {
  private let lock = NSLock()
  private var events: [String] = []

  func record(_ event: String) { lock.withLock { events.append(event) } }
  func snapshot() -> [String] { lock.withLock { events } }
}

private final class XPCFakeAuthority: BrokerCredentialLifecycleAuthority, @unchecked Sendable {
  private let condition = NSCondition()
  private let suspendProjection: Bool
  private let expectedSecret: Data?
  private var calls: [(String, UUID)] = []
  private var cancellations = 0
  private var projectionCompletions = 0
  private var matchedSecret = false
  private var providerBinding: ProviderProfileBinding?

  init(suspendProjection: Bool = false, expectedSecret: Data? = nil) {
    self.suspendProjection = suspendProjection
    self.expectedSecret = expectedSecret
  }

  var callCount: Int { condition.withLock { calls.count } }
  var cancellationCount: Int { condition.withLock { cancellations } }
  var receivedExpectedSecret: Bool { condition.withLock { matchedSecret } }
  var receivedProviderBinding: ProviderProfileBinding? {
    condition.withLock { providerBinding }
  }

  func waitForCallCount(_ expected: Int, timeout: TimeInterval = 3) -> Bool {
    condition.lock()
    defer { condition.unlock() }
    let deadline = Date().addingTimeInterval(timeout)
    while calls.count < expected, condition.wait(until: deadline) {}
    return calls.count >= expected
  }

  func waitForCancellationCount(_ expected: Int, timeout: TimeInterval = 3) -> Bool {
    condition.lock()
    defer { condition.unlock() }
    let deadline = Date().addingTimeInterval(timeout)
    while cancellations < expected, condition.wait(until: deadline) {}
    return cancellations >= expected
  }

  func waitForProjectionCompletionCount(_ expected: Int, timeout: TimeInterval = 3) -> Bool {
    condition.lock()
    defer { condition.unlock() }
    let deadline = Date().addingTimeInterval(timeout)
    while projectionCompletions < expected, condition.wait(until: deadline) {}
    return projectionCompletions >= expected
  }

  func authoritativeLifecycleProjection(
    for connectionID: UUID
  ) async throws(BrokerJournalError) -> CredentialLifecycleProjection {
    record("projection", connectionID: connectionID)
    defer { recordProjectionCompletion() }
    if suspendProjection {
      do {
        try await Task.sleep(for: .seconds(60))
      } catch {
        recordCancellation()
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
    let bytes = secret.withUnsafeBytes { Data($0) }
    secret.erase()
    recordStage(
      connectionID: connectionID,
      providerBinding: providerBinding,
      bytes: bytes
    )
    return StagingAttempt(
      connectionID: connectionID,
      attemptID: UUID(uuidString: "60000000-0000-4000-8000-000000000011")!,
      fence: expectedFence + 1,
      candidate: CredentialGeneration(
        generationID: UUID(uuidString: "70000000-0000-4000-8000-000000000011")!,
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
    record("resume", connectionID: connectionID)
    return StagingAttempt(
      connectionID: connectionID,
      attemptID: UUID(uuidString: "60000000-0000-4000-8000-000000000011")!,
      fence: expectedFence + 1,
      candidate: CredentialGeneration(
        generationID: UUID(uuidString: "70000000-0000-4000-8000-000000000011")!,
        ordinal: 1,
        createdAt: Date(timeIntervalSince1970: 1)
      ),
      previousReady: nil,
      startedAt: Date(timeIntervalSince1970: 1)
    )
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
    record("abort", connectionID: connectionID)
    return nil
  }

  func disconnect(
    connectionID: UUID,
    operationID: UUID,
    expectedFence: UInt64
  ) async throws(BrokerStateError) -> TombstoneProjection {
    record("disconnect", connectionID: connectionID)
    return TombstoneProjection(
      connectionID: connectionID,
      fence: expectedFence + 1,
      lastGenerationOrdinal: 0,
      tombstonedAt: Date(timeIntervalSince1970: 1)
    )
  }

  private func record(_ operation: String, connectionID: UUID) {
    condition.lock()
    calls.append((operation, connectionID))
    condition.broadcast()
    condition.unlock()
  }

  private func recordCancellation() {
    condition.lock()
    cancellations += 1
    condition.broadcast()
    condition.unlock()
  }
  private func recordProjectionCompletion() {
    condition.lock()
    projectionCompletions += 1
    condition.broadcast()
    condition.unlock()
  }

  private func recordStage(
    connectionID: UUID,
    providerBinding: ProviderProfileBinding,
    bytes: Data
  ) {
    condition.lock()
    calls.append(("stage", connectionID))
    self.providerBinding = providerBinding
    if let expectedSecret { matchedSecret = bytes == expectedSecret }
    condition.broadcast()
    condition.unlock()
  }
}

private final class AnonymousListenerDelegate: NSObject, NSXPCListenerDelegate,
  @unchecked Sendable
{
  private let wrapped: BrokerServiceListenerDelegate
  private let accepted = LockedSignal()
  private let invalidated = LockedSignal()
  private let lock = NSLock()
  private var retainedConnections: [NSXPCConnection] = []

  init(wrapped: BrokerServiceListenerDelegate) {
    self.wrapped = wrapped
  }

  func listener(
    _ listener: NSXPCListener,
    shouldAcceptNewConnection newConnection: NSXPCConnection
  ) -> Bool {
    wrapped.configure(newConnection)
    let originalInvalidation = newConnection.invalidationHandler
    newConnection.invalidationHandler = { [invalidated] in
      originalInvalidation?()
      invalidated.signal()
    }
    lock.withLock { retainedConnections.append(newConnection) }
    accepted.signal()
    return true
  }

  func waitForAcceptance() -> Bool { accepted.wait() }
  func waitForInvalidation() -> Bool { invalidated.wait() }
}

private struct XPCOpenAIIdentityFingerprinter: CredentialIdentityFingerprinting {
  static let rawFingerprint = "sha256:" + String(repeating: "1", count: 64)

  func fingerprint(
    credential: UnsafeRawBufferPointer,
    binding: ProviderProfileBinding
  ) throws(CredentialIdentityFingerprintError) -> CredentialIdentityFingerprint {
    guard !credential.isEmpty, binding == .openAI else { throw .invalidCredential }
    return try CredentialIdentityFingerprint(validating: Self.rawFingerprint)
  }
}

private final class XPCOpenAIOnboardingFactory:
  BrokerOpenAIOnboardingSessionFactory,
  @unchecked Sendable
{
  let session = XPCOpenAIOnboardingSession()

  func makeSession(
    context: BrokerOpenAIOnboardingStagingContext,
    abortOperationID: UUID
  ) throws(BrokerOpenAIOnboardingError) -> any BrokerOpenAIOnboardingSessionProtocol {
    guard context.providerBinding == .openAI else { throw .invalidContext }
    return session
  }
}

private final class XPCOpenAIOnboardingSession:
  BrokerOpenAIOnboardingSessionProtocol,
  @unchecked Sendable
{
  private let closed = LockedSignal()

  func verify() async throws(BrokerOpenAIOnboardingError) -> BrokerOpenAIModelCatalog {
    BrokerOpenAIModelCatalog(modelIDs: ["gpt-5"], requestID: "request-id")
  }

  func finalize(
    exactModelID: String,
    operationID: UUID
  ) async throws(BrokerOpenAIOnboardingError) -> BrokerOpenAIOnboardingReceipt {
    throw .invalidState
  }

  func close() async throws(BrokerOpenAIOnboardingError) {
    closed.signal()
  }

  func waitUntilClosed() -> Bool { closed.wait() }
}

extension BrokerCredentialLifecycleReply {
  fileprivate var requestIDForTesting: UInt64 {
    switch self {
    case .projection(let requestID, _), .staged(let requestID, _),
      .mutation(let requestID, _), .failure(let requestID, _):
      requestID
    }
  }
}
