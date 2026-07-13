# Native Credential Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` task by task. Every production
> behavior change follows `superpowers:test-driven-development`: add the focused
> failing test, run it and inspect the expected failure, then write the minimum
> implementation.

**Goal:** Turn the existing durable macOS Keychain/journal authority into the
live signed broker's private credential lifecycle service, without exposing a
secret, credential reference, provider request, or reusable capability to Node.

**Architecture:** The broker recovers one process-wide `BrokerCredentialState`
before its XPC listener is activated. Every exact-peer launcher connection gets
its own bounded lifecycle gateway but shares that recovered actor. A separate
native-only XPC protocol carries fixed lifecycle metadata and redacted replies;
staging secret bytes travel in a distinct native XPC argument and are consumed
immediately into `SecretBytes`. The existing Node protocol remains health-only.
Provider/profile binding, candidate verification, native TTY capture, provider
HTTPS, and direct-provider activation remain closed for later slices.

**Tech stack:** Swift 6.2, Swift Testing, NSXPC, Data Protection Keychain,
CryptoKit-authenticated broker journal, APFS descriptor-relative storage.

## Verified starting point

- `BrokerCredentialState.recovering`, fenced lifecycle mutations,
  authoritative reads, and ready-generation reservations already exist.
- `DataProtectionCredentialStore`, `KeychainJournalAuthenticator`,
  `FileBrokerJournalStore`, and `SecureDirectory.openLiveJournalDirectory()`
  already implement the production storage primitives.
- The live broker currently builds only a Keychain health probe and reports
  `persistentCredentials: false`.
- The XPC surface currently exposes only one-shot health `exchange(Data)`.
- The Node-facing `RecursNativeProtocol` accepts only hello, health, cancel, and
  fixed safe failures; this plan does not add credential messages to it.

## Global constraints

- Production startup order is fixed: signed peer requirement, production
  Keychain configuration, secure journal directory, side-effect-free Keychain
  journal authenticator construction, journal-store open (which acquires the
  authority lease), credential store, complete state recovery, then listener
  activation. Any failure exits before listening.
- One recovered credential authority is shared across all accepted XPC
  connections. Per-connection handshake, monotonic request IDs, in-flight work,
  and cancellation state are never shared. The gateway owns every lifecycle
  task handle and exactly-once reply gate so invalidation performs real task
  cancellation before any late result can reply.
- The private credential wire is not the Node protocol and uses a distinct
  `RCCL` magic/version. It carries only request IDs, connection/operation/attempt
  IDs, fences, redacted state, and fixed result/failure codes. Client request
  IDs range from `1` through `UInt64.max - 1`; `UInt64.max` is reserved as the
  malformed-request reply sentinel.
- Replies never contain generation IDs or ordinals, Keychain accounts or
  references, store keys, credential-derived fingerprints, secret lengths,
  secret-derived values, native error text, file paths, or journal records.
- A staging secret is nonempty and at most 4,096 bytes. It is never accepted in
  the metadata blob. The broker consumes its owned `Data` into `SecretBytes`
  before the first credential-authority await and erases all mutable temporary
  storage.
- The lifecycle gateway requires a successful versioned hello on the same XPC
  connection, strictly increasing nonzero `UInt64` lifecycle request IDs, at
  most eight in-flight lifecycle requests, exactly one reply per accepted XPC
  call, and terminal cancellation on connection invalidation.
- Core state errors map to fixed lifecycle failure codes. No `description`,
  `debugDescription`, reflection, or thrown error crosses XPC.
- `persistentCredentials` is true in the live broker only when the process-wide
  authority recovered successfully. Test-only configurations may inject an
  explicit lifecycle authority; production code cannot set the bit directly.
- Provider manifests remain `runnable: false`. This plan adds no provider/profile
  binding, staging-candidate request authority, verification request, network
  transport, model discovery, CLI setup command, or heavy sub-agent behavior.
- Unit/integration tests inject stores and journals and must not touch the
  developer's real Keychain or credential journal.

## Private wire contract

`RecursBrokerXPC` owns a manually bounded binary codec independent of
`RecursNativeProtocol`.

Header, all big-endian:

```text
magic "RCCL" u32 | version 1 u16 | kind u16 | bodyLength u32
```

The body limit is 256 bytes. UUIDs are exactly their 16 RFC 4122 bytes and the
all-zero UUID is invalid. Client request IDs are in `1...(UInt64.max - 1)`;
`UInt64.max` is valid only in an encoded `.invalidRequest` failure reply for an
input from which no canonical request ID could be decoded.

