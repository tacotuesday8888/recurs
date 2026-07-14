import Foundation
import RecursBrokerXPC

protocol BrokerServiceConnection: AnyObject {
  var exportedInterface: NSXPCInterface? { get set }
  var exportedObject: Any? { get set }
  var interruptionHandler: (() -> Void)? { get set }
  var invalidationHandler: (() -> Void)? { get set }

  func setCodeSigningRequirement(_ requirement: String)
  func activate()
}

extension NSXPCConnection: BrokerServiceConnection {}

final class BrokerServiceListenerDelegate: NSObject, NSXPCListenerDelegate,
  @unchecked Sendable
{
  private let exactPeerRequirement: String
  private let configuration: BrokerServiceConfiguration

  init(
    exactPeerRequirement: String,
    configuration: BrokerServiceConfiguration
  ) {
    self.exactPeerRequirement = exactPeerRequirement
    self.configuration = configuration
    super.init()
  }

  func listener(
    _ listener: NSXPCListener,
    shouldAcceptNewConnection newConnection: NSXPCConnection
  ) -> Bool {
    configure(newConnection)
    return true
  }

  func configure(_ connection: any BrokerServiceConnection) {
    connection.setCodeSigningRequirement(exactPeerRequirement)

    let interface: NSXPCInterface
    if configuration.exportsOpenAIGeneration {
      interface = NSXPCInterface(with: BrokerOpenAIGenerationXPCProtocol.self)
    } else if configuration.exportsOpenAIOnboarding {
      interface = NSXPCInterface(with: BrokerOpenAIOnboardingXPCProtocol.self)
    } else if configuration.exportsCredentialLifecycle {
      interface = NSXPCInterface(with: BrokerCredentialLifecycleXPCProtocol.self)
    } else {
      interface = NSXPCInterface(with: BrokerXPCProtocol.self)
    }
    let dataClasses = NSSet(object: NSData.self) as! Set<AnyHashable>
    let registrations = Self.dataClassRegistrations(
      includesCredentialLifecycle: configuration.exportsCredentialLifecycle,
      includesOpenAIOnboarding: configuration.exportsOpenAIOnboarding,
      includesOpenAIGeneration: configuration.exportsOpenAIGeneration
    )
    for registration in registrations {
      interface.setClasses(
        dataClasses,
        for: registration.selector,
        argumentIndex: registration.argumentIndex,
        ofReply: registration.ofReply
      )
    }

    let service = BrokerService(configuration: configuration)
    connection.exportedInterface = interface
    connection.exportedObject = service
    connection.interruptionHandler = { service.close() }
    connection.invalidationHandler = { service.transportTeardown() }
    connection.activate()
  }

  private static func dataClassRegistrations(
    includesCredentialLifecycle: Bool,
    includesOpenAIOnboarding: Bool,
    includesOpenAIGeneration: Bool
  ) -> [(selector: Selector, argumentIndex: Int, ofReply: Bool)] {
    var registrations: [(selector: Selector, argumentIndex: Int, ofReply: Bool)] = [
      (#selector(BrokerXPCProtocol.exchange(_:reply:)), 0, false),
      (#selector(BrokerXPCProtocol.exchange(_:reply:)), 0, true),
    ]
    guard includesCredentialLifecycle else { return registrations }
    let lifecycleRegistrations: [(selector: Selector, argumentIndex: Int, ofReply: Bool)] = [
      (
        #selector(BrokerCredentialLifecycleXPCProtocol.stageCredential(_:secret:reply:)),
        0,
        false
      ),
      (
        #selector(BrokerCredentialLifecycleXPCProtocol.stageCredential(_:secret:reply:)),
        1,
        false
      ),
      (
        #selector(BrokerCredentialLifecycleXPCProtocol.stageCredential(_:secret:reply:)),
        0,
        true
      ),
      (
        #selector(BrokerCredentialLifecycleXPCProtocol.credentialControl(_:reply:)),
        0,
        false
      ),
      (
        #selector(BrokerCredentialLifecycleXPCProtocol.credentialControl(_:reply:)),
        0,
        true
      ),
    ]
    registrations.append(contentsOf: lifecycleRegistrations)
    guard includesOpenAIOnboarding else { return registrations }
    let onboardingRegistrations:
      [(
        selector: Selector,
        argumentIndex: Int,
        ofReply: Bool
      )] = [
        (
          #selector(
            BrokerOpenAIOnboardingXPCProtocol.beginOpenAIOnboarding(_:secret:reply:)
          ),
          0,
          false
        ),
        (
          #selector(
            BrokerOpenAIOnboardingXPCProtocol.beginOpenAIOnboarding(_:secret:reply:)
          ),
          1,
          false
        ),
        (
          #selector(
            BrokerOpenAIOnboardingXPCProtocol.beginOpenAIOnboarding(_:secret:reply:)
          ),
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
    registrations.append(contentsOf: onboardingRegistrations)
    guard includesOpenAIGeneration else { return registrations }
    for selector in [
      #selector(BrokerOpenAIGenerationXPCProtocol.beginOpenAIGeneration(_:reply:)),
      #selector(BrokerOpenAIGenerationXPCProtocol.pollOpenAIGeneration(_:reply:)),
      #selector(BrokerOpenAIGenerationXPCProtocol.cancelOpenAIGeneration(_:reply:)),
    ] {
      registrations.append((selector, 0, false))
      registrations.append((selector, 0, true))
    }
    return registrations
  }
}
