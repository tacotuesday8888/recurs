# Recurs CLI

Recurs is a TypeScript coding-agent harness for interactive work, bounded
headless runs, repository review, and durable agent teams.

This guide follows the published `0.1.0-alpha.11` release.

## Install

Requirements:

- Node.js 22.22 or newer
- Git 2.45 or newer
- ripgrep
- Bubblewrap on Linux for subprocess tools

The shortest supported path is npm:

```bash
npm install --global recurs@alpha
recurs
```

`--global` only makes the `recurs` command available from any directory.
Use the `@alpha` tag explicitly: npm `alpha` selects `0.1.0-alpha.11`, while
unqualified `latest` remains `0.1.0-alpha.2` (verified September 9, 2026).
The [product polish release record](PRODUCT_POLISH.md) includes the published artifact's
integrity, provenance, and fresh installation checks.

The same reviewed npm artifact is also available through Bun-as-installer, the
checksummed GitHub release installer, and Homebrew:

```bash
bun install --global recurs@alpha
curl -fsSL https://github.com/tacotuesday8888/recurs/releases/download/v0.1.0-alpha.11/install.sh | sh
brew install tacotuesday8888/recurs/recurs
```

All four paths require Node.js. Bun installs the package but is not a supported
Recurs runtime. There is no signed standalone binary or desktop release.

### Upgrade or uninstall

Use the same channel you installed from:

```bash
npm install --global recurs@alpha       # npm upgrade
bun install --global recurs@alpha       # Bun upgrade; Node still runs Recurs
brew update && brew upgrade recurs      # Homebrew upgrade
```

Rerun the checksum-verifying release installer to upgrade a curl installation.
To uninstall, use `npm uninstall --global recurs`,
`bun remove --global recurs`, or `brew uninstall recurs`. A curl installation
uses `${RECURS_INSTALL_PREFIX:-$HOME/.local}`; remove its `bin/recurs` and
`lib/node_modules/recurs` entries after checking that prefix.

Uninstalling the executable does not delete sessions or project state. Locate
that private directory before deciding whether to retain or remove it:

```bash
recurs data path
recurs data path --json
```

Stop Recurs, inspect the reported path, and delete it only when you no longer
need its sessions, checkpoints, provider-routing metadata, or company state.
See [Privacy and local data](../PRIVACY.md) for the complete boundary.

To run from source:

```bash
git clone https://github.com/tacotuesday8888/recurs.git
cd recurs
npm ci
npm run build
npm link
recurs
```

The Recurs JavaScript bundle remains gated below 2.10 MB. Runtime dependencies
are installed separately. Current source uses name-preserving variable
minification; final package and installation measurements are recorded in
[release readiness](RELEASE_READINESS.md). Source development also installs
Codex compatibility fixtures that are absent from a normal Recurs install.

## First run

Run `recurs` in a local terminal inside your project. Choose an existing
session or **Start new chat**. Without a configured model, setup discovers saved accounts and local
runtimes, connects your chosen model, and asks for a permission boundary.
Choose **Start coding** to begin immediately with bounded defaults.

For a tailored team, select an operating mode instead. Setup then offers team
limits, model routes, and optional Quick, Guided, or Deep project onboarding.
Quick keeps the interview short; Guided and Deep can inspect the project with
your consent before proposing roles and responsibilities. Review the complete
proposal with Page Up/Down before approving it. Approval saves configuration;
`/goal launch` starts the approved work.

Run `recurs setup` to revisit configuration or resume an interrupted interview.
Existing sessions keep their original backend pins. Returning users can open
their saved conversation without repeating setup. **Start new chat** reuses the
current model connection, permissions, and operating mode through `/new`.

Team setup shows the saved limits before editing them. Numeric prompts show
the allowed range; cancelling a limit prompt leaves the saved limits intact.
Role choices show the provider, model, saved reasoning effort, and current
assignment. Keep parent inheritance or explicitly choose an eligible specialist.
When no specialist is eligible, setup explains the mode's billing requirement.
Saved candidates are checked again when a child starts.

Recurs's release gate drives this exact first-run path through an installed npm
artifact with an empty private home and a deterministic local provider. The
proof includes layered implementation, independent change requests, Repair,
re-review, synthesis, approved application, and an external fixture test. It
requires no API key. When a company-owned goal receives exact apply authority,
the engine applies the reviewed candidate before returning; an `approved` team
shown by `/agents teams` is already applied.

