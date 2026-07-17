# Recurs Multi-Approach Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a production-quality foreground orchestration layer in which one parent can explicitly compose bounded Explore, Implement, and Review children through Recurs's own engine.

**Architecture:** Keep `delegate_task` as the single parent-facing primitive, but require an exact profile on every call. Durable profile IDs select immutable prompt, execution-mode, tool, permission-intent, evidence, and workspace-effect policy; the existing `BackendRunCoordinator` remains the only execution path. A host-created per-run budget limits sequential children and cumulative reported cost, while the existing concurrency/depth/request limits, cancellation, sessions, checkpoints, and normalized events remain authoritative.

**Tech Stack:** TypeScript 6, Node.js 22, npm workspaces, Vitest 4, JSONL version-2 sessions, existing Recurs provider/runtime/tool/approval/checkpoint seams.

## Global Constraints

- Keep the existing `explore_v1` durable identity and existing session logs valid.
- Add only `implement_v1` and `review_v1`; display labels remain renameable.
- A child never widens the parent's execution or permission envelope.
- Explore is Plan-only and host-read-only.
- Implement requires an Act parent, may edit only through reviewed host tools, and may not use credential, network, deploy, external-path, sensitive, or destructive intents.
- Review requires an Act parent, cannot patch or use an arbitrary shell, and may run only fixed, allowlisted verification commands without shell interpretation.
- All profiles exclude `delegate_task`, keeping depth at one.
- One parent run remains foreground, sequential, cancellation-linked, and explicitly bounded; no background tasks, automatic retries, swarms, or unbounded fan-out.
- Direct and host-tool delegated runtimes receive exact host policy. Opaque delegated runtimes may run only profiles compatible with their pinned enforced execution mode; Recurs must not claim internal tool control.
- Do not hard-code current model brands into agent policy.
- Use test-first red/green cycles and focused commits.

---

### Task 1: Generalize stable agent profiles and workflow limits

**Files:**
- Modify: `packages/contracts/src/agents.ts`
- Modify: `packages/contracts/test/agents.test.ts`
- Modify: `packages/core/src/session-record-validator.ts`
- Modify: `packages/core/test/session-v2.test.ts`

**Interfaces:**
- Produces `AgentProfileId = "explore_v1" | "implement_v1" | "review_v1"`.
- Produces `parseAgentProfileId(input: string): AgentProfileId | null`.
- Extends `AgentProfilePolicy.tools` with `allowedCategories` and `maxRisk`.
- Extends `OperatingModePolicy` with non-persisted `workflow.maxChildrenPerRun`; the persisted mode ID/version remains the durable selector.

- [ ] **Step 1: Write failing contract tests** for the three exact IDs, exact name/ID parsing, frozen nested policies, profile execution modes, tool allowlists, intent ceilings, and mode-specific child-run limits.

```ts
expect(parseAgentProfileId("implement")).toBe("implement_v1");
expect(parseAgentProfileId("rev")).toBeNull();
expect(getAgentProfilePolicy("review_v1")).toMatchObject({
  executionMode: "act",
  tools: { allowedNames: expect.arrayContaining(["run_verification"]) },
});
expect(getOperatingModePolicy("balanced_v1").workflow.maxChildrenPerRun).toBe(4);
```

- [ ] **Step 2: Run the contract tests and confirm RED**.

Run: `npm test -- packages/contracts/test/agents.test.ts`

- [ ] **Step 3: Implement immutable profiles and workflow limits**.

```ts
export type AgentProfileId = "explore_v1" | "implement_v1" | "review_v1";

export interface AgentProfilePolicy {
  readonly id: AgentProfileId;
  readonly version: 1;
  readonly displayName: string;
  readonly executionMode: AgentExecutionMode;
  readonly tools: {
    readonly readOnly: boolean;
    readonly evidenceFromSources: boolean;
    readonly allowedNames: readonly string[];
    readonly allowedCategories: readonly AgentToolPermissionCategory[];
    readonly maxRisk: AgentToolPermissionRisk;
  };
}
```

