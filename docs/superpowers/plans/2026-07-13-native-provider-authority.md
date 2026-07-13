# Native Provider Authority Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the real macOS native authority, credential lifecycle,
strict launcher protocol, and TypeScript client required before any
broker-owned provider can become runnable.

**Architecture:** A Swift package contains a dependency-light binary protocol,
broker credential core, Data Protection Keychain adapter, exact code-identity
requirements, XPC service, and headless launcher. `@recurs/auth` is a
credential-free TypeScript client for the anonymous launcher socket. The app
and CLI can inspect redacted attestation/health, but OpenAI, Anthropic, and
coding-plan manifests remain disabled until later protocol/onboarding plans.

**Tech Stack:** Swift 6.2, macOS 14.4+, Security.framework, Foundation XPC,
ServiceManagement, TypeScript 6, Node.js 22.22+, npm workspaces, Swift Testing,
Vitest 4.

## Global Constraints

- No desktop UI and no heavy sub-agent architecture.
- No API key, token, authorization header, credential reference, Keychain
  persistent reference, XPC endpoint, or native bearer capability may enter
  TypeScript, argv, environment, ordinary stdin, logs, events, JSONL, errors,
  checkpoints, or tool descendants.
- The native helper must never expose a `getSecret` operation.
- Persistent credentials require production signing attestation. Source,
  unsigned, and ad-hoc builds fail closed with no plaintext fallback.
- Data Protection Keychain operations require a nonempty broker-private access
  group and use `WhenUnlockedThisDeviceOnly`, non-synchronizing generic-password
  items.
- The Node-facing protocol is bounded, versioned, duplicate-free binary TLV;
  it carries no arbitrary RPC, credential bytes, URLs, headers, descriptors, or
  native authorization handles.
- The broker XPC peer requirement matches exact launcher identifier, Team ID,
  and production signing class; same-team-only checks are forbidden.
- Model-selected child processes receive no launcher descriptor or native
  authority environment marker.
- Providers remain `requires_native_broker` throughout this plan.
- Follow RED/GREEN/REFACTOR and commit every independently reviewable task.

---

### Task 1: Add dependency-leaf native authority contracts

**Files:**
- Create: `packages/contracts/src/native-authority.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/test/contracts.test.ts`

**Interfaces:**
- Produces `NATIVE_AUTHORITY_PROTOCOL_VERSION`,
  `NativeAuthorityUnavailableReason`, `NativeAuthorityAttestation`,
  `NativeAuthorityHealth`, `NativeAuthorityStatus`, and
  `NativeAuthorityStatusPort`.
- Contains no Node, Swift, storage, transport, or credential type.

- [ ] **Step 1: Write failing authority contract tests**

Add immutable-shape tests that expect exact safe status variants:

```ts
import {
  NATIVE_AUTHORITY_PROTOCOL_VERSION,
  type NativeAuthorityStatus,
} from "../src/index.js";

it("describes native authority readiness without credential references", () => {
  const status: NativeAuthorityStatus = {
    state: "ready",
    attestation: {
      protocolVersion: NATIVE_AUTHORITY_PROTOCOL_VERSION,
      launcherVersion: "0.1.0",
      brokerVersion: "0.1.0",
      platform: "darwin",
      minimumMacosVersion: "14.4",
      productionSigned: true,
      persistentCredentials: true,
    },
    health: {
      keychain: "available",
      broker: "available",
      peerIdentity: "verified",
    },
  };
  expect(JSON.stringify(status)).not.toMatch(
    /credentialRef|authorization|token|secret|keychainItem/iu,
  );
});
```

Add one test for every unavailable reason and assert the safe message is an
enum-owned string rather than arbitrary native text.

- [ ] **Step 2: Run the contract test and verify RED**

Run:

```bash
npx vitest run packages/contracts/test/contracts.test.ts
```

Expected: FAIL because `native-authority.ts` is absent.

- [ ] **Step 3: Implement the dependency-leaf contracts**

Use these exact public shapes:

```ts
export const NATIVE_AUTHORITY_PROTOCOL_VERSION = 1 as const;

export type NativeAuthorityUnavailableReason =
  | "unsupported_platform"
  | "unsupported_os_version"
  | "launcher_unavailable"
  | "broker_unavailable"
  | "protocol_mismatch"
  | "peer_identity_unverified"
  | "production_signing_required"
  | "keychain_unavailable";

export interface NativeAuthorityAttestation {
  readonly protocolVersion: typeof NATIVE_AUTHORITY_PROTOCOL_VERSION;
  readonly launcherVersion: string;
  readonly brokerVersion: string;
  readonly platform: "darwin";
  readonly minimumMacosVersion: "14.4";
  readonly productionSigned: boolean;
  readonly persistentCredentials: boolean;
}

export interface NativeAuthorityHealth {
  readonly keychain: "available" | "locked" | "unavailable";
  readonly broker: "available";
  readonly peerIdentity: "verified";
}

export type NativeAuthorityStatus =
  | {
      readonly state: "ready";
      readonly attestation: NativeAuthorityAttestation;
      readonly health: NativeAuthorityHealth;
    }
  | {
      readonly state: "unavailable";
      readonly reason: NativeAuthorityUnavailableReason;
    };

export interface NativeAuthorityStatusPort {
  status(signal?: AbortSignal): Promise<NativeAuthorityStatus>;
}
```

