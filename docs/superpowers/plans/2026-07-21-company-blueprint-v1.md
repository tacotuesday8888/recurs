# Company Blueprint v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn guided onboarding into a durable, reviewable tailored company and prove that one approved company role can delegate through the existing parent/child runtime and return evidence to the parent.

**Architecture:** Add dependency-free blueprint contracts, a deterministic fail-closed compiler, and a private immutable file store. Freeze an approved blueprint into parent and child session descriptors, add its bounded summary to root context, and expose one `delegate_company_task` tool that maps an approved role to an existing enforced execution profile. Guided onboarding gathers a short project intake and optional consent-gated repository markers, previews the compiled company, persists it only after confirmation, creates the first goal, and starts an ordinary session through the existing provider, permission, coordinator, and event seams.

**Tech Stack:** TypeScript 5, Node.js 22+, Vitest, existing Recurs contracts/core/CLI packages, JSON private project storage, existing `ChildAgentManager`, `AgentLoopDirectExecutor`, and `JsonlSessionStore`.

## Global Constraints

- Keep the current first-party agent loop, provider registry, permission engine, operating modes, session journal, child manager, and normalized events authoritative.
- A blueprint can narrow or describe authority but can never grant tools, permissions, billing eligibility, concurrency, depth, retries, or spend beyond the frozen parent policy.
- Version 1 remains depth one and process-lifetime; it does not add a daemon, deep recursion, desktop UI, automatic MCP installation, deployment, or self-modifying agents.
- Approved blueprints are immutable, private project data. No API keys, account labels, credential environment names, repository absolute paths, or raw provider failures are stored in them.
- Project inspection is local, bounded, read-only, and runs only after explicit user confirmation. It reads marker names, not arbitrary source or secret content.
- The layered-company roster contains eight stable roles, but the current operating mode still controls actual child count and concurrency. Creating a roster does not start eight model calls.
- Every displayed executable role maps to a real existing `AgentProfileId`; no decorative role may be reported as running.
- Follow TDD for each behavior and preserve all existing tests.

---

### Task 1: Versioned blueprint contracts and deterministic compiler

**Files:**
- Create: `packages/contracts/src/company.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/test/company.test.ts`
- Create: `packages/core/src/company-blueprint.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/test/company-blueprint.test.ts`

**Interfaces:**
- Produces: `CompanyBlueprintV1`, `CompanyRoleV1`, `CompanyProjectV1`, `CompanyRepositoryFactsV1`, `CompanyDevelopmentStyle`, `CompanyRoleId`, and `CompanyBlueprintBinding`.
- Produces: `compileCompanyBlueprint(input): CompanyBlueprintV1`, `parseCompanyBlueprint(value): CompanyBlueprintV1`, and `companyContextInstructions(blueprint): readonly string[]`.
- Consumes: current `AgentProfileId`, `AgentPermissionMode`, `OperatingModeId`, `OperatingModeVersion`, and `getOperatingModePolicy`.

- [ ] **Step 1: Write contract tests for the closed version-1 shape**

Test exact enum values, eight layered-company roles, stable departments, bounded UTF-8 text, unique role IDs, one orchestrator with no execution profile, executable roles with real public profiles only, operating-mode version agreement, monotonic role permissions, and frozen immutable return values.

```ts
expect(parseCompanyBlueprint(validBlueprint)).toEqual(validBlueprint);
expect(() => parseCompanyBlueprint({ ...validBlueprint, version: 2 }))
  .toThrow(/version/iu);
expect(() => parseCompanyBlueprint({
  ...validBlueprint,
  roles: [...validBlueprint.roles, validBlueprint.roles[0]],
})).toThrow(/unique/iu);
```

- [ ] **Step 2: Run the contract test and verify failure**

Run: `npx vitest run packages/contracts/test/company.test.ts`

Expected: FAIL because `company.ts` and its exports do not exist.

- [ ] **Step 3: Implement the closed contracts and parser**

Use these stable identifiers:

```ts
type CompanyDevelopmentStyle =
  | "layered_company"
  | "orchestrator"
  | "single_agent";

type CompanyRoleId =
  | "orchestrator_v1"
  | "product_planner_v1"
  | "tool_curator_v1"
  | "architect_v1"
  | "implementation_lead_v1"
  | "scoped_builder_v1"
  | "qa_reviewer_v1"
  | "security_release_reviewer_v1";

interface CompanyBlueprintBinding {
  readonly blueprintId: string;
  readonly blueprintVersion: 1;
  readonly roleId: CompanyRoleId;
  readonly roleVersion: 1;
}
```

