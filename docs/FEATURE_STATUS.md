# Recurs Feature Status

**Audited:** 2026-07-30 against the source, exported package surfaces, CLI
assembly, durable contracts/stores, provider manifests, and automated tests in
this release candidate.

This is the concise current capability inventory. Dated files under
`docs/superpowers/` are design and delivery records; their historical
checkboxes are not a live backlog. Research under `docs/research/` is preserved
context, not a product commitment.

## Implemented

| Area | Current capability |
| --- | --- |
| Base loop | Provider-neutral streamed turns, strict event reduction, bounded retries/steps/output, tool calls, cancellation, loop detection, steering, and queued follow-ups |
| Sessions | Durable version-2 sessions, exact backend pins, mutation leases, resume/fork, compaction, recovery, goals, checkpoints, and conflict-safe undo |
| CLI | Interactive chat; headless text, JSON, and JSONL; images; `review`; ACP v1; scoped help; offline `doctor`; project `AGENTS.md` loading |
| Permissions | Ask Always, Approved for Me, Full Access, enforced Plan mode, read-only Review mode, parent ceilings, and explicit apply |
| Tools | Bounded file reads/list/search, code outline, TypeScript diagnostics, Git inspection, public web fetch, patching, verification, commands, and owned process sessions |
| Interoperability | Bounded Agent Skills, user-configured or explicitly project-trusted stdio MCP, and a Recurs-owned ACP server |
| General sub-agents | One Explore/Implement/Review child, bounded parallel Explore/Review batches, durable Implement teams, independent Review, finding-driven Repair, staging, recovery, and explicit apply |
| Operating modes | Stable version-6 Economy, Standard, Balanced, Performance, and Max policies with historical V1-V5 loading |
| Backend routing | Explicit saved Implement/Review/Repair routes with revalidation, immutable per-run decisions, policy eligibility, and parent fallback |
| Company onboarding | Resumable Quick, Guided, and Deep interviews; Stable Core + Specialists or Guardrailed Dynamic designs; consented read-only research; conversational/YAML revisions; explicit approval |
| Company execution | Validated assignment DAGs, orchestrator/lead/worker planning handoffs, dependency-ordered implementation stages, independent review, bounded repair, parent apply, and synthesis |
| Company authority | Immutable blueprints; root and independent-review anchors; user-selected topology; frozen active-agent, depth, concurrency, escalation, review, repair, request, and reported-cost limits; claim-time revalidation; structured manager/root escalation; cancellation; truthful events |
| Company adaptation | Tailored role charters, attributable project knowledge, historical authority snapshots, exact Skill/MCP bundle bindings, approval-gated blueprint amendments, and repeated-run recommendations that can only narrow future team limits |
| Evaluation | Discoverable versioned scenarios; deterministic offline formation; exact-connection, explicit-network configured formation including Codex app-server; three hidden-verifier Company Proof fixtures; read-only exact-run company-goal scoring; sanitized reports and bounded human progress |
| Model teams | `/model auto` records exact completed company-goal evidence and selects the most-supported eligible recorded configured Parent/Implement/Review/Repair lineup only when decomposition, evidence, and synthesis passed; selected routes apply to future sessions and remain inspectable, while Repair remains a fallback that may not activate |
| Providers | Reviewed saved environment BYOK, literal-loopback Ollama/LM Studio, and local user-present Codex subscription discovery/execution through the official app-server |
| Host safety | Permanent credential-path denial, clean child environments, bounded failures, macOS Seatbelt, Linux Bubblewrap, Git worktree isolation, and tamper-evident private state |

## Real but bounded

