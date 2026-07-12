# Recurs Architecture

Recurs has one small coding-agent engine and multiple future clients. The terminal is the first client; the planned desktop app will present projects as agent-managed companies without turning Recurs into an IDE.

## Package boundaries

Dependencies point inward:

```text
contracts ◄── providers ◄── app
    ▲             ▲          ▲
    ├── runtimes  │          │
    ├── tools ◄── core       │
    └─────────────┴────────── cli
```

- `@recurs/contracts` owns dependency-free model, connection, billing, backend-pin, trusted-invocation, failure, direct-provider, delegated-runtime, and coordinator contracts.
- `@recurs/providers` owns strict provider manifests, the immutable 25-path catalog, normalized direct-provider streams, safe provider-error mapping, and deterministic fixtures. It has no credential implementation.
- `@recurs/app` owns the non-secret connection registry, redacted lifecycle service, local onboarding, onboarding projection, and Codex onboarding policy. It depends on contracts and providers, never on the CLI.
- `@recurs/runtimes` owns bounded ACP process/protocol handling and the pinned official Codex ACP profile. It receives opaque continuation-store capabilities and does not import vendor credentials.
- `@recurs/tools` owns tool definitions and execution, permission intents, the unified credential/workspace path policy, command classification, clean child-process setup and bounds, Git inspection, and checkpoint format gates.
- `@recurs/core` owns the direct agent loop, delegated executor, backend-neutral coordinator, trusted preflight handoff, normalized runtime events, process-scoped continuation authority, durable goals, session reduction, JSONL persistence, compaction, and recovery.
- `@recurs/cli` composes app, providers, runtimes, core, and tools; it owns slash commands, rendering, interactive input, non-interactive execution, and process exit behavior.

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

## Tools and permissions

The registry parses tool input, evaluates every permission intent, asks when required, records exact session grants, runs an optional side-effect-free validation preflight, creates checkpoints around mutating tools, and executes the tool. A failed preflight cannot start checkpoint capture. Unknown implementation errors are converted to safe typed tool failures before they can enter events or session storage.

Plan mode removes mutating tools from the provider-visible registry and rejects them if called directly. It is an enforced capability boundary, not a prompt convention.

Permission engines and reusable grants are isolated by session. The three presets are:

- **Ask Always:** normal project reads run; writes and shell commands ask; classified credential paths are denied.
- **Approved for Me:** normal guarded project reads and writes run; all shell, network, sensitive, external, deployment, and destructive actions ask; classified credential paths are denied.
- **Full Access:** routine workspace, shell, network, deployment, and destructive prompts are skipped after explicit confirmation; sensitive and external paths still ask; classified credential paths are denied.

Built-in file, search, patch, Git, and checkpoint operations derive their case-insensitive credential exclusions from one path policy. Direct and canonical classified targets fail before tool execution, and aggregate `rg`/Git operations exclude slash and literal-backslash variants. Checkpoint capture reclassifies canonical parent and regular-file targets before any content read or blob write. This path-based defense does not eliminate adversarial symlink-swap races and does not constrain arbitrary shell scripts.

Fixed Git operations require Git 2.45 or newer, pin the requested worktree, and disable optional index locks, lazy object fetching, repository hooks, fsmonitor, external diff/text conversion, expanded dirty-submodule diffs, and configured clean/smudge/process filters. Filter key names are enumerated through a bounded name-only Git query; their command values never enter Recurs, and command-line empty overrides make the filters pass through without execution. The same prefix protects status, diff, patch parsing/check/application, and checkpoint enumeration. Apply-patch accepts exact slash-separated declarations, rejects path spellings that its policy would transform, rejects rename/copy operations, resolves canonical targets in a pre-checkpoint preflight, and compares Git's NUL-delimited `--numstat` path set with the declared, revision-checked files before mutation. This is application-level configuration preflight, not an OS boundary against another same-user process changing repository state concurrently.

