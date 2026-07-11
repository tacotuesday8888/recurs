# Recurs CLI

Recurs Core v0 is a provider-neutral coding-agent harness. The CLI, agent loop, tools, permissions, Plan mode, durable sessions, goals, checkpoints, structured output, and a credential-free local model transport are implemented.

The executable starts in a sessionless workspace shell when no provider is available. Coding prompts require a configured literal-loopback local server or an injected `ModelProvider`; no fake `unconfigured` session is written.

## Install from source

Requirements:

- Node.js 22.22 or newer. Node.js 24 LTS is supported.
- Git 2.45 or newer. Protected Git operations fail with a typed error on older
  versions because their lazy-fetch suppression is unavailable.
- ripgrep (`rg`) for file listing and text search.

Build and inspect the CLI:

```bash
npm install
npm run check
npm run build
node packages/cli/dist/main.js --help
```

You can expose the root package's `recurs` binary locally with `npm link` after building. No package or installer is published today. An npm package is the likely first preview channel. Bun may later install that npm package, but Node remains the supported runtime and Bun runtime compatibility has not been implemented. Homebrew and curl wait for versioned, signed artifacts; Windows packaging remains later work.

The repository does not yet contain a license. Although it is intended to become open source, it remains source-available rather than legally open source until the owner selects and adds a license.

## Provider boundary

Recurs does not currently ask for an API key or connect to Codex, Claude, GLM, Gemini, or another hosted service. It also does not attempt to reuse coding-agent subscriptions.

The CLI can verify and save one credential-free OpenAI-compatible server bound to literal `127.0.0.1` or `[::1]`. It refuses DNS names, LAN/remote addresses, HTTPS, URL credentials, queries, fragments, and redirects. Direct, coding-plan, subscription, OAuth, and cloud-identity connections remain blocked on the separately tested native broker/storage and OS tool-sandbox boundary.

For Ollama, start the server, ensure the model is installed, then run:

```bash
recurs setup local --url http://127.0.0.1:11434/v1 --model qwen2.5-coder:7b
```

For LM Studio, enable its local server and use its displayed model identifier:

```bash
recurs setup local --url http://127.0.0.1:1234/v1 --model <model-id>
```

Setup reads `/models`, requires an exact model match, and writes only non-secret endpoint/model metadata under `RECURS_HOME`. Restart Recurs after changing the configured local model.

A host injects a provider that implements:

```ts
interface ModelProvider {
  readonly id: string;
  stream(request: ProviderRequest): AsyncIterable<ProviderEvent>;
}
```

The normalized request contains the model name, immutable message snapshot, visible tool definitions, and an abort signal. The stream returns text/reasoning deltas, normalized tool calls, usage, and one terminal event. `ScriptedProvider` supplies deterministic responses for tests and embedded development.

`createStandaloneRuntime(eventSink, { provider, model })` is the current test/embedding assembly point for an injected provider. It creates an immutable version-2 backend pin and resolves that exact pin before each run. Launching the compiled CLI without one keeps workspace commands available, but `recurs run <prompt>` exits with configuration code `2` before persisting the prompt. JSONL mode emits one `configuration_error` object without prose on standard output.

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

The prompt examples require a configured local provider or an injected provider. `--format jsonl` emits the same normalized events used by the interactive runtime; it is not a separate agent path.

Exit codes:

- `0`: success.
- `1`: terminal agent or provider failure.
- `2`: usage or provider-configuration failure.
- `130`: cancellation.

## Permissions

Every tool reports normalized intent before execution. `/permissions` selects one of three session presets:

| Mode | Behavior |
| --- | --- |
| Ask Always | Project reads run normally. Every write and shell command asks. Sensitive files, network, external paths, deployment, and destructive actions also ask. Classified credential paths are denied. This is the default. |
| Approved for Me | Normal guarded project reads/writes run automatically. Every shell command asks while Recurs has no OS sandbox. Network, external, sensitive, deployment, and destructive actions also ask. Classified credential paths are denied. |
| Full Access | Routine workspace, command, network, deployment, and destructive prompts are skipped after explicit confirmation. Sensitive and external paths still ask, and classified credential paths are denied. Integrity controls remain enabled. Arbitrary shell commands are not OS-isolated and may still access host files or the network indirectly, so this preset is not credential-safe. |

An explicit outside path can run only after its external-path intent is approved, including in Full Access. A hidden symlink escape remains blocked because the model did not request that outside path explicitly.

