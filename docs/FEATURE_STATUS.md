# Recurs Feature Status

**Published alpha:** `0.1.0-alpha.11`. **Audited:** 2026-09-09 against source,
exported package surfaces, CLI assembly, durable contracts/stores, provider
manifests, automated tests and the public installed artifact. Exact evidence is
recorded in [Product polish](PRODUCT_POLISH.md).

This is the concise current capability inventory. Dated files under
`docs/superpowers/` are design and delivery records; their historical
checkboxes are not a live backlog. Research under `docs/research/` is preserved
context, not a product commitment.

## Implemented

| Area | Current capability |
| --- | --- |
| Base loop | Provider-neutral streamed turns, strict event reduction, bounded retries/steps/output, tool calls, cancellation, loop detection, steering, and queued follow-ups |
| Sessions | Durable version-2 sessions, exact backend pins, mutation leases, resume/fork, compaction, recovery, goals, checkpoints, and conflict-safe undo |
| CLI | Conventional team tree, actual execution inspector and scrollable Markdown chat with slash/file completion, queued approvals, draft preservation, images, and `/export` Markdown transcripts; headless text, JSON, and JSONL with `--resume`/`--continue`; `review`; ACP v1; scoped help; static shell completion; offline `doctor`; explicit local-data location; project `AGENTS.md` loading |
| Appearance | Persistent system/dark/light/contrast palettes, strict custom semantic colors, F2 preview/save/cancel, draft preservation and no-color support; full-screen terminal only |
| Permissions | Ask Always, Approved for Me, Full Access, enforced Plan mode, read-only Review mode, parent ceilings, explicit apply, exact session-scoped interactive grants, and private exact-workspace allow/ask/deny rules |
| Tools | Bounded file reads/list/search, code outline, TypeScript diagnostics, Git inspection, public web fetch, patching, verification, commands, and owned process sessions |
| Interoperability | Installable scoped Agent Skills with pinned GitHub bundles, user-configured or explicitly project-trusted stdio/HTTP MCP with OAuth, resources and prompts, a Recurs-owned ACP server, and observe-only user lifecycle hooks |
| Execution visibility | Ordinary, batch, team and company children share a durable execution inventory with exact parent IDs, model/effort, parent permission ceilings, recorded limits, transcripts, artifacts, usage availability, recovery commands, unknown-owner states and scoped cancellation |
| General sub-agents | One Explore/Implement/Review child, bounded parallel Explore/Review batches, durable Implement teams, independent Review, finding-driven Repair, staging, recovery, explicit apply, and normalized live phase/status/review activity |
| Operating modes | Stable version-6 Economy, Standard, Balanced, Performance, and Max policies with historical V1-V5 loading |
| Backend routing | Explicit saved Implement/Review/Repair routes with revalidation, immutable per-run decisions, policy eligibility, and parent fallback; `/agents routes` previews configured assignments without resolving a future child or editing past pins; provider discovery does not silently assign specialist routes |
| Company onboarding | Immediate coding after connection and authority, returning New chat through `/new`, saved-limit editing and explicit model/effort role choices, plus resumable Quick, Guided, and Deep interviews; Stable Core + Specialists or Guardrailed Dynamic designs; consented read-only research; conversational/YAML revisions; explicit approval |
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
| Company hierarchy | Exact execution-parent trees and read-only child inspection, within the selected mode's depth and active-role ceiling; cancellation requires a live owner. No unrestricted child steering or unbounded recursive swarm |
| Team adaptation | Requires at least two compatible completed goals, records exact usage rather than a quality winner, proposes only narrower future limits, and remains inactive until a local user approves |
| Background work | Durable and resumable while the Recurs process owns it; no daemon survives CLI exit |
| Cost enforcement | Uses provider-reported cost when available; unknown cost remains unknown, and already-running siblings may finish after a ceiling is crossed |
| Model selection | Local interactive `/model` offers a saved-connection picker with confirmation/revalidation and a fresh session; non-picker hosts retain a text list. Users may choose explicit routes or activate evidence-backed Auto for the current `general_coding` task class; Recurs does not infer a winner without eligible completed-goal evidence or perform broad price/capability ranking |
| MCP and Skills | Exact enabled/trusted IDs can be bound to approved company bundles; Recurs does not install, trust, or infer a binding automatically |
| Codex subscription | Exact reviewed user-installed Codex CLI, official app-server login/discovery/execution, local/manual/user-present foreground execution, Recurs-scoped host tools, and optional Sol/Terra/Luna parent/role routing; no remaining-quota claim, background work, or vendor continuation in V1 |
| Coding plans | Kimi Code and OpenCode Go use their documented fixed coding endpoints; Alibaba Coding Plan additionally requires a current-plan attestation and is rechecked for local/manual/user-present CLI use on every run; MiniMax Token Plan requires explicit prepaid-credit fallback acknowledgement. Z.ai GLM Coding Plan remains blocked pending written provider approval. |
| Code intelligence | Strong lexical multi-language outlines and TypeScript project diagnostics; no general LSP or semantic reference engine |
| Lifecycle hooks | The local CLI runs user-private, identity-bound executable hooks from a bounded asynchronous queue. They receive sanitized session/turn/tool/permission/agent/team envelopes in deterministic order and are observe-only, time/output bounded, read-only, network-denied, and unavailable to project configuration. Hook outcomes appear in text/JSONL; ACP and aggregate JSON do not claim live hook projection. |
| Permission rules | User-private rules match one canonical workspace, category, resource, and risk exactly, with redacted resource digests and no repository configuration or wildcard expansion. Persistent allows are root-only; credential denial, destructive-allow rejection, Plan mode, profile/tool policy, parent ceilings, path guards, and OS containment remain above the rule layer. |

