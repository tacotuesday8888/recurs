import Darwin
import Dispatch
import Foundation
import Testing

@testable import RecursLauncher

private let ptyChildSignalKey = "RECURS_PTY_CHILD_SIGNAL"
private let ptyChildRoleKey = "RECURS_PTY_CHILD_ROLE"
private let ptyPrompt = Array("Provider credential: ".utf8)
private let ptyCanary = Array("PTY_SECRET_CANARY".utf8)
private let ptyWorkerMarker = Array("RECURS_PTY_WORKER:".utf8)
private let ptyStoppedMarker = Array("RECURS_PTY_STOPPED:".utf8)
private let ptyDoneMarker = Array("RECURS_PTY_DONE:".utf8)
private let ptyWorkerGateDescriptor: Int32 = 127

@Suite("Launcher controlling PTY", .serialized)
struct LauncherControllingPTYIntegrationTests {
  @Test(arguments: PTYSignalScenario.allCases)
  func signalsRestoreExactTerminalStateWithoutEcho(
    scenario: PTYSignalScenario
  ) async throws {
    let child = try ControllingPTYChild.spawn(scenario: scenario)
    defer { child.forceCleanup() }

    var output = try await child.readUntilPrompt()
    let hidden = try child.attributes()
    #expect(hidden.c_lflag & tcflag_t(ECHO) == 0)
    #expect(hidden.c_lflag & tcflag_t(ECHONL) == 0)

    try child.writeInput(ptyCanary)
    try child.deliver(scenario)

    if scenario == .suspend {
      let stopped = try await child.waitForStop()
      output.append(contentsOf: stopped.output)
      #expect(stopped.signal == SIGTSTP)
      #expect(try child.attributeBytes() == child.originalAttributeBytes)
      try child.resume()
    }

    output.append(contentsOf: try await child.waitForCompletion())

    #expect(try child.attributeBytes() == child.originalAttributeBytes)
    #expect(!containsSubsequence(output, ptyCanary))
    child.closeTerminal()

    let status = try await child.waitForExit()
    #expect(exitCode(status) == 0)
  }

  @Test
  func forcedCleanupIsBoundedAndLeavesNoOwnedProcess() async throws {
    let child = try ControllingPTYChild.spawn(scenario: .terminate)
    _ = try await child.readUntilPrompt()

    let started = ContinuousClock.now
    child.forceCleanup()

    #expect(started.duration(to: .now) < .seconds(2))
    #expect(!child.hasLiveOwnedProcess)
  }
}

@Suite("Launcher controlling PTY child")
struct LauncherControllingPTYChildTests {
  @Test
  func captureUnderARealControllingTerminal() async throws {
    let environment = ProcessInfo.processInfo.environment
    guard
      let rawScenario = environment[ptyChildSignalKey],
      let scenario = PTYSignalScenario(rawValue: rawScenario),
      let rawRole = environment[ptyChildRoleKey],
      let role = PTYChildRole(rawValue: rawRole)
    else {
      return
    }

    switch role {
    case .supervisor:
      do {
        try runPTYSessionSupervisor(scenario: scenario)
        exitPTYSessionSupervisor(0)
      } catch {
        try? writeBytes(
          Array("RECURS_PTY_SUPERVISOR_ERROR:\(error)\n".utf8),
          to: STDERR_FILENO
        )
        exitPTYSessionSupervisor(1)
      }
    case .worker:
      try waitForSupervisorGate()
      let coordinator = LauncherProcessSignalCoordinator()
      let session = try TTYSecretCaptureSession.open(
        manualUserPresent: true,
        automation: false
      )
      await #expect(throws: TTYSecretCaptureError.cancelled) {
        _ = try await coordinator.captureSecret(using: session)
      }
      await coordinator.close()
    }
  }
}

enum PTYSignalScenario: String, CaseIterable, Sendable {
  case interrupt
  case terminate
  case hangup
  case suspend
}

