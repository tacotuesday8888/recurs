# Recurs Model-Team Evaluation Evidence Report

**Report version:** 1.0
**Evidence cutoff:** 2026-08-03T02:21:07.154Z
**Report date:** 2026-08-04
**Repository revision:** `f03a77564f628175255879a8847d6efaebb0b802`
**Durable campaign store:** `~/.recurs/evaluations/company-proof-v1`
**Decision status:** insufficient evidence for an Auto ranking

## Executive recommendation

Do not publish a universal Sol/Terra/Luna Auto winner from this evidence.

- **Best Quality:** insufficient evidence. Sol/high single-agent has the highest
  observed raw verifier rate, 9/13 (69.2%), and the highest rate after excluding
  two clearly shared upstream outage repetitions, 9/11 (81.8%). Mixed Auto is
  7/13 raw (53.8%) and 7/11 outage-adjusted (63.6%). The 13 matched baseline ↔
  Auto pairs contain six both-pass outcomes, three baseline-only passes, one
  Auto-only pass, and three both-fail outcomes. This is too small and too
  heterogeneous across harness revisions to establish a quality winner.
- **Balanced:** insufficient evidence. Keep the configured mixed lineup as a
  transparent candidate when independent review is explicitly desired, not as
  an automatic default. Its Luna review route showed useful safety behavior,
  but the company did not demonstrate a repeatable correctness advantage over
  the baseline and its Terra repair route succeeded 0/2.
- **Lowest Cost:** Sol/high single-agent is the best current *usage proxy*, not
  a dollar-cost winner. On the six pairs where both arms passed, baseline used
  6 requests and 704,396 input tokens versus Auto's 18 requests and 1,282,356
  input tokens. Reported dollar cost is unknown for all 30 trials, so no actual
  price ranking is supportable.
- **Overall:** insufficient evidence. Preserve Custom routing and keep Auto's
  rationale/sample count visible until current-harness repetitions cover all
  three fixtures and at least one alternative lineup without a shared outage
  window.

## Scope and method

This report uses only Recurs's immutable Company Proof fixtures and durable
benchmark records. It does not inspect credentials, copy authentication, or
modify production harness code.

The official Codex app-server connections were confirmed through the sanitized
`account list` surface:

| Route | Model | Effort |
| --- | --- | --- |
| Parent / baseline | `gpt-5.6-sol` | high |
| Auto Implement | `gpt-5.6-terra` | medium |
| Auto Review | `gpt-5.6-luna` | medium |
| Auto Repair | `gpt-5.6-terra` | medium |
| All-strong Parent / Implement / Review / Repair | `gpt-5.6-sol` | high |

The evidence contains 11 campaigns, 30 trials, 30 reservations, 30 settlements,
and 11 summaries. Every reservation has a durable trial and completed
settlement. The final frozen campaign,
`company-proof-160f5aa0-8d47-49d0-a1f2-7037b4ee5be8`, has all nine planned
slots. Running the official `--resume` command after reconciliation made zero
model requests and returned the existing immutable report. Its process status
was nonzero because the completed campaign includes failed trials, not because
resume was incomplete.

The evidence spans three harness labels: `recurs_development`,
`recurs_0_1_0-alpha_1`, and `recurs_0_1_0-alpha_5`. Aggregate results are useful
for reliability history, but current-product recommendations must give more
weight to alpha.5 and must not silently pool harness revisions as identical.

## Evidence inventory and raw outcomes

| Scenario | Arm | Trials | Completed | Hidden verifier passed | Completion | Correctness |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `alias_registry` | Sol baseline | 9 | 6 | 5 | 66.7% | 55.6% |
| `alias_registry` | mixed Auto | 9 | 5 | 5 | 55.6% | 55.6% |
| `alias_registry` | all-Sol company | 4 | 1 | 1 | 25.0% | 25.0% |
| `layered_config` | Sol baseline | 2 | 2 | 2 | 100% | 100% |
| `layered_config` | mixed Auto | 2 | 1 | 1 | 50.0% | 50.0% |
| `retry_after` | Sol baseline | 2 | 2 | 2 | 100% | 100% |
| `retry_after` | mixed Auto | 2 | 1 | 1 | 50.0% | 50.0% |
| **All fixtures** | **Sol baseline** | **13** | **10** | **9** | **76.9%** | **69.2%** |
| **All fixtures** | **mixed Auto** | **13** | **7** | **7** | **53.8%** | **53.8%** |
| **All fixtures** | **all-Sol company** | **4** | **1** | **1** | **25.0%** | **25.0%** |

Across every arm, 18/30 trials completed and 17/30 passed the hidden verifier.
All 30 recorded workspace, visible-test, and hidden-verifier outcomes. One
completed baseline trial failed hidden verification, which is why completion
and correctness differ.

### Current alpha.5 evidence

Alpha.5 has 13 trials: baseline 5, Auto 5, and all-Sol company 3. Raw passes are
3/5, 2/5, and 0/3. Two repetitions in the final campaign are shared upstream
outages affecting all three arms. Removing only those six non-informative
trials leaves baseline 3/3, Auto 2/3, and all-Sol 0/1. Alpha.5 has no
`layered_config` campaign, so current-harness fixture coverage is incomplete.

