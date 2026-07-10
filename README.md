# Recurs

Recurs is a provider-neutral coding-agent harness that will grow into an agent manager. It is not an IDE: the CLI and future desktop app are clients over the same engine.

## Current foundation

The repository contains a usable single-agent base:

- one streaming tool-calling loop with bounded pre-output retries, cancellation, step limits, and repeated-loop detection;
- strict provider-event validation and normalized text, reasoning, tool, usage, and completion events;
- seven tools for file reading, listing, search, patching, bounded shell execution, Git status, and Git diff;
- Ask Always, Approved for Me, Full Access, enforced Plan mode, and temporary read-only review;
- durable `/goal` state, append-only JSONL sessions, interrupted-tool recovery, compaction, checkpoints, and conflict-safe undo;
- interactive and non-interactive CLI paths with text or normalized JSONL output;
- one `npm run check` path covering lint, type checking, 100+ tests, and build output.

The standalone CLI does not yet bundle a live LLM provider. Hosts can inject the public `ModelProvider` interface; local slash commands remain available without one.

## Quick start

Requirements: Node.js 22.22 or newer, Git, and ripgrep.

```bash
npm install
npm run check
npm run build
node packages/cli/dist/main.js --help
```

After building, `npm link` exposes the local `recurs` command.

## Packages

```text
packages/providers   Normalized provider protocol and deterministic test provider
packages/tools       Tool registry, permissions, path policy, Git, and checkpoints
packages/core        Agent loop, events, sessions, goals, compaction, and recovery
packages/cli         Runtime assembly, slash commands, renderers, REPL, and executable
tests/e2e            Public-interface coding workflow proof
```

The engine is first-party. Open-source agents informed its design; their source code was not copied into Recurs. See the [base-engine comparison](docs/BASE_ENGINE_COMPARISON.md).

## Trust boundary

File tools enforce workspace, symlink, stale-write, and output limits. Shell commands are bounded and cancellable, but they are not yet isolated by an OS sandbox. Approved for Me therefore asks before every shell command. Full Access is an explicit decision to trust the model with commands, credentials, external paths, network access, and inherited host environment values.

## Next

1. Implement the reviewed provider, authentication, model-selection, and onboarding design.
2. Build the heavy sub-agent/company runtime over the same events, tools, sessions, goals, and permissions.
3. Add the desktop agent-manager client, plugins/MCP, signed releases, Homebrew, and curl installation in later slices.

Start with the [documentation index](docs/README.md), [CLI guide](docs/CLI.md), [architecture](ARCHITECTURE.md), and [product direction](PRODUCT.md).
