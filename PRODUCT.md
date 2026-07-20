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

Core v0, the provider/authentication catalog foundation, and the TypeScript tool-safety precursor are implemented: a provider-neutral loop, bounded built-in and user-configured stdio MCP tools, agent-owned long-running command sessions, three owned delegation primitives, three permission presets, Plan and review modes, goals, pinned version-2 sessions, cross-process mutation leases, trusted run context, direct and delegated coordinator lanes, interrupted-work recovery, compaction, checkpoints/undo, sessionless workspace shell, interactive and JSONL CLI paths, and full end-to-end coding workflows.

The Recurs-owned team vertical is now durable. A parent can create one Explore, Implement, or Review child, run a bounded foreground Explore/Review batch, or ask `delegate_team` to run up to four isolated Implement workers followed by strict Review and bounded finding-driven Repair. Version-5 Economy through Max policies combine quality, team width, reviewers, repair rounds, child/request limits, concurrency, depth, retries, reported-cost ceilings, and eligible billing classes. Users can explicitly assign Implement, Review, and Repair to saved direct-model connections; Recurs revalidates those connections, freezes the selected backend evidence per run, and falls back to the parent when policy or availability makes an assignment ineligible. All candidate work stays in private staging until approval. Foreground applies an approved candidate through a two-phase checkpoint transaction; process-lifetime background stops at `ready_to_apply` for explicit control. A sequenced journal, cross-process owner leases, truthful interruption/resume, startup recovery, normalized events, `/agents` controls, and model control tools make lifecycle and evidence inspectable. Recursion, automatic task decomposition, automatic model ranking, a persistent daemon, dirty-parent snapshots, and auto-commit/push/deploy remain intentionally absent.

Built-in tools now share a permanent credential-path denial, aggregate tools and new checkpoints exclude those paths, child processes receive clean synthetic state, and provider/tool/CLI failures are sanitized before durable or user-visible boundaries. Hosts may choose `workspace_sandboxed`, `local_guarded`, or a fail-closed `tools_disabled` profile. The standalone CLI selects the workspace sandbox by default on macOS and Linux, and the guarded profile on Windows.

The MCP stdio slice accepts private user configuration and exact-digest project configuration after explicit local user trust. It progressively lists/calls tools through ordinary permission, checkpoint, normalized-event, isolated-environment, sandbox, timeout, cancellation, output, and process-group boundaries. A runtime retains one serialized session per exact server/workspace/sandbox identity, checks health before reuse, restarts only before an operation, never retries an ambiguous tool call, invalidates changed project configuration, and owns teardown across untrust, CLI, and ACP exits. It is a parent-only interoperability seam, not a marketplace: remote OAuth/transports, cross-runtime daemons, installation, prompts/resources, and child/team access remain absent.

The CLI now has a validated 25-path catalog, a non-secret saved-connection lifecycle, and cross-platform saved plus ephemeral BYOK for fixed-origin OpenAI Responses and reviewed OpenAI Chat-compatible and Anthropic Messages providers. Saved BYOK retains a provider/model policy binding, environment-variable name, and one-way credential fingerprint—not the key—and refuses to run if the current process lacks the exact credential. Authenticated fixed-origin discovery verifies selected OpenAI, Anthropic, OpenRouter, DeepSeek, and MiniMax models during setup; remaining reviewed providers keep the bounded public-catalog or exact-ID path. Public OpenAI Responses runs disable API storage and retain encrypted reasoning only in bounded process memory. An interrupted tool turn is not resumable after the CLI exits; a completed conversation resumes from its last visible answer, while the native broker remains the persistent hidden-continuation design. Literal-loopback Ollama/LM Studio and the pinned official Codex ACP adapter remain supported. Codex setup and every Codex turn recheck vendor-reported authentication/account identity; the connection is local, manual, user-present, and Plan-only. Versioned protocol-level harness profiles distinguish native tool use from conservative compatibility-model tool use without ranking model brands.

The private macOS authority implements complete OpenAI API, Anthropic API, and Kimi Code activation and generation verticals. It remains the stronger persistent-credential design: the sealed TypeScript engine sees only redacted lifecycle and normalized generation frames. Source/npm BYOK is a separate, explicitly weaker process-environment option and never impersonates a native connection. No signed/notarized installed artifact or production credential-canary smoke has shipped, so the native verticals are implemented and tested but not distributed.