## Shared upstream failure attribution

Final-campaign repetitions 2 and 3 are not roster comparisons:

- all six arms activated only the shared Sol/high parent;
- every attempt failed with `coordinated_runtime_failed`;
- every attempt lasted 228.4–229.4 seconds at the role level, and every trial
  settled in 229.3–230.2 seconds;
- none produced a token usage report; and
- Terra Implement, Luna Review, and either Repair route never activated.

These six failures remain in raw completion/reliability rates. They are excluded
only from the roster-informative view below:

| Arm | Informative trials | Completed | Passed |
| --- | ---: | ---: | ---: |
| Sol baseline | 11 | 10 | 9 |
| mixed Auto | 11 | 7 | 7 |
| all-Sol company | 2 | 1 | 1 |

This exclusion does not rescue an Auto winner. It prevents a correlated parent
or provider outage from being misattributed to Terra or Luna.

The remaining execution failure codes are four `company_goal_failed`, one
`company_goal_not_executed`, and one baseline `runtime_execution_failed`.
Thirteen failed trials also record `scenario_verification_failed`, as expected
when the workspace is incomplete or incorrect.

## Matched baseline versus mixed Auto evidence

There are 13 byte-identical baseline ↔ Auto pairs:

| Pair outcome | Count |
| --- | ---: |
| Both pass | 6 |
| Baseline only passes | 3 |
| Auto only passes | 1 |
| Both fail | 3 |

Two of the three both-fail pairs are the shared upstream outages above. The
discordant quality evidence is therefore only four pairs, three favoring the
baseline and one favoring Auto. This is not enough for a stable quality claim.

On the six shared successes:

| Metric | Sol baseline | Mixed Auto | Interpretation |
| --- | ---: | ---: | --- |
| Requests | 6 | 18 | Auto used exactly 3× |
| Input tokens | 704,396 | 1,282,356 | Auto used 1.82× |
| Cached input | 525,568 | 913,152 | Auto used 1.74× |
| Output tokens | 29,477 | 29,526 | effectively equal |
| Reasoning tokens | 16,906 | 13,925 | Auto reported fewer |
| Wall time | 1,180.242s | 1,125.366s | Auto 4.6% lower in aggregate |

Auto was faster in only 2/6 shared successes and used fewer input tokens in
0/6. Its aggregate wall advantage is dominated by one unusually slow 586.3s
baseline trial; it is not a stable latency win.

## Individual role capability

The current task matrix is role-confounded: Terra is observed only as
Implement/Repair, Luna only as Review, and Sol as Parent/baseline plus the
limited all-strong lineup. It does not cross every model with every role or
effort.

| Model / role | Trial observations | Attempts | Completed | Failed | Median attempt latency |
| --- | ---: | ---: | ---: | ---: | ---: |
| Sol/high single-agent | 13 | 13 | 10 | 3 | 153.3s |
| Sol/high Auto parent | 13 | 13 | 10 | 3 | 204.4s |
| Terra/medium Implement | 10 | 10 | 10 | 0 | 54.4s |
| Luna/medium Review | 10 | 17 | 15 | 2 | 42.1s |
| Terra/medium Repair | 2 | 2 | 2 | 0 | 30.1s |
| Sol/high all-strong Implement | 2 | 2 | 1 | 1 | 174.3s |
| Sol/high all-strong Review | 1 | 3 | 3 | 0 | 83.0s |
| Sol/high all-strong Repair | 1 | 1 | 1 | 0 | 44.8s |

Planning/orchestration and final synthesis are combined in the parent
observation. Exploration was not activated by any Company Proof trial and has
no durable cross-model evidence here. Review and Repair samples for all-Sol are
one candidate each and must not be generalized.

## Pairing evidence

### Planner → Implementer

Mixed Auto reached a Sol→Terra implementation handoff in 10/13 trials. Terra
completed all 10 implementation attempts. Seven of those ten pipelines ended
in verifier passes. Two upstream outage trials and one historical
`company_goal_not_executed` trial never reached Terra.

The all-Sol company reached implementation in 2/4 trials. Sol completed one of
two implementation attempts; the completed path later passed after review and
repair. Two other trials failed at the shared parent before handoff.

This favors Terra as the more reliable observed implementer, but the samples
are not a randomized model swap and span harness revisions.

### Implementer → Reviewer

All ten mixed-Auto implementation candidates reached Luna review. Across 17
review-role requests, 15 completed and two failed. The durable review outcomes
were:

- seven final approvals, all seven followed by hidden-verifier passes;
- two final change-request outcomes, containing nine findings total; and
- one unverified outcome after reviewer execution failures.

There are no observed false approvals. Luna therefore added independent safety
value: it approved passing candidates and blocked two candidates that did not
become valid. It did not demonstrate a net correctness lift because those two
blocked candidates were not repaired successfully, and one reviewer failure
prevented completion.

### Reviewer → Repairer

