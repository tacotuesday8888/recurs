# Provider Authentication Matrix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a broad, truthful provider/authentication catalog, reusable onboarding foundation, and the first official delegated ChatGPT/Codex subscription path.

**Architecture:** Dependency-leaf contracts describe provider manifests, policy, billing, and delegated runtime capabilities. `@recurs/providers` owns immutable bundled manifests and protocol-family metadata; `@recurs/app` owns non-secret connections and onboarding; core owns durable delegated execution; `@recurs/runtimes` uses the official ACP SDK and Codex ACP adapter. Local and Codex connections are runnable in this phase; credential-bearing direct entries remain activation recipes until the native broker exists.

**Tech Stack:** TypeScript 6, Node.js 22.22+, npm workspaces, Vitest 4, `@agentclientprotocol/sdk` 1.2.1, `@agentclientprotocol/codex-acp` 1.1.2, ACP protocol version 1, append-only JSONL sessions.

## Delivery status (2026-07-11)

Tasks 1–6 are implemented, including the 25-path catalog, non-secret registry,
delegated executor and recovery, bounded ACP runtime, the Plan-only official
Codex-with-ChatGPT path, and provider/account CLI commands. The repository-wide
verification gate passes with 41 test files and 570 tests, and independent final
review found no remaining Critical or Important issue. The historical step
checkboxes below record the original execution plan; this status section is
authoritative.

- [x] Task 6 provider/account command implementation and E2E test.
- [x] Task 6 public documentation update.
- [x] Task 6 repository-wide lint, typecheck, 570-test, and build verification.
- [x] Task 6 final re-read and commit.

## Global Constraints

- Never read or import vendor auth files, browser cookies, copied OAuth tokens, desktop credentials, or shared subscription credentials.
- Never collect or persist an API/coding-plan key in the TypeScript process during this plan; direct credential activation remains fail-closed until the native broker exists.
- Use only `@agentclientprotocol/codex-acp` 1.1.2 for new Codex ACP installs; the deprecated `@zed-industries/codex-acp` package is forbidden.
- Consume ACP `authMethods` dynamically; do not hardcode deprecated method IDs. ChatGPT login uses the currently advertised `chat-gpt` method only when present.
- Pin the ACP SDK and adapter versions, negotiate `PROTOCOL_VERSION`, spawn the resolved installed binary directly, and never invoke floating `npx` during a run.
- Keep `APP_SERVER_LOGS` and `DEFAULT_AUTH_REQUEST` unset so adapter logs cannot capture credentials.
- Claude Free/Pro/Max third-party login is blocked absent Anthropic approval. Z.ai GLM Coding Plan is hidden pending provider recognition. Alibaba Coding Plan is local, user-present, manual, foreground-interactive only.
- Every coding plan keeps its own endpoint, credential kind, region, billing policy, usage policy, and support status even when it shares a protocol codec.
- Unknown or additional billing fallback never silently activates. Unsupported and stale policy fails closed.
- Preserve all existing local-provider, permission, Plan mode, session, goal, checkpoint, and tool behavior.
- Follow test-first RED/GREEN cycles and keep every package dependency direction acyclic.

---

### Task 1: Provider manifest contracts and bundled matrix

**Files:**
- Create: `packages/contracts/src/manifests.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/providers/src/manifest-validator.ts`
- Create: `packages/providers/src/bundled-manifests.ts`
- Create: `packages/providers/src/manifest-registry.ts`
- Modify: `packages/providers/src/index.ts`
- Create: `packages/providers/test/manifests.test.ts`
- Modify: `packages/contracts/test/contracts.test.ts`

**Interfaces:**
- Produces `SupportStatus`, `ProviderProtocol`, `ProviderEndpoint`, `UsagePolicyRule`, `ProviderUsagePolicy`, `ProviderManifest`, `validateProviderManifest()`, `BUNDLED_PROVIDER_MANIFESTS`, and `ProviderManifestRegistry`.
- The registry exposes `list({ includeBlocked? })`, `get(id)`, and `runnable()` returning immutable defensive copies.

