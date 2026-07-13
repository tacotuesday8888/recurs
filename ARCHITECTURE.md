# Recurs Architecture

Recurs has one small coding-agent engine and multiple future clients. The terminal is the first client; the planned desktop app will present projects as agent-managed companies without turning Recurs into an IDE.

## Package boundaries

Dependencies point inward:

```text
contracts ◄── providers ◄── app ◄── cli
    ▲             ▲                  ▲
    ├── auth ─────┘                  │
    ├── runtimes ────────────────────┤
    └── tools ◄── core ──────────────┘

native broker ◄──health XPC── native launcher
      │ recovered private credential lifecycle surface (not yet consumed)
                                      │ fixed Node/main.js + anonymous fd 3
                                      ▼
auth ◄──bounded native frames── sealed private engine
public/source CLI ──fixed unavailable port──► shared process host
```

- `@recurs/contracts` owns dependency-free model, connection, billing, backend-pin, trusted-invocation, failure, direct-provider, delegated-runtime, and coordinator contracts.
- `@recurs/providers` owns strict provider manifests, the immutable 25-path catalog, normalized direct-provider streams, safe provider-error mapping, and deterministic fixtures. It has no credential implementation.
- `@recurs/auth` owns the credential-free, bounded client for one injected native duplex. It understands only framed attestation/health messages and fixed safe failures; descriptor parsing and ownership stay in the private engine, and auth has no secret-retrieval operation.
- `@recurs/app` owns the non-secret connection registry, redacted lifecycle and native-authority services, local onboarding, onboarding projection, and Codex onboarding policy. It depends on contracts, providers, and auth, never on the CLI.
- `@recurs/runtimes` owns bounded ACP process/protocol handling and the pinned official Codex ACP profile. It receives opaque continuation-store capabilities and does not import vendor credentials.
- `@recurs/tools` owns tool definitions and execution, permission intents, the unified credential/workspace path policy, command classification, clean child-process setup and bounds, Git inspection, and checkpoint format gates.
- `@recurs/core` owns the direct agent loop, delegated executor, backend-neutral coordinator, trusted preflight handoff, normalized runtime events, process-scoped continuation authority, durable goals, session reduction, JSONL persistence, compaction, and recovery.
- `@recurs/cli` composes app (which assembles auth), providers, runtimes, core, and tools; it owns slash commands, redacted native diagnostics, rendering, interactive input, non-interactive execution, and process exit behavior.
- `packages/native-engine` is the launcher-only entrypoint that claims descriptor 3 before loading the shared process host. Its sealed build substitutes a fixed denial for delegated Codex rather than resolving an ambient runtime.
- `native/macos` contains the headless Swift launcher, exact-peer XPC broker, fixed bundle/child lifecycle, Data Protection Keychain adapter, credential journal/state machine, endpoint policy, and no-secret engine wire protocol. Production broker startup now recovers one authority before activating its private lifecycle/health listener; the launcher-to-engine bridge is health-only, and the launcher does not yet consume the credential lifecycle or perform provider operations. This is native CLI infrastructure, not a desktop interface.

The future desktop app and sub-agent orchestrator should consume these public boundaries rather than reimplementing the loop.

## Turn lifecycle

For one prompt in the coordinated direct-model lane:

1. `BackendRunCoordinator` acquires a cross-process session mutation lease with a monotonic fencing token and exact expected sequence;
2. it resolves trusted invocation context, the immutable pinned backend, and run-bound authorization before persisting the prompt;
3. closes pending tool records and inserts missing interrupted tool results;
4. records the user message and turn start;
5. sends an immutable message/tool snapshot to the selected provider;
6. validates and streams provider events through one reducer;
7. executes normalized tool calls sequentially through permissions and checkpoints;
8. records a terminal tool record plus a model-visible result for every started call;
9. repeats until a final response, cancellation, repeated interaction, failure, or step limit;
10. persists the terminal turn record and updates active-goal progress.

Provider retries are bounded to two attempts and are allowed only before text, reasoning, or a tool call has appeared. Retrying after semantic output could duplicate visible text or work.

## Provider boundary

`ModelProvider.stream()` accepts a model identifier, immutable messages, visible tool definitions, and an abort signal. It returns normalized events:

- text and reasoning deltas;
- complete tool calls;
- token usage;
- exactly one terminal event.

The collector rejects malformed usage, duplicate or empty tool identities, data after completion, oversized output, excessive tool calls, and missing completion. `ScriptedProvider` makes the full engine deterministic in tests.

`BackendRunCoordinator` selects the immutable session pin's direct-model or delegated-runtime lane. Standalone assembly rereads the registry on every operation, finds the exact pinned connection ID, reconstructs its canonical pin, and compares the complete value before creating a provider or runtime. Changing the global primary therefore cannot redirect an old session; changing or disconnecting its record fails preflight. Local pins include a domain-separated digest of the normalized loopback origin. The coordinator also rejects a resolver whose run authorization is bound to a different operation, turn, session, connection, model, policy, billing mode, or invalid request budget. Direct providers are instantiated per run and enter `AgentLoop` through `AgentLoopDirectExecutor`; the authorization's request budget limits model steps. `DelegatedAgentExecutor` separately validates bounded runtime events, approval option IDs, capabilities, continuation provenance, and one terminal result.

The live direct transports are credential-free literal-loopback Ollama/LM Studio plus the injected test/embedding seam. The live delegated transport is the pinned official `@agentclientprotocol/codex-acp` 1.1.2 profile with `@openai/codex` 0.144.0. It enforces Codex `read-only`/Plan mode and local, manual, user-present CLI context. Before every run or reconciliation, assembly rereads the connection and current policy. The runtime verifies structured ChatGPT authentication and the canonical account fingerprint on the exact ACP child that will perform the work, after continuation loading when resuming, and again after session configuration immediately before continuation staging and prompting. One-shot, unattended, recognized CI, remote, scripted, implicit SDK, Act-mode, stale-policy, changed-account, or changed-connection use fails before delegated work continues. In Plan mode, core rejects every opaque runtime approval except a normal read, regardless of the permission preset.

That Codex implementation belongs to the public npm/source CLI. The sealed private engine does not bundle or dynamically resolve the Codex binary/adapter graph; its `@recurs/runtimes` seam returns one fixed `adapter_unavailable` failure. Delegated Codex can enter the sealed host only after the runtime binary and adapter have their own reviewed fixed signed-bundle layout.

Broker-owned catalog paths have a non-permissive future activation requirement: current native attestation, a registered codec and endpoint profile, current policy, and a compatible platform are all required. This phase registers no trusted activation issuer, and the validator rejects even a structurally complete caller-created claim. A manifest boolean or fabricated object therefore cannot make a path runnable; OpenAI, Anthropic, Kimi, and every other broker-owned path remain `requires_native_broker`.

## Tools and permissions

The registry parses tool input, evaluates every permission intent, asks when required, records exact session grants, runs an optional side-effect-free validation preflight, creates checkpoints around mutating tools, and executes the tool. A failed preflight cannot start checkpoint capture. Unknown implementation errors are converted to safe typed tool failures before they can enter events or session storage.

Plan mode removes mutating tools from the provider-visible registry and rejects them if called directly. It is an enforced capability boundary, not a prompt convention.

Permission engines and reusable grants are isolated by session. The three presets are:

- **Ask Always:** normal project reads run; writes and shell commands ask; classified credential paths are denied.
- **Approved for Me:** normal guarded project reads and writes run; all shell, network, sensitive, external, deployment, and destructive actions ask; classified credential paths are denied.
- **Full Access:** routine workspace, shell, network, deployment, and destructive prompts are skipped after explicit confirmation; sensitive and external paths still ask; classified credential paths are denied.

Built-in file, search, patch, Git, and checkpoint operations derive their case-insensitive credential exclusions from one path policy. Direct and canonical classified targets fail before tool execution, and aggregate `rg`/Git operations exclude slash and literal-backslash variants. Checkpoint capture reclassifies canonical parent and regular-file targets before any content read or blob write. This path-based defense does not eliminate adversarial symlink-swap races and does not constrain arbitrary shell scripts.