Luna activated Terra Repair in 2/10 reviewed mixed-company candidates. Both
repair attempts completed, but neither trial reached approval or passed hidden
verification: repair success is 0/2.

The one all-Sol reviewed candidate produced two findings, activated Sol Repair,
then passed re-review and hidden verification: 1/1. This is a real repair
success, but one sample cannot justify routing all repair work to Sol/high,
especially given the lineup's high usage and later implementation/upstream
failures.

## Work duplication and code quality

All 30 trials recorded zero duplicate Implement changed-file claims and zero
Implement-overlap paths. The benchmark assigns one implementer, so this shows
the current company flow avoided duplicated implementation work; it does not
test parallel multi-implementer overlap. Three trials activated Repair, and two
repairs intentionally touched implementation paths.

Final code quality is measured by visible tests plus the immutable hidden
verifier. Seventeen trials passed every check. No separate maintainability or
style judge exists in this evidence, so no broader code-quality claim is made.

## Usage and cost

These are sums of known reports. Trials with missing usage contribute no tokens
and are reflected in coverage, not treated as zero-cost successes.

| Arm | Trials | Requests | Input | Cached input | Output | Reasoning | Token coverage |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Sol baseline | 13 | 13 | 1,588,495 | 1,249,280 | 57,605 | 33,963 | 11 complete, 2 none |
| mixed Auto | 13 | 41 | 2,680,470 | 2,011,648 | 66,111 | 35,234 | 9 complete, 1 partial, 3 none |
| all-Sol company | 4 | 10 | 600,752 | 475,648 | 15,185 | 8,824 | 1 complete, 1 partial, 2 none |

Total recorded wall time is 2,421.866s baseline, 3,016.819s mixed Auto, and
1,222.638s all-Sol. Raw totals mix successes, failures, fixture distributions,
and outage waits; matched-success comparisons above are more decision-useful.

Reported dollar cost is unknown for 30/30 trials. Unknown is preserved as
unknown. Subscription inclusion and token counts are not a valid dollar-price
substitute.

## Prioritized tuning recommendations

1. **Separate shared upstream availability from roster scoring.** Detect a
   repetition where all arms fail on the same parent route with the same
   bounded latency and no usage, label it provider/upstream-invalid for quality
   comparison, and retain it in operational reliability reporting.
2. **Do not let one shared planner collapse every arm.** Add an evaluation mode
   that holds the Sol baseline fixed while independently varying company parent
   and worker routes, or add a parent-bypass role test. The current all-arm Sol
   parent creates correlated failures and obscures worker quality.
3. **Complete current-harness coverage before ranking.** After provider health
   recovers, run at least three alpha.5 repetitions of `alias_registry`,
   `layered_config`, and `retry_after` for baseline, mixed Auto, and one
   alternative lineup. The current alpha.5 set has no `layered_config` and only
   one roster-informative all-Sol trial.
4. **Cross models and efforts by role.** At minimum, compare Sol/Terra for
   Implement, Luna/Sol for Review, and Terra/Sol for Repair on the same frozen
   candidates. Add explicit planning/synthesis tests and an exploration fixture;
   the current evidence cannot distinguish model ability from role assignment.
5. **Improve repair evidence before spending on stronger review.** Investigate
   why Terra Repair completed 2/2 requests but recovered 0/2 candidates. Preserve
   the independent review findings and staged candidate as evaluation evidence,
   then test whether context quality or repair model choice changes success.
6. **Treat reviewer reliability as a first-class metric.** Luna had two failed
   review requests in one `retry_after` trial, leaving the result unverified.
   Report review availability separately from finding quality and use bounded
   retry/backoff without converting missing review into approval.
7. **Require demonstrated marginal review value.** A stronger reviewer is
   justified when it finds actionable defects that repair successfully or
   prevents a false approval at an acceptable latency/usage increment. Current
   Luna evidence shows prevention value but no repair lift; current Sol evidence
   shows one successful repair at high usage. Neither clears a default-routing
   threshold.
8. **Collect price coverage before a Lowest Cost claim.** Keep reported cost
   unknown until the provider supplies it. Continue showing requests, known
   input/cached/output/reasoning tokens, latency, and coverage alongside cost.
9. **Keep Auto conservative.** Require repeated current-harness evidence across
   fixtures, a declared quality floor, minimum eligible pair counts, and
   freshness. A one-off Auto-only win or all-Sol repair success must not change
   routing by itself.

## Reproducibility notes

- Fixtures: `alias_registry` v1 / `alias_registry_hidden_v2`,
  `layered_config` v1 / `layered_config_hidden_v1`, and `retry_after` v1 /
  `retry_after_hidden_v1`.
- Final campaign harness: `recurs_0_1_0-alpha_5`;
  launch protocol: `company-benchmark-launch-v1`; operating policy:
  `balanced_v6`.
- Final campaign summary:
  `benchmark_summary_053d5a2f44b5e402e8832612dfd7eacd`.
- Final campaign result: 9/9 trials settled; correctness and efficiency both
  `insufficient_evidence`; token coverage partial; cost coverage none.
- No durable evidence was deleted, rewritten, or manually edited.
- No production harness source was changed for this report.