The blueprint stores project type, stage, purpose, constraints, approved marker names, development style, parent permission, exact operating-mode ID/version, roles, tool requirements, quality gates, and initial goal. It stores route classes (`parent`, `implement`, `review`, `repair`), never connection IDs or account metadata.

- [ ] **Step 4: Write compiler tests**

Cover layered, orchestrator, and single-agent rosters; mode-derived quality/review limits; purpose and repository-marker personalization; deterministic output with injected ID/time; no model call; and rejection when the requested authority does not match the operating-mode policy.

```ts
const blueprint = compileCompanyBlueprint({
  id: "company-1",
  createdAt: "2026-07-21T00:00:00.000Z",
  project: intake,
  developmentStyle: "layered_company",
  permissionMode: "approved_for_me",
  operatingModeId: "balanced_v5",
});
expect(blueprint.roles).toHaveLength(8);
expect(blueprint.quality.maxImplementers).toBe(2);
expect(blueprint.roles.find((role) => role.id === "architect_v1")?.instructions)
  .toContain(intake.purpose);
```

- [ ] **Step 5: Run the compiler test and verify failure**

Run: `npx vitest run packages/core/test/company-blueprint.test.ts`

Expected: FAIL because `compileCompanyBlueprint` does not exist.

- [ ] **Step 6: Implement the compiler and bounded root context rendering**

Generate role instructions from stable Recurs role charters plus the bounded project intake. `companyContextInstructions` must tell only the root parent which company is approved, which roles are executable, that `delegate_company_task` is the only blueprint-aware delegation seam, and that roster membership does not authorize automatic work or spend.

- [ ] **Step 7: Run focused contract/compiler tests**

Run: `npx vitest run packages/contracts/test/company.test.ts packages/core/test/company-blueprint.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit the contract/compiler slice**

```bash
git add packages/contracts/src/company.ts packages/contracts/src/index.ts packages/contracts/test/company.test.ts packages/core/src/company-blueprint.ts packages/core/src/index.ts packages/core/test/company-blueprint.test.ts
git commit -m "feat: add company blueprint contracts"
```

---

### Task 2: Private immutable blueprint persistence

**Files:**
- Create: `packages/core/src/file-company-blueprint-store.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/test/file-company-blueprint-store.test.ts`

**Interfaces:**
- Consumes: `parseCompanyBlueprint(value)` from Task 1.
- Produces: `FileCompanyBlueprintStore.create(blueprint)`, `load(id)`, and `list()`.

- [ ] **Step 1: Write failing store tests**

Cover mode-0700 directory and mode-0600 file creation, exclusive immutable create, idempotent same-content create, rejection of ID reuse with different bytes, symlink/non-regular files, invalid UTF-8/JSON/schema, mid-read identity changes, unknown IDs, sorted bounded listing, cancellation, and absence of temporary files after success/failure.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `npx vitest run packages/core/test/file-company-blueprint-store.test.ts`

Expected: FAIL because the store does not exist.

- [ ] **Step 3: Implement the store with existing safety patterns**

Store one canonical JSON document at `company-blueprints/<safe-id>.json`. Use exclusive temporary creation, fsync, atomic rename, parent-directory fsync, exact file identity rechecks, fatal UTF-8 decoding, a 256 KiB maximum, strict safe IDs, and cloned/frozen results. Never overwrite an existing blueprint.

- [ ] **Step 4: Run the store test repeatedly**

Run: `for i in {1..10}; do npx vitest run packages/core/test/file-company-blueprint-store.test.ts || exit 1; done`

Expected: ten PASS runs.

- [ ] **Step 5: Commit the persistence slice**

```bash
git add packages/core/src/file-company-blueprint-store.ts packages/core/src/index.ts packages/core/test/file-company-blueprint-store.test.ts
git commit -m "feat: persist approved company blueprints"
```

---

### Task 3: Freeze company identity into durable sessions and context

**Files:**
- Modify: `packages/contracts/src/agents.ts`
- Modify: `packages/core/src/session-v2.ts`
- Modify: `packages/core/src/session-record-validator.ts`
- Modify: `packages/core/src/child-agent-manager.ts`
- Modify: `packages/core/src/events.ts`
- Modify: `packages/core/src/agent-activity.ts`
- Modify: `packages/core/test/session-v2.test.ts`
- Modify: `packages/core/test/child-agent-manager.test.ts`
- Modify: `packages/core/test/agent-activity.test.ts`

**Interfaces:**
- Consumes: `CompanyBlueprintBinding`.
- Produces: optional immutable `agent.company` binding on parent and child descriptors and matching normalized activity correlation.
- Produces: trusted `ChildDelegationOptions.company` and `ChildDelegationOptions.permissionMode` inputs used only by internal composition.

- [ ] **Step 1: Add failing session round-trip and corruption tests**

Prove a parent binding survives create/load/reduce and that unknown blueprint versions, role IDs, excess fields, child/parent mismatches, or bindings added by later mutation records fail closed.

- [ ] **Step 2: Run focused session tests and verify failure**

Run: `npx vitest run packages/core/test/session-v2.test.ts packages/core/test/session-runtime-records.test.ts`

Expected: FAIL because descriptors do not accept or validate company bindings.

- [ ] **Step 3: Implement session binding validation**

Allow the binding only in the immutable sequence-zero descriptor. Root parents use `orchestrator_v1`; blueprint children use their exact approved role. Existing sessions without a company remain valid.

- [ ] **Step 4: Add failing child narrowing and event tests**

Assert that a blueprint child inherits the exact blueprint ID/version, receives the requested role binding, cannot request a permission above the parent, and emits company correlation on started/completed/failed/cancelled activity without exposing prompts or private blueprint contents.

- [ ] **Step 5: Implement child binding and permission narrowing**

Use `narrowAgentPermissionMode(parentPermissionMode, requestedPermissionMode)` and existing profile tool policy. Reject a child company binding when the parent has no matching blueprint, when IDs/versions differ, or when the child role is the orchestrator.

- [ ] **Step 6: Run focused durable-session and activity tests**

Run: `npx vitest run packages/core/test/session-v2.test.ts packages/core/test/session-runtime-records.test.ts packages/core/test/child-agent-manager.test.ts packages/core/test/agent-activity.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the session-binding slice**

