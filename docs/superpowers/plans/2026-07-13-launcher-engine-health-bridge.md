# Launcher-to-Engine Health Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the health-only signed-launcher-to-bundled-engine bridge, while keeping the public/source CLI unable to trust inherited descriptors and keeping every direct provider disabled.

**Architecture:** A typed Swift session translates only protocol `hello`, `health`, and `cancel` frames between one anonymous socket and the existing exact-peer `BrokerConnection`; it is not an XPC proxy. A private TypeScript engine host is the sole process entrypoint that can claim the inherited socket marker, while the npm/source CLI deletes that marker and returns a fixed unavailable result. The native launcher resolves Node and the engine only from fixed sealed-bundle locations, spawns them with one close-on-exec socket endpoint, serves the typed session, and propagates child termination.

**Tech Stack:** Swift 6.2, Swift Testing, Darwin POSIX sockets and `posix_spawn`, TypeScript 6, Node.js 22.22+, Vitest 4, npm workspaces.

## Global Constraints

- Production native code targets macOS 14.4 or newer; source and unsigned builds must fail closed.
- Protocol version remains `1`; the frame header remains `16` bytes; payloads remain capped at `64 * 1024` bytes; nonce length remains `32` bytes.
- The launcher session accepts only `hello`, `health`, and `cancel`; it exposes no generic exchange, credential, endpoint, header, Keychain-reference, URL, request-body, or provider-operation surface.
- Node request IDs are nonzero and strictly increasing; at most `64` health requests may be active or queued; broker work stays serial.
- Active-request cancellation is terminal: close the broker, socket, and session, and suppress every late XPC response.
- Native failures cross the socket only as existing fixed `SafeFailureCode` values; native error prose and transport details never cross it.
- The public/npm/source CLI deletes `RECURS_NATIVE_FD`, never reads or writes its descriptor, and never treats the marker as provenance.
- The private engine host has no npm `bin` and no public package export; private placement is not identity proof, so self-asserted readiness remains downgraded until installed signed-artifact evidence exists.
- The launcher resolves the Node runtime and engine entrypoint only from fixed regular, nonsymlinked files inside its own sealed bundle; it never resolves either from `PATH`, the working directory, an environment variable, or a user argument.
- A spawned engine inherits descriptors `0`, `1`, `2`, and exactly one anonymous socket endpoint mapped to descriptor `3`; all other descriptors use close-on-exec semantics.
- The engine environment is rebuilt from the reviewed non-secret keys `HOME`, `PATH`, `TMPDIR`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TERM`, `COLORTERM`, `NO_COLOR`, `FORCE_COLOR`, `TZ`, `RECURS_HOME`, and `CODEX_HOME`, plus canonicalized recognized automation markers and `RECURS_NATIVE_FD=3`; `NODE_OPTIONS`, `NODE_PATH`, `DYLD_*`, proxy, cloud, credential, token, and key variables are never copied.
- No direct-provider manifest becomes runnable, no credential is collected, and no heavy sub-agent architecture is added in this plan.

---

## File Structure

- `native/macos/Sources/RecursNativeProtocol/Messages.swift`: typed health and cancellation request codecs.
- `native/macos/Sources/RecursLauncher/LauncherNodeSession.swift`: bounded protocol state machine that invokes `BrokerConnection`.
- `native/macos/Sources/RecursLauncher/LauncherNodeSocket.swift`: one owned socket endpoint with bounded reads, complete writes, timeouts, and idempotent close.
- `native/macos/Sources/RecursLauncher/EngineBundleLayout.swift`: fixed sealed-bundle runtime and engine resolution.
- `native/macos/Sources/RecursLauncher/EngineChildProcess.swift`: socketpair creation, exact descriptor inheritance, `posix_spawn`, wait, and termination.
- `native/macos/Sources/RecursNativeLauncherExecutable/main.swift`: health diagnostic compatibility plus the bundled-engine host lifecycle.
- `packages/auth/src/client.ts`: injected-duplex protocol client only; no process environment access.
- `packages/app/src/native-authority.ts`: sanitized service wrapper only; no inherited-descriptor assembly.
- `packages/cli/src/process-host.ts`: shared CLI process assembly with an injected native status port.
- `packages/cli/src/main.ts`: public/source bin that discards the untrusted marker and injects a fixed unavailable port.
- `packages/native-engine/src/inherited-socket.ts`: the only TypeScript production code that claims the marker.
- `packages/native-engine/src/native-authority.ts`: private one-shot client/service assembly with the interim provenance downgrade.
- `packages/native-engine/src/main.ts`: private bundled-engine process entrypoint.
- `scripts/check-native-engine-bridge.mjs`: cross-process public/private-host boundary smoke.

### Task 1: Add the typed Swift health bridge session

**Files:**
- Modify: `native/macos/Sources/RecursNativeProtocol/Messages.swift`
- Modify: `native/macos/Tests/RecursNativeProtocolTests/FrameTests.swift`
- Create: `native/macos/Sources/RecursLauncher/LauncherNodeSession.swift`
- Create: `native/macos/Tests/RecursLauncherTests/LauncherNodeSessionTests.swift`

**Interfaces:**
- Consumes: existing `NativeFrameDecoder`, `HelloMessage`, `HelloResultMessage`, `HealthResultMessage`, `SafeFailureCode`, and `BrokerConnection`.
- Produces: `HealthMessage`, `CancelMessage`, `LauncherNodeSessionOutput`, and `LauncherNodeSession`.

- [ ] **Step 1: Write failing typed request-codec tests**

Add exact round-trip and malformed-input cases for these public interfaces:

```swift
public struct HealthMessage: Equatable, Sendable {
  public init() {}
  public static func decode(_ frame: NativeFrame) throws -> HealthMessage
  public func encodedFrame(requestID: UInt32) throws -> Data
}

