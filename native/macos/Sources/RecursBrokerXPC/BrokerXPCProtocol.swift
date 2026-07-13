import Foundation

@objc(RecursBrokerXPCProtocol)
public protocol BrokerXPCProtocol: NSObjectProtocol {
  func exchange(_ frame: Data, reply: @escaping @Sendable (Data) -> Void)
}
