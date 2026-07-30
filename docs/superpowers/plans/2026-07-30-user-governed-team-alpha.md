# User-Governed Team Alpha Implementation Plan

**Goal:** Ship Recurs `0.1.0` as a truthful, publicly installable alpha where
users can narrow and control real bounded sub-agent execution.

**Design:** `docs/superpowers/specs/2026-07-30-user-governed-team-alpha-design.md`

**Method:** Strict red-green-refactor. Every behavioral production change
starts with a focused test that fails for the missing behavior. Preserve
historical contracts and use the existing scheduler, budget, permission,
provider, company, event, and release authorities.

## Delivery map

The goal ships through four ordered PRs:

1. `codex/user-governed-team-alpha`: policy contracts, durable preference,
   frozen goal authority, runtime enforcement, CLI/onboarding, and docs.
2. `codex/team-alpha-evidence`: repeated Codex Company Proof campaigns,
   evidence-backed tuning, and sanitized evaluation records.
3. `codex/team-alpha-presentation`: final product copy, terminal polish limited
   to proven behavior, quick start, troubleshooting, and release notes.
4. `codex/v0.1.0-alpha-release`: version/tag metadata and the owner-controlled
   npm/GitHub/curl/Homebrew publication workflow.

Each PR is based on synchronized `main`, has focused commits, passes
`npm run check`, receives green Linux/macOS CI, merges before the next PR, and
leaves canonical local `main` equal to `origin/main`.

## Milestone 1: User-governed team policy

### Task 1: Versioned policy contract

**Files**

- Create `packages/contracts/src/team-controls.ts`
- Modify `packages/contracts/src/index.ts`
- Create `packages/contracts/test/team-controls.test.ts`

**RED**

Add literal-fixture tests proving:

- every topology and communication/review option parses;
- unknown fields and versions fail;
- integer, cost, and collection bounds fail closed;
- returned contracts are deeply frozen;
- deterministic recommended policies derive from each V6 operating mode; and
- a custom policy cannot exceed the selected mode.

Run:

```bash
npx vitest run packages/contracts/test/team-controls.test.ts
```

Confirm failure occurs because the contract API does not exist.

**GREEN**

Add:

- `TeamTopologyV1`
- `TeamEscalationV1`
- `TeamIndependentReviewV1`
- `TeamControlPolicyV1`
- `EffectiveTeamControlPolicyV1`
- `parseTeamControlPolicyV1`
- `parseEffectiveTeamControlPolicyV1`
- `recommendedTeamControlPolicy`
- `validateTeamControlPolicyAgainstMode`
- `effectiveTeamControlPolicy`

Use stable storage IDs and existing contract utilities. Effective values are
the minimum of the user preference and V6 company/team/orchestration ceilings.
The editable policy carries an optimistic revision and exact operating-mode
ID/version binding. The effective snapshot carries that source revision plus
the exact approved blueprint ID/revision. Do not create a second
operating-mode table.

Re-run the focused test and refactor only after green.

### Task 2: Private project preference store

**Files**

- Create `packages/core/src/file-team-control-policy-store.ts`
- Modify `packages/core/src/index.ts`
- Create `packages/core/test/file-team-control-policy-store.test.ts`

**RED**

Prove with real temporary directories:

- a missing preference returns `null`;
- first publication and optimistic revision replacement succeed;
- stale replacement fails;
- repeated identical publication is idempotent;
- malformed, oversized, symlinked, or permission-unsafe state fails closed;
- concurrent writers produce one authoritative revision; and
- the stored document is private and survives a new store instance.

Run:

```bash
npx vitest run packages/core/test/file-team-control-policy-store.test.ts
```

**GREEN**

Implement a small store over existing private-state helpers. Key the record by
the same canonical workspace identity used by CLI assembly. Store no project
content, credentials, or provider data. Do not introduce a general
configuration framework.

### Task 3: Frozen company-goal authority V2

**Files**

- Modify `packages/contracts/src/company-goals.ts`
- Modify `packages/contracts/test/company-goals.test.ts`
- Modify `packages/core/src/jsonl-company-goal-store.ts`
- Modify `packages/core/test/jsonl-company-goal-store.test.ts`
- Update exact V1 fixtures only where compatibility assertions require it

**RED**

Add tests proving:

- all historical V1 records still parse unchanged;
- V2 requires the exact operating-mode, blueprint, selected-control, and
  effective-control snapshots;
- V2 rejects mismatched mode versions, widening effective values, or mutable
  snapshot aliases;
- V1 and V2 coexist in one append-only store;
- resumption returns the original V2 snapshot after the current preference
  changes; and
- unknown future versions fail closed.

**GREEN**

Add `CompanyGoalRunV2` and a `CompanyGoalRun` compatibility union. Keep V1
parsing byte-shape compatible. New goals write V2; no migration rewrites
historical records.

### Task 4: Topology and communication validation

**Files**

- Create `packages/core/src/team-control-policy.ts`
- Modify `packages/core/src/index.ts`
- Create `packages/core/test/team-control-policy.test.ts`
- Modify `packages/core/test/company-goal-supervisor.test.ts`

