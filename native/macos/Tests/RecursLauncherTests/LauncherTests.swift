import Foundation
import RecursNativeProtocol
import RecursNativeSecurity
import ServiceManagement
import Testing

@testable import RecursLauncher

@Suite("Signed launcher boundary")
struct LauncherTests {
  @Test
  func connectionInstallsInterfaceAndRequirementBeforeActivation() async throws {
    let system = ScriptedBrokerConnection { _ in
      .failure(.brokerUnavailable)
    }
    let connection = BrokerConnection(
      validatedPeerRequirement: try brokerRequirement(),
      connectionFactory: ScriptedBrokerConnectionFactory(connection: system)
    )

    #expect(system.events == ["make", "interface", "requirement", "activate"])
    #expect(
      system.requirement
        == exactRequirement(identifier: "com.recurs.cli.broker")
    )

    await connection.close()
    #expect(system.invalidationCount == 1)
  }

  @Test
  func nonceHandshakeThenHealthUsesIncreasingCorrelatedRequests() async throws {
    let system = ScriptedBrokerConnection { encoded in
      do {
        let frame = try decodeSingleFrame(encoded)
        switch frame.type {
        case .hello:
          let hello = try HelloMessage.decode(frame)
          return .success(
            try HelloResultMessage(
              launcherVersion: "0.1.0",
              brokerVersion: "0.1.0",
              echoedNonce: hello.nonce,
              productionSigned: true,
              persistentCredentials: true,
              minimumMacosVersion: "14.4"
            ).encodedFrame(requestID: frame.requestID)
          )
        case .health:
          return .success(
            try HealthResultMessage(
              keychain: .available,
              peerVerified: true
            ).encodedFrame(requestID: frame.requestID)
          )
        default:
          return .failure(.brokerUnavailable)
        }
      } catch {
        return .failure(.brokerUnavailable)
      }
    }
    let connection = BrokerConnection(
      validatedPeerRequirement: try brokerRequirement(),
      connectionFactory: ScriptedBrokerConnectionFactory(connection: system)
    )
    let nonce = Data((0..<nativeNonceByteCount).map(UInt8.init))

    let hello = try await connection.handshake(
      engineVersion: "0.1.0",
      nonce: nonce
    )
    let health = try await connection.health()
    await connection.close()

    #expect(hello.echoedNonce == nonce)
    #expect(health.keychain == .available)
    #expect(health.peerVerified)
    #expect(system.requestIDs == [1, 2])
    #expect(system.invalidationCount == 1)
  }

  @Test
  func nonceMismatchFailsClosedAndCannotBeRetried() async throws {
    let system = ScriptedBrokerConnection { encoded in
      do {
        let frame = try decodeSingleFrame(encoded)
        return .success(
          try HelloResultMessage(
            launcherVersion: "0.1.0",
            brokerVersion: "0.1.0",
            echoedNonce: Data(repeating: 0xff, count: nativeNonceByteCount),
            productionSigned: true,
            persistentCredentials: true,
            minimumMacosVersion: "14.4"
          ).encodedFrame(requestID: frame.requestID)
        )
      } catch {
        return .failure(.brokerUnavailable)
      }
    }
    let connection = BrokerConnection(
      validatedPeerRequirement: try brokerRequirement(),
      connectionFactory: ScriptedBrokerConnectionFactory(connection: system)
    )

    await #expect(throws: BrokerConnectionError.protocolMismatch) {
      _ = try await connection.handshake(
        engineVersion: "0.1.0",
        nonce: Data(repeating: 7, count: nativeNonceByteCount)
      )
    }
    await #expect(throws: BrokerConnectionError.closed) {
      _ = try await connection.health()
    }

    #expect(system.invalidationCount == 1)
    #expect(system.requestIDs == [1])
  }

  @Test
  func componentVersionMismatchFailsClosed() async throws {
    let expectedVersion = "0.1.0"
    let mismatchedVersions = [
      (launcher: "0.2.0", broker: expectedVersion),
      (launcher: expectedVersion, broker: "0.2.0"),
    ]

    for versions in mismatchedVersions {
      let system = ScriptedBrokerConnection { encoded in
        do {
          let frame = try decodeSingleFrame(encoded)
          let hello = try HelloMessage.decode(frame)
          return .success(
            try HelloResultMessage(
              launcherVersion: versions.launcher,
              brokerVersion: versions.broker,
              echoedNonce: hello.nonce,
              productionSigned: true,
              persistentCredentials: true,
              minimumMacosVersion: "14.4"
            ).encodedFrame(requestID: frame.requestID)
          )
        } catch {
          return .failure(.brokerUnavailable)
        }
      }
      let connection = BrokerConnection(
        validatedPeerRequirement: try brokerRequirement(),
        connectionFactory: ScriptedBrokerConnectionFactory(connection: system)
      )

      await #expect(throws: BrokerConnectionError.protocolMismatch) {
        _ = try await connection.handshake(
          engineVersion: expectedVersion,
          nonce: Data(repeating: 8, count: nativeNonceByteCount)
        )
      }
      await #expect(throws: BrokerConnectionError.closed) {
        _ = try await connection.health()
      }
      #expect(system.invalidationCount == 1)
    }
  }

  @Test
  func fixedSafeFailuresAreMappedWithoutNativeText() async throws {
    let system = ScriptedBrokerConnection { encoded in
      do {
        let frame = try decodeSingleFrame(encoded)
        return .success(
          try SafeFailureCode.keychainUnavailable.encodedFrame(
            requestID: frame.requestID
          )
        )
      } catch {
        return .failure(.brokerUnavailable)
      }
    }
    let connection = BrokerConnection(
      validatedPeerRequirement: try brokerRequirement(),
      connectionFactory: ScriptedBrokerConnectionFactory(connection: system)
    )

    await #expect(throws: BrokerConnectionError.keychainUnavailable) {
      _ = try await connection.handshake(
        engineVersion: "0.1.0",
        nonce: Data(repeating: 9, count: nativeNonceByteCount)
      )
    }
    #expect(system.invalidationCount == 1)
  }

  @Test
  func registrationMapsFixedStatusAndErrors() throws {
    let service = ScriptedRegistrationService(status: .notRegistered)
    let registration = ServiceRegistration(authorizedService: service)

    #expect(registration.status() == .notRegistered)
    try registration.register()
    #expect(service.registerCount == 1)

    service.setStatus(.enabled)
    try registration.register()
    #expect(service.registerCount == 1)
    #expect(service.unregisterCount == 0)

    try registration.refresh()
    #expect(service.registerCount == 2)
    #expect(service.unregisterCount == 1)

    service.setStatus(.requiresApproval)
    #expect(throws: ServiceRegistrationError.approvalRequired) {
      try registration.register()
    }

    service.setStatus(.enabled)
    try registration.unregister()
    #expect(service.unregisterCount == 2)
  }

  private func brokerRequirement() throws -> PeerRequirement {
    try PeerRequirement.fromValidatedSignedMetadata(
      for: .broker,
      metadata: [
        "RecursTeamIdentifier": "ABCDE12345",
        "RecursLauncherIdentifier": "com.recurs.cli.launcher",
        "RecursBrokerIdentifier": "com.recurs.cli.broker",
        "RecursProductionSigned": true,
      ]
    )
  }

  private func exactRequirement(identifier: String) -> String {
    "anchor apple generic and identifier \"\(identifier)\" "
      + "and certificate 1[field.1.2.840.113635.100.6.2.6] exists "
      + "and certificate leaf[field.1.2.840.113635.100.6.1.13] exists "
      + "and certificate leaf[subject.OU] = \"ABCDE12345\""
  }
}

