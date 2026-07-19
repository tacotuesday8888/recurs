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
- versioned protocol-level harness profiles that give native-tool and compatibility models different, stable tool-use instructions without baking model brands into policy; native v2 may request up to four independent reads together, while compatibility v1 remains sequential;
- credential-free OpenAI-compatible local model setup for literal-loopback Ollama and LM Studio servers;
- cross-platform saved and ephemeral BYOK for reviewed fixed-origin OpenAI Chat-compatible and Anthropic Messages providers; saved setup retains only provider/model policy metadata, an environment-variable name, and a credential fingerprint, while key values are never persisted or forwarded to tools;
- private signed-macOS activation paths for OpenAI API, Anthropic API, and Kimi Code credentials, with native model discovery and streamed tool calling;
- a validated 25-path provider/authentication catalog, a revisioned non-secret connection registry, and exact-ID account listing, verification, primary selection, and metadata-only disconnection;
- a bounded `models.dev` discovery catalog, fixed-origin credential-visible Anthropic model discovery, fixed-port loopback detection for Ollama and LM Studio, and one `/provider` surface shared with first-run onboarding;
- an official Codex ACP path for an existing ChatGPT login, constrained to local, interactive, user-present, Plan-only work;
- eight tools for file reading, listing, search, patching, bounded shell execution, shell-free allowlisted verification, Git status, and Git diff; independent built-in reads can run in bounded parallel groups, while mutations, approvals, MCP, delegation, and commands remain ordered barriers; each child profile receives an exact host-tool and intent ceiling;
- Ask Always, Approved for Me, Full Access, enforced Plan mode, and a read-only Review profile;
- durable `/goal` state, append-only JSONL sessions, interrupted-tool recovery, compaction, checkpoints, and conflict-safe undo;
- interactive and non-interactive CLI paths with text or normalized JSONL output, including explicit fresh-session permission pinning for headless runs;
- a Recurs-owned ACP v1 stdio agent endpoint for editor and agent-client integration, with isolated sessions, streamed model/tool/child/team activity, one-shot permission forwarding, cancellation, and honest capability negotiation;
- bounded Agent Skills discovery and progressive activation for user-installed `~/.agents/skills` and `$RECURS_HOME/skills`, plus explicitly trusted project `.agents/skills` and `.recurs/skills`;
- a bounded stdio MCP client for private user-owned `$RECURS_HOME/config/mcp-servers.json` configuration, with progressive tool discovery, ordinary shell/network approvals, sanitized process environments, full process-group cleanup, and no implicit project trust;
- immutable backend pins, strict version-2 session records, cross-process mutation leases, typed preflight failures, and durable delegated-runtime results and recovery;
- one credential-path policy enforced across direct and aggregate built-in tools, permanent denial of classified credential intents, and checkpoint capture that excludes those paths;
- clean per-child environments, bounded process-group cleanup, safe provider/tool/CLI failures, and explicit `workspace_sandboxed`, `local_guarded`, or fail-closed `tools_disabled` composition;
- a macOS 14.4+ native-authority foundation with tested binary framing, Data Protection Keychain, credential-state/journal, exact signed peers, production-gated broker recovery, bounded OpenAI onboarding, fixed sealed-bundle paths, and redacted diagnostics;
- one `npm run check` path covering lint, type checking, tests, build output, and the exact npm package manifest; CI also installs the packed artifact into an empty prefix and runs its `recurs` binary.

The standalone CLI can use credential-free OpenAI-compatible servers on literal `127.0.0.1` or `[::1]`, saved or ephemeral environment BYOK for a reviewed Chat-compatible or Anthropic Messages provider, or the pinned official `@agentclientprotocol/codex-acp` adapter with an existing ChatGPT account. Saved connections retain explicit primary selection and immutable historical pins. A complete `RECURS_PROVIDER`/`RECURS_MODEL`/`RECURS_API_KEY` selection overrides saved selection for that process. Codex is read-only/Plan-only, local, manual, and user-present: one-shot and unattended runs fail closed. Without any connection, an interactive launch offers one guided provider, exact-model, and permission flow; skipping it keeps the honest sessionless workspace shell. Test hosts can also inject the public `ModelProvider` interface.

## Quick start

