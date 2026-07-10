# Harness Ecosystem Research

Research date: 2026-06-29.

This document surveys current coding-agent harnesses, general agent frameworks, and agent protocols that are relevant to Subagents IDE. It is product and architecture research, not a set of runtime prompts for future agents.

## Research Rules

- Primary sources were preferred: official GitHub repositories, official docs, and repository license files.
- License notes are current observations, not legal advice.
- Do not copy code, prompts, configs, docs, UI assets, names, logos, or character assets unless the exact source file has been checked at the commit being copied.
- Generic workflow ideas can be adapted, but exact implementation details require license review.
- MIT and Apache-2.0 code is generally practical to reuse with notices and attribution. Mixed, source-available, archived, or non-code licenses need extra care.

## High-Level Finding

The best product direction is not to wrap many agents and expose that complexity to users. The better path is a first-party Subagents Core that owns:

- The project company graph.
- The command layer.
- The boss/orchestrator.
- Agent identity, departments, tasks, handoffs, blockers, reviews, and quality gates.
- Permissions and approvals.
- Project memory.
- Tool bundles.
- A narrow harness adapter boundary.

Existing agents are best used as pattern sources and optional execution backends while Subagents IDE builds its own coherent product model.

## Reuse Categories

- Copy candidate: license appears permissive, but direct copying still requires exact file-level review, notice preservation, and attribution.
- Study conceptually: useful ideas, but direct copying is risky because of license, product status, brand, architecture mismatch, or unclear file-level rights.
- Avoid as base: do not build the product on this project without legal and architectural review.

## Coding Agents and Harnesses

### OpenCode

