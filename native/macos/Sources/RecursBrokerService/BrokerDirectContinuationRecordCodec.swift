import Foundation

enum BrokerDirectContinuationRecordCodecError: Error, Sendable, Equatable {
  case invalidRecord
}

struct BrokerDirectContinuationRecordCodec: Sendable {
  // The private output payload is capped at 16 MiB before canonical JSON's
  // base64 representation is applied.
  static let maximumEncodedByteCount = 24 * 1_024 * 1_024

  private let encoder: JSONEncoder
  private let decoder: JSONDecoder

  init() {
    encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    decoder = JSONDecoder()
  }

  func encode(
    _ record: BrokerDirectContinuationRecord
  ) throws(BrokerDirectContinuationRecordCodecError) -> Data {
    do {
      let data = try encoder.encode(PersistedRecord(record))
      guard data.count <= Self.maximumEncodedByteCount else { throw CodecFailure.invalid }
      return data
    } catch {
      throw .invalidRecord
    }
  }

  func decode(
    _ data: Data
  ) throws(BrokerDirectContinuationRecordCodecError) -> BrokerDirectContinuationRecord {
    guard !data.isEmpty, data.count <= Self.maximumEncodedByteCount else {
      throw .invalidRecord
    }
    do {
      let persisted = try decoder.decode(PersistedRecord.self, from: data)
      guard try encoder.encode(persisted) == data else { throw CodecFailure.invalid }
      return try persisted.record()
    } catch {
      throw .invalidRecord
    }
  }
}

private enum CodecFailure: Error {
  case invalid
}

private struct PersistedRecord: Codable, Equatable {
  let format: UInt8
  let handle: PersistedHandle
  let binding: PersistedBinding
  let outputItems: [Data]
  let createdAtMilliseconds: UInt64

  init(_ record: BrokerDirectContinuationRecord) throws {
    format = 1
    handle = PersistedHandle(record.handle)
    binding = try PersistedBinding(record.binding)
    outputItems = record.outputItems.map(\.encodedItemCopy)
    createdAtMilliseconds = try milliseconds(record.createdAt)
  }

  func record() throws -> BrokerDirectContinuationRecord {
    guard
      format == 1,
      (1...BrokerDirectContinuationAuthority.maximumOutputItemCount).contains(
        outputItems.count
      )
    else { throw CodecFailure.invalid }
    let decodedHandle = try handle.value()
    let decodedBinding = try binding.value()
    guard decodedHandle.recursSessionID == decodedBinding.sessionID,
      decodedHandle.connectionID == decodedBinding.connectionID,
      decodedHandle.adapterID == decodedBinding.adapterID,
      decodedHandle.modelID == decodedBinding.modelID,
      decodedHandle.backendFingerprint == decodedBinding.backendFingerprint,
      decodedHandle.originTurnID == decodedBinding.turnID
    else { throw CodecFailure.invalid }
    let outputs = try outputItems.map {
      try BrokerOpenAIResponsesPrivateOutput(decoderItemJSON: $0)
    }
    let byteCount = outputs.reduce(0) { total, item in
      let (next, overflowed) = total.addingReportingOverflow(item.encodedByteCount)
      return overflowed ? .max : next
    }
    guard byteCount <= BrokerDirectContinuationAuthority.maximumStateByteCount else {
      throw CodecFailure.invalid
    }
    return BrokerDirectContinuationRecord(
      handle: decodedHandle,
      binding: decodedBinding,
      outputItems: outputs,
      createdAt: date(createdAtMilliseconds)
    )
  }
}

private struct PersistedHandle: Codable, Equatable {
  let id: String
  let storageClass: String
  let recursSessionID: String
  let connectionID: String
  let adapterID: String
  let modelID: String
  let backendFingerprint: String
  let stateVersion: UInt16
  let originTurnID: String
  let continuationSequence: UInt64
  let status: String

  init(_ handle: BrokerDirectContinuationHandle) {
    id = handle.id
    storageClass = handle.storageClass.rawValue
    recursSessionID = handle.recursSessionID
    connectionID = handle.connectionID
    adapterID = handle.adapterID
    modelID = handle.modelID
    backendFingerprint = handle.backendFingerprint
    stateVersion = handle.stateVersion
    originTurnID = handle.originTurnID
    continuationSequence = handle.continuationSequence
    status = handle.status.rawValue
  }

  func value() throws -> BrokerDirectContinuationHandle {
    guard id == id.lowercased(), UUID(uuidString: id)?.uuidString.lowercased() == id,
      storageClass == BrokerDirectContinuationStorageClass.persistentBroker.rawValue,
      stateVersion == BrokerDirectContinuationAuthority.stateVersion,
      continuationSequence > 0,
      status == BrokerDirectContinuationStatus.committed.rawValue
    else { throw CodecFailure.invalid }
    return BrokerDirectContinuationHandle(
      id: id,
      storageClass: .persistentBroker,
      recursSessionID: recursSessionID,
      connectionID: connectionID,
      adapterID: adapterID,
      modelID: modelID,
      backendFingerprint: backendFingerprint,
      stateVersion: stateVersion,
      originTurnID: originTurnID,
      continuationSequence: continuationSequence,
      status: .committed
    )
  }
}

private struct PersistedBinding: Codable, Equatable {
  let authorizationID: String
  let sessionID: String
  let connectionID: String
  let adapterID: String
  let modelID: String
  let backendFingerprint: String
  let turnID: String
  let expectedSessionRecordSequence: UInt64
  let expiresAtMilliseconds: UInt64

  init(_ binding: BrokerDirectContinuationWriteBinding) throws {
    authorizationID = binding.authorizationID
    sessionID = binding.sessionID
    connectionID = binding.connectionID
    adapterID = binding.adapterID
    modelID = binding.modelID
    backendFingerprint = binding.backendFingerprint
    turnID = binding.turnID
    expectedSessionRecordSequence = binding.expectedSessionRecordSequence
    expiresAtMilliseconds = try milliseconds(binding.expiresAt)
  }

  func value() throws -> BrokerDirectContinuationWriteBinding {
    guard expiresAtMilliseconds > 0 else { throw CodecFailure.invalid }
    return BrokerDirectContinuationWriteBinding(
      authorizationID: authorizationID,
      sessionID: sessionID,
      connectionID: connectionID,
      adapterID: adapterID,
      modelID: modelID,
      backendFingerprint: backendFingerprint,
      turnID: turnID,
      expectedSessionRecordSequence: expectedSessionRecordSequence,
      expiresAt: date(expiresAtMilliseconds)
    )
  }
}

private func milliseconds(_ date: Date) throws -> UInt64 {
  let value = date.timeIntervalSince1970 * 1_000
  guard value.isFinite, value >= 0, value <= Double(UInt64.max) else {
    throw CodecFailure.invalid
  }
  return UInt64(value.rounded(.down))
}

private func date(_ milliseconds: UInt64) -> Date {
  Date(timeIntervalSince1970: Double(milliseconds) / 1_000)
}
