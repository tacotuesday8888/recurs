import Foundation
import RecursBrokerCore

protocol BrokerOpenAISetupRouteAuthorizing: BrokerOpenAIModelCatalogRouteAuthorizing {
  func issueSetup(
    connectionID: UUID,
    attemptID: UUID,
    expectedFence: UInt64,
    expiresAt: Date,
    requestBudget: UInt64,
    byteBudget: UInt64
  ) async throws -> Capability

  func cancel(_ handle: Capability) async
  func close() async
}

extension BrokerProviderRouteAuthority: BrokerOpenAISetupRouteAuthorizing {}

struct BrokerOpenAISetupCatalogFetcher<
  Route: BrokerOpenAISetupRouteAuthorizing,
  Network: BrokerOpenAIModelCatalogNetworking
>: BrokerOpenAISetupCatalogFetching, Sendable {
  private let route: Route
  private let transport: BrokerOpenAIModelCatalogTransport<Route, Network>

  init(route: Route, network: Network) {
    self.route = route
    transport = BrokerOpenAIModelCatalogTransport(route: route, network: network)
  }

  func fetchSetupCatalog(
    context: BrokerOpenAIOnboardingStagingContext,
    expiresAt: Date
  ) async throws -> BrokerOpenAIModelCatalog {
    let capability: Route.Capability
    do {
      capability = try await route.issueSetup(
        connectionID: context.connectionID,
        attemptID: context.attemptID,
        expectedFence: context.fence,
        expiresAt: expiresAt,
        requestBudget: 1,
        byteBudget: 0
      )
    } catch {
      await route.close()
      throw error
    }

    do {
      let catalog = try await transport.fetch(capability: capability, use: .setup)
      await cleanup(capability)
      return catalog
    } catch {
      await cleanup(capability)
      throw error
    }
  }

  private func cleanup(_ capability: Route.Capability) async {
    await route.cancel(capability)
    await route.close()
  }
}
