import Foundation
import RecursBrokerCore

enum BrokerProviderRouteScope: Sendable, Equatable {
  case setup
  case run
  case maintenance

  fileprivate var routeID: EndpointRouteID {
    switch self {
    case .setup, .maintenance:
      .modelCatalog
    case .run:
      .generation
    }
  }

  fileprivate var credentialUsePurpose: CredentialUsePurpose {
    switch self {
    case .setup:
      .stagingCandidate
    case .run, .maintenance:
      .usableReady
    }
  }
}

enum BrokerProviderRouteAuthorityError:
  Error,
  Sendable,
  Equatable,
  CustomStringConvertible,
  CustomDebugStringConvertible,
  LocalizedError
{
  case cancelled
  case closed
  case expired
  case invalidCapability
  case invalidCredential
  case wrongScope
  case wrongProvider
  case wrongRequestBytes
  case staleCapability
  case authorityUnavailable
  case routeUnavailable
  case requestBudgetExceeded
  case byteBudgetExceeded

  private var fixedDescription: String {
    switch self {
    case .cancelled:
      "The provider route authorization was cancelled."
    case .closed:
      "The provider route authority is closed."
    case .expired:
      "The provider route capability expired."
    case .invalidCapability:
      "The provider route capability is invalid."
    case .invalidCredential:
      "The provider credential is invalid."
    case .wrongScope:
      "The provider route scope is invalid."
    case .wrongProvider:
      "The provider route binding is invalid."
    case .wrongRequestBytes:
      "The provider route request size is invalid."
    case .staleCapability:
      "The provider route capability is stale."
    case .authorityUnavailable:
      "Provider route authority is unavailable."
    case .routeUnavailable:
      "The provider route is unavailable."
    case .requestBudgetExceeded:
      "The provider route request budget is exhausted."
    case .byteBudgetExceeded:
      "The provider route byte budget is exhausted."
    }
  }

  var description: String { fixedDescription }
  var debugDescription: String { fixedDescription }
  var errorDescription: String? { fixedDescription }
}

final class BrokerProviderRouteCapability:
  Sendable,
  CustomReflectable,
  CustomStringConvertible,
  CustomDebugStringConvertible
{
  fileprivate init() {}

  var customMirror: Mirror {
    Mirror(self, children: EmptyCollection<(label: String?, value: Any)>(), displayStyle: .class)
  }

  var description: String { "Broker provider route capability." }
  var debugDescription: String { description }
}

final class BrokerProviderRouteReservation:
  @unchecked Sendable,
  CustomReflectable,
  CustomStringConvertible,
  CustomDebugStringConvertible
{
  private enum State {
    case reserved(CredentialUseReservation)
    case consuming(CredentialUseReservation)
    case terminal(BrokerProviderRouteAuthorityError)
  }

  private let lock = NSLock()
  private let useID: UInt64
  private var state: State

  fileprivate init(useID: UInt64, credential: CredentialUseReservation) {
    self.useID = useID
    state = .reserved(credential)
  }

  fileprivate var authorityUseID: UInt64 { useID }

  fileprivate func claim() -> Result<CredentialUseReservation, BrokerProviderRouteAuthorityError> {
    lock.withLock {
      switch state {
      case .reserved(let credential):
        state = .consuming(credential)
        return .success(credential)
      case .consuming:
        return .failure(.invalidCapability)
      case .terminal(let error):
        return .failure(error)
      }
    }
  }

  fileprivate func consumingError() -> BrokerProviderRouteAuthorityError? {
    lock.withLock {
      switch state {
      case .consuming:
        nil
      case .reserved:
        .invalidCapability
      case .terminal(let error):
        error
      }
    }
  }

  fileprivate func revoke(
    with error: BrokerProviderRouteAuthorityError
  ) -> CredentialUseReservation? {
    lock.withLock {
      switch state {
      case .reserved(let credential), .consuming(let credential):
        state = .terminal(error)
        return credential
      case .terminal:
        return nil
      }
    }
  }

  fileprivate func complete() -> CredentialUseReservation? {
    lock.withLock {
      guard case .consuming(let credential) = state else { return nil }
      state = .terminal(.invalidCapability)
      return credential
    }
  }

  fileprivate var terminalError: BrokerProviderRouteAuthorityError? {
    lock.withLock {
      guard case .terminal(let error) = state else { return nil }
      return error
    }
  }

  var customMirror: Mirror {
    Mirror(self, children: EmptyCollection<(label: String?, value: Any)>(), displayStyle: .class)
  }

  var description: String { "<provider-route-reservation>" }
  var debugDescription: String { description }
}

