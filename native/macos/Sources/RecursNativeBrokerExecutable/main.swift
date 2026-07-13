import Dispatch
import Foundation
import RecursBrokerService
import RecursNativeProtocol
import RecursNativeSecurity

private let brokerMachServiceName = "com.recurs.cli.broker"
private let nativeComponentVersion = "0.1.0"

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

do {
  let launcherRequirement = try PeerRequirement.production(
    for: .launcher,
    authenticatedAs: .broker
  )
  let keychainConfiguration = try KeychainStoreConfiguration.production()
  let keychainProbe = DataProtectionKeychainAvailabilityProbe(
    configuration: keychainConfiguration
  )
  let initialKeychainStatus = protocolStatus(for: keychainProbe.status())
  let configuration = try BrokerServiceConfiguration(
    launcherVersion: nativeComponentVersion,
    brokerVersion: nativeComponentVersion,
    productionSigned: true,
    persistentCredentials: true,
    initialKeychain: initialKeychainStatus,
    keychainStatus: {
      protocolStatus(for: keychainProbe.status())
    }
  )
  let delegate = BrokerServiceListenerDelegate(
    exactPeerRequirement: launcherRequirement.requirementString,
    configuration: configuration
  )
  let listener = NSXPCListener(machServiceName: brokerMachServiceName)
  listener.setConnectionCodeSigningRequirement(
    launcherRequirement.requirementString
  )
  listener.delegate = delegate
  listener.activate()
  withExtendedLifetime((listener, delegate)) {
    dispatchMain()
  }
} catch {
  Foundation.exit(78)
}