Request kinds and exact bodies:

```text
1 stage       requestID u64 | connectionID uuid | operationID uuid | expectedFence u64
2 projection  requestID u64 | connectionID uuid
3 resume      requestID u64 | connectionID uuid | operationID uuid | expectedFence u64
4 reserved     requestID u64; always returns operation_unavailable
5 abort       requestID u64 | connectionID uuid | attemptID uuid | operationID uuid | expectedFence u64
6 disconnect  requestID u64 | connectionID uuid | operationID uuid | expectedFence u64
```

Reply kinds:

```text
101 projectionResult  requestID u64 | state u8 | fence u64 | hasUsableReady u8 | [attemptID uuid]
102 stageResult       same body; state must be staging and attemptID is required
103 mutationResult    same body; attemptID exists only for staging
255 failure           requestID u64 | failureCode u16
```

State values are `missing=1`, `vacant=2`, `staging=3`, `ready=4`, and
`tombstoned=5`. `missing` requires fence zero and no usable ready credential.
`vacant` permits fence zero for a durable bootstrap vacancy; staging, ready, and
tombstoned require a nonzero fence. Only `staging` carries an attempt ID.
`hasUsableReady` is true for ready, may be true for staging, and is false for
missing, vacant, and tombstoned. Failure codes are fixed:

```text
1 invalid_request                 8 conflict
2 session_not_ready               9 busy
3 capacity_exceeded              10 credential_store_unavailable
4 cancelled                      11 cleanup_pending
5 not_found                      12 operation_unavailable
6 disconnected                   13 authority_unavailable
7 stale_fence
```

Kind 4 is deliberately unavailable: only a later broker-owned setup coordinator
that has bound the provider/profile and successfully verified the staging
candidate may commit a generation. The exact-peer launcher is trusted transport,
not authority to mark arbitrary bytes ready.

---

## Task 1: Add a redacted lifecycle projection to the credential core

**Files:**

- Modify: `native/macos/Sources/RecursBrokerCore/BrokerCredentialState.swift`
- Modify: `native/macos/Sources/RecursBrokerCore/BrokerCredentialStateMachine.swift`
- Create: `native/macos/Tests/RecursBrokerCoreTests/BrokerCredentialLifecycleProjectionTests.swift`

**Interface:**

```swift
package enum CredentialLifecycleProjection: Sendable, Equatable {
  case missing(connectionID: UUID)
  case vacant(connectionID: UUID, fence: UInt64)
  case staging(
    connectionID: UUID,
    fence: UInt64,
    attemptID: UUID,
    hasUsableReady: Bool
  )
  case ready(connectionID: UUID, fence: UInt64)
  case tombstoned(connectionID: UUID, fence: UInt64)
}

extension BrokerCredentialState {
  package func lifecycleProjection(
    for connectionID: UUID
  ) -> CredentialLifecycleProjection

  package func authoritativeLifecycleProjection(
    for connectionID: UUID
  ) async throws(BrokerJournalError) -> CredentialLifecycleProjection
}
```

- [x] **Step 1: Add focused failing tests**

Cover missing, bootstrap vacant at fence zero, durable vacant after initial
abort, initial staging, reconnect staging with a previous ready generation,
ready, tombstoned, and an authoritative journal mismatch. Assert the new
projection contains no generation ID, ordinal,
timestamp, credential key, journal tag, or store identity through equality,
reflection, descriptions, and encoded test canaries.

- [x] **Step 2: Verify RED**

Run:

```bash
swift test --package-path native/macos \
  --filter BrokerCredentialLifecycleProjectionTests
```

Expected: compilation fails because `CredentialLifecycleProjection` and the two
state methods do not exist.

- [x] **Step 3: Implement the minimum projection**

Add a pure state-machine mapping from its private `Record`; keep the existing
`CredentialProjection` API unchanged. For the authoritative method, reuse
`beginAuthoritativeProjection`, perform exactly one journal load, finish the
existing read token, then map the still-validated record without another await.
Do not add a store/secret read.

- [x] **Step 4: Verify GREEN and regressions**

