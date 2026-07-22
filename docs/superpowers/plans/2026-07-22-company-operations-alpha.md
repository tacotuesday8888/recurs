# Company Operations Alpha Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing bounded company runtime observable, evaluable, and provable from the packaged Recurs CLI without adding a second orchestrator or speculative background service.

**Architecture:** Keep `CompanyBlueprintV2`, `CompanyGoalRunV1`, `CompanyGoalSupervisor`, and the existing private stores as the only authority. Add pure read-only projections for operators, score completed durable goal runs without interpreting text as authority, and expose the existing safe evaluation path through one noninteractive installed CLI command. All displays are snapshots over immutable or monotonic state; they never start, resume, approve, or mutate work.

**Tech Stack:** TypeScript 6, Node.js 22, Vitest, the existing CLI command registry/process host, existing company contracts and private stores, existing npm package smoke, Swift compatibility verification.

## Global Constraints

- Preserve all historical company, session, goal, evaluation, and operating-mode contracts without migration.
- Do not add a daemon, cloud worker, desktop UI, unbounded recursion, automatic provider ranking, automatic capability installation, or hidden authority.
- Operator output must be truthful about unknown usage, reported cost, inactive roles, interrupted work, blocked assignments, and absent evidence.
- Read-only inspection and offline evaluation must not require an API key, network access, repository mutation, MCP startup, or project commands.
- Configured evaluation remains an explicit `--configured --allow-network` operation and continues to use only saved direct/local connection metadata and environment-owned credentials.
- Keep terminal presentation semantics and branding from PR #98; this milestone adds content, not a full-screen TUI.
- Use TDD, focused commits, full TypeScript/native/package verification, and the normal PR/CI/merge/sync workflow.

---

### Task 1: Truthful company operating projections

**Files:**
- Create: `packages/cli/src/company-operating-view.ts`
- Modify: `packages/cli/src/index.ts`
- Test: `packages/cli/test/company-operating-view.test.ts`

**Interfaces:**
- Produce `renderCompanyOperations(blueprint, runs): string` for a bounded company-wide snapshot.
- Produce `renderCompanyGoalRun(blueprint, run): string` for one exact durable goal run.
- Derive assignment counts, active roles, dependency state, execution correlation, request/reservation/cost accounting, result/evidence presence, failure, and a truthful next-state explanation from stored contracts only.

- [x] **Step 1: Write failing projection tests**

  Cover no runs; running, interrupted, waiting, completed, and failed runs; unknown assignment usage; parent/child dependencies; team and child execution correlation; output bounding/control-character normalization; and a stale role ID rendered as an unknown role rather than trusted text.

- [x] **Step 2: Run the focused test and confirm the module is missing**

  Run: `npx vitest run packages/cli/test/company-operating-view.test.ts`

  Expected: FAIL because `company-operating-view.js` does not exist.

- [x] **Step 3: Implement the pure renderers**

  Use stable headings `Company operations`, `Goal`, `Progress`, `Budget`, `Assignments`, `Result`, and `Next`. Render ratios as exact integers, reported dollars with four decimals, and assignment rows in stored plan order. Never infer that an inactive roster member is working.

- [x] **Step 4: Export and verify**

  Export the module from `packages/cli/src/index.ts`, run the focused test twice, then run `npm run typecheck`.

- [x] **Step 5: Commit**

  Commit message: `feat(cli): add truthful company operating views`

### Task 2: Wire exact run inspection into `/company`

**Files:**
- Modify: `packages/cli/src/commands/company.ts`
- Test: `packages/cli/test/company-commands.test.ts`
- Modify: `docs/CLI.md`

**Interfaces:**
- Add `/company operations` for the bounded aggregate snapshot.
- Add `/company run <run-id>` for exact run inspection.
- Retain `/company activity` as the compact historical list and preserve every existing command.

- [x] **Step 1: Write failing command tests**

  Assert exact parsing, missing run errors, cross-session/blueprint filtering, aggregate output, detailed output, and usage rejection for extra tokens or unsafe IDs.

- [x] **Step 2: Run the focused test and confirm failure**

  Run: `npx vitest run packages/cli/test/company-commands.test.ts`

  Expected: FAIL because the new subcommands are not registered.

- [x] **Step 3: Implement command routing**

  Load company goal records once per inspection command, filter through the existing immutable session/blueprint authority, and pass only validated runs to the pure renderer. Do not add mutation, polling, or implicit resume behavior.

- [x] **Step 4: Document and verify**

  Update the slash-command table and company section in `docs/CLI.md`. Run both company renderer/command tests twice and `npm run typecheck`.

- [x] **Step 5: Commit**

  Commit message: `feat(cli): inspect company goal operations`

### Task 3: Score durable company goal execution

**Files:**
- Modify: `packages/cli/src/company-evaluation.ts`
- Test: `packages/cli/test/company-evaluation.test.ts`
- Modify: `packages/contracts/test/company-evaluation.test.ts` only if a parser edge is uncovered.

