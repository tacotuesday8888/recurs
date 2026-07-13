import Foundation
import RecursBrokerXPC
import RecursNativeProtocol
import Testing

@testable import RecursBrokerCore
@testable import RecursBrokerService

@Suite(.serialized)
struct BrokerServiceRuntimeTests {
  private let connectionID = UUID(uuidString: "61000000-0000-4000-8000-000000000001")!
  private let operationID = UUID(uuidString: "62000000-0000-4000-8000-000000000001")!

  @Test
  func startupOrdersDependenciesRetainsObjectsAndActivatesOnce() async throws {
    let fixture = try await makeRuntimeFixture()

    #expect(
      fixture.events.snapshot()
        == [
          "peer",
          "keychain",
          "recover:73",
          "health-source:73",
          "listener:com.recurs.cli.broker",
          "requirement:anchor apple generic and identifier \"com.recurs.cli\"",
          "delegate",
        ]
    )
    #expect(fixture.retention.listener != nil)
    #expect(fixture.retention.delegate != nil)
    #expect(fixture.retention.listener?.activationCount == 0)

    let activation = RuntimeActivationProbe(runtime: fixture.runtime)
    let startGate = RuntimeActivationStartGate(expectedArrivals: 32)
    await withTaskGroup(of: Void.self) { group in
      for _ in 0..<32 {
        group.addTask {
          await startGate.arriveAndWait()
          activation.activate()
        }
      }
      await startGate.waitUntilReady()
      await startGate.release()
    }

