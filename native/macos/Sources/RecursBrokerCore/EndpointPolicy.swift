import Darwin
import Foundation

package enum EndpointPolicyError:
  Error,
  Sendable,
  Equatable,
  CustomStringConvertible,
  CustomDebugStringConvertible,
  LocalizedError
{
  case invalidEndpoint
  case routeNotAllowed
  case unsafeResolvedAddress
  case resolutionMismatch

  private var fixedDescription: String {
    switch self {
    case .invalidEndpoint:
      "The provider endpoint is invalid."
    case .routeNotAllowed:
      "The provider route is not allowed."
    case .unsafeResolvedAddress:
      "The provider address is not public global unicast."
    case .resolutionMismatch:
      "The connected provider address does not match the validated resolution."
    }
  }

  package var description: String { fixedDescription }
  package var debugDescription: String { fixedDescription }
  package var errorDescription: String? { fixedDescription }
}

package enum EndpointScheme: String, Sendable, Hashable {
  case https
}

package enum EndpointProtocolFamily: String, Sendable, Hashable {
  case openAIResponses = "openai_responses"
  case anthropicMessages = "anthropic_messages"
  case openAIChatCompletions = "openai_chat_completions"
}

package enum EndpointCodec: String, Sendable, Hashable {
  case openAIResponsesV1 = "openai_responses_v1"
  case anthropicMessagesV1 = "anthropic_messages_v1"
  case openAIChatCompletionsV1 = "openai_chat_completions_v1"
}

package enum EndpointAuthenticationScheme: String, Sendable, Hashable {
  case bearer
  case xAPIKey = "x_api_key"
}

package enum EndpointModelCatalogBehavior: String, Sendable, Hashable {
  case modelsRoute = "models_route"
  case unavailable
}

package enum EndpointBillingPolicy: String, Sendable, Hashable {
  case directAPI = "direct_api"
  case codingSubscription = "coding_subscription"
  case customTrustedRecipient = "custom_trusted_recipient"
}

package enum EndpointRouteID: String, Sendable, Hashable, CaseIterable {
  case modelCatalog = "model_catalog"
  case generation
}

package enum BrokerHTTPMethod: String, Sendable, Hashable {
  case get = "GET"
  case post = "POST"
}

package enum BrokerFixedRequestHeader: String, Sendable, Hashable {
  case acceptApplicationJSON = "accept_application_json"
  case contentTypeApplicationJSON = "content_type_application_json"
  case anthropicVersion20230601 = "anthropic_version_2023_06_01"
  case recursClientIdentity = "recurs_client_identity"

  package var wireName: String {
    switch self {
    case .acceptApplicationJSON:
      "accept"
    case .contentTypeApplicationJSON:
      "content-type"
    case .anthropicVersion20230601:
      "anthropic-version"
    case .recursClientIdentity:
      "user-agent"
    }
  }

  package var fixedValue: String {
    switch self {
    case .acceptApplicationJSON, .contentTypeApplicationJSON:
      "application/json"
    case .anthropicVersion20230601:
      "2023-06-01"
    case .recursClientIdentity:
      "recurs"
    }
  }
}

package enum BrokerResponseHeaderName: String, Sendable, Hashable {
  case contentType = "content-type"
  case requestID = "request-id"
  case xRequestID = "x-request-id"
}

package struct AllowedRoute: Sendable, Hashable {
  package let id: EndpointRouteID
  package let method: BrokerHTTPMethod
  package let absoluteURL: String
  package let fixedRequestHeaders: Set<BrokerFixedRequestHeader>
  package let allowedResponseHeaders: Set<BrokerResponseHeaderName>

  fileprivate init(
    id: EndpointRouteID,
    method: BrokerHTTPMethod,
    absoluteURL: String,
    additionalRequestHeaders: Set<BrokerFixedRequestHeader>
  ) {
    self.id = id
    self.method = method
    self.absoluteURL = absoluteURL
    var requestHeaders: Set<BrokerFixedRequestHeader> = [.acceptApplicationJSON]
    if method == .post {
      requestHeaders.insert(.contentTypeApplicationJSON)
    }
    requestHeaders.formUnion(additionalRequestHeaders)
    self.fixedRequestHeaders = requestHeaders
    self.allowedResponseHeaders = [.contentType, .requestID, .xRequestID]
  }
}