- [ ] **Step 1: Write failing schema and registry tests.** Assert unique IDs, exact endpoint origins, legal credential-owner/lane combinations, nonempty current policy evidence, conditional machine conditions, no secrets, blocked filtering, and explicit entries for all providers in the design.
- [ ] **Step 2: Run `npm test -- packages/contracts/test/contracts.test.ts packages/providers/test/manifests.test.ts`.** Expected: FAIL because manifest exports do not exist.
- [ ] **Step 3: Add dependency-free manifest contracts and strict unknown-field validation.** Protocol values are `openai_responses`, `openai_chat`, `anthropic_messages`, `gemini_generate_content`, `bedrock`, `azure_openai`, `acp`, `sdk`, and `local_openai`.
- [ ] **Step 4: Add the bundled immutable matrix.** Include separate direct/subscription/coding-plan manifests for the exact paths in the design, with official source URLs, reviewed date `2026-07-11`, expiry `2026-10-11T00:00:00.000Z`, and truthful support states.
- [ ] **Step 5: Implement registry filtering and defensive cloning, then run focused tests and `npm run typecheck`.** Expected: PASS.
- [ ] **Step 6: Commit with `feat: add provider manifest registry`.**

### Task 2: Non-secret connection registry and onboarding catalog

**Files:**
- Create: `packages/app/package.json`
- Create: `packages/app/tsconfig.json`
- Create: `packages/app/src/connection-registry.ts`
- Create: `packages/app/src/onboarding-catalog.ts`
- Create: `packages/app/src/index.ts`
- Create: `packages/app/test/connection-registry.test.ts`
- Create: `packages/app/test/onboarding-catalog.test.ts`
- Modify: `packages/cli/package.json`
- Modify: `packages/cli/src/local-connection.ts`
- Modify: `tsconfig.json`
- Modify: `tsconfig.eslint.json`
- Modify: `vitest.config.ts`

**Interfaces:**
- Produces `ConnectionRegistryDocument { schemaVersion: 1; revision; primaryConnectionId; connections }`, strict `LocalConnectionRecord` and `DelegatedConnectionRecord`, `FileConnectionRegistry`, and `OnboardingCatalog`.
- `FileConnectionRegistry.read()`, `commit(expectedRevision, mutation)`, and `migrateLegacyLocal()` use atomic mode-`0600` writes and reject stale revision, symlink, oversized, malformed, secret-shaped, and unknown fields.
- `OnboardingCatalog.list()` reports `runnable`, `requires_native_broker`, or `blocked` plus billing/restriction disclosure; it never asks for a key.

- [ ] **Step 1: Write failing tests for empty registry, exact revision CAS, competing writes, malformed records, secret-shaped field rejection, legacy local migration, primary selection, and onboarding support/billing rendering.**
- [ ] **Step 2: Run `npm test -- packages/app/test`.** Expected: FAIL because `@recurs/app` is absent.
- [ ] **Step 3: Add the workspace package and strict registry parser/store.** Reuse the existing literal-loopback validator; preserve legacy local connection ID, creation time, endpoint, and model during migration.
- [ ] **Step 4: Add onboarding catalog projection over bundled manifests.** Local and Codex are runnable; direct key/cloud entries require the broker; blocked entries are hidden unless `includeBlocked` is true.
- [ ] **Step 5: Convert CLI local setup to the shared registry while keeping its public exports and existing tests compatible.**
- [ ] **Step 6: Run app, CLI local-connection, assembly, typecheck, and dependency-boundary tests.** Expected: PASS.
- [ ] **Step 7: Commit with `feat: add connection registry and onboarding catalog`.**

### Task 3: Durable delegated-runtime executor

