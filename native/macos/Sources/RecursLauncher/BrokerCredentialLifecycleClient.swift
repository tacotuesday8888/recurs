import Foundation
import RecursBrokerXPC

package enum BrokerCredentialLifecycleClientError: Error, Equatable, Sendable {
  case invalidRequest
  case sessionNotReady
  case capacityExceeded
  case cancelled
  case notFound
  case disconnected
  case staleFence
  case conflict
  case busy
  case credentialStoreUnavailable
  case cleanupPending
  case operationUnavailable
  case authorityUnavailable
  case brokerUnavailable
  case protocolMismatch
  case closed

  init(_ code: BrokerCredentialLifecycleFailureCode) {
    self =
      switch code {
      case .invalidRequest: .invalidRequest
      case .sessionNotReady: .sessionNotReady
      case .capacityExceeded: .capacityExceeded
      case .cancelled: .cancelled
      case .notFound: .notFound
      case .disconnected: .disconnected
      case .staleFence: .staleFence
      case .conflict: .conflict
      case .busy: .busy
      case .credentialStoreUnavailable: .credentialStoreUnavailable
      case .cleanupPending: .cleanupPending
      case .operationUnavailable: .operationUnavailable
      case .authorityUnavailable: .authorityUnavailable
      }
  }
}

package enum BrokerCredentialLifecycleControl: Sendable, Equatable {
  case projection(connectionID: UUID)
  case resumeStage(
    connectionID: UUID,
    operationID: UUID,
    expectedFence: UInt64
  )
  case reservedOperation
  case abort(
    connectionID: UUID,
    attemptID: UUID,
    operationID: UUID,
    expectedFence: UInt64
  )
  case disconnect(
    connectionID: UUID,
    operationID: UUID,
    expectedFence: UInt64
  )

  enum ExpectedReply {
    case projection
    case staged
    case mutation
    case failure
  }

  var expectedReply: ExpectedReply {
    switch self {
    case .projection:
      .projection
    case .resumeStage:
      .staged
    case .abort, .disconnect:
      .mutation
    case .reservedOperation:
      .failure
    }
  }

  func request(requestID: UInt64) throws -> BrokerCredentialControlRequest {
    switch self {
    case .projection(let connectionID):
      .projection(requestID: requestID, connectionID: connectionID)
    case .resumeStage(let connectionID, let operationID, let expectedFence):
      .resumeStage(
        requestID: requestID,
        connectionID: connectionID,
        operationID: operationID,
        expectedFence: expectedFence
      )
    case .reservedOperation:
      .reservedOperation(requestID: requestID)
    case .abort(
      let connectionID,
      let attemptID,
      let operationID,
      let expectedFence
    ):
      .abort(
        requestID: requestID,
        connectionID: connectionID,
        attemptID: attemptID,
        operationID: operationID,
        expectedFence: expectedFence
      )
    case .disconnect(let connectionID, let operationID, let expectedFence):
      .disconnect(
        requestID: requestID,
        connectionID: connectionID,
        operationID: operationID,
        expectedFence: expectedFence
      )
    }
  }
}
