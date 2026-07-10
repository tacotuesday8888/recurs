# Recurs Provider Foundation Slice 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the provider-neutral contracts, pinned-session foundation, trusted runtime seam, and sessionless CLI state required before Recurs can safely accept real provider credentials.

**Architecture:** A new dependency-leaf `@recurs/contracts` package owns shared model, connection, backend, failure, and runtime port types. Core adds a strict version-2 session log beside read-only version-1 loading, plus a backend-neutral coordinator and runtime state that can exist before a session. The CLI composes those ports and stops creating fake `unconfigured` sessions; the existing injected `ScriptedProvider` path remains available through a compatibility coordinator until direct live adapters land.

**Tech Stack:** TypeScript 6, Node.js 22.22+, npm workspaces, Vitest 4, append-only JSONL, atomic filesystem lock directories.

## Global Constraints

- Do not accept, persist, import, or transmit any live provider credential in this slice.
- Keep `@recurs/contracts` free of Node APIs and dependencies on other Recurs packages.
- New durable sessions use version 2 and an immutable `SessionBackendPin`; version-1 logs remain readable and listable but cannot be mutated.
- Repository files and model output cannot construct trusted invocation context, backend pins, or authorizations.
- Preserve the current scripted-provider coding flow and all existing permission, Plan mode, goal, checkpoint, and tool behavior.
- Keep the current product name isolated to CLI copy; do not add new architecture identifiers derived from `Recurs` branding.

---

### Task 1: Add the dependency-leaf contracts package

**Files:**
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/src/json.ts`
- Create: `packages/contracts/src/model.ts`
- Create: `packages/contracts/src/connections.ts`
- Create: `packages/contracts/src/failures.ts`
- Create: `packages/contracts/src/runtime.ts`
- Create: `packages/contracts/src/index.ts`
- Create: `packages/contracts/test/contracts.test.ts`
- Modify: `packages/providers/package.json`
- Modify: `packages/providers/src/types.ts`
- Modify: `packages/tools/package.json`
- Modify: `packages/tools/src/types.ts`
- Modify: `packages/tools/src/registry.ts`
- Modify: `packages/core/package.json`
- Modify: `packages/cli/package.json`
- Modify: `tsconfig.json`
- Modify: `tsconfig.eslint.json`
- Modify: `vitest.config.ts`

**Interfaces:**
- Produces: `JsonValue`, `ModelMessage`, `ProviderBackedMessage`, `ToolCall`, `ToolDefinition`, `ProviderUsage`, `ModelProvider`, `AgentRuntime`, `IntegrationFailure`, `SessionBackendPin`, `TrustedRunContext`, `HostInvocation`, `RunAuthorization`, `BackendResolver`, `RunCoordinator`, `RunOutcome`, and continuation types.
- Preserves: the current provider collector's `ProviderError`, `ProviderEvent`, and `CollectedProviderEvents` compatibility exports.

- [x] **Step 1: Write failing contracts and dependency-boundary tests**

```ts
it("derives every trusted context dimension from a host-only invocation", () => {
  expect(deriveTrustedRunContext(createHostInvocation({
    invocation: "one_shot",
    userPresent: false,
    remote: true,
    scripted: true,
    embedding: "ci",
  }))).toEqual({
    invocation: "one_shot",
    presence: "unattended",
    location: "remote",
    automation: "scripted",
    embedding: "ci",
  });
});

it("keeps contracts as the only dependency leaf", async () => {
  expect(contractPackage.dependencies).toBeUndefined();
  expect(providerPackage.dependencies).toEqual({ "@recurs/contracts": "0.0.0" });
});
```

- [x] **Step 2: Run the contracts test and verify it fails because the package is absent**

Run: `npm test -- packages/contracts/test/contracts.test.ts`
Expected: FAIL because `packages/contracts/src/index.ts` cannot be resolved.

- [x] **Step 3: Add focused contracts modules and re-export compatibility types**

```ts
export interface SessionBackendPin {
  kind: "model_provider" | "agent_runtime";
  providerId: string;
  adapterId: string;
  connectionId: string;
  modelId: string;
  modelIdentityKind: "versioned" | "mutable_alias" | "router";
  providerResolvedModelRevisionAtCreation: string | null;
  catalogRevision: string | null;
  policyRevisionAtCreation: string;
  billingPolicyRevisionAtCreation: string;
  primaryBillingSourceAtCreation: BillingSource;
  billingSelectionAtCreation: BillingSelection;
  accountSubjectFingerprint: string;
}
```

`providers/src/types.ts` imports/re-exports the existing model primitives from `@recurs/contracts`; provider-only collection and legacy error types remain in providers. Tools import shared definitions directly from contracts.

- [x] **Step 4: Add trusted host invocation construction and derivation**

```ts
declare const hostInvocationBrand: unique symbol;

