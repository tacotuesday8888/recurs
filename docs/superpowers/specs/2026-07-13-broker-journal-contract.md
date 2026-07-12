# Broker Journal Contract

Date: 2026-07-13

## Status and scope

This document freezes the implementation contract for Task 5 of the Native
Provider Authority Foundation plan. It supersedes the older
`prepared -> secretStored -> committed` sketch in that plan.

Task 5 adds crash-consistent, descriptor-relative, non-secret broker metadata,
test-only authenticated recovery, and the journal integration seams in
`BrokerCredentialState`. It does not add a production authenticator, Keychain,
XPC, provider requests, TypeScript credential state, desktop work, or product
sub-agent behavior.

Production recovered authority remains disabled until Task 6 supplies the
broker-private Keychain authenticator and rollback anchor defined here. File
ownership, permissions, canonical encoding, and locking are not treated as
same-UID authenticity.

All declarations are `package`, not `public`.

## Topology and bounds

Use two deterministic journal slots per connection in a dedicated broker
journal directory. Slot basenames are exactly
`<lowercase-canonical-uuid>.0.rcbj` and
`<lowercase-canonical-uuid>.1.rcbj`; revision parity selects the suffix.
Callers never supply a path or filename. An
external anchor selects exactly one slot by revision and tag. The other slot is
an untrusted previous/orphan candidate and never supplies authority. Stable
tombstones and their anchors remain. Task 5 performs no compaction or tombstone
deletion.

The directory contains at most:

- 1,024 anchored connections and at most two slot files per connection;
- one constant `.broker-journal-v1.lock` file; and
- 128 recognized unanchored slot files; and
- 32 recognized temporary files left by interrupted writes.

Total recognized directory entries are capped at 2,209. Each envelope is at
most 65,536 bytes. Directory enumeration fails closed on an unexpected entry,
excessive entry count, ambiguous UUID name, or an unverified leftover
temporary file. Recovery never follows a link and never performs a destructive
action against an authority record that has not passed path, encoding,
invariant, authentication, and rollback validation.

## Journal envelope and authority chain

Every journal file is a canonical envelope with exactly these ordered fields:

```text
{
  "previousAuthTag": <64 lowercase hex characters>,
  "authTag": <64 lowercase hex characters>,
  "record": <canonical BrokerJournalRecord object>
}
```

An authentication tag is 32 bytes. The first record uses 32 zero bytes as its
`previousAuthTag`. The `authTag` is domain-separated authentication over the
raw previous tag followed by the exact canonical record bytes. It is journal
integrity metadata, never a credential-derived digest.

Task 6 computes HMAC-SHA256 over the exact byte concatenation
`UTF8("recurs.broker-journal.v1") || 0x00 || previousTag[32] || canonicalRecord`.
Task 5's deterministic fake preserves this field ordering even though it does
not claim cryptographic strength.

`JournalAuthenticationTag` is an immutable `Sendable`, `Hashable` value with
private copied 32-byte storage and fixed lowercase-hex codec. It accepts no
other length or alphabet. `BrokerJournalAnchor` is an immutable `Sendable`,
`Hashable` value with connection ID, nonzero revision, and one tag.

Each connection has an external `BrokerJournalAnchor` containing exactly its
connection ID, selected journal revision, and authentication tag. The revision
parity selects the canonical slot. The anchor is outside the
same-UID-writable directory. Task 5 defines the injected actor protocol and a
deterministic test fake; Task 6 implements it with a broker-private Keychain key
and anchor items.

```swift
protocol BrokerJournalAuthenticator: Actor {
  func authenticate(
    previousTag: JournalAuthenticationTag,
    canonicalRecord: Data
  ) async throws(BrokerJournalError) -> JournalAuthenticationTag

  func verify(
    previousTag: JournalAuthenticationTag,
    canonicalRecord: Data,
    tag: JournalAuthenticationTag
  ) async throws(BrokerJournalError)

  func anchor(for connectionID: UUID)
    async throws(BrokerJournalError) -> BrokerJournalAnchor?

  func listAnchors()
    async throws(BrokerJournalError) -> [BrokerJournalAnchor]

  func compareAndSwapAnchor(
    expected: BrokerJournalAnchor?,
    replacement: BrokerJournalAnchor
  ) async throws(BrokerJournalError)
}
```

The protocol never exports the authentication key. Its errors are fixed and
payload-free. The deterministic fake belongs in the test target only.

`listAnchors()` is bounded to 1,024 entries, sorted by canonical connection
UUID, rejects duplicates, and is the authoritative recovery index. Recovery
accepts only the slot selected by an anchor and only when filename connection
ID, parity, record revision, record connection ID, and envelope tag exactly
match that anchor. There is no ahead-by-one or missing-anchor acceptance.

