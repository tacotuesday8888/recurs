# Team Orchestration v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the first complete Recurs-owned team workflow: mode-bounded isolated Implement children produce validated patch artifacts, Recurs integrates them deterministically into the parent workspace with rollback on conflict, adaptive Review children return strict verdicts, and users can inspect durable child activity from the CLI.

**Architecture:** Keep `BackendRunCoordinator` and `ChildAgentManager` as the only child execution path. Add three small services around them: a durable activity projection over version-2 child sessions, a Git patch artifact boundary over owned worktree leases, and a foreground team coordinator that composes Implement, integration, and Review phases. Version 3 operating modes define real team width and review standards while continuing to inherit the parent's pinned backend. The parent remains the only integration authority; children never merge, commit, widen permissions, recurse, or run in the background.

**Tech Stack:** TypeScript ESM monorepo, Vitest, existing Recurs contracts/core/tools/CLI packages, safe fixed Git process helpers, JSONL session state, checkpoint store, scripted provider fixtures.

## Global Constraints

- Preserve all v1/v2 operating-mode replay semantics; new behavior receives stable v3 IDs.
- Keep maximum delegation depth at one, retries at zero, and child backend/model selection inherited from the parent until a real provider capability exists.
- Require an Act parent, a clean canonical Git root, and exact committed `HEAD` before isolated implementation begins.
- Child permissions and tool profiles may only narrow the parent security envelope.
- Patch artifacts are bounded, text-only, path-normalized, credential-path denied, hash-addressed, and tied to the exact base revision.
- Recurs applies patches only in input order. A capture/integration failure stops the workflow; a partial integration is rolled back to the pre-integration checkpoint.
- Review responses are strict machine-readable verdicts. Malformed or failed reviews are `unverified`, never approvals.
- A review rejection leaves the integrated patch visible for parent synthesis and explicit correction or `/undo`; it is not silently rolled back or called successful.
- No automatic repair retry, recursive delegation, background execution, cross-process child resume, dirty-workspace snapshot, auto-commit, or independent child model routing in this milestone.
- Keep implementation independent. Research may inform contracts, but do not paste third-party source or add license obligations.

---

### Task 1: Version team policy without changing historical modes

**Files:**

- Modify: `packages/contracts/src/agents.ts`
- Modify: `packages/contracts/test/agents.test.ts`
- Modify: `packages/core/src/session-record-validator.ts`
- Modify: `packages/core/test/session-record-validator.test.ts`
- Modify: `packages/cli/src/commands/agents.ts`
- Modify: `packages/cli/test/session-commands.test.ts`

- [x] Add failing contract tests for stable `*_v3` IDs, v3 as the display-name/default selection, and unchanged exact v1/v2 policies.
- [x] Add a versioned team workflow policy containing maximum Implement workers, initial/max reviewers, and a fail-closed review rule.
- [x] Size policies so maximum Implement plus maximum Review children never exceeds each mode's existing workflow child ceiling.
- [x] Extend strict session validation to accept version 3 and reject mismatched IDs/versions.
- [x] Update `/agents` output to describe real team capacity and keep historical exact-ID selection available.
- [x] Run contracts, core validator, and CLI command tests.

### Task 2: Add durable child activity projection and CLI inspection

**Files:**

- Create: `packages/core/src/agent-activity.ts`
- Create: `packages/core/test/agent-activity.test.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/cli/src/commands/agents.ts`
- Modify: `packages/cli/src/commands/create.ts`
- Modify: `packages/cli/test/session-commands.test.ts`
- Modify: `packages/cli/src/assembly.ts`

- [x] Add failing core tests for parent-scoped child listing, exact child/session lookup, deterministic recency order, terminal usage/evidence, and cross-parent denial.
- [x] Project activity from durable version-2 session state instead of creating a second lifecycle store.
- [x] Add `/agents activity` and `/agents activity <exact-child-or-session-id>` with concise status, profile, task description, usage, changed files, evidence, and isolation revision.
- [x] Do not print full prompts, backend account fingerprints, worktree paths, or secret-bearing configuration.
- [x] Wire the session-backed activity service through command assembly and test unavailable/sessionless behavior.
- [x] Run core activity and CLI command tests.

