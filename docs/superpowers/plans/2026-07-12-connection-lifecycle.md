# Non-Secret Connection Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete exact, non-secret connection management for local models and Codex, and make every existing session resolve its immutable backend pin independently of the current primary.

**Architecture:** `@recurs/app` owns local onboarding, redacted connection summaries, exact-ID mutations, and the verification port. The CLI composes local/Codex verifiers and renders account commands. Standalone assembly resolves providers and runtimes from the active session pin on every operation instead of closing over the startup primary.

**Tech Stack:** TypeScript 6, Node.js 22.22+, npm workspaces, Vitest 4, append-only JSONL sessions, revisioned atomic connection registry, existing provider and ACP runtime packages.

## Global Constraints

- Do not collect, import, export, log, or persist any API key, coding-plan key, OAuth token, browser cookie, vendor auth file, or vendor session ID.
- Support exactly the currently runnable paths: literal-loopback local OpenAI-compatible servers and official Codex ACP with ChatGPT.
- Require full exact connection IDs for mutation; never accept prefixes, labels, indexes, or fuzzy matches.
- Only the first record written to an empty registry becomes primary. Never promote a record implicitly.
- No primary means workspace-shell mode even when secondary records exist.
- Existing sessions resolve their exact immutable pin; changing primary cannot redirect them.
- Removing a connection removes Recurs metadata only and never signs out, revokes, or deletes vendor authentication.
- Public account results never contain local endpoint URLs, account labels, subject fingerprints, vendor paths, or credential material.
- Codex verification remains local, manual, user-present, Plan-only, and read-only.
- Follow RED/GREEN/REFACTOR for every production behavior and commit each independently testable task.
- Do not add native credential authority, a new provider, desktop behavior, or any heavy sub-agent architecture.

---

### Task 1: Move local onboarding into the application layer and fix primary semantics

**Files:**
- Create: `packages/app/src/local-connection.ts`
- Create: `packages/app/test/local-connection.test.ts`
- Modify: `packages/app/src/index.ts`
- Modify: `packages/app/src/codex-onboarding.ts`
- Modify: `packages/app/test/codex-onboarding.test.ts`
- Modify: `packages/cli/src/local-connection.ts`
- Modify: `packages/cli/test/local-connection.test.ts`
- Modify: `packages/cli/src/assembly.ts`

**Interfaces:**
- Produces `LocalConnectionError`, `LocalConnectionConfiguration`, `readLocalConnection()`, `writeLocalConnection()`, `setupLocalConnection()`, and `verifyLocalConnection()` from `@recurs/app`.
- `LocalConnectionConfiguration` and `CodexConnectionConfiguration` gain `primary: boolean`.
- A normalized `baseUrl` identifies a local record. Same origin updates one record; a distinct origin creates another.
- The CLI module re-exports application symbols and contains no registry mutation.

- [ ] **Step 1: Write failing application tests for distinct origins and first-only primary selection**

Add focused tests with two literal-loopback endpoints and deterministic fetch fixtures:

```ts
it("keeps a later local origin secondary", async () => {
  const first = await setupLocalConnection(root, {
    baseUrl: "http://127.0.0.1:11434/v1",
    modelId: "qwen",
    fetch: modelList("qwen"),
  });
  const second = await setupLocalConnection(root, {
    baseUrl: "http://127.0.0.1:1234/v1",
    modelId: "codestral",
    fetch: modelList("codestral"),
  });

  expect(first.primary).toBe(true);
  expect(second.primary).toBe(false);
  const document = await new FileConnectionRegistry(root).read();
  expect(document.primaryConnectionId).toBe(first.id);
  expect(document.connections).toHaveLength(2);
});

it("updates the exact normalized local origin without changing primary", async () => {
  const original = await setupLocalConnection(root, {
    baseUrl: "http://127.0.0.1:11434/v1/",
    modelId: "old",
    fetch: modelList("old"),
  });
  await setupLocalConnection(root, {
    baseUrl: "http://127.0.0.1:1234/v1",
    modelId: "secondary",
    fetch: modelList("secondary"),
  });
  const updated = await setupLocalConnection(root, {
    baseUrl: "http://127.0.0.1:11434/v1",
    modelId: "new",
    fetch: modelList("new"),
  });

  expect(updated).toMatchObject({ id: original.id, modelId: "new", primary: true });
  expect((await new FileConnectionRegistry(root).read()).connections).toHaveLength(2);
});
```

