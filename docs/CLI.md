# Recurs CLI

Recurs Core v0 is a provider-neutral coding-agent harness. The CLI, agent loop, tools, permissions, Plan mode, durable sessions, goals, checkpoints, and structured output are implemented. A live LLM transport is intentionally not bundled yet.

The executable can run local slash commands today. Coding prompts require a host application or test harness to inject an implementation of the `ModelProvider` interface.

## Install from source

Requirements:

- Node.js 22.22 or newer. Node.js 24 LTS is supported.
- Git.
- ripgrep (`rg`) for file listing and text search.

Build and inspect the CLI:

```bash
npm install
npm run check
npm run build
node packages/cli/dist/main.js --help
```

You can expose the root package's `recurs` binary locally with `npm link` after building. Homebrew, curl installers, signed release artifacts, and Windows packaging are later distribution work; they are not available in v0.

## Provider boundary

Recurs does not currently ask for an API key, select a model, or connect to Codex, Claude, GLM, Gemini, or another hosted service. It also does not attempt to reuse coding-agent subscriptions.

A host injects a provider that implements:

```ts
interface ModelProvider {
  readonly id: string;
  stream(request: ProviderRequest): AsyncIterable<ProviderEvent>;
}
```

The normalized request contains the model name, immutable message snapshot, visible tool definitions, and an abort signal. The stream returns text/reasoning deltas, normalized tool calls, usage, and one terminal event. `ScriptedProvider` supplies deterministic responses for tests and embedded development.

`createStandaloneRuntime(eventSink, { provider, model })` is the current assembly point for an injected provider. Launching the compiled CLI without one keeps local slash commands available, but `recurs run <prompt>` exits with configuration code `2` and explains that no live provider is connected.

## Start and run

Interactive mode:

```bash
node packages/cli/dist/main.js
```

One non-interactive run:

```bash
node packages/cli/dist/main.js run "inspect the repository" --format text
node packages/cli/dist/main.js run "inspect the repository" --format jsonl
```

The standalone prompt examples require an injected provider. `--format jsonl` emits the same normalized events used by the interactive runtime; it is not a separate agent path.

Exit codes:

- `0`: success.
- `1`: terminal agent or provider failure.
- `2`: usage or provider-configuration failure.
- `130`: cancellation.

## Permissions

Every tool reports normalized intent before execution. `/permissions` selects one of three session presets:

| Mode | Behavior |
| --- | --- |
| Ask Always | Project reads run normally. Every write and shell command asks. Sensitive files, network, external paths, credentials, deployment, and destructive actions also ask. This is the default. |
| Approved for Me | Normal guarded project reads/writes run automatically. Every shell command asks while Recurs has no OS sandbox. Network, external, sensitive, credential, deployment, and destructive actions also ask. |
| Full Access | Routine prompts are skipped after explicit confirmation. The model may access credentials, inherited host environment values, the network, and external paths. Integrity controls—logging, cancellation, budgets, stale-write checks, path validation, and checkpoint conflict checks—remain enabled. |

An explicit outside path can run after its external-path intent is approved or in Full Access. A hidden symlink escape remains blocked because the model did not request that outside path explicitly.

## Plan and Act modes

Act mode is normal coding. Plan mode is enforced read-only at the tool registry:

- Available: file reads/listing/search and Git status/diff.
- Hidden and denied: patching and shell commands.

`/plan [prompt]` enters Plan mode and can immediately submit a planning prompt. `/plan exit` restores the permission preset that was active before planning. `/review` uses a temporary read-only override without changing the stored Act/Plan mode.

## Goals

`/goal` is the durable long-running-work primitive:

```text
/goal <objective>
/goal
/goal pause
/goal resume
/goal complete
/goal clear
```

Replacing or clearing an unfinished goal requires confirmation. Each successful agent turn records its final progress summary and its own verification evidence into the active goal. Completion is rejected until that goal—not an older conversation—contains both.

## Slash commands

| Command | Purpose |
| --- | --- |
| `/help` | Show concise command help. |
| `/goal ...` | Create, inspect, pause, resume, complete, or clear the durable goal. |
| `/plan [prompt\|exit]` | Enter enforced read-only planning or return to Act. |
| `/permissions [ask\|approved\|full]` | Inspect or change the permission preset. |
| `/status` | Show session, workspace, model identifier, modes, goal, usage, and pending tools. |
| `/init` | Confirm and create a starter `AGENTS.md`; never overwrite an existing path. |
| `/new` | Start a new durable session in the same workspace. |
| `/resume [id]` | List sessions newest-first or resume one exact ID. Prefix matching is not used. |
| `/compact` | Ask the injected provider for a continuation summary and retain roughly the latest six messages without splitting tool-call/result groups. |
| `/diff [--staged] [path]` | Show a bounded Git diff without external diff or text-conversion programs. |
| `/review` | Submit staged/unstaged changes for a temporary read-only review. |
| `/undo` | Restore the latest checkpoint that actually changed files. |
| `/cancel` | Abort the current provider/tool run. |
| `/quit`, `/exit`, `/q` | Exit the interactive CLI. |

## Sessions and recovery

By default, project data lives under:

```text
~/.recurs/projects/<workspace-hash>/
```

Set `RECURS_HOME` to move the Recurs data root. Session logs are versioned, append-only JSONL. Completed messages and tool/permission/turn boundaries are flushed to disk. A partial final JSONL record is quarantined during recovery; committed corruption in the middle of a log fails loudly. Before the next turn, pending tool calls are closed as interrupted and any assistant tool call without a result receives a synthetic interrupted result so resumed provider history remains valid.

Compaction is also append-only: the log keeps the audit history, while replay replaces active context with the summary plus retained recent messages.

## Checkpoints and undo

Every potentially mutating tool is wrapped with before/after workspace snapshots. Checkpoint data is content-addressed and kept outside the project and outside `.git`. Git is used only to enumerate tracked and non-ignored untracked project files; Recurs never creates commits, resets, cleans, or checks out the user's repository for checkpointing.

`/undo` skips newer no-op checkpoints and selects the latest checkpoint that changed files. Before writing anything, it verifies that every affected path still matches the agent-produced after-state. If the user changed one path—or replaced a parent with an outside-pointing symlink—the entire undo is refused before restoration begins.

## Current safety limits

- The current guard is application-level path/permission enforcement, not a strong OS sandbox or container.
- Shell classification is conservative but cannot prove arbitrary scripts safe. Every shell command requires approval outside Full Access until an enforceable sandbox exists.
- Checkpoints enumerate Git tracked and non-ignored untracked files; ignored files are not restored by checkpoint undo.
- Output, read, patch, command-time, and agent-step limits are bounded, but very large repositories can still make full snapshots expensive.
- There is no secret vault, API-key flow, live provider transport, model picker, subscription adapter, plugin system, public MCP loading, multi-agent company runtime, desktop app, cloud worker, scheduler, or endless `/loop` in v0.
