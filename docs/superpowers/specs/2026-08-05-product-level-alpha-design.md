# Product-Level Alpha

**Status:** Approved product direction for the next Recurs public-alpha
milestone.

## Outcome

Recurs will be a dependable open-source coding CLI whose default journey is
simple, whose company/sub-agent controls are real, and whose claims match
measured behavior. This milestone improves the existing TypeScript harness; it
does not replace the agent loop, add another scheduler, or redesign the CLI as
a full-screen IDE.

The product promise remains:

> **The best coding model is a team. You control the team.**

Recurs is an open-source, controllable deep-work harness: users choose the
operating intensity and authority, while Recurs forms bounded project-aware
roles, routes approved models, shows only activated agents, and preserves
independent review, repair, synthesis, evidence, and shared limits.

## Existing foundation

The milestone extends the implemented foundation:

- a provider-neutral streaming agent loop with durable sessions, tools,
  approvals, Plan and Review modes, continuation, compaction, images, MCP, and
  Agent Skills;
- local, BYOK, cloud/coding-plan activation recipes, and delegated vendor
  runtimes, including live-verified Codex subscription authentication;
- versioned operating modes and user-governed team controls;
- durable Company Blueprint V2 formation, approval, amendments, knowledge, and
  goal-scoped execution;
- bounded parent, lead, implement, independent review, repair, and synthesis
  paths with permission monotonicity, shared budgets, cancellation, recovery,
  worktree isolation, and explicit apply; and
- one reviewed artifact distributed through npm, Bun-as-installer, curl,
  Homebrew, and GitHub Releases, with Node.js as the declared runtime.

## Delivery sequence

### 1. First-run product hardening

Polish only problems demonstrated by a real Codex-backed onboarding run:

- emit truthful stage messages before long company-formation operations so a
  live terminal does not appear frozen;
- keep proposal review concise while retaining full detail in
  `/company capabilities`;
- distinguish built-in execution bundles from optional, explicitly approved
  Skill/MCP bindings;
- surface safe, actionable private-state failures without exposing local
  paths, IDs, causes, or arbitrary exception text; and
- update alpha documentation to the latest immutable evaluation evidence.

The storage layer continues to reject symlink traversal. A lexical `/tmp` path
on macOS is not automatically rewritten around that boundary; the CLI explains
the safe failure and the user can select a canonical private state location.

### 2. Evidence-driven company runtime quality

Use the existing immutable Company Proof machinery and the versioned evaluation
report. Separate shared parent/provider outages from roster-quality outcomes
without deleting them from reliability results. Improve diagnostics around
activation, review, and repair, then change prompts, routing, or orchestration
only when repeated evidence demonstrates a specific defect.

No model lineup is called `Auto` because of a guessed ranking. Current evidence
does not prove that the mixed Sol/Terra/Luna company beats the strong Sol
baseline, and Terra repair has not yet demonstrated recovery value. Those
limitations remain visible until repeated runs change the evidence.

### 3. Installed-product and release proof

Exercise the complete installed CLI journey from a clean user-local prefix:
install, help, doctor, provider discovery, onboarding, company approval, one
bounded goal, review/repair when invoked, synthesis, and explicit apply. Verify
npm, Bun installation, curl, Homebrew, and GitHub Release instructions all
refer to the same supported alpha channel and continue to identify Node.js as
the runtime.

Publish a new alpha only after the source and installed checks are green, the
artifact is reviewed, and public documentation describes exactly what was
verified.

## Capability presentation contract

Company role `toolBundles` are Recurs-owned capability categories. Execution
profiles and the permission engine provide the bounded built-in tools needed by
the core company path. Company capability bindings may add an installed Agent
Skill or enabled MCP server to an approved bundle, but discovery never binds,
installs, trusts, authenticates, or widens a role automatically.

For backward compatibility, Company Blueprint V2 retains the stored
`available | required` tool-plan status. User-facing rendering distinguishes an
**unbound** entry from one whose approved extension source is currently
**unavailable**, and aggregates both as **not ready** rather than claiming that
the company runtime is unusable. New blueprints describe the requirement as an
extension opportunity rather than a precondition for execution.

Onboarding renders a summary only:

- built-in-ready bundle count;
- not-ready optional-extension count;
- approved binding count;
- enabled Skill and MCP catalog counts, or `not inspected`; and
- the explicit approval boundary.

`/company capabilities` remains the detailed inspection surface with bundle and
binding identifiers. It does not expose filesystem paths, commands, arguments,
private descriptions, or credential material.

## Formation progress contract

Before awaiting a potentially long model-backed `advance`, onboarding prints
one concise stage derived from durable state. It may say that Recurs is
understanding the project or preparing/refining a proposal. It must not invent
agents, percentages, tool activity, or completion. Existing completed-research,
question, proposal, and approval messages remain authoritative.

## Safe error contract

Only recognized error classes cross the CLI boundary. Private company-state
errors map by stable error code to fixed public copy. Raw IDs, paths, causes,
and arbitrary store messages are never returned. Unknown exceptions retain the
diagnostic-ID response.

## Quality and delivery

Every behavior change begins with a focused failing test, then the smallest
implementation that makes it pass. Full `npm run check`, installed-package
smoke tests, a safe real Codex dogfood path, diff review, generated-file review,
and secret scanning precede publication. Work ships through focused feature
branches and green pull requests; canonical local `main` is synchronized after
merge.

## Explicit exclusions

This milestone does not add a desktop client, full-screen TUI, native Bun
runtime claim, Windows process containment, persistent worker daemon,
unbounded recursion, silent self-modification, remote MCP/OAuth, automatic
plugin installation, general marketplace, autonomous deployment, or unattended
push/messaging. These remain separate future decisions rather than hidden
release blockers.
