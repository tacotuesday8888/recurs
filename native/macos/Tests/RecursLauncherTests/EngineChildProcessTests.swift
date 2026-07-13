import Darwin
import Foundation
import Testing

@testable import RecursLauncher

@Suite("Engine child process")
struct EngineChildProcessTests {
  @Test
  func automationDetectionUsesOnlyReviewedTruthyMarkers() {
    #expect(!isLauncherAutomationEnvironment([:]))
    #expect(!isLauncherAutomationEnvironment(["CI": " off "]))
    #expect(!isLauncherAutomationEnvironment(["UNREVIEWED_CI": "true"]))
    #expect(isLauncherAutomationEnvironment(["CI": "yes"]))
    #expect(isLauncherAutomationEnvironment(["GITHUB_ACTIONS": "1"]))
  }

  @Test
  func terminationAndErrorsAreFixedAndPathFree() {
    #expect(EngineTermination.exited(0) == .exited(0))
    #expect(EngineTermination.signaled(SIGTERM) == .signaled(SIGTERM))

    for error in [
      EngineChildProcessError.socketSetupFailed,
      .spawnFailed,
      .waitFailed,
      .shutdownFailed,
    ] {
      let rendered = String(reflecting: error)
      #expect(!rendered.contains("/"))
      #expect(!rendered.contains("SECRET_ENGINE_CANARY"))
    }
  }

