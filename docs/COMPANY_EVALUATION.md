# Company Evaluation

Recurs includes distinct versioned Quick, Guided, and Deep company-formation
scenarios that exercise the real restricted onboarding coordinator. They
evaluate adaptive interviewing, blueprint tailoring, role decomposition,
repository evidence, and request/cost efficiency. The historical
`company_formation_v1` ID remains loadable as a Guided compatibility alias.
Goal-result synthesis remains covered by deterministic runtime integration
tests and is marked `not_applicable` in formation-only scenarios.

Run the deterministic offline baseline:

```sh
npm run eval:company -- --scenario company_formation_guided_v1
```

Add `--json` for the strict `CompanyEvaluationReportV1` representation. The
offline run uses a scripted provider, reads only through the onboarding Plan
mode registry, performs no network request, and needs no API key.

To assess a real model, first configure a direct BYOK or local provider through
normal Recurs onboarding, make it the primary connection, and explicitly allow
the evaluation network request:

```sh
npm run eval:company -- \
  --scenario company_formation_guided_v1 \
  --configured --allow-network --json
```

Configured evaluation creates a temporary private Recurs home and copies only
the selected non-secret connection record. Environment credentials remain in
their existing environment variable; their values are never copied into the
report or temporary registry. The official Codex app-server connection is also
supported: decision turns receive no tools, optional Explore research receives
only the reviewed read-only onboarding tools, vendor approval requests are
denied, and authentication remains owned by Codex.

Reports contain a scenario version, sanitized provider/model identity,
backend fingerprint, latency, usage, reported cost when available, rubric
evidence, and bounded failures. They intentionally omit prompts, answers, raw
model output, environment values, and repository contents. Configured-provider
cost is marked unknown until the onboarding accounting seam can distinguish a
provider-reported zero from absent cost data.

`npm run check` executes all three depth-specific offline formation scenarios.
A real provider is useful for qualitative comparisons between models, but is
not required to verify Recurs's contracts or authority boundaries.

`npm run package:smoke-install` goes beyond formation-only evaluation. It packs
and installs the actual npm artifact into an empty private home, completes
Quick onboarding, approves a generated company, and launches a layered coding
goal through lead, Implement, Review, finding-driven Repair, re-review, parent
synthesis, and approved application. A separate fixture test verifies the
applied repository. The smoke uses a deterministic loopback provider and does
not need credentials or public network access. A company-owned apply finishes
inside the accepted goal after its exact approval; the resulting durable team
status is `approved` and must not be applied a second time.

## Company Proof campaigns

`recurs benchmark company --list` exposes three immutable coding fixtures:
`alias_registry`, the cross-file `layered_config`, and the review-sensitive
`retry_after`. Each configured campaign runs byte-identical fresh workspaces
through the selected parent-only baseline and the currently configured saved
role-route snapshot. When saved worker routes differ from the parent,
`--compare-all-strong` explicitly adds an all-strong bounded lineup.

```sh
recurs benchmark company --configured --allow-network \
  --scenario layered_config --repetitions 3 \
  --compare-all-strong --json
```

The hidden verifier, not model prose, determines correctness. Durable trials
record activated routes, role attempts and latency, review findings, Repair
rounds, usage and cache coverage, reported cost when available, changed-file
overlap, evidence, and unattended intervention counts. Immutable V1 campaign,
trial, reservation, settlement, and summary records remain unchanged. The
version-2 command report adds a derived attribution block: shared
parent-boundary failures stay in reliability but are separated from roster
evidence only when every arm satisfies the same strict pre-worker failure
conditions. Review and Repair completion/recovery counts are also derived
explicitly. Reports never choose a winner.

### 2026-08-06 installed active-use probe

