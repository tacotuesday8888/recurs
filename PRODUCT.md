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

Core v0, provider-foundation Slice 0, and the TypeScript tool-safety precursor are implemented: a provider-neutral loop, seven tools, three permission presets, Plan and review modes, goals, pinned version-2 sessions, cross-process mutation leases, trusted run context, a backend-neutral coordinator, interrupted-work recovery, compaction, checkpoints/undo, sessionless workspace shell, interactive and JSONL CLI paths, and a full end-to-end coding workflow.

Built-in tools now share a permanent credential-path denial, aggregate tools and new checkpoints exclude those paths, child processes receive clean synthetic state, and provider/tool/CLI failures are sanitized before durable or user-visible boundaries. Hosts may choose the default `local_guarded` tool profile or a fail-closed `tools_disabled` profile that exposes no model tools.

The CLI still needs an injected `ModelProvider` for real prompts. It does not collect credentials, connect subscriptions, choose a model, or ship provider network adapters. `local_guarded` arbitrary commands are not OS-sandboxed and retain the user's filesystem, network, IPC, and process authority, so no live credential may enter this process. `tools_disabled` avoids model tools but is not a usable coding profile and does not replace the future credential boundary.

The repository is intended to become open source, but it has no license yet and cannot legally be described as open source until the owner adds one. It is source-installable only; no npm, Bun, Homebrew, curl, or binary release has been published.

## Roadmap

### 1. Provider and onboarding layer

The next bounded product slice is credential-free onboarding for a literal-loopback local provider. It must not collect a key, reuse another product's auth, add `@recurs/auth`, or imply that the current process is safe for cloud credentials.

In parallel, design and prove the narrow native authority boundary required before credential-bearing providers: descriptor-relative no-follow storage, owner/mode/ACL/full-parent validation, filesystem capability checks, a non-exporting broker, origin-bound transport, and an OS sandbox that prevents tool children from reaching Recurs or vendor auth state. A small Rust or platform-native component fits this boundary; rewriting the TypeScript harness wholesale does not.

Only after that gate should Recurs add credential-bearing connection metadata, model catalogs, billing disclosure, connection verification, first-run setup shared by CLI and desktop, direct providers, and official delegated runtimes.

### 2. Sub-agent company runtime

Build the primary product differentiator:

- an orchestrator that decomposes and delegates work;
- explicit worker roles and capability profiles;
- isolated workspaces and controlled integration;
- goals, budgets, cancellation, handoffs, review, and escalation;
- a normalized activity stream understandable by both terminal and desktop clients.

Before unattended local workers run arbitrary commands, add an enforceable process/filesystem/network isolation layer.

### 3. Product surfaces and ecosystem

Add the company-style desktop client, plugins and MCP with trust boundaries, background/cloud execution, and distribution. An npm package is the likely first preview channel; Bun may later install it while Node remains the runtime. Homebrew and curl wait for versioned signed artifacts, and Windows support remains later work.

## Not current commitments

Recurs is not currently building its own foundation model, replacing code editors, hosting model credits, promising unofficial access to consumer subscriptions, or copying the full feature inventory of Kilo Code, OpenCode, Codex, Claude Code, or Cursor.

Historical exploration is preserved under [docs/research](docs/research/README.md). Current technical decisions live in [ARCHITECTURE.md](ARCHITECTURE.md) and the reviewed specs indexed in [docs/README.md](docs/README.md).
