# Active-session memory — September 26, 2026

Baseline: `5f79544a98bb0a72cb18ee6d0549b4ba30de68d5` (PR #226). The
[stress follow-up](QUALITY_STRESS_FOLLOWUP.md) observed parent RSS rising from
about 177 to 489 MiB over 120 streamed turns and left the cause open. This
record identifies the cause, the fix, and what the measurements do and do not
show. No model account was used.

## Method

`scripts/measure-active-session.mjs` drives the built CLI through a real PTY
with a deterministic loopback provider. The workload is fixed:

- 120 turns of 160 Unicode-bearing lines each;
- four turns of 6,000 lines, beyond the transcript's retained limit;
- 40 cycles of appearance, execution-list and team navigation, history paging,
  resizing to 40×12 and back, with an unfinished draft preserved each time;
- 20 turns cancelled while streaming;
- quitting, reopening the saved conversation and sending one more turn.

At each checkpoint the probe reads `process.memoryUsage()` through the V8
inspector, forces two full collections, and reads it again. Heap used after
collection is retained JavaScript data. On macOS it also records the kernel's
physical footprint and its high-water mark (`vmmap --summary`), the figure
Activity Monitor reports. At the end it requires 145 durable turns, including
20 cancellations, so a skipped or silently rejected prompt fails the run.

`ps` RSS is recorded but not used for conclusions. On macOS it can still count
pages V8 has already released as reusable, and it omits compressed or swapped
pages. The measuring host was using about 10.6 of 11.2 GiB of swap.

## Cause

Retained memory was not growing materially. After forced collection the heap
rose from 32 MiB idle to 40 MiB after 120 turns and 44 MiB after all phases;
the physical footprint after collection stayed between 85 and 135 MiB. The
growth was garbage produced while streaming:

- every streamed chunk copied the whole retained transcript (up to 262,144
  characters), rebuilt its collapsed-code view line by line, and cut the oldest
  output by copying the tail again;
- every frame re-parsed and re-wrapped the complete transcript as one Markdown
  document, even though only the last turn changed.

An allocation profile of turns 11–30 sampled 3,408 MiB of allocations for about
9 KiB of new text per turn. Collapsing and Markdown rendering took 2.6 of the
3.9 seconds of busy CPU time in that window. Turn latency tripled once the
transcript reached its limit (median 145 ms for the first ten turns, 522 ms for
the last ten).

## Changes

- The transcript buffer caches its text, drops old output in batches of 32,768
  characters from a line boundary, and reopens a code fence when the retained tail
  begins inside one. Before, a cut inside a code block could turn its closing
  fence into an opening one and render the rest of the conversation as code.
- Streamed chunks mark the conversation dirty; it is read once per rendered
  frame.
- The conversation renders one Markdown document per turn. Settled turns reuse
  their wrapped lines; only the changing turn is parsed again. Turn text is
  copied when cached so it does not keep older transcript versions alive.
  Expanded activity details are rendered after the conversation instead of
  inside a code block that is still streaming.
- Terminal text sanitizing uses a character-class replacement instead of a
  per-character array, with an exhaustive equivalence test.

The retained limits are unchanged. Tests cover exact equivalence with the
previous sanitizer and code collapsing, amortized trimming, fence reopening,
turn-by-turn rendering equality while streaming, cache reuse after trimming,
and deferring transcript work from chunks to frames.

## Results

Two runs of each build, alternating (baseline, new, new, baseline), macOS arm64,
Node 26.9.0, same dependencies. Raw samples and bundle hashes are in
[the measurement record](quality/active-session-2026-09-26.json).

| Measurement | Baseline | Changed |
| --- | ---: | ---: |
| Median turn time, 120 turns | 501, 521 ms | 124, 124 ms |
| Median of the last ten turns | 522, 522 ms | 146, 144 ms |
| Complete workload | 133, 134 s | 76, 74 s |
| Peak physical footprint, 120 turns | 399, 403 MiB | 278, 269 MiB |
| Peak physical footprint, all phases | 433, 483 MiB | 343, 355 MiB |
| Heap after collection, 120 turns | 39.9, 39.9 MiB | 40.6, 40.5 MiB |
| Peak footprint after reopening + one turn | 315, 315 MiB | 245, 254 MiB |

A separate profiled run of the same workload sampled 369 MiB of allocations in
turns 11–30 (3,408 MiB before), and busy CPU time fell from 3.9 to 1.2 seconds.

Retained heap is about 0.6 MiB higher because each cached turn holds its own
copy of its text. `ps` RSS did not improve in these runs (maximum 368 and
337 MiB before, 381 and 348 MiB after), which is consistent with the RSS
limitations above rather than evidence of lower memory.

## Remaining limits

The peak footprint still grows with session length (151 MiB idle to about
275 MiB after 120 turns). Retained heap does not, and most remaining allocation
comes from loading the entire session log several times per turn; its cost grows
with history. That is the next profiling target, not something this change
claims to fix.

These are one host's measurements of a synthetic local workload. They are not a
model-quality result, a cross-platform guarantee, or proof of a leak-free
hours-long session. Vendor runtime subprocesses were not part of this workload.

Reproduce with `npm run build && npm run performance:active-session`. Pass
`--executable <absolute path to another build's dist/cli/main.js>` for a paired
comparison; that build needs its dependencies alongside it. `--quick` runs a
shorter smoke version.
