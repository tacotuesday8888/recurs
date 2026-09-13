# Reproducible Recurs benchmarks

The published evidence does **not** establish a team advantage. `results.json`
is a sanitized export of real model-backed historical campaigns, not a fixture
simulation and not a new run on the current release.

## Inspect the evidence without a provider

```sh
npm ci
npm run build
node scripts/benchmark-evidence.mjs check
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
All 27 trial records and 30 slot settlements are retained, including failed
trials, unmatched-parent comparisons and the interrupted campaign. No run was
excluded based on outcome. The default website table is the last complete
matched-parent campaign in that inventory; other campaigns remain selectable.

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
```

The explicit selection controls what is exported. Local connection IDs become
stable one-way aliases so exact-parent comparisons still work. The source
SHA-256 fingerprints the contract-parsed records before aliases are substituted;
it permits a local owner to compare a regenerated export, not public recovery
of the private original. Fixture paths and bounded failure codes remain.
Re-export is deterministic and performs no model or network request.

This task could inspect the saved Sol/Terra/Luna connections but could not access
a supported foreground Terminal surface: Computer Use denied the Terminal app.
No scripted invocation was substituted and no fresh model-result claim is made.
The website therefore labels this entire release of evidence historical.
