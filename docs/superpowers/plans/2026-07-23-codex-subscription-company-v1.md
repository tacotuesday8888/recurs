# Codex Subscription Company Runtime V1 Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let Recurs use an authenticated local Codex/ChatGPT subscription as a real, permission-bounded runtime with exact model and reasoning-effort selection, so a Sol parent and Terra/Luna workers can run through Recurs's existing company orchestration without API keys.

**Architecture:** Add a reviewed Codex app-server JSONL adapter beside the existing ACP Plan-only adapter. Codex receives an enforced read-only built-in sandbox and no native multi-agent tools; Recurs tools are supplied as app-server dynamic tools and dispatched through `AgentRuntimeHost.executeTool`, preserving Recurs permissions, checkpoints, budgets, and evidence. Setup discovers the authenticated account and live model catalog, then saves one logical connection per selected model/effort while binding every connection to the same verified account fingerprint.

**Tech Stack:** TypeScript 6, Node.js child processes/readline, Zod, Vitest, official pinned `@openai/codex` platform binary, existing Recurs contracts/runtime/connection registry.

---

### Task 1: Pin and validate the app-server executable seam

**Files:**
- Modify: `packages/runtimes/src/codex-acp-profile.ts`
- Create: `packages/runtimes/src/codex-app-server-protocol.ts`
- Modify: `packages/runtimes/src/index.ts`
- Test: `packages/runtimes/test/codex-app-server-protocol.test.ts`

1. Write failing tests for exact package/artifact validation, bounded JSONL frames, request/response correlation, unknown messages, stderr limits, startup timeout, abort, and clean shutdown.
2. Export a contained, reviewed Codex executable path from the existing installation resolver without duplicating package trust logic.
3. Implement a private bounded JSONL process client for `codex app-server --listen stdio://` with strict request IDs and sanitized errors.
4. Run the focused runtime tests repeatedly.
5. Commit the protocol/executable foundation.

### Task 2: Implement authenticated catalog discovery and account binding

**Files:**
- Create: `packages/runtimes/src/codex-app-server-catalog.ts`
- Modify: `packages/runtimes/src/index.ts`
- Test: `packages/runtimes/test/codex-app-server-catalog.test.ts`
- Create: `packages/runtimes/test/fixtures/fake-codex-app-server.mjs`

1. Write failing tests for initialize/initialized, ChatGPT auth requirements, account mismatch, exact model IDs, supported effort parsing/order, malformed/oversized catalog data, cancellation, and secret-safe diagnostics.
2. Implement `account/read` and paginated `model/list` parsing. Return only a one-way account fingerprint and non-sensitive display label; never read or expose `auth.json` or tokens.
3. Represent model availability and reasoning efforts as immutable validated values.
4. Run the focused catalog tests repeatedly.
5. Commit catalog discovery.

### Task 3: Implement the Recurs-owned Codex app-server runtime

**Files:**
- Create: `packages/runtimes/src/codex-app-server-runtime.ts`
- Modify: `packages/runtimes/src/index.ts`
- Test: `packages/runtimes/test/codex-app-server-runtime.test.ts`
- Modify: `packages/runtimes/test/fixtures/fake-codex-app-server.mjs`

1. Write failing tests for exact model/effort routing, Plan and Act turns, read-only vendor sandbox, disabled vendor shell/collaboration features, dynamic Recurs tool callbacks, approval callbacks, normalized text/reasoning/activity/file/usage events, continuation, interruption, malformed events, process failure, and truthful terminal outcomes.
2. Add the adapter with `toolExecution: host_tools`, `checkpointing: host_tools`, host approval control, protocol cancellation, and a versioned capability profile.
3. Translate host tool schemas to app-server dynamic tools. Dispatch calls only through `AgentRuntimeHost.executeTool`; reject duplicate/unknown calls and bound arguments/results.
4. Persist only bounded vendor thread identifiers through `RuntimeContinuationStore`; resume only when connection/model/account/capability bindings match.
5. Never call app-server's unsandboxed shell API. Start every thread with a read-only Codex sandbox and explicit instructions that Recurs dynamic tools are the sole mutation/command path.
6. Run focused runtime and delegated-executor integration tests repeatedly.
7. Commit the runtime vertical.

