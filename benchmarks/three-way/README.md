# Three-way task comparison: runbook

The [protocol](PROTOCOL.md) was frozen and pushed before any model request.
This file says how to run it; results are added only after the run.

## Before running

- Build the repository: `npm ci && npm run build`.
- Claude Code is signed in to the Claude subscription (`claude` works in a
  terminal), and Recurs shows the GPT-5.6 Luna, Terra and Sol connections in
  `node dist/cli/main.js account list`.
- The Codex connections allow a declared prepaid-credit fallback. If the
  account holds prepaid credits, reaching the plan limit could spend them. The
  runner stops at the first usage-limit or billing message.

## Run

Start it in your own local terminal (the Recurs harness requires a
user-present session for subscription use):

```bash
bash benchmarks/three-way/run.sh
```

It runs 18 attempts for the three-way question and 12 for the team question,
writing raw records to `harness/` and `claude/`, retained candidate source to
`artifacts/`, and the aggregate to `results.json`. Expect one to two hours.
If it stops early, the remaining attempts are reported as not run; do not
restart them.

## After running

`node scripts/three-way-report.mjs` rebuilds `results.json` from the raw
records. Then audit every finished candidate's source for grader
introspection, hard-coded answers and global tampering, record any rejection
with its evidence in `audit.md`, and report the outcome, including attempts
that did not finish.