Export the module from `packages/contracts/src/index.ts`.

- [ ] **Step 4: Run contract tests, typecheck, and lint**

Run:

```bash
npx vitest run packages/contracts/test/contracts.test.ts
npm run typecheck
npm run lint
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts
git commit -m "feat: define native authority contracts"
```

---

### Task 2: Add `@recurs/auth` with a strict bounded frame codec

**Files:**
- Create: `packages/auth/package.json`
- Create: `packages/auth/tsconfig.json`
- Create: `packages/auth/src/frame.ts`
- Create: `packages/auth/src/fields.ts`
- Create: `packages/auth/src/messages.ts`
- Create: `packages/auth/src/index.ts`
- Create: `packages/auth/test/frame.test.ts`
- Create: `tests/fixtures/native-authority/frames.json`
- Modify: `tsconfig.json`

**Interfaces:**
- Consumes safe semantic contracts from `@recurs/contracts`.
- Produces `NativeFrameDecoder`, `encodeNativeFrame`, `decodeFieldTable`,
  `encodeFieldTable`, `encodeHello`, `decodeHelloResult`, `encodeHealth`, and
  `decodeHealthResult`.
- Does not open a path, Keychain, XPC service, endpoint, or secret.

- [ ] **Step 1: Write failing frame and TLV tests**

The golden fixture contains hex for hello, hello-result, health,
health-result, and safe-failure frames. Tests must cover every split point:

```ts
for (let split = 0; split <= bytes.length; split += 1) {
  const decoder = new NativeFrameDecoder();
  expect([
    ...decoder.push(bytes.subarray(0, split)),
    ...decoder.push(bytes.subarray(split)),
  ]).toEqual([expected]);
}
```

Add failures for wrong magic/version, zero request ID, body over 64 KiB,
duplicate/out-of-order TLV tags, more than 64 fields, invalid UTF-8, unknown
message type, trailing bytes, and post-terminal response.

- [ ] **Step 2: Run the auth tests and verify RED**

Run:

```bash
npx vitest run packages/auth/test/frame.test.ts
```

Expected: FAIL because the workspace/package does not exist.

- [ ] **Step 3: Add workspace metadata and exact protocol constants**

`packages/auth/package.json` must be private ESM package `@recurs/auth`, depend
only on `@recurs/contracts`, and export `dist/index.js`. Add it after contracts
in the root project references.

Define this exact 16-byte big-endian frame header:

```ts
export const NATIVE_FRAME_MAGIC = 0x52435552; // RCUR
export const NATIVE_FRAME_HEADER_BYTES = 16;
export const NATIVE_FRAME_MAX_PAYLOAD_BYTES = 64 * 1024;

export enum NativeMessageType {
  hello = 1,
  helloResult = 2,
  health = 3,
  healthResult = 4,
  cancel = 5,
  safeFailure = 255,
}
```

Header fields are magic `u32`, protocol `u16`, type `u16`, payload length
`u32`, and nonzero request ID `u32`.

- [ ] **Step 4: Implement strict frame and field-table parsing**

The field table begins with `fieldCount u16`; each strictly ascending field is
`tag u16`, `length u32`, then bytes. Reject unknown/duplicate tags at each
message decoder. Provide exact helpers for bounded fatal UTF-8, `u16`, `u32`,
`u64`, booleans encoded as one byte, and 32-byte nonces.

`NativeFrameDecoder.push()` retains at most one incomplete bounded frame and
returns zero or more complete immutable frames. `finish()` fails on truncated
bytes.

- [ ] **Step 5: Implement hello/health semantic codecs**

Use exact TLV schemas:

```text
hello:        1 engineVersion, 2 nonce(32)
helloResult:  1 launcherVersion, 2 brokerVersion, 3 echoedNonce(32),
              4 productionSigned(bool), 5 persistentCredentials(bool),
              6 minimumMacosVersion
health:       no fields
healthResult: 1 keychain(enum u16), 2 peerVerified(bool)
safeFailure:  1 safeFailureCode(enum u16)
cancel:       1 targetRequestId(u32)
```

Map only fixed safe failure codes to `NativeAuthorityUnavailableReason`; never
decode native prose.

- [ ] **Step 6: Run tests and the repository TypeScript gate**

Run:

```bash
npx vitest run packages/auth/test/frame.test.ts
npm run typecheck
npm run lint
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/auth tests/fixtures/native-authority tsconfig.json
git commit -m "feat: add native authority wire codec"
```

---

### Task 3: Implement the same protocol in Swift with golden fixtures