```bash
swift test --package-path native/macos \
  --filter BrokerCredentialLifecycleProjectionTests
swift test --package-path native/macos \
  --filter BrokerCredentialStateMachineAuthoritativeProjectionTests
swift test --package-path native/macos \
  --filter BrokerCredentialJournalAuthorityActorTests
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add native/macos/Sources/RecursBrokerCore/BrokerCredentialState.swift \
  native/macos/Sources/RecursBrokerCore/BrokerCredentialStateMachine.swift \
  native/macos/Tests/RecursBrokerCoreTests/BrokerCredentialLifecycleProjectionTests.swift
git commit -m "feat: add redacted credential lifecycle projection"
```

## Task 2: Freeze the private credential lifecycle codec

**Files:**

- Create: `native/macos/Sources/RecursBrokerXPC/BrokerCredentialLifecycleCodec.swift`
- Create: `native/macos/Tests/RecursBrokerServiceTests/BrokerCredentialLifecycleCodecTests.swift`
- Modify: `native/macos/Package.swift`

**Interfaces:**

```swift
public struct BrokerCredentialStageRequest: Sendable, Equatable {
  public let requestID: UInt64
  public let connectionID: UUID
  public let operationID: UUID
  public let expectedFence: UInt64

  public init(
    requestID: UInt64,
    connectionID: UUID,
    operationID: UUID,
    expectedFence: UInt64
  ) throws
}

public enum BrokerCredentialControlRequest: Sendable, Equatable {
  case projection(requestID: UInt64, connectionID: UUID)
  case resumeStage(requestID: UInt64, connectionID: UUID,
                   operationID: UUID, expectedFence: UInt64)
  case reservedOperation(requestID: UInt64)
  case abort(requestID: UInt64, connectionID: UUID, attemptID: UUID,
             operationID: UUID, expectedFence: UInt64)
  case disconnect(requestID: UInt64, connectionID: UUID,
                  operationID: UUID, expectedFence: UInt64)
}

public enum BrokerCredentialRedactedState: UInt8, Sendable {
  case missing = 1, vacant = 2, staging = 3, ready = 4, tombstoned = 5
}

public let brokerCredentialMalformedRequestID = UInt64.max

public enum BrokerCredentialLifecycleFailureCode: UInt16, Sendable {
  case invalidRequest = 1
  case sessionNotReady = 2
  case capacityExceeded = 3
  case cancelled = 4
  case notFound = 5
  case disconnected = 6
  case staleFence = 7
  case conflict = 8
  case busy = 9
  case credentialStoreUnavailable = 10
  case cleanupPending = 11
  case operationUnavailable = 12
  case authorityUnavailable = 13
}

public struct BrokerCredentialRedactedProjection: Sendable, Equatable {
  public let state: BrokerCredentialRedactedState
  public let fence: UInt64
  public let hasUsableReady: Bool
  public let attemptID: UUID?

  public init(
    state: BrokerCredentialRedactedState,
    fence: UInt64,
    hasUsableReady: Bool,
    attemptID: UUID?
  ) throws
}

public enum BrokerCredentialLifecycleReply: Sendable, Equatable {
  case projection(requestID: UInt64, BrokerCredentialRedactedProjection)
  case staged(requestID: UInt64, BrokerCredentialRedactedProjection)
  case mutation(requestID: UInt64, BrokerCredentialRedactedProjection)
  case failure(requestID: UInt64, BrokerCredentialLifecycleFailureCode)
}
```

Each request/reply exposes `encode() throws -> Data`; request/reply namespaces
expose exact `decode(_:)`. Constructors validate all state invariants so invalid
values cannot be encoded.

- [ ] **Step 1: Add codec tests from the frozen table above**

Test every round trip and exact byte length. Reject bad magic/version/kind/body
length, trailing bytes, request ID zero or `UInt64.max`, truncated/oversized
bodies, all-zero UUIDs, a reserved kind 4 body other than one request ID,
invalid state/fence/ready/attempt combinations, reply kind/state mismatches,
and unknown fixed failure codes. Prove canonical kind 4 decodes only to
`.reservedOperation`; Task 3 owns the `.operationUnavailable` dispatch rule.
Prove the reply codec accepts the reserved sentinel only for
`.invalidRequest`, while ordinary valid-request failure replies echo a client
request ID below the sentinel. Task 3 proves malformed input dispatches that
sentinel reply.
Assert a credential canary and all forbidden identifier names are absent from
every encoded reply.

- [ ] **Step 2: Verify RED**

```bash
swift test --package-path native/macos \
  --filter BrokerCredentialLifecycleCodecTests
```