On macOS and Linux, `workspace_sandboxed` gives command and verification children canonical workspace-only host writes, hides host credential/runtime state, and binds network access to approved command intent. Linux uses system Bubblewrap namespaces and deliberately does not claim a Recurs seccomp policy. Windows still selects `local_guarded` but rejects subprocess execution as unsupported; an explicit guarded profile on macOS/Linux retains host authority. `tools_disabled` avoids model tools but is not a usable coding profile and does not replace the private credential boundary.

The repository is public, but it has no license yet and cannot legally be described as open source until the owner adds one. It is source-installable only; no npm, Bun, Homebrew, curl, or binary release has been published. The guarded release path is prepared: one exact npm tarball feeds trusted npm publishing, a checksum-verifying user-local installer, a generated Homebrew formula, GitHub release assets, and provenance attestations. The workflow remains fail-closed until the owner selects the license/version and configures the protected publishing identities.

## Roadmap

### 1. Provider and onboarding layer

Credential-free onboarding for literal-loopback OpenAI-compatible local providers is implemented. It collects no key, refuses non-loopback endpoints and redirects, and persists only endpoint/model metadata. Interactive saved-BYOK setup adds fixed-origin OpenAI Responses plus reviewed Chat and Anthropic Messages providers without persisting their keys, with explicit billing acknowledgement and credential-binding verification. OpenAI, Anthropic, OpenRouter, DeepSeek, and MiniMax additionally authenticate against exact reviewed model-list endpoints before their selected model is saved. The first-run guide now creates a real initial team configuration: parent connection, permission boundary, durably recorded versioned operating mode, optional confirmation-gated Implement/Review/Repair candidates from eligible saved direct connections, and bounded project instructions. Existing root-to-cwd `AGENTS.md` policy is reused; otherwise the user may review and confirm a non-overwriting starter brief. It does not claim automatic decomposition or a company UI. The 25-path catalog, billing/restriction projection, redacted provider/account commands, and official Codex-with-ChatGPT delegated path are also implemented.

The private macOS OpenAI, Anthropic, and Kimi paths are assembled without rewriting the TypeScript harness: exact profile binding, model discovery, crash-safe setup, generation codecs, CLI onboarding, cancellation, usage, and redacted diagnostics are implemented. The next step is a signed/notarized installed artifact plus recovery and credential-canary proof. A manifest flag or shared wire protocol alone still cannot activate a provider.

Additional providers and delegated runtimes remain provider-specific integrations. Future native HTTPS treats macOS system proxy/root configuration as trusted host policy. The current macOS/Linux tool profile is a subprocess boundary, not a persistent-credential authority. A provider stays unavailable whenever any required attestation, codec/profile, policy, platform, onboarding, or release evidence is absent.

### 2. Sub-agent company runtime

The durable parent/child and team-run contracts, exact worker profiles, shared budgets, foreground and process-lifetime background delegation, normalized activity, isolated staging, strict Review, bounded Repair, explicit apply, ownership fencing, and restart recovery are implemented. Continue the primary product differentiator with:

- capability- and price-aware routing beyond the explicit saved role assignments, without brand ranking or silent secondary spend;
- Windows containment and a reviewed Linux syscall policy before claiming cross-platform unattended arbitrary-command workers;
- a separately designed durable worker host if work must continue after the CLI exits;
- a company-level operating view over the existing goals, modes, budgets, cancellation, handoffs, review, repair, and normalized activity stream.

Current process-lifetime workers remain bounded to the CLI lifetime. Any worker that must survive it needs a separately authenticated durable host rather than a detached CLI child.

### 3. Product surfaces and ecosystem

Add the company-style desktop client, plugin packaging and later MCP remote/profile slices, background/cloud execution, and distribution. npm, checksum-bound curl, and a Homebrew formula now share one prepared versioned artifact path, but none is live until the release gate is satisfied; a tap is still absent. Bun may later install the package while Node remains the runtime, and Windows support remains later work.

## Not current commitments

Recurs is not currently building its own foundation model, replacing code editors, hosting model credits, promising unofficial access to consumer subscriptions, or copying the full feature inventory of Kilo Code, OpenCode, Codex, Claude Code, or Cursor.

Historical exploration is preserved under [docs/research](docs/research/README.md). Current technical decisions live in [ARCHITECTURE.md](ARCHITECTURE.md) and the reviewed specs indexed in [docs/README.md](docs/README.md).