An unanchored first-revision file, an inactive-slot successor, an older
revision, a gap, a same-revision tag mismatch, a selected file missing behind
an anchor, or anchor overflow supplies no authority. A valid MAC without the
exact selected external anchor is never sufficient. Verified unselected slots
may be overwritten by a later CAS; they are never promoted during recovery.

## Record model

Every canonical record contains these ordered common fields:

```text
schemaVersion = 1
revision: UInt64
connectionID: UUID
phase: BrokerJournalPhase
fence: UInt64
lastGenerationOrdinal: UInt64
changedAt: canonical millisecond UTC timestamp
payload: exact phase payload
terminalOperations: [TerminalOperation]
```

`revision` is a journal CAS counter, separate from the lifecycle fence. It
starts at `1`, increments exactly once per durable transition, and never wraps.
`terminalOperations` is FIFO and contains at most the latest 64 retained
failed-stage results and successful commit, abort, and disconnect results.
There is no successful stage replay across restart because restart invalidates
staging attempt authority.

Each terminal operation contains only its operation ID, operation kind,
expected fence, optional attempt ID, and one exact safe result. The canonical
object key order and allowed result are:

| Kind | Ordered keys | Exact result |
| --- | --- | --- |
| `stageFailure` | `operationID`, `kind`, `expectedFence`, `result` | `{ "error": "cancelled" }`, `{ "error": "storeUnavailable" }`, or recovery-only `{ "error": "attemptNotCurrent" }` |
| `commit` | `operationID`, `kind`, `expectedFence`, `attemptID`, `result` | `{ "ready": <ReadyProjection> }` |
| `abort` | `operationID`, `kind`, `expectedFence`, `attemptID`, `result` | `{ "restoredReady": <ReadyProjection or null> }` |
| `disconnect` | `operationID`, `kind`, `expectedFence`, `result` | `{ "tombstone": <TombstoneProjection> }` |

No validation failure, successful stage, `cleanupPending`, arbitrary error
code, or diagnostic prose is persisted. Operation IDs are unique within the
FIFO. Every nested result connection ID must match the record; result fences
must be compatible with and no greater than the current record fence.

Use phase-specific Swift value types so an inapplicable field cannot be
constructed. `BrokerJournalPhase` contains exactly:

```text
vacant
storePending
staging
readyCleanupPending
ready
stageCleanupPending
abortCleanupPending
disconnectFenced
tombstoned
```

The exact phase payloads are:

- `vacant`: empty.
- `storePending`: `attemptID`, `operationID`, the stage `expectedFence`,
  `candidate`, optional `previousReady`, and `startedAt`.
- `staging`: the same fields as `storePending`.
- `readyCleanupPending`: commit `attemptID`, `operationID`, `expectedFence`,
  authoritative candidate `ready`, and required `previousReady`.
- `ready`: authoritative `ready`.
- `stageCleanupPending`: failed-stage `attemptID`, `operationID`, the original
  stage `expectedFence`, `candidate`, optional authoritative `restoredReady`,
  and the fixed terminal stage error to replay after cleanup.
- `abortCleanupPending`: explicit-abort `attemptID`, `operationID`, abort
  `expectedFence`, `candidate`, and optional authoritative `restoredReady`.
- `disconnectFenced`: `operationID`, `expectedFence`, `tombstonedAt`, and
  `deleteGenerations`.
- `tombstoned`: `tombstonedAt`.

The canonical payload object keys and value types are therefore exactly:

| Phase | Ordered payload keys and types |
| --- | --- |
| `vacant` | no keys (`{}`) |
| `storePending` | `attemptID: UUID`, `operationID: UUID`, `expectedFence: UInt64`, `candidate: CredentialGeneration`, `previousReady: ReadyGeneration | null`, `startedAt: timestamp` |
| `staging` | `attemptID: UUID`, `operationID: UUID`, `expectedFence: UInt64`, `candidate: CredentialGeneration`, `previousReady: ReadyGeneration | null`, `startedAt: timestamp` |
| `readyCleanupPending` | `attemptID: UUID`, `operationID: UUID`, `expectedFence: UInt64`, `ready: ReadyGeneration`, `previousReady: ReadyGeneration` |
| `ready` | `ready: ReadyGeneration` |
| `stageCleanupPending` | `attemptID: UUID`, `operationID: UUID`, `expectedFence: UInt64`, `candidate: CredentialGeneration`, `restoredReady: ReadyGeneration | null`, `error: "cancelled" | "storeUnavailable" | "attemptNotCurrent"` |
| `abortCleanupPending` | `attemptID: UUID`, `operationID: UUID`, `expectedFence: UInt64`, `candidate: CredentialGeneration`, `restoredReady: ReadyGeneration | null` |
| `disconnectFenced` | `operationID: UUID`, `expectedFence: UInt64`, `tombstonedAt: timestamp`, `deleteGenerations: [CredentialGeneration]` |
| `tombstoned` | `tombstonedAt: timestamp` |

