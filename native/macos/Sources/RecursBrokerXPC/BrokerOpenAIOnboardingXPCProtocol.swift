import Foundation

@objc(RecursBrokerOpenAIOnboardingXPCProtocol)
public protocol BrokerOpenAIOnboardingXPCProtocol:
  BrokerCredentialLifecycleXPCProtocol
{
  func beginOpenAIOnboarding(
    _ request: Data,
    secret: Data,
    reply: @escaping @Sendable (Data) -> Void
  )

  func openAIOnboardingControl(
    _ request: Data,
    reply: @escaping @Sendable (Data) -> Void
  )
}
