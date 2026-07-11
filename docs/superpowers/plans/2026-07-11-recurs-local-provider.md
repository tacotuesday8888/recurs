# Recurs Local Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing harness usable with a credential-free OpenAI-compatible model server bound to a literal loopback address.

**Architecture:** `@recurs/providers` owns a narrow OpenAI-compatible streaming adapter and loopback-origin validation. The CLI owns a small non-secret local connection file and setup rendering, while the existing backend resolver creates a fresh provider for each run and pins sessions to the selected connection and model. No key, OAuth token, cloud identity, remote endpoint, LAN discovery, or new authentication package enters this slice.

**Tech Stack:** TypeScript 6, Node.js 22 built-in `fetch`, npm workspaces, Vitest 4, OpenAI-compatible `/models` and `/chat/completions` endpoints.

## Global Constraints

- Accept only plain HTTP origins whose hostname is exactly `127.0.0.1` or `[::1]`; reject credentials, queries, fragments, redirects, DNS names, private-LAN addresses, and non-loopback destinations.
- Persist only validated non-secret connection metadata. Revalidate it every time it is loaded.
- Keep the injected `ScriptedProvider` path working for tests and embeddings.
- Create or resume a version-2 session only after a configured connection and model are available.
- Use test-first red-green cycles for every behavioral change.

---

### Task 1: Literal-loopback provider

**Files:**
- Create: `packages/providers/src/local-openai-compatible.ts`
- Create: `packages/providers/test/local-openai-compatible.test.ts`
- Modify: `packages/providers/src/index.ts`

**Interfaces:**
- Produces: `normalizeLoopbackOpenAIBaseUrl(input: string): string`, `listLocalOpenAIModels(options): Promise<LocalModelDescriptor[]>`, and `LocalOpenAICompatibleProvider implements ModelProvider`.
- Consumes: normalized `ModelProvider`, `ProviderRequest`, and `ProviderEvent` contracts.

- [x] Write tests proving accepted IPv4/IPv6 loopback origins, rejected remote/ambiguous URLs, redirect rejection, strict catalog parsing, streamed text, usage, tool-call assembly, cancellation, response bounds, and safe errors.
- [x] Run `npm test -- packages/providers/test/local-openai-compatible.test.ts` and confirm failure because the module is absent.
- [x] Implement the smallest adapter that passes those tests, using manual redirect handling and bounded SSE parsing.
- [x] Run the focused test and `npm run typecheck`.

### Task 2: Non-secret local connection store and assembly

**Files:**
- Create: `packages/cli/src/local-connection.ts`
- Create: `packages/cli/test/local-connection.test.ts`
- Modify: `packages/cli/src/assembly.ts`
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/test/assembly.test.ts`

**Interfaces:**
- Produces: schema-versioned `LocalConnectionConfiguration`, `readLocalConnection()`, and `writeLocalConnection()` using an atomic replacement file.
- Assembly loads and revalidates the configuration, creates immutable backend pins, resumes only an exact connection/model match, and creates the provider per run.

- [x] Write failing tests for round-trip persistence, malformed/unknown-field rejection, remote-origin rejection on load, exact session pinning, and configured startup.
- [x] Run the focused tests and confirm the expected missing behavior.
- [x] Implement strict parsing, mode-`0600` atomic persistence, and generalized local-provider assembly without weakening injected-provider behavior.
- [x] Run focused tests and `npm run typecheck`.

### Task 3: CLI setup and shell visibility

**Files:**
- Modify: `packages/cli/src/main.ts`
- Modify: `packages/cli/src/runtime.ts`
- Modify: `packages/cli/test/run-mode.test.ts`
- Modify: `packages/cli/test/assembly.test.ts`

**Interfaces:**
- Produces: `recurs setup local --url <loopback-base-url> --model <id>` and useful `/connect`, `/model`, and `/status` output.
- Setup validates the endpoint, confirms the selected model exists in `/models`, persists configuration, and never accepts a secret.

- [x] Write failing CLI tests for successful setup, missing arguments, unreachable endpoints, absent models, and remote URL rejection.
- [x] Run the focused tests and confirm expected failures.
- [x] Implement setup argument parsing and rendering; update workspace-shell commands to show exact setup instructions.
- [x] Run focused tests and `npm run typecheck`.

### Task 4: Documentation and complete verification

**Files:**
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `docs/CLI.md`
- Modify: `docs/superpowers/specs/2026-07-10-recurs-provider-auth-design.md`

- [x] Document the supported setup command, trust boundary, Ollama/LM Studio examples, and remaining credential-provider blocker.
- [x] Inspect `git diff --check`, `git status`, and the complete diff.
- [x] Run `npm run check` and require lint, typecheck, all tests, and build to pass.
- [x] Re-read this plan and mark every delivered item accurately; report any intentionally deferred item.
