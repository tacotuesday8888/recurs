# Company Dogfooding V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Recurs's installed company evaluation workflow useful for real-provider formation dogfooding and read-only scoring of real durable company goals, with exact connection selection, truthful Codex handling, and visible bounded progress.

**Architecture:** Keep `CompanyEvaluationReportV1`, `evaluateCompanyFormation`, and `evaluateCompanyGoalExecution` as the only scoring authority. Extend the CLI command with a small discriminated scenario parser, select one exact saved connection without changing the registry primary, and load historical goal/blueprint/session state through existing strict private stores. Human progress is an ephemeral callback; JSON output remains silent and machine-clean. No evaluation path starts a company goal, mutates a project, imports a credential, or widens a Plan-only runtime.

**Tech Stack:** TypeScript 6, Node.js 22, Vitest, existing Recurs private stores and provider registry, npm packed-install smoke, Swift native verification.

## Global Constraints

- Work only on `codex/company-dogfood-v2` in the isolated `.worktrees/company-dogfood-v2` checkout.
- Preserve no-network-by-default behavior. Formation contacts a provider only with both `--configured` and `--allow-network`.
- `company_goal_execution_v1` is a read-only projection over one exact durable run; it never resumes, retries, approves, applies, or contacts a provider.
- `--connection <exact-id>` selects an existing connection for this evaluation only and never changes the registry primary.
- Direct environment, literal-loopback local, and brokered native-model connections may run configured formation when their existing authority is ready. Delegated Codex remains local, user-present, foreground, and Plan-only and must receive an explicit unsupported-boundary error for formation evaluation.
- Human progress goes to stderr only for non-JSON output. JSON stdout and stderr remain clean on success.
- Reports contain scenario metrics and sanitized failures only—never prompts, answers, credentials, environment values, private paths, connection labels, or raw model output.
- Use TDD, focused commits, full TypeScript/native/package verification, and PR/CI/merge/sync delivery.

---

### Task 1: Versioned scenario discovery and exact argument contracts

**Files:**
- Modify: `packages/cli/src/company-evaluation-command.ts`
- Modify: `packages/cli/src/cli-help.ts`
- Modify: `packages/cli/test/run-mode.test.ts`

**Interfaces:**
- Produce `COMPANY_EVALUATION_SCENARIOS`, a frozen display-safe catalog for `company_formation_v1` and `company_goal_execution_v1`.
- Replace the formation-only options with this closed union:

```ts
export type CompanyEvaluationCommandOptions =
  | {
      readonly action: "list";
      readonly json: boolean;
    }
  | {
      readonly action: "run";
      readonly scenario: "company_formation_v1";
      readonly mode: "offline" | "configured";
      readonly allowNetwork: boolean;
      readonly connectionId: string | null;
      readonly json: boolean;
    }
  | {
      readonly action: "run";
      readonly scenario: "company_goal_execution_v1";
      readonly runId: string;
      readonly json: boolean;
    };
```

- [x] **Step 1: Write failing parser and routing tests**

  Cover `--list`, `--list --json`, configured formation with `--connection`, execution with required `--run`, stable scenario order, and rejection of crossed flags such as execution plus `--configured`, offline plus `--connection`, or formation plus `--run`.

- [x] **Step 2: Confirm the focused tests fail**

  Run: `npx vitest run packages/cli/test/run-mode.test.ts -t "installed company evaluation command"`

  Expected: failures because list, connection selection, and execution-run parsing are absent.

- [x] **Step 3: Implement the strict parser and safe catalog renderer**

  Parse every value with the existing bounded ID rules or an equivalent exact ASCII ID expression. Reject duplicates and unknown flags. Render only stable IDs, versions, network behavior, and a one-line description.

- [x] **Step 4: Update scoped help and run tests twice**

  The help must show:

```text
recurs eval company --list [--json]
recurs eval company [--scenario company_formation_v1] [--configured --allow-network] [--connection <id>] [--json]
recurs eval company --scenario company_goal_execution_v1 --run <exact-run-id> [--json]
```

  Run the focused test twice, then `npm run typecheck`.

- [x] **Step 5: Commit**

  Commit message: `feat(cli): define company evaluation scenarios`

### Task 2: Exact configured connection selection and truthful runtime eligibility

