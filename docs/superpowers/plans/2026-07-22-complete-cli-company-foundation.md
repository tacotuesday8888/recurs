# Complete Recurs CLI Company Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing immutable V1 company roster and one-child handoff into a resumable, editable, goal-scoped CLI company foundation with bounded hierarchy, durable evidence-backed learning, and approved amendments.

**Architecture:** Preserve every V1 parser and historical session while adding strict V2 company, onboarding, goal-run, knowledge, and amendment contracts. Run pre-approval discovery through a dedicated Plan-only read registry, then execute approved V2 goal plans through the existing child, batch, worktree, review, repair, provider-routing, permission, and event seams under one durable shared budget.

**Tech Stack:** TypeScript 6, Node.js 22, Vitest, YAML 2.9, existing Recurs JSONL/file stores, provider/agent loop, Git worktree team runtime, Swift native compatibility checks.

## Global Constraints

- Guided is the default onboarding depth; Quick, Guided, and Deep remain explicit stable identifiers.
- Before blueprint approval, no shell, write, network, credential, installation, or project-command capability is exposed.
- Dynamic companies always retain a root orchestrator and independent review authority.
- V1 blueprints, bindings, sessions, modes, and stores remain readable and executable without migration.
- Goal execution is bounded by immutable mode, permission, model-route, depth, concurrency, request, retry, and reported-cost snapshots.
- YAML is editable presentation; validated JSON records remain canonical authority.
- No desktop UI, daemon, deployment autonomy, automatic tool installation, or unbounded recursion.

---

### Task 1: V2 company and policy contracts

**Files:**
- Modify: `packages/contracts/src/company.ts`
- Modify: `packages/contracts/src/agents.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/test/company.test.ts`
- Test: `packages/contracts/test/agents.test.ts`

**Interfaces:**
- Produces `CompanyOnboardingDepth`, `CompanyDesignMode`, `CompanyBlueprintV2`, `CompanyBlueprint`, `CompanyRoleV2`, `CompanyDepartmentV2`, `CompanyBlueprintBindingV2`, `CompanyModePolicy`, `parseCompanyBlueprint`, and V6 operating policies.
- Preserves V1 return shapes through the discriminated `version` field and exact historical mode lookup.

- [x] Write failing parser and type tests for valid stable-core and guardrailed-dynamic V2 blueprints.
- [x] Add rejection tests for unknown fields, unsafe IDs, cycles, missing root/review anchors, permission escalation, invalid routes, and out-of-policy role/depth limits.
- [x] Add V6 mode tests proving company limits increase monotonically while historical V1-V5 values remain exact.
- [x] Implement the minimal discriminated parsers, deep freezing, graph validation, and policy tables.
- [x] Run `npx vitest run packages/contracts/test/company.test.ts packages/contracts/test/agents.test.ts` and commit the green contract slice.

### Task 2: Onboarding, goal, knowledge, and amendment contracts

**Files:**
- Create: `packages/contracts/src/company-onboarding.ts`
- Create: `packages/contracts/src/company-goals.ts`
- Create: `packages/contracts/src/company-knowledge.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/test/company-onboarding.test.ts`
- Test: `packages/contracts/test/company-goals.test.ts`
- Test: `packages/contracts/test/company-knowledge.test.ts`

**Interfaces:**
- Produces `CompanyOnboardingRunV1`, `CompanyOnboardingDepthPolicy`, `CompanyProposalRevisionV1`, `CompanyGoalRunV1`, `CompanyGoalPlanV1`, `CompanyGoalAssignmentV1`, `CompanyGoalBudgetV1`, `CompanyKnowledgeV1`, and `CompanyAmendmentV1` plus strict parsers.
- Depth policies are Quick `4/0/1/8`, Guided `10/3/2/24`, and Deep `20/8/4/64` for interview rounds, total research children, research concurrency, and total model requests; live operating policy clamps the latter three.

- [ ] Write failing exact-schema and invariant tests for every lifecycle state and transition payload.
- [ ] Test assignment DAG validation, role/delegation matching, shared ledger arithmetic, terminal-state truth, provenance requirements, and immutable amendment bases.
- [ ] Implement strict, dependency-free parsers and transition helpers with safe text/size bounds and deep freezing.
- [ ] Run the three focused contract suites and commit the green slice.

### Task 3: Private durable stores

**Files:**
- Create: `packages/core/src/file-company-onboarding-store.ts`
- Create: `packages/core/src/jsonl-company-goal-store.ts`
- Create: `packages/core/src/file-company-knowledge-store.ts`
- Create: `packages/core/src/file-company-amendment-store.ts`
- Modify: `packages/core/src/index.ts`
- Test: matching focused store test files under `packages/core/test/`

