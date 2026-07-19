import Dispatch
import Foundation
import RecursBrokerService
import RecursNativeProtocol

do {
  let runtime = try await BrokerServiceRuntime.production(
    launcherVersion: NativeComponentVersion.current,
    brokerVersion: NativeComponentVersion.current
  )
  runtime.activate()
  withExtendedLifetime(runtime) { dispatchMain() }
} catch {
  Foundation.exit(78)
}