```bash
git add packages/contracts/src/agents.ts packages/core/src/session-v2.ts packages/core/src/session-record-validator.ts packages/core/src/child-agent-manager.ts packages/core/src/events.ts packages/core/src/agent-activity.ts packages/core/test/session-v2.test.ts packages/core/test/session-runtime-records.test.ts packages/core/test/child-agent-manager.test.ts packages/core/test/agent-activity.test.ts
git commit -m "feat: bind company roles to agent sessions"
```

---

### Task 4: Blueprint-aware delegation through the existing runtime

**Files:**
- Create: `packages/core/src/company-agent-manager.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/test/company-agent-manager.test.ts`
- Modify: `packages/cli/src/assembly.ts`
- Modify: `packages/cli/test/assembly.test.ts`

**Interfaces:**
- Consumes: `FileCompanyBlueprintStore`, `ChildAgentManager.delegate`, and the parent's frozen `agent.company` binding.
- Produces: model tool `delegate_company_task` with exact input `{ role, description, prompt }`.

- [ ] **Step 1: Write failing manager tests**

Cover exact input parsing, root-parent-only execution, approved blueprint lookup, executable-role lookup, role-to-existing-profile mapping, project-tailored prompt composition, permission narrowing, shared delegation budget use, cancellation/failure propagation, and metadata containing only blueprint/role/session/evidence identifiers.

- [ ] **Step 2: Run the focused manager test and verify failure**

Run: `npx vitest run packages/core/test/company-agent-manager.test.ts`

Expected: FAIL because `CompanyAgentManager` does not exist.

- [ ] **Step 3: Implement `CompanyAgentManager`**

The manager must load the exact parent-bound blueprint, find the requested role, reject the orchestrator or any role without an execution profile, prepend its tailored responsibility/instructions to the bounded task, and call the existing child manager. It must not implement another model loop, budget, permission engine, retry policy, or event system.

- [ ] **Step 4: Add an assembly test for a real parent → company child → parent synthesis turn**

Use `ScriptedProvider` events: the parent calls `delegate_company_task`, the child returns evidence, and the parent emits a final synthesis. Assert the durable child descriptor carries the blueprint/role binding and the root result includes the child evidence.

- [ ] **Step 5: Wire blueprint context and the manager into assembly**

Create the store under the existing project-data directory, load the exact parent binding inside `contextInstructions`, render the bounded blueprint context only for the root parent, register `delegate_company_task`, and preserve ordinary `delegate_task` for non-company and advanced use.