### Terminal interface

The session launcher opens the parent conversation. Type a task, use `/` for
command completion, or complete file paths in the editor. Enter sends;
Shift+Enter inserts a newline. Page Up/Down scrolls history and Ctrl+End returns
to the latest output. Streaming output preserves your reading position.

- **Ctrl+G** opens the configured team tree. Roles without executions are
  labeled inactive; configured roles are not counted as running agents.
- **Ctrl+T** opens actual executions: ordinary children, batches, teams and
  company goals, including completed and failed history. The list groups each
  child beneath its exact execution parent; arrow keys select and keep the
  selected row visible. Counts describe recorded children, with the parent
  conversation at depth 0.
- **Enter** on an execution opens that exact session's durable transcript,
  model, permission boundary, changed files and evidence. The inspector also
  shows its exact parent, depth, recorded limits, usage availability, and
  containing team or company-goal recovery commands when available.
- **Ctrl+C** in a child inspector cancels that execution and its descendants
  when this process owns it. The inspector has no parent composer. Return to
  the parent to send instructions; targeted child steering is unavailable.
- **R** refreshes an inspected transcript. Escape returns to the execution list.
  In an empty parent composer, Escape returns to session navigation.
- **Ctrl+Q** quits. Ctrl+C in the parent conversation cancels its active turn.

Approval and agent questions are queued, and your draft returns afterward.
Vendor runtimes may expose only prompts and final responses; the inspector
states when internal traces are unavailable. Reopened work whose owner cannot
be established is marked unknown, with a recovery explanation. Unreadable
session logs produce an incomplete-history notice. These views do not create
new agents or grant additional authority.

`NO_COLOR`, `CLICOLOR=0`, and `TERM=dumb` disable presentation color. Set
`RECURS_NO_TUI=1` for the line-oriented interactive interface. Headless text,
JSON, JSONL and ACP remain available.

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

recurs setup byok \
  --provider alibaba-coding-plan \
  --model qwen3-coder-plus \
  --key-env DASHSCOPE_API_KEY

recurs setup byok \
  --provider minimax-token-plan \
  --model MiniMax-M2.7 \
  --key-env MINIMAX_API_KEY \
  --billing allow-additional

recurs setup codex
```

Alpha.8 also includes `recurs setup copilot`, backed by GitHub's official
Copilot SDK. Recurs keeps catalog presence, SDK availability, a configured
account, and a verified live account as separate states; it does not treat a
catalog entry or an installed SDK as proof that Copilot is ready. GitHub
Enterprise and unofficial credential discovery remain unsupported.

Codex subscription setup uses the separately installed official Codex CLI
`0.145.0` and its app-server. Recurs discovers that exact version on `PATH`;
`RECURS_CODEX_PATH` may instead name its absolute executable. If ChatGPT is not
already connected, Recurs presents the official one-time login URL and waits
for Codex to confirm it. Recurs does not receive or persist the vendor
credential.

Fresh setup saves the discovered Sol, Terra, and Luna connections and selects
the preferred parent. It does not assign Implement, Review, or Repair from
model names. Those routes continue to inherit the parent until the user runs
`recurs account route ...` or confirms an eligible Models Auto selection.
Refreshing setup preserves routes the user already chose.

BYOK stores provider/model metadata, the environment-variable name, and a
one-way credential fingerprint. It never stores the key value. The same named
value must be present and match the fingerprint when a run starts.

Coding-plan setup also preserves the reviewed policy acknowledgement. Alibaba
requires a separate confirmation of an active Coding Plan and runs only from a
local, manual, user-present CLI session. That saved confirmation applies to
future eligible sessions until the connection or reviewed policy changes.
MiniMax Token Plan requires the
documented prepaid-credit fallback to be accepted. These conditions are
rechecked before every run; saved credentials do not bypass them.

Supported fixed-origin adapters include reviewed OpenAI Responses, Anthropic
Messages, Gemini GenerateContent, and OpenAI Chat-compatible providers. The
guided provider screen groups subscriptions/coding plans, API keys/cloud
gateways, and local runtimes rather than treating public catalog metadata as a
detected local account.
Provider manifests that lack an implemented adapter remain blocked.

Inspect provider state without configuring it:

```bash
recurs provider list [--all] [--json]
recurs provider catalog [query] [--json]
recurs provider detect [--json]
recurs provider models --provider <id> --key-env <ENV> [--json]
recurs doctor [--json]
```

Recurs does not silently select providers or fallback across billing sources.
Its optional Models Auto path uses recorded successful company-goal evidence;
it does not invent a ranking from model names.

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
/agents routes
/agents controls
/agents configure topology=hierarchical active=6 concurrent=3
/goal
/goal launch
/company status
/company operations
/company run <run-id>
/company resume <run-id>
/company recommendations
/company recommendation <id>
/company approve-recommendation <id>
/company reject-recommendation <id>
/process
/image
/undo
/fork
/quit
```