Phase payloads use `ReadyGeneration`, not `ReadyProjection`; record common
fields supply connection ID, fence, and last ordinal. Terminal result objects
use the full projection types shown in the terminal-operation table.

A credential generation contains only generation UUID, monotonic ordinal, and
creation time. A ready generation additionally contains commit time.
`deleteGenerations` contains at most two unique generations, sorted by
descending ordinal.

### Record invariants

The decoder and initializer enforce all of these before exposing a record:

- every nested connection ID matches the record connection ID;
- non-tombstone phases have `fence == lastGenerationOrdinal` and fence below
  `UInt64.max`;
- disconnect/tombstone phases satisfy checked
  `fence == lastGenerationOrdinal + 1`;
- a stage candidate ordinal equals `lastGenerationOrdinal` and is nonzero;
- a previous/restored ready ordinal is nonzero, no greater than the last
  ordinal, and strictly below its reconnect candidate ordinal;
- a ready ordinal is nonzero and no greater than the last ordinal;
- the `storePending`, `staging`, and `stageCleanupPending` expected fence is
  exactly one below the record fence;
- commit and explicit-abort payload expected fence equals the record fence;
- a disconnect payload expected fence is exactly one below its tombstone
  fence;
- generation IDs and delete targets are unique;
- all timestamps are finite and encode exactly at millisecond precision; and
- terminal memo fingerprints and results are valid for their operation kind.

Within the terminal FIFO, operation IDs are unique. A commit/abort attempt ID
may occur in only one terminal entry. The same historical generation may
legitimately recur in multiple terminal result projections, but a generation
UUID must always map to the exact same ordinal and creation timestamp and may
never be substituted. A stage-failure entry satisfies
checked `expectedFence + 1 <= record.fence`. Commit and abort result fences
equal their expected fence. A disconnect result satisfies checked
`tombstone.fence == expectedFence + 1` and, because no operation follows a
disconnect, equals the current tombstone record. All result connection IDs are
the record connection ID.

Unknown enum values, impossible phase payloads, arithmetic overflow, or a
failed invariant produce a fixed invalid-record error and no recovery action.

## Store API and CAS

`BrokerJournalStore` is an `Actor` protocol. Before constructing the live file
store, `SecureDirectory` opens and verifies the constant lock inode, acquires
an exclusive nonblocking `flock`, and returns a noncopyable
`BrokerAuthorityLease`. `FileBrokerJournalStore` consumes and retains that lease
for its entire lifetime together with one `SecureDirectory` and one
authenticator. A second legitimate broker instance fails startup with
`.lockUnavailable` before anchor enumeration. Reads return an immutable record
snapshot plus its revision and authentication tag; no path, file descriptor,
store reference, lease, or authentication capability is returned.

On a fresh directory, lock bootstrap first tries
`openat(O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600)`. The newly
created inode is set to exact `0600` and verified. On `EEXIST`, reopen with
`openat(O_RDWR | O_NOFOLLOW | O_CLOEXEC)` and never chmod an existing inode.
In both cases require a zero-length regular file, current UID, exact `0600`,
link count one, same device, and no extended ACL before
`flock(LOCK_EX | LOCK_NB)`. Every error closes the descriptor; success transfers
the locked descriptor into the lifetime lease.

The exact store surface is:

```swift
struct BrokerJournalSnapshot: Sendable, Hashable {
  let record: BrokerJournalRecord
  let authenticationTag: JournalAuthenticationTag
}

protocol BrokerJournalStore: Actor {
  func list()
    async throws(BrokerJournalError) -> [BrokerJournalSnapshot]

  func load(connectionID: UUID)
    async throws(BrokerJournalError) -> BrokerJournalSnapshot?

  func compareAndSwap(
    expected: BrokerJournalSnapshot?,
    replacement: BrokerJournalRecord
  ) async throws(BrokerJournalError) -> BrokerJournalSnapshot
}
```

`list()` begins with the bounded authenticated anchor list, opens each exact
revision-parity slot, and returns snapshots in canonical connection-UUID order
only after every selected envelope has validated. An empty anchor list returns
an empty array even if ignored orphan slots exist. `load` returns `nil` only
when the anchor is absent; an anchor with a missing selected slot is
`.rollbackDetected`. `compareAndSwap(expected: nil, ...)` means create and
requires an absent anchor plus replacement revision 1; it never means overwrite
without reading.

