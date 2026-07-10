# Recurs Architecture

Recurs has one small coding-agent engine and multiple future clients. The terminal is the first client; the planned desktop app will present projects as agent-managed companies without turning Recurs into an IDE.

## Package boundaries

Dependencies point inward:

```text
packages/contracts
      ▲       ▲       ▲
      │       │       │
 providers  tools    core ◄──── cli
      ▲       ▲       ▲          │
      └───────┴───────┴──────────┘
```

- `@recurs/contracts` owns dependency-free model, connection, billing, backend-pin, trusted-invocation, failure, direct-provider, delegated-runtime, and coordinator contracts.
- `@recurs/providers` owns normalized stream collection and deterministic provider fixtures. It has no authentication or network implementation.
- `@recurs/tools` owns tool definitions and execution, permission intents, workspace path policy, command classification, process bounds, Git inspection, and checkpoints.
- `@recurs/core` owns the turn loop, backend-neutral coordinator/runtime, trusted preflight handoff, normalized runtime events, durable goals, session reduction, JSONL persistence, compaction, and loop detection.
- `@recurs/cli` owns runtime assembly, slash commands, rendering, interactive input, non-interactive execution, and process exit behavior.

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

`BackendRunCoordinator` selects the immutable session pin's direct-model or delegated-runtime lane. It rejects a resolver whose run authorization is bound to a different operation, turn, session, connection, model, policy, billing mode, or invalid request budget. Direct providers are instantiated per run and enter `AgentLoop` through `AgentLoopDirectExecutor`; the authorization's request budget limits model steps. Delegated runtimes have a separate contract and dispatch port rather than being disguised as raw models. The current injected provider is a test/embedding path, not live credential support, and no production delegated executor exists yet.

## Tools and permissions

The registry parses tool input, evaluates every permission intent, asks when required, records exact session grants, creates checkpoints around mutating tools, and executes the tool.

Plan mode removes mutating tools from the provider-visible registry and rejects them if called directly. It is an enforced capability boundary, not a prompt convention.

Permission engines and reusable grants are isolated by session. The three presets are:

- **Ask Always:** normal project reads run; writes and shell commands ask.
- **Approved for Me:** normal guarded project reads and writes run; all shell, network, sensitive, credential, external, deployment, and destructive actions ask.
- **Full Access:** routine prompts are skipped after explicit confirmation; logging, cancellation, limits, path validation, stale-write checks, and checkpoint conflict checks remain.

File tools enforce workspace containment after symlink resolution. Patches require a current-turn read hash. Shell execution has command-risk classification, timeout, cancellation, process-group termination, and output bounds, but no OS filesystem/network sandbox. Full Access therefore trusts the host environment; the middle preset does not auto-run shell commands.

## Sessions and recovery

New sessions are append-only version-2 JSONL logs. Sequence zero records an immutable backend pin; every later record increments by exactly one and carries turn or operation provenance. Strict validators reject unknown fields, mixed versions, invalid transitions, stale sequences, malformed nested messages/failures, and contradictory terminals. Every append is flushed and synced.

The loop repairs an interrupted protocol boundary before the next request:

- pending `tool_started` records receive `tool_failed` with code `interrupted`;
- assistant tool calls without a tool result receive a synthetic interrupted result.

The mutation lease uses an atomic lock directory, owner-process recovery, and monotonic fence. A concurrent or stale writer fails before provider work. Version-1 logs remain readable and listable but are permanently read-only; continuing them will require the later explicit generic fork flow. Partial trailing records are quarantined, while committed corruption fails loudly.

An orphaned compaction start is closed locally as interrupted with unknown usage and is never retried automatically. The agent loop closes incomplete tool boundaries and the previous open turn before beginning another request. Model-call usage is accounted when its durable completion record is replayed, so a later interrupted turn does not erase already incurred usage.

Compaction targets the latest six messages but extends the retained window when necessary so an assistant tool call is never separated from its tool results.

## Checkpoints

Mutating tools capture content-addressed before/after workspace states outside the project. Undo chooses the newest checkpoint that changed files and verifies the current files still match the agent-produced after-state before restoring anything. Git is used for enumeration only; Recurs does not reset, clean, checkout, or commit the user's repository.

## Verification and extension order

`npm run check` is the repository gate: lint, strict TypeScript, all tests, and build. GitHub Actions runs the same command.

Without a provider, the CLI remains in a `WorkspaceShellState` and creates no durable session. Its local help, status, permissions default, history listing, initialization, and diff commands remain available. Noninteractive model prompts fail before persistence with exit code `2`; JSONL mode emits a structured `configuration_error`.

The remaining extension order is deliberate:

1. credential broker, origin-bound transport, safe diagnostics, and enforceable tool-process isolation;
2. connection registry, catalogs, billing policy, model selection, and onboarding;
3. direct API/coding-plan providers and official delegated subscription runtimes;
4. the sub-agent/company coordinator, isolated workspaces, handoffs, and budgets;
5. desktop, plugins/MCP, and distribution.

See [the engine comparison](docs/BASE_ENGINE_COMPARISON.md), [the Core v0 design](docs/superpowers/specs/2026-07-10-recurs-core-v0-design.md), and [the provider design](docs/superpowers/specs/2026-07-10-recurs-provider-auth-design.md).
