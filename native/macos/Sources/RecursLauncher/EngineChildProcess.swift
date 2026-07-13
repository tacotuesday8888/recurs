import Darwin
import Dispatch
import Foundation

package enum EngineTermination: Equatable, Sendable {
  case exited(Int32)
  case signaled(Int32)
}

package enum EngineChildProcessError: Error, Equatable, Sendable {
  case socketSetupFailed
  case spawnFailed
  case waitFailed
  case shutdownFailed
}

enum EngineChildProcessCallFailure: Error, Equatable, Sendable {
  case interrupted
  case failed
}

enum EngineChildProcessWaitResult: Equatable, Sendable {
  case running
  case reaped(status: Int32)
}

struct EngineChildProcessSystem: @unchecked Sendable {
  let makeSocketPair: @Sendable () -> Result<(Int32, Int32), EngineChildProcessCallFailure>
  let duplicateDescriptor: @Sendable (Int32) -> Result<Int32, EngineChildProcessCallFailure>
  let closeDescriptor: @Sendable (Int32) -> Void
  let launcherSocketSystem: LauncherNodeSocketSystem
  let spawn:
    @Sendable (
      _ executable: String,
      _ arguments: [String],
      _ environment: [String],
      _ engineDescriptor: Int32
    ) -> Result<pid_t, EngineChildProcessCallFailure>
  let wait:
    @Sendable (pid_t, Int32) -> Result<
      EngineChildProcessWaitResult, EngineChildProcessCallFailure
    >
  let signal: @Sendable (pid_t, Int32) -> Result<Void, EngineChildProcessCallFailure>
  let nowNanoseconds: @Sendable () -> UInt64
  let sleep: @Sendable (UInt64) async -> Void

  static let live = EngineChildProcessSystem(
    makeSocketPair: {
      var descriptors = [Int32](repeating: -1, count: 2)
      guard socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors) == 0 else {
        return .failure(engineCallFailure())
      }
      return .success((descriptors[0], descriptors[1]))
    },
    duplicateDescriptor: { descriptor in
      let duplicated = fcntl(descriptor, F_DUPFD_CLOEXEC, 4)
      return duplicated == -1
        ? .failure(engineCallFailure()) : .success(duplicated)
    },
    closeDescriptor: { descriptor in
      _ = Darwin.close(descriptor)
    },
    launcherSocketSystem: .live,
    spawn: { executable, arguments, environment, engineDescriptor in
      liveSpawn(
        executable: executable,
        arguments: arguments,
        environment: environment,
        engineDescriptor: engineDescriptor
      )
    },
    wait: { pid, options in
      var status: Int32 = 0
      let result = waitpid(pid, &status, options)
      if result == pid {
        return .success(.reaped(status: status))
      }
      if result == 0 {
        return .success(.running)
      }
      return .failure(engineCallFailure())
    },
    signal: { pid, signal in
      Darwin.kill(pid, signal) == 0
        ? .success(()) : .failure(engineCallFailure())
    },
    nowNanoseconds: { DispatchTime.now().uptimeNanoseconds },
    sleep: { nanoseconds in
      try? await Task.sleep(nanoseconds: nanoseconds)
    }
  )
}