private struct ScriptedBrokerConnectionFactory: BrokerXPCConnectionFactory {
  let connection: ScriptedBrokerConnection

  func makeConnection() -> any BrokerXPCConnectionHandling {
    connection.record("make")
    return connection
  }
}

private final class ScriptedBrokerConnection: BrokerXPCConnectionHandling,
  @unchecked Sendable
{
  typealias Handler = @Sendable (Data) -> Result<Data, BrokerXPCExchangeError>

  private let handler: Handler
  private let lock = NSLock()
  private var eventStorage: [String] = []
  private var requirementStorage: String?
  private var requestIDStorage: [UInt32] = []
  private var invalidationStorage = 0

  init(handler: @escaping Handler) {
    self.handler = handler
  }

  var events: [String] {
    withLock { eventStorage }
  }

  var requirement: String? {
    withLock { requirementStorage }
  }

  var requestIDs: [UInt32] {
    withLock { requestIDStorage }
  }

  var invalidationCount: Int {
    withLock { invalidationStorage }
  }

  func installRemoteInterface() {
    record("interface")
  }

  func setCodeSigningRequirement(_ requirement: String) {
    withLock {
      requirementStorage = requirement
      eventStorage.append("requirement")
    }
  }

  func activate() {
    record("activate")
  }

  func exchange(
    _ frame: Data,
    reply: @escaping @Sendable (Result<Data, BrokerXPCExchangeError>) -> Void
  ) {
    if let requestID = try? decodeSingleFrame(frame).requestID {
      withLock { requestIDStorage.append(requestID) }
    }
    reply(handler(frame))
  }

  func invalidate() {
    withLock { invalidationStorage += 1 }
  }

  func record(_ event: String) {
    withLock { eventStorage.append(event) }
  }

  private func withLock<Value>(_ body: () -> Value) -> Value {
    lock.lock()
    defer { lock.unlock() }
    return body()
  }
}

private final class ScriptedRegistrationService:
  BrokerServiceRegistrationHandling, @unchecked Sendable
{
  private let lock = NSLock()
  private var statusStorage: SMAppService.Status
  private var registerCountStorage = 0
  private var unregisterCountStorage = 0

  init(status: SMAppService.Status) {
    self.statusStorage = status
  }

  var status: SMAppService.Status {
    withLock { statusStorage }
  }

  var registerCount: Int {
    withLock { registerCountStorage }
  }

  var unregisterCount: Int {
    withLock { unregisterCountStorage }
  }

  func setStatus(_ status: SMAppService.Status) {
    withLock { statusStorage = status }
  }

  func register() throws {
    withLock { registerCountStorage += 1 }
  }

  func unregister() throws {
    withLock { unregisterCountStorage += 1 }
  }

  private func withLock<Value>(_ body: () -> Value) -> Value {
    lock.lock()
    defer { lock.unlock() }
    return body()
  }
}

private func decodeSingleFrame(_ data: Data) throws -> NativeFrame {
  var decoder = NativeFrameDecoder()
  let frames = try decoder.push(data)
  try decoder.finish()
  guard frames.count == 1, let frame = frames.first else {
    throw NativeProtocolError.invalidFrame
  }
  return frame
}