export function createHostInvocation(input: HostInvocationInput): HostInvocation {
  return Object.freeze({ ...input, [hostInvocationBrand]: true });
}

export function deriveTrustedRunContext(input: HostInvocation): TrustedRunContext {
  return Object.freeze({
    invocation: input.invocation,
    presence: input.userPresent ? "present" : "unattended",
    location: input.remote ? "remote" : "local",
    automation: input.scripted ? "scripted" : "manual",
    embedding: input.embedding,
  });
}
```

- [x] **Step 5: Run focused tests, typecheck, and commit**

Run: `npm test -- packages/contracts/test/contracts.test.ts && npm run typecheck`
Expected: PASS.

Commit: `feat: add provider-neutral contracts`

---

### Task 2: Add strict version-2 sessions and read-only legacy loading

**Files:**
- Create: `packages/core/src/session-v2.ts`
- Create: `packages/core/src/session-record-validator.ts`
- Create: `packages/core/src/session-mutation-lease.ts`
- Create: `packages/core/test/session-v2.test.ts`
- Modify: `packages/core/src/events.ts`
- Modify: `packages/core/src/session.ts`
- Modify: `packages/core/src/jsonl-session-store.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/test/session.test.ts`

**Interfaces:**
- Produces: `SessionRecordV2`, `SessionRecordInputV2`, `SessionStateV2`, `SessionBackendState`, `SessionMutationLease`, `JsonlSessionStore.createPinnedSession()`, `withSessionMutation()`, and `appendV2()`.
- Preserves: `loadState()` for version-1 fixtures and historical logs; `list()` labels legacy and pinned sessions.

- [ ] **Step 1: Write failing tests for pins, strict sequences, legacy immutability, and competing leases**

```ts
it("creates sequence-zero pinned sessions and appends only the exact next sequence", async () => {
  const state = await store.createPinnedSession({ id: "s2", cwd, backend: pin, at });
  expect(state.version).toBe(2);
  expect(state.lastSequence).toBe(0);
  await store.withSessionMutation("s2", 0, async (lease) => {
    await lease.append({ type: "turn_started", turnId: "t1", prompt: "inspect", at });
  });
  await expect(store.withSessionMutation("s2", 0, async () => undefined))
    .rejects.toMatchObject({ code: "session_conflict" });
});

it("loads version one as legacy and refuses every append", async () => {
  const state = await store.loadState("legacy");
  expect(state.backend).toEqual({ type: "legacy", model: "scripted" });
  await expect(store.append("legacy", legacyGoalRecord))
    .rejects.toMatchObject({ code: "legacy_read_only" });
});
```

- [ ] **Step 2: Run the focused test and verify the missing v2 APIs fail**

Run: `npm test -- packages/core/test/session-v2.test.ts`
Expected: FAIL because `createPinnedSession` and `withSessionMutation` do not exist.

- [ ] **Step 3: Define exact v2 records and a strict validator**

The validator rejects unknown keys, wrong discriminants, missing turn IDs, unsafe sequences, mixed session IDs, and mixed versions. The first record must be `session_created` at sequence `0`; later records must increment by exactly one.

```ts
export interface SessionRecordBaseV2 {
  version: 2;
  sessionId: string;
  sequence: number;
  at: string;
}

export type SessionRecordV2 =
  | (SessionRecordBaseV2 & { type: "session_created"; cwd: string; backend: SessionBackendPin })
  | (SessionRecordBaseV2 & { type: "turn_started"; turnId: string; prompt: string })
  | (SessionRecordBaseV2 & { type: "model_completed"; turnId: string; message: ProviderBackedMessage; usage: ProviderUsage | null; stopReason: StopReason })
  | (SessionRecordBaseV2 & { type: "tool_started"; turnId: string; call: ToolCall })
  | (SessionRecordBaseV2 & { type: "tool_completed"; turnId: string; callId: string; result: ToolResult })
  | (SessionRecordBaseV2 & { type: "tool_failed"; turnId: string; callId: string; error: IntegrationFailure })
  | (SessionRecordBaseV2 & { type: "turn_completed"; turnId: string; result: RunResult })
  | (SessionRecordBaseV2 & { type: "turn_failed"; turnId: string; error: IntegrationFailure })
  | (SessionRecordBaseV2 & { type: "turn_cancelled"; turnId: string; reason: string })
  | (SessionRecordBaseV2 & { type: "turn_interrupted"; turnId: string; reason: string });
