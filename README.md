<p align="center">
  <img src="docs/assets/recurs-wordmark.svg" alt="Recurs" width="420">
</p>

<p align="center"><b>Coding agents in your terminal.</b><br>Choose the models, bound the team, and review every change.</p>

<p align="center">
  <a href="https://github.com/tacotuesday8888/recurs/actions/workflows/ci.yml"><img src="https://github.com/tacotuesday8888/recurs/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/recurs"><img src="https://img.shields.io/npm/v/recurs/alpha?label=npm%20alpha&amp;color=f3a05b" alt="npm alpha"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-d96545.svg" alt="Apache 2.0"></a>
</p>

![Recurs terminal workflow](docs/assets/terminal-workflow.gif)

## Install

macOS or Linux · Node.js 22.22+ · Git 2.45+ · ripgrep

```bash
npm install --global recurs@alpha
cd your-project
recurs
```

Connect a model, choose permissions, and start coding. Use your Codex login,
a supported API provider, or a local model. [Connections](docs/PROVIDER_CAPABILITY_MATRIX.md)

<details>
<summary>Other installers</summary>

```bash
brew install tacotuesday8888/recurs/recurs
bun install --global recurs@alpha
curl -fsSL https://github.com/tacotuesday8888/recurs/releases/download/v0.1.0-alpha.11/install.sh | sh
```

Bun can install Recurs; Node.js runs it. Linux command isolation requires Bubblewrap.
[Install help](docs/CLI.md#install)

</details>

## Code, review, continue

- Follow progress and approve changes. Press **Ctrl+O** to expand code and tool details.
- Browse files and review numbered diffs in unified or split view.
- Rename, pin, archive, copy, and reopen chats.
- Connect MCP servers and add skills.

<details>
<summary>Open code review</summary>

![Code review](docs/assets/terminal-diff.svg)

</details>

## Work with a team

Choose models for implementation, review, and repair. Set delegation depth,
concurrency, and permissions. Follow each running agent and inspect its work.

![Agent team](docs/assets/terminal-v19-working.svg)

**Ctrl+G** opens the team. **Ctrl+T** opens executions. **Enter** inspects an agent.
[Team setup](docs/AUTO_MODEL_TEAMS.md)

## Built to stay responsive

| Workload (same machine, before → after) | Result |
| --- | --- |
| Streaming turn, median over 120 turns | 501–521 ms → **124 ms** |
| Loading a chat's agent history beside 30 other chats | 1.1 s → **8 ms** |
| Peak physical memory over 120 turns | ~400 MiB → **~270 MiB** |

Deterministic local workloads, not a model-quality benchmark.
[Method and raw measurements](docs/ACTIVE_SESSION_MEMORY.md)

## Reference

[CLI](docs/CLI.md) · [MCP](docs/MCP.md) · [Skills](docs/SKILLS.md) ·
[Appearance](docs/APPEARANCE.md) · [Benchmarks](benchmarks/product-comparison/README.md) ·
[Contributing](CONTRIBUTING.md)

Recurs is an alpha (`0.1.0-alpha.11`). Use `@alpha` for the current published
package. This README follows the source; captures come from the terminal test
walkthrough. [Release notes](CHANGELOG.md) · [Feature status](docs/FEATURE_STATUS.md) ·
[Verification](docs/UI_VERIFICATION.md) · [Security](SECURITY.md) · [Privacy](PRIVACY.md)