Journal CAS compares the complete expected snapshot identity: requested
connection ID, selected filename UUID/parity, anchor connection ID/revision/tag,
record connection ID/revision/phase/fence, attempt/generation identity, and
authentication tag. Every nested projection and every credential-store key
must carry that same connection ID before authentication, CAS, bootstrap, or
deletion. A replacement must use exactly `revision + 1`; anchor CAS preserves
the connection ID and advances by that exact revision. Creation requires an
absent anchor and revision 1. Comparing only phase and fence is forbidden.

Because Swift actors are reentrant at authenticator awaits, the file store uses
an explicit nonreentrant per-instance operation gate for each transaction. The
already-held lifetime lease remains locked across read, anchor validation,
semantic CAS validation, inactive-slot write, rename, directory sync,
selected-file verification, and anchor CAS. The lease coordinates legitimate
broker instances; it is not claimed to stop a malicious same-UID process that
replaces a filesystem name or ignores advisory locking.

For an outcome-unknown write or anchor update, reload the anchor and its exact
selected slot:

- an anchor selecting the exact intended revision/tag means success after the
  selected slot is reverified or repaired from the still-owned canonical bytes;
- the exact previous anchor and selected record means not applied; the inactive
  successor is ignored and may be overwritten by a safe retry;
- any other state is a fixed conflict/outcome-unknown failure.

File revision `anchor + 1` is never promoted by inspection. Never infer
success, restore guessed old bytes, or move an anchor backward.

### Closed semantic transition matrix

Structural record validity is not authorization to write it. CAS accepts only
the following predecessor/successor pairs; every other pair is `.casConflict`
before authentication or filesystem mutation:

| Predecessor | Successor | Required carried change |
| --- | --- | --- |
| absent | `storePending` | revision/fence/ordinal are `1`; stage expected fence is `0`; no previous ready; empty terminal FIFO |
| `vacant` or `ready` | `storePending` | fence and ordinal each increase by one; stage expected fence equals predecessor fence; previous ready equals the predecessor ready exactly or is nil for vacant; terminal FIFO unchanged |
| `storePending` | `staging` | attempt, operation, candidate, previous ready, counters, and FIFO are byte-for-byte identical apart from phase/revision/change time |
| `storePending` | `vacant` or `ready` | only after definite store `.unavailable`; consumed counters retained; exact previous authority restored; append exact `storeUnavailable` stage terminal result |
| `storePending` or `staging` | `stageCleanupPending` | exact stage/connection/candidate identities and counters retained; restored ready equals exact previous ready; fixed result is `cancelled`, `storeUnavailable`, or recovery-only `attemptNotCurrent`; FIFO unchanged |
| `stageCleanupPending` | `vacant` or `ready` | exact restored authority/counters retained; append the recorded stage-failure terminal result |
| `staging` | `readyCleanupPending` | commit attempt matches staging; candidate becomes the exact authoritative ready; previous ready is carried exactly; counters retained; FIFO unchanged |
| `staging` without previous ready | `ready` | commit attempt matches; candidate becomes ready; counters retained; append exact commit terminal result |
| `readyCleanupPending` | `ready` | authoritative candidate/counters retained; append exact commit terminal result |
| `staging` | `abortCleanupPending` | abort attempt matches; candidate and previous/restored authority carried exactly; counters retained; FIFO unchanged |
| `abortCleanupPending` | `vacant` or `ready` | exact restored authority/counters retained; append exact abort terminal result |
| `vacant`, `ready`, or `staging` | `disconnectFenced` | fence increases by one, ordinal is unchanged, expected fence equals predecessor fence, and delete list is exactly all candidate/previous/ready generations reachable from the predecessor, unique and descending; FIFO unchanged |
| `disconnectFenced` | `tombstoned` | tombstone identity/counters/time retained; append exact disconnect terminal result |

Each accepted successor increments only journal revision by one. UUIDs carried
from the predecessor cannot be substituted. A newly created candidate UUID
must differ from every carried generation UUID. A transition that appends a
terminal result preserves the previous FIFO and appends exactly that result,
dropping exactly the oldest entry only when the count would become 65. A
transition marked FIFO-unchanged must preserve it byte-for-byte. Tombstoned and
cleanup-pending records have no other successors.

### State actor composition

Task 5 adds this package-only async factory while retaining Task 4's volatile
initializer for its focused tests:

```swift
static func recovering(
  store: any CredentialStore,
  journal: any BrokerJournalStore,
  clock: @escaping @Sendable () -> Date = { Date() },
  generationIDSource: @escaping @Sendable () -> UUID = { UUID() },
  attemptIDSource: @escaping @Sendable () -> UUID = { UUID() }
) async throws(BrokerJournalError) -> BrokerCredentialState

func authoritativeProjection(for connectionID: UUID)
  async throws(BrokerJournalError) -> CredentialProjection?
```