Add a duplicate-origin fixture and assert setup fails closed rather than choosing one record. Add a registry-with-records-and-null-primary fixture and assert a new local record remains secondary.

- [ ] **Step 2: Run the new application test and verify RED**

Run:

```bash
npx vitest run packages/app/test/local-connection.test.ts
```

Expected: FAIL because `@recurs/app` does not export local onboarding and current CLI setup overwrites one record and primary selection.

- [ ] **Step 3: Move the implementation and make origin identity exact**

Implement the application-layer record lookup around normalized origin:

```ts
function recordsForOrigin(
  document: ConnectionRegistryDocument,
  baseUrl: string,
): readonly LocalConnectionRecord[] {
  return document.connections.filter(
    (record): record is LocalConnectionRecord =>
      record.kind === "local_openai_compatible" && record.baseUrl === baseUrl,
  );
}

function shouldBecomePrimary(
  document: ConnectionRegistryDocument,
  existing: LocalConnectionRecord | undefined,
): boolean {
  return existing === undefined &&
    document.connections.length === 0 &&
    document.primaryConnectionId === null;
}
```

Generate a fresh ID only for a new origin. Preserve `createdAt` on update. Set primary only when `shouldBecomePrimary()` is true. Return `primary` by reading the committed document, not by predicting the mutation result.

`verifyLocalConnection(record, options)` calls `listLocalOpenAIModels()` and returns `"verified"` only when the exact stored model is present; it never writes the registry.

Replace `packages/cli/src/local-connection.ts` with explicit re-exports from `@recurs/app`.

- [ ] **Step 4: Write failing Codex primary-preservation tests**

Add tests proving a new account stays secondary and re-verifying an existing secondary account does not steal primary:

```ts
expect(first.primary).toBe(true);
expect(second.primary).toBe(false);
expect(reverifiedSecond).toMatchObject({ id: second.id, primary: false });
expect((await registry.read()).primaryConnectionId).toBe(first.id);
```

- [ ] **Step 5: Run the Codex test and verify RED**

Run:

```bash
npx vitest run packages/app/test/codex-onboarding.test.ts
```

Expected: FAIL because Codex setup currently assigns every verified record as primary and does not return primary state.

- [ ] **Step 6: Implement first-only Codex primary selection**

Inside the existing revision-retry transaction, use the pre-mutation document:

```ts
const makePrimary = previous === undefined &&
  current.connections.length === 0 &&
  current.primaryConnectionId === null;

await registry.commit(current.revision, (draft) => {
  const index = draft.connections.findIndex((entry) => entry.id === record.id);
  if (index === -1) draft.connections.push(record);
  else draft.connections[index] = record;
  if (makePrimary) draft.primaryConnectionId = record.id;
});
```

Return `primary: committed.primaryConnectionId === record.id` from the saved result.

- [ ] **Step 7: Run focused tests, typecheck, and commit**

Run:

```bash
npx vitest run packages/app/test/local-connection.test.ts packages/app/test/codex-onboarding.test.ts packages/cli/test/local-connection.test.ts packages/cli/test/assembly.test.ts
npm run typecheck
```

Expected: PASS.

Commit:

```bash
git add packages/app packages/cli/src/local-connection.ts packages/cli/test/local-connection.test.ts packages/cli/src/assembly.ts
git commit -m "feat: centralize non-secret connection setup"
```

---

### Task 2: Add the redacted connection lifecycle service

**Files:**
- Create: `packages/app/src/connection-lifecycle.ts`
- Create: `packages/app/test/connection-lifecycle.test.ts`
- Modify: `packages/app/src/index.ts`

**Interfaces:**
- Produces `ConnectionLifecycleService`, `ConnectionLifecycleError`, `ConnectionSummary`, `ConnectionVerifier`, `ConnectionVerification`, and `ConnectionDisconnection`.
- Uses `FileConnectionRegistry.migrateLegacyLocal()` and bounded three-attempt revision CAS.
- All public results are redacted and deeply frozen.

