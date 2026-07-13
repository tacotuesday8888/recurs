import Foundation
import Testing

@testable import RecursBrokerCore

@Suite("Provider profile bindings")
struct ProviderProfileBindingTests {
  @Test
  func builtInsOwnOnlyTheirGeneratedProviderProfilePair() throws {
    let cases: [(ProviderProfileBinding, String, ProviderActivationProfileID, EndpointProfile)] = [
      (.openAI, "openai-api", .openaiApiV1, .openAI),
      (.anthropic, "anthropic-api", .anthropicApiV1, .anthropic),
      (.kimiCode, "kimi-code", .kimiCodeV1, .kimiCode),
    ]

    for (binding, providerID, activationProfileID, endpointProfile) in cases {
      let restored = try ProviderProfileBinding.validatingStoredFields(
        providerID: providerID,
        activationProfileID: activationProfileID.rawValue
      )
      #expect(binding.providerID == providerID)
      #expect(binding.providerID == activationProfileID.bundledProviderID)
      #expect(binding.activationProfileID == activationProfileID)
      #expect(binding.customHost == nil)
      #expect(binding.customPort == nil)
      #expect(binding.customBasePath == nil)
      #expect(binding.customModelCatalogBehavior == nil)
      #expect(binding == restored)
      #expect(try binding.endpointProfile == endpointProfile)
    }
  }

  @Test
  func customFactoryRetainsOnlyCanonicalStructuralEndpointFields() throws {
    let cases:
      [(
        baseURL: String,
        behavior: EndpointModelCatalogBehavior,
        host: String,
        port: UInt16?,
        path: String
      )] = [
        ("https://gateway.vendor.dev/api/v2", .modelsRoute, "gateway.vendor.dev", nil, "/api/v2"),
        (
          "https://inference.vendor.net:8443/openai",
          .unavailable,
          "inference.vendor.net",
          8_443,
          "/openai"
        ),
      ]

    for testCase in cases {
      let binding = try ProviderProfileBinding.customOpenAICompatible(
        baseURL: testCase.baseURL,
        modelCatalogBehavior: testCase.behavior
      )
      let restored = try ProviderProfileBinding.validatingStoredFields(
        providerID: "custom-openai-compatible",
        activationProfileID: "custom_openai_compatible_v1",
        customHost: testCase.host,
        customPort: testCase.port.map(UInt64.init),
        customBasePath: testCase.path,
        customModelCatalogBehavior: testCase.behavior.rawValue
      )
      let expectedEndpoint = try EndpointProfile.customOpenAICompatible(
        baseURL: testCase.baseURL,
        modelCatalogBehavior: testCase.behavior
      )

      #expect(binding.providerID == "custom-openai-compatible")
      #expect(binding.activationProfileID == .customOpenaiCompatibleV1)
      #expect(binding.customHost == testCase.host)
      #expect(binding.customPort == testCase.port)
      #expect(binding.customBasePath == testCase.path)
      #expect(binding.customModelCatalogBehavior == testCase.behavior)
      #expect(binding == restored)
      #expect(try binding.endpointProfile == expectedEndpoint)
    }
  }