**RED**

Using real blueprint and plan fixtures, prove:

- `focused` rejects unnecessary parallel implementation branches;
- `parallel` permits only dependency-ready approved branches up to its ceiling;
- `hierarchical` requires assignment parents to follow approved reporting and
  delegation edges;
- `research_heavy` permits only read-only research expansion before mutation;
- `review_heavy` requires an independent reviewer;
- `manager_only` rejects a root escalation from a non-root grandchild;
- `root_allowed` accepts one attributable blocker escalation;
- active-role, concurrency, depth, request, cost, review, and repair ceilings
  cannot widen the blueprint or operating mode; and
- a violation starts no executor.

**GREEN**

Implement pure validation and effective-policy helpers. Represent escalation as
a bounded structured handoff attached to assignment evidence/events, not as
shared free-form chat. Reuse blueprint `reportsTo` and `delegatesTo`.

### Task 5: Supervisor enforcement and recovery

**Files**

- Modify `packages/core/src/company-goal-supervisor.ts`
- Modify `packages/core/src/company-agent-manager.ts` only if claim-time
  intersection cannot remain in the supervisor
- Modify `packages/core/src/events.ts`
- Modify `packages/core/test/company-goal-supervisor.test.ts`
- Modify `packages/core/test/events.test.ts`

**RED**

Prove end-to-end:

- new goals freeze V2 authority before the first child starts;
- effective concurrency is observed during parallel execution;
- claim-time validation catches a tampered or invalid plan;
- current preference edits do not affect an active/interrupted goal;
- cancellation and failure preserve exact policy and truthful agent state;
- budget exhaustion starts no additional assignment;
- unknown cost remains unknown;
- structured assignment, handoff, escalation, review, repair, and synthesis
  events include role/model provenance; and
- inactive roster roles emit no working event.

**GREEN**

Thread the one frozen effective policy through the existing
`CompanyGoalSupervisor` and shared ledger. Do not add another scheduler,
executor, retry loop, or accounting object.

### Task 6: CLI service and `/agents` controls

**Files**

- Create `packages/cli/src/team-control-service.ts`
- Modify `packages/cli/src/index.ts`
- Modify `packages/cli/src/assembly.ts`
- Modify `packages/cli/src/commands/types.ts`
- Modify `packages/cli/src/commands/agents.ts`
- Modify `packages/cli/test/commands.test.ts`
- Add a focused test file if `commands.test.ts` becomes less readable

**RED**

Prove:

- `/agents controls` distinguishes saved, hard-ceiling, and effective values;
- `/agents configure` publishes only an explicitly confirmed valid policy;
- invalid or widening values leave state unchanged;
- `/agents reset` restores the deterministic recommended policy;
- changing the operating mode exposes an incompatible saved preference instead
  of silently widening it;
- structured/headless contexts reject interactive configuration cleanly; and
- a new session uses the saved project preference while historical runs do
  not.

**GREEN**

Extend the existing command rather than adding `/team`. Keep formatting in
small pure render helpers. The service owns store/revision operations; the
command owns parsing, confirmation, and messages.

### Task 7: Guided onboarding and goal-start summary

**Files**

- Modify `packages/cli/src/guided-onboarding.ts`
- Modify `packages/cli/test/guided-onboarding.test.ts`
- Modify `packages/cli/src/commands/goal.ts`
- Modify `packages/cli/test/goal-command.test.ts`
- Modify `packages/cli/src/company-operating-view.ts`
- Modify `packages/cli/test/company-operating-view.test.ts`

**RED**

Prove:

- the default path adds no required prompt and saves `recommended`;
- the optional advanced path edits only values within the selected mode;
- cancellation publishes nothing;
- a goal-start summary renders topology, effective limits, escalation, review,
  repair, requests, and reported-cost ceiling;
- operating snapshots show only activated agents and exact model routes; and
- noninteractive onboarding retains deterministic defaults.

**GREEN**

Add one optional “Customize team controls?” decision after operating intensity.
Reuse the CLI service and rendering. Do not redesign provider, company, or
roster onboarding.

### Task 8: Approval-gated adaptation

**Files**

- Modify `packages/contracts/src/company-knowledge.ts` only if a new typed
  recommendation needs a versioned contract
- Modify `packages/core/src/company-learning.ts`
- Modify `packages/core/src/company-amendments.ts`
- Modify corresponding tests
- Modify `packages/cli/src/commands/company.ts`
- Modify `packages/cli/test/company-commands.test.ts`

**RED**

Prove:

- completed evidence can propose a narrower topology or limit;
- one run cannot claim comparative superiority;
- proposals include exact supporting run IDs and metrics;
- no proposal can widen permissions, tools, model eligibility, or blueprint
  delegation;
- rejection changes nothing;
- approval publishes a future preference/blueprint revision; and
- historical goals retain prior authority.

**GREEN**

Reuse amendments and evidence stores. Add the smallest typed recommendation
needed; do not create a generic self-modification engine.

### Task 9: Milestone documentation and full verification

