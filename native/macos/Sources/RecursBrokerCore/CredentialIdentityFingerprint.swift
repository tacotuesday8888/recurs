import Foundation

package enum CredentialIdentityFingerprintError:
  Error,
  Sendable,
  Equatable,
  CustomStringConvertible,
  CustomDebugStringConvertible,
  CustomReflectable,
  LocalizedError
{
  case invalidFingerprint
  case invalidCredential
  case invalidBinding
  case keyUnavailable
  case keyMalformed

  private var fixedDescription: String {
    switch self {
    case .invalidFingerprint:
      "The credential identity fingerprint is invalid."
    case .invalidCredential:
      "The credential is invalid."
    case .invalidBinding:
      "The provider profile binding is invalid."
    case .keyUnavailable:
      "The credential identity key is unavailable."
    case .keyMalformed:
      "The credential identity key is invalid."
    }
  }

  package var description: String { fixedDescription }
  package var debugDescription: String { fixedDescription }
  package var errorDescription: String? { fixedDescription }

  package var customMirror: Mirror {
    let children: [(label: String?, value: Any)] = []
    return Mirror(self, children: children, displayStyle: .enum)
  }
}

package struct CredentialIdentityFingerprint:
  Sendable,
  Hashable,
  CustomStringConvertible,
  CustomDebugStringConvertible,
  CustomReflectable
{
  package static let maximumCredentialByteCount = 16_384

  package let rawValue: String

  package init(
    validating rawValue: String
  ) throws(CredentialIdentityFingerprintError) {
    let bytes = Array(rawValue.utf8)
    let prefix = Array("sha256:".utf8)
    guard
      bytes.count == prefix.count + 64,
      bytes.prefix(prefix.count).elementsEqual(prefix),
      bytes.dropFirst(prefix.count).allSatisfy({
        (Character("0").asciiValue!...Character("9").asciiValue!).contains($0)
          || (Character("a").asciiValue!...Character("f").asciiValue!).contains($0)
      })
    else {
      throw .invalidFingerprint
    }
    self.rawValue = rawValue
  }

  package var description: String { "<credential-identity-fingerprint>" }
  package var debugDescription: String { description }

  package var customMirror: Mirror {
    let children: [(label: String?, value: Any)] = []
    return Mirror(self, children: children, displayStyle: .struct)
  }
}

package protocol CredentialIdentityFingerprinting: Sendable {
  func fingerprint(
    credential: UnsafeRawBufferPointer,
    binding: ProviderProfileBinding
  ) throws(CredentialIdentityFingerprintError) -> CredentialIdentityFingerprint
}

package enum CredentialIdentityBindingEncoder {
  private static let magic = Data("RCBI".utf8)
  private static let version: UInt8 = 1

  package static func encode(
    _ binding: ProviderProfileBinding
  ) throws(CredentialIdentityFingerprintError) -> Data {
    guard canonicalCopy(of: binding) == binding else {
      throw .invalidBinding
    }

    var data = magic
    data.append(version)
    append(binding.providerID, to: &data)
    append(binding.activationProfileID.rawValue, to: &data)
    append(binding.customHost, to: &data)
    append(binding.customPort, to: &data)
    append(binding.customBasePath, to: &data)
    append(binding.customModelCatalogBehavior?.rawValue, to: &data)
    return data
  }

  private static func canonicalCopy(
    of binding: ProviderProfileBinding
  ) -> ProviderProfileBinding? {
    try? ProviderProfileBinding.validatingStoredFields(
      providerID: binding.providerID,
      activationProfileID: binding.activationProfileID.rawValue,
      customHost: binding.customHost,
      customPort: binding.customPort.map(UInt64.init),
      customBasePath: binding.customBasePath,
      customModelCatalogBehavior: binding.customModelCatalogBehavior?.rawValue
    )
  }

  private static func append(_ value: String, to data: inout Data) {
    let bytes = Data(value.utf8)
    append(UInt32(bytes.count), to: &data)
    data.append(bytes)
  }

  private static func append(_ value: String?, to data: inout Data) {
    guard let value else {
      data.append(0)
      return
    }
    data.append(1)
    append(value, to: &data)
  }

  private static func append(_ value: UInt16?, to data: inout Data) {
    guard var value = value?.bigEndian else {
      data.append(0)
      return
    }
    data.append(1)
    withUnsafeBytes(of: &value) { data.append(contentsOf: $0) }
  }

  private static func append(_ value: UInt32, to data: inout Data) {
    var value = value.bigEndian
    withUnsafeBytes(of: &value) { data.append(contentsOf: $0) }
  }
}
