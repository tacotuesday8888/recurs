import Foundation
import Testing

@testable import RecursBrokerCore

@Suite("Native endpoint policy")
struct EndpointPolicyTests {
  @Test
  func builtInProfilesOwnExactOriginsPathsRoutesAndMethods() throws {
    let openAI = EndpointProfile.openAI
    #expect(openAI.kind == .openAI)
    #expect(openAI.revision == 1)
    #expect(openAI.protocolFamily == .openAIResponses)
    #expect(openAI.authenticationScheme == .bearer)
    #expect(openAI.modelCatalogBehavior == .modelsRoute)
    #expect(openAI.scheme == .https)
    #expect(openAI.host == "api.openai.com")
    #expect(openAI.port == nil)
    #expect(openAI.origin == "https://api.openai.com")
    #expect(openAI.basePath == "/v1")
    #expect(openAI.codec == .openAIResponsesV1)
    #expect(openAI.codecRevision == 1)
    #expect(openAI.compatibilityRevision == 1)
    #expect(openAI.billingPolicyEvidenceRevision == 1)
    #expect(try openAI.route(.modelCatalog).absoluteURL == "https://api.openai.com/v1/models")
    #expect(try openAI.route(.modelCatalog).method == .get)
    #expect(try openAI.route(.generation).absoluteURL == "https://api.openai.com/v1/responses")
    #expect(try openAI.route(.generation).method == .post)
    #expect(!openAI.isCustomTrustedCredentialRecipient)

    let anthropic = EndpointProfile.anthropic
    #expect(anthropic.kind == .anthropic)
    #expect(anthropic.protocolFamily == .anthropicMessages)
    #expect(anthropic.authenticationScheme == .xAPIKey)
    #expect(anthropic.scheme == .https)
    #expect(anthropic.host == "api.anthropic.com")
    #expect(anthropic.port == nil)
    #expect(anthropic.origin == "https://api.anthropic.com")
    #expect(anthropic.basePath == "/v1")
    #expect(anthropic.codec == .anthropicMessagesV1)
    #expect(
      try anthropic.route(.modelCatalog).absoluteURL
        == "https://api.anthropic.com/v1/models"
    )
    #expect(
      try anthropic.route(.generation).absoluteURL
        == "https://api.anthropic.com/v1/messages"
    )

    let kimi = EndpointProfile.kimiCode
    #expect(kimi.kind == .kimiCode)
    #expect(kimi.protocolFamily == .openAIChatCompletions)
    #expect(kimi.authenticationScheme == .bearer)
    #expect(kimi.scheme == .https)
    #expect(kimi.host == "api.kimi.com")
    #expect(kimi.port == nil)
    #expect(kimi.origin == "https://api.kimi.com")
    #expect(kimi.basePath == "/coding/v1")
    #expect(kimi.codec == .openAIChatCompletionsV1)
    #expect(kimi.billingPolicy == .codingSubscription)
    #expect(try kimi.route(.modelCatalog).absoluteURL == "https://api.kimi.com/coding/v1/models")
    #expect(
      try kimi.route(.generation).absoluteURL
        == "https://api.kimi.com/coding/v1/chat/completions"
    )

    #expect(
      try openAI.route(.generation).fixedRequestHeaders
        == [.acceptApplicationJSON, .contentTypeApplicationJSON]
    )
    #expect(
      try anthropic.route(.generation).fixedRequestHeaders
        == [
          .acceptApplicationJSON, .contentTypeApplicationJSON,
          .anthropicVersion20230601,
        ]
    )
    #expect(
      try kimi.route(.generation).fixedRequestHeaders
        == [.acceptApplicationJSON, .contentTypeApplicationJSON, .recursClientIdentity]
    )

    for profile in [openAI, anthropic, kimi] {
      for routeID in [EndpointRouteID.modelCatalog, .generation] {
        let route = try profile.route(routeID)
        #expect(
          route.allowedResponseHeaders == [.contentType, .requestID, .xRequestID]
        )
        #expect(!route.absoluteURL.contains("@"))
        #expect(!route.absoluteURL.contains("?"))
        #expect(!route.absoluteURL.contains("#"))
      }
    }
  }

  @Test
  func customProfileRequiresOneExactCanonicalPublicHTTPSBase() throws {
    let profile = try EndpointProfile.customOpenAICompatible(
      baseURL: "https://gateway.vendor.dev/api/v2"
    )

    #expect(profile.kind == .customOpenAICompatible)
    #expect(profile.protocolFamily == .openAIChatCompletions)
    #expect(profile.authenticationScheme == .bearer)
    #expect(profile.origin == "https://gateway.vendor.dev")
    #expect(profile.scheme == .https)
    #expect(profile.host == "gateway.vendor.dev")
    #expect(profile.port == nil)
    #expect(profile.basePath == "/api/v2")
    #expect(profile.isCustomTrustedCredentialRecipient)
    #expect(
      try profile.route(.modelCatalog).absoluteURL
        == "https://gateway.vendor.dev/api/v2/models"
    )
    #expect(
      try profile.route(.generation).absoluteURL
        == "https://gateway.vendor.dev/api/v2/chat/completions"
    )
  }

  @Test
  func customProfileSupportsCanonicalPublicPortsAndOptionalCatalog() throws {
    let profile = try EndpointProfile.customOpenAICompatible(
      baseURL: "https://gateway.vendor.dev:8443/api/v2",
      modelCatalogBehavior: .unavailable
    )

    #expect(profile.origin == "https://gateway.vendor.dev:8443")
    #expect(profile.port == 8_443)
    #expect(profile.basePath == "/api/v2")
    #expect(profile.modelCatalogBehavior == .unavailable)
    #expect(throws: EndpointPolicyError.routeNotAllowed) {
      _ = try profile.route(.modelCatalog)
    }
    #expect(
      try profile.route(.generation).absoluteURL
        == "https://gateway.vendor.dev:8443/api/v2/chat/completions"
    )
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