**Interfaces:**
- Produces append/create/load/list/mutate APIs following the current company blueprint and session-store publication patterns.
- Stores enforce private permissions, regular-file/no-symlink paths, exact UTF-8 JSON/JSONL, atomic publication, sequence monotonicity, idempotency, conflict-on-ID-reuse, and fail-closed tamper handling.

- [ ] Write failing create/load/idempotency/conflict tests.
- [ ] Add deterministic same-instance and cross-instance publication races plus corrupt/truncated/symlink/permission tests.
- [ ] Implement stores by extracting only narrowly reusable publication helpers where duplication would otherwise create divergent security behavior.
- [ ] Repeat focused race tests, run all new store suites, and commit.

### Task 4: V2 compiler, YAML codec, and proposal revision

**Files:**
- Create: `packages/core/src/company-blueprint-v2.ts`
- Create: `packages/cli/src/company-blueprint-yaml.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/company-blueprint-v2.test.ts`
- Test: `packages/cli/test/company-blueprint-yaml.test.ts`

**Interfaces:**
- Produces `compileCompanyBlueprintV2(input)`, `approveCompanyBlueprintV2(proposal, at)`, `renderCompanyBlueprintYaml(blueprint)`, `parseCompanyBlueprintYaml(text)`, and a structural proposal diff.
- Stable-core compilation creates the six known departments and baseline accountability roles before adding bounded specialists; dynamic compilation accepts generated departments and roles but injects or rejects missing guardrails.

- [ ] Write deterministic compiler tests for both company modes and every mode ceiling.
- [ ] Write YAML round-trip, alias/billion-laughs rejection, duplicate-key, unknown-field, authority-escalation, and readable-validation-error tests.
- [ ] Implement stable opaque role IDs, editable display metadata, closed capabilities/tool bundles/model routes, and canonical JSON normalization.
- [ ] Run focused tests and commit.

### Task 5: Resumable progressive onboarding coordinator

**Files:**
- Create: `packages/core/src/company-onboarding-coordinator.ts`
- Create: `packages/cli/src/company-onboarding-runtime.ts`
- Refactor: `packages/cli/src/guided-onboarding.ts`
- Modify: `packages/cli/src/process-host.ts`
- Test: `packages/core/test/company-onboarding-coordinator.test.ts`
- Test: `packages/cli/test/guided-onboarding.test.ts`

**Interfaces:**
- Produces a durable state machine for interview, consented discovery, proposal, revision, approval, abandonment, cancellation, and resume.
- The dedicated onboarding AgentLoop registry contains only `read_file`, `list_files`, `search_text`, `code_outline`, `git_status`, `git_history`, `git_show`, and `git_diff`; research children use `explore_v1` and the same restricted registry.

- [ ] Write scripted-provider tests for Quick, Guided, and Deep limits, adaptive follow-ups, early completion, and bounded research fan-out.
- [ ] Prove unavailable write/shell/network/MCP/skill/process tools cannot be invoked even under Full Access.
- [ ] Test consent denial, SIGINT, crash/resume, corrupt state, save/exit, and cwd/provider/authority mismatch.
- [ ] Implement coordinator integration after provider, safety, mode, and routing selection; resume the newest compatible unfinished run or offer a clean restart without deleting history.
- [ ] Run focused onboarding tests and commit.

### Task 6: Conversation and structured company editor

**Files:**
- Create: `packages/cli/src/company-proposal-editor.ts`
- Modify: `packages/cli/src/guided-onboarding.ts`
- Modify: `packages/cli/src/process-host.ts`
- Test: `packages/cli/test/company-proposal-editor.test.ts`
- Test: `packages/cli/test/guided-onboarding.test.ts`

**Interfaces:**
- Produces the review loop actions `discuss`, `edit_yaml`, `approve`, and `save_exit`.
- Chat revisions must return a validated V2 draft and display a bounded structural diff; editor revisions use `$VISUAL`, then `$EDITOR`, and otherwise retain chat revision without launching an unknown command.

- [ ] Write tests for natural-language revision, invalid model output, YAML editor success/failure/cancellation, unchanged drafts, authority escalation, and final approval.
- [ ] Implement the editor with private temporary files, exact cleanup, no shell interpolation, and canonical revalidation.
- [ ] Connect approved output to immutable blueprint creation and the initial durable goal; rejected proposals start no normal session work.
- [ ] Run focused CLI suites and commit.

### Task 7: Goal-wide policy and bounded company hierarchy

**Files:**
- Create: `packages/core/src/company-goal-supervisor.ts`
- Modify: `packages/core/src/company-agent-manager.ts`
- Modify: `packages/core/src/child-agent-manager.ts`
- Modify: `packages/core/src/events.ts`
- Modify: `packages/contracts/src/agents.ts`
- Test: `packages/core/test/company-goal-supervisor.test.ts`
- Test: `packages/core/test/company-agent-manager.test.ts`