- [ ] **Step 6: Run focused manager and assembly tests**

Run: `npx vitest run packages/core/test/company-agent-manager.test.ts packages/cli/test/assembly.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the runtime vertical**

```bash
git add packages/core/src/company-agent-manager.ts packages/core/src/index.ts packages/core/test/company-agent-manager.test.ts packages/cli/src/assembly.ts packages/cli/test/assembly.test.ts
git commit -m "feat: delegate work through approved company roles"
```

---

### Task 5: Consent-gated project intake and company onboarding

**Files:**
- Create: `packages/cli/src/project-facts.ts`
- Modify: `packages/cli/src/index.ts`
- Create: `packages/cli/test/project-facts.test.ts`
- Modify: `packages/cli/src/guided-onboarding.ts`
- Modify: `packages/cli/src/process-host.ts`
- Modify: `packages/cli/test/guided-onboarding.test.ts`
- Modify: `packages/cli/test/process-host.test.ts`

**Interfaces:**
- Produces: `inspectProjectFacts(cwd): Promise<CompanyRepositoryFactsV1>`.
- Extends `GuidedOnboardingPorts` with `inspectProjectFacts` and `createCompanyBlueprint`.
- Extends configured onboarding outcome with exact `companyBlueprintId` and `initialGoal`.

- [ ] **Step 1: Write failing bounded project-fact tests**

Prove inspection reports only a closed set of root marker names (`.git`, `package.json`, `Package.swift`, `Cargo.toml`, `pyproject.toml`, `go.mod`, `Gemfile`, `Podfile`, `Dockerfile`, `AGENTS.md`), never reads their contents, ignores symlinks, sorts output, caps entries, and returns no absolute path.

- [ ] **Step 2: Run project-fact tests and verify failure**

Run: `npx vitest run packages/cli/test/project-facts.test.ts`

Expected: FAIL because the inspector does not exist.

- [ ] **Step 3: Implement the read-only marker inspector**

Use `realpath`, `lstat`, and `readdir` without recursion. Fail closed on root identity changes and malformed roots. The onboarding caller, not this helper, owns consent.

- [ ] **Step 4: Write failing guided-onboarding tests**

Cover the short intake (new/existing, project type, stage, layered/orchestrator/single-agent style, purpose, constraints, first goal), repository-inspection deny/approve paths, compiled eight-role preview, approval/edit/skip outcomes, no blueprint persistence before confirmation, and no credential values in the compiler input or output.

- [ ] **Step 5: Implement the onboarding company stage**

After provider, safety, operating mode, and specialist routing, gather the bounded intake. Ask before repository-marker inspection. Compile and render a concise review containing project, goal, roster, tool requirements, permissions, quality gates, and truthful cost limits. Persist only after explicit approval; a decline leaves provider setup intact and starts no company-bound session.

- [ ] **Step 6: Wire process-host ports and session options**

Use the same canonical cwd and project-data calculation as runtime assembly. Pass `companyBlueprintId` and `initialGoal` only for an approved company. Preserve the existing skip path and sessionless provider workspace.

- [ ] **Step 7: Run focused onboarding/process tests**

Run: `npx vitest run packages/cli/test/project-facts.test.ts packages/cli/test/guided-onboarding.test.ts packages/cli/test/process-host.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit the onboarding slice**

```bash
git add packages/cli/src/project-facts.ts packages/cli/src/index.ts packages/cli/test/project-facts.test.ts packages/cli/src/guided-onboarding.ts packages/cli/src/process-host.ts packages/cli/test/guided-onboarding.test.ts packages/cli/test/process-host.test.ts
git commit -m "feat: compile a tailored company during onboarding"
```

---

### Task 6: Approved blueprint activation and initial goal

**Files:**
- Modify: `packages/cli/src/assembly.ts`
- Modify: `packages/core/src/session-v2.ts`
- Modify: `packages/cli/test/assembly.test.ts`
- Modify: `packages/cli/test/process-host.test.ts`
- Modify: `packages/cli/test/e2e.test.ts`

**Interfaces:**
- Extends `StandaloneRuntimeOptions` with `companyBlueprintId` and `initialGoalObjective`.
- Consumes: immutable approved blueprint, root `CompanyBlueprintBinding`, and existing `activeGoal`/`goal_updated` records.

- [ ] **Step 1: Write failing activation tests**

Assert fresh company setup creates a root descriptor bound to `orchestrator_v1`, creates exactly one active initial goal, rejects a missing/corrupt/mode-mismatched/permission-escalating blueprint before session creation, never retrofits an existing resumed session, and leaves ordinary setup unchanged.