Credential classification is shared across direct and aggregate built-in operations. It covers `.env` and `.env.*`, common private-key and credential filenames, certificate/key suffixes, and auth directories such as `.ssh`, `.aws`, `.azure`, `.docker`, `.gnupg`, `.kube`, and `.config/gcloud`, case-insensitively. Slash and literal-backslash path variants use the same exclusions. Direct or canonical classified targets are denied. List, search, Git status/diff, and checkpoint enumeration exclude them. Patch accepts exact slash-separated declarations without surrounding whitespace or backslashes, rejects rename/copy operations, denies canonical credential aliases before checkpoint capture, and requires Git's complete parsed path set to equal the declared revision-checked files before mutation. Configured `sensitivePatterns` remain a separate approvable policy.

This protects the built-in interfaces only. A permitted shell script can spell, discover, or open any host path available to the current user, regardless of the path classifier.

## Tool security profiles

The embedding assembly option `toolSecurityProfile` has two values:

| Profile | Behavior |
| --- | --- |
| `local_guarded` | Default. Advertises the registered tools and applies Plan mode, permission evaluation, path checks, process bounds, and checkpoints. Arbitrary commands still retain host authority. |
| `tools_disabled` | Advertises no model tools and rejects every direct model-tool invocation before parsing, permissions, or checkpoint capture. This is fail-closed but is not a useful coding profile. |

Every fixed or arbitrary child process receives a fresh private home, config, cache, and temporary directory plus only a filtered absolute `PATH` and selected locale/terminal variables. It does not inherit the real home, parent `SHELL`, cloud/provider variables, proxies, sockets, Git config variables, or workspace-contained `PATH` entries. `/bin/sh -c` is used for `run_command` on macOS and Linux; it is not a login shell. Recurs terminates the process group on completion, cancellation, timeout, or output overflow, bounds output-pipe draining, destroys its pipe handles, and then performs synthetic-tree cleanup. A descendant that deliberately enters another process group or session can survive this application-level cleanup; preventing that requires the later OS containment boundary. Subprocess tools fail with a typed unsupported-platform error on Windows.

Fixed Git operations first require Git 2.45 or newer, then pin the requested worktree and disable optional index writes, lazy object fetching, repository hooks, fsmonitor commands, external diff/text conversion, configured clean/smudge/process filters, and expanded dirty-submodule diffs. Recurs enumerates filter key names only and replaces their commands with empty command-line overrides before status, diff, patch, or checkpoint Git work; configured command values are never returned to the harness. This preflight is not protection against a hostile same-user process racing repository configuration.

Environment cleanup prevents direct inheritance, but it is not an OS sandbox. A child can still use the user's filesystem, network, IPC, and process-inspection authority. No live provider credential may enter the current Recurs process under either profile.

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
| `/diff [--staged] [path]` | Show a bounded Git diff without repository hooks, filters, external diff/text conversion, or expanded dirty-submodule content. |
| `/review` | Submit staged/unstaged changes for a temporary read-only review. |
| `/undo` | Restore the latest checkpoint that actually changed files. |
| `/cancel` | Abort the current provider/tool run. |
| `/quit`, `/exit`, `/q` | Exit the interactive CLI. |

Before a provider is configured, the workspace shell exposes only `/help`, `/connect`, `/model`, `/permissions`, `/status`, `/resume` listing, `/init`, `/diff`, and exit commands. `/connect` gives the credential-free local setup command; `/model` reports that no connection is active.

## Sessions and recovery

By default, project data lives under:

```text
~/.recurs/projects/<workspace-hash>/
```

Set `RECURS_HOME` to move the Recurs data root. New session logs use strict version-2 append-only JSONL. Sequence zero pins the provider lane, connection, adapter, account fingerprint, model identity, billing choice, catalog, and policy revisions. Every mutation holds a cross-process lock and exact sequence; stale or concurrent writers fail. Version-1 logs remain readable and listable but cannot be changed.

Completed messages and tool/permission/turn boundaries are flushed to disk. A partial final JSONL record is quarantined during recovery; committed corruption in the middle fails loudly. Before the next turn, pending tools receive durable failure results and the prior open turn is closed as interrupted. An orphaned compaction is closed locally with unknown usage and never retried automatically.

Compaction is also append-only: the log keeps the audit history, while replay replaces active context with the summary plus retained recent messages.

## Checkpoints and undo

