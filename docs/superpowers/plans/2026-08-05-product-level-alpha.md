# Product-Level Alpha Implementation Plan

**Goal:** Harden Recurs' real first-run company journey, align public claims
with current evidence, then use measured failures to improve company-runtime
quality and prove the installed alpha.

**Design:**
`docs/superpowers/specs/2026-08-05-product-level-alpha-design.md`

**Method:** Strict red-green-refactor. Preserve the existing agent loop,
provider boundaries, scheduler, permission engine, budget ledger, storage
authority, and release chain.

## PR 1: First-run product hardening

### Task 1: Safe private-state errors

**Files**

- Modify `packages/cli/src/error-rendering.ts`
- Add or modify focused CLI error-rendering tests

**RED**

Prove that every `CompanyStateStoreError` code returns fixed, useful public
copy; messages containing paths or IDs never cross the boundary; and unknown
errors still return a diagnostic ID.

**GREEN**

Map recognized codes without returning `error.message`. Keep the underlying
symlink, ownership, permissions, tamper, and corruption checks unchanged.

### Task 2: Truthful formation progress

**Files**

- Modify `packages/cli/src/guided-onboarding.ts`
- Modify `packages/cli/test/guided-onboarding.test.ts`

**RED**

Use deferred coordinator operations to prove a formation-stage message is
written before a long `advance` resolves. Prove repeated transitions do not
invent research or agent activity and existing result messages remain intact.

**GREEN**

Derive a concise stage label from the durable run state and write it immediately
before `advance`.

### Task 3: Accurate capability readiness

**Files**

- Modify `packages/cli/src/company-tool-readiness.ts`
- Modify `packages/cli/test/company-tool-readiness.test.ts`
- Modify `packages/cli/src/guided-onboarding.ts`
- Modify `packages/cli/test/guided-onboarding.test.ts`
- Modify `packages/core/src/company-blueprint-v2.ts`
- Modify `packages/core/test/company-blueprint-v2.test.ts`

**RED**

Prove summary rendering shows aggregate bundle, binding, Skill, and MCP counts
without identifiers or private metadata. Prove full rendering remains
inspectable. Prove a newly compiled unbound bundle no longer claims that its
role cannot execute.

**GREEN**

Add `summary | full` rendering with `full` as the compatibility default. Use
`summary` during onboarding. Render unresolved optional extensions as
`unbound`, retain exact approval language, and correct new-blueprint reason
copy without changing the V2 schema.

### Task 4: Truthful alpha documents

**Files**

- Modify `docs/PUBLIC_ALPHA.md`
- Modify `docs/COMPANY_EVALUATION.md` if its summary conflicts with the
  versioned report
- Modify `docs/FEATURE_STATUS.md` only if an implemented boundary changed

**RED / review gate**

Cross-check every quantitative claim against
`docs/research/2026-08-04-RECURS-MODEL-TEAM-EVALUATION-V1.md`, current package
metadata, and current release instructions.

**GREEN**

Replace superseded evaluation claims, link the versioned evidence, and keep
unknown dollar cost and insufficient Auto evidence explicit.

### Task 5: Verify and ship PR 1

Run focused tests repeatedly, `npm run check`, and the relevant installed CLI
smoke. Repeat the safe Codex onboarding dogfood in isolated state. Inspect the
full diff, generated files, and credential patterns. Obtain an independent code
review, fix actionable findings, then commit, push, open a PR, wait for green
CI, merge, and synchronize local `main`.

## PR 2: Evidence-driven company-runtime quality

### Task 6: Failure stratification and diagnostics

Extend Company Proof reporting so shared pre-activation parent/provider
failures are classified separately from roster execution failures while still
counting against end-to-end reliability. Record activated roles, request/usage
availability, review verdicts, repair attempt outcomes, and terminal stage in a
machine-readable, backwards-compatible result.

### Task 7: Reproduce one actionable runtime defect

Use immutable fixtures and scripted providers first. Reproduce the highest
impact current defect—repair ineffectiveness, reviewer unavailability, or
parent-only outage handling—without selecting a winner in advance. Add a
failing regression test at the existing runtime seam.

### Task 8: Implement the narrow correction

Change only the responsible prompt, evidence handoff, retry boundary, or
diagnostic contract. Do not add a second scheduler, free-form agent chat,
unbounded retries, or hidden model fallback. Re-run focused and full checks,
then repeat representative real-provider trials when provider health permits.

### Task 9: Verify and ship PR 2

Publish a versioned evidence update whether the result is positive, negative,
or inconclusive. Review, PR, green CI, merge, and synchronize as in PR 1.

## PR 3: Installed alpha proof and release readiness

### Task 10: Clean-prefix end-to-end smoke

Verify npm and Bun installation into isolated prefixes plus curl and Homebrew
artifact resolution. Exercise help, doctor, provider discovery, safe
onboarding, company approval, one bounded goal, result inspection, and explicit
apply. Node.js remains the runtime.

### Task 11: Release truth and support surface

Reconcile README quick start, troubleshooting, provider authentication,
permissions, company controls, release notes, and changelog. Keep the GitHub
page concise and do not add unsupported superiority, cost, platform, or
self-improvement claims.

### Task 12: Ship the next alpha when all gates pass

Run the guarded release workflow only after exact artifact, integrity,
checksum, provenance, installer, and post-publish smoke gates pass. Merge the
release PR and verify local `main` equals `origin/main` with no completed work
stranded in another worktree.