private enum PTYChildRole: String {
  case supervisor
  case worker
}

private final class ControllingPTYChild: @unchecked Sendable {
  let originalAttributeBytes: [UInt8]

  private let master: Int32
  private let pid: pid_t
  private let lock = NSLock()
  private var masterClosed = false
  private var reaped = false
  private var workerPID: pid_t?

  private init(
    master: Int32,
    pid: pid_t,
    originalAttributeBytes: [UInt8]
  ) {
    self.master = master
    self.pid = pid
    self.originalAttributeBytes = originalAttributeBytes
  }

  deinit {
    forceCleanup()
    closeTerminal()
  }

  static func spawn(
    scenario: PTYSignalScenario
  ) throws -> ControllingPTYChild {
    var master: Int32 = -1
    var slave: Int32 = -1
    guard openpty(&master, &slave, nil, nil, nil) == 0 else {
      throw ControllingPTYTestError.terminalSetupFailed
    }
    var ownsDescriptors = true
    defer {
      if ownsDescriptors {
        _ = Darwin.close(master)
        _ = Darwin.close(slave)
      }
    }

    let original = try configureTerminal(slave)
    guard setNonblocking(master) else {
      throw ControllingPTYTestError.terminalSetupFailed
    }

    let invocation = try childInvocation(scenario: scenario, role: .supervisor)
    var fileActions: posix_spawn_file_actions_t?
    guard posix_spawn_file_actions_init(&fileActions) == 0 else {
      throw ControllingPTYTestError.spawnFailed
    }
    defer { posix_spawn_file_actions_destroy(&fileActions) }
    for descriptor: Int32 in 0...2 {
      guard posix_spawn_file_actions_adddup2(&fileActions, slave, descriptor) == 0 else {
        throw ControllingPTYTestError.spawnFailed
      }
    }
    guard
      posix_spawn_file_actions_addclose(&fileActions, master) == 0,
      posix_spawn_file_actions_addclose(&fileActions, slave) == 0
    else {
      throw ControllingPTYTestError.spawnFailed
    }

    let pid = try spawnChild(invocation, fileActions: &fileActions)

    _ = Darwin.close(slave)
    ownsDescriptors = false
    return ControllingPTYChild(
      master: master,
      pid: pid,
      originalAttributeBytes: termiosBytes(original)
    )
  }

  func attributes() throws -> termios {
    var value = termios()
    guard tcgetattr(master, &value) == 0 else {
      throw ControllingPTYTestError.terminalSetupFailed
    }
    return value
  }

  func attributeBytes() throws -> [UInt8] {
    termiosBytes(try attributes())
  }

