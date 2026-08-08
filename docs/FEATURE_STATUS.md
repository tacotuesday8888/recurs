# Recurs Feature Status

**Audited:** 2026-08-08 against the source, exported package surfaces, CLI
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
| CLI | Differential-rendered company map and interactive chat with slash/file completion, queued approvals, draft preservation, and images; headless text, JSON, and JSONL; `review`; ACP v1; scoped help; offline `doctor`; explicit local-data location; project `AGENTS.md` loading |
| Permissions | Ask Always, Approved for Me, Full Access, enforced Plan mode, read-only Review mode, parent ceilings, explicit apply, exact session-scoped interactive grants, and private exact-workspace allow/ask/deny rules |
| Tools | Bounded file reads/list/search, code outline, TypeScript diagnostics, Git inspection, public web fetch, patching, verification, commands, and owned process sessions |
| Interoperability | Bounded Agent Skills, user-configured or explicitly project-trusted stdio MCP, a Recurs-owned ACP server, and observe-only user lifecycle hooks |
| General sub-agents | One Explore/Implement/Review child, bounded parallel Explore/Review batches, durable Implement teams, independent Review, finding-driven Repair, staging, recovery, explicit apply, and normalized live phase/status/review activity |
| Operating modes | Stable version-6 Economy, Standard, Balanced, Performance, and Max policies with historical V1-V5 loading |
| Backend routing | Explicit saved Implement/Review/Repair routes with revalidation, immutable per-run decisions, policy eligibility, and parent fallback |
| Company onboarding | Resumable Quick, Guided, and Deep interviews; Stable Core + Specialists or Guardrailed Dynamic designs; consented read-only research; conversational/YAML revisions; explicit approval |
| Company execution | Validated assignment DAGs, orchestrator/lead/worker planning handoffs, dependency-ordered implementation stages, independent review, bounded repair, parent apply, and synthesis; the packed-install gate proves the complete formation-to-repaired-apply journey |
| Company authority | Immutable blueprints; root and independent-review anchors; user-selected topology; frozen active-agent, depth, concurrency, escalation, review, repair, request, and reported-cost limits; claim-time revalidation; structured manager/root escalation; cancellation; truthful events |
| Company adaptation | Tailored role charters, attributable project knowledge, historical authority snapshots, exact Skill/MCP bundle bindings, approval-gated blueprint amendments, and repeated-run recommendations that can only narrow future team limits |
| Evaluation | Discoverable versioned scenarios; deterministic offline formation; exact-connection, explicit-network configured formation including Codex app-server; three hidden-verifier Company Proof fixtures; read-only exact-run company-goal scoring; sanitized reports, additive per-trial runtime/roster/verification/harness failure scope with optional evidenced terminal stages, aggregate-only shared-parent-boundary attribution, separate Review/Repair recovery diagnostics, and bounded human progress |
| Model teams | `/model auto` records immutable V2 company-goal evidence that separates configured routes from actual activation. It requires three exact eligible runs with observed Parent/Implement/Review activity and passed decomposition, evidence, and synthesis; legacy V1 records remain readable but cannot activate Auto, and Repair remains an explicit fallback unless separately observed |
| Providers | Reviewed saved environment credentials for API keys and coding plans, explicit billing/entitlement bindings, literal-loopback Ollama/LM Studio, local user-present Codex subscription discovery/execution through the official app-server, and an opt-in official GitHub Copilot SDK path for `github.com` |
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

- `0.1.0-alpha.7` npm package, minimal bundle, empty-prefix installation smoke,
  and protected publication workflow;
- checksum-verifying curl installer and official Homebrew tap formula derived
  from that exact npm archive; and
- a pinned Linux Bun smoke that globally installs the npm archive, preserves
  the Node shebang, runs it through Node.js, and proves it fails without Node.

There is no native Bun runtime, signed binary, Windows subprocess containment,
or desktop app. Bun's verified boundary is package installation, not Recurs
execution.

The package gate keeps the unpacked Recurs artifact below 2.1 MB. The exact
`0.1.0-alpha.7` archive measured 453 KiB compressed / 1.96 MiB unpacked. Its
2026-08-06 Apple-silicon production prefix was 41.3 MiB. Optional Codex
compatibility packages are not downloaded with Recurs. Codex subscription
users supply the exact reviewed official CLI separately, so an existing Codex
installation is shared rather than duplicated. Source development still
installs the pinned Codex packages to exercise legacy compatibility and exact
app-server behavior in tests.

The published alpha.7 archive is the immutable tagged artifact. Current source
contains post-tag additions, including the Copilot path, for a later deliberate
preview; those additions are not retroactively claimed as published alpha.7
bytes. npm's `alpha` tag selects alpha.7, while unqualified `latest` still
selects alpha.2.

## Not implemented

- a full-screen company operations dashboard or desktop client;
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

The base harness and bounded company architecture are implemented. The exact
packed artifact passes an empty-home journey through Quick formation, layered
lead/Implement/Review, a rejected candidate, Repair, re-review, synthesis,
explicit apply, and an external fixture test. Codex subscriptions can run
restricted formation and foreground reviewed goals through Recurs-scoped host
tools. The terminal reports only activated agents, exact model/effort routes,
bounded usage, and truthful unknown cost.

`Models: Auto` remains an evidence gate, not a brand ranking. Round 2 added
current-harness and matched-parent evidence but did not pass the representative
fixture, durable completeness, matched-pair, non-inferiority, Repair recovery,
false-approval, or cost-coverage gates. Complete campaigns yielded 12
informative pairs but only six parent-matched pairs; in matched evidence the
baseline-only count was two and the company-only count was zero. One Luna
approval failed the hidden verifier. Complete campaigns supplied three Repair
attempts and only one recovery. Dollar cost remained unknown. See the
[Round 2 evidence report](research/2026-08-07-RECURS-MODEL-TEAM-EVALUATION-V2.md).

The 2026-08-08 RC dogfood independently repeated the false-approval failure
class: Sol/Terra/Luna completed with three requests and Luna approval, but the
hidden registry-boundary verifier failed; Repair did not activate. This single
run does not estimate a general error rate, and it strengthens no lineup claim.
The exact metrics and distribution checks are in the
[active-use RC evidence](ACTIVE_USE_RELEASE_CANDIDATE.md).

The next evidence milestone remains complete current-harness coverage of all
three frozen fixtures with at least three repetitions, at least nine matched
informative pairs, wider role/effort crosses, two or more demonstrated Repair
recoveries, zero false approvals, and real dollar-cost coverage. A new
orchestration foundation is not the next step.
