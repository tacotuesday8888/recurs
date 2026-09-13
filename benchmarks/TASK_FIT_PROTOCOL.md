# Task fit pilot, September 2026

This protocol is written before any model trial on these fixtures. It is a
bounded pilot of three workload classes, not a representative sample of all
software engineering. No claim that teams should win is assumed.

| Task | Workload | Team policy |
| --- | --- | --- |
| options_precedence | Existing single-module config precedence defect | Mandatory independent review; an intentional overhead control |
| queue_cancellation | Coupled two-module queue cancellation and slot lifecycle repair | Implementation followed by independent review and bounded repair |
| workspace_maintenance | Three independent existing utility modules plus an immutable integration module | Three scoped implementation assignments can run concurrently, then one combined independent review |

Each fixture has runnable existing code, a public objective, visible regression
checks and three external authenticated check groups. The original defects must
fail; test-only reference fixes must pass. Partial repairs must fail. Verifier
code and references are excluded from every candidate workspace. Checks include
workspace inventory, Git state and approved paths. This remains a synthetic,
dependency-free Node.js exercise, not a production repository study.

## Frozen comparison

- Two repetitions per task, two arms, twelve planned slots total.
- Baseline and team parent: gpt-5.6-luna, medium effort.
- Implementation and repair: gpt-5.6-terra, medium effort.
- Independent review: gpt-5.6-luna, medium effort.
- Baseline exposes no host child, batch, team, or company delegation tools.
  The reviewed Codex runtime also disables native environment tools. Both arms
  retain the same ordinary edit, read and verification capabilities.
- Baseline first in repetition one; team first in repetition two.
- Fresh identical workspace per slot, frozen route and blueprint authorities.
- Existing Codex subscription through the supported foreground Recurs CLI.
  No purchased credits, changed billing policy, or alternative auth paths.
- At most 64 outer runtime invocations per four-slot campaign, 192 total. The
  runner allocates remaining allowance across remaining slots. These are not
  counts of internal vendor model calls. Per-run product limits also apply.
- Stop a campaign after 20 minutes; stop further campaigns on provider rate,
  billing, login or policy rejection. No automatic reruns, substitutions, or
  extra trials based on outcomes. Report missing/interrupted slots.
- Freeze a source commit and record the built CLI SHA256 before launch. Retain
  every resulting campaign and settlement, including unsuccessful outcomes.

## Measurements and interpretation

Primary outcome: externally verified correctness, with passes divided by all
planned slots. Also report execution status and failures, median recorded wall
time including failures, input/output tokens, cached input, outer runtime
invocations, repair rounds and per-role observations. Include uncached input
as total input minus cached input only where both are reported and consistent.
Do not sum parent and child latency: the parent interval includes delegation.
Report costs as unknown when the provider does not supply them. Subscription
tokens do not establish dollar cost or marginal billing.

Display paired observations, not just an aggregate winner. Two repetitions do
not support a general superiority claim or a stable model ranking. Mandatory
review and orchestration are part of the team treatment, and may be wasteful
on small tasks. Compare observed parallel overlap on the independent task;
merely declaring three workers is not proof that they ran concurrently.
Prompt reuse is not directly measured by aggregate input tokens. Confirmation
callbacks are not measured human interventions.

Keep the prior retry-after probe and historical Round 2 results available and
separate. The prior baseline did not structurally disable delegation, so label
it as an earlier protocol, without retroactively changing its records.

## Retained artifacts

`--artifacts <directory>` retains the declared fixture and candidate files,
SHA256 hashes and normalized trial/verifier record in a fresh trial directory.
It never copies the private runtime home, credentials or raw model transcript.
Unavailable, non-regular, oversized or outside-workspace files are marked rather
than followed. Retain failed candidates too. Captures must identify the exact
candidate and result; test-only reference patches are not model evidence.

## Foreground time limit

Run each campaign with a terminal attached. `scripts/benchmark-time-limit.mjs`
passes through the normal CLI and environment, interrupts at twenty minutes,
and allows fifteen seconds for cleanup before termination. It does not alter
provider authority, routes or permissions. The pilot used the byte-equivalent
wrapper from a temporary file; the committed helper adds only usage validation.

```sh
node scripts/benchmark-time-limit.mjs dist/cli/main.js benchmark company \
  --configured --allow-network --scenario options_precedence --repetitions 2 \
  --connection <luna-medium-id> --parent-connection <luna-medium-id> \
  --implement-connection <terra-medium-id> --review-connection <luna-medium-id> \
  --repair-connection <terra-medium-id> --artifacts /tmp/recurs-task-fit/options
```

Use the same frozen bundle and explicit routes for `queue_cancellation` and
`workspace_maintenance`. Do not launch the campaigns concurrently: local and
provider contention would further complicate wall-time comparisons. This pilot
ran on a development machine with other ongoing work; wall times are exploratory,
not measurements from an otherwise isolated machine.
