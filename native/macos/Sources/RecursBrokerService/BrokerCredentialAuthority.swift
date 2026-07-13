import Foundation
import RecursBrokerCore
import RecursNativeSecurity

protocol BrokerCredentialLifecycleAuthority: Sendable {
  func authoritativeLifecycleProjection(
    for connectionID: UUID
  ) async throws(BrokerJournalError) -> CredentialLifecycleProjection

  func stage(
    connectionID: UUID,
    providerBinding: ProviderProfileBinding,
    operationID: UUID,
    expectedFence: UInt64,
    secret: sending SecretBytes
  ) async throws(BrokerStateError) -> StagingAttempt

  func resumeStage(
    connectionID: UUID,
    operationID: UUID,
    expectedFence: UInt64
  ) async throws(BrokerStateError) -> StagingAttempt

  func abort(
    connectionID: UUID,
    attemptID: UUID,
    operationID: UUID,
    expectedFence: UInt64
  ) async throws(BrokerStateError) -> ReadyProjection?

  func disconnect(
    connectionID: UUID,
    operationID: UUID,
    expectedFence: UInt64
  ) async throws(BrokerStateError) -> TombstoneProjection
}

struct BrokerCredentialAuthority:
  BrokerCredentialLifecycleAuthority,
  Sendable
{
  let state: BrokerCredentialState

  static func recovering(
    store: any CredentialStore,
    journal: any BrokerJournalStore
  ) async throws -> BrokerCredentialAuthority {
    BrokerCredentialAuthority(
      state: try await BrokerCredentialState.recovering(store: store, journal: journal)
    )
  }

  static func production(
    configuration: KeychainStoreConfiguration
  ) async throws -> BrokerCredentialAuthority {
    let directory = try SecureDirectory.openLiveJournalDirectory()
    let authenticator = KeychainJournalAuthenticator(configuration: configuration)
    let journal = try FileBrokerJournalStore.open(
      directory: directory,
      authenticator: authenticator
    )
    let store = DataProtectionCredentialStore(configuration: configuration)
    let state = try await BrokerCredentialState.recovering(
      store: store,
      journal: journal
    )
    return BrokerCredentialAuthority(state: state)
  }

  func authoritativeLifecycleProjection(
    for connectionID: UUID
  ) async throws(BrokerJournalError) -> CredentialLifecycleProjection {
    try await state.authoritativeLifecycleProjection(for: connectionID)
  }

  func stage(
    connectionID: UUID,
    providerBinding: ProviderProfileBinding,
    operationID: UUID,
    expectedFence: UInt64,
    secret: sending SecretBytes
  ) async throws(BrokerStateError) -> StagingAttempt {
    try await state.stage(
      connectionID: connectionID,
      providerBinding: providerBinding,
      operationID: operationID,
      expectedFence: expectedFence,
      secret: secret
    )
  }

  func resumeStage(
    connectionID: UUID,
    operationID: UUID,
    expectedFence: UInt64
  ) async throws(BrokerStateError) -> StagingAttempt {
    try await state.resumeStage(
      connectionID: connectionID,
      operationID: operationID,
      expectedFence: expectedFence
    )
  }

  func abort(
    connectionID: UUID,
    attemptID: UUID,
    operationID: UUID,
    expectedFence: UInt64
  ) async throws(BrokerStateError) -> ReadyProjection? {
    try await state.abort(
      connectionID: connectionID,
      attemptID: attemptID,
      operationID: operationID,
      expectedFence: expectedFence
    )
  }

  func disconnect(
    connectionID: UUID,
    operationID: UUID,
    expectedFence: UInt64
  ) async throws(BrokerStateError) -> TombstoneProjection {
    try await state.disconnect(
      connectionID: connectionID,
      operationID: operationID,
      expectedFence: expectedFence
    )
  }
}