**Interfaces:**
- Add `COMPANY_GOAL_EXECUTION_EVALUATION_SCENARIO` with ID `company_goal_execution_v1`.
- Add `evaluateCompanyGoalExecution({ run, blueprint, mode, backend, startedAt, completedAt }): CompanyEvaluationReportV1`.
- Score decomposition, attributable evidence, synthesis, and efficiency from the exact approved blueprint and terminal run. Mark interview and blueprint tailoring `not_applicable`; never convert semantic text quality into a structural pass.

- [ ] **Step 1: Write failing scorer tests**

  Cover completed reviewed execution, missing review/evidence, failed/cancelled/interrupted runs, unknown configured cost, budget ceilings, secret-canary failures, stale blueprint binding, and deterministic report identity.

- [ ] **Step 2: Confirm tests fail**

  Run: `npx vitest run packages/cli/test/company-evaluation.test.ts`

  Expected: FAIL because the execution scenario and scorer do not exist.

- [ ] **Step 3: Implement structural scoring**

  Reuse `createCompanyEvaluationReport` and `sanitizeCompanyEvaluationText`. Validate the run with `parseCompanyGoalRun`, require exact blueprint ID/revision and independent-review coverage, preserve unknown provider cost, and emit bounded evidence without raw prompts.

- [ ] **Step 4: Verify twice**

  Run the CLI and contract evaluation suites twice and `npm run typecheck`.

- [ ] **Step 5: Commit**

  Commit message: `feat(company): evaluate durable goal execution`

### Task 4: Ship offline company evaluation through the installed CLI

**Files:**
- Create: `packages/cli/src/company-evaluation-command.ts`
- Modify: `packages/cli/src/process-host.ts`
- Modify: `packages/cli/src/cli-help.ts`
- Modify: `packages/cli/src/index.ts`
- Modify: `scripts/evaluate-company.mjs`
- Test: `packages/cli/test/process-host.test.ts`
- Test: `scripts/evaluate-company.test.mjs`
- Modify: `scripts/smoke-install-npm-package.mjs`

**Interfaces:**
- Add `recurs eval company [--scenario company_formation_v1] [--json] [-C <path>]` for deterministic offline evaluation.
- Retain configured evaluation only behind `--configured --allow-network` and existing connection resolution.
- Move orchestration from the source-only script into a reusable CLI service; leave the npm script as a thin compatibility wrapper.
- The packed-archive smoke must execute offline evaluation through the installed `recurs` binary and assert safe structured output.

- [ ] **Step 1: Write failing process/help/script tests**

  Cover scoped help, offline JSON, malformed arguments, configured-without-network rejection, abort handling, no provider/credential requirement offline, and no raw interview/prompt content in output.

- [ ] **Step 2: Confirm the installed command is absent**

  Run the focused process-host and script tests.

  Expected: FAIL because `recurs eval company` is not routed.

- [ ] **Step 3: Extract the shared evaluation command service**

  Preserve the existing temporary private home, deterministic `ScriptedProvider`, direct/local configured-connection restriction, cleanup, report rendering, and exit semantics. Accept dependencies explicitly so process-host tests do not contact the network or real home directory.

- [ ] **Step 4: Route help and process execution**

  Add exact argument parsing before interactive startup. Offline evaluation must run unattended; configured evaluation must require both flags. Return exit `0` for passed/partial and `1` for failed/cancelled reports, with CLI misuse returning `2`.

- [ ] **Step 5: Prove the packed artifact**

  Extend `scripts/smoke-install-npm-package.mjs` to invoke the installed binary's offline JSON scenario from the fixture workspace and assert scenario ID, six rubric rows, safe output, and empty stderr.

- [ ] **Step 6: Verify and commit**

  Run focused tests twice, `npm run package:check`, and `npm run package:smoke-install`.

  Commit message: `feat(cli): ship company evaluation command`

### Task 5: Documentation, full verification, and delivery

**Files:**
- Modify: `docs/FEATURE_STATUS.md`
- Modify: `PRODUCT.md`
- Modify: `ARCHITECTURE.md` only where the implemented inspection/evaluation boundary needs clarification.

**Interfaces:**
- Record that operations are read-only snapshots, offline evaluation is structural rather than a claim of model quality, and configured qualitative evaluation still needs a real provider.
- Keep npm/curl/Homebrew publication status truthful: prepared and verified does not mean published.

- [ ] **Step 1: Update current-truth documents**

  Remove the operating-view and installed-evaluation gaps only after their code and tests pass. Keep real-model quality proof and public distribution listed as absent.

- [ ] **Step 2: Run strongest verification**

  Run focused tests repeatedly, then `npm run check`, `npm run package:smoke-install`, and `npm run check:native`.

- [ ] **Step 3: Review publication safety**

  Inspect status, complete diff, file modes, generated output, package contents, and secret patterns. Stage only intended files.

- [ ] **Step 4: Deliver**

  Push the feature branch, open a focused PR, wait for verify/native CI, resolve actionable failures, merge only when green, fetch, and fast-forward canonical `main`.

- [ ] **Step 5: Prove terminal state**

  Verify local `main` equals `origin/main`, canonical status is clean, and every completed commit from this milestone is present through the merged PR. Report remaining clean historical worktrees without deleting them.
