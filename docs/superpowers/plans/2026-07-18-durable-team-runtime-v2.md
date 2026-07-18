# Durable Team Runtime v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a restart-truthful, bounded Recurs team runtime with isolated staging, structured review/repair, process-lifetime background control, explicit apply, durable activity, and capability-aware parent-backend routing.

**Architecture:** Preserve `ChildAgentManager` and `BackendRunCoordinator` as the only child execution path. Put team progress in a separate sequenced JSONL journal, build candidates in an isolated staging worktree, persist cumulative patch artifacts, and mutate the parent only at an explicit two-phase apply boundary. New v4 policies use no-process Implement/Review/Repair profiles and depth-one sibling repair attempts.

**Tech Stack:** TypeScript 6, Node.js 22, Vitest, append-only JSONL stores, existing Git worktree/patch/checkpoint ports, existing CLI runtime and command registry.

## Global Constraints

- Preserve v1-v3 operating-mode IDs and their frozen numeric values; new behavior uses version-4 IDs.
- Child depth is exactly one and child retries remain zero.
- Every model child runs through `ChildAgentManager` and `BackendRunCoordinator`; do not add a second model loop or shell out to Recurs.
- V4 Implement, Review, and Repair profiles cannot run repository code, arbitrary commands, network tools, credentials, deployments, or external/sensitive paths.
- Background work is process-lifetime only, never mutates the parent, and becomes `interrupted` after restart unless it already reached a stable `ready_to_apply` state.
- Only an explicit apply may mutate the parent; never auto-commit, push, open a PR, deploy, or contact an external service.
- Provider routing uses capability facts and stable IDs, never hard-coded model brands; production may expose only the parent pin and must say so.
- Raw prompts and patch bodies never enter events, list/status output, or tool metadata. Persisted prompts remain only in mode-0600 local team journals for resume.
- Unknown provider cost remains unknown; do not report or enforce it as zero.
- Use test-first red/green/refactor for every behavior change and make focused commits.

---

### Task 1: Close proven Team v1 safety and determinism gaps

**Files:**
- Modify: `packages/contracts/src/agents.ts`
- Modify: `packages/contracts/test/agents.test.ts`
- Modify: `packages/core/src/team-agent-manager.ts`
- Modify: `packages/core/test/team-agent-manager.test.ts`
- Modify: `packages/cli/src/assembly.ts`
- Modify: `packages/cli/test/assembly.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: existing `AgentProfilePolicy`, `TeamAgentManager`, `JsonlSessionStore`.
- Produces: read-only Review v1 tool policy, best-effort team event delivery, deterministic implementation failure selection, root-only restart selection.

- [ ] **Step 1: Write failing policy and root-selection tests**

```ts
it("keeps Review unable to execute repository code", () => {
  const review = getAgentProfilePolicy("review_v1");
  expect(review.tools.readOnly).toBe(true);
  expect(review.tools.allowedNames).not.toContain("run_verification");
  expect(review.tools.allowedCategories).toEqual(["read"]);
});

it("reopens the canonical parent instead of a newer child", async () => {
  const runtime = await assembleWithParentAndNewerChildAtDifferentCwd();
  expect(runtime.session.agent.role).toBe("parent");
  expect(runtime.session.cwd).toBe(repositoryRoot);
});
```

- [ ] **Step 2: Run the tests and verify the expected failures**

Run: `npx vitest run packages/contracts/test/agents.test.ts packages/cli/test/assembly.test.ts`

Expected: FAIL because Review still exposes `run_verification` and assembly accepts any matching child/backend session.

- [ ] **Step 3: Narrow Review and filter startup sessions**

```ts
profile(
  "review_v1",
  "Review",
  "act",
  true,
  ["read_file", "list_files", "search_text", "git_status", "git_diff"],
  ["read"],
  "normal",
);

const isRootCandidate = isPinnedSessionState(candidate) &&
  candidate.agent.role === "parent" &&
  candidate.cwd === cwd;
```

- [ ] **Step 4: Write failing event-sink and deterministic-failure tests**

```ts
it("keeps durable team truth when presentation events fail", async () => {
  const result = await runApprovedTeam({ emit: async () => { throw new Error("sink"); } });
  expect(result.metadata.status).toBe("approved");
  expect(await readFile(changedFile, "utf8")).toBe("integrated\n");
});

it("reports the lowest task index regardless of completion order", async () => {
  const result = await runTwoFailures({ secondFailsFirst: true });
  expect(result.output).toContain("task 1 failed");
});
```

- [ ] **Step 5: Make event emission non-authoritative and failure selection ordered**

```ts
async #publish(event: RecursEvent): Promise<void> {
  try {
    await this.dependencies.emit(event);
  } catch {
    // Durable/session/workspace truth is authoritative; presentation is best effort.
  }
}

const canonicalFailure = implementations
  .filter((item): item is FailedImplementation => item.status !== "completed")
  .sort((left, right) => left.index - right.index)[0]?.failure;
```

- [ ] **Step 6: Run focused tests and update the stale README mode statement**

Run: `npx vitest run packages/contracts/test/agents.test.ts packages/core/test/team-agent-manager.test.ts packages/cli/test/assembly.test.ts`

Expected: PASS. README must describe the current v3 default before v4 is introduced.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/agents.ts packages/contracts/test/agents.test.ts packages/core/src/team-agent-manager.ts packages/core/test/team-agent-manager.test.ts packages/cli/src/assembly.ts packages/cli/test/assembly.test.ts README.md
git commit -m "fix: harden team review and restart selection"
```

### Task 2: Add v4 profiles, policies, team-run contracts, and routing