package struct EndpointProfile: Sendable, Hashable {
  package let activationProfileID: ProviderActivationProfileID
  package let scheme: EndpointScheme
  package let host: String
  package let port: UInt16?
  package let protocolFamily: EndpointProtocolFamily
  package let authenticationScheme: EndpointAuthenticationScheme
  package let modelCatalogBehavior: EndpointModelCatalogBehavior
  package let codec: EndpointCodec
  package let codecRevision: UInt32
  package let compatibilityRevision: UInt32
  package let billingPolicy: EndpointBillingPolicy
  package let billingPolicyEvidenceRevision: UInt32
  package let origin: String
  package let basePath: String
  package let isCustomTrustedCredentialRecipient: Bool
  private let routes: [EndpointRouteID: AllowedRoute]

  package static let openAI = EndpointProfile(
    activationProfileID: .openaiApiV1,
    host: "api.openai.com",
    protocolFamily: .openAIResponses,
    authenticationScheme: .bearer,
    codec: .openAIResponsesV1,
    billingPolicy: .directAPI,
    basePath: "/v1",
    generationPath: "/responses",
    additionalRequestHeaders: [],
    isCustom: false
  )

  package static let anthropic = EndpointProfile(
    activationProfileID: .anthropicApiV1,
    host: "api.anthropic.com",
    protocolFamily: .anthropicMessages,
    authenticationScheme: .xAPIKey,
    codec: .anthropicMessagesV1,
    billingPolicy: .directAPI,
    basePath: "/v1",
    generationPath: "/messages",
    additionalRequestHeaders: [.anthropicVersion20230601],
    isCustom: false
  )

  package static let kimiCode = EndpointProfile(
    activationProfileID: .kimiCodeV1,
    host: "api.kimi.com",
    protocolFamily: .openAIChatCompletions,
    authenticationScheme: .bearer,
    codec: .openAIChatCompletionsV1,
    billingPolicy: .codingSubscription,
    basePath: "/coding/v1",
    generationPath: "/chat/completions",
    additionalRequestHeaders: [.recursClientIdentity],
    isCustom: false
  )

  package static func customOpenAICompatible(
    baseURL: String,
    modelCatalogBehavior: EndpointModelCatalogBehavior = .modelsRoute
  ) throws(EndpointPolicyError) -> EndpointProfile {
    let parsed = try CanonicalPublicHTTPSBase.parse(baseURL)
    return EndpointProfile(
      activationProfileID: .customOpenaiCompatibleV1,
      host: parsed.host,
      port: parsed.port,
      protocolFamily: .openAIChatCompletions,
      authenticationScheme: .bearer,
      codec: .openAIChatCompletionsV1,
      billingPolicy: .customTrustedRecipient,
      basePath: parsed.path,
      generationPath: "/chat/completions",
      modelCatalogBehavior: modelCatalogBehavior,
      additionalRequestHeaders: [.recursClientIdentity],
      isCustom: true
    )
  }

  package func route(
    _ id: EndpointRouteID
  ) throws(EndpointPolicyError) -> AllowedRoute {
    guard let route = routes[id] else {
      throw .routeNotAllowed
    }
    return route
  }

  package func validateResolution(
    _ addresses: [String]
  ) throws(EndpointPolicyError) -> ValidatedEndpointResolution {
    guard !addresses.isEmpty else {
      throw .unsafeResolvedAddress
    }
    var canonicalAddresses: Set<EndpointIPAddress> = []
    canonicalAddresses.reserveCapacity(addresses.count)
    for address in addresses {
      canonicalAddresses.insert(try EndpointAddressPolicy.parseGlobalUnicast(address))
    }
    return ValidatedEndpointResolution(profile: self, addresses: canonicalAddresses)
  }

  package func validatePeer(
    _ address: String,
    against resolution: ValidatedEndpointResolution
  ) throws(EndpointPolicyError) {
    let peer = try EndpointAddressPolicy.parseGlobalUnicast(address)
    guard resolution.profile == self, resolution.addresses.contains(peer) else {
      throw .resolutionMismatch
    }
  }

  private init(
    activationProfileID: ProviderActivationProfileID,
    host: String,
    port: UInt16? = nil,
    protocolFamily: EndpointProtocolFamily,
    authenticationScheme: EndpointAuthenticationScheme,
    codec: EndpointCodec,
    billingPolicy: EndpointBillingPolicy,
    basePath: String,
    generationPath: String,
    modelCatalogBehavior: EndpointModelCatalogBehavior = .modelsRoute,
    additionalRequestHeaders: Set<BrokerFixedRequestHeader>,
    isCustom: Bool
  ) {
    self.activationProfileID = activationProfileID
    self.scheme = .https
    self.host = host
    self.port = port
    self.protocolFamily = protocolFamily
    self.authenticationScheme = authenticationScheme
    self.modelCatalogBehavior = modelCatalogBehavior
    self.codec = codec
    self.codecRevision = 1
    self.compatibilityRevision = 1
    self.billingPolicy = billingPolicy
    self.billingPolicyEvidenceRevision = 1
    self.origin = port.map { "https://\(host):\($0)" } ?? "https://\(host)"
    self.basePath = basePath
    self.isCustomTrustedCredentialRecipient = isCustom
    var routes: [EndpointRouteID: AllowedRoute] = [
      .generation: AllowedRoute(
        id: .generation,
        method: .post,
        absoluteURL: "\(origin)\(basePath)\(generationPath)",
        additionalRequestHeaders: additionalRequestHeaders
      )
    ]
    if modelCatalogBehavior == .modelsRoute {
      routes[.modelCatalog] = AllowedRoute(
        id: .modelCatalog,
        method: .get,
        absoluteURL: "\(origin)\(basePath)/models",
        additionalRequestHeaders: additionalRequestHeaders
      )
    }
    self.routes = routes
  }
}

