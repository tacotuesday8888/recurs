import Foundation

@objc(RecursBrokerXPCProtocol)
public protocol BrokerXPCProtocol: NSObjectProtocol {
  func exchange(_ frame: Data, reply: @escaping (Data) -> Void)
}