Expected: compilation fails because the private codec does not exist.

- [ ] **Step 3: Implement the manual bounded codec**

Use private byte append/read helpers and checked offsets. Do not use `Codable`,
JSON, property lists, `NSKeyedArchiver`, `RecursNativeProtocol`, or arbitrary
dictionaries. Decode into copied value types and reject any noncanonical form.

- [ ] **Step 4: Verify GREEN and release compilation**

```bash
swift test --package-path native/macos \
  --filter BrokerCredentialLifecycleCodecTests
swift build --package-path native/macos -c release \
  -Xswiftc -warnings-as-errors
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add native/macos/Package.swift \
  native/macos/Sources/RecursBrokerXPC/BrokerCredentialLifecycleCodec.swift \
  native/macos/Tests/RecursBrokerServiceTests/BrokerCredentialLifecycleCodecTests.swift
git commit -m "feat: add private credential lifecycle codec"
```

## Task 3: Add the shared authority and bounded lifecycle gateway

**Files:**

- Create: `native/macos/Sources/RecursBrokerService/BrokerCredentialAuthority.swift`
- Create: `native/macos/Sources/RecursBrokerService/BrokerCredentialLifecycleGateway.swift`
- Create: `native/macos/Tests/RecursBrokerServiceTests/BrokerCredentialAuthorityTests.swift`
- Create: `native/macos/Tests/RecursBrokerServiceTests/BrokerCredentialLifecycleGatewayTests.swift`
- Modify: `native/macos/Package.swift`

**Interfaces:**

```swift
package protocol BrokerCredentialLifecycleAuthority: Sendable {
  func authoritativeLifecycleProjection(for connectionID: UUID)
    async throws(BrokerJournalError)
    -> CredentialLifecycleProjection
  func stage(connectionID: UUID, operationID: UUID, expectedFence: UInt64,
             secret: sending SecretBytes) async throws(BrokerStateError)
    -> StagingAttempt
  func resumeStage(connectionID: UUID, operationID: UUID,
                   expectedFence: UInt64) async throws(BrokerStateError)
    -> StagingAttempt
  func abort(connectionID: UUID, attemptID: UUID, operationID: UUID,
             expectedFence: UInt64) async throws(BrokerStateError)
    -> ReadyProjection?
  func disconnect(connectionID: UUID, operationID: UUID,
                  expectedFence: UInt64) async throws(BrokerStateError)
    -> TombstoneProjection
}

package struct BrokerCredentialAuthority:
  BrokerCredentialLifecycleAuthority,
  Sendable
{
  let state: BrokerCredentialState

  package static func recovering(
    store: any CredentialStore,
    journal: any BrokerJournalStore
  ) async throws -> BrokerCredentialAuthority

  package static func production(
    configuration: KeychainStoreConfiguration
  ) async throws -> BrokerCredentialAuthority

  package func authoritativeLifecycleProjection(for connectionID: UUID)
    async throws(BrokerJournalError) -> CredentialLifecycleProjection
  package func stage(connectionID: UUID, operationID: UUID,
                     expectedFence: UInt64, secret: sending SecretBytes)
    async throws(BrokerStateError) -> StagingAttempt
  package func resumeStage(connectionID: UUID, operationID: UUID,
                           expectedFence: UInt64)
    async throws(BrokerStateError) -> StagingAttempt
  package func abort(connectionID: UUID, attemptID: UUID,
                     operationID: UUID, expectedFence: UInt64)
    async throws(BrokerStateError) -> ReadyProjection?
  package func disconnect(connectionID: UUID, operationID: UUID,
                          expectedFence: UInt64)
    async throws(BrokerStateError) -> TombstoneProjection
}

package final class BrokerCredentialLifecycleGateway: @unchecked Sendable {
  package static let maximumInflightRequests = 8
  package static let maximumSecretBytes = 4_096

  package init(authority: any BrokerCredentialLifecycleAuthority)
  package func authorizeAfterHello()
  package func submitStage(
    metadata: Data,
    secret: consuming Data,
    reply: @escaping @Sendable (Data) -> Void
  )
  package func submitControl(
    _ request: Data,
    reply: @escaping @Sendable (Data) -> Void
  )
  package func close()
}
```

- [ ] **Step 1: Add authority and gateway failing tests**