## Distribution

`0.1.0-alpha.11` is published after passing source and installed-package gates
on Linux and macOS. Fresh public npm and curl installations are verified.
The JavaScript bundle retains its 2.10 MB ceiling. npm, Bun-as-installer,
checksum-verifying curl and Homebrew all use the same npm archive. There is no
native Bun runtime, signed standalone binary or Windows subprocess sandbox.

The September 9 publication check found npm `alpha` at `0.1.0-alpha.11` and
`latest` at `0.1.0-alpha.2`. The registry archive matches the attested GitHub
release bytes. The matching Homebrew tap update passed its install/test gate
and is merged. Exact source, artifact, and verification evidence is in the
[release record](PRODUCT_POLISH.md).

## Not implemented

- a desktop client;
- enough repeated and statistically useful real-model evidence to publish a
  default Sol/Terra/Luna winner;
- a persistent daemon, cloud worker, scheduler, or work that survives CLI exit;
- child-created unbounded recursion, autonomous organization rewrites, or
  automatic role/tool authority expansion;
- arbitrary in-process plugins, blocking/mutating hooks, automatic extension installation, a plugin marketplace, or universal third-party compatibility;
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

The alpha.8 review traced that failure and the earlier Round 2 false approval
through their durable reviewer sessions. Both reviewers had the objective,
boundary-specific acceptance criteria, staged diff access, visible test
evidence, and the known alias-boundary risk. No missing context or authority
defect was demonstrated. The concrete product defect was first-run Codex setup
silently assigning the same unevaluated specialist lineup. Fresh setup now
leaves role routes on the selected parent, preserves explicit existing routes,
and keeps Models Auto evidence-gated. One fresh parent-fallback comparison
passed both arms but remains insufficient evidence. See the
[alpha.8 review-integrity report](research/2026-08-10-RECURS-REVIEW-INTEGRITY-ALPHA8.md).

The next evidence milestone remains complete current-harness coverage of all
three frozen fixtures with at least three repetitions, at least nine matched
informative pairs, wider role/effort crosses, two or more demonstrated Repair
recoveries, zero false approvals, and real dollar-cost coverage. A new
orchestration foundation is not the next step.
