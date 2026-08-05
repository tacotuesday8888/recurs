# Recurs Feature Status

**Audited:** 2026-08-05 against the source, exported package surfaces, CLI
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
| CLI | Interactive chat with slash completion; headless text, JSON, and JSONL; images; `review`; ACP v1; scoped help; offline `doctor`; explicit local-data location; project `AGENTS.md` loading |
| Permissions | Ask Always, Approved for Me, Full Access, enforced Plan mode, read-only Review mode, parent ceilings, explicit apply, exact session-scoped interactive grants, and private exact-workspace allow/ask/deny rules |
| Tools | Bounded file reads/list/search, code outline, TypeScript diagnostics, Git inspection, public web fetch, patching, verification, commands, and owned process sessions |
| Interoperability | Bounded Agent Skills, user-configured or explicitly project-trusted stdio MCP, a Recurs-owned ACP server, and observe-only user lifecycle hooks |
| General sub-agents | One Explore/Implement/Review child, bounded parallel Explore/Review batches, durable Implement teams, independent Review, finding-driven Repair, staging, recovery, explicit apply, and normalized live phase/status/review activity |
| Operating modes | Stable version-6 Economy, Standard, Balanced, Performance, and Max policies with historical V1-V5 loading |
| Backend routing | Explicit saved Implement/Review/Repair routes with revalidation, immutable per-run decisions, policy eligibility, and parent fallback |
| Company onboarding | Resumable Quick, Guided, and Deep interviews; Stable Core + Specialists or Guardrailed Dynamic designs; consented read-only research; conversational/YAML revisions; explicit approval |
| Company execution | Validated assignment DAGs, orchestrator/lead/worker planning handoffs, dependency-ordered implementation stages, independent review, bounded repair, parent apply, and synthesis |
| Company authority | Immutable blueprints; root and independent-review anchors; user-selected topology; frozen active-agent, depth, concurrency, escalation, review, repair, request, and reported-cost limits; claim-time revalidation; structured manager/root escalation; cancellation; truthful events |
| Company adaptation | Tailored role charters, attributable project knowledge, historical authority snapshots, exact Skill/MCP bundle bindings, approval-gated blueprint amendments, and repeated-run recommendations that can only narrow future team limits |
| Evaluation | Discoverable versioned scenarios; deterministic offline formation; exact-connection, explicit-network configured formation including Codex app-server; three hidden-verifier Company Proof fixtures; read-only exact-run company-goal scoring; sanitized reports, strict shared-parent-boundary versus roster attribution, separate Review/Repair recovery diagnostics, and bounded human progress |
| Model teams | `/model auto` records exact completed company-goal evidence and selects the most-supported eligible recorded configured Parent/Implement/Review/Repair lineup only when decomposition, evidence, and synthesis passed; selected routes apply to future sessions and remain inspectable, while Repair remains a fallback that may not activate |
| Providers | Reviewed saved environment credentials for API keys and coding plans, explicit billing/entitlement bindings, literal-loopback Ollama/LM Studio, and local user-present Codex subscription discovery/execution through the official app-server |
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
| Coding plans | Kimi Code and OpenCode Go use their documented fixed coding endpoints; Alibaba Coding Plan additionally requires a current-plan attestation and is rechecked for local/manual/user-present CLI use on every run; MiniMax Token Plan requires explicit prepaid-credit fallback acknowledgement. Z.ai GLM Coding Plan remains blocked pending written provider approval. |
| Code intelligence | Strong lexical multi-language outlines and TypeScript project diagnostics; no general LSP or semantic reference engine |
| Lifecycle hooks | The local CLI runs user-private, identity-bound executable hooks from a bounded asynchronous queue. They receive sanitized session/turn/tool/permission/agent/team envelopes in deterministic order and are observe-only, time/output bounded, read-only, network-denied, and unavailable to project configuration. Hook outcomes appear in text/JSONL; ACP and aggregate JSON do not claim live hook projection. |
| Permission rules | User-private rules match one canonical workspace, category, resource, and risk exactly, with redacted resource digests and no repository configuration or wildcard expansion. Persistent allows are root-only; credential denial, destructive-allow rejection, Plan mode, profile/tool policy, parent ceilings, path guards, and OS containment remain above the rule layer. |

## Distribution

- `0.1.0-alpha.6` npm package, minimal bundle, empty-prefix installation smoke,
  and protected publication workflow;
- checksum-verifying curl installer and official Homebrew tap formula derived
  from that exact npm archive; and
- a pinned Linux Bun smoke that globally installs the npm archive, preserves
  the Node shebang, runs it through Node.js, and proves it fails without Node.

There is no native Bun runtime, signed binary, Windows subprocess containment,
or desktop app. Bun's verified boundary is package installation, not Recurs
execution.

The package gate keeps the unpacked Recurs artifact below 2.1 MB. The exact
`0.1.0-alpha.6` archive measured 445 KiB compressed / 1.92 MiB
unpacked. Its 2026-08-05 Apple-silicon production prefix was 38.9 MiB. Optional Codex
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
- arbitrary in-process plugins, blocking/mutating hooks, automatic plugin/MCP
  installation, a plugin marketplace, remote MCP/OAuth,
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
and Luna as Review. The larger frozen evaluation now covers 11 campaigns and
30 trials: raw hidden-verifier passes were 9/13 for the Sol baseline, 7/13 for
mixed Auto, and 1/4 for the all-Sol company. Two repetitions were correlated
upstream parent/provider failures across every arm; excluding only those shared
outages leaves 9/11, 7/11, and 1/2, which still does not establish a winning
roster. Terra Implement completed 10/10 attempts, seven final Luna approvals
all passed the verifier, and Terra Repair completed 2/2 requests but recovered
0/2 candidates. Dollar cost remained unknown. See the
[versioned evidence report](research/2026-08-04-RECURS-MODEL-TEAM-EVALUATION-V1.md).
The terminal reports only activated agents, their exact model/effort and route
rationale, and bounded usage.

The controlled comparison surface includes three hidden-verifier coding
fixtures, distinct Quick/Guided/Deep formation scenarios, and campaigns that
compare the selected parent-only baseline against the currently configured
saved role-route snapshot, with an explicit option for an additional all-strong
bounded team. The next evidence milestone is a healthy-provider current-harness
run with at least three repetitions per fixture, wider role/effort crosses,
repair diagnosis, and real cost coverage. Activation, context, latency, and
review value must continue to be tuned only from durable results. A new
orchestration foundation is not the next step.
