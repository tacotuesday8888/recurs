<div align="center">

# Recurs

**Build and run a bounded agent company from your terminal.**

Recurs is a first-party, provider-neutral coding-agent harness with durable
sessions, explicit permissions, and evidence-bearing team workflows.

[![CI](https://github.com/tacotuesday8888/recurs/actions/workflows/ci.yml/badge.svg)](https://github.com/tacotuesday8888/recurs/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-4c8eda.svg)](LICENSE)
[![Status: alpha](https://img.shields.io/badge/status-alpha-d29922.svg)](#project-status)
[![Node.js 22.22+](https://img.shields.io/badge/node-%E2%89%A522.22-3c873a.svg)](package.json)

</div>

![Recurs first-run terminal](https://raw.githubusercontent.com/tacotuesday8888/recurs/main/docs/assets/terminal-preview.png)

Recurs turns a project brief into a reviewed company blueprint, then runs only
the roles and workflows the user approved. The CLI is the product today; a
future desktop client will sit on the same engine rather than replace it.

> [!IMPORTANT]
> Recurs is in source-installable alpha. No npm package, Homebrew formula,
> curl installer, signed binary, or desktop app has been published yet.

## Why Recurs

- **Company-shaped work.** Quick, Guided, or Deep onboarding can produce a
  tailored, versioned roster with explicit roles, reporting lines, tools,
  quality gates, and an initial goal.
- **Bounded execution.** Parent, Explore, Implement, Review, Repair, and
  company-role work all run inside enforced depth, concurrency, request, cost,
  permission, and cancellation limits.
- **Evidence before apply.** Mutating team work stays in isolated Git
  worktrees, passes independent review and bounded repair, and reaches the
  parent workspace only through an explicit apply path.
- **Provider choice without invented portability.** Recurs supports reviewed
  direct APIs, literal-loopback local models, and the official Codex ACP path,
  while preserving the real restrictions of each connection.
- **Durable by default.** Sessions, goals, team journals, checkpoints,
  company knowledge, and approved organization revisions survive restarts and
  remain inspectable.

## Quick start

Requirements:

- Node.js 22.22 or newer
- Git 2.45 or newer
- ripgrep
- Linux only: `/usr/bin/bwrap` with unprivileged user namespaces enabled

```bash
git clone https://github.com/tacotuesday8888/recurs.git
cd recurs
npm ci
npm run build
npm link
recurs
```

The first launch walks through the parent model, safety boundary, operating
mode, specialist routing, agent company, and project context. No API key is
entered into the generic Recurs prompt: supported credentials remain with the
vendor runtime, native authority, or a named process environment.

Useful entry points:

```bash
recurs                              # interactive setup or resume
recurs run "inspect the project" --plan
recurs review                       # bounded staged/unstaged Git review
recurs doctor                       # redacted host readiness report
recurs --help
```

Use `-C /path/to/project` with interactive, run, or review commands to select a
working root without changing the caller's shell directory. See the
[CLI guide](docs/CLI.md) for provider setup, JSON/JSONL output, image inputs,
sessions, permissions, and every supported command.

## What works today

### Agent company

- resumable Quick, Guided, and Deep onboarding;
- Stable Core + Specialists and Guardrailed Dynamic company designs;
- consented, closed, read-only project discovery before approval;
- conversational or YAML proposal revision with explicit activation;
- approved multi-stage role DAG execution, goal-wide accounting, attributable
  learning, and approval-gated organization amendments;
- `/company` status, blueprint, activity, knowledge, amendment, readiness, and
  exact user-approved Skill/MCP capability bindings.

### Agent runtime

- a streaming tool-calling loop with bounded retries, step limits,
  cancellation, and repeated-loop detection;
- one child, parallel Explore/Review batches, and isolated Implement teams;
- independent review, finding-driven repair, staged candidates, explicit
  apply, restart recovery, and truthful partial-failure reporting;
- five version-6 operating modes from Economy through Max, with immutable
  historical policy replay;
- durable goals, steering, queued follow-ups, compaction, forks, checkpoints,
  and conflict-safe undo.

### Models and integrations

- fixed-origin environment BYOK for reviewed OpenAI Responses,
  Anthropic Messages, Gemini GenerateContent, and OpenAI-compatible providers;
- credential-free literal-loopback Ollama and LM Studio setup;
- official Codex ACP with an existing ChatGPT login for local, interactive,
  user-present, Plan-only work;
- bounded Agent Skills from user or explicitly trusted project locations;
- bounded stdio MCP servers with digest-bound project trust and exact
  user-approved company-role bindings;
- interactive text and images, headless text/JSON/JSONL, and a Recurs-owned
  ACP v1 stdio endpoint.

### Safety and host boundaries

- Ask Always, Approved for Me, Full Access, enforced Plan, and read-only Review
  profiles;
- permanent classified-credential path denial across built-in tools and new
  checkpoints;
- clean child environments and sanitized provider, tool, process, and CLI
  failures;
- workspace-write containment for arbitrary subprocesses on supported macOS
  and Linux hosts; Linux fails closed when Bubblewrap is unavailable;
- private, tested macOS native credential authority foundations that are not
  yet distributed as a signed/notarized product.

## How a company goal runs

```text
approved goal
    └─ orchestrator
       ├─ read / planning handoffs
       └─ reviewed implementation stages
          ├─ isolated builders
          ├─ independent review
          └─ bounded repair
                 ↓
        reviewed candidate → explicit apply → parent synthesis
```

Recurs depicts only agents that actually run. It does not claim arbitrary
recursive hierarchies, autonomous deployment, unattended daemon workers, or
automatic installation/trust of Skills and MCP servers.

## Project status

| Surface | Current state |
| --- | --- |
| Source CLI | Usable alpha on the supported Node.js toolchain |
| Package metadata | `0.1.0-alpha.1`; release gate prepared |
| npm / Homebrew / curl | Not published |
| macOS native authority | Implemented and tested; unsigned and undistributed |
| Windows subprocess containment | Not implemented; subprocess tools fail closed |
| Desktop app | Not implemented |

The package build produces one self-contained Recurs code bundle and a minimal
tarball. CI installs that artifact into an empty prefix and exercises the real
binary, OS sandbox, Agent Skills, stdio MCP, and ACP negotiation. Publication
remains an explicit owner-controlled release step.

## Develop and verify

```bash
npm run check          # generated state, lint, types, tests, build, package checks
npm run check:native   # full Swift/native suite on macOS
npm run package:smoke-install
```

The monorepo keeps contracts at the dependency leaf, then builds provider,
runtime, tool, application, core, and CLI layers above them. Read
[Architecture](ARCHITECTURE.md) for the package boundaries and execution
lifecycle.

## Documentation

- [Feature status](docs/FEATURE_STATUS.md) — code-backed inventory of what is
  implemented, bounded, prepared-only, and absent
- [CLI guide](docs/CLI.md) — setup, commands, storage, outputs, and limits
- [Architecture](ARCHITECTURE.md) — engine boundaries and lifecycle
- [Agent company onboarding](docs/AGENT_COMPANY_ONBOARDING.md) — product and
  authority model
- [Security policy](SECURITY.md) — support and disclosure boundary
- [Product direction](PRODUCT.md) — current product shape and roadmap
- [Release runbook](docs/RELEASING.md) — exact artifact and publication gate
- [Documentation index](docs/README.md) — reviewed designs and implementation
  plans

## License

Recurs is licensed under the [Apache License 2.0](LICENSE). Direct runtime
dependencies retain their own licenses as listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
