# Recurs

Recurs is a provider-neutral coding-agent harness that will grow into an agent manager. It is not an IDE: the CLI and future desktop app are clients over the same engine.

The code is intended to become an open-source project, but this repository does not yet contain a license. Until the owner selects and adds one, it is source-available rather than legally open source: no release or package should claim otherwise.

## Current foundation

The repository contains a usable agent base and a bounded, Recurs-owned child-agent vertical:

- one streaming tool-calling loop with bounded pre-output retries, cancellation, step limits, and repeated-loop detection;
- one foreground `delegate_task` path that selects an exact Explore, Implement, or Review profile, creates a durable child session, runs it through the same coordinator/provider/runtime/approval seams, and returns its evidence-bearing handoff to the parent for synthesis;
- one foreground `delegate_tasks` path for two to eight independent Explore/Review tasks, with mode-bounded parallelism, clean detached Git worktrees, deterministic input-order results, partial-failure evidence, linked cancellation, and parent synthesis;
- one durable `delegate_team` path that stages isolated Implement work outside the parent, performs strict independent Review, runs bounded finding-driven Repair, and either applies an approved foreground candidate or leaves an approved background candidate for explicit apply;
- durable parent/child/task/lifecycle/workspace/result contracts plus a sequenced team-run journal, normalized activity events, monotonic permission inheritance, shared child/request/reported-cost budgets, and explicit depth-one/zero-retry/mode-bounded limits;
- process-lifetime background team control through model tools and `/agents`, with cross-process owner leases, truthful interruption, safe resume boundaries, two-phase parent apply, conservative startup recovery, and stale private-worktree cleanup;
- five version-4 operating modes, with Balanced v4 as the default, plus immutable version-1 through version-3 replay policies, provider-neutral role-routing contracts, honest parent-backend inheritance in the production assembly, and per-run child/request/reported-cost policy;
- strict provider-event validation and normalized text, reasoning, tool, usage, and completion events;
- versioned protocol-level harness profiles that give native-tool and compatibility models different, stable tool-use instructions without baking model brands into policy;
- credential-free OpenAI-compatible local model setup for literal-loopback Ollama and LM Studio servers;
- cross-platform ephemeral BYOK for reviewed OpenAI Chat-compatible HTTPS providers through `RECURS_PROVIDER`, `RECURS_MODEL`, and `RECURS_API_KEY`; the key is never persisted or forwarded to tools;
- private signed-macOS activation paths for OpenAI API, Anthropic API, and Kimi Code credentials, with native model discovery and streamed tool calling;
- a validated 25-path provider/authentication catalog, a revisioned non-secret connection registry, and exact-ID account listing, verification, primary selection, and metadata-only disconnection;
- a bounded `models.dev` discovery catalog, fixed-port loopback detection for Ollama and LM Studio, and one `/provider` surface shared with first-run onboarding;
- an official Codex ACP path for an existing ChatGPT login, constrained to local, interactive, user-present, Plan-only work;
- eight tools for file reading, listing, search, patching, bounded shell execution, shell-free allowlisted verification, Git status, and Git diff; each child profile receives an exact host-tool and intent ceiling;
- Ask Always, Approved for Me, Full Access, enforced Plan mode, and a read-only Review profile;
- durable `/goal` state, append-only JSONL sessions, interrupted-tool recovery, compaction, checkpoints, and conflict-safe undo;
- interactive and non-interactive CLI paths with text or normalized JSONL output;
- immutable backend pins, strict version-2 session records, cross-process mutation leases, typed preflight failures, and durable delegated-runtime results and recovery;
- one credential-path policy enforced across direct and aggregate built-in tools, permanent denial of classified credential intents, and checkpoint capture that excludes those paths;
- clean per-child environments, bounded process-group cleanup, safe provider/tool/CLI failures, and explicit `local_guarded` or fail-closed `tools_disabled` composition;
- a macOS 14.4+ native-authority foundation with tested binary framing, Data Protection Keychain, credential-state/journal, exact signed peers, production-gated broker recovery, bounded OpenAI onboarding, fixed sealed-bundle paths, and redacted diagnostics;
- one `npm run check` path covering lint, type checking, tests, and build output.

