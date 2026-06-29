# Subagents IDE

Subagents IDE is an agentic development engine for running serious software projects through a managed team of specialized coding agents. The Mac app is the flagship interface; a CLI should emerge as a second surface over the same core engine.

This repo documents the product we are building. It should not contain per-agent runtime instruction files yet, because we are not using the future product's agent workflow inside this repo. Agent roles, onboarding, tool bundles, roadmap behavior, and quality gates belong in the product and architecture docs until the actual app needs runtime prompt files.

## Product Spine

1. Open the Mac app and see a calm list of ongoing projects, similar to project folders.
2. Create a new project, open an existing one, or skip guided onboarding and start from scratch.
3. During setup, choose the project type, scope, development style, and tool range.
4. The system recommends an agent team and a curated plugin/tool bundle for that project.
5. Inside a project, the main experience is a live sub-agent workspace: connected agents, roadmap, chat, tasks, reviews, handoffs, blockers, and approvals.
6. The CLI exposes the same project, agent, command, permission, approval, and roadmap system for terminal-first or automated workflows.
7. The proof is better code: cleaner diffs, stronger tests, clearer docs, fewer broken flows, and smoother deployment.

## Positioning

The product should not feel like a beginner-only app builder. It should feel like a professional agentic development environment for technical founders and senior builders.

The best current framing is:

> Vibe coding with engineering discipline.

The app can still be excellent for non-technical users because the UX is clear, but technical credibility comes first.

## Current Docs

- [PRODUCT.md](PRODUCT.md): product design, positioning, user experience, onboarding, roadmap, plugin management, and unresolved product questions.
- [ARCHITECTURE.md](ARCHITECTURE.md): system architecture, app boundaries, agent orchestration model, harness adapter, graph model, and quality gates.
- [PRODUCT_QUESTIONS.md](PRODUCT_QUESTIONS.md): decision checklist for remaining product, onboarding, tool, agent, harness, and launch questions.
- [HARNESS_RESEARCH.md](HARNESS_RESEARCH.md): current coding-agent, agent-framework, ACP, and MCP ecosystem survey with license and reuse guidance.
- [HARNESS_APPROACH.md](HARNESS_APPROACH.md): recommended first-party harness/core-engine strategy for Subagents IDE.
