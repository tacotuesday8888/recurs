import Foundation

enum BrokerDirectContinuationError:
  Error, Sendable, Equatable, CustomStringConvertible, LocalizedError
{
  case invalidRequest
  case invalidCapability
  case bindingMismatch
  case expired
  case stateTooLarge
  case persistenceUnavailable

  private var fixedDescription: String {
    switch self {
    case .invalidRequest: "The direct continuation request is invalid."
    case .invalidCapability: "The direct continuation capability is invalid."
    case .bindingMismatch: "The direct continuation binding does not match."
    case .expired: "The direct continuation capability expired."
    case .stateTooLarge: "The direct continuation state is too large."
    case .persistenceUnavailable: "Direct continuation storage is unavailable."
    }
  }

  var description: String { fixedDescription }
  var errorDescription: String? { fixedDescription }
}

enum BrokerDirectContinuationRecordError: Error, Sendable, Equatable {
  case conflict
  case unavailable
}

enum BrokerDirectContinuationStorageClass: String, Sendable, Equatable {
  case persistentBroker = "persistent_broker"
}

enum BrokerDirectContinuationStatus: String, Sendable, Equatable {
  case committed
}

struct BrokerDirectContinuationHandle:
  Sendable, Equatable, CustomStringConvertible, CustomDebugStringConvertible
{
  let id: String
  let storageClass: BrokerDirectContinuationStorageClass
  let recursSessionID: String
  let connectionID: String
  let adapterID: String
  let modelID: String
  let backendFingerprint: String
  let stateVersion: UInt16
  let originTurnID: String
  let continuationSequence: UInt64
  let status: BrokerDirectContinuationStatus

  var description: String { "Broker direct continuation handle." }
  var debugDescription: String { description }
}

struct BrokerDirectContinuationWriteBinding: Sendable, Equatable {
  let authorizationID: String
  let sessionID: String
  let connectionID: String
  let adapterID: String
  let modelID: String
  let backendFingerprint: String
  let turnID: String
  let expectedSessionRecordSequence: UInt64
  let expiresAt: Date
}

struct BrokerDirectContinuationReplayBinding: Sendable, Equatable {
  let authorizationID: String
  let sessionID: String
  let connectionID: String
  let adapterID: String
  let modelID: String
  let backendFingerprint: String
  let turnID: String
  let expectedSessionRecordSequence: UInt64
  let expiresAt: Date
}

struct BrokerDirectContinuationRecord: Sendable, Equatable {
  let handle: BrokerDirectContinuationHandle
  let binding: BrokerDirectContinuationWriteBinding
  let outputItems: [BrokerOpenAIResponsesPrivateOutput]
  let createdAt: Date
}

protocol BrokerDirectContinuationRecordStoring: Sendable {
  func insert(_ record: BrokerDirectContinuationRecord) async throws
  func read(id: String) async throws -> BrokerDirectContinuationRecord?
  func remove(id: String) async throws
}