**Files:**
- Create: `packages/contracts/src/team-runs.ts`
- Modify: `packages/contracts/src/agents.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/test/agents.test.ts`
- Create: `packages/contracts/test/team-runs.test.ts`
- Create: `packages/core/src/agent-backend-router.ts`
- Create: `packages/core/test/agent-backend-router.test.ts`
- Modify: `packages/core/src/child-agent-manager.ts`
- Modify: `packages/core/test/child-agent-manager.test.ts`
- Modify: `packages/core/src/session-record-validator.ts`
- Modify: `packages/core/test/session-runtime-records.test.ts`
- Modify: `packages/core/src/agent-profile.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `SessionBackendPin`, `AgentPermissionMode`, current v1-v3 policies.
- Produces: `implement_v2`, `review_v2`, `repair_v1`; v4 policies; `TeamRunDescriptor`; `AgentBackendRouter.select()`; trusted child backend-route options.

**Sequencing corrections from the architecture audit:**

- Task 2 defines v4 but does not activate it as the default. Keep
  `DEFAULT_OPERATING_MODE_ID` at `balanced_v3`, and resolve unqualified display
  names against the default policy generation, until Task 6 wires the durable
  supervisor and switches the default atomically.
- Exact v4 IDs may be parsed for replay/tests, but the legacy
  `TeamAgentManager` must reject every non-v3 policy before acquiring a lease,
  creating a child, or mutating a workspace. Add a focused rejection test.
- Preserve the physical shape of every v1-v3 policy. Use a versioned team-policy
  union or a v4-only factory so `maxRepairRounds` is absent, not zero or
  `undefined`, in historical objects.
- New `implement_v2` and `review_v2` descriptors carry profile version 2;
  `repair_v1` carries version 1. Unqualified public profile names remain mapped
  to v1, while the supervisor selects v4 profiles by exact trusted IDs.
- The run descriptor freezes the exact parent permission/execution ceiling,
  trusted invocation classification, bounded request, exact policy/allocation
  snapshot, and serializable route decisions/reasons. Restart code must not
  re-derive those facts from a future default.
- A routed decision is trusted only when produced and authenticated by the
  injected router instance. Bind it to role, execution mode, permission mode,
  candidate ID, decision reason, and an immutable complete pin; reject forged,
  cross-router, mismatched, or mutated decisions.
- Background eligibility fails closed for non-direct runtimes and unreviewed
  billing sources. Production may provide only the parent candidate, but tests
  must prove deterministic role-candidate selection and parent fallback.
- Add explicit no-process prompt scopes and update exhaustive CLI switches; do
  not expose the new internal profiles through the existing model-controlled
  `delegate_task` schema.
- Extend child descriptors with exact optional team correlation
  (`runId`, role, task index, round, attempt ID). It is supplied only by trusted
  team code and lets restart reconciliation identify an orphan child even if
  the process dies around session creation.

- [ ] **Step 1: Write failing contract tests for stable profiles and v4 budgets**

```ts
expect(getAgentProfilePolicy("implement_v2").tools.allowedNames).toEqual([
  "read_file", "list_files", "search_text", "apply_patch", "git_status", "git_diff",
]);
expect(getAgentProfilePolicy("review_v2").tools.readOnly).toBe(true);
expect(getAgentProfilePolicy("repair_v1").tools.allowedCategories).toEqual(["read", "write"]);
expect(getOperatingModePolicy("balanced_v4").workflow.team?.maxRepairRounds).toBe(1);
expect(getOperatingModePolicy("balanced_v3")).toEqual(balancedV3Fixture);
```

- [ ] **Step 2: Run the contract tests and verify missing-ID failures**

Run: `npx vitest run packages/contracts/test/agents.test.ts packages/contracts/test/team-runs.test.ts`

Expected: FAIL because v4/profile/team-run types do not exist.

- [ ] **Step 3: Add exact team-run public contracts**

```ts
export type TeamRunExecution = "foreground" | "background";
export type TeamRunRole = "implement" | "review" | "repair";
export type TeamRunStatus =
  | "created" | "running" | "ready_to_apply" | "applying"
  | "approved" | "changes_requested" | "unverified"
  | "failed" | "cancelled" | "interrupted";
export type TeamRunTerminalStatus = Extract<
  TeamRunStatus,
  "approved" | "changes_requested" | "unverified" | "failed" | "cancelled"
>;
export type TeamRunPhase = "implement" | "stage" | "review" | "repair" | "apply";

export interface TeamReviewFinding {
  readonly path: string | "*";
  readonly problem: string;
  readonly acceptance: string;
  readonly evidence: readonly string[];
}

export interface TeamRunDescriptor {
  readonly id: string;
  readonly version: 1;
  readonly parentSessionId: string;
  readonly parentAgentId: string;
  readonly execution: TeamRunExecution;
  readonly operatingModeId: OperatingModeId;
  readonly operatingModeVersion: OperatingModeVersion;
  readonly backend: SessionBackendPin;
  readonly repositoryRoot: string;
  readonly baseRevision: string;
  readonly request: TeamRunRequest;
}
```

- [ ] **Step 4: Add immutable v4 policy values**

```ts
policy("economy_v4", 4, "Economy", 1, 8, 0.25, 2, team("essential", 1, 1, 1, 0));
policy("standard_v4", 4, "Standard", 2, 36, 1, 6, team("standard", 1, 1, 2, 1));
policy("balanced_v4", 4, "Balanced", 3, 56, 3, 7, team("balanced", 2, 1, 2, 1));
policy("performance_v4", 4, "Performance", 4, 100, 10, 10, team("thorough", 3, 2, 3, 1));
policy("max_v4", 4, "Max", 6, 216, 25, 18, team("maximum", 4, 2, 4, 2));
// Task 6 changes the default only after the v4 supervisor is real.
export const DEFAULT_OPERATING_MODE_ID: OperatingModeId = "balanced_v3";
```

- [ ] **Step 5: Write failing routing tests**

```ts
expect(router.select({ role: "implement", background: true, candidates })).toMatchObject({
  strategy: "inherit_parent",
  candidateId: "parent",
});
expect(() => router.select({ role: "repair", background: true, candidates: [foregroundOnly] }))
  .toThrow(/eligible backend/u);
```

- [ ] **Step 6: Implement provider-neutral eligibility and parent fallback**

```ts
export interface AgentBackendCandidate {
  readonly id: string;
  readonly pin: SessionBackendPin;
  readonly parent: boolean;
  readonly roles: readonly TeamRunRole[];
  readonly executionModes: readonly AgentExecutionMode[];
  readonly permissionModes: readonly AgentPermissionMode[];
  readonly hostTools: boolean;
  readonly background: boolean;
  readonly ready: boolean;
}

