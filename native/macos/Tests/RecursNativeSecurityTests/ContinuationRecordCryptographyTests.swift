import Foundation
import Testing

@testable import RecursNativeSecurity

struct ContinuationRecordCryptographyTests {
  @Test
  func sealsWithAuthenticatedContextAndRejectsTampering() async throws {
    let cryptography = ContinuationRecordCryptography(
      keySource: { Data(UInt8.min...31) }
    )
    let plaintext = Data("private reasoning".utf8)
    let context = Data("record-id".utf8)

    let sealed = try await cryptography.seal(plaintext, authenticating: context)

    #expect(sealed != plaintext)
    #expect(try await cryptography.open(sealed, authenticating: context) == plaintext)
    await #expect(throws: ContinuationRecordCryptographyError.authenticationFailed) {
      _ = try await cryptography.open(sealed, authenticating: Data("other-id".utf8))
    }
    var tampered = sealed
    tampered[tampered.startIndex] ^= 1
    await #expect(throws: ContinuationRecordCryptographyError.authenticationFailed) {
      _ = try await cryptography.open(tampered, authenticating: context)
    }
  }

  @Test
  func rejectsInvalidKeysAndOversizedInputs() async {
    let invalidKey = ContinuationRecordCryptography(
      keySource: { Data(repeating: 0, count: 31) }
    )
    await #expect(throws: ContinuationRecordCryptographyError.unavailable) {
      _ = try await invalidKey.seal(Data([1]), authenticating: Data([2]))
    }

    let valid = ContinuationRecordCryptography(
      keySource: { Data(repeating: 0, count: 32) }
    )
    await #expect(throws: ContinuationRecordCryptographyError.invalidInput) {
      _ = try await valid.seal(
        Data(repeating: 0, count: ContinuationRecordCryptography.maximumPlaintextByteCount + 1),
        authenticating: Data([2])
      )
    }
  }
}