**Files:**
- Create: `native/macos/Package.swift`
- Create: `native/macos/Sources/RecursNativeProtocol/Frame.swift`
- Create: `native/macos/Sources/RecursNativeProtocol/FieldTable.swift`
- Create: `native/macos/Sources/RecursNativeProtocol/Messages.swift`
- Create: `native/macos/Tests/RecursNativeProtocolTests/FrameTests.swift`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces Swift `NativeFrame`, `NativeFrameDecoder`, `FieldTable`,
  `HelloMessage`, `HelloResultMessage`, `HealthResultMessage`, and
  `SafeFailureCode` matching Task 2 byte-for-byte.

- [ ] **Step 1: Write failing Swift golden-fixture tests**

Load `tests/fixtures/native-authority/frames.json` relative to the package
root. Decode each fixture, re-encode it, and assert byte equality. Repeat each
frame at every split point. Add malformed cases matching every TypeScript
failure category.

- [ ] **Step 2: Run Swift tests and verify RED**

Run:

```bash
swift test --package-path native/macos
```

Expected: FAIL because `Package.swift` and targets are absent.

- [ ] **Step 3: Add the Swift package and frame parser**

Use tools version 6.2, platform `.macOS(.v14)`, and a library target
`RecursNativeProtocol`. Use explicit bounds before `Data` allocation, manual
big-endian integer reads, `String(decoding:as:)` only after validating with
`String(data:encoding:.utf8)`, and immutable `Sendable` value types.

Add `native/macos/Tests/Fixtures/frames.json` as a byte-identical checked-in
test resource; do not make SwiftPM follow a workspace symlink. Add a Node test
that asserts the Swift fixture and
`tests/fixtures/native-authority/frames.json` remain byte-identical.

- [ ] **Step 4: Implement strict TLV and message schemas**

Mirror the exact field schemas and error categories in Task 2. Unknown tags,
wrong lengths, wrong enum values, wrong ordering, or trailing data throw
`NativeProtocolError` with a fixed case and no raw payload.

- [ ] **Step 5: Add native scripts and macOS CI**

Add:

```json
"native:build": "swift build --package-path native/macos",
"native:test": "swift test --package-path native/macos",
"check:native": "npm run native:test && npm run native:build"
```

Keep the existing Ubuntu TypeScript job. Add a `macos-15` job that checks out,
runs `npm ci`, and runs `npm run check:native`. Pin current major action
versions consistently with the existing workflow.

- [ ] **Step 6: Run both protocol suites and native build**

Run:

```bash
npx vitest run packages/auth/test/frame.test.ts
npm run check:native
```

Expected: PASS with byte-identical fixtures.

- [ ] **Step 7: Commit**

```bash
git add native/macos package.json .github/workflows/ci.yml packages/auth/test
git commit -m "feat: add native authority protocol core"
```

---

### Task 4: Add fenced broker credential lifecycle with a fake store

**Files:**
- Create: `native/macos/Sources/RecursBrokerCore/SecretBytes.swift`
- Create: `native/macos/Sources/RecursBrokerCore/CredentialStore.swift`
- Create: `native/macos/Sources/RecursBrokerCore/BrokerCredentialState.swift`
- Create: `native/macos/Tests/RecursBrokerCoreTests/BrokerCredentialStateTests.swift`
- Modify: `native/macos/Package.swift`

**Interfaces:**
- Produces `SecretBytes`, `CredentialStore`, `InMemoryCredentialStore`,
  `CredentialGeneration`, `StagingAttempt`, `CredentialProjection`, and actor
  `BrokerCredentialState`.
- Public projections contain only UUIDs, timestamps, generations, state, and
  fences; never credential data or store references.

- [ ] **Step 1: Write failing lifecycle and race tests**

Tests must prove:

- stage stores one generation but returns no secret;
- commit accepts only the current attempt/fence;
- abort deletes staging data;
- reconnect stages a higher generation and leaves the ready generation usable
  until commit;
- disconnect increments the fence before deletion and prevents late commit;
- concurrent first commits produce one winner;
- broker restart invalidates all volatile attempt authority; and
- every `String(reflecting:)`, encoded projection, and error omits a canary.

- [ ] **Step 2: Run broker-core tests and verify RED**

Run:

```bash
swift test --package-path native/macos --filter BrokerCredentialStateTests
```

Expected: FAIL because the broker core target is absent.

- [ ] **Step 3: Implement secret and storage abstractions**

`SecretBytes` owns one mutable `Data`, exposes only
`withUnsafeBytes<R>(_ body: (UnsafeRawBufferPointer) throws -> R)`, clears its
buffer on explicit `erase()` and `deinit`, is non-`Sendable`, and has a constant
redacted description. `CredentialStore` accepts `SecretBytes` only on store and
returns `SecretBytes` only to the broker transport layer; no TypeScript-facing
type can reference it.

- [ ] **Step 4: Implement the actor and exact state machine**

Use states `staging`, `ready`, and `tombstoned`. Every mutation accepts an
expected fence and returns fixed `BrokerStateError` cases. Store the secret
generation before exposing staging; commit only metadata; disconnect writes
the higher tombstone fence before deleting store generations.

- [ ] **Step 5: Run native tests and secret-pattern scan**

Run:

```bash
npm run check:native
rg -n "SecretBytes|credential" native/macos/Sources/RecursBrokerCore
```

Inspect every match and confirm secret-bearing types stay internal.

- [ ] **Step 6: Commit**

```bash
git add native/macos
git commit -m "feat: add fenced native credential state"
```

---

### Task 5: Add a descriptor-relative durable broker journal

**Files:**
- Create: `native/macos/Sources/RecursBrokerCore/SecureDirectory.swift`
- Create: `native/macos/Sources/RecursBrokerCore/DarwinFileSystemBackend.swift`
- Create: `native/macos/Sources/RecursBrokerCore/BrokerJournal.swift`
- Create: `native/macos/Sources/RecursBrokerCore/BrokerJournalModel.swift`
- Create: `native/macos/Sources/RecursBrokerCore/BrokerJournalCodec.swift`
- Create: `native/macos/Sources/RecursBrokerCore/BrokerJournalRecovery.swift`
- Modify: `native/macos/Sources/RecursBrokerCore/BrokerCredentialState.swift`
- Create: `native/macos/Tests/RecursBrokerCoreTests/SecureDirectoryTests.swift`
- Create: `native/macos/Tests/RecursBrokerCoreTests/BrokerJournalTests.swift`
- Create: `native/macos/Tests/RecursBrokerCoreTests/BrokerJournalCodecTests.swift`
- Create: `native/macos/Tests/RecursBrokerCoreTests/BrokerJournalRecoveryTests.swift`
- Create: `native/macos/Tests/RecursBrokerCoreTests/ScriptedDarwinFileSystemBackend.swift`
- Create: `policy/non-secret-policy.v1.json`
- Create: `scripts/generate-non-secret-policy.mjs`
- Create: `packages/app/src/generated/non-secret-policy.ts`
- Create: `native/macos/Sources/RecursBrokerCore/GeneratedNonSecretPolicy.swift`
- Create: `tests/fixtures/non-secret-policy-cases.json`
- Create: `native/macos/Tests/RecursBrokerCoreTests/Fixtures/non-secret-policy-cases.json`
- Modify: `packages/app/src/connection-registry-model.ts`
- Modify: `packages/app/test/connection-registry.test.ts`
- Modify: `native/macos/Package.swift`
- Modify: `package.json`

**Interfaces:**
- Produces `SecureDirectory`, `BrokerJournalStore`, `FileBrokerJournalStore`,
  `BrokerJournalRecord`, and `BrokerJournalPhase`.
- Journal records contain only the safe lifecycle identities, counters,
  timestamps, cleanup targets, and bounded fixed terminal results frozen in
  the broker journal contract; envelope tags are not credential-derived.
- Produces one generated cross-language non-secret policy and one
  byte-identical behavioral fixture. The
  broker journal contract is normative for the two-slot, exact-anchor schema
  and supersedes the original three-phase sketch.

- [ ] **Step 1: Write failing secure-directory tests**

In a private temporary root, assert the implementation rejects a symlink root,
symlink parent, wrong owner, group/world-writable parent, nonlocal or
unsupported filesystem capability, symlink target, hard-linked target,
nonregular target, wrong mode, and path traversal. Race a symlink replacement
between validation and write and prove the directory descriptor keeps the write
inside the opened directory.

- [ ] **Step 2: Write failing journal crash/recovery tests**

Cover every exact broker-journal phase:

```text
vacant
storePending -> staging
storePending|staging -> stageCleanupPending -> vacant|ready
staging -> readyCleanupPending -> ready
staging -> abortCleanupPending -> vacant|ready
vacant|ready|staging -> disconnectFenced -> tombstoned
```