export class AgentBackendRouter {
  select(input: AgentBackendRouteInput): AgentBackendRouteDecision {
    const eligible = input.candidates.filter((candidate) =>
      candidate.ready && candidate.hostTools &&
      candidate.executionModes.includes(input.executionMode) &&
      (!input.background || candidate.background));
    const selected = eligible.find((candidate) => !candidate.parent) ??
      eligible.find((candidate) => candidate.parent);
    if (selected === undefined) throw new ToolError("tool_unavailable", "No eligible agent backend");
    return {
      strategy: selected.parent ? "inherit_parent" : "role_candidate",
      candidateId: selected.id,
      reason: selected.parent ? "parent_fallback" : "eligible_role_candidate",
      pin: selected.pin,
    };
  }
}
```

- [ ] **Step 7: Write red tests and thread trusted routing into child creation**

```ts
const result = await manager.delegate(task, context, {
  backend: { decision: routedDecision },
});
const child = await sessions.loadState(result.metadata.childSessionId);
expect(child.backend.pin).toEqual(routedDecision.pin);
expect(child.agent.backend.strategy).toBe("policy_route");
expect(child.agent.permissions.permissionMode).toBe(parent.permissionMode);
expect(child.agent.depth).toBe(1);
```

Make `AgentBackendSelection` a discriminated union and add an exact
`policy_route` member containing the stable candidate ID and reason as well as
adapter/connection/model IDs. Add an internal-only `backend` member to
`ChildDelegationOptions`; it carries the router's authenticated, frozen
decision. The manager asks the injected router to validate provenance and
checks role/profile, execution mode, permission mode, candidate ID, and the
complete immutable pin. The session validator accepts the routed child's pin
while still requiring descriptor adapter/connection/model IDs to equal it.
Default calls continue to inherit the parent exactly.

- [ ] **Step 8: Run contract, profile, router, child, and session validator tests**

Run: `npx vitest run packages/contracts/test/agents.test.ts packages/contracts/test/team-runs.test.ts packages/core/test/agent-backend-router.test.ts packages/core/test/agent-profile.test.ts packages/core/test/child-agent-manager.test.ts packages/core/test/session-v2.test.ts packages/core/test/session-runtime-records.test.ts packages/core/test/team-agent-manager.test.ts packages/cli/test/session-commands.test.ts`

Expected: PASS with historical v1-v3 snapshots unchanged, the v3 default and
unqualified display-name behavior preserved until Task 6, exact v4 IDs
available, and legacy team execution rejecting v4 before side effects.

- [ ] **Step 9: Commit**

```bash
git add packages/contracts packages/core/src/agent-backend-router.ts packages/core/test/agent-backend-router.test.ts packages/core/src/child-agent-manager.ts packages/core/test/child-agent-manager.test.ts packages/core/src/session-record-validator.ts packages/core/test/session-runtime-records.test.ts packages/core/src/agent-profile.ts packages/core/src/index.ts
git commit -m "feat: add versioned team runtime policy contracts"
```

### Task 3: Implement the strict durable team journal

**Files:**
- Create: `packages/core/src/team-run-state.ts`
- Create: `packages/core/src/jsonl-team-run-store.ts`
- Create: `packages/core/test/team-run-state.test.ts`
- Create: `packages/core/test/jsonl-team-run-store.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `TeamRunDescriptor`, `ProviderUsage`, `acquireSessionLock()`.
- Produces: `TeamRunRecord`, `TeamRunState`, `JsonlTeamRunStore.create/append/load/list`.

**Architecture-audit corrections:**

- The store is policy-free and never decides that an owner process died.
  Process ownership and restart reconciliation belong to the supervisor, which
  holds a distinct per-run owner lock for the full active lifetime. A busy lock
  means another live Recurs process owns the run; only a reclaimed lock may be
  reconciled.
- Persist child reservation before launch, then terminal outcome separately.
  The reservation owns attempt/agent/session IDs, correlation, and request
  allowance so a crash cannot lose a started child or its budget.
- Persist worker and staged-candidate artifact links explicitly. Raw patch
  bodies remain outside the journal.
- Claims use monotonically increasing epochs so an interrupted run can be
  resumed by a new owner. `interrupted` is resumable; true terminal outcomes
  are not.
- Journal only a bounded `CheckpointRef` (`id`, `sessionId`, `toolCallId`), not
  the checkpoint's full file manifest. Include both `apply_reset` and
  `apply_committed` so prepared-apply recovery can converge truthfully.
- Torn-tail repair happens only while holding the append lock and truncates to
  the last validated byte offset. Middle corruption, a complete invalid final
  record, sequence gaps, and illegal transitions fail closed.

- [ ] **Step 1: Write reducer red tests for every legal and illegal transition**

```ts
const created = reduceTeamRunRecords([teamCreatedRecord()]);
expect(created.status).toBe("created");
expect(() => reduceTeamRunRecord(created, phaseStarted("review"))).toThrow(/implement/u);
const interrupted = reduceTeamRunRecord(running, runInterrupted("process_restart"));
expect(interrupted.status).toBe("interrupted");
expect(() => reduceTeamRunRecord(interrupted, runApproved())).toThrow(/terminal/u);
```

- [ ] **Step 2: Run reducer tests and verify missing-module failure**

Run: `npx vitest run packages/core/test/team-run-state.test.ts`

Expected: FAIL because the team state reducer is absent.

- [ ] **Step 3: Implement exact records and reducer**

```ts
export type TeamRunRecordInput =
  | { readonly type: "run_claimed"; readonly ownerId: string; readonly claimEpoch: number; readonly at: string }
  | { readonly type: "phase_started"; readonly phase: TeamRunPhase; readonly round: number; readonly at: string }
  | { readonly type: "child_reserved"; readonly child: TeamRunChildReservation; readonly at: string }
  | { readonly type: "child_finished"; readonly child: TeamRunChildRecord; readonly at: string }
  | { readonly type: "artifact_linked"; readonly artifact: TeamRunArtifactLink; readonly at: string }
  | { readonly type: "review_recorded"; readonly review: TeamRunReviewRecord; readonly at: string }
  | { readonly type: "candidate_ready"; readonly artifact: GitPatchArtifactHandle; readonly changedFiles: readonly string[]; readonly at: string }
  | { readonly type: "apply_prepared"; readonly checkpoint: CheckpointRef; readonly at: string }
  | { readonly type: "apply_reset"; readonly reason: "clean_base"; readonly at: string }
  | { readonly type: "apply_committed"; readonly checkpoint: CheckpointRef; readonly changedFiles: readonly string[]; readonly at: string }
  | { readonly type: "run_terminal"; readonly status: TeamRunTerminalStatus; readonly outcome: TeamRunOutcome; readonly at: string }
  | { readonly type: "cancel_requested"; readonly reason: string; readonly at: string }
  | { readonly type: "run_interrupted"; readonly reason: string; readonly manualAttentionRequired: boolean; readonly at: string };

export interface TeamRunChildReservation {
  readonly attemptId: string;
  readonly role: TeamRunRole;
  readonly index: number;
  readonly round: number;
  readonly childAgentId: string;
  readonly childSessionId: string;
  readonly requestAllowance: number;
}

export interface TeamRunChildRecord {
  readonly attemptId: string;
  readonly status: "completed" | "failed" | "cancelled";
  readonly usage: ProviderUsage | null;
  readonly usageSource: "provider" | "runtime" | "unavailable";
  readonly changedFiles: readonly string[];
  readonly evidence: readonly string[];
  readonly failure: { readonly code: string; readonly message: string } | null;
}

export interface TeamRunArtifactLink {
  readonly kind: "worker" | "staged_candidate";
  readonly handle: GitPatchArtifactHandle;
  readonly round: number;
  readonly attemptId: string | null;
}

export interface CheckpointRef {
  readonly id: string;
  readonly sessionId: string;
  readonly toolCallId: string;
}

export interface TeamRunReviewRecord {
  readonly round: number;
  readonly verdict: "approved" | "changes_requested" | "unverified";
  readonly findings: readonly TeamReviewFinding[];
  readonly evidence: readonly string[];
}

export interface TeamRunOutcome {
  readonly changedFiles: readonly string[];
  readonly evidence: readonly string[];
  readonly failure: { readonly code: string; readonly message: string } | null;
}
```