public struct CancelMessage: Equatable, Sendable {
  public let targetRequestID: UInt32
  public init(targetRequestID: UInt32) throws
  public static func decode(_ frame: NativeFrame) throws -> CancelMessage
  public func encodedFrame(requestID: UInt32) throws -> Data
}
```

`HealthMessage.decode` accepts only `.health` with an exact empty field table. `CancelMessage` accepts only `.cancel` with one tag-`1` nonzero `UInt32`. Keep `makeHealthFrame` and `makeCancelFrame` as compatibility wrappers over the typed messages.

- [ ] **Step 2: Run the protocol tests and verify RED**

Run:

```bash
swift test --package-path native/macos --filter 'Native authority protocol'
```

Expected: FAIL because `HealthMessage` and `CancelMessage` do not exist.

- [ ] **Step 3: Implement the typed request codecs**

Implement the two exact interfaces above using `requireFields`, `FieldTable.decodeUInt32`, and the existing frame constructors. Convert every codec failure to `NativeProtocolError.invalidMessage` through `withInvalidMessage`.

- [ ] **Step 4: Write failing session tests**

Use the existing scripted `BrokerConnection` test double and a recording output implementing:

```swift
package protocol LauncherNodeSessionOutput: Sendable {
  func write(_ frame: Data) async throws
  func close() async
}

package actor LauncherNodeSession {
  package init(
    brokerConnectionFactory: @escaping @Sendable () throws(BrokerConnectionError) -> BrokerConnection,
    output: any LauncherNodeSessionOutput
  )
  package func receive(_ chunk: Data)
  package func finish()
  package func close()
}
```

Prove fragmented hello, hello then health, serial FIFO health responses, the `64` active-plus-queued bound, strictly increasing request IDs, fixed safe-failure mapping, queued cancellation, terminal active cancellation, malformed/wrong-phase frames, truncated EOF, output failure, late-XPC suppression, and exactly-once broker/output close. Include a canary native error and assert its bytes never occur in output.

- [ ] **Step 5: Run the launcher tests and verify RED**

Run:

```bash
swift test --package-path native/macos --filter LauncherNodeSessionTests
```

Expected: FAIL because the session does not exist.

- [ ] **Step 6: Implement the bounded session**

Use phases `awaitingHello`, `handshaking`, `ready`, and `closed`; one `NativeFrameDecoder`; one greatest-seen request ID; one active task; and a FIFO of health request IDs. Invoke the factory only after a valid first hello, retain exactly one connection, and never reconnect within a session. Re-encode broker results with the original Node request ID. Map `BrokerConnectionError.closed` to `.brokerUnavailable`; map all other cases one-for-one. Any parse/state/output/unknown error closes the broker and output once. Cancelling the active request cancels its task and closes the entire session; a late completion checks the closed phase and emits nothing.

- [ ] **Step 7: Run focused tests and commit**

Run:

```bash
swift test --package-path native/macos --filter RecursNativeProtocolTests
swift test --package-path native/macos --filter RecursLauncherTests
```

Expected: PASS.

```bash
git add native/macos/Sources/RecursNativeProtocol/Messages.swift \
  native/macos/Sources/RecursLauncher/LauncherNodeSession.swift \
  native/macos/Tests/RecursNativeProtocolTests/FrameTests.swift \
  native/macos/Tests/RecursLauncherTests/LauncherNodeSessionTests.swift