### Task 4: Upgrade setup to save selectable subscription models and efforts

**Files:**
- Modify: `packages/app/src/connection-registry-model.ts`
- Modify: `packages/app/src/codex-onboarding.ts`
- Modify: `packages/app/src/connection-lifecycle.ts`
- Modify: `packages/cli/src/codex-connection.ts`
- Modify: relevant setup/command files discovered by tests
- Test: `packages/app/test/codex-onboarding.test.ts`
- Test: `packages/cli/test/codex-connection.test.ts`
- Test: relevant connection-registry/command tests

1. Write failing compatibility tests: existing ACP records still parse and remain Plan-only; app-server records carry exact effort and capability profile; multiple models may share one verified account without duplicate-record corruption.
2. Add optional delegated reasoning effort and explicit runtime profile metadata without breaking stored V2 registries.
3. Make setup discover the live app-server catalog and save/update selected model routes. Default suggestions are Sol parent, Terra implement/repair, and Luna review only when those exact models and efforts are actually available.
4. Keep billing disclosure truthful: subscription is primary, prepaid-credit fallback remains declared, reported dollar cost is unknown unless supplied by the runtime.
5. Run focused onboarding/registry tests repeatedly.
6. Commit setup and persistence.

### Task 5: Route Codex subscription connections through company execution

**Files:**
- Modify: `packages/cli/src/assembly.ts`
- Modify: `packages/cli/src/commands/model.ts`
- Modify: `packages/core/src/agent-backend-router.ts` only if the existing candidate contract cannot express the safe runtime
- Modify: `packages/core/src/team-run-supervisor.ts` only if required for present/local foreground operation
- Test: `packages/cli/test/assembly.test.ts`
- Test: `packages/core/test/agent-backend-router.test.ts`
- Test: `packages/core/test/team-run-supervisor.integration.test.ts`

1. Write failing tests proving app-server connections advertise Act + Plan, pin exact model/effort/profile, and qualify as host-tool company candidates.
2. Construct account-bound app-server runtimes from saved connections and route them through the existing `DelegatedAgentExecutor`.
3. Permit only local, manual, user-present foreground company execution in V1. Keep unattended/background subscription execution blocked.
4. Verify a parent can invoke Recurs's existing `delegate_company_goal` tool and a worker can use implementation/review tools without bypassing permission or shared company limits.
5. Keep company formation on the restricted pre-approval boundary; enable it only if the same dynamic-tool allowlist is proven by tests.
6. Run the focused assembly/company suites repeatedly.
7. Commit the company-routing vertical.

### Task 6: Real dogfood, documentation, and delivery

**Files:**
- Modify: `README.md`
- Modify: `docs/CLI.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/SECURITY.md`
- Modify: current capability-gap/product truth document if applicable

1. Use the authenticated local Codex account for a harmless read-only catalog probe and one bounded Recurs runtime turn; do not print account details or credentials.
2. Add exact documentation for what is real: ChatGPT login reuse, model/effort discovery, Sol/Terra/Luna routing when available, Recurs-owned tools/permissions, foreground-only boundary, subscription billing uncertainty, and API-key-free setup.
3. Run focused suites repeatedly, then `npm run check` and `npm run check:native`.
4. Inspect `git status`, the complete diff, generated files, and secret patterns. Stage only intended files.
5. Push the feature branch, open a focused PR, monitor both CI jobs, address failures, and merge only when green.
6. Fetch and fast-forward canonical local `main`; verify `main == origin/main`, canonical status clean, and report any remaining worktrees/branches with unique commits.

## Explicit Non-Goals

- No token copying, direct reading of Codex credential files, or unofficial auth flow.
- No use of app-server's unsandboxed `thread/shellCommand` API.
- No automatic background/unattended use of a subscription.
- No permanent brand-specific orchestration policy; model IDs remain user-selected connection data.
- No replacement of the existing direct-provider path or ACP compatibility.
- No desktop UI work in this milestone.