The reducer must require exact sequence increments, matching run IDs, monotonic
rounds/counters, legal predecessor phases, bounded arrays/text, one claim owner,
and immutable descriptor/policy/base/backend fields.

- [ ] **Step 4: Write store red tests for permissions, fsync replay, fencing, corruption, and partial-tail recovery**

```ts
await store.create(descriptor, at);
await store.append(descriptor.id, { type: "run_claimed", ownerId: "owner-1", at });
expect((await store.load(descriptor.id)).lastSequence).toBe(1);
await expect(store.append(descriptor.id, staleInput, 0)).rejects.toMatchObject({ code: "session_conflict" });
expect((await stat(logPath)).mode & 0o777).toBe(0o600);
```

- [ ] **Step 5: Implement the JSONL store with the existing lock primitive**

```ts
export class JsonlTeamRunStore {
  constructor(readonly directory: string) {}
  create(descriptor: TeamRunDescriptor, at: string): Promise<TeamRunState>;
  append(runId: string, expectedSequence: number, input: TeamRunRecordInput): Promise<TeamRunState>;
  load(runId: string): Promise<TeamRunState>;
  list(parentSessionId?: string): Promise<readonly TeamRunListEntry[]>;
}
```

Each append acquires `acquireSessionLock(directory, runId)`, reloads and checks
the exact expected sequence, appends one validated JSON line with mode `0o600`,
syncs the file, releases the lock, and returns the reduced state. Loading a
possibly torn log for repair also holds the same lock; a non-newline-terminated
partial final line is truncated and synced only when every preceding record
validates. Validate pre-existing directory/file type, containment, and private
permissions rather than trusting `mkdir({ mode })` to repair them.

- [ ] **Step 6: Run store and existing session-store tests**

Run: `npx vitest run packages/core/test/team-run-state.test.ts packages/core/test/jsonl-team-run-store.test.ts packages/core/test/session-v2.test.ts packages/core/test/session-runtime-records.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/team-run-state.ts packages/core/src/jsonl-team-run-store.ts packages/core/test/team-run-state.test.ts packages/core/test/jsonl-team-run-store.test.ts packages/core/src/index.ts
git commit -m "feat: add durable team run journal"
```

### Task 4: Persist patch artifacts and stage candidates outside the parent

**Files:**
- Create: `packages/core/src/file-git-patch-artifact-store.ts`
- Create: `packages/core/test/file-git-patch-artifact-store.test.ts`
- Modify: `packages/core/src/git-patch-artifacts.ts`
- Modify: `packages/core/test/git-patch-artifacts.test.ts`
- Modify: `packages/core/src/git-worktree-leases.ts`
- Modify: `packages/core/test/git-worktree-leases.test.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/tools/src/checkpoints.ts`
- Modify: `packages/tools/test/checkpoints.test.ts`

**Interfaces:**
- Consumes: current patch validation, worktree lease, checkpoint store.
- Produces: `GitPatchArtifactStore`, `FileGitPatchArtifactStore`, async discard, `stage()`, dedicated v4 apply primitive, stale-worktree reconciliation.

**Architecture-audit corrections:**

- Use a literal content-addressed layout: immutable
  `objects/<sha256>.patch` plus atomic versioned `refs/<artifact-id>.json`.
  Publish and fsync the object before its ref. Ref removal is idempotent; blob
  garbage collection is deferred.
- The ref binds the complete handle, canonical repository, and bounded exact
  after-state fingerprints for every changed/deleted path. Recovery compares
  those fingerprints without mutating the index or recapturing an unknown
  workspace.
- Keep legacy v3 `integrate()` behavior intact. Add a dedicated one-candidate
  v4 prepare/apply pair so the supervisor can order checkpoint-before, durable
  `apply_prepared`, mutation, idempotent checkpoint completion, durable
  `apply_committed`, then best-effort event and artifact cleanup. A journal
  failure after mutation is recoverable prepared state, not an ordinary patch
  conflict. Add an idempotent checkpoint `complete(ref, cwd)` operation that
  returns an already-completed exact checkpoint and rejects mismatched, undone,
  or corrupt state.
- Worktree leases hold a separate owner lock for their full lifetime. Stale
  recovery must attempt that lock and skip a live/busy owner; an in-memory set
  from a new process is not proof that a lease is stale. Expose
  `assertActive(lease)` and require it before staging/apply.

- [ ] **Step 1: Write file-store red tests**

```ts
await store.put({ handle, repositoryRoot, patch });
expect(await store.load(handle)).toEqual({ handle, repositoryRoot, patch });
await writeFile(patchPath, `${patch}tamper`);
await expect(store.load(handle)).rejects.toThrow(/integrity/u);
expect((await stat(patchPath)).mode & 0o777).toBe(0o600);
```

- [ ] **Step 2: Run the test and verify the missing-store failure**

Run: `npx vitest run packages/core/test/file-git-patch-artifact-store.test.ts`

Expected: FAIL because the store does not exist.

- [ ] **Step 3: Implement an exact file-backed store port**

```ts
export interface StoredGitPatchArtifact {
  readonly handle: GitPatchArtifactHandle;
  readonly repositoryRoot: string;
  readonly patch: string;
}

export interface GitPatchArtifactStore {
  put(artifact: StoredGitPatchArtifact): Promise<void>;
  load(handle: GitPatchArtifactHandle): Promise<StoredGitPatchArtifact>;
  remove(handles: readonly GitPatchArtifactHandle[]): Promise<void>;
}
```

Use the content-addressed object/ref layout above, atomic temporary-file rename,
strict JSON metadata, mode `0o600`, canonical repository paths, and
SHA/length/path/result-fingerprint checks on every load. Keep an in-memory
implementation as the default for existing tests.

- [ ] **Step 4: Write staging and two-phase apply red tests**

