import Foundation
import RecursBrokerXPC
import RecursNativeProtocol
import Testing

@testable import RecursBrokerService

@Suite
struct BrokerServiceTests {
  @Test
  func helloEchoesTheNonceAndReportsOnlyConfiguredCapabilities() throws {
    var session = BrokerServiceSession(
      configuration: try BrokerServiceConfiguration(
        launcherVersion: "0.1.0",
        brokerVersion: "0.1.0",
        productionSigned: false,
        keychain: .unavailable
      )
    )
    let nonce = Data((0..<nativeNonceByteCount).map(UInt8.init))

    let response = session.exchange(
      try HelloMessage(engineVersion: "0.1.0", nonce: nonce)
        .encodedFrame(requestID: 41)
    ).response

    let result = try HelloResultMessage.decode(try decodeSingleFrame(response))
    #expect(result.launcherVersion == "0.1.0")
    #expect(result.brokerVersion == "0.1.0")
    #expect(result.echoedNonce == nonce)
    #expect(!result.productionSigned)
    #expect(!result.persistentCredentials)
    #expect(result.minimumMacosVersion == "14.4")
  }

  @Test
  func healthSucceedsOnlyAfterAValidHello() throws {
    var session = BrokerServiceSession(
      configuration: try BrokerServiceConfiguration(
        launcherVersion: "0.1.0",
        brokerVersion: "0.1.0",
        productionSigned: true,
        keychain: .available
      )
    )
    let nonce = Data(repeating: 7, count: nativeNonceByteCount)
    _ = session.exchange(
      try HelloMessage(engineVersion: "0.1.0", nonce: nonce)
        .encodedFrame(requestID: 41)
    )

    let response = session.exchange(try makeHealthFrame(requestID: 42)).response

    let result = try HealthResultMessage.decode(try decodeSingleFrame(response))
    #expect(result.keychain == .available)
    #expect(result.peerVerified)
  }

  @Test
  func helloRejectsAnEngineVersionThatDoesNotMatchTheBrokerGeneration() throws {
    var session = BrokerServiceSession(
      configuration: try BrokerServiceConfiguration(
        launcherVersion: "0.1.0",
        brokerVersion: "0.1.0",
        productionSigned: true,
        keychain: .available
      )
    )
    let nonce = Data(repeating: 8, count: nativeNonceByteCount)

    let mismatch = try decodeSingleFrame(
      session.exchange(
        try HelloMessage(engineVersion: "0.2.0", nonce: nonce)
          .encodedFrame(requestID: 41)
      ).response
    )
    let retry = try decodeSingleFrame(
      session.exchange(
        try HelloMessage(engineVersion: "0.1.0", nonce: nonce)
          .encodedFrame(requestID: 42)
      ).response
    )

    #expect(mismatch.requestID == 41)
    #expect(try SafeFailureCode.decode(mismatch) == .protocolMismatch)
    #expect(retry.requestID == 42)
    #expect(try SafeFailureCode.decode(retry) == .protocolMismatch)
  }

  @Test
  func everyHealthRequestReadsCurrentKeychainAvailability() throws {
    let statuses = ScriptedKeychainStatusSource([.available, .locked])
    var session = BrokerServiceSession(
      configuration: try BrokerServiceConfiguration(
        launcherVersion: "0.1.0",
        brokerVersion: "0.1.0",
        productionSigned: true,
        keychainStatus: { statuses.next() }
      )
    )
    _ = session.exchange(
      try HelloMessage(
        engineVersion: "0.1.0",
        nonce: Data(repeating: 9, count: nativeNonceByteCount)
      ).encodedFrame(requestID: 1)
    )

    let first = try HealthResultMessage.decode(
      try decodeSingleFrame(
        session.exchange(try makeHealthFrame(requestID: 2)).response
      )
    )
    let second = try HealthResultMessage.decode(
      try decodeSingleFrame(
        session.exchange(try makeHealthFrame(requestID: 3)).response
      )
    )

    #expect(first.keychain == .available)
    #expect(second.keychain == .locked)
    #expect(statuses.callCount == 2)
  }

  @Test
  func healthBeforeHelloReturnsOnlyTheFixedProtocolMismatchCode() throws {
    var session = BrokerServiceSession(
      configuration: try BrokerServiceConfiguration(
        launcherVersion: "0.1.0",
        brokerVersion: "0.1.0",
        productionSigned: false,
        keychain: .unavailable
      )
    )

    let frame = try decodeSingleFrame(
      session.exchange(try makeHealthFrame(requestID: 9)).response
    )

    #expect(frame.requestID == 9)
    #expect(try SafeFailureCode.decode(frame) == .protocolMismatch)
    let fields = try FieldTable.decode(frame.payload).fields
    #expect(fields.count == 1)
    #expect(fields[0].tag == 1)
    #expect(fields[0].value.count == 2)
  }