Use `/help` inside the CLI for the exact current command list.

### Terminal presentation

Press **F2** or enter `/theme` while idle to preview system, dark, light, or
high-contrast colors. Enter saves; Escape restores the prior appearance and
preserves the draft. `/theme color accent #67e8f9` changes a semantic color.
See [appearance settings](APPEARANCE.md) for all roles, environment overrides,
private persistence, and no-color behavior.

Recurs uses pi-tui for differential rendering, input, bracketed paste and
completion. The application presents a conventional conversation, configured
team tree and separate execution inspector. It does not run decorative timers.
Terminal output is sanitized before presentation, and unknown usage or cost is
never represented as zero. Company handoff usage is labeled partial.

The current terminal acceptance record lives in [release readiness](RELEASE_READINESS.md).

### Recovering without guessing

Recurs records sessions and company goals durably, but it never assumes a
stopped terminal means remote work is still live. Start recovery with:

```bash
recurs doctor
recurs help recovery
```

Then inspect before changing state: `/status` and `/resume` cover an ordinary
session; `/company operations` lists unresolved company goals; and `/company
run <run-id>` shows assignment evidence, usage availability, failures, and the
next safe action. Only `/company resume <run-id>` resumes an exact interrupted
company goal. It reconciles the durable record and does not restart settled
work. If the connection needs attention, use `recurs provider detect`,
`recurs account list`, or `recurs setup`; Recurs does not display, import, or
reuse provider credentials outside the official, user-present connection flow.

### Choose a model or inspect role routes

In the local interactive terminal, `/model` opens saved connections in a picker.
Use Up/Down or Page Up/Down to browse, Enter to select, or Escape to cancel.
Entries show provider/model, saved reasoning effort when present, the active
connection, execution capability, and declared billing sources. Selection is
followed by confirmation and connection revalidation. A successful change
starts a fresh session; the previous conversation keeps its original pin and
remains available to resume. The saved primary connection is unchanged.

`/model <exact-connection-id>` takes the same confirmed path. Hosts without a
picker retain the text list; injected or ephemeral connections may not support
saved-model switching. Remote or automated invocations cannot switch models.

Use `/agents routes` to compare the current parent pin with saved Implement,
Review, and Repair assignments. It shows configured model/effort and exact
connection IDs, including missing connections that cannot be resolved. A saved
candidate is not a promise that a future child will use it: the operating mode,
credentials, and billing authority are checked at launch, with parent fallback
when required. Historical parent-only policies are identified explicitly.

Run `recurs setup` to change role assignments. To inspect what a child actually
used, open its execution or run `/agents inspect <session-id>`. Route changes do
not rewrite existing child pins. `/agents routes` performs no model request.

### Models Auto

Explicit `/model <connection-id>` selection remains available. The Auto alpha
uses exact immutable backend routes from completed company goals:

```text
/model auto status
/model auto evaluate <company-goal-run-id>
/model auto
```

`evaluate` records a configured goal only after its decomposition, evidence,
and synthesis can be inspected. `/model auto` then confirmation-gates the
most-supported eligible recorded configured four-role lineup and applies it to
future Parent/Implement/Review/Repair sessions. This is a structural selection,
not a comparative winner. Repair remains a configured fallback and may not
activate in a recorded run. Changed or missing connections fail closed. The
command shows the selected models, reasoning effort, evidence count, and
rationale. It does not change the current session. During a company goal, the
terminal also shows only agents that actually activate, their exact assigned
model and reasoning effort, the bounded route reason (role route, parent
fallback, or inherited parent model), and request/token/reported-cost usage as
it becomes available. One company/team child produces one activation line.

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

