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

native broker ◄──private XPC── native launcher
      │ Keychain, lifecycle, catalog, and generation authority
                                      │ fixed Node/main.js + anonymous fd 3
                                      ▼
auth ◄──bounded native frames── sealed private engine
public/source CLI ──fixed unavailable port──► shared process host
```

- `@recurs/contracts` owns dependency-free model, connection, billing, backend-pin, trusted-invocation, failure, direct-provider, delegated-runtime, coordinator, agent-profile, operating-mode, and parent/child state contracts.
- `@recurs/providers` owns strict provider manifests, the immutable 25-path catalog, normalized direct-provider streams, safe provider-error mapping, and deterministic fixtures. It has no credential implementation.
- `@recurs/auth` owns the credential-free, bounded client and strict redacted onboarding/generation codecs for one injected native duplex. Descriptor parsing and ownership stay in the private engine, and auth has no credential or secret-retrieval operation.
- `@recurs/app` owns the non-secret connection registry, redacted lifecycle and native-authority services, local onboarding, onboarding projection, and Codex onboarding policy. It depends on contracts, providers, and auth, never on the CLI.
- `@recurs/runtimes` owns bounded ACP process/protocol handling and the pinned official Codex ACP profile. It receives opaque continuation-store capabilities and does not import vendor credentials.
- `@recurs/tools` owns tool definitions and execution, permission intents, the unified credential/workspace path policy, command classification, clean one-shot and managed child-process setup and bounds, Git inspection, and checkpoint format gates.
- `@recurs/core` owns the direct agent loop, delegated executor, backend-neutral coordinator, owned child manager, bounded batch and team coordinators, durable team-run journal/supervisor/recovery, provider-neutral role routing, cross-process run ownership, durable patch artifacts, activity projection, Git worktree leases, adaptive Review panels, shared delegation budgets, normalized runtime/agent events, trusted preflight handoff, process-scoped continuation authority, durable goals, session reduction, JSONL persistence, compaction, and recovery.
- `@recurs/cli` composes app (which assembles auth), providers, runtimes, core, and tools; it owns slash commands, operating-mode selection, agent activity rendering, redacted native diagnostics, interactive input, non-interactive execution, the Recurs-owned ACP stdio server, the bounded user-configured MCP stdio client, and process exit behavior.
- `packages/native-engine` is the launcher-only entrypoint that claims descriptor 3 before loading the shared process host. Its sealed build substitutes a fixed denial for delegated Codex rather than resolving an ambient runtime.
- `native/macos` contains the headless Swift launcher, exact-peer XPC broker, fixed bundle/child lifecycle, foreground secret capture, Data Protection Keychain adapter, credential journal/state machine, endpoint policy, model catalogs, and broker-owned OpenAI/Anthropic/Kimi generation. This is native CLI infrastructure, not a desktop interface.

The implemented child and durable-team orchestrators consume these boundaries rather than reimplementing the loop. The future desktop app and company runtime must do the same.

## Turn lifecycle

For one prompt in the coordinated direct-model lane:

1. `BackendRunCoordinator` acquires a cross-process session mutation lease with a monotonic fencing token and exact expected sequence;
2. it resolves trusted invocation context, the immutable pinned backend, and run-bound authorization before persisting the prompt;
3. closes pending tool records and inserts missing interrupted tool results;
4. records the user message and turn start;
5. loads a bounded root-to-cwd project-instruction snapshot once for the turn;
6. sends that immutable context/message/tool snapshot to the selected provider;
7. validates and streams provider events through one reducer;
8. executes normalized tool calls sequentially through permissions and checkpoints;
9. records a terminal tool record plus a model-visible result for every started call;
10. repeats until a final response, cancellation, repeated interaction, failure, or step limit;
11. persists the terminal turn record and updates active-goal progress.

Provider retries are bounded to two attempts and are allowed only before text, reasoning, or a tool call has appeared. Retrying after semantic output could duplicate visible text or work.

## Owned child orchestration

`delegate_task` creates one durable Explore, Implement, or Review child session through `BackendRunCoordinator`. `delegate_tasks` schedules independent Explore/Review children through that same path. `delegate_team` composes isolated Implement, Review, and Repair children without creating another model loop. Child permissions can only narrow the parent, depth is one, retries are zero, and every operating mode caps total and concurrent work. Immutable version-1 through version-4 IDs retain their historical behavior; display-name selection uses the version-5 routed-team policy.

Batch preflight requires the parent cwd to be the canonical root of a clean Git repository. `GitWorktreeLeaseManager` creates a detached worktree at exact `HEAD` under the private project-data root, outside the repository. Each child session stores its lease and revision, results settle in input order, linked cancellation stops active work, and every lease is cleaned before settlement. Explore/Review batches intentionally discard workspace effects while retaining successful sibling evidence after ordinary partial failure.

For a version-4-or-newer team workflow, all Implement workers must succeed before staging begins. `GitPatchArtifactManager` captures each lease against the same revision, accepts at most 256 unambiguous non-credential paths and 1 MiB of text patch data per artifact, and rejects binaries, symlinks, submodules, mode changes, renames/copies, and tampered or foreign handles. Recurs applies artifacts sequentially in declared task order to a dedicated private staging worktree, never directly to the parent. `implement_v2`, `review_v2`, and `repair_v1` deliberately expose no arbitrary-command or verification tool; only hardened Git inspection may spawn a process, and project scripts cannot be executed. Strict Review JSON produces `approved`, `changes_requested`, or `unverified`; only valid structured findings can start a new depth-one Repair sibling, and the frozen policy bounds the number of repair rounds.

`JsonlTeamRunStore` is authoritative for the descriptor, frozen policy/routes, lifecycle, child reservations and results, artifact links, review/repair rounds, cancellation, accounting, and outcome. The journal uses strict records, monotonic sequences, private files, fsynced appends, and cross-process append fencing. `TeamRunOwnerLeaseManager` separately admits one live owner per parent and run, reclaims a dead owner, and fences stale in-process writers. A parent may have only one unresolved durable team run.

Foreground and background use the same `TeamRunSupervisor`. Foreground waits for an approved candidate and applies it before returning. `execution: "background"` returns after durable ownership is established, continues only for the lifetime of that Recurs process, and stops an approved run at `ready_to_apply`. Recurs releases the staging worktree before publishing that boundary and best-effort discards intermediate artifacts; bounded wait and apply confirm the cross-process owner handoff before treating ready as actionable. Status, bounded wait, cancellation, safe resume, and explicit apply are exposed through model tools and `/agents`. Background start and resume require a local, manual, user-present Act session, an eligible backend, and Full Access; explicit apply requires Full Access or one explicit elevated write approval. These are lifecycle controls, not a daemon.

Parent apply is a two-phase transaction. Recurs verifies the frozen parent/backend/policy/base/candidate binding, captures a durable checkpoint, records `apply_prepared`, applies the cumulative artifact, validates the complete dirty path set, completes the checkpoint, and records `apply_committed`. Startup recovery settles exact bound child sessions, cleans owned stale worktrees, and reconciles an interrupted apply: a clean unchanged base returns to `ready_to_apply`, an exact candidate diff completes idempotently, and any other workspace state becomes `interrupted` with manual attention required. It never resets or overwrites an ambiguous parent.

Interrupted version-4-or-newer background runs support safe resume from an interrupted boundary; resume creates fresh depth-one siblings and preserves prior attempts. These runs also support bounded finding-driven repair. Recursive delegation, automatic task decomposition, retrying a terminal child, dirty-parent snapshots, auto-commit, push/deploy, a persistent worker daemon, and automatic backend ranking remain absent. `/agents activity` projects child lifecycle from durable session state, while `/agents teams` and `/agents team <id>` project safe run state from the team journal.

## Provider boundary

`ModelProvider.stream()` accepts a model identifier, immutable messages, visible tool definitions, and an abort signal. It returns normalized events:

- text and reasoning deltas;
- complete tool calls;
- token usage;
- exactly one terminal event.

The collector rejects malformed usage, duplicate or empty tool identities, data after completion, oversized output, excessive tool calls, and missing completion. `ScriptedProvider` makes the full engine deterministic in tests.

`BackendRunCoordinator` selects the immutable session pin's direct-model or delegated-runtime lane. Standalone assembly rereads the registry on every operation, finds the exact pinned connection ID, reconstructs its canonical pin, and compares the complete value before creating a provider or runtime. Changing the global primary therefore cannot redirect an old session; changing or disconnecting its record fails preflight. Local pins include a domain-separated digest of the normalized loopback origin. The coordinator also rejects a resolver whose run authorization is bound to a different operation, turn, session, connection, model, policy, billing mode, or invalid request budget. Direct providers are instantiated per run and enter `AgentLoop` through `AgentLoopDirectExecutor`; the authorization's request budget limits model steps. `DelegatedAgentExecutor` separately validates bounded runtime events, approval option IDs, capabilities, continuation provenance, and one terminal result.

`AgentBackendRouter` evaluates role candidates by declared capability—execution mode, host-controlled tools, background eligibility, permission support, connection readiness, and billing policy—rather than provider brand. Registry schema v2 stores at most one explicit direct-model connection assignment for each Implement, Review, and Repair role. Production assembly rereads and resolves those assignments at team preflight, filters them through the active version-5 mode's eligible billing classes, always retains the immutable parent pin as fallback, and freezes each decision and backend pin into the durable descriptor. Historical modes continue to inherit the parent. Resume requires the fresh eligible decision to match the frozen route exactly. This is explicit routing, not automatic model intelligence: Recurs does not infer strength, estimate price, route ordinary `delegate_task` calls, or silently choose an unassigned account.

The live direct transports are credential-free literal-loopback Ollama/LM Studio, fixed-origin environment BYOK for OpenAI Responses plus reviewed OpenAI Chat-compatible and Anthropic Messages providers, and the injected test/embedding seam. Environment selection is all-or-nothing (`RECURS_PROVIDER`, `RECURS_MODEL`, `RECURS_API_KEY`), rejects arbitrary origins, derives the adapter from the reviewed manifest protocol, hashes the credential into a non-secret pin identity, and strips key-bearing variables from all tool children. The public Responses adapter keeps API storage disabled, validates typed streaming lifecycle and function items, and holds replayable encrypted reasoning behind bounded process-scoped handles; it fails closed rather than claiming restart durability. The Anthropic adapter translates durable system/message/tool history into native Messages blocks and uses bounded named-SSE decoding. Both normalize usage and reject redirects, malformed events, and split-chunk credential echoes. Protocol-level harness profiles add stable native or conservative compatibility tool-use instructions to every direct-model step. The live delegated transport is the pinned official `@agentclientprotocol/codex-acp` 1.1.2 profile with `@openai/codex` 0.144.0. It enforces Codex `read-only`/Plan mode and local, manual, user-present CLI context. Before every run or reconciliation, assembly rereads saved connections and current policy. The runtime verifies structured ChatGPT authentication and the canonical account fingerprint on the exact ACP child that will perform the work. One-shot, unattended, recognized CI, remote, scripted, implicit SDK, Act-mode, stale-policy, changed-account, or changed-connection use fails before delegated Codex work continues.

That Codex implementation belongs to the public npm/source CLI. The sealed private engine does not bundle or dynamically resolve the Codex binary/adapter graph; its `@recurs/runtimes` seam returns one fixed `adapter_unavailable` failure. Delegated Codex can enter the sealed host only after the runtime binary and adapter have their own reviewed fixed signed-bundle layout.

Broker-owned saved connections require current native attestation, an exact registered codec/endpoint profile, current policy, a compatible platform, and a production-signed launcher/broker relationship. The public environment path is intentionally separate: it can use only supported fixed HTTPS manifest protocols implemented by its explicit Responses, Chat, or Anthropic adapter and never creates or activates a brokered registry record. A catalog manifest or caller-created object alone still cannot activate a provider.

## Tools and permissions

The registry parses tool input, evaluates every permission intent, asks when required, records exact session grants, runs an optional side-effect-free validation preflight, creates checkpoints around mutating tools, and executes the tool. A failed preflight cannot start checkpoint capture. Unknown implementation errors are converted to safe typed tool failures before they can enter events or session storage.

Plan mode removes mutating tools from the provider-visible registry and rejects them if called directly. It is an enforced capability boundary, not a prompt convention.

The parent direct-provider loop may register one generic `mcp` tool from private user-owned configuration or project configuration whose canonical workspace and exact bytes have been explicitly trusted. Project trust is stored below that workspace's private Recurs data root and is invalidated before execution when the config digest changes; user/project server-ID collisions fail closed. MCP server startup is always mutating/elevated shell authority and optional network authority is explicit. One runtime may retain a single serialized stdio session for each exact server/workspace/sandbox identity. Reuse requires a protocol ping; failed health may restart only before an operation, never after an ambiguous tool call. Cancellation, timeout, failure, untrust, runtime close, one-shot settlement, REPL exit, and ACP close/disconnect converge on process-group cleanup. Protocol metadata and results are untrusted data. Historical child/team profiles do not include the tool. Remote authentication/transports, cross-runtime daemons, and ACP-client declarations remain outside this boundary.

Permission engines and reusable grants are isolated by session. The three presets are:

- **Ask Always:** normal project reads run; writes and shell commands ask; classified credential paths are denied.
- **Approved for Me:** normal guarded project reads and writes run; all shell, network, sensitive, external, deployment, and destructive actions ask; classified credential paths are denied.
- **Full Access:** routine workspace, shell, network, deployment, and destructive prompts are skipped after explicit confirmation; sensitive and external paths still ask; classified credential paths are denied.

Built-in file, search, patch, Git, and checkpoint operations derive their case-insensitive credential exclusions from one path policy. Direct and canonical classified targets fail before tool execution, and aggregate `rg`/Git operations exclude slash and literal-backslash variants. Checkpoint capture reclassifies canonical parent and regular-file targets before any content read or blob write. This path-based defense does not eliminate adversarial symlink-swap races and does not constrain arbitrary shell scripts.

Fixed Git operations require Git 2.45 or newer, pin the requested worktree, and disable optional index locks, lazy object fetching, repository hooks, fsmonitor, external diff/text conversion, expanded dirty-submodule diffs, and configured clean/smudge/process filters. Filter key names are enumerated through a bounded name-only Git query; their command values never enter Recurs, and command-line empty overrides make the filters pass through without execution. The same prefix protects status, diff, patch parsing/check/application, and checkpoint enumeration. Apply-patch accepts exact slash-separated declarations, rejects path spellings that its policy would transform, rejects rename/copy operations, resolves canonical targets in a pre-checkpoint preflight, and compares Git's NUL-delimited `--numstat` path set with the declared, revision-checked files before mutation. This is application-level configuration preflight, not an OS boundary against another same-user process changing repository state concurrently.

Every fixed or arbitrary child process receives exactly standard descriptors `0`–`2`, a mode-`0700` synthetic home, config, cache, and temporary tree under the canonical root-owned sticky system temporary directory. Its environment contains those paths, a filtered absolute `PATH`, and selected locale/terminal values only; it does not inherit the launcher descriptor, native-authority markers, Keychain/token variables, provider/cloud variables, the real home, `SHELL`, proxy variables, sockets, or workspace-contained `PATH` entries. Shell execution has command-risk classification, timeout, cancellation, process-group termination, output bounds, and a bounded output-pipe drain before parent handles are destroyed and synthetic-state cleanup proceeds. This prevents inherited pipes alone from holding Recurs settlement open; it does not terminate or contain a descendant that deliberately creates another process group or session. Nonzero exits expose the command and exit code, not stderr. Windows subprocess use fails with a typed unsupported-platform error.

The current security profiles are:

- `workspace_sandboxed` (standalone default on macOS and Linux): all registered tools remain subject to Plan mode and permissions. Shell and verification children run under Apple Seatbelt or a fixed system-Bubblewrap policy with canonical workspace-only host writes, hidden host credential/runtime state, and network denied unless an approved command intent requires it. Linux adds mount/user/PID/IPC/UTS namespaces but no Recurs seccomp filter. Sandbox setup fails closed.
- `local_guarded` (standalone default on Windows and explicit embedding option elsewhere): all registered tools are available subject to Plan mode and permissions. On supported process platforms, arbitrary commands still have the user's host filesystem, network, IPC, and process authority. Windows subprocess execution is rejected as unsupported.
- `tools_disabled`: no model tool definitions are advertised, and every direct invocation is rejected before parsing, permissions, or checkpoint capture. It is a fail-closed composition option, not a useful coding profile or sandbox.

The macOS/Linux sandbox is a subprocess boundary, not authorization to expose provider credentials to TypeScript. Windows containment remains unimplemented. Full Access does not change those boundaries.

## Sessions and recovery

New sessions are append-only version-2 JSONL logs. Sequence zero records an immutable backend pin; every later record increments by exactly one and carries turn or operation provenance. Strict validators reject unknown fields, mixed versions, invalid transitions, stale sequences, malformed nested messages/failures, and contradictory terminals. Every append is flushed and synced.

The loop repairs an interrupted protocol boundary before the next request:

- pending `tool_started` records receive `tool_failed` with code `interrupted`;
- assistant tool calls without a tool result receive a synthetic interrupted result.

The mutation lease uses an atomic lock directory, owner-process recovery, and monotonic fence. A concurrent or stale writer fails before provider work. Version-1 logs remain readable and listable but are permanently read-only; continuing them will require the later explicit generic fork flow. Partial trailing records are quarantined, while committed corruption fails loudly.

Delegated turns persist normalized text, usage, changed files, evidence, failure/cancellation, and provenance-bearing continuation updates in the same version-2 log. Vendor session identifiers remain behind bounded process-scoped continuation capabilities and are not written to JSONL. A continuation is staged as uncertain before terminal settlement and committed only with the matching durable terminal. On a later attempt while that process-scoped payload remains available, the coordinator asks the runtime to reconcile the uncertain tip before any new prompt. Core can record a proven committed or gone outcome, but the current ACP implementation conservatively reports an existing resumable vendor session as still uncertain and advances only when the session is proven gone; it never repeats remote work. After process loss the opaque payload is unavailable, so the durable uncertain record blocks unsafe replay rather than promising cross-process vendor-session recovery. The current continuation store is not a persistent broker.

An orphaned compaction start is closed locally as interrupted with unknown usage and is never retried automatically. The agent loop closes incomplete tool boundaries and the previous open turn before beginning another request. Model-call usage is accounted when its durable completion record is replayed, so a later interrupted turn does not erase already incurred usage.

Compaction targets the latest six messages but extends the retained window when necessary so an assistant tool call is never separated from its tool results.

Team-run recovery is separate from conversational replay. At standalone assembly startup, before provider-policy or conversational-session activation, Recurs acquires dead-owner leases before changing a run, validates child identity against the frozen task/workspace/assignment binding, converts terminal child usage into team accounting, interrupts unsafe in-flight work, reconciles prepared parent applies, and removes only stale worktrees under Recurs's private project-data root. Per-run failures are sanitized; after all runs are inspected, any failure blocks startup with one safe error. A stable `ready_to_apply` candidate survives restart. Active compute does not: without a daemon, an ownerless running team becomes `interrupted` and requires an explicit safe resume. Legacy run records that lack the complete child binding fail closed rather than trusting a coincidentally matching session.

## Checkpoints

Mutating tools capture content-addressed before/after workspace states outside the project. Credential-classified paths are removed before any workspace read or blob write. Fresh stores receive a private version-2 format marker asserting that this exclusion was active from the first capture. A nonempty unversioned store, invalid or symlinked marker, or unknown format fails with `checkpoint_migration_required`; Recurs never blesses, rewrites, or deletes it automatically. Because this is unreleased `0.0.0` data, the supported migration is an explicit user-initiated move of the legacy checkpoint directory so a fresh store can be created.

Undo chooses the newest checkpoint that changed files and verifies the current files still match the agent-produced after-state before restoring anything. Credential-classified canonical parents and targets are conflicts—even when the expected after-state is absent—and are checked again before each restore. Git is used for enumeration only; Recurs does not reset, clean, checkout, or commit the user's repository. The format marker protects upgrade semantics; the Node pathname-based store is not suitable for authentication secrets.

## Native provider authority

The macOS authority checks exact launcher/broker identifiers, Team ID, production signing class, and Hardened Runtime posture. It stores provider credentials as non-synchronizing `WhenUnlockedThisDeviceOnly` Data Protection Keychain items in a broker-private access group. Production broker startup authenticates and recovers the complete journal-v2 authority before activating XPC. Every record is bound to one exact provider/profile identity and generation; unreleased schema-v1 state deliberately fails closed and is reset rather than assigned a synthetic identity.

The production-signed launcher resolves only fixed nonsymlinked Node and engine resources, owns foreground TTY capture and restoration, erases transient secret buffers, and bridges bounded redacted frames over anonymous descriptor 3. The sealed engine never receives a reusable credential. The public npm/source CLI removes an injected native descriptor before application loading, while unsigned and ad-hoc launchers fail the private engine path closed. Signal ownership, exact-PID process cleanup, terminal restoration, framing, and peer identity are covered by native and controlling-PTY tests.

OpenAI API, Anthropic API, and Kimi Code activation are complete private verticals. The authority captures a credential, performs the exact bound model catalog, and transactionally commits Keychain plus non-secret registry state with crash recovery. Broker-owned generation streams OpenAI Responses, Anthropic Messages, or Kimi's OpenAI Chat Completions profile through scoped, expiring, cancellation- and budget-bound one-use reservations. OpenAI continuation state is encrypted behind opaque handles; Anthropic and Kimi use the durable transcript. Strict codecs normalize events and usage, reject redirects/profile drift, and filter credential echoes before any reply crosses the native boundary.

No signed/notarized installed artifact or production credential-canary smoke has shipped, so these completed verticals are not distributed and source/npm execution cannot activate them. Release work still needs the installed-artifact proof and owner-selected project license. The standalone CLI applies fail-closed Seatbelt on macOS and system Bubblewrap on Linux to shell and verification children; `local_guarded` remains an explicit macOS/Linux embedding option and the Windows default. The private provider design relies on credentials and reusable request authority remaining exclusively in the broker; rewriting the agent loop, session engine, or CLI wholesale in Rust is not required for that boundary.

Public release assembly retains one npm tarball as the authoritative portable artifact. A protected exact-tag workflow reruns verification, renders a SHA-256-bound user-local installer and Homebrew formula from that archive, creates a draft GitHub release, attests the assets, and publishes or verifies the same tarball's npm SHA-512 integrity before making the release public. The current `UNLICENSED`/`0.0.0`/private-package state fails before artifact publication even though the source repository is now public. This prepares npm, curl, and Homebrew surfaces without claiming a live package, tap, or signed native bundle.

The public npm/source Codex path does not weaken that gate: Recurs launches the pinned official adapter, delegates any advertised `chat-gpt` login flow to it, and stores only non-secret linkage, verified account label/fingerprint, policy/billing acknowledgement, and model metadata. Recurs never reads `auth.json`, browser cookies, copied tokens, or credential values. The adapter/runtime remains vendor-authenticated, and the current path is deliberately Plan-only and foreground-only. The sealed private engine denies this delegated path until it can ship without ambient runtime resolution.

## Verification and extension order

`npm run check` is the repository gate: lint, strict TypeScript, all tests, and build. GitHub Actions runs the same command.

Without an explicit primary, the CLI remains in a `WorkspaceShellState` and creates no durable session even when secondary records exist. A configured credential-free OpenAI-compatible server is accepted only at literal HTTP loopback, is verified through `/models`, and is pinned to an exact connection/model/origin before a session is created. Saved environment BYOK accepts only reviewed supported OpenAI Chat profiles with fixed HTTPS origins and unconditional current usage policy; setup stores the provider/model policy and billing snapshot, environment-variable name, and credential fingerprint but never the key. Runtime rereads policy and registry state, requires the exact environment credential, and creates the provider only through the reviewed manifest origin. A Codex connection is established only through interactive billing acknowledgement, structured ChatGPT authentication/status checks, a read-only capability probe, and non-secret registry commit. The first record in an empty registry becomes primary; later records never replace it implicitly. Exact-ID account commands list, verify, select, and disconnect records through bounded atomic registry mutations. Verification is read-only; environment verification checks the local binding, not live vendor authentication. Disconnection removes Recurs metadata only and clears a removed primary rather than promoting another record. Public results omit account labels, fingerprints, endpoints, and credentials. Empty-argument REPL startup requires a user-present local TTY and rejects recognized automation even when it has a TTY; supported noninteractive direct-model work uses the explicit `recurs run` command. Noninteractive prompts without a connection—and all noninteractive Codex prompts—fail before provider work. Provider, tool, process, and unexpected CLI failures cross user-visible or durable boundaries through allowlisted messages; unknown CLI faults receive a diagnostic UUID rather than raw error text.

The Recurs ACP server is another process host over this same boundary, not a second agent implementation. `session/new` creates a distinct pinned runtime session instead of reusing an interactive conversation. ACP prompts are branded as local, unattended, scripted SDK invocations, so provider policy remains authoritative; the user-present Codex subscription path is not silently made available. The adapter projects normalized model, tool, child, batch, and team events into ACP updates, forwards only allow-once/reject-once permission decisions, propagates cancellation and disconnect, and exposes no client filesystem or terminal capability. It rejects additional roots and MCP declarations until those authorities can be admitted through Recurs's own containment and tool-policy layers.

The remaining extension order is deliberate:

1. select the project license/version, configure the protected npm identity and Homebrew tap, then exercise the prepared portable release path from the now-public repository;
2. produce and verify the signed/notarized installed bundle, including isolated broker recovery and credential-canary smokes for the completed OpenAI, Anthropic, and Kimi verticals;
3. add the explicit public-HTTPS OpenAI-compatible profile only with DNS-rebinding-safe endpoint verification;
4. add further direct API and coding-plan verticals only with exact provider profiles, billing disclosure, and installed-artifact evidence;
5. add official delegated runtimes to the sealed host only with fixed signed layouts plus provider-specific capability and policy proof;
6. add enforceable process/filesystem/network containment before unattended arbitrary-command workers, then design any persistent worker host as a separately authenticated owner rather than extending the CLI promise;
7. extend explicit role routing with reviewed capability and price metadata only while preserving frozen routing, user intent, and accounting truth;
8. extend MCP only through separately reviewed authenticated remote, project-trust, prompt/resource, and child-profile slices; add the company coordinator, desktop, plugin packaging, and distribution over the same durable contracts and the live ACP client boundary.

See [the engine comparison](docs/BASE_ENGINE_COMPARISON.md), [the Core v0 design](docs/superpowers/specs/2026-07-10-recurs-core-v0-design.md), and [the provider design](docs/superpowers/specs/2026-07-10-recurs-provider-auth-design.md).
