import Darwin
import Dispatch
import Foundation
import Testing

@testable import RecursLauncher

@Suite("Launcher process signal coordinator")
struct LauncherProcessSignalCoordinatorTests {
  @Test(arguments: [SIGINT, SIGTERM, SIGHUP, SIGQUIT])
  func terminationSignalsRequestOneBoundedChildShutdown(signal: Int32) async {
    let harness = SignalHarness()
    let coordinator = LauncherProcessSignalCoordinator(system: harness.system)
    let child = TestLauncherChild()
    coordinator.attach(child: child)

    harness.fire(signal)
    await child.waitForShutdown()

    #expect(child.shutdownCount == 1)
    #expect(harness.sleeps == [2_000_000_000])
    await coordinator.close()
  }

  @Test
  func firstTerminationSignalLatchesAndRepeatedSignalsAreIdempotent() async {
    let harness = SignalHarness()
    let coordinator = LauncherProcessSignalCoordinator(system: harness.system)
    let child = TestLauncherChild()
    coordinator.attach(child: child)

    harness.fire(SIGINT)
    harness.fire(SIGTERM)
    harness.fire(SIGINT)
    await child.waitForShutdown()
    await Task.yield()

    #expect(child.shutdownCount == 1)
    #expect(harness.sleeps.count == 1)
    await coordinator.close()
  }

  @Test
  func signalBeforeAttachShutsDownTheLaterExactChild() async {
    let harness = SignalHarness()
    let coordinator = LauncherProcessSignalCoordinator(system: harness.system)

    harness.fire(SIGHUP)
    let child = TestLauncherChild()
    coordinator.attach(child: child)
    await child.waitForShutdown()

    #expect(child.shutdownCount == 1)
    await coordinator.close()
  }

  @Test
  func taskCancellationRestoresTheTerminalBeforeCloseReturns() async throws {
    let harness = SignalHarness()
    let coordinator = LauncherProcessSignalCoordinator(system: harness.system)
    let terminal = try CoordinatorPseudoTerminal()
    let before = try terminal.attributeBytes()
    let session = try TTYSecretCaptureSession(
      terminalDescriptor: terminal.duplicateSlave(),
      foregroundCheck: { _ in true }
    )

    let capture = Task { try await coordinator.captureSecret(using: session) }
    _ = try terminal.readPrompt()
    capture.cancel()
    let close = Task { await coordinator.close() }
    await #expect(throws: TTYSecretCaptureError.cancelled) {
      _ = try await capture.value
    }
    await close.value

