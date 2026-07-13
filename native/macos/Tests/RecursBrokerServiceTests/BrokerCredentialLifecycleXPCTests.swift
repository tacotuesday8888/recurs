import Darwin
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
  func exportedProtocolsAndSevenDataAllowlistsAreExact() throws {
    let baseProtocol: Protocol = BrokerXPCProtocol.self
    let lifecycleProtocol: Protocol = BrokerCredentialLifecycleXPCProtocol.self
    #expect(protocol_conformsToProtocol(lifecycleProtocol, baseProtocol))
    #expect(
      selectors(declaredBy: baseProtocol)
        == [NSStringFromSelector(#selector(BrokerXPCProtocol.exchange(_:reply:)))]
    )
    #expect(
      selectors(declaredBy: lifecycleProtocol)
        == [
          NSStringFromSelector(
            #selector(BrokerCredentialLifecycleXPCProtocol.credentialControl(_:reply:))),
          NSStringFromSelector(
            #selector(
              BrokerCredentialLifecycleXPCProtocol.stageCredential(_:secret:reply:))),
        ]
    )

    let authority = XPCFakeAuthority()
    let recovered = try recoveredConfiguration(authority: authority)
    let dynamicallyUnavailable = try? BrokerServiceConfiguration.recoveredCredentialService(
      launcherVersion: "0.1.0",
      brokerVersion: "0.1.0",
      authority: authority,
      initialKeychain: .unavailable,
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

    let healthOnly = try BrokerServiceConfiguration.healthOnlyForTesting(
      launcherVersion: "0.1.0",
      brokerVersion: "0.1.0",
      productionSigned: true,
      initialKeychain: .available,
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
  func healthOnlyCallsFailClosedAndEraseStageStorage() throws {
    let configuration = try BrokerServiceConfiguration.healthOnlyForTesting(
      launcherVersion: "0.1.0",
      brokerVersion: "0.1.0",
      productionSigned: true,
      initialKeychain: .available,
      keychainStatus: { .available }
    )
    let service = BrokerService(configuration: configuration)
    let hello = LockedDataProbe()
    service.exchange(try helloFrame(requestID: 1), reply: hello.receive)
    let helloResult = try HelloResultMessage.decode(
      try decodeNativeFrame(hello.wait())
    )
    #expect(!helloResult.persistentCredentials)

    let validSecret = MutableSecretBuffer(Data("health-only-stage-canary".utf8))
    let validStage = LockedDataProbe()
    service.stageCredential(
      try stageRequest(requestID: 7).encode(),
      secret: validSecret.makeData(),
      reply: validStage.receive
    )
    #expect(validSecret.isErased)
    #expect(validStage.count == 1)
    #expect(
      try decodeLifecycleReply(validStage.wait())
        == .failure(requestID: 7, .operationUnavailable)
    )

    var malformedMetadata = try stageRequest(requestID: 8).encode()
    malformedMetadata.replaceSubrange(20..<36, with: repeatElement(UInt8(0), count: 16))
    let malformedSecret = MutableSecretBuffer(Data("malformed-stage-canary".utf8))
    let malformedStage = LockedDataProbe()
    service.stageCredential(
      malformedMetadata,
      secret: malformedSecret.makeData(),
      reply: malformedStage.receive
    )
    #expect(malformedSecret.isErased)
    #expect(
      try decodeLifecycleReply(malformedStage.wait())
        == .failure(requestID: 8, .invalidRequest)
    )

    let validControl = LockedDataProbe()
    service.credentialControl(
      try BrokerCredentialControlRequest.projection(
        requestID: 9,
        connectionID: connectionID
      ).encode(),
      reply: validControl.receive
    )
    #expect(
      try decodeLifecycleReply(validControl.wait())
        == .failure(requestID: 9, .operationUnavailable)
    )

    let malformedControl = LockedDataProbe()
    service.credentialControl(Data([0xde, 0xad]), reply: malformedControl.receive)
    #expect(
      try decodeLifecycleReply(malformedControl.wait())
        == .failure(requestID: brokerCredentialMalformedRequestID, .invalidRequest)
    )
  }

  @Test
  func helloAndTerminalActionsPrecedeReentrantReplies() async throws {
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
    try await Task.sleep(for: .milliseconds(20))
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
    #expect(
      try decodeLifecycleReply(firstReply.wait())
        == .failure(requestID: 1, .cancelled)
    )
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
    secondConnection.fireInvalidation()
    #expect(
      try decodeLifecycleReply(secondReply.wait())
        == .failure(requestID: 1, .cancelled)
    )
    #expect(firstReply.count == 1)
    #expect(secondReply.count == 1)
    #expect(authority.callCount == 2)

    let reservedAuthority = XPCFakeAuthority()
    let reservedService = BrokerService(
      configuration: try recoveredConfiguration(authority: reservedAuthority)
    )
    let beforeHello = LockedDataProbe()
    reservedService.credentialControl(
      try BrokerCredentialControlRequest.projection(
        requestID: 1,
        connectionID: connectionID
      ).encode(),
      reply: beforeHello.receive
    )
    #expect(
      try decodeLifecycleReply(beforeHello.wait())
        == .failure(requestID: 1, .sessionNotReady)
    )
    let reservedHello = LockedDataProbe()
    reservedService.exchange(try helloFrame(requestID: 1), reply: reservedHello.receive)
    _ = reservedHello.wait()
    let reserved = LockedDataProbe()
    reservedService.credentialControl(
      try BrokerCredentialControlRequest.reservedOperation(requestID: 2).encode(),
      reply: reserved.receive
    )
    #expect(
      try decodeLifecycleReply(reserved.wait())
        == .failure(requestID: 2, .operationUnavailable)
    )
    #expect(reservedAuthority.callCount == 0)
  }

  @Test
  func concurrentHelloLifecycleAndConnectionTerminationStayFailClosed() throws {
    for iteration in 0..<20 {
      let authority = XPCFakeAuthority()
      let connection = TestBrokerConnection()
      BrokerServiceListenerDelegate(
        exactPeerRequirement: "true",
        configuration: try recoveredConfiguration(authority: authority)
      ).configure(connection)
      let service = try #require(connection.exportedObject as? BrokerService)
      let hello = try helloFrame(requestID: 1)
      let control = try BrokerCredentialControlRequest.projection(
        requestID: 1,
        connectionID: connectionID
      ).encode()
      let helloReply = LockedDataProbe()
      let lifecycleReply = LockedDataProbe()
      let start = DispatchSemaphore(value: 0)
      let group = DispatchGroup()
      let work: [@Sendable () -> Void] = [
        { service.exchange(hello, reply: helloReply.receive) },
        { service.credentialControl(control, reply: lifecycleReply.receive) },
        { connection.fireInterruption() },
        { connection.fireInvalidation() },
      ]
      for operation in work {
        group.enter()
        DispatchQueue.global().async {
          start.wait()
          operation()
          group.leave()
        }
      }
      for _ in work { start.signal() }
      #expect(group.wait(timeout: .now() + 3) == .success)
      _ = helloReply.wait()
      let reply = try decodeLifecycleReply(lifecycleReply.wait())
      switch reply {
      case .projection(requestID: 1, _), .failure(requestID: 1, .sessionNotReady),
        .failure(requestID: 1, .cancelled):
        break
      default:
        Issue.record("Unexpected hello/lifecycle race reply in iteration \(iteration)")
      }
      #expect(lifecycleReply.count == 1)

      let afterClose = LockedDataProbe()
      service.credentialControl(
        try BrokerCredentialControlRequest.projection(
          requestID: 2,
          connectionID: connectionID
        ).encode(),
        reply: afterClose.receive
      )
      #expect(
        try decodeLifecycleReply(afterClose.wait())
          == .failure(requestID: 2, .cancelled)
      )
    }
  }

  @Test
  func anonymousXPCExercisesInheritedHealthLifecycleDataAndInvalidation() throws {
    let authority = XPCFakeAuthority(expectedSecret: Data("anonymous-xpc-secret".utf8))
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

    let staged = LockedDataProbe()
    proxy.stageCredential(
      try stageRequest(requestID: 1).encode(),
      secret: Data("anonymous-xpc-secret".utf8),
      reply: staged.receive
    )
    if case .staged(requestID: 1, _) = try decodeLifecycleReply(staged.wait()) {
    } else {
      Issue.record("Expected a staged anonymous-XPC reply")
    }

    let control = LockedDataProbe()
    proxy.credentialControl(
      try BrokerCredentialControlRequest.projection(
        requestID: 2,
        connectionID: connectionID
      ).encode(),
      reply: control.receive
    )
    #expect(try decodeLifecycleReply(control.wait()).requestIDForTesting == 2)
    #expect(authority.receivedExpectedSecret)

    connection.invalidate()
    #expect(clientInvalidated.wait())
    #expect(listenerDelegate.waitForInvalidation())
    #expect(errors.count == 0)
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
      initialKeychain: .available,
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
    try BrokerCredentialStageRequest(
      requestID: requestID,
      connectionID: connectionID,
      operationID: operationID,
      expectedFence: 0
    )
  }

  private func decodeLifecycleReply(_ data: Data) throws -> BrokerCredentialLifecycleReply {
    try BrokerCredentialLifecycleReply.decode(data)
  }
}

