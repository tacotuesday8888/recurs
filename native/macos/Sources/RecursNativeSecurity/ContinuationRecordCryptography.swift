import CryptoKit
import Foundation
import Security

package enum ContinuationRecordCryptographyError: Error, Sendable, Equatable {
  case invalidInput
  case authenticationFailed
  case unavailable
}

package protocol ContinuationRecordCryptographic: Sendable {
  func seal(_ plaintext: Data, authenticating context: Data) async throws -> Data
  func open(_ sealed: Data, authenticating context: Data) async throws -> Data
}

package actor ContinuationRecordCryptography: ContinuationRecordCryptographic {
  package static let maximumPlaintextByteCount = 24 * 1_024 * 1_024
  private static let maximumContextByteCount = 512
  private static let sealedOverheadByteCount = 28

  private let keySource: @Sendable () async throws -> Data

  package init(keySource: @escaping @Sendable () async throws -> Data) {
    self.keySource = keySource
  }

  package static func production(
    configuration: KeychainStoreConfiguration
  ) -> ContinuationRecordCryptography {
    let source = KeychainContinuationKeySource(configuration: configuration)
    return ContinuationRecordCryptography { try await source.bytes() }
  }

  package func seal(
    _ plaintext: Data,
    authenticating context: Data
  ) async throws -> Data {
    try Self.validate(plaintext: plaintext, context: context)
    let key = try await symmetricKey()
    do {
      let box = try AES.GCM.seal(plaintext, using: key, authenticating: context)
      guard let combined = box.combined,
        combined.count <= Self.maximumPlaintextByteCount + Self.sealedOverheadByteCount
      else { throw ContinuationRecordCryptographyError.unavailable }
      return combined
    } catch let error as ContinuationRecordCryptographyError {
      throw error
    } catch {
      throw ContinuationRecordCryptographyError.unavailable
    }
  }

  package func open(
    _ sealed: Data,
    authenticating context: Data
  ) async throws -> Data {
    guard !sealed.isEmpty,
      sealed.count <= Self.maximumPlaintextByteCount + Self.sealedOverheadByteCount,
      (1...Self.maximumContextByteCount).contains(context.count)
    else { throw ContinuationRecordCryptographyError.invalidInput }
    let key = try await symmetricKey()
    do {
      let box = try AES.GCM.SealedBox(combined: sealed)
      let plaintext = try AES.GCM.open(box, using: key, authenticating: context)
      guard plaintext.count <= Self.maximumPlaintextByteCount else {
        throw ContinuationRecordCryptographyError.invalidInput
      }
      return plaintext
    } catch let error as ContinuationRecordCryptographyError {
      throw error
    } catch {
      throw ContinuationRecordCryptographyError.authenticationFailed
    }
  }

  private func symmetricKey() async throws -> SymmetricKey {
    var bytes: Data
    do {
      bytes = try await keySource()
    } catch {
      throw ContinuationRecordCryptographyError.unavailable
    }
    defer { eraseData(&bytes) }
    guard bytes.count == 32 else { throw ContinuationRecordCryptographyError.unavailable }
    return SymmetricKey(data: bytes)
  }

  private static func validate(plaintext: Data, context: Data) throws {
    guard !plaintext.isEmpty, plaintext.count <= maximumPlaintextByteCount,
      (1...maximumContextByteCount).contains(context.count)
    else { throw ContinuationRecordCryptographyError.invalidInput }
  }
}

private actor KeychainContinuationKeySource {
  private static let service = "com.recurs.cli.continuation-key.v1"
  private static let account = "aes-gcm-256.v1"
  private static let marker = Data("continuation-encryption-key.v1".utf8)

  private let client: KeychainClient
  private let configuration: KeychainStoreConfiguration
  private let randomBytes: @Sendable () throws -> Data

  init(configuration: KeychainStoreConfiguration) {
    client = .live
    self.configuration = configuration
    randomBytes = {
      var data = Data(repeating: 0, count: 32)
      let status = data.withUnsafeMutableBytes { bytes in
        SecRandomCopyBytes(kSecRandomDefault, bytes.count, bytes.baseAddress!)
      }
      guard status == errSecSuccess else {
        throw ContinuationRecordCryptographyError.unavailable
      }
      return data
    }
  }

  func bytes() throws -> Data {
    if let existing = try load() { return existing }
    var candidate: Data
    do {
      candidate = try randomBytes()
    } catch {
      throw ContinuationRecordCryptographyError.unavailable
    }
    guard candidate.count == 32 else {
      eraseData(&candidate)
      throw ContinuationRecordCryptographyError.unavailable
    }
    defer { eraseData(&candidate) }
    let status = client.add(
      baseQuery().adding([
        kSecAttrAccount: Self.account,
        kSecValueData: candidate,
      ])
    )
    if status == errSecSuccess { return candidate }
    guard let selected = try load() else {
      throw ContinuationRecordCryptographyError.unavailable
    }
    return selected
  }

  private func load() throws -> Data? {
    let result = client.copyMatching(
      baseQuery(includeMarker: false).adding([
        kSecAttrAccount: Self.account,
        kSecReturnData: true,
        kSecReturnAttributes: true,
        kSecMatchLimit: kSecMatchLimitOne,
      ])
    )
    switch result.status {
    case errSecItemNotFound:
      return nil
    case errSecSuccess:
      guard result.items.count == 1,
        result.items[0].account == Self.account,
        result.items[0].data.count == 32,
        result.items[0].generic == Self.marker
      else { throw ContinuationRecordCryptographyError.authenticationFailed }
      return result.items[0].data
    default:
      throw ContinuationRecordCryptographyError.unavailable
    }
  }

  private func baseQuery(includeMarker: Bool = true) -> KeychainQuery {
    KeychainQuery.base(
      configuration: configuration,
      service: Self.service,
      generic: includeMarker ? Self.marker : nil
    )
  }
}
