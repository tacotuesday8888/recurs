# Sub-Agent Harness Comparison

Verified against primary open-source repositories and project documentation on 2026-07-17. This comparison is about execution mechanics, not marketing claims or source copying.

## What the mature harnesses actually do

| Harness | Spawn primitive | Isolation and inheritance | Bounds and observability | Recurs takeaway |
| --- | --- | --- | --- | --- |
| Codex CLI | `spawn_agent` creates a child thread through agent control. | The child receives a derived config, optional forked history, role/model policy, and the parent approval policy. | Explicit depth checks and started/completed collaboration events carry sender, receiver, prompt, model, reasoning, status, and state. Tests cover depth, model/provider constraints, context forking, and preserved approvals. | Make spawning a tool, preserve the parent security envelope, and expose normalized lifecycle events. |
| OpenCode | `task` creates or resumes a child session with `parentID`. | The child gets derived permissions, a selected agent profile, and either that profile's model or the parent model/variant. | Configurable depth, foreground/background execution, linked cancellation, resumable task IDs, and structured task results. Primary-only tools are denied to children unless explicitly allowed. | Use real child sessions and return a structured handoff; keep background/resume out until foreground truth is solid. |
| Kimi Code | `SessionSubagentHost` creates a child agent within the session's durable agent map. | Profiles define prompt, tool set, summary policy, model alias, and parent relationship. Explore is read-only; coder is the editing profile. | Active-child tracking, timeout, batch concurrency, cancellation propagation, retry/resume paths, lifecycle hooks/events, usage, and a minimum-quality final handoff. | Profiles and swarms are useful later; first own lifecycle, cancellation, usage, and evidence without hiding work. |
| Kilo Code | A task tool launches built-in or custom sub-agents in isolated sessions. | Custom agents can constrain prompts, tools, permissions, model, and maximum steps; results return to the parent. | Separate histories, task-level permissions, concurrent tasks, and explicit step limits. | Keep permissions monotonic and make model overrides an explicit future capability, not an implied one. |
| Pi | The reference extension launches separate `pi` processes; the SDK can also create agent sessions. | A separate process gives a clean context and JSON output; the extension supports single, parallel, and chain modes. | The example caps parallel tasks and concurrency, while Pi's extension philosophy keeps orchestration visible and replaceable. | Do not shell Recurs out to itself as the core design. Keep the simple task primitive and observability, but run through one internal engine. |
| Goose | Sub-agent tools and sub-recipes run independent tasks; current settings bound child turns and background-task concurrency. | Recipes scope instructions, model/provider settings, and extensions. | `GOOSE_SUBAGENT_MAX_TURNS` and `GOOSE_MAX_BACKGROUND_TASKS` are explicit. Goose's own architecture discussion identifies inconsistent chat, scheduler, dynamic-task, and sub-recipe execution paths as technical debt and proposes an agent-per-session unified executor. | Use one coordinator for interactive, provider, runtime, and child work from the beginning. Do not create a second execution stack for orchestration. |

## Primary sources

- Codex [`spawn_agent` handler](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents/spawn.rs) and [multi-agent tests](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_tests.rs)
- OpenCode [`task` tool](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/task.ts) and [task tests](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/test/tool/task.test.ts)
- Kimi Code [`SessionSubagentHost`](https://github.com/MoonshotAI/kimi-code/blob/main/packages/agent-core/src/session/subagent-host.ts), [host tests](https://github.com/MoonshotAI/kimi-code/blob/main/packages/agent-core/test/session/subagent-host.test.ts), and [agent profiles](https://github.com/MoonshotAI/kimi-code/blob/main/packages/agent-core-v2/src/session/agentLifecycle/profile/profiles.ts)
- Kilo Code [orchestration documentation](https://github.com/Kilo-Org/kilocode/blob/main/packages/kilo-docs/pages/code-with-ai/agents/orchestrator-mode.md) and [custom sub-agent documentation](https://github.com/Kilo-Org/kilocode/blob/main/packages/kilo-docs/pages/customize/custom-subagents.md)
- Pi [sub-agent extension](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/subagent/index.ts), [SDK documentation](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/sdk.md), and [session-first orchestration proposal](https://github.com/badlogic/pi-mono/issues/552)
- Goose [environment limits](https://github.com/block/goose/blob/main/documentation/docs/guides/environment-variables.md), [custom-distribution sub-agent overview](https://github.com/aaif-goose/goose/blob/main/CUSTOM_DISTROS.md), and [unified agent-execution discussion](https://github.com/block/goose/discussions/4389)

## Decision for the first Recurs vertical

Recurs now follows the convergent core while deliberately stopping before the heavy architecture:

- `delegate_task` is a model-callable, exact-input tool.
- Every child is a separate pinned version-2 Recurs session, not a subprocess wrapper or an external-runtime-only feature.
- The first stable child profile is `explore_v1`: it narrows execution to Plan, exposes only five inspection tools where Recurs owns tool execution, and requests a structured evidence handoff.
- The child uses the same `BackendRunCoordinator`, backend resolver, direct provider or delegated runtime, approval engine, host tools, and cancellation signal as its parent.
- The child inherits the exact backend/model pin and a permission mode that cannot exceed the parent; Explore narrows execution to Plan even when its parent is in Act.
- Stable operating-mode IDs bound request count, depth, concurrency, retries, and reported cost. Display names can change later without migrating logs.
- Parent/child activity emits normalized events; child JSONL state retains its task, lifecycle, usage, result, files, evidence, failure, or cancellation.
- The parent receives the child final text as a tool result and performs the synthesis itself.

## Intentionally absent

This milestone does not implement parallel fan-out, background children, child resumption, automatic retries, depth beyond one, additional role/profile libraries, independent model routing, worktree isolation, swarms, schedules, or the company UI. Reported USD cost can only be flagged after a provider/runtime supplies telemetry; request limits are the enforceable pre-run spending bound. The official Codex runtime is opaque internally and already permits one authorized runtime invocation, so Recurs does not claim to meter its vendor-internal model calls or filter its internal tool catalog; it is accepted for Explore only through its pinned enforced-Plan capability.