- [ ] **Step 4: Replace hard-coded Explore descriptor validation** with exact lookup through `parseAgentProfileId`, matching profile version and execution mode. Add hostile-record tests for unknown profiles and execution-mode mismatch.

- [ ] **Step 5: Run focused tests and type checking**.

Run: `npm test -- packages/contracts/test/agents.test.ts packages/core/test/session-v2.test.ts && npm run typecheck`

- [ ] **Step 6: Commit the contract slice**.

```bash
git add packages/contracts/src/agents.ts packages/contracts/test/agents.test.ts packages/core/src/session-record-validator.ts packages/core/test/session-v2.test.ts
git commit -m "feat: define specialized agent profiles"
```

### Task 2: Enforce dynamic workspace effects and add a safe verification tool

**Files:**
- Modify: `packages/tools/src/types.ts`
- Modify: `packages/tools/src/registry.ts`
- Modify: `packages/tools/test/registry.test.ts`
- Create: `packages/tools/src/builtins/run-verification.ts`
- Modify: `packages/tools/src/index.ts`
- Create: `packages/tools/test/verification.test.ts`
- Modify: `packages/cli/src/assembly.ts`
- Modify: `packages/cli/test/assembly.test.ts`

**Interfaces:**
- Adds optional `Tool.isMutating(input, context): boolean` for input-dependent effects.
- Extends `ToolPolicy` with exact permission category/risk ceilings.
- Produces `createRunVerificationTool(): Tool<RunVerificationInput>`.

- [ ] **Step 1: Write failing registry tests** proving a dynamically mutating tool remains visible in Plan for its read-only input, rejects its mutating input in Plan, receives a checkpoint in Act, and is rejected before approval when its intents exceed the active profile.

```ts
isMutating(input) { return input.kind === "write"; }
```

- [ ] **Step 2: Run registry tests and confirm RED**.

Run: `npm test -- packages/tools/test/registry.test.ts`

- [ ] **Step 3: Implement effective mutation and intent-policy enforcement** after exact input parsing and before approval. Use effective mutation for Plan denial, profile denial, and checkpoint capture.

```ts
const mutating = tool.mutating || (tool.isMutating?.(input, context) ?? false);
```

- [ ] **Step 4: Write failing verification-tool tests** for accepted commands (`npm test`, `npm run lint`, `cargo test`, `go test ./...`, `pytest`, `python -m pytest`, `swift test`) and rejection of pipes, redirection, command substitution, network/install/deploy commands, arbitrary programs, malformed quoting, and excess output/time.

- [ ] **Step 5: Implement `run_verification` without a shell**. Tokenize a bounded command into one allowlisted executable plus arguments, call `runProcess(program, args, ...)`, mark it `fixed_process` and mutating, return exact exit evidence, and never pass input to `/bin/sh`.

```ts
export interface RunVerificationInput {
  readonly command: string;
  readonly timeoutMs: number;
}

return {
  output,
  metadata: { exitCode: result.exitCode, evidence: [`${canonical} exited 0`] },
};
```

- [ ] **Step 6: Register and export the tool**, then run tools, CLI assembly, lint, and type checks.

Run: `npm test -- packages/tools/test/registry.test.ts packages/tools/test/verification.test.ts packages/cli/test/assembly.test.ts && npm run lint && npm run typecheck`

- [ ] **Step 7: Commit the enforcement/tool slice**.

```bash
git add packages/tools packages/cli/src/assembly.ts packages/cli/test/assembly.test.ts
git commit -m "feat: enforce agent tool policies"
```

### Task 3: Add trusted per-run delegation budgets

**Files:**
- Modify: `packages/tools/src/types.ts`
- Modify: `packages/core/src/agent-profile.ts`
- Modify: `packages/core/src/agent-loop.ts`
- Modify: `packages/core/src/delegated-agent-executor.ts`
- Modify: `packages/core/test/agent-loop.test.ts`
- Modify: `packages/core/test/delegated-agent-executor.test.ts`