Fixed Git operations require Git 2.45 or newer, pin the requested worktree, and disable optional index locks, lazy object fetching, repository hooks, fsmonitor, external diff/text conversion, expanded dirty-submodule diffs, and configured clean/smudge/process filters. Filter key names are enumerated through a bounded name-only Git query; their command values never enter Recurs, and command-line empty overrides make the filters pass through without execution. The same prefix protects status, diff, patch parsing/check/application, and checkpoint enumeration. Apply-patch accepts exact slash-separated declarations, rejects path spellings that its policy would transform, rejects rename/copy operations, resolves canonical targets in a pre-checkpoint preflight, and compares Git's NUL-delimited `--numstat` path set with the declared, revision-checked files before mutation. This is application-level configuration preflight, not an OS boundary against another same-user process changing repository state concurrently.

Every fixed or arbitrary child process receives exactly standard descriptors `0`–`2`, a mode-`0700` synthetic home, config, cache, and temporary tree under the canonical root-owned sticky system temporary directory. Its environment contains those paths, a filtered absolute `PATH`, and selected locale/terminal values only; it does not inherit the launcher descriptor, native-authority markers, Keychain/token variables, provider/cloud variables, the real home, `SHELL`, proxy variables, sockets, or workspace-contained `PATH` entries. Shell execution has command-risk classification, timeout, cancellation, process-group termination, output bounds, and a bounded output-pipe drain before parent handles are destroyed and synthetic-state cleanup proceeds. This prevents inherited pipes alone from holding Recurs settlement open; it does not terminate or contain a descendant that deliberately creates another process group or session. Nonzero exits expose the command and exit code, not stderr. Windows subprocess use fails with a typed unsupported-platform error.

The current security profiles are:

- `local_guarded` (default): all registered tools are available subject to Plan mode and permissions. Arbitrary commands still have the user's host filesystem, network, IPC, and process authority.
- `tools_disabled`: no model tool definitions are advertised, and every direct invocation is rejected before parsing, permissions, or checkpoint capture. It is a fail-closed composition option, not a useful coding profile or sandbox.

Neither profile makes this process safe for live credentials. Full Access does not change that boundary.

## Sessions and recovery

New sessions are append-only version-2 JSONL logs. Sequence zero records an immutable backend pin; every later record increments by exactly one and carries turn or operation provenance. Strict validators reject unknown fields, mixed versions, invalid transitions, stale sequences, malformed nested messages/failures, and contradictory terminals. Every append is flushed and synced.

The loop repairs an interrupted protocol boundary before the next request:

- pending `tool_started` records receive `tool_failed` with code `interrupted`;
- assistant tool calls without a tool result receive a synthetic interrupted result.

The mutation lease uses an atomic lock directory, owner-process recovery, and monotonic fence. A concurrent or stale writer fails before provider work. Version-1 logs remain readable and listable but are permanently read-only; continuing them will require the later explicit generic fork flow. Partial trailing records are quarantined, while committed corruption fails loudly.

Delegated turns persist normalized text, usage, changed files, evidence, failure/cancellation, and provenance-bearing continuation updates in the same version-2 log. Vendor session identifiers remain behind bounded process-scoped continuation capabilities and are not written to JSONL. A continuation is staged as uncertain before terminal settlement and committed only with the matching durable terminal. On a later attempt while that process-scoped payload remains available, the coordinator asks the runtime to reconcile the uncertain tip before any new prompt. Core can record a proven committed or gone outcome, but the current ACP implementation conservatively reports an existing resumable vendor session as still uncertain and advances only when the session is proven gone; it never repeats remote work. After process loss the opaque payload is unavailable, so the durable uncertain record blocks unsafe replay rather than promising cross-process vendor-session recovery. The current continuation store is not a persistent broker.

An orphaned compaction start is closed locally as interrupted with unknown usage and is never retried automatically. The agent loop closes incomplete tool boundaries and the previous open turn before beginning another request. Model-call usage is accounted when its durable completion record is replayed, so a later interrupted turn does not erase already incurred usage.

Compaction targets the latest six messages but extends the retained window when necessary so an assistant tool call is never separated from its tool results.

## Checkpoints