### Task 3: Capture and validate owned patch artifacts

**Files:**

- Create: `packages/core/src/git-patch-artifacts.ts`
- Create: `packages/core/test/git-patch-artifacts.test.ts`
- Modify: `packages/core/src/index.ts`

- [x] Add failing Git-fixture tests for tracked edits, additions, deletions, deterministic path order, exact base revision, patch hash, and no-change results.
- [x] Add failing security tests for credential paths, path ambiguity, symlinks, submodules, mode changes, binary content, oversized patches, cancellation, dirty parent preflight, and foreign/tampered artifacts.
- [x] Capture untracked files in the isolated child by using intent-to-add only after status/path validation; never stage or commit the parent.
- [x] Generate one bounded full-index patch against the lease's exact revision and verify raw modes, numstat paths, patch paths, and SHA-256.
- [x] Expose only hash/path/size metadata to parent results; keep raw patch text internal to the foreground workflow.
- [x] Add a parent preflight that proves canonical root, clean status, and exact `HEAD` before worker leases are created.
- [x] Run the patch artifact and existing worktree lease tests.

### Task 4: Add exact checkpoint rollback for integration transactions

**Files:**

- Modify: `packages/tools/src/checkpoints.ts`
- Modify: `packages/tools/test/checkpoints.test.ts`
- Modify: checkpoint test doubles in `packages/cli/test/session-commands.test.ts`, `packages/core/test/delegated-agent-executor.test.ts`, and `tests/e2e/coding-agent.test.ts` only if their concrete interfaces require it.

- [x] Add failing tests that restore one explicitly supplied completed checkpoint even when a newer unrelated checkpoint exists.
- [x] Add `restore(checkpoint, cwd)` as an exact, conflict-checked operation; keep `undoLatest` behavior unchanged and share the safe restore implementation.
- [x] Reject incomplete, foreign-session, tampered, already-undone, credential-resolving, or current-state-conflicting checkpoint handles.
- [x] Run the full tools checkpoint suite.

### Task 5: Integrate patch artifacts deterministically with rollback

**Files:**

- Modify: `packages/core/src/git-patch-artifacts.ts`
- Modify: `packages/core/test/git-patch-artifacts.test.ts`

- [x] Add failing tests for ordered disjoint integration, overlapping conflict, base revision drift, unexpected parent dirt, cancellation, and tampered artifact rejection.
- [x] Capture an internal pre-integration checkpoint, validate every artifact, run fixed `git apply --check`, then apply in task order.
- [x] After each apply, verify the workspace's complete dirty path set is contained in the cumulative declared artifact paths.
- [x] On any failure after mutation, capture the failed state and restore the exact internal checkpoint before returning a truthful failure.
- [x] Return integrated artifact IDs, changed paths, rollback status, and safe error details; never auto-commit.
- [x] Run patch artifact, checkpoint, apply-patch, and Git safety tests.

### Task 6: Implement strict adaptive Review panels

**Files:**

- Create: `packages/core/src/agent-review-panel.ts`
- Create: `packages/core/test/agent-review-panel.test.ts`
- Modify: `packages/core/src/index.ts`

- [x] Add failing parser tests for exact JSON approval/change-request verdicts, bounded summary/evidence, unknown fields, Markdown wrappers, oversized output, and malformed responses.
- [x] Add failing coordinator tests for mode-selected initial reviewers, adaptive escalation on disagreement/malformed/failure, maximum reviewer bounds, linked cancellation, and budget exhaustion.
- [x] Run Review children through `ChildAgentManager` in the parent workspace with an evidence-oriented prompt and strict output contract.
- [x] Require unanimous valid approvals for `approved`; any valid change request becomes `changes_requested`; any failure/malformed result without a change request becomes `unverified`.
- [x] Preserve every reviewer session/result and expose normalized reviewer records for parent synthesis.
- [x] Run review-panel and child-manager tests.

