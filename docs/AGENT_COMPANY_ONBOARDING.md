# Agent Company Onboarding

**Status:** CLI company foundation implemented. This document distinguishes
the durable, bounded company system that exists now from later desktop,
distribution, and long-running-worker work.

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
  V2 supports a validated orchestrator → lead → worker planning hierarchy and
  one bounded parallel implementation → independent review → repair workflow.
  Arbitrary recursive delegation remains unavailable.
- **Use pre-built roles with tailored identities.** Stable role charters and
  permission ceilings are supplied by Recurs. Onboarding specializes their
  prompts, context, tools, model routes, and working relationships for the
  project. A free-form agent builder is not required for the first version.
- **Offer a coherent default and a guarded dynamic option.** Stable Core +
  Specialists uses Product, Engineering, QA, Security, Tools, and Deployment.
  Guardrailed Dynamic may propose project-specific departments and roles, but
  it cannot remove the root orchestrator or independent-review authority.
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
  and checks local readiness. Installed Skills and configured MCP servers are
  reported separately and never inferred to satisfy a bundle, become trusted,
  or gain role authority automatically.
- **The first run is both disciplined and visibly useful.** Blueprint approval
  starts no work. An explicit `/goal` may then run bounded planning and
  implementation in parallel, while review and permission gates decide what
  becomes accepted work.
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
| Blueprint-directed dependency-ordered implementation → independent review → bounded repair → parent apply | Implemented as finite reviewed frontiers through the existing durable team engine |
| Model-proposed assignment DAG with harness validation and parent synthesis | Implemented through `delegate_company_goal`; no claim of deterministic optimal decomposition |
| Role-specific tool-bundle readiness and exact Skill/MCP bindings | Implemented as immutable user-approved mappings; no automatic trust or installation |
| Natural model-authored interview, proposal editing, and generated roadmap | Implemented behind strict contracts and user approval |
| Consent-gated readiness view over installed Agent Skills and configured MCP servers | Implemented; catalogs grant nothing without an exact approved binding |
| Automatic MCP/Skill binding, trust, installation, or role-authority expansion from the blueprint | Intentionally not implemented; exact bindings require a local user decision |
| Unbounded recursion or autonomous role invention after approval | Not implemented |
| `/company` status, blueprint, readiness, activity, knowledge, and amendment inspection | Implemented, including exact-ID local approval/rejection of existing proposals |
| Durable attributable project learning supplied to future company goals | Implemented; secret-shaped evidence is rejected and historical sessions are unchanged |
| Controlled organizational amendments | Implemented as immutable proposals and explicit decisions; no automatic organization rewrite |
| Company operating UI | Intentionally deferred |

### Provider and delivery audit (2026-07-22)

The source CLI can run saved environment BYOK connections for 13 reviewed
fixed-origin providers: OpenAI API, Anthropic API, OpenRouter, xAI, OpenCode Go,
Kilo Gateway, Alibaba Model Studio, Kimi Platform, Kimi Code, MiniMax API, Z.ai
API, DeepSeek API, and Gemini API. It also supports literal-loopback Ollama and
LM Studio plus the official Codex app-server path under its local,
user-present, foreground subscription policy. The app-server discovers the
authenticated model/effort catalog and exposes only Recurs-owned host tools;
historical ACP records remain Plan-only. Catalog entries marked conditional or
blocked, and paths without a reviewed runnable adapter, are not silently
treated as runnable; this includes Claude subscription reuse, Copilot, Alibaba
Coding Plan, MiniMax Token Plan, Z.ai GLM Coding Plan, and cloud-identity paths
whose reviewed runtime is absent.

The release pipeline builds one minimal npm tarball, installs it into an empty
prefix, derives checksum-bound curl and Homebrew assets from that exact archive,
and supports an owner-controlled attested release. These are verified release
foundations, not published products: no npm package, Homebrew formula, curl
release, signed binary, or desktop app has shipped. Bun is verified only as an
npm-compatible installer for the prepared tarball on a pinned Linux CI lane;
Recurs still requires Node.js at runtime. The removed private native credential
authority is not a product path: current remote execution uses the documented
portable TypeScript adapters or an official delegated vendor runtime. No
speculative provider or installer surface was added by this audit.

In plain language: onboarding now creates and launches a real personalized
company policy. The parent can run a validated company goal across bounded
planning handoffs and multiple dependency-ordered implementation/review stages,
with repair, evidence, shared accounting, and permission-controlled parent
apply. Each active role receives a tailored immutable charter and only relevant
provenance-backed knowledge. Successful goal evidence can become context for
later goals. Approved amendments create a new blueprint revision for future
sessions;
the current session remains pinned to its historical revision. Inactive roster
members remain inactive. Recurs does not install tools, change the approved
organization by itself, run unbounded recursion, or keep compute alive after
the CLI exits.

## How the model and harness divide the work

This is primarily a harness feature, with models inside it.

The harness owns durable schemas, permission monotonicity, budgets, lifecycle,
tool access, model eligibility, delegation depth, concurrency, cancellation,
evidence, recovery, and truthful state. A model may analyze the project,
conduct the interview, propose roles, tailor prompts, decompose goals, and
synthesize results, but it cannot be trusted to enforce its own boundaries.

The enforcement foundation is tested with scripted providers. The versioned
offline company evaluation runs the real restricted onboarding path without a
key. A real direct/local provider is optional for qualitative interview and
proposal comparisons and must be selected explicitly with network opt-in; see
[Company evaluation](COMPANY_EVALUATION.md).

## Deliberate remaining boundaries

- Agent Skills and MCP servers are usable by a role only after a confirmed
  exact-ID binding to one of that role's approved tool bundles. Bindings do not
  install or trust capabilities and cannot widen parent/profile policy.
- Amendment proposal creation is a durable service boundary, not an autonomous
  self-reorganization loop. Existing proposals are inspectable and require an
  exact-ID, local, user-present decision.
- Real-provider qualitative scores are not release gates yet; the checked-in
  deterministic baseline remains the enforcement/regression gate.
- Desktop UI, autonomous deployment, automatic plugin/MCP installation, a
  daemon that survives the CLI, and unbounded recursive agents remain outside
  this milestone.

## Success criteria

The onboarding/company milestone is real when a fresh user can explain a
project, inspect and approve a tailored company, launch it, and observe a
bounded planned goal complete through the existing permission/provider/runtime
seams—with durable evidence showing which roles acted, what they were allowed
to do, what the workflow cost when reported, and how independently reviewed
work reached the parent.
