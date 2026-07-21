# Agent Company Onboarding

**Status:** First vertical implemented. This document distinguishes the
bounded onboarding-to-company path that exists now from the deeper company
system Recurs is intended to become.

## Product thesis

Recurs is not an IDE and onboarding is not primarily a setup wizard. Recurs is
an agent manager whose core experience is letting a managed software company
work on a project. Onboarding is the compiler for that company: it turns the
user's idea, repository, constraints, accounts, and preferred working style
into durable agents, responsibilities, tools, permissions, quality gates, and
a first goal.

The product should feel credible to technical founders and senior builders.
Clear onboarding may also make it accessible to non-technical users, but the
promise is disciplined engineering rather than a beginner-only app generator.

The intended product loop is:

1. design a tailored agent company for the project;
2. operate that company through planning, implementation, review, testing, and
   release work; and
3. prove the method through evidence: scoped changes, tests, reviews, clean
   handoffs, and visible progress.

UI treatment is deliberately unresolved. The same company specification must
work through the CLI now and a desktop client later.

## Settled product decisions

These decisions come from the earliest workspace product discussion, with
later project decisions taking precedence where the direction changed.

- **CLI first, desktop later.** The original Mac-first concept established the
  company metaphor. The current delivery surface is the CLI; both surfaces
  must eventually consume the same engine and durable state.
- **First-party harness.** Recurs studies and selectively adapts proven
  open-source patterns, but owns its agent loop, contracts, permissions,
  orchestration, and company model.
- **The company is hierarchical, not a flat agent list.** A senior
  orchestrator delegates through leads and specialists to bounded workers.
  Deeper delegation is a target, not a current capability.
- **Use pre-built roles with tailored identities.** Stable role charters and
  permission ceilings are supplied by Recurs. Onboarding specializes their
  prompts, context, tools, model routes, and working relationships for the
  project. A free-form agent builder is not required for the first version.
- **Keep a stable department map.** Product, Engineering, QA, Security, Tools,
  and Deployment are the default departments. Project-specific specialists
  attach to the closest department instead of creating an incoherent org chart.
- **A meaningful default company is larger than a three-agent demo.** The
  original baseline was at least seven or eight roles: orchestrator, product
  planner, tool curator, architect, implementation lead, scoped builder, QA,
  and security/release. Operating modes decide how many are activated and how
  much work runs concurrently; the roster must not become automatic token burn.
- **Permissions are simple at the top and precise underneath.** The user picks
  a project-wide safety boundary first, while advanced configuration may narrow
  individual agents. A child can never exceed its parent.
- **Working style is a real engine choice.** A project may use a layered
  sub-agent company, one main orchestrator, or a single agent for simple work.
  This is more important than exposing arbitrary prompt-count choices.
- **Onboarding is conversational and skippable.** A short classification can
  lead into a voice or text discussion, followed by structured confirmation.
  Users may bypass the company setup and use Recurs as a normal coding agent.
- **Tools are assigned as coherent bundles.** Users should not have to reason
  about an unstructured wall of individual MCP servers and skills. Recurs
  recommends role- and project-specific bundles, explains why each is needed,
  checks local readiness, and requires approval before installation or trust.
- **The first run is both disciplined and visibly useful.** Planning,
  documentation, and safe foundation work may proceed in parallel, but review
  and permission gates still decide what becomes accepted work.
- **The company adapts from evidence.** Project instructions, successful
  patterns, review findings, tool readiness, and user corrections should refine
  future assignments. Adaptation must never silently expand permissions,
  billing, or deployment authority.

Earlier purple styling, pixel characters, graph layouts, and animations are
useful explorations, not current engine requirements.

## What onboarding must produce

The durable result is a versioned `CompanyBlueprint`, not a collection of
answers that disappears after setup. Its conceptual output is:

```text
CompanyBlueprint
├── ProjectBrief
├── DevelopmentStyle
├── OperatingMode + budget envelope
├── PermissionPlan
├── DepartmentGraph
│   └── AgentProfile[]
├── ModelRoutePlan
├── ToolBundlePlan
├── QualityPlan
├── InitialGoal + roadmap
└── ProjectDocumentationPlan
```

Each `AgentProfile` needs a stable role identifier and version, department,
responsibility, project-specific instructions, context boundary, allowed tools,
permission ceiling, model/backend eligibility, budget, delegation limits,
review obligations, and expected evidence. Names and visual personalities are
display metadata and may change without migrating execution policy.

The blueprint must be inspectable, editable before launch, and frozen into each
run so later configuration changes cannot rewrite historical authority.

## Intended onboarding engine

The interaction may be rendered differently over time, but the engine should
perform these stages:

1. **Choose the project.** Start a new project or select an existing one.
2. **Establish authority.** Connect a parent model, choose the safety boundary,
   acknowledge billing, and select an operating mode.
3. **Classify the work.** Capture platform, project type, stage, scope, and the
   desired development style.
4. **Understand the project.** Conduct a natural text or voice interview. For
   an existing repository, request explicit permission before scanning it and
   combine repository facts with the user's intent.
