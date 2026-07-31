<div align="center">

<img src="./docs/assets/recurs-mark.svg" alt="Recurs returning-loop logo" width="96">

# Recurs

### The best coding model is a team. You control the team.

An open-source coding-agent harness for user-controlled deep work in your
terminal.

[![CI](https://github.com/tacotuesday8888/recurs/actions/workflows/ci.yml/badge.svg)](https://github.com/tacotuesday8888/recurs/actions/workflows/ci.yml)
[![npm: alpha](https://img.shields.io/npm/v/recurs/alpha?label=npm&color=4285f4)](https://www.npmjs.com/package/recurs)
[![Status: alpha](https://img.shields.io/badge/status-alpha-d29922.svg)](#project-status)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-4c8eda.svg)](LICENSE)

</div>

<p align="center">
  <img src="./docs/assets/terminal-preview.svg" alt="An actual Recurs alpha company run showing its activated Parent, Implement, and Review roles, assigned models, results, verification, and usage" width="760">
</p>

<p align="center"><sub>Actual alpha run, not a mockup.</sub></p>

## Quick start

Recurs currently supports macOS and Linux. Install the public alpha with npm,
then launch it:

```bash
npm install --global recurs@alpha
recurs
```

`--global` only makes the `recurs` command available from any directory.

The first run guides you through model access, authority, team intensity, model
routing, an optional company roster, and project context.

<details>
<summary><strong>Other install options</strong></summary>

All options install the same reviewed npm artifact and run Recurs on Node.js.
Bun is a verified installer, not a separate Recurs runtime.

```bash
# Bun
bun install --global recurs@alpha

# Checksummed user-local installer
curl -fsSL https://github.com/tacotuesday8888/recurs/releases/download/v0.1.0-alpha.4/install.sh | sh

# Homebrew
brew install tacotuesday8888/recurs/recurs
```

To run from source:

```bash
git clone https://github.com/tacotuesday8888/recurs.git
cd recurs
npm ci
npm run build
npm link
recurs
```

</details>

> [!NOTE]
> The alpha requires Node.js 22.22+, Git 2.45+, and ripgrep. Linux subprocess
> containment also requires `/usr/bin/bwrap` with unprivileged user
> namespaces. Windows subprocess containment and a desktop app are not
> implemented.

## Deep work without the black box

Proprietary “Ultra” modes can send a difficult task through a hidden team.
Recurs is the open-source, user-controlled version of that idea: the harness
shows which agents activate, what each one owns, which model it uses, what it
costs, and what evidence it returns.

You control:

| Control | What it changes |
| --- | --- |
| Team size | Active-agent and concurrency ceilings |
| Paths | Sequential, parallel, and review/repair routes |
| Layers | Maximum delegation depth |
| Escalation | Which roles may report or hand work upward |
| Models | Parent, Implement, Review, and Repair assignments |
| Authority | Permissions, approvals, retries, requests, and spend |

Choose a simple bounded parent agent or approve a project-specific company.
Recurs never depicts inactive roster members as working.

## From goal to reviewed change

```text
approved goal
    │
    ▼
explore and plan
    │
    ├──► bounded specialists
    │
    ▼
isolated implementation ──► independent review ──► bounded repair
    │
    ▼
candidate change ──► your approval ──► apply
```

Mutating work stays in isolated Git worktrees. Child permissions cannot exceed
their parent. One goal-wide policy freezes delegation, concurrency, retry,
request, and reported-cost ceilings before work begins.

## Built today

- **Adaptive company formation:** Quick, Guided, and Deep onboarding; resumable
  interviews; read-only project understanding; editable proposals; explicit
  activation; and versioned rosters.
- **Controlled multi-agent execution:** parent, lead, specialist, implementation,
  independent review, bounded repair, and synthesis paths with shared limits.
- **Flexible model access:** OpenAI, Anthropic, Gemini, OpenAI-compatible APIs,
  Ollama, LM Studio, and local user-present Codex subscriptions with exact
  model and effort routing.
- **Coding-agent fundamentals:** streaming tools, Plan and Act modes, steering,
  queues, compaction, forks, undo, image input, read-only review, restart
  recovery, and explicit permission profiles.
- **Extensions:** bounded Agent Skills, digest-bound stdio MCP, headless
  JSON/JSONL, and a Recurs ACP endpoint.
- **Approval-gated learning:** attributable project knowledge and completed-goal
  evidence can produce inspectable team recommendations. Recurs never silently
  rewrites the company or expands authority.

See [Feature status](docs/FEATURE_STATUS.md) for the code-backed inventory of
implemented, bounded, prepared-only, and absent capabilities.

## Everyday commands

```bash
recurs                                      # set up or resume
recurs run "inspect the project" --plan    # one bounded headless run
recurs review                               # review staged/unstaged Git work
recurs doctor                               # redacted host-readiness report
recurs eval company --json                  # deterministic offline evaluation
```

Inside an interactive session:

```text
/goal <objective>       Start or manage a durable goal
/agents controls       Inspect the exact effective team limits
/company status        Inspect the approved company and current operation
/model auto             Explain or apply an evidence-backed model team
/permissions           Inspect or change the authority profile
/status                Show session, model, mode, goal, and usage
```

Use `-C /path/to/project` with interactive, run, or review commands. The
[CLI guide](docs/CLI.md) covers the complete command and provider surface.

## Proof, not promises

A real Codex subscription run completed company formation and a reviewed
Balanced coding goal with Sol leading, Terra implementing, and Luna reviewing.
The run passed its verifier and reported exact token usage.

Subsequent hidden-verifier comparisons proved that the company path, independent
review, routing, and comparable-arm recording all execute correctly. They did
**not** establish a general quality or efficiency advantage over a strong
single agent. Repeated trials and alternative teams are still required.

The [evaluation record](docs/COMPANY_EVALUATION.md) contains the exact results,
limitations, and next evidence bar.

## Security and boundaries

- Credentials remain with the vendor runtime or a named process environment;
  Recurs does not persist BYOK values.
- Ask Always, Approved for Me, and Full Access remain bounded by the active
  execution profile and platform containment.
- Project Skills and MCP servers are never silently installed or trusted.
- Cancellation, unknown usage, failures, and review outcomes propagate
  truthfully.

Read the [security policy](SECURITY.md) and
[architecture](ARCHITECTURE.md) for the complete boundary.

## Project status

Recurs is usable alpha software. The public `0.1.0-alpha.4` release is available
through npm, Bun-as-installer, a checksummed curl installer, Homebrew, or source.
macOS and Linux are supported. The CLI and company runtime are real; the project
does not claim arbitrary unbounded recursion, autonomous deployment, persistent
daemon workers, a signed standalone binary, Windows subprocess containment, or
a desktop app.

## Documentation

- [Five-minute CLI guide](docs/CLI.md)
- [Public alpha status and installation boundaries](docs/PUBLIC_ALPHA.md)
- [Exact feature status](docs/FEATURE_STATUS.md)
- [Company onboarding and authority model](docs/AGENT_COMPANY_ONBOARDING.md)
- [Product direction](PRODUCT.md)
- [Release runbook](docs/RELEASING.md)

## Contributing

Run the complete local gate before opening a pull request:

```bash
npm ci
npm run check
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow,
[SUPPORT.md](SUPPORT.md) for help, and [SECURITY.md](SECURITY.md) for private
security reporting.

## License

Recurs is licensed under the [Apache License 2.0](LICENSE). Direct runtime
dependencies retain their own licenses in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