  @Test
  func malformedInputReturnsADeterministicProtocolMismatchFrame() throws {
    var session = BrokerServiceSession(
      configuration: try BrokerServiceConfiguration(
        launcherVersion: "0.1.0",
        brokerVersion: "0.1.0",
        productionSigned: false,
        keychain: .unavailable
      )
    )

    let frame = try decodeSingleFrame(
      session.exchange(Data([0xde, 0xad, 0xbe, 0xef])).response
    )

    #expect(frame.requestID == brokerMalformedFrameRequestID)
    #expect(try SafeFailureCode.decode(frame) == .protocolMismatch)
  }

  @Test
  func oneXPCExchangeCannotBatchMultipleProtocolFrames() throws {
    var session = BrokerServiceSession(
      configuration: try BrokerServiceConfiguration(
        launcherVersion: "0.1.0",
        brokerVersion: "0.1.0",
        productionSigned: false,
        keychain: .unavailable
      )
    )
    let hello = try HelloMessage(
      engineVersion: "0.1.0",
      nonce: Data(repeating: 1, count: nativeNonceByteCount)
    ).encodedFrame(requestID: 1)
    let batched = hello + (try makeHealthFrame(requestID: 2))

    let frame = try decodeSingleFrame(session.exchange(batched).response)

    #expect(frame.requestID == brokerMalformedFrameRequestID)
    #expect(try SafeFailureCode.decode(frame) == .protocolMismatch)
  }

  @Test
  func everyDecodedNonHelloOrHealthMessageIsUnsupported() throws {
    let unsupportedTypes = NativeMessageType.allCases.filter {
      $0 != .hello && $0 != .health
    }
    #expect(
      unsupportedTypes
        == [
          .helloResult,
          .healthResult,
          .cancel,
          .openAIOnboardingRequest,
          .openAIOnboardingBegun,
          .openAIOnboardingCatalogPage,
          .openAIOnboardingCommitted,
          .openAIOnboardingAborted,
          .openAIOnboardingReconciliation,
          .openAIOnboardingFailure,
          .openAIGenerationRequest,
          .openAIGenerationEvent,
          .openAIGenerationFailure,
          .safeFailure,
        ]
    )

