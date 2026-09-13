# Reproducible Recurs benchmarks

The published evidence does **not** establish a team advantage. The two evidence
sets are sanitized exports of real model-backed campaigns. `current-results.json`
contains one fresh foreground pair; `results.json` preserves the full historical
Round 2 inventory. Neither contains simulated model-quality results.

## Fresh foreground probe (2026-09-13 UTC)

One predeclared `retry_after` pair completed through the supported local
foreground CLI and existing official Codex app-server login. Both arms used the
exact same **gpt-5.6-luna / medium** parent route. The mixed team used Terra medium
for Implement and Repair, and Luna medium for Review. The exact frozen routes
are in `current-results.json`; names were verified from the campaign rather than
assumed from the current account list.

| Arm | Verified / planned | Time | Requests | Input (cached) | Output | Reported cost |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Luna medium, single agent | 1/1 | 90.432 s | 1 | 76,674 (59,136) | 3,628 | Unknown |
| Luna parent + Terra Implement/Repair + Luna Review | 1/1 | 229.438 s | 5 | 409,620 (320,768) | 7,796 | Unknown |

Both external verifiers passed all seven checks. The company completed one
implementation, two reviews and one repair; the repair recovered the trial.
The baseline had one confirmation callback, the company four; both recorded
zero user-input requests. These callbacks are not a measurement of human effort.
The campaign remained insufficient evidence (`minimum_comparable_pairs_not_met`
and `usage_incomplete`; token reporting was complete but dollar cost was absent).
One pair cannot establish quality, repair reliability, or a general efficiency
advantage. No retries, credits purchases, policy changes or outcome exclusions
were used.

Provenance: source base `69c0fe5`, dirty `codex/product-workflows` candidate;
executed `dist/cli/main.js` SHA-256
`760393acc9f3b3b9be2bcd20c0c095a1004156fd77f3fca3777cc2503e07142f`.
The running bundle was unchanged during the campaign. Later source, terminal
capture and website changes were **not tested by this campaign**. The dirty
source state is not reconstructible from the base commit alone; the artifact
hash identifies the executed candidate. The fixture protocol and measurement
export can be reproduced independently of this historical candidate.

Original foreground command:

```sh
recurs benchmark company --configured --allow-network \
  --scenario retry_after --repetitions 1
```

Campaign: `company-proof-61c66464-2c24-4cba-9897-8e8ff170ed48`.
Selection and provenance: `current-selection.json`.

## Inspect the evidence without a provider

```sh
npm ci
npm run build
npm run benchmark:check
node --test scripts/benchmark-evidence.test.mjs
npm --prefix website run check
```

The checker uses Recurs's strict campaign/trial/settlement contracts, checks
fixture and blueprint authority, route snapshots, slot identity and usage
settlement consistency, then recomputes the website metrics. It cannot prove a
historical provider response occurred or rerun the deleted historical candidate
workspace. Those limits remain distinct from schema and arithmetic validation.

`selection.json` fixes the full four-campaign inventory from the
[Round 2 report](../docs/research/2026-08-07-RECURS-MODEL-TEAM-EVALUATION-V2.md).
All 27 historical trial records and 30 slot settlements are retained, including failed
trials, unmatched-parent comparisons and the interrupted campaign. No run was
excluded based on outcome. The default website table is the fresh foreground
pair; every historical campaign remains selectable without pooling harnesses.

| Complete matched-parent campaign | Verified / planned | Median time | Total input | Total output |
| --- | ---: | ---: | ---: | ---: |
| Sol high, single agent | 3/3 | 108.298 s | 387,836 | 14,245 |
| Sol high + Terra medium Implement/Repair + Luna medium Review | 2/3 | 222.661 s | 1,291,111 | 22,272 |
| Sol high for all roles | 2/3 | 245.275 s | 1,454,805 | 28,230 |

These runs occurred on August 8, 2026, using `layered_config` and alpha.7.
Median time includes every recorded trial, including failures. Token totals
include cached input, with cache counts separately available. The sample is
three repetitions per arm on one fixture. It is not a statistically established
effect or a prediction for another task/model/version. **Reported dollar cost
is unknown.** Neither subscription allowances nor `costChargedUsd` reservation
accounting are observed spend. Incomplete token coverage produces `null` in
derived totals rather than a misleading partial total.

`externalConfirmationRequests` counts approval callbacks, including requests
handled by the benchmark's fixed preapproval policy. It is **not a measurement
of human intervention**. `userInputRequests`, automatic approvals/denials and
the original callback counts remain available. Human intervention duration was
not measured. Independent hidden tests, workspace integrity and completed
execution determine a pass; model approval is not correctness.

## Run a bounded new comparison

Use a supported local, user-present foreground Recurs session and the existing
official Codex app-server login. Do not copy credentials or change provider
execution policy to make a headless runner work. Inspect the current account
configuration first:

```sh
recurs account list --json
recurs benchmark company --list
recurs benchmark company --configured --allow-network \
  --scenario retry_after --repetitions 1
```

The default command freezes the same saved parent for both arms and the saved
Implement/Review/Repair routes for the company. Verify the route snapshot in
the returned campaign. This is one pair, at most two trial slots, 192 model
requests and $6 **reported-cost allowance**, not a promise of known spend or a
subscription quota cap. Each runtime is additionally bounded by the saved
operating-mode policy. Stop with Ctrl-C; retain failed/interrupted settlements
and never rerun silently. Do not purchase credits or enable fallback billing.

To repeat the fresh route lineup after account preferences change, pass explicit
local IDs for `--connection` and `--parent-connection` (Luna medium),
`--implement-connection` and `--repair-connection` (Terra medium), and
`--review-connection` (Luna medium). Resolve IDs through `recurs account list`;
never assume the primary model is Sol, Luna or any other model.

For a predeclared larger study, use all three immutable fixtures
(`alias_registry`, `layered_config`, `retry_after`), three repetitions each,
and `--compare-all-strong` only when separately authorized. Alternate arm order
is built into the harness. The baseline and company must use the exact same
parent model, effort and route for worker-quality attribution. A different
parent is an end-to-end observation only. Do not infer a universal ranking.

The fixture generator, objectives, visible tests and external hidden verifiers
are versioned in
[`company-benchmark-scenario.ts`](../packages/core/src/company-benchmark-scenario.ts).
The verifier is external to the model workspace; it is public repository code,
so this is not a contamination-resistant held-out benchmark. Fresh trials must
record source revision, harness version, route snapshot, fixture digest,
verifier version, exact command, interruptions and scope limits before any
result claim. Historical and current-harness results must stay separate.

## Refresh a public export

Only the local campaign/trial/settlement stores are read; no auth files,
environment values, prompts or raw model output are read or published.

```sh
node scripts/benchmark-evidence.mjs export
# Or: node scripts/benchmark-evidence.mjs export --recurs-home /path/to/home
node scripts/benchmark-evidence.mjs export \
  --selection benchmarks/current-selection.json \
  --results benchmarks/current-results.json
```

The explicit selection controls what is exported. Local connection IDs become
stable one-way aliases so exact-parent comparisons still work. The source
SHA-256 fingerprints the contract-parsed records before aliases are substituted;
it permits a local owner to compare a regenerated export, not public recovery
of the private original. Fixture paths and bounded failure codes remain.
Re-export is deterministic and performs no model or network request.

Computer Use denied access to the native Terminal app. The coordinated terminal
task subsequently ran the explicit bounded benchmark through the supported
foreground CLI tool with a PTY. No background runner, copied credentials or
weakened provider policy was substituted. The fresh pair is kept separate from
Round 2 and does not upgrade that study's conclusions.
