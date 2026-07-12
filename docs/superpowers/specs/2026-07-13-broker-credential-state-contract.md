# Broker Credential State Contract

Date: 2026-07-13

## Status and scope

This document freezes the Task 4 credential-state contract for the native
provider authority. It is implementation-ready and normative for Task 4.

This contract resolves and supersedes the ambiguous Task 4 wording that listed
`InMemoryCredentialStore` as a production source type. The in-memory store is
test support only. This clarification does not otherwise change the Native
Provider Authority Foundation plan or the Provider Activation v1 design.

Task 4 owns the volatile, fenced credential authority state machine and its
secret/store abstractions. It does not add durable journal behavior, a
production credential-store adapter, Keychain, XPC, provider requests, desktop
UI, or product/subagent code.

## Authority and visibility

There is one `BrokerCredentialState` actor for all connections. It owns a
per-connection record, at most one active mutation reservation per connection,
and a bounded terminal-operation memo. A single actor prevents separate actor
instances from authorizing the same connection while allowing different
connections to progress independently across store awaits.

Every declaration in this contract is `package`, never `public`. These values
may cross native package targets, but must not appear in Node-facing or XPC
protocol projections.

The package-visible value shapes are:

```swift
struct CredentialGeneration: Sendable, Hashable, Codable {
    let generationID: UUID
    let ordinal: UInt64
    let createdAt: Date
}

struct ReadyGeneration: Sendable, Hashable, Codable {
    let generation: CredentialGeneration
    let committedAt: Date
}

struct StagingAttempt: Sendable, Hashable, Codable {
    let connectionID: UUID
    let attemptID: UUID
    let fence: UInt64
    let candidate: CredentialGeneration
    let previousReady: ReadyGeneration?
    let startedAt: Date
}

struct ReadyProjection: Sendable, Hashable, Codable {
    let connectionID: UUID
    let fence: UInt64
    let ready: ReadyGeneration
    let lastGenerationOrdinal: UInt64
}

struct TombstoneProjection: Sendable, Hashable, Codable {
    let connectionID: UUID
    let fence: UInt64
    let lastGenerationOrdinal: UInt64
    let tombstonedAt: Date
}

enum CredentialProjection: Sendable, Hashable, Codable {
    case staging(StagingAttempt)
    case ready(ReadyProjection)
    case tombstoned(TombstoneProjection)
}
```

The actor also has an internal
`vacant(connectionID, fence, lastGenerationOrdinal)` state. It is required
before first staging and after aborting first setup, but has no projection:
`projection(for:)` returns `nil`.

`CredentialProjection.usableReady` may be a computed package property. For a
ready projection it returns that ready generation; for staging it returns
`previousReady`; for a tombstone it returns `nil`. It never loads secret bytes.

The actor API is:

```swift
func projection(for connectionID: UUID) -> CredentialProjection?

func stage(
    connectionID: UUID,
    operationID: UUID,
    expectedFence: UInt64,
    secret: sending SecretBytes
) async throws -> StagingAttempt

func commit(
    connectionID: UUID,
    attemptID: UUID,
    operationID: UUID,
    expectedFence: UInt64
) async throws -> ReadyProjection

func abort(
    connectionID: UUID,
    attemptID: UUID,
    operationID: UUID,
    expectedFence: UInt64
) async throws -> ReadyProjection?

func disconnect(
    connectionID: UUID,
    operationID: UUID,
    expectedFence: UInt64
) async throws -> TombstoneProjection
```

## Secret and store ownership

`SecretBytes` is a final, non-`Sendable` class. It owns mutable `Data` and has:

- only a consuming `Data` initializer;
- synchronous, nonescaping `withUnsafeBytes` access;
- idempotent `erase` and erasure again in `deinit`; and
- constant, redacted `description` and `debugDescription` values.

It exposes no `Codable`, equality, hashing, byte count, or byte accessor. No
diagnostic path may derive text or another inspectable value from its bytes.

`CredentialStore` is a package-internal `Actor` protocol:

```swift
func store(_ secret: sending SecretBytes, for key: CredentialStoreKey)
    async throws(CredentialStoreError)
func load(for key: CredentialStoreKey)
    async throws(CredentialStoreError) -> sending SecretBytes
func deleteIfPresent(_ key: CredentialStoreKey)
    async throws(CredentialStoreError)
```

