# Company Proof And Efficiency Alpha

> Historical implementation checklist. The code-backed current state lives in
> `docs/FEATURE_STATUS.md` and `docs/COMPANY_EVALUATION.md`; unchecked boxes
> below preserve the original planning record and must not be read as the
> current product inventory.

**Goal:** Prove when Recurs's bounded company earns its orchestration overhead,
make that evidence durable and inspectable, remove known onboarding context
waste, exercise the real Repair route, keep the Codex integration current, and
finish with a clean packaged alpha candidate.

**Architecture:** Preserve `CompanyEvaluationReportV1`, existing company goal
and team journals, model-team V1 records, and all provider/permission
boundaries. Add an immutable benchmark layer that executes the same built-in
fixture and objective through the existing single-parent runtime and approved
company runtime in fresh workspaces. A hidden fixture-owned verifier supplies
correctness; existing durable records supply role, review, repair, timing, and
usage evidence. Benchmarking never becomes a second agent engine.

**Delivery:** Implement in focused PR-sized branches. Benchmark foundation,
onboarding efficiency, and Codex compatibility are independent first PRs; each
later slice starts from the merged `main`. Every slice uses tests first, full
verification, diff/secret review, PR CI, merge, and non-destructive main sync.
Release publication, desktop UI, a marketplace, remote MCP/OAuth, arbitrary
provider endpoints, and unbounded recursion are excluded.

## Non-negotiable boundaries

- A configured trial requires explicit network consent and exact saved
  connection IDs. It copies only non-secret connection records into isolated
  temporary state.
- Every trial gets a fresh fixture workspace and Recurs home. The arm order is
  deterministic and alternates by repetition to reduce temporal bias.
- A campaign has exactly one single-agent baseline and one to three company
  arms. Every company arm uses the baseline's exact parent connection, model,
  and effort; only the bounded team policy may vary.
- Campaign-wide request, trial-slot, and known-cost ceilings are authoritative.
  Trials run sequentially, terminal failures consume their deterministic slot,
  and cancellation stops the campaign without silently retrying completed or
  persisted work.
- Model-written code is verified only through existing OS-contained process
  execution with network denied, a clean environment, bounded time, and bounded
  output.
- Reports omit prompts, raw model output, repository contents, credentials,
  environment values, private paths, and vendor continuation identifiers.
- Unknown usage or cost remains unknown. Cached input is reported separately
  and is never treated as free. Coverage is explicit as
  `none | partial | complete`; missing cost is distinct from zero cost.
- `changed_file_overlap_v1` is a narrow duplication signal. It is not described
  as semantic duplication.
- Review activity, findings, and Repair rounds are observations, not causal
  proof of review value unless a pre/post verifier demonstrates a difference.
- Unattended evaluation counts and denies requests for human intervention.
- Existing V1 evaluation, model-team, session, company, and team records remain
  fully loadable.
- Benchmark reports never choose or market a winner. V1 records only
  `insufficient_evidence | comparable`; a future versioned policy may make a
  recommendation after at least three comparable pairs for the exact
  scenario, arm, and harness revision.

## Slice 1 — immutable benchmark foundation

### Contracts and stores

- [ ] Add `packages/contracts/src/company-benchmarks.ts`.
- [ ] Define strict, frozen V1 contracts for:
  - scenario references: ID, version, task class, difficulty, fixture digest,
    verifier ID;
  - campaign configuration: exact parent baseline, one to three company arms,
    configured routes, operating mode, permission mode, repetition count,
    campaign-wide ceilings, harness/launch-protocol revisions, blueprint
    identity/revision/digest, and deterministic arm order;
  - trial observations: `single_agent | company`, exact route snapshot,
    activated routes, timestamps, external verification, per-role attempt and
    wall-clock metrics, aggregate usage and coverage, review verdict/count/path,
    evidence counts, repair rounds, external-confirmation and user-input
    intervention counts, auto approval/denial counts, changed files, narrow
    overlap metrics, and bounded failures;
  - campaign summary: completed trial IDs, comparable pairs, winner
    eligibility `insufficient_evidence | comparable`, and bounded rationale.
