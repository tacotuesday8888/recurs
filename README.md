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
- a macOS 14.4+ native-authority foundation with tested binary framing, Data Protection Keychain, credential-state/journal, exact signed peers, production-gated broker recovery and private credential lifecycle XPC, a health-only launcher/private-engine bridge, fixed sealed-bundle paths, and redacted diagnostics;
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
node packages/cli/dist/main.js doctor native --json
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
packages/auth        Credential-free bounded client for an inherited native socket
packages/providers   Validated provider manifests, protocol metadata, and direct-provider implementations
packages/app         Non-secret connection registry, lifecycle service, onboarding, and policy
packages/runtimes    Bounded ACP transport and the pinned official Codex runtime profile
packages/tools       Tool registry, permissions, path policy, Git, and checkpoints
packages/core        Direct/delegated execution, events, sessions, goals, compaction, and recovery
packages/cli         Runtime assembly, slash commands, renderers, REPL, and executable
packages/native-engine  Sealed launcher-only host for the health bridge
native/macos         Native security/state libraries and recovered broker/launcher executables
tests/e2e            Public-interface coding workflow proof
```

The engine is first-party. Open-source agents informed its design; their source code was not copied into Recurs. See the [base-engine comparison](docs/BASE_ENGINE_COMPARISON.md).

## Trust boundary

Built-in file, search, patch, Git, and checkpoint paths share one case-insensitive credential classification. Direct classified credential paths are permanently denied in every permission preset, and aggregate tools omit them. New checkpoint stores carry a format marker recording the version-2 credential-exclusion contract used for new captures; an ambiguous nonempty legacy store fails closed and requires a manual reset. The marker is an unauthenticated upgrade assertion, not hardened proof about storage contents.

Fixed Git inspection requires Git 2.45 or newer, pins the requested worktree, and disables optional index writes, lazy object fetching, repository hooks, fsmonitor commands, external diff/text conversion, configured clean/smudge/process filters, and expanded dirty-submodule diffs. Patch input uses exact slash-separated declarations, rejects rename/copy operations, denies canonical credential aliases before checkpoint capture, and must match Git's complete parsed path set. Checkpoint capture and undo also reclassify canonical parent and file targets, so a stable safe-looking symlink alias into an auth directory is omitted or refused before a read or restore.

All fixed and arbitrary child processes receive a fresh private home, config, cache, and temporary tree plus an allowlisted environment. They do not inherit provider/cloud variables, the real home, `SHELL`, proxy variables, sockets, or workspace-contained `PATH` entries. Process-group cleanup and output-pipe draining are bounded so inherited pipes alone cannot hold Recurs settlement open before synthetic-state cleanup, but preventing an escaped descendant requires the later OS containment boundary. Provider, tool, process, and unexpected CLI failures cross durable/user-visible boundaries through safe typed messages instead of raw causes or stderr.

These are application-level defenses, not an OS security boundary. The default `local_guarded` profile still lets approved arbitrary commands use the user's host filesystem, network, IPC, and process authority. `Full Access` remains unsafe for credentials. The optional `tools_disabled` profile exposes no model-callable tools at all; it is a fail-closed composition option, not a coding sandbox. No API key, coding-plan key, cloud credential, copied token, or imported vendor auth file may enter the Recurs TypeScript process. The Codex path is a narrow exception only in the sense that the official vendor runtime keeps ownership of its existing ChatGPT authentication; Recurs never reads or stores that credential.

The macOS native-authority foundation now includes the health-only launcher-to-engine process boundary. After production-signing validation, the launcher resolves only nonsymlinked `Contents/Resources/runtime/bin/node` and `Contents/Resources/engine/main.js`, spawns that engine in its foreground process group with descriptors `0`–`3` only, and serves bounded `hello`, `health`, and `cancel` frames over the anonymous descriptor-3 socket. The public npm/source CLI deletes an injected `RECURS_NATIVE_FD` before loading the application and never writes to it. Unsigned, ad-hoc, and source launchers cannot substitute an engine through `PATH`, cwd, environment, or arguments; the engine path fails with fixed exit `78` and empty output.

The broker is no longer health-only: its production-gated startup derives and validates the exact launcher signing requirement and Keychain configuration, fully recovers one credential authority before listener construction or activation, and then exposes a private launcher-only lifecycle surface with `persistentCredentials: true`. Its schema-v2 journal now authenticates one exact provider/profile binding on every record; custom bindings include canonical host, port, base path, and model-catalog behavior. Native component `0.2.0` also carries that identity through a bounded, non-secret private credential-stage descriptor while keeping lifecycle replies redacted and the launcher-to-engine bridge limited to `hello`, `health`, and `cancel`. Because this credential state has never shipped, schema-v1 journals are not migrated; development users reset the unpublished native journal and reconnect.

The broker also has dormant internal setup/run/maintenance route authority. It derives every capability from authenticated journal binding and candidate or usable-ready state, rechecks that state after suspension, and enforces exact scope, expiry, cancellation, and checked budgets without loading Keychain or touching a resolver or network path. The launcher library now contains an internal foreground-TTY capture primitive and an authenticated lifecycle XPC client; capture restores exact terminal state, cancellation is sticky, transient secret buffers are erased, lifecycle request IDs are independently correlated, and replies remain redacted. Neither seam is called by the executable, and TTY capture stays internal until a signal-owning coordinator proves restoration across interrupt, termination, and suspension.

This is still not a provider-usable authority. There is no executable secret-collection/setup flow, provider verification, DNS or network feasibility proof, credential reservation from a route receipt, broker HTTP/TLS/proxy path, request/stream codec, model-catalog transport, direct-provider CLI assembly, signed production smoke, or enabled broker-owned provider. Source/npm and ad-hoc builds therefore cannot activate it, and every broker-owned manifest remains disabled. A directly injected peer still cannot prove provenance and is downgraded to `peer_identity_unverified`. The owner-run release smoke requires an ephemeral macOS user and a dedicated production test Keychain access group because changing `HOME` cannot safely redirect the live journal root or Keychain configuration. The sealed private engine also rejects delegated Codex with a fixed safe error until its runtime binary and adapter have a reviewed fixed signed-bundle layout; the public npm/source Codex ACP path remains implemented. The bundle builder is configured to retain legal comments, but release packaging still needs a complete third-party notices and license review. The approved future native HTTPS path will trust macOS system proxy and root configuration while ignoring repository proxy/CA environment variables. The current `local_guarded` tool profile is still not a general OS sandbox.

## Next

1. Produce and verify a signed/notarized installed launcher bundle, including the isolated owner-run broker recovery smoke.
2. Connect TTY secret capture and provider-verified staging to the broker lifecycle, then build the first DNS/network-feasible native HTTP/TLS/proxy, request/stream codec, model-catalog, and transport vertical over the dormant route authority.
3. Activate reviewed direct API and coding-plan paths only after signed installed-artifact and credential-canary gates pass; catalog-only entries remain unavailable until their complete vertical lands.
4. Give any delegated runtime included in the sealed engine its own fixed signed layout; expand delegated runtimes only through documented integrations and provider-specific policy review.
5. Build the heavy sub-agent/company runtime over these explicit backend capabilities.

Start with the [documentation index](docs/README.md), [CLI guide](docs/CLI.md), [architecture](ARCHITECTURE.md), [security policy](SECURITY.md), and [product direction](PRODUCT.md).