Crash fixtures after every inactive-slot write, rename, directory sync, anchor
CAS, credential-store side effect, and cleanup step must recover
deterministically. Only the exact externally anchored parity slot supplies
authority; abandoned valid successors stay inert. Exercise the closed
predecessor matrix, stale actor/lifetime-lease exclusion, reconnect cleanup,
store/staging crash cleanup, disconnect fencing, and exact retry memo.
Encode/decode rejects unknown fields, duplicate JSON keys, invalid
UUID/timestamp/fence/phase, and credential-like fields or values.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
swift test --package-path native/macos --filter SecureDirectoryTests
swift test --package-path native/macos --filter BrokerJournalTests
```

Expected: FAIL because secure storage/journal files are absent.

- [ ] **Step 4: Implement descriptor-relative storage**

Implement the descriptor-relative ancestor, APFS, ACL, ownership, mode, link,
device, entry-count, and lifetime authority-lease contract in the broker
journal specification. Writes full-sync a verified temp, rename it to the
inactive parity slot, sync the directory, reverify it, and only then CAS the
external anchor. Reads open only the exact anchor-selected slot. No path is
reopened after the final directory descriptor is retained.

- [ ] **Step 5: Implement strict non-secret journal records**

Use the two-slot, exact-anchor deterministic encoding and closed semantic CAS
matrix in the broker journal contract. Add a duplicate-aware exact-key decoder.
Before writing or after reading, recursively reject forbidden key names and
credential-like values using definitions generated from the shared declarative
production policy; run the byte-identical behavioral cases in both languages
and refactor the TypeScript registry matcher to consume the generated policy.
Add `generate:non-secret-policy` and drift-check it from the root `check` gate.
Recovery integrates safe bootstrap and resumable cleanup with
`BrokerCredentialState`; it never returns Keychain data. Task 5 uses only a
deterministic test authenticator and keeps production recovery disabled.

- [ ] **Step 6: Run native tests and commit**

```bash
npm run check
npm run check:native
git add native/macos policy scripts/generate-non-secret-policy.mjs tests/fixtures/non-secret-policy-cases.json packages/app package.json
git commit -m "feat: add durable broker journal"
```

---

### Task 6: Add Data Protection Keychain storage behind the broker

**Files:**
- Create: `native/macos/Sources/RecursNativeSecurity/KeychainClient.swift`
- Create: `native/macos/Sources/RecursNativeSecurity/DataProtectionCredentialStore.swift`
- Create: `native/macos/Sources/RecursNativeSecurity/KeychainJournalAuthenticator.swift`
- Create: `native/macos/Sources/RecursNativeSecurity/SecureData.swift`
- Create: `native/macos/Tests/RecursNativeSecurityTests/KeychainStoreTests.swift`
- Create: `native/macos/Tests/RecursNativeSecurityTests/KeychainJournalAuthenticatorTests.swift`
- Modify: `native/macos/Package.swift`

**Interfaces:**
- Consumes `CredentialStore` from Task 4.
- Consumes the journal authenticator/anchor protocol from Task 5.
- Produces `DataProtectionCredentialStore`, `KeychainStoreConfiguration`, and
  the production HMAC-SHA256 journal authenticator with bounded anchor
  enumeration and exact anchor CAS.
- Links Security.framework; no command-line `security` invocation.

- [x] **Step 1: Write failing query and status-mapping tests**

Inject a closure-based `KeychainClient` and capture queries without storing a
real key. Assert every add/read/update/delete query includes:

```swift
kSecClass: kSecClassGenericPassword
kSecUseDataProtectionKeychain: true
kSecAttrSynchronizable: false
kSecAttrAccessible: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
kSecAttrService: "com.recurs.cli.credentials.v1"
kSecAttrAccessGroup: configuration.accessGroup
```

The credential account injectively encodes the lowercase connection UUID,
lowercase generation UUID, and decimal generation ordinal, so an old usable
generation and a staged replacement cannot collide. Journal keys and anchors
use separate fixed broker-private services. Reject an empty/whitespace access
group before calling Security. Map locked,
interaction-not-allowed, duplicate, missing, and unexpected `OSStatus` values
to fixed errors with no Security message text.

Add query tests for a random 256-bit broker-private journal HMAC key and one
anchor item per connection. Assert anchor list/read/CAS is bounded, exact,
connection-bound, retains tombstone anchors, and maps outcome-unknown writes by
re-reading fixed data rather than guessing. Test the exact domain-separated
input and two-slot rule from the broker journal contract. No test touches the
user's real Keychain.

- [x] **Step 2: Run the security tests and verify RED**

Run:

```bash
swift test --package-path native/macos --filter KeychainStoreTests
swift test --package-path native/macos --filter KeychainJournalAuthenticatorTests
```

Expected: FAIL because the target is absent.

- [x] **Step 3: Implement the Security.framework client**

`KeychainClient.live` wraps `SecItemAdd`, `SecItemCopyMatching`,
`SecItemUpdate`, and `SecItemDelete`. It immediately copies complete typed
results into module-private values; credential bytes move into `SecretBytes`,
and transient credential/HMAC buffers are cleared after use. It never requests
a persistent reference or calls `SecCopyErrorMessageString` on a boundary that
can reach Node.

`KeychainJournalAuthenticator` owns an HMAC key that is never exported by a
Recurs API, computes tags without converting key bytes to `String`, and stores
typed anchors in the same broker-private Data Protection Keychain boundary. It
exposes no key, persistent reference, raw Keychain account, or arbitrary query
result. Its actor and the broker-lifetime journal lease serialize exact
read/compare/update anchor CAS. A missing HMAC key with existing anchors is
rollback evidence, not a reason to silently create a replacement key.

- [x] **Step 4: Implement fail-closed production configuration**

`KeychainStoreConfiguration.production(bundle:)` reads the signed bundle's
application identifier prefix and `RecursCredentialAccessGroup`, validates
both against strict identifier patterns, and constructs the exact access group.
Missing bundle metadata returns `productionSigningRequired`; it never omits the
access-group attribute.

- [x] **Step 5: Run native tests and build**

Run:

```bash
npm run check:native
```

Expected: PASS without touching the user's real Keychain.

- [x] **Step 6: Commit**

```bash
git add native/macos
git commit -m "feat: add broker-only keychain storage"
```

---

### Task 7: Add endpoint policy, delivery state, and streaming secret filter

**Files:**
- Create: `native/macos/Sources/RecursBrokerCore/EndpointPolicy.swift`
- Create: `native/macos/Sources/RecursBrokerCore/DeliveryState.swift`
- Create: `native/macos/Sources/RecursBrokerCore/CredentialUseReservation.swift`
- Create: `native/macos/Sources/RecursBrokerCore/StreamingSecretFilter.swift`
- Modify: `native/macos/Sources/RecursBrokerCore/BrokerCredentialState.swift`
- Create: `native/macos/Tests/RecursBrokerCoreTests/EndpointPolicyTests.swift`
- Create: `native/macos/Tests/RecursBrokerCoreTests/CredentialUseReservationTests.swift`
- Create: `native/macos/Tests/RecursBrokerCoreTests/StreamingSecretFilterTests.swift`

**Interfaces:**
- Produces immutable `EndpointProfile`, `AllowedRoute`, `DeliveryState`, and
  `StreamingSecretFilter` for later provider transport work.
- Produces a broker-only fenced credential-use reservation that spans
  pre-load journal validation, credential load, post-load validation,
  cancellation, and the `notSent -> requestStarted` boundary.
- Does not perform a network request in this task.

- [ ] **Step 1: Write failing endpoint-policy tests**

Accept exact built-ins for `api.openai.com`, `api.anthropic.com`, and
`api.kimi.com` plus a separately marked custom public-HTTPS profile. Reject
HTTP, credentials, query, fragment, nondefault ambiguous port forms, empty or
dot-segment base paths, CR/LF, Unicode-control host/path, loopback, private,
link-local, metadata, multicast, reserved, unspecified, IPv4-mapped IPv6, and
numeric-address ambiguity. Routes are relative IDs mapped by the profile;
callers cannot submit a URL or auth/Host/Cookie header.

- [ ] **Step 2: Write failing secret-filter tests**

For every split of `RECURS_NATIVE_SECRET_CANARY_79A2` and
`Bearer RECURS_NATIVE_SECRET_CANARY_79A2`, feed chunks through the
filter and assert no output contains a full or partial reconstructable secret.
Test overlapping patterns, secret-at-EOF, empty secret rejection, bounded
lookbehind, exact completion, cancellation, and a nonmatching stream preserved
byte-for-byte.

Add reservation tests with fake journal/store barriers. Disconnect or
generation change before load, during load, or after load but before
`requestStarted` must erase loaded bytes and produce no send transition. Exact
unchanged anchor/generation may advance once. Cancellation before send erases;
cancellation after send is advisory. No reservation/token is Codable,
XPC-facing, or exposed to TypeScript.

- [ ] **Step 3: Run broker-core tests and verify RED**

Run:

```bash
swift test --package-path native/macos --filter RecursBrokerCoreTests
```

Expected: FAIL because the policy/filter types are absent.

- [ ] **Step 4: Implement pure endpoint and delivery policy**

Use `URLComponents` only as an initial parse; reconstruct and compare the exact
canonical URL, then apply explicit host/address classification. `DeliveryState`
permits `notSent -> requestStarted -> responseStarted -> terminal`; no reverse
or duplicate transition. Only `notSent` is retry-safe.

Place credential-use reservation and revocation state inside the existing
`BrokerCredentialState` actor. One native operation must atomically bind the
exact journal snapshot/fence/generation, reserve the connection, load through
`CredentialStore`, revalidate after the await, and hold the reservation through
the final `notSent -> requestStarted` decision. Disconnect/tombstone revocation
is serialized in that same actor and erases any loaded bytes before send.
Release/cancellation is idempotent and leaves no Codable/XPC/TypeScript token.

- [ ] **Step 5: Implement rolling exact-secret filtering**

Use a streaming multiple-pattern matcher with lookbehind of
`maxPatternLength - 1`. Buffer possible prefixes until they are proven safe.
On a complete match, terminate with fixed `credentialEchoDetected` and emit no
buffered prefix. Erase pattern and lookbehind storage on terminal/cancel.

- [ ] **Step 6: Run native tests and commit**

```bash
npm run check:native
git add native/macos
git commit -m "feat: enforce native endpoint and secret policy"
```

---

### Task 8: Add exact-peer XPC broker and signed headless launcher skeletons

**Files:**
- Create: `native/macos/Sources/RecursNativeSecurity/PeerRequirement.swift`
- Create: `native/macos/Sources/RecursBrokerService/BrokerXPCProtocol.swift`
- Create: `native/macos/Sources/RecursBrokerService/BrokerService.swift`
- Create: `native/macos/Sources/RecursBrokerService/main.swift`
- Create: `native/macos/Sources/RecursLauncher/BrokerConnection.swift`
- Create: `native/macos/Sources/RecursLauncher/ServiceRegistration.swift`
- Create: `native/macos/Sources/RecursLauncher/main.swift`
- Create: `native/macos/Resources/com.recurs.cli.broker.plist`
- Create: `native/macos/Resources/RecursLauncher-Info.plist`
- Create: `native/macos/Resources/RecursBroker-Info.plist`
- Create: `native/macos/Resources/RecursBroker.entitlements`
- Create: `native/macos/Resources/RecursLauncher.entitlements`
- Create: `native/macos/Tests/RecursNativeSecurityTests/PeerRequirementTests.swift`
- Create: `native/macos/Tests/RecursBrokerServiceTests/BrokerServiceTests.swift`
- Modify: `native/macos/Package.swift`

**Interfaces:**
- Produces headless executables `recurs-native-launcher` and
  `recurs-native-broker`.
- XPC exposes only framed handshake/health exchange in this plan.
- Source builds report production signing unavailable and cannot store a key.

- [ ] **Step 1: Write failing peer-requirement and service tests**

Assert a valid requirement contains all of:

```text
anchor apple generic
identifier "com.recurs.cli.launcher"
certificate 1[field.1.2.840.113635.100.6.2.6]
certificate leaf[field.1.2.840.113635.100.6.1.13]
certificate leaf[subject.OU] = "ABCDE12345"
```

Reject missing/invalid Team ID, alternate identifier, ad-hoc marker, and same
team without identifier/Developer-ID signing-class clauses. Service tests reject sensitive
work before a successful nonce-echoing handshake and return only fixed failure
codes.

- [ ] **Step 2: Run the focused Swift tests and verify RED**

Run:

```bash
swift test --package-path native/macos --filter PeerRequirementTests
swift test --package-path native/macos --filter BrokerServiceTests
```

Expected: FAIL because service/security files are absent.

- [ ] **Step 3: Implement bundle-owned peer requirements**

Read `RecursTeamIdentifier`, `RecursLauncherIdentifier`, and
`RecursBrokerIdentifier` from signed bundle metadata, validate fixed ASCII
identifier patterns, and build exact immutable requirements. Source SwiftPM
executables without those signed resources return
`productionSigningRequired`.

- [ ] **Step 4: Implement the XPC handshake-only service**

Use an `@objc` protocol with one `exchange(_ frame: Data,
reply: @escaping (Data) -> Void)` method. Set the exact code-signing requirement
before resuming each connection. Accept only hello and health messages in this
plan; all setup/run/maintenance message types return `unsupportedOperation`.
Never include thrown error descriptions in replies.

- [ ] **Step 5: Implement LaunchAgent registration and launcher health mode**

Use `SMAppService.agent(plistName: "com.recurs.cli.broker.plist")` and fail
closed outside the signed bundle. The launcher's `native-health --machine`
prints one stable, non-secret JSON status for release diagnostics. It does not
accept a key, endpoint, arbitrary XPC name, or requirement override.

- [ ] **Step 6: Run native tests/build and inspect resource schemas**

Run:

```bash
npm run check:native
plutil -lint native/macos/Resources/*.plist
```

Expected: all tests/build and plist validation pass. Running the source
launcher health mode reports production signing required.

- [ ] **Step 7: Commit**

```bash
git add native/macos
git commit -m "feat: add signed native broker skeleton"
```

---

### Task 9: Add the TypeScript launcher client and descriptor-denial tests

**Files:**
- Create: `packages/auth/src/client.ts`
- Create: `packages/auth/src/socket.ts`
- Create: `packages/auth/src/fake.ts`
- Create: `packages/auth/test/client.test.ts`
- Create: `packages/auth/test/fixtures/fake-native-peer.mjs`
- Modify: `packages/auth/src/index.ts`
- Modify: `packages/tools/src/process-environment.ts`
- Modify: `packages/tools/src/process.ts`
- Modify: `packages/tools/test/command.test.ts`

**Interfaces:**
- Produces `NativeAuthorityClient`, `createNativeAuthorityClientFromInheritedFd`,
  and `FakeNativeAuthorityStatusPort`.
- The client supports only handshake, health, cancellation, and close in this
  plan; there is no credential or generic exchange method.

- [ ] **Step 1: Write failing client protocol tests**

Use an injected bounded duplex fixture. Prove nonce echo, exact protocol and
version matching, one request ID per in-flight operation, cancellation,
out-of-order response correlation, duplicate/unknown/post-terminal rejection,
peer close, timeout, and fixed unavailable mapping. Assert all errors and
serialized status omit injected frame/payload canaries.

- [ ] **Step 2: Write failing child-boundary tests**

Set fake `RECURS_NATIVE_FD`, `RECURS_BROKER_*`, Keychain, token, and proxy
variables in the parent fixture. Execute a tool child and assert every value is
absent. Give the parent an extra readable descriptor and assert the child
cannot read it. Verify tool subprocess stdio contains only descriptors 0–2.

- [ ] **Step 3: Run auth/tools tests and verify RED**

Run:

```bash
npx vitest run packages/auth/test/client.test.ts packages/tools/test/command.test.ts
```

Expected: FAIL because client/descriptor enforcement is absent.

- [ ] **Step 4: Implement the bounded client**

The production factory accepts only a decimal inherited descriptor from
`RECURS_NATIVE_FD`, deletes the environment entry before returning, validates
the descriptor with `fstat`, wraps it in one owned `net.Socket`, and closes on
handshake failure. The public client has `status(signal?)` and `close()` only.
All unexpected transport faults map to fixed unavailable reasons.

- [ ] **Step 5: Harden child spawning**

Explicitly remove all `RECURS_*` native/broker variables from isolated child
environments even though the allowlist is already narrow. Keep `stdio` exactly
`["pipe", "pipe", "pipe"]`; never add an inherited descriptor. Add a central
assertion so future process-runner variants cannot widen the descriptor list
without updating the security test.

- [ ] **Step 6: Run focused and package tests**

Run:

```bash
npx vitest run packages/auth/test packages/tools/test
npm run typecheck
npm run lint
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/auth packages/tools
git commit -m "feat: connect engine to native authority safely"
```

---

### Task 10: Expose redacted native diagnostics and finish the foundation gate

**Files:**
- Modify: `packages/app/package.json`
- Create: `packages/app/src/native-authority.ts`
- Create: `packages/app/test/native-authority.test.ts`
- Modify: `packages/app/src/index.ts`
- Modify: `packages/cli/src/main.ts`
- Modify: `packages/cli/test/run-mode.test.ts`
- Modify: `packages/providers/src/manifest-validator.ts`
- Modify: `packages/providers/test/manifests.test.ts`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `PRODUCT.md`
- Modify: `SECURITY.md`
- Modify: `docs/CLI.md`
- Modify: `docs/README.md`
- Modify: `docs/superpowers/specs/2026-07-10-recurs-provider-auth-design.md`

**Interfaces:**
- `@recurs/app` depends on `@recurs/auth` and produces a redacted
  `NativeAuthorityService`.
- CLI adds `recurs doctor native [--json]`.
- Broker-owned manifests remain non-runnable; the validator gains an explicit
  attestation-gated future activation state rather than a permissive flag.

- [ ] **Step 1: Write failing app/CLI diagnostics tests**

Inject ready and every unavailable status. Text and JSON must contain only
protocol/launcher/broker versions, safe health enums, and fixed reasons. Assert
they omit canary endpoint, account, native path, Team ID, signing requirement,
bundle path, descriptor, and secret values. Invalid flags exit `2`; cancellation
exits `130`; diagnostics never start an agent runtime.

- [ ] **Step 2: Write failing manifest-gate tests**

Prove a broker-owned path still cannot become runnable from a manifest boolean
alone. Define a typed activation requirement that needs native attestation,
registered codec/profile, current policy, and compatible platform. This plan
provides only native attestation, so OpenAI/Anthropic/Kimi remain
`requires_native_broker`.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
npx vitest run packages/app/test/native-authority.test.ts packages/cli/test/run-mode.test.ts packages/providers/test/manifests.test.ts
```

Expected: FAIL because diagnostics/activation requirements are absent.

- [ ] **Step 4: Implement the redacted service and CLI command**

`NativeAuthorityService.status()` delegates to `NativeAuthorityStatusPort`,
deep-freezes a structural clone, and catches unknown errors as
`broker_unavailable`. The CLI parser accepts exactly `doctor native` and
`doctor native --json` and prints versioned JSON `{version:1,nativeAuthority}`.

- [ ] **Step 5: Implement the non-permissive manifest activation requirement**

Keep all current runnable behavior unchanged. Replace the validator's blanket
broker-owned runnable error with a schema that still rejects direct activation
unless every required runtime attestation input exists. Do not supply codec,
onboarding, or provider-transport attestation in this plan, so no catalog entry
changes status yet.

- [ ] **Step 6: Update reviewed/public documentation**

Document the headless signed companion, source-build fail-closed behavior,
native health command, Data Protection Keychain boundary, exact XPC identity,
system proxy trust, current non-sandbox disclosure, and the fact that direct
providers are still disabled pending later verticals. Add the Provider
Activation v1 design and this plan to `docs/README.md`.

- [ ] **Step 7: Run the complete verification matrix**

Run:

```bash
rm -rf packages/*/dist native/macos/.build
npm run check
npm run check:native
RECURS_HOME="$(mktemp -d)" node packages/cli/dist/main.js doctor native --json
git diff --check main...HEAD
```

Expected: TypeScript lint/typecheck/all tests/build and Swift tests/build pass;
the source CLI reports `production_signing_required` without paths or secrets.

- [ ] **Step 8: Scan the full branch for sensitive material and unsafe drift**

Run a no-output sensitive-pattern scan across `main...HEAD`; inspect every
native occurrence of `SecretBytes`, `kSecValueData`, XPC service name,
`RECURS_NATIVE_FD`, `Authorization`, `x-api-key`, `credential`, and `token`.
Confirm providers remain disabled and no key collection exists in Node.

- [ ] **Step 9: Commit the completed native foundation**

```bash
git add README.md ARCHITECTURE.md PRODUCT.md SECURITY.md docs packages .github native package.json package-lock.json tsconfig.json
git commit -m "docs: complete native authority foundation"
```

Do not merge to `main` yet. Continue on this feature branch with the separately
planned direct-provider contract/onboarding and protocol activation verticals.
