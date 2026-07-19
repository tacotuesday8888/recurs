import Foundation
import Testing

@testable import RecursBrokerService

struct BrokerDirectContinuationAuthorityTests {
  @Test
  func mintsOpaqueBoundHandlesAndReplaysOnlyFromTheActiveTranscript() async throws {
    let records = MemoryDirectContinuationRecords()
    let authority = BrokerDirectContinuationAuthority(
      records: records,
      idSource: { UUID(uuidString: "81000000-0000-4000-8000-000000000001")! },
      clock: { Date(timeIntervalSince1970: 100) }
    )
    let binding = directBinding()
    let output = try privateOutput("reasoning-1")

    let handle = try await authority.put(
      binding: binding,
      previous: nil,
      outputItems: [output]
    )

    #expect(handle.id == "81000000-0000-4000-8000-000000000001")
    #expect(handle.storageClass == .persistentBroker)
    #expect(handle.recursSessionID == binding.sessionID)
    #expect(handle.connectionID == binding.connectionID)
    #expect(handle.backendFingerprint == binding.backendFingerprint)
    #expect(handle.originTurnID == binding.turnID)
    #expect(handle.continuationSequence == 1)
    #expect(handle.status == .committed)
    #expect(String(describing: handle).contains("reasoning-1") == false)

    let replay = directReplayBinding(binding, turnID: "turn-2")
    let loaded = try await authority.load(
      handle,
      binding: replay,
      activeHandleIDs: [handle.id]
    )
    #expect(loaded == [output])

    await #expect(throws: BrokerDirectContinuationError.invalidCapability) {
      _ = try await authority.load(
        handle,
        binding: replay,
        activeHandleIDs: []
      )
    }
    await #expect(throws: BrokerDirectContinuationError.bindingMismatch) {
      _ = try await authority.load(
        handle,
        binding: directReplayBinding(
          binding,
          turnID: "turn-2",
          backendFingerprint: "sha256:\(String(repeating: "d", count: 64))"
        ),
        activeHandleIDs: [handle.id]
      )
    }
  }

  @Test
  func derivesTheNextSequenceFromTheExactCommittedPredecessor() async throws {
    let records = MemoryDirectContinuationRecords()
    let ids = LockedContinuationIDs([
      UUID(uuidString: "81000000-0000-4000-8000-000000000001")!,
      UUID(uuidString: "81000000-0000-4000-8000-000000000002")!,
    ])
    let authority = BrokerDirectContinuationAuthority(
      records: records,
      idSource: { ids.next() },
      clock: { Date(timeIntervalSince1970: 100) }
    )
    let firstBinding = directBinding()
    let first = try await authority.put(
      binding: firstBinding,
      previous: nil,
      outputItems: [try privateOutput("reasoning-1")]
    )
    let secondBinding = directBinding(turnID: "turn-2", expectedRecordSequence: 8)
    let second = try await authority.put(
      binding: secondBinding,
      previous: first,
      outputItems: [try privateOutput("reasoning-2")]
    )

    #expect(second.continuationSequence == 2)
    await #expect(throws: BrokerDirectContinuationError.bindingMismatch) {
      _ = try await authority.put(
        binding: directBinding(turnID: "turn-3", expectedRecordSequence: 9),
        previous: BrokerDirectContinuationHandle(
          id: first.id,
          storageClass: first.storageClass,
          recursSessionID: first.recursSessionID,
          connectionID: first.connectionID,
          adapterID: first.adapterID,
          modelID: first.modelID,
          backendFingerprint: first.backendFingerprint,
          stateVersion: first.stateVersion,
          originTurnID: first.originTurnID,
          continuationSequence: 9,
          status: first.status
        ),
        outputItems: [try privateOutput("reasoning-3")]
      )
    }
  }

  @Test
  func rejectsExpiredCapabilitiesAndOversizedStateBeforePersistence() async throws {
    let records = MemoryDirectContinuationRecords()
    let authority = BrokerDirectContinuationAuthority(
      records: records,
      clock: { Date(timeIntervalSince1970: 300) }
    )

    await #expect(throws: BrokerDirectContinuationError.expired) {
      _ = try await authority.put(
        binding: directBinding(),
        previous: nil,
        outputItems: [try privateOutput("reasoning-1")]
      )
    }

    let currentAuthority = BrokerDirectContinuationAuthority(
      records: records,
      clock: { Date(timeIntervalSince1970: 100) }
    )
    let oversized = try (0..<17).map { index in
      try privateOutput("reasoning-\(index)", encryptedByteCount: 1_000_000)
    }
    await #expect(throws: BrokerDirectContinuationError.stateTooLarge) {
      _ = try await currentAuthority.put(
        binding: directBinding(),
        previous: nil,
        outputItems: oversized
      )
    }
  }
}

private func directBinding(
  turnID: String = "turn-1",
  expectedRecordSequence: UInt64 = 3
) -> BrokerDirectContinuationWriteBinding {
  BrokerDirectContinuationWriteBinding(
    authorizationID: "authorization-1",
    sessionID: "session-1",
    connectionID: "71000000-0000-4000-8000-000000000001",
    adapterID: "openai-responses",
    modelID: "gpt-5.6-sol",
    backendFingerprint: "sha256:\(String(repeating: "a", count: 64))",
    turnID: turnID,
    expectedSessionRecordSequence: expectedRecordSequence,
    expiresAt: Date(timeIntervalSince1970: 200)
  )
}

private func directReplayBinding(
  _ binding: BrokerDirectContinuationWriteBinding,
  turnID: String,
  backendFingerprint: String? = nil
) -> BrokerDirectContinuationReplayBinding {
  BrokerDirectContinuationReplayBinding(
    authorizationID: "authorization-2",
    sessionID: binding.sessionID,
    connectionID: binding.connectionID,
    adapterID: binding.adapterID,
    modelID: binding.modelID,
    backendFingerprint: backendFingerprint ?? binding.backendFingerprint,
    turnID: turnID,
    expectedSessionRecordSequence: binding.expectedSessionRecordSequence + 1,
    expiresAt: Date(timeIntervalSince1970: 200)
  )
}

private func privateOutput(
  _ id: String,
  encryptedByteCount: Int = 6
) throws -> BrokerOpenAIResponsesPrivateOutput {
  let encrypted = String(repeating: "a", count: encryptedByteCount)
  return try BrokerOpenAIResponsesPrivateOutput(
    decoderItemJSON: Data(
      #"{"id":"\#(id)","type":"reasoning","status":"completed","summary":[],"encrypted_content":"\#(encrypted)"}"#.utf8
    )
  )
}

private actor MemoryDirectContinuationRecords:
  BrokerDirectContinuationRecordStoring
{
  private var values: [String: BrokerDirectContinuationRecord] = [:]

  func insert(_ record: BrokerDirectContinuationRecord) throws {
    guard values[record.handle.id] == nil else {
      throw BrokerDirectContinuationRecordError.conflict
    }
    values[record.handle.id] = record
  }

  func read(id: String) -> BrokerDirectContinuationRecord? {
    values[id]
  }

  func remove(id: String) {
    values[id] = nil
  }
}

private final class LockedContinuationIDs: @unchecked Sendable {
  private let lock = NSLock()
  private var values: [UUID]

  init(_ values: [UUID]) {
    self.values = values
  }

  func next() -> UUID? {
    lock.withLock {
      values.isEmpty ? nil : values.removeFirst()
    }
  }
}