**Interfaces:**
- Produces `delegate_company_goal` and trusted internal `request_company_handoff` tools.
- The supervisor owns one atomic goal budget; validates each assignment edge, depth, active-role ceiling, model route, permission ceiling, and evidence contract; then delegates through existing managers.

- [ ] Write root→lead→worker and independent-review lifecycle tests with normalized role/department/handoff events.
- [ ] Test cycles, unauthorized edges, depth/concurrency/request/cost exhaustion, cancellation, child failure, unknown usage, and process recovery.
- [ ] Implement guarded nested read/planning delegation; keep mutating implementation owned by the existing root-authorized durable team pipeline.
- [ ] Run focused hierarchy tests and commit.

### Task 8: Blueprint-directed implementation, review, and repair

**Files:**
- Modify: `packages/core/src/team-agent-manager.ts`
- Modify: `packages/core/src/team-run-supervisor.ts`
- Modify: `packages/contracts/src/team-runs.ts`
- Modify: `packages/cli/src/assembly.ts`
- Test: `packages/core/test/team-run-supervisor.integration.test.ts`
- Test: `packages/cli/test/assembly.test.ts`

**Interfaces:**
- Adds optional immutable company-goal/assignment correlations to durable team runs without changing historical V1 descriptor interpretation.
- Maps approved builder, reviewer, and repair capabilities to existing profile/model routes and intersects role tools with parent/profile policy.

- [ ] Write an end-to-end scripted test for parallel company builders, independent review, bounded repair, staged candidate, permission-controlled apply, and parent synthesis.
- [ ] Add failure/cancellation/recovery/accounting tests and assert inactive roster roles emit no activity.
- [ ] Implement only correlation and policy adapters around the existing worktree and review engine; do not fork a second implementation runtime.
- [ ] Run team, company, assembly, and recovery suites and commit.

### Task 9: CLI company operations and goal launch

**Files:**
- Create: `packages/cli/src/commands/company.ts`
- Modify: `packages/cli/src/commands/create.ts`
- Modify: `packages/cli/src/commands/types.ts`
- Modify: `packages/cli/src/commands/goal.ts`
- Test: `packages/cli/test/company-commands.test.ts`
- Test: `packages/cli/test/goal-command.test.ts`

**Interfaces:**
- Adds `/company`, `/company blueprint`, `/company activity`, `/company knowledge`, `/company amendments`, `/company approve-amendment <id>`, and `/company reject-amendment <id>`.
- On an approved V2 company, `/goal <objective>` persists the goal and submits the bounded company-launch prompt; non-company and V1 command behavior remains compatible.

- [ ] Write command parsing, state, permission, stale-revision, and launch tests.
- [ ] Implement concise truthful rendering and wire services through command dependencies.
- [ ] Run focused command/runtime tests and commit.

### Task 10: Evidence-backed learning and amendments

**Files:**
- Create: `packages/core/src/company-learning.ts`
- Create: `packages/core/src/company-amendments.ts`
- Modify: `packages/cli/src/assembly.ts`
- Test: `packages/core/test/company-learning.test.ts`
- Test: `packages/core/test/company-amendments.test.ts`

**Interfaces:**
- Produces `recordCompanyKnowledge(evidence)` and propose/approve/reject amendment services.
- Knowledge entries require source type, source identifier, evidence text, timestamp, and confidence; organization changes always target an exact approved blueprint revision.

- [ ] Test user/evidence provenance, deduplication, contradictions, bounded context selection, and secret-like-content rejection.
- [ ] Test amendment review, stale base, approval creating a new immutable blueprint revision, rejection, and historical-session stability.
- [ ] Implement automatic post-goal learning and future-context selection without automatic organization changes.
- [ ] Run focused tests and commit.

### Task 11: Documentation, exhaustive verification, and delivery

**Files:**
- Modify: `docs/AGENT_COMPANY_ONBOARDING.md`
- Modify: `docs/CLI.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `README.md`

**Interfaces:**
- Documents only capabilities backed by tests and explicitly lists remaining exclusions.

- [ ] Run all focused company/onboarding/team suites repeatedly and resolve nondeterminism rather than retrying it away.
- [ ] Run `npm run check` and `npm run check:native` from a clean worktree.
- [ ] Inspect `git status`, complete diff, generated files, and secret patterns; stage only intended files.
- [ ] Push focused branches/commits, open reviewable PRs, monitor both verification jobs, address failures, and merge only when green.
- [ ] Fetch and non-destructively synchronize canonical `main`; verify `main == origin/main`, canonical status is clean, and no intended commit remains stranded.