**Files:**
- Modify: `packages/cli/src/company-evaluation-command.ts`
- Modify: `packages/cli/src/process-host.ts`
- Test: `packages/cli/test/company-evaluation-command.test.ts`

**Interfaces:**
- Add an injectable command dependency shape:

```ts
export interface CompanyEvaluationCommandDependencies {
  readonly projectRoot: string;
  readonly dataDirectory?: string;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly nativeOpenAIResponses?: NativeOpenAIResponsesPort;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: CompanyEvaluationProgress) => void | Promise<void>;
}
```

- `copyConfiguredConnection(sourceRoot, targetRoot, connectionId)` selects the exact requested record or current primary, copies only that immutable non-secret record, and retains its exact ID as evaluation primary.
- Support `local_openai_compatible`, `environment_model_provider`, and `brokered_model_provider`; reject `delegated_agent` with the safe message: `Codex and other delegated subscriptions are Plan-only here; choose a direct API or local model connection for company formation evaluation.`

- [x] **Step 1: Write failing service tests**

  Create private registry fixtures for an exact non-primary environment connection, local connection, brokered connection with an injected native port, missing connection, and delegated Codex connection. Assert selection does not mutate the source registry and failures contain no labels, paths, credential-variable names, or fingerprints.

- [x] **Step 2: Confirm focused failure**

  Run: `npx vitest run packages/cli/test/company-evaluation-command.test.ts`

- [x] **Step 3: Implement exact selection and native composition**

  Pass `connectionId` and `nativeOpenAIResponses` into `createStandaloneCompanyOnboarding`. Do not preflight credentials by reading or copying them; ordinary backend resolution remains authoritative.

- [x] **Step 4: Wire native authority through process host**

  `runCliProcess` supplies its existing `nativeOpenAIResponses` port. Progress is wired with its closed event contract in Task 4.

- [x] **Step 5: Run focused tests twice and typecheck**

  Run both command-service and installed-command suites twice, followed by `npm run typecheck`.

- [x] **Step 6: Commit**

  Commit message: `feat(company): select evaluation connections safely`

### Task 3: Installed read-only scoring for durable company goals

**Files:**
- Create: `packages/cli/src/company-evaluation-store.ts`
- Modify: `packages/cli/src/company-evaluation-command.ts`
- Modify: `packages/cli/src/index.ts`
- Test: `packages/cli/test/company-evaluation-store.test.ts`
- Modify: `packages/cli/test/run-mode.test.ts`

**Interfaces:**
- Produce:

```ts
export async function evaluateStoredCompanyGoal(input: {
  readonly dataDirectory: string;
  readonly projectRoot: string;
  readonly runId: string;
  readonly signal?: AbortSignal;
  readonly now?: () => string;
}): Promise<CompanyEvaluationReportV1>;
```

- Derive the existing project directory from the canonical real project root. Strictly load the exact `JsonlCompanyGoalStore` run, exact `FileCompanyBlueprintV2Store` blueprint ID/revision, and exact parent `JsonlSessionStore` state. Require a pinned V2 parent backend and pass its provider/model identity to `evaluateCompanyGoalExecution`.

- [ ] **Step 1: Write failing store-adapter tests**

  Cover one complete run, unknown cost, incomplete/failed run, nonexistent ID, corrupt state, blueprint mismatch, revision mismatch, legacy/unpinned parent session, cancellation, and sanitized failures. Assert the source files are byte-identical before and after evaluation.

- [ ] **Step 2: Confirm focused failure**

  Run: `npx vitest run packages/cli/test/company-evaluation-store.test.ts`

- [ ] **Step 3: Implement the read-only adapter**

  Reuse the existing stores directly; do not add a second persistence format or copy project state into the evaluation temp root. Use the run's `createdAt` as `startedAt` and the injected current time as `completedAt`, preserving nonnegative timestamp order.

- [ ] **Step 4: Route the execution scenario**

  `runCompanyEvaluationCommand` dispatches formation to the temporary evaluation home and execution scoring to `evaluateStoredCompanyGoal`. The execution path ignores provider configuration entirely and performs no network calls.

- [ ] **Step 5: Run focused tests twice and typecheck**

  Run the new adapter, existing evaluator, and installed routing suites twice, followed by `npm run typecheck`.