**Interfaces:**
- Adds host-created `ToolContext.delegationBudget`.
- Produces `createDelegationBudget(agent): DelegationBudget`.
- The same mutable budget object lives for exactly one parent run and is never supplied by the model.

- [ ] **Step 1: Write failing direct and delegated tests** proving the context contains the mode-derived child count and reported-cost ceilings and remains shared across multiple tool calls in one run.

```ts
export interface DelegationBudget {
  readonly maxChildren: number;
  childrenStarted: number;
  readonly maxReportedCostUsd: number;
  reportedCostUsd: number;
}
```

- [ ] **Step 2: Run executor tests and confirm RED**.

Run: `npm test -- packages/core/test/agent-loop.test.ts packages/core/test/delegated-agent-executor.test.ts`

- [ ] **Step 3: Build the budget from the durable operating-mode ID** in both direct and delegated executors, attach it once per run, and keep child contexts independently bounded.

- [ ] **Step 4: Run focused tests and type checking**, then commit.

```bash
git add packages/tools/src/types.ts packages/core/src/agent-profile.ts packages/core/src/agent-loop.ts packages/core/src/delegated-agent-executor.ts packages/core/test/agent-loop.test.ts packages/core/test/delegated-agent-executor.test.ts
git commit -m "feat: bound child workflows per run"
```

### Task 4: Generalize `delegate_task` across Explore, Implement, and Review

**Files:**
- Modify: `packages/core/src/child-agent-manager.ts`
- Modify: `packages/core/src/agent-profile.ts`
- Modify: `packages/core/src/events.ts`
- Modify: `packages/core/test/child-agent-manager.test.ts`

**Interfaces:**
- `delegate_task` accepts exactly `{ profile, description, prompt }`.
- Profile accepts exact conventional names or stable IDs through `parseAgentProfileId`.
- Implement and Review are dynamically mutating at the parent checkpoint boundary; Explore remains non-mutating.

- [ ] **Step 1: Write failing manager tests** for exact profile input, all three durable descriptors/prompts/tool policies, Act-parent requirements, permission monotonicity, parent checkpoint effect classification, per-run child exhaustion, cumulative reported-cost exhaustion, failures consuming a child slot, and profile-correlated lifecycle events.

```ts
const input = tool.parse({
  profile: "implement",
  description: "Fix cache key",
  prompt: "Patch the cache key and verify the focused tests.",
});
```

- [ ] **Step 2: Run manager tests and confirm RED**.

Run: `npm test -- packages/core/test/child-agent-manager.test.ts`

- [ ] **Step 3: Implement exact selection and profile prompts**:

```ts
switch (agent.profile?.id) {
  case "explore_v1": return explorePrompt(prompt);
  case "implement_v1": return implementPrompt(prompt);
  case "review_v1": return reviewPrompt(prompt);
  default: return prompt;
}
```

- [ ] **Step 4: Reserve the run budget before child creation**, count failed/cancelled attempts, accumulate reported cost after terminal outcomes, and reject further work at the exact child/cost ceiling. Continue enforcing depth, concurrency, zero retries, cancellation, and immutable backend/model inheritance.

- [ ] **Step 5: Expand normalized events** so every started/completed/failed/cancelled event carries `profileId`; completion also carries changed files, evidence, and workflow budget usage.

- [ ] **Step 6: Run manager, executor, event, lint, and type checks**, then commit.

```bash
git add packages/core/src/child-agent-manager.ts packages/core/src/agent-profile.ts packages/core/src/events.ts packages/core/test/child-agent-manager.test.ts
git commit -m "feat: delegate specialized child agents"
```

### Task 5: Expose real profiles and workflow limits in the CLI

**Files:**
- Modify: `packages/cli/src/commands/agents.ts`
- Modify: `packages/cli/src/commands/foundation.ts`
- Modify: `packages/cli/src/render.ts`
- Modify: `packages/cli/test/commands.test.ts`
- Modify: `packages/cli/test/render.test.ts`
- Modify: `packages/cli/test/session-commands.test.ts`

