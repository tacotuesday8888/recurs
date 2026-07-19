# Base Engine Comparison

This review compares Recurs with the current open-source engines behind Kilo Code, OpenCode, and Codex. The goal is not feature parity. It is to identify the smallest set of engine guarantees Recurs needs before the sub-agent architecture is built on top.

Reviewed on 2026-07-10 through the GitHub connector:

- [Kilo Code](https://github.com/Kilo-Org/kilocode/tree/8324cf7ddc6539993f7d1743175716ae2705d195)
- [OpenCode](https://github.com/anomalyco/opencode/tree/8a03fc265b6d73c2e15881fcc702c9cb3027dd0e)
- [Codex](https://github.com/openai/codex/tree/dc5ae378967cff0de2cfb30b98c52047ab978e3d)

Kilo's CLI is a fork of OpenCode, as Kilo states in its [README](https://github.com/Kilo-Org/kilocode/blob/8324cf7ddc6539993f7d1743175716ae2705d195/README.md). They are therefore one engine lineage for this comparison; Kilo-specific guards are considered separately.

## What the mature engines establish

| Engine concern | OpenCode and Kilo | Codex | Recurs decision |
| --- | --- | --- | --- |
| Turn loop | A stream processor persists text, reasoning, tool state, snapshots, and completion state as events arrive. | A turn-scoped sampling loop records response items, executes tools, handles follow-up requests, and compacts when needed. | Keep one small deterministic loop, but centralize stream validation and make partial-stream retry behavior explicit. |
| Tool lifecycle | OpenCode's [processor](https://github.com/anomalyco/opencode/blob/8a03fc265b6d73c2e15881fcc702c9cb3027dd0e/packages/opencode/src/session/processor.ts) settles running tools and marks unfinished tools as aborted during cleanup. Kilo adds guards for empty tool-call finishes and incomplete output. | Tool events and cancellation are first-class parts of the turn protocol. | A started tool must always receive a durable terminal record and a model-visible tool result, including after cancellation or process restart. |
| Loop protection | OpenCode asks on three repeated identical tool calls. Kilo retains that guard. | The turn loop is bounded by cancellation, context policy, and explicit lifecycle state. | Keep Recurs's existing repeated-interaction detector and step budget. Do not add more heuristics yet. |
| Retry behavior | OpenCode uses a provider-aware backoff policy and exposes retry status. Kilo adds offline handling and a configured retry limit. | Codex has bounded stream retries, transport fallback, user-visible reconnect events, and cancellation. | Keep two bounded retries, but only before semantic output. Retrying after text or a tool call risks duplicated work and confusing output. |
| Permissions | OpenCode/Kilo use ordered allow, ask, and deny rules per tool or target. Their autonomous mode can remove prompts. | Codex separates approval decisions from an enforceable filesystem/network sandbox; session approvals use exact cached keys. | Preserve Ask Always, Approved for Me, and Full Access. Until Recurs has an OS sandbox, Approved for Me must ask before every shell command. Full Access remains an explicit trust boundary. |
| Filesystem/process isolation | OpenCode/Kilo primarily expose configurable permission rules. | Codex evaluates patches against writable roots and runs tools through platform sandbox policy when available. | Keep Recurs's path, symlink, stale-write, command classification, output, timeout, and cancellation guards. Document that shell execution is not sandboxed; do not claim secret isolation that does not exist. |
| Sessions and recovery | OpenCode persists granular session/message/part state and cleans up aborted work. | Codex writes append-only JSONL rollouts through an owned writer task with flush and terminal-failure reporting. | Keep versioned JSONL and partial-record quarantine. Reconcile missing tool results on resume and reject concurrent runs for one session. Defer multi-process locking and the reviewed session-v2 work. |
| Extension surface | Both expose large provider, tool, plugin, MCP, and agent systems. | Codex has a broad tool router, plugins, skills, connectors, and multi-agent protocol. | Do not copy these into the base. The current provider and tool interfaces are enough seams for the next provider and sub-agent phases. |
| Verification | Both repositories use automated tests and CI across their packages. | Codex has extensive protocol, runtime, sandbox, rollout, and integration tests. | Add one strict `npm run check` path and run it in CI. |

## Recurs base assessment

The existing code is already a real harness, not a placeholder. It has a provider-neutral streaming loop, seven bounded tools, three permission modes, Plan mode, durable goals, append-only sessions, partial-record recovery, compaction, checkpoints and undo, interactive and JSONL CLI output, cancellation, step limits, and repeated-loop detection.

Its useful difference is size. Recurs can keep the single-agent engine understandable while placing future complexity in provider adapters and the sub-agent orchestration layer.

The base is ready for that next layer after four narrow changes:

1. One strict provider-event reducer shared by tests and the live loop.
2. Durable cleanup and restart reconciliation for every tool call.
3. A same-session run guard and honest unsandboxed-shell permission behavior.
4. A single local/CI verification command plus concise current documentation.

## Explicitly deferred

These are valuable, but they do not belong in this hardening slice:

- live provider authentication and subscription routing;
- Linux and Windows OS-level filesystem/network sandboxing (macOS shell and verification subprocesses now use fail-closed Seatbelt workspace containment);
- multi-process session locking and session version 2;
- parallel tool execution;
- plugins, MCP, skills, desktop UI, and sub-agents;
- Kilo/OpenCode's large mode and provider inventories;
- Codex's transport fallback, hooks, connectors, and mature multi-agent protocol.

Cross-platform sandboxing remains the most important follow-up before Recurs allows unattended local sub-agents to execute arbitrary shell commands on Linux or Windows. On macOS, the standalone default now adds a fail-closed Seatbelt boundary while retaining permission prompts as a separate decision layer.