git commit -m "feat: add typed launcher engine session"
```

### Task 2: Separate the public CLI from the private engine host

**Files:**
- Modify: `packages/auth/src/client.ts`
- Delete: `packages/auth/src/socket.ts`
- Modify: `packages/auth/src/index.ts`
- Modify: `packages/auth/test/client.test.ts`
- Delete: `packages/auth/test/inherited-client.test.ts`
- Modify: `packages/app/src/native-authority.ts`
- Modify: `packages/app/src/index.ts`
- Modify: `packages/app/package.json`
- Modify: `packages/app/tsconfig.json`
- Modify: `packages/app/test/native-authority.test.ts`
- Modify: `packages/app/test/onboarding-catalog.test.ts`
- Create: `packages/cli/src/process-host.ts`
- Modify: `packages/cli/src/main.ts`
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/test/run-mode.test.ts`
- Create: `packages/native-engine/package.json`
- Create: `packages/native-engine/tsconfig.json`
- Create: `packages/native-engine/src/inherited-socket.ts`
- Create: `packages/native-engine/src/native-authority.ts`
- Create: `packages/native-engine/src/main.ts`
- Create: `packages/native-engine/test/inherited-socket.test.ts`
- Create: `packages/native-engine/test/native-authority.test.ts`
- Move: `packages/auth/test/fixtures/fake-native-peer.mjs` to `packages/native-engine/test/fixtures/fake-native-peer.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tsconfig.json`

**Interfaces:**
- Consumes: `connectNativeAuthorityClient(duplex, options)`, `NativeAuthorityService`, and `runCli`.
- Produces: `runCliProcess(nativeAuthority: NativeAuthorityStatusPort): Promise<void>` and a private package with no `bin` or `exports`.

- [ ] **Step 1: Write failing package-boundary and process-host tests**

Assert that `@recurs/auth` exports the injected-duplex connector but no inherited-descriptor factory, `@recurs/app` exports only the sanitizer/service, the public CLI deletes `RECURS_NATIVE_FD` before any async work and returns `launcher_unavailable` on Darwin or `unsupported_platform` elsewhere, and the private host owns canonical descriptor parsing/closure. Spawn a real fd-3 fake peer against the public CLI and assert zero bytes reach it.

- [ ] **Step 2: Run focused TypeScript tests and verify RED**

Run:

```bash
npx vitest run packages/auth/test packages/app/test/native-authority.test.ts \
  packages/cli/test/run-mode.test.ts packages/native-engine/test
```

Expected: FAIL because the process-boundary split and private host do not exist.

- [ ] **Step 3: Make auth and app transport-agnostic**

Export this existing pure connector from `@recurs/auth`:

```ts
export function connectNativeAuthorityClient(
  duplex: Duplex,
  options: NativeAuthorityClientConnectOptions,
): Promise<NativeAuthorityClient>;
```

Remove all `process.env`, `fstat`, descriptor wrapping, and interim provenance restriction from auth. Keep `NativeAuthorityService` unchanged as the sanitizer/close wrapper, but remove `createNativeAuthorityServiceFromInheritedFd` and the app-to-auth dependency.

- [ ] **Step 4: Extract shared CLI process assembly**

Move argv, signal, TTY, confirmation, data-directory, runtime, and account assembly behind:

```ts
export async function runCliProcess(
  nativeAuthority: NativeAuthorityStatusPort,
): Promise<void>;
```

The public `main.ts` synchronously deletes `process.env.RECURS_NATIVE_FD`, injects a frozen fixed-unavailable port, and calls `runCliProcess`. It must not import `@recurs/auth`, `node:net`, or descriptor helpers.

- [ ] **Step 5: Implement the private engine host**

Create `@recurs/native-engine` with `"private": true`, no `bin`, and no `exports`. Move the exact canonical descriptor parser and ownership tests into it. Its one-shot status port claims and deletes the marker, creates an injected-duplex client with `NATIVE_COMPONENT_VERSION`, wraps it in `NativeAuthorityService`, and still changes any ready status to `peer_identity_unverified` before closing. Its main module calls `runCliProcess` and closes owned resources in `finally`.

- [ ] **Step 6: Run focused tests, typecheck, lint, and commit**

Run:

```bash
npx vitest run packages/auth/test packages/app/test/native-authority.test.ts \
  packages/cli/test/run-mode.test.ts packages/native-engine/test
npm run typecheck
npm run lint
```

Expected: PASS.

```bash
git add package.json package-lock.json tsconfig.json packages/auth packages/app \
  packages/cli packages/native-engine
git commit -m "refactor: isolate bundled native engine host"
```

### Task 3: Add the owned Darwin socket transport

**Files:**
- Create: `native/macos/Sources/RecursLauncher/LauncherNodeSocket.swift`
- Create: `native/macos/Tests/RecursLauncherTests/LauncherNodeSocketTests.swift`

**Interfaces:**
- Consumes: `LauncherNodeSessionOutput` and `LauncherNodeSession.receive/finish/close`.
- Produces: one owned close-on-exec socket endpoint and a bounded read pump.

- [ ] **Step 1: Write failing real-socket tests**

Create a real `socketpair(AF_UNIX, SOCK_STREAM, 0, ...)`. Prove fragmented and coalesced frames reach the session, complete writes survive forced short writes/EINTR, peer EOF calls `finish`, read/write timeout or EPIPE closes without SIGPIPE, oversized/truncated input fails closed, and repeated or concurrent close closes the descriptor once. Confirm `F_GETFD & FD_CLOEXEC != 0` and `SO_NOSIGPIPE == 1` on the owned endpoint.

- [ ] **Step 2: Run the socket tests and verify RED**

Run:

```bash
swift test --package-path native/macos --filter LauncherNodeSocketTests
```

Expected: FAIL because the socket transport does not exist.

- [ ] **Step 3: Implement the owned socket and read pump**

Provide these package-only interfaces:

```swift
package final class LauncherNodeSocket: LauncherNodeSessionOutput,
  @unchecked Sendable
{
  package init(ownedDescriptor: Int32) throws
  package func read(maximumByteCount: Int) async throws -> Data?
  package func write(_ frame: Data) async throws
  package func close() async
}

package func serve(
  session: LauncherNodeSession,
  socket: LauncherNodeSocket
) async
```

Use a lock-protected owned descriptor, `SO_NOSIGPIPE`, finite `SO_RCVTIMEO`/`SO_SNDTIMEO`, retry only EINTR, bounded `recv`, and a loop for complete `send`. Return `nil` only for clean EOF. `serve` feeds chunks no larger than `nativeFrameHeaderByteCount + nativeFrameMaximumPayloadByteCount`, calls `finish` on EOF, and closes both sides in `defer`.

- [ ] **Step 4: Run focused native tests and commit**

Run:

```bash
swift test --package-path native/macos --filter RecursLauncherTests
```

Expected: PASS without hangs or SIGPIPE.

```bash
git add native/macos/Sources/RecursLauncher/LauncherNodeSocket.swift \
  native/macos/Tests/RecursLauncherTests/LauncherNodeSocketTests.swift
git commit -m "feat: add bounded launcher socket transport"
```

### Task 4: Spawn only the fixed bundled engine

