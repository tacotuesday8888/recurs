# Company Runtime Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining engine-quality gaps after the company foundation by adding explicit capability authorization, repeatable real-model evaluation, stronger role-specific behavior, and bounded multi-stage reviewed execution without duplicating completed provider or distribution work.

**Architecture:** Keep `CompanyBlueprintV2`, the existing provider registry, `CompanyGoalSupervisor`, durable team engine, permission engine, and immutable run history as the authority. Add narrowly versioned capability-binding state and evaluation records, then extend the existing supervisor to schedule multiple dependency-ordered implementation/review stages instead of creating a second orchestration runtime.

**Tech Stack:** TypeScript 6, Node.js 22, Vitest, existing private atomic stores, existing direct/delegated provider seams, existing Git-worktree team runtime, Swift native compatibility checks.

## Global Constraints

- Do not modify the established onboarding command flow or terminal UX semantics in this milestone.
- Do not touch `README.md`, `packages/cli/src/render.ts`, `packages/cli/src/repl.ts`, or their presentation tests while the separate presentation task owns them.
- Never discover a semantic Skill/MCP mapping from a name or description; only an exact local user-approved binding grants availability.
- A capability binding cannot widen the blueprint, profile, parent permission, MCP trust, process, network, or operating-mode boundary.
- Real-provider evaluation is opt-in, never persists credentials, and records sanitized evidence and usage only.
- Historical V1/V2 blueprints, sessions, goal runs, and team runs remain readable without migration.
- Multi-stage execution remains a finite approved DAG with existing depth, concurrency, request, retry, permission, and reported-cost ceilings; no daemon or unbounded recursion.
- Existing npm, Homebrew/curl asset, native, and provider work changes only where a failing audit or test proves a concrete gap.

---

### Task 1: Approved company capability bindings

**Files:**
- Create: `packages/contracts/src/company-capabilities.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/core/src/file-company-capability-store.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/contracts/test/company-capabilities.test.ts`
- Test: `packages/core/test/file-company-capability-store.test.ts`

**Interfaces:**
- Produce `CompanyCapabilityBindingSetV1`, `CompanyCapabilityBindingV1`, `CompanyCapabilitySourceV1`, and strict parsers.
- Bind one exact approved blueprint revision and tool-bundle ID to one exact enabled Agent Skill or MCP server identity.
- Persist immutable revisions in a private, atomic, tamper-evident store; conflicts and stale blueprint revisions fail closed.

- [x] Write malformed-schema, duplicate binding, stale revision, unknown bundle, unsafe identifier, and deterministic parser tests.
- [x] Write create/load/latest/idempotency/ID-reuse, same-instance race, cross-instance race, corrupt file, symlink, and permissions tests.
- [x] Implement strict contracts and the private append-only store using the existing private-state publication/lock primitives.
- [x] Run `npx vitest run packages/contracts/test/company-capabilities.test.ts packages/core/test/file-company-capability-store.test.ts` twice and commit.

### Task 2: Capability approval, readiness, and runtime enforcement

**Files:**
- Modify: `packages/cli/src/company-tool-readiness.ts`
- Modify: `packages/cli/src/commands/company.ts`
- Modify: `packages/cli/src/commands/types.ts`
- Modify: `packages/cli/src/assembly.ts`
- Modify: `packages/cli/src/agent-skills.ts`
- Modify: `packages/cli/src/mcp-client.ts`
- Modify: `packages/tools/src/types.ts`
- Modify: `packages/core/src/agent-profile.ts`
- Test: `packages/cli/test/company-tool-readiness.test.ts`
- Test: `packages/cli/test/company-commands.test.ts`
- Test: focused Agent Skill, MCP, assembly, and profile-policy tests.

**Interfaces:**
- Add `/company capabilities`, `/company bind <bundle> skill <name>`, `/company bind <bundle> mcp <server>`, and exact-ID unbind commands behind local/manual/user-present confirmation.
- Resolve exact approved bindings against enabled catalogs and trusted project MCP state.
- Pass a frozen per-agent capability policy through `ToolContext`; generic Skill/MCP tools reject every capability not explicitly bound to one of that role's approved bundles.

- [x] Write tests proving catalogs alone grant nothing and unavailable/disabled/untrusted/stale bindings remain unusable.
- [x] Write tests proving binding cannot add an unapproved role bundle, tool name, permission category, network grant, or project trust.
- [x] Implement command confirmation, immutable revision publication, safe rendering, role-policy intersection, and tool-level exact-ID enforcement.
- [x] Run the focused CLI/core/tools suites twice and commit.

### Task 3: Repeatable real-provider company evaluation

**Files:**
- Create: `packages/contracts/src/company-evaluation.ts`
- Create: `packages/core/src/company-evaluation.ts`
- Create: `packages/cli/src/company-evaluation.ts`
- Create: `scripts/evaluate-company.mjs`
- Modify: `package.json`
- Test: matching contract, core, CLI, and script tests.

