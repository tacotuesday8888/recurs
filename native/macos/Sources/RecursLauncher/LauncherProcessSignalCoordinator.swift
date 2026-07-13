import Darwin
import Dispatch
import Foundation

package protocol LauncherEngineChild: AnyObject, Sendable {
  func shutdown() async throws -> EngineTermination
}

extension EngineChildProcess: LauncherEngineChild {}

protocol LauncherSignalSourceHandling: AnyObject, Sendable {
  func cancel()
}

struct LauncherProcessSignalSystem: @unchecked Sendable {
  let install:
    @Sendable (
      _ signal: Int32,
      _ handler: @escaping @Sendable () -> Void
    ) -> any LauncherSignalSourceHandling
  let restoreDefault: @Sendable (Int32) -> Void
  let suspendSelf: @Sendable () -> Void
  let sleep: @Sendable (UInt64) async -> Void

  static let live = LauncherProcessSignalSystem(
    install: { signalNumber, handler in
      _ = Darwin.signal(signalNumber, SIG_IGN)
      let source = DispatchSource.makeSignalSource(
        signal: signalNumber,
        queue: DispatchQueue.global(qos: .userInitiated)
      )
      source.setEventHandler(handler: handler)
      source.resume()
      return SystemLauncherSignalSource(source: source)
    },
    restoreDefault: { signalNumber in
      _ = Darwin.signal(signalNumber, SIG_DFL)
    },
    suspendSelf: {
      _ = Darwin.raise(SIGTSTP)
    },
    sleep: { nanoseconds in
      try? await Task.sleep(nanoseconds: nanoseconds)
    }
  )
}