```

- [ ] **Step 4: Implement one-version logs and atomic mutation leases**

`withSessionMutation` atomically creates `.locks/<session>.lock`, verifies the caller's expected sequence under that lock, issues a private lease object with a monotonic fence, and removes only its own lock on exit. A competing process receives `session_busy`; a stale expected sequence receives `session_conflict`.

```ts
await store.withSessionMutation(sessionId, expectedSequence, async (lease) => {
  const appended = await lease.append({ type: "turn_started", turnId, prompt, at });
  expect(appended.sequence).toBe(expectedSequence + 1);
});
```

- [ ] **Step 5: Reduce v2 records without weakening legacy behavior**

V2 replay derives the user message from `turn_started`, assistant messages from `model_completed`, tool messages from terminal tool records, and current mode/goal/result from their provenance-bearing records. V1 replay returns `backend: { type: "legacy", model }` and never accepts a new record.

- [ ] **Step 6: Run session tests and commit**

Run: `npm test -- packages/core/test/session.test.ts packages/core/test/session-v2.test.ts && npm run typecheck`
Expected: PASS.

Commit: `feat: add pinned version two sessions`

---

### Task 3: Add the backend-neutral run coordinator seam

**Files:**
- Create: `packages/core/src/run-context.ts`
- Create: `packages/core/src/run-coordinator.ts`
- Create: `packages/core/src/compatibility-coordinator.ts`
- Create: `packages/core/test/run-coordinator.test.ts`
- Modify: `packages/core/src/agent-loop.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `BackendResolver`, `HostInvocation`, `RunCoordinator`, `RunOutcome`, `SessionBackendPin` from contracts.
- Produces: `CompatibilityRunCoordinator`, preflight-before-persistence behavior, and a normalized event/outcome surface.

- [ ] **Step 1: Write failing tests for preflight, immutable routing, and provider lifetime**

```ts
it("resolves the pinned backend before persisting a prompt", async () => {
  resolver.resolve.mockRejectedValue(policyFailure);
  const outcome = await coordinator.start(input);
  await expect(outcome.outcome).resolves.toEqual({ ok: false, failure: policyFailure });
  expect((await store.load("s2")).records).toHaveLength(1);
});

it("creates a backend for each run instead of retaining a process-wide provider", async () => {
  await runTwice();
  expect(factory.create).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: Run the coordinator test and verify it fails because the seam is absent**

Run: `npm test -- packages/core/test/run-coordinator.test.ts`
Expected: FAIL because `RunCoordinator` implementation exports are missing.

- [ ] **Step 3: Implement trusted preflight and resolved-backend dispatch**

```ts
const context = deriveTrustedRunContext(input.invocation);
const state = await sessions.loadPinnedState(input.sessionId);
if (state.lastSequence !== input.expectedSessionRecordSequence) {
  return configurationFailure("session_conflict");
}
const resolved = await resolver.resolve({
  operation: "run",
  operationId,
  sessionId: input.sessionId,
  turnId,
  pin: state.backend.pin,
  context,
  signal: input.signal,
});
```

No `turn_started` or prompt record is appended until this completes. The direct lane creates a provider for this run and wraps the existing `AgentLoop`; the runtime lane uses the injected fake `AgentRuntime` executor and normalizes its result. Both return typed failures as data.

- [ ] **Step 4: Add a compatibility coordinator for existing scripted-provider fixtures**

The compatibility coordinator adapts `AgentLoop.run()` to `RunOutcome`, while `AgentLoop` writes version-2 records under the coordinator's mutation lease. It makes no claim that a live credential is safe and exists only for injected/test providers until Slice 1 and the real resolver replace it.

- [ ] **Step 5: Run coordinator and agent-loop tests and commit**

Run: `npm test -- packages/core/test/run-coordinator.test.ts packages/core/test/agent-loop.test.ts && npm run typecheck`
Expected: PASS.

Commit: `feat: add backend-neutral run coordination`

---

### Task 4: Move runtime ownership to core and add a sessionless workspace shell

**Files:**
- Create: `packages/core/src/runtime.ts`
- Create: `packages/core/src/workspace-shell.ts`
- Create: `packages/core/test/runtime.test.ts`
- Modify: `packages/cli/src/runtime.ts`
- Modify: `packages/cli/src/assembly.ts`
- Modify: `packages/cli/src/commands/types.ts`
- Modify: `packages/cli/src/commands/foundation.ts`
- Modify: `packages/cli/src/commands/session.ts`
- Modify: `packages/cli/src/repl.ts`
- Modify: `packages/cli/src/main.ts`
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/test/runtime.test.ts`
- Modify: `packages/cli/test/run-mode.test.ts`