Source: [GitHub](https://github.com/anomalyco/opencode), [docs](https://opencode.ai/docs), [agents docs](https://opencode.ai/docs/agents), [commands docs](https://opencode.ai/docs/commands)

License observed: MIT in the repository license file.

Useful patterns:

- Terminal and desktop coding-agent surfaces.
- Built-in primary agents, including a read-only planning mode and a development mode.
- A general subagent mechanism.
- Slash command templates and command configuration.
- Permission handling.
- MCP integration.
- ACP implementation and tests.
- Server/API surfaces.

Product fit:

OpenCode is one of the strongest coding-agent references for Subagents IDE because it already combines commands, agents, subagents, MCP, permissions, and ACP. Its product is still coding-agent-first, while Subagents IDE should be graph-led and company-led.

Reuse guidance:

Copy candidate after file-level MIT check and attribution. The safest use is to study command metadata, ACP boundaries, permission flow, and subagent routing. Avoid copying brand, UI identity, default prompts, or command text verbatim unless explicitly audited.

### Pi

Source: [GitHub](https://github.com/earendil-works/pi)

License observed: MIT in the repository license file.

Useful patterns:

- Modular package layout for unified LLM API, agent runtime, coding CLI, TUI, extensions, skills, sessions, compaction, and observability.
- JSONL session storage.
- Hook and extension examples.
- RPC/SDK modes.
- Explicit security docs stating that project trust is not a sandbox and that real isolation must come from containers, VMs, micro-VMs, or OS controls.

Product fit:

Pi is a strong reference for building a small first-party runtime instead of starting with a giant framework. Its security posture is also useful because it clearly separates project trust from sandboxing.

Reuse guidance:

Copy candidate after file-level MIT check and attribution. Best direct study areas are runtime boundaries, session storage, extension hooks, compaction, and RPC. Do not inherit its lack of sandboxing as a product default.

### Aider

Source: [GitHub](https://github.com/Aider-AI/aider), [docs](https://aider.chat/docs/)

License observed: Apache-2.0 via GitHub license metadata and repository badges/docs.

Useful patterns:

- Git-centered coding flow.
- Codebase repository map.
- Diff, commit, lint, and test loops.
- Practical terminal interaction for existing codebases.
- Strong model-provider flexibility.

Product fit:

Aider is less aligned with the company graph UI, but it is a high-value reference for quality proof. Subagents IDE should make every agent change visible as diff evidence, test evidence, and review evidence.

Reuse guidance:

Copy candidate after file-level Apache-2.0 check, including NOTICE obligations if applicable. Prefer conceptual reuse of Git discipline and repo-map behavior over copying implementation.

### Cline

Source: [GitHub](https://github.com/cline/cline), [site](https://cline.bot/)

License observed: Apache-2.0 in GitHub metadata and license file.

Useful patterns:

- IDE extension, CLI, and SDK surfaces.
- Plan/Act mode lineage and current interactive mode handling.
- Human-in-the-loop approvals.
- MCP management.
- Model/provider configuration.
- ACP permission code in the CLI.

Product fit:

Cline is useful for approval UX and editor-agent ergonomics. Subagents IDE should not become editor-panel-first; it should keep graph and company state as the primary product surface.

Reuse guidance:

Copy candidate after file-level Apache-2.0 check. Study approval flows, mode switching, MCP management, and SDK separation. Avoid copying extension UI patterns too directly because the Mac app needs a different layout.

### OpenHands

Source: [GitHub](https://github.com/OpenHands/OpenHands), [software-agent-sdk](https://github.com/OpenHands/software-agent-sdk), [docs](https://docs.openhands.dev/)

License observed:

- Main repo license file says content outside enterprise restrictions is MIT, with an enterprise directory carve-out.
- `OpenHands/software-agent-sdk` is MIT in GitHub license metadata.

Useful patterns:

- Agent Canvas as a self-hosted developer control center.
- Local, Docker, VM, cloud, and enterprise backends.
- Agent server architecture.
- ACP-compatible agent backends.
- Automations and scheduled/background engineering work.
- Explicit warning that running without a sandbox gives broad filesystem access.

Product fit:

OpenHands is a strong architecture reference for durable backends and remote/local execution. It is not the right product base because Subagents IDE needs its own graph-led company experience and simpler v1 scope.

Reuse guidance:

Study conceptually, with selective copy only after exact path-level license review. Avoid enterprise directories. The SDK may be a better candidate than the main repo if direct code reuse is needed.

### Goose

Source: [GitHub](https://github.com/aaif-goose/goose), [docs](https://goose-docs.ai/)

License observed: Apache-2.0 in GitHub metadata and README badge.

Useful patterns:

- Native desktop app, CLI, and API.
- General local automation beyond code.
- 15+ model providers.
- MCP extension ecosystem.
- ACP provider support.
- Custom distributions with preconfigured providers, extensions, and branding.

Product fit:

Goose is useful for local desktop-agent packaging, MCP extension UX, and general automation. Subagents IDE should borrow the distribution and tool-extension lessons, not the broad "do anything" product stance.

Reuse guidance:

Copy candidate after file-level Apache-2.0 review. Most useful as a desktop/CLI/API and MCP ecosystem reference.

### Plandex

Source: [GitHub](https://github.com/plandex-ai/plandex), [docs](https://docs.plandex.ai/)

License observed: MIT in GitHub metadata and repository license file.

Useful patterns:

- Large multi-step coding plans.
- Cumulative diff review sandbox.
- Review-before-apply flow.
- Tree-sitter project maps.
- Multi-model planning and execution.
- Configurable autonomy.
- Git integration and optional auto-commit.

Current status note:

The README says Plandex Cloud is winding down and points users to self-hosted/local mode.

Product fit:

Plandex is one of the best references for serious code-change control. Its diff sandbox and plan/review/apply flow map directly to Subagents IDE quality gates.

Reuse guidance:

Copy candidate after file-level MIT check and attribution. Best ideas to adapt are cumulative diffs, review-before-apply, and large-context planning.

### SWE-agent and mini-swe-agent

Sources: [SWE-agent](https://github.com/SWE-agent/SWE-agent), [mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent), [mini docs](https://mini-swe-agent.com/latest/)

License observed: MIT for both repositories in GitHub metadata.

Useful patterns:

- Minimal issue-solving loop.
- Linear trajectory history.
- Bash-only worker baseline in mini-swe-agent.
- Simple sandbox switching by swapping execution environment.
- Benchmark orientation and trajectory inspection.
- Strong reminder that useful agents do not always need complex scaffolding.

Product fit:

mini-swe-agent is a strong baseline for Subagents IDE worker execution: keep workers simple, observable, and easy to sandbox. The company graph and orchestration should add product value above that simple loop.

Reuse guidance:

Copy candidate after file-level MIT check. The most valuable reuse is conceptual: a small worker loop, linear histories, trajectory inspection, and environment-level sandboxing.

### Gemini CLI

Source: [GitHub](https://github.com/google-gemini/gemini-cli), [docs](https://geminicli.com/docs/)

License observed: Apache-2.0 in GitHub metadata, README, and license file.

Useful patterns:

- Terminal-first coding agent.
- Built-in file, shell, web-fetch, and Google Search grounding tools.
- MCP support.
- Conversation checkpointing.
- Custom context files.
- GitHub Action integration for PR review and issue triage.
- Fast release channels.

Product fit:

Gemini CLI is a strong reference for terminal agent UX, checkpointing, and GitHub workflow integration. It is model-provider-specific by default, so it should not become the core product dependency.

Reuse guidance:

Copy candidate after file-level Apache-2.0 review. Study ACP/MCP behavior, checkpointing, and GitHub automation patterns. Avoid coupling Subagents IDE to one model family.

### Qwen Code

Source: [GitHub](https://github.com/QwenLM/qwen-code), [docs](https://qwenlm.github.io/qwen-code-docs/en/users/overview)

License observed: Apache-2.0 in GitHub metadata and license file.

Useful patterns:

- Terminal UI, headless mode, IDE plugins, desktop app, daemon mode, SDKs, and messaging integrations.
- Auto-memory, auto-skills, subagents, agent teams, hooks, MCP, plan mode, sandbox, worktrees, and LSP integration according to its README.
- Experimental HTTP+SSE daemon using ACP.
- Multi-provider model support.

Current status note:

The README states the project was originally based on Google Gemini CLI v0.8.2 and later diverged.

Product fit:

Qwen Code is highly relevant because it exposes a broad feature set that overlaps Subagents IDE goals: subagents, teams, skills, memory, ACP daemon, and desktop ambitions.

Reuse guidance:

Copy candidate after file-level Apache-2.0 review. Because it descends from Gemini CLI, check upstream attribution and file history if copying. Strong conceptual source for daemon/SDK/ACP shape and agent-team features.

### Crush

Source: [GitHub](https://github.com/charmbracelet/crush)

License observed: Functional Source License 1.1 with MIT future license in the repository license file.

Useful patterns:

- Polished terminal UX.
- LSP-enhanced context.
- Session-based project contexts.
- MCP support.
- Provider switching while preserving context.

Product fit:

Crush is useful for interaction design and LSP-context ideas. It is not a good direct code source for a competing commercial product because of the current source-available license terms.

Reuse guidance:

Study conceptually. Avoid direct copying unless legal review confirms the intended use is permitted or the relevant code has converted under its future-license terms.

### Continue

Source: [GitHub](https://github.com/continuedev/continue), [docs](https://docs.continue.dev/)

License observed: Apache-2.0 in README and GitHub metadata.

Current status note:

The README says the repository is no longer actively maintained and is read-only, with a final 2.0.0 release.

Useful patterns:

- Historical editor-agent architecture.
- CLI, VS Code, and JetBrains distribution.
- Configuration and extension conventions.

Product fit:

Continue is useful historical context, but should not be a dependency for a new product.

Reuse guidance:

Study conceptually. Copy only after Apache-2.0 file-level review, but prefer current projects for implementation patterns.

### Roo Code

Source: [GitHub](https://github.com/RooCodeInc/Roo-Code), [docs](https://roocodeinc.github.io/Roo-Code/)

License observed: Apache-2.0 in GitHub metadata and README.

Current status note:

The GitHub repo is archived. The README states the extension was shut down on May 15.

Useful patterns:

- Role/mode model: Code, Architect, Ask, Debug, and Custom Modes.
- MCP support.
- "AI dev team in the editor" product positioning.

Product fit:

Roo Code is relevant as a historical reference for named modes and custom agent roles, but the shutdown makes it unsuitable as a current dependency.

Reuse guidance:

Study conceptually. Avoid depending on it. Direct copying still requires file-level Apache-2.0 review.

### Hermes Agent

Source: [GitHub](https://github.com/NousResearch/hermes-agent), [docs](https://hermes-agent.nousresearch.com/docs/)

License observed: MIT in GitHub metadata and README badge.

Useful patterns:

- Self-improving agent loop.
- Skills creation and improvement.
- Persistent memory and session search.
- Scheduled automations.
- Messaging gateways.
- Subagent delegation and parallelization.
- Local, Docker, SSH, Singularity, Modal, and Daytona execution backends.
- Command approval and container isolation docs.

Product fit:

Hermes is highly relevant for durable memory, skills, scheduled agents, and long-running background work. It is less central to code-edit discipline than Aider, Plandex, Pi, and OpenCode.

Reuse guidance:

Copy candidate after file-level MIT check. Strong conceptual reference for memory, skills, scheduling, and remote durable execution.

## General Agent Frameworks

### LangGraph

Source: [GitHub](https://github.com/langchain-ai/langgraph), [docs](https://docs.langchain.com/oss/python/langgraph/)

License observed: MIT in GitHub metadata and README badge.

Useful patterns:

- Long-running, stateful agent workflows.
- Durable execution.
- Human-in-the-loop interrupts.
- Short-term and long-term memory.
- State graphs and subgraphs.
- Deployment and observability through the LangChain ecosystem.

Product fit:

LangGraph is the best conceptual framework reference for internal orchestration. Its graph is an execution graph, while Subagents IDE's visible graph is a product/work graph. Those should stay separate but connected.

Reuse guidance:

Copy candidate after file-level MIT review, but the likely best path is conceptual: state machines, checkpoints, interrupts, and durable workflows.

### CrewAI

Source: [GitHub](https://github.com/crewAIInc/crewAI), [docs](https://docs.crewai.com/)

License observed: MIT in GitHub metadata and README badge.

Useful patterns:

- Role-based agent crews.
- Crews for autonomy and Flows for event-driven control.
- Tasks, roles, goals, tools, memory, guardrails, and human review.

Product fit:

CrewAI maps naturally to the "company" mental model, but Subagents IDE should own its own department and character model rather than adopting CrewAI terminology directly.

Reuse guidance:

Copy candidate after file-level MIT review. Best to borrow role/task vocabulary and the separation between autonomous teams and controlled flows.

### Microsoft AutoGen

Source: [GitHub](https://github.com/microsoft/autogen), [docs](https://microsoft.github.io/autogen/)

License observed: GitHub metadata reports CC-BY-4.0 for the repository license.

Current status note:

The README says AutoGen is in maintenance mode and directs new users to Microsoft Agent Framework.

Useful patterns:

- Historical multi-agent conversation patterns.
- Agent tools, group chats, event-driven core, and Studio.
- MCP workbench example.

Product fit:

AutoGen is important history, but not a recommended base for a new product.

Reuse guidance:

Study conceptually. Avoid direct code copying unless a specific package/file has a code-appropriate license and legal review confirms reuse.

### Microsoft Agent Framework

Source: [GitHub](https://github.com/microsoft/agent-framework), [docs](https://learn.microsoft.com/en-us/agent-framework/)

License observed: MIT in GitHub metadata.

Useful patterns:

- Production-grade agents and multi-agent workflows for Python and .NET.
- Sequential, concurrent, handoff, and group collaboration patterns.
- Checkpointing, streaming, time-travel, and human-in-the-loop.
- OpenTelemetry observability.
- Declarative agents.
- Agent skills.
- A2A and MCP integration.

Product fit:

Microsoft Agent Framework is a strong current reference for production workflows, especially handoffs, checkpoints, human review, and observability.

Reuse guidance:

Copy candidate after file-level MIT review. Best used conceptually unless Subagents IDE chooses a Python or .NET runtime layer.

### smolagents

Source: [GitHub](https://github.com/huggingface/smolagents), [docs](https://huggingface.co/docs/smolagents)

License observed: Apache-2.0 in GitHub metadata and README header.

Useful patterns:

- Minimal agent library.
- CodeAgent action model.
- Sandbox execution through external environments such as Docker and hosted sandboxes.
- Hub sharing of tools/agents.
- MCP tool loading.
- Model-agnostic integrations.

Product fit:

smolagents is useful for simple worker loops, tool abstraction, and sandboxed code execution. It is not a full coding IDE harness.

Reuse guidance:

Copy candidate after file-level Apache-2.0 review. Best used as a small-agent design reference.

### Agno

Source: [GitHub](https://github.com/agno-agi/agno), [docs](https://docs.agno.com/)

License observed: Apache-2.0 in GitHub metadata.

Useful patterns:

- Agent platform control plane.
- Production API with SSE and websockets.
- Storage for sessions, memory, knowledge, and traces.
- Human approval.
- OpenTelemetry, audit logs, RBAC, multi-user and multi-tenant isolation.
- Scheduling.
- Interfaces such as Slack, Telegram, Discord, AG-UI, and A2A.

Product fit:

Agno is a strong reference for platform operations: runs, traces, approvals, scheduling, and RBAC. Subagents IDE should apply those ideas locally first.

Reuse guidance:

Copy candidate after file-level Apache-2.0 review. Most useful conceptually for control-plane architecture.

### Mastra

Source: [GitHub](https://github.com/mastra-ai/mastra), [docs](https://mastra.ai/docs)

License observed:

- Repository license file says the core framework and most code are Apache-2.0.
- Directories named `ee/` are under Mastra Enterprise License.

Useful patterns:

- TypeScript-native agents and workflows.
- Model routing.
- Graph-based workflow engine.
- Human-in-the-loop suspend and resume.
- Storage-backed state.
- Memory, RAG, MCP server authoring, evals, and observability.

Product fit:

Mastra is relevant if Subagents IDE uses a TypeScript engine service. It has many patterns that align with productized agents, but direct reuse must avoid enterprise-licensed paths.

Reuse guidance:

Selective copy candidate only outside `ee/` and after file-level Apache-2.0 review. Avoid enterprise directories without legal review.

### LlamaIndex

Source: [GitHub](https://github.com/run-llama/llama_index), [docs](https://developers.llamaindex.ai/)

License observed: MIT in GitHub metadata.

Useful patterns:

- Data connectors, ingestion, indexing, retrieval, and agentic document workflows.
- LlamaAgents and LlamaIndex Workflows.
- Large ecosystem of integrations.

Product fit:

LlamaIndex is most relevant for project memory, docs ingestion, retrieval over large code and project docs, and future document-heavy agents.

Reuse guidance:

Copy candidate after file-level MIT review, but likely best as a dependency or conceptual source for retrieval and memory.

### OpenManus

Source: [GitHub](https://github.com/FoundationAgents/OpenManus), [site](https://openmanus.github.io/)

License observed: MIT in GitHub metadata and README badge.

Useful patterns:

- General autonomous agent flow.
- Browser automation and MCP variant.
- Optional multi-agent flow.
- Simple configuration-driven setup.

Product fit:

OpenManus is relevant as a general-agent reference, but it is not coding-agent-specialized enough to be a primary harness reference.

Reuse guidance:

Study conceptually. Copy only after file-level MIT review.

## Protocols

### Agent Client Protocol

Source: [GitHub](https://github.com/agentclientprotocol/agent-client-protocol), [docs](https://agentclientprotocol.com/)

License observed: Apache-2.0 in GitHub metadata and license file.

Useful patterns:

- JSON-RPC protocol between coding agents and coding clients.
- Session setup, prompt turns, cancellation, tool calls, file-system support, terminal support, plans, and slash commands.
- Dynamic slash command advertisement through session updates.
- Registry of ACP-compatible agents, including OpenCode, Cline, Gemini CLI, Goose, Qwen Code, Pi ACP, Codex ACP, and others.

Product fit:

ACP is strategically important for the harness adapter boundary. It should not replace Subagents IDE's internal graph model, because ACP is client-agent communication, not a product company graph. It should inform how the app talks to executable coding workers.

Reuse guidance:

Copy candidate after Apache-2.0 file-level review. Prefer official SDKs and schemas over hand-copying protocol code.

### Model Context Protocol

Source: [GitHub](https://github.com/modelcontextprotocol/modelcontextprotocol), [docs](https://modelcontextprotocol.io/), [Python SDK](https://github.com/modelcontextprotocol/python-sdk), [TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)

License observed:

- Main spec repository license file says the project is transitioning from MIT to Apache-2.0, with documentation contributions excluding specifications under CC-BY-4.0.
- Python SDK reports MIT in GitHub metadata.
- TypeScript SDK license file uses transition language similar to the main project.

Useful patterns:

- Tool and data access protocol.
- Servers expose tools, resources, and prompts to clients.
- Widely adopted by coding agents and desktop agents.

Product fit:

MCP should be the primary tool/plugin boundary for Subagents IDE. It should not be the agent-team protocol or the product state model.

Reuse guidance:

Use official SDKs when possible. Check exact SDK and spec file licenses before copying. Treat docs text as CC-BY-4.0 unless a file says otherwise.

## Cross-Ecosystem Patterns To Borrow

- Command metadata: Commands should have names, descriptions, optional input hints, target rules, permission impact, graph impact, and evidence requirements.
- Dynamic commands: Available commands can change by project phase, selected graph node, and agent permissions.
- First-party routing: Familiar commands like `/plan`, `/review`, and `/test` should route through Subagents IDE state first, then to a coding worker if needed.
- ACP-like adapters: Executable coding workers should speak through a protocol boundary instead of being hardwired into the UI.
- MCP tool bundles: Tools should be grouped into product bundles, not exposed as raw server clutter.
- Simple worker loops: Many coding tasks can use a small linear loop with strong observability and sandboxing.
- Durable orchestration: Project work should have resumable runs, checkpoints, interrupts, and state snapshots.
- Review-before-apply: Large or risky changes should be held as diffs until review gates pass.
- Git discipline: Every meaningful code change should map to changed files, diffs, tests, and optional commits.
- Permission gates: The system should classify actions before execution, not after damage is done.
- Real sandboxing: Filesystem/process/network isolation must come from OS, container, VM, micro-VM, or remote sandbox boundaries.
- Memory separation: Runtime agent context, project memory docs, retrieval indexes, and product architecture docs should remain separate.
- Observability: Runs need logs, traces, tool calls, model calls, approvals, and evidence linked back into the graph.

## Patterns To Avoid

- Building the Mac app as a generic bring-your-own-agent wrapper.
- Exposing a raw list of agents, MCP servers, skills, and providers as the main UX.
- Forking a full coding agent too early and inheriting its product identity.
- Depending on archived or maintenance-mode projects for core runtime behavior.
- Treating project trust as a sandbox.
- Letting subagents spawn invisibly.
- Letting the graph become decorative rather than driven by real events.
- Copying prompts, command templates, or UI assets without explicit license review.
- Using source-available code such as FSL projects as a direct product base without legal review.

## Practical Recommendation

Build a first-party Subagents Core.

Start with a narrow local runtime:

1. Own the command router, graph event store, permission gate, and project memory.
2. Implement a minimal first-party worker loop inspired by Pi and mini-swe-agent.
3. Use MCP for tools.
4. Use ACP as the adapter boundary for optional external coding agents.
5. Borrow Git/diff/review discipline from Aider and Plandex.
6. Borrow command/subagent/permission patterns from OpenCode and Qwen Code.
7. Borrow durable state and human-in-the-loop ideas from LangGraph, Microsoft Agent Framework, Mastra, and Agno.

Do not start by forking OpenHands, Cline, Roo Code, Continue, Crush, or AutoGen as the core product base.

## Research Remaining

- Run a small ACP proof of concept with OpenCode, Qwen Code, Gemini CLI, and Pi ACP if available.
- Run a local worker proof of concept using a minimal loop plus MCP tools and a per-task Git worktree.
- Test macOS sandbox options, Docker/Colima, and a remote sandbox option for command execution.
- Perform file-level license audits before copying any implementation.
- Decide whether the first engine service should be TypeScript, Rust, Swift, Python, or a hybrid.
- Define the exact event schema that connects chat, graph, commands, agents, and quality evidence.
