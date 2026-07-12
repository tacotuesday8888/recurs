// swift-tools-version: 6.2
import PackageDescription

let package = Package(
  name: "RecursNative",
  platforms: [.macOS("14.4")],
  products: [
    .library(
      name: "RecursNativeProtocol",
      targets: ["RecursNativeProtocol"]
    )
  ],
  targets: [
    .target(name: "RecursNativeProtocol"),
    .testTarget(
      name: "RecursNativeProtocolTests",
      dependencies: ["RecursNativeProtocol"],
      path: "Tests",
      sources: ["RecursNativeProtocolTests"],
      resources: [.copy("Fixtures/frames.json")]
    ),
  ]
)