```ts
const staged = await manager.stage({ lease: stagingLease, artifacts: [a, b], signal });
expect(staged.changedFiles).toEqual(["a.ts", "b.ts"]);
expect(await gitStatus(parentRoot)).toBe("");

await manager.integrate({
  base,
  artifacts: [candidate],
  sessionId,
  operationId,
  checkpoints,
  signal,
  onPrepared: async (checkpoint) => observed.push(checkpoint),
});
expect(observed).toHaveLength(1);
```

- [ ] **Step 5: Add `stage`, persistent loading, and apply hooks**

```ts
export interface GitPatchStageInput {
  readonly lease: GitWorktreeLease;
  readonly artifacts: readonly GitPatchArtifactHandle[];
  readonly signal: AbortSignal;
}

stage(input: GitPatchStageInput): Promise<{ readonly changedFiles: readonly string[] }>;
discard(handles: readonly GitPatchArtifactHandle[]): Promise<void>;

prepareCandidateApply(input: GitPatchCandidatePrepareInput): Promise<CheckpointRef>;
applyCandidate(input: GitPatchCandidateApplyInput): Promise<GitPatchCandidateApplyOutcome>;
```

`stage` validates ownership/base/path/hash exactly like parent integration,
applies in input order only to the supplied owned staging lease, verifies the
complete dirty path set after every apply, and leaves the parent clean. Do not
delete artifacts before durable commit/explicit discard. `applyCandidate`
performs only the mutation and exact after-state validation after a matching
prepared checkpoint; the supervisor calls the checkpoint store's idempotent
completion and appends `apply_committed`. Neither method owns journal appends or
presentation events.

- [ ] **Step 6: Add stale worktree reconciliation red/green tests**

```ts
const recovered = await manager.recoverStale({ repositoryRoot });
expect(recovered.removedLeaseIds).toEqual([orphan.id]);
expect(await pathExists(orphan.worktreeRoot)).toBe(false);
```

Reconcile only children directly under the configured private root. Verify each
target's ID, `lstat` directory/non-symlink type, basename/realpath containment,
and exact Git worktree registration before attempting its owner lock. Skip a
busy live lease; force-remove only a safely reclaimed dead lease. Never accept
an arbitrary caller path.

- [ ] **Step 7: Run patch, worktree, and checkpoint suites**

Run: `npx vitest run packages/core/test/file-git-patch-artifact-store.test.ts packages/core/test/git-patch-artifacts.test.ts packages/core/test/git-worktree-leases.test.ts packages/tools/test/checkpoints.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/file-git-patch-artifact-store.ts packages/core/src/git-patch-artifacts.ts packages/core/src/git-worktree-leases.ts packages/core/src/index.ts packages/core/test/file-git-patch-artifact-store.test.ts packages/core/test/git-patch-artifacts.test.ts packages/core/test/git-worktree-leases.test.ts packages/tools/src/checkpoints.ts packages/tools/test/checkpoints.test.ts
git commit -m "feat: persist and stage team patch artifacts"
```

### Task 5: Add strict review-v2 findings and bounded repair prompts

**Files:**
- Modify: `packages/core/src/agent-review-panel.ts`
- Modify: `packages/core/test/agent-review-panel.test.ts`
- Modify: `packages/core/src/agent-profile.ts`
- Modify: `packages/core/test/child-agent-manager.test.ts`

**Interfaces:**
- Consumes: v4 profiles/policies and `ChildAgentManager.delegate()`.
- Produces: `parseAgentReviewVerdictV2()`, workspace-aware review options, `repairPrompt()`.

- [ ] **Step 1: Write strict parser red tests**

```ts
expect(parseAgentReviewVerdictV2(JSON.stringify({
  verdict: "request_changes",
  summary: "Null branch is unsafe",
  findings: [{ path: "src/a.ts", problem: "Null dereference", acceptance: "Guard null", evidence: ["src/a.ts:42"] }],
  evidence: ["src/a.ts:42"],
})).findings).toHaveLength(1);
expect(() => parseAgentReviewVerdictV2(approveWithFinding)).toThrow(/verdict contract/u);
expect(() => parseAgentReviewVerdictV2(requestChangesWithoutFinding)).toThrow(/verdict contract/u);
```

- [ ] **Step 2: Run parser/panel tests and verify failure**

Run: `npx vitest run packages/core/test/agent-review-panel.test.ts`

Expected: FAIL because review v2 is absent.

- [ ] **Step 3: Implement exact review-v2 parsing and staged-workspace delegation**

```ts
export interface AgentReviewVerdictV2 extends AgentReviewVerdict {
  readonly findings: readonly TeamReviewFinding[];
}

export interface AgentReviewPanelRunOptions {
  readonly contract?: "v1" | "v2";
  readonly workspace?: { readonly cwd: string; readonly descriptor: AgentGitWorktreeWorkspace };
  readonly team?: { readonly id: string; readonly indexOffset: number; readonly round: number };
}
```

For contract v2, delegate `review_v2` with the supplied staging cwd/workspace.
Bound output to 16 KiB, at most 12 findings, at most 8 evidence items per
finding, safe relative paths or `*`, and exact keys. Preserve v1 parser behavior.
Panel precedence is fail-closed: any invalid or failed required reviewer makes
the panel `unverified`; only an otherwise entirely valid panel containing at
least one valid change request becomes `changes_requested`; approval requires
all valid approvals and zero findings. Invalid review never triggers Repair.

- [ ] **Step 4: Write and implement deterministic repair prompt tests**

```ts
const prompt = repairPrompt({ objective, changedFiles, findings, round: 1, maximumRounds: 1 });
expect(prompt).toContain("Repair round 1 of 1");
expect(prompt).toContain(JSON.stringify(findings));
expect(prompt.length).toBeLessThanOrEqual(32_768);
```

The prompt instructs `repair_v1` to change only the staged candidate, satisfy
each acceptance condition, avoid delegation/process/network use, and return
changed-file/evidence handoff. Reject oversized aggregate findings before child
creation.

- [ ] **Step 5: Run review, profile, and child suites**

Run: `npx vitest run packages/core/test/agent-review-panel.test.ts packages/core/test/child-agent-manager.test.ts packages/contracts/test/agents.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/agent-review-panel.ts packages/core/test/agent-review-panel.test.ts packages/core/src/agent-profile.ts packages/core/test/child-agent-manager.test.ts
git commit -m "feat: add structured team review and repair contracts"
```

### Task 6: Build the durable foreground supervisor vertical

