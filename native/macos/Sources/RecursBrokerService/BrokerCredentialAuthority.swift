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

  func commit(
    connectionID: UUID,
    attemptID: UUID,
    operationID: UUID,
    expectedFence: UInt64
  ) async throws(BrokerStateError) -> ReadyProjection

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

protocol BrokerProviderCredentialUseAuthority: Sendable {
  func reserveCredentialUse(
    connectionID: UUID,
    expectedBinding: ProviderProfileBinding,
    purpose: CredentialUsePurpose
  ) async throws(CredentialUseError) -> CredentialUseReservation

  func startCredentialUse<Prepared: Sendable>(
    _ reservation: CredentialUseReservation,
    prepare: @Sendable (UnsafeRawBufferPointer) -> CredentialUsePreparation<Prepared>,
    start: @Sendable (Prepared) -> Void
  ) async throws(CredentialUseError) -> DeliveryState

  func cancelCredentialUse(_ reservation: CredentialUseReservation) async
  func releaseCredentialUse(_ reservation: CredentialUseReservation) async
}

struct BrokerCredentialAuthority:
  BrokerCredentialLifecycleAuthority,
  BrokerProviderCredentialUseAuthority,
  BrokerProviderRouteProjectionReader,
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

  func authoritativeBoundProjection(
    for connectionID: UUID
  ) async throws(BrokerJournalError) -> BrokerCredentialBoundProjection? {
    try await state.authoritativeBoundProjection(for: connectionID)
  }

  func reserveCredentialUse(
    connectionID: UUID,
    expectedBinding: ProviderProfileBinding,
    purpose: CredentialUsePurpose
  ) async throws(CredentialUseError) -> CredentialUseReservation {
    try await state.reserveCredentialUse(
      connectionID: connectionID,
      expectedBinding: expectedBinding,
      purpose: purpose
    )
  }

  func cancelCredentialUse(_ reservation: CredentialUseReservation) async {
    await state.cancelCredentialUse(reservation)
  }

  func startCredentialUse<Prepared: Sendable>(
    _ reservation: CredentialUseReservation,
    prepare: @Sendable (UnsafeRawBufferPointer) -> CredentialUsePreparation<Prepared>,
    start: @Sendable (Prepared) -> Void
  ) async throws(CredentialUseError) -> DeliveryState {
    try await state.startCredentialUse(
      reservation,
      prepare: prepare,
      start: start
    )
  }

  func releaseCredentialUse(_ reservation: CredentialUseReservation) async {
    await state.releaseCredentialUse(reservation)
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

  func commit(
    connectionID: UUID,
    attemptID: UUID,
    operationID: UUID,
    expectedFence: UInt64
  ) async throws(BrokerStateError) -> ReadyProjection {
    try await state.commit(
      connectionID: connectionID,
      attemptID: attemptID,
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