Every fixed or arbitrary child process receives a mode-`0700` synthetic home, config, cache, and temporary tree under the canonical root-owned sticky system temporary directory. Its environment contains those paths, a filtered absolute `PATH`, and selected locale/terminal values only; it does not inherit provider/cloud variables, the real home, `SHELL`, proxy variables, sockets, or workspace-contained `PATH` entries. Shell execution has command-risk classification, timeout, cancellation, process-group termination, output bounds, and a bounded output-pipe drain before parent handles are destroyed and synthetic-state cleanup proceeds. This prevents inherited pipes alone from holding Recurs settlement open; it does not terminate or contain a descendant that deliberately creates another process group or session. Nonzero exits expose the command and exit code, not stderr. Windows subprocess use fails with a typed unsupported-platform error.

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

## Native authority boundary before Recurs-owned credentials

The TypeScript safety precursor closes several direct leak paths, but package boundaries, pathname validation, environment cleanup, and opaque TypeScript types are not hardened storage or an OS sandbox. An approved arbitrary command can still inspect any host resource available to the Recurs user, including Recurs data or vendor auth state through paths, IPC, networking, or process inspection.

Before a direct API, coding-plan, OAuth, or cloud-identity credential enters the Recurs TypeScript process, a separately reviewed native broker/storage boundary must provide:

- descriptor-relative, no-follow filesystem operations rather than check-then-open pathnames;
- owner, mode, ACL, and full-parent-chain validation;
- filesystem capability checks for required atomic and no-follow semantics;
- a broker or OS service that never exports long-lived credentials to the TypeScript harness; and
- an OS sandbox that denies tool processes access to Recurs storage, vendor authentication state, broker IPC, unrelated processes, and non-approved network destinations.

A small Rust or platform-native component is an appropriate implementation for this narrow authority boundary. Rewriting the agent loop, session engine, or CLI wholesale in Rust would not create those guarantees and is not required. `@recurs/auth` must not be added until its public capability is backed by this real boundary.

The existing Codex path does not weaken that gate: Recurs launches the pinned official adapter, delegates any advertised `chat-gpt` login flow to it, and stores only non-secret linkage, verified account label/fingerprint, policy/billing acknowledgement, and model metadata. Recurs never reads `auth.json`, browser cookies, copied tokens, or credential values. The adapter/runtime remains vendor-authenticated, and the current path is deliberately Plan-only and foreground-only.

## Verification and extension order

`npm run check` is the repository gate: lint, strict TypeScript, all tests, and build. GitHub Actions runs the same command.

Without an explicit primary, the CLI remains in a `WorkspaceShellState` and creates no durable session even when secondary records exist. A configured credential-free OpenAI-compatible server is accepted only at literal HTTP loopback, is verified through `/models`, and is pinned to an exact connection/model/origin before a session is created. A Codex connection is established only through interactive billing acknowledgement, structured ChatGPT authentication/status checks, a read-only capability probe, and non-secret registry commit. The first record in an empty registry becomes primary; later records never replace it implicitly. Exact-ID account commands list, verify, select, and disconnect records through bounded atomic registry mutations. Verification is read-only. Disconnection removes Recurs metadata only and clears a removed primary rather than promoting another record. Public results omit account labels, fingerprints, endpoints, and credentials. Empty-argument REPL startup requires a user-present local TTY and rejects recognized automation even when it has a TTY; supported noninteractive direct-model work uses the explicit `recurs run` command. Noninteractive prompts without a connection—and all noninteractive Codex prompts—fail before provider work. Provider, tool, process, and unexpected CLI failures cross user-visible or durable boundaries through allowlisted messages; unknown CLI faults receive a diagnostic UUID rather than raw error text.

The remaining extension order is deliberate:

1. the native broker/storage authority, origin-bound transport, and enforceable OS tool sandbox required for Recurs-owned credentials;
2. direct API, coding-plan, OAuth, and cloud-identity activations over that authority;
3. additional official delegated runtimes with provider-specific capability and policy proof;
4. the sub-agent/company coordinator, isolated workspaces, handoffs, and budgets;
5. desktop, plugins/MCP, and distribution.

See [the engine comparison](docs/BASE_ENGINE_COMPARISON.md), [the Core v0 design](docs/superpowers/specs/2026-07-10-recurs-core-v0-design.md), and [the provider design](docs/superpowers/specs/2026-07-10-recurs-provider-auth-design.md).
