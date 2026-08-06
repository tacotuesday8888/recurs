# Recurs Active-Use Alpha Implementation Plan

**Goal:** Ship one coherent installed-product milestone in which a new user enters
Recurs through the same terminal interface used for company operation, completes
resumable company onboarding, runs a bounded reviewed coding goal, and receives
truthful activity, usage, and recovery feedback.

**Architecture:** Extend the existing TypeScript differential TUI with a small
onboarding host adapter. Keep `runGuidedOnboarding` as the single onboarding
workflow and keep the current `RecursRuntime`, permission engine, provider
registry, company supervisor, stores, and release pipeline authoritative. The
TUI supplies presentation and input; it does not become another scheduler or
duplicate product state.

**Method:** Strict test-driven slices. Preserve headless and `RECURS_NO_TUI=1`
behavior. Every shipped slice receives focused regression tests, full package
verification, independent review, a green PR, and a synchronized `main`.

## Slice 1: One continuous first-run terminal

### Task 1: Define the interactive onboarding seam

**Files**

- Modify `packages/cli/src/process-host.ts`
- Modify `packages/cli/src/terminal-ui.ts`
- Modify `packages/cli/test/run-mode.test.ts`
- Modify `packages/cli/test/terminal-ui.test.ts`

**RED**

- Prove the host starts one terminal onboarding surface before configured-session
  runtime creation (the bare command may first open its existing workspace
  state to determine whether setup is needed).
- Prove guided choices, text, suggestions, confirmation, output, errors, and
  cancellation use that surface.
- Prove `RECURS_NO_TUI=1`, non-TTY, automation, and dependency-injected tests
  retain the existing line-oriented behavior.
- Prove setup does not create a runtime when onboarding is saved, skipped, or
  fails.

**GREEN**

- Add one narrow interactive-onboarding interface to `InteractiveShell`.
- Reuse the existing transcript/editor primitives for setup prompts.
- Let commands that need direct terminal ownership suspend and resume the TUI
  without losing onboarding progress.
- Route both bare `recurs` first run and `recurs setup` through the same seam.

### Task 2: Make onboarding states legible and truthful

**Files**

- Modify `packages/cli/src/terminal-ui.ts`
- Modify `packages/cli/src/terminal-style.ts` only if a shared token is needed
- Modify focused TUI/onboarding tests

**RED**

- Prove narrow and wide terminals render within bounds.
- Prove a prompt shows its title, choices, details, current step transcript, and
  default suggestion without leaking terminal controls.
- Prove waiting, cancellation, save/resume, validation error, and completion
  remain visible and keyboard reachable.

**GREEN**

- Keep the one-color black-background pixel language and current wordmark.
- Use selection rows and concise status copy; do not introduce decorative
  windows, fake workers, percentages, or a full-screen IDE layout.
- Preserve drafts and restore focus across suspended provider authentication.

### Task 3: Verify and ship the onboarding slice

- Run focused tests repeatedly, then `npm run check` and installed package smoke.
- Capture the real terminal journey at representative narrow and wide sizes and
  compare it with the approved company-map visual language.
- Inspect the complete diff, generated output, dependency changes, and secret
  patterns.
- Obtain independent code review, fix all actionable findings, push a focused
  PR, wait for Linux/macOS/Bun/CodeQL, merge, and synchronize `main`.

## Slice 2: Full installed company journey

### Task 4: Add an installed end-to-end product proof

**Files**

- Extend existing package smoke and CLI integration fixtures
- Update current public-alpha documentation only where behavior is proven

**RED**

- From an empty isolated prefix and private state directory, prove install,
  `--help`, `doctor`, provider discovery, setup, company approval, `/goal`,
  activated worker visibility, independent review, repair when requested,
  synthesis, and explicit apply.
- Prove interruption/resume and provider failure leave truthful durable state.

**GREEN**

- Add only missing host/test seams required by the real journey.
- Keep npm as the package channel, Node as the runtime, Bun as a supported
  installer, and curl/Homebrew tied to the same GitHub release artifact.

### Task 5: Safe real Codex dogfood

- Use the existing vendor-owned Codex authentication without copying secrets.
- Run one read-only onboarding formation and bounded goal first, then one
  isolated mutating fixture with explicit apply.
- Record activated roles, selected models/efforts, requests, known usage,
  latency, review/repair outcomes, and unknown cost truthfully.
- Treat provider outages separately from roster quality without removing them
  from reliability results.

## Slice 3: Evidence-backed engine corrections

### Task 6: Fix only reproduced runtime defects

- Start with the existing evidence priorities: Terra repair recovery, reviewer
  availability, and shared-parent outage diagnosis.
- For each change, first reproduce one concrete failure using scripted or
  immutable fixtures, then correct only the responsible prompt, evidence
  handoff, retry boundary, or diagnostic contract.
- Do not add another scheduler, hidden fallback, unbounded recursion, guessed
  Auto ranking, or free-form cross-agent chat.

### Task 7: Finish active-use terminal states

- Verify long output, resize, loading, empty company, active company, failure,
  recovery, review, repair, synthesis, and completed-goal states.
- Improve only issues observed in those runs, preserving the company-home to
  normal-chat interaction and truthful activated-agent model.

## Slice 4: Release and product truth

### Task 8: Reconcile the public surface

- Keep the README concise and align onboarding, permissions, provider, company,
  troubleshooting, and release docs with the installed product.
- State evidence limits plainly: Recurs has a real controlled company runtime,
  but current trials do not prove a universal team advantage or dollar-cost
  winner.

### Task 9: Ship the next alpha

- Run the full source, package, npm-install, Bun-install, curl, and Homebrew
  gates defined by the repository.
- Use the protected release workflow only after the reviewed artifact and
  checksums agree.
- Merge all intended PRs, fetch, fast-forward canonical `main`, and verify local
  `main == origin/main`, a clean canonical status, and no completed unique
  feature commit stranded in any worktree.

## Acceptance

- A new user sees one coherent terminal experience from first launch through a
  reviewed company goal.
- The same durable onboarding and company contracts power TUI and fallback
  modes; no duplicate workflow exists.
- Permission, budget, cancellation, provider ownership, and evidence boundaries
  remain monotonic and tested.
- UI states are keyboard-usable, bounded, sanitized, resize-safe, and truthful.
- Real Codex and deterministic installed proofs are recorded without secrets.
- All intended work is merged behind green CI and the released docs make no
  unsupported quality, cost, Auto, runtime, or recursive-agent claims.
