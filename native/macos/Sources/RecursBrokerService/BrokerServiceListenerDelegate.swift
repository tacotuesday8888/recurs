import Foundation
import RecursBrokerXPC

protocol BrokerServiceConnection: AnyObject {
  var exportedInterface: NSXPCInterface? { get set }
  var exportedObject: Any? { get set }

  func setCodeSigningRequirement(_ requirement: String)
  func activate()
}

extension NSXPCConnection: BrokerServiceConnection {}

package final class BrokerServiceListenerDelegate: NSObject, NSXPCListenerDelegate,
  @unchecked Sendable
{
  private let exactPeerRequirement: String
  private let configuration: BrokerServiceConfiguration

  package init(
    exactPeerRequirement: String,
    configuration: BrokerServiceConfiguration
  ) {
    self.exactPeerRequirement = exactPeerRequirement
    self.configuration = configuration
    super.init()
  }

  package func listener(
    _ listener: NSXPCListener,
    shouldAcceptNewConnection newConnection: NSXPCConnection
  ) -> Bool {
    configure(newConnection)
    return true
  }

  func configure(_ connection: any BrokerServiceConnection) {
    connection.setCodeSigningRequirement(exactPeerRequirement)

    let interface = NSXPCInterface(with: BrokerXPCProtocol.self)
    let selector = #selector(BrokerXPCProtocol.exchange(_:reply:))
    let dataClasses = NSSet(object: NSData.self) as! Set<AnyHashable>
    interface.setClasses(
      dataClasses,
      for: selector,
      argumentIndex: 0,
      ofReply: false
    )
    interface.setClasses(
      dataClasses,
      for: selector,
      argumentIndex: 0,
      ofReply: true
    )

    connection.exportedInterface = interface
    connection.exportedObject = BrokerService(configuration: configuration)
    connection.activate()
  }
}