private func selectors(declaredBy protocolValue: Protocol) -> Set<String> {
  var count: UInt32 = 0
  guard
    let descriptions = protocol_copyMethodDescriptionList(
      protocolValue,
      true,
      true,
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
  includesLifecycle: Bool
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

private func decodeNativeFrame(_ data: Data) throws -> NativeFrame {
  var decoder = NativeFrameDecoder()
  let frames = try decoder.push(data)
  try decoder.finish()
  return try #require(frames.count == 1 ? frames[0] : nil)
}

private final class TestBrokerConnection: BrokerServiceConnection, @unchecked Sendable {
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

private final class LockedDataProbe: @unchecked Sendable {
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

private final class MutableSecretBuffer {
  private let pointer: UnsafeMutableRawPointer
  private let byteCount: Int

  init(_ data: Data) {
    byteCount = data.count
    pointer = .allocate(byteCount: max(data.count, 1), alignment: 1)
    data.withUnsafeBytes { bytes in
      if let baseAddress = bytes.baseAddress, !bytes.isEmpty {
        pointer.copyMemory(from: baseAddress, byteCount: bytes.count)
      }
    }
  }

  func makeData() -> Data {
    Data(bytesNoCopy: pointer, count: byteCount, deallocator: .none)
  }

  var isErased: Bool {
    UnsafeRawBufferPointer(start: pointer, count: byteCount).allSatisfy { $0 == 0 }
  }

  deinit { pointer.deallocate() }
}

private final class XPCFakeAuthority: BrokerCredentialLifecycleAuthority, @unchecked Sendable {
  private let condition = NSCondition()
  private let suspendProjection: Bool
  private let expectedSecret: Data?
  private var calls: [(String, UUID)] = []
  private var cancellations = 0
  private var matchedSecret = false

  init(suspendProjection: Bool = false, expectedSecret: Data? = nil) {
    self.suspendProjection = suspendProjection
    self.expectedSecret = expectedSecret
  }

  var callCount: Int { condition.withLock { calls.count } }
  var receivedExpectedSecret: Bool { condition.withLock { matchedSecret } }

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

  func authoritativeLifecycleProjection(
    for connectionID: UUID
  ) async throws(BrokerJournalError) -> CredentialLifecycleProjection {
    record("projection", connectionID: connectionID)
    if suspendProjection {
      do {
        try await Task.sleep(for: .seconds(60))
      } catch {
        recordCancellation()
        throw .storageUnavailable
      }
    }
    return .vacant(connectionID: connectionID, fence: 0)
  }

  func stage(
    connectionID: UUID,
    operationID: UUID,
    expectedFence: UInt64,
    secret: sending SecretBytes
  ) async throws(BrokerStateError) -> StagingAttempt {
    let bytes = secret.withUnsafeBytes { Data($0) }
    secret.erase()
    recordStage(connectionID: connectionID, bytes: bytes)
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

  private func recordStage(connectionID: UUID, bytes: Data) {
    condition.lock()
    calls.append(("stage", connectionID))
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

extension BrokerCredentialLifecycleReply {
  fileprivate var requestIDForTesting: UInt64 {
    switch self {
    case .projection(let requestID, _), .staged(let requestID, _),
      .mutation(let requestID, _), .failure(let requestID, _):
      requestID
    }
  }
}