5. **Check readiness.** Inspect approved local tools and project requirements,
   then identify missing runtimes, MCPs, skills, accounts, or documentation.
   Never import another product's credentials or trust configuration silently.
6. **Compile the company.** Select the baseline roles, add project specialists,
   tailor their instructions, assign eligible models and tool bundles, define
   handoffs, and create review and quality gates within the chosen limits.
7. **Review one coherent proposal.** Present the product brief, initial goal and
   roadmap, agent company, tool bundles, permissions, models, and expected spend
   or unknown-cost boundaries. The user can edit, save, or approve it.
8. **Launch truthfully.** Persist the blueprint and project documentation, then
   start only the work the real runtime supports. Decorative agents must never
   appear active when no corresponding execution path exists.

For new projects, the original emphasis is a rich idea-to-company flow. For
existing projects, repository understanding and preservation of local policy
become equally important. Both compile to the same blueprint.

## What exists today

The current implementation includes the first complete company compiler and
execution vertical. It remains deliberately bounded: the approved roster is a
durable policy and assignment catalog, not a promise that every role runs
automatically.

| Capability | Current state |
| --- | --- |
| Reviewed provider catalog, saved accounts, BYOK, local runtime detection, and official Codex path | Implemented |
| Parent connection and model selection with billing-aware policy | Implemented |
| Ask Always, Approved for Me, and Full Access safety boundaries | Implemented |
| Versioned Economy, Standard, Balanced, Performance, and Max modes | Implemented |
| Optional Implement, Review, and Repair model routes | Implemented |
| Root-to-working-directory `AGENTS.md` policy loading | Implemented |
| Non-overwriting starter project brief | Implemented, intentionally minimal |
| Durable parent/child state and normalized activity | Implemented |
| Bounded isolated Implement, Review, and Repair team workflow | Implemented |
| Shared depth, concurrency, retry, request, permission, and cost limits | Implemented |
| Cancellation, recovery, staging, evidence, and explicit apply | Implemented |
| Short project classification, purpose, one constraint, and development-style intake | Implemented |
| Consent-gated inspection of ten allowlisted root marker names, without file contents | Implemented |
| Durable immutable version-1 `CompanyBlueprint` and eight tailored layered-company roles | Implemented |
| Explicit preview and approval of roster, authority, repository facts, tool readiness, quality, and first goal | Implemented |
| Fresh parent session bound to the approved orchestrator role | Implemented |
| Onboarding-generated durable initial goal and tailored quality plan | Implemented |
| Blueprint-aware parent-to-child handoff with durable result/evidence and parent synthesis | Implemented for one bounded depth-one role at a time |
| Automatic role selection, dependency decomposition, and handoff graph | Not implemented |
| Role-specific tool-bundle readiness plan | Implemented as bounded available/required policy; no installation |
| Natural model-authored interview, proposal editing, or generated roadmap | Not implemented |
| Automatic MCP/skill discovery, trust, or installation from the blueprint | Not implemented |
| Recursive lead-to-worker orchestration beyond depth one | Not implemented |
| Long-lived project learning and evidence-driven team adaptation | Not implemented |
| Company operating UI | Intentionally deferred |

In plain language: onboarding now creates and launches a real personalized
company policy. The parent can delegate a concrete task to one approved child
role through the existing engine and synthesize its result. It does not yet
run the whole roster, invent a dependency graph, install tools, recurse through
management layers, or continue working after the CLI exits.

## How the model and harness divide the work

This is primarily a harness feature, with models inside it.

The harness owns durable schemas, permission monotonicity, budgets, lifecycle,
tool access, model eligibility, delegation depth, concurrency, cancellation,
evidence, recovery, and truthful state. A model may analyze the project,
conduct the interview, propose roles, tailor prompts, decompose goals, and
synthesize results, but it cannot be trusted to enforce its own boundaries.

Most of the next foundation can be built and tested with scripted providers.
A real API key is useful later for qualitative end-to-end evaluation of the
interview and company proposal, but it is not needed to design or enforce the
company contracts.

## Next implementation slices

1. **Blueprint-directed team execution.** Map approved builder, reviewer, and
   repair roles onto the existing isolated durable-team workflow while keeping
   its worktree, review, apply, model-route, and accounting guarantees.
2. **Editable semantic intake.** Let a model conduct a richer interview and
   propose project-specific specialists or a roadmap, then validate all output
   against the closed harness policy and require a human review before launch.
3. **Tool readiness.** Resolve required tool bundles to installed skills and
   MCP configuration without automatically installing, trusting, or granting
   anything.
4. **Measured adaptation and deeper hierarchy.** Learn from durable evidence,
   then add bounded lead-to-worker delegation only after the depth-one company
   path remains reliable and cost-visible in real use.

Desktop UI, autonomous deployment, long-lived self-modifying agents, and
unbounded recursion remain outside this milestone.

## Success criteria

The onboarding/company milestone is real when a fresh user can explain a
project, inspect and approve a tailored company, launch it, and observe at least
one planned handoff complete through the existing permission/provider/runtime
seams—with durable evidence showing which agent acted, what it was allowed to
do, what it cost when reported, and how its result changed the parent plan.