  func readUntilPrompt() async throws -> [UInt8] {
    var output: [UInt8] = []
    let deadline = DispatchTime.now().uptimeNanoseconds + 5_000_000_000
    while DispatchTime.now().uptimeNanoseconds < deadline {
      output.append(contentsOf: try readAvailable())
      recordWorkerPID(from: output)
      guard output.count <= 64 * 1024 else {
        throw ControllingPTYTestError.outputExceeded
      }
      if containsSubsequence(output, ptyPrompt), currentWorkerPID != nil {
        return output
      }
      try await Task.sleep(for: .milliseconds(10))
    }
    throw ControllingPTYTestError.timedOut(
      String(decoding: output, as: UTF8.self)
    )
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
      if count < 0, errno == EINTR { continue }
      guard count > 0 else { throw ControllingPTYTestError.inputFailed }
      offset += count
    }
  }

  func deliver(_ scenario: PTYSignalScenario) throws {
    switch scenario {
    case .interrupt:
      try writeInput([0x03])
    case .terminate:
      guard let workerPID = ownedWorkerPID, Darwin.kill(workerPID, SIGTERM) == 0 else {
        throw ControllingPTYTestError.signalFailed
      }
    case .hangup:
      guard let workerPID = ownedWorkerPID, Darwin.kill(workerPID, SIGHUP) == 0 else {
        throw ControllingPTYTestError.signalFailed
      }
    case .suspend:
      try writeInput([0x1a])
    }
  }

  func waitForStop() async throws -> (signal: Int32, output: [UInt8]) {
    var output: [UInt8] = []
    let deadline = DispatchTime.now().uptimeNanoseconds + 5_000_000_000
    while DispatchTime.now().uptimeNanoseconds < deadline {
      output.append(contentsOf: try readAvailable())
      guard output.count <= 64 * 1024 else {
        throw ControllingPTYTestError.outputExceeded
      }
      if let signal = markerValue(ptyStoppedMarker, in: output) {
        return (signal, output)
      }
      try await Task.sleep(for: .milliseconds(10))
    }
    throw ControllingPTYTestError.timedOut(
      String(decoding: output, as: UTF8.self)
    )
  }

  func resume() throws {
    guard let workerPID = ownedWorkerPID, Darwin.kill(workerPID, SIGCONT) == 0 else {
      throw ControllingPTYTestError.signalFailed
    }
  }

  func waitForCompletion() async throws -> [UInt8] {
    var output: [UInt8] = []
    let deadline = DispatchTime.now().uptimeNanoseconds + 5_000_000_000
    while DispatchTime.now().uptimeNanoseconds < deadline {
      output.append(contentsOf: try readAvailable())
      guard output.count <= 64 * 1024 else {
        throw ControllingPTYTestError.outputExceeded
      }
      if markerValue(ptyDoneMarker, in: output) == 0 { return output }
      try await Task.sleep(for: .milliseconds(10))
    }
    throw ControllingPTYTestError.timedOut(
      String(decoding: output, as: UTF8.self)
    )
  }

  func closeTerminal() {
    let shouldClose = lock.withLock { () -> Bool in
      guard !masterClosed else { return false }
      masterClosed = true
      return true
    }
    if shouldClose { _ = Darwin.close(master) }
  }

  var hasLiveOwnedProcess: Bool {
    if Darwin.kill(pid, 0) == 0 || errno != ESRCH { return true }
    guard let workerPID = currentWorkerPID else { return false }
    return getsid(workerPID) == pid
  }

  func waitForExit() async throws -> Int32 {
    try await wait(options: 0, terminal: true)
  }

  func forceCleanup() {
    let state = lock.withLock { (reaped, workerPID) }
    let alreadyReaped = state.0
    guard !alreadyReaped else { return }
    closeTerminal()
    if waitForExactChildExit(pid, timeoutNanoseconds: 250_000_000) {
      lock.withLock { reaped = true }
      return
    }
    if let workerPID = state.1, getsid(workerPID) == pid {
      _ = Darwin.kill(workerPID, SIGCONT)
      _ = Darwin.kill(workerPID, SIGKILL)
    }
    if !waitForExactChildExit(pid, timeoutNanoseconds: 250_000_000) {
      terminateAndReapExactChild(pid)
    }
    lock.withLock { reaped = true }
  }

  private func readAvailable() throws -> [UInt8] {
    var result: [UInt8] = []
    var buffer = [UInt8](repeating: 0, count: 1024)
    while true {
      let count = buffer.withUnsafeMutableBytes { storage in
        Darwin.read(master, storage.baseAddress, storage.count)
      }
      if count > 0 {
        result.append(contentsOf: buffer[..<count])
        continue
      }
      if count < 0, errno == EINTR { continue }
      if count < 0, errno == EAGAIN || errno == EWOULDBLOCK { return result }
      if count == 0 { return result }
      throw ControllingPTYTestError.outputFailed
    }
  }

  private var currentWorkerPID: pid_t? {
    lock.withLock { workerPID }
  }

  private var ownedWorkerPID: pid_t? {
    guard let workerPID = currentWorkerPID, getsid(workerPID) == pid else {
      return nil
    }
    return workerPID
  }

  private func recordWorkerPID(from output: [UInt8]) {
    guard let value = markerValue(ptyWorkerMarker, in: output), value > 0 else {
      return
    }
    lock.withLock { workerPID = value }
  }

  private func wait(options: Int32, terminal: Bool) async throws -> Int32 {
    let deadline = DispatchTime.now().uptimeNanoseconds + 5_000_000_000
    while DispatchTime.now().uptimeNanoseconds < deadline {
      var status: Int32 = 0
      let result = waitpid(pid, &status, options | WNOHANG)
      if result == pid {
        if terminal { lock.withLock { reaped = true } }
        return status
      }
      if result < 0, errno == EINTR { continue }
      guard result == 0 else { throw ControllingPTYTestError.waitFailed }
      try await Task.sleep(for: .milliseconds(10))
    }
    let pending = (try? readAvailable()) ?? []
    throw ControllingPTYTestError.timedOut(
      "waiting for supervisor exit\n" + String(decoding: pending, as: UTF8.self)
    )
  }
}