- [ ] **Step 1: Write failing summary/redaction tests**

Use one local and one delegated record containing endpoint/account canaries:

```ts
const summaries = await service.list();
expect(summaries).toEqual([
  expect.objectContaining({ id: local.id, primary: true, account: "local endpoint (no credential)" }),
  expect.objectContaining({ id: codex.id, primary: false, account: "verified (identifier redacted)" }),
]);
expect(JSON.stringify(summaries)).not.toContain(local.baseUrl);
expect(JSON.stringify(summaries)).not.toContain(codex.accountLabel);
expect(JSON.stringify(summaries)).not.toContain(codex.accountSubjectFingerprint);
expect(Object.isFrozen(summaries[0])).toBe(true);
```

- [ ] **Step 2: Write failing exact-ID mutation tests**

Cover exact set-primary, prefix/label rejection, no-op preservation, disconnecting secondary, disconnecting primary to `null`, concurrent revision retry, exhausted revision conflicts, abort-before-mutation, and no implicit promotion:

```ts
await expect(service.setPrimary(codex.id)).resolves.toMatchObject({
  id: codex.id,
  primary: true,
});
await expect(service.setPrimary(codex.id.slice(0, 8))).rejects.toMatchObject({
  code: "connection_not_found",
});
const removed = await service.disconnect(codex.id);
expect(removed).toMatchObject({ connectionId: codex.id, primaryCleared: true });
expect((await registry.read()).primaryConnectionId).toBeNull();
```

- [ ] **Step 3: Write failing verifier-port tests**

Prove the service passes an immutable clone of the exact record, returns only a redacted result, does not change registry revision, maps each declared verifier reason to canonical text, treats unknown throws as unavailable, and honors cancellation:

```ts
const before = await registry.read();
const result = await service.verify(local.id, {
  async verifyLocal(record) {
    expect(Object.isFrozen(record)).toBe(true);
    expect(record.id).toBe(local.id);
    return { status: "verified" };
  },
  async verifyDelegated() {
    throw new Error("wrong adapter");
  },
});
expect(result.connection).toMatchObject({ id: local.id });
expect((await registry.read()).revision).toBe(before.revision);
```

- [ ] **Step 4: Run the service test and verify RED**

Run:

```bash
npx vitest run packages/app/test/connection-lifecycle.test.ts
```

Expected: FAIL because the service and types do not exist.

- [ ] **Step 5: Implement lifecycle types and canonical errors**

Define the public contracts:

```ts
export type ConnectionVerificationFailureReason =
  | "connection_unavailable"
  | "authentication_required"
  | "account_mismatch"
  | "model_unavailable"
  | "policy_stale"
  | "adapter_unavailable";

export type ConnectionVerificationDecision =
  | { readonly status: "verified" }
  | { readonly status: "failed"; readonly reason: ConnectionVerificationFailureReason };

export interface ConnectionVerifier {
  verifyLocal(
    record: Readonly<LocalConnectionRecord>,
    signal: AbortSignal,
  ): Promise<ConnectionVerificationDecision>;
  verifyDelegated(
    record: Readonly<DelegatedConnectionRecord>,
    signal: AbortSignal,
  ): Promise<ConnectionVerificationDecision>;
}
```

`ConnectionSummary` contains only the fields permitted by the design. Map each verification reason to one constant safe message. `ConnectionLifecycleError` exposes only `connection_not_found`, `registry_changed`, `verification_failed`, or `cancelled`.

- [ ] **Step 6: Implement bounded atomic operations**

Use one private retry loop for mutations:

```ts
for (let attempt = 0; attempt < 3; attempt += 1) {
  throwIfAborted(signal);
  const current = await registry.migrateLegacyLocal({ signal });
  const record = exactRecord(current, id);
  try {
    const committed = await registry.commit(current.revision, mutation(record), { signal });
    return resultFrom(committed, record.id);
  } catch (error) {
    if (isRevisionConflict(error) && attempt < 2) continue;
    throw mapLifecycleError(error, signal);
  }
}
throw new ConnectionLifecycleError("registry_changed");
```