**Interfaces:**
- Produces: `WorkspaceShellState`, `RuntimeState`, core-owned `RecursRuntime`, and CLI `RuntimeAdapter` command routing.
- Preserves: public `RecursRuntime` compatibility export from `@recurs/cli`.

- [ ] **Step 1: Write failing tests for no fake session and shell command boundaries**

```ts
it("starts without creating a session when no backend is configured", async () => {
  const runtime = await createStandaloneRuntime(sink, { cwd, dataDirectory });
  expect(runtime.state.type).toBe("workspace");
  expect(await sessions.list()).toEqual([]);
  await expect(runtime.submit("inspect the repo"))
    .rejects.toMatchObject({ code: "provider_not_configured" });
  expect(await sessions.list()).toEqual([]);
});

it("keeps only local workspace commands available before connection", async () => {
  expect(await runtime.submit("/status")).toMatchObject({ text: expect.stringContaining("No active session") });
  expect(await runtime.submit("/goal ship it")).toMatchObject({ level: "error" });
});
```

- [ ] **Step 2: Run runtime tests and verify the current eager session creation fails them**

Run: `npm test -- packages/core/test/runtime.test.ts packages/cli/test/runtime.test.ts`
Expected: FAIL because assembly creates an `unconfigured` version-1 session.

- [ ] **Step 3: Implement the core runtime state machine and CLI command adapter**

```ts
export type RuntimeState =
  | { type: "workspace"; shell: WorkspaceShellState }
  | { type: "session"; session: SessionState };

export interface RuntimeCommandRouter {
  execute(input: string, context: RuntimeCommandContext): Promise<RuntimeCommandResult>;
}
```

The core runtime owns active cancellation, prompt coordination, session reload, and state transitions. The CLI registry implements the command port and checks command availability for workspace versus session state.

- [ ] **Step 4: Stop eager session creation and render honest onboarding-ready copy**

Without an injected provider, `createStandaloneRuntime` returns a workspace state and creates no JSONL. `/status`, `/help`, `/permissions`, `/resume`, `/init`, `/diff`, and exit commands remain local. A model prompt returns configuration exit `2` without persisting the prompt. With a scripted injected provider, assembly creates a pinned test connection/session and preserves the coding path.

- [ ] **Step 5: Run CLI, core runtime, and end-to-end tests and commit**

Run: `npm test -- packages/core/test/runtime.test.ts packages/cli/test/runtime.test.ts packages/cli/test/run-mode.test.ts tests/e2e/coding-agent.test.ts && npm run typecheck`
Expected: PASS.

Commit: `feat: add sessionless provider-ready runtime`

---

### Task 5: Document, verify, review, and integrate the slice

**Files:**
- Modify: `ARCHITECTURE.md`
- Modify: `README.md`
- Modify: `docs/CLI.md`
- Modify: `docs/README.md`
- Modify: `docs/superpowers/specs/2026-07-10-recurs-provider-auth-design.md`
- Modify: `docs/superpowers/plans/2026-07-10-recurs-provider-foundation-slice-0.md`

**Interfaces:**
- Documents: exact implemented state, explicit non-goals, legacy behavior, and next Slice 1 safety work.

- [ ] **Step 1: Update docs without claiming live provider or credential support**

Document that contracts, pins, trusted context, v2 logs, coordinator seam, and sessionless shell are implemented. Keep live API keys, secure storage, broker transport, onboarding, OpenAI/Anthropic network adapters, delegated subscriptions, and subagents explicitly unimplemented.

- [ ] **Step 2: Mark every completed plan checkbox and self-review the full diff**

Run: `git diff --check && git status --short && git diff --stat && git diff`
Expected: only intended provider-foundation files, no secret material, no swap files, and no whitespace errors.

- [ ] **Step 3: Run the full repository gate from a clean build**

Run: `rm -rf packages/*/dist && npm run check`
Expected: lint, strict TypeScript, all tests, and build pass.

- [ ] **Step 4: Request an independent code review and address every validated issue**

Review focus: package cycles, trusted-context forgery, session sequence/lock races, v1 mutation, prompt persistence before preflight, fake-session creation, cancellation, and compatibility regressions.

- [ ] **Step 5: Commit documentation, push, open PR, monitor CI, merge, and clean up**

Commit: `docs: describe provider foundation slice`

Push `codex/provider-onboarding-foundation`, open a ready PR, wait for green CI, merge without bypassing checks, delete the merged branch, switch the main checkout to updated `main`, and run `npm run check` once more.