private func runPTYSessionSupervisor(
  scenario: PTYSignalScenario
) throws {
  guard
    setsid() > 0,
    ioctl(STDIN_FILENO, TIOCSCTTY, 0) == 0,
    tcsetpgrp(STDIN_FILENO, getpgrp()) == 0
  else {
    throw ControllingPTYTestError.sessionSetupFailed
  }

  var gate = [Int32](repeating: -1, count: 2)
  guard Darwin.pipe(&gate) == 0 else {
    throw ControllingPTYTestError.spawnFailed
  }
  var gateReadOpen = true
  var gateWriteOpen = true
  var workerPID: pid_t = 0
  var workerReaped = false
  defer {
    if gateReadOpen { _ = Darwin.close(gate[0]) }
    if gateWriteOpen { _ = Darwin.close(gate[1]) }
    if workerPID > 0, !workerReaped {
      terminateAndReapExactChild(workerPID)
    }
  }

  let invocation = try childInvocation(scenario: scenario, role: .worker)
  var fileActions: posix_spawn_file_actions_t?
  guard posix_spawn_file_actions_init(&fileActions) == 0 else {
    throw ControllingPTYTestError.spawnFailed
  }
  defer { posix_spawn_file_actions_destroy(&fileActions) }
  guard
    posix_spawn_file_actions_addopen(
      &fileActions,
      STDIN_FILENO,
      "/dev/tty",
      O_RDWR,
      0
    ) == 0,
    posix_spawn_file_actions_adddup2(
      &fileActions,
      STDIN_FILENO,
      STDOUT_FILENO
    ) == 0,
    posix_spawn_file_actions_adddup2(
      &fileActions,
      STDIN_FILENO,
      STDERR_FILENO
    ) == 0,
    posix_spawn_file_actions_adddup2(
      &fileActions,
      gate[0],
      ptyWorkerGateDescriptor
    ) == 0,
    posix_spawn_file_actions_addclose(&fileActions, gate[0]) == 0,
    posix_spawn_file_actions_addclose(&fileActions, gate[1]) == 0
  else {
    throw ControllingPTYTestError.spawnFailed
  }

  workerPID = try spawnChild(
    invocation,
    fileActions: &fileActions,
    createsProcessGroup: true
  )
  _ = Darwin.close(gate[0])
  gateReadOpen = false

  try writeBytes(
    ptyWorkerMarker + Array("\(workerPID)\n".utf8),
    to: STDOUT_FILENO
  )
  guard
    getpgid(workerPID) == workerPID,
    tcsetpgrp(STDIN_FILENO, workerPID) == 0
  else {
    throw ControllingPTYTestError.sessionSetupFailed
  }
  try writeBytes([1], to: gate[1])
  _ = Darwin.close(gate[1])
  gateWriteOpen = false

  var status = try waitForExactChild(
    workerPID,
    options: scenario == .suspend ? WUNTRACED : 0
  )
  if scenario == .suspend {
    guard stoppedSignal(status) == SIGTSTP else {
      throw ControllingPTYTestError.unexpectedStatus
    }
    try writeBytes(
      ptyStoppedMarker + Array("\(SIGTSTP)\n".utf8),
      to: STDOUT_FILENO
    )
    status = try waitForExactChild(workerPID, options: 0)
  }
  workerReaped = true

  _ = Darwin.signal(SIGTTOU, SIG_IGN)
  _ = Darwin.signal(SIGHUP, SIG_IGN)
  guard tcsetpgrp(STDIN_FILENO, getpgrp()) == 0, exitCode(status) == 0 else {
    throw ControllingPTYTestError.unexpectedStatus
  }
  try writeBytes(ptyDoneMarker + Array("0\n".utf8), to: STDOUT_FILENO)
}