### Task 7: Compose the foreground `delegate_team` vertical

**Files:**

- Create: `packages/core/src/team-agent-manager.ts`
- Create: `packages/core/test/team-agent-manager.test.ts`
- Modify: `packages/core/src/events.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/cli/src/assembly.ts`
- Modify: `packages/cli/src/render.ts`
- Modify: `packages/cli/test/render.test.ts`
- Modify: `packages/cli/test/assembly.test.ts`

- [x] Add failing exact-schema tests for `{ description, tasks, review }`, mode worker limits, Act-only execution, permissions, and mutation classification.
- [x] Add failing workflow tests for bounded parallel worktree Implement children, input-order results, capture-before-cleanup, all-worker success gating, cleanup failures, cancellation, and budget reservations.
- [x] Add failing integration/review tests for approved, changes-requested, unverified, capture failure, implementation failure, integration rollback, and review failure after successful integration.
- [x] Register `delegate_team` beside existing single/batch tools. The parent supplies concrete implementation tasks; Recurs supplies lifecycle and policy, not speculative automatic planning.
- [x] Emit normalized team started, patch captured/integrated, review recorded, completed, failed, and cancelled events with stable workflow/task IDs and no raw patch or prompt content.
- [x] Return structured tool metadata containing workflow status, worker evidence, patch hashes, integration result, review verdicts, usage/budget totals, and changed-file/evidence metadata.
- [x] Render concise live team activity and verify the tool is visible only where parent execution/tool policy permits it.
- [x] Run core team, CLI render, assembly, and existing child/batch tests.

### Task 8: Prove the complete workflow through the real engine seams

**Files:**

- Modify: `tests/e2e/coding-agent.test.ts`
- Modify: `packages/cli/test/assembly.test.ts`

- [x] Add a failing deterministic scripted-provider scenario where a parent calls `delegate_team`, an isolated Implement child edits a fixture, Recurs integrates it, a Review child approves it, and the parent synthesizes the result.
- [x] Assert separate durable child sessions, inherited backend/model/permissions, depth one, exact patch evidence, normalized events, parent workspace change, and no worktree leak.
- [x] Add failure scenarios for patch conflict rollback and malformed reviewer output producing `unverified` rather than approval.
- [x] Run targeted E2E tests; the final all-TypeScript run is tracked in Task 10.

### Task 9: Update product truth, research, and security documentation

**Files:**

- Modify: `ARCHITECTURE.md`
- Modify: `PRODUCT.md`
- Modify: `SECURITY.md`
- Modify: `README.md`
- Modify: `docs/research/SUBAGENT_HARNESS_COMPARISON.md`
- Modify: `docs/README.md`

- [x] Describe the exact implemented workflow, policy table, activity command, patch restrictions, rollback semantics, and review verdict rules.
- [x] Add the verified Grok Build findings: independent child sessions, lifecycle/status, worktree isolation, goal/skeptic patterns, shallow depth, and the Recurs takeaways. Cite the official repository and preserve license independence.
- [x] State the remaining limits prominently: foreground only, depth one, clean committed parent, text patches only, no auto-repair/resume/model routing/background/company UI, and no OS containment for arbitrary commands.
- [x] Remove obsolete claims that Implement is parent-workspace-only or that patch integration is absent.
- [x] Run documentation link/reference searches and `git diff --check`.

### Task 10: Full verification, audit, and focused commits

**Files:**

- Modify only files required by failures found during verification.

- [ ] Run targeted package tests after every task, then `npm run check` from the isolated worktree.
- [ ] Run `npm run check:native`; if the unchanged controlling-PTY helper reproduces its known hang, capture the exact evidence and do not claim a pass.
- [ ] Inspect `git status`, the complete relevant diff, generated-file status, and dependency changes.
- [ ] Scan intended files for credential material and secret-shaped values; confirm no `.env`, key, certificate, local registry, worktree, or generated machine state is staged.
- [ ] Make small focused commits on `codex/team-orchestration-v1`; do not push.
- [ ] Re-run the strongest relevant checks after the final commit and document what is real versus intentionally absent.