    #expect(try terminal.attributeBytes() == before)
  }

  @Test(arguments: [SIGINT, SIGTERM, SIGHUP, SIGQUIT])
  func terminationSignalCancelsCaptureAndRestoresTerminal(
    signal: Int32
  ) async throws {
    let harness = SignalHarness()
    let coordinator = LauncherProcessSignalCoordinator(system: harness.system)
    let terminal = try CoordinatorPseudoTerminal()
    let before = try terminal.attributeBytes()
    let session = try TTYSecretCaptureSession(
      terminalDescriptor: terminal.duplicateSlave(),
      foregroundCheck: { _ in true }
    )
    let capture = Task { try await coordinator.captureSecret(using: session) }
    _ = try terminal.readPrompt()

    harness.fire(signal)
    await #expect(throws: TTYSecretCaptureError.cancelled) {
      _ = try await capture.value
    }
    await coordinator.close()

    #expect(try terminal.attributeBytes() == before)
  }

  @Test
  func suspendIsCaptureOnlyAndOccursAfterTerminalRestoration() async throws {
    let terminal = try CoordinatorPseudoTerminal()
    let before = try terminal.attributeBytes()
    let harness = SignalHarness {
      (try? terminal.attributeBytes()) == before
    }
    let coordinator = LauncherProcessSignalCoordinator(system: harness.system)

    #expect(
      harness.installedSignals == [SIGINT, SIGTERM, SIGHUP, SIGQUIT].sorted()
    )

    let session = try TTYSecretCaptureSession(
      terminalDescriptor: terminal.duplicateSlave(),
      foregroundCheck: { _ in true }
    )
    let capture = Task { try await coordinator.captureSecret(using: session) }
    _ = try terminal.readPrompt()
    #expect(harness.installedSignals.contains(SIGTSTP))

    harness.fire(SIGTSTP)
    let close = Task { await coordinator.close() }
    await #expect(throws: TTYSecretCaptureError.cancelled) {
      _ = try await capture.value
    }
    await close.value

    #expect(harness.suspendCount == 1)
    #expect(harness.restoredAtSuspend == true)
    #expect(harness.cancelledSignals.contains(SIGTSTP))
    #expect(harness.defaultedSignals.contains(SIGTSTP))
  }

  @Test
  func closeCancelsSourcesAndRestoresDefaultDispositionsOnce() async {
    let harness = SignalHarness()
    let coordinator = LauncherProcessSignalCoordinator(system: harness.system)

    await coordinator.close()
    await coordinator.close()

    #expect(harness.cancelledSignals == [SIGINT, SIGTERM, SIGHUP, SIGQUIT])
    #expect(harness.defaultedSignals == [SIGINT, SIGTERM, SIGHUP, SIGQUIT])
  }

  @Test
  func bridgeCancellationSealsCaptureAdmissionBeforeALateWorkerCanRegister() async throws {
    let harness = SignalHarness()
    let coordinator = LauncherProcessSignalCoordinator(system: harness.system)

    await coordinator.cancelActiveCaptureAndWait()
    let terminal = try CoordinatorPseudoTerminal()
    let session = try TTYSecretCaptureSession(
      terminalDescriptor: terminal.duplicateSlave(),
      foregroundCheck: { _ in true }
    )

    await #expect(throws: TTYSecretCaptureError.cancelled) {
      _ = try await coordinator.captureSecret(using: session)
    }
    await coordinator.close()
  }

  @Test
  func concurrentCloseCallersWaitForDefaultRestoration() async {
    let restoration = BlockingDefaultRestoration()
    let harness = SignalHarness(restoreProbe: restoration.restore)
    let coordinator = LauncherProcessSignalCoordinator(system: harness.system)
    let secondReturned = LockedFlag()

    let first = Task.detached { await coordinator.close() }
    #expect(restoration.waitUntilEntered())
    let second = Task.detached {
      await coordinator.close()
      secondReturned.set()
    }
    for _ in 0..<10 { await Task.yield() }
    let returnedBeforeRestoration = secondReturned.value

    restoration.release()
    await first.value
    await second.value

    #expect(!returnedBeforeRestoration)
    #expect(secondReturned.value)
  }

  @Test
  func cancelledSuspendSourceCannotAffectALaterCapture() async throws {
    let harness = SignalHarness()
    let coordinator = LauncherProcessSignalCoordinator(system: harness.system)
    let firstTerminal = try CoordinatorPseudoTerminal()
    let firstSession = try TTYSecretCaptureSession(
      terminalDescriptor: firstTerminal.duplicateSlave(),
      foregroundCheck: { _ in true }
    )
    let firstCapture = Task {
      try await coordinator.captureSecret(using: firstSession)
    }
    _ = try firstTerminal.readPrompt()
    let staleSource = try #require(harness.source(for: SIGTSTP))
    firstCapture.cancel()
    await #expect(throws: TTYSecretCaptureError.cancelled) {
      _ = try await firstCapture.value
    }

    let secondTerminal = try CoordinatorPseudoTerminal()
    let secondSession = try TTYSecretCaptureSession(
      terminalDescriptor: secondTerminal.duplicateSlave(),
      foregroundCheck: { _ in true }
    )
    let secondCapture = Task {
      try await coordinator.captureSecret(using: secondSession)
    }
    _ = try secondTerminal.readPrompt()

    staleSource.fireQueued()
    try secondTerminal.writeInput(Array("second-value\n".utf8))
    let secret = try await secondCapture.value

    #expect(secret.withUnsafeBytes { Array($0) } == Array("second-value".utf8))
    #expect(harness.suspendCount == 0)
    secret.erase()
    await coordinator.close()
  }
}

private protocol LockedSignalSource: LauncherSignalSourceHandling {
  var signal: Int32 { get }
  func fire()
}

private final class TestSignalSource: LockedSignalSource, @unchecked Sendable {
  let signal: Int32

  private let lock = NSLock()
  private let handler: @Sendable () -> Void
  private let onCancel: @Sendable (Int32) -> Void
  private var isCancelled = false

  init(
    signal: Int32,
    handler: @escaping @Sendable () -> Void,
    onCancel: @escaping @Sendable (Int32) -> Void
  ) {
    self.signal = signal
    self.handler = handler
    self.onCancel = onCancel
  }

  func fire() {
    let mayFire = lock.withLock { !isCancelled }
    if mayFire { handler() }
  }

  func fireQueued() {
    handler()
  }

  func cancel() {
    let didCancel = lock.withLock { () -> Bool in
      guard !isCancelled else { return false }
      isCancelled = true
      return true
    }
    if didCancel { onCancel(signal) }
  }
}

private final class SignalHarness: @unchecked Sendable {
  private let lock = NSLock()
  private let suspendProbe: @Sendable () -> Bool
  private let restoreProbe: @Sendable (Int32) -> Void
  private var sources: [Int32: TestSignalSource] = [:]
  private var sleepStorage: [UInt64] = []
  private var cancelledStorage: [Int32] = []
  private var defaultedStorage: [Int32] = []
  private var suspendStorage = 0
  private var restoredAtSuspendStorage: Bool?

  init(
    suspendProbe: @escaping @Sendable () -> Bool = { true },
    restoreProbe: @escaping @Sendable (Int32) -> Void = { _ in }
  ) {
    self.suspendProbe = suspendProbe
    self.restoreProbe = restoreProbe
  }