Mutating tools capture content-addressed before/after workspace states outside the project. Credential-classified paths are removed before any workspace read or blob write. Fresh stores receive a private version-2 format marker asserting that this exclusion was active from the first capture. A nonempty unversioned store, invalid or symlinked marker, or unknown format fails with `checkpoint_migration_required`; Recurs never blesses, rewrites, or deletes it automatically. Because this is unreleased `0.0.0` data, the supported migration is an explicit user-initiated move of the legacy checkpoint directory so a fresh store can be created.

Undo chooses the newest checkpoint that changed files and verifies the current files still match the agent-produced after-state before restoring anything. Credential-classified canonical parents and targets are conflicts—even when the expected after-state is absent—and are checked again before each restore. Git is used for enumeration only; Recurs does not reset, clean, checkout, or commit the user's repository. The format marker protects upgrade semantics; the Node pathname-based store is not suitable for authentication secrets.

## Native authority boundary before Recurs-owned providers

The implemented macOS foundation contains independently tested pieces of the intended Swift process boundary. Code-identity logic checks exact launcher/broker identifiers, Team ID, production signing class, and Hardened Runtime posture. The Data Protection Keychain adapter uses non-synchronizing, `WhenUnlockedThisDeviceOnly` generic-password items in a broker-private access group. Production broker startup validates the launcher requirement and Keychain configuration, acquires the journal lease, authenticates and recovers the complete credential authority, and only then creates and activates the XPC listener. The recovered configuration advertises `persistentCredentials: true` and exports a private launcher-only lifecycle surface backed by that same recovered actor; health continues to read live Keychain availability without rebuilding the authority. Journal schema v2 authenticates one exact generated profile identity on every record, including canonical custom endpoint and model-catalog fields when present. Native component `0.2.0` passes that identity through bounded private stage metadata and keeps replies redacted. Unreleased schema-v1 journals fail closed and are reset by development users rather than migrated or assigned a synthetic binding.

`@recurs/auth` consumes one injected duplex, performs an exact protocol/component-version and nonce handshake, and bounds framing and in-flight work. The public npm/source CLI deletes `RECURS_NATIVE_FD` before loading the application and writes zero bytes to an injected descriptor. The private entrypoint alone claims the marker. After production-signing validation, the Swift launcher resolves only fixed nonsymlinked Node and `main.js` resources, creates one anonymous socketpair, maps the engine endpoint to descriptor 3, and directly spawns the child with only descriptors `0`–`3` and a reviewed environment. It serves one lazy broker session and keeps one exact-PID reap owner. The child stays in the launcher's foreground process group; an intercepted launcher signal starts a two-second relay grace, followed if needed by channel closure, exact-PID `SIGTERM`, another two-second grace, and exact-PID `SIGKILL`. Source, unsigned, and ad-hoc launchers cannot select an engine through `PATH`, cwd, environment, or argv and fail the engine path with fixed exit `78` and empty output.

The broker now has dormant opaque route capabilities for exact setup/catalog, run/generation, and maintenance/catalog scopes. Issuance derives from one authenticated bound projection and uses reconnect-safe candidate versus usable-ready generation fencing. Authorization rechecks that projection before and after reserving the exact matching Keychain generation, validates the opaque reservation identity, and only then atomically debits cancellation-, expiry-, request-, and byte-bounded authority. Failures before a route reservation is returned clean up without a debit; a returned one-use reservation is conservatively charged once, and starting it never charges again. A broker-only built-in OpenAI model-catalog transport can consume that exact reservation for one hardened `GET /v1/models`; it filters credential echoes across headers and body chunks, bounds and validates the catalog, rejects redirects and alternate authentication, uses macOS system proxy and root policy, and never retries after request start. The service configuration, XPC gateway, and executable do not instantiate or invoke this transport yet, and there is no generation or custom-endpoint transport. The launcher library also has a private lifecycle client with its own monotonic request IDs and exact reply correlation. Its stage call accepts an owned native secret, makes one explicit transient `Data` copy for XPC, erases both owned buffers on every outcome, and returns a redacted projection. A separate internal foreground-TTY primitive provides bounded no-echo capture, sticky cancellation, exact termios restoration, and byte erasure. Real controlling-PTY tests now prove restoration across interrupt, termination, hangup, and suspend/resume under the launcher's signal coordinator; capture remains unreachable from the executable until provider onboarding is assembled.

