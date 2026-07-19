import Foundation
import Testing

@testable import RecursBrokerService
@testable import RecursNativeSecurity

struct FileBrokerDirectContinuationRecordStoreTests {
  @Test
  func persistsEncryptedExclusiveRecordsAndRemovesThem() async throws {
    let directory = FileManager.default.temporaryDirectory
      .appending(path: UUID().uuidString.lowercased(), directoryHint: .isDirectory)
    try FileManager.default.createDirectory(
      at: directory,
      withIntermediateDirectories: false,
      attributes: [.posixPermissions: 0o700]
    )
    defer { try? FileManager.default.removeItem(at: directory) }
    let cryptography = ContinuationRecordCryptography(
      keySource: { Data(UInt8.min...31) }
    )
    let store = try FileBrokerDirectContinuationRecordStore(
      directoryURL: directory,
      cryptography: cryptography
    )
    let record = try fileStoreRecord()

    try await store.insert(record)

    let file = directory.appending(path: "\(record.handle.id).rcdc")
    let persisted = try Data(contentsOf: file)
    #expect(persisted.range(of: Data("opaque".utf8)) == nil)
    #expect(try await store.read(id: record.handle.id) == record)
    await #expect(throws: BrokerDirectContinuationRecordError.conflict) {
      try await store.insert(record)
    }

    try await store.remove(id: record.handle.id)
    #expect(try await store.read(id: record.handle.id) == nil)
  }

  @Test
  func rejectsTamperingAndUnsafeDirectories() async throws {
    let directory = FileManager.default.temporaryDirectory
      .appending(path: UUID().uuidString.lowercased(), directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    defer { try? FileManager.default.removeItem(at: directory) }
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
    let cryptography = ContinuationRecordCryptography(
      keySource: { Data(UInt8.min...31) }
    )
    let store = try FileBrokerDirectContinuationRecordStore(
      directoryURL: directory,
      cryptography: cryptography
    )
    let record = try fileStoreRecord()
    try await store.insert(record)
    let file = directory.appending(path: "\(record.handle.id).rcdc")
    var tampered = try Data(contentsOf: file)
    tampered[tampered.startIndex] ^= 1
    try tampered.write(to: file)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)

    await #expect(throws: BrokerDirectContinuationRecordError.unavailable) {
      _ = try await store.read(id: record.handle.id)
    }

    let unsafe = FileManager.default.temporaryDirectory
      .appending(path: UUID().uuidString.lowercased(), directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: unsafe, withIntermediateDirectories: false)
    defer { try? FileManager.default.removeItem(at: unsafe) }
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: unsafe.path)
    #expect(throws: BrokerDirectContinuationRecordError.unavailable) {
      _ = try FileBrokerDirectContinuationRecordStore(
        directoryURL: unsafe,
        cryptography: cryptography
      )
    }
  }
}

private func fileStoreRecord() throws -> BrokerDirectContinuationRecord {
  let binding = BrokerDirectContinuationWriteBinding(
    authorizationID: "authorization-1",
    sessionID: "session-1",
    connectionID: "71000000-0000-4000-8000-000000000001",
    adapterID: "openai-responses",
    modelID: "gpt-5.6-sol",
    backendFingerprint: "sha256:\(String(repeating: "a", count: 64))",
    turnID: "turn-1",
    expectedSessionRecordSequence: 3,
    expiresAt: Date(timeIntervalSince1970: 200)
  )
  return BrokerDirectContinuationRecord(
    handle: BrokerDirectContinuationHandle(
      id: "81000000-0000-4000-8000-000000000001",
      storageClass: .persistentBroker,
      recursSessionID: binding.sessionID,
      connectionID: binding.connectionID,
      adapterID: binding.adapterID,
      modelID: binding.modelID,
      backendFingerprint: binding.backendFingerprint,
      stateVersion: 1,
      originTurnID: binding.turnID,
      continuationSequence: 1,
      status: .committed
    ),
    binding: binding,
    outputItems: [
      try BrokerOpenAIResponsesPrivateOutput(
        decoderItemJSON: Data(
          #"{"id":"reasoning-1","type":"reasoning","status":"completed","summary":[],"encrypted_content":"opaque"}"#
            .utf8
        )
      )
    ],
    createdAt: Date(timeIntervalSince1970: 100)
  )
}
