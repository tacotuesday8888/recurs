# Recurs

Recurs is a provider-neutral coding-agent harness that will grow into an agent manager. It is not an IDE: the CLI and future desktop app are clients over the same engine.

The code is intended to become an open-source project, but this repository does not yet contain a license. Until the owner selects and adds one, it is source-available rather than legally open source: no release or package should claim otherwise.

## Current foundation

The repository contains a usable single-agent base:

- one streaming tool-calling loop with bounded pre-output retries, cancellation, step limits, and repeated-loop detection;
- strict provider-event validation and normalized text, reasoning, tool, usage, and completion events;
- credential-free OpenAI-compatible local model setup for literal-loopback Ollama and LM Studio servers;
- a validated 25-path provider/authentication catalog, a revisioned non-secret connection registry, and exact-ID account listing, verification, primary selection, and metadata-only disconnection;
- an official Codex ACP path for an existing ChatGPT login, constrained to local, interactive, user-present, Plan-only work;
- seven tools for file reading, listing, search, patching, bounded shell execution, Git status, and Git diff;
- Ask Always, Approved for Me, Full Access, enforced Plan mode, and temporary read-only review;
- durable `/goal` state, append-only JSONL sessions, interrupted-tool recovery, compaction, checkpoints, and conflict-safe undo;
- interactive and non-interactive CLI paths with text or normalized JSONL output;
- immutable backend pins, strict version-2 session records, cross-process mutation leases, typed preflight failures, and durable delegated-runtime results and recovery;
- one credential-path policy enforced across direct and aggregate built-in tools, permanent denial of classified credential intents, and checkpoint capture that excludes those paths;
- clean per-child environments, bounded process-group cleanup, safe provider/tool/CLI failures, and explicit `local_guarded` or fail-closed `tools_disabled` composition;
- one `npm run check` path covering lint, type checking, tests, and build output.

The standalone CLI can use credential-free OpenAI-compatible servers on literal `127.0.0.1` or `[::1]`, or the pinned official `@agentclientprotocol/codex-acp` adapter with an existing ChatGPT account. Only the first saved connection becomes primary; later connections remain secondary until selected explicitly. Historical sessions always resolve their own immutable pin rather than the current primary. Codex is read-only/Plan-only, local, manual, and user-present: one-shot and unattended runs fail closed. Without an explicit primary the CLI starts a sessionless workspace shell, so local commands remain available without writing a fake session. Test hosts can also inject the public `ModelProvider` interface.

## Quick start

Requirements: Node.js 22.22 or newer, Git 2.45 or newer, and ripgrep.

```bash
npm install
npm run check
npm run build
node packages/cli/dist/main.js --help
node packages/cli/dist/main.js provider list
node packages/cli/dist/main.js account list
node packages/cli/dist/main.js account verify <connection-id>
node packages/cli/dist/main.js account set-primary <connection-id>
node packages/cli/dist/main.js account disconnect <connection-id>
node packages/cli/dist/main.js setup local --url http://127.0.0.1:11434/v1 --model qwen2.5-coder:7b
# Or, from a local interactive terminal, connect an existing ChatGPT account:
# node packages/cli/dist/main.js setup codex
node packages/cli/dist/main.js
```

After building, `npm link` exposes the local `recurs` command.

This is currently the only installation path. An npm package is the likely first preview channel. Bun may later install that npm package, while Node remains the supported runtime; Bun runtime support is not implemented. Homebrew and curl installers wait for versioned, signed release artifacts. Nothing is published by this repository today.

## Packages

```text
packages/contracts   Dependency-leaf model, connection, backend, failure, and runtime contracts
packages/providers   Validated provider manifests, protocol metadata, and direct-provider implementations
packages/app         Non-secret connection registry, lifecycle service, onboarding, and policy
packages/runtimes    Bounded ACP transport and the pinned official Codex runtime profile
packages/tools       Tool registry, permissions, path policy, Git, and checkpoints
packages/core        Direct/delegated execution, events, sessions, goals, compaction, and recovery
packages/cli         Runtime assembly, slash commands, renderers, REPL, and executable
tests/e2e            Public-interface coding workflow proof
```

The engine is first-party. Open-source agents informed its design; their source code was not copied into Recurs. See the [base-engine comparison](docs/BASE_ENGINE_COMPARISON.md).

## Trust boundary

Built-in file, search, patch, Git, and checkpoint paths share one case-insensitive credential classification. Direct classified credential paths are permanently denied in every permission preset, and aggregate tools omit them. New checkpoint stores carry a format marker recording the version-2 credential-exclusion contract used for new captures; an ambiguous nonempty legacy store fails closed and requires a manual reset. The marker is an unauthenticated upgrade assertion, not hardened proof about storage contents.

Fixed Git inspection requires Git 2.45 or newer, pins the requested worktree, and disables optional index writes, lazy object fetching, repository hooks, fsmonitor commands, external diff/text conversion, configured clean/smudge/process filters, and expanded dirty-submodule diffs. Patch input uses exact slash-separated declarations, rejects rename/copy operations, denies canonical credential aliases before checkpoint capture, and must match Git's complete parsed path set. Checkpoint capture and undo also reclassify canonical parent and file targets, so a stable safe-looking symlink alias into an auth directory is omitted or refused before a read or restore.

All fixed and arbitrary child processes receive a fresh private home, config, cache, and temporary tree plus an allowlisted environment. They do not inherit provider/cloud variables, the real home, `SHELL`, proxy variables, sockets, or workspace-contained `PATH` entries. Process-group cleanup and output-pipe draining are bounded so inherited pipes alone cannot hold Recurs settlement open before synthetic-state cleanup, but preventing an escaped descendant requires the later OS containment boundary. Provider, tool, process, and unexpected CLI failures cross durable/user-visible boundaries through safe typed messages instead of raw causes or stderr.

These are application-level defenses, not an OS security boundary. The default `local_guarded` profile still lets approved arbitrary commands use the user's host filesystem, network, IPC, and process authority. `Full Access` remains unsafe for credentials. The optional `tools_disabled` profile exposes no model-callable tools at all; it is a fail-closed composition option, not a coding sandbox. No API key, coding-plan key, cloud credential, copied token, or imported vendor auth file may enter the Recurs TypeScript process. The Codex path is a narrow exception only in the sense that the official vendor runtime keeps ownership of its existing ChatGPT authentication; Recurs never reads or stores that credential.

Before Recurs can own direct API, coding-plan, OAuth, or cloud-identity credentials, it needs a separately tested native broker/storage boundary with descriptor-relative no-follow I/O, ownership/mode/ACL and full-parent validation, filesystem capability checks, origin-bound transport, and an OS sandbox that prevents tool children from reaching broker authority. A small Rust or native component is appropriate for that boundary; the TypeScript harness does not need a wholesale rewrite.

## Next

1. Design and prove the native broker, hardened storage, origin-bound transport, and OS tool sandbox before any Recurs-owned provider credential.
2. Activate reviewed direct API, coding-plan, OAuth, and cloud-identity paths over that authority boundary; catalog-only entries remain unavailable until their broker/adapter work lands.
3. Expand official delegated runtimes only through documented integrations and provider-specific policy review.
4. Build the heavy sub-agent/company runtime over these explicit backend capabilities.

Start with the [documentation index](docs/README.md), [CLI guide](docs/CLI.md), [architecture](ARCHITECTURE.md), [security policy](SECURITY.md), and [product direction](PRODUCT.md).
