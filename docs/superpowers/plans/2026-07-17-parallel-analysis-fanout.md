# Parallel Analysis and Review Fan-Out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:executing-plans` and `superpowers:test-driven-development` to
> implement this plan task by task. Every behavior change follows
> RED/GREEN/REFACTOR and every coherent slice receives a focused commit.

**Goal:** Add the first production-quality Recurs-owned parallel orchestration
primitive: one parent can delegate a bounded batch of Explore and Review tasks,
run them concurrently in isolated clean Git worktrees, and receive deterministic
results and evidence for synthesis.

**Architecture:** Preserve every persisted version-1 policy and session shape.
New sessions use version-2 operating modes whose stable IDs encode real
concurrency. A host-owned worktree lease manager creates detached worktrees at
the parent's exact `HEAD`, records isolation on each child descriptor, and
removes every lease after completion, failure, or cancellation. A focused batch
manager validates exact input, schedules a bounded worker pool through the
existing `ChildAgentManager` and `BackendRunCoordinator`, shares the parent's
per-turn child/request/reported-cost budget, emits normalized batch and child
events, and returns ordered settled results. The existing sequential
`delegate_task` remains the only Implement path.

**Tech stack:** TypeScript 6, Node.js 22, npm workspaces, Vitest 4, JSONL
session state, the existing provider/runtime/tool/approval seams, and Git 2.45+
protected subprocesses.

## Frozen decisions and boundaries

1. The five `_v1` mode IDs and limits never change. New `_v2` IDs carry real
   concurrency. Display-name parsing selects the latest version; exact old IDs
   remain readable and selectable.
2. New root sessions default to `balanced_v2`. A historical session-created
   record with no agent descriptor reconstructs as `balanced_v1`; replay never
   silently upgrades stored semantics.
3. Version-2 concurrency is Economy 1, Standard 2, Balanced 3, Performance 4,
   and Max 6. Their child-per-run ceilings remain 2/3/4/6/8. Depth remains one
   and automatic retries remain zero.
4. Model selection still inherits the exact pinned backend. Modes change
   orchestration and cost/request envelopes only; they do not claim unavailable
   model routing or hard-code provider brands.
5. A version-2 workflow divides its parent request allowance into immutable
   child allowances. Reservations happen before child startup, so concurrent
   children cannot collectively exceed the parent request ceiling. An opaque
   runtime consumes its full reservation because Recurs cannot observe its
   vendor-internal request count.
6. Reported USD cost remains telemetry-based. A child is not started after the
   known ceiling is reached, and overshoot is reported truthfully, but Recurs
   does not claim a pre-spend guarantee when a provider exposes cost only after
   completion.
7. `delegate_tasks` accepts two or more exact tasks and only the stable Explore
   and Review profiles. Parallel Implement is rejected until Recurs has an
   explicit patch-integration, conflict-resolution, and rollback design.
8. Every batch child gets a detached worktree at the parent's exact `HEAD`.
   The first version fails closed when the parent has staged, unstaged tracked,
   or untracked state because a Git `HEAD` worktree cannot faithfully reproduce
   it. Git-ignored machine-local state does not block a lease and is
   intentionally absent from the child worktree.
9. Worktrees are host-owned under the project's Recurs data directory. Cleanup
   validates exact lease identity and containment, does not trust model input,
   and runs even after cancellation. Cleanup failure is surfaced; success is
   never reported while an owned lease is known to remain.
10. Batch results preserve input order independent of completion order. One
    child failure does not erase successful siblings. Parent cancellation
    cancels active children, prevents queued starts, awaits cleanup, emits a
    cancelled batch event, and fails the tool as cancellation.
11. This milestone adds no background agents, recursive fan-out, dirty-tree
    snapshotting, worktree resume, automatic merge, conflict resolution,
    company UI, desktop UI, or provider/model marketplace.

---

### Task 1: Version operating modes without migrating old sessions

**Files:**

- Modify: `packages/contracts/src/agents.ts`
- Modify: `packages/contracts/test/agents.test.ts`
- Modify: `packages/core/src/session-v2.ts`
- Modify: `packages/core/src/session-record-validator.ts`
- Modify: `packages/core/test/session-v2.test.ts`
- Modify: `packages/core/test/session-runtime-records.test.ts`

**Interfaces:**

- Add `_v2` stable IDs and `OperatingModeVersion = 1 | 2`.
- Add `LEGACY_OPERATING_MODE_ID = "balanced_v1"` and make
  `DEFAULT_OPERATING_MODE_ID = "balanced_v2"`.
