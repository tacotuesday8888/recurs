# Recurs Model-Team Evaluation Evidence Report — Round 2

**Report version:** 2.0

**Evidence cutoff:** 2026-08-08

**Source base:** `0833e549dcbed709d2bbf88a51f92b765df65c88`

**Evaluated harness:** `recurs_0_1_0-alpha_7`

**Durable campaign store:** `~/.recurs/evaluations/company-proof-v1`

**Decision status:** insufficient evidence for an Auto or worker-route promotion

## Recommendation

Keep Models: Auto and the current operating-mode policy unchanged.

Round 2 adds reproducible measurement and current-harness evidence, not a
winner. Parent-unmatched campaigns are end-to-end route observations only.
They do not isolate Implement, Review, or Repair quality. Complete matched-
parent pair coverage remained below its candidate threshold, and the
representative-fixture, durable-completeness, repair-recovery, false-approval,
and cost-coverage gates did not all pass. Reported dollar cost is unknown and
therefore cannot support a Lowest Cost recommendation.

## Predeclared decision gates

The analyzer freezes these candidate-screen thresholds before aggregating the
Round 2 campaigns:

| Gate | Threshold |
| --- | ---: |
| Current representative fixtures | `alias_registry`, `layered_config`, and `retry_after` |
| Repetitions per fixture | at least 3 |
| Outage-adjusted informative pairs | at least 9 |
| Parent-matched informative pairs for policy/worker review | at least 9 |
| Review-activated company trials | at least 9 |
| Repair evidence | at least 3 attempts and 2 recovered trials |
| False approvals | 0 |
| Reliability floor | company completion no more than 10 percentage points below baseline |
| Token coverage | complete for every recorded request |
| Dollar-cost coverage | complete before any dollar-cost comparison |

`companyOnlyPassed >= baselineOnlyPassed` is only a non-inferiority candidate
screen. It is not a significance test, a superiority claim, or a winner rule.
All other gates must also pass. An Auto or worker-policy review additionally
requires the parent-matched pair gate; unmatched-parent results cannot tip it.

## Experimental designs

Campaigns now freeze an optional `comparisonDesign`:

- absent or `shared_parent_v1`: every company arm uses the baseline's exact
  Parent route;
- `independent_company_parent_v1`: the fixed baseline and company Parent may
  differ.

The label discloses design only. The analyzer independently compares the full
effective Parent route for every company arm and emits `matched`, `unmatched`,
or a campaign-level `mixed`. Mixed campaigns keep each arm's outcomes in a
separate bucket.

A repetition is called `shared_parent_boundary_failure` only when every
matched arm records the same typed parent-boundary failure on the same
effective Parent route. Those trials remain in raw reliability totals and are
excluded only from outage-adjusted outcomes. Different parents are never
called shared merely because they fail together.

## Frozen routes and available matrix

The authenticated official Codex route exposed three reviewed connections:

| Saved route | Model | Effort | Observed use |
| --- | --- | --- | --- |
| strong | `gpt-5.6-sol` | high | baseline, Parent, all-strong workers |
| balanced worker | `gpt-5.6-terra` | medium | Parent, Implement, Repair |
| review worker | `gpt-5.6-luna` | medium | Review |

No API key was requested, copied, or read. The run used only the existing
Codex app-server connections. This environment did not contain reviewed saved
connections for every model/effort cross. Creating or rewriting authentication
state was outside this lane, so unsupported crosses remain a declared gap.

Planning and final synthesis currently share the Parent session observation.
The frozen benchmark blueprint contains no independent Exploration assignment.
Consequently this evidence can compare end-to-end Parent routes, Implement,
Review, and activated Repair, but cannot truthfully publish separate
Exploration, planning, or synthesis scores.

## Campaign inventory

Every campaign uses immutable fixtures, alternating arm order, three
repetitions, explicit request/reported-cost ceilings, durable reservations and
settlements, visible tests, workspace-integrity checks, and the external hidden
verifier.