`/permissions` explains the active session boundary. A child agent can only
operate within its parent’s authority, its role profile, Plan-mode restrictions,
and OS containment; no child can widen those limits.

`recurs permissions` shows the exact rules active for the canonical workspace;
`recurs permissions --json` returns the same redacted status. The raw resource
is not displayed; a stable SHA-256 digest lets users correlate status with
their private configuration. Rules are loaded only from the private user file
`$RECURS_HOME/config/permissions.json`:

```json
{
  "version": 1,
  "workspaces": [
    {
      "workspace": "/canonical/path/to/project",
      "rules": [
        {
          "id": "tests",
          "decision": "allow",
          "category": "shell",
          "resource": "npm test",
          "risk": "normal"
        },
        {
          "id": "no-production",
          "decision": "deny",
          "category": "deploy",
          "resource": "production",
          "risk": "elevated"
        }
      ]
    }
  ]
}
```

Matching is exact across workspace, category, resource, and risk; there are no
wildcards. Configured rules are evaluated before reusable session grants and
the selected preset. Credential intents remain denied, destructive intents
cannot be persistently allowed, and Plan mode, role tool policies, parent
ceilings, path guards, and OS containment remain authoritative. Existing
sessions retain their loaded rule snapshot until a new runtime is created.
Persistent allows apply only to the root agent. Child agents retain exact ask
and deny rules while their inherited permission and profile ceilings remain in
force.

Operating modes freeze team width, role routing, model eligibility, request
budgets, review/repair policy, and reported-cost limits before execution.
Children cannot widen their parent’s permissions.

`/agents controls` distinguishes the saved preference, operating-mode ceiling,
and effective company policy. `/agents configure key=value …` and
`/agents reset` require an interactive local user and confirmation. Supported
advanced keys are topology, active agents, concurrency, depth, escalation,
independent review, repair rounds, requests, and reported cost. Changes apply
to future goals; every started goal keeps its immutable snapshot.

## Agent teams

Recurs can run bounded Explore, Implement, Review, and Repair specialists.
Implement workers use isolated Git worktrees. Review is independent and
read-only. Repair is allowed only by the active versioned policy. The parent
retains apply authority.

Background team work is process-lifetime work, not a daemon. Durable journals
allow explicit resume, inspection, and apply after interruption.

Company children may request a bounded handoff only for an assignment already
present in the approved DAG. They may escalate attributable evidence to their
direct manager; root escalation additionally requires the frozen
`root_allowed` policy.

## Company commands

Company formation is optional. When used, onboarding proposes a
project-specific roster and authority graph before activation; run
`recurs setup` to return to it later. The CLI supports status, operations,
activity, knowledge, amendments, goals, and exact-run inspection through the
interactive command surface.

After at least two compatible completed goals, Recurs may store one
evidence-backed recommendation that lowers future team limits. Inspect it with
`/company recommendations` and `/company recommendation <id>`. Approval or
rejection requires a local, manual, user-present CLI confirmation. Approval
publishes the next project policy revision; rejection and inspection do not
change execution.

Offline evaluation is deterministic:

```bash
recurs eval company --list [--json]
recurs eval company \
  [--scenario company_formation_<quick|guided|deep>_v1] [--json]
recurs eval company --configured --allow-network \
  [--scenario company_formation_<quick|guided|deep>_v1] \
  [--connection <id>] [--json]
recurs eval company --scenario company_goal_execution_v1 \
  --run <id> [--json]
```

Configured evaluation requires an explicit network opt-in.
`company_formation_v1` remains a compatibility alias for Guided.
Codex app-server connections use the same restricted pre-approval formation
boundary: decision turns receive no project tools, while bounded Explore
research receives only the reviewed read-only file, outline, search, and Git
inspection tools.

Company Proof runs the same immutable fixture through the selected parent-only
baseline and the currently configured saved role-route snapshot:

```bash
recurs benchmark company --list [--json]
recurs benchmark company --configured --allow-network \
  [--scenario <id>] [--connection <id>] \
  [--repetitions 1|2|3] [--compare-all-strong] [--json]
recurs benchmark company --resume <campaign-id> --allow-network [--json]
```

Campaigns are resumable and alternate arm order. The default compares the
selected parent-only baseline with the currently configured saved role-route
snapshot. When saved worker routes differ from the parent,
`--compare-all-strong` explicitly adds an all-strong bounded team and derives
the larger ceilings from that selection. Hidden verification decides
correctness; reports preserve unknown token or cost coverage rather than
inventing zeroes or a winner. Version-2 command reports derive a separate
version-1 attribution block from immutable V1 trials. All recorded trials remain
in reliability. A repetition is excluded from roster evidence only when every
arm recorded the same parent-boundary failure code on the same parent route
before any worker activated and no usage report was available. Review
activation, final verdicts, Repair attempts, completed Repair attempts, and
recovered trials are reported separately.

## ACP

```bash
recurs acp
```

The ACP endpoint serves the real Recurs runtime over stdio. Editor transport
does not prove user presence, so user-present-only provider paths fail closed.

## Agent Skills and MCP

Manage extensions before or after connecting a model:

```bash
recurs mcp list
recurs skills list
```

The same commands are available as `/mcp` and `/skills` inside a session.
MCP supports approved stdio processes and standard HTTP, OAuth, tools,
resources and prompts. User and project scopes have explicit precedence and
project trust. See [MCP setup and troubleshooting](MCP.md).

Skills can be copied from local bundles or installed from an explicitly
selected public source. They load instructions and referenced resources
without granting new tool permissions or executing dependency installers.
See [skills installation, invocation and scope](SKILLS.md).

## Lifecycle hooks

`recurs hooks` inspects user-owned lifecycle hooks without starting a model or
agent runtime. `recurs hooks --json` returns the same redacted status as a
versioned object. Configuration lives at `$RECURS_HOME/config/hooks.json` and
must be a private `0600`, owned, single-link regular file:

```json
{
  "version": 1,
  "hooks": [
    {
      "id": "audit",
      "events": ["turn.stop", "agent.stop", "team.stop"],
      "command": "/absolute/path/to/recurs-audit",
      "timeoutMs": 1000
    }
  ]
}
```

The stable Alpha events are `session.start`, `turn.start`, `turn.stop`,
`tool.start`, `tool.stop`, `permission.request`, `permission.result`,
`agent.start`, `agent.stop`, `team.start`, and `team.stop`. Each exact command
receives one JSON envelope on standard input. Payloads omit prompts, tool
arguments/results, permission resources, file paths, evidence, provider text,
and raw error messages. Safe opaque turn, tool-call, agent, team, and company-goal
identifiers are retained when the normalized source event provides them so
concurrent activity can be correlated.

Hooks are observe-only. Each command is one private, owned, single-link
executable outside the workspace; use an owned wrapper executable when custom
arguments are needed. Recurs binds its identity at startup and revalidates it
before every launch. Hooks run in declaration order from a bounded asynchronous
queue with strict schema, count, output, per-hook timeout, and aggregate
per-event timeout limits. Their subprocess sees a read-only workspace, a
private synthetic home, a filtered environment without host credentials, and
no network. Bounded shutdown drains completed work and cancels unfinished hook
work. Failures are visible in text and JSONL
event modes but do not change the agent result; aggregate JSON remains a
terminal-result format. Hooks run only in the local CLI host in Alpha, not ACP.
A project cannot register a hook, and hooks cannot deny or mutate prompts,
tools, results, permissions, or agent authority.

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

- Recurs is public alpha software; its npm, release-installer, Homebrew, and
  Bun-installer paths all execute the same Node.js package.
- Windows subprocess containment is not implemented.
- There is no desktop app, cloud worker, persistent daemon, scheduler, or
  unattended deployment system.
- Provider discovery does not make an unimplemented transport runnable.
- Delegated runtimes remain limited to their reviewed host-tool contract.
- Agent Skills are context, not executable plugins.
- There is no extension marketplace or guarantee that every third-party server or skill has been tested.

The code-backed capability inventory lives in
[FEATURE_STATUS.md](FEATURE_STATUS.md).