private func exitPTYSessionSupervisor(_ status: Int32) -> Never {
  _ = Darwin.close(STDIN_FILENO)
  _ = Darwin.close(STDOUT_FILENO)
  _ = Darwin.close(STDERR_FILENO)
  Darwin._exit(status)
}

private func waitForSupervisorGate() throws {
  defer { _ = Darwin.close(ptyWorkerGateDescriptor) }
  var byte: UInt8 = 0
  while true {
    let count = Darwin.read(ptyWorkerGateDescriptor, &byte, 1)
    if count < 0, errno == EINTR { continue }
    guard count == 1, byte == 1 else {
      throw ControllingPTYTestError.sessionSetupFailed
    }
    return
  }
}

private struct ChildInvocation {
  let executable: String
  let arguments: [String]
  let environment: [String]
}

private func childInvocation(
  scenario: PTYSignalScenario,
  role: PTYChildRole
) throws -> ChildInvocation {
  let bundle = Bundle(for: TestBundleMarker.self)
  guard
    bundle.bundleURL.pathExtension == "xctest",
    let bundleExecutable = bundle.executableURL?.path,
    let helper = CommandLine.arguments.first,
    helper.hasSuffix("swiftpm-testing-helper")
  else {
    throw ControllingPTYTestError.helperUnavailable
  }
  let packagePath = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .path
  let arguments = [
    helper,
    "--test-bundle-path",
    bundleExecutable,
    "--package-path",
    packagePath,
    "--filter",
    "LauncherControllingPTYChildTests",
    bundleExecutable,
    "--testing-library",
    "swift-testing",
  ]
  let inherited = ProcessInfo.processInfo.environment
  var environment: [String: String] = [:]
  for key in ["PATH", "HOME", "TMPDIR"] {
    environment[key] = inherited[key]
  }
  environment[ptyChildSignalKey] = scenario.rawValue
  environment[ptyChildRoleKey] = role.rawValue
  if let frameworkPath = inherited["DYLD_FRAMEWORK_PATH"] {
    environment["DYLD_FRAMEWORK_PATH"] = frameworkPath
  } else if let toolchains = helper.range(of: "/Toolchains/") {
    let developerDirectory = helper[..<toolchains.lowerBound]
    environment["DYLD_FRAMEWORK_PATH"] =
      "\(developerDirectory)/Platforms/MacOSX.platform/Developer/Library/Frameworks"
  }
  return ChildInvocation(
    executable: helper,
    arguments: arguments,
    environment: environment.sorted { $0.key < $1.key }
      .map { "\($0.key)=\($0.value)" }
  )
}