    for (index, type) in unsupportedTypes.enumerated() {
      var session = BrokerServiceSession(
        configuration: try BrokerServiceConfiguration(
          launcherVersion: "0.1.0",
          brokerVersion: "0.1.0",
          productionSigned: false,
          keychain: .unavailable
        )
      )
      let requestID = UInt32(index + 1)
      let request = try NativeFrame(
        type: type,
        requestID: requestID,
        payload: FieldTable(fields: []).encoded()
      ).encoded()

      let frame = try decodeSingleFrame(session.exchange(request).response)

      #expect(frame.requestID == requestID)
      #expect(try SafeFailureCode.decode(frame) == .unsupportedOperation)
    }
  }

  @Test
  func aSecondHelloIsAReplayThatFailsClosed() throws {
    var session = BrokerServiceSession(
      configuration: try BrokerServiceConfiguration(
        launcherVersion: "0.1.0",
        brokerVersion: "0.1.0",
        productionSigned: false,
        keychain: .unavailable
      )
    )
    let firstHello = try HelloMessage(
      engineVersion: "0.1.0",
      nonce: Data(repeating: 3, count: nativeNonceByteCount)
    ).encodedFrame(requestID: 21)
    _ = session.exchange(firstHello)
    let secondHello = try HelloMessage(
      engineVersion: "0.1.0",
      nonce: Data(repeating: 4, count: nativeNonceByteCount)
    ).encodedFrame(requestID: 22)

    let replay = try decodeSingleFrame(session.exchange(secondHello).response)

    #expect(replay.requestID == 22)
    #expect(try SafeFailureCode.decode(replay) == .protocolMismatch)
  }

  @Test
  func replayedAndOutOfOrderRequestIDsFailClosed() throws {
    var replaySession = BrokerServiceSession(
      configuration: try BrokerServiceConfiguration(
        launcherVersion: "0.1.0",
        brokerVersion: "0.1.0",
        productionSigned: false,
        keychain: .unavailable
      )
    )
    let hello = try HelloMessage(
      engineVersion: "0.1.0",
      nonce: Data(repeating: 5, count: nativeNonceByteCount)
    ).encodedFrame(requestID: 40)
    _ = replaySession.exchange(hello)
    _ = replaySession.exchange(try makeHealthFrame(requestID: 41))

    let replay = try decodeSingleFrame(
      replaySession.exchange(try makeHealthFrame(requestID: 41)).response
    )
    let afterReplay = try decodeSingleFrame(
      replaySession.exchange(try makeHealthFrame(requestID: 42)).response
    )

    #expect(replay.requestID == 41)
    #expect(try SafeFailureCode.decode(replay) == .protocolMismatch)
    #expect(afterReplay.requestID == 42)
    #expect(try SafeFailureCode.decode(afterReplay) == .protocolMismatch)

    var outOfOrderSession = BrokerServiceSession(
      configuration: try BrokerServiceConfiguration(
        launcherVersion: "0.1.0",
        brokerVersion: "0.1.0",
        productionSigned: false,
        keychain: .unavailable
      )
    )
    _ = outOfOrderSession.exchange(hello)
    let outOfOrder = try decodeSingleFrame(
      outOfOrderSession.exchange(try makeHealthFrame(requestID: 39)).response
    )
    #expect(outOfOrder.requestID == 39)
    #expect(try SafeFailureCode.decode(outOfOrder) == .protocolMismatch)
  }

  @Test
  func malformedHelloNeverUnlocksHealthAndPreservesValidRequestIDs() throws {
    var session = BrokerServiceSession(
      configuration: try BrokerServiceConfiguration(
        launcherVersion: "0.1.0",
        brokerVersion: "0.1.0",
        productionSigned: false,
        keychain: .unavailable
      )
    )
    let malformedHello = try NativeFrame(
      type: .hello,
      requestID: 30,
      payload: FieldTable(fields: []).encoded()
    ).encoded()

    let helloFailure = try decodeSingleFrame(session.exchange(malformedHello).response)
    let healthFailure = try decodeSingleFrame(
      session.exchange(try makeHealthFrame(requestID: 31)).response
    )

    #expect(helloFailure.requestID == 30)
    #expect(try SafeFailureCode.decode(helloFailure) == .protocolMismatch)
    #expect(healthFailure.requestID == 31)
    #expect(try SafeFailureCode.decode(healthFailure) == .protocolMismatch)
  }

  @Test
  func configurationRejectsInvalidVersions() {
    #expect(throws: BrokerServiceConfigurationError.invalidConfiguration) {
      _ = try BrokerServiceConfiguration(
        launcherVersion: "",
        brokerVersion: "0.1.0",
        productionSigned: false,
        keychain: .unavailable
      )
    }
    #expect(throws: BrokerServiceConfigurationError.invalidConfiguration) {
      _ = try BrokerServiceConfiguration(
        launcherVersion: "0.1.0",
        brokerVersion: "",
        productionSigned: false,
        keychain: .unavailable
      )
    }
  }

  @Test
  func exportedServiceSerializesOneSessionAndRepliesExactlyOnce() throws {
    let service = BrokerService(
      configuration: try BrokerServiceConfiguration(
        launcherVersion: "0.1.0",
        brokerVersion: "0.1.0",
        productionSigned: false,
        keychain: .unavailable
      )
    )
    let nonce = Data(repeating: 4, count: nativeNonceByteCount)
    let responses = LockedServiceReplyProbe()

    service.exchange(
      try HelloMessage(engineVersion: "0.1.0", nonce: nonce)
        .encodedFrame(requestID: 1)
    ) { responses.receive($0) }

    #expect(responses.count == 1)
    let result = try HelloResultMessage.decode(
      try decodeSingleFrame(try #require(responses.first))
    )
    #expect(result.echoedNonce == nonce)
  }

  @Test
  func healthOnlyServiceRejectsOpenAIOnboardingAndPreservesCallerSecret() throws {
    let service = BrokerService(
      configuration: try BrokerServiceConfiguration.healthOnlyForTesting(
        launcherVersion: "0.1.0",
        brokerVersion: "0.1.0",
        productionSigned: true,
        keychainStatus: { .available }
      )
    )
    let alias = Data("onboarding-secret-canary".utf8)
    let transferred = alias
    let beginReply = LockedServiceReplyProbe()

    service.beginOpenAIOnboarding(
      try BrokerOpenAIOnboardingRequest.begin(requestID: 1).encode(),
      secret: transferred,
      reply: beginReply.receive
    )

    #expect(alias == Data("onboarding-secret-canary".utf8))
    #expect(
      try BrokerOpenAIOnboardingReply.decode(try #require(beginReply.first))
        == .failure(requestID: 1, .operationUnavailable)
    )

    let controlReply = LockedServiceReplyProbe()
    service.openAIOnboardingControl(
      try BrokerOpenAIOnboardingRequest.verify(requestID: 2).encode(),
      reply: controlReply.receive
    )
    #expect(
      try BrokerOpenAIOnboardingReply.decode(try #require(controlReply.first))
        == .failure(requestID: 2, .operationUnavailable)
    )

    let reconciliationReply = LockedServiceReplyProbe()
    service.reconcileOpenAIActivation(
      try BrokerOpenAIActivationReconciliationRequest.reconcile(
        requestID: 3,
        connectionID: UUID(uuidString: "10000000-0000-4000-8000-000000000001")!
      ).encode(),
      reply: reconciliationReply.receive
    )
    #expect(
      try BrokerOpenAIActivationReconciliationReply.decode(
        try #require(reconciliationReply.first)
      ) == .failure(requestID: 3, .operationUnavailable)
    )
  }

  @Test
  func listenerDelegatePinsIdentityAndDataClassesBeforeActivation() throws {
    let configuration = try BrokerServiceConfiguration(
      launcherVersion: "0.1.0",
      brokerVersion: "0.1.0",
      productionSigned: true,
      keychain: .available
    )
    let requirement =
      "anchor apple generic and identifier \"com.recurs.cli.launcher\""
    let delegate = BrokerServiceListenerDelegate(
      exactPeerRequirement: requirement,
      configuration: configuration
    )
    let connection = RecordingBrokerConnection()

    delegate.configure(connection)

    #expect(
      connection.events
        == ["requirement", "interface", "object", "interruption", "invalidation", "activate"]
    )
    #expect(connection.requirement == requirement)
    #expect(connection.exportedObject is BrokerService)
    let interface = try #require(connection.exportedInterface)
    let selector = #selector(BrokerXPCProtocol.exchange(_:reply:))
    let requestClasses = interface.classes(
      for: selector,
      argumentIndex: 0,
      ofReply: false
    )
    let replyClasses = interface.classes(
      for: selector,
      argumentIndex: 0,
      ofReply: true
    )
    #expect(requestClasses.count == 1)
    #expect((requestClasses as NSSet).contains(NSData.self))
    #expect(replyClasses.count == 1)
    #expect((replyClasses as NSSet).contains(NSData.self))
  }

  @Test
  func serviceBoundariesAreSendableUnderSwiftSix() {
    assertSendable(BrokerServiceConfiguration.self)
    assertSendable(BrokerServiceSession.self)
    assertSendable(BrokerService.self)
    assertSendable(BrokerServiceListenerDelegate.self)
  }
}

