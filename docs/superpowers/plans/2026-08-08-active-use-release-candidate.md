# Active-Use Release Candidate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove and harden the Recurs alpha.7 CLI release candidate from the exact npm artifact while preserving the existing architecture and excluding website implementation.

**Architecture:** Reuse the current CLI, provider adapters, durable company runtime, package scripts, and release workflow. Investigate first, add only test-first root-cause fixes for reproduced defects, and store new release-candidate evidence separately from immutable historical research.

**Tech Stack:** Node.js 22/24, TypeScript, Vitest, npm pack, Bun installer smoke, official Codex app-server runtime, GitHub Actions.

## Global Constraints

- Start from the latest `origin/main` in the existing isolated `codex/active-use-release-candidate` worktree.
- Do not implement the website, touch paused website worktrees, rebuild the harness, add retries/sleeps/skips, weaken assertions, or introduce speculative abstractions.
- Use no pasted API key, copied credential, unofficial authentication, or unsupported subscription route.
- Keep Node.js as the runtime; Bun is an installation boundary only.
- Preserve historical research documents as history.

---

### Task 1: Classify the interrupted local failures

**Files:**
- Inspect: `packages/cli/test/assembly.test.ts`
- Inspect: `packages/cli/test/mcp-client.test.ts`
- Inspect: `packages/tools/test/command.test.ts`
- Inspect: `tests/e2e/provider-onboarding.test.ts`
- Record: `docs/ACTIVE_USE_RELEASE_CANDIDATE.md`

**Interfaces:**
- Consumes: the unchanged four-test Vitest command and the Codex desktop sandbox boundary.
- Produces: a deterministic-versus-host-specific classification with exact pass/fail counts.

- [ ] Run `npx vitest run packages/cli/test/assembly.test.ts packages/cli/test/mcp-client.test.ts packages/tools/test/command.test.ts tests/e2e/provider-onboarding.test.ts --reporter=verbose` inside the desktop sandbox and retain the six failures.
- [ ] Run the identical command outside the desktop sandbox and verify whether loopback binding and nested `sandbox-exec` are the only changed variables.
- [ ] If and only if a product defect remains outside the desktop sandbox, write one minimal regression test, run it red, implement the root fix, and run it green; otherwise make no production/test workaround.
- [ ] Record the exact environmental classification and commands in the RC evidence document.

### Task 2: Prove the exact packed-artifact first-use journey

**Files:**
- Inspect/modify only if a defect reproduces: `scripts/smoke-install-npm-package.mjs`
- Inspect/modify only if a defect reproduces: `scripts/installed-company-smoke.mjs`
- Test if changed: `scripts/installed-company-smoke.test.mjs`
- Record: `docs/ACTIVE_USE_RELEASE_CANDIDATE.md`

**Interfaces:**
- Consumes: `dist/cli/main.js`, the exact `npm pack` archive, temporary private HOME/data/config/cache directories, and the existing deterministic local provider fixture.
- Produces: verified onboarding, configured-account readiness, company approval, Implement, independent Review, Repair, synthesis, explicit apply, resume/recovery, human output, JSON/JSONL, cancellation, permissions, unknown cost/usage, and actionable failures.

- [ ] Run `npm run package:build` and `npm run package:smoke-install` outside the desktop sandbox so the loopback fixture and Recurs process sandbox are available.
- [ ] Inspect the smoke assertions against every acceptance path above; add a failing assertion only for a concrete uncovered or misleading behavior found in the installed journey.
- [ ] For each reproduced defect, run the focused test red, apply the smallest source fix, and rerun it green.
- [ ] Capture archive identity, private-home boundaries, role path, review/repair/apply outcome, recovery, output formats, usage/cost truth, and verifier result in the RC evidence document.

### Task 3: Audit provider onboarding and readiness truth

**Files:**
- Inspect/modify only if a defect reproduces: `packages/app/src/provider-account.ts`
- Inspect/modify only if a defect reproduces: `packages/app/src/provider-activation.ts`
- Inspect/modify only if a defect reproduces: `packages/cli/src/commands/provider.ts`
- Test if changed: `packages/cli/test/provider-account.test.ts`
- Test if changed: `tests/e2e/provider-onboarding.test.ts`
- Modify: `docs/PROVIDER_CAPABILITY_MATRIX.md`

**Interfaces:**
- Consumes: generated activation profiles plus the executable BYOK, local, coding-plan, Codex, and GitHub Copilot adapters.
- Produces: separate catalog support, adapter implementation, configured-account readiness, live verification, and blocked-provider states.