private func spawnChild(
  _ invocation: ChildInvocation,
  fileActions: inout posix_spawn_file_actions_t?,
  createsProcessGroup: Bool = false
) throws -> pid_t {
  var attributes: posix_spawnattr_t?
  guard posix_spawnattr_init(&attributes) == 0 else {
    throw ControllingPTYTestError.spawnFailed
  }
  defer { posix_spawnattr_destroy(&attributes) }
  var flags = Int16(
    POSIX_SPAWN_CLOEXEC_DEFAULT
      | POSIX_SPAWN_SETSIGDEF
      | POSIX_SPAWN_SETSIGMASK
  )
  if createsProcessGroup {
    flags |= Int16(POSIX_SPAWN_SETPGROUP)
    guard posix_spawnattr_setpgroup(&attributes, 0) == 0 else {
      throw ControllingPTYTestError.spawnFailed
    }
  }
  guard posix_spawnattr_setflags(&attributes, flags) == 0 else {
    throw ControllingPTYTestError.spawnFailed
  }

  var emptyMask = sigset_t()
  var defaultSignals = sigset_t()
  guard sigemptyset(&emptyMask) == 0, sigemptyset(&defaultSignals) == 0 else {
    throw ControllingPTYTestError.spawnFailed
  }
  for signalNumber in [
    SIGINT, SIGTERM, SIGHUP, SIGQUIT, SIGTSTP, SIGCONT, SIGPIPE, SIGTTOU,
  ] {
    guard sigaddset(&defaultSignals, signalNumber) == 0 else {
      throw ControllingPTYTestError.spawnFailed
    }
  }
  guard
    posix_spawnattr_setsigmask(&attributes, &emptyMask) == 0,
    posix_spawnattr_setsigdefault(&attributes, &defaultSignals) == 0
  else {
    throw ControllingPTYTestError.spawnFailed
  }

  guard
    let executable = strdup(invocation.executable),
    let arguments = CStringVector(invocation.arguments),
    let environment = CStringVector(invocation.environment)
  else {
    throw ControllingPTYTestError.spawnFailed
  }
  defer { free(executable) }

  var pid: pid_t = 0
  let result = arguments.withUnsafeMutableBufferPointer { argv in
    environment.withUnsafeMutableBufferPointer { envp in
      posix_spawn(
        &pid,
        executable,
        &fileActions,
        &attributes,
        argv.baseAddress,
        envp.baseAddress
      )
    }
  }
  guard result == 0, pid > 0 else {
    throw ControllingPTYTestError.spawnFailed
  }
  return pid
}

private func waitForExactChild(
  _ pid: pid_t,
  options: Int32
) throws -> Int32 {
  var status: Int32 = 0
  while true {
    let result = waitpid(pid, &status, options)
    if result < 0, errno == EINTR { continue }
    guard result == pid else { throw ControllingPTYTestError.waitFailed }
    return status
  }
}

private func terminateAndReapExactChild(_ pid: pid_t) {
  _ = Darwin.kill(pid, SIGCONT)
  _ = Darwin.kill(pid, SIGKILL)
  _ = waitForExactChildExit(pid, timeoutNanoseconds: 1_000_000_000)
}

private func waitForExactChildExit(
  _ pid: pid_t,
  timeoutNanoseconds: UInt64
) -> Bool {
  let deadline = DispatchTime.now().uptimeNanoseconds + timeoutNanoseconds
  while DispatchTime.now().uptimeNanoseconds < deadline {
    var status: Int32 = 0
    let result = waitpid(pid, &status, WNOHANG)
    if result == pid || (result < 0 && errno == ECHILD) { return true }
    if result < 0, errno != EINTR { return false }
    _ = Darwin.usleep(10_000)
  }
  return false
}

private func writeBytes(
  _ bytes: [UInt8],
  to descriptor: Int32
) throws {
  var offset = 0
  while offset < bytes.count {
    let count = bytes.withUnsafeBytes { storage in
      Darwin.write(
        descriptor,
        storage.baseAddress!.advanced(by: offset),
        bytes.count - offset
      )
    }
    if count < 0, errno == EINTR { continue }
    guard count > 0 else { throw ControllingPTYTestError.outputFailed }
    offset += count
  }
}

