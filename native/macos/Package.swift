// swift-tools-version: 6.2
import PackageDescription

let package = Package(
  name: "RecursNative",
  platforms: [.macOS("14.4")],
  products: [
    .library(
      name: "RecursBrokerCore",
      targets: ["RecursBrokerCore"]
    ),
    .library(
      name: "RecursNativeProtocol",
      targets: ["RecursNativeProtocol"]
    ),
  ],
  targets: [
    .target(name: "RecursBrokerCore"),
    .target(name: "RecursNativeProtocol"),
    .target(
      name: "RecursNativeSecurity",
      dependencies: ["RecursBrokerCore"],
      linkerSettings: [.linkedFramework("Security")]
    ),
    .testTarget(
      name: "RecursBrokerCoreTests",
      dependencies: ["RecursBrokerCore"],
      resources: [.copy("Fixtures/non-secret-policy-cases.json")]
    ),
    .testTarget(
      name: "RecursNativeProtocolTests",
      dependencies: ["RecursNativeProtocol"],
      path: "Tests",
      exclude: ["RecursBrokerCoreTests", "RecursNativeSecurityTests"],
      sources: ["RecursNativeProtocolTests"],
      resources: [.copy("Fixtures/frames.json")]
    ),
    .testTarget(
      name: "RecursNativeSecurityTests",
      dependencies: ["RecursNativeSecurity", "RecursBrokerCore"]
    ),
  ]
)
