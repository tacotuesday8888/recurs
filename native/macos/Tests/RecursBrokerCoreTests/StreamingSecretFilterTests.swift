import Foundation
import Testing

@testable import RecursBrokerCore

@Suite("Streaming exact-secret filter")
struct StreamingSecretFilterTests {
  private let secret = Data("RECURS_NATIVE_SECRET_CANARY_79A2".utf8)
  private let bearer = Data("Bearer RECURS_NATIVE_SECRET_CANARY_79A2".utf8)

  @Test
  func filterCanTravelWithASendablePreparedRequest() throws {
    let filter = try makeFilter()
    requireSendable(filter)
    filter.cancel()
  }

  @Test
  func everySecretAndAuthorizationSplitTerminatesBeforeAnyPrefixIsEmitted() throws {
    for pattern in [secret, bearer] {
      for split in 0...pattern.count {
        let filter = try makeFilter()
        var emitted = Data()
        var detected = false
        let splitIndex = pattern.index(pattern.startIndex, offsetBy: split)
        for chunk in [Data(pattern[..<splitIndex]), Data(pattern[splitIndex...])] {
          do {
            emitted.append(try filter.process(chunk))
          } catch {
            #expect(error == .credentialEchoDetected)
            detected = true
            break
          }
        }
        #expect(detected)
        #expect(emitted.isEmpty)
        #expect(filter.bufferedByteCount == 0)
      }
    }
  }

  @Test
  func nonmatchingStreamsRoundTripByteForByteAcrossEverySplit() throws {
    let input = Data("safe response with Bear and RECURS_NATIVE_OTHER_CANARY_79A2 bytes".utf8)
    for split in 0...input.count {
      let filter = try makeFilter()
      var output = Data()
      output.append(try filter.process(Data(input.prefix(split))))
      output.append(try filter.process(Data(input.dropFirst(split))))
      output.append(try filter.finish())
      #expect(output == input)
      #expect(filter.bufferedByteCount == 0)
    }
  }

  @Test
  func overlappingPatternsAndExactEOFMatchFailClosed() throws {
    let first = SecretFilterAlias(SecretBytes(Data("aba".utf8)))
    let second = SecretFilterAlias(SecretBytes(Data("bab".utf8)))
    let filter = try StreamingSecretFilter(patterns: [first.value, second.value])
    #expect(first.isErased())
    #expect(second.isErased())
    #expect(try filter.process(Data("safe-".utf8)) == Data("safe-".utf8))
    #expect(try filter.process(Data("ab".utf8)).isEmpty)
    #expect(throws: StreamingSecretFilterError.credentialEchoDetected) {
      _ = try filter.process(Data("a".utf8))
    }