- Allow an optional versioned workspace-isolation descriptor on an agent while
  retaining historical descriptors with no workspace field.
- Permit a child request limit to be a positive narrowing of its mode limit;
  root limits must still equal the policy exactly.

- [x] Write failing contract tests for all ten IDs, latest display-name parsing,
  exact old-ID parsing, v1 immutability, v2 concurrency, and frozen policies.
- [x] Write failing session tests proving new roots use v2, descriptor-less old
  logs replay as v1, explicit v1/v2 agents round-trip, malformed workspace
  isolation is rejected, and a child can narrow but never widen requests.
- [x] Run the focused tests and observe RED for the missing v2 contracts.
- [x] Implement versioned policy lookup/parsing, explicit legacy reconstruction,
  and strict backward-compatible descriptor validation.
- [x] Run focused contract/core tests, typecheck, inspect the diff, and commit.

### Task 2: Make the per-parent workflow budget concurrency-safe

**Files:**

- Modify: `packages/tools/src/types.ts`
- Modify: `packages/core/src/agent-profile.ts`
- Modify: `packages/core/src/child-agent-manager.ts`
- Modify: `packages/core/src/events.ts`
- Modify: `packages/core/test/child-agent-manager.test.ts`
- Modify: `packages/core/test/direct-model-executor.test.ts`
- Modify: `packages/core/test/delegated-agent-executor.test.ts`

**Interfaces:**

```ts
interface DelegationBudget {
  readonly maxChildren: number;
  childrenStarted: number;
  readonly maxRequests: number;
  requestsReserved: number;
  requestsUsed: number;
  readonly maxReportedCostUsd: number;
  reportedCostUsd: number;
}
```

- [x] Write failing tests for deterministic request allocation, shared child and
  request reservations, known-cost refusal, concurrent-safe accounting, direct
  request reporting, and opaque-runtime full-reservation accounting.
- [x] Confirm RED against the current child/cost-only budget.
- [x] Add exact budget validation and one atomic synchronous claim before child
  session creation. Version-2 children receive a narrowed immutable request
  allowance; v1 behavior remains compatible.
- [x] Extend normalized workflow usage with request reserved/used values and
  preserve the existing reported-cost semantics.
- [x] Run focused manager/executor tests, typecheck, inspect, and commit.

### Task 3: Add safe host-owned Git worktree leases

**Files:**

- Create: `packages/core/src/git-worktree-leases.ts`
- Create: `packages/core/test/git-worktree-leases.test.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/tools/src/index.ts`

**Interfaces:**

```ts
interface GitWorktreeLease {
  readonly id: string;
  readonly repositoryRoot: string;
  readonly worktreeRoot: string;
  readonly revision: string;
}

interface GitWorktreeLeasePort {
  create(repositoryRoot: string, signal: AbortSignal): Promise<GitWorktreeLease>;
  release(lease: GitWorktreeLease): Promise<void>;
}
```

- [x] Write real temporary-repository tests for exact-HEAD checkout, clean-tree
  enforcement including untracked files, distinct concurrent leases, hostile
  IDs/paths, cancellation before/during creation, partial-create recovery,
  dirty lease cleanup, idempotent release, and truthful cleanup failure.
- [x] Observe RED before the lease manager exists.
- [x] Implement bounded shell-free Git calls through existing protected process
  helpers, strict realpath/containment checks, detached worktree creation, and
  cleanup that ignores the cancelled run signal.
- [x] Run focused real-Git tests and the tools/core suites, inspect, and commit.

### Task 4: Extract one reusable child-run path

**Files:**

- Modify: `packages/core/src/child-agent-manager.ts`
- Modify: `packages/core/test/child-agent-manager.test.ts`

**Interfaces:**

- Expose a production `delegate(...)` path used by both slash-visible tools;
  the public input remains exact and no model, permission, retry, concurrency,
  or background override is added.
- Accept host-derived execution options for child cwd and workspace isolation;
  model input can never supply them.

- [x] Add failing tests that run a child in a supplied host worktree, persist its
  isolation descriptor, route every host tool to that cwd, return evidence, and
  retain the original sequential parent-workspace behavior.
- [x] Refactor the current tool wrapper away from execution mechanics without
  changing existing `delegate_task` behavior or event order.
- [x] Verify all existing child-manager tests remain green, inspect, and commit.

### Task 5: Implement bounded parallel `delegate_tasks`

**Files:**

