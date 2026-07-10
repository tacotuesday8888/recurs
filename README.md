# Recurs

Recurs is a provider-neutral coding-agent harness and agent manager. The first surface is a terminal CLI, built around a durable tool-calling loop, strong subagent-ready boundaries, explicit permissions, Plan mode, long-running goals, recoverable checkpoints, and resumable sessions.

It is not an IDE. The longer-term desktop product will feel closer to a coding-agent manager: open a project, see the working “company” of agents, follow conversations, goals, handoffs, approvals, reviews, and progress—while keeping chat as the primary interaction model.

## What works now

Recurs Core v0 includes:

- A first-party, provider-neutral streaming agent loop.
- Deterministic scripted providers for tests and embedded development.
- Sequential tool execution with cancellation, retry limits, step budgets, and repeated-loop detection.
- Safe file read/list/search/patch tools with workspace, sensitive-path, output, current-turn read, and stale-write guards.
- Bounded shell commands, conservative command-risk classification, and read-only Git inspection.
- Ask Always, Approved for Me, and Full Access permission presets.
- Enforced Plan mode and temporary read-only reviews.
- Append-only JSONL sessions, crash-tail recovery, compaction, and exact-ID resume.
- Durable `/goal` progress, blockers, and completion evidence.
- Content-addressed before/after checkpoints and conflict-safe `/undo`.
- Interactive and `recurs run` paths over the same runtime, with text or normalized JSONL events.

The end-to-end test drives the public harness through read → patch → test → persist → resume → review → undo in a temporary Git repository.

## Quick start

Requirements: Node.js 22.22+, Git, and ripgrep.

```bash
npm install
npm run build
node packages/cli/dist/main.js --help
npm test
```

After building, `npm link` can expose the local `recurs` binary. See the [CLI guide](docs/CLI.md) for commands, permissions, session storage, JSONL output, checkpoints, and safety limits.

## LLM status

Live LLM wiring is deliberately deferred. Recurs does not currently collect API keys, choose models, connect to hosted providers, or reuse Codex/Claude/other subscriptions. Hosts can inject the public `ModelProvider` contract today; the standalone CLI clearly reports that a provider is not configured when a coding prompt is submitted.

This keeps the harness testable while provider transports, authentication, model routing, and subscription integrations are designed separately.

## Packages

```text
packages/providers   Normalized model/provider protocol and ScriptedProvider
packages/tools       Permissions, path policy, tools, commands, Git, checkpoints
packages/core        Events, sessions, goals, compaction, loop detection, agent loop
packages/cli         Slash commands, runtime assembly, renderers, REPL, executable
tests/e2e            Public-interface coding-agent proof
```

The implementation is first-party. Open-source coding agents informed the architecture, but their code was not copied into this harness.

## Direction after Core v0

The next layers are intentionally separate extensions:

1. Live provider transports, authentication, model selection, and subscription-backed adapters.
2. A heavy subagent/company architecture over the same events, tools, goals, sessions, and permissions.
3. Plugin and MCP integration with explicit trust and permission boundaries.
4. Signed releases plus Homebrew and curl installation; Windows distribution later.
5. A desktop agent-manager experience—not an IDE—that presents each project as a working software company while retaining the chat interface.

Product exploration and earlier research remain in [PRODUCT.md](PRODUCT.md), [ARCHITECTURE.md](ARCHITECTURE.md), [HARNESS_RESEARCH.md](HARNESS_RESEARCH.md), and [HARNESS_APPROACH.md](HARNESS_APPROACH.md). The approved Core v0 design is in [the design spec](docs/superpowers/specs/2026-07-10-recurs-core-v0-design.md).
