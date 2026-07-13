import CryptoKit
import Foundation
import RecursBrokerCore
import Security

package struct KeychainCredentialIdentityFingerprinter:
  CredentialIdentityFingerprinting,
  CustomStringConvertible,
  CustomDebugStringConvertible,
  CustomReflectable
{
  private static let keyByteCount = 32
  private static let domainSeparator = Data("recurs/credential-subject/v1".utf8)
  private static let keyService = "com.recurs.cli.credential-identity-key.v1"
  private static let keyAccount = "hmac-sha256.v1"
  private static let keyMarker = Data("credential-identity-key.v1".utf8)

  private let client: KeychainClient
  private let configuration: KeychainStoreConfiguration
  private let randomBytes: @Sendable () throws -> Data

  package init(configuration: KeychainStoreConfiguration) {
    self.client = .live
    self.configuration = configuration
    self.randomBytes = {
      var data = Data(repeating: 0, count: Self.keyByteCount)
      let status = data.withUnsafeMutableBytes { bytes in
        SecRandomCopyBytes(kSecRandomDefault, bytes.count, bytes.baseAddress!)
      }
      guard status == errSecSuccess else {
        eraseData(&data)
        throw CredentialIdentityFingerprintError.keyUnavailable
      }
      return data
    }
  }

  init(
    client: KeychainClient,
    configuration: KeychainStoreConfiguration,
    randomBytes: @escaping @Sendable () throws -> Data
  ) {
    self.client = client
    self.configuration = configuration
    self.randomBytes = randomBytes
  }

  package var description: String { "<credential-identity-fingerprinter>" }
  package var debugDescription: String { "<credential-identity-fingerprinter>" }

  package var customMirror: Mirror {
    let children: [(label: String?, value: Any)] = []
    return Mirror(self, children: children, displayStyle: .struct)
  }

  package func fingerprint(
    credential: UnsafeRawBufferPointer,
    binding: ProviderProfileBinding
  ) throws(CredentialIdentityFingerprintError) -> CredentialIdentityFingerprint {
    guard
      (1...CredentialIdentityFingerprint.maximumCredentialByteCount).contains(
        credential.count
      )
    else {
      throw .invalidCredential
    }

    let canonicalBinding = try CredentialIdentityBindingEncoder.encode(binding)
    var keyData = try selectedKeyData()
    defer { eraseData(&keyData) }

    var input = Self.domainSeparator
    input.append(0)
    Self.append(UInt32(canonicalBinding.count), to: &input)
    input.append(canonicalBinding)
    Self.append(UInt32(credential.count), to: &input)
    input.append(contentsOf: credential)
    defer { eraseData(&input) }

    let code = HMAC<SHA256>.authenticationCode(
      for: input,
      using: SymmetricKey(data: keyData)
    )
    return try CredentialIdentityFingerprint(
      validating: "sha256:" + Self.lowercaseHex(code)
    )
  }

  private func selectedKeyData() throws(CredentialIdentityFingerprintError) -> Data {
    if let existing = try loadKeyData() {
      return existing
    }

    var candidate: Data
    do {
      candidate = try randomBytes()
    } catch {
      throw .keyUnavailable
    }
    guard Self.isValidKeyData(candidate) else {
      eraseData(&candidate)
      throw .keyUnavailable
    }
    defer { eraseData(&candidate) }

    _ = client.add(
      keyBaseQuery().adding([
        kSecAttrAccount: Self.keyAccount,
        kSecValueData: candidate,
      ])
    )

    guard let selected = try loadKeyData() else {
      throw .keyUnavailable
    }
    return selected
  }

  private func loadKeyData() throws(CredentialIdentityFingerprintError) -> Data? {
    let result = client.copyMatching(
      keyBaseQuery(includeMarker: false).adding([
        kSecAttrAccount: Self.keyAccount,
        kSecReturnData: true,
        kSecReturnAttributes: true,
        kSecMatchLimit: kSecMatchLimitOne,
      ])
    )
    switch result.status {
    case errSecItemNotFound:
      return nil
    case errSecSuccess:
      guard
        result.items.count == 1,
        result.items[0].account == Self.keyAccount,
        result.items[0].generic == Self.keyMarker,
        Self.isValidKeyData(result.items[0].data)
      else {
        throw .keyMalformed
      }
      return result.items[0].data
    default:
      throw .keyUnavailable
    }
  }

  private func keyBaseQuery(includeMarker: Bool = true) -> KeychainQuery {
    KeychainQuery.base(
      configuration: configuration,
      service: Self.keyService,
      generic: includeMarker ? Self.keyMarker : nil
    )
  }

  private static func isValidKeyData(_ data: Data) -> Bool {
    data.count == keyByteCount && data.contains(where: { $0 != 0 })
  }

  private static func append(_ value: UInt32, to data: inout Data) {
    var value = value.bigEndian
    withUnsafeBytes(of: &value) { data.append(contentsOf: $0) }
  }

  private static func lowercaseHex<Bytes: Sequence>(_ bytes: Bytes) -> String
  where Bytes.Element == UInt8 {
    let alphabet = Array("0123456789abcdef".utf8)
    var output: [UInt8] = []
    output.reserveCapacity(64)
    for byte in bytes {
      output.append(alphabet[Int(byte >> 4)])
      output.append(alphabet[Int(byte & 0x0f)])
    }
    return String(decoding: output, as: UTF8.self)
  }
}
