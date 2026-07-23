# Recurs Product Direction

Recurs is an agent manager for software work. It combines a coding-agent CLI with a later desktop experience where a project looks and behaves like a small software company: agents have responsibilities, conversations, goals, handoffs, reviews, approvals, and visible progress.

It is not an IDE. Users may keep their editor of choice. Recurs manages the people-like software agents doing the work.

## Product shape

- **CLI first:** run `recurs` inside a project, chat with the active coding agent, inspect activity, set a durable goal, plan, approve work, review changes, resume, and undo.
- **Desktop later:** selecting a project opens the company operating view rather than only a chat archive. Chat remains central, surrounded by agents, current work, goals, handoffs, approvals, reviews, and history.
- **One engine:** CLI, desktop, automation, and future cloud workers use the same event, session, tool, permission, and orchestration contracts.

## Simple controls and Auto model teams

The intended default experience is understandable without exposing every
orchestration contract:

```text
Team size     Balanced
Models        Auto
Roster        Recommended
Permissions   Approved for Me
```

Economy through Max remain the versioned operating policies and should appear
as one intensity control. Onboarding depth, roster design, execution state, and
permissions remain separate choices because they answer different questions.

The longer-term Auto direction keeps the default sub-agent structure and
selects an evaluated model lineup to power the roles needed for a task. It does
not continuously invent a new organization. Model names and “best” claims must
come from versioned real-provider evaluation, with visible rationale,
freshness, and fallback. Automatic model ranking is not implemented today.

See [Auto Model Teams and Simple Controls](docs/AUTO_MODEL_TEAMS.md) for the
current product direction and the exact implemented boundary.

## Principles

1. **A strong base before a large surface.** Reliability, recovery, permissions, and observability matter more than matching every competitor command.
2. **First-party engine.** Recurs studies open-source agents but owns its core interfaces and behavior.
3. **Provider-neutral and policy-honest.** Users should be able to connect supported keys, coding plans, subscriptions, and local models only through documented methods, with billing and limitations shown clearly.
4. **Sub-agents are the differentiation.** The single-agent harness stays small; coordination, delegation, isolation, review, and company structure become the main product layer.
5. **Permissions are enforced.** Plan mode and tool access are capability boundaries. Product copy must not promise a sandbox or credential isolation that the code does not enforce.
6. **Durable work.** Goals, sessions, tool boundaries, evidence, checkpoints, and handoffs survive restarts and remain inspectable.

## What exists now

Core v0, the provider/authentication foundation, and the bounded CLI company
runtime are implemented: a provider-neutral loop, built-in and user-configured
stdio MCP tools, agent-owned long-running command sessions, three general
delegation primitives, company-goal orchestration, three permission presets,
Plan and review modes, goals, pinned version-2 sessions, immutable tailored
company blueprints, cross-process mutation leases, trusted run context, direct
and delegated coordinator lanes, interrupted-work recovery, compaction,
checkpoints/undo, a sessionless workspace shell, interactive and structured CLI
paths, and end-to-end coding workflows.

The Recurs-owned team vertical is durable. A parent can create one Explore,
Implement, or Review child, run a bounded foreground Explore/Review batch, or
ask `delegate_team` to run up to four isolated Implement workers followed by
strict Review and bounded finding-driven Repair. Version-6 Economy through Max
policies combine quality, company depth and width, reviewers, repair rounds,
request limits, concurrency, retries, reported-cost ceilings, and eligible
billing classes. Users can explicitly assign Implement, Review, and Repair to
saved direct-model connections; Recurs revalidates those connections, freezes
the selected backend evidence per run, and falls back to the parent when policy
or availability makes an assignment ineligible. All candidate work stays in
private staging until approval. Foreground applies an approved candidate
through a two-phase checkpoint transaction; process-lifetime background stops
at `ready_to_apply` for explicit control. A sequenced journal, cross-process
owner leases, truthful interruption/resume, startup recovery, normalized
events, `/agents` controls, and model control tools make lifecycle and evidence
inspectable. Child-created unbounded recursion, automatic model ranking, a
persistent daemon, dirty-parent snapshots, and auto-commit/push/deploy remain
intentionally absent.

Built-in tools now share a permanent credential-path denial, aggregate tools and new checkpoints exclude those paths, child processes receive clean synthetic state, and provider/tool/CLI failures are sanitized before durable or user-visible boundaries. Hosts may choose `workspace_sandboxed`, `local_guarded`, or a fail-closed `tools_disabled` profile. The standalone CLI selects the workspace sandbox by default on macOS and Linux, and the guarded profile on Windows.