**Files:**
- Create: `native/macos/Sources/RecursLauncher/EngineBundleLayout.swift`
- Create: `native/macos/Sources/RecursLauncher/EngineChildProcess.swift`
- Create: `native/macos/Tests/RecursLauncherTests/EngineBundleLayoutTests.swift`
- Create: `native/macos/Tests/RecursLauncherTests/EngineChildProcessTests.swift`
- Modify: `native/macos/Resources/README.md`

**Interfaces:**
- Consumes: `LauncherNodeSocket` and the private host output layout.
- Produces: validated fixed bundle paths and a child-process handle with one launcher socket.

- [ ] **Step 1: Write failing bundle-layout and spawn tests**

Validate this exact release layout:

```text
RecursLauncher.app/Contents/Resources/runtime/bin/node
RecursLauncher.app/Contents/Resources/engine/main.js
```

Reject missing, directory, symlink, nonregular, and escaped paths. With an injected fixed test executable, prove argv is `[nodePath, enginePath, ...userArguments]`, a preexisting marker is replaced, the child inherits `0`, `1`, `2`, and descriptor `3` only, the parent closes the child endpoint immediately, spawn failure closes both endpoints, and wait maps normal exits and signals without leaking paths or environment values in errors. Inject canary `NODE_OPTIONS`, `NODE_PATH`, `DYLD_*`, proxy, cloud, credential, token, and key variables and prove none reach the child; prove only the reviewed environment allowlist and canonicalized automation flags survive.

- [ ] **Step 2: Run the process tests and verify RED**

Run:

```bash
swift test --package-path native/macos --filter EngineBundleLayoutTests
swift test --package-path native/macos --filter EngineChildProcessTests
```

Expected: FAIL because layout and child-process types do not exist.

- [ ] **Step 3: Implement fixed layout validation**

Provide:

```swift
package struct EngineBundleLayout: Equatable, Sendable {
  package let nodeExecutable: URL
  package let engineEntrypoint: URL
  package static func production(bundle: Bundle = .main) throws -> Self
}
```

First validate the current outer launcher as the exact production-signed launcher through the existing strict `PeerRequirement.production(for:authenticatedAs:)` path. Resolve only the two exact descendants above. Standardize paths, require containment under `bundle.bundleURL`, use `lstat` to reject symlinks, require regular files, and require execute permission only for Node. Errors are fixed enums with no associated path or text.

- [ ] **Step 4: Implement exact descriptor inheritance and child lifecycle**

Create the raw socketpair, duplicate both endpoints above descriptor `3` with `F_DUPFD_CLOEXEC`, and close the raw descriptors immediately. Set `SO_NOSIGPIPE` on the launcher endpoint. Configure `POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK`; explicitly inherit descriptors `0`, `1`, and `2`, `adddup2(engineSocketFD, 3)`, then close the source engine descriptor in the child. Reset `SIGINT`, `SIGTERM`, `SIGHUP`, `SIGQUIT`, and `SIGPIPE` with an empty child signal mask. Spawn the fixed Node URL directly with the fixed engine URL as argv[1], rebuild the reviewed environment, set only `RECURS_NATIVE_FD=3`, and never invoke a shell. Close the child endpoint in the parent on every path. Treat each `posix_spawn*` return as its own error code rather than reading `errno`. Retry exact-positive-PID `waitpid` only on EINTR and decode Darwin wait status into a fixed `EngineTermination` value without function-like C macros. Forced shutdown closes the channel, sends `SIGTERM`, polls exact-PID `waitpid(..., WNOHANG)` for a bounded grace period, sends `SIGKILL` if needed, and always performs the final exact-PID reap; repeated shutdown cannot double-close, double-signal, or double-wait.

- [ ] **Step 5: Run focused native tests and commit**

Run:

```bash
swift test --package-path native/macos --filter RecursLauncherTests
```

Expected: PASS.

```bash
git add native/macos/Sources/RecursLauncher/EngineBundleLayout.swift \
  native/macos/Sources/RecursLauncher/EngineChildProcess.swift \
  native/macos/Tests/RecursLauncherTests/EngineBundleLayoutTests.swift \
  native/macos/Tests/RecursLauncherTests/EngineChildProcessTests.swift \
  native/macos/Resources/README.md
git commit -m "feat: add fixed bundled engine launcher"
```