private func configureTerminal(_ descriptor: Int32) throws -> termios {
  var attributes = termios()
  guard tcgetattr(descriptor, &attributes) == 0 else {
    throw ControllingPTYTestError.terminalSetupFailed
  }
  attributes.c_lflag |= tcflag_t(ECHO | ECHONL | ICANON | ISIG)
  attributes.c_lflag &= ~tcflag_t(TOSTOP)
  withUnsafeMutableBytes(of: &attributes.c_cc) { bytes in
    bytes[Int(VINTR)] = 0x03
    bytes[Int(VSUSP)] = 0x1a
  }
  guard tcsetattr(descriptor, TCSAFLUSH, &attributes) == 0 else {
    throw ControllingPTYTestError.terminalSetupFailed
  }
  var configured = termios()
  guard tcgetattr(descriptor, &configured) == 0 else {
    throw ControllingPTYTestError.terminalSetupFailed
  }
  return configured
}

private func setNonblocking(_ descriptor: Int32) -> Bool {
  let flags = fcntl(descriptor, F_GETFL)
  return flags >= 0 && fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) == 0
}

private func termiosBytes(_ value: termios) -> [UInt8] {
  withUnsafeBytes(of: value) { Array($0) }
}

private func containsSubsequence(
  _ bytes: [UInt8],
  _ subsequence: [UInt8]
) -> Bool {
  guard !subsequence.isEmpty, bytes.count >= subsequence.count else {
    return false
  }
  for index in 0...(bytes.count - subsequence.count)
  where bytes[index..<(index + subsequence.count)].elementsEqual(subsequence) {
    return true
  }
  return false
}

private func markerValue(
  _ marker: [UInt8],
  in bytes: [UInt8]
) -> Int32? {
  guard !marker.isEmpty, bytes.count > marker.count else { return nil }
  for index in 0...(bytes.count - marker.count)
  where bytes[index..<(index + marker.count)].elementsEqual(marker) {
    let valueStart = index + marker.count
    guard
      let newline = bytes[valueStart...].firstIndex(of: 0x0a),
      newline > valueStart
    else {
      continue
    }
    var valueEnd = newline
    if bytes[valueEnd - 1] == 0x0d { valueEnd -= 1 }
    let digits = bytes[valueStart..<valueEnd]
    guard digits.allSatisfy({ (0x30...0x39).contains($0) }) else {
      continue
    }
    return Int32(String(decoding: digits, as: UTF8.self))
  }
  return nil
}

private func stoppedSignal(_ status: Int32) -> Int32? {
  status & 0x7f == 0x7f ? (status >> 8) & 0xff : nil
}

private func exitCode(_ status: Int32) -> Int32? {
  status & 0x7f == 0 ? (status >> 8) & 0xff : nil
}

private final class CStringVector {
  private var pointers: [UnsafeMutablePointer<CChar>?]

  init?(_ strings: [String]) {
    pointers = []
    pointers.reserveCapacity(strings.count + 1)
    for string in strings {
      guard !string.utf8.contains(0), let pointer = strdup(string) else {
        for pointer in pointers { free(pointer) }
        return nil
      }
      pointers.append(pointer)
    }
    pointers.append(nil)
  }

  deinit {
    for pointer in pointers { free(pointer) }
  }

  func withUnsafeMutableBufferPointer<Result>(
    _ body: (inout UnsafeMutableBufferPointer<UnsafeMutablePointer<CChar>?>) -> Result
  ) -> Result {
    pointers.withUnsafeMutableBufferPointer(body)
  }
}

private final class TestBundleMarker {}

private enum ControllingPTYTestError: Error {
  case terminalSetupFailed
  case sessionSetupFailed
  case helperUnavailable
  case spawnFailed
  case inputFailed
  case outputFailed
  case outputExceeded
  case signalFailed
  case waitFailed
  case unexpectedStatus
  case timedOut(String)
}