package struct ValidatedEndpointResolution: Sendable, CustomReflectable {
  fileprivate let profile: EndpointProfile
  fileprivate let addresses: Set<EndpointIPAddress>

  fileprivate init(profile: EndpointProfile, addresses: Set<EndpointIPAddress>) {
    self.profile = profile
    self.addresses = addresses
  }

  package var customMirror: Mirror {
    let children: [(label: String?, value: Any)] = []
    return Mirror(self, children: children, displayStyle: .struct)
  }
}

package enum EndpointAddressPolicy {
  package static func validateGlobalUnicast(
    _ presentation: String
  ) throws(EndpointPolicyError) {
    _ = try parseGlobalUnicast(presentation)
  }

  fileprivate static func parseGlobalUnicast(
    _ presentation: String
  ) throws(EndpointPolicyError) -> EndpointIPAddress {
    guard
      !presentation.isEmpty,
      presentation.utf8.count <= 64,
      presentation.utf8.allSatisfy({
        (48...57).contains($0) || (65...70).contains($0) || (97...102).contains($0)
          || $0 == 46 || $0 == 58
      })
    else {
      throw .unsafeResolvedAddress
    }
    var ipv4 = in_addr()
    if presentation.withCString({ inet_pton(AF_INET, $0, &ipv4) }) == 1 {
      let bytes = withUnsafeBytes(of: &ipv4) { Array($0) }
      guard isGlobalIPv4(bytes) else {
        throw .unsafeResolvedAddress
      }
      return EndpointIPAddress(bytes: bytes)
    }

    var ipv6 = in6_addr()
    if presentation.withCString({ inet_pton(AF_INET6, $0, &ipv6) }) == 1 {
      let bytes = withUnsafeBytes(of: &ipv6) { Array($0) }
      guard isAllocatedGlobalIPv6(bytes) else {
        throw .unsafeResolvedAddress
      }
      return EndpointIPAddress(bytes: bytes)
    }
    throw .unsafeResolvedAddress
  }

  private static func isGlobalIPv4(_ bytes: [UInt8]) -> Bool {
    guard bytes.count == 4 else { return false }
    let first = bytes[0]
    let second = bytes[1]
    if bytes == [100, 100, 100, 200] || bytes == [168, 63, 129, 16] { return false }
    if first == 0 || first == 10 || first == 127 || first >= 224 { return false }
    if first == 100, second & 0xc0 == 0x40 { return false }
    if first == 169, second == 254 { return false }
    if first == 172, second & 0xf0 == 0x10 { return false }
    if first == 192 {
      if second == 0 || second == 168 { return false }
      if second == 88, bytes[2] == 99 { return false }
    }
    if first == 198 {
      if second == 18 || second == 19 { return false }
      if second == 51, bytes[2] == 100 { return false }
    }
    if first == 203, second == 0, bytes[2] == 113 { return false }
    return true
  }

  // IANA IPv6 Global Unicast Address Space, revision 2025-10-10. Unlisted
  // 2000::/3 space is reserved. IANA special-purpose and 6to4 blocks are
  // intentionally excluded rather than treated as public provider targets.
  private static func isAllocatedGlobalIPv6(_ bytes: [UInt8]) -> Bool {
    guard bytes.count == 16 else { return false }
    let first = UInt16(bytes[0]) << 8 | UInt16(bytes[1])
    let second = UInt16(bytes[2]) << 8 | UInt16(bytes[3])

    if first == 0x2001 {
      if second == 0x0db8 { return false }
      return matches(second, prefix: 0x0200, length: 7)
        || matches(second, prefix: 0x0400, length: 7)
        || matches(second, prefix: 0x0600, length: 7)
        || matches(second, prefix: 0x0800, length: 6)
        || matches(second, prefix: 0x0c00, length: 7)
        || matches(second, prefix: 0x0e00, length: 7)
        || matches(second, prefix: 0x1200, length: 7)
        || matches(second, prefix: 0x1400, length: 6)
        || matches(second, prefix: 0x1800, length: 7)
        || matches(second, prefix: 0x1a00, length: 7)
        || matches(second, prefix: 0x1c00, length: 6)
        || matches(second, prefix: 0x2000, length: 3)
        || matches(second, prefix: 0x4000, length: 7)
        || matches(second, prefix: 0x4200, length: 7)
        || matches(second, prefix: 0x4400, length: 7)
        || matches(second, prefix: 0x4600, length: 7)
        || matches(second, prefix: 0x4800, length: 7)
        || matches(second, prefix: 0x4a00, length: 7)
        || matches(second, prefix: 0x4c00, length: 7)
        || matches(second, prefix: 0x5000, length: 4)
        || matches(second, prefix: 0x8000, length: 3)
        || matches(second, prefix: 0xa000, length: 4)
        || matches(second, prefix: 0xb000, length: 4)
    }
    if first == 0x2003 {
      return matches(second, prefix: 0, length: 2)
    }
    if matches(first, prefix: 0x2400, length: 11) { return true }
    if matches(first, prefix: 0x2600, length: 12) { return true }
    if first == 0x2610, matches(second, prefix: 0, length: 7) { return true }
    if first == 0x2620, matches(second, prefix: 0, length: 7) { return true }
    if matches(first, prefix: 0x2630, length: 12) { return true }
    if matches(first, prefix: 0x2800, length: 12) { return true }
    if matches(first, prefix: 0x2a00, length: 11) { return true }
    return matches(first, prefix: 0x2c00, length: 12)
  }

  private static func matches(_ value: UInt16, prefix: UInt16, length: Int) -> Bool {
    let mask = UInt16.max << (16 - length)
    return value & mask == prefix & mask
  }
}

