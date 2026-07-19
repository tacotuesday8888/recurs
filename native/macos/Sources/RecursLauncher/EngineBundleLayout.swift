import Darwin
import Foundation
import RecursNativeSecurity

package enum EngineBundleLayoutError: Error, Equatable, Sendable {
  case productionSigningRequired
  case invalidBundleLayout
}

package struct EngineBundleLayout: Equatable, Sendable {
  package let nodeExecutable: URL
  package let engineEntrypoint: URL

  package static func production(bundle: Bundle = .main) throws -> Self {
    try requireSigning {
      _ = try PeerRequirement.production(
        for: .launcher,
        authenticatedAs: .launcher
      )
    }
    return try resolveValidated(bundleRoot: bundle.bundleURL)
  }

  // Internal overrides keep unsigned path tests deterministic.
  static func resolve(
    bundleRoot: URL,
    nodeExecutable: URL? = nil,
    engineEntrypoint: URL? = nil,
    signingValidation: () throws -> Void
  ) throws -> Self {
    try requireSigning(signingValidation)
    return try resolveValidated(
      bundleRoot: bundleRoot,
      nodeExecutable: nodeExecutable,
      engineEntrypoint: engineEntrypoint
    )
  }

  private static func requireSigning(
    _ validation: () throws -> Void
  ) throws {
    do {
      try validation()
    } catch {
      throw EngineBundleLayoutError.productionSigningRequired
    }
  }

  private static func resolveValidated(
    bundleRoot: URL,
    nodeExecutable: URL? = nil,
    engineEntrypoint: URL? = nil
  ) throws -> Self {
    guard bundleRoot.isFileURL else {
      throw EngineBundleLayoutError.invalidBundleLayout
    }
    let root = bundleRoot.standardizedFileURL
    let fixedNode =
      root
      .appendingPathComponent("Contents/Resources/runtime/bin/node")
      .standardizedFileURL
    let fixedEngine =
      root
      .appendingPathComponent("Contents/Resources/engine/main.js")
      .standardizedFileURL
    let node = (nodeExecutable ?? fixedNode).standardizedFileURL
    let engine = (engineEntrypoint ?? fixedEngine).standardizedFileURL

    guard
      node.isFileURL,
      engine.isFileURL,
      contains(node, within: root),
      contains(engine, within: root)
    else {
      throw EngineBundleLayoutError.invalidBundleLayout
    }

    try validateBranch(from: root, through: node)
    try validateBranch(from: root, through: engine)
    guard isExecutable(node) else {
      throw EngineBundleLayoutError.invalidBundleLayout
    }

    return Self(nodeExecutable: node, engineEntrypoint: engine)
  }

  private static func contains(_ candidate: URL, within root: URL) -> Bool {
    let rootComponents = root.pathComponents
    let candidateComponents = candidate.pathComponents
    return candidateComponents.count > rootComponents.count
      && candidateComponents.starts(with: rootComponents)
  }

  private static func validateBranch(
    from root: URL,
    through leaf: URL
  ) throws {
    try requireKind(.directory, at: root)

    var descendants: [URL] = []
    var cursor = leaf
    while cursor != root {
      descendants.append(cursor)
      let parent = cursor.deletingLastPathComponent().standardizedFileURL
      guard parent != cursor else {
        throw EngineBundleLayoutError.invalidBundleLayout
      }
      cursor = parent
    }

    for (index, descendant) in descendants.reversed().enumerated() {
      let isLeaf = index == descendants.count - 1
      try requireKind(isLeaf ? .regular : .directory, at: descendant)
    }
  }

  private static func requireKind(
    _ kind: FileKind,
    at url: URL
  ) throws {
    var information = stat()
    let result = url.withUnsafeFileSystemRepresentation { path in
      guard let path else { return Int32(-1) }
      return Darwin.lstat(path, &information)
    }
    guard result == 0 else {
      throw EngineBundleLayoutError.invalidBundleLayout
    }

    let fileType = information.st_mode & mode_t(S_IFMT)
    let expectedType =
      switch kind {
      case .directory: mode_t(S_IFDIR)
      case .regular: mode_t(S_IFREG)
      }
    guard fileType == expectedType else {
      throw EngineBundleLayoutError.invalidBundleLayout
    }
  }

  private static func isExecutable(_ url: URL) -> Bool {
    url.withUnsafeFileSystemRepresentation { path in
      guard let path else { return false }
      return Darwin.access(path, X_OK) == 0
    }
  }

  private enum FileKind {
    case directory
    case regular
  }
}