This milestone is still a component foundation, not direct-provider activation or an installed authority. No signed/notarized bundle or successful production broker smoke is produced here; source/npm and ad-hoc builds cannot pass the production gates, and a directly injected peer's self-attestation remains downgraded to `peer_identity_unverified`. The launcher-to-engine schema remains limited to `hello`, `health`, and `cancel`, with no credential, endpoint, header, arbitrary RPC, or secret-retrieval field. The executable has no provider setup route and does not invoke the internal capture/lifecycle or OpenAI catalog seams. Provider-verified staging, production gateway wiring, DNS/network feasibility beyond the fixed system-trusted OpenAI request, generation HTTP/stream codecs, direct-provider CLI assembly, and installed-artifact canary evidence remain future work, so every direct broker-owned manifest stays disabled. The owner-run signed smoke needs an ephemeral macOS user and a dedicated production test access group because `HOME` cannot safely redirect the live journal root or Keychain configuration. The bundle builder is configured to retain legal comments, but release packaging still needs a complete third-party notices and license review.

The TypeScript tool defenses remain application-level. `local_guarded` is not a general OS sandbox, and an approved arbitrary command can still inspect host resources available to the user. The reviewed direct-provider design permits activation only if installed-artifact tests prove the narrower fact that credentials and reusable request authority stay exclusively inside the hardened broker and cannot be inherited or reused by tool children. If that cannot be proven, direct providers remain disabled and a broader OS sandbox is again a release prerequisite. Rewriting the agent loop, session engine, or CLI wholesale in Rust is not required for this boundary.

The public npm/source Codex path does not weaken that gate: Recurs launches the pinned official adapter, delegates any advertised `chat-gpt` login flow to it, and stores only non-secret linkage, verified account label/fingerprint, policy/billing acknowledgement, and model metadata. Recurs never reads `auth.json`, browser cookies, copied tokens, or credential values. The adapter/runtime remains vendor-authenticated, and the current path is deliberately Plan-only and foreground-only. The sealed private engine denies this delegated path until it can ship without ambient runtime resolution.

## Verification and extension order

`npm run check` is the repository gate: lint, strict TypeScript, all tests, and build. GitHub Actions runs the same command.

Without an explicit primary, the CLI remains in a `WorkspaceShellState` and creates no durable session even when secondary records exist. A configured credential-free OpenAI-compatible server is accepted only at literal HTTP loopback, is verified through `/models`, and is pinned to an exact connection/model/origin before a session is created. A Codex connection is established only through interactive billing acknowledgement, structured ChatGPT authentication/status checks, a read-only capability probe, and non-secret registry commit. The first record in an empty registry becomes primary; later records never replace it implicitly. Exact-ID account commands list, verify, select, and disconnect records through bounded atomic registry mutations. Verification is read-only. Disconnection removes Recurs metadata only and clears a removed primary rather than promoting another record. Public results omit account labels, fingerprints, endpoints, and credentials. Empty-argument REPL startup requires a user-present local TTY and rejects recognized automation even when it has a TTY; supported noninteractive direct-model work uses the explicit `recurs run` command. Noninteractive prompts without a connection—and all noninteractive Codex prompts—fail before provider work. Provider, tool, process, and unexpected CLI failures cross user-visible or durable boundaries through allowlisted messages; unknown CLI faults receive a diagnostic UUID rather than raw error text.

The remaining extension order is deliberate:

1. produce and verify the signed/notarized installed bundle, including the isolated production broker recovery smoke;
2. connect TTY secret capture, provider-verified staging, and the broker-only OpenAI catalog transport to the production gateway, then add generation request/stream codecs and CLI onboarding over the fenced route authority;
3. obtain signed installed-artifact and credential-canary proof, followed by reviewed direct API and coding-plan activations;
4. add official delegated runtimes to the sealed host only with fixed signed layouts plus provider-specific capability and policy proof;
5. build the sub-agent/company coordinator, isolated workspaces, handoffs, and budgets;
6. add desktop, plugins/MCP, and distribution.

See [the engine comparison](docs/BASE_ENGINE_COMPARISON.md), [the Core v0 design](docs/superpowers/specs/2026-07-10-recurs-core-v0-design.md), and [the provider design](docs/superpowers/specs/2026-07-10-recurs-provider-auth-design.md).