| Campaign | Fixture | Parent design | Slots | Result |
| --- | --- | --- | ---: | --- |
| `company-proof-a2003c1d-0a5a-45da-a5a6-dc8ab3411c84` | `layered_config` | unmatched: Sol baseline ↔ Terra company | 6/6 settled | baseline 3/3; company 3/3 |
| `company-proof-51b3bdb1-4a05-4331-951a-14dc49545a9b` | `alias_registry` | unmatched: Sol baseline ↔ Terra company | 6/6 settled | baseline 3/3; company 2/3; one false approval |
| `company-proof-d0c7c179-a9a8-48c3-a053-61984370d4ce` | `layered_config` | matched: Sol parent for every arm | 9/9 settled; 6 trials | interrupted reliability evidence only; three rep-3 `adapter_failed` settlements |
| `company-proof-3e097996-56a2-4c84-90d4-cc2cef840723` | `layered_config` | matched: Sol parent for every arm | 9/9 settled and recorded | baseline 3/3; mixed company 2/3; all-Sol company 2/3 |

The two 6-slot campaigns freeze ceilings of 6 trial slots, 576 requests, and
$18 maximum reported cost. The two 9-slot campaigns freeze 9 slots, 864
requests, and $27 maximum reported cost. These are allowances, not observed
dollar cost.

| Fixture | Frozen SHA-256 | Hidden verifier | Objective revision |
| --- | --- | --- | --- |
| `alias_registry` | `442e5e5a476297693640606191b58eca98772d3eb85e6f9b7a0c7e1d6b5c4e2d` | `alias_registry_hidden_v2` | `alias_registry_objective_v1` |
| `layered_config` | `9afc323c32671ee372d1fdbd046ae37772d81433dcac32966a2da12ac48edbb4` | `layered_config_hidden_v1` | `layered_config_objective_v1` |
| `retry_after` | `ba99fc64c07892d54e15115bf04eb31ec5091755961d1d059ed794265ed5a22e` | `retry_after_hidden_v1` | `retry_after_objective_v1` |

The current harness is alpha.7. Round 2 does not rewrite historical alpha.5
records. It supplies current-harness `layered_config` campaigns and keeps
harness revision as an explicit stratum. The matrix stopped after the fresh
matched campaign because the existing false approval, missing reported cost,
and incomplete representative-fixture coverage already made Auto promotion
unreachable in this round; no additional subscription requests were spent.

## Reproducible commands

Connection identifiers are local non-secret record IDs. Replace the brackets
with reviewed IDs from `recurs account list --json`.

```bash
npm run build
node dist/cli/main.js account list --json

# Fixed Sol baseline, independently varied company Parent and workers.
node dist/cli/main.js benchmark company --configured --allow-network \
  --scenario layered_config --repetitions 3 \
  --connection <sol-high> --parent-connection <terra-medium> \
  --implement-connection <terra-medium> --review-connection <luna-medium> \
  --repair-connection <terra-medium>

# Matched Sol Parent with mixed-worker and all-Sol company arms.
node dist/cli/main.js benchmark company --configured --allow-network \
  --scenario layered_config --repetitions 3 --compare-all-strong \
  --connection <sol-high> --implement-connection <terra-medium> \
  --review-connection <luna-medium> --repair-connection <terra-medium>

node scripts/analyze-company-benchmarks.mjs \
  --campaign <campaign-id> [--campaign <campaign-id> ...]

# Resume uses only the frozen campaign authority; route flags are forbidden.
node dist/cli/main.js benchmark company --resume <campaign-id> --allow-network
```

`--connection` owns the fixed single-agent baseline. The four role-specific
connection flags apply only to company arms. `--resume` accepts no route
changes and reuses the immutable campaign.

## Current measurements

### Independent-parent `layered_config`

All six trials completed and passed workspace integrity plus the hidden
verifier. The baseline used 3 requests; the company used 9. Known usage was:

| Arm | Wall time | Requests | Input | Cached input | Output | Reasoning | Reported cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Sol/high baseline | 274.442s | 3 | 431,952 | 335,104 | 12,086 | 5,192 | unknown |
| Terra-parent mixed company | 396.084s | 9 | 810,241 | 669,696 | 11,220 | 3,654 | unknown |

Luna Review activated and completed in 3/3 company trials, approving three
hidden-verifier passes. Repair was not activated, so the campaign contributes
zero repair or recovery observations.

### Independent-parent `alias_registry`

All six slots settled. The baseline passed 3/3; the company passed 2/3. Luna
Review approved all three candidates, but one approved candidate failed the
hidden verifier. This is one observed false approval and prevents a review
safety claim from Round 2. Repair did not activate because Review approved the
candidate, so this outcome does not reproduce Terra Repair's historical 0/2.