Return without committing when the selected connection is already primary. On disconnect, remove exactly one record and set primary to `null` only when it matched the removed ID.

- [ ] **Step 7: Run focused tests, typecheck, and commit**

Run:

```bash
npx vitest run packages/app/test/connection-lifecycle.test.ts packages/app/test/connection-registry.test.ts
npm run typecheck
```

Expected: PASS.

Commit:

```bash
git add packages/app/src/connection-lifecycle.ts packages/app/src/index.ts packages/app/test/connection-lifecycle.test.ts
git commit -m "feat: add connection lifecycle service"
```

---

### Task 3: Compose verification and expose exact CLI account commands

**Files:**
- Modify: `packages/cli/src/codex-connection.ts`
- Modify: `packages/cli/src/provider-account.ts`
- Modify: `packages/cli/src/main.ts`
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/test/provider-account.test.ts`
- Modify: `packages/cli/test/run-mode.test.ts`
- Modify: `tests/e2e/provider-onboarding.test.ts`

**Interfaces:**
- Produces `verifyCodexSubscriptionConnection()` and CLI lifecycle wrappers over `ConnectionLifecycleService`.
- Adds `recurs account set-primary <id>`, `recurs account verify <id>`, and `recurs account disconnect <id>`.
- Disconnect requires interactive, manual, local confirmation before its dependency is called.

- [ ] **Step 1: Write failing local/Codex verifier adapter tests**

Test exact mapping without raw vendor details:

```ts
expect(await verifier.verifyLocal(local, signal)).toEqual({ status: "verified" });
expect(await verifier.verifyDelegated(codex, signal)).toEqual({ status: "verified" });
expect(await switchedAccountVerifier.verifyDelegated(codex, signal)).toEqual({
  status: "failed",
  reason: "account_mismatch",
});
```

For Codex, assert official adapter/version, structured `chat-gpt` status,
canonical fingerprint, exact model, and `read-only` mode. Do not call
authentication from verification.

- [ ] **Step 2: Run verifier tests and verify RED**

Run:

```bash
npx vitest run packages/cli/test/provider-account.test.ts packages/runtimes/test/codex-acp-profile.test.ts
```

Expected: FAIL because verification composition does not exist.

- [ ] **Step 3: Implement trusted verification adapters**

Create a CLI-owned verifier:

```ts
export function createConnectionVerifier(cwd: string): ConnectionVerifier {
  return {
    verifyLocal: (record, signal) => verifyLocalConnection(record, { signal }),
    verifyDelegated: (record, signal) =>
      verifyCodexSubscriptionConnection(record, cwd, signal),
  };
}
```

The Codex function returns declared reasons and catches all unexpected adapter
errors as `adapter_unavailable`. Cancellation is detected from the signal by the
application service.

- [ ] **Step 4: Write failing CLI parsing, trust-gate, output, and exit tests**

Cover:

```ts
expect(await runCli(["account", "set-primary", exactId], deps)).toBe(0);
expect(setPrimary).toHaveBeenCalledWith(exactId);

expect(await runCli(["account", "disconnect", exactId], {
  ...deps,
  interactive: false,
  disconnectAccount,
})).toBe(2);
expect(disconnectAccount).not.toHaveBeenCalled();

expect(await runCli(["account", "disconnect", exactId], {
  ...deps,
  interactive: true,
  automation: false,
  confirm: async () => false,
  disconnectAccount,
})).toBe(2);
expect(disconnectAccount).not.toHaveBeenCalled();
```

Assert successful output contains exact ID/model and never endpoint, account
label, fingerprint, or vendor path. Assert unknown IDs exit `2`; cancellation
exits `130`; malformed extra flags never call a lifecycle dependency.

- [ ] **Step 5: Run CLI tests and verify RED**

Run:

```bash
npx vitest run packages/cli/test/run-mode.test.ts packages/cli/test/provider-account.test.ts
```

Expected: FAIL because only `account list` is parsed.

- [ ] **Step 6: Implement exact account subcommands**

Parse the account command into a strict discriminated union:

```ts
type AccountCommand =
  | { readonly kind: "list"; readonly json: boolean }
  | { readonly kind: "set_primary"; readonly id: string }
  | { readonly kind: "verify"; readonly id: string }
  | { readonly kind: "disconnect"; readonly id: string };