Every potentially mutating tool is wrapped with before/after workspace snapshots. Checkpoint data is content-addressed and kept outside the project and outside `.git`. Git is used only to enumerate tracked and non-ignored untracked project files; raw Git names plus canonical parent and regular-file targets are classified before Recurs reads workspace content or writes a blob. Recurs never creates commits, resets, cleans, or checks out the user's repository for checkpointing.

Fresh checkpoint stores contain a private `.format.json` marker for format version 2 with credential exclusion enabled. A nonempty unversioned store, invalid or symlinked marker, or unknown marker version is rejected without scanning, rewriting, deleting, or blessing its contents. Recurs creates the marker before the first version-2 capture, but the marker is an unauthenticated upgrade assertion rather than proof about the store's contents. Do not copy or create a marker in a legacy store.

For this unreleased `0.0.0` format, recovery is an explicit manual reset:

1. Exit every Recurs process using the project.
2. From the exact workspace root, derive and verify its checkpoint directory with the command below.
3. Move its `checkpoints` directory to a private backup outside any repository. Do not attach, publish, or inspect it with model tools; legacy data may contain secrets.
4. Restart Recurs. The next mutating tool creates a fresh marked store.

The CLI derives the project ID from the SHA-256 digest of the canonical workspace path. This command reproduces that calculation and honors `RECURS_HOME`:

```bash
CHECKPOINT_DIR="$(
  node --input-type=module -e '
    import { createHash } from "node:crypto";
    import { realpathSync } from "node:fs";
    import { homedir } from "node:os";
    import path from "node:path";

    const workspace = realpathSync(process.cwd());
    const projectId = createHash("sha256")
      .update(workspace)
      .digest("hex")
      .slice(0, 24);
    const root = process.env.RECURS_HOME ?? path.join(homedir(), ".recurs");
    process.stdout.write(path.join(root, "projects", projectId, "checkpoints"));
  '
)"
printf 'Checkpoint directory for this workspace:\n%s\n' "$CHECKPOINT_DIR"
```

Inspect the printed path before moving anything. If an embedding application supplies `dataDirectory` programmatically, substitute that directory for the data root because the shell command cannot discover it. Choose a backup root outside every repository; the default below is independent of `RECURS_HOME`. Then create a private directory and collision-resistant backup name before moving the rejected store:

```bash
umask 077
BACKUP_ROOT="${RECURS_CHECKPOINT_BACKUP_ROOT:-$HOME/.recurs-legacy-backups}"
mkdir -p "$BACKUP_ROOT"
chmod 700 "$BACKUP_ROOT"
BACKUP="$BACKUP_ROOT/checkpoints-legacy-$(node --input-type=module -e '
  import { randomUUID } from "node:crypto";
  process.stdout.write(randomUUID());
')"
mv "$CHECKPOINT_DIR" "$BACKUP"
printf 'Moved legacy checkpoints to:\n%s\n' "$BACKUP"
```

Recurs does not perform this move automatically. The marker is an upgrade-safety invariant, not hardened secret storage.

`/undo` skips newer no-op checkpoints and selects the latest checkpoint that changed files. Before writing anything, it verifies that every affected path still matches the agent-produced after-state. If the user changed one path, replaced a parent with an outside-pointing symlink, or made a canonical parent/target credential-classified, the entire undo is refused before restoration begins. Missing credential targets are conflicts rather than being mistaken for the expected absent state.

## Current safety limits

- The current guard is application-level path/permission enforcement and clean child state, not a strong OS sandbox or container.
- `local_guarded` arbitrary commands have host filesystem, network, IPC, and process authority. Shell classification is conservative but cannot prove scripts safe. Every shell command requires approval outside Full Access until an enforceable sandbox exists.
- Permanent credential-path denial covers built-in tools, not indirect shell access. Neither Full Access nor `tools_disabled` makes this process safe to hold a live provider credential.
- Node pathname validation and an opaque TypeScript object cannot provide hardened auth storage. Credential-bearing providers require descriptor-relative no-follow I/O, ownership/mode/ACL/full-parent validation, filesystem capability checks, a native non-exporting broker, and an OS tool sandbox.
- Checkpoints enumerate Git tracked and non-ignored untracked files; ignored files are not restored by checkpoint undo.
- Output, read, patch, command-time, and agent-step limits are bounded, but very large repositories can still make full snapshots expensive.
- There is no secret vault, API-key flow, live provider transport, model picker, subscription adapter, plugin system, public MCP loading, multi-agent company runtime, desktop app, cloud worker, scheduler, or endless `/loop` in v0.