**Files:**
- Create: `packages/core/src/team-run-supervisor.ts`
- Create: `packages/core/test/team-run-supervisor.test.ts`
- Modify: `packages/core/src/team-agent-manager.ts`
- Modify: `packages/core/test/team-agent-manager.test.ts`
- Modify: `packages/core/src/events.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: team store, patch store/staging, worktrees, children, review panel, router, checkpoints.
- Produces: `TeamRunSupervisor.startForeground()`, v4 delegation path, durable normalized events.

- [ ] **Step 1: Write foreground red tests for staged approval and no-parent-change failures**

```ts
const result = await supervisor.startForeground(request, context);
expect(result.status).toBe("approved");
expect(result.repairRounds).toBe(0);
expect(await readFile(parentFile, "utf8")).toBe("new\n");
expect((await store.load(result.teamId)).status).toBe("approved");

const failed = await supervisor.startForeground(conflictingRequest, context);
expect(failed.status).toBe("failed");
expect(await gitStatus(parentRoot)).toBe("");
```

- [ ] **Step 2: Run supervisor tests and verify missing-module failure**

Run: `npx vitest run packages/core/test/team-run-supervisor.test.ts`

Expected: FAIL because the supervisor does not exist.

- [ ] **Step 3: Implement one authoritative execution pipeline**

```ts
export class TeamRunSupervisor {
  startForeground(input: DelegateTeamInput, context: ToolContext): Promise<TeamRunResult>;
  startBackground(input: DelegateTeamInput, context: ToolContext): Promise<TeamRunSnapshot>;
  inspect(parentSessionId: string, runId: string): Promise<TeamRunSnapshot>;
  list(parentSessionId: string): Promise<readonly TeamRunSnapshot[]>;
  wait(parentSessionId: string, runId: string, timeoutMs: number, signal: AbortSignal): Promise<TeamRunSnapshot>;
  cancel(parentSessionId: string, runId: string, reason: string): Promise<TeamRunSnapshot>;
  resume(parentSessionId: string, runId: string, context: ToolContext): Promise<TeamRunSnapshot>;
  apply(parentSessionId: string, runId: string, context: ToolContext): Promise<TeamRunSnapshot>;
}
```

The private pipeline must persist creation before starting children, reserve the
complete worst-case v4 envelope, route every role, create all Implement siblings
through `ChildAgentManager`, stage artifacts in input order, review with v2, run
at most the frozen repair rounds, capture one cumulative candidate, and apply it
only for foreground approved runs. Use the lowest failed input index as the
canonical failure. Release every reachable worktree in `finally`.

- [ ] **Step 4: Write repair-loop red tests**

```ts
const repaired = await runWithReviewSequence(["request_changes", "approve"]);
expect(repaired.status).toBe("approved");
expect(repaired.repairRounds).toBe(1);
expect(repaired.children.every((child) => child.depth === 1)).toBe(true);

const exhausted = await runWithReviewSequence(["request_changes", "request_changes"]);
expect(exhausted.status).toBe("changes_requested");
expect(await gitStatus(parentRoot)).toBe("");
```

- [ ] **Step 5: Implement bounded repair and accounting**

Before each new child, read journal cancellation and verify remaining child,
request, and reported-cost admission. Each Repair is a new `repair_v1` child in
the staging workspace, then review round increments. Invalid/failed review
becomes `unverified` without Repair. Aggregate provider usage with optional
fields; keep cost `null` until at least one provider reports it and record which
children lacked cost telemetry.

- [ ] **Step 6: Route v4 `delegate_team` through the supervisor**

```ts
const policy = getOperatingModePolicy(parent.agent.operatingMode.id);
if (policy.version >= 4) {
  return input.execution === "background"
    ? this.dependencies.supervisor.startBackground(input, context)
    : this.dependencies.supervisor.startForeground(input, context);
}
return this.delegateLegacyV3(input, context);
```

Keep foreground as the default parser value and preserve strict v3 input
acceptance. Add normalized journal-sequence/phase/round events without prompts,
patches, or worktree paths; publish them best-effort after durable transitions.
Once this routing is fully wired and the focused v4 path is green, change
`DEFAULT_OPERATING_MODE_ID` to `balanced_v4` and make unqualified operating-mode
display names resolve to v4 in the same commit. Existing v1-v3 IDs and replay
records remain unchanged.

- [ ] **Step 7: Run supervisor, legacy team, child, review, patch, and event tests**

Run: `npx vitest run packages/core/test/team-run-supervisor.test.ts packages/core/test/team-agent-manager.test.ts packages/core/test/child-agent-manager.test.ts packages/core/test/agent-review-panel.test.ts packages/core/test/git-patch-artifacts.test.ts`

Expected: PASS with v3 tests unchanged and v4 parent unchanged on every non-approved result.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/team-run-supervisor.ts packages/core/test/team-run-supervisor.test.ts packages/core/src/team-agent-manager.ts packages/core/test/team-agent-manager.test.ts packages/core/src/events.ts packages/core/src/index.ts
git commit -m "feat: add durable staged team supervisor"
```

### Task 7: Add background ownership and model/CLI controls

**Files:**
- Modify: `packages/core/src/team-run-supervisor.ts`
- Modify: `packages/core/test/team-run-supervisor.test.ts`
- Create: `packages/core/src/team-run-tools.ts`
- Create: `packages/core/test/team-run-tools.test.ts`
- Modify: `packages/cli/src/commands/types.ts`
- Modify: `packages/cli/src/commands/agents.ts`
- Modify: `packages/cli/src/commands/create.ts`
- Modify: `packages/cli/test/commands.test.ts`
- Modify: `packages/cli/src/assembly.ts`
- Modify: `packages/cli/test/assembly.test.ts`

**Interfaces:**
- Consumes: `TeamRunSupervisor` control methods and CLI invocation context.
- Produces: process-lifetime background scheduling, scoped status/wait/cancel/resume/apply model tools and `/agents` subcommands.

- [ ] **Step 1: Write background lifecycle red tests**

```ts
const started = await supervisor.startBackground(request, fullAccessContext);
expect(started.status).toBe("running");
const ready = await supervisor.wait(parentId, started.id, 30_000, signal);
expect(ready.status).toBe("ready_to_apply");
expect(await gitStatus(parentRoot)).toBe("");
const applied = await supervisor.apply(parentId, started.id, fullAccessContext);
expect(applied.status).toBe("approved");
```

Also assert background denial for non-`full_access`, remote/scripted invocation,
agent-runtime pins, and billing sources outside `local_compute`/`metered_api`.

- [ ] **Step 2: Implement active handles and bounded waits**

```ts
interface ActiveTeamRun {
  readonly controller: AbortController;
  readonly settled: Promise<void>;
}

readonly #active = new Map<string, ActiveTeamRun>();
```