**Files:**
- Modify: `packages/contracts/src/runtime.ts`
- Create: `packages/core/src/backend-authorization.ts`
- Create: `packages/core/src/runtime-continuation-store.ts`
- Modify: `packages/core/src/session-v2.ts`
- Modify: `packages/core/src/session-record-validator.ts`
- Modify: `packages/core/src/session.ts`
- Create: `packages/core/src/delegated-agent-executor.ts`
- Modify: `packages/core/src/run-coordinator.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/test/backend-authorization.test.ts`
- Create: `packages/core/test/runtime-continuation-store.test.ts`
- Create: `packages/core/test/delegated-agent-executor.test.ts`
- Modify: `packages/core/test/run-coordinator.test.ts`
- Modify: `packages/core/test/session-v2.test.ts`
- Modify: `packages/cli/src/commands/session.ts`
- Modify: `packages/cli/test/session-commands.test.ts`

**Interfaces:**
- Adds immutable `RuntimeCapabilities`, `RuntimeActivity`, runtime `files_changed`, `evidence`, and `continuation_updated` events plus exactly one terminal event.
- Adds exact offered runtime permission option IDs and selected-ID/cancelled outcomes. Neither core nor an ACP adapter may convert a generic decision kind into an option ID.
- Adds split `RuntimeContinuationAuthority` and `RuntimeContinuationStore` facets plus a bounded `ProcessScopedRuntimeContinuationStore`; vendor session IDs remain only in the store while JSONL receives Recurs handles. A persistent native broker remains deferred.
- Adds shared domain-separated canonical backend/billing/context digests and one authorization binder/verifier; the CLI raw-`JSON.stringify` fingerprint path is removed.
- Adds a provenance-bearing `runtime_completed` session record and continuation-bearing failure/cancellation records; replay derives the assistant message, usage, changed files, evidence, and latest runtime continuation.
- `DelegatedAgentExecutor` consumes `AgentRuntime.run()`, bridges approval decisions, enforces capability/mode compatibility, validates event bounds/order, and produces one normalized `RunResult`.

- [ ] **Step 1: Write failing tests for text/usage aggregation, changed files/evidence, process-scoped continuation staging/commit/owner expiry, cancellation/failure, missing/duplicate/post-terminal events, exact permission option IDs, unsupported modes, approval bridging, exact lane identity, canonical fingerprints, and expired/mismatched authorization.**
- [ ] **Step 2: Run the focused core tests.** Expected: FAIL because the executor and record variants are absent.
- [ ] **Step 3: Expand runtime contracts and strict v2 record validation/reduction without weakening v1 read-only compatibility.**
- [ ] **Step 4: Implement the executor with bounded text/activity/file/evidence counts and exactly-one-terminal enforcement.** Never invent usage or evidence.
- [ ] **Step 5: Harden coordinator preflight so direct pins cannot resolve delegated and vice versa; validate runtime adapter/connection identity, expiry, and authorization fingerprint.**
- [ ] **Step 5a: Implement the process-scoped continuation store with single-use short-lived capabilities, copied bounded bytes, monotonic sequences, uncertain-to-committed transition, owner binding, and disposal.**
- [ ] **Step 6: Reject delegated `/compact` explicitly before provider work.**
- [ ] **Step 7: Run focused tests, the full core suite, and typecheck.** Expected: PASS.
- [ ] **Step 8: Commit with `feat: execute delegated agent runtimes`.**

### Task 4: Bounded ACP runtime package

**Files:**
- Create: `packages/runtimes/package.json`
- Create: `packages/runtimes/tsconfig.json`
- Create: `packages/runtimes/src/process-supervisor.ts`
- Create: `packages/runtimes/src/acp-runtime.ts`
- Create: `packages/runtimes/src/acp-updates.ts`
- Create: `packages/runtimes/src/index.ts`
- Create: `packages/runtimes/test/fixtures/fake-acp-agent.mjs`
- Create: `packages/runtimes/test/process-supervisor.test.ts`
- Create: `packages/runtimes/test/acp-runtime.test.ts`
- Modify: `tsconfig.json`
- Modify: `tsconfig.eslint.json`
- Modify: `vitest.config.ts`
- Modify: `package-lock.json`