- [ ] Compare every documented runnable path with its generated activation profile and executable adapter.
- [ ] Run provider/account listing in JSON and human modes from both empty and configured homes and verify unsupported/provider-approval-blocked routes remain blocked.
- [ ] Add a failing onboarding/readiness test before any correction to misleading discovery, recovery, or readiness behavior, then apply the minimal fix and rerun focused tests.
- [ ] Update the current provider matrix only where executable evidence differs from current copy.

### Task 4: Run one bounded live Codex-subscription dogfood

**Files:**
- Record: `docs/ACTIVE_USE_RELEASE_CANDIDATE.md`
- Do not modify: prior files under `docs/research/`

**Interfaces:**
- Consumes: the existing authenticated official Codex app-server connection, a frozen small fixture, explicit request limits, and the current company evaluation recorder.
- Produces: exact activation, routes, requests, usage, latency, review/repair behavior, and verifier outcome, or one exact external blocker.

- [ ] Verify the official Codex CLI/runtime version and login status without reading or copying credential material.
- [ ] List redacted configured Recurs accounts and select only an already reviewed Codex app-server route.
- [ ] Run one small frozen company formation and one bounded reviewed coding goal with explicit limits; do not create new auth state or widen permissions.
- [ ] Record exact route/request/usage/latency/review/repair/verifier facts and keep Models: Auto unchanged unless every existing evidence gate passes.

### Task 5: Reverify distribution and dependency candidates

**Files:**
- Inspect/modify only if a defect reproduces: `scripts/check-npm-release.mjs`
- Inspect/modify only if a defect reproduces: `scripts/render-install-assets.mjs`
- Inspect/modify only if a defect reproduces: `scripts/smoke-install-bun-package.mjs`
- Modify: `docs/RELEASING.md`
- Record: `docs/ACTIVE_USE_RELEASE_CANDIDATE.md`

**Interfaces:**
- Consumes: npm registry metadata, `recurs@alpha`, GitHub release assets, official Homebrew tap formula, exact archive integrity, package limits, and open dependency PR heads rebased/refreshed against current main.
- Produces: current distribution evidence and only compatible dependency merges retested on current main.

- [ ] Verify npm dist-tags/version/integrity/size, generated checksum installer, Homebrew formula, Bun global installation with Node execution, and GitHub release assets/checksums.
- [ ] State explicitly that unqualified npm `latest` points to alpha.2; do not change tags without a deliberate separately authorized promotion decision.
- [ ] Fetch each open dependency PR head, test its current diff against current main, merge only compatible justified updates, and close the Codex upgrade with a precise reason if its new official version is not worth adopting.
- [ ] After any dependency merge, update this branch from the new `origin/main` and rerun all distribution checks.

### Task 6: Reconcile current release truth and ship

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/FEATURE_STATUS.md`
- Modify: `docs/PUBLIC_ALPHA.md`
- Modify: `docs/RELEASING.md`
- Modify: `docs/README.md`
- Create: `docs/ACTIVE_USE_RELEASE_CANDIDATE.md`
- Preserve: `docs/product/WEBSITE_DIRECTION.md`
- Preserve: `docs/research/*.md`

**Interfaces:**
- Consumes: Round 2 evidence, journey/dogfood/distribution results, merged website-direction brief, and current alpha.7 package truth.
- Produces: contradiction-free current docs, troubleshooting, changelog, RC evidence, a verified PR, merged main, and a clean synchronized canonical checkout.

- [ ] Replace current-doc references that incorrectly point only to Round 1 with the Round 2 conclusion: insufficient Auto evidence, one observed false approval, limited repair evidence, and unknown dollar cost.
- [ ] Remove stale current size/provider/release claims while leaving dated research unchanged; keep website implementation explicitly excluded and the merged direction brief preserved.
- [ ] Run `npm run check`, `npm run package:smoke-install`, and `npm run package:smoke-install-bun` on the final tree outside the desktop sandbox.
- [ ] Inspect `git status`, the complete diff, staged file list, and secret-sensitive patterns; stage only intended files and commit focused changes.
- [ ] Push `codex/active-use-release-candidate`, open the PR, wait for Linux/macOS/Bun/CodeQL checks, fix only evidenced failures, merge when green, fetch, and verify canonical `main` is clean and exactly equals `origin/main`.
- [ ] Remove only feature branches proven merged; leave both paused website worktrees untouched and report them explicitly.
