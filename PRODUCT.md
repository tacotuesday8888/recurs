# Recurs Product Direction

Recurs is an agent manager for software work. It combines a coding-agent CLI with a later desktop experience where a project looks and behaves like a small software company: agents have responsibilities, conversations, goals, handoffs, reviews, approvals, and visible progress.

It is not an IDE. Users may keep their editor of choice. Recurs manages the people-like software agents doing the work.

## Product shape

- **CLI first:** run `recurs` inside a project, chat with the active coding agent, inspect activity, set a durable goal, plan, approve work, review changes, resume, and undo.
- **Desktop later:** selecting a project opens the company operating view rather than only a chat archive. Chat remains central, surrounded by agents, current work, goals, handoffs, approvals, reviews, and history.
- **One engine:** CLI, desktop, automation, and future cloud workers use the same event, session, tool, permission, and orchestration contracts.

## Principles

1. **A strong base before a large surface.** Reliability, recovery, permissions, and observability matter more than matching every competitor command.
2. **First-party engine.** Recurs studies open-source agents but owns its core interfaces and behavior.
3. **Provider-neutral and policy-honest.** Users should be able to connect supported keys, coding plans, subscriptions, and local models only through documented methods, with billing and limitations shown clearly.
4. **Sub-agents are the differentiation.** The single-agent harness stays small; coordination, delegation, isolation, review, and company structure become the main product layer.
5. **Permissions are enforced.** Plan mode and tool access are capability boundaries. Product copy must not promise a sandbox or credential isolation that the code does not enforce.
6. **Durable work.** Goals, sessions, tool boundaries, evidence, checkpoints, and handoffs survive restarts and remain inspectable.

## What exists now

Core v0, the provider/authentication catalog foundation, and the TypeScript tool-safety precursor are implemented: a provider-neutral loop, seven tools, three permission presets, Plan and review modes, goals, pinned version-2 sessions, cross-process mutation leases, trusted run context, direct and delegated coordinator lanes, interrupted-work recovery, compaction, checkpoints/undo, sessionless workspace shell, interactive and JSONL CLI paths, and a full end-to-end coding workflow.

Built-in tools now share a permanent credential-path denial, aggregate tools and new checkpoints exclude those paths, child processes receive clean synthetic state, and provider/tool/CLI failures are sanitized before durable or user-visible boundaries. Hosts may choose the default `local_guarded` tool profile or a fail-closed `tools_disabled` profile that exposes no model tools.

The CLI now has a validated 25-path catalog and a non-secret connection lifecycle. Three paths are runnable: literal-loopback Ollama, literal-loopback LM Studio, and an existing ChatGPT account through the pinned official Codex ACP adapter. Users can list, verify, select, and disconnect exact connection IDs; only the first connection becomes primary automatically, disconnection never logs out of a vendor, and historical sessions continue through their immutable pin. Codex setup and every Codex turn recheck vendor-reported authentication/account identity; each turn binds the account on the same ACP child before session work and again immediately before prompting. The connection is local, manual, user-present, and Plan-only, and its disclosed billing can include automatic prepaid-credit use after included limits. Recurs does not import or store the vendor credential.

The first macOS native-authority component foundation is also implemented: Data Protection Keychain and crash-safe credential-state recovery, exact-peer code-identity checks, a production-gated broker that recovers one authority before activating its private lifecycle/health XPC listener, a headless launcher and fixed sealed-engine bridge, bounded no-secret framing, an injected-descriptor TypeScript client, tool-child descriptor denial, and redacted `recurs doctor native` diagnostics. Journal schema v2 authenticates an exact generated profile identity plus any canonical custom endpoint and model-catalog behavior on every connection record. Native component `0.2.0` carries the same binding through bounded private stage metadata without exposing it in replies, TypeScript, or descriptor 3. A dormant broker-internal route authority now derives setup, run, and maintenance capabilities from that authenticated state, rechecks exact candidate or usable-ready generations after suspension, and enforces scope, expiry, cancellation, and budgets without loading a credential or touching the network. Unreleased schema-v1 journals deliberately have no migration; development users reset that unpublished state and reconnect.