The factory loads and validates every snapshot before any deletion. It derives
one safe `CredentialBootstrap` and, where needed, one internal recovered
cleanup reservation per connection. Invalid bootstrap data maps to
`.invalidRecord`. It creates the actor with journal-backed mutation enabled,
installs all safe authority states before cleanup, attempts each cleanup once,
and returns the actor even when an idempotent cleanup remains paused. The
recorded original operation/fingerprint is the only call allowed to resume a
paused cleanup; other mutations receive `.cleanupPending` after terminal memo
handling.

An empty validated journal yields a fresh journal-backed actor. Any unsafe
directory, corrupt record, authentication failure, or rollback failure fails
the factory before it returns an actor, so v1 disables all recovered direct
provider authority rather than partially trusting a directory. Credential
deletion failure alone does not fail the factory because safe authority has
already been installed and the cleanup reservation remains recoverable.

The authority lease is acquired before `list()` and remains owned by the
journal-backed state actor/store until shutdown, so no second legitimate actor
can mutate after enumeration and then leave this actor authorizing a stale
projection. Task 4's synchronous `projection(for:)` remains diagnostic only in
journal-backed mode. Task 5 adds an async authoritative-read path that reloads
the exact selected anchor/snapshot and compares it to the actor's expected
record before returning a usable-ready generation. A mismatch fails closed and
marks the connection unavailable; it never returns the older generation.

This async result is still a metadata preflight, not a credential-use or
request authorization: after it returns, another task could disconnect before
a later credential-store load. Task 6 therefore does not treat it as permission
to load. Task 7 must add one native fenced-use reservation spanning pre-load
anchor validation, credential load, post-load anchor/cancellation revalidation,
request construction, and the final `notSent -> requestStarted` transition.
Any intervening tombstone or generation mismatch erases loaded bytes and sends
nothing. Task 8's single LaunchAgent and exact-peer boundary are still required;
advisory locking alone is not represented as protection from a malicious
same-UID process.

## Credential-state integration ordering

The journal becomes the durable authority linearization point. The state actor
reserves an active in-memory operation before each journal await and revalidates
operation ID, phase, fence, attempt, candidate, and expected snapshot after
every journal or credential-store suspension.

### Stage

1. Propose the next fence, ordinal, attempt, and candidate under the active
   reservation.
2. Durably CAS the previous stable record to `storePending`.
3. Only after that CAS succeeds are the fence and ordinal consumed and visible;
   only then call `CredentialStore.store`.
4. On definite store success, durably CAS to `staging`.
5. Only after the staging CAS may the actor publish a staging attempt.

A definite pre-CAS journal failure erases the untransferred secret and accepts
no stage reservation; its unobservable proposed UUIDs may be discarded. An
outcome-unknown CAS is reconciled before deciding whether ownership may move to
the credential store.

Cancellation after `storePending` but before the store call erases the still
owned secret, CASes to `stageCleanupPending(cancelled)`, deletes the candidate
idempotently, and persists stable state before returning `.cancelled`.

Store `.unavailable` durably returns to `ready` or `vacant` at the consumed
fence/ordinal and appends the fixed stage result. If that final journal CAS
cannot complete, retain the reservation and return `.cleanupPending`; do not
invent a staging result.

Store `.mutationOutcomeUnknown`, or cancellation after a possible store side
effect, durably enters `stageCleanupPending`, performs idempotent candidate
deletion, then CASes to `ready` or `vacant`.

After definite credential-store success, any failure or outcome-unknown result
from `storePending -> staging` is reconciled against the selected anchor. If
the staging record is anchored, it may be published only if cancellation has
not intervened; otherwise transition it to `stageCleanupPending`. If
`storePending` remains anchored, transition that exact record to
`stageCleanupPending`. Until one of those cleanup records is durable, retain the
operation and candidate cleanup obligation and return `.cleanupPending`.

For every stage-cleanup path, a delete failure or final stable-journal failure
retains the exact reservation. Only the secret-free `resumeStage` for that
operation/fingerprint continues it. The fixed original stage result is returned
and memoized only after the stable record is anchored.

### Commit and abort

- Commit CASes `staging` to `readyCleanupPending` before publishing the
  candidate as authoritative. If there is no previous generation it CASes
  directly to `ready`. It deletes the previous generation and then CASes the
  cleanup phase to `ready`; commit is never rolled back.
- Abort CASes to `abortCleanupPending` before restoring previous-ready or
  vacant authority in memory. It deletes the candidate and then CASes to the
  stable phase.

### Disconnect

Disconnect CASes to `disconnectFenced` with the higher fence before publishing
tombstone authority or deleting anything. It then deletes the recorded
generations in descending ordinal order and CASes to `tombstoned`. It never
deletes first and fences later.