**Interfaces:**
- Define versioned scenarios for interview quality, blueprint tailoring, decomposition, evidence, synthesis, and efficiency.
- Run against the normal selected direct/local provider path with a temporary private Recurs home and fixture repository; accept credentials only through existing provider resolution and environment references.
- Emit sanitized JSON plus a readable report containing scenario version, provider/model fingerprint, latency, reported usage/cost, rubric evidence, failures, and no prompts or environment secrets by default.

- [x] Write scripted-provider tests for pass/fail/partial results, malformed model output, cancellation, unknown usage, and secret-canary redaction.
- [x] Implement `npm run eval:company -- --scenario <id>` with explicit opt-in and no network behavior in ordinary test/check commands.
- [x] Add a deterministic offline smoke scenario and document the exact command for later OpenAI/Anthropic/local qualitative runs.
- [x] Run the complete evaluation suite and commit.

### Task 4: Tailored role charters and role-relevant memory

**Files:**
- Create: `packages/core/src/company-role-charter.ts`
- Modify: `packages/core/src/company-goal-supervisor.ts`
- Modify: `packages/core/src/company-learning.ts`
- Test: `packages/core/test/company-role-charter.test.ts`
- Test: `packages/core/test/company-goal-supervisor.test.ts`
- Test: `packages/core/test/company-learning.test.ts`

**Interfaces:**
- Compile a bounded role charter from existing immutable blueprint fields: role kind, department purpose, reporting relationship, responsibility, project constraints, instructions, tool bundles, model route, expected evidence, quality standard, and authority boundary.
- Select attributable knowledge per assignment using objective + role + assignment terms while retaining the run-start historical cutoff.
- Keep identity/presentation text separate from stable policy identifiers and never interpret learned text as authority.

- [x] Write snapshot-style prompt contract tests for orchestrator, lead, worker, reviewer, and repair roles.
- [x] Prove prompt truncation preserves authority/evidence clauses and malicious knowledge remains quoted context rather than instructions.
- [x] Implement the charter compiler and per-assignment bounded knowledge selection.
- [x] Run focused prompt, learning, and supervisor tests twice and commit.

### Task 5: Bounded multi-stage reviewed implementation

**Files:**
- Modify: `packages/contracts/src/company-goals.ts`
- Modify: `packages/core/src/company-goal-supervisor.ts`
- Modify: `packages/core/src/team-run-supervisor.ts` only if an existing adapter cannot carry stage correlation.
- Test: `packages/contracts/test/company-goals.test.ts`
- Test: `packages/core/test/company-goal-supervisor.test.ts`
- Test: `packages/core/test/team-run-supervisor.integration.test.ts`

**Interfaces:**
- Permit multiple dependency-ordered implementation frontiers in one approved assignment DAG.
- Every mutating frontier must have at least one independent review assignment that covers that frontier; at least one final independent review covers all non-review work.
- Execute one ready frontier at a time through the existing reserve/start/inspect team path, then unlock the next stage from durable results.

- [x] Write a deterministic plan for planning → implementation/review → dependent implementation/review → final synthesis.
- [x] Add rejection coverage for uncovered mutation, review-before-change, cross-stage cycles, concurrency overflow, cost/request exhaustion, and authority escalation.
- [x] Add interruption, recovery, and cancellation coverage after an approved earlier stage; later-stage repair remains inside the existing durable team recovery boundary.
- [x] Implement ready-frontier selection and stage correlation without a second team runtime or new recursive scheduler.
- [x] Repeat focused runtime suites and commit.

### Task 6: Gap audit, full verification, and delivery

**Files:**
- Modify: `docs/AGENT_COMPANY_ONBOARDING.md`
- Modify: `docs/CLI.md`
- Modify: `ARCHITECTURE.md`
- Modify provider/release files only when a concrete test-backed audit finding requires it.

**Interfaces:**
- Document what is executable, what is evaluation-only, how capability approval works, and the remaining intentional exclusions.
- Preserve the separate presentation task's README/UI ownership and reconcile only after its PR lands.

- [ ] Audit provider catalog activation, subscription/BYOK/local paths, npm packaging, generated Homebrew/curl assets, and native boundaries against existing tests/docs; open no speculative integration surface.
- [ ] Run all new suites repeatedly, then `npm run check`, `npm run package:smoke-install`, and `npm run check:native`.
- [ ] Inspect status, full diff, file modes, generated files, and secret patterns; stage only intended files.
- [ ] Push focused PRs, wait for both verify/native checks, address actionable failures, and merge only when green.
- [ ] Fetch and synchronize canonical `main`; prove `main == origin/main`, canonical status is clean, and no completed feature commit is stranded.
