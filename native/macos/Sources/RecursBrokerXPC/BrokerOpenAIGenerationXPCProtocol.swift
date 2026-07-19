import Foundation

@objc(RecursBrokerOpenAIGenerationXPCProtocol)
public protocol BrokerOpenAIGenerationXPCProtocol: BrokerOpenAIOnboardingXPCProtocol {
  func beginOpenAIGeneration(
    _ request: Data,
    reply: @escaping @Sendable (Data) -> Void
  )

  func pollOpenAIGeneration(
    _ operation: Data,
    reply: @escaping @Sendable (Data) -> Void
  )

  func cancelOpenAIGeneration(
    _ operation: Data,
    reply: @escaping @Sendable (Data) -> Void
  )
}