- [ ] Reject unknown fields, duplicate roles/trials, inconsistent timestamps,
  impossible usage provenance, unsafe paths, incomplete comparable pairs,
  non-finite metrics, and mismatched fixture/scenario versions.
- [ ] Add immutable private campaign/trial stores using existing atomic
  publication and tamper-detection primitives. Trials are idempotent by exact
  identity and never overwritten.

### Scenarios and pure scoring

- [ ] Add one no-dependency built-in coding scenario with a deterministic
  materializer, objective, hidden verifier, and fixture digest.
- [ ] Add a pure projector that de-duplicates root and child session journals
  before deriving role latency, requests, input/output,
  cached/cache-write/reasoning tokens, reported cost, findings, repair rounds,
  evidence counts, Implement-to-Implement changed-file overlap, and
  intervention counts from existing runtime/company/team records. Repair
  overlap remains separate. Total latency is trial wall time, never the sum of
  concurrent role latencies.
- [ ] Add a conservative comparability classifier. Correctness and safety are
  required; missing cost cannot become zero; no V1 winner is inferred.
- [ ] Unit-test contracts, stores, materialization, metrics, sanitization,
  cancellation, partial campaigns, resumption, and deterministic ordering.

## Slice 2 — real single-agent versus company execution

- [ ] Add an injected `CompanyBenchmarkExecutionAdapter` and a pure
  `CompanyBenchmarkRunner`.
- [ ] Materialize a fresh workspace and private Recurs home for every trial.
- [ ] Copy only the exact parent/Implement/Review/Repair non-secret connection
  records and immutable routing required by that campaign.
- [ ] Run the single-agent arm through `createStandaloneRuntime` with no company
  blueprint by entering `/goal <objective>` and then submitting the exact
  objective.
- [ ] Run the company arm through the same runtime, same parent/model effort,
  same permission and operating mode, and a deterministic approved benchmark
  blueprint. Launch the exact same objective through `/goal`.
- [ ] Capture normalized events and load the resulting company and team journals
  read-only for metrics.
- [ ] Keep the hidden verifier outside the model-visible Git workspace. Run it
  read-only against the workspace through the existing sandbox with network
  denied, a clean environment, timeout, and output limits. Record only stable
  check IDs/statuses, while also validating Git HEAD/base, staged/untracked
  state, allowed paths, file modes, symlinks, and inventory.
- [ ] Close runtimes and clean temporary state even on cancellation or failure.
- [ ] Add an offline scripted integration proving both arms execute against
  byte-identical starting fixtures without widening authority.
- [ ] Add a strict CLI scenario with list/JSON/progress/resume support.
  Configured execution requires both `--configured` and `--allow-network`.

## Slice 3 — context and observability quality

### Onboarding efficiency

- [ ] Stop combining cumulative decision prompts with a session that also
  retains every prior cumulative prompt. Use fresh one-shot decision and
  revision sessions keyed by run revision/request sequence while the durable
  onboarding run remains the sole state authority.
- [ ] Preserve bounded research synthesis as an explicitly untrusted handoff
  alongside attributable tool citations. Citations remain the only provenance.
- [ ] Enforce the eight-call research ceiling in code, including multiple calls
  emitted in one model response; prompt text is not a security boundary.
- [ ] Test Quick, Guided, and Deep interruption/resumption and prove later
  requests contain one canonical state snapshot, not prior decision transcripts
  or repeated full blueprints.

### Role observations and Auto honesty

- [ ] Join company goal assignments to correlated team journals read-only.
- [ ] Populate benchmark role observations from existing timestamps, routes,
  usage, findings, and Repair records; do not modify supervisor authority.
- [ ] Add backward-compatible model-team evidence that distinguishes configured
  routes from routes actually activated in the run.
- [ ] Require observed Parent, Implement, and Review evidence before Auto can
  describe a lineup as evaluated. An unobserved Repair route remains an explicit
  fallback and is never marketed as evaluated.
- [ ] Record only whether evidence is comparable. Do not wire benchmark output
  into Auto until a separately reviewed versioned recommendation policy has
  enough repeated evidence.

