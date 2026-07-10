# Recurs Base Harness Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Finish Recurs's existing single-agent harness as a small, reliable, well-tested foundation for the later sub-agent architecture.

**Architecture:** Preserve the four-package structure and the single deterministic `AgentLoop`. Harden provider stream semantics, make tool-call state recoverable across cancellation and restart, prevent concurrent mutation of one session, keep permission claims honest while shell commands are unsandboxed, and establish one local/CI verification path. Do not add provider integrations or sub-agent behavior.

**Evidence:** The decisions are based on `docs/BASE_ENGINE_COMPARISON.md`, which reviews Kilo Code, OpenCode, and Codex at pinned GitHub revisions.

**Tech stack:** Node.js 22.22+ locally, Node.js 24 in CI, TypeScript 6.0.3, npm workspaces, Vitest 4.1.10, ESLint 10.6.0.

## Constraints

- Keep the provider-neutral engine and the current seven built-in tools.
- Keep tool execution sequential.
- Keep Ask Always, Approved for Me, Full Access, Plan mode, goals, version-1 sessions, checkpoints, and the existing CLI surface.
- Do not add live providers, authentication, routing, OS sandboxing, plugins, MCP, desktop UI, or sub-agents.
- Full Access means the user explicitly trusts the model with the host environment. Do not claim that secrets are isolated.
- Until an enforceable process sandbox exists, Approved for Me asks before shell execution.
- Follow red-green-refactor for each production behavior change.

## Task 1: Centralize and harden provider stream consumption

**Files:**

- Modify: `packages/providers/src/types.ts`
- Modify: `packages/providers/src/collect-provider-events.ts`
- Test: `packages/providers/test/types.test.ts`
- Modify: `packages/core/src/agent-loop.ts`
- Modify: `packages/core/src/compaction.ts`
- Test: `packages/core/test/agent-loop.test.ts`
- Test: `packages/core/test/compaction.test.ts`

- [x] Add failing provider tests for events after `done`, duplicate or empty tool IDs/names, invalid usage, output/tool-count limits, and event observation.
- [x] Add a failing loop test proving that a retryable failure after text or a tool call is not retried.
- [x] Add `CollectProviderEventsOptions.onEvent` and make `collectProviderEvents` the only reducer.
- [x] Reject streams without exactly one terminal event, invalid usage, duplicate tool IDs, more than 128 tool calls, or more than 4 MiB of combined text/reasoning output.
- [x] Reuse the reducer from `AgentLoop`; emit model events through the observer and retry at most twice only before semantic text, reasoning, or tool output.
- [x] Run focused tests and `npm run typecheck`.
- [x] Commit as `fix: harden provider stream handling`.

## Task 2: Make tool execution durable and single-writer per session

**Files:**

- Modify: `packages/core/src/agent-loop.ts`
- Test: `packages/core/test/agent-loop.test.ts`

- [x] Add a failing cancellation test proving a started tool currently remains pending and lacks a model-visible tool result.
- [x] Add a failing restart test by seeding an assistant tool call and `tool_started`, then proving the next request currently lacks an interrupted tool result.
- [x] Add a failing concurrency test proving two `AgentLoop.run()` calls can currently enter the same session.
- [x] On every tool failure, append `tool_failed` and a tool result message before propagating cancellation.
- [x] Before a new turn, reconcile pending calls and assistant tool calls without results. Persist an `interrupted` failure when needed and append a synthetic tool result so provider history remains valid.
- [x] Add `session_busy` to `AgentLoopErrorCode`; have `AgentLoop` reject a concurrent run for the same session and always release its in-memory guard in `finally`.
- [x] Preserve complete assistant-tool-call/result groups when selecting the recent compaction window.
- [x] Run focused tests and `npm run typecheck`.
- [x] Commit as `fix: recover interrupted tool calls`.

## Task 3: Keep unsandboxed shell permissions honest

**Files:**

- Modify: `packages/tools/src/permissions.ts`
- Test: `packages/tools/test/permissions.test.ts`
- Test: `packages/tools/test/command.test.ts`
- Modify: `packages/cli/src/commands/permissions.ts`
- Test: `packages/cli/test/commands.test.ts`