The MCP stdio slice accepts private user configuration and exact-digest project
configuration after explicit local user trust. It progressively lists/calls
tools through ordinary permission, checkpoint, normalized-event,
isolated-environment, sandbox, timeout, cancellation, output, and process-group
boundaries. A runtime retains one serialized session per exact
server/workspace/sandbox identity, checks health before reuse, restarts only
before an operation, never retries an ambiguous tool call, invalidates changed
project configuration, and owns teardown across untrust, CLI, and ACP exits.
The parent can use configured servers; a company role can use one only after an
exact user-approved bundle binding that also survives its role and parent
policy intersection. This is not a marketplace: remote OAuth/transports,
installation, prompts/resources, and automatic trust remain absent.

The CLI now has a validated 26-path catalog, a non-secret saved-connection lifecycle, and cross-platform saved plus ephemeral BYOK for fixed-origin OpenAI Responses and reviewed OpenAI Chat-compatible and Anthropic Messages providers. Saved BYOK retains a provider/model policy binding, environment-variable name, and one-way credential fingerprint—not the key—and refuses to run if the current process lacks the exact credential. Authenticated fixed-origin discovery verifies selected OpenAI, Anthropic, OpenRouter, xAI, DeepSeek, and MiniMax models during setup; remaining reviewed providers keep the bounded public-catalog or exact-ID path. xAI runs use the documented compatibility Chat endpoint and do not claim Responses continuation semantics. OpenAI Responses runs disable API storage and retain encrypted reasoning only in bounded process memory. An interrupted tool turn is not resumable after the CLI exits; a completed conversation resumes from its last visible answer. Literal-loopback Ollama/LM Studio and the pinned official Codex ACP adapter remain supported. Codex setup and every Codex turn recheck vendor-reported authentication/account identity; the connection is local, manual, user-present, and Plan-only. Versioned protocol-level harness profiles distinguish provider-native tool use from conservative compatibility-model tool use without ranking model brands.

The private macOS authority implements complete OpenAI API, Anthropic API, and Kimi Code activation and generation verticals. It remains the stronger persistent-credential design: the sealed TypeScript engine sees only redacted lifecycle and normalized generation frames. Source/npm BYOK is a separate, explicitly weaker process-environment option and never impersonates a native connection. No signed/notarized installed artifact or production credential-canary smoke has shipped, so the native verticals are implemented and tested but not distributed.

On macOS and Linux, `workspace_sandboxed` gives command and verification children canonical workspace-only host writes, hides host credential/runtime state, and binds network access to approved command intent. Linux uses system Bubblewrap namespaces and deliberately does not claim a Recurs seccomp policy. Windows still selects `local_guarded` but rejects subprocess execution as unsupported; an explicit guarded profile on macOS/Linux retains host authority. `tools_disabled` avoids model tools but is not a usable coding profile and does not replace the private credential boundary.

The repository is open source under Apache-2.0, with release-ready `0.1.0-alpha.1` package metadata. It is source-installable only; no npm, Bun, Homebrew, curl, or binary release has been published. The guarded release path is prepared: one exact npm tarball feeds trusted npm publishing, a checksum-verifying user-local installer, a generated Homebrew formula, GitHub release assets, and provenance attestations. Publication remains owner-controlled through a documented one-time npm bootstrap, the later trusted-publisher relationship, and exact manually dispatched tags.

## Next priorities

1. **Prove the company experience with real models.** Use the installed
   versioned configured-provider formation evaluation and durable-goal scorer,
   then complete real repository goals through
   onboarding, decomposition, implementation, independent review, repair, and
   synthesis. The workflow is implemented, but no authorized real-provider run
   is evidence yet. Improve interview and delegation quality from measured
   failures, not from another speculative scheduler.
2. **Ship a portable alpha.** Complete the one-time npm bootstrap and release
   the already verified npm, checksum-bound curl, and generated Homebrew
   artifacts. Bun remains unclaimed until compatibility is tested.
3. **Tune from visible operations.** Use the implemented read-only company
   snapshots and durable evaluation reports to find waste, weak handoffs, and
   poor review coverage before expanding orchestration complexity.
4. **Expand only through reviewed boundaries.** Add capability/price-aware
   routing, provider-specific coding plans, remote MCP/OAuth, signed native
   distribution, and platform containment as separate test-backed slices.

Current background workers remain bounded to the CLI lifetime. Work that must
survive it needs a separately authenticated durable host rather than a detached
CLI child.

## Not current commitments

Recurs is not currently building its own foundation model, replacing code editors, hosting model credits, promising unofficial access to consumer subscriptions, or copying the full feature inventory of Kilo Code, OpenCode, Codex, Claude Code, or Cursor.

Historical exploration is preserved under [docs/research](docs/research/README.md). Current technical decisions live in [ARCHITECTURE.md](ARCHITECTURE.md) and the reviewed specs indexed in [docs/README.md](docs/README.md).

The current code-backed inventory is [Feature Status](docs/FEATURE_STATUS.md).
The canonical company concept and implemented boundary are recorded in
[Agent Company Onboarding](docs/AGENT_COMPANY_ONBOARDING.md).