private struct EndpointIPAddress: Sendable, Hashable {
  private let high: UInt64
  private let low: UInt64
  private let byteCount: UInt8

  init(bytes: [UInt8]) {
    precondition(bytes.count == 4 || bytes.count == 16)
    var high: UInt64 = 0
    var low: UInt64 = 0
    if bytes.count == 4 {
      for byte in bytes {
        low = low << 8 | UInt64(byte)
      }
    } else {
      for byte in bytes.prefix(8) {
        high = high << 8 | UInt64(byte)
      }
      for byte in bytes.suffix(8) {
        low = low << 8 | UInt64(byte)
      }
    }
    self.high = high
    self.low = low
    self.byteCount = UInt8(bytes.count)
  }
}

private struct CanonicalPublicHTTPSBase {
  let host: String
  let port: UInt16?
  let path: String

  static func parse(_ input: String) throws(EndpointPolicyError) -> Self {
    guard
      !input.isEmpty,
      input.utf8.count <= 2_048,
      input.unicodeScalars.allSatisfy({ $0.value >= 0x21 && $0.value <= 0x7e }),
      let components = URLComponents(string: input),
      components.scheme == EndpointScheme.https.rawValue,
      components.user == nil,
      components.password == nil,
      components.query == nil,
      components.fragment == nil,
      let host = components.host,
      let origin = canonicalOrigin(host: host, port: components.port),
      components.percentEncodedPath == components.path,
      isSafeDNSHost(host),
      isCanonicalBasePath(components.path),
      !reservedBuiltInHosts.contains(host),
      input == "\(origin)\(components.path)"
    else {
      throw .invalidEndpoint
    }
    return Self(host: host, port: components.port.map(UInt16.init), path: components.path)
  }