An exact locally packed `0.1.0-alpha.6`-versioned artifact ran a configured
Quick formation followed by one installed `retry_after` comparison. The Sol
baseline passed all seven verifier checks in 114.090 seconds with one request.
The Sol/Terra/Luna company failed five checks in 361.380 seconds with five
requests. Terra Repair completed but made no material change, and the rejected
candidate was not applied.

That run drove a focused harness correction: a completed no-op repair is now
recorded durably and stops as `changes_requested` without paying for another
review of identical content. The full artifact provenance, metrics,
limitations, and correction boundary are in the
[installed active-use proof](research/2026-08-06-RECURS-INSTALLED-ACTIVE-USE-PROOF.md).
The run is additional evidence, not an amendment to the frozen 2026-08-04
aggregate decision below.

### Current frozen evidence (2026-08-04)

The current decision record contains 11 campaigns and 30 trials across three
harness revisions. Raw hidden-verifier passes were 9/13 for the Sol baseline,
7/13 for mixed Auto, and 1/4 for the all-Sol company. Two repetitions were
shared upstream Sol-parent/provider failures before any worker activated;
excluding only those six trials from roster comparison leaves 9/11, 7/11, and
1/2. They remain included in end-to-end reliability.

On the six matched successes, baseline versus mixed Auto used 6 versus 18
requests and 704,396 versus 1,282,356 input tokens. Auto was faster in 2/6 and
used fewer input tokens in 0/6. Terra Implement completed 10/10 observed
attempts. Seven final Luna approvals all passed the hidden verifier, while two
change-request outcomes did not recover: Terra Repair completed both requests
but recovered 0/2 candidates. Reported dollar cost is unknown for all 30
trials.

The decision remains **insufficient evidence for an Auto ranking**. The full
method, compatibility caveats, outage attribution, role evidence, and
reproduction notes are preserved in the
[versioned report](research/2026-08-04-RECURS-MODEL-TEAM-EVALUATION-V1.md).
The dated sections below remain useful historical run records, but they do not
supersede the frozen aggregate decision.

### 2026-07-29 three-scenario Codex comparison

A fresh configured campaign was run once for each built-in scenario through
the official saved Codex subscription connections. The baseline used Sol
(`gpt-5.6-sol`, high). The company used Sol as Parent, Terra
(`gpt-5.6-terra`, medium) for Implement/Repair, and Luna
(`gpt-5.6-luna`, medium) for Review.

| Scenario | Arm | Verifier | Time | Requests | Input (cached) | Output |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| `alias_registry` | Sol baseline | failed 1/7 | 168.4s | 1 | 183,988 (155,392) | 7,236 |
| `alias_registry` | company | passed 7/7 | 138.7s | 3 | 189,058 (146,944) | 5,249 |
| `layered_config` | Sol baseline | passed 7/7 | 90.7s | 1 | 98,083 (59,392) | 4,229 |
| `layered_config` | company | passed 7/7 | 110.1s | 3 | 149,500 (96,768) | 3,500 |
| `retry_after` | Sol baseline | passed 7/7 | 120.8s | 1 | 117,275 (93,696) | 5,067 |
| `retry_after` | company | passed 7/7 | 118.3s | 3 | 161,119 (104,192) | 4,546 |

The company passed all three scenarios; the baseline passed two. On tasks where
both passed, the company was slower once and slightly faster once, while using
three requests and more input tokens in both. Every company candidate received
independent approval and none required Repair. Dollar cost was unavailable.

### 2026-07-29 `alias_registry` replication

A later same-day pair reran the same immutable fixture:

| Arm | Verifier | Time | Requests | Input (cached) | Output |
| --- | --- | ---: | ---: | ---: | ---: |
| Sol baseline | passed 7/7 | 103.341s | 1 | 135,236 (91,648) | 4,824 |
| company | passed 7/7 | 125.310s | 3 | 159,828 (99,328) | 4,204 |

The company candidate received independent approval, and both arms passed all
seven checks. Dollar cost was unavailable.

