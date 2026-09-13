# Fresh product benchmark presentation

Draft copy and measurement guidance. No results, performance claims, or campaign
outcomes are recorded here. Publish numbers only after the frozen campaign and
its candidate audits have been verified.

## Suggested public copy

### Can a coding team help finish practical tasks?

We compare native Codex CLI with a Recurs team on three new, small developer
tasks: adding a shipment quote feature, fixing an incremental build planner,
and writing checks that detect seeded scheduler regressions.

Each product gets two attempts per task, with a five-minute limit per attempt.
Both use the existing Codex subscription. The Codex CLI control uses Luna;
Recurs uses Luna for its parent and reviewer, with Terra workers. This compares
the two complete configurations, including their models and tools.

| Task label | What the work involves | What passing means |
| --- | --- | --- |
| Add shipment quotes | Connect cart validation, discounts, parcel rates, and the quote API across four modules. | The final candidate passes the frozen visible and hidden checks and workspace rules. |
| Fix rebuild planning | Repair change detection, dependency traversal, and rebuild selection across three modules. | The final candidate passes the frozen visible and hidden checks and workspace rules. |
| Detect seeded regressions | Write a reusable checker for a release-window scheduler's published contract. | The checker accepts conforming APIs, rejects all three seeded behavioral mutations, and passes the required source review. |

These are authored, dependency-free Node projects, not full applications. Two
attempts per task show what happened in these runs; they do not establish a
reliable general success rate or show that either product is universally better.

## Measurement and display guidance

- Lead with **tasks completed**, shown as counts with denominators, and elapsed
  time per attempt. Keep all twelve declared slots visible in the detailed
  record, including failed, cancelled, timed-out, invalid, and unstarted slots.
  Identify execution status separately from candidate-check results. An invalid
  comparison slot must never be silently relabeled as a coding failure.
- Use the frozen definition of elapsed time and state its start and end events.
  Show a timeout as a timeout. If a time summary includes only successful runs,
  label that restriction and retain the failed-run durations alongside it.
  Twelve five-minute limits bound attempt execution, not setup and audit time.
- Describe the third task as **seeded mutation detection** or **regression-check
  effectiveness**. Its three mutations cover an end boundary, paused-window
  eligibility, and priority ordering. It does not measure general bug finding,
  all scheduler contract properties, or unknown production defects. Check counts
  across tasks are not comparable units of work.
- Record the exact CLI and Recurs revisions, model IDs, reasoning effort, routes,
  tool/permission settings, fixture hashes, grader revision, run order, and skill
  discovery settings in methodology. Report observed delegation rather than
  assuming workers ran because the team configuration allowed them.
- Subscription access does not provide a per-attempt dollar bill. Do not infer
  zero cost, savings, or price from access mode. If usage is recorded, distinguish
  available token counts, cache accounting, and unavailable fields; compare them
  only when both products expose equivalent measurements.
- Treat all three tasks as one predeclared small sample. Do not select a favorable
  task, discard a bad attempt, add retries, or change scoring after seeing results.
  State the actual isolation and skill-discovery controls and any deviations.
  Cross-module work offers opportunities to divide work but also requires serial
  integration; it does not guarantee a benefit from delegation.
- Link the frozen declaration and complete audit from any result presentation.
  Keep earlier pilot results and the stopped Issue Desk campaign separately
  identified. Neither supplies new attempts for this campaign.

## Review gates before using results

The candidate checker runs inside the existing bounded verifier. Identical API
wrappers remove simple function-source cues, but they do not prove that candidate
code cannot inspect or manipulate grading. Apply the predeclared source review
for introspection, persistent call-count tricks, invalid test inputs, global
tampering, and fixture-oracle imports to both products consistently. Do not
present an automated pass as complete until that review is recorded.

Passing means passing this finite verifier. The shipment task excludes payments,
taxes, persistence and inventory concurrency. The build task selects rebuilds;
it does not compile code, watch files, schedule builds or measure cache speed.
The scheduler task measures a checker against authored behavior changes, with
correct-API acceptance as a mandatory control. No task measures production
readiness, long-running agent reliability, or a full development lifecycle.