**Interfaces:**
- `ManagedAcpRuntime` implements `AgentRuntime` using `@agentclientprotocol/sdk` 1.2.1 and an injected immutable `AcpRuntimeProfile`.
- `AcpRuntimeProfile` pins command, arguments, adapter ID, connection ID, protocol/version, reviewed model/config-option and act/plan/permission-mode mappings, separate frame/stdout/stderr/queue/event/time bounds, allowed environment keys, and capabilities.
- `ManagedAcpRuntime` receives only the opaque runtime-store facet. It stores vendor session IDs as bytes behind process-scoped Recurs continuation handles and never emits them into JSONL.
- Exposes `inspectAcpRuntime(profile, signal)` and `authenticateAcpRuntime(profile, advertisedMethodId, signal)` for onboarding.

- [ ] **Step 1: Add exact SDK 1.2.1 and compatible exact Zod dependencies and write hostile raw fake-agent tests for initialize/new/resume/prompt, model/mode enforcement, streamed updates, exact dynamic permission option IDs, auth-required retry, cancellation settlement, malformed/oversized/invalid-UTF8 NDJSON, stderr/queue/event bounds, early exit, timeout, duplicate/post-terminal traffic, and process-group cleanup.**
- [ ] **Step 2: Run `npm test -- packages/runtimes/test`.** Expected: FAIL because the package is absent.
- [ ] **Step 3: Implement bounded child supervision with explicit executable/argv, direct stdio, fatal UTF-8 and JSON-RPC envelope framing, process-group termination, stderr redaction, and a minimal environment allowlist.** Process-group cleanup is lifecycle hygiene, not OS containment.
- [ ] **Step 4: Implement the official SDK client over the prevalidated bounded stream using raw request/notification APIs rather than the unbounded ActiveSession helper.** Runtime-validate every result, negotiate `PROTOCOL_VERSION`, consume advertised capabilities/auth methods, create/resume sessions with absolute cwd and empty MCP servers, enforce reviewed model/mode mappings, translate updates tolerantly, and echo only an exact received permission option ID.
- [ ] **Step 5: Propagate abort through `session/cancel`, wait for the original prompt to settle as cancelled, then close the session/process within bounds.**
- [ ] **Step 6: Run runtime tests, lint, and typecheck.** Expected: PASS with no warning output.
- [ ] **Step 7: Commit with `feat: add bounded ACP runtime`.**

### Task 5: Official Codex subscription profile and setup

**Files:**
- Modify: `packages/runtimes/package.json`
- Modify: `packages/providers/src/bundled-manifests.ts`
- Modify: `packages/providers/test/manifests.test.ts`
- Create: `packages/runtimes/src/codex-acp-profile.ts`
- Create: `packages/runtimes/test/codex-acp-profile.test.ts`
- Modify: `packages/app/src/connection-registry.ts`
- Create: `packages/app/src/codex-onboarding.ts`
- Create: `packages/app/test/codex-onboarding.test.ts`
- Modify: `packages/cli/package.json`
- Modify: `packages/cli/src/assembly.ts`
- Modify: `packages/cli/src/main.ts`
- Modify: `packages/cli/src/runtime.ts`
- Modify: `packages/cli/test/assembly.test.ts`
- Modify: `packages/cli/test/run-mode.test.ts`
- Modify: `package-lock.json`

