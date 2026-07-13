import Foundation
import RecursNativeSecurity
import ServiceManagement

package enum BrokerRegistrationStatus: Sendable, Equatable {
  case notRegistered
  case enabled
  case requiresApproval
  case notFound
  case unavailable
}

package enum ServiceRegistrationError: Error, Sendable, Equatable {
  case productionSigningRequired
  case approvalRequired
  case serviceNotFound
  case registrationFailed
  case unregistrationFailed
}

package protocol BrokerServiceRegistrationHandling: AnyObject, Sendable {
  var status: SMAppService.Status { get }
  func register() throws
  func unregister() throws
}

package struct ServiceRegistration: Sendable {
  private let service: any BrokerServiceRegistrationHandling

  package static func production() throws(ServiceRegistrationError)
    -> ServiceRegistration
  {
    do {
      _ = try PeerRequirement.production(
        for: .broker,
        authenticatedAs: .launcher
      )
    } catch {
      throw .productionSigningRequired
    }
    return ServiceRegistration(
      authorizedService: SystemBrokerServiceRegistration()
    )
  }

  package init(
    authorizedService service: any BrokerServiceRegistrationHandling
  ) {
    self.service = service
  }

  package func status() -> BrokerRegistrationStatus {
    switch service.status {
    case .notRegistered:
      .notRegistered
    case .enabled:
      .enabled
    case .requiresApproval:
      .requiresApproval
    case .notFound:
      .notFound
    @unknown default:
      .unavailable
    }
  }

  package func register() throws(ServiceRegistrationError) {
    switch status() {
    case .requiresApproval:
      throw .approvalRequired
    case .notFound, .unavailable:
      throw .serviceNotFound
    case .enabled:
      return
    case .notRegistered:
      do {
        try service.register()
      } catch {
        throw .registrationFailed
      }
    }
  }

  package func refresh() throws(ServiceRegistrationError) {
    switch status() {
    case .requiresApproval:
      throw .approvalRequired
    case .notFound, .unavailable:
      throw .serviceNotFound
    case .enabled:
      do {
        try service.unregister()
      } catch {
        throw .unregistrationFailed
      }
      do {
        try service.register()
      } catch {
        throw .registrationFailed
      }
    case .notRegistered:
      do {
        try service.register()
      } catch {
        throw .registrationFailed
      }
    }
  }

  package func unregister() throws(ServiceRegistrationError) {
    switch status() {
    case .notRegistered:
      return
    case .notFound, .unavailable:
      throw .serviceNotFound
    case .enabled, .requiresApproval:
      do {
        try service.unregister()
      } catch {
        throw .unregistrationFailed
      }
    }
  }
}

private final class SystemBrokerServiceRegistration:
  BrokerServiceRegistrationHandling, @unchecked Sendable
{
  private static let launchAgentPlistName = "com.recurs.cli.broker.plist"

  private let service = SMAppService.agent(plistName: launchAgentPlistName)

  var status: SMAppService.Status {
    service.status
  }

  func register() throws {
    try service.register()
  }

  func unregister() throws {
    try service.unregister()
  }
}
