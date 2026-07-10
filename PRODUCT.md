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

Core v0 is implemented and verified: a provider-neutral loop, seven tools, three permission presets, Plan and review modes, goals, append-only sessions, interrupted-tool recovery, compaction, checkpoints/undo, interactive and JSONL CLI paths, and a full end-to-end coding workflow.

The CLI currently needs an injected `ModelProvider` for real prompts. It does not yet collect credentials, connect subscriptions, choose a model, or ship provider network adapters. Shell commands are not OS-sandboxed, so the default is cautious and Approved for Me asks before command execution.

## Roadmap

### 1. Provider and onboarding layer

Implement the reviewed connection architecture: secure credential handling, documented API-key and subscription paths, model catalogs, billing disclosure, exact session backend pins, connection verification, and a first-run setup flow shared by CLI and desktop.

### 2. Sub-agent company runtime

Build the primary product differentiator:

- an orchestrator that decomposes and delegates work;
- explicit worker roles and capability profiles;
- isolated workspaces and controlled integration;
- goals, budgets, cancellation, handoffs, review, and escalation;
- a normalized activity stream understandable by both terminal and desktop clients.

Before unattended local workers run arbitrary commands, add an enforceable process/filesystem/network isolation layer.

### 3. Product surfaces and ecosystem

Add the company-style desktop client, plugins and MCP with trust boundaries, background/cloud execution, signed binaries, Homebrew and curl installation, and Windows distribution.

## Not current commitments

Recurs is not currently building its own foundation model, replacing code editors, hosting model credits, promising unofficial access to consumer subscriptions, or copying the full feature inventory of Kilo Code, OpenCode, Codex, Claude Code, or Cursor.

Historical exploration is preserved under [docs/research](docs/research/README.md). Current technical decisions live in [ARCHITECTURE.md](ARCHITECTURE.md) and the reviewed specs indexed in [docs/README.md](docs/README.md).