private func decodeSingleFrame(_ bytes: Data) throws -> NativeFrame {
  var decoder = NativeFrameDecoder()
  let frames = try decoder.push(bytes)
  try decoder.finish()
  return try #require(frames.count == 1 ? frames[0] : nil)
}

private func assertSendable<T: Sendable>(_: T.Type) {}

private final class ScriptedKeychainStatusSource: @unchecked Sendable {
  private let lock = NSLock()
  private var statuses: [KeychainStatusCode]
  private var calls = 0

  init(_ statuses: [KeychainStatusCode]) {
    self.statuses = statuses
  }

  var callCount: Int {
    lock.withLock { calls }
  }

  func next() -> KeychainStatusCode {
    lock.withLock {
      calls += 1
      return statuses.isEmpty ? .unavailable : statuses.removeFirst()
    }
  }
}

private final class LockedServiceReplyProbe: @unchecked Sendable {
  private let lock = NSLock()
  private var values: [Data] = []

  var count: Int {
    lock.withLock { values.count }
  }

  var first: Data? {
    lock.withLock { values.first }
  }

  func receive(_ data: Data) {
    lock.withLock { values.append(data) }
  }
}

private final class RecordingBrokerConnection: BrokerServiceConnection {
  var events: [String] = []
  var requirement: String?

  var exportedInterface: NSXPCInterface? {
    didSet { events.append("interface") }
  }

  var exportedObject: Any? {
    didSet { events.append("object") }
  }

  var interruptionHandler: (() -> Void)? {
    didSet { events.append("interruption") }
  }

  var invalidationHandler: (() -> Void)? {
    didSet { events.append("invalidation") }
  }

  func setCodeSigningRequirement(_ requirement: String) {
    self.requirement = requirement
    events.append("requirement")
  }

  func activate() {
    events.append("activate")
  }
}