package final class LauncherProcessSignalCoordinator: @unchecked Sendable {
  private final class CaptureSignalToken: @unchecked Sendable {}

  private static let terminationSignals = [SIGINT, SIGTERM, SIGHUP, SIGQUIT]
  private static let forwardingGraceNanoseconds: UInt64 = 2_000_000_000

  private let lock = NSLock()
  private let system: LauncherProcessSignalSystem
  private var terminationSources: [(signal: Int32, source: any LauncherSignalSourceHandling)] = []
  private var suspendSource: (any LauncherSignalSourceHandling)?
  private var child: (any LauncherEngineChild)?
  private var firstTerminationSignal: Int32?
  private var shutdownStarted = false
  private var activeCapture: TTYSecretCaptureSession?
  private var activeCaptureToken: CaptureSignalToken?
  private var acceptsSuspendSignal = false
  private var captureRestorationWaiters: [CheckedContinuation<Void, Never>] = []
  private var suspendRequested = false
  private var isClosing = false
  private var teardownComplete = false
  private var teardownTask: Task<Void, Never>?

  package convenience init() {
    self.init(system: .live)
  }

  init(system: LauncherProcessSignalSystem) {
    self.system = system
    for signalNumber in Self.terminationSignals {
      let source = system.install(signalNumber) { [weak self] in
        self?.receiveTerminationSignal(signalNumber)
      }
      terminationSources.append((signalNumber, source))
    }
  }

  package func attach(child: any LauncherEngineChild) {
    let childToShutdown: (any LauncherEngineChild)? = lock.withLock {
      guard !teardownComplete, !isClosing, self.child == nil else {
        return nil
      }
      self.child = child
      guard firstTerminationSignal != nil, !shutdownStarted else {
        return nil
      }
      shutdownStarted = true
      return child
    }

    if let childToShutdown {
      beginShutdown(of: childToShutdown)
    }
  }

  package func close() async {
    let capture = lock.withLock { () -> TTYSecretCaptureSession? in
      guard !teardownComplete else { return nil }
      isClosing = true
      return activeCapture
    }
    capture?.cancel()
    await waitForCaptureRestoration()
    let teardown = claimTeardownTask()
    await teardown.value
    lock.withLock { teardownComplete = true }
  }

  // This remains module-internal until a real controlling-PTY signal test exists.
  func captureSecret(
    using session: TTYSecretCaptureSession
  ) async throws(TTYSecretCaptureError) -> TTYSecret {
    let token = CaptureSignalToken()
    let mayStart = lock.withLock { () -> Bool in
      guard
        !isClosing,
        !teardownComplete,
        firstTerminationSignal == nil,
        activeCapture == nil
      else {
        return false
      }
      activeCapture = session
      activeCaptureToken = token
      acceptsSuspendSignal = true
      return true
    }
    guard mayStart else {
      let busy = lock.withLock { activeCapture != nil }
      throw busy ? .alreadyUsed : .cancelled
    }

    let source = system.install(SIGTSTP) { [weak self, token] in
      self?.receiveSuspendSignal(token: token)
    }
    let keepsSource = lock.withLock { () -> Bool in
      guard
        activeCapture === session,
        activeCaptureToken === token,
        acceptsSuspendSignal,
        !isClosing,
        firstTerminationSignal == nil
      else {
        return false
      }
      suspendSource = source
      return true
    }
    if !keepsSource {
      source.cancel()
      system.restoreDefault(SIGTSTP)
      session.cancel()
    }

    defer { finishCapture(session) }
    return try await session.capture()
  }

  private func receiveTerminationSignal(_ signalNumber: Int32) {
    let owned:
      (
        capture: TTYSecretCaptureSession?,
        child: (any LauncherEngineChild)?
      ) = lock.withLock {
        guard !isClosing, !teardownComplete, firstTerminationSignal == nil else {
          return (nil, nil)
        }
        firstTerminationSignal = signalNumber
        suspendRequested = false
        let childToShutdown: (any LauncherEngineChild)?
        if !shutdownStarted, let child {
          shutdownStarted = true
          childToShutdown = child
        } else {
          childToShutdown = nil
        }
        return (activeCapture, childToShutdown)
      }

    owned.capture?.cancel()
    if let child = owned.child {
      beginShutdown(of: child)
    }
  }

  private func receiveSuspendSignal(token: CaptureSignalToken) {
    let capture = lock.withLock { () -> TTYSecretCaptureSession? in
      guard
        !teardownComplete,
        !isClosing,
        firstTerminationSignal == nil,
        !suspendRequested,
        acceptsSuspendSignal,
        activeCaptureToken === token,
        let activeCapture
      else {
        return nil
      }
      suspendRequested = true
      return activeCapture
    }
    guard let capture else { return }
    capture.cancel()
  }

  private func finishCapture(_ session: TTYSecretCaptureSession) {
    let source: (any LauncherSignalSourceHandling)? = lock.withLock {
      guard activeCapture === session else { return nil }
      acceptsSuspendSignal = false
      let source = suspendSource
      suspendSource = nil
      return source
    }

    if let source {
      source.cancel()
      system.restoreDefault(SIGTSTP)
    }

    let shouldSuspend = lock.withLock { () -> Bool in
      guard
        activeCapture === session,
        suspendRequested,
        firstTerminationSignal == nil,
        !teardownComplete
      else {
        suspendRequested = false
        return false
      }
      suspendRequested = false
      return true
    }
    if shouldSuspend { system.suspendSelf() }

    let waiters: [CheckedContinuation<Void, Never>] = lock.withLock {
      guard activeCapture === session else { return [] }
      activeCapture = nil
      activeCaptureToken = nil
      let waiters = captureRestorationWaiters
      captureRestorationWaiters.removeAll(keepingCapacity: false)
      return waiters
    }
    for waiter in waiters { waiter.resume() }
  }

  private func waitForCaptureRestoration() async {
    await withCheckedContinuation { continuation in
      let restored = lock.withLock { () -> Bool in
        guard activeCapture != nil else { return true }
        captureRestorationWaiters.append(continuation)
        return false
      }
      if restored { continuation.resume() }
    }
  }

  private func beginShutdown(of child: any LauncherEngineChild) {
    Task.detached(priority: .userInitiated) { [self, child] in
      await waitForCaptureRestoration()
      await system.sleep(Self.forwardingGraceNanoseconds)
      _ = try? await child.shutdown()
    }
  }

  private func claimTeardownTask() -> Task<Void, Never> {
    lock.withLock {
      if let teardownTask { return teardownTask }
      child = nil
      var sources = terminationSources
      terminationSources.removeAll(keepingCapacity: false)
      if let suspendSource {
        self.suspendSource = nil
        sources.append((SIGTSTP, suspendSource))
      }
      let system = system
      let task = Task {
        for entry in sources {
          entry.source.cancel()
          system.restoreDefault(entry.signal)
        }
      }
      teardownTask = task
      return task
    }
  }
}

private final class SystemLauncherSignalSource: LauncherSignalSourceHandling,
  @unchecked Sendable
{
  private let source: any DispatchSourceSignal

  init(source: any DispatchSourceSignal) {
    self.source = source
  }

  func cancel() {
    source.cancel()
  }
}
