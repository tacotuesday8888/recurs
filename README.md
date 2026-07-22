<div align="center">

<img src="https://raw.githubusercontent.com/tacotuesday8888/recurs/main/docs/assets/recurs-mark.svg" alt="Recurs loop logo" width="132">

# Recurs

**Build a bounded agent company from your terminal.**

Turn a project brief into a reviewed roster, route work through specialist
agents, and apply only what you approve.

[![CI](https://github.com/tacotuesday8888/recurs/actions/workflows/ci.yml/badge.svg)](https://github.com/tacotuesday8888/recurs/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-4c8eda.svg)](LICENSE)
[![Status: alpha](https://img.shields.io/badge/status-alpha-d29922.svg)](#-project-status)
[![Node.js 22.22+](https://img.shields.io/badge/node-%E2%89%A522.22-3c873a.svg)](package.json)

[🚀 Quick start](#-quick-start) · [✅ What works](#-what-works-today) ·
[🛡️ Boundaries](#-how-a-goal-runs) · [📚 Docs](#-documentation)

</div>

> [!IMPORTANT]
> Recurs is a source-installable alpha. The npm package, Homebrew formula,
> curl installer, signed binary, and desktop app are not published yet.

![Recurs guided setup in a terminal](https://raw.githubusercontent.com/tacotuesday8888/recurs/main/docs/assets/terminal-preview.svg)

Recurs builds a versioned agent-company blueprint for your project, then runs
approved roles inside explicit permission, concurrency, request, cost, review,
and cancellation boundaries.

## ✨ Why Recurs

- 🏢 **Company-shaped work** — choose Quick, Guided, or Deep onboarding and
  review the proposed roles, reporting lines, tools, gates, and first goal.
- 🧭 **Bounded orchestration** — parent, specialist, review, and repair work
  all execute under frozen limits instead of open-ended recursion.
- 🔎 **Evidence before apply** — mutating team work stays in isolated Git
  worktrees until independent review and an explicit apply step.
- 🔌 **Truthful model access** — use reviewed direct APIs, literal-loopback
  local models, or official Codex ACP without hiding their restrictions.
- 💾 **Durable by default** — sessions, goals, journals, checkpoints, company
  knowledge, and approved organization revisions survive restarts.

## 🚀 Quick start

**Requirements:** Node.js 22.22+, Git 2.45+, ripgrep, and on Linux
`/usr/bin/bwrap` with unprivileged user namespaces enabled.

```bash
git clone https://github.com/tacotuesday8888/recurs.git
cd recurs
npm ci
npm run build
npm link
recurs
```

The first launch guides you through model access, safety boundaries, operating
mode, specialist routing, company review, and project context. Credentials stay
with the vendor runtime, native authority, or a named process environment.

```bash
recurs                                      # set up or resume
recurs run "inspect the project" --plan    # one bounded headless run
recurs review                               # review staged/unstaged Git work
recurs doctor                               # redacted host-readiness report
recurs eval company --json                  # deterministic offline evaluation
```

Use `-C /path/to/project` with interactive, run, or review commands. The
[CLI guide](docs/CLI.md) covers providers, images, sessions, permissions,
JSON/JSONL output, and every supported command.

## ✅ What works today

- 🏗️ **Company design:** resumable Quick, Guided, and Deep onboarding;
  versioned rosters; proposal revision; explicit activation; and multi-stage
  role DAG execution.
- 🧑‍💻 **Agent runtime:** streaming tool use, bounded retries, cancellation,
  parallel Explore/Review batches, isolated Implement teams, repair, apply,
  restart recovery, compaction, steering, forks, and undo.
- 🔌 **Models:** reviewed OpenAI, Anthropic, Gemini, OpenAI-compatible, Ollama,
  LM Studio, and user-present Plan-only Codex ACP paths.
- 🧰 **Extensions:** bounded Agent Skills, digest-bound stdio MCP servers,
  interactive text and images, headless JSON/JSONL, and a Recurs ACP endpoint.
- 🛡️ **Host safety:** permission profiles, credential-path denial, clean child
  environments, sanitized failures, and supported macOS/Linux subprocess
  containment.
- 📈 **Operations:** company status, activity, knowledge, readiness,
  amendments, exact-run inspection, and offline structural evaluation.

See [Feature status](docs/FEATURE_STATUS.md) for the code-backed inventory of
implemented, bounded, prepared-only, and absent capabilities.

## 🔁 How a goal runs

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
automatic installation or trust of Skills and MCP servers.

## 🚧 Project status

| Surface | Current state |
| --- | --- |
| Source CLI | Usable alpha on the supported Node.js toolchain |
| Package metadata | `0.1.0-alpha.1`; release gate prepared |
| npm / Homebrew / curl | Not published |
| macOS native authority | Implemented and tested; unsigned and undistributed |
| Windows subprocess containment | Not implemented; subprocess tools fail closed |
| Desktop app | Not implemented |

CI builds one self-contained Recurs bundle, installs it into an empty prefix,
and exercises the real binary, OS sandbox, Agent Skills, stdio MCP, and ACP
negotiation. Publication remains an explicit owner-controlled release step.

## 🧪 Develop and verify

```bash
npm run check          # generated state, lint, types, tests, build, package checks
npm run check:native   # full Swift/native suite on macOS
npm run package:smoke-install
```

The monorepo keeps contracts at the dependency leaf, with provider, runtime,
tool, application, core, and CLI layers above them. See
[Architecture](ARCHITECTURE.md) for package boundaries and execution lifecycle.

## 📚 Documentation

- 📋 [Feature status](docs/FEATURE_STATUS.md) — exact implementation inventory
- ⌨️ [CLI guide](docs/CLI.md) — setup, commands, outputs, storage, and limits
- 🧱 [Architecture](ARCHITECTURE.md) — engine boundaries and lifecycle
- 🏢 [Agent company onboarding](docs/AGENT_COMPANY_ONBOARDING.md) — product and authority model
- 🔐 [Security policy](SECURITY.md) — support and disclosure boundary
- 🧭 [Product direction](PRODUCT.md) — current product shape and roadmap
- 📦 [Release runbook](docs/RELEASING.md) — artifact and publication gates

## 📄 License

Recurs is licensed under the [Apache License 2.0](LICENSE). Direct runtime
dependencies retain their own licenses in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
