package struct LauncherOpenAISecretCapture: Sendable {
  private let captureOperation: @Sendable () async throws(TTYSecretCaptureError) -> TTYSecret
  private let cancellationOperation: @Sendable () async -> Void

  package init(
    capture: @escaping @Sendable () async throws(TTYSecretCaptureError) -> TTYSecret,
    cancelAndWait: @escaping @Sendable () async -> Void
  ) {
    captureOperation = capture
    cancellationOperation = cancelAndWait
  }

  package static func live(
    signalCoordinator: LauncherProcessSignalCoordinator,
    automation: Bool
  ) -> Self {
    Self(
      capture: { () async throws(TTYSecretCaptureError) -> TTYSecret in
        let session = try TTYSecretCaptureSession.open(
          manualUserPresent: true,
          automation: automation
        )
        return try await signalCoordinator.captureSecret(using: session)
      },
      cancelAndWait: {
        await signalCoordinator.cancelActiveCaptureAndWait()
      }
    )
  }

  func capture() async throws(TTYSecretCaptureError) -> TTYSecret {
    try await captureOperation()
  }

  func cancelAndWait() async {
    await cancellationOperation()
  }
}

package func isExactOpenAISetupInvocation(_ arguments: [String]) -> Bool {
  arguments == ["setup", "openai"]
}
