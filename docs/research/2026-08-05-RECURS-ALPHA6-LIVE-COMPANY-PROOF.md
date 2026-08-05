# Recurs Alpha.6-Line Current-Source Live Company Proof

- **Date:** 2026-08-05
- **Campaign:** `company-proof-f25e86f4-44a5-4765-80a6-36c251290be7`
- **Harness:** `recurs_0_1_0-alpha_6`
- **Source revision:** `7eebfdcf2feea61cf4ab56adf5c1107063ca5317`
- **Scenario:** `alias_registry` v1 with hidden verifier v2
- **Status:** one matched pair; insufficient for a model-team recommendation

The command used a clean locally built source checkout at the revision above.
That revision is two commits after the published `v0.1.0-alpha.6` tag, adding
stable company-failure diagnostics and a development-only lockfile advisory
fix. This is an alpha.6-line current-source proof, not an execution of the
exact published tag artifact.

## Frozen routes

| Role | Route |
| --- | --- |
| Parent and single-agent baseline | GPT-5.6 Sol, high effort |
| Implement and Repair | GPT-5.6 Terra, medium effort |
| Independent Review | GPT-5.6 Luna, medium effort |

The run used existing user-present Codex subscription connections. Recurs did
not copy credentials or require an API key.

## Results

| Observation | Sol baseline | Recurs company |
| --- | ---: | ---: |
| Hidden-verifier result | Passed | Passed |
| Workspace integrity | Passed | Passed |
| Requests | 1 | 3 |
| Wall time | 96.250 s | 127.640 s |
| Input tokens | 90,265 | 304,456 |
| Cached input tokens | 68,352 | 246,272 |
| Output tokens | 4,899 | 4,436 |
| Reasoning tokens | 2,842 | 1,531 |
| Reported dollar cost | Unavailable | Unavailable |

The baseline changed `src/alias-path.js` and `src/alias-registry.js` and passed
all visible and hidden checks. The company activated Parent, Implement, and
Review. Terra changed the same two files, Luna approved the staged candidate,
and the final applied workspace passed every check. Review requested no change,
so Repair correctly remained inactive. Neither trial recorded a failure or
requested user input.

The company was 31.390 seconds (32.6%) slower and used 3.37 times as many input
tokens in this pair. It added an independent review boundary, but this result
does not show that the review improved the already-passing implementation.

## Reproduction and recovery

After checking out the exact source revision, the campaign was created with:

```bash
npm ci
npm run build
node dist/cli/main.js benchmark company --configured --allow-network \
  --scenario alias_registry --repetitions 1 --json
```

After completion, this command returned the same frozen campaign, trial IDs,
timestamps, and usage without creating a new trial or model request:

```bash
node dist/cli/main.js benchmark company --allow-network \
  --resume company-proof-f25e86f4-44a5-4765-80a6-36c251290be7 --json
```

## Interpretation

This run proves that the pinned alpha.6-line current source can complete one
real Sol-parent → Terra-Implement → Luna-Review → Sol-synthesis goal through
the bounded worktree and hidden-verification engine. It does not prove the
exact published tag artifact ran this campaign. It also shows why Recurs must
not rank this lineup as universally better or cheaper:

- one matched pair is below the three-pair comparability floor;
- both arms passed, so the incremental review value is unknown;
- Repair did not activate;
- only one fixture and one repetition were observed; and
- provider-reported dollar cost was unavailable.

The next evidence slice should add repeated alpha.6 pairs across the other
frozen fixtures, include a deterministic review finding that exercises Repair,
and investigate company context/latency before changing `Models: Auto`.