The launcher library now has two deliberately unexposed onboarding seams: an internal foreground-TTY capture primitive that restores exact terminal state and erases owned bytes, and an authenticated private lifecycle client that stages those bytes over XPC and returns only redacted state. The executable does not call either seam. Capture remains internal until a signal-owning coordinator proves restoration across interrupt, termination, and suspension.

This is not yet a shipped or provider-usable authority: no signed/notarized artifact or production smoke exists, and source/npm builds cannot activate it. There is no executable setup command, provider verification, DNS/network feasibility, credential reservation from a route receipt, broker HTTP/TLS/proxy handling, request/stream codec, model-catalog transport, or direct-provider CLI assembly. Ordinary macOS source execution fails closed as launcher-unavailable, other platforms report unsupported, and an injected peer cannot establish trusted provenance. Every direct API, coding-plan, OAuth, cloud-identity, and other broker-owned entry remains disabled until its remaining policy, transport, onboarding, signed-artifact, and credential-canary gates land.

`local_guarded` arbitrary commands are not OS-sandboxed and retain the user's filesystem, network, IPC, and process authority. `tools_disabled` avoids model tools but is not a usable coding profile and does not replace the future credential boundary.

The repository is intended to become open source, but it has no license yet and cannot legally be described as open source until the owner adds one. It is source-installable only; no npm, Bun, Homebrew, curl, or binary release has been published.

## Roadmap

### 1. Provider and onboarding layer

Credential-free onboarding for literal-loopback OpenAI-compatible local providers is implemented. It collects no key, refuses non-loopback endpoints and redirects, and persists only endpoint/model metadata. The 25-path catalog, billing/restriction projection, redacted provider/account commands, and official Codex-with-ChatGPT delegated path are also implemented.

The narrow macOS authority components are now in place without rewriting the TypeScript harness, including authenticated profile binding in journal v2, bounded private stage metadata, and dormant fenced route authority. The next work must connect TTY secret capture, provider-verified staging, DNS/network feasibility, broker-owned HTTP/TLS/proxy and model-catalog transport, request/stream codecs, CLI onboarding, an adapter, and signed installed-artifact credential-canary proof. A manifest flag or shared wire protocol alone cannot activate a provider.

Additional providers and delegated runtimes remain provider-specific integrations. Future native HTTPS treats macOS system proxy/root configuration as trusted host policy, and the current tool profile remains explicitly non-sandboxed. A provider stays unavailable whenever any required attestation, codec/profile, policy, platform, onboarding, or release evidence is absent.

### 2. Sub-agent company runtime

Build the primary product differentiator:

- an orchestrator that decomposes and delegates work;
- explicit worker roles and capability profiles;
- isolated workspaces and controlled integration;
- goals, budgets, cancellation, handoffs, review, and escalation;
- a normalized activity stream understandable by both terminal and desktop clients.

Before unattended local workers run arbitrary commands, add an enforceable process/filesystem/network isolation layer.

### 3. Product surfaces and ecosystem

Add the company-style desktop client, plugins and MCP with trust boundaries, background/cloud execution, and distribution. An npm package is the likely first preview channel; Bun may later install it while Node remains the runtime. Homebrew and curl wait for versioned signed artifacts, and Windows support remains later work.

## Not current commitments

Recurs is not currently building its own foundation model, replacing code editors, hosting model credits, promising unofficial access to consumer subscriptions, or copying the full feature inventory of Kilo Code, OpenCode, Codex, Claude Code, or Cursor.

Historical exploration is preserved under [docs/research](docs/research/README.md). Current technical decisions live in [ARCHITECTURE.md](ARCHITECTURE.md) and the reviewed specs indexed in [docs/README.md](docs/README.md).
