import Darwin
import Foundation
import RecursLauncher
import RecursNativeProtocol
import Security

private struct MachineEnvelope: Encodable {
  let version = 1
  let nativeAuthority: MachineAuthorityStatus
}

private enum MachineAuthorityStatus: Encodable {
  case ready(attestation: MachineAttestation, health: MachineHealth)
  case unavailable(reason: String)

  private enum CodingKeys: String, CodingKey {
    case state
    case attestation
    case health
    case reason
  }

  func encode(to encoder: any Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case .ready(let attestation, let health):
      try container.encode("ready", forKey: .state)
      try container.encode(attestation, forKey: .attestation)
      try container.encode(health, forKey: .health)
    case .unavailable(let reason):
      try container.encode("unavailable", forKey: .state)
      try container.encode(reason, forKey: .reason)
    }
  }
}

private struct MachineAttestation: Encodable {
  let protocolVersion = nativeAuthorityProtocolVersion
  let launcherVersion: String
  let brokerVersion: String
  let platform = "darwin"
  let minimumMacosVersion: String
  let productionSigned: Bool
  let persistentCredentials: Bool
}

private struct MachineHealth: Encodable {
  let keychain: String
  let broker = "available"
  let peerIdentity = "verified"
}

private func brokerConnectionError(
  for error: ServiceRegistrationError
) -> BrokerConnectionError {
  switch error {
  case .productionSigningRequired:
    .productionSigningRequired
  case .approvalRequired, .serviceNotFound, .registrationFailed,
    .unregistrationFailed:
    .launcherUnavailable
  }
}

private func unavailableReason(
  for error: ServiceRegistrationError
) -> String {
  switch error {
  case .productionSigningRequired:
    "production_signing_required"
  case .approvalRequired, .serviceNotFound, .registrationFailed,
    .unregistrationFailed:
    "launcher_unavailable"
  }
}

private func unavailableReason(for error: BrokerConnectionError) -> String {
  switch error {
  case .unsupportedPlatform:
    "unsupported_platform"
  case .unsupportedOSVersion:
    "unsupported_os_version"
  case .launcherUnavailable:
    "launcher_unavailable"
  case .brokerUnavailable, .closed:
    "broker_unavailable"
  case .protocolMismatch:
    "protocol_mismatch"
  case .peerIdentityUnverified:
    "peer_identity_unverified"
  case .productionSigningRequired:
    "production_signing_required"
  case .keychainUnavailable:
    "keychain_unavailable"
  case .unsupportedOperation:
    "unsupported_operation"
  }
}

private func secureNonce() throws -> Data {
  var bytes = [UInt8](repeating: 0, count: nativeNonceByteCount)
  guard
    SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess
  else {
    throw BrokerConnectionError.launcherUnavailable
  }
  return Data(bytes)
}

private func enabledServiceRegistration() throws(ServiceRegistrationError)
  -> ServiceRegistration
{
  let registration = try ServiceRegistration.production()
  switch registration.status() {
  case .enabled:
    return registration
  case .notRegistered:
    try registration.register()
    guard registration.status() == .enabled else {
      throw .registrationFailed
    }
    return registration
  case .requiresApproval:
    throw .approvalRequired
  case .notFound, .unavailable:
    throw .serviceNotFound
  }
}

private func openRegisteredBrokerConnection() throws(BrokerConnectionError)
  -> BrokerConnection
{
  do {
    _ = try enabledServiceRegistration()
  } catch {
    throw brokerConnectionError(for: error)
  }

  return try BrokerConnection.open()
}

private func brokerHealth() async throws -> MachineAuthorityStatus {
  let connection = try BrokerConnection.open()
  let hello = try await connection.handshake(
    engineVersion: NativeComponentVersion.current,
    nonce: try secureNonce()
  )
  let health = try await connection.health()
  await connection.close()
  let keychain =
    switch health.keychain {
    case .available: "available"
    case .locked: "locked"
    case .unavailable: "unavailable"
    }
  return .ready(
    attestation: MachineAttestation(
      launcherVersion: hello.launcherVersion,
      brokerVersion: hello.brokerVersion,
      minimumMacosVersion: hello.minimumMacosVersion,
      productionSigned: hello.productionSigned,
      persistentCredentials: hello.persistentCredentials
    ),
    health: MachineHealth(keychain: keychain)
  )
}

