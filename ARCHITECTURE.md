# Recurs Architecture

Recurs has one small coding-agent engine and multiple future clients. The terminal is the first client; the planned desktop app will present projects as agent-managed companies without turning Recurs into an IDE.

## Package boundaries

Dependencies point inward:

```text
packages/cli  ───────► packages/core
     │                    │
     ├────────────────────┼────► packages/tools
     └────────────────────┴────► packages/providers
```

- `@recurs/providers` owns provider-neutral request, message, tool-call, event, error, and collection contracts. It has no provider authentication or network implementation.
- `@recurs/tools` owns tool definitions and execution, permission intents, workspace path policy, command classification, process bounds, Git inspection, and checkpoints.
- `@recurs/core` owns the turn loop, normalized runtime events, durable goals, session reduction, JSONL persistence, compaction, and loop detection.
- `@recurs/cli` owns runtime assembly, slash commands, rendering, interactive input, non-interactive execution, and process exit behavior.

The future desktop app and sub-agent orchestrator should consume these public boundaries rather than reimplementing the loop.

## Turn lifecycle

For one prompt, `AgentLoop`:

1. rejects a concurrent run for the same session;
2. loads and reduces the append-only session log;
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

Live transports, account connections, billing policy, provider catalogs, and delegated coding-agent runtimes belong to the separate reviewed provider design. They must resolve to this boundary or an explicit future runtime boundary; they must not add provider-specific branches to `AgentLoop`.

## Tools and permissions

The registry parses tool input, evaluates every permission intent, asks when required, records exact session grants, creates checkpoints around mutating tools, and executes the tool.

Plan mode removes mutating tools from the provider-visible registry and rejects them if called directly. It is an enforced capability boundary, not a prompt convention.

The three presets are:

- **Ask Always:** normal project reads run; writes and shell commands ask.
- **Approved for Me:** normal guarded project reads and writes run; all shell, network, sensitive, credential, external, deployment, and destructive actions ask.
- **Full Access:** routine prompts are skipped after explicit confirmation; logging, cancellation, limits, path validation, stale-write checks, and checkpoint conflict checks remain.

File tools enforce workspace containment after symlink resolution. Patches require a current-turn read hash. Shell execution has command-risk classification, timeout, cancellation, process-group termination, and output bounds, but no OS filesystem/network sandbox. Full Access therefore trusts the host environment; the middle preset does not auto-run shell commands.

## Sessions and recovery

Each session is an append-only version-1 JSONL log. Every append is flushed and synced. Replay reduces records into active state; a partial trailing record is quarantined and removed, while committed corruption fails loudly.

The loop repairs an interrupted protocol boundary before the next request:

- pending `tool_started` records receive `tool_failed` with code `interrupted`;
- assistant tool calls without a tool result receive a synthetic interrupted result.

This keeps resumed provider history structurally valid. Multi-process file locking, indexed metadata, provenance-rich backend pins, and atomic grouped records remain part of the later session-v2/provider work.

## Checkpoints

Mutating tools capture content-addressed before/after workspace states outside the project. Undo chooses the newest checkpoint that changed files and verifies the current files still match the agent-produced after-state before restoring anything. Git is used for enumeration only; Recurs does not reset, clean, checkout, or commit the user's repository.

## Verification and extension order

`npm run check` is the repository gate: lint, strict TypeScript, all tests, and build. GitHub Actions runs the same command.

The extension order is deliberate:

1. provider/authentication and onboarding;
2. enforceable process isolation suitable for unattended work;
3. the sub-agent/company coordinator, isolated workspaces, handoffs, and budgets;
4. desktop, plugins/MCP, and distribution.

See [the engine comparison](docs/BASE_ENGINE_COMPARISON.md), [the Core v0 design](docs/superpowers/specs/2026-07-10-recurs-core-v0-design.md), and [the provider design](docs/superpowers/specs/2026-07-10-recurs-provider-auth-design.md).