  @Test
  func startUsesFixedArgvAndReviewedEnvironment() async throws {
    let fixture = RecordingEngineChildSystem()
    let child = try await EngineChildProcess.start(
      layout: fixedLayout,
      arguments: ["doctor", "native", "--json"],
      environment: [
        "HOME": "/safe/home",
        "PATH": "/safe/bin",
        "LANG": "en_US.UTF-8",
        "TERM": "xterm-256color",
        "RECURS_HOME": "/safe/recurs",
        "CI": " yes ",
        "GITHUB_ACTIONS": "true",
        "GITLAB_CI": "off",
        "RECURS_NATIVE_FD": "99",
        "NODE_OPTIONS": "SECRET_ENGINE_CANARY",
        "NODE_PATH": "/SECRET_ENGINE_CANARY",
        "DYLD_INSERT_LIBRARIES": "/SECRET_ENGINE_CANARY",
        "HTTPS_PROXY": "http://SECRET_ENGINE_CANARY",
        "AWS_SECRET_ACCESS_KEY": "SECRET_ENGINE_CANARY",
        "TOKEN": "SECRET_ENGINE_CANARY",
      ],
      system: fixture.system
    )

    #expect(fixture.spawnExecutable == "/fixed/runtime/bin/node")
    #expect(
      fixture.spawnArguments == [
        "/fixed/runtime/bin/node",
        "/fixed/engine/main.js",
        "doctor",
        "native",
        "--json",
      ])
    #expect(
      fixture.spawnEnvironment == [
        "HOME=/safe/home",
        "PATH=/safe/bin",
        "LANG=en_US.UTF-8",
        "TERM=xterm-256color",
        "RECURS_HOME=/safe/recurs",
        "CI=1",
        "GITHUB_ACTIONS=1",
        "RECURS_NATIVE_FD=3",
      ])
    #expect(fixture.spawnEngineDescriptor == 11)
    #expect(fixture.closedDescriptors == [8, 9, 11])
    #expect(!fixture.closedDescriptors.contains(10))

    fixture.enqueueWait(.reaped(status: 0))
    #expect(try await child.wait() == .exited(0))
    #expect(fixture.closedDescriptors == [8, 9, 11, 10])
  }

  @Test
  func spawnFailureClosesEveryOwnedEndpoint() async {
    let fixture = RecordingEngineChildSystem(spawnFails: true)

    await #expect(throws: EngineChildProcessError.spawnFailed) {
      _ = try await EngineChildProcess.start(
        layout: fixedLayout,
        environment: ["HOME": "/safe/home"],
        system: fixture.system
      )
    }

    #expect(fixture.closedDescriptors == [8, 9, 11, 10])
    #expect(fixture.shutdownDescriptors == [10])
  }

  @Test
  func concurrentWaitersShareOneExactPIDReaper() async throws {
    let fixture = RecordingEngineChildSystem()
    fixture.enqueueWait(.running)
    fixture.enqueueWait(.reaped(status: 23 << 8))
    let child = try await EngineChildProcess.start(
      layout: fixedLayout,
      environment: [:],
      system: fixture.system
    )

    let terminations = try await withThrowingTaskGroup(
      of: EngineTermination.self,
      returning: [EngineTermination].self
    ) { group in
      for _ in 0..<12 {
        group.addTask { try await child.wait() }
      }
      var values: [EngineTermination] = []
      for try await value in group {
        values.append(value)
      }
      return values
    }

    #expect(terminations == Array(repeating: .exited(23), count: 12))
    #expect(fixture.waitCalls.map(\.pid) == [41, 41])
    #expect(fixture.waitCalls.allSatisfy { $0.options == WNOHANG })
    #expect(fixture.signals.isEmpty)
    #expect(fixture.closedDescriptors.filter { $0 == 10 }.count == 1)
  }

  @Test
  func shutdownClosesChannelThenSendsTermAndKillOnceAfterGrace() async throws {
    let fixture = RecordingEngineChildSystem(reapAfterKill: true)
    let child = try await EngineChildProcess.start(
      layout: fixedLayout,
      environment: [:],
      system: fixture.system
    )

    async let first = child.shutdown()
    async let second = child.shutdown()
    async let third = child.wait()
    let terminations = try await [first, second, third]

    #expect(terminations == Array(repeating: .signaled(SIGKILL), count: 3))
    #expect(fixture.signals.map(\.pid).allSatisfy { $0 == 41 })
    #expect(fixture.signals.map(\.signal) == [SIGTERM, SIGKILL])
    #expect(fixture.signals[1].time - fixture.signals[0].time == 2_000_000_000)
    #expect(fixture.sleepDurations.allSatisfy { $0 == 50_000_000 })
    #expect(fixture.closedDescriptors.filter { $0 == 10 }.count == 1)
    #expect(fixture.shutdownDescriptors.filter { $0 == 10 }.count == 1)
  }

  @Test
  func abandonedChildClosesChannelAndConvergesThroughKillAndReap() async throws {
    let fixture = RecordingEngineChildSystem(reapAfterKill: true)
    var child: EngineChildProcess? = try await EngineChildProcess.start(
      layout: fixedLayout,
      environment: [:],
      system: fixture.system
    )
    weak let releasedChild: EngineChildProcess? = child

    child = nil
    #expect(releasedChild == nil)

    var remainingYields = 1_000
    while fixture.reapCount == 0, remainingYields > 0 {
      remainingYields -= 1
      await Task.yield()
    }

    #expect(fixture.reapCount == 1)
    #expect(fixture.waitCalls.allSatisfy { $0.pid == 41 && $0.options == WNOHANG })
    #expect(fixture.signals.map(\.pid).allSatisfy { $0 == 41 })
    #expect(fixture.signals.map(\.signal) == [SIGTERM, SIGKILL])
    try #require(fixture.signals.count == 2)
    #expect(fixture.signals[1].time - fixture.signals[0].time == 2_000_000_000)
    #expect(fixture.closedDescriptors.filter { $0 == 10 }.count == 1)
    #expect(fixture.shutdownDescriptors.filter { $0 == 10 }.count == 1)
  }

  @Test
  func shutdownAfterReapReturnsStoredResultWithoutSignalingReusedPID() async throws {
    let fixture = RecordingEngineChildSystem()
    fixture.enqueueWait(.reaped(status: 7 << 8))
    let child = try await EngineChildProcess.start(
      layout: fixedLayout,
      environment: [:],
      system: fixture.system
    )

    #expect(try await child.wait() == .exited(7))
    #expect(try await child.shutdown() == .exited(7))
    #expect(fixture.signals.isEmpty)
    #expect(fixture.waitCalls.count == 1)
  }

  @Test
  func waitAndSignalRetryOnlyInterruptedCalls() async throws {
    let fixture = RecordingEngineChildSystem(
      waitInterruptions: 2,
      signalInterruptions: 1
    )
    fixture.enqueueWait(.running)
    fixture.enqueueWait(.reaped(status: SIGTERM))
    let child = try await EngineChildProcess.start(
      layout: fixedLayout,
      environment: [:],
      system: fixture.system
    )

    #expect(try await child.shutdown() == .signaled(SIGTERM))
    #expect(fixture.waitCalls.count == 4)
    #expect(fixture.signals.map(\.signal) == [SIGTERM, SIGTERM])
  }

  @Test
  func waitFailureIsFixedAndClosesTheChannel() async throws {
    let fixture = RecordingEngineChildSystem(waitFails: true)
    let child = try await EngineChildProcess.start(
      layout: fixedLayout,
      environment: [:],
      system: fixture.system
    )

    await #expect(throws: EngineChildProcessError.waitFailed) {
      _ = try await child.wait()
    }
    #expect(await child.ownsExactPIDForTesting())
    await #expect(throws: EngineChildProcessError.waitFailed) {
      _ = try await child.shutdown()
    }
    #expect(await child.ownsExactPIDForTesting())
    #expect(fixture.waitCalls.count == 1)
    #expect(fixture.signals.isEmpty)
    #expect(fixture.closedDescriptors.filter { $0 == 10 }.count == 1)
  }

  @Test
  func liveSpawnInheritsOnlyStandardDescriptorsAndEngineSocket() async throws {
    let fixture = try LiveChildFixture()
    let canarySource = Darwin.open("/dev/null", O_RDONLY)
    try #require(canarySource >= 0)
    let canaryDescriptor = fcntl(canarySource, F_DUPFD, 64)
    _ = Darwin.close(canarySource)
    try #require(canaryDescriptor >= 64)
    defer { _ = Darwin.close(canaryDescriptor) }
    try #require(fcntl(canaryDescriptor, F_SETFD, 0) == 0)
    #expect(fcntl(canaryDescriptor, F_GETFD) & FD_CLOEXEC == 0)

    let child = try await EngineChildProcess.start(
      layout: EngineBundleLayout(
        nodeExecutable: URL(fileURLWithPath: "/bin/sh"),
        engineEntrypoint: fixture.script
      ),
      arguments: [fixture.output.path, String(canaryDescriptor), "alpha", "two words"],
      environment: [
        "HOME": "/safe/home",
        "PATH": "/usr/bin:/bin",
        "CI": "true",
        "NODE_OPTIONS": "SECRET_ENGINE_CANARY",
      ]
    )

    #expect(try await child.wait() == .exited(7))
    let lines = Set(
      try String(contentsOf: fixture.output, encoding: .utf8)
        .split(separator: "\n")
        .map(String.init)
    )
    #expect(lines.contains("arg=alpha"))
    #expect(lines.contains("arg=two words"))
    #expect(lines.contains("HOME=/safe/home"))
    #expect(lines.contains("CI=1"))
    #expect(lines.contains("RECURS_NATIVE_FD=3"))
    #expect(lines.contains("NODE_OPTIONS=absent"))
    #expect(lines.contains("canary=absent"))
    #expect(fcntl(canaryDescriptor, F_GETFD) >= 0)
    for descriptor in 0...3 {
      #expect(lines.contains("fd=\(descriptor)"))
    }
    for descriptor in 4...9 {
      #expect(!lines.contains("fd=\(descriptor)"))
    }
  }

  private var fixedLayout: EngineBundleLayout {
    EngineBundleLayout(
      nodeExecutable: URL(fileURLWithPath: "/fixed/runtime/bin/node"),
      engineEntrypoint: URL(fileURLWithPath: "/fixed/engine/main.js")
    )
  }
}