private func nativeHealth() async -> MachineAuthorityStatus {
  do {
    let registration = try enabledServiceRegistration()
    do {
      return try await brokerHealth()
    } catch let error as BrokerConnectionError
      where error == .protocolMismatch || error == .brokerUnavailable
    {
      try registration.refresh()
      guard registration.status() == .enabled else {
        return .unavailable(reason: "launcher_unavailable")
      }
      return try await brokerHealth()
    }
  } catch let error as ServiceRegistrationError {
    return .unavailable(reason: unavailableReason(for: error))
  } catch let error as BrokerConnectionError {
    return .unavailable(reason: unavailableReason(for: error))
  } catch {
    return .unavailable(reason: "launcher_unavailable")
  }
}

private func writeMachineStatus(_ status: MachineAuthorityStatus) {
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
  let fallback =
    #"{"nativeAuthority":{"reason":"launcher_unavailable","state":"unavailable"},"version":1}"#
  let output: Data
  do {
    output =
      try encoder.encode(
        MachineEnvelope(nativeAuthority: status)
      ) + Data([0x0a])
  } catch {
    output = Data(fallback.utf8) + Data([0x0a])
  }
  FileHandle.standardOutput.write(output)
}

private enum EngineRunEvent: Sendable {
  case bridgeClosed
  case childFinished(EngineTermination)
  case childFailed
}

private func runBundledEngine(arguments: [String]) async -> EngineTermination? {
  let signalCoordinator = LauncherProcessSignalCoordinator()
  do {
    let layout = try EngineBundleLayout.production()
    let child = try await EngineChildProcess.start(
      layout: layout,
      arguments: arguments
    )
    signalCoordinator.attach(child: child)
    let session = LauncherNodeSession(
      brokerConnectionFactory: { () throws(BrokerConnectionError) -> BrokerConnection in
        try openRegisteredBrokerConnection()
      },
      output: child.socket
    )

    let termination = await withTaskGroup(
      of: EngineRunEvent.self,
      returning: EngineTermination?.self
    ) { group in
      group.addTask {
        await serve(session: session, socket: child.socket)
        return .bridgeClosed
      }
      group.addTask {
        do {
          return .childFinished(try await child.wait())
        } catch {
          return .childFailed
        }
      }

      guard let first = await group.next() else {
        return nil
      }

      switch first {
      case .bridgeClosed:
        guard let childEvent = await group.next() else {
          return nil
        }
        switch childEvent {
        case .childFinished(let result):
          return result
        case .childFailed:
          return try? await child.shutdown()
        case .bridgeClosed:
          return nil
        }
      case .childFinished(let result):
        group.cancelAll()
        return result
      case .childFailed:
        group.cancelAll()
        return try? await child.shutdown()
      }
    }

    await session.close()
    await child.socket.close()
    await signalCoordinator.close()
    return termination
  } catch {
    await signalCoordinator.close()
    return nil
  }
}

private func exitMirroring(_ termination: EngineTermination?) -> Never {
  guard let termination else {
    Foundation.exit(78)
  }

  switch termination {
  case .exited(let status):
    Foundation.exit(status)
  case .signaled(let signalNumber):
    _ = Darwin.signal(signalNumber, SIG_DFL)
    _ = Darwin.raise(signalNumber)
    Foundation.exit(128 + signalNumber)
  }
}

let arguments = Array(CommandLine.arguments.dropFirst())
if arguments == ["native-health", "--machine"] {
  writeMachineStatus(await nativeHealth())
} else {
  exitMirroring(await runBundledEngine(arguments: arguments))
}
