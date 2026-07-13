import Foundation
import Testing

@testable import RecursBrokerCore

@Suite("Native endpoint policy")
struct EndpointPolicyTests {
  @Test
  func generatedIDsFreezeTheCompleteBuiltInPolicyTuple() throws {
    let actual = try Dictionary(
      uniqueKeysWithValues: [
        EndpointProfile.openAI, .anthropic, .kimiCode,
      ].map { profile in
        (profile.activationProfileID, try snapshot(profile))
      }
    )
    let commonResponses = Set(["content-type", "request-id", "x-request-id"])
    let accept = FixedHeaderSnapshot(
      id: "accept_application_json",
      name: "accept",
      value: "application/json"
    )
    let contentType = FixedHeaderSnapshot(
      id: "content_type_application_json",
      name: "content-type",
      value: "application/json"
    )
    let client = FixedHeaderSnapshot(
      id: "recurs_client_identity",
      name: "user-agent",
      value: "recurs"
    )
    let expected: [ProviderActivationProfileID: EndpointPolicySnapshot] = [
      .openaiApiV1: EndpointPolicySnapshot(
        scheme: "https",
        host: "api.openai.com",
        port: nil,
        origin: "https://api.openai.com",
        basePath: "/v1",
        protocolFamily: "openai_responses",
        authenticationScheme: "bearer",
        modelCatalogBehavior: "models_route",
        codec: "openai_responses_v1",
        codecRevision: 1,
        compatibilityRevision: 1,
        billingPolicy: "direct_api",
        billingPolicyEvidenceRevision: 1,
        isCustomTrustedCredentialRecipient: false,
        routes: [
          "generation": RouteSnapshot(
            id: "generation",
            method: "POST",
            absoluteURL: "https://api.openai.com/v1/responses",
            fixedRequestHeaders: [accept, contentType],
            allowedResponseHeaders: commonResponses
          ),
          "model_catalog": RouteSnapshot(
            id: "model_catalog",
            method: "GET",
            absoluteURL: "https://api.openai.com/v1/models",
            fixedRequestHeaders: [accept],
            allowedResponseHeaders: commonResponses
          ),
        ]
      ),
      .anthropicApiV1: EndpointPolicySnapshot(
        scheme: "https",
        host: "api.anthropic.com",
        port: nil,
        origin: "https://api.anthropic.com",
        basePath: "/v1",
        protocolFamily: "anthropic_messages",
        authenticationScheme: "x_api_key",
        modelCatalogBehavior: "models_route",
        codec: "anthropic_messages_v1",
        codecRevision: 1,
        compatibilityRevision: 1,
        billingPolicy: "direct_api",
        billingPolicyEvidenceRevision: 1,
        isCustomTrustedCredentialRecipient: false,
        routes: [
          "generation": RouteSnapshot(
            id: "generation",
            method: "POST",
            absoluteURL: "https://api.anthropic.com/v1/messages",
            fixedRequestHeaders: [
              accept,
              contentType,
              FixedHeaderSnapshot(
                id: "anthropic_version_2023_06_01",
                name: "anthropic-version",
                value: "2023-06-01"
              ),
            ],
            allowedResponseHeaders: commonResponses
          ),
          "model_catalog": RouteSnapshot(
            id: "model_catalog",
            method: "GET",
            absoluteURL: "https://api.anthropic.com/v1/models",
            fixedRequestHeaders: [
              accept,
              FixedHeaderSnapshot(
                id: "anthropic_version_2023_06_01",
                name: "anthropic-version",
                value: "2023-06-01"
              ),
            ],
            allowedResponseHeaders: commonResponses
          ),
        ]
      ),
      .kimiCodeV1: EndpointPolicySnapshot(
        scheme: "https",
        host: "api.kimi.com",
        port: nil,
        origin: "https://api.kimi.com",
        basePath: "/coding/v1",
        protocolFamily: "openai_chat_completions",
        authenticationScheme: "bearer",
        modelCatalogBehavior: "models_route",
        codec: "openai_chat_completions_v1",
        codecRevision: 1,
        compatibilityRevision: 1,
        billingPolicy: "coding_subscription",
        billingPolicyEvidenceRevision: 1,
        isCustomTrustedCredentialRecipient: false,
        routes: [
          "generation": RouteSnapshot(
            id: "generation",
            method: "POST",
            absoluteURL: "https://api.kimi.com/coding/v1/chat/completions",
            fixedRequestHeaders: [accept, contentType, client],
            allowedResponseHeaders: commonResponses
          ),
          "model_catalog": RouteSnapshot(
            id: "model_catalog",
            method: "GET",
            absoluteURL: "https://api.kimi.com/coding/v1/models",
            fixedRequestHeaders: [accept, client],
            allowedResponseHeaders: commonResponses
          ),
        ]
      ),
    ]

    #expect(actual == expected)
    #expect(
      Set(expected.keys).union([.customOpenaiCompatibleV1])
        == Set(ProviderActivationProfileID.allCases)
    )
  }

  @Test
  func customIDFreezesPolicyWhileEndpointAndCatalogRemainBoundParameters() throws {
    let withCatalog = try EndpointProfile.customOpenAICompatible(
      baseURL: "https://gateway.vendor.dev/api/v2",
      modelCatalogBehavior: .modelsRoute
    )
    let withoutCatalog = try EndpointProfile.customOpenAICompatible(
      baseURL: "https://inference.vendor.net:8443/openai",
      modelCatalogBehavior: .unavailable
    )
    let expectedFamilies: [ProviderActivationProfileID: CustomPolicyFamilySnapshot] = [
      .customOpenaiCompatibleV1: CustomPolicyFamilySnapshot(
        activationProfileID: "custom_openai_compatible_v1",
        scheme: "https",
        protocolFamily: "openai_chat_completions",
        authenticationScheme: "bearer",
        codec: "openai_chat_completions_v1",
        codecRevision: 1,
        compatibilityRevision: 1,
        billingPolicy: "custom_trusted_recipient",
        billingPolicyEvidenceRevision: 1,
        isCustomTrustedCredentialRecipient: true,
        generationRouteID: "generation",
        generationPath: "/chat/completions",
        generationMethod: "POST",
        generationHeaders: [
          FixedHeaderSnapshot(
            id: "accept_application_json",
            name: "accept",
            value: "application/json"
          ),
          FixedHeaderSnapshot(
            id: "content_type_application_json",
            name: "content-type",
            value: "application/json"
          ),
          FixedHeaderSnapshot(
            id: "recurs_client_identity",
            name: "user-agent",
            value: "recurs"
          ),
        ],
        allowedResponseHeaders: ["content-type", "request-id", "x-request-id"]
      )
    ]

    #expect(
      try customFamilySnapshot(withCatalog)
        == expectedFamilies[withCatalog.activationProfileID]
    )
    #expect(
      try customFamilySnapshot(withoutCatalog)
        == expectedFamilies[withoutCatalog.activationProfileID]
    )
    #expect(withCatalog.host == "gateway.vendor.dev")
    #expect(withCatalog.port == nil)
    #expect(withCatalog.basePath == "/api/v2")
    #expect(withCatalog.modelCatalogBehavior == .modelsRoute)
    #expect(
      routeSnapshot(try withCatalog.route(.modelCatalog))
        == RouteSnapshot(
          id: "model_catalog",
          method: "GET",
          absoluteURL: "https://gateway.vendor.dev/api/v2/models",
          fixedRequestHeaders: [
            FixedHeaderSnapshot(
              id: "accept_application_json",
              name: "accept",
              value: "application/json"
            ),
            FixedHeaderSnapshot(
              id: "recurs_client_identity",
              name: "user-agent",
              value: "recurs"
            ),
          ],
          allowedResponseHeaders: ["content-type", "request-id", "x-request-id"]
        )
    )
    #expect(withoutCatalog.host == "inference.vendor.net")
    #expect(withoutCatalog.port == 8_443)
    #expect(withoutCatalog.basePath == "/openai")
    #expect(withoutCatalog.modelCatalogBehavior == .unavailable)
    #expect(throws: EndpointPolicyError.routeNotAllowed) {
      _ = try withoutCatalog.route(.modelCatalog)
    }
  }

  @Test(
    arguments: [
      "http://gateway.vendor.dev/v1",
      "https://gateway.vendor.dev",
      "https://gateway.vendor.dev/",
      "https://gateway.vendor.dev/v1/",
      "https://GATEWAY.vendor.dev/v1",
      "https://gateway.vendor.dev:443/v1",
      "https://gateway.vendor.dev:0443/v1",
      "https://gateway.vendor.dev:08443/v1",
      "https://gateway.vendor.dev:0/v1",
      "https://gateway.vendor.dev:65536/v1",
      "https://user@gateway.vendor.dev/v1",
      "https://user:pass@gateway.vendor.dev/v1",
      "https://gateway.vendor.dev/v1?key=value",
      "https://gateway.vendor.dev/v1#fragment",
      "https://gateway.vendor.dev/v1/../admin",
      "https://gateway.vendor.dev/v1/./models",
      "https://gateway.vendor.dev/%76%31",
      "https://gateway.vendor.dev./v1",
      "https://localhost/v1",
      "https://service.localhost/v1",
      "https://metadata.google.internal/v1",
      "https://service.internal/v1",
      "https://service.local/v1",
      "https://service.example/v1",
      "https://service.alt/v1",
      "https://home.arpa/v1",
      "https://service.arpa/v1",
      "https://resolver.arpa/v1",
      "https://api.openai.com/v1",
      "https://api.anthropic.com/v1",
      "https://api.kimi.com/coding/v1",
      "https://127.0.0.1/v1",
      "https://127.1/v1",
      "https://2130706433/v1",
      "https://0x7f000001/v1",
      "https://[::1]/v1",
      "https://[::ffff:127.0.0.1]/v1",
      "https://gateway.vendor.dev/v1\r\nHost:evil.dev",
      "https://gateway.vendor.dev/v1\u{0000}",
      " https://gateway.vendor.dev/v1",
    ]
  )
  func rejectsNoncanonicalUnsafeOrAmbiguousCustomBases(_ baseURL: String) {
    #expect(throws: EndpointPolicyError.invalidEndpoint) {
      _ = try EndpointProfile.customOpenAICompatible(baseURL: baseURL)
    }
  }

  @Test
  func resolvedAddressPolicyAllowsOnlyGlobalUnicast() throws {
    for address in ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"] {
      try EndpointAddressPolicy.validateGlobalUnicast(address)
    }

    for address in [
      "0.0.0.0", "10.0.0.1", "100.64.0.1", "100.100.100.200", "127.0.0.1",
      "168.63.129.16", "169.254.169.254", "169.254.170.2", "169.254.170.23",
      "172.16.0.1", "192.0.0.1", "192.0.2.1", "192.168.1.1", "198.18.0.1",
      "198.51.100.1", "203.0.113.1", "224.0.0.1", "240.0.0.1", "255.255.255.255",
      "::", "::1", "::ffff:8.8.8.8", "64:ff9b::808:808", "100::1", "2001:db8::1",
      "2000::1", "2001::1", "2002::1", "3ffe::1", "3fff::1", "fc00::1", "fe80::1",
      "ff02::1", "not-an-ip", "127.1", "2130706433",
      "8.8.8.8\u{0000}10.0.0.1", "2606:4700:4700::1111\u{0000}::1",
    ] {
      #expect(
        throws: EndpointPolicyError.unsafeResolvedAddress,
        Comment(rawValue: address)
      ) {
        try EndpointAddressPolicy.validateGlobalUnicast(address)
      }
    }
  }

  @Test
  func pinnedIANAIPv6AllocationBoundariesFailClosed() throws {
    let allocatedBoundaryCanaries = [
      "2001:200::1", "2001:3ff:ffff::1", "2001:400::1", "2001:5ff:ffff::1",
      "2001:600::1", "2001:7ff:ffff::1", "2001:800::1", "2001:bff:ffff::1",
      "2001:c00::1", "2001:dff:ffff::1", "2001:e00::1", "2001:fff:ffff::1",
      "2001:1200::1", "2001:13ff:ffff::1", "2001:1400::1", "2001:17ff:ffff::1",
      "2001:1800::1", "2001:19ff:ffff::1", "2001:1a00::1", "2001:1bff:ffff::1",
      "2001:1c00::1", "2001:1fff:ffff::1", "2001:2000::1", "2001:3fff:ffff::1",
      "2001:4000::1", "2001:4dff:ffff::1", "2001:5000::1", "2001:5fff:ffff::1",
      "2001:8000::1", "2001:9fff:ffff::1", "2001:a000::1", "2001:bfff:ffff::1",
      "2003::1", "2003:3fff:ffff::1", "2400::1", "241f:ffff:ffff::1", "2600::1",
      "260f:ffff:ffff::1", "2610::1", "2610:1ff:ffff::1", "2620::1",
      "2620:1ff:ffff::1", "2630::1", "263f:ffff:ffff::1", "2800::1",
      "280f:ffff:ffff::1", "2a00::1", "2a1f:ffff:ffff::1", "2c00::1",
      "2c0f:ffff:ffff::1",
    ]
    for address in allocatedBoundaryCanaries {
      try EndpointAddressPolicy.validateGlobalUnicast(address)
    }

    let reservedGapCanaries = [
      "2001:1ff:ffff::1", "2001:1000::1", "2001:4e00::1", "2001:6000::1",
      "2001:c000::1", "2003:4000::1", "2004::1", "2420::1", "2610:200::1",
      "2620:200::1", "2640::1", "2810::1", "2a20::1", "2c10::1",
    ]
    for address in reservedGapCanaries {
      #expect(throws: EndpointPolicyError.unsafeResolvedAddress) {
        try EndpointAddressPolicy.validateGlobalUnicast(address)
      }
    }
  }

  @Test
  func profileRequiresEveryResolutionAndConnectedPeerToBePublic() throws {
    let profile = try EndpointProfile.customOpenAICompatible(
      baseURL: "https://gateway.vendor.dev/v1"
    )

    let resolution = try profile.validateResolution([
      "1.1.1.1", "2606:4700:4700::1111",
    ])
    try profile.validatePeer("1.1.1.1", against: resolution)
    try profile.validatePeer("2606:4700:4700::1111", against: resolution)

    #expect(throws: EndpointPolicyError.resolutionMismatch) {
      try profile.validatePeer("8.8.8.8", against: resolution)
    }
    let other = try EndpointProfile.customOpenAICompatible(
      baseURL: "https://other.vendor.dev/v1"
    )
    #expect(throws: EndpointPolicyError.resolutionMismatch) {
      try other.validatePeer("1.1.1.1", against: resolution)
    }

    #expect(throws: EndpointPolicyError.unsafeResolvedAddress) {
      try profile.validateResolution([])
    }
    #expect(throws: EndpointPolicyError.unsafeResolvedAddress) {
      try profile.validateResolution(["1.1.1.1", "10.0.0.1"])
    }
    #expect(throws: EndpointPolicyError.unsafeResolvedAddress) {
      try profile.validatePeer("100.100.100.200", against: resolution)
    }
  }

  @Test
  func routeAndHeaderAuthorityCannotBeConstructedFromArbitraryStrings() {
    #expect(EndpointRouteID(rawValue: "https://evil.dev") == nil)
    #expect(BrokerFixedRequestHeader(rawValue: "authorization") == nil)
    #expect(BrokerFixedRequestHeader(rawValue: "host") == nil)
    #expect(BrokerFixedRequestHeader(rawValue: "cookie") == nil)
    #expect(BrokerFixedRequestHeader(rawValue: "proxy-authorization") == nil)
    #expect(BrokerResponseHeaderName(rawValue: "location") == nil)
    #expect(BrokerResponseHeaderName(rawValue: "set-cookie") == nil)
    #expect(BrokerResponseHeaderName(rawValue: "www-authenticate") == nil)
    #expect(BrokerFixedRequestHeader.anthropicVersion20230601.wireName == "anthropic-version")
    #expect(BrokerFixedRequestHeader.anthropicVersion20230601.fixedValue == "2023-06-01")
    #expect(BrokerFixedRequestHeader.recursClientIdentity.wireName == "user-agent")
    #expect(BrokerFixedRequestHeader.recursClientIdentity.fixedValue == "recurs")
  }
}

