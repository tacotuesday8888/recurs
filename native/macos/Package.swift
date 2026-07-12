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
    .testTarget(
      name: "RecursBrokerCoreTests",
      dependencies: ["RecursBrokerCore"]
    ),
    .testTarget(
      name: "RecursNativeProtocolTests",
      dependencies: ["RecursNativeProtocol"],
      path: "Tests",
      exclude: ["RecursBrokerCoreTests"],
      sources: ["RecursNativeProtocolTests"],
      resources: [.copy("Fixtures/frames.json")]
    ),
  ]
)
