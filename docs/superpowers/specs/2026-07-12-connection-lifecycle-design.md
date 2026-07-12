# Recurs Non-Secret Connection Lifecycle Design

**Date:** 2026-07-12
**Status:** Approved implementation slice derived from the reviewed provider/authentication design
**Scope:** The three currently runnable, non-secret connection paths; no native credential broker or sub-agent architecture

## 1. Decision

Finish the connection lifecycle around literal-loopback local models and the
official Codex-with-ChatGPT runtime before adding another provider or beginning
the heavy sub-agent layer.

This slice makes `@recurs/app` the owner of connection inventory and mutation,
keeps provider/runtime verification behind injected trusted ports, and makes
runtime resolution follow an immutable session pin rather than the current
global primary. The CLI receives exact-ID account management commands over
that application service. No credential is collected, imported, exported, or
stored.

The user's instruction to choose and execute the next reasonable milestone is
the approval for this bounded slice. The umbrella provider/onboarding design
already defines the connection lifecycle and command surface this document
narrows.

## 2. Why This Is Next

Three alternatives were considered:

1. **Complete the current connection lifecycle — selected.** This fixes
   primary-selection and session-pin correctness, gives users safe management
   of connections that already work, and creates one application boundary for
   the CLI and future desktop.
2. **Start the native credential broker now — deferred to the next security
   program.** A useful broker must land hardened storage, origin-bound
   transport, process isolation, platform support, and signing policy together.
   A protocol scaffold or TypeScript-branded handle would not make BYOK safe.
3. **Add another delegated subscription — rejected for this slice.** That
   would multiply setup and lifecycle behavior while selection, verification,
   disconnection, and pinned resume remain incomplete.

## 3. Current Gaps

- Local and Codex setup always replace `primaryConnectionId`; the reviewed
  behavior says only the first persistent connection becomes primary.
- When the registry has no primary, standalone assembly silently uses the first
  connection. That can select a billing source the user did not choose.
- The standalone resolver is built around the primary connection. After the
  user changes primary, a historical session cannot reliably continue through
  its immutable connection/model pin.
- Direct-session compaction receives the startup provider rather than resolving
  the active session's exact pin.
- Inventory is read-only. There is no exact-ID primary switch, verification, or
  metadata-only disconnection command.
- Local setup lives in the CLI package even though the application layer is
  meant to be shared with the future desktop.

## 4. Behavioral Contract

### 4.1 Primary selection

- The first persistent record written to an empty registry becomes primary.
- Adding another connection leaves the existing primary unchanged.
- Re-verifying or updating an existing record preserves its primary/secondary
  state.
- If records exist but `primaryConnectionId` is `null`, setup does not choose
  one implicitly. The user must run `recurs account set-primary <id>`.
- Runtime startup never falls back to array order. No explicit primary means a
  sessionless workspace shell.
- Changing primary affects only selection for a future new session. Existing
  sessions retain their exact backend pin.

### 4.2 Local records

Local onboarding moves to `@recurs/app`. A normalized literal-loopback origin
identifies one local connection. Re-running setup for the same origin updates
that record and model; a distinct origin creates a secondary record. Duplicate
records for one normalized origin fail closed instead of choosing by order.

The existing CLI exports remain compatibility wrappers so external imports and
tests do not break abruptly.

### 4.3 Account management

The CLI adds:

```text
recurs account set-primary <exact-id>
recurs account verify <exact-id>
recurs account disconnect <exact-id>
```

`set-primary` is an atomic compare-and-swap mutation. It never changes an
existing session pin and reports the selected provider/model/billing sources.

`verify` is read-only. `@recurs/app` loads the exact immutable record and calls
an injected trusted verifier:

- local verification rechecks the literal-loopback server and exact model;
- Codex verification checks the official adapter/version, structured ChatGPT
  status, saved account fingerprint, exact model, and read-only mode.

Verification neither authenticates, changes billing acknowledgement, nor
silently repairs a connection. Codex reauthentication continues through
`recurs setup codex`, including its billing disclosure.

`disconnect` removes only Recurs connection metadata after a local interactive
confirmation. It never signs out of, revokes, or deletes vendor-owned
authentication. Removing the primary sets `primaryConnectionId` to `null`; it
never promotes another record implicitly. Historical sessions and logs remain,
but a later model turn fails preflight if its pinned connection was removed.

### 4.4 Redaction and exact identifiers

Public results may contain connection ID, Recurs label, provider ID, adapter
ID, model ID, execution mode, primary state, and declared billing sources.
They never contain local endpoint URLs, ChatGPT account labels, account
fingerprints, vendor paths, tokens, or authentication payloads.

All mutation commands require one full exact ID. Prefix matching, display-label
matching, and array-position selection are forbidden. Invalid and unknown IDs
share one safe not-found result.