- [ ] **Step 2: Run activation tests and verify failure**

Run: `npx vitest run packages/cli/test/assembly.test.ts packages/cli/test/process-host.test.ts`

Expected: FAIL because runtime options cannot activate a blueprint or initial goal.

- [ ] **Step 3: Implement atomic-enough fresh-session activation**

Load and validate the blueprint before creating the session. Create the root descriptor with the exact company binding, then append the initial goal through the existing session mutation lease. If goal persistence fails, report setup failure and leave the incomplete session non-reusable rather than claiming successful company activation.

- [ ] **Step 4: Add installed-style end-to-end proof with a scripted provider**

Drive setup through company approval, create a company-bound session, submit the first goal, execute one `delegate_company_task`, receive child evidence, and finish with parent synthesis. Assert normalized events, permission monotonicity, reported/unknown usage truth, and durable reload after runtime close.

- [ ] **Step 5: Run the complete TypeScript verification**

Run: `npm run check`

Expected: PASS.

- [ ] **Step 6: Commit the activation proof**

```bash
git add packages/cli/src/assembly.ts packages/core/src/session-v2.ts packages/cli/test/assembly.test.ts packages/cli/test/process-host.test.ts packages/cli/test/e2e.test.ts
git commit -m "test: prove onboarding to company delegation"
```

---

### Task 7: Documentation, safety review, and delivery

**Files:**
- Modify: `docs/AGENT_COMPANY_ONBOARDING.md`
- Modify: `docs/CLI.md`
- Modify: `PRODUCT.md`
- Modify: `ARCHITECTURE.md`
- Modify: `docs/README.md`

**Interfaces:**
- Documents the exact implemented contract and explicit omissions only.

- [ ] **Step 1: Update current-state documentation**

Record the real bounded intake, immutable blueprint, eight-role layered roster, existing-profile mapping, root context, initial goal, blueprint-aware depth-one delegation, and activity evidence. Keep voice intake, semantic model-authored interviews, automatic dependency decomposition, tool installation, deep recursion, adaptation, and desktop UI marked absent.

- [ ] **Step 2: Inspect the complete diff and run secret/sensitive-path checks**

Run: `git diff --check origin/main...HEAD`

Run a repository-scoped pattern scan over changed files for API keys, tokens, private keys, `.env`, absolute home paths, temporary paths, and fixture credentials. Inspect every match manually.

- [ ] **Step 3: Run strongest local verification**

Run: `npm run check`

Run: `npm run check:native`

Expected: both PASS. If the unrelated existing abandoned-child timing test fails, inspect the production boundary and make its test synchronization deterministic without sleeps, retries, skips, or weakened kill/reap assertions before proceeding.

- [ ] **Step 4: Commit documentation and any verified test-harness correction**

```bash
git add docs/AGENT_COMPANY_ONBOARDING.md docs/CLI.md PRODUCT.md ARCHITECTURE.md docs/README.md
git commit -m "docs: record company blueprint vertical"
```

- [ ] **Step 5: Push, open a focused PR, and monitor CI**

Push `codex/company-blueprint-v1`, open a PR against `main`, report the contract/runtime/onboarding commits and verification evidence, and wait for both `verify` and `native` to pass. Fix only actionable failures with focused tests and commits.

- [ ] **Step 6: Merge and synchronize**

After green CI, merge through the repository's normal PR workflow. Fetch and fast-forward canonical local `main`, verify local `main == origin/main`, confirm the canonical checkout is clean, and report any remaining worktree/branch with whether it contains unique commits.

---

## Self-review

- Spec coverage: contracts, durable state, tailored roles, permission/model/tool/quality plans, initial goal, real delegation, evidence, cancellation, failure, CLI onboarding, tests, docs, and delivery all have explicit tasks.
- Explicit omissions remain out of scope: desktop UI, voice transport, free-form custom-agent builder, automatic MCP installation, deeper recursion, daemon/cloud work, deployment, and evidence-driven adaptation.
- Placeholder scan: the plan contains no deferred implementation placeholders; every future omission is an explicit product boundary.
- Type consistency: `CompanyBlueprintV1`, `CompanyBlueprintBinding`, `CompanyRoleId`, `FileCompanyBlueprintStore`, `CompanyAgentManager`, `delegate_company_task`, `companyBlueprintId`, and `initialGoalObjective` retain the same names across tasks.
