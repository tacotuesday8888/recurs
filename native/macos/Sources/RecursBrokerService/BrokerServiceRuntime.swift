import Foundation
import RecursNativeProtocol
import RecursNativeSecurity

protocol BrokerServiceListenerHandle: AnyObject {
  var delegate: NSXPCListenerDelegate? { get set }

  func setConnectionCodeSigningRequirement(_ requirement: String)
  func activate()
}

extension NSXPCListener: BrokerServiceListenerHandle {}

struct BrokerServiceRuntimeDependencies<KeychainConfiguration: Sendable> {
  let makePeerRequirement: () throws -> String
  let makeKeychainConfiguration: () throws -> KeychainConfiguration
  let recoverAuthority: (KeychainConfiguration) async throws -> BrokerCredentialAuthority
  let makeKeychainStatusSource: (KeychainConfiguration) -> @Sendable () -> KeychainStatusCode
  let makeListener: (String) -> any BrokerServiceListenerHandle
}

package final class BrokerServiceRuntime {
  private static let machServiceName = "com.recurs.cli.broker"

  private let listener: any BrokerServiceListenerHandle
  private let delegate: BrokerServiceListenerDelegate
  private let activationLock = NSLock()
  private var isActivated = false

  private init(
    listener: any BrokerServiceListenerHandle,
    delegate: BrokerServiceListenerDelegate
  ) {
    self.listener = listener
    self.delegate = delegate
  }

  package static func production(
    launcherVersion: String,
    brokerVersion: String
  ) async throws -> BrokerServiceRuntime {
    let dependencies = BrokerServiceRuntimeDependencies(
      makePeerRequirement: {
        try PeerRequirement.production(
          for: .launcher,
          authenticatedAs: .broker
        ).requirementString
      },
      makeKeychainConfiguration: {
        try KeychainStoreConfiguration.production()
      },
      recoverAuthority: { configuration in
        try await BrokerCredentialAuthority.production(configuration: configuration)
      },
      makeKeychainStatusSource: { configuration in
        let probe = DataProtectionKeychainAvailabilityProbe(configuration: configuration)
        return {
          protocolStatus(for: probe.status())
        }
      },
      makeListener: { name in
        NSXPCListener(machServiceName: name)
      }
    )
    return try await build(
      launcherVersion: launcherVersion,
      brokerVersion: brokerVersion,
      dependencies: dependencies
    )
  }

  static func forTesting<KeychainConfiguration: Sendable>(
    launcherVersion: String,
    brokerVersion: String,
    dependencies: BrokerServiceRuntimeDependencies<KeychainConfiguration>
  ) async throws -> BrokerServiceRuntime {
    try await build(
      launcherVersion: launcherVersion,
      brokerVersion: brokerVersion,
      dependencies: dependencies
    )
  }

  package func activate() {
    let shouldActivate = activationLock.withLock {
      guard !isActivated else { return false }
      isActivated = true
      return true
    }
    guard shouldActivate else { return }
    listener.activate()
  }

  private static func build<KeychainConfiguration: Sendable>(
    launcherVersion: String,
    brokerVersion: String,
    dependencies: BrokerServiceRuntimeDependencies<KeychainConfiguration>
  ) async throws -> BrokerServiceRuntime {
    let peerRequirement = try dependencies.makePeerRequirement()
    let keychainConfiguration = try dependencies.makeKeychainConfiguration()
    let authority = try await dependencies.recoverAuthority(keychainConfiguration)
    let keychainStatus = dependencies.makeKeychainStatusSource(keychainConfiguration)
    let configuration = try BrokerServiceConfiguration.recoveredCredentialService(
      launcherVersion: launcherVersion,
      brokerVersion: brokerVersion,
      authority: authority,
      keychainStatus: keychainStatus
    )
    let delegate = BrokerServiceListenerDelegate(
      exactPeerRequirement: peerRequirement,
      configuration: configuration
    )
    let listener = dependencies.makeListener(machServiceName)
    listener.setConnectionCodeSigningRequirement(peerRequirement)
    listener.delegate = delegate
    return BrokerServiceRuntime(listener: listener, delegate: delegate)
  }
}

private func protocolStatus(
  for status: KeychainAvailabilityStatus
) -> KeychainStatusCode {
  switch status {
  case .available:
    .available
  case .locked:
    .locked
  case .unavailable:
    .unavailable
  }
}