The campaign and replication demonstrate that the machinery, saved routing,
independent review, hidden verification, and comparable-arm recording execute
correctly. They do not establish a quality or efficiency advantage: the task
catalog remains small, the replication is one additional pair, and there is no
all-strong-team comparison. Repeated trials are still required. The runs also
found and drove fixes for benchmark approval handling, bounded worker
verification, review evidence handoff, scenario-bound company authority, and
hidden-verifier versioning.

### 2026-07-30 Guided formation and three-way Codex proof

A fresh Guided formation run through the official Codex subscription initially
failed because the model added a field outside the strict onboarding-decision
schema. Recurs now makes at most one bounded repair request when request budget
remains. The repair prompt contains the validated schema error and original
decision context, but never echoes the invalid model output. A repeated live
run then completed in 190.0 seconds with six requests, two bounded repository
research assignments, three repository evidence items, six departments, eight
roles, and one independent-review role. Reported dollar cost remained
unavailable.

A fresh `alias_registry` campaign then compared all three supported
configurations on the byte-identical fixture:

| Arm | Verifier | Time | Requests | Input (cached) | Output | Review / Repair |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Sol baseline | passed 7/7 | 124.8s | 1 | 109,851 (74,496) | 4,040 | none |
| Sol/Terra/Luna company | passed 7/7 | 162.1s | 3 | 164,431 (99,328) | 4,525 | approved / 0 |
| all-Sol company | passed 7/7 | 454.7s | 6 | 389,060 (276,480) | 12,280 | changes requested, approved after 1 repair |

This single three-way campaign is evidence that the recommended mixed lineup
can execute the full bounded implementation and independent-review path. In
this run it preserved correctness with less latency and fewer tokens than the
all-strong company, while the single strong agent remained faster and cheaper
than either company. It is not enough evidence to rank a universal winner, and
the durable campaign correctly remains `insufficient_evidence`. The current
recommended lineup therefore remains a transparent candidate rather than an
automatic claim of superiority.

## Auto Team Alpha dogfood

On 2026-07-23, the safe configured dogfood path used the official saved Codex
subscription connections without copying credentials:

- Quick onboarding asked one adaptive question, used no research child, made
  two model requests, and approved a six-department/eight-role company.
- Company goal `e8f79115-26c4-4226-b885-e53bd08da7f7` activated one Sol parent
  (`gpt-5.6-sol`, high), Terra Implement/Repair routes (`gpt-5.6-terra`,
  medium), and an independent Luna Review route (`gpt-5.6-luna`, medium).
- The durable run completed three assignments within Balanced limits, applied
  a two-file patch, and the fixture's four tests passed.
- Provider-reported usage was 95,305 input / 1,293 output tokens for the Sol
  lead, 78,559 / 977 for Terra implementation, and 43,015 / 1,004 for Luna
  review: 216,879 input and 3,274 output tokens in total. Of the input total,
  161,024 tokens were reported as cached. Reported dollar cost was unavailable
  and remains unknown.
- `/model auto evaluate <run-id>` recorded a `partial` report because dollar
  cost coverage was unknown; decomposition, evidence, and synthesis passed.
  `/model auto` then selected that exact four-route snapshot.

The successful live review approved the first patch, so the configured Repair
fallback did not activate. The request-changes → bounded Repair → independent
re-review path remains proved by the deterministic `team-run-supervisor`
integration suite.
This formation-to-apply run plus the later three-scenario comparison proves the
lineup and comparison machinery execute end to end. It still does not show that
the named lineup is a universal winner or always more efficient than one
strong agent. The next configured evidence set should use at least three
repetitions per scenario, include the all-strong team where authorized, and run
the three depth-specific formation scenarios.
Possible prepaid-credit fallback requires explicit user authorization; catalog
inspection alone does not authorize model turns. Record quality, review
findings, repair rounds, elapsed time, total and cached tokens, and reported
cost when available; do not treat cache-heavy input as free.