Cancellation after a durable authority CAS is advisory. A pre-linearization
journal failure maps to Task 4's `.storeUnavailable`; unfinished work after
authority linearization maps to `.cleanupPending`. Task 5 does not add cases to
the exact `BrokerStateError` enum.

## Crash recovery

Recovery validates every selected envelope and anchor before constructing a
bootstrap or touching the credential store. It first converts
`storePending -> stageCleanupPending(storeUnavailable)` and
`staging -> stageCleanupPending(attemptNotCurrent)` with exact journal CAS.
Only after all such conversions succeed does it install the safe authority
states and cleanup reservations in the actor; deletion happens afterward:

| Phase | Recovery action |
| --- | --- |
| `vacant` | Bootstrap vacant. |
| `storePending` | CAS to `stageCleanupPending(storeUnavailable)`; then bootstrap previous-ready or vacant and delete candidate through the installed reservation. |
| `staging` | CAS to `stageCleanupPending(attemptNotCurrent)`; then bootstrap previous-ready or vacant and delete candidate through the installed reservation. |
| `readyCleanupPending` | Bootstrap the candidate as ready first, delete previous-ready idempotently, then CAS to `ready`. |
| `ready` | Bootstrap ready. |
| `stageCleanupPending` | Bootstrap restored-ready or vacant, install exact operation/fingerprint cleanup, delete candidate idempotently, persist stable state, and append the fixed failed-stage result for replay. |
| `abortCleanupPending` | Bootstrap restored-ready or vacant first, delete candidate idempotently, then CAS stable. |
| `disconnectFenced` | Bootstrap higher-fence tombstone authority first, finish all deletes, then CAS `tombstoned`. |
| `tombstoned` | Bootstrap tombstoned. |

A crash after a deletion but before its final CAS simply repeats
`deleteIfPresent`. Previous-ready remains usable while a candidate is being
removed. A committed candidate remains usable while a retired generation is
being removed. `disconnectFenced` never permits usable authority.

Corrupt, noncanonical, unauthenticated, rollbacked, unsafe-path, or unsupported
filesystem state performs no deletion and provides no ready authority. The
connection is disabled through a fixed native health/storage failure.

## Descriptor-relative directory contract

Production starts from an already-open trusted root descriptor. Components are
walked with `openat(O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)` and
verified with `fstat`. Empty, `.`, `..`, slash-containing, NUL-containing, and
overlong components are rejected.

The live broker derives the user subtree from the current UID using the system
account database, never from Node, argv, environment, or ordinary stdin.
System-prefix ancestors must be root-owned directories without group/world
write permission. User-subtree ancestors must be current-UID directories
without group/world write permission. The final dedicated journal directory
must be current-UID, exact mode `0700`, and have no extended ACL. Its descriptor
is retained and it is never reopened by path.

The fixed live subtree is
`Library/Application Support/com.recurs.cli/broker/journal-v1` below the
system-resolved home directory. Only the three private components beginning at
`com.recurs.cli` may be created, one at a time with `mkdirat(..., 0700)` and
immediate descriptor verification; existing private components must already
match exact `0700` and ACL policy. There is no recursive path-based mkdir.

Every filesystem operation is routed through a package-only synchronous
`DarwinFileSystemBackend` protocol. The live implementation is a thin fixed
wrapper over `open/openat`, `mkdirat`, `fstat/fstatfs`, ACL inspection,
`readdir`, `read/write`, `fcntl(F_FULLFSYNC)`, `renameat`, `unlinkat`, `fsync`,
`flock`, and `close`; it maps `errno` immediately to fixed internal outcomes.
Tests inject a scripted backend that deterministically exercises partial reads
and writes, `EINTR`, every before/after-side-effect failure, link/inode/device
races, lock contention, post-rename failure, directory-sync uncertainty, and
close/unlink cleanup. Production source contains no test fault hook.

V1 accepts local APFS only. Require `MNT_LOCAL`, APFS filesystem type, and the
same device for directory, lock, temporary, and journal files.

Reads use `openat(O_RDONLY | O_NOFOLLOW | O_CLOEXEC)`, then require a regular
file, current UID, exact mode `0600`, link count one, same device, no extended
ACL, and bounded size before allocation.

Temporary basenames are exactly `.tmp.<lowercase-canonical-random-uuid>.rcbj`.
They contain no connection ID. Enumeration treats only the lock name, exact
slot-name grammar, and exact temporary-name grammar as recognized; all other
entries other than `.` and `..` fail closed. `.` and `..` are ignored and do
not count toward any bound. An unanchored recognized slot is inert. A leftover temp
may be unlinked only after its opened inode passes the same owner/mode/type/link/
device/ACL checks and is confirmed not to be any selected slot.

