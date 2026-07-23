# Recurs CLI

Recurs is a TypeScript coding-agent harness for interactive work, bounded
headless runs, repository review, and durable agent teams.

## Install from source

Requirements:

- Node.js 22.22 or newer
- Git 2.45 or newer
- ripgrep
- Bubblewrap on Linux for subprocess tools

```bash
git clone https://github.com/tacotuesday8888/recurs.git
cd recurs
npm ci
npm run build
npm link
recurs
```

Recurs is an unpublished alpha. No npm, Homebrew, curl, signed binary, or
desktop release is available yet.

## First run

Run `recurs` or `recurs setup` in a local terminal. Guided setup:

1. discovers saved accounts and local runtimes;
2. offers reviewed provider paths;
3. selects permissions and an operating mode;
4. proposes specialist routing;
5. optionally forms a project-specific company; and
6. reads or creates project context.

Setup is local and user-present. Automation environments cannot drive the
interactive flow.

## Provider access

Recurs has three connection families:

- **Local:** credential-free OpenAI-compatible servers on literal loopback.
- **BYOK:** reviewed fixed-origin adapters using a named environment variable.
- **Delegated:** vendor-owned runtimes such as Codex with ChatGPT.

```bash
recurs setup local \
  --url http://127.0.0.1:11434/v1 \
  --model qwen-coder

recurs setup byok \
  --provider openai-api \
  --model gpt-5.6-sol \
  --key-env OPENAI_API_KEY

recurs setup codex
```

BYOK stores provider/model metadata, the environment-variable name, and a
one-way credential fingerprint. It never stores the key value. The same named
value must be present and match the fingerprint when a run starts.

Supported fixed-origin adapters include reviewed OpenAI Responses, Anthropic
Messages, Gemini GenerateContent, and OpenAI Chat-compatible providers.
Provider manifests that lack an implemented adapter remain blocked.

Inspect provider state without configuring it:

```bash
recurs provider list [--all] [--json]
recurs provider catalog [query] [--json]
recurs provider detect [--json]
recurs provider models --provider <id> --key-env <ENV> [--json]
recurs doctor [--json]
```

Recurs does not automatically rank models, silently select providers, or
fallback across billing sources.

## Saved accounts

```bash
recurs account list [--json]
recurs account set-primary <id>
recurs account route <implement|review|repair> <id|parent>
recurs account verify <id>
recurs account disconnect <id>
```

Changing the primary affects future sessions. Existing sessions retain their
original immutable backend pin.

## Interactive sessions

```bash
recurs [-C /path/to/project]
```

Common slash commands:

```text
/help
/status
/model
/permissions
/agents
/goal
/checkpoint
/process
/image
/undo
/fork
/quit
```

Use `/help <command>` inside the CLI for the exact current syntax.

## Headless runs

```bash
recurs run "inspect the repository" --plan
recurs run "fix the failing test" --permissions approved
recurs run "describe this screenshot" --image ./screen.png
recurs run "continue" --resume <session-id>
recurs run - --format jsonl
```

Useful options:

- `-C <dir>` selects one canonical working root.
- `--plan` enforces read-only execution for a fresh session.
- `--permissions ask|approved|full` selects the permission profile.
- `--mode economy|standard|balanced|performance|max` selects the operating
  mode.
- `--connection <id>` selects one saved connection.
- `--format text|json|jsonl` selects output framing.
- `--stdin` appends bounded piped input.
- `--image <path>` attaches PNG, JPEG, or WebP input.

JSONL streams normalized events and ends with one terminal result or error.
Structured output contains no extra prose on standard output.

## Review

```bash
recurs review [-C /path/to/project]
```

Review creates a fresh Plan session, reads bounded staged and unstaged Git
diffs, and uses the hardened Git tools. It does not accept an arbitrary prompt,
stdin, images, or resume.

## Permissions and modes

Permission profiles:

- `ask` asks before changes and commands.
- `approved` automates routine work inside the active boundary.
- `full` skips routine prompts inside that boundary.

Plan mode remains read-only regardless of the permission profile. Act mode may
use mutating tools according to the active profile.

Operating modes freeze team width, role routing, model eligibility, request
budgets, review/repair policy, and reported-cost limits before execution.
Children cannot widen their parent’s permissions.

## Agent teams

Recurs can run bounded Explore, Implement, Review, and Repair specialists.
Implement workers use isolated Git worktrees. Review is independent and
read-only. Repair is allowed only by the active versioned policy. The parent
retains apply authority.

Background team work is process-lifetime work, not a daemon. Durable journals
allow explicit resume, inspection, and apply after interruption.

## Company commands

Company onboarding proposes a project-specific roster and authority graph
before activation. The CLI supports status, activity, knowledge, amendments,
goals, and exact-run inspection through the interactive command surface.

Offline evaluation is deterministic:

```bash
recurs eval company --list [--json]
recurs eval company [--scenario company_formation_v1] [--json]
recurs eval company --configured --allow-network \
  [--connection <id>] [--json]
recurs eval company --scenario company_goal_execution_v1 \
  --run <id> [--json]
```

Configured evaluation requires an explicit network opt-in.

## ACP

```bash
recurs acp
```

The ACP endpoint serves the real Recurs runtime over stdio. Editor transport
does not prove user presence, so user-present-only provider paths fail closed.

## Agent Skills and MCP

Agent Skills are bounded text/resource context. They do not grant tools or
execute arbitrary code merely by being installed.

Approved stdio MCP servers are launched with a filtered environment, bounded
messages, digest-bound configuration, explicit tool names, and the active
permission policy. Server metadata and results are untrusted data.

## Tools and subprocesses

Built-in tools enforce canonical workspace paths, bounded input/output, and
credential-path denial. Subprocesses receive a private synthetic home and a
filtered environment.

- macOS subprocesses use Seatbelt.
- Linux subprocesses use Bubblewrap and a fresh network namespace unless the
  approved command requires network.
- Windows subprocess tools are unsupported and fail closed.

PTY attachment is a bounded relay for interactive commands, not a complete
terminal emulator or a safe hidden-input channel.

## Sessions, checkpoints, and recovery

Sessions are append-only and preserve their backend, working root, permissions,
and operating mode. Checkpoints bind workspace state before mutating work.
Undo restores a verified checkpoint rather than blindly rewriting files.

Startup recovery validates session, worktree, lease, assignment, artifact, and
base-revision bindings before resuming durable work or applying a candidate.

Private session logs can contain prompts, tool arguments, and repository
content. See [SECURITY.md](../SECURITY.md) for the storage and credential
boundary.

## Current limits

- Recurs is source-only alpha software.
- Windows subprocess containment is not implemented.
- There is no desktop app, cloud worker, persistent daemon, scheduler, or
  unattended deployment system.
- Provider discovery does not make an unimplemented transport runnable.
- Delegated runtimes remain limited to their reviewed host-tool contract.
- Agent Skills are context, not executable plugins.
- MCP marketplace installation and remote OAuth are not implemented.

The code-backed capability inventory lives in
[FEATURE_STATUS.md](FEATURE_STATUS.md).
