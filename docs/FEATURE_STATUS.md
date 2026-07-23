# Recurs Feature Status

**Audited:** 2026-07-23 against the source, exported package surfaces, CLI
assembly, durable contracts/stores, provider manifests, native targets, and
automated tests on `main`.

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
| Company authority | Immutable blueprints, root orchestrator and independent-review anchors, permission monotonicity, active-role/depth/concurrency/request/retry/reported-cost limits, cancellation, and truthful events |
| Company adaptation | Tailored role charters, attributable project knowledge, historical blueprint pinning, exact Skill/MCP bundle bindings, and approval-gated amendments |
| Evaluation | Discoverable versioned scenarios; deterministic offline formation; exact-connection, explicit-network configured formation; read-only exact-run company-goal scoring; sanitized reports and bounded human progress |
| Providers | Reviewed saved environment BYOK, literal-loopback Ollama/LM Studio, official local user-present Plan-only Codex ACP, and tested private macOS OpenAI/Anthropic/Kimi authority |
| Host safety | Permanent credential-path denial, clean child environments, bounded failures, macOS Seatbelt, Linux Bubblewrap, Git worktree isolation, and tamper-evident private state |

## Real but bounded

| Area | Boundary |
| --- | --- |
| Company hierarchy | Up to the selected operating mode's fixed depth and active-role ceiling; children do not freely create an unbounded recursive swarm |
| Background work | Durable and resumable while the Recurs process owns it; no daemon survives CLI exit |
| Cost enforcement | Uses provider-reported cost when available; unknown cost remains unknown, and already-running siblings may finish after a ceiling is crossed |
| Model selection | Users choose the parent and optional Implement/Review/Repair routes; Recurs does not automatically rank every model by quality or price |
| MCP and Skills | Exact enabled/trusted IDs can be bound to approved company bundles; Recurs does not install, trust, or infer a binding automatically |
| Codex subscription | Official adapter, existing ChatGPT authentication, local/manual/user-present, foreground, Plan-only; no plan-tier or remaining-quota claim |
| Native credentials | OpenAI, Anthropic, and Kimi verticals are implemented and tested but unavailable to normal users until signed/notarized distribution and production canary proof |
| Code intelligence | Strong lexical multi-language outlines and TypeScript project diagnostics; no general LSP or semantic reference engine |

## Prepared, not shipped

- npm package metadata, minimal bundle, empty-prefix installation smoke, and
  protected publication workflow;
- checksum-verifying curl installer and generated Homebrew formula derived from
  that exact npm archive; and
- the private macOS launcher/broker bundle foundation.

No npm package, curl release, Homebrew tap/formula, Bun runtime, signed native
binary, or desktop app is public today.

## Not implemented

- a full-screen company operating UI or desktop client;
- real-model quality gates for onboarding, decomposition, and synthesis;
- a persistent daemon, cloud worker, scheduler, or work that survives CLI exit;
- child-created unbounded recursion, autonomous organization rewrites, or
  automatic role/tool authority expansion;
- automatic plugin/MCP installation, a plugin marketplace, remote MCP/OAuth,
  MCP prompts/resources, or broad connector support;
- automatic model ranking or general capability/price-aware role routing;
- Windows subprocess containment and a Recurs-owned Linux seccomp policy;
- arbitrary public OpenAI-compatible endpoints or general cloud-identity
  onboarding;
- automatic commit, push, PR, deployment, or external messaging; and
- voice onboarding, a general LSP, or an endless `/loop`.

## Readiness assessment

The base harness and bounded heavy-company architecture are implemented. The
CLI now exposes read-only operating snapshots, deterministic formation,
explicit configured-provider dogfooding, and provider-free scoring of one
durable goal. Codex remains truthfully excluded from automated formation
because its subscription route is Plan-only and user-present. These implemented
workflows are not evidence of real-model quality until they are actually run
with an authorized provider. The largest remaining product risk is qualitative:
real models have not yet been exercised enough to prove that the interview
creates the right company, that delegation uses agents economically, and that
the final result consistently beats a strong single-agent run.

The next product milestone should therefore be real-provider dogfooding and
evaluation, followed by the already prepared alpha distribution path. A new
orchestration foundation is not the next step.