The standalone CLI can use credential-free OpenAI-compatible servers on literal `127.0.0.1` or `[::1]`, an explicit ephemeral environment BYOK connection to a reviewed Chat-compatible provider, or the pinned official `@agentclientprotocol/codex-acp` adapter with an existing ChatGPT account. Saved connections retain explicit primary selection and immutable historical pins. Environment BYOK overrides saved selection for that process and receives its own credential-bound immutable pin without storing the key. Codex is read-only/Plan-only, local, manual, and user-present: one-shot and unattended runs fail closed. Without any connection the CLI starts a sessionless workspace shell. Test hosts can also inject the public `ModelProvider` interface.

## Quick start

Requirements: Node.js 22.22 or newer, Git 2.45 or newer, and ripgrep.

```bash
npm install
npm run check
npm run build
node packages/cli/dist/main.js --help
node packages/cli/dist/main.js provider list
node packages/cli/dist/main.js provider catalog kimi
node packages/cli/dist/main.js provider detect
node packages/cli/dist/main.js account list
node packages/cli/dist/main.js account verify <connection-id>
node packages/cli/dist/main.js account set-primary <connection-id>
node packages/cli/dist/main.js account disconnect <connection-id>
node packages/cli/dist/main.js doctor native --json
node packages/cli/dist/main.js setup local --url http://127.0.0.1:11434/v1 --model qwen2.5-coder:7b
# Or use a reviewed OpenAI Chat-compatible provider without saving its key:
RECURS_PROVIDER=openrouter-api RECURS_MODEL=<provider/model> RECURS_API_KEY=<key> node packages/cli/dist/main.js
# Or, from a local interactive terminal, connect an existing ChatGPT account:
# node packages/cli/dist/main.js setup codex
# The private native macOS path also supports:
# recurs setup openai [--model <exact-id>]
# recurs setup anthropic --model <exact-id>
# recurs setup kimi --model <exact-id>
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

The engine is first-party. Open-source agents informed its design; their source code was not copied into Recurs. See the [base-engine comparison](docs/BASE_ENGINE_COMPARISON.md) and [sub-agent harness comparison](docs/research/SUBAGENT_HARNESS_COMPARISON.md).

## Trust boundary

Built-in file, search, patch, Git, and checkpoint paths share one case-insensitive credential classification. Direct classified credential paths are permanently denied in every permission preset, and aggregate tools omit them. New checkpoint stores carry a format marker recording the version-2 credential-exclusion contract used for new captures; an ambiguous nonempty legacy store fails closed and requires a manual reset. The marker is an unauthenticated upgrade assertion, not hardened proof about storage contents.

Fixed Git inspection requires Git 2.45 or newer, pins the requested worktree, and disables optional index writes, lazy object fetching, repository hooks, fsmonitor commands, external diff/text conversion, configured clean/smudge/process filters, and expanded dirty-submodule diffs. Patch input uses exact slash-separated declarations, rejects rename/copy operations, denies canonical credential aliases before checkpoint capture, and must match Git's complete parsed path set. Checkpoint capture and undo also reclassify canonical parent and file targets, so a stable safe-looking symlink alias into an auth directory is omitted or refused before a read or restore.

Parallel Explore/Review batches and team implementation start only when the session directory is the canonical root of a clean Git repository at an exact committed `HEAD`. Ignored files are intentionally absent from detached child worktrees. Batch leases are force-cleaned without importing changes. Team Implement workers return bounded, hash-addressed, text-only patch artifacts after credential paths, modes, symlinks, submodules, binary content, renames, size, and complete path sets are validated.

The default version-4 team path applies worker artifacts to a private staging worktree, runs Review and bounded finding-driven Repair there without arbitrary-command or verification tools, and captures one durable cumulative candidate. Only hardened Git inspection may spawn a process; project scripts cannot be executed by these roles. An approved foreground run applies that candidate to the parent behind a durable two-phase checkpoint transaction; an approved background run stops at `ready_to_apply` until explicit `/agents apply <id>` or `apply_team`. Startup recovery reclaims dead owners, settles bound child records, removes owned stale worktrees, and classifies an interrupted parent apply as unchanged, exact-candidate, or ambiguous. Ambiguity requires manual attention and is never overwritten or called approved. Historical version-3 policies replay their original foreground semantics. Worktrees and owner locks separate workspace effects and writers, but they are not an OS sandbox.

All fixed and arbitrary child processes receive a fresh private home, config, cache, and temporary tree plus an allowlisted environment. They do not inherit provider/cloud variables, the real home, `SHELL`, proxy variables, sockets, or workspace-contained `PATH` entries. Process-group cleanup and output-pipe draining are bounded so inherited pipes alone cannot hold Recurs settlement open before synthetic-state cleanup, but preventing an escaped descendant requires the later OS containment boundary. Provider, tool, process, and unexpected CLI failures cross durable/user-visible boundaries through safe typed messages instead of raw causes or stderr.

These are application-level defenses, not an OS security boundary. The default `local_guarded` profile still lets approved arbitrary commands use the user's host filesystem, network, IPC, and process authority. `Full Access` remains unsafe for credentials. The optional `tools_disabled` profile exposes no model-callable tools at all; it is a fail-closed composition option, not a coding sandbox. Persistent provider credentials stay in the signed native authority when that path is used. Cross-platform environment BYOK is deliberately weaker: the selected key enters the Recurs process for that invocation, is kept in a private provider field, never persisted or rendered, and is removed from every tool subprocess environment along with variables containing `KEY`, `SECRET`, `TOKEN`, `PROXY`, or `KEYCHAIN` segments. The official Codex runtime continues to own its existing ChatGPT authentication.

The macOS native-authority foundation includes the launcher-to-engine process boundary. After production-signing validation, the launcher resolves only nonsymlinked `Contents/Resources/runtime/bin/node` and `Contents/Resources/engine/main.js`, spawns that engine in its foreground process group with descriptors `0`–`3` only, and serves bounded health, cancellation, and OpenAI onboarding frames over the anonymous descriptor-3 socket. The public npm/source CLI deletes an injected `RECURS_NATIVE_FD` before loading the application and never writes to it. Unsigned, ad-hoc, and source launchers cannot substitute an engine through `PATH`, cwd, environment, or arguments; the engine path fails with fixed exit `78` and empty output.

The broker is no longer health-only: its production-gated startup derives and validates the exact launcher signing requirement and Keychain configuration, fully recovers one credential authority before listener construction or activation, and then exposes a private launcher-only lifecycle surface with `persistentCredentials: true`. Its schema-v2 journal authenticates one exact provider/profile binding on every record; custom bindings include canonical host, port, base path, and model-catalog behavior. Native component `0.2.0` carries that identity through bounded, non-secret metadata while keeping lifecycle replies redacted. Because this credential state has never shipped, schema-v1 journals are not migrated; development users reset the unpublished native journal and reconnect.

The broker also has internal setup/run/maintenance route authority. It derives every capability from authenticated journal binding and candidate or usable-ready state, rechecks that state across actor suspension, and atomically couples exact scope, expiry, cancellation, and checked budgets to a one-use reservation for the matching Keychain generation. Pre-authorization failures clean up without a debit; a returned reservation is conservatively charged exactly once. The launcher performs foreground TTY capture for OpenAI onboarding; capture restores exact terminal state, cancellation is sticky, transient secret buffers are erased, lifecycle request IDs are independently correlated, and replies remain redacted. One process coordinator owns launcher termination signals and capture suspension handling, and real controlling-PTY tests prove restoration with no input echo across interrupt, termination, hangup, and suspend/resume.

The private native path supports crash-safe OpenAI API, Anthropic API, and Kimi Code activation. It remains the stronger persistent-credential path and is still undistributed pending a signed/notarized artifact. Source/npm builds can now use a separate explicit environment-BYOK path for reviewed OpenAI Chat-compatible HTTPS origins; it neither collects nor persists a key and does not weaken native connection records. Broker-owned generation retains its stricter continuation, reservation, credential-echo, and lifecycle guarantees. The current `local_guarded` tool profile is still not a general OS sandbox.

## Next

1. Produce and verify a signed/notarized installed launcher bundle, including the isolated owner-run broker recovery smoke.
2. Exercise the completed OpenAI, Anthropic, and Kimi Code verticals through installed-artifact security and credential-canary tests.
3. Expand the fixed-origin environment-BYOK path to Responses, Anthropic Messages, and provider-specific model discovery without permitting arbitrary remote URLs.
4. Give any delegated runtime included in the sealed engine its own fixed signed layout; expand delegated runtimes only through documented integrations and provider-specific policy review.
5. Extend team execution only through enforceable OS containment, reviewed role/model candidates, and a separately designed durable worker host; do not mistake process-lifetime background work for a daemon or turn repair into unbounded token burn.

Start with the [documentation index](docs/README.md), [CLI guide](docs/CLI.md), [architecture](ARCHITECTURE.md), [security policy](SECURITY.md), and [product direction](PRODUCT.md).