**Files**

- Modify `PRODUCT.md`
- Modify `ARCHITECTURE.md`
- Modify `docs/FEATURE_STATUS.md`
- Modify `docs/CLI.md`
- Modify `docs/AUTO_MODEL_TEAMS.md`
- Modify `README.md` only for concise implemented control language

Document exact commands and boundaries. Do not claim public installation,
universal model superiority, peer chat, autonomous improvement, or persistent
workers.

Run:

```bash
npx vitest run packages/contracts/test/team-controls.test.ts
npx vitest run packages/core/test/file-team-control-policy-store.test.ts
npx vitest run packages/contracts/test/company-goals.test.ts
npx vitest run packages/core/test/team-control-policy.test.ts
npx vitest run packages/core/test/company-goal-supervisor.test.ts
npx vitest run packages/cli/test/commands.test.ts
npx vitest run packages/cli/test/guided-onboarding.test.ts
npx vitest run packages/cli/test/goal-command.test.ts
npx vitest run packages/cli/test/company-operating-view.test.ts
npm run check
npm run package:smoke-install
npm run package:smoke-install-bun
```

Inspect status, full diff, generated artifacts, package contents, and secrets.
Commit intentional files, push, open a PR, wait for Linux/macOS CI, address
actionable failures, merge green, and synchronize canonical `main`.

## Milestone 2: Real Codex proof and tuning

Create a fresh branch from merged Milestone 1.

### Task 10: Baseline readiness

- Verify exact Codex app-server authentication and Sol/Terra/Luna catalog
  without exposing credentials.
- Verify all three immutable Company Proof fixtures and formation scenarios.
- Freeze harness version, model routes, efforts, scenario versions, order
  randomization, request/cost allowances, and sanitized output path.
- Run one safe smoke; fix harness defects through TDD before campaigns.

### Task 11: Repeated campaigns

For each built-in coding scenario, run at least three alternating comparisons:

- strong parent only;
- selected configured company; and
- one authorized alternative team.

Separately compare Quick, Guided, and Deep onboarding. Preserve raw private
records and publish sanitized metrics only.

### Task 12: Evidence-driven tuning

Classify each observed issue as correctness, activation waste, context
duplication, weak handoff, review value, recovery, latency, or measurement.
Change code only for reproducible failures or material repeated waste, with a
failing regression test first. Re-run affected campaigns after each accepted
change.

### Task 13: Evidence PR

Update `docs/COMPANY_EVALUATION.md`, feature status, and public-alpha status
with sample counts, exact dates, pass rates, usage, latency, unknown costs, and
limitations. Merge only with green CI and clean canonical synchronization.

## Milestone 3: Product presentation

Create a fresh branch from merged Milestone 2.

### Task 14: First-run and daily-use audit

Capture clean source-install, provider setup, Codex setup, Quick onboarding,
advanced team controls, company approval, goal execution, interruption,
resumption, apply, and failure guidance in an 80-column terminal. Record every
misleading, redundant, overflowing, or dead-end surface.

### Task 15: Focused presentation fixes

Fix only demonstrated presentation problems. Preserve command semantics and
accessibility. Update:

- README demonstration and five-minute quick start;
- provider/Codex authentication;
- team/onboarding explanation;
- permissions/security;
- troubleshooting;
- contribution and release documentation; and
- changelog/roadmap truth.

Run presentation tests, installed-package smokes, full checks, CI, review, and
merge.

## Milestone 4: Public distribution

Create a fresh release branch from merged Milestone 3.

### Task 16: Release preflight

Follow `docs/RELEASING.md` exactly:

- confirm public repository, protections, release environment, trusted
  publisher, clean tag, and changelog;
- verify `0.1.0-alpha.1` availability/ownership on npm before publication;
- build one tarball and record integrity, checksum, compressed/unpacked size,
  and production install footprint;
- rerun npm and pinned Bun clean-prefix smokes;
- render curl and Homebrew assets from the exact archive; and
- verify generated GitHub attestations and workflows reference identical
  bytes.

Ask for the minimum owner action only if npm bootstrap or environment approval
cannot be completed through existing authenticated tooling.

### Task 17: Publish and verify

- Merge the green release PR.
- Dispatch the exact protected tag workflow.
- Monitor npm publication and GitHub Release checks.
- Verify `npm install -g recurs` in a clean environment.
- Verify `bun add -g recurs` installs the same package and executes through
  Node.js.
- Verify checksum-bound curl installation.
- Verify generated Homebrew installation.
- Run `recurs --version`, `recurs doctor`, help, and safe onboarding smoke from
  every installed path.
- Confirm package integrity and release checksums match the approved tarball.

### Task 18: Completion audit

Against the design and active goal, inspect:

- every named command and user control;
- every enforcement and recovery invariant;
- real-provider evidence;
- README and feature claims;
- public install paths;
- GitHub release/check/attestation state;
- open PRs and CI;
- local/remote commit equality;
- worktrees and branches for stranded commits; and
- clean canonical status.

Do not mark the goal complete until every required item has direct evidence.
