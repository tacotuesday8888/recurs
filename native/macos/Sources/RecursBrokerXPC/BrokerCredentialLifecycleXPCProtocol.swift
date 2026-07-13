import Foundation

@objc(RecursBrokerCredentialLifecycleXPCProtocol)
public protocol BrokerCredentialLifecycleXPCProtocol: BrokerXPCProtocol {
  func stageCredential(
    _ metadata: Data,
    secret: Data,
    reply: @escaping @Sendable (Data) -> Void
  )

  func credentialControl(
    _ request: Data,
    reply: @escaping @Sendable (Data) -> Void
  )
}