package final class EngineChildProcess: @unchecked Sendable {
  package let socket: LauncherNodeSocket

  private let lifecycle: EngineChildLifecycle

  private init(
    socket: LauncherNodeSocket,
    pid: pid_t,
    system: EngineChildProcessSystem
  ) {
    self.socket = socket
    self.lifecycle = EngineChildLifecycle(pid: pid, system: system)
  }

  deinit {
    let socket = socket
    let lifecycle = lifecycle
    Task { [socket, lifecycle] in
      await socket.close()
      _ = try? await lifecycle.shutdown()
    }
  }

  package static func start(
    layout: EngineBundleLayout,
    arguments: [String] = [],
    environment: [String: String] = ProcessInfo.processInfo.environment
  ) async throws -> EngineChildProcess {
    try await start(
      layout: layout,
      arguments: arguments,
      environment: environment,
      system: .live
    )
  }

  static func start(
    layout: EngineBundleLayout,
    arguments: [String] = [],
    environment: [String: String],
    system: EngineChildProcessSystem
  ) async throws -> EngineChildProcess {
    let executable = layout.nodeExecutable.path
    let spawnArguments = [executable, layout.engineEntrypoint.path] + arguments
    let spawnEnvironment = try makeEngineEnvironment(environment)
    guard
      !executable.isEmpty,
      !spawnArguments.contains(where: containsNullByte),
      !spawnEnvironment.contains(where: containsNullByte)
    else {
      throw EngineChildProcessError.spawnFailed
    }

    let rawDescriptors = try retryInterrupted(
      system.makeSocketPair,
      error: .socketSetupFailed
    )
    var rawLauncherOpen = true
    var rawEngineOpen = true
    defer {
      if rawLauncherOpen {
        system.closeDescriptor(rawDescriptors.0)
      }
      if rawEngineOpen {
        system.closeDescriptor(rawDescriptors.1)
      }
    }

    let launcherDescriptor: Int32
    do {
      launcherDescriptor = try retryInterrupted(
        { system.duplicateDescriptor(rawDescriptors.0) },
        error: .socketSetupFailed
      )
      guard launcherDescriptor > 3 else {
        throw EngineChildProcessError.socketSetupFailed
      }
    } catch {
      throw EngineChildProcessError.socketSetupFailed
    }

    let engineDescriptor: Int32
    do {
      engineDescriptor = try retryInterrupted(
        { system.duplicateDescriptor(rawDescriptors.1) },
        error: .socketSetupFailed
      )
    } catch {
      system.closeDescriptor(launcherDescriptor)
      throw EngineChildProcessError.socketSetupFailed
    }
    guard engineDescriptor > 3 else {
      system.closeDescriptor(launcherDescriptor)
      throw EngineChildProcessError.socketSetupFailed
    }
    guard engineDescriptor != launcherDescriptor else {
      system.closeDescriptor(engineDescriptor)
      throw EngineChildProcessError.socketSetupFailed
    }

    system.closeDescriptor(rawDescriptors.0)
    rawLauncherOpen = false
    system.closeDescriptor(rawDescriptors.1)
    rawEngineOpen = false

    let socket: LauncherNodeSocket
    do {
      socket = try LauncherNodeSocket(
        ownedDescriptor: launcherDescriptor,
        system: system.launcherSocketSystem
      )
    } catch {
      system.closeDescriptor(launcherDescriptor)
      system.closeDescriptor(engineDescriptor)
      throw EngineChildProcessError.socketSetupFailed
    }

    let spawnResult = system.spawn(
      executable,
      spawnArguments,
      spawnEnvironment,
      engineDescriptor
    )
    system.closeDescriptor(engineDescriptor)

    guard case .success(let pid) = spawnResult, pid > 0 else {
      await socket.close()
      throw EngineChildProcessError.spawnFailed
    }

    return EngineChildProcess(socket: socket, pid: pid, system: system)
  }

  package func wait() async throws -> EngineTermination {
    do {
      let termination = try await lifecycle.wait()
      await socket.close()
      return termination
    } catch {
      await socket.close()
      throw error
    }
  }

  package func shutdown() async throws -> EngineTermination {
    await socket.close()
    return try await lifecycle.shutdown()
  }

  func ownsExactPIDForTesting() async -> Bool {
    await lifecycle.ownsExactPID()
  }
}

