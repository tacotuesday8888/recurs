# Recurs Core v0 Design

## Purpose

Recurs Core v0 is the first usable foundation of the Recurs coding agent. It is a first-party harness that can accept a coding request, call an LLM, execute tools safely, preserve the session, and continue until the model returns a final response or the run reaches a defined limit.

The CLI is a thin client over this core. Plugins, the desktop company interface, branded command names, subscription-backed coding clients, and advanced multi-agent orchestration come after this foundation is reliable.

## Design Decision

Recurs will not fork an existing coding agent. It will implement its own small harness using three primary references:

- [Pi](https://github.com/earendil-works/pi) for its clean separation between model providers, the agent loop, sessions, and the terminal client.
- [OpenCode](https://github.com/anomalyco/opencode) for permission rules, snapshots, recovery, agent-scoped capabilities, and stuck-loop detection.
- [Codex CLI](https://github.com/openai/codex) for sandbox boundaries, approvals, durable goals, structured events, and separation between the engine and its clients.

Secondary references strengthen specific foundation behavior:

- [Cline](https://github.com/cline/cline) for enforced Plan/Act separation, auto-approval categories, and recoverable checkpoints.
- [Qwen Code](https://github.com/QwenLM/qwen-code) for approval-mode restoration and read-before-write enforcement.
- [Crush](https://github.com/charmbracelet/crush) for session permission grants and tool-call-plus-result loop detection.
- [Gemini CLI](https://github.com/google-gemini/gemini-cli), [Goose](https://github.com/aaif-goose/goose), [Aider](https://github.com/Aider-AI/aider), and [OpenHands](https://github.com/OpenHands/OpenHands) for tool scheduling, portable clients, repository context, verification, and runtime isolation patterns.

The implementation may reuse permissively licensed ideas and small components after license and provenance review, but Recurs owns its public interfaces, state model, prompts, commands, and behavior. No source is copied without attribution and compatibility review.

## Technical Direction

The v0 implementation will use TypeScript. Pi and OpenCode demonstrate that TypeScript is suitable for a portable harness and broad provider support, while keeping the first implementation faster to change than a Rust or Go core. Runtime and dependency versions will be selected from current official documentation in the implementation plan.

The codebase will be organized as independently testable packages:

```text
packages/
  core/       Agent loop, turn coordinator, goals, sessions, events
  providers/  Provider-neutral types and concrete LLM adapters
  tools/      Tool registry, built-in tools, permissions, execution
  cli/        Interactive terminal client and slash commands
```

Package boundaries are directional: `cli` depends on `core`; `core` depends on provider and tool interfaces; concrete providers and tools do not depend on the CLI.

## Agent Loop

For a normal prompt, Recurs performs this sequence:

1. Persist the user message.
2. Capture an immutable turn snapshot containing the active goal, model, messages, project instructions, tools, permissions, and budgets.
3. Send the snapshot to the selected provider and stream events to the client.
4. If the model requests tools, validate every tool name and argument before execution.
5. Evaluate each tool request against the active permission policy.
6. Execute allowed tools sequentially, persist normalized results, and return those results to the model. Providers may request multiple tools in one response, but v0 preserves deterministic request order rather than running them concurrently.
7. Repeat model and tool turns until the model returns a final response or Recurs stops the run.
8. Persist the final response, usage, changed files, verification evidence, and terminal status.

The loop stops on:

- A normal final model response.
- User cancellation.
- A denied action that the model cannot recover from.
- Provider or tool failure after bounded retries.
- Maximum steps, time, or token budget.
- Repeated identical tool calls or another detected stuck-loop pattern.
- An internal consistency failure.

User messages entered while the agent is working are queued and injected at the next safe turn boundary. The active turn snapshot never changes underneath an in-flight provider request.

## Provider Boundary

Every provider adapter exposes the same capabilities:

- Stream assistant text, reasoning metadata when available, and tool calls.
- Accept normalized messages and JSON-schema tool definitions.
- Report token usage and stop reasons.
- Normalize authentication, rate limits, context overflow, cancellation, and transport failures.
- Declare capabilities such as images, parallel tool calls, prompt caching, and supported reasoning controls.

V0 includes a deterministic scripted provider for tests and the complete provider-neutral streaming contract. Concrete LLM transports, authentication, model discovery, subscriptions, and API-key handling are deliberately deferred until the harness behavior is proven. Later provider integrations must implement this boundary without changing the agent loop.

## Built-in Tools

V0 provides a deliberately small tool set:

- `read_file`: read a bounded file range.
- `list_files`: list files using bounded patterns.
- `search_text`: search repository text with bounded output.
- `apply_patch`: create, modify, or delete workspace files through explicit patches.
- `run_command`: execute a command with working directory, timeout, output limit, and cancellation.
- `git_status`: inspect repository state.
- `git_diff`: inspect current changes.

Every tool has a stable name, description, input schema, result schema, timeout policy, output limit, and permission category. Tool output is truncated deterministically before it is sent back to the model, while the user-facing event may retain a larger bounded record.

`apply_patch` enforces read-before-write. An existing file must have been read during the current turn, and the patch carries the observed content hash. If the file changed after that read, the patch fails instead of overwriting newer work.

The tool registry is extensible internally, but there is no public plugin marketplace or third-party plugin loading in v0.

## Permissions and Execution Safety

V0 exposes three user-facing permission modes:

- **Ask Always**: the default. Normal project reads are allowed, but every file change and shell command requires confirmation. Sensitive-file reads, network access, external paths, destructive commands, credential access, and deployment are denied unless the user explicitly approves the individual action.
- **Approved for Me**: normal project reads and writes plus recognized safe local development commands run automatically. Network access, external paths, sensitive files, destructive commands, credential access, and deployment still require confirmation or remain denied. This is the practical everyday mode.
- **Full Access**: tools can read, write, execute commands, use the network, and access paths without routine approval prompts. Selecting this mode requires an explicit warning confirmation. Secret redaction, event logging, cancellation, and step/time/token limits remain active because they are integrity controls rather than permission restrictions.

The active mode is session state and may be changed with `/permissions`. Permission grants in Ask Always or Approved for Me can apply once or to a narrow reusable command/path pattern for the current session. Full Access never silently becomes the default for a new project.

The policy engine receives normalized tool intent rather than raw model prose. A model cannot bypass the policy by changing how it describes an action.

V0 defines the permission interface and enforces workspace boundaries in the tools. Strong operating-system sandbox backends are a subsequent security slice because they require platform-specific implementation and validation.

## Plan and Act Modes

Recurs has two execution modes that are separate from the three permission modes:

- **Act mode** is the normal coding mode. The active permission mode decides which reads, edits, commands, network actions, and external paths are allowed.
- **Plan mode** is enforced read-only exploration. It exposes project reads, listing, text search, `git_status`, and `git_diff`; it hides or denies `apply_patch` and `run_command`. A system-prompt change alone is never considered sufficient enforcement.

`/plan [prompt]` enters Plan mode and may immediately submit a planning request. `/plan exit` returns to Act mode and restores the permission mode that was active before planning. The conversation and active goal remain intact across the transition. V0 uses the same selected model in both modes; separate plan and act model routing is a later optimization.

## Sessions, Events, and Recovery

Sessions use a storage interface with an append-only JSONL implementation in v0. Records are versioned and human-inspectable. Durable records are appended and flushed at message, tool-call, permission, and turn boundaries. On recovery, a trailing partial record is quarantined and earlier valid records remain usable.

The event model includes:

- Session and turn lifecycle events.
- Model stream and completion events.
- Tool requested, started, completed, failed, or denied events.
- Permission requested and resolved events.
- Goal created, updated, paused, completed, failed, or cleared events.
- Usage, warning, retry, cancellation, and error events.
- Changed-file and verification-evidence events.

Streaming text deltas are sent to clients but do not need to be individually persisted. Completed messages and tool records are the durable source of truth.

After an interruption, Recurs resumes from the last committed boundary. An interrupted tool call is marked incomplete and is never silently assumed to have succeeded.

Before each mutating tool, Recurs creates a workspace checkpoint outside the project Git history. The checkpoint records the bounded file state and hashes needed to compare and restore agent changes. `/undo` restores the most recent agent checkpoint only when affected files still match the agent-produced hashes; if the user changed a file afterward, Recurs refuses to overwrite it and shows the conflict. Checkpoints never commit to, reset, or clean the user's Git repository.

## `/goal`

`/goal` is the v0 long-running-work primitive. Recurs does not add `/loop` initially.

A goal contains:

- Objective.
- Status: active, paused, completed, failed, or cancelled.
- Creation and update times.
- Optional step, time, and token budgets.
- Progress summary.
- Blockers.
- Completion evidence.

The active goal is injected into each turn as structured context. It does not automatically make the agent run forever. A run still ends normally and can be continued later against the same durable goal.

Initial syntax:

```text
/goal <objective>
/goal
/goal pause
/goal resume
/goal complete
/goal clear
```

Replacing an unfinished goal requires confirmation. A goal can only be marked complete with a final summary and whatever verification evidence the completed work produced.

## Initial Slash Commands

Commands are local control operations, not prompts disguised as commands. The command router supports parsing, aliases, inline arguments, interactive prompts, availability during an active run, and future registration without coupling commands to the TUI.

V0 commands are:

- `/help`: list commands and concise usage.
- `/goal`: manage the durable project goal.
- `/plan`: enter enforced read-only planning or return to Act mode.
- `/permissions`: inspect or change the current permission preset.
- `/status`: show session, goal, model, context, usage, and permission state.
- `/init`: create a minimal `AGENTS.md` when one does not exist.
- `/new`: start a new session in the current project.
- `/resume`: select a persisted session.
- `/compact`: summarize older context while retaining recent turns.
- `/diff`: show current repository changes.
- `/review`: ask the active model to review the current diff without automatically changing it.
- `/undo`: restore the most recent safe agent checkpoint without changing conversation history.
- `/cancel`: stop the active run at the next safe boundary.
- `/quit` and `/exit`: close the CLI cleanly.

Commands for agents, plugins, memory, session branching, background jobs, scheduling, themes, and branded aliases are deferred until their underlying capabilities exist.

The CLI also exposes a non-interactive `recurs run <prompt> --format text|jsonl` path over the same command router, agent loop, permission engine, events, and session store. JSONL output emits normalized events for scripts without inventing a second execution path.

## Errors and User Feedback

Errors are normalized into provider, tool, permission, storage, context, cancellation, and internal categories. Every error specifies whether it is retryable and preserves a safe underlying cause for diagnostics.

The CLI explains failures in plain language and suggests the next useful action. Technical logs redact known credential forms and remain separate from the conversational transcript.

## Verification Strategy

The first implementation is test-driven around a scripted fake model. Required test coverage includes:

- A text-only response completes one turn.
- One and multiple tool calls execute and feed results back to the model.
- Invalid tool names and arguments never execute.
- Ask Always, Approved for Me, and Full Access enforce their exact read, write, shell, network, external-path, sensitive-file, and destructive-action behavior.
- Permission allow, ask, deny, once, and narrow session grants behave correctly.
- Plan mode hides and rejects mutating tools, then restores the previous permission mode on exit.
- Read-before-write rejects a patch when the observed file hash is missing or stale.
- Cancellation, timeout, retry, maximum-step, and repeated-call guards stop safely.
- Loop detection includes normalized tool inputs and results rather than tool names alone.
- Multiple tool calls preserve deterministic event and message ordering.
- Sessions resume from committed boundaries after simulated interruption.
- `/undo` restores agent changes but refuses to overwrite later user edits.
- `/goal` persists and is injected into later turns.
- Every initial slash command parses and dispatches correctly.
- Compaction preserves the goal, recent work, changed files, and unresolved blockers.
- An end-to-end temporary-repository test reads a file, applies a patch, runs a verification command, and returns the resulting diff.

No completion claim is made until unit tests, type checking, linting, and the end-to-end harness test pass.

## Explicitly Deferred

- Recursive multi-agent orchestration and the agent-company hierarchy.
- Public plugins, MCP installation, hooks, and a marketplace.
- Desktop UI and IDE integrations.
- Cloud execution and remote workers.
- Real LLM transports, API-key authentication, model selection, and subscription-backed Codex, Claude Code, Gemini, or ACP adapters.
- Strong OS-specific sandboxes and containers.
- Scheduled or endless loops.
- Branded command renaming.
- Voice, images, deployment, billing, collaboration, and analytics.

These features must extend the core interfaces rather than require a second harness.

## Acceptance Criteria

Recurs Core v0 is complete when the CLI can run in a Git repository with an injected provider implementation, set a goal, execute a bounded scripted coding change through the real agent loop, show tool activity and approvals, review the diff, resume the session after restarting, and pass the automated end-to-end verification. Connecting that provider boundary to live LLMs is the next product layer.