private final class RecordingEngineChildSystem: @unchecked Sendable {
  private let lock = NSLock()
  private let spawnFails: Bool
  private let reapAfterKill: Bool
  private let waitFails: Bool
  private var waitInterruptions: Int
  private var signalInterruptions: Int
  private var waitResults: [EngineChildProcessWaitResult] = []
  private var killed = false
  private var now: UInt64 = 0
  private var spawnExecutableStorage: String?
  private var spawnArgumentsStorage: [String] = []
  private var spawnEnvironmentStorage: [String] = []
  private var spawnEngineDescriptorStorage: Int32?
  private var closedDescriptorsStorage: [Int32] = []
  private var shutdownDescriptorsStorage: [Int32] = []
  private var waitCallsStorage: [(pid: pid_t, options: Int32)] = []
  private var signalsStorage: [(pid: pid_t, signal: Int32, time: UInt64)] = []
  private var sleepDurationsStorage: [UInt64] = []
  private var reapCountStorage = 0

  init(
    spawnFails: Bool = false,
    reapAfterKill: Bool = false,
    waitFails: Bool = false,
    waitInterruptions: Int = 0,
    signalInterruptions: Int = 0
  ) {
    self.spawnFails = spawnFails
    self.reapAfterKill = reapAfterKill
    self.waitFails = waitFails
    self.waitInterruptions = waitInterruptions
    self.signalInterruptions = signalInterruptions
  }

  var spawnExecutable: String? { lock.withLock { spawnExecutableStorage } }
  var spawnArguments: [String] { lock.withLock { spawnArgumentsStorage } }
  var spawnEnvironment: [String] { lock.withLock { spawnEnvironmentStorage } }
  var spawnEngineDescriptor: Int32? { lock.withLock { spawnEngineDescriptorStorage } }
  var closedDescriptors: [Int32] { lock.withLock { closedDescriptorsStorage } }
  var shutdownDescriptors: [Int32] { lock.withLock { shutdownDescriptorsStorage } }
  var waitCalls: [(pid: pid_t, options: Int32)] { lock.withLock { waitCallsStorage } }
  var signals: [(pid: pid_t, signal: Int32, time: UInt64)] {
    lock.withLock { signalsStorage }
  }
  var sleepDurations: [UInt64] { lock.withLock { sleepDurationsStorage } }
  var reapCount: Int { lock.withLock { reapCountStorage } }