Prove the recovery composition seam shares one actor, restores vacant/ready/
tombstoned records, and fails closed on journal authentication, rollback,
directory-lock, and store recovery errors using injected fakes only.

The authority methods above forward directly to the one shared state actor; no
wrapper keeps a second projection, fence, secret, or operation cache.

For the gateway prove pre-hello denial, valid projection/stage/resume/abort/
disconnect, exact operation replay, stale fence, conflicting operation ID,
busy cleanup, strictly increasing request IDs, eight-request capacity, closing
with work in flight, reserved-commit denial, and exactly one fixed reply for
every accepted call. Pause
the fake authority at every await boundary to cover invalidation races. Feed a
secret canary fragmented across `Data` storage and assert it is absent from
replies, errors, descriptions, reflection, task cancellation, and retained test
objects. Assert the fake authority receives a `SecretBytes`, never raw `Data`.
For malformed or truncated metadata/control input, assert exactly one
`.invalidRequest` reply with `brokerCredentialMalformedRequestID`; if a
canonical request ID was decoded before a later semantic failure, assert the
gateway echoes that ID instead.

- [ ] **Step 2: Verify RED**

```bash
swift test --package-path native/macos \
  --filter BrokerCredentialAuthorityTests
swift test --package-path native/macos \
  --filter BrokerCredentialLifecycleGatewayTests
```

Expected: compilation fails because the authority/gateway do not exist.

- [ ] **Step 3: Implement production recovery composition**

`production(configuration:)` performs exactly:

```swift
let directory = try SecureDirectory.openLiveJournalDirectory()
let authenticator = KeychainJournalAuthenticator(configuration: configuration)
let journal = try FileBrokerJournalStore.open(
  directory: directory,
  authenticator: authenticator
)
let store = DataProtectionCredentialStore(configuration: configuration)
let state = try await BrokerCredentialState.recovering(
  store: store,
  journal: journal
)
```

The returned authority retains the state; the journal retains the directory and
its authority lease. Do not catch and downgrade a production error.

- [ ] **Step 4: Implement the gateway**

Decode before dispatch, but always consume/erase stage secret storage. The
gateway is a synchronous ingress object with one private `NSLock`, one greatest-
seen request ID, a task/reply-gate table capped at eight, and a closed flag.
`@unchecked Sendable` is permitted only because every mutable field and every
admission/authorization/close transition is protected by that lock; no lock is
held while invoking authority, awaiting, cancelling a task, or calling a reply.
Reject before touching the authority when unauthorized, nonmonotonic, over
capacity, malformed, or closed. Convert the secret to `SecretBytes` before the
first credential-authority await. Map core errors exhaustively to fixed failure
codes. After a
successful mutation, return only its redacted state/fence/attempt information.
For an initial abort, return vacant at the mutation's expected fence.
`submitStage`/`submitControl` perform decode, hello/ID/capacity admission, task
creation, and task-handle insertion in one lock critical section, so there is no
unbounded pre-gateway task or close-before-insertion race. `close()` synchronously
marks the gateway terminal and snapshots/clears the table, then outside the lock
completes every reply gate with `.cancelled` and cancels every stored
`Task<Void, Never>`. Each task checks cancellation before invoking authority and
after every authority await. Late completions pass through the same reply gate
and therefore cannot reply or mutate gateway state a second time. Canonical
reserved kind 4 replies `.operationUnavailable` without calling authority.

Use this exhaustive error projection:

```text
BrokerStateError.cancelled                                      -> cancelled
.connectionNotFound                                            -> not_found
.connectionTombstoned                                          -> disconnected
.staleFence                                                    -> stale_fence
.operationInProgress                                           -> busy
.storeUnavailable                                              -> credential_store_unavailable
.cleanupPending                                                -> cleanup_pending
.fenceOverflow/.generationOverflow/.invalidTransition/
  .attemptNotCurrent/.operationIDConflict                      -> conflict
.invalidBootstrap                                              -> authority_unavailable + close

BrokerJournalError.casConflict/.revisionOverflow               -> conflict
.lockUnavailable/.storageUnavailable                           -> credential_store_unavailable
.mutationOutcomeUnknown                                        -> cleanup_pending
.invalidRecord/.nonCanonical/.unsupportedVersion/
  .authenticationFailed/.rollbackDetected                      -> authority_unavailable + close
```

- [ ] **Step 5: Verify GREEN and core regressions**