    let eofFilter = try makeFilter()
    #expect(try eofFilter.process(Data(secret.dropLast())).isEmpty)
    #expect(throws: StreamingSecretFilterError.credentialEchoDetected) {
      _ = try eofFilter.process(Data(secret.suffix(1)))
    }
  }

  @Test
  func lateMatchDiscardsTheWholeCurrentCallAndNeverReleasesCredentialBytes() throws {
    let sameCall = try makeFilter()
    #expect(throws: StreamingSecretFilterError.credentialEchoDetected) {
      _ = try sameCall.process(Data("safe-prefix-".utf8) + secret)
    }

    let crossingCall = try makeFilter()
    let safePrefix = Data("safe-prefix-".utf8)
    #expect(
      try crossingCall.process(safePrefix + secret.dropLast())
        == safePrefix
    )
    #expect(throws: StreamingSecretFilterError.credentialEchoDetected) {
      _ = try crossingCall.process(Data(secret.suffix(1)))
    }
    #expect(crossingCall.bufferedByteCount == 0)
  }

  @Test
  func terminalCauseCannotBeLaunderedByCancellation() throws {
    let echoed = try makeFilter()
    #expect(throws: StreamingSecretFilterError.credentialEchoDetected) {
      _ = try echoed.process(secret)
    }
    echoed.cancel()
    #expect(throws: StreamingSecretFilterError.credentialEchoDetected) {
      _ = try echoed.process(Data())
    }
    #expect(throws: StreamingSecretFilterError.credentialEchoDetected) {
      _ = try echoed.finish()
    }

    let completed = try makeFilter()
    #expect(try completed.finish().isEmpty)
    completed.cancel()
    #expect(throws: StreamingSecretFilterError.alreadyFinished) {
      _ = try completed.process(Data())
    }
  }

  @Test
  func binaryAndSingleBytePatternsPreserveOnlyProvenSafeBytes() throws {
    let filter = try StreamingSecretFilter(patterns: [SecretBytes(Data([0xff]))])
    let safe = Data([0x00, 0x01, 0x7f, 0xfe])
    #expect(try filter.process(safe) == safe)
    #expect(try filter.finish().isEmpty)

    let match = try StreamingSecretFilter(patterns: [SecretBytes(Data([0xff]))])
    #expect(throws: StreamingSecretFilterError.credentialEchoDetected) {
      _ = try match.process(Data([0xff]))
    }
  }

  @Test
  func patternCountAndAggregateBytesAreBoundedAndInputsAreErased() throws {
    let tooMany = (0..<9).map { index in
      SecretFilterAlias(SecretBytes(Data("pattern-\(index)".utf8)))
    }
    #expect(throws: StreamingSecretFilterError.patternLimitExceeded) {
      _ = try StreamingSecretFilter(patterns: tooMany.map(\.value))
    }
    #expect(tooMany.allSatisfy { $0.isErased() })

    let tooLarge = (0..<8).map { index in
      var bytes = Data(repeating: UInt8(index + 1), count: 8_193)
      bytes.append(UInt8(index))
      return SecretFilterAlias(SecretBytes(bytes))
    }
    #expect(throws: StreamingSecretFilterError.patternLimitExceeded) {
      _ = try StreamingSecretFilter(patterns: tooLarge.map(\.value))
    }
    #expect(tooLarge.allSatisfy { $0.isErased() })

    let boundary = SecretFilterAlias(SecretBytes(Data(repeating: 0x41, count: 65_536)))
    let accepted = try StreamingSecretFilter(patterns: [boundary.value])
    #expect(boundary.isErased())
    accepted.cancel()
  }

  @Test
  func matcherFallsBackWithoutDroppingNonmatchingOverlaps() throws {
    let filter = try StreamingSecretFilter(patterns: [SecretBytes(Data("ABABAC".utf8))])
    let input = Data("ABABABX".utf8)
    var output = try filter.process(input)
    output.append(try filter.finish())
    #expect(output == input)
  }

  @Test
  func completionCancellationAndEmptyPatternsEraseAllBufferedAuthority() throws {
    let empty = SecretFilterAlias(SecretBytes(Data()))
    #expect(throws: StreamingSecretFilterError.emptyPattern) {
      _ = try StreamingSecretFilter(patterns: [empty.value])
    }
    #expect(empty.isErased())

    let completed = try makeFilter()
    #expect(try completed.process(Data(secret.prefix(8))).isEmpty)
    #expect(try completed.finish() == Data(secret.prefix(8)))
    #expect(completed.bufferedByteCount == 0)
    #expect(throws: StreamingSecretFilterError.alreadyFinished) {
      _ = try completed.process(Data([1]))
    }

    let cancelled = try makeFilter()
    #expect(try cancelled.process(Data(secret.prefix(8))).isEmpty)
    cancelled.cancel()
    cancelled.cancel()
    #expect(cancelled.bufferedByteCount == 0)
    #expect(throws: StreamingSecretFilterError.cancelled) {
      _ = try cancelled.process(Data([1]))
    }
    #expect(throws: StreamingSecretFilterError.cancelled) {
      _ = try cancelled.finish()
    }
    #expect(Array(Mirror(reflecting: cancelled).children).isEmpty)
  }

  @Test
  func lookbehindNeverExceedsLongestPatternMinusOne() throws {
    let filter = try makeFilter()
    let chunks = [
      Data(repeating: Character("x").asciiValue!, count: 4_096),
      Data("RECURS_NATIVE_SECRET_CANARY_79".utf8),
      Data("safe-tail".utf8),
    ]
    var output = Data()
    for chunk in chunks {
      output.append(try filter.process(chunk))
      #expect(filter.bufferedByteCount <= bearer.count - 1)
    }
    output.append(try filter.finish())
    #expect(output == chunks.reduce(into: Data()) { $0.append($1) })
  }

  @Test
  func maximumSelfOverlappingPatternUsesLinearRingOperations() throws {
    var pattern = Data(repeating: Character("A").asciiValue!, count: 65_535)
    pattern.append(Character("B").asciiValue!)
    let filter = try StreamingSecretFilter(patterns: [SecretBytes(pattern)])
    let input = Data(repeating: Character("A").asciiValue!, count: 262_144)

    var output = try filter.process(input)
    #expect(filter.bufferedByteCount == 65_535)
    #expect(filter.storageOperationCount <= input.count * 2)
    output.append(try filter.finish())
    #expect(output == input)
  }

  @Test
  func concurrentProcessingAndCancellationRemainFailClosed() async throws {
    let filter = try makeFilter()
    let errors = await withTaskGroup(
      of: StreamingSecretFilterError?.self,
      returning: [StreamingSecretFilterError].self
    ) { group in
      for _ in 0..<32 {
        group.addTask {
          do {
            _ = try filter.process(Data("safe-provider-bytes".utf8))
            return nil
          } catch let error as StreamingSecretFilterError {
            return error
          } catch {
            Issue.record("Unexpected non-filter error: \(error)")
            return .credentialEchoDetected
          }
        }
      }
      group.addTask {
        filter.cancel()
        return nil
      }

      var selected: [StreamingSecretFilterError] = []
      for await error in group {
        if let error {
          selected.append(error)
        }
      }
      return selected
    }

    #expect(errors.allSatisfy { $0 == StreamingSecretFilterError.cancelled })
    #expect(filter.bufferedByteCount == 0)
    #expect(throws: StreamingSecretFilterError.cancelled) {
      _ = try filter.finish()
    }
  }

  private func makeFilter() throws -> StreamingSecretFilter {
    try StreamingSecretFilter(
      patterns: [SecretBytes(secret), SecretBytes(bearer)]
    )
  }
}

private func requireSendable<Value: Sendable>(_ value: Value) {
  _ = value
}

private final class SecretFilterAlias: @unchecked Sendable {
  let value: SecretBytes

  init(_ value: SecretBytes) {
    self.value = value
  }

  func isErased() -> Bool {
    value.withUnsafeBytes(\.isEmpty)
  }
}