private final class WeakProviderRouteReservation: @unchecked Sendable {
  weak var value: BrokerProviderRouteReservation?

  init(_ value: BrokerProviderRouteReservation) {
    self.value = value
  }
}

private final class ProviderRouteOperationLatch: @unchecked Sendable {
  private let lock = NSLock()
  private var isFinished = false
  private var waiters: [CheckedContinuation<Void, Never>] = []

  func wait() async {
    await withCheckedContinuation { continuation in
      lock.lock()
      if isFinished {
        lock.unlock()
        continuation.resume()
      } else {
        waiters.append(continuation)
        lock.unlock()
      }
    }
  }

  func finish() {
    lock.lock()
    guard !isFinished else {
      lock.unlock()
      return
    }
    isFinished = true
    let selected = waiters
    waiters.removeAll()
    lock.unlock()
    for waiter in selected { waiter.resume() }
  }
}

protocol BrokerProviderRouteProjectionReader: Sendable {
  func authoritativeBoundProjection(
    for connectionID: UUID
  ) async throws(BrokerJournalError) -> BrokerCredentialBoundProjection?
}

actor BrokerProviderRouteAuthority {
  private struct ExpectedSetupIdentity: Sendable {
    let attemptID: UUID
    let fence: UInt64
  }

  private struct PendingReserve: Sendable {
    let capabilityID: ObjectIdentifier
    let latch: ProviderRouteOperationLatch
  }

  private struct ActiveUse: Sendable {
    let reservation: WeakProviderRouteReservation
    let capability: BrokerProviderRouteCapability
    let scope: BrokerProviderRouteScope
    let providerBinding: ProviderProfileBinding
    let requestBytes: UInt64
  }

  private struct Entry: Sendable {
    let handle: BrokerProviderRouteCapability
    let connectionID: UUID
    let scope: BrokerProviderRouteScope
    let providerBinding: ProviderProfileBinding
    let identity: CredentialUseIdentity
    let expiresAt: Date
    let requestBudget: UInt64
    let byteBudget: UInt64
    var requestsUsed: UInt64
    var bytesUsed: UInt64
    var isCancelled: Bool
    var activeUseIDs: Set<UInt64>
  }

  private let reader: any BrokerProviderRouteProjectionReader
  private let credentialAuthority: any BrokerProviderCredentialUseAuthority
  private let useIDAllocator: (@Sendable () -> UInt64?)?
  private let clock: @Sendable () -> Date
  private var entries: [ObjectIdentifier: Entry] = [:]
  private var activeUses: [UInt64: ActiveUse] = [:]
  private var pendingReserves: [ObjectIdentifier: PendingReserve] = [:]
  private var cleanupTail: Task<Void, Never>?
  private var lastUseID: UInt64 = 0
  private var isClosed = false

  init(
    reader: any BrokerProviderRouteProjectionReader,
    credentialAuthority: any BrokerProviderCredentialUseAuthority,
    useIDAllocator: (@Sendable () -> UInt64?)? = nil,
    clock: @escaping @Sendable () -> Date = { Date() }
  ) {
    self.reader = reader
    self.credentialAuthority = credentialAuthority
    self.useIDAllocator = useIDAllocator
    self.clock = clock
  }

  func issue(
    scope: BrokerProviderRouteScope,
    connectionID: UUID,
    expiresAt: Date,
    requestBudget: UInt64,
    byteBudget: UInt64
  ) async throws(BrokerProviderRouteAuthorityError) -> BrokerProviderRouteCapability {
    try await issue(
      scope: scope,
      connectionID: connectionID,
      expectedSetupIdentity: nil,
      expiresAt: expiresAt,
      requestBudget: requestBudget,
      byteBudget: byteBudget
    )
  }

  func issueSetup(
    connectionID: UUID,
    attemptID: UUID,
    expectedFence: UInt64,
    expiresAt: Date,
    requestBudget: UInt64,
    byteBudget: UInt64
  ) async throws(BrokerProviderRouteAuthorityError) -> BrokerProviderRouteCapability {
    try await issue(
      scope: .setup,
      connectionID: connectionID,
      expectedSetupIdentity: ExpectedSetupIdentity(
        attemptID: attemptID,
        fence: expectedFence
      ),
      expiresAt: expiresAt,
      requestBudget: requestBudget,
      byteBudget: byteBudget
    )
  }

  private func issue(
    scope: BrokerProviderRouteScope,
    connectionID: UUID,
    expectedSetupIdentity: ExpectedSetupIdentity?,
    expiresAt: Date,
    requestBudget: UInt64,
    byteBudget: UInt64
  ) async throws(BrokerProviderRouteAuthorityError) -> BrokerProviderRouteCapability {
    try checkSession(expiresAt: expiresAt)

    let result: Result<BrokerCredentialBoundProjection?, BrokerJournalError>
    do {
      result = .success(
        try await reader.authoritativeBoundProjection(for: connectionID)
      )
    } catch let error {
      result = .failure(error)
    }

    try checkSession(expiresAt: expiresAt)
    guard
      case .success(let bound?) = result,
      let projection = bound.projection
    else {
      throw .authorityUnavailable
    }
    let identity = try Self.identity(
      scope: scope,
      connectionID: connectionID,
      projection: projection,
      stale: false
    )
    if let expectedSetupIdentity {
      guard
        case .stagingCandidate(_, let fence, let attemptID, _) = identity,
        attemptID == expectedSetupIdentity.attemptID,
        fence == expectedSetupIdentity.fence
      else {
        throw .staleCapability
      }
    }
    try Self.requireRoute(scope.routeID, from: bound.providerBinding)

    let handle = BrokerProviderRouteCapability()
    entries[ObjectIdentifier(handle)] = Entry(
      handle: handle,
      connectionID: connectionID,
      scope: scope,
      providerBinding: bound.providerBinding,
      identity: identity,
      expiresAt: expiresAt,
      requestBudget: requestBudget,
      byteBudget: byteBudget,
      requestsUsed: 0,
      bytesUsed: 0,
      isCancelled: false,
      activeUseIDs: []
    )
    return handle
  }

  func reserveCredentialUse(
    _ handle: BrokerProviderRouteCapability,
    expectedScope: BrokerProviderRouteScope,
    expectedProviderBinding: ProviderProfileBinding,
    requestBytes: UInt64
  ) async throws(BrokerProviderRouteAuthorityError)
    -> BrokerProviderRouteReservation
  {
    let identifier = ObjectIdentifier(handle)
    pruneAbandonedUses(identifier: identifier)
    let expected = try liveEntry(
      identifier: identifier,
      handle: handle,
      expectedScope: expectedScope,
      expectedProviderBinding: expectedProviderBinding,
      requestBytes: requestBytes
    )
    let routeReservationID = try allocateUseID()
    let pendingReserve = beginReserveOperation(capabilityID: identifier)
    defer {
      finishReserveOperation(
        pendingReserve.identifier,
        latch: pendingReserve.latch
      )
    }

    let result = await authoritativeProjection(for: expected.connectionID)

    var live = try liveEntry(
      identifier: identifier,
      handle: handle,
      expectedScope: expectedScope,
      expectedProviderBinding: expectedProviderBinding,
      requestBytes: requestBytes
    )
    try Self.validate(result, against: live)

    let reservation: CredentialUseReservation
    do {
      reservation = try await credentialAuthority.reserveCredentialUse(
        connectionID: live.connectionID,
        expectedBinding: expectedProviderBinding,
        purpose: live.scope.credentialUsePurpose
      )
    } catch let error {
      throw Self.mapCredentialUseError(error)
    }

    do {
      live = try liveEntry(
        identifier: identifier,
        handle: handle,
        expectedScope: expectedScope,
        expectedProviderBinding: expectedProviderBinding,
        requestBytes: requestBytes
      )
      guard
        reservation.isBound(
          to: live.identity,
          providerBinding: live.providerBinding
        )
      else {
        throw BrokerProviderRouteAuthorityError.staleCapability
      }

      let finalResult = await authoritativeProjection(for: live.connectionID)
      live = try liveEntry(
        identifier: identifier,
        handle: handle,
        expectedScope: expectedScope,
        expectedProviderBinding: expectedProviderBinding,
        requestBytes: requestBytes
      )
      try Self.validate(finalResult, against: live)
      guard
        reservation.isBound(
          to: live.identity,
          providerBinding: live.providerBinding
        )
      else {
        throw BrokerProviderRouteAuthorityError.staleCapability
      }

      let usage = try Self.checkedUsage(entry: live, requestBytes: requestBytes)
      live.requestsUsed = usage.requests
      live.bytesUsed = usage.bytes
      let routeReservation = BrokerProviderRouteReservation(
        useID: routeReservationID,
        credential: reservation
      )
      live.activeUseIDs.insert(routeReservationID)
      entries[identifier] = live
      activeUses[routeReservationID] = ActiveUse(
        reservation: WeakProviderRouteReservation(routeReservation),
        capability: handle,
        scope: expectedScope,
        providerBinding: expectedProviderBinding,
        requestBytes: requestBytes
      )
      return routeReservation
    } catch let error as BrokerProviderRouteAuthorityError {
      let cleanup = enqueueCleanup([reservation])
      await cleanup.value
      throw error
    } catch {
      let cleanup = enqueueCleanup([reservation])
      await cleanup.value
      throw .authorityUnavailable
    }
  }

  func startCredentialUse<Prepared: Sendable>(
    _ reservation: BrokerProviderRouteReservation,
    capability handle: BrokerProviderRouteCapability,
    expectedScope: BrokerProviderRouteScope,
    expectedProviderBinding: ProviderProfileBinding,
    requestBytes: UInt64,
    prepare: @Sendable (UnsafeRawBufferPointer) -> CredentialUsePreparation<Prepared>,
    start: @Sendable (Prepared) -> Void
  ) async throws(BrokerProviderRouteAuthorityError) -> DeliveryState {
    let reservationID = reservation.authorityUseID
    guard
      let use = activeUses[reservationID],
      use.reservation.value === reservation
    else {
      throw reservation.terminalError ?? .invalidCapability
    }

    let credential: CredentialUseReservation
    switch reservation.claim() {
    case .success(let claimed):
      credential = claimed
    case .failure(let error):
      throw error
    }

    let initial: Entry
    do {
      initial = try validateClaimedUse(
        use,
        reservation: reservation,
        capability: handle,
        expectedScope: expectedScope,
        expectedProviderBinding: expectedProviderBinding,
        requestBytes: requestBytes
      )
    } catch let error {
      await terminateActiveUse(
        reservationID,
        reservation: reservation,
        error: error
      )
      throw error
    }

    let result = await authoritativeProjection(for: initial.connectionID)
    do {
      let live = try validateClaimedUse(
        use,
        reservation: reservation,
        capability: handle,
        expectedScope: expectedScope,
        expectedProviderBinding: expectedProviderBinding,
        requestBytes: requestBytes
      )
      try Self.validate(result, against: live)
    } catch let error {
      await terminateActiveUse(
        reservationID,
        reservation: reservation,
        error: error
      )
      throw error
    }

    let delivery: DeliveryState
    do {
      delivery = try await credentialAuthority.startCredentialUse(
        credential,
        prepare: prepare,
        start: start
      )
    } catch let error {
      let mapped = reservation.terminalError ?? Self.mapCredentialUseError(error)
      await terminateActiveUse(
        reservationID,
        reservation: reservation,
        error: mapped
      )
      throw mapped
    }

    removeActiveUse(reservationID)
    if let completed = reservation.complete() {
      let cleanup = enqueueCleanup([completed], cancelBeforeRelease: false)
      await cleanup.value
    } else if let cleanupTail {
      await cleanupTail.value
    }
    return delivery
  }

  func cancel(_ handle: BrokerProviderRouteCapability) async {
    let identifier = ObjectIdentifier(handle)
    let pending = pendingReserveLatches(for: identifier)
    guard var entry = entries[identifier], entry.handle === handle else {
      await waitForPendingReserves(pending)
      if let cleanupTail { await cleanupTail.value }
      return
    }
    entry.isCancelled = true
    let activeUseIDs = entry.activeUseIDs
    entry.activeUseIDs.removeAll()
    entries[identifier] = entry
    let credentials = revokeActiveUses(activeUseIDs, error: .cancelled)
    if !credentials.isEmpty {
      _ = enqueueCleanup(credentials)
    }
    await waitForPendingReserves(pending)
    if let cleanupTail { await cleanupTail.value }
  }

  func close() async {
    let pending = pendingReserveLatches()
    guard !isClosed else {
      await waitForPendingReserves(pending)
      if let cleanupTail { await cleanupTail.value }
      return
    }
    isClosed = true
    let activeUseIDs = Set(activeUses.keys)
    entries.removeAll()
    let credentials = revokeActiveUses(activeUseIDs, error: .closed)
    if !credentials.isEmpty {
      _ = enqueueCleanup(credentials)
    }
    await waitForPendingReserves(pending)
    if let cleanupTail { await cleanupTail.value }
  }

  private func checkSession(
    expiresAt: Date
  ) throws(BrokerProviderRouteAuthorityError) {
    guard !isClosed else { throw .closed }
    guard !Task.isCancelled else { throw .cancelled }
    guard clock() < expiresAt else { throw .expired }
  }

  private func liveEntry(
    identifier: ObjectIdentifier,
    handle: BrokerProviderRouteCapability,
    expectedScope: BrokerProviderRouteScope,
    expectedProviderBinding: ProviderProfileBinding,
    requestBytes: UInt64
  ) throws(BrokerProviderRouteAuthorityError) -> Entry {
    let entry = try liveEntry(
      identifier: identifier,
      handle: handle,
      expectedScope: expectedScope,
      expectedProviderBinding: expectedProviderBinding
    )
    _ = try Self.checkedUsage(entry: entry, requestBytes: requestBytes)
    return entry
  }

  private func liveEntry(
    identifier: ObjectIdentifier,
    handle: BrokerProviderRouteCapability,
    expectedScope: BrokerProviderRouteScope,
    expectedProviderBinding: ProviderProfileBinding
  ) throws(BrokerProviderRouteAuthorityError) -> Entry {
    guard !isClosed else { throw .closed }
    guard !Task.isCancelled else { throw .cancelled }
    guard let entry = entries[identifier], entry.handle === handle else {
      throw .invalidCapability
    }
    guard entry.scope == expectedScope else { throw .wrongScope }
    guard entry.providerBinding == expectedProviderBinding else { throw .wrongProvider }
    guard !entry.isCancelled else { throw .cancelled }
    guard clock() < entry.expiresAt else { throw .expired }
    return entry
  }

  private func validateClaimedUse(
    _ expected: ActiveUse,
    reservation: BrokerProviderRouteReservation,
    capability: BrokerProviderRouteCapability,
    expectedScope: BrokerProviderRouteScope,
    expectedProviderBinding: ProviderProfileBinding,
    requestBytes: UInt64
  ) throws(BrokerProviderRouteAuthorityError) -> Entry {
    let reservationID = reservation.authorityUseID
    guard
      let current = activeUses[reservationID],
      current.reservation.value === reservation,
      current.capability === expected.capability
    else {
      throw reservation.terminalError ?? .invalidCapability
    }
    guard current.capability === capability else { throw .invalidCapability }
    guard current.scope == expectedScope else { throw .wrongScope }
    guard current.providerBinding == expectedProviderBinding else { throw .wrongProvider }
    guard current.requestBytes == requestBytes else { throw .wrongRequestBytes }
    if let error = reservation.consumingError() { throw error }
    return try liveEntry(
      identifier: ObjectIdentifier(current.capability),
      handle: current.capability,
      expectedScope: current.scope,
      expectedProviderBinding: current.providerBinding
    )
  }

  private func terminateActiveUse(
    _ identifier: UInt64,
    reservation: BrokerProviderRouteReservation,
    error: BrokerProviderRouteAuthorityError
  ) async {
    removeActiveUse(identifier)
    if let credential = reservation.revoke(with: error) {
      let cleanup = enqueueCleanup([credential])
      await cleanup.value
    } else if let cleanupTail {
      await cleanupTail.value
    }
  }

  private func enqueueCleanup(
    _ credentials: [CredentialUseReservation],
    cancelBeforeRelease: Bool = true
  ) -> Task<Void, Never> {
    let previous = cleanupTail
    let credentialAuthority = credentialAuthority
    let cleanup = Task.detached {
      if let previous { await previous.value }
      for credential in credentials {
        if cancelBeforeRelease {
          await credentialAuthority.cancelCredentialUse(credential)
        }
        await credentialAuthority.releaseCredentialUse(credential)
      }
    }
    cleanupTail = cleanup
    return cleanup
  }

  private func removeActiveUse(_ identifier: UInt64) {
    guard let use = activeUses.removeValue(forKey: identifier) else { return }
    let capabilityID = ObjectIdentifier(use.capability)
    guard var entry = entries[capabilityID] else { return }
    entry.activeUseIDs.remove(identifier)
    entries[capabilityID] = entry
  }

  private func revokeActiveUses(
    _ identifiers: Set<UInt64>,
    error: BrokerProviderRouteAuthorityError
  ) -> [CredentialUseReservation] {
    var credentials: [CredentialUseReservation] = []
    credentials.reserveCapacity(identifiers.count)
    for identifier in identifiers {
      guard let use = activeUses.removeValue(forKey: identifier) else { continue }
      let capabilityID = ObjectIdentifier(use.capability)
      if var entry = entries[capabilityID] {
        entry.activeUseIDs.remove(identifier)
        entries[capabilityID] = entry
      }
      if let credential = use.reservation.value?.revoke(with: error) {
        credentials.append(credential)
      }
    }
    return credentials
  }

  private func pruneAbandonedUses(identifier: ObjectIdentifier) {
    guard var entry = entries[identifier] else { return }
    let abandoned = entry.activeUseIDs.filter {
      activeUses[$0]?.reservation.value == nil
    }
    for activeUseID in abandoned {
      entry.activeUseIDs.remove(activeUseID)
      activeUses.removeValue(forKey: activeUseID)
    }
    entries[identifier] = entry
  }

  private func allocateUseID() throws(BrokerProviderRouteAuthorityError) -> UInt64 {
    let candidate: UInt64
    if let useIDAllocator {
      guard let allocated = useIDAllocator() else { throw .authorityUnavailable }
      candidate = allocated
    } else {
      let (allocated, overflow) = lastUseID.addingReportingOverflow(1)
      guard !overflow else { throw .authorityUnavailable }
      candidate = allocated
    }
    guard candidate > lastUseID else { throw .authorityUnavailable }
    lastUseID = candidate
    return candidate
  }

  private func beginReserveOperation(
    capabilityID: ObjectIdentifier
  ) -> (identifier: ObjectIdentifier, latch: ProviderRouteOperationLatch) {
    let latch = ProviderRouteOperationLatch()
    let identifier = ObjectIdentifier(latch)
    pendingReserves[identifier] = PendingReserve(
      capabilityID: capabilityID,
      latch: latch
    )
    return (identifier, latch)
  }

  private func finishReserveOperation(
    _ identifier: ObjectIdentifier,
    latch: ProviderRouteOperationLatch
  ) {
    pendingReserves.removeValue(forKey: identifier)
    latch.finish()
  }

  private func pendingReserveLatches(
    for capabilityID: ObjectIdentifier? = nil
  ) -> [ProviderRouteOperationLatch] {
    pendingReserves.values.compactMap { pending in
      guard capabilityID == nil || pending.capabilityID == capabilityID else {
        return nil
      }
      return pending.latch
    }
  }

  private func waitForPendingReserves(
    _ latches: [ProviderRouteOperationLatch]
  ) async {
    for latch in latches { await latch.wait() }
  }

  private static func checkedUsage(
    entry: Entry,
    requestBytes: UInt64
  ) throws(BrokerProviderRouteAuthorityError) -> (requests: UInt64, bytes: UInt64) {
    let (requests, requestOverflow) = entry.requestsUsed.addingReportingOverflow(1)
    guard !requestOverflow, requests <= entry.requestBudget else {
      throw .requestBudgetExceeded
    }
    let (bytes, byteOverflow) = entry.bytesUsed.addingReportingOverflow(requestBytes)
    guard !byteOverflow, bytes <= entry.byteBudget else {
      throw .byteBudgetExceeded
    }
    return (requests, bytes)
  }

  private static func identity(
    scope: BrokerProviderRouteScope,
    connectionID: UUID,
    projection: CredentialProjection,
    stale: Bool
  ) throws(BrokerProviderRouteAuthorityError) -> CredentialUseIdentity {
    let failure: BrokerProviderRouteAuthorityError =
      stale ? .staleCapability : .authorityUnavailable
    switch scope {
    case .setup:
      guard case .staging(let attempt) = projection,
        attempt.connectionID == connectionID
      else {
        throw failure
      }
      return .stagingCandidate(
        connectionID: connectionID,
        fence: attempt.fence,
        attemptID: attempt.attemptID,
        generation: attempt.candidate
      )

    case .run, .maintenance:
      switch projection {
      case .staging(let attempt):
        guard
          attempt.connectionID == connectionID,
          let ready = attempt.previousReady
        else {
          throw failure
        }
        return .usableReady(
          connectionID: connectionID,
          fence: attempt.fence,
          generation: ready
        )
      case .ready(let ready):
        guard ready.connectionID == connectionID else { throw failure }
        return .usableReady(
          connectionID: connectionID,
          fence: ready.fence,
          generation: ready.ready
        )
      case .tombstoned:
        throw failure
      }
    }
  }

  private func authoritativeProjection(
    for connectionID: UUID
  ) async -> Result<BrokerCredentialBoundProjection?, BrokerJournalError> {
    do {
      return .success(
        try await reader.authoritativeBoundProjection(for: connectionID)
      )
    } catch let error {
      return .failure(error)
    }
  }

  private static func validate(
    _ result: Result<BrokerCredentialBoundProjection?, BrokerJournalError>,
    against entry: Entry
  ) throws(BrokerProviderRouteAuthorityError) {
    guard
      case .success(let bound?) = result,
      let projection = bound.projection
    else {
      throw .authorityUnavailable
    }
    guard bound.providerBinding == entry.providerBinding else {
      throw .staleCapability
    }
    let currentIdentity = try identity(
      scope: entry.scope,
      connectionID: entry.connectionID,
      projection: projection,
      stale: true
    )
    guard currentIdentity == entry.identity else {
      throw .staleCapability
    }
    try requireRoute(entry.scope.routeID, from: bound.providerBinding)
  }

  private static func mapCredentialUseError(
    _ error: CredentialUseError
  ) -> BrokerProviderRouteAuthorityError {
    switch error {
    case .cancelled:
      .cancelled
    case .connectionNotFound, .connectionTombstoned, .noUsableCredential,
      .invalidReservation:
      .staleCapability
    case .invalidCredential:
      .invalidCredential
    case .operationInProgress, .authorityUnavailable, .credentialUnavailable,
      .invalidDeliveryTransition:
      .authorityUnavailable
    }
  }

  private static func requireRoute(
    _ routeID: EndpointRouteID,
    from binding: ProviderProfileBinding
  ) throws(BrokerProviderRouteAuthorityError) {
    let profile: EndpointProfile
    do {
      profile = try binding.endpointProfile
    } catch {
      throw .authorityUnavailable
    }
    do {
      _ = try profile.route(routeID)
    } catch EndpointPolicyError.routeNotAllowed {
      throw .routeUnavailable
    } catch {
      throw .authorityUnavailable
    }
  }
}