private actor EngineChildLifecycle {
  private static let pollNanoseconds: UInt64 = 50_000_000
  private static let shutdownGraceNanoseconds: UInt64 = 2_000_000_000

  private let system: EngineChildProcessSystem
  private var pid: pid_t?
  private var finalResult: Result<EngineTermination, EngineChildProcessError>?
  private var runner: Task<Result<EngineTermination, EngineChildProcessError>, Never>?
  private var shutdownRequested = false
  private var termSent = false
  private var killSent = false
  private var shutdownDeadline: UInt64?

  init(pid: pid_t, system: EngineChildProcessSystem) {
    precondition(pid > 0)
    self.pid = pid
    self.system = system
  }

  func wait() async throws -> EngineTermination {
    try await runTask().value.get()
  }

  func shutdown() async throws -> EngineTermination {
    shutdownRequested = true
    return try await runTask().value.get()
  }

  func ownsExactPID() -> Bool {
    pid != nil
  }

  private func runTask() -> Task<
    Result<EngineTermination, EngineChildProcessError>, Never
  > {
    if let runner {
      return runner
    }
    let task = Task { await self.pollUntilReaped() }
    runner = task
    return task
  }

  private func pollUntilReaped() async -> Result<
    EngineTermination, EngineChildProcessError
  > {
    if let finalResult {
      return finalResult
    }

    while let ownedPID = pid {
      switch waitOnce(pid: ownedPID) {
      case .failure(let error):
        return storeFailure(error)
      case .success(.reaped(let status)):
        guard let termination = decodeWaitStatus(status) else {
          return finishAfterReap(.failure(.waitFailed))
        }
        return finishAfterReap(.success(termination))
      case .success(.running):
        break
      }

      if shutdownRequested {
        if !termSent {
          termSent = true
          guard signal(pid: ownedPID, signal: SIGTERM) else {
            return storeFailure(.shutdownFailed)
          }
          shutdownDeadline = deadline(
            from: system.nowNanoseconds(),
            after: Self.shutdownGraceNanoseconds
          )
        } else if !killSent,
          let shutdownDeadline,
          system.nowNanoseconds() >= shutdownDeadline
        {
          killSent = true
          guard signal(pid: ownedPID, signal: SIGKILL) else {
            return storeFailure(.shutdownFailed)
          }
        }
      }

      await system.sleep(Self.pollNanoseconds)
    }

    return finalResult ?? .failure(.waitFailed)
  }

  private func waitOnce(
    pid: pid_t
  ) -> Result<EngineChildProcessWaitResult, EngineChildProcessError> {
    while true {
      switch system.wait(pid, WNOHANG) {
      case .success(let result):
        return .success(result)
      case .failure(.interrupted):
        continue
      case .failure(.failed):
        return .failure(.waitFailed)
      }
    }
  }

  private func signal(pid: pid_t, signal: Int32) -> Bool {
    while true {
      switch system.signal(pid, signal) {
      case .success:
        return true
      case .failure(.interrupted):
        continue
      case .failure(.failed):
        return false
      }
    }
  }

  private func finishAfterReap(
    _ result: Result<EngineTermination, EngineChildProcessError>
  ) -> Result<EngineTermination, EngineChildProcessError> {
    finalResult = result
    pid = nil
    return result
  }

  private func storeFailure(
    _ error: EngineChildProcessError
  ) -> Result<EngineTermination, EngineChildProcessError> {
    let result: Result<EngineTermination, EngineChildProcessError> = .failure(error)
    finalResult = result
    return result
  }
}

private let engineEnvironmentKeys = [
  "HOME",
  "PATH",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "TZ",
  "RECURS_HOME",
  "CODEX_HOME",
]

private let engineAutomationEnvironmentKeys = [
  "CI",
  "CONTINUOUS_INTEGRATION",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "BUILDKITE",
  "CIRCLECI",
  "TF_BUILD",
  "TEAMCITY_VERSION",
  "JENKINS_URL",
  "BITBUCKET_BUILD_NUMBER",
  "CODEBUILD_BUILD_ID",
]

private func makeEngineEnvironment(
  _ source: [String: String]
) throws -> [String] {
  var environment: [String] = []
  for key in engineEnvironmentKeys {
    if let value = source[key] {
      guard !containsNullByte(value) else {
        throw EngineChildProcessError.spawnFailed
      }
      environment.append("\(key)=\(value)")
    }
  }
  for key in engineAutomationEnvironmentKeys where isTruthy(source[key]) {
    environment.append("\(key)=1")
  }
  environment.append("RECURS_NATIVE_FD=3")
  return environment
}

private func isTruthy(_ value: String?) -> Bool {
  guard let value else {
    return false
  }
  let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
    .lowercased()
  return !normalized.isEmpty
    && normalized != "0"
    && normalized != "false"
    && normalized != "no"
    && normalized != "off"
}

private func containsNullByte(_ value: String) -> Bool {
  value.utf8.contains(0)
}

private func retryInterrupted<Value>(
  _ operation: () -> Result<Value, EngineChildProcessCallFailure>,
  error: EngineChildProcessError
) throws -> Value {
  while true {
    switch operation() {
    case .success(let value):
      return value
    case .failure(.interrupted):
      continue
    case .failure(.failed):
      throw error
    }
  }
}

