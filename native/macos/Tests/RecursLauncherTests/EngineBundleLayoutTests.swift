import Foundation
import Testing

@testable import RecursLauncher

@Suite("Engine bundle layout")
struct EngineBundleLayoutTests {
  @Test
  func resolvesOnlyTheFixedBundleFiles() throws {
    let fixture = try EngineBundleFixture()

    let layout = try EngineBundleLayout.resolve(bundleRoot: fixture.root) {}

    #expect(layout.nodeExecutable == fixture.node.standardizedFileURL)
    #expect(layout.engineEntrypoint == fixture.engine.standardizedFileURL)
  }

  @Test
  func signingFailurePrecedesFilesystemValidationAndIsPathFree() throws {
    let parent = FileManager.default.temporaryDirectory
      .appendingPathComponent("missing-\(UUID().uuidString)")
    var signingCalls = 0

    #expect(throws: EngineBundleLayoutError.productionSigningRequired) {
      try EngineBundleLayout.resolve(bundleRoot: parent) {
        signingCalls += 1
        throw SigningProbeFailure.rejected
      }
    }
    #expect(signingCalls == 1)
    #expect(
      String(reflecting: EngineBundleLayoutError.productionSigningRequired)
        == "RecursLauncher.EngineBundleLayoutError.productionSigningRequired")
  }

  @Test
  func rejectsSymlinkAtEveryValidatedComponent() throws {
    let components = [
      "",
      "Contents",
      "Contents/Resources",
      "Contents/Resources/runtime",
      "Contents/Resources/runtime/bin",
      "Contents/Resources/runtime/bin/node",
      "Contents/Resources/engine",
      "Contents/Resources/engine/main.js",
    ]

    for component in components {
      let fixture = try EngineBundleFixture()
      let target =
        component.isEmpty
        ? fixture.root
        : fixture.root.appendingPathComponent(component)
      let outside = fixture.parent.appendingPathComponent("outside")
      try FileManager.default.moveItem(at: target, to: outside)
      try FileManager.default.createSymbolicLink(
        at: target,
        withDestinationURL: outside
      )

      #expect(throws: EngineBundleLayoutError.invalidBundleLayout) {
        try EngineBundleLayout.resolve(bundleRoot: fixture.root) {}
      }
    }
  }

  @Test
  func rejectsNonDirectoryAncestorAtEveryBranch() throws {
    let ancestors = [
      "",
      "Contents",
      "Contents/Resources",
      "Contents/Resources/runtime",
      "Contents/Resources/runtime/bin",
      "Contents/Resources/engine",
    ]

    for ancestor in ancestors {
      let fixture = try EngineBundleFixture()
      let target =
        ancestor.isEmpty
        ? fixture.root
        : fixture.root.appendingPathComponent(ancestor)
      try FileManager.default.removeItem(at: target)
      try Data("not a directory".utf8).write(to: target)

      #expect(throws: EngineBundleLayoutError.invalidBundleLayout) {
        try EngineBundleLayout.resolve(bundleRoot: fixture.root) {}
      }
    }
  }

  @Test
  func rejectsMissingAndNonregularLeaves() throws {
    for leaf in [EngineLeaf.node, .engine] {
      let missingFixture = try EngineBundleFixture()
      try FileManager.default.removeItem(at: leaf.url(in: missingFixture))
      #expect(throws: EngineBundleLayoutError.invalidBundleLayout) {
        try EngineBundleLayout.resolve(bundleRoot: missingFixture.root) {}
      }

      let directoryFixture = try EngineBundleFixture()
      let directoryLeaf = leaf.url(in: directoryFixture)
      try FileManager.default.removeItem(at: directoryLeaf)
      try FileManager.default.createDirectory(
        at: directoryLeaf,
        withIntermediateDirectories: false
      )
      #expect(throws: EngineBundleLayoutError.invalidBundleLayout) {
        try EngineBundleLayout.resolve(bundleRoot: directoryFixture.root) {}
      }
    }
  }

  @Test
  func rejectsCandidateOutsideStandardizedBundleRoot() throws {
    let fixture = try EngineBundleFixture()
    let outsideNode = fixture.parent.appendingPathComponent("outside-node")
    let outsideEngine = fixture.parent.appendingPathComponent("outside-engine")
    try EngineBundleFixture.writeFile(outsideNode, permissions: 0o700)
    try EngineBundleFixture.writeFile(outsideEngine, permissions: 0o600)

    #expect(throws: EngineBundleLayoutError.invalidBundleLayout) {
      try EngineBundleLayout.resolve(
        bundleRoot: fixture.root,
        nodeExecutable: outsideNode
      ) {}
    }
    #expect(throws: EngineBundleLayoutError.invalidBundleLayout) {
      try EngineBundleLayout.resolve(
        bundleRoot: fixture.root,
        engineEntrypoint: outsideEngine
      ) {}
    }
  }

  @Test
  func requiresNodeButNotEngineToBeExecutable() throws {
    let fixture = try EngineBundleFixture()
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o600],
      ofItemAtPath: fixture.node.path
    )

    #expect(throws: EngineBundleLayoutError.invalidBundleLayout) {
      try EngineBundleLayout.resolve(bundleRoot: fixture.root) {}
    }

    try FileManager.default.setAttributes(
      [.posixPermissions: 0o700],
      ofItemAtPath: fixture.node.path
    )
    let layout = try EngineBundleLayout.resolve(bundleRoot: fixture.root) {}
    #expect(layout.engineEntrypoint == fixture.engine.standardizedFileURL)
  }
}

private enum SigningProbeFailure: Error {
  case rejected
}

private enum EngineLeaf {
  case node
  case engine

  func url(in fixture: EngineBundleFixture) -> URL {
    switch self {
    case .node:
      fixture.node
    case .engine:
      fixture.engine
    }
  }
}

private final class EngineBundleFixture {
  let parent: URL
  let root: URL
  let node: URL
  let engine: URL

  init() throws {
    parent = FileManager.default.temporaryDirectory
      .appendingPathComponent("engine-bundle-\(UUID().uuidString)")
    root = parent.appendingPathComponent("RecursLauncher.app")
    node = root.appendingPathComponent("Contents/Resources/runtime/bin/node")
    engine = root.appendingPathComponent("Contents/Resources/engine/main.js")

    try FileManager.default.createDirectory(
      at: node.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )
    try FileManager.default.createDirectory(
      at: engine.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )
    try Self.writeFile(node, permissions: 0o700)
    try Self.writeFile(engine, permissions: 0o600)
  }

  deinit {
    try? FileManager.default.removeItem(at: parent)
  }

  static func writeFile(_ url: URL, permissions: Int) throws {
    try Data("fixture".utf8).write(to: url)
    try FileManager.default.setAttributes(
      [.posixPermissions: permissions],
      ofItemAtPath: url.path
    )
  }
}