Start stores the handle before returning. `wait` accepts 0-30,000 ms and returns
the latest snapshot on timeout without consuming it. `cancel` returns typed
truth for requested/already-terminal/not-found and aborts a local controller.
Every async pipeline catches its own rejection, journals a safe terminal, and
never creates an unhandled rejection.

- [ ] **Step 3: Write exact model-tool schema tests**

```ts
expect(toolNames).toEqual(expect.arrayContaining([
  "team_status", "wait_team", "cancel_team", "resume_team", "apply_team",
]));
await expect(invoke("apply_team", { id: foreignId }, otherParent)).rejects.toMatchObject({ code: "not_found" });
```

- [ ] **Step 4: Implement small scoped control tools**

```ts
export function createTeamRunTools(supervisor: TeamRunSupervisor): readonly Tool[];
```

Use exact `{ id }`, `{ id, timeoutMs }`, or `{ id, reason }` schemas, bounded
text, exact parent ownership, `in_process` execution, and truthful structured
metadata. Only `apply_team` is mutating; `resume_team` may start background work
but never mutates the parent.

- [ ] **Step 5: Write CLI command red tests**

```ts
expect(await runAgents("teams")).toContain("ready_to_apply");
expect(await runAgents(`team ${id}`)).toContain(`Team run: ${id}`);
expect(await runAgents(`wait ${id}`)).toContain("approved");
expect(await runAgents(`apply ${foreign}`)).toContain("not found");
```

- [ ] **Step 6: Inject control into command context and render concise activity**

Extend `CommandDependencies` with a narrow `teamRuns` control port and extend
`CommandContext` with the current trusted `HostInvocation` so resume can mint
fresh authorization. Add `/agents teams|team|wait|cancel|resume|apply` without
exposing prompts, patch hashes, worktree paths, or account data. The list shows
status, phase, round, child counts, known usage/cost, updated time, and exact ID.

- [ ] **Step 7: Run core tool, CLI command, runtime, and assembly tests**

Run: `npx vitest run packages/core/test/team-run-supervisor.test.ts packages/core/test/team-run-tools.test.ts packages/cli/test/commands.test.ts packages/cli/test/runtime.test.ts packages/cli/test/assembly.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/team-run-supervisor.ts packages/core/test/team-run-supervisor.test.ts packages/core/src/team-run-tools.ts packages/core/test/team-run-tools.test.ts packages/cli/src/commands packages/cli/src/assembly.ts packages/cli/test/commands.test.ts packages/cli/test/assembly.test.ts
git commit -m "feat: add background team controls"
```

### Task 8: Reconcile restart, apply crashes, and stale owned resources

**Files:**
- Modify: `packages/core/src/team-run-supervisor.ts`
- Modify: `packages/core/test/team-run-supervisor.test.ts`
- Modify: `packages/core/src/jsonl-team-run-store.ts`
- Modify: `packages/core/test/jsonl-team-run-store.test.ts`
- Modify: `packages/core/src/git-patch-artifacts.ts`
- Modify: `packages/core/test/git-patch-artifacts.test.ts`
- Modify: `packages/core/src/jsonl-session-store.ts`
- Modify: `packages/core/test/session-runtime-records.test.ts`
- Modify: `packages/cli/src/assembly.ts`
- Modify: `packages/cli/test/assembly.test.ts`

**Interfaces:**
- Consumes: `apply_prepared` checkpoint, cumulative candidate, child sessions, private worktree root.
- Produces: `TeamRunSupervisor.recover()`, exact apply reconciliation, interrupted child terminalization, startup wiring.

- [ ] **Step 1: Write restart red tests for running and stable states**

```ts
await store.forceState(runningReviewState);
const recovered = await restartedSupervisor.recover(now);
expect(recovered[0]?.status).toBe("interrupted");

await store.forceState(readyToApplyState);
await restartedSupervisor.recover(now);
expect((await store.load(id)).status).toBe("ready_to_apply");
```

- [ ] **Step 2: Implement conservative startup recovery**

`recover()` first reconciles private stale worktrees, then marks every `created`,
`running`, or non-mutating `applying` record from a dead owner as `interrupted`.
It preserves `ready_to_apply` and terminals. It terminalizes owned child sessions
still `ready`/`running` with `turn_interrupted` or `agent_run_cancelled`; it never
reuses them. Resume verifies the original parent, exact cwd/base/backend/policy,
clean Git state, current `full_access` permission, and fresh trusted invocation before
launching new sibling attempts.

- [ ] **Step 3: Write apply-preparation crash red tests**

```ts
await simulateCrashAfterPrepared({ parentDiff: "clean" });
expect((await recover()).status).toBe("ready_to_apply");

await simulateCrashAfterPrepared({ parentDiff: "exact_candidate" });
expect((await recover()).status).toBe("approved");

await simulateCrashAfterPrepared({ parentDiff: "foreign_change" });
expect((await recover()).manualAttentionRequired).toBe(true);
```

- [ ] **Step 4: Add canonical workspace/candidate comparison and idempotent apply recovery**

```ts
compareWorkspace(input: {
  readonly base: GitPatchBase;
  readonly artifact: GitPatchArtifactHandle;
  readonly signal: AbortSignal;
}): Promise<"clean_base" | "exact_candidate" | "other">;
```

Generate the same bounded full-index, no-rename, no-textconv patch used at
capture; compare paths, bytes, and digest. For `clean_base`, append back to
`ready_to_apply`. For `exact_candidate`, complete/capture the checkpoint and
append approved. For `other`, append interrupted/manual attention and retain the
artifact/checkpoint; never restore or overwrite unknown user work automatically.

- [ ] **Step 5: Add startup assembly ordering tests**

```ts
expect(order).toEqual([
  "recover-team-runs",
  "recover-child-sessions",
  "select-root-session",
  "register-tools",
]);
```

Assembly constructs stores/managers, runs recovery before accepting prompts,
then selects only the canonical parent session. Recovery failures produce one
safe startup error rather than silently proceeding with stale running state.

- [ ] **Step 6: Run recovery, store, patch, session, and assembly suites**

Run: `npx vitest run packages/core/test/team-run-supervisor.test.ts packages/core/test/jsonl-team-run-store.test.ts packages/core/test/git-patch-artifacts.test.ts packages/core/test/session-runtime-records.test.ts packages/cli/test/assembly.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/team-run-supervisor.ts packages/core/test/team-run-supervisor.test.ts packages/core/src/jsonl-team-run-store.ts packages/core/test/jsonl-team-run-store.test.ts packages/core/src/git-patch-artifacts.ts packages/core/test/git-patch-artifacts.test.ts packages/core/src/jsonl-session-store.ts packages/core/test/session-runtime-records.test.ts packages/cli/src/assembly.ts packages/cli/test/assembly.test.ts
git commit -m "feat: recover interrupted team workflows"
```

