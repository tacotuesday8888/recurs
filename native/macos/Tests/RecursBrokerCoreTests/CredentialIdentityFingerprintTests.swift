import Foundation
import Testing

@testable import RecursBrokerCore

@Suite("Credential identity fingerprints")
struct CredentialIdentityFingerprintTests {
  @Test
  func acceptsOnlyCanonicalLowercaseSHA256Values() throws {
    let rawValue = "sha256:" + String(repeating: "0123456789abcdef", count: 4)
    let fingerprint = try CredentialIdentityFingerprint(validating: rawValue)

    #expect(fingerprint.rawValue == rawValue)
    #expect(fingerprint.description == "<credential-identity-fingerprint>")
    #expect(fingerprint.debugDescription == "<credential-identity-fingerprint>")
    #expect(Array(Mirror(reflecting: fingerprint).children).isEmpty)

    for rejected in [
      "",
      "sha256:",
      "sha256:" + String(repeating: "0", count: 63),
      "sha256:" + String(repeating: "0", count: 65),
      "SHA256:" + String(repeating: "0", count: 64),
      "sha256:" + String(repeating: "A", count: 64),
      "sha256:" + String(repeating: "g", count: 64),
      "sha512:" + String(repeating: "0", count: 64),
    ] {
      #expect(throws: CredentialIdentityFingerprintError.invalidFingerprint) {
        _ = try CredentialIdentityFingerprint(validating: rejected)
      }
    }
  }

  @Test
  func canonicalBindingEncodingIsVersionedAndExact() throws {
    let openAI = try CredentialIdentityBindingEncoder.encode(.openAI)
    let custom = try CredentialIdentityBindingEncoder.encode(
      .customOpenAICompatible(
        baseURL: "https://gateway.vendor.dev:8443/openai",
        modelCatalogBehavior: .unavailable
      )
    )

    #expect(
      openAI.hex
        == "52434249010000000a6f70656e61692d6170690000000d6f70656e61695f6170695f763100000000"
    )
    #expect(
      custom.hex == "524342490100000018637573746f6d2d6f70656e61692d636f6d70617469626c65"
        + "0000001b637573746f6d5f6f70656e61695f636f6d70617469626c655f76310100"
        + "000012676174657761792e76656e646f722e6465760120fb01000000072f6f7065"
        + "6e6169010000000b756e617661696c61626c65"
    )
  }

  @Test
  func everyBoundProviderFieldChangesTheCanonicalEncoding() throws {
    let bindings: [ProviderProfileBinding] = [
      .openAI,
      .anthropic,
      .kimiCode,
      try .customOpenAICompatible(baseURL: "https://one.vendor.dev/v1"),
      try .customOpenAICompatible(baseURL: "https://two.vendor.dev/v1"),
      try .customOpenAICompatible(baseURL: "https://one.vendor.dev:8443/v1"),
      try .customOpenAICompatible(baseURL: "https://one.vendor.dev/v2"),
      try .customOpenAICompatible(
        baseURL: "https://one.vendor.dev/v1",
        modelCatalogBehavior: .unavailable
      ),
    ]

    let encodings = try bindings.map(CredentialIdentityBindingEncoder.encode)
    #expect(Set(encodings).count == bindings.count)
  }

  @Test
  func invalidStoredBindingsFailBeforeTheyCanBeEncoded() {
    #expect(throws: ProviderProfileBindingError.invalidBinding) {
      _ = try ProviderProfileBinding.validatingStoredFields(
        providerID: "openai-api",
        activationProfileID: "openai_api_v1",
        customHost: "api.openai.com"
      )
    }
    #expect(throws: ProviderProfileBindingError.invalidBinding) {
      _ = try ProviderProfileBinding.validatingStoredFields(
        providerID: "custom-openai-compatible",
        activationProfileID: "custom_openai_compatible_v1",
        customHost: "gateway.vendor.dev",
        customBasePath: "/v1",
        customModelCatalogBehavior: "unknown"
      )
    }
  }

  @Test
  func errorsHaveFixedNonReflectiveDescriptions() {
    let cases: [(CredentialIdentityFingerprintError, String)] = [
      (.invalidFingerprint, "The credential identity fingerprint is invalid."),
      (.invalidCredential, "The credential is invalid."),
      (.invalidBinding, "The provider profile binding is invalid."),
      (.keyUnavailable, "The credential identity key is unavailable."),
      (.keyMalformed, "The credential identity key is invalid."),
    ]

    for (error, description) in cases {
      #expect(error.description == description)
      #expect(error.debugDescription == description)
      #expect(error.localizedDescription == description)
      #expect(Array(Mirror(reflecting: error).children).isEmpty)
    }
  }
}

extension Data {
  fileprivate var hex: String {
    map { String(format: "%02x", $0) }.joined()
  }
}