    #expect(fixture.retention.listener?.activationCount == 1)
  }

  @Test
  func recoveredAuthorityIdentityAndLiveHealthSurviveLockedKeychain() async throws {
    let store = AuthorityCredentialStore()
    let vacantRecord = try BrokerJournalRecord(
      revision: 1,
      connectionID: connectionID,
      fence: 0,
      lastGenerationOrdinal: 0,
      changedAt: JournalTimestamp(unixMilliseconds: 1_000),
      payload: .vacant(BrokerJournalVacantPayload())
    )
    let journal = AuthorityJournalStore(
      snapshots: [
        BrokerJournalSnapshot(record: vacantRecord, authenticationTag: .zero)
      ]
    )
    let authority = try await BrokerCredentialAuthority.recovering(
      store: store,
      journal: journal
    )
    let recoveries = LockedRuntimeCounter()
    let statuses = LockedRuntimeStatuses([.locked, .unavailable])
    let retention = RuntimeRetentionProbe()
    let dependencies = BrokerServiceRuntimeDependencies(
      makePeerRequirement: { "runtime-test-requirement" },
      makeKeychainConfiguration: { RuntimeKeychainToken(value: 91) },
      recoverAuthority: { token in
        #expect(token == RuntimeKeychainToken(value: 91))
        recoveries.increment()
        return authority
      },
      makeKeychainStatusSource: { token in
        #expect(token == RuntimeKeychainToken(value: 91))
        return { statuses.next() }
      },
      makeListener: { _ in
        let listener = RecordingRuntimeListener(
          events: LockedRuntimeEvents(),
          retention: retention
        )
        retention.listener = listener
        return listener
      }
    )

    let runtime = try await BrokerServiceRuntime.forTesting(
      launcherVersion: "0.1.0",
      brokerVersion: "0.1.0",
      dependencies: dependencies
    )
    #expect(recoveries.value == 1)
    #expect(statuses.callCount == 0)

    let delegate = try #require(retention.delegate)
    let connection = TestBrokerConnection()
    delegate.configure(connection)
    let service = try #require(connection.exportedObject as? BrokerService)

    let helloReply = LockedDataProbe()
    service.exchange(
      try HelloMessage(
        engineVersion: "0.1.0",
        nonce: Data(repeating: 0x5a, count: nativeNonceByteCount)
      ).encodedFrame(requestID: 1),
      reply: helloReply.receive
    )
    let hello = try HelloResultMessage.decode(decodeFrame(helloReply.wait()))
    #expect(hello.productionSigned)
    #expect(hello.persistentCredentials)

    let stageReply = LockedDataProbe()
    service.stageCredential(
      try BrokerCredentialStageRequest(
        requestID: 1,
        connectionID: connectionID,
        operationID: operationID,
        expectedFence: 0
      ).encode(),
      secret: Data("runtime-secret".utf8),
      reply: stageReply.receive
    )
    let staged = try BrokerCredentialLifecycleReply.decode(stageReply.wait())
    guard case .staged(requestID: 1, let redacted) = staged else {
      Issue.record("Expected a staged lifecycle reply")
      return
    }
    let attemptID = try #require(redacted.attemptID)
    #expect(
      try await authority.authoritativeLifecycleProjection(for: connectionID)
        == .staging(
          connectionID: connectionID,
          fence: redacted.fence,
          attemptID: attemptID,
          hasUsableReady: false
        )
    )

    for (requestID, expected) in [(UInt32(2), KeychainStatusCode.locked), (3, .unavailable)] {
      let healthReply = LockedDataProbe()
      service.exchange(
        try HealthMessage().encodedFrame(requestID: requestID),
        reply: healthReply.receive
      )
      let health = try HealthResultMessage.decode(decodeFrame(healthReply.wait()))
      #expect(health.keychain == expected)
      #expect(health.peerVerified)
    }
    #expect(statuses.callCount == 2)
    #expect(recoveries.value == 1)
    withExtendedLifetime(runtime) {}
  }

  @Test(arguments: RuntimeFailurePoint.allCases)
  func everyStartupFailurePrecedesListenerConstruction(
    _ failurePoint: RuntimeFailurePoint
  ) async {
    let events = LockedRuntimeEvents()
    let listenerConstructions = LockedRuntimeCounter()
    let dependencies = BrokerServiceRuntimeDependencies(
      makePeerRequirement: {
        events.record("peer")
        if failurePoint == .peer { throw RuntimeInjectedFailure() }
        return "runtime-test-requirement"
      },
      makeKeychainConfiguration: {
        events.record("keychain")
        if failurePoint == .keychain { throw RuntimeInjectedFailure() }
        return RuntimeKeychainToken(value: 17)
      },
      recoverAuthority: { _ in
        events.record("recover:\(failurePoint.rawValue)")
        throw RuntimeInjectedFailure()
      },
      makeKeychainStatusSource: { _ in
        events.record("health-source")
        return { .available }
      },
      makeListener: { _ in
        listenerConstructions.increment()
        return RecordingRuntimeListener(
          events: events,
          retention: RuntimeRetentionProbe()
        )
      }
    )

    do {
      _ = try await BrokerServiceRuntime.forTesting(
        launcherVersion: "0.1.0",
        brokerVersion: "0.1.0",
        dependencies: dependencies
      )
      Issue.record("Expected startup to fail")
    } catch is RuntimeInjectedFailure {
      // Expected: every injected failure is fatal before listener creation.
    } catch {
      Issue.record("Unexpected startup error: \(error)")
    }

    #expect(listenerConstructions.value == 0)
    switch failurePoint {
    case .peer:
      #expect(events.snapshot() == ["peer"])
    case .keychain:
      #expect(events.snapshot() == ["peer", "keychain"])
    default:
      #expect(
        events.snapshot()
          == ["peer", "keychain", "recover:\(failurePoint.rawValue)"]
      )
    }
  }

  @Test
  func invalidServiceConfigurationAfterRecoveryStillPrecedesListenerConstruction() async throws {
    let events = LockedRuntimeEvents()
    let listenerConstructions = LockedRuntimeCounter()
    let authority = try await BrokerCredentialAuthority.recovering(
      store: AuthorityCredentialStore(),
      journal: AuthorityJournalStore()
    )
    let dependencies = BrokerServiceRuntimeDependencies(
      makePeerRequirement: {
        events.record("peer")
        return "runtime-test-requirement"
      },
      makeKeychainConfiguration: {
        events.record("keychain")
        return RuntimeKeychainToken(value: 29)
      },
      recoverAuthority: { _ in
        events.record("recover")
        return authority
      },
      makeKeychainStatusSource: { _ in
        events.record("health-source")
        return { .available }
      },
      makeListener: { _ in
        listenerConstructions.increment()
        return RecordingRuntimeListener(
          events: events,
          retention: RuntimeRetentionProbe()
        )
      }
    )

    await #expect(throws: BrokerServiceConfigurationError.invalidConfiguration) {
      _ = try await BrokerServiceRuntime.forTesting(
        launcherVersion: "",
        brokerVersion: "0.1.0",
        dependencies: dependencies
      )
    }
    #expect(events.snapshot() == ["peer", "keychain", "recover", "health-source"])
    #expect(listenerConstructions.value == 0)
  }

  private func makeRuntimeFixture() async throws -> (
    runtime: BrokerServiceRuntime,
    events: LockedRuntimeEvents,
    retention: RuntimeRetentionProbe
  ) {
    let events = LockedRuntimeEvents()
    let retention = RuntimeRetentionProbe()
    let authority = try await BrokerCredentialAuthority.recovering(
      store: AuthorityCredentialStore(),
      journal: AuthorityJournalStore()
    )
    let dependencies = BrokerServiceRuntimeDependencies(
      makePeerRequirement: {
        events.record("peer")
        return "anchor apple generic and identifier \"com.recurs.cli\""
      },
      makeKeychainConfiguration: {
        events.record("keychain")
        return RuntimeKeychainToken(value: 73)
      },
      recoverAuthority: { token in
        events.record("recover:\(token.value)")
        return authority
      },
      makeKeychainStatusSource: { token in
        events.record("health-source:\(token.value)")
        return { .available }
      },
      makeListener: { name in
        events.record("listener:\(name)")
        let listener = RecordingRuntimeListener(events: events, retention: retention)
        retention.listener = listener
        return listener
      }
    )
    let runtime = try await BrokerServiceRuntime.forTesting(
      launcherVersion: "0.1.0",
      brokerVersion: "0.1.0",
      dependencies: dependencies
    )
    return (runtime, events, retention)
  }

  private func decodeFrame(_ data: Data) throws -> NativeFrame {
    var decoder = NativeFrameDecoder()
    let frames = try decoder.push(data)
    try decoder.finish()
    return try #require(frames.count == 1 ? frames[0] : nil)
  }
}