`CredentialStoreKey` contains the connection UUID, generation UUID, and
generation ordinal. UUIDs provide identity; the ordinal provides ordering.

`CredentialStoreError` has exactly two cases, with no associated values or
prose:

- `.unavailable`: the mutation definitely did not occur;
- `.mutationOutcomeUnknown`: the mutation may have occurred.

`BrokerCredentialState` transfers a secret to the store exactly once through
the consuming store call. Neither actor projections nor store inspection may
expose the secret or a store reference.

## Identity, counters, and overflow

- A missing/new connection starts with fence `0` and last ordinal `0`.
- Generation and attempt UUIDs are identity only and are never ordered.
- The generation ordinal is the only generation ordering. It advances exactly
  once when staging is reserved, before the first store await. An ordinal is
  never reused after failure, abort, or cancellation.
- The fence advances once when a staging epoch is reserved and once when a
  tombstone is published. Commit and abort retain the staging fence.
- Timestamps never participate in ordering or compare-and-swap decisions.
- Stage requires `fence <= UInt64.max - 2`, preserving one final fence value
  for disconnect. Otherwise it throws `.fenceOverflow` without mutation.
- Disconnect may accept fence `UInt64.max - 1` and publish the terminal
  tombstone at `UInt64.max`.
- Stage at last ordinal `UInt64.max` throws `.generationOverflow`.
- Fence overflow is checked before generation overflow. Either overflow makes
  no UUID, clock, or store call and erases the supplied secret.
- A non-tombstone bootstrap at fence `UInt64.max` is invalid.

## State transitions

Notation: `V(f,o)` is vacant, `R(r,f,o)` ready, `S(c,p?,a,f,o)` staging, and
`T(f,o)` tombstoned.

| Input | Linearization and result |
| --- | --- |
| `V(f,o)` or `R(r,f,o)` + stage | Validate cancellation and CAS. Before awaiting the store, reserve `f+1,o+1` plus candidate and attempt UUIDs. The candidate remains hidden. Store success publishes `S(candidate,r?,attempt,f+1,o+1)`. |
| Reconnect store pending | The previous ready generation remains the only usable generation, now under the advanced fence. The candidate is never usable before staging publication. |
| `S(c,p,a,f,o)` + commit with exact `a/f` | Atomically publish `R(c,f,o)` without advancing the fence. The candidate is authoritative from that point. Then idempotently delete `p`, if present. Never roll back the commit. |
| `S(c,p,a,f,o)` + abort with exact `a/f` | Atomically restore `R(p,f,o)` or `V(f,o)`; the fence and ordinal remain consumed. Make the candidate unusable before its idempotent deletion. |
| `V`, `R`, or `S` + disconnect at the exact fence | Check fence headroom, then atomically publish `T(f+1,o)` before awaiting deletion. Delete the candidate and then the prior/ready generation in descending ordinal order. |
| `T` + any mutation | Fail without resurrection or another fence increment. |
| Commit or abort without the exact current attempt and fence | A fence mismatch returns `.staleFence`; otherwise return `.attemptNotCurrent`. |

Only metadata is linearized. A stage candidate is not visible until its store
operation succeeds; a disconnect tombstone revokes authority before deletion.

### Store and cleanup outcomes

If store fails with `.unavailable`, no deletion is attempted. Restore the
previous visible state at the already-consumed fence and ordinal, and return
`.storeUnavailable`.

If store succeeds and cancellation is then observed, or store returns
`.mutationOutcomeUnknown`, hide the candidate and call `deleteIfPresent` for
it. If cleanup succeeds, return the original `.cancelled` or
`.storeUnavailable`. If cleanup fails, retain a cleanup reservation and return
`.cleanupPending`.

A commit, abort, or disconnect cleanup failure never changes its
already-linearized authority state. Only the same operation may resume that
cleanup. An outcome-unknown `deleteIfPresent` is the only side effect that may
be repeated; the delete itself is idempotent.

## Reentrancy, cancellation, and retry

Before every store await, reserve one active mutation for that connection.
Awaiting one connection does not block another connection.

While an operation is actively awaiting, every concurrent call for that
connection returns `.operationInProgress`; Task 4 provides no waiter fan-out.
A rejected duplicate stage call erases its supplied secret.

While cleanup is paused, only the exact same operation ID and fingerprint may
resume it. Every other operation returns `.cleanupPending`.

Cancellation and linearization follow this order:

1. Check the terminal memo before cancellation so a completed commit or
   disconnect continues to replay as completed.
2. Check cancellation before reserving. This consumes no counter and is not
   memoized.
3. For stage, check cancellation again after reservation and immediately after
   store returns. Before any possible store side effect, erase the secret and
   restore the previous visible state at the consumed fence and ordinal before
   finishing cancelled. After a possible side effect, clean the candidate
   first.
4. Commit, abort, and disconnect have no suspension between their final
   cancellation check and authority linearization. After linearization,
   cancellation is advisory: never roll back; finish cleanup or retain
   `.cleanupPending`.

Every post-await continuation revalidates the connection, operation ID,
attempt ID, fence, candidate key, and reservation phase before publishing any
state.

### Terminal operation memo

Retain the latest 64 terminal accepted operations per connection in FIFO
order. A fingerprint comprises operation kind, connection ID, expected fence,
and attempt ID where applicable.

- An exact retained terminal retry replays the same value or error without
  calling the clock, UUID source, store, or delete.
- Reusing a retained operation ID with different arguments returns
  `.operationIDConflict`.
- Validation failures before reservation are not memoized.
- After FIFO eviction, state/fence validation still prevents side effects, but
  exact response replay is no longer promised.

## Fixed broker errors

`BrokerStateError` contains exactly these cases, with no associated values:

```swift
.cancelled
.connectionNotFound
.connectionTombstoned
.staleFence
.fenceOverflow
.generationOverflow
.invalidTransition
.attemptNotCurrent
.operationIDConflict
.operationInProgress
.storeUnavailable
.cleanupPending
.invalidBootstrap
```

Its description, debug description, and localized description all come from
one exhaustive fixed switch. They never retain or interpolate an underlying
error.

## Restart and bootstrap

Provide a package-only bootstrap enum containing exactly:

- `vacant(connectionID, fence, lastGenerationOrdinal)`;
- `ready(ReadyProjection)`; and
- `tombstoned(TombstoneProjection)`.

There is deliberately no staging bootstrap. Each actor initialization creates
a new volatile incarnation with empty reservation state and an empty terminal
operation memo. An attempt created before restart therefore returns
`.attemptNotCurrent` and cannot commit.

Task 4 neither reads nor writes durable metadata and makes no durability
claim. Before Task 5, production composition accepts only fresh bootstrap.
Recovered bootstrap values are an injection seam only for tests and the future
validated journal loader.

Restart during staging may leave a candidate orphaned in the Task 4 fake
store. Restart still invalidates its authority; durable discovery and cleanup
of that candidate are Task 5 responsibilities.

## Test-only store and deterministic support

`InMemoryCredentialStore` exists only in the test target or a dedicated
test-support target used by tests; it is not compiled as a production source
type. Its inspection API exposes only keys, existence, retained count, and
per-operation call counts. It never returns `Data`, text derived from bytes,
hashes, prefixes, or retained `SecretBytes`.

The fake store provides deterministic barriers and failures at:

- store before side effect;
- store after side effect;
- delete before side effect; and
- delete after side effect.

An after-side-effect store failure retains the secret and throws
`.mutationOutcomeUnknown`. An after-side-effect delete failure removes and
erases the secret, then throws `.mutationOutcomeUnknown`. `deleteIfPresent` is
idempotent. Clock and generation/attempt UUID sources are injected separately.

Canary tests cover every projection encoding, `String(describing:)`,
`String(reflecting:)`, localized error, memoized result, fake-store inspection
result, cancellation path, and before/after-side-effect failure path.

## Explicit Task 5 deferrals

Task 4 adds no journal stub or filesystem call. Task 5 must integrate durable
metadata with this state machine by adding:

- durable phase CAS at the existing reservation and linearization points;
- a write-ahead `storePending` phase before calling the credential store, so a
  crash after storage but before `secretStored` cannot orphan a generation;
- records containing the candidate, optional previous-ready generation, fence,
  and last ordinal;
- committed reconnect recovery that restores the candidate as ready and
  idempotently deletes the recorded previous ready generation;
- disconnect-fenced recovery that completes all deletions before tombstoning;
- canonical encoding, descriptor-relative storage, locking, sync semantics,
  corruption handling, and recovery; and
- any cross-restart operation-result replay.

Task 4 promises authority safety across restart, not exact idempotent response
replay across restart.