- Create: `packages/core/src/child-agent-batch.ts`
- Create: `packages/core/test/child-agent-batch.test.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/events.ts`
- Modify: `packages/cli/src/render.ts`

**Exact input:**

```ts
{
  tasks: Array<{
    profile: "explore" | "review" | "explore_v1" | "review_v1";
    description: string;
    prompt: string;
  }>;
}
```

- [ ] Write failing tests for exact keys, minimum/maximum size, unsupported
  Implement, Plan/Act compatibility, Economy sequential fallback, real bounded
  overlap in faster modes, deterministic result order, partial failure, queued
  budget exhaustion, known cost exhaustion, parent cancellation, and cleanup on
  every terminal path.
- [ ] Confirm RED before adding the batch tool.
- [ ] Implement a small worker pool capped by both task count and the selected
  mode's `maxConcurrentChildren`; never use unbounded `Promise.all`.
- [ ] Create a lease immediately before each child starts, call the existing
  child run path with the shared `ToolContext` budget, settle success/failure in
  the original slot, and release in `finally`.
- [ ] Add `agent_batch_started`, `agent_batch_completed`,
  `agent_batch_failed`, and `agent_batch_cancelled` events with bounded counts
  and correlation IDs. Reuse existing child lifecycle events for task details.
- [ ] Return a concise synthesis-ready output and bounded metadata containing
  ordered status, IDs, profile, isolation revision, usage, and evidence.
- [ ] Render truthful text status for the new events; JSONL remains the exact
  serialized event contract.
- [ ] Run focused batch, manager, render, validation, and type tests; inspect and
  commit.

### Task 6: Wire the real backend and CLI policy surface

**Files:**

- Modify: `packages/cli/src/assembly.ts`
- Modify: `packages/cli/src/commands/agents.ts`
- Modify: `packages/cli/test/assembly.test.ts`
- Modify: `packages/cli/test/commands.test.ts`
- Modify: `packages/cli/test/run-mode.test.ts`

- [ ] Write failing assembly tests proving the data-root lease manager and both
  delegation tools are registered only against the real coordinator seam.
- [ ] Write failing command tests proving `/agents` reports exact policy version,
  true parallelism or sequential fallback, shared request/cost bounds, and
  Explore/Review batch eligibility while Implement is sequential-only.
- [ ] Register `delegate_tasks` beside `delegate_task`, rooted at
  `<projectData>/agent-worktrees`, without exposing a user-controlled path.
- [ ] Update `/agents mode <name>` so display names select v2 while exact `_v1`
  IDs remain available for compatibility and diagnostics.
- [ ] Run CLI/core integration tests, typecheck, inspect, and commit.

### Task 7: Prove parent fan-out and synthesis end to end

**Files:**

- Modify: `tests/e2e/coding-agent.test.ts`

- [ ] Add a failing direct-provider scenario where a parent calls
  `delegate_tasks` with Explore and Review, the children overlap in separate
  worktrees, one contributes evidence, ordered results return regardless of
  completion order, all leases disappear, and the parent synthesizes a final
  answer from the tool result.
- [ ] Add a failing partial-failure scenario showing successful evidence is
  retained and the parent is told exactly which sibling failed.
- [ ] Add a failing cancellation scenario proving active child sessions become
  cancelled, queued children never start, the parent tool fails as cancelled,
  and no lease remains.
- [ ] Make only the integration fixes required by those tests.
- [ ] Run the end-to-end test, the full TypeScript suite, and build; inspect and
  commit.

### Task 8: Document exact capability and audit the branch

**Files:**

- Modify: `README.md`
- Modify: `docs/CLI.md`
- Modify: `docs/research/SUBAGENT_HARNESS_COMPARISON.md`
- Modify: `docs/superpowers/plans/2026-07-17-parallel-analysis-fanout.md`

- [ ] Document new v2 mode limits, exact clean-Git requirement, isolated
  Explore/Review batch behavior, sequential Implement boundary, request
  reservations, reported-cost limitation, lifecycle events, and CLI commands.
- [ ] Update the primary-source comparison only where it informs the shipped
  design; distinguish verified source facts from Recurs design decisions.
- [ ] State every intentionally absent feature from the frozen boundaries.
- [ ] Run secret/sensitive-file review, `git status`, full relevant diff review,
  focused test reruns, `npm run check`, and the strongest practical native check
  if shared TypeScript/native contracts changed.
- [ ] Mark completed plan steps, create the final focused documentation/audit
  commit, and leave `codex/parallel-fanout-v1` clean without push or merge.