  var system: LauncherProcessSignalSystem {
    LauncherProcessSignalSystem(
      install: { [self] signal, handler in
        let source = TestSignalSource(
          signal: signal,
          handler: handler,
          onCancel: { [self] signal in
            lock.withLock { cancelledStorage.append(signal) }
          }
        )
        lock.withLock { sources[signal] = source }
        return source
      },
      restoreDefault: { [self] signal in
        restoreProbe(signal)
        lock.withLock { defaultedStorage.append(signal) }
      },
      suspendSelf: { [self] in
        lock.withLock {
          suspendStorage += 1
          restoredAtSuspendStorage = suspendProbe()
        }
      },
      sleep: { [self] nanoseconds in
        lock.withLock { sleepStorage.append(nanoseconds) }
      }
    )
  }

  var installedSignals: [Int32] {
    lock.withLock { sources.keys.sorted() }
  }

  var cancelledSignals: [Int32] {
    lock.withLock { cancelledStorage }
  }

  var defaultedSignals: [Int32] {
    lock.withLock { defaultedStorage }
  }

  var sleeps: [UInt64] {
    lock.withLock { sleepStorage }
  }

  var suspendCount: Int {
    lock.withLock { suspendStorage }
  }

  var restoredAtSuspend: Bool? {
    lock.withLock { restoredAtSuspendStorage }
  }

  func fire(_ signal: Int32) {
    lock.withLock { sources[signal] }?.fire()
  }

  func source(for signal: Int32) -> TestSignalSource? {
    lock.withLock { sources[signal] }
  }
}

private final class TestLauncherChild: LauncherEngineChild, @unchecked Sendable {
  private let lock = NSLock()
  private var shutdownStorage = 0
  private var waiters: [CheckedContinuation<Void, Never>] = []

  var shutdownCount: Int {
    lock.withLock { shutdownStorage }
  }

  func shutdown() async throws -> EngineTermination {
    let ownedWaiters = lock.withLock { () -> [CheckedContinuation<Void, Never>] in
      shutdownStorage += 1
      let owned = waiters
      waiters.removeAll(keepingCapacity: false)
      return owned
    }
    for waiter in ownedWaiters { waiter.resume() }
    return .exited(0)
  }

  func waitForShutdown() async {
    await withCheckedContinuation { continuation in
      let complete = lock.withLock { () -> Bool in
        guard shutdownStorage == 0 else { return true }
        waiters.append(continuation)
        return false
      }
      if complete { continuation.resume() }
    }
  }
}

private final class CoordinatorPseudoTerminal: @unchecked Sendable {
  private let master: Int32
  private let slave: Int32

  init() throws {
    var master: Int32 = -1
    var slave: Int32 = -1
    guard openpty(&master, &slave, nil, nil, nil) == 0 else {
      throw CoordinatorTestError.system
    }
    self.master = master
    self.slave = slave
  }

  deinit {
    _ = Darwin.close(master)
    _ = Darwin.close(slave)
  }

  func duplicateSlave() throws -> Int32 {
    let descriptor = Darwin.dup(slave)
    guard descriptor >= 0 else { throw CoordinatorTestError.system }
    return descriptor
  }

  func attributeBytes() throws -> [UInt8] {
    var value = termios()
    guard tcgetattr(slave, &value) == 0 else { throw CoordinatorTestError.system }
    return withUnsafeBytes(of: value) { Array($0) }
  }

  func readPrompt() throws -> String {
    var bytes = [UInt8](repeating: 0, count: 21)
    var offset = 0
    while offset < bytes.count {
      let remaining = bytes.count - offset
      let count = bytes.withUnsafeMutableBytes { storage in
        Darwin.read(
          master,
          storage.baseAddress!.advanced(by: offset),
          remaining
        )
      }
      guard count > 0 else { throw CoordinatorTestError.system }
      offset += count
    }
    return String(decoding: bytes, as: UTF8.self)
  }

  func writeInput(_ bytes: [UInt8]) throws {
    var offset = 0
    while offset < bytes.count {
      let remaining = bytes.count - offset
      let count = bytes.withUnsafeBytes { storage in
        Darwin.write(
          master,
          storage.baseAddress!.advanced(by: offset),
          remaining
        )
      }
      guard count > 0 else { throw CoordinatorTestError.system }
      offset += count
    }
  }
}

private final class BlockingDefaultRestoration: @unchecked Sendable {
  private let lock = NSLock()
  private let entered = DispatchSemaphore(value: 0)
  private let released = DispatchSemaphore(value: 0)
  private var didBlock = false

  func restore(_: Int32) {
    let shouldBlock = lock.withLock { () -> Bool in
      guard !didBlock else { return false }
      didBlock = true
      return true
    }
    guard shouldBlock else { return }
    entered.signal()
    released.wait()
  }

  func waitUntilEntered() -> Bool {
    entered.wait(timeout: .now() + 2) == .success
  }

  func release() {
    released.signal()
  }
}

private final class LockedFlag: @unchecked Sendable {
  private let lock = NSLock()
  private var storage = false

  var value: Bool { lock.withLock { storage } }

  func set() {
    lock.withLock { storage = true }
  }
}

private enum CoordinatorTestError: Error {
  case system
}