```bash
swift test --package-path native/macos \
  --filter BrokerCredentialAuthorityTests
swift test --package-path native/macos \
  --filter BrokerCredentialLifecycleGatewayTests
swift test --package-path native/macos \
  --filter RecursBrokerCoreTests
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add native/macos/Package.swift \
  native/macos/Sources/RecursBrokerService/BrokerCredentialAuthority.swift \
  native/macos/Sources/RecursBrokerService/BrokerCredentialLifecycleGateway.swift \
  native/macos/Tests/RecursBrokerServiceTests/BrokerCredentialAuthorityTests.swift \
  native/macos/Tests/RecursBrokerServiceTests/BrokerCredentialLifecycleGatewayTests.swift
git commit -m "feat: add broker credential lifecycle authority"
```

## Task 4: Expose the private lifecycle over exact-peer XPC

**Files:**

- Create: `native/macos/Sources/RecursBrokerXPC/BrokerCredentialLifecycleXPCProtocol.swift`
- Modify: `native/macos/Sources/RecursBrokerXPC/BrokerXPCProtocol.swift`
- Modify: `native/macos/Sources/RecursBrokerService/BrokerService.swift`
- Modify: `native/macos/Sources/RecursBrokerService/BrokerServiceListenerDelegate.swift`
- Modify: `native/macos/Tests/RecursBrokerServiceTests/BrokerServiceTests.swift`
- Create: `native/macos/Tests/RecursBrokerServiceTests/BrokerCredentialLifecycleXPCTests.swift`

**XPC interface:**

```swift
@objc(RecursBrokerXPCProtocol)
public protocol BrokerXPCProtocol: NSObjectProtocol {
  func exchange(
    _ frame: Data,
    reply: @escaping @Sendable (Data) -> Void
  )
}

@objc(RecursBrokerCredentialLifecycleXPCProtocol)
public protocol BrokerCredentialLifecycleXPCProtocol: BrokerXPCProtocol {
  func stageCredential(
    _ metadata: Data,
    secret: Data,
    reply: @escaping @Sendable (Data) -> Void
  )

  func credentialControl(
    _ request: Data,
    reply: @escaping @Sendable (Data) -> Void
  )
}

extension BrokerServiceConfiguration {
  package static func recoveredCredentialService(
    launcherVersion: String,
    brokerVersion: String,
    authority: any BrokerCredentialLifecycleAuthority,
    initialKeychain: KeychainStatusCode,
    keychainStatus: @escaping @Sendable () -> KeychainStatusCode
  ) throws -> BrokerServiceConfiguration

  package static func healthOnlyForTesting(
    launcherVersion: String,
    brokerVersion: String,
    productionSigned: Bool,
    initialKeychain: KeychainStatusCode,
    keychainStatus: @escaping @Sendable () -> KeychainStatusCode
  ) throws -> BrokerServiceConfiguration
}
```

Remove `persistentCredentials` from every configuration initializer. Store an
optional authority privately and derive the hello capability bit from its
presence. The recovered factory requires a nonoptional authority; the health-
only test factory always stores `nil`. No production call site can set the bit.

- [ ] **Step 1: Add failing XPC/service tests**

Prove the exported interface declares only the existing health exchange plus
the two fixed credential selectors; both argument and reply class allowlists
contain only `NSData`; and no generic selector, URL, header, Keychain reference,
credential lookup, or arbitrary object class is exposed.

Using a fake authority, prove hello is required on the same service object,
health remains compatible, lifecycle requests reach the per-connection gateway,
the listener injects the exact same authority into two independently handshaken
connections, one connection's request IDs/cancellation do not affect the other,
and connection invalidation closes only its gateway. Cover malformed health
after hello cancelling lifecycle work and suppressing late state/error detail.
Assert canonical reserved kind 4 never calls a commit method and cannot create
a ready projection.

Race hello, lifecycle calls, interruption, and invalidation from concurrent
queues. Prove lifecycle either observes hello or fails closed, IDs admit only in
strict increasing order, no ninth operation creates a task, invalidation
synchronously prevents every later admission, and an operation admitted just
before invalidation is cancelled exactly once. Foundation gives no ordering
guarantee between handlers and replies, so these tests must exercise both race
orders.

Also run a real anonymous-XPC round trip with
`NSXPCListener.anonymous()` and `NSXPCConnection(listenerEndpoint:)`. Exercise
inherited health exchange, stage metadata plus secret `NSData`, control request,
reply `NSData`, and invalidation. This test proves Objective-C protocol
inheritance, selector names/signatures, class argument indexes, and serialization
rather than relying only on a fake connection object.