private struct RuntimeKeychainToken: Sendable, Equatable {
  let value: Int
}

private struct RuntimeInjectedFailure: Error {}

private final class RuntimeActivationProbe: @unchecked Sendable {
  private let runtime: BrokerServiceRuntime

  init(runtime: BrokerServiceRuntime) {
    self.runtime = runtime
  }

  func activate() {
    runtime.activate()
  }
}

private actor RuntimeActivationStartGate {
  private let expectedArrivals: Int
  private var arrivals = 0
  private var isReleased = false
  private var readyWaiter: CheckedContinuation<Void, Never>?
  private var startWaiters: [CheckedContinuation<Void, Never>] = []

  init(expectedArrivals: Int) {
    self.expectedArrivals = expectedArrivals
  }

  func arriveAndWait() async {
    arrivals += 1
    if arrivals == expectedArrivals {
      readyWaiter?.resume()
      readyWaiter = nil
    }
    await withCheckedContinuation { continuation in
      if isReleased {
        continuation.resume()
      } else {
        startWaiters.append(continuation)
      }
    }
  }

  func waitUntilReady() async {
    guard arrivals < expectedArrivals else { return }
    await withCheckedContinuation { continuation in
      readyWaiter = continuation
    }
  }

  func release() {
    isReleased = true
    let waiters = startWaiters
    startWaiters.removeAll(keepingCapacity: false)
    for waiter in waiters {
      waiter.resume()
    }
  }
}

enum RuntimeFailurePoint: String, CaseIterable, Sendable {
  case peer
  case keychain
  case recovery
}

private final class LockedRuntimeEvents: @unchecked Sendable {
  private let lock = NSLock()
  private var events: [String] = []

  func record(_ event: String) {
    lock.withLock { events.append(event) }
  }

  func snapshot() -> [String] {
    lock.withLock { events }
  }
}

private final class LockedRuntimeCounter: @unchecked Sendable {
  private let lock = NSLock()
  private var count = 0

  var value: Int { lock.withLock { count } }

  func increment() {
    lock.withLock { count += 1 }
  }
}

private final class LockedRuntimeStatuses: @unchecked Sendable {
  private let lock = NSLock()
  private let statuses: [KeychainStatusCode]
  private var index = 0

  init(_ statuses: [KeychainStatusCode]) {
    self.statuses = statuses
  }

  var callCount: Int { lock.withLock { index } }

  func next() -> KeychainStatusCode {
    lock.withLock {
      defer { index += 1 }
      guard index < statuses.count else { return statuses.last ?? .unavailable }
      return statuses[index]
    }
  }
}

private final class RuntimeRetentionProbe: @unchecked Sendable {
  weak var listener: RecordingRuntimeListener?
  weak var delegate: BrokerServiceListenerDelegate?
}

private final class RecordingRuntimeListener: BrokerServiceListenerHandle, @unchecked Sendable {
  private let lock = NSLock()
  private let events: LockedRuntimeEvents
  private let retention: RuntimeRetentionProbe
  private weak var storedDelegate: NSXPCListenerDelegate?
  private var activations = 0

  init(events: LockedRuntimeEvents, retention: RuntimeRetentionProbe) {
    self.events = events
    self.retention = retention
  }

  var delegate: NSXPCListenerDelegate? {
    get { lock.withLock { storedDelegate } }
    set {
      lock.withLock { storedDelegate = newValue }
      retention.delegate = newValue as? BrokerServiceListenerDelegate
      events.record("delegate")
    }
  }

  var activationCount: Int { lock.withLock { activations } }

  func setConnectionCodeSigningRequirement(_ requirement: String) {
    events.record("requirement:\(requirement)")
  }

  func activate() {
    lock.withLock { activations += 1 }
  }
}