| Area | Boundary |
| --- | --- |
| Company hierarchy | Up to the selected operating mode's fixed depth and active-role ceiling; children do not freely create an unbounded recursive swarm |
| Team adaptation | Requires at least two compatible completed goals, records exact usage rather than a quality winner, proposes only narrower future limits, and remains inactive until a local user approves |
| Background work | Durable and resumable while the Recurs process owns it; no daemon survives CLI exit |
| Cost enforcement | Uses provider-reported cost when available; unknown cost remains unknown, and already-running siblings may finish after a ceiling is crossed |
| Model selection | Users may choose explicit routes or activate evidence-backed Auto for the current `general_coding` task class; Recurs does not infer a winner without eligible completed-goal evidence or perform broad price/capability ranking |
| MCP and Skills | Exact enabled/trusted IDs can be bound to approved company bundles; Recurs does not install, trust, or infer a binding automatically |
| Codex subscription | Exact reviewed user-installed Codex CLI, official app-server login/discovery/execution, local/manual/user-present foreground execution, Recurs-scoped host tools, and optional Sol/Terra/Luna parent/role routing; no remaining-quota claim, background work, or vendor continuation in V1 |
| Code intelligence | Strong lexical multi-language outlines and TypeScript project diagnostics; no general LSP or semantic reference engine |

## Distribution

- `0.1.0-alpha.3` npm package, minimal bundle, empty-prefix installation smoke,
  and protected publication workflow;
- checksum-verifying curl installer and release Homebrew formula derived from
  that exact npm archive; and
- a pinned Linux Bun smoke that globally installs the npm archive, preserves
  the Node shebang, runs it through Node.js, and proves it fails without Node.

There is no Homebrew tap, native Bun runtime, signed binary, Windows subprocess
containment, or desktop app. Bun's verified boundary is package installation,
not Recurs execution.

The package gate keeps the unpacked Recurs artifact below 2.1 MB. The exact
`0.1.0-alpha.3` archive was 433 KiB compressed / 1.87 MiB unpacked, and its
2026-07-30 Apple-silicon production prefix was about 38.8 MiB. Optional Codex
compatibility packages are not downloaded with Recurs. Codex subscription
users supply the exact reviewed official CLI separately, so an existing Codex
installation is shared rather than duplicated. Source development still
installs the pinned Codex packages to exercise legacy compatibility and exact
app-server behavior in tests.

## Not implemented

- a full-screen company operating UI or desktop client;
- enough repeated and statistically useful real-model evidence to publish a
  default Sol/Terra/Luna winner;
- a persistent daemon, cloud worker, scheduler, or work that survives CLI exit;
- child-created unbounded recursion, autonomous organization rewrites, or
  automatic role/tool authority expansion;
- automatic plugin/MCP installation, a plugin marketplace, remote MCP/OAuth,
  MCP prompts/resources, or broad connector support;
- automatic task classification, evidence-expiry policy, or general
  capability/price-aware role routing;
- Windows subprocess containment and a Recurs-owned Linux seccomp policy;
- arbitrary public OpenAI-compatible endpoints or general cloud-identity
  onboarding;
- automatic commit, push, PR, deployment, or external messaging; and
- voice onboarding, a general LSP, or an endless `/loop`.

## Readiness assessment

The base harness and bounded heavy-company architecture are implemented. The
CLI now exposes read-only operating snapshots, deterministic formation,
explicit configured-provider dogfooding, and provider-free scoring of one
durable goal. Codex subscriptions can now execute restricted pre-approval
company formation and foreground parent/company assignments through
Recurs-scoped tools. `Models: Auto` is implemented as an evidence gate rather
than a brand ranking. One safe formation-to-apply Codex dogfood completed Quick
formation, approval, a reviewed coding goal, parent synthesis, and
evidence-backed Auto activation with Sol as parent, Terra as Implement/Repair,
and Luna as Review. A later fresh three-scenario comparison ran that lineup
against the same Sol parent: the company passed all three hidden verifiers and
the single-agent baseline passed two. On the two shared successes the company
used more input tokens, was slower once, and slightly faster once. Dollar cost
remained unknown. The terminal reports only activated agents, their exact
model/effort, and bounded usage.

The controlled comparison surface includes three hidden-verifier coding
fixtures, distinct Quick/Guided/Deep formation scenarios, and campaigns that
compare the selected parent-only baseline against the currently configured
saved role-route snapshot, with an explicit option for an additional all-strong
bounded team. The remaining evidence milestone is repetition: run at least
three pairs per scenario, include alternative teams where authorized, and tune
activation, context, latency, and review value only from durable results. A new
orchestration foundation is not the next step.
