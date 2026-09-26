# Quality stress follow-up — September 20, 2026

Baseline: `4a1d537f329a0c2af70fe439cf5845c4676a547a` (PR #225).
This follow-up addresses benchmark verification, retained repair evidence, and
session-history memory from the [initial audit](PRODUCT_QUALITY_AUDIT.md).
No historical outcome was changed and no live model campaign was run.

## Benchmark verification and diagnosis

The incremental-build scenario now defaults to version 2. Its additional hidden
check exercises own-enumerable-key semantics in additions, removals, graph
membership, and build selection. Four deliberately broken implementations pass
the frozen version-1 checks and fail version 2; the correct reference passes
both. The production verifier is also exercised against an affected candidate.
The public fixture hash remains identical; the scenario version and verifier ID
distinguish the stronger grader. Resumed version-1 campaigns keep version 1.

With `--artifacts`, the benchmark runner captures completed team implementation
and repair candidates before review and cleanup, including unchanged repairs.
Snapshots contain only bounded declared fixture files, their hashes, scenario
and verifier identity, and the team run, round, phase, and patch hash. Final
diagnostics link those snapshots to structured reviewer findings. A capture
failure cannot change whether the team is reviewed, approved, or cleaned up.

Regression coverage includes a stalled, unchanged repair, a capture failure,
post-cleanup source availability, and a full scripted benchmark run that links
both implementation and repair snapshots. The capture limit is 32 snapshots per
slot, with at most 64 KiB per candidate file. These are local diagnostics, not
automatically published artifacts. Interrupted workers that never reach a
completed snapshot can still lack source evidence. Capture time is included in
execution time and must be part of a predeclared comparison protocol.

## Session-history memory

Listing sessions now reads 64 KiB chunks, validates every record, and retains
only the first and last records needed for history metadata. It preserves
record ownership, version and sequence validation, strict UTF-8 behavior,
file-leading BOM handling, and locked quarantine/recovery of an incomplete
tail. Tests cover records spanning multiple chunks, corruption before a valid
final record, split Unicode tails, and writer-lock behavior.

The synthetic probe creates four complete legacy logs, each with 1,024 messages
of 8,192 ASCII characters: 34,120,200 bytes in total. Three fresh child-process
measurements follow one discarded warmup. Raw samples and module hashes are
stored in [before](quality/history-before.json) and
[after](quality/history-after.json). These measure the listing operation on
macOS arm64 with Node 24.19.0, not whole active-agent memory.

| Listing measurement | Before | After |
| --- | ---: | ---: |
| Median peak RSS | 168.64 MiB | 66.33 MiB |
| Median elapsed time | 46.22 ms | 41.33 ms |

Peak RSS fell by 60.7% in this paired local probe. Timing depends on host load;
the three samples are observations, not statistical performance guarantees.

Run `npm run build && npm run performance:history` to reproduce the current
probe. Pass an independently built baseline module's absolute path to
`node scripts/measure-session-history.mjs` for a paired comparison using the
same Node runtime and dependencies. For this local baseline, the unchanged
store implementation from PR #225 used the same dependency modules; its relative
imports were resolved to those modules before running the probe.

Memory remains proportional to the largest individual record plus the endpoint
records and read buffer. A large fork snapshot can itself be a large record.
Interrupted-tail recovery and full session restoration still use the existing
whole-log reader. Listing still validates all bytes, so its work grows with
history size. This change does not prove a universal RAM ceiling.

## Terminal and website verification

`npm run package:stress-terminal` installs the exact locally packed artifact in
an isolated home and drives a real PTY with a deterministic local provider. It
streams 120 turns of 160 Unicode-bearing lines, with 24 resize and appearance
navigation cycles that preserve unfinished drafts. It then completes the
existing walkthrough: cancellation, approvals, real patch application, child
inspection, diff modes, theme persistence, chat organization, and reopening
saved history. No paid or vendor-model requests are involved. macOS CI runs
this extended test; Linux retains the regular installed-terminal walkthrough.

The probe records parent and owned-process-tree RSS after each completed turn.
These are sampled resident-set values, not allocation profiles, peak-process
measurements, or evidence of a leak-free long-duration workload. The local
provider server, PTY emulator, and capture harness are outside the measured CLI
process tree. Raw samples are in [terminal stress](quality/terminal-stress.json).

All 120 turns and the subsequent walkthrough passed. Median observed completion
time was 749 ms per synthetic turn. Parent RSS ranged from 170.89 to 489.22 MiB;
the first five turns had a median of 176.58 MiB and the last five 461.86 MiB.
The largest sampled owned-process-tree RSS was 506.42 MiB. The final two
ten-turn blocks were both about 469 MiB, but that short plateau cannot establish
a memory bound or distinguish retained data from allocator/GC behavior. Active
session memory remains a profiling target; the history-listing improvement must
not be represented as a reduction in this active workload.
[Active-session memory](ACTIVE_SESSION_MEMORY.md) later traced this growth to
streaming garbage rather than retained data and records the fix.

Browser checks on the current website covered npm/Bun/Homebrew selection and
copied commands, all twelve benchmark targets through keyboard activation,
play/pause/resume/replay, animation preference, and desktop, 320 px, and 390 px
layouts. The page had no horizontal overflow at those widths and no captured
console warnings or errors. The existing restrained layout and terminal assets
remain consistent; the website does not turn synthetic stress results into
model-quality claims.

The complete local `npm run check` passed: 2,537 source tests (4 skipped), 40
package-script tests, 34 benchmark-script tests, and 37 website tests, alongside
generated-file, lint, type, build, package, and frozen-evidence checks.
After adding bounded slot-level links for interrupted captures, the focused
artifact/execution suite passed 32 tests and lint/types passed again. Captured
snapshots remain discoverable even without a final team-state record.
The fresh installed-package agent smoke also passed, including discovery of
the corrected scenario version through the installed CLI.

## Remaining limits

The old comparison still contains twelve small-task attempts and does not
establish that Recurs is better overall. Its missing rejected repair cannot be
reconstructed. A fresh quality comparison needs a frozen protocol, comparable
model settings, bounded spend, more task diversity, and complete slot reporting.
Resource behavior with real vendor subprocesses, very large fork snapshots,
and hours-long sessions still needs representative profiling. The improvements
here are measured engineering progress, not a claim of perfection.
