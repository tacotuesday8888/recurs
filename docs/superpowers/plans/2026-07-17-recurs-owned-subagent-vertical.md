# Recurs-Owned Sub-Agent Vertical Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that Recurs can durably create, constrain, run, observe, and collect one scoped child agent through its own execution engine.

**Architecture:** Treat every agent as a pinned Recurs session. A parent-visible `delegate_task` tool creates a child session whose immutable agent descriptor records its parent, task, backend/model inheritance, permission envelope, operating mode, and limits. The existing `BackendRunCoordinator` then executes the child through the same direct-provider or delegated-runtime lane used by normal turns. The tool returns the child result to the parent while the child JSONL log remains the durable source of lifecycle, usage, files, evidence, failure, and cancellation truth.

**Tech Stack:** TypeScript 6, Node.js 22, npm workspaces, Vitest 4, JSONL session reducer, existing Recurs provider/runtime/tool/approval seams.

## Global Constraints

- Preserve backward compatibility with existing version-2 session logs.
- Never widen a child permission or execution mode beyond its parent.
- The first slice supports one foreground child at a time, depth one, and zero automatic retries.
- Child backend/model selection is `inherit_parent` only. A child profile may narrow execution mode and tools, but must not claim model routing that the backend cannot perform.
- Every run is bounded by both the backend authorization and the selected operating mode.
- Providers that report USD cost are accounted exactly; providers without cost telemetry remain bounded by request count and report cost as unavailable.
- Cancellation uses the parent signal and must surface as cancellation, never as success or a generic error.
- Do not add swarms, background jobs, role marketplaces, recursive companies, or decorative UI in this slice.

---

### Task 1: Add stable agent and operating-mode contracts

**Files:**
- Create: `packages/contracts/src/agents.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/test/agents.test.ts`

- [x] Write failing tests for the five stable mode identifiers, immutable lookup, default mode, permission narrowing, and bounded mode limits.
- [x] Add `AgentSessionDescriptor`, `AgentTask`, `AgentLifecycle`, `AgentLimits`, `AgentBackendSelection`, `AgentResult`, and `OperatingModePolicy` contracts.
- [x] Define stable IDs `economy_v1`, `standard_v1`, `balanced_v1`, `performance_v1`, and `max_v1`; keep Economy/Standard/Balanced/Performance/Max as display labels only.
- [x] Implement exact parsing and `narrowPermissionMode(parent, requested)` so the returned mode can never exceed the parent.
- [x] Run the contracts test suite and commit the contract slice.

### Task 2: Make agent identity and lifecycle durable in session state

**Files:**
- Modify: `packages/core/src/session.ts`
- Modify: `packages/core/src/session-v2.ts`
- Modify: `packages/core/src/session-record-validator.ts`
- Modify: `packages/core/src/jsonl-session-store.ts`
- Test: `packages/core/test/session-v2.test.ts`
- Test: `packages/core/test/session-runtime-records.test.ts`

- [x] Write failing reducer and hostile-record tests for root descriptors, child descriptors, task/depth validation, lifecycle transitions, terminal result capture, and legacy logs without agent metadata.
- [x] Add optional `agent` metadata to `session_created`; `createPinnedSession` supplies a root descriptor by default and accepts an explicit child descriptor.
- [x] Add `agent` state to `PinnedSessionState`. Root sessions return to `ready` after a terminal turn; a child becomes `completed`, `failed`, or `cancelled` and retains its normalized terminal result.
- [x] Reject malformed descriptors, impossible parent/depth combinations, invalid limits, permission widening, and post-terminal child turns.
- [x] Run the focused core session tests and commit the persistence slice.

### Task 3: Propagate trusted run context and enforce child request limits

**Files:**
- Modify: `packages/core/src/run-coordinator.ts`
- Modify: `packages/core/src/direct-model-executor.ts`
- Modify: `packages/core/src/agent-loop.ts`
- Modify: `packages/core/src/delegated-agent-executor.ts`
- Modify: `packages/tools/src/types.ts`
- Modify: `packages/cli/src/assembly.ts`
- Test: `packages/core/test/direct-model-executor.test.ts`
- Test: `packages/core/test/delegated-agent-executor.test.ts`
- Test: `packages/core/test/run-coordinator.test.ts`

- [x] Write failing tests proving the host-derived trusted context reaches host tools in both execution lanes and that direct child request limits clamp—but never expand—the backend authorization.
- [x] Add trusted run context to `ToolContext` and pass it from the coordinator through both executors.
- [x] Use `min(authorization.maxRequests, session.agent.limits.maxRequests)` for child direct steps. The currently supported delegated Codex lane is already capped to one authorized runtime invocation; Recurs does not pretend it can cap opaque vendor-internal model calls.
- [x] Keep ordinary root-run behavior unchanged.
- [x] Run focused coordinator/executor tests and commit the execution-seam slice.

### Task 4: Implement one Recurs-owned delegation tool