### Task 5: Wire the launcher, smoke the boundary, and document the honest state

**Files:**
- Modify: `native/macos/Sources/RecursNativeLauncherExecutable/main.swift`
- Modify: `scripts/check-native-source-launcher.mjs`
- Modify: `scripts/check-native-doctor.mjs`
- Create: `scripts/check-native-engine-bridge.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `SECURITY.md`
- Modify: `docs/CLI.md`
- Modify: `docs/superpowers/specs/2026-07-10-recurs-provider-auth-design.md`
- Modify: `docs/superpowers/specs/2026-07-13-provider-activation-v1-design.md`
- Modify: `docs/superpowers/plans/2026-07-13-launcher-engine-health-bridge.md`

**Interfaces:**
- Consumes: Tasks 1–4 and existing `ServiceRegistration`/`BrokerConnection`.
- Produces: a source-safe launcher lifecycle and cross-process bridge evidence, not a signed release artifact.

- [ ] **Step 1: Write failing launcher lifecycle and smoke assertions**

Keep `native-health --machine` backward compatible. Add a bundle-engine run path that resolves only `EngineBundleLayout.production`, starts one child, lazily opens the existing exact-peer broker on the first hello, serves the session, closes it when either side ends, waits for the child, and mirrors its normal or signal termination. Keep the child in the foreground process group; intercept launcher signals only long enough to close/reap without duplicating terminal-delivered `SIGINT`, and forward explicit termination once to the exact positive child PID. Source builds without staged engine resources must return a fixed configuration exit with empty stdout and no path-bearing stderr.

The cross-process smoke must prove: public CLI plus a real fd-3 fake peer writes zero bytes and reports fixed unavailable; private host plus the peer performs hello/health but still reports `peer_identity_unverified`; source launcher cannot resolve an engine from `PATH`, cwd, env, or arguments; cancellation exits promptly; no credential-shaped canary appears; providers remain hard-disabled.

- [ ] **Step 2: Run smokes and verify RED**

Run:

```bash
npm run build
node scripts/check-native-engine-bridge.mjs
npm run native:smoke
```

Expected: FAIL because the executable lifecycle and bridge smoke are not wired.

- [ ] **Step 3: Wire the executable and build checks**

Factor registration/open logic out of the old direct diagnostic so both paths use the same exact-peer `BrokerConnection`. Do not reconnect after a protocol or peer-identity failure. Add `native:engine-bridge-smoke` and include it in both `check` and `check:native`; keep macOS CI running the real Darwin descriptor path.

- [ ] **Step 4: Update documentation without claiming activation**

Document the public/private entrypoint split, fixed sealed-bundle paths, exact inherited-descriptor set, health-only protocol, cancellation behavior, and source-build failure. State explicitly that no signed/notarized engine bundle, live broker credential operation, provider codec/transport, or direct-provider onboarding is complete and all broker-owned providers remain disabled.

- [ ] **Step 5: Run the complete verification matrix**

Run:

```bash
rm -rf packages/*/dist native/macos/.build
npm run check
npm run check:native
RECURS_HOME="$(mktemp -d)" node packages/cli/dist/main.js doctor native --json
git diff --check main...HEAD
```

Expected: all TypeScript lint/typecheck/tests/build, Swift tests/build, plist/entitlement lint, public/private bridge smoke, and source launcher smoke pass. The public source CLI reports only `launcher_unavailable` on Darwin, the private host remains provenance-downgraded, and no provider is runnable.

- [ ] **Step 6: Scan for boundary drift and commit**

Confirm only `packages/native-engine/src/inherited-socket.ts` reads `RECURS_NATIVE_FD`; tool-child tests still prove descriptors `0`–`2` only; no `Authorization`, `x-api-key`, credential, token, endpoint, URL, or request-body field was added to the bridge; and broker-owned manifests remain denied.

```bash
git add README.md ARCHITECTURE.md SECURITY.md docs package.json .github \
  scripts native/macos/Sources/RecursNativeLauncherExecutable/main.swift
git commit -m "feat: wire launcher to bundled engine health bridge"
```

Do not merge to `main` or push. Stop at this reviewed health-only bridge; live credential operations and provider activation require a separate implementation plan.