- [ ] **Step 6: Commit**

  Commit message: `feat(company): score stored company goals`

### Task 4: Natural bounded progress for formation and evaluation

**Files:**
- Modify: `packages/cli/src/company-evaluation.ts`
- Modify: `packages/cli/src/company-evaluation-command.ts`
- Modify: `packages/cli/src/guided-onboarding.ts`
- Test: `packages/cli/test/company-evaluation.test.ts`
- Test: `packages/cli/test/guided-onboarding.test.ts`
- Test: `packages/cli/test/run-mode.test.ts`

**Interfaces:**
- Add a closed progress contract:

```ts
export type CompanyEvaluationProgress =
  | { readonly phase: "preparing"; readonly message: string }
  | { readonly phase: "interview"; readonly message: string }
  | { readonly phase: "research"; readonly message: string }
  | { readonly phase: "proposal"; readonly message: string }
  | { readonly phase: "scoring"; readonly message: string };
```

- Messages contain only phase, counts, and scenario IDs. They never contain the question, answer, prompt, evidence, provider label, path, or model output.

- [ ] **Step 1: Write failing progress and onboarding-presentation tests**

  Assert ordered formation phases, no progress on JSON output, bounded human stderr progress, and guided onboarding headings for interview question count, completed investigations, proposal review, and approval. Preserve all existing choices and semantics.

- [ ] **Step 2: Confirm focused failure**

  Run: `npx vitest run packages/cli/test/company-evaluation.test.ts packages/cli/test/guided-onboarding.test.ts packages/cli/test/run-mode.test.ts`

- [ ] **Step 3: Emit sanitized phase events**

  `evaluateCompanyFormation` emits preparing before start, interview before each answer boundary, research after settled research, proposal before approval, and scoring after the approved blueprint loads. Await callbacks so ordering is deterministic; callback failure fails safely before claiming success.

- [ ] **Step 4: Tighten guided onboarding presentation**

  Add concise phase lines such as `Company interview · question 2`, `Project understanding · 3 bounded investigations complete`, and `Company proposal · ready for review`. Do not add animation, a full-screen TUI, new choices, or extra model requests.

- [ ] **Step 5: Run focused tests twice and typecheck**

- [ ] **Step 6: Commit**

  Commit message: `feat(cli): show company formation progress`

### Task 5: Installed proof, documentation, and delivery

**Files:**
- Modify: `scripts/evaluate-company.mjs`
- Modify: `scripts/evaluate-company.test.mjs`
- Modify: `scripts/smoke-install-npm-package.mjs`
- Modify: `README.md`
- Modify: `PRODUCT.md`
- Modify: `ARCHITECTURE.md`
- Modify: `docs/CLI.md`
- Modify: `docs/FEATURE_STATUS.md`
- Modify: this plan

**Interfaces:**
- The compatibility npm script forwards scenario, run, connection, configured, network, project, and Recurs-home options to the shared parser/service.
- Packed smoke runs `--list --json`, offline formation, and safe invalid durable-run lookup through the installed binary. It must not need an API key or network.

- [ ] **Step 1: Extend script and packed-artifact tests**

  Assert both stable scenarios are discoverable, offline formation remains green, invalid stored-run lookup is sanitized, and successful JSON commands keep stderr empty.

- [ ] **Step 2: Update current-truth documents**

  Document exact selection, no-primary-mutation, Codex's Plan-only exclusion, execution scoring's read-only nature, human progress, and the remaining absence of real-model quality proof until a user supplies and explicitly authorizes a configured connection run.

- [ ] **Step 3: Run strongest verification**

  Run focused tests repeatedly, then `npm run check`, `npm run package:smoke-install`, and `npm run check:native` outside the enclosing sandbox where Recurs's own process sandbox requires it.

- [ ] **Step 4: Review publication safety**

  Inspect `git status`, complete branch diff, file modes, generated/package output, and secret patterns. Stage only intended files.

- [ ] **Step 5: Deliver**

  Push, open a focused PR, wait for green `verify` and `native`, fix actionable failures, merge, fetch, fast-forward canonical `main`, and verify exact local/remote equality.

- [ ] **Step 6: Prove terminal state**

  Verify canonical status is clean, the feature worktree has no unmerged content, and remaining historical/harness worktrees are reported without destructive cleanup.