- [ ] **Step 2: Verify RED**

```bash
swift test --package-path native/macos \
  --filter BrokerCredentialLifecycleXPCTests
swift test --package-path native/macos \
  --filter BrokerServiceTests
```

Expected: compilation or assertions fail because the selectors and gateway
wiring do not exist.

- [ ] **Step 3: Implement the composite XPC interface**

Configure `NSXPCInterface` with
`BrokerCredentialLifecycleXPCProtocol.self`. Register `NSData` for every data
argument/reply position of all three selectors. Keep the launcher-side health
proxy compatible through protocol inheritance.

- [ ] **Step 4: Wire per-connection service state**

Keep the existing `BrokerService` lock only for the synchronous hello/health
state machine; never hold it across an await or while calling an XPC reply. A
successful hello synchronously calls `gateway.authorizeAfterHello()` before the
exchange method returns. A terminal/malformed health session synchronously
calls `gateway.close()`. The two lifecycle XPC methods call the gateway's
synchronous submit methods directly and create no actor-hop task of their own.

`BrokerServiceListenerDelegate` creates a fresh service/gateway for each
accepted connection from the same injected authority. Add the existing
Foundation-compatible, non-`@Sendable` `interruptionHandler` and
`invalidationHandler` properties to the test connection abstraction; both call
the service's idempotent synchronous close. The gateway lock linearizes every
submit/authorize/close race, owns the bounded authority-operation task handles,
and owns the exactly-once reply gates.

- [ ] **Step 5: Verify GREEN and launcher compatibility**

```bash
swift test --package-path native/macos \
  --filter RecursBrokerServiceTests
swift test --package-path native/macos \
  --filter RecursLauncherTests
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add native/macos/Sources/RecursBrokerXPC \
  native/macos/Sources/RecursBrokerService/BrokerService.swift \
  native/macos/Sources/RecursBrokerService/BrokerServiceListenerDelegate.swift \
  native/macos/Tests/RecursBrokerServiceTests
git commit -m "feat: expose private broker credential lifecycle"
```

## Task 5: Recover the authority before live listener activation

**Files:**

- Modify: `native/macos/Sources/RecursBrokerService/BrokerService.swift`
- Create: `native/macos/Sources/RecursBrokerService/BrokerServiceRuntime.swift`
- Modify: `native/macos/Sources/RecursNativeBrokerExecutable/main.swift`
- Create: `native/macos/Tests/RecursBrokerServiceTests/BrokerServiceRuntimeTests.swift`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `SECURITY.md`

**Runtime interface:**

```swift
package final class BrokerServiceRuntime {
  package static func production(
    launcherVersion: String,
    brokerVersion: String
  ) async throws -> BrokerServiceRuntime

  package func activate()
}

package protocol BrokerServiceListenerHandle: AnyObject {
  var delegate: NSXPCListenerDelegate? { get set }
  func setConnectionCodeSigningRequirement(_ requirement: String)
  func activate()
}

package struct BrokerServiceRuntimeDependencies {
  let makePeerRequirement: () throws -> PeerRequirement
  let makeKeychainConfiguration:
    () throws -> KeychainStoreConfiguration
  let recoverAuthority:
    (KeychainStoreConfiguration) async throws
      -> BrokerCredentialAuthority
  let makeKeychainStatusSource:
    (KeychainStoreConfiguration) -> @Sendable () -> KeychainStatusCode
  let makeListener:
    (String) -> any BrokerServiceListenerHandle
}
```

Add `NSXPCListener: BrokerServiceListenerHandle`. The test factory accepts an
explicit `BrokerServiceRuntimeDependencies`; the live factory uses only fixed
production implementations. It evaluates dependencies in field order, creates
the listener only after recovery, sets its exact signing requirement and
delegate, but leaves activation to `activate()`.

- [ ] **Step 1: Add failing startup-order tests**

Record events and prove exact peer validation and authority recovery finish
before listener construction/activation; the same authority reaches the
delegate; persistent capability is true only on the recovered path; and every
peer, Keychain, directory, authority-lock, journal-authentication, rollback, or
recovery failure leaves activation count zero. Prove health reads current
Keychain availability after startup without rebuilding authority.

- [ ] **Step 2: Verify RED**