private func deadline(from now: UInt64, after duration: UInt64) -> UInt64 {
  let (deadline, overflow) = now.addingReportingOverflow(duration)
  return overflow ? UInt64.max : deadline
}

private func decodeWaitStatus(_ status: Int32) -> EngineTermination? {
  let lowBits = status & 0x7f
  if lowBits == 0 {
    return .exited((status >> 8) & 0xff)
  }
  guard lowBits != 0x7f else {
    return nil
  }
  return .signaled(lowBits)
}

private func engineCallFailure() -> EngineChildProcessCallFailure {
  errno == EINTR ? .interrupted : .failed
}

private func liveSpawn(
  executable: String,
  arguments: [String],
  environment: [String],
  engineDescriptor: Int32
) -> Result<pid_t, EngineChildProcessCallFailure> {
  guard
    engineDescriptor > 3,
    let executableCString = strdup(executable)
  else {
    return .failure(.failed)
  }
  defer { free(executableCString) }
  guard
    let argumentVector = EngineCStringVector(arguments),
    let environmentVector = EngineCStringVector(environment)
  else {
    return .failure(.failed)
  }

  var fileActions: posix_spawn_file_actions_t?
  guard posix_spawn_file_actions_init(&fileActions) == 0 else {
    return .failure(.failed)
  }
  defer { posix_spawn_file_actions_destroy(&fileActions) }

  for descriptor: Int32 in 0...2 {
    guard posix_spawn_file_actions_addinherit_np(&fileActions, descriptor) == 0 else {
      return .failure(.failed)
    }
  }
  guard
    posix_spawn_file_actions_adddup2(&fileActions, engineDescriptor, 3) == 0,
    posix_spawn_file_actions_addclose(&fileActions, engineDescriptor) == 0
  else {
    return .failure(.failed)
  }

  var attributes: posix_spawnattr_t?
  guard posix_spawnattr_init(&attributes) == 0 else {
    return .failure(.failed)
  }
  defer { posix_spawnattr_destroy(&attributes) }

  let flags = Int16(
    POSIX_SPAWN_CLOEXEC_DEFAULT
      | POSIX_SPAWN_SETSIGDEF
      | POSIX_SPAWN_SETSIGMASK
  )
  guard posix_spawnattr_setflags(&attributes, flags) == 0 else {
    return .failure(.failed)
  }

  var emptyMask = sigset_t()
  guard sigemptyset(&emptyMask) == 0 else {
    return .failure(.failed)
  }
  var defaultSignals = sigset_t()
  guard sigemptyset(&defaultSignals) == 0 else {
    return .failure(.failed)
  }
  for signal in [SIGINT, SIGTERM, SIGHUP, SIGQUIT, SIGPIPE] {
    guard sigaddset(&defaultSignals, signal) == 0 else {
      return .failure(.failed)
    }
  }
  guard
    posix_spawnattr_setsigmask(&attributes, &emptyMask) == 0,
    posix_spawnattr_setsigdefault(&attributes, &defaultSignals) == 0
  else {
    return .failure(.failed)
  }

  var pid: pid_t = 0
  let spawnResult = argumentVector.withUnsafeMutableBufferPointer { argv in
    environmentVector.withUnsafeMutableBufferPointer { envp in
      posix_spawn(
        &pid,
        executableCString,
        &fileActions,
        &attributes,
        argv.baseAddress,
        envp.baseAddress
      )
    }
  }
  guard spawnResult == 0, pid > 0 else {
    return .failure(.failed)
  }
  return .success(pid)
}

private final class EngineCStringVector {
  private var pointers: [UnsafeMutablePointer<CChar>?]

  init?(_ strings: [String]) {
    pointers = []
    pointers.reserveCapacity(strings.count + 1)
    for string in strings {
      guard !containsNullByte(string), let pointer = strdup(string) else {
        for pointer in pointers {
          free(pointer)
        }
        return nil
      }
      pointers.append(pointer)
    }
    pointers.append(nil)
  }

  deinit {
    for pointer in pointers {
      free(pointer)
    }
  }

  func withUnsafeMutableBufferPointer<Result>(
    _ body: (inout UnsafeMutableBufferPointer<UnsafeMutablePointer<CChar>?>) -> Result
  ) -> Result {
    pointers.withUnsafeMutableBufferPointer(body)
  }
}