  func enqueueWait(_ result: EngineChildProcessWaitResult) {
    lock.withLock { waitResults.append(result) }
  }

  var system: EngineChildProcessSystem {
    EngineChildProcessSystem(
      makeSocketPair: { .success((8, 9)) },
      duplicateDescriptor: { descriptor in
        .success(descriptor == 8 ? 10 : 11)
      },
      closeDescriptor: { [self] descriptor in
        lock.withLock { closedDescriptorsStorage.append(descriptor) }
      },
      launcherSocketSystem: LauncherNodeSocketSystem(
        descriptorFlags: { _ in .success(0) },
        setDescriptorFlags: { _, _ in .success(()) },
        setNoSigpipe: { _ in .success(()) },
        setReceiveTimeout: { _ in .success(()) },
        setSendTimeout: { _ in .success(()) },
        receive: { _, _ in .failure(.wouldBlock) },
        send: { _, bytes in .success(bytes.count) },
        shutdown: { [self] descriptor in
          lock.withLock { shutdownDescriptorsStorage.append(descriptor) }
        },
        close: { [self] descriptor in
          lock.withLock { closedDescriptorsStorage.append(descriptor) }
        }
      ),
      spawn: { [self] executable, arguments, environment, engineDescriptor in
        lock.withLock {
          spawnExecutableStorage = executable
          spawnArgumentsStorage = arguments
          spawnEnvironmentStorage = environment
          spawnEngineDescriptorStorage = engineDescriptor
        }
        return spawnFails ? .failure(.failed) : .success(41)
      },
      wait: { [self] pid, options in
        lock.withLock {
          waitCallsStorage.append((pid, options))
          if waitInterruptions > 0 {
            waitInterruptions -= 1
            return .failure(.interrupted)
          }
          if waitFails {
            return .failure(.failed)
          }
          if !waitResults.isEmpty {
            return .success(waitResults.removeFirst())
          }
          if reapAfterKill && killed {
            reapCountStorage += 1
            return .success(.reaped(status: SIGKILL))
          }
          return .success(.running)
        }
      },
      signal: { [self] pid, signal in
        lock.withLock { () -> Result<Void, EngineChildProcessCallFailure> in
          signalsStorage.append((pid, signal, now))
          if signalInterruptions > 0 {
            signalInterruptions -= 1
            return .failure(.interrupted)
          }
          if signal == SIGKILL {
            killed = true
          }
          return .success(())
        }
      },
      nowNanoseconds: { [self] in lock.withLock { now } },
      sleep: { [self] duration in
        lock.withLock {
          sleepDurationsStorage.append(duration)
          now += duration
        }
        await Task.yield()
      }
    )
  }
}

private final class LiveChildFixture {
  let directory: URL
  let script: URL
  let output: URL

  init() throws {
    directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("engine-child-\(UUID().uuidString)")
    script = directory.appendingPathComponent("engine.sh")
    output = directory.appendingPathComponent("result.txt")
    try FileManager.default.createDirectory(
      at: directory,
      withIntermediateDirectories: true
    )
    let source = """
      output="$1"
      canary="$2"
      shift 2
      {
        for argument in "$@"; do printf 'arg=%s\\n' "$argument"; done
        printf 'HOME=%s\\n' "$HOME"
        printf 'CI=%s\\n' "$CI"
        printf 'RECURS_NATIVE_FD=%s\\n' "$RECURS_NATIVE_FD"
        if [ "${NODE_OPTIONS+x}" = x ]; then
          printf 'NODE_OPTIONS=present\\n'
        else
          printf 'NODE_OPTIONS=absent\\n'
        fi
        if [ -e "/dev/fd/$canary" ]; then
          printf 'canary=inherited\\n'
        else
          printf 'canary=absent\\n'
        fi
        descriptor=0
        while [ "$descriptor" -le 9 ]; do
          if [ -e "/dev/fd/$descriptor" ]; then printf 'fd=%s\\n' "$descriptor"; fi
          descriptor=$((descriptor + 1))
        done
      } > "$output"
      exit 7
      """
    try Data(source.utf8).write(to: script)
  }

  deinit {
    try? FileManager.default.removeItem(at: directory)
  }
}
