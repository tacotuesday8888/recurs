# Production Alpha Recovery And Evidence Hardening Plan

> Implement this plan inline with test-first changes and independent review
> after every focused task.

**Goal:** Ship the smallest complete set of production-alpha hardening changes
identified by independent architecture, reliability, and product audits.

**Architecture:** Preserve the existing TypeScript-first seven-package engine.
Reuse current stores, permission intents, company supervisor, benchmark
records, and command registry. Add no new orchestration framework.

**Branch:** `codex/company-recovery-routing-alpha`

## Task 1 — lock-safe session journal recovery

**Files**

- Modify `packages/core/src/jsonl-session-store.ts`
- Modify `packages/core/test/session.test.ts`

**TDD**

1. Add a test that holds the session mutation lock while a torn tail exists.
   `load`, `loadState`, and `list` must not change the journal or quarantine and
   must fail busy.
2. Add a test that releases the lock and proves the same ordinary read repairs
   exactly the torn suffix.
3. Add a V2 test proving an already lock-owning mutation repairs then appends
   without recursively acquiring the lock.
4. Run the focused test and observe failure before implementation.
5. Introduce a private typed incomplete-tail signal, non-mutating first read,
   and lock-held repair helper. Truncate the existing inode and sync it; do not
   replace the pathname.
6. Re-run the focused suite repeatedly and related session/coordinator suites.
7. Commit only the durability change.

## Task 2 — typed benchmark approval boundary

**Files**

- Modify `packages/cli/src/assembly.ts`
- Modify `packages/cli/src/company-benchmark-execution.ts`
- Modify `packages/cli/test/company-benchmark-execution.test.ts`
- Modify focused assembly tests only if the injected typed seam requires them

**TDD**

1. Replace the misleading presentation-string test with a table over typed
   `PermissionIntent` values.
2. Prove exact fixed apply/orchestration and immutable fixture verification
   operations are admitted.
3. Prove arbitrary reads, redirects, substitutions, nested shells, destructive
   Git/removal, environment inspection, package installation, network,
   credentials, and look-alike presentation text are denied.
4. Add an end-to-end fake-provider attempt proving denied commands never spawn.
5. Run the focused tests and observe failure.
6. Add the smallest optional internal approval-handler seam to standalone
   assembly and inject the benchmark policy. Remove string-prefix authority.
7. Re-run focused tests repeatedly and commit.

## Task 3 — company-goal resume and duplicate prevention

**Files**

- Modify `packages/cli/src/assembly.ts`
- Modify `packages/cli/src/commands/types.ts`
- Modify `packages/cli/src/commands/company.ts`
- Modify `packages/cli/src/commands/goal.ts`
- Modify `packages/cli/src/commands/create.ts`
- Modify `packages/core/src/company-goal-supervisor.ts`
- Modify focused command/assembly tests
- Modify focused supervisor ownership tests

**TDD**

1. Add `/company resume <exact-id>` command tests for local/manual/Act
   authority, explicit approval, Full Access, stale authority, unknown run,
   terminal idempotence, interrupted completion, and truthful failure.
2. Add concurrent two-supervisor tests proving a parent-scoped durable lease
   allows exactly one start and no duplicate journal, request, child, team, or
   event.
3. Add `/goal` tests that detect an existing matching live/interrupted run and
   refuse a model launch. Keep the supervisor's under-lease check authoritative.
4. Add an assembly recovery test proving durable completed child/team work is
   settled without duplicate provider or assignment execution.
5. Add fail-closed tests for concurrent resume, unresolved siblings, stale
   authority, terminal state, waiting-for-approval, Plan, remote, automated,
   unattended, and missing exact approvals.
6. Observe focused failures.
7. Retain one supervisor instance in assembly and expose only its exact
   `resume` operation through command dependencies.
8. Reuse the existing parent/run owner-lease primitive under a distinct
   company-goal root. Hold the lease through validation and execution.
9. Build the trusted tool context from the pinned parent, current invocation,
   company capability policy, and existing delegation budget. Do not widen
   permissions.
10. Re-run focused recovery tests repeatedly and commit.

## Task 4 — enforce blueprint activation

**Files**

- Modify `packages/contracts/src/company-goals.ts`
- Modify `packages/core/src/company-blueprint-v2.ts`
- Modify `packages/core/src/company-role-charter.ts`
- Modify `packages/core/src/company-goal-supervisor.ts`
- Modify `packages/core/src/team-run-supervisor.ts`
- Modify `packages/core/src/team-run-state.ts` only if reservation validation
  owns the repair-slot calculation there
- Modify `packages/contracts/test/company-goals.test.ts`
- Modify `packages/core/test/company-goal-supervisor.test.ts`
- Modify focused team-supervisor/state tests
- Modify blueprint/compiler/context contract tests

**TDD**

1. Add runtime tests for missing default roles, non-default on-demand roles,
   mandatory review, unknown roles, unsupported assignment profiles, and
   historical stored plans.
2. Make `defaultActiveRoleIds` the executable set. Model-authored assignments
   cannot activate another roster role, and every non-root active role must
   appear in the plan.
3. Ensure the deterministic stable compiler gives every operating mode a
   minimal functional root/implementation/review spine, without
   changing role IDs: depth 1 starts root/builder/reviewer; depth 2+ starts
   root/implementation-lead/builder/reviewer. Keep optional roster roles
   inactive by default: `maxActiveRoles` is a ceiling, not a target. Active
   reporting ancestry must remain inside the active set. Give the stable
   builder Repair capability and make the optional security/release reviewer a
   direct `review_v1` role.
