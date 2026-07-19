import Foundation
import Security
import Testing

@testable import RecursNativeSecurity

@Suite("Exact XPC peer requirements")
struct PeerRequirementTests {
  @Test
  func validatedMetadataBuildsExactDeveloperIDRequirements() throws {
    let metadata: [String: Any] = [
      "RecursTeamIdentifier": "ABCDE12345",
      "RecursLauncherIdentifier": "com.recurs.cli.launcher",
      "RecursBrokerIdentifier": "com.recurs.cli.broker",
      "RecursProductionSigned": true,
    ]

    let launcher = try PeerRequirement.fromValidatedSignedMetadata(
      for: .launcher,
      metadata: metadata
    )
    let broker = try PeerRequirement.fromValidatedSignedMetadata(
      for: .broker,
      metadata: metadata
    )

    #expect(
      launcher.requirementString
        == exactRequirement(identifier: "com.recurs.cli.launcher")
    )
    #expect(
      broker.requirementString
        == exactRequirement(identifier: "com.recurs.cli.broker")
    )
  }

  @Test
  func malformedTeamIdentifierIsRejected() {
    for invalidIdentifier in [
      "",
      "ABCDE1234",
      "ABCDE123456",
      "abcde12345",
      "ABCDE_2345",
      "ABCDE1234\n",
      "ABCDE1234\"",
    ] {
      #expect(throws: PeerRequirementError.productionSigningRequired) {
        _ = try PeerRequirement.fromValidatedSignedMetadata(
          for: .launcher,
          metadata: metadata(teamIdentifier: invalidIdentifier)
        )
      }
    }
  }

  @Test
  func malformedOrNonDistinctBundleIdentifiersAreRejected() {
    for invalidIdentifier in [
      "",
      "alternate",
      ".com.recurs.cli.launcher",
      "com..recurs.cli.launcher",
      "com.recurs.cli.launcher-",
      "com.recurs.cli_launcher",
      "com.recurs.cli.launcher\n",
      "com.recurs.cli.launchér",
      "com.recurs.cli.launcher\" or true or identifier \"alternate",
    ] {
      #expect(throws: PeerRequirementError.productionSigningRequired) {
        _ = try PeerRequirement.fromValidatedSignedMetadata(
          for: .launcher,
          metadata: metadata(launcherIdentifier: invalidIdentifier)
        )
      }
      #expect(throws: PeerRequirementError.productionSigningRequired) {
        _ = try PeerRequirement.fromValidatedSignedMetadata(
          for: .launcher,
          metadata: metadata(brokerIdentifier: invalidIdentifier)
        )
      }
    }
    #expect(throws: PeerRequirementError.productionSigningRequired) {
      _ = try PeerRequirement.fromValidatedSignedMetadata(
        for: .broker,
        metadata: metadata(brokerIdentifier: "com.recurs.cli.launcher")
      )
    }
  }

  @Test
  func wellFormedAlternateProductIdentifiersAreRejected() {
    #expect(throws: PeerRequirementError.productionSigningRequired) {
      _ = try PeerRequirement.fromValidatedSignedMetadata(
        for: .launcher,
        metadata: metadata(launcherIdentifier: "com.recurs.cli.other")
      )
    }
    #expect(throws: PeerRequirementError.productionSigningRequired) {
      _ = try PeerRequirement.fromValidatedSignedMetadata(
        for: .broker,
        metadata: metadata(brokerIdentifier: "com.recurs.cli.other")
      )
    }
  }

  @Test
  func missingOrWrongTypedSignedMetadataIsRejected() {
    for key in [
      "RecursTeamIdentifier",
      "RecursLauncherIdentifier",
      "RecursBrokerIdentifier",
      "RecursProductionSigned",
    ] {
      var missing = metadata()
      missing.removeValue(forKey: key)
      #expect(throws: PeerRequirementError.productionSigningRequired) {
        _ = try PeerRequirement.fromValidatedSignedMetadata(
          for: .launcher,
          metadata: missing
        )
      }

      var wrongTyped = metadata()
      wrongTyped[key] = key == "RecursProductionSigned" ? "true" : true
      #expect(throws: PeerRequirementError.productionSigningRequired) {
        _ = try PeerRequirement.fromValidatedSignedMetadata(
          for: .broker,
          metadata: wrongTyped
        )
      }
    }
  }

  @Test
  func nonProductionMarkerIsRejected() {
    #expect(throws: PeerRequirementError.productionSigningRequired) {
      _ = try PeerRequirement.fromValidatedSignedMetadata(
        for: .launcher,
        metadata: metadata(productionSigned: false)
      )
    }
  }

  @Test
  func sourceMainBundleFailsClosedWithFixedError() {
    #expect(throws: PeerRequirementError.productionSigningRequired) {
      _ = try PeerRequirement.production(
        for: .launcher,
        authenticatedAs: .broker
      )
    }
    #expect(throws: PeerRequirementError.productionSigningRequired) {
      _ = try PeerRequirement.production(
        for: .broker,
        authenticatedAs: .launcher
      )
    }
  }

  @Test
  func validatedSigningEvidenceCannotAuthenticateTheWrongSelfRole() {
    #expect(throws: PeerRequirementError.productionSigningRequired) {
      _ = try PeerRequirement.fromValidatedSignedMetadata(
        for: .broker,
        authenticatedAs: .launcher,
        signingIdentifier: "com.recurs.cli.broker",
        signingTeamIdentifier: "ABCDE12345",
        metadata: metadata()
      )
    }
    #expect(throws: PeerRequirementError.productionSigningRequired) {
      _ = try PeerRequirement.fromValidatedSignedMetadata(
        for: .launcher,
        authenticatedAs: .broker,
        signingIdentifier: "com.recurs.cli.broker",
        signingTeamIdentifier: "WRONG12345",
        metadata: metadata()
      )
    }
  }

  @Test
  func productionSigningRequiresHardenedRuntimeAndRoleSafeEntitlements() throws {
    let runtimeFlag: UInt32 = 0x0001_0000
    try PeerRequirement.validateProductionSigningAttributes(
      authenticatedAs: .launcher,
      metadata: metadata(),
      signingFlags: runtimeFlag,
      entitlements: [:]
    )

    #expect(throws: PeerRequirementError.productionSigningRequired) {
      try PeerRequirement.validateProductionSigningAttributes(
        authenticatedAs: .launcher,
        metadata: metadata(),
        signingFlags: 0,
        entitlements: [:]
      )
    }
    for unsafeKey in [
      "com.apple.security.get-task-allow",
      "com.apple.security.cs.allow-dyld-environment-variables",
      "com.apple.security.cs.allow-jit",
      "com.apple.security.cs.allow-unsigned-executable-memory",
      "com.apple.security.cs.disable-executable-page-protection",
      "com.apple.security.cs.disable-library-validation",
    ] {
      #expect(throws: PeerRequirementError.productionSigningRequired) {
        try PeerRequirement.validateProductionSigningAttributes(
          authenticatedAs: .launcher,
          metadata: metadata(),
          signingFlags: runtimeFlag,
          entitlements: [unsafeKey: true]
        )
      }
    }
    #expect(throws: PeerRequirementError.productionSigningRequired) {
      try PeerRequirement.validateProductionSigningAttributes(
        authenticatedAs: .launcher,
        metadata: metadata(),
        signingFlags: runtimeFlag,
        entitlements: ["keychain-access-groups": ["ABCDE12345.secret"]]
      )
    }

    var brokerMetadata = metadata()
    brokerMetadata["AppIdentifierPrefix"] = "ABCDE12345."
    brokerMetadata["RecursCredentialAccessGroup"] =
      "com.recurs.cli.broker.credentials.v1"
    let accessGroup = "ABCDE12345.com.recurs.cli.broker.credentials.v1"
    try PeerRequirement.validateProductionSigningAttributes(
      authenticatedAs: .broker,
      metadata: brokerMetadata,
      signingFlags: runtimeFlag,
      entitlements: ["keychain-access-groups": [accessGroup]]
    )
    for entitlements: [String: Any] in [
      [:],
      ["keychain-access-groups": []],
      ["keychain-access-groups": ["ABCDE12345.wrong"]],
      ["keychain-access-groups": [accessGroup, "ABCDE12345.extra"]],
    ] {
      #expect(throws: PeerRequirementError.productionSigningRequired) {
        try PeerRequirement.validateProductionSigningAttributes(
          authenticatedAs: .broker,
          metadata: brokerMetadata,
          signingFlags: runtimeFlag,
          entitlements: entitlements
        )
      }
    }
  }

  @Test
  func errorsCarryNoPayload() {
    let error = PeerRequirementError.productionSigningRequired
    #expect(Mirror(reflecting: error).children.isEmpty)
  }

  private func exactRequirement(identifier: String) -> String {
    "anchor apple generic and identifier \"\(identifier)\" "
      + "and certificate 1[field.1.2.840.113635.100.6.2.6] exists "
      + "and certificate leaf[field.1.2.840.113635.100.6.1.13] exists "
      + "and certificate leaf[subject.OU] = \"ABCDE12345\""
  }

  private func metadata(
    teamIdentifier: String = "ABCDE12345",
    launcherIdentifier: String = "com.recurs.cli.launcher",
    brokerIdentifier: String = "com.recurs.cli.broker",
    productionSigned: Bool = true
  ) -> [String: Any] {
    [
      "RecursTeamIdentifier": teamIdentifier,
      "RecursLauncherIdentifier": launcherIdentifier,
      "RecursBrokerIdentifier": brokerIdentifier,
      "RecursProductionSigned": productionSigned,
    ]
  }
}