  @Test
  func storedBuiltInsRejectUnknownOrMismatchedIdentity() {
    let invalidPairs = [
      ("unknown-provider", "openai_api_v1"),
      ("openai-api", "unknown_profile_v1"),
      ("openai-api", "anthropic_api_v1"),
      ("anthropic-api", "kimi_code_v1"),
      ("kimi-code", "openai_api_v1"),
      ("custom-openai-compatible", "openai_api_v1"),
      ("openai-api", "custom_openai_compatible_v1"),
    ]

    for (providerID, activationProfileID) in invalidPairs {
      #expect(throws: ProviderProfileBindingError.invalidBinding) {
        _ = try ProviderProfileBinding.validatingStoredFields(
          providerID: providerID,
          activationProfileID: activationProfileID
        )
      }
    }
  }

  @Test
  func storedBuiltInsRejectEveryCustomField() {
    let invalidCustomFields: [StoredCustomFields] = [
      StoredCustomFields(host: "gateway.vendor.dev"),
      StoredCustomFields(port: 8_443),
      StoredCustomFields(path: "/v1"),
      StoredCustomFields(catalog: "models_route"),
    ]

    for fields in invalidCustomFields {
      #expect(throws: ProviderProfileBindingError.invalidBinding) {
        _ = try ProviderProfileBinding.validatingStoredFields(
          providerID: "openai-api",
          activationProfileID: "openai_api_v1",
          customHost: fields.host,
          customPort: fields.port,
          customBasePath: fields.path,
          customModelCatalogBehavior: fields.catalog
        )
      }
    }
  }

  @Test
  func storedCustomBindingRequiresProviderHostPathAndCatalog() {
    #expect(throws: ProviderProfileBindingError.invalidBinding) {
      _ = try ProviderProfileBinding.validatingStoredFields(
        providerID: "unknown-provider",
        activationProfileID: "custom_openai_compatible_v1",
        customHost: "gateway.vendor.dev",
        customBasePath: "/v1",
        customModelCatalogBehavior: "models_route"
      )
    }
    let incompleteFields: [StoredCustomFields] = [
      StoredCustomFields(path: "/v1", catalog: "models_route"),
      StoredCustomFields(host: "gateway.vendor.dev", catalog: "models_route"),
      StoredCustomFields(host: "gateway.vendor.dev", path: "/v1"),
    ]

    for fields in incompleteFields {
      #expect(throws: ProviderProfileBindingError.invalidBinding) {
        _ = try ProviderProfileBinding.validatingStoredFields(
          providerID: "custom-openai-compatible",
          activationProfileID: "custom_openai_compatible_v1",
          customHost: fields.host,
          customPort: fields.port,
          customBasePath: fields.path,
          customModelCatalogBehavior: fields.catalog
        )
      }
    }
  }

  @Test
  func customFactoryRejectsReservedAndNoncanonicalBases() {
    for baseURL in [
      "https://api.openai.com/v1",
      "https://api.anthropic.com/v1",
      "https://api.kimi.com/coding/v1",
      "https://GATEWAY.vendor.dev/v1",
      "https://gateway.vendor.dev:443/v1",
      "https://gateway.vendor.dev/v1/",
      "http://gateway.vendor.dev/v1",
    ] {
      #expect(throws: ProviderProfileBindingError.invalidBinding) {
        _ = try ProviderProfileBinding.customOpenAICompatible(baseURL: baseURL)
      }
    }
  }

  @Test
  func storedCustomBindingRejectsInvalidHostsPortsPathsAndCatalogs() {
    let invalidFields: [StoredCustomFields] = [
      StoredCustomFields(host: "api.openai.com", path: "/v1", catalog: "models_route"),
      StoredCustomFields(host: "GATEWAY.vendor.dev", path: "/v1", catalog: "models_route"),
      StoredCustomFields(host: "gateway.vendor.dev", port: 0, path: "/v1", catalog: "models_route"),
      StoredCustomFields(
        host: "gateway.vendor.dev", port: 443, path: "/v1", catalog: "models_route"),
      StoredCustomFields(
        host: "gateway.vendor.dev",
        port: 65_536,
        path: "/v1",
        catalog: "models_route"
      ),
      StoredCustomFields(host: "gateway.vendor.dev", path: "v1", catalog: "models_route"),
      StoredCustomFields(host: "gateway.vendor.dev", path: "/", catalog: "models_route"),
      StoredCustomFields(host: "gateway.vendor.dev", path: "/v1/", catalog: "models_route"),
      StoredCustomFields(host: "gateway.vendor.dev", path: "/v1/../admin", catalog: "models_route"),
      StoredCustomFields(host: "gateway.vendor.dev", path: "/v1", catalog: "unknown"),
    ]

    for fields in invalidFields {
      #expect(throws: ProviderProfileBindingError.invalidBinding) {
        _ = try ProviderProfileBinding.validatingStoredFields(
          providerID: "custom-openai-compatible",
          activationProfileID: "custom_openai_compatible_v1",
          customHost: fields.host,
          customPort: fields.port,
          customBasePath: fields.path,
          customModelCatalogBehavior: fields.catalog
        )
      }
    }
  }

  @Test
  func errorsAreFixedAndDoNotDiscloseRejectedInput() {
    let rejected = "https://user:private@gateway.vendor.dev/v1"

    do {
      _ = try ProviderProfileBinding.customOpenAICompatible(baseURL: rejected)
      Issue.record("Expected the binding to be rejected")
    } catch let error {
      #expect(error == .invalidBinding)
      #expect(error.description == "The provider profile binding is invalid.")
      #expect(error.debugDescription == "The provider profile binding is invalid.")
      #expect(error.localizedDescription == "The provider profile binding is invalid.")
      #expect(!error.description.contains(rejected))
      #expect(!error.debugDescription.contains(rejected))
      #expect(!error.localizedDescription.contains(rejected))
    }
  }
}

private struct StoredCustomFields {
  let host: String?
  let port: UInt64?
  let path: String?
  let catalog: String?

  init(
    host: String? = nil,
    port: UInt64? = nil,
    path: String? = nil,
    catalog: String? = nil
  ) {
    self.host = host
    self.port = port
    self.path = path
    self.catalog = catalog
  }
}
