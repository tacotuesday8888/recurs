import Foundation

struct BrokerOpenAIOnboardingSessionFactoryLive<
  Authority,
  Network
>: BrokerOpenAIOnboardingSessionFactory, Sendable
where
  Authority: BrokerCredentialLifecycleAuthority,
  Authority: BrokerProviderCredentialUseAuthority,
  Authority: BrokerProviderRouteProjectionReader,
  Network: BrokerOpenAIModelCatalogNetworking
{
  private let authority: Authority
  private let network: Network

  init(authority: Authority, network: Network) {
    self.authority = authority
    self.network = network
  }

  func makeSession(
    context: BrokerOpenAIOnboardingStagingContext,
    abortOperationID: UUID
  ) throws(BrokerOpenAIOnboardingError) -> any BrokerOpenAIOnboardingSessionProtocol {
    let route = BrokerProviderRouteAuthority(
      reader: authority,
      credentialAuthority: authority
    )
    let catalogFetcher = BrokerOpenAISetupCatalogFetcher(
      route: route,
      network: network
    )
    return try BrokerOpenAIOnboardingSession(
      context: context,
      abortOperationID: abortOperationID,
      authority: authority,
      catalogFetcher: catalogFetcher
    )
  }
}