Requirements: Node.js 22.22 or newer, Git 2.45 or newer, and ripgrep. Linux
also requires the distribution `bubblewrap` package at `/usr/bin/bwrap` with
unprivileged user namespaces enabled. On AppArmor-restricted Ubuntu systems,
the distribution `bwrap-userns-restrict` profile must also permit Bubblewrap's
namespace setup. Recurs fails closed if the host blocks that boundary; see
[Ubuntu bug 2141298](https://bugs.launchpad.net/bugs/2141298) for the current
Ubuntu 24.04 profile/kernel regression and distribution workaround.

```bash
npm install
npm run check
npm run build
npm link
recurs --help
recurs setup
node packages/cli/dist/main.js --help
# Recommended first run: connect a reviewed path, select a model and permission
# preset, then enter a fresh durable Recurs session.
node packages/cli/dist/main.js setup
node packages/cli/dist/main.js provider list
node packages/cli/dist/main.js provider catalog kimi
node packages/cli/dist/main.js provider detect
node packages/cli/dist/main.js account list
node packages/cli/dist/main.js account verify <connection-id>
node packages/cli/dist/main.js account set-primary <connection-id>
node packages/cli/dist/main.js account disconnect <connection-id>
node packages/cli/dist/main.js doctor native --json
node packages/cli/dist/main.js acp
node packages/cli/dist/main.js setup local --url http://127.0.0.1:11434/v1 --model qwen2.5-coder:7b
# Or save a reviewed public provider/model binding without saving its key:
export OPENROUTER_API_KEY=<key>
node packages/cli/dist/main.js setup byok --provider openrouter-api --model <provider/model> --key-env OPENROUTER_API_KEY
# Anthropic Messages is also available without persisting its key:
export ANTHROPIC_API_KEY=<key>
node packages/cli/dist/main.js provider models --provider anthropic-api --key-env ANTHROPIC_API_KEY
node packages/cli/dist/main.js setup byok --provider anthropic-api --model <exact-model-id> --key-env ANTHROPIC_API_KEY
# Or use a reviewed provider for one process without saving its key:
RECURS_PROVIDER=openrouter-api RECURS_MODEL=<provider/model> RECURS_API_KEY=<key> node packages/cli/dist/main.js
# Or, from a local interactive terminal, connect an existing ChatGPT account:
# node packages/cli/dist/main.js setup codex
# The private native macOS path also supports:
# recurs setup openai [--model <exact-id>]
# recurs setup anthropic --model <exact-id>
# recurs setup kimi --model <exact-id>
# A plain interactive launch offers the same guide when no model is configured.
node packages/cli/dist/main.js
```

After building, `npm link` exposes the local `recurs` command. It can be removed
with `npm unlink --global recurs`.

This is currently the only installation path. The root build also produces a self-contained Recurs-code bundle at `dist/cli/main.js`; `npm run package:check` proves the tarball contains only that executable, `package.json`, `README.md`, `SECURITY.md`, and `THIRD_PARTY_NOTICES.md`. After a build, `npm run package:smoke-install` packs and installs the artifact into an empty temporary prefix, configures a deterministic loopback model, and proves the installed agent can run a sandboxed command, deny an outside-workspace write, read the workspace result, and return it to the model. Runtime packages remain exact dependencies rather than copied third-party source.

The package is deliberately `private` and declares `UNLICENSED`, so npm publication remains blocked until the owner selects a license, chooses a real preview version, and makes the source repository public. Reviewed direct-runtime dependency notices now ship in `THIRD_PARTY_NOTICES.md`. A manual, protected-environment GitHub workflow is prepared for npm trusted publishing with OIDC and provenance, but its preflight refuses the placeholder version, missing project license, private source repository, non-public package metadata, wrong repository/workflow/tag, or a long-lived npm token. Nothing is published today. Bun may later install the npm artifact while Node remains the supported runtime; Bun runtime support is not implemented. Homebrew and curl installers wait for versioned release artifacts.

## Packages

```text
packages/contracts   Dependency-leaf model, connection, backend, failure, and runtime contracts
packages/auth        Credential-free bounded client for an inherited native socket
packages/providers   Validated provider manifests, protocol metadata, and direct-provider implementations
packages/app         Non-secret connection registry, lifecycle service, onboarding, and policy
packages/runtimes    Bounded ACP transport and the pinned official Codex runtime profile
packages/tools       Tool registry, permissions, path policy, Git, and checkpoints
packages/core        Direct/delegated execution, events, sessions, goals, compaction, and recovery
packages/cli         Runtime assembly, slash commands, renderers, REPL, ACP server, and executable
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

All fixed and arbitrary child processes receive a fresh private home, config, cache, and temporary tree plus an allowlisted environment. They do not inherit provider/cloud variables, the real home, `SHELL`, proxy variables, sockets, or workspace-contained `PATH` entries. Process-group cleanup and output-pipe draining are bounded so inherited pipes alone cannot hold Recurs settlement open before synthetic-state cleanup. The default macOS and Linux workspace profiles add OS containment for arbitrary shell and verification children; an embedding that explicitly selects `local_guarded` retains only the application-level cleanup boundary. Provider, tool, process, and unexpected CLI failures cross durable/user-visible boundaries through safe typed messages instead of raw causes or stderr.

User-configured stdio MCP servers use that same process boundary. Recurs reads only a private, owned, single-link configuration under its data directory; server commands are absolute paths, arguments are literal, no shell or configured environment injection is accepted, and host credentials are removed. Every list or call creates one bounded server process, performs the standard MCP initialize handshake, and closes the complete process group. Server descriptions, schemas, annotations, and results remain untrusted data and never grant permissions. Project MCP files, server installation, persistent daemons, remote transports/OAuth, prompts/resources, and child/team MCP access are not implemented.

On macOS and Linux, the standalone CLI now defaults shell and verification subprocesses to the `workspace_sandboxed` profile. Apple Seatbelt and a fixed system-Bubblewrap policy permit host writes only in the canonical workspace and a private per-process tree, hide common host credential/runtime locations, and deny network unless the command's approved intents include network access. Linux keeps the remaining host filesystem read-only so user-installed toolchains still work, hides host temporary/runtime state, and uses fresh user, PID, IPC, UTS, mount, and deny-network namespaces; it refuses a workspace that contains the host home or sits inside a host credential directory, and it does not yet add a Recurs seccomp filter. Sandbox setup fails closed, including when `/usr/bin/bwrap` or unprivileged user namespaces are unavailable. Windows still selects `local_guarded`, so subprocess tools remain unsupported there; an embedding can explicitly select the same guarded host-authority profile on macOS/Linux. The optional `tools_disabled` profile exposes no model-callable tools at all. Persistent provider credentials stay in the signed native authority when that path is used. Cross-platform environment BYOK is deliberately weaker: the selected key enters the Recurs process, is kept in a private provider field, never persisted or rendered, and is removed from every tool subprocess environment along with variables containing `KEY`, `SECRET`, `TOKEN`, `PROXY`, or `KEYCHAIN` segments. Saved BYOK records contain the environment-variable name and a one-way provider-bound fingerprint so a later process can require the same credential without storing it. The official Codex runtime continues to own its existing ChatGPT authentication.

The macOS native-authority foundation includes the launcher-to-engine process boundary. After production-signing validation, the launcher resolves only nonsymlinked `Contents/Resources/runtime/bin/node` and `Contents/Resources/engine/main.js`, spawns that engine in its foreground process group with descriptors `0`–`3` only, and serves bounded health, cancellation, and OpenAI onboarding frames over the anonymous descriptor-3 socket. The public npm/source CLI deletes an injected `RECURS_NATIVE_FD` before loading the application and never writes to it. Unsigned, ad-hoc, and source launchers cannot substitute an engine through `PATH`, cwd, environment, or arguments; the engine path fails with fixed exit `78` and empty output.

The broker is no longer health-only: its production-gated startup derives and validates the exact launcher signing requirement and Keychain configuration, fully recovers one credential authority before listener construction or activation, and then exposes a private launcher-only lifecycle surface with `persistentCredentials: true`. Its schema-v2 journal authenticates one exact provider/profile binding on every record; custom bindings include canonical host, port, base path, and model-catalog behavior. Native component `0.2.0` carries that identity through bounded, non-secret metadata while keeping lifecycle replies redacted. Because this credential state has never shipped, schema-v1 journals are not migrated; development users reset the unpublished native journal and reconnect.

The broker also has internal setup/run/maintenance route authority. It derives every capability from authenticated journal binding and candidate or usable-ready state, rechecks that state across actor suspension, and atomically couples exact scope, expiry, cancellation, and checked budgets to a one-use reservation for the matching Keychain generation. Pre-authorization failures clean up without a debit; a returned reservation is conservatively charged exactly once. The launcher performs foreground TTY capture for OpenAI onboarding; capture restores exact terminal state, cancellation is sticky, transient secret buffers are erased, lifecycle request IDs are independently correlated, and replies remain redacted. One process coordinator owns launcher termination signals and capture suspension handling, and real controlling-PTY tests prove restoration with no input echo across interrupt, termination, hangup, and suspend/resume.

The private native path supports crash-safe OpenAI API, Anthropic API, and Kimi Code activation. It remains the stronger persistent-credential path and is still undistributed pending a signed/notarized artifact. Source/npm builds can now use a separate explicit environment-BYOK path for reviewed fixed-origin OpenAI Chat-compatible and Anthropic Messages providers; it neither collects nor persists a key and does not weaken native connection records. Anthropic setup and `provider models` authenticate against the fixed `/v1/models` endpoint, expose only credential-visible model metadata, and require the selected exact model before saving. The public Anthropic transport uses the required versioned headers, strict bounded tool/SSE decoding, normalized usage, redirect denial, and split-chunk credential-echo detection. Broker-owned generation retains its stricter reservation, custody, continuation, and lifecycle guarantees. The macOS/Linux command sandboxes are defense in depth for tool subprocesses; neither replaces the native credential authority, and Windows containment remains absent.

## Next

1. Produce and verify a signed/notarized installed launcher bundle, including the isolated owner-run broker recovery smoke.
2. Exercise the completed OpenAI, Anthropic, and Kimi Code verticals through installed-artifact security and credential-canary tests.
3. Expand the fixed-origin environment-BYOK path to OpenAI Responses and additional reviewed providers' authenticated model discovery without permitting arbitrary remote URLs.
4. Extend MCP only through separately reviewed persistent-session health, authenticated Streamable HTTP, project trust, and versioned child-profile slices; stdio v1 does not imply those authorities.
5. Give any delegated runtime included in the sealed engine its own fixed signed layout; expand delegated runtimes only through documented integrations and provider-specific policy review.
6. Extend team execution only through enforceable OS containment, reviewed role/model candidates, and a separately designed durable worker host; do not mistake process-lifetime background work for a daemon or turn repair into unbounded token burn.

Start with the [documentation index](docs/README.md), [CLI guide](docs/CLI.md), [architecture](ARCHITECTURE.md), [security policy](SECURITY.md), and [product direction](PRODUCT.md).