A recognized temp is explicitly non-authority and may contain a partial write;
it is not required to pass JSON or authentication checks before safe unlink.
Recognized unanchored slots are also non-authority, remain subject to the
numeric bound above, and may be overwritten only after a fresh anchor check
under the lifetime lease.

Writes perform exactly:

1. verify that the retained lifetime authority lease remains open and exclusive;
2. load and validate the exact currently anchored slot, or prove the anchor is
   absent for first creation, and validate the closed semantic transition;
3. authenticate the replacement against the current tag or initial zero tag;
4. create a random sibling with
   `openat(O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600)`;
5. verify inode type, owner, mode, link count, device, and ACL;
6. loop on partial writes and `EINTR`;
7. call `F_FULLFSYNC` on the temporary file;
8. `renameat` it onto the inactive revision-parity slot within the retained
   directory;
9. `fsync` the retained directory;
10. reopen and byte-verify the intended inactive slot; and
11. compare-and-swap the external anchor from the exact previous anchor to the
    intended revision/tag.

Before rename, only the verified temporary inode may be unlinked. After rename,
never restore a guessed previous file. Before anchor CAS, the old anchor keeps
selecting the untouched old slot; an unanchored inactive-slot write is inert.
After anchor CAS, the new slot was already fully synced. This promises atomic
crash consistency and a full file-data flush on supported APFS. It does not
promise mathematical survival of arbitrary hardware power loss because
directory-sync guarantees remain platform-limited.

## Canonical encoding

Use a duplicate-aware strict decoder, not `JSONSerialization` alone:

- UTF-8 only, no BOM;
- exact fields in fixed order and no insignificant whitespace;
- full-range unsigned decimal integers with no sign or leading zero;
- lowercase canonical UUID strings;
- UTC timestamps exactly `yyyy-MM-dd'T'HH:mm:ss.SSS'Z'`;
- maximum nesting depth 12 and maximum 64 terminal operations;
- rejection of missing, unknown, duplicate, and phase-inapplicable fields; and
- required byte-for-byte canonical re-encoding after decode.

`JournalTimestamp` is the canonical `Sendable`, `Hashable` timestamp value and
owns one `Int64` Unix-millisecond integer. Accepted values are exactly
`-62135596800000...253402300799999` (`0001-01-01T00:00:00.000Z` through
`9999-12-31T23:59:59.999Z`). Journal hashing, equality, CAS, decoding, and
encoding use only that integer.

A raw injected `Date` may be captured once with
`floor(date.timeIntervalSince1970 * 1000)` after finite/range checks. The result
immediately becomes `JournalTimestamp`; it is never recomputed from a derived
`Date`. Canonical timestamp text is parsed directly to the integer and emitted
directly from the integer with strict proleptic-Gregorian integer routines, not
through `DateFormatter`, `Double`, or a `Date -> milliseconds` round trip.
`JournalTimestamp.date` may expose a derived `Date` only for the existing safe
projection types. Journal-backed actor clock events originate as
`JournalTimestamp` and derive projection dates from the same value. Nonfinite,
out-of-range, or noncanonical input is `invalidRecord`.

Canonical nested key order is fixed as follows:

```text
CredentialGeneration: generationID, ordinal, createdAt
ReadyGeneration: generation, committedAt
ReadyProjection: connectionID, fence, ready, lastGenerationOrdinal
TombstoneProjection: connectionID, fence, lastGenerationOrdinal, tombstonedAt
Record: schemaVersion, revision, connectionID, phase, fence,
        lastGenerationOrdinal, changedAt, payload, terminalOperations
```

Phase payload keys appear in the order listed in “Record model.” Optional
`previousReady` and `restoredReady` keys are always present and encode absence
as JSON `null`; they are never omitted. Terminal objects and result objects use
the exact key order in their table. Arrays preserve their normative FIFO or
descending-ordinal order. UUIDs, phase/kind/error strings, and timestamps are
the only JSON strings admitted by the record schema.

Before writing and after reading, apply the shared frozen-repertoire NFKC
forbidden-name and credential-like-value fixtures used by the TypeScript
non-secret registry to the canonical **record**. Key normalization accepts at
most 4,096 Unicode scalars, admits only scalars assigned by Unicode 15.0.0
according to the committed `DerivedAge.txt` ranges, and fails closed before
NFKC when a key contains a surrogate, unassigned scalar, or later-version
scalar. Unicode normalization stability then makes NFKC deterministic across
the TypeScript and Foundation implementations for every admitted scalar. A
record may contain no path, Keychain
service/account/access-group name, persistent reference, endpoint, header,
provider message, credential bytes, credential-derived hash, or diagnostic
prose.

The two envelope authentication-tag fields are parsed outside that generic
record-value scan. They are the only explicit exception to its long-hex rule,
and their exact names, position, lowercase alphabet, and 32-byte decoded length
are enforced directly. No other envelope string or field is accepted.

