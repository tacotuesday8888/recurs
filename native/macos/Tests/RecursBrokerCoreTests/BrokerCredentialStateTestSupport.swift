import Foundation

@testable import RecursBrokerCore

extension BrokerCredentialState {
  func stage(
    connectionID: UUID,
    operationID: UUID,
    expectedFence: UInt64,
    secret: sending SecretBytes
  ) async throws(BrokerStateError) -> StagingAttempt {
    try await stage(
      connectionID: connectionID,
      providerBinding: .openAI,
      operationID: operationID,
      expectedFence: expectedFence,
      secret: secret
    )
  }

  func reserveCredentialUse(
    connectionID: UUID
  ) async throws(CredentialUseError) -> CredentialUseReservation {
    try await reserveCredentialUse(
      connectionID: connectionID,
      expectedBinding: .openAI
    )
  }
}

extension BrokerCredentialStateMachine {
  func stageProposal(
    connectionID: UUID,
    expectedFence: UInt64
  ) throws(BrokerStateError) -> StageProposal {
    try stageProposal(
      connectionID: connectionID,
      expectedFence: expectedFence,
      providerBinding: .openAI
    )
  }
}