**Interfaces:**
- Resolves the installed `@agentclientprotocol/codex-acp` 1.1.2 entry point without importing its side-effectful module and spawns it with the current Node executable; exact reviewed `@openai/codex` and platform artifacts are pinned too. No `npx`, shell, copied token, or auth-file read.
- `setupCodexConnection()` initializes the adapter, uses an existing ChatGPT login when valid, otherwise selects only the currently advertised `chat-gpt` method, re-verifies structured ChatGPT auth status and session/model/modes, and commits non-secret delegated connection metadata. Adapter 1.1.2 does not expose plan tier or organization, so onboarding never claims that it does.
- The Codex manifest uses a machine-verifiable ChatGPT-authenticated/session-usable claim rather than `chatgpt_plan_active`. Current official billing is included plan usage with possible automatic prepaid-credit usage after limits; no strict-only path is provable, so activation requires an explicit `allow_declared_additional` selection.
- Standalone assembly resolves `agent_runtime` pins to a fresh `ManagedAcpRuntime` and installs `DelegatedAgentExecutor`.

- [ ] **Step 1: Pin the official adapter, exact Codex executable/platform artifacts, and write failing tests for package integrity/entry resolution without import, forbidden deprecated package, hazardous-environment stripping (including `CODEX_PATH` and logging/auth overrides), dynamic auth selection/status recheck, no-browser behavior, explicit billing acceptance, verified connection commit, pin creation, and delegated assembly.**
- [ ] **Step 2: Run focused runtime/app/CLI tests.** Expected: FAIL because the Codex profile is absent.
- [ ] **Step 3: Implement the immutable Codex runtime profile.** Keep `APP_SERVER_LOGS`, `DEFAULT_AUTH_REQUEST`, `CODEX_PATH`, provider/key/token/proxy overrides, and arbitrary secret-shaped environment entries unset; retain only reviewed platform/home context, and send Recurs identity through ACP `clientInfo`.
- [ ] **Step 4: Implement Codex onboarding and non-secret connection persistence.** Do not store auth method secrets or vendor paths.
- [ ] **Step 5: Generalize CLI assembly around registry records and create exact delegated pins with the persisted included-plus-declared-credits selection and local/manual policy.**
- [ ] **Step 6: Add `recurs setup codex` and useful `/connect`, `/model`, and `/status` copy.** Noninteractive prompts never trigger browser login.
- [ ] **Step 7: Run focused suites, full CLI/core/runtimes suites, and typecheck.** Expected: PASS.
- [ ] **Step 8: Commit with `feat: add Codex subscription onboarding`.**

### Task 6: Provider/account CLI, documentation, and end-to-end verification

**Files:**
- Modify: `packages/cli/src/main.ts`
- Modify: `packages/cli/test/run-mode.test.ts`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `PRODUCT.md`
- Modify: `docs/CLI.md`
- Modify: `docs/README.md`
- Modify: `docs/superpowers/specs/2026-07-10-recurs-provider-auth-design.md`
- Create: `tests/e2e/provider-onboarding.test.ts`

**Interfaces:**
- Adds `recurs provider list [--all] [--json]` and `recurs account list [--json]` using registry/application services rather than CLI-owned provider constants.
- Text and JSON distinguish runnable, broker-required, conditional, and blocked paths and always show billing owner/restriction for coding plans.

- [ ] **Step 1: Write failing CLI and E2E tests for provider filtering, machine-readable output, account redaction, local migration, Codex pin selection, and no-session behavior for broker-required entries.**
- [ ] **Step 2: Run the focused CLI/E2E tests.** Expected: FAIL because the commands are absent.
- [ ] **Step 3: Implement provider/account commands and renderers without exposing settings that could become secret-bearing.**
- [ ] **Step 4: Update all user and architecture documentation with exact implemented versus catalog-only status, setup commands, official ACP package/version, provider restrictions, and the next native-broker/cloud-identity work.**
- [ ] **Step 5: Run secret-pattern scan, `git diff --check`, package-boundary checks, `npm run check`, and an opt-in fake-process Codex workflow.** Expected: all default checks PASS; no live credential is required.
- [ ] **Step 6: Re-read the design and plan, mark delivered items accurately, and record any remaining gaps without calling them implemented.**
- [ ] **Step 7: Commit with `docs: complete provider authentication foundation`.**