actor BrokerDirectContinuationAuthority {
  static let stateVersion: UInt16 = 1
  static let maximumOutputItemCount = 128
  static let maximumStateByteCount = 16 * 1_024 * 1_024

  private let records: any BrokerDirectContinuationRecordStoring
  private let idSource: @Sendable () -> UUID?
  private let clock: @Sendable () -> Date

  init(
    records: any BrokerDirectContinuationRecordStoring,
    idSource: @escaping @Sendable () -> UUID? = { UUID() },
    clock: @escaping @Sendable () -> Date = { Date() }
  ) {
    self.records = records
    self.idSource = idSource
    self.clock = clock
  }

  func put(
    binding: BrokerDirectContinuationWriteBinding,
    previous: BrokerDirectContinuationHandle?,
    outputItems: [BrokerOpenAIResponsesPrivateOutput]
  ) async throws(BrokerDirectContinuationError) -> BrokerDirectContinuationHandle {
    let now = clock()
    try Self.validate(binding, now: now)
    guard (1...Self.maximumOutputItemCount).contains(outputItems.count) else {
      throw .invalidRequest
    }
    let byteCount = outputItems.reduce(into: 0) { total, item in
      let (next, overflowed) = total.addingReportingOverflow(item.encodedByteCount)
      total = overflowed ? .max : next
    }
    guard byteCount <= Self.maximumStateByteCount else { throw .stateTooLarge }

    let sequence: UInt64
    if let previous {
      let record = try await read(previous.id)
      guard record.handle == previous,
        Self.sameLane(record.binding, binding),
        binding.expectedSessionRecordSequence > record.binding.expectedSessionRecordSequence,
        previous.status == .committed,
        previous.continuationSequence < UInt64.max
      else { throw .bindingMismatch }
      sequence = previous.continuationSequence + 1
    } else {
      sequence = 1
    }
    guard let id = idSource()?.uuidString.lowercased() else {
      throw .persistenceUnavailable
    }
    let handle = BrokerDirectContinuationHandle(
      id: id,
      storageClass: .persistentBroker,
      recursSessionID: binding.sessionID,
      connectionID: binding.connectionID,
      adapterID: binding.adapterID,
      modelID: binding.modelID,
      backendFingerprint: binding.backendFingerprint,
      stateVersion: Self.stateVersion,
      originTurnID: binding.turnID,
      continuationSequence: sequence,
      status: .committed
    )
    do {
      try await records.insert(BrokerDirectContinuationRecord(
        handle: handle,
        binding: binding,
        outputItems: outputItems,
        createdAt: now
      ))
    } catch {
      throw .persistenceUnavailable
    }
    return handle
  }

  func load(
    _ handle: BrokerDirectContinuationHandle,
    binding: BrokerDirectContinuationReplayBinding,
    activeHandleIDs: Set<String>
  ) async throws(BrokerDirectContinuationError) -> [BrokerOpenAIResponsesPrivateOutput] {
    try Self.validate(binding, now: clock())
    guard activeHandleIDs.contains(handle.id), handle.status == .committed else {
      throw .invalidCapability
    }
    let record = try await read(handle.id)
    guard record.handle == handle else { throw .invalidCapability }
    guard Self.sameLane(record.binding, binding),
      binding.expectedSessionRecordSequence > record.binding.expectedSessionRecordSequence
    else { throw .bindingMismatch }
    return record.outputItems
  }

  private func read(
    _ id: String
  ) async throws(BrokerDirectContinuationError) -> BrokerDirectContinuationRecord {
    do {
      guard let record = try await records.read(id: id) else {
        throw BrokerDirectContinuationError.invalidCapability
      }
      return record
    } catch let error as BrokerDirectContinuationError {
      throw error
    } catch {
      throw .persistenceUnavailable
    }
  }

  private static func validate(
    _ binding: BrokerDirectContinuationWriteBinding,
    now: Date
  ) throws(BrokerDirectContinuationError) {
    try validateFields(
      authorizationID: binding.authorizationID,
      sessionID: binding.sessionID,
      connectionID: binding.connectionID,
      adapterID: binding.adapterID,
      modelID: binding.modelID,
      backendFingerprint: binding.backendFingerprint,
      turnID: binding.turnID,
      expiresAt: binding.expiresAt,
      now: now
    )
  }

  private static func validate(
    _ binding: BrokerDirectContinuationReplayBinding,
    now: Date
  ) throws(BrokerDirectContinuationError) {
    try validateFields(
      authorizationID: binding.authorizationID,
      sessionID: binding.sessionID,
      connectionID: binding.connectionID,
      adapterID: binding.adapterID,
      modelID: binding.modelID,
      backendFingerprint: binding.backendFingerprint,
      turnID: binding.turnID,
      expiresAt: binding.expiresAt,
      now: now
    )
  }

  private static func validateFields(
    authorizationID: String,
    sessionID: String,
    connectionID: String,
    adapterID: String,
    modelID: String,
    backendFingerprint: String,
    turnID: String,
    expiresAt: Date,
    now: Date
  ) throws(BrokerDirectContinuationError) {
    guard validText(authorizationID), validText(sessionID), validText(connectionID),
      validText(adapterID), validText(modelID), validText(turnID),
      validFingerprint(backendFingerprint), expiresAt > now
    else {
      if expiresAt <= now { throw .expired }
      throw .invalidRequest
    }
  }

  private static func validText(_ value: String) -> Bool {
    (1...512).contains(value.utf8.count) && value == value.trimmingCharacters(in: .whitespaces)
      && value.unicodeScalars.allSatisfy { $0.value >= 0x21 && $0.value <= 0x7e }
  }

  private static func validFingerprint(_ value: String) -> Bool {
    value.utf8.count == 71 && value.hasPrefix("sha256:")
      && value.dropFirst(7).allSatisfy { $0.isHexDigit && !$0.isUppercase }
  }

  private static func sameLane(
    _ previous: BrokerDirectContinuationWriteBinding,
    _ current: BrokerDirectContinuationWriteBinding
  ) -> Bool {
    previous.sessionID == current.sessionID && previous.connectionID == current.connectionID
      && previous.adapterID == current.adapterID && previous.modelID == current.modelID
      && previous.backendFingerprint == current.backendFingerprint
  }

  private static func sameLane(
    _ previous: BrokerDirectContinuationWriteBinding,
    _ current: BrokerDirectContinuationReplayBinding
  ) -> Bool {
    previous.sessionID == current.sessionID && previous.connectionID == current.connectionID
      && previous.adapterID == current.adapterID && previous.modelID == current.modelID
      && previous.backendFingerprint == current.backendFingerprint
  }
}
