# Direct Codex comparison — prepared, not run

Three authored tasks in a small issue-tracking service:

| Task | What counts as finished |
| --- | --- |
| Fix reported bugs | Repair tenant isolation, cursor pagination and private-field leaks; add passing regression tests. |
| Build a feature | Implement atomic bulk close, including validation, tests and documentation; preserve existing behavior. |
| Catch hidden bugs | Write API tests that accept repaired code and reject three independently seeded regressions. |

This is a small, Recurs-authored development exercise, **not a full application
benchmark**. The third task measures regression-test effectiveness, not general
bug discovery. Every candidate needs a code review before its outcome is published;
the grader alone cannot distinguish a useful test from source inspection or a
hardcoded answer. References and grader mutation tests validate the harness, not
either model's ability.

## Fixed comparison

Run all three tasks twice with both products: **12 attempts**, alternating which
product goes first. Each attempt gets a fresh Git workspace, the same task prompt,
a five-minute wall-time limit, and no package downloads. Stop after one hour.
Do not retry failed attempts or choose tasks after seeing results. Preserve
unfinished, failed and invalid attempts alongside the complete planned inventory.

The control is the **official Codex CLI**, not a Recurs single-agent configuration.
Both products use official Codex **0.145.0**, matching Recurs's pinned runtime;
the system's separate 0.154.0 installation is excluded. Pin executable hashes,
Node version, model routes, prompts and fixture hashes before the first request.

Codex uses Luna medium. Recurs uses the same Luna medium parent, Luna medium review,
and Terra medium implementation/repair in balanced mode. This compares two complete
configurations, including their model mix and tools. It cannot isolate a harness-only
effect or establish superiority over every Codex configuration. Recurs decides
whether to delegate; no benchmark-only team prompt is injected. Record whether
delegation actually occurred before describing an attempt as team execution.

Codex runs with `workspace-write`, ignoring user configuration but preserving
execution rules. Its `approval_policy="never"` denies actions requiring approval;
it does not bypass the sandbox. Recurs uses its existing `approved` workspace
policy. Record permission failures as failures; do not silently broaden access.
Both reuse existing official authentication without copying credentials. These
local fixtures are not adversarial isolation: review traces for reads of grader
or reference files, and label contaminated attempts invalid without replacement.

## Metrics and publishing

Show tasks finished out of attempts, seeded regressions caught out of three, and
wall time for every attempt. Keep failures in time summaries. Preserve individual
results; two repetitions cannot establish a dependable general ranking.

Private raw JSONL traces are retained for a separate usage audit. The runner starts
token and dollar fields as **null**, not zero. Before publishing token comparisons,
verify complete parent/child coverage and avoid counting the same runtime both in
its completion and handoff events. Cached input is a subset of input, not extra
tokens. Provider-reported costs remain unavailable unless actually observed;
subscription token counts do not establish dollars saved. No invented score or
estimated price will be substituted for missing evidence.

Do not connect these prepared tasks to website charts as results. Keep the existing
pilot records intact. A future export must include the frozen inventory, outcomes,
manual audit and measured coverage; it must not relabel the earlier pilot as Codex.

## Local use

All commands below except `run` are offline or read-only installation checks.

```sh
node --test scripts/direct-benchmark/*.test.mjs
node scripts/direct-benchmark/suite.mjs plan /tmp/recurs-direct-plan.json
node scripts/direct-benchmark/suite.mjs check-plan /tmp/recurs-direct-plan.json
node scripts/direct-benchmark/suite.mjs prepare fix-issues /tmp/issue-desk-candidate
node scripts/direct-benchmark/suite.mjs grade fix-issues /tmp/issue-desk-candidate
```

Create a private JSON configuration outside the repository with absolute
`codexLauncher` (official npm launcher), `codexBinary` (the matching native binary),
`recursBundle` (a frozen built executable), and `connections` mapping parent,
implement, review and repair to existing Recurs connection IDs. Never include keys
or copy authentication files into it. Preflight validates versions and redacted
route metadata without sending a model request.

```sh
node scripts/direct-benchmark/run.mjs preflight /tmp/direct-config.json /tmp/unused
# Only after this new, bounded campaign is authorized:
node scripts/direct-benchmark/run.mjs run /tmp/direct-config.json /tmp/new-direct-campaign
```

The foreground runner reserves slots before launching models, caps captured
output at 16 MiB per attempt, kills the process group on timeout/cancellation,
and refuses to reuse an artifact directory. Raw artifacts are private; publish
only audited, sanitized exports. The previous four-attempt approval covered the
completed workspace correction; it is not reused for this new campaign.

Grading follows outcome-based agent evaluation guidance from
[Anthropic](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents).
[SWE-bench Verified](https://www.swebench.com/SWE-bench/guides/datasets/)
is a separate, expert-validated public benchmark; no SWE-bench score is claimed here.
