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
    .executable(
      name: "recurs-native-broker",
      targets: ["RecursNativeBrokerExecutable"]
    ),
    .executable(
      name: "recurs-native-launcher",
      targets: ["RecursNativeLauncherExecutable"]
    ),
  ],
  targets: [
    .target(name: "RecursBrokerCore"),
    .target(name: "RecursNativeProtocol"),
    .target(name: "RecursBrokerXPC"),
    .target(
      name: "RecursNativeSecurity",
      dependencies: ["RecursBrokerCore"],
      linkerSettings: [.linkedFramework("Security")]
    ),
    .target(
      name: "RecursBrokerService",
      dependencies: [
        "RecursBrokerCore",
        "RecursBrokerXPC",
        "RecursNativeProtocol",
        "RecursNativeSecurity",
      ]
    ),
    .target(
      name: "RecursLauncher",
      dependencies: [
        "RecursBrokerXPC",
        "RecursNativeProtocol",
        "RecursNativeSecurity",
      ],
      linkerSettings: [.linkedFramework("ServiceManagement")]
    ),
    .executableTarget(
      name: "RecursNativeBrokerExecutable",
      dependencies: [
        "RecursBrokerService",
        "RecursNativeProtocol",
      ]
    ),
    .executableTarget(
      name: "RecursNativeLauncherExecutable",
      dependencies: [
        "RecursLauncher",
        "RecursNativeProtocol",
      ],
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
      exclude: [
        "RecursBrokerCoreTests",
        "RecursBrokerServiceTests",
        "RecursLauncherTests",
        "RecursNativeSecurityTests",
      ],
      sources: ["RecursNativeProtocolTests"],
      resources: [.copy("Fixtures/frames.json")]
    ),
    .testTarget(
      name: "RecursNativeSecurityTests",
      dependencies: ["RecursNativeSecurity", "RecursBrokerCore"]
    ),
    .testTarget(
      name: "RecursBrokerServiceTests",
      dependencies: [
        "RecursBrokerCore",
        "RecursBrokerService",
        "RecursBrokerXPC",
        "RecursNativeProtocol",
      ]
    ),
    .testTarget(
      name: "RecursLauncherTests",
      dependencies: [
        "RecursBrokerXPC",
        "RecursLauncher",
        "RecursNativeProtocol",
        "RecursNativeSecurity",
      ]
    ),
  ]
)
