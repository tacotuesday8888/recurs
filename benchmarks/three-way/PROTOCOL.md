# Three-way task comparison — protocol

Frozen September 27, 2026, before any model request. Results under this
version are reported in full, whatever they show. Changes require a new
version; no outcome-based retries, task swaps or rescoring.

## Question

On the same small coding tasks, how often does each product deliver a correct
change within five minutes when run by its owner's subscription?

## Products and models

| Product | Account | Configuration |
| --- | --- | --- |
| Claude Code (installed `claude`) | Claude Pro subscription | `claude -p`, model `sonnet`, edits accepted, shell limited to `node` and `npm` |
| Codex CLI 0.145.0 | ChatGPT subscription | `codex exec`, GPT-5.6-Luna medium, workspace-write sandbox, never asks for approval |
| Recurs (this repository) | the same ChatGPT subscription | balanced team: Luna parent and review, Terra implement and repair |

Codex CLI and Recurs run through `recurs benchmark company --control codex`,
the existing audited harness. Claude Code runs through
`scripts/three-way-claude-arm.mjs`, which uses the same scenario fixtures,
workspace initialisation, five-minute execution limit and hidden verifier. The
harnesses differ in process wrapping; timing is reported per product, not as a
ranking. No product sees the hidden checks or reference solutions.

## Tasks

`shipment_quote` v1, `incremental_build_repair` v2 and
`release_window_regressions` v1: the fixtures, objectives and verifiers already
in this repository. They were used in the earlier two-way comparison; no
product change since then was made using their outcomes.

## Schedule

Two attempts per product per task, 18 attempts. For each task in the order
above: the Codex CLI and Recurs campaign (its harness alternates product
order), then two Claude Code attempts.

## Finished

An attempt is finished only if execution completed within 300 seconds, the
workspace-integrity checks pass, and every visible and hidden task check
passes. A later source audit rejects grader introspection, hard-coded answers
and global tampering equally for all products; any rejection is reported with
the evidence.

## Stopping and invalid attempts

Stop the campaign at the first subscription usage-limit or billing message and
report all remaining attempts as not run. Setup failures, product crashes and
usage-limit interruptions are recorded as invalid with their reason. Nothing is
repeated or removed.

## Reporting

For every attempt: product, task, attempt number, finished or not with the
reason, elapsed time, and provider-reported usage where available. Report
finished counts per product and the full list. Two attempts per task across
three small tasks is descriptive evidence, not a general ranking.