Task 5 creates one complete declarative production policy source at
`policy/non-secret-policy.v1.json`. It defines the frozen Unicode version,
source URL and SHA-256, sorted merged assigned-scalar ranges, normalized
forbidden-key values, and typed value-rule parameters (private-key marker,
provider-token prefixes and alphabets, JWT segments, authorization schemes,
long hex, and mixed-class high-entropy bounds) without JavaScript- or
ICU-specific regular expressions.
`scripts/generate-non-secret-policy.mjs` deterministically generates
`packages/app/src/generated/non-secret-policy.ts` and
`native/macos/Sources/RecursBrokerCore/GeneratedNonSecretPolicy.swift`; a
`--check` gate fails on drift. Both runtime matchers consume only those
generated definitions.

Behavioral cases live at
`tests/fixtures/non-secret-policy-cases.json`, with a byte-identical SwiftPM
test resource at
`native/macos/Tests/RecursBrokerCoreTests/Fixtures/non-secret-policy-cases.json`.
The broker test target declares that exact resource in `Package.swift`. Cases
cover forbidden raw/confusable keys, every secret-value rule and boundary, and
safe values. A Node test enforces raw byte identity; Swift and TypeScript run
every case. Examples do not define production policy, and the native
implementation must not independently own a second list.

## Fixed errors

`SecureDirectoryError` has exactly these payload-free cases:

```text
invalidComponent
unsafeAncestor
wrongOwner
wrongMode
extendedACL
symlink
notDirectory
notRegularFile
hardLink
deviceMismatch
unsupportedFilesystem
fileTooLarge
ioUnavailable
durabilityUnknown
```

`BrokerJournalError` has exactly these payload-free cases:

```text
invalidRecord
nonCanonical
unsupportedVersion
authenticationFailed
rollbackDetected
revisionOverflow
casConflict
lockUnavailable
storageUnavailable
mutationOutcomeUnknown
```

Descriptions, debug descriptions, and localized descriptions use one
exhaustive fixed switch and never include a path, `errno`, decoder prose, or
underlying error.

### Exact error mapping

`SecureDirectoryError` maps at the file-store boundary as follows:

| Secure-directory error | Journal error |
| --- | --- |
| `fileTooLarge` for a selected journal slot | `invalidRecord` |
| `durabilityUnknown` | `mutationOutcomeUnknown` followed by anchor reconciliation |
| `invalidComponent`, `unsafeAncestor`, `wrongOwner`, `wrongMode`, `extendedACL`, `symlink`, `notDirectory`, `notRegularFile`, `hardLink`, `deviceMismatch`, `unsupportedFilesystem`, `ioUnavailable` | `storageUnavailable` |

Failure to acquire or validate the lifetime lease maps to `lockUnavailable`.
A missing anchor makes `load` return `nil`; it is not an error. A selected slot
missing behind an anchor is `rollbackDetected`. A wrong expected snapshot is
`casConflict`. Codec/version/authentication/revision failures preserve their
matching journal cases.

Journal errors during actor mutation map by authority point:

- Before a replacement anchor is selected, reconciliation showing the exact
  previous anchor means the transition did not occur; erase any untransferred
  stage secret and return `.storeUnavailable`.
- Reconciliation showing the exact intended anchor means the journal
  transition succeeded; continue from the intended authority state even if the
  original call reported outcome unknown.
- After an authority anchor is selected, any unfinished journal or credential
  cleanup returns `.cleanupPending` and retains the exact reservation.
- `mutationOutcomeUnknown` is never mapped without re-reading the anchor and
  exact parity-selected slot. Any state other than exact previous or exact
  intended is fail-closed, retains no old usable authority, and returns
  `.cleanupPending` if an authority transition may have occurred or
  `.storeUnavailable` otherwise.
- `authenticationFailed`, `rollbackDetected`, `invalidRecord`, `nonCanonical`,
  and `unsupportedVersion` additionally mark native journal health unavailable;
  no later credential load or request is authorized from the affected actor.
- `revisionOverflow`, `casConflict`, `lockUnavailable`, and
  `storageUnavailable` return `.storeUnavailable` before authority
  linearization and `.cleanupPending` afterward.

Startup/recovery does not map journal failures to `BrokerStateError`; the async
factory propagates the fixed `BrokerJournalError` and returns no actor.

## Task 6 production gate

Task 6 supplies a random 256-bit HMAC-SHA256 key in the broker-private Data
Protection Keychain access group and one rollback anchor per connection. It
implements domain-separated authentication without exporting the key and
retains anchors for tombstoned connections.

Until that implementation is present and attested, Task 5 has no production
authenticator, source/ad-hoc builds accept no recovered authority, and direct
provider manifests remain `requires_native_broker`.