4. Enforce the execution profiles the real product supports: direct
   `explore_v1`/`review_v1`, paired team `implement_v2`, and only
   independent-review `review_v2`. Reject standalone `implement_v1`,
   `repair_v1`, or non-anchor `review_v2` assignments before execution.
5. Advertise only default-active roles as executable; label the rest inactive
   and remove inactive delegation targets from role charters.
6. Restrict conditional team repair authority to an active implementation
   assignment whose role has Repair plus `implementation_v1`. An inactive
   roster specialist can never become the repair binding; omit repair when no
   active assigned implementation role has it.
7. When company repair is omitted, reserve no repair slots and terminate
   truthfully as `changes_requested` if review requests changes. Do not fail
   late or spend a repair request that lacks approved authority.
8. Count paired implementation/review phases by their actual simultaneous
   team concurrency, not the number of sequential assignment records. Add an
   Economy end-to-end regression for its builder then reviewer path.
9. Preserve historical parsing/loading, but revalidate stored plans on resume
   and fail before provider, child, team, event, budget, or journal mutation.
10. Preserve strict role/delegation/depth/budget/tool/permission checks.
11. Re-run contract, compiler, context, charter, and supervisor suites
   repeatedly and commit.

## Task 5 — Auto evidence honesty

**Files**

- Modify `packages/core/src/model-team-evaluation.ts` only if its returned
  rationale is misleading
- Modify `packages/cli/src/model-team-service.ts` only if its returned
  selection/status contract is misleading
- Modify `packages/cli/src/commands/model.ts`
- Modify model-team command/service tests
- Modify public Auto documentation in Task 6

**TDD**

1. Add command/service assertions that distinguish a recorded configured
   lineup from a comparative winner.
2. Replace “strongest/best” text with “most-supported eligible recorded
   configured lineup.”
3. State that Repair can be a configured fallback even when it was not
   activated in the recorded run.
4. Keep local confirmation, exact connection revalidation, immutable route
   snapshots, deterministic ranking, and parent fallback unchanged.
5. Do not add a benchmark winner contract or automatic general-goal task
   classifier before repeated evidence exists.
6. Re-run focused service/command suites repeatedly and commit the focused
   command/test truth fix. Leave public documentation to Task 6.

## Task 6 — company discoverability and onboarding truth

**Files**

- Modify `packages/cli/src/commands/foundation.ts`
- Modify `packages/cli/src/commands/company.ts`
- Modify `packages/cli/src/company-operating-view.ts`
- Modify `packages/cli/src/cli-help.ts`
- Modify `packages/cli/src/guided-onboarding.ts`
- Modify `packages/cli/test/guided-onboarding.test.ts`
- Modify focused interactive/top-level help, benchmark-help, and
  company-operating-view tests
- Modify `README.md`, `docs/CLI.md`, `docs/FEATURE_STATUS.md`, and
  `docs/AUTO_MODEL_TEAMS.md`
- Modify `PRODUCT.md` and company-evaluation/proof documentation only where
  current route snapshots are mislabeled

**TDD**

1. Assert interactive help includes `/company`.
2. Assert no-roster completion gives the concrete `recurs setup` next step.
3. Add a 21-run operations regression proving totals and unresolved/current
   state use the full history while only Recent is capped. Interrupted work
   must show no active roles, and stopped progress must name cancellation.
4. Keep all onboarding choices and semantics unchanged.
5. Update public text to distinguish optional company formation, structural
   lineup records, and comparative evidence.
6. Remove nonexistent `/checkpoint` and `/help <command>` claims. Describe
   Company Proof arms as the selected parent-only baseline versus the
   currently configured saved role-route snapshot, not strong/recommended
   winners.
7. Re-run presentation/onboarding/command tests and commit.

## Task 7 — proof, review, and delivery

1. Run all focused suites repeatedly.
2. Run `npm run check`.
3. Run installed npm smoke and pinned Bun installer smoke.
4. Run deterministic offline Quick, Guided, Deep, and company-goal flows.
5. Run the safe real Codex catalog/read-only canary, then one bounded
   onboarding and company-goal dogfood if the reviewed installed runtime is
   still available. Store only sanitized evidence.
6. Inspect `git status`, complete diff, generated files, permissions, and
   secrets.
7. Request independent architecture/correctness, security, and product-truth
   reviews; fix findings with focused tests.
8. Push, open a ready PR, monitor Linux/macOS/Bun checks, and address failures.
9. Merge only when green. Fetch and fast-forward canonical `main`.
10. Verify local `main == origin/main`, canonical status is clean, and no
    intended feature commit remains stranded.

## Acceptance

- Ordinary session reads cannot mutate a journal concurrently with its writer.
- Configured benchmark preconsent is typed and exact; arbitrary shell requests
  are denied before spawn.
- An interrupted company goal can be resumed explicitly without duplicate
  execution, and a new `/goal` cannot silently duplicate it.
- Blueprint activation fields constrain actual plans.
- Inactive roster roles cannot gain assignment, delegation, or repair
  authority, and low modes retain a runnable coding/review spine.
- Models Auto never describes structural completion as comparative superiority.
- `/company`, accurate operations state, and the optional-roster recovery path
  are discoverable.
- Full local checks, package smokes, dogfood, independent reviews, and PR CI
  are green; local and remote `main` are identical.