private struct EndpointPolicySnapshot: Equatable {
  let scheme: String
  let host: String
  let port: UInt16?
  let origin: String
  let basePath: String
  let protocolFamily: String
  let authenticationScheme: String
  let modelCatalogBehavior: String
  let codec: String
  let codecRevision: UInt32
  let compatibilityRevision: UInt32
  let billingPolicy: String
  let billingPolicyEvidenceRevision: UInt32
  let isCustomTrustedCredentialRecipient: Bool
  let routes: [String: RouteSnapshot]
}

private struct RouteSnapshot: Equatable {
  let id: String
  let method: String
  let absoluteURL: String
  let fixedRequestHeaders: Set<FixedHeaderSnapshot>
  let allowedResponseHeaders: Set<String>
}

private struct FixedHeaderSnapshot: Hashable {
  let id: String
  let name: String
  let value: String
}

private struct CustomPolicyFamilySnapshot: Equatable {
  let activationProfileID: String
  let scheme: String
  let protocolFamily: String
  let authenticationScheme: String
  let codec: String
  let codecRevision: UInt32
  let compatibilityRevision: UInt32
  let billingPolicy: String
  let billingPolicyEvidenceRevision: UInt32
  let isCustomTrustedCredentialRecipient: Bool
  let generationRouteID: String
  let generationPath: String
  let generationMethod: String
  let generationHeaders: Set<FixedHeaderSnapshot>
  let allowedResponseHeaders: Set<String>
}

