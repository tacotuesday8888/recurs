<div align="center">

<img src="./docs/assets/recurs-mark.svg" alt="Recurs loop logo" width="80">

# Recurs

**Build and run a bounded agent company from your terminal.**

Give Recurs a goal. It proposes a specialist team, runs approved work inside
explicit limits, and keeps every change reviewable before apply.

[![CI](https://github.com/tacotuesday8888/recurs/actions/workflows/ci.yml/badge.svg)](https://github.com/tacotuesday8888/recurs/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-4c8eda.svg)](LICENSE)
[![Status: alpha](https://img.shields.io/badge/status-alpha-d29922.svg)](#-project-status)
[![Node.js 22.22+](https://img.shields.io/badge/node-%E2%89%A522.22-3c873a.svg)](package.json)

[**Quick start**](#-quick-start) · [**Why Recurs**](#-why-recurs) ·
[**How it works**](#-how-it-works) · [**Docs**](#-documentation)

</div>

<p align="center">
  <img src="./docs/assets/terminal-preview.svg" alt="Recurs guided setup in a terminal" width="560">
</p>

## ✨ Why Recurs

- **🏢 A team, not a single prompt.** Choose Quick, Guided, or Deep setup and
  review the proposed roles, reporting lines, tools, gates, and first goal.
- **🛡️ Bounded by design.** Permission, concurrency, request, cost, review,
  retry, and cancellation limits are frozen before work begins.
- **🔎 Evidence before apply.** Mutating work stays in isolated Git worktrees
  until independent review and your explicit approval.
- **🔌 Bring the model you trust.** Use reviewed OpenAI, Anthropic, Gemini,
  OpenAI-compatible, Ollama, LM Studio, or official Codex ACP paths.
- **💾 Built to resume.** Goals, sessions, checkpoints, company knowledge, and
  approved organization revisions survive restarts.

## 🚀 Quick start

> [!IMPORTANT]
> Recurs is currently a source-installable alpha. npm, Homebrew, curl, signed
> binary, and desktop releases are not published yet.

**Requirements:** Node.js 22.22+, Git 2.45+, and ripgrep. Linux subprocess
containment also requires `/usr/bin/bwrap` with unprivileged user namespaces.

```bash
git clone https://github.com/tacotuesday8888/recurs.git
cd recurs
npm ci
npm run build
npm link
recurs
```

The first launch walks through model access, safety boundaries, operating mode,
specialist routing, company review, and project context.

```bash
recurs                                      # set up or resume
recurs run "inspect the project" --plan    # one bounded headless run
recurs review                               # review staged/unstaged Git work
recurs doctor                               # redacted host-readiness report
recurs eval company --json                  # deterministic offline evaluation
recurs eval company --list --json           # discover evaluation scenarios
```

Credentials remain with the vendor runtime, native authority, or named process
environment. See the [CLI guide](docs/CLI.md) for every command, provider,
permission, image, session, and JSON/JSONL option.

## 🔁 How it works

```text
goal
 └─ orchestrator
    ├─ explore and plan
    └─ reviewed implementation stages
       ├─ isolated specialist worktrees
       ├─ independent review
       └─ bounded repair
              ↓
       candidate change → your approval → apply
```

Recurs depicts only agents that actually run. It does not claim arbitrary
recursive hierarchies, autonomous deployment, unattended daemon workers, or
automatic installation or trust of Skills and MCP servers.

## ✅ What works today

| Surface | Current capability |
| --- | --- |
| **Company design** | Resumable onboarding, versioned rosters, proposal revision, explicit activation, and multi-stage role DAGs |
| **Agent runtime** | Streaming tools, parallel Explore/Review, isolated Implement teams, repair, apply, cancellation, recovery, compaction, steering, forks, and undo |
| **Models** | Reviewed OpenAI, Anthropic, Gemini, OpenAI-compatible, Ollama, LM Studio, and user-present Plan-only Codex ACP paths |
| **Extensions** | Bounded Agent Skills, digest-bound stdio MCP, text and images, headless JSON/JSONL, and a Recurs ACP endpoint |
| **Host safety** | Permission profiles, credential-path denial, clean child environments, sanitized failures, and supported macOS/Linux containment |
| **Operations** | Company status, activity, knowledge, readiness, amendments, exact-run inspection, deterministic formation, exact-connection provider dogfooding, and durable-goal scoring |

The [feature status](docs/FEATURE_STATUS.md) is the code-backed inventory of
implemented, bounded, prepared-only, and absent capabilities.

## 🚧 Project status

| Distribution surface | Status |
| --- | --- |
| **Source CLI** | Usable alpha on the supported Node.js toolchain |
| **Package metadata** | `0.1.0-alpha.1`; release gate prepared |
| **npm / Homebrew / curl** | Not published |
| **macOS native authority** | Implemented and tested; unsigned and undistributed |
| **Windows subprocess containment** | Not implemented; subprocess tools fail closed |
| **Desktop app** | Not implemented |

## 🧪 Develop and verify

```bash
npm run check          # generated state, lint, types, tests, build, packages
npm run check:native   # full Swift/native suite on macOS
npm run package:smoke-install
```

## 📚 Documentation

- 📋 [Feature status](docs/FEATURE_STATUS.md) — exact capability inventory
- ⌨️ [CLI guide](docs/CLI.md) — setup, commands, outputs, storage, and limits
- 🧱 [Architecture](ARCHITECTURE.md) — engine boundaries and lifecycle
- 🏢 [Agent company onboarding](docs/AGENT_COMPANY_ONBOARDING.md) — product and authority model
- 🔐 [Security policy](SECURITY.md) — support and disclosure boundary
- 🧭 [Product direction](PRODUCT.md) — current shape and roadmap
- 📦 [Release runbook](docs/RELEASING.md) — artifact and publication gates

## 📄 License

Recurs is licensed under the [Apache License 2.0](LICENSE). Direct runtime
dependencies retain their own licenses in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
