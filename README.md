<p align="center">
  <img src="./docs/assets/recurs-wordmark.png" alt="Recurs" width="820">
</p>

<p align="center">
  <strong>The best coding model is a team. You control the team.</strong>
</p>

<p align="center">
  An open-source coding-agent harness for running controlled teams in your terminal.
</p>

<p align="center">
  <a href="https://github.com/tacotuesday8888/recurs/actions/workflows/ci.yml"><img src="https://github.com/tacotuesday8888/recurs/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/recurs"><img src="https://img.shields.io/npm/v/recurs/alpha?label=npm&color=4285f4" alt="npm alpha"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-4c8eda.svg" alt="Apache 2.0"></a>
</p>

## Install

```bash
npm install -g recurs@alpha
recurs
```

Recurs supports macOS and Linux. The first run connects a model, sets
permissions, and configures your team.

[Bun, curl, Homebrew, and source installs →](docs/PUBLIC_ALPHA.md#installation-reality)

## Why Recurs?

Most heavy-agent modes hide the team behind one switch. Recurs gives you the
controls:

- choose team size and delegation depth
- route each role to a different model
- set permissions, retries, requests, and spend limits
- require independent review and bounded repair
- see every active agent, handoff, result, and usage record

Start with one agent or form a project-specific company through guided
onboarding.

## How it works

```text
goal → plan → workers → review → repair → synthesis → approval
```

Workers inherit narrower authority than their parent. Mutating work happens in
isolated Git worktrees and is only applied through the active approval policy.

Recurs works with API keys, local models, and user-present vendor runtimes,
including an existing Codex subscription.

## Use it

```bash
recurs                                  # interactive session
recurs run "fix the failing tests"      # bounded headless run
recurs review                           # review local changes
recurs doctor                           # check host readiness
```

Inside Recurs:

```text
/goal <objective>    start a durable goal
/goal launch         launch the active approved company goal
/agents controls     inspect team limits
/company status      inspect the active company
/model auto          select an evaluated model team
/permissions         change the authority profile
/status              show the current session and usage
```

## Learn more

- [Five-minute CLI guide](docs/CLI.md)
- [Feature status](docs/FEATURE_STATUS.md)
- [Company onboarding](docs/AGENT_COMPANY_ONBOARDING.md)
- [Architecture](ARCHITECTURE.md)
- [Security](SECURITY.md)
- [Privacy and local data](PRIVACY.md)
- [Contributing](CONTRIBUTING.md)

Recurs is public alpha software. See the
[current release boundaries](docs/PUBLIC_ALPHA.md) before using it on
sensitive or production work.

Apache-2.0 © Recurs contributors