### Interrupted matched-parent `layered_config`

This campaign has nine immutable reservations and nine terminal settlements,
but only six trial records. Repetition 3 settled `adapter_failed` for baseline,
mixed company, and all-Sol company with request charges 1/0/0. The aggregate
attribution cannot call this a shared parent-boundary outage because there are
no typed trial failures for that repetition. It remains raw reliability and is
not a complete roster comparison.

The official `--resume` command was run once as a reconciliation proof. It
returned in 0.49 seconds, made zero new model requests, and left byte-identical
SHA-256 fingerprints for all six trial files and all nine settlement files.
The completed-trial request total remained 16. No slot was retried or mutated.

### Complete matched-parent `layered_config`

All nine slots have valid reservations, trial-backed completed settlements,
and one validated summary. Baseline passed 3/3. The Terra/Luna mixed-worker arm
and all-Sol company arm each passed 2/3. Per-arm matched outcomes were therefore
`bothPassed=2, baselineOnlyPassed=1` for each company arm. No repetition met the
typed shared-parent-boundary outage rule.

| Arm | Wall time | Requests | Input | Cached input | Output | Reasoning | Reported cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Sol/high baseline | 301.181s | 3 | 387,836 | 304,896 | 14,245 | 6,838 | unknown |
| Terra/Luna mixed workers | 596.527s | 13 | 1,291,111 | 1,035,776 | 22,272 | 10,778 | unknown |
| all-Sol company | 825.436s | 11 | 1,454,805 | 1,170,176 | 28,230 | 15,507 | unknown |

Across all four selected campaigns, settlement-backed raw completion was
11/12 (91.7%) for baseline slots and 16/18 (88.9%) for company slots. This
passes only the predeclared 10-point reliability-deficit screen. Trial-based
analysis from complete campaigns produced 12 informative pairs and 6 parent-
matched informative pairs, with matched `baselineOnlyPassed=2` and
`companyOnlyPassed=0`. No pair was excluded as a shared outage. The incomplete
6/9 campaign lowers raw reliability but contributes no pair, review, repair,
token-coverage, or worker-policy gate evidence.

## Repair and review diagnosis

The prior Terra Repair result of 0 recoveries from 2 attempts did not reproduce
as a deterministic harness failure. Across current matched campaigns, Terra
Repair completed 3 attempts and 2 associated mixed-worker trials recovered;
one did not. The interrupted campaign's one recovery remains reliability and
diagnostic evidence only. Recommendation gates use complete campaigns, where
all company arms supply 3 repair attempts and only 1 recovery. This is
availability evidence, not proof that Terra is universally effective.

Luna Review completed every activated mixed-worker review in the selected
campaigns. Complete campaigns contribute 12 review-activated company trials
to recommendation gates; the independent `alias_registry` false approval
remains. In the fresh matched campaign two review/repair sequences still ended
in hidden verifier failure, so availability does not imply correctness or
prevention.

The exact aggregate screens are: representative fixtures false (`retry_after`
has 0 repetitions), durable campaigns complete false, matched-pair threshold
false, overall and matched non-inferiority candidate screens false, reliability
floor true, review activation true, repair recovery false, false-approval floor
false, complete token coverage true, and complete cost coverage false.

## Limitations

- Parent-unmatched deltas measure the whole route, including Parent behavior;
  they are never worker-causal evidence.
- The saved connection matrix covers Sol/high, Terra/medium, and Luna/medium,
  not every supported effort for every model.
- Exploration, planning, and synthesis are not separately observable in the
  frozen blueprint/recorder authority.
- Dollar cost was unreported. Subscription inclusion and token counts are not
  substituted for price.
- The fixture set is intentionally small. Passing the candidate screen would
  justify policy review, not an automatic winner or broad superiority claim.
- The interrupted campaign has valid immutable reservation/settlement
  authority but is incomplete. Its terminal failures affect raw reliability;
  its missing repetition never becomes synthetic trial or roster evidence.
- No provider transport, authentication, onboarding, native authority,
  terminal presentation, website, release, or marketing surface changed.

## Exact recommendation status

`insufficient_evidence`

Models: Auto remains unchanged. The shipped improvement is the additive
experimental-design authority, per-arm matched/unmatched projection, durable
evidence analyzer, current `layered_config` coverage, and truthful reporting.
