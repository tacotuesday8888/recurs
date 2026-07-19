import Foundation

package enum DeliveryTerminal: String, Sendable, Hashable {
  case succeeded
  case failed
  case cancelled
}

package enum DeliveryState: Sendable, Hashable {
  case notSent
  case requestStarted
  case responseStarted
  case terminal(DeliveryTerminal)

  package var isRetrySafe: Bool {
    self == .notSent
  }

  package mutating func transition(
    to next: DeliveryState
  ) throws(DeliveryStateError) {
    switch (self, next) {
    case (.notSent, .requestStarted),
      (.requestStarted, .responseStarted),
      (.notSent, .terminal(.failed)),
      (.notSent, .terminal(.cancelled)),
      (.requestStarted, .terminal(.failed)),
      (.requestStarted, .terminal(.cancelled)),
      (.responseStarted, .terminal):
      self = next
    default:
      throw .invalidTransition
    }
  }
}

package enum DeliveryStateError:
  Error,
  Sendable,
  Equatable,
  CustomStringConvertible,
  CustomDebugStringConvertible,
  LocalizedError
{
  case invalidTransition

  private var fixedDescription: String {
    "The provider delivery transition is invalid."
  }

  package var description: String { fixedDescription }
  package var debugDescription: String { fixedDescription }
  package var errorDescription: String? { fixedDescription }
}
