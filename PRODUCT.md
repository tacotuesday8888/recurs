# Recurs Product Direction

Recurs is an agent manager for software work. It combines a coding-agent CLI with a later desktop experience where a project looks and behaves like a small software company: agents have responsibilities, conversations, goals, handoffs, reviews, approvals, and visible progress.

It is not an IDE. Users may keep their editor of choice. Recurs manages the people-like software agents doing the work.

## Product shape

- **CLI first:** run `recurs` inside a project, chat with the active coding agent, inspect activity, set a durable goal, plan, approve work, review changes, resume, and undo.
- **Desktop later:** selecting a project opens the company operating view rather than only a chat archive. Chat remains central, surrounded by agents, current work, goals, handoffs, approvals, reviews, and history.
- **One engine:** CLI, desktop, automation, and future cloud workers use the same event, session, tool, permission, and orchestration contracts.

## Principles

1. **A strong base before a large surface.** Reliability, recovery, permissions, and observability matter more than matching every competitor command.
2. **First-party engine.** Recurs studies open-source agents but owns its core interfaces and behavior.
3. **Provider-neutral and policy-honest.** Users should be able to connect supported keys, coding plans, subscriptions, and local models only through documented methods, with billing and limitations shown clearly.
4. **Sub-agents are the differentiation.** The single-agent harness stays small; coordination, delegation, isolation, review, and company structure become the main product layer.
5. **Permissions are enforced.** Plan mode and tool access are capability boundaries. Product copy must not promise a sandbox or credential isolation that the code does not enforce.
6. **Durable work.** Goals, sessions, tool boundaries, evidence, checkpoints, and handoffs survive restarts and remain inspectable.

## What exists now

Core v0, the provider/authentication catalog foundation, and the TypeScript tool-safety precursor are implemented: a provider-neutral loop, eight host tools, three owned delegation primitives, three permission presets, Plan and review modes, goals, pinned version-2 sessions, cross-process mutation leases, trusted run context, direct and delegated coordinator lanes, interrupted-work recovery, compaction, checkpoints/undo, sessionless workspace shell, interactive and JSONL CLI paths, and full end-to-end coding workflows.

The first Recurs-owned team vertical is also real. A parent can create one durable Explore, Implement, or Review child, run a bounded foreground Explore/Review batch, or ask `delegate_team` to run up to four isolated Implement workers and a mode-selected Review panel. Version-3 Economy through Max policies combine a named quality standard with implementation width, initial/maximum reviewers, child/request limits, concurrency, depth, retries, and reported-cost ceilings. Team patches are bounded, text-only, hash-addressed, and applied in task order behind an exact rollback checkpoint; all workers must succeed, permissions cannot widen, cancellation is linked, and strict Review output produces `approved`, `changes_requested`, or `unverified`. Durable `/agents activity` exposes child status, usage, files, evidence, and isolation revision. Background work, resumption, recursion, automatic repair, dirty-parent snapshots, auto-commit, and independent child-model routing are intentionally absent.

Built-in tools now share a permanent credential-path denial, aggregate tools and new checkpoints exclude those paths, child processes receive clean synthetic state, and provider/tool/CLI failures are sanitized before durable or user-visible boundaries. Hosts may choose the default `local_guarded` tool profile or a fail-closed `tools_disabled` profile that exposes no model tools.

The CLI now has a validated 25-path catalog and a non-secret connection lifecycle. Three paths are runnable: literal-loopback Ollama, literal-loopback LM Studio, and an existing ChatGPT account through the pinned official Codex ACP adapter. Users can list, verify, select, and disconnect exact connection IDs; only the first connection becomes primary automatically, disconnection never logs out of a vendor, and historical sessions continue through their immutable pin. Codex setup and every Codex turn recheck vendor-reported authentication/account identity; each turn binds the account on the same ACP child before session work and again immediately before prompting. The connection is local, manual, user-present, and Plan-only, and its disclosed billing can include automatic prepaid-credit use after included limits. Recurs does not import or store the vendor credential.

The private macOS authority now implements complete OpenAI API, Anthropic API, and Kimi Code activation and generation verticals. A production-signed launcher owns foreground no-echo capture and exact process/signal cleanup; an exact-peer XPC broker owns Data Protection Keychain, crash-safe journal-v2 state, model discovery, provider HTTP/stream codecs, encrypted OpenAI continuation state, bounded one-use route reservations, and credential-echo filtering. The sealed TypeScript engine sees only redacted lifecycle and normalized generation frames, never a reusable credential. Source/npm and ad-hoc execution fail this path closed. No signed/notarized installed artifact or production credential-canary smoke has shipped, so the verticals are implemented and tested but not distributed.

`local_guarded` arbitrary commands are not OS-sandboxed and retain the user's filesystem, network, IPC, and process authority. `tools_disabled` avoids model tools but is not a usable coding profile and does not replace the future credential boundary.

The repository is intended to become open source, but it has no license yet and cannot legally be described as open source until the owner adds one. It is source-installable only; no npm, Bun, Homebrew, curl, or binary release has been published.

## Roadmap

### 1. Provider and onboarding layer

Credential-free onboarding for literal-loopback OpenAI-compatible local providers is implemented. It collects no key, refuses non-loopback endpoints and redirects, and persists only endpoint/model metadata. The 25-path catalog, billing/restriction projection, redacted provider/account commands, and official Codex-with-ChatGPT delegated path are also implemented.

The private macOS OpenAI, Anthropic, and Kimi paths are assembled without rewriting the TypeScript harness: exact profile binding, model discovery, crash-safe setup, generation codecs, CLI onboarding, cancellation, usage, and redacted diagnostics are implemented. The next step is a signed/notarized installed artifact plus recovery and credential-canary proof. A manifest flag or shared wire protocol alone still cannot activate a provider.

Additional providers and delegated runtimes remain provider-specific integrations. Future native HTTPS treats macOS system proxy/root configuration as trusted host policy, and the current tool profile remains explicitly non-sandboxed. A provider stays unavailable whenever any required attestation, codec/profile, policy, platform, onboarding, or release evidence is absent.

### 2. Sub-agent company runtime

The durable parent/child contracts, exact worker profiles, shared budgets, foreground delegation, normalized activity, isolated Explore/Review batches, parallel Implement patch integration, exact rollback, and adaptive Review slice are implemented. Continue the primary product differentiator with:

- durable background ownership, resumption, and escalation without duplicating the execution engine;
- carefully expanded role contracts, automatic correction loops, and model routing behind versioned policy and hard spend limits;
- a company-level operating view over the existing goals, budgets, cancellation, handoffs, review, and normalized activity stream.

Before unattended local workers run arbitrary commands, add an enforceable process/filesystem/network isolation layer.

### 3. Product surfaces and ecosystem

Add the company-style desktop client, plugins and MCP with trust boundaries, background/cloud execution, and distribution. An npm package is the likely first preview channel; Bun may later install it while Node remains the runtime. Homebrew and curl wait for versioned signed artifacts, and Windows support remains later work.

## Not current commitments

Recurs is not currently building its own foundation model, replacing code editors, hosting model credits, promising unofficial access to consumer subscriptions, or copying the full feature inventory of Kilo Code, OpenCode, Codex, Claude Code, or Cursor.

Historical exploration is preserved under [docs/research](docs/research/README.md). Current technical decisions live in [ARCHITECTURE.md](ARCHITECTURE.md) and the reviewed specs indexed in [docs/README.md](docs/README.md).