```

Require one non-flag ID and no trailing arguments. Verify requires a local
interactive terminal because one supported adapter is user-present-only.
Disconnect additionally requires manual mode and confirmation with copy that
states vendor authentication is unchanged.

Update setup success rendering to say either `Primary connection` or `Saved as
secondary; use recurs account set-primary <id> to select it` from the returned
`primary` field.

- [ ] **Step 7: Run focused tests and commit**

Run:

```bash
npx vitest run packages/cli/test/provider-account.test.ts packages/cli/test/run-mode.test.ts tests/e2e/provider-onboarding.test.ts
npm run typecheck
```

Expected: PASS.

Commit:

```bash
git add packages/cli/src packages/cli/test tests/e2e/provider-onboarding.test.ts
git commit -m "feat: manage configured accounts"
```

---

### Task 4: Resolve every run through its immutable connection pin

**Files:**
- Modify: `packages/cli/src/assembly.ts`
- Modify: `packages/cli/test/assembly.test.ts`
- Modify: `packages/cli/test/run-mode.test.ts`

**Interfaces:**
- Replaces startup-primary closure resolution with a registry-backed backend factory.
- Local pins bind a SHA-256 digest of normalized endpoint origin rather than only a random connection ID.
- No-primary registry state always creates `WorkspaceShellState`.

- [ ] **Step 1: Write failing no-primary and multiple-connection startup tests**

Create a registry with two valid records and `primaryConnectionId: null`:

```ts
const runtime = await createStandaloneRuntime(events, { cwd, dataDirectory });
expect(runtime.state).toMatchObject({ type: "workspace" });
expect(runtime.state).not.toHaveProperty("session");
```

Create a primary local and secondary Codex record and assert startup selects
only the explicit primary, independent of array order.

- [ ] **Step 2: Write failing immutable-pin resolution tests**

Create a session on connection A, change primary to connection B, then run the
old session and assert provider/runtime A is created. Mutate A's pinned model,
endpoint origin, account fingerprint, policy, or billing selection one case at
a time and assert preflight fails before provider/runtime creation. Remove A
and assert the same.

For a local session, assert its pin contains:

```ts
expect(pin.accountSubjectFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
expect(pin.accountSubjectFingerprint).not.toContain(connection.id);
```

- [ ] **Step 3: Run assembly tests and verify RED**

Run:

```bash
npx vitest run packages/cli/test/assembly.test.ts
```

Expected: FAIL because no-primary falls back to the first record and the resolver closes over the startup primary.

- [ ] **Step 4: Extract canonical backend construction**

Implement:

```ts
function backendForConnection(
  connection: ConnectionRecord,
  delegatedRuntimeFactory: DelegatedRuntimeFactory,
): RuntimeBackend {
  if (connection.kind === "local_openai_compatible") {
    return localRuntimeBackend(connection);
  }
  assertCodexPolicy(connection, randomUUID());
  return delegatedRuntimeBackend(connection, delegatedRuntimeFactory);
}
```

`selectedConnection()` returns `null` unless `primaryConnectionId` is non-null
and resolves exactly. `localBackendPin()` hashes a domain-separated normalized
base URL and uses a bumped local policy revision so pre-existing weaker pins
fail closed rather than redirect.

- [ ] **Step 5: Implement registry-backed resolution**

For non-injected operation resolution:

```ts
const current = await connectionRegistry.read();
const connection = current.connections.find(
  (entry) => entry.id === input.pin.connectionId,
);
if (connection === undefined) throw connectionPreflightFailure(input.operationId);
const selected = backendForConnection(connection, delegatedFactory);
const expected = selected.pin(input.pin.billingSelectionAtCreation.acknowledgedAt);
if (!isDeepStrictEqual(expected, input.pin)) {
  throw connectionPreflightFailure(input.operationId);
}
```

Bind `connectionRevision` to the current registry revision for both direct and
delegated lanes. Create the provider/runtime only from `selected` after exact
comparison. Keep the injected test/embedding provider as its own immutable
resolver path.

- [ ] **Step 6: Run assembly and coordinator tests, then commit**

Run:

```bash
npx vitest run packages/cli/test/assembly.test.ts packages/core/test/run-coordinator.test.ts tests/e2e/provider-onboarding.test.ts
npm run typecheck
```

Expected: PASS.

Commit:

```bash
git add packages/cli/src/assembly.ts packages/cli/test/assembly.test.ts packages/cli/test/run-mode.test.ts tests/e2e/provider-onboarding.test.ts
git commit -m "fix: resolve sessions by immutable connection pin"
```

---

### Task 5: Resume pinned history from the workspace shell and resolve compaction per session

**Files:**
- Modify: `packages/cli/src/runtime.ts`
- Modify: `packages/cli/test/runtime.test.ts`
- Modify: `packages/cli/src/commands/types.ts`
- Modify: `packages/cli/src/commands/session.ts`
- Modify: `packages/cli/test/session-commands.test.ts`
- Modify: `packages/cli/src/assembly.ts`
- Modify: `packages/cli/test/assembly.test.ts`

**Interfaces:**
- `RecursRuntime` can lazily create a `CoordinatedRuntime` after an exact workspace-shell `/resume <id>`.
- `CommandDependencies.resolveProvider(session, signal)` resolves direct compaction from the active pin.
- Existing static `provider` remains a compatibility fallback for injected tests/hosts.

- [ ] **Step 1: Write failing workspace resume tests**

Start from `WorkspaceShellState` with a coordinator and a stored pinned session:

```ts
const result = await runtime.submit(`/resume ${session.id}`);
expect(result).toMatchObject({ type: "message", level: "info" });
expect(runtime.state).toMatchObject({
  type: "session",
  session: { id: session.id },
});
```

Then submit a prompt and assert the coordinator receives the stored session ID.
With no matching connection in the resolver, assert prompt preflight fails
without provider work. Keep legacy history inspectable but non-runnable.

- [ ] **Step 2: Run runtime tests and verify RED**

Run:

```bash
npx vitest run packages/cli/test/runtime.test.ts packages/cli/test/session-commands.test.ts
```

Expected: FAIL because workspace resume with an ID is blocked and no runner is created from workspace state.

- [ ] **Step 3: Implement lazy session activation**

Store the normalized coordinator in `RecursRuntime` and replace `#setSession`
with activation semantics:

```ts
#activateSession(session: SessionState): void {
  this.#session = session;
  this.#workspace = null;
  this.#runner = this.#coordinator === null
    ? null
    : this.#runner === null
      ? new CoordinatedRuntime(
          { sessions: this.dependencies.sessions, coordinator: this.#coordinator },
          session,
        )
      : (this.#runner.replaceSession(session), this.#runner);
}
```

Allow exact `/resume <id>` through the workspace command registry. After command
execution, activate the loaded session when the context no longer contains the
transient `workspace-shell` state. Listing sessions remains in workspace mode.

- [ ] **Step 4: Write failing per-session compaction tests**

```ts
const result = await commands.execute("/compact", contextFor(sessionB));
expect(resolveProvider).toHaveBeenCalledWith(sessionB, expect.any(AbortSignal));
expect(providerA.stream).not.toHaveBeenCalled();
expect(providerB.stream).toHaveBeenCalledOnce();
```

Assert missing/changed/disconnected local connections produce a safe command
error, and delegated sessions still reject before calling the resolver.

- [ ] **Step 5: Run compaction tests and verify RED**

Run:

```bash
npx vitest run packages/cli/test/session-commands.test.ts packages/cli/test/assembly.test.ts
```

Expected: FAIL because compaction uses one startup provider.

- [ ] **Step 6: Implement provider-at-call-time compaction**

Extend dependencies:

```ts
resolveProvider?(
  session: SessionState,
  signal: AbortSignal,
): Promise<ModelProvider | null>;
```

In `/compact`, reject delegated sessions first, then resolve the active direct
session provider, falling back to the existing static provider only for
compatibility. Standalone assembly reads the registry, reconstructs the exact
local pin, and returns a provider only after complete pin comparison.

- [ ] **Step 7: Run focused tests and commit**

Run:

```bash
npx vitest run packages/cli/test/runtime.test.ts packages/cli/test/session-commands.test.ts packages/cli/test/assembly.test.ts packages/core/test/compaction.test.ts
npm run typecheck
```

Expected: PASS.

Commit:

```bash
git add packages/cli/src/runtime.ts packages/cli/test/runtime.test.ts packages/cli/src/commands packages/cli/test/session-commands.test.ts packages/cli/src/assembly.ts packages/cli/test/assembly.test.ts
git commit -m "fix: preserve pinned sessions across account changes"
```

---

### Task 6: End-to-end lifecycle proof and truthful documentation

**Files:**
- Modify: `tests/e2e/provider-onboarding.test.ts`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `PRODUCT.md`
- Modify: `SECURITY.md`
- Modify: `docs/CLI.md`
- Modify: `docs/README.md`
- Modify: `docs/superpowers/specs/2026-07-10-recurs-provider-auth-design.md`
- Modify: `docs/superpowers/specs/2026-07-12-connection-lifecycle-design.md`
- Modify: `docs/superpowers/plans/2026-07-12-connection-lifecycle.md`

**Interfaces:**
- Documents exact implemented commands, first-only primary behavior, metadata-only disconnect, verification limits, and pin-based resume.
- Leaves native credentials and heavy sub-agents explicitly pending.

- [ ] **Step 1: Add an end-to-end multi-connection lifecycle test**

The test must use temporary data/workspace directories and fake local/Codex
verification ports. It performs:

```text
setup local A -> primary A
setup local B -> secondary B
create and run session pinned to A
set primary B
resume/run old session -> still A
verify B -> no registry revision change
disconnect A with confirmation
old session prompt -> preflight failure before provider work
disconnect B -> primary null
restart -> workspace shell, no array-order fallback
```

Assert all public text/JSON excludes endpoint, account-label, and fingerprint
canaries.

- [ ] **Step 2: Run the E2E test and verify GREEN**

Run:

```bash
npx vitest run tests/e2e/provider-onboarding.test.ts
```

Expected: PASS.

- [ ] **Step 3: Update public and reviewed documentation**

Document:

- exact account commands and interaction requirements;
- first connection only becomes primary;
- secondary records never run without explicit selection or a historical pin;
- disconnect removes Recurs metadata only;
- verification is non-billable/read-only and does not authenticate or repair;
- existing sessions follow their pin and fail if the record changes or is removed;
- no API/coding-plan credential, native broker, provider expansion, or sub-agent
  work is included.

Mark this plan's delivered checklist accurately. Do not call the native
credential boundary or full onboarding state machine complete.

- [ ] **Step 4: Scan the final diff and sensitive patterns**

Run:

```bash
git status --short
git diff --check main...HEAD
git diff --stat main...HEAD
git diff main...HEAD | rg -n "(sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|BEGIN .*PRIVATE KEY|gh[pousr]_[A-Za-z0-9]{20,})"
```

Expected: lifecycle code/tests/docs only; the final `rg` command returns no match.

- [ ] **Step 5: Run the complete clean gate and built-CLI smoke test**

Run:

```bash
rm -rf packages/*/dist
npm run check
RECURS_HOME="$(mktemp -d)" node packages/cli/dist/main.js account list --json
RECURS_HOME="$(mktemp -d)" node packages/cli/dist/main.js account set-primary missing
```

Expected: lint, strict typecheck, every test, and build pass; empty account JSON
is redacted and versioned; unknown exact ID exits `2` with safe copy.

- [ ] **Step 6: Commit documentation and prepare integration**

```bash
git add README.md ARCHITECTURE.md PRODUCT.md SECURITY.md docs tests/e2e/provider-onboarding.test.ts
git commit -m "docs: complete connection lifecycle"
```

Re-read every requirement in the design, verify the branch is clean, then
fast-forward local `main` only after the full committed-tree gate passes.