- [x] Change the Approved for Me test to require approval for normal shell commands while continuing to allow normal workspace reads and writes.
- [x] Change the command test to prove a normal command runs only after an approval response in Approved for Me.
- [x] Add an assertion that the Full Access confirmation explicitly mentions credentials and the host environment.
- [x] Remove `shell` from automatic normal workspace actions in `PermissionEngine`.
- [x] Update Full Access confirmation copy to say it may access credentials and inherited host environment values without routine prompts.
- [x] Run focused tests and `npm run typecheck`.
- [x] Commit as `fix: clarify unsandboxed shell trust`.

## Task 4: Add one strict repository verification path

**Files:**

- Modify: `package.json`
- Modify: `tsconfig.json`
- Create: `.github/workflows/ci.yml`

- [x] Run `npm run check` and confirm it fails because the script does not exist.
- [x] Add `noFallthroughCasesInSwitch`, `noImplicitReturns`, `noImplicitOverride`, `noUnusedLocals`, and `noUnusedParameters` to the shared TypeScript configuration.
- [x] Add `"check": "npm run lint && npm run typecheck && npm test && npm run build"`.
- [x] Add a read-only GitHub Actions workflow using `actions/checkout@v7`, `actions/setup-node@v6`, Node 24, `npm ci`, and `npm run check`.
- [x] Run `npm run check`.
- [x] Commit as `ci: verify the base harness`.

## Task 5: Consolidate current documentation

**Files:**

- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `PRODUCT.md`
- Create: `docs/README.md`
- Modify: `docs/CLI.md`
- Keep: `docs/BASE_ENGINE_COMPARISON.md`
- Move: `COMPETITIVE_RESEARCH.md` to `docs/research/COMPETITIVE_RESEARCH.md`
- Move: `HARNESS_RESEARCH.md` to `docs/research/HARNESS_RESEARCH.md`
- Move: `HARNESS_APPROACH.md` to `docs/research/HARNESS_APPROACH.md`
- Move: `PRODUCT_QUESTIONS.md` to `docs/research/PRODUCT_QUESTIONS.md`
- Create: `docs/research/README.md`
- Modify: `docs/superpowers/specs/2026-07-10-recurs-core-v0-design.md`
- Modify: `docs/superpowers/specs/2026-07-10-recurs-provider-auth-design.md`

- [x] Preserve historical research through Git-aware moves; do not rewrite its old terminology.
- [x] Replace root README, architecture, and product documents with concise descriptions of what exists, the package boundaries, known shell-sandbox limitation, and the next provider/sub-agent phases.
- [x] Add a documentation index and link the engine comparison, CLI guide, reviewed specs, plans, and historical research.
- [x] Correct the CLI permission table: Approved for Me asks for shell commands; Full Access trusts credentials and the host environment.
- [x] Update stale cross-document paths and mark reviewed specs as design inputs rather than completed code.
- [x] Run stale-term, broken-relative-link, and placeholder scans, then `npm run check`.
- [x] Commit as `docs: consolidate the Recurs foundation`.

## Task 6: Resolve independent review findings

- [x] Move the in-process session run lock to the session-store boundary so all loop entry points share it.
- [x] Isolate permission modes and reusable grants by session; cover sequential grant leakage and interleaved Full Access/Ask Always runs.
- [x] Derive unresolved tool outcomes from durable completed/failed records and reuse the real output during recovery.
- [x] Keep tool execution errors separate from terminal persistence/event failures so one call cannot receive contradictory terminal records.
- [x] Normalize malformed usage values before arithmetic.
- [x] Correct the Core v0 design snapshot's status and permission descriptions.

## Final verification and integration

- [x] Review `git diff main...HEAD`, `git status`, and staged files for unrelated changes or secrets.
- [x] Run `npm run check` from a clean working tree.
- [x] Push the branch, open a pull request, monitor CI, address failures or comments, and merge when green.
- [x] Verify `main` after the merge, delete the merged branch, and remove the worktree.