```bash
swift test --package-path native/macos --filter BrokerServiceRuntimeTests
```

Expected: compilation fails because `BrokerServiceRuntime` does not exist.

- [ ] **Step 3: Implement fail-closed startup**

Remove `productionHandshakeHealthOnly` from the executable path. Build and
recover the production authority asynchronously, then create the listener and
delegate. Keep all runtime objects alive for the process lifetime. Activate
exactly once only after the runtime is complete. On any error, the executable
exits with configuration status 78 and does not emit raw error text.

Use Swift's top-level async entry directly; do not create an unretained startup
task:

```swift
do {
  let runtime = try await BrokerServiceRuntime.production(
    launcherVersion: NativeComponentVersion.current,
    brokerVersion: NativeComponentVersion.current
  )
  runtime.activate()
  withExtendedLifetime(runtime) { dispatchMain() }
} catch {
  Foundation.exit(78)
}
```

Configuration reports `persistentCredentials: true` only when constructed with
the recovered authority. Keep a health-only test factory for unsigned/fake unit
tests, but name it explicitly and prevent its use in `main.swift`.

- [ ] **Step 4: Update truthful documentation**

Document that the production-gated broker code path now owns and recovers
persistent credentials and exposes a private launcher-only lifecycle surface.
Do not imply that a signed/notarized installed artifact has been produced or
verified. State equally clearly
that the launcher has not yet collected secrets, staging candidates cannot yet
be provider-verified, provider metadata is not yet durably bound to generations,
provider HTTP does not exist, source/npm builds cannot activate this authority,
and all direct provider manifests remain disabled.

- [ ] **Step 5: Verify focused GREEN**

```bash
swift test --package-path native/macos --filter BrokerServiceRuntimeTests
swift test --package-path native/macos --filter RecursBrokerServiceTests
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add native/macos/Sources/RecursBrokerService \
  native/macos/Sources/RecursNativeBrokerExecutable/main.swift \
  native/macos/Tests/RecursBrokerServiceTests \
  README.md ARCHITECTURE.md SECURITY.md
git commit -m "feat: activate durable broker credential service"
```

## Task 6: Security review and clean verification matrix

**Files:**

- Modify only files required by findings from the independent review.

- [ ] **Step 1: Produce and independently review the diff package**

Use the subagent-driven-development review package script from the branch base
through `HEAD`. Review against this plan, the Provider Activation v1 design, and
the broker credential/journal contracts. Fix every actionable finding and repeat
the review until it passes.

- [ ] **Step 2: Run the full clean matrix**

```bash
rm -rf native/macos/.build
npm test
npm run typecheck
npm run lint
npm run build
npm run check:native
swift test --package-path native/macos
swift build --package-path native/macos -c release \
  -Xswiftc -warnings-as-errors
npm run check:native:plist
npm run check:native:entitlements
npm run check:native:bundle
npm run check:native:bridge
npm run check:doctor
npm run check:source-smoke
```

Expected: all commands PASS from a clean build.

- [ ] **Step 3: Run boundary and secret scans**

```bash
rg -n "stageCredential|credentialControl|CredentialLifecycle" \
  packages native/macos/Sources/RecursNativeProtocol
rg -n "api[_-]?key|authorization|bearer|credential.*reference|keychain.*account" \
  packages/auth packages/native-engine packages/contracts
rg -n "runnable:\s*true" packages/providers packages/app
git grep -nE "BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|sk-[A-Za-z0-9_-]{16,}"
```

Expected: credential lifecycle symbols occur only in native broker/XPC/service
code; no new secret/reference surface appears in TypeScript or the Node
protocol; broker-owned provider manifests remain disabled; the secret scan is
empty.

- [ ] **Step 4: Inspect intended diff and commit review fixes**

```bash
git status --short
git diff --check
git diff --stat
git log --oneline --decorate -12
```

Stage only intended files, inspect the staged diff, rerun the secret scan, and
commit any review fixes as a focused commit.

## Completion boundary

This plan is complete only when the live signed broker recovers and shares the
durable credential authority before listening, the private exact-peer lifecycle
surface is bounded/cancellable/redacted and fully tested, the Node protocol and
TypeScript remain credential-free, all direct providers remain disabled, and
the full verification matrix is green.

The next plan must resolve native provider/profile binding and a fenced staging-
candidate reservation plus the pre-send network-route feasibility proof before
adding TTY onboarding or loading a real credential for provider HTTPS.