### 4.5 Session-pin resolution

Standalone assembly constructs a registry-backed resolver rather than one
resolver for the startup primary. For every run it:

1. rereads the registry;
2. finds the exact `pin.connectionId`;
3. reconstructs the connection's canonical pin;
4. compares the complete canonical pin with the session pin;
5. rechecks current policy and billing state;
6. creates the direct provider or delegated runtime only after those checks.

A primary change therefore cannot redirect an old session. A record update
that changes a pinned field makes the old session fail closed. A disconnected
record cannot be used.

The direct compaction command resolves its provider from the active session pin
at call time. Delegated sessions continue to reject compaction.

The sessionless workspace may resume an exact historical session for
inspection. Model work still passes through the registry-backed resolver, so a
missing, changed, or ineligible connection fails before provider/runtime work.

## 5. Application Boundary

`@recurs/app` adds a `ConnectionLifecycleService` backed by
`FileConnectionRegistry`:

```ts
interface ConnectionLifecycleService {
  list(): Promise<readonly ConnectionSummary[]>;
  setPrimary(id: string, options?: { signal?: AbortSignal }): Promise<ConnectionSummary>;
  verify(
    id: string,
    verifier: ConnectionVerifier,
    options?: { signal?: AbortSignal },
  ): Promise<ConnectionVerification>;
  disconnect(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<ConnectionDisconnection>;
}
```

Mutations retry a bounded three compare-and-swap conflicts. Returned objects
are defensive, deeply frozen, and redacted. Registry storage retains the
private non-secret fields required for same-account verification, but the
service never exposes them through summaries.

`ConnectionVerifier` receives an immutable trusted verification request and
returns only `verified`; failures cross the boundary as typed safe errors. The
CLI composition root supplies local-provider and official-Codex implementations.

## 6. Error and Cancellation Semantics

- Malformed or unknown exact IDs: configuration exit `2`, safe
  `Connection not found` copy.
- Stale compare-and-swap after three attempts: configuration exit `2`, safe
  `Connection registry changed; try again` copy.
- Verification unavailable, account mismatch, model missing, policy stale, or
  adapter mismatch: configuration exit `2` with an allowlisted action message.
- Cancellation: exit `130`; no registry mutation.
- Disconnect outside a local user-present terminal, under recognized
  automation, or without confirmation: rejected before registry mutation.
- Unknown causes and vendor details remain behind the existing diagnostic-ID
  renderer.

## 7. Package and File Shape

- `packages/app/src/local-connection.ts`: shared local onboarding and
  verification.
- `packages/app/src/connection-lifecycle.ts`: redacted summaries, exact-ID
  lifecycle service, bounded mutations, verifier port.
- `packages/cli/src/local-connection.ts`: compatibility wrappers only.
- `packages/cli/src/provider-account.ts`: CLI composition adapters and public
  summary aliases, not registry mutation logic.
- `packages/cli/src/assembly.ts`: dynamic registry-backed pin resolver.
- `packages/cli/src/commands/session.ts`: provider-at-call-time compaction.
- `packages/cli/src/runtime.ts`: workspace-to-historical-session transition.
- `packages/cli/src/main.ts`: exact account subcommands and trust-context gates.

No new workspace package, dependency, credential field, provider transport,
background mode, desktop UI, or sub-agent contract is introduced.

## 8. Verification

Tests must prove:

- first setup becomes primary; later local and Codex connections remain
  secondary; updates preserve status; no-primary never falls back;
- normalized local origins update exactly one record and distinct origins create
  distinct records;
- set-primary/disconnect survive bounded revision conflicts and never select by
  prefix or label;
- disconnect confirmation and automation gates run before mutation;
- public text/JSON never reveal endpoint, account label, or fingerprint;
- local and Codex verification execute the expected trusted adapter and cannot
  mutate the registry;
- an old session continues through its pin after primary changes;
- a changed or disconnected pinned record fails before provider/runtime work;
- direct compaction resolves the active session provider, while delegated
  compaction stays unavailable;
- workspace-shell exact resume can inspect history and cannot bypass backend
  preflight;
- cancellation, malformed input, and unknown failures retain documented exit
  codes and sanitized output.

The final gate is `npm run check`, plus built-CLI smoke tests using temporary
`RECURS_HOME` directories. No real provider credential is required.

## 9. Explicit Non-Goals

- API keys, coding-plan keys, OAuth, cloud identity, or a native credential
  broker.
- Vendor logout/revocation or deletion of vendor-owned authentication.
- Automatic primary promotion, automatic model routing, or cheapest/strongest
  selection.
- New delegated providers.
- Persistent cross-process delegated continuations.
- Heavy sub-agent orchestration, worker roles, budgets, or isolated worker
  workspaces.