  private static let reservedBuiltInHosts = [
    "api.openai.com", "api.anthropic.com", "api.kimi.com",
  ]

  private static func canonicalOrigin(host: String, port: Int?) -> String? {
    guard let port else { return "https://\(host)" }
    guard (1...65_535).contains(port), port != 443 else { return nil }
    return "https://\(host):\(port)"
  }

  private static func isSafeDNSHost(_ host: String) -> Bool {
    guard
      host == host.lowercased(),
      host.utf8.count <= 253,
      host.unicodeScalars.allSatisfy({ $0.value <= 0x7f }),
      !host.hasSuffix(".")
    else {
      return false
    }

    var legacyIPv4 = in_addr()
    if host.withCString({ inet_aton($0, &legacyIPv4) }) == 1 {
      return false
    }
    var ipv6 = in6_addr()
    if host.withCString({ inet_pton(AF_INET6, $0, &ipv6) }) == 1 {
      return false
    }

    let labels = host.split(separator: ".", omittingEmptySubsequences: false)
    guard labels.count >= 2 else { return false }
    for label in labels {
      let bytes = Array(label.utf8)
      guard
        !bytes.isEmpty,
        bytes.count <= 63,
        bytes.first != 45,
        bytes.last != 45,
        bytes.allSatisfy({
          (97...122).contains($0) || (48...57).contains($0) || $0 == 45
        })
      else {
        return false
      }
    }
    guard labels.last?.utf8.contains(where: { (97...122).contains($0) }) == true else {
      return false
    }

    let forbiddenExact = [
      "example.com", "example.net", "example.org", "metadata.google.internal",
    ]
    if forbiddenExact.contains(host) { return false }
    // IANA Special-Use Domain Names, revision 2026-05-22, applies each
    // designation to all subdomains. Public provider profiles conservatively
    // reject the entire ARPA infrastructure namespace as well.
    let forbiddenSuffixes = [
      ".example.com", ".example.net", ".example.org", ".localhost", ".local", ".internal",
      ".home", ".lan", ".test", ".invalid", ".example", ".onion", ".alt", ".arpa",
    ]
    return host != "localhost" && !forbiddenSuffixes.contains(where: host.hasSuffix)
  }

  private static func isCanonicalBasePath(_ path: String) -> Bool {
    guard
      path.utf8.count >= 2,
      path.utf8.count <= 512,
      path.first == "/",
      path.last != "/",
      !path.contains("//")
    else {
      return false
    }
    for segment in path.dropFirst().split(separator: "/", omittingEmptySubsequences: false) {
      guard segment != ".", segment != "..", !segment.isEmpty else { return false }
      guard
        segment.utf8.allSatisfy({
          (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0)
            || [45, 46, 95, 126].contains($0)
        })
      else {
        return false
      }
    }
    return true
  }
}