private func snapshot(_ profile: EndpointProfile) throws -> EndpointPolicySnapshot {
  var routes: [String: RouteSnapshot] = [:]
  for id in EndpointRouteID.allCases {
    let route = try profile.route(id)
    routes[id.rawValue] = routeSnapshot(route)
  }
  return EndpointPolicySnapshot(
    scheme: profile.scheme.rawValue,
    host: profile.host,
    port: profile.port,
    origin: profile.origin,
    basePath: profile.basePath,
    protocolFamily: profile.protocolFamily.rawValue,
    authenticationScheme: profile.authenticationScheme.rawValue,
    modelCatalogBehavior: profile.modelCatalogBehavior.rawValue,
    codec: profile.codec.rawValue,
    codecRevision: profile.codecRevision,
    compatibilityRevision: profile.compatibilityRevision,
    billingPolicy: profile.billingPolicy.rawValue,
    billingPolicyEvidenceRevision: profile.billingPolicyEvidenceRevision,
    isCustomTrustedCredentialRecipient: profile.isCustomTrustedCredentialRecipient,
    routes: routes
  )
}

private func customFamilySnapshot(
  _ profile: EndpointProfile
) throws -> CustomPolicyFamilySnapshot {
  let generation = try profile.route(.generation)
  let routeBase = "\(profile.origin)\(profile.basePath)"
  guard generation.absoluteURL.hasPrefix(routeBase) else {
    throw EndpointPolicyError.invalidEndpoint
  }
  return CustomPolicyFamilySnapshot(
    activationProfileID: profile.activationProfileID.rawValue,
    scheme: profile.scheme.rawValue,
    protocolFamily: profile.protocolFamily.rawValue,
    authenticationScheme: profile.authenticationScheme.rawValue,
    codec: profile.codec.rawValue,
    codecRevision: profile.codecRevision,
    compatibilityRevision: profile.compatibilityRevision,
    billingPolicy: profile.billingPolicy.rawValue,
    billingPolicyEvidenceRevision: profile.billingPolicyEvidenceRevision,
    isCustomTrustedCredentialRecipient: profile.isCustomTrustedCredentialRecipient,
    generationRouteID: generation.id.rawValue,
    generationPath: String(generation.absoluteURL.dropFirst(routeBase.count)),
    generationMethod: generation.method.rawValue,
    generationHeaders: headerSnapshots(generation.fixedRequestHeaders),
    allowedResponseHeaders: Set(generation.allowedResponseHeaders.map(\.rawValue))
  )
}

private func routeSnapshot(_ route: AllowedRoute) -> RouteSnapshot {
  RouteSnapshot(
    id: route.id.rawValue,
    method: route.method.rawValue,
    absoluteURL: route.absoluteURL,
    fixedRequestHeaders: headerSnapshots(route.fixedRequestHeaders),
    allowedResponseHeaders: Set(route.allowedResponseHeaders.map(\.rawValue))
  )
}

private func headerSnapshots(
  _ headers: Set<BrokerFixedRequestHeader>
) -> Set<FixedHeaderSnapshot> {
  Set(
    headers.map {
      FixedHeaderSnapshot(id: $0.rawValue, name: $0.wireName, value: $0.fixedValue)
    }
  )
}
