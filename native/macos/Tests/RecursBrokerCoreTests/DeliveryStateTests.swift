import Testing

@testable import RecursBrokerCore

@Suite("Provider delivery state")
struct DeliveryStateTests {
  @Test
  func exactSuccessfulSequenceAdvancesOnce() throws {
    var state = DeliveryState.notSent
    #expect(state.isRetrySafe)

    try state.transition(to: .requestStarted)
    #expect(state == .requestStarted)
    #expect(!state.isRetrySafe)

    try state.transition(to: .responseStarted)
    #expect(state == .responseStarted)
    try state.transition(to: .terminal(.succeeded))
    #expect(state == .terminal(.succeeded))
  }

  @Test
  func failureAndCancellationCanTerminateAtTheirObservedBoundary() throws {
    for (initial, terminal) in [
      (DeliveryState.notSent, DeliveryTerminal.cancelled),
      (.requestStarted, .failed),
      (.responseStarted, .cancelled),
    ] {
      var state = initial
      try state.transition(to: .terminal(terminal))
      #expect(state == .terminal(terminal))
      #expect(!state.isRetrySafe)
    }
  }

  @Test
  func duplicatesSkipsAndReverseTransitionsFailClosed() throws {
    let invalid: [(DeliveryState, DeliveryState)] = [
      (.notSent, .notSent),
      (.notSent, .responseStarted),
      (.notSent, .terminal(.succeeded)),
      (.requestStarted, .requestStarted),
      (.requestStarted, .notSent),
      (.requestStarted, .terminal(.succeeded)),
      (.responseStarted, .responseStarted),
      (.responseStarted, .requestStarted),
      (.terminal(.succeeded), .terminal(.failed)),
      (.terminal(.failed), .requestStarted),
    ]

    for (initial, target) in invalid {
      var state = initial
      #expect(throws: DeliveryStateError.invalidTransition) {
        try state.transition(to: target)
      }
      #expect(state == initial)
    }
  }
}