**Interfaces:**
- `/agents` reports the active operating mode and exact workflow child limit.
- `/agents profiles` reports the three real profiles, their stable IDs, execution requirements, and host-controlled tools.
- Lifecycle rendering names the actual profile on every terminal event.

- [ ] **Step 1: Write failing CLI tests** for `/agents profiles`, strict extra-argument rejection, workflow-limit display, profile-aware lifecycle rendering, and unchanged durable mode updates.

- [ ] **Step 2: Run CLI tests and confirm RED**.

Run: `npm test -- packages/cli/test/commands.test.ts packages/cli/test/session-commands.test.ts packages/cli/test/render.test.ts`

- [ ] **Step 3: Implement truthful CLI copy** without claiming background, recursion, independent model routing, or support from an incompatible delegated backend.

- [ ] **Step 4: Run the complete CLI suite**, then commit.

```bash
git add packages/cli
git commit -m "feat: expose specialized agent profiles"
```

### Task 6: Prove a bounded multi-profile parent workflow end to end

**Files:**
- Modify: `packages/core/test/child-agent-manager.test.ts`
- Modify: `tests/e2e/coding-agent.test.ts`

**Interfaces:**
- Proves one parent can Explore, then Implement, then Review, with each child using a separate durable session and the parent performing final synthesis.

- [ ] **Step 1: Write a failing scripted-provider workflow** in which the parent explicitly selects Explore, receives evidence, selects Implement, changes a fixture and runs verification, selects Review, inspects/verifies the result, and returns the synthesized answer.

- [ ] **Step 2: Assert durable truth**: three child session descriptors, ordered profile events, parent-visible handoffs, changed-file/evidence propagation, parent-level checkpoint metadata for effectful delegations, and rejection of a child beyond the selected mode's run limit.

- [ ] **Step 3: Run the end-to-end tests and fix only real integration gaps**.

Run: `npm test -- packages/core/test/child-agent-manager.test.ts tests/e2e/coding-agent.test.ts`

- [ ] **Step 4: Commit the proof slice**.

```bash
git add packages/core/test/child-agent-manager.test.ts tests/e2e/coding-agent.test.ts
git commit -m "test: prove multi-profile orchestration"
```

### Task 7: Document, audit, and finish the milestone

**Files:**
- Modify: `README.md`
- Modify: `docs/CLI.md`
- Modify: `docs/research/SUBAGENT_HARNESS_COMPARISON.md`
- Modify: `docs/superpowers/plans/2026-07-17-multi-approach-orchestration.md`

- [ ] **Step 1: Document exactly what is real**: three profiles, direct/host-tool enforcement, opaque-runtime limitation, safe verification execution, sequential per-run limits, reported-cost behavior, checkpoints, cancellation, and synthesis.

- [ ] **Step 2: Document intentionally absent work**: background agents, parallel fan-out, retry/resume, depth beyond one, worktree-per-child isolation, independent model routing, role marketplaces, schedules, and company UI.

- [ ] **Step 3: Run full verification**.

```bash
npm run check:generated
npm run lint
npm run typecheck
npm test
npm run build
npm run native:engine-bundle-smoke
npm run native:engine-bridge-smoke
npm run native:doctor-smoke
```

- [ ] **Step 4: Audit status, complete diff, secret patterns, generated files, and `git diff --check`**. Confirm `main` remains unchanged and nothing was pushed.

- [ ] **Step 5: Commit documentation/audit results**.

```bash
git add README.md docs/CLI.md docs/research/SUBAGENT_HARNESS_COMPARISON.md docs/superpowers/plans/2026-07-17-multi-approach-orchestration.md
git commit -m "docs: define multi-approach orchestration"
```

- [ ] **Step 6: Use `superpowers:finishing-a-development-branch`** and leave the branch clean and integration-ready without pushing or merging unless explicitly authorized.