## Slice 4 — Repair proof and representative evidence

- [ ] Add at least two more versioned fixtures: one cross-file behavior change
  and one review-sensitive edge-case change.
- [ ] Add a fully scripted deterministic Repair regression first. Separately
  seek a naturally triggered configured Repair run. Do not introduce a
  benchmark-only mixed execution engine merely to force a real Repair route;
  if deterministic route injection is needed, design it as a small production
  routing seam with its own authority tests.
- [ ] Separately run a flawed-candidate detection scenario to evaluate a real
  Review route without forcing its verdict.
- [ ] Run Quick, Guided, and Deep configured onboarding evaluations through the
  existing Codex subscription as distinct versioned scenarios and record
  sanitized qualitative/usage evidence.
- [ ] Run bounded comparable campaigns for the strong parent and at least two
  company lineups. Do not publish a winner without comparable repeated passes.
- [ ] Tune prompts, activation, and context only from recorded evidence. Retain
  all before/after scenario and harness revisions.

## Slice 5 — Codex/ACP compatibility and install weight

### Compatibility set

- [ ] Treat `@agentclientprotocol/codex-acp` 1.1.7,
  `@agentclientprotocol/sdk` 1.3.0, and `@openai/codex` 0.145.0 as one reviewed
  compatibility set. Do not merge their independent Dependabot PRs.
- [ ] Update exact runtime/profile/integrity/platform allowlists, generated
  policy, onboarding constants, fixtures, disclosures, notices, and package
  checker together.
- [ ] Run full tests, installed npm/Bun smokes, catalog discovery, and one safe
  read-only Codex turn before merging.

### Default install footprint

- [ ] Do not move Codex to `optionalDependencies` and claim success: npm installs
  optional dependencies by default and `codex-acp` currently pulls Codex
  transitively.
- [ ] Design and implement the smallest truthful decoupling:
  - keep the generic ACP SDK required;
  - prefer an exact reviewed user-installed official Codex CLI for app-server;
  - move account login/catalog/session behavior to the existing official
    app-server path;
  - remove the legacy ACP-only Codex package dependency only after equivalent
    authentication and runtime tests pass;
  - fail with an actionable setup message when Codex is not installed.
- [ ] Measure packed and installed dependency size before and after. Do not
  claim a reduction that merely moved bytes between dependency categories.

## Slice 6 — documentation and final delivery

- [ ] Mark old native/Swift designs as historical or superseded at their entry
  points without rewriting the project record.
- [ ] Update feature status, product direction, architecture, CLI, evaluation,
  Auto-team, public-alpha, and release documentation with exact implemented
  boundaries and benchmark evidence.
- [ ] Run focused suites repeatedly, then `npm run check`,
  `npm run package:smoke-install`, the pinned Bun installer smoke, security
  review, secret scan, and safe real Codex dogfood.
- [ ] Review every diff and generated file, commit focused changes, push, open
  PRs, address review/CI failures, and merge only with green Linux/macOS/Bun
  checks.
- [ ] Fetch and fast-forward canonical `main`, verify local `main` equals
  `origin/main`, verify the canonical checkout is clean, and report all
  remaining branches/worktrees and whether they contain unique commits.

## Acceptance

- The same immutable scenario can be run and resumed across a strong
  single-agent arm and a company arm without sharing mutable workspace state.
- External verification, not model prose, determines correctness.
- Per-role activation, latency, usage/cache/cost provenance, findings, Repair,
  interventions, and narrow overlap evidence are durable and inspectable.
- Quick, Guided, and Deep no longer replay quadratic cumulative transcripts.
- Auto never describes an unobserved route as evaluated.
- A deterministic Repair regression passes through Recurs-owned boundaries.
  Any claimed real configured Repair evidence comes from a truthful production
  route, not a benchmark-only mixed provider.
- The compatible ACP/Codex set passes locally and in CI.
- The default install footprint is truthfully reduced, or the decoupling is
  rejected with measured evidence and no false optional-dependency claim.
- All intended work is merged, local and remote main are identical, and no
  completed feature commit remains stranded.
