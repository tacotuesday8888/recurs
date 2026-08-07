# Provider Capability Matrix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose an exact, adapter-local provider capability matrix that distinguishes catalog metadata, implementation coverage, policy conditions, blocks, unsupported paths, and separately recorded live verification.

**Architecture:** `@recurs/providers` owns transport facet evidence derived from its real adapter and discovery registries. The CLI combines that evidence with its existing onboarding catalog without changing shared contracts; live evidence is accepted only as an explicit, current probe input and is never inferred from a manifest or unit test.

**Tech Stack:** TypeScript 6, Vitest 4, existing seven-package Recurs workspace

## Global Constraints

- Do not edit `packages/contracts`, `packages/core`, `packages/runtimes`, or terminal visual components before the engine checkpoint.
- Preserve existing credential boundaries: process-environment credentials remain non-persistent and vendor-runtime credentials remain vendor-owned.
- A provider is activatable only when authentication, a model-discovery/readiness probe, streaming, tools, usage/error handling, and onboarding backend readiness are all implemented.
- Claude subscription and written-approval-restricted coding plans remain blocked.
- Live-tested evidence must come from an explicit safe probe result; implementation facets and scripted tests never imply live evidence.

---

### Task 1: Provider-owned transport readiness

**Files:**
- Create: `packages/providers/src/provider-capability.ts`
- Modify: `packages/providers/src/index.ts`
- Test: `packages/providers/test/provider-capability.test.ts`

**Interfaces:**
- Consumes: bundled `ProviderManifest` records, reviewed environment adapter selection, and model-discovery support.
- Produces: `providerTransportCapability(providerId): ProviderTransportCapability` with explicit authentication, model-discovery/readiness-probe, streaming, tools, usage, and error facets.

- [ ] **Step 1: Write the failing provider capability tests**

Cover one complete direct path (`openai-api`), one implemented transport missing discovery (`zai-api`), one official-runtime path (`openai-codex-chatgpt`), one approval-blocked path (`zai-glm-coding-plan`), one unimplemented cloud path (`aws-bedrock`), and an unknown ID.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run packages/providers/test/provider-capability.test.ts`

Expected: FAIL because `providerTransportCapability` is not exported.

- [ ] **Step 3: Implement the minimal provider-owned projection**

Use frozen literal facet values derived from actual adapter/discovery registries. Do not accept caller-supplied claims and do not classify onboarding readiness in this package.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npx vitest run packages/providers/test/provider-capability.test.ts`

Expected: PASS.

### Task 2: CLI capability matrix and explicit live evidence

**Files:**
- Modify: `packages/cli/src/provider-account.ts`
- Test: `packages/cli/test/provider-account.test.ts`

**Interfaces:**
- Consumes: `providerTransportCapability`, `OnboardingCatalogEntry`, and optional `ProviderLiveVerification` records supplied by safe caller-owned probes.
- Produces: `listProviderCapabilities(options?): readonly ProviderCapability[]` with category `activatable`, `live-tested`, `conditional`, `blocked`, `cataloged`, or `unsupported` and an immutable missing-capabilities list.

- [ ] **Step 1: Write failing CLI matrix tests**

Assert that a complete runnable backend is `activatable`, explicit successful live evidence upgrades only that exact provider to `live-tested`, stale/failed evidence does not, conditional and approval-blocked providers remain honest, missing discovery prevents activation, unknown requested IDs are `unsupported`, and returned data is deeply immutable.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run packages/cli/test/provider-account.test.ts`

Expected: FAIL because `listProviderCapabilities` is not exported.

- [ ] **Step 3: Implement minimal combination logic**

Keep live evidence bounded to provider ID, checked-at timestamp, and success/failure. Require every implementation facet plus runnable onboarding status before `activatable`; policy-conditional status takes precedence over implementation completeness, and blocked policy takes precedence over all evidence.

- [ ] **Step 4: Run focused provider and CLI tests**

Run: `npx vitest run packages/providers/test/provider-capability.test.ts packages/cli/test/provider-account.test.ts`

Expected: PASS.

### Task 3: Evidence documentation and approval outreach packet

**Files:**
- Create: `docs/PROVIDER_CAPABILITY_MATRIX.md`
- Create: `docs/provider-approvals/README.md`
- Create: `docs/provider-approvals/anthropic.md`
- Create: `docs/provider-approvals/zai.md`

**Interfaces:**
- Consumes: executable matrix output and official provider documentation.
- Produces: a dated human-readable matrix and unsent outreach drafts containing only verified technical/security facts.

- [ ] **Step 1: Generate the dated matrix from the executable projection**

List every bundled manifest exactly once, separate implementation coverage from live checks, and record gaps without upgrading support based on catalog presence. Record scripted command results only as PR delivery evidence, never as a `ProviderCapability` field.

- [ ] **Step 2: Write the approval tracker and drafts**

State that messages are drafts, identify the intended official recipient/channel as unresolved where necessary, ask for written authorization, and never claim to represent the maintainer.

- [ ] **Step 3: Run documentation policy checks**

Run: `npm run package:check`

Expected: PASS with no stale-status or unsupported marketing claims.

### Task 4: Full verification and delivery

**Files:**
- Review only: all files changed above

**Interfaces:**
- Consumes: completed implementation and documentation.
- Produces: one focused branch, commit, pushed PR, green CI, merge, and synchronized canonical checkout.

- [ ] **Step 1: Run full repository verification**

Run: `npm run check`

Expected: PASS.

- [ ] **Step 2: Review status, diff, and secret safety**

Run: `git status --short && git diff --check && git diff --stat && git diff`

Confirm only intended files changed and no credentials, tokens, private paths, or environment values appear.

- [ ] **Step 3: Commit, push, open the PR, and monitor CI**

Use a focused conventional commit and a PR body that records exact scripted test results and separately supplied live verification evidence. Merge only with green CI and synchronize local `main` with `origin/main` afterward.