### Task 9: Prove the real engine path end to end

**Files:**
- Modify: `tests/e2e/coding-agent.test.ts`
- Modify: `packages/cli/test/render.test.ts`
- Modify: `packages/cli/test/runtime.test.ts`

**Interfaces:**
- Consumes: assembled scripted direct provider, real coordinator/tools/sessions/worktrees/store/supervisor.
- Produces: complete foreground repair and background apply proof.

- [ ] **Step 1: Add a foreground review-repair-approve E2E test**

The scripted parent calls `delegate_team`; two v4 Implement children edit
disjoint files; the first review returns one structured finding; one Repair child
fixes it in staging; the second review approves; the parent synthesizes. Assert:

```ts
expect(result.finalText).toContain("team approved");
expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
  "agent_team_started", "agent_team_repair_started", "agent_team_ready_to_apply", "agent_team_completed",
]));
expect(childStates.every((child) => child.agent.depth === 1)).toBe(true);
expect(await privateWorktreeLeakCount()).toBe(0);
```

- [ ] **Step 2: Run it red, then implement only missing integration wiring**

Run: `npx vitest run tests/e2e/coding-agent.test.ts -t "repairs a staged v4 team before approval"`

Expected before wiring: FAIL at the first absent tool/event/control boundary. After wiring: PASS.

- [ ] **Step 3: Add background ready/wait/apply and restart-resume E2E tests**

Assert background returns before children settle, parent remains clean through
`ready_to_apply`, `/agents team` is durable, explicit apply mutates exactly the
candidate paths, restart preserves ready candidates, active work becomes
interrupted, and resume creates new depth-one sibling IDs under the same team ID.

- [ ] **Step 4: Add security/failure E2E tests**

Cover no-process v4 tool visibility, event-sink failure, patch conflict, dirty
parent apply denial, malformed review no-repair, repair exhaustion, cancellation,
foreign-parent controls, cost/child/request admission, and no prompts/patches/
private paths in JSONL event rendering.

- [ ] **Step 5: Run E2E, render, runtime, and complete targeted orchestration gate**

Run: `npx vitest run tests/e2e/coding-agent.test.ts packages/cli/test/render.test.ts packages/cli/test/runtime.test.ts packages/core/test/team-run-supervisor.test.ts packages/core/test/team-run-tools.test.ts packages/core/test/jsonl-team-run-store.test.ts packages/core/test/agent-review-panel.test.ts packages/core/test/git-patch-artifacts.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/coding-agent.test.ts packages/cli/test/render.test.ts packages/cli/test/runtime.test.ts
git commit -m "test: prove durable team runtime end to end"
```

### Task 10: Update product truth, review, and run the full repository gate

**Files:**
- Modify: `ARCHITECTURE.md`
- Modify: `PRODUCT.md`
- Modify: `SECURITY.md`
- Modify: `README.md`
- Modify: `docs/CLI.md`
- Modify: `docs/README.md`
- Modify: `docs/research/SUBAGENT_HARNESS_COMPARISON.md`
- Modify: `docs/superpowers/plans/2026-07-18-durable-team-runtime-v2.md`

**Interfaces:**
- Consumes: verified implementation and primary-source research.
- Produces: exact product/security/CLI truth and final verification evidence.

- [ ] **Step 1: Document only implemented behavior**

Document v4 policy values, no-process profiles, durable journal, staging,
structured repair, background process-lifetime semantics, explicit apply,
recovery states, commands/tools, routing fallback, accounting limits, and event
privacy. State prominently that there is no daemon, deep recursion, automatic
provider ranking, OS containment, exact unknown-cost enforcement, auto-commit,
push, deploy, desktop company UI, or released distribution.

- [ ] **Step 2: Update official harness research**

Add the verified official-source patterns from current Codex, OpenCode, Grok
Build, Goose, Kilo, and Pi: durable parent edges, bounded wait/cancel/resume,
process-local background ownership caveats, restart reconciliation, role/model
selection, and bounded skeptic/repair patterns. Cite commit-pinned official URLs
and distinguish source facts from Recurs decisions.

- [ ] **Step 3: Self-review docs and source truth**

Run:

```bash
rg -n "foreground-only|version-3|no auto-repair|background.*absent|review.*run_verification" README.md PRODUCT.md ARCHITECTURE.md SECURITY.md docs
git diff --check
```

Expected: no stale current-state claims and no whitespace errors.

- [ ] **Step 4: Run the strongest TypeScript gate**

Run: `npm run check`

Expected: generated checks, lint, type checks, every Vitest file, build, native engine-bundle smoke, bridge smoke, and doctor smoke pass.

- [ ] **Step 5: Run native verification proportionate to the unchanged native surface**

Run: `npm run native:build && npm run native:lint-resources && npm run native:smoke`

Then run the known-good Swift suite excluding only the three unchanged host-
blocked controlling-PTY suites documented in the previous milestone. If the host
behavior changes, run full `npm run check:native`; never claim a blocked suite
passed.

- [ ] **Step 6: Inspect status, full diff, dependencies, and secrets**

Run:

```bash
git status --short --branch
git diff --stat 4ca0aa9...HEAD
git diff --check 4ca0aa9...HEAD
git diff --name-only 4ca0aa9...HEAD
rg -n --hidden -g '!node_modules' -g '!.git' -g '!.worktrees' '(BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|api[_-]?key\s*[:=]|password\s*[:=]|secret\s*[:=])' .
```

Confirm no `.env`, credential, key, certificate, local registry, worktree,
dependency, or generated machine-state file changed unexpectedly.

- [ ] **Step 7: Perform task and whole-branch reviews, fix every Critical/Important finding, and re-run covering tests**

Use the review-package workflow with merge base `4ca0aa9`. The final reviewer
must check spec coverage, crash/cancellation truth, permission monotonicity,
background parent isolation, accounting bounds, journal corruption behavior,
and CLI/product honesty.

- [ ] **Step 8: Commit documentation and verification evidence**

```bash
git add ARCHITECTURE.md PRODUCT.md SECURITY.md README.md docs
git commit -m "docs: document durable team runtime v2"
```

- [ ] **Step 9: Fast-forward local main without pushing**

After the feature branch is clean and fully verified, switch to the clean main
worktree, run `git merge --ff-only codex/durable-team-runtime-v2`, rerun the
focused post-merge gate, and confirm `git status --short --branch`. Do not push.
