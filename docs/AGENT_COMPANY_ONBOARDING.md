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
| Quick, Guided, and Deep adaptive onboarding with durable save/exit/resume | Implemented |
| Consent-gated project understanding through a closed read-only Plan registry | Implemented |
| Durable V2 stable-core or guardrailed-dynamic company blueprint | Implemented; V1 remains loadable and executable |
| Conversational and YAML proposal revision with structural diff and explicit approval | Implemented |
| Explicit preview and approval of roster, hierarchy, authority, repository facts, tool readiness, quality, and first goal | Implemented |
| Fresh parent session bound to the approved orchestrator role | Implemented |
| Onboarding-generated durable initial goal and tailored quality plan | Implemented |
| Blueprint-aware bounded parent → lead → worker handoffs with durable result/evidence | Implemented for approved read/planning assignments |
| Blueprint-directed parallel implementation → independent review → bounded repair → parent apply | Implemented through the existing durable team engine |
| Model-proposed assignment DAG with harness validation and parent synthesis | Implemented through `delegate_company_goal`; no claim of deterministic optimal decomposition |
| Role-specific tool-bundle readiness plan | Implemented as bounded available/required policy; no installation |
| Natural model-authored interview, proposal editing, and generated roadmap | Implemented behind strict contracts and user approval |
| Automatic MCP/skill discovery, trust, or installation from the blueprint | Not implemented |
| Unbounded recursion or autonomous role invention after approval | Not implemented |
| `/company` status, blueprint, activity, knowledge, and amendment inspection | Implemented; approve/reject becomes operational with the controlled amendment service |
| Long-lived project learning and evidence-driven team adaptation | Not implemented |
| Company operating UI | Intentionally deferred |

In plain language: onboarding now creates and launches a real personalized
company policy. The parent can run a validated company goal across bounded
planning handoffs and one parallel implementation batch, with independent
review, repair, evidence, shared accounting, and permission-controlled parent
apply. Inactive roster members remain inactive. Recurs does not install tools,
change the approved organization by itself, run unbounded recursion, or keep
compute alive after the CLI exits.

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

1. **CLI company operations.** Add truthful status, blueprint, activity,
   knowledge, amendment, and approved-goal launch commands over the durable V2
   state that already exists.
2. **Tool readiness.** Resolve required tool bundles to installed skills and
   MCP configuration without automatically installing, trusting, or granting
   anything.
3. **Measured adaptation.** Learn attributable project facts and successful
   patterns from durable evidence, then require explicit approval for every
   organizational amendment.

Desktop UI, autonomous deployment, long-lived self-modifying agents, and
unbounded recursion remain outside this milestone.

## Success criteria

The onboarding/company milestone is real when a fresh user can explain a
project, inspect and approve a tailored company, launch it, and observe a
bounded planned goal complete through the existing permission/provider/runtime
seams—with durable evidence showing which roles acted, what they were allowed
to do, what the workflow cost when reported, and how independently reviewed
work reached the parent.
