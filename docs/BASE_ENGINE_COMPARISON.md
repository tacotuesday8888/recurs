# Base Engine Comparison

This review compares Recurs with the current open-source engines behind Kilo Code, OpenCode, and Codex. The goal is not feature parity. It is to identify the smallest set of engine guarantees Recurs needs before the sub-agent architecture is built on top.

Reviewed on 2026-07-10 through the GitHub connector:

- [Kilo Code](https://github.com/Kilo-Org/kilocode/tree/8324cf7ddc6539993f7d1743175716ae2705d195)
- [OpenCode](https://github.com/anomalyco/opencode/tree/8a03fc265b6d73c2e15881fcc702c9cb3027dd0e)
- [Codex](https://github.com/openai/codex/tree/dc5ae378967cff0de2cfb30b98c52047ab978e3d)

Parallel scheduling was rechecked on 2026-07-19 against current [Codex](https://github.com/openai/codex/blob/0fb559f0f6e231a88ac02ea002d3ecd248e2b515/codex-rs/core/src/tools/parallel.rs), which uses an explicit per-tool capability behind a shared/exclusive execution gate, and [Gemini CLI](https://github.com/google-gemini/gemini-cli/blob/acae7124bdd849e554eaa5e090199a0cf08cd782/packages/core/src/scheduler/scheduler.ts), which batches contiguous calls with an explicit ordering barrier.

Kilo's CLI is a fork of OpenCode, as Kilo states in its [README](https://github.com/Kilo-Org/kilocode/blob/8324cf7ddc6539993f7d1743175716ae2705d195/README.md). They are therefore one engine lineage for this comparison; Kilo-specific guards are considered separately.

## What the mature engines establish

| Engine concern | OpenCode and Kilo | Codex | Recurs decision |
| --- | --- | --- | --- |
| Turn loop | A stream processor persists text, reasoning, tool state, snapshots, and completion state as events arrive. | A turn-scoped sampling loop records response items, executes tools, handles follow-up requests, and compacts when needed. | Keep one small deterministic loop, but centralize stream validation and make partial-stream retry behavior explicit. |
| Tool lifecycle | OpenCode's [processor](https://github.com/anomalyco/opencode/blob/8a03fc265b6d73c2e15881fcc702c9cb3027dd0e/packages/opencode/src/session/processor.ts) settles running tools and marks unfinished tools as aborted during cleanup. Kilo adds guards for empty tool-call finishes and incomplete output. | Tool events and cancellation are first-class parts of the turn protocol. | A started tool must always receive a durable terminal record and a model-visible tool result, including after cancellation or process restart. |
| Parallel tool calls | Gemini CLI batches contiguous calls and exposes an explicit `wait_for_previous` barrier. OpenCode's provider-facing tools run through independent async execute functions. | Codex marks tools that support parallel execution and uses a read/write gate so unsupported calls are exclusive. | Use explicit opt-in, never inference from `mutating: false` alone. Run at most four approval-free built-in reads together; mutations, approvals, commands, MCP, delegation, and unknown tools stay serial. Persist starts, terminal records, and provider results in call order even when completion order differs. |
| Loop protection | OpenCode asks on three repeated identical tool calls. Kilo retains that guard. | The turn loop is bounded by cancellation, context policy, and explicit lifecycle state. | Keep Recurs's existing repeated-interaction detector and step budget. Do not add more heuristics yet. |
| Retry behavior | OpenCode uses a provider-aware backoff policy and exposes retry status. Kilo adds offline handling and a configured retry limit. | Codex has bounded stream retries, transport fallback, user-visible reconnect events, and cancellation. | Keep two bounded retries, but only before semantic output. Retrying after text or a tool call risks duplicated work and confusing output. |
| Permissions | OpenCode/Kilo use ordered allow, ask, and deny rules per tool or target. Their autonomous mode can remove prompts. | Codex separates approval decisions from an enforceable filesystem/network sandbox; session approvals use exact cached keys. | Preserve Ask Always, Approved for Me, and Full Access as a layer separate from containment. Recurs now pins the chosen preset into each session and keeps Full Access behind an explicit warning. |
| Filesystem/process isolation | OpenCode/Kilo primarily expose configurable permission rules. | Codex evaluates patches against writable roots and runs tools through platform sandbox policy when available. | Recurs now combines its path/symlink/stale-write/process guards with fail-closed Seatbelt on macOS and system Bubblewrap on Linux. Windows command tools remain unsupported instead of receiving a false sandbox claim. |
| Sessions and recovery | OpenCode persists granular session/message/part state and cleans up aborted work. | Codex writes append-only JSONL rollouts through an owned writer task with flush and terminal-failure reporting. | Version-2 pinned sessions, exact mutation leases, partial-record recovery, interrupted-operation reconciliation, continuation state, and durable team journals are implemented. |
| Extension surface | Both expose large provider, tool, plugin, MCP, and agent systems. | Codex has a broad tool router, plugins, skills, connectors, and multi-agent protocol. | Keep extensions narrow and authority-aware: Recurs now exposes ACP stdio, bounded stdio MCP, progressive Agent Skills, owned child/batch tools, and durable team tools without a generic plugin authority. |
| Verification | Both repositories use automated tests and CI across their packages. | Codex has extensive protocol, runtime, sandbox, rollout, and integration tests. | Add one strict `npm run check` path and run it in CI. |

## Recurs base assessment

The current code is a real harness, not a placeholder. Beyond the original provider-neutral loop, tools, permissions, Plan mode, goals, sessions, compaction, checkpoints, structured output, cancellation, and loop guards, it now has reviewed provider onboarding, immutable backend pins, direct/delegated coordination, ACP/MCP/skills interoperability, owned child and durable team execution, and fail-closed macOS/Linux tool containment.

Its useful difference is size. Recurs can keep the single-agent engine understandable while placing future complexity in provider adapters and the sub-agent orchestration layer.

The original four hardening requirements are now implemented:

1. One strict provider-event reducer shared by tests and the live loop.
2. Durable cleanup and restart reconciliation for every tool call.
3. A same-session run guard and an honest platform-specific permission/containment boundary.
4. A single local/CI verification command plus concise current documentation.

## Explicitly deferred

The remaining material gaps are narrower and explicit:

- Windows OS-level filesystem/network sandboxing and a Linux seccomp layer (macOS uses fail-closed Seatbelt; Linux uses fail-closed system Bubblewrap namespaces and mount policy);
- a reviewed general plugin lifecycle, remote MCP/OAuth, and desktop UI;
- additional live provider-specific transports beyond the current local, fixed-origin Chat, Codex ACP, and private native OpenAI/Anthropic/Kimi paths;
- Codex's transport fallback, hooks, connectors, and mature multi-agent protocol.

Windows containment and a reviewed Linux syscall policy remain important follow-ups before Recurs allows unattended arbitrary-command workers. The standalone macOS and Linux defaults now add fail-closed OS boundaries while retaining permission prompts as a separate decision layer.
