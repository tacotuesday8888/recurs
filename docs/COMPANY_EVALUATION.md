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
overlap, evidence, and unattended intervention counts. V1 reports never choose
a winner.

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

This is useful product evidence, not a published winner: each scenario has one
pair, the task catalog is small, and there is no all-strong-team comparison.
It supports selective company activation for quality insurance, not mandatory
fan-out on every task. The runs also found and drove fixes for benchmark
approval handling, bounded worker verification, review evidence handoff,
scenario-bound company authority, and hidden-verifier versioning.

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
