import Foundation
import Security

package enum PeerRequirementError: Error, Sendable, Equatable {
  case productionSigningRequired
}

package enum PeerRequirementRole: Sendable, Equatable {
  case launcher
  case broker
}

package struct PeerRequirement: Sendable, Equatable {
  private static let hardenedRuntimeFlag: UInt32 = 0x0001_0000
  private static let unsafeBooleanEntitlements = [
    "com.apple.security.get-task-allow",
    "com.apple.security.cs.allow-dyld-environment-variables",
    "com.apple.security.cs.allow-jit",
    "com.apple.security.cs.allow-unsigned-executable-memory",
    "com.apple.security.cs.disable-executable-page-protection",
    "com.apple.security.cs.disable-library-validation",
  ]
  private static let authorityExpandingEntitlements = [
    "com.apple.security.application-groups",
    "com.apple.developer.icloud-container-identifiers",
    "com.apple.developer.icloud-services",
    "com.apple.developer.ubiquity-container-identifiers",
  ]

  package let requirementString: String

  private init(requirementString: String) {
    self.requirementString = requirementString
  }

  package static func production(
    for peerRole: PeerRequirementRole,
    authenticatedAs selfRole: PeerRequirementRole
  ) throws(PeerRequirementError) -> PeerRequirement {
    do {
      let metadata = try validatedCurrentSigningMetadata(
        authenticatedAs: selfRole
      )
      return try fromValidatedSignedMetadata(
        for: peerRole,
        metadata: metadata
      )
    } catch {
      throw .productionSigningRequired
    }
  }

  package static func fromValidatedSignedMetadata(
    for role: PeerRequirementRole,
    metadata: [String: Any]
  ) throws(PeerRequirementError) -> PeerRequirement {
    guard
      let teamIdentifier = metadata["RecursTeamIdentifier"] as? String,
      let launcherIdentifier = metadata["RecursLauncherIdentifier"] as? String,
      let brokerIdentifier = metadata["RecursBrokerIdentifier"] as? String,
      metadata["RecursProductionSigned"] as? Bool == true,
      isValidTeamIdentifier(teamIdentifier),
      isValidBundleIdentifier(launcherIdentifier),
      isValidBundleIdentifier(brokerIdentifier),
      launcherIdentifier == "com.recurs.cli.launcher",
      brokerIdentifier == "com.recurs.cli.broker"
    else {
      throw .productionSigningRequired
    }
    let identifier =
      switch role {
      case .launcher: launcherIdentifier
      case .broker: brokerIdentifier
      }
    let requirementString =
      "anchor apple generic and identifier \"\(identifier)\" "
      + "and certificate 1[field.1.2.840.113635.100.6.2.6] exists "
      + "and certificate leaf[field.1.2.840.113635.100.6.1.13] exists "
      + "and certificate leaf[subject.OU] = \"\(teamIdentifier)\""
    var compiledRequirement: SecRequirement?
    let status = SecRequirementCreateWithString(
      requirementString as CFString,
      SecCSFlags(),
      &compiledRequirement
    )
    guard status == errSecSuccess, compiledRequirement != nil else {
      throw .productionSigningRequired
    }
    return PeerRequirement(requirementString: requirementString)
  }

  static func fromValidatedSignedMetadata(
    for peerRole: PeerRequirementRole,
    authenticatedAs selfRole: PeerRequirementRole,
    signingIdentifier: String,
    signingTeamIdentifier: String,
    metadata: [String: Any]
  ) throws(PeerRequirementError) -> PeerRequirement {
    let selfRequirement = try fromValidatedSignedMetadata(
      for: selfRole,
      metadata: metadata
    )
    guard
      signingIdentifier == fixedIdentifier(for: selfRole),
      signingTeamIdentifier == metadata["RecursTeamIdentifier"] as? String,
      selfRequirement.requirementString.contains(
        "identifier \"\(signingIdentifier)\""
      )
    else {
      throw .productionSigningRequired
    }
    return try fromValidatedSignedMetadata(for: peerRole, metadata: metadata)
  }

  static func validateProductionSigningAttributes(
    authenticatedAs selfRole: PeerRequirementRole,
    metadata: [String: Any],
    signingFlags: UInt32,
    entitlements: [String: Any]
  ) throws(PeerRequirementError) {
    guard signingFlags & hardenedRuntimeFlag != 0 else {
      throw .productionSigningRequired
    }
    for key in unsafeBooleanEntitlements {
      guard let value = entitlements[key] else {
        continue
      }
      guard let enabled = value as? Bool, !enabled else {
        throw .productionSigningRequired
      }
    }
    guard authorityExpandingEntitlements.allSatisfy({ entitlements[$0] == nil }) else {
      throw .productionSigningRequired
    }

    switch selfRole {
    case .launcher:
      guard entitlements["keychain-access-groups"] == nil else {
        throw .productionSigningRequired
      }
    case .broker:
      guard
        let applicationIdentifierPrefix = metadata["AppIdentifierPrefix"] as? String,
        let credentialAccessGroup = metadata["RecursCredentialAccessGroup"] as? String,
        let groups = entitlements["keychain-access-groups"] as? [String]
      else {
        throw .productionSigningRequired
      }
      let configuration: KeychainStoreConfiguration
      do {
        configuration = try KeychainStoreConfiguration.production(
          applicationIdentifierPrefix: applicationIdentifierPrefix,
          credentialAccessGroup: credentialAccessGroup
        )
      } catch {
        throw .productionSigningRequired
      }
      guard groups == [configuration.accessGroup] else {
        throw .productionSigningRequired
      }
    }
  }

  private static func validatedCurrentSigningMetadata(
    authenticatedAs selfRole: PeerRequirementRole
  ) throws(PeerRequirementError) -> [String: Any] {
    var currentCode: SecCode?
    guard
      SecCodeCopySelf(SecCSFlags(), &currentCode) == errSecSuccess,
      let currentCode
    else {
      throw .productionSigningRequired
    }

    var staticCode: SecStaticCode?
    guard
      SecCodeCopyStaticCode(
        currentCode,
        SecCSFlags(rawValue: UInt32(kSecCSUseAllArchitectures)),
        &staticCode
      ) == errSecSuccess,
      let staticCode
    else {
      throw .productionSigningRequired
    }
    let validationFlags = SecCSFlags(
      rawValue: UInt32(kSecCSCheckAllArchitectures) | UInt32(kSecCSStrictValidate)
    )
    guard SecStaticCodeCheckValidity(staticCode, validationFlags, nil) == errSecSuccess else {
      throw .productionSigningRequired
    }

    var rawInformation: CFDictionary?
    guard
      SecCodeCopySigningInformation(
        staticCode,
        SecCSFlags(rawValue: UInt32(kSecCSSigningInformation)),
        &rawInformation
      ) == errSecSuccess,
      let information = rawInformation as NSDictionary?,
      let metadata = information[kSecCodeInfoPList as String] as? [String: Any],
      let signingTeamIdentifier = information[kSecCodeInfoTeamIdentifier as String] as? String,
      let signingIdentifier = information[kSecCodeInfoIdentifier as String] as? String,
      let signingFlags = information[kSecCodeInfoFlags as String] as? NSNumber,
      let metadataTeamIdentifier = metadata["RecursTeamIdentifier"] as? String,
      signingTeamIdentifier == metadataTeamIdentifier,
      signingIdentifier == fixedIdentifier(for: selfRole)
    else {
      throw .productionSigningRequired
    }

    let entitlements =
      information[kSecCodeInfoEntitlementsDict as String] as? [String: Any] ?? [:]
    try validateProductionSigningAttributes(
      authenticatedAs: selfRole,
      metadata: metadata,
      signingFlags: signingFlags.uint32Value,
      entitlements: entitlements
    )

    let ownRequirement = try fromValidatedSignedMetadata(
      for: selfRole,
      authenticatedAs: selfRole,
      signingIdentifier: signingIdentifier,
      signingTeamIdentifier: signingTeamIdentifier,
      metadata: metadata
    )
    var compiledOwnRequirement: SecRequirement?
    guard
      SecRequirementCreateWithString(
        ownRequirement.requirementString as CFString,
        SecCSFlags(),
        &compiledOwnRequirement
      ) == errSecSuccess,
      let compiledOwnRequirement,
      SecCodeCheckValidity(
        currentCode,
        SecCSFlags(rawValue: UInt32(kSecCSStrictValidate)),
        compiledOwnRequirement
      ) == errSecSuccess,
      SecStaticCodeCheckValidity(
        staticCode,
        validationFlags,
        compiledOwnRequirement
      ) == errSecSuccess
    else {
      throw .productionSigningRequired
    }
    return metadata
  }

  private static func fixedIdentifier(for role: PeerRequirementRole) -> String {
    switch role {
    case .launcher:
      "com.recurs.cli.launcher"
    case .broker:
      "com.recurs.cli.broker"
    }
  }

  private static func isValidTeamIdentifier(_ value: String) -> Bool {
    let bytes = Array(value.utf8)
    guard bytes.count == 10 else {
      return false
    }
    return bytes.allSatisfy {
      (Character("A").asciiValue!...Character("Z").asciiValue!).contains($0)
        || (Character("0").asciiValue!...Character("9").asciiValue!).contains($0)
    }
  }

  private static func isValidBundleIdentifier(_ value: String) -> Bool {
    let bytes = Array(value.utf8)
    guard !bytes.isEmpty, bytes.count <= 255 else {
      return false
    }
    var componentLength = 0
    var componentCount = 1
    var previousWasHyphen = false
    for byte in bytes {
      if byte == Character(".").asciiValue {
        guard componentLength > 0, !previousWasHyphen else {
          return false
        }
        componentCount += 1
        componentLength = 0
        previousWasHyphen = false
        continue
      }
      let isAlphaNumeric =
        (Character("A").asciiValue!...Character("Z").asciiValue!).contains(byte)
        || (Character("a").asciiValue!...Character("z").asciiValue!).contains(byte)
        || (Character("0").asciiValue!...Character("9").asciiValue!).contains(byte)
      let isHyphen = byte == Character("-").asciiValue
      guard isAlphaNumeric || isHyphen, !(componentLength == 0 && isHyphen) else {
        return false
      }
      componentLength += 1
      previousWasHyphen = isHyphen
    }
    return componentCount >= 2 && componentLength > 0 && !previousWasHyphen
  }
}
