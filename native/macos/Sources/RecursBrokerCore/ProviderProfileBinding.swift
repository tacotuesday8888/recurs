import Foundation

package enum ProviderProfileBindingError:
  Error,
  Sendable,
  Equatable,
  CustomStringConvertible,
  CustomDebugStringConvertible,
  LocalizedError
{
  case invalidBinding

  private var fixedDescription: String {
    "The provider profile binding is invalid."
  }

  package var description: String { fixedDescription }
  package var debugDescription: String { fixedDescription }
  package var errorDescription: String? { fixedDescription }
}

package struct ProviderProfileBinding: Sendable, Hashable {
  package static let customProviderID = "custom-openai-compatible"

  package let providerID: String
  package let activationProfileID: ProviderActivationProfileID
  package let customHost: String?
  package let customPort: UInt16?
  package let customBasePath: String?
  package let customModelCatalogBehavior: EndpointModelCatalogBehavior?

  package static let openAI = builtIn(.openaiApiV1)
  package static let anthropic = builtIn(.anthropicApiV1)
  package static let kimiCode = builtIn(.kimiCodeV1)

  package static func customOpenAICompatible(
    baseURL: String,
    modelCatalogBehavior: EndpointModelCatalogBehavior = .modelsRoute
  ) throws(ProviderProfileBindingError) -> Self {
    do {
      return custom(
        try EndpointProfile.customOpenAICompatible(
          baseURL: baseURL,
          modelCatalogBehavior: modelCatalogBehavior
        )
      )
    } catch {
      throw .invalidBinding
    }
  }

  package static func validatingStoredFields(
    providerID: String,
    activationProfileID: String,
    customHost: String? = nil,
    customPort: UInt64? = nil,
    customBasePath: String? = nil,
    customModelCatalogBehavior: String? = nil
  ) throws(ProviderProfileBindingError) -> Self {
    guard let profileID = ProviderActivationProfileID(rawValue: activationProfileID) else {
      throw .invalidBinding
    }

    switch profileID {
    case .openaiApiV1, .anthropicApiV1, .kimiCodeV1:
      guard
        providerID == profileID.bundledProviderID,
        customHost == nil,
        customPort == nil,
        customBasePath == nil,
        customModelCatalogBehavior == nil
      else {
        throw .invalidBinding
      }
      return builtIn(profileID)

    case .customOpenaiCompatibleV1:
      guard
        providerID == customProviderID,
        let customHost,
        let customBasePath,
        let catalogRawValue = customModelCatalogBehavior,
        let catalog = EndpointModelCatalogBehavior(rawValue: catalogRawValue)
      else {
        throw .invalidBinding
      }
      let port: UInt16?
      if let customPort {
        guard (1...UInt64(UInt16.max)).contains(customPort) else {
          throw .invalidBinding
        }
        port = UInt16(customPort)
      } else {
        port = nil
      }
      do {
        let endpoint = try EndpointProfile.customOpenAICompatible(
          baseURL: customBaseURL(host: customHost, port: port, path: customBasePath),
          modelCatalogBehavior: catalog
        )
        guard
          endpoint.host == customHost,
          endpoint.port == port,
          endpoint.basePath == customBasePath
        else {
          throw ProviderProfileBindingError.invalidBinding
        }
        return custom(endpoint)
      } catch {
        throw .invalidBinding
      }
    }
  }

  package var endpointProfile: EndpointProfile {
    get throws(ProviderProfileBindingError) {
      switch activationProfileID {
      case .openaiApiV1:
        return .openAI
      case .anthropicApiV1:
        return .anthropic
      case .kimiCodeV1:
        return .kimiCode
      case .customOpenaiCompatibleV1:
        guard
          providerID == Self.customProviderID,
          let customHost,
          let customBasePath,
          let customModelCatalogBehavior
        else {
          throw .invalidBinding
        }
        do {
          return try EndpointProfile.customOpenAICompatible(
            baseURL: Self.customBaseURL(
              host: customHost,
              port: customPort,
              path: customBasePath
            ),
            modelCatalogBehavior: customModelCatalogBehavior
          )
        } catch {
          throw .invalidBinding
        }
      }
    }
  }

  private init(
    providerID: String,
    activationProfileID: ProviderActivationProfileID,
    customHost: String? = nil,
    customPort: UInt16? = nil,
    customBasePath: String? = nil,
    customModelCatalogBehavior: EndpointModelCatalogBehavior? = nil
  ) {
    self.providerID = providerID
    self.activationProfileID = activationProfileID
    self.customHost = customHost
    self.customPort = customPort
    self.customBasePath = customBasePath
    self.customModelCatalogBehavior = customModelCatalogBehavior
  }

  private static func builtIn(_ profileID: ProviderActivationProfileID) -> Self {
    guard let providerID = profileID.bundledProviderID else {
      preconditionFailure("A built-in profile must own a provider ID.")
    }
    return Self(providerID: providerID, activationProfileID: profileID)
  }

  private static func custom(_ endpoint: EndpointProfile) -> Self {
    Self(
      providerID: customProviderID,
      activationProfileID: .customOpenaiCompatibleV1,
      customHost: endpoint.host,
      customPort: endpoint.port,
      customBasePath: endpoint.basePath,
      customModelCatalogBehavior: endpoint.modelCatalogBehavior
    )
  }

  private static func customBaseURL(host: String, port: UInt16?, path: String) -> String {
    let origin = port.map { "https://\(host):\($0)" } ?? "https://\(host)"
    return "\(origin)\(path)"
  }
}