**Files:**
- Create: `packages/core/src/child-agent-manager.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/events.ts`
- Modify: `packages/cli/src/assembly.ts`
- Test: `packages/core/test/child-agent-manager.test.ts`
- Test: `packages/cli/test/run-mode.test.ts`

- [x] Write failing tests for exact input, parent→child→parent synthesis, backend/model inheritance, child permission monotonicity, depth/concurrency rejection, zero retries, cancellation, preflight failure, and normalized agent events. Started failures reuse the already-covered coordinator terminal path.
- [x] Implement `delegate_task` with exact `{ description, prompt }` input; no model, permission, background, retry, or concurrency override is exposed in v1.
- [x] Load the parent state, resolve its operating mode, create an immutable child descriptor, and create a pinned child session on the exact parent backend.
- [x] Invoke the existing coordinator with the child sequence, parent signal, inherited execution mode, and trusted invocation reconstructed only from the coordinator-derived context.
- [x] Emit `agent_started`, `agent_completed`, `agent_failed`, or `agent_cancelled` with parent/child correlation. Return final text plus child/session IDs, usage, files, and evidence in tool metadata.
- [x] Track active children per parent in-process and enforce mode depth/concurrency/retry/request policies without polling or hidden retries. Reported USD cost is accounted and flagged after provider/runtime telemetry arrives; it is not misrepresented as a pre-spend hard stop.
- [x] Register the tool only after the coordinator reference is live; fail closed if the execution engine is unavailable.
- [x] Run focused manager, core, CLI run-mode, and type verification and commit the vertical.

### Task 5: Add a real, minimal operating-mode CLI surface

**Files:**
- Create: `packages/cli/src/commands/agents.ts`
- Modify: `packages/cli/src/commands/create.ts`
- Modify: `packages/cli/src/commands/foundation.ts`
- Modify: `packages/cli/src/commands/types.ts`
- Modify: `packages/cli/src/session-mutations.ts`
- Modify: `packages/core/src/events.ts`
- Modify: `packages/core/src/session-v2.ts`
- Test: `packages/cli/test/commands.test.ts`
- Test: `packages/cli/test/session-commands.test.ts`

- [x] Write failing tests for `/agents`, `/agents mode <name>`, exact parsing, durable mode changes, and the unconfigured workspace explanation; `/status` uses the same policy lookup.
- [x] Persist mode changes through an `agent_policy_updated` version-2 record; do not overload Act/Plan or permission mode.
- [x] Display the active mode’s real request/depth/concurrency/retry/cost policy and state that model selection currently inherits the pinned parent backend.
- [x] Add `/agents` to help and `/status`; avoid claims about recursive or parallel execution.
- [x] Run the full CLI tests and type verification and commit the CLI slice.

### Task 6: Document the evidence and the intentionally absent surface

**Files:**
- Create: `docs/research/SUBAGENT_HARNESS_COMPARISON.md`
- Modify: `docs/CLI.md`
- Modify: `README.md`

- [x] Record the primary-source comparison of Codex, OpenCode, Kimi Code, Kilo Code, Pi, and Goose.
- [x] Clearly separate the shipped one-child vertical from future recursion, parallelism, background work, role profiles, model routing, and company UX.
- [x] Document child-session durability, permission inheritance, limits, cancellation, cost-telemetry behavior, `/agents`, and `delegate_task`.
- [x] Check all links and terminology, then commit the documentation slice.

### Task 7: Full verification and branch audit

**Files:**
- Review every changed file in this worktree.

- [x] Run `npm run lint`.
- [x] Run `npm run typecheck`.
- [x] Run `npm test` (65 files, 1051 tests; loopback/Git integration required the normal unsandboxed test permission).
- [x] Run `npm run build`.
- [x] Run native engine-bundle, engine-bridge, and doctor smoke verification.
- [x] Inspect `git status`, the complete diff, generated artifacts, and secret patterns.
- [x] Confirm main remains unchanged after commit `9902ad2` and do not push.

### Task 8: Add the first constrained Explore profile

**Files:**
- Modify: `packages/contracts/src/agents.ts`
- Create: `packages/core/src/agent-profile.ts`
- Modify: `packages/core/src/child-agent-manager.ts`
- Modify: `packages/core/src/agent-loop.ts`
- Modify: `packages/core/src/delegated-agent-executor.ts`
- Modify: `packages/tools/src/registry.ts`
- Modify: read-only built-in tools and focused tests
- Modify: CLI rendering and documentation

- [x] Define the stable `explore_v1` profile and persist it on child descriptors.
- [x] Narrow Explore children to Plan and reject durable mode changes that would widen them.
- [x] Enforce a five-tool read-only allowlist in both model definitions and invocation.
- [x] Apply one bounded Explore prompt across direct and delegated execution.
- [x] Return traceable evidence metadata from every allowed inspection tool.
- [x] Run the full repository verification, audit the complete diff, and commit the slice.
