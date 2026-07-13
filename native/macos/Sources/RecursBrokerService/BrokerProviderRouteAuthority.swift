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
  case wrongScope
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
    case .wrongScope:
      "The provider route scope is invalid."
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

final class BrokerProviderRouteAuthorizationReceipt:
  Sendable,
  CustomReflectable,
  CustomStringConvertible,
  CustomDebugStringConvertible
{
  fileprivate init() {}

  var customMirror: Mirror {
    Mirror(self, children: EmptyCollection<(label: String?, value: Any)>(), displayStyle: .class)
  }

  var description: String { "Broker provider route authorization receipt." }
  var debugDescription: String { description }
}

protocol BrokerProviderRouteProjectionReader: Sendable {
  func authoritativeBoundProjection(
    for connectionID: UUID
  ) async throws(BrokerJournalError) -> BrokerCredentialBoundProjection?
}

actor BrokerProviderRouteAuthority {
  private enum FencedCredentialIdentity: Sendable, Equatable {
    case setup(
      connectionID: UUID,
      fence: UInt64,
      attemptID: UUID,
      candidate: CredentialGeneration
    )
    case usableReady(
      connectionID: UUID,
      fence: UInt64,
      ready: ReadyGeneration
    )
  }

  private struct Entry: Sendable {
    let handle: BrokerProviderRouteCapability
    let connectionID: UUID
    let scope: BrokerProviderRouteScope
    let providerBinding: ProviderProfileBinding
    let identity: FencedCredentialIdentity
    let expiresAt: Date
    let requestBudget: UInt64
    let byteBudget: UInt64
    var requestsUsed: UInt64
    var bytesUsed: UInt64
    var isCancelled: Bool
  }

  private let reader: any BrokerProviderRouteProjectionReader
  private let clock: @Sendable () -> Date
  private var entries: [ObjectIdentifier: Entry] = [:]
  private var isClosed = false

  init(
    reader: any BrokerProviderRouteProjectionReader,
    clock: @escaping @Sendable () -> Date = { Date() }
  ) {
    self.reader = reader
    self.clock = clock
  }

  func issue(
    scope: BrokerProviderRouteScope,
    connectionID: UUID,
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
    guard case .success(let bound?) = result else {
      throw .authorityUnavailable
    }
    let identity = try Self.identity(
      scope: scope,
      connectionID: connectionID,
      projection: bound.projection,
      stale: false
    )
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
      isCancelled: false
    )
    return handle
  }

  func authorize(
    _ handle: BrokerProviderRouteCapability,
    expectedScope: BrokerProviderRouteScope,
    requestBytes: UInt64
  ) async throws(BrokerProviderRouteAuthorityError)
    -> BrokerProviderRouteAuthorizationReceipt
  {
    let identifier = ObjectIdentifier(handle)
    let expected = try liveEntry(
      identifier: identifier,
      handle: handle,
      expectedScope: expectedScope,
      requestBytes: requestBytes
    )

    let result: Result<BrokerCredentialBoundProjection?, BrokerJournalError>
    do {
      result = .success(
        try await reader.authoritativeBoundProjection(for: expected.connectionID)
      )
    } catch let error {
      result = .failure(error)
    }

    var live = try liveEntry(
      identifier: identifier,
      handle: handle,
      expectedScope: expectedScope,
      requestBytes: requestBytes
    )
    guard case .success(let bound?) = result else {
      throw .authorityUnavailable
    }
    guard bound.providerBinding == live.providerBinding else {
      throw .staleCapability
    }
    let currentIdentity = try Self.identity(
      scope: live.scope,
      connectionID: live.connectionID,
      projection: bound.projection,
      stale: true
    )
    guard currentIdentity == live.identity else {
      throw .staleCapability
    }
    try Self.requireRoute(live.scope.routeID, from: bound.providerBinding)

    let usage = try Self.checkedUsage(entry: live, requestBytes: requestBytes)
    live.requestsUsed = usage.requests
    live.bytesUsed = usage.bytes
    entries[identifier] = live
    return BrokerProviderRouteAuthorizationReceipt()
  }

  func cancel(_ handle: BrokerProviderRouteCapability) {
    let identifier = ObjectIdentifier(handle)
    guard var entry = entries[identifier], entry.handle === handle else {
      return
    }
    entry.isCancelled = true
    entries[identifier] = entry
  }

  func close() {
    guard !isClosed else { return }
    isClosed = true
    entries.removeAll()
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
    requestBytes: UInt64
  ) throws(BrokerProviderRouteAuthorityError) -> Entry {
    guard !isClosed else { throw .closed }
    guard !Task.isCancelled else { throw .cancelled }
    guard let entry = entries[identifier], entry.handle === handle else {
      throw .invalidCapability
    }
    guard entry.scope == expectedScope else { throw .wrongScope }
    guard !entry.isCancelled else { throw .cancelled }
    guard clock() < entry.expiresAt else { throw .expired }
    _ = try Self.checkedUsage(entry: entry, requestBytes: requestBytes)
    return entry
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
  ) throws(BrokerProviderRouteAuthorityError) -> FencedCredentialIdentity {
    let failure: BrokerProviderRouteAuthorityError =
      stale ? .staleCapability : .authorityUnavailable
    switch scope {
    case .setup:
      guard case .staging(let attempt) = projection,
        attempt.connectionID == connectionID
      else {
        throw failure
      }
      return .setup(
        connectionID: connectionID,
        fence: attempt.fence,
        attemptID: attempt.attemptID,
        candidate: attempt.candidate
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
          ready: ready
        )
      case .ready(let ready):
        guard ready.connectionID == connectionID else { throw failure }
        return .usableReady(
          connectionID: connectionID,
          fence: ready.fence,
          ready: ready.ready
        )
      case .tombstoned:
        throw failure
      }
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
