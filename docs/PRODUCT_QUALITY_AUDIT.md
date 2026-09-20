# Product quality audit — September 20, 2026

Recurs has a working, extensively tested local CLI and bounded team architecture.
It is still an alpha. The current benchmark does not establish superior product
quality, lower cost, or lower active-agent RAM than another product. This audit
found and fixed avoidable startup memory, repeated terminal projection work,
mutable historical UI snapshots, and two website usability defects.

Source baseline: `8262da0b68321acad4d7d33c45f4589a06556b96`. The fixes and
measurement tooling accompany this document. No live model campaign, npm release,
or website deployment was performed for this audit.

## Findings and disposition

| Priority | Evidence | Disposition |
| --- | --- | --- |
| High | Only 12 declared attempts across 3 authored tasks; Codex completed 3/6 and Recurs 2/6 under the audited completion rule. Models and workflows differ. | Preserve all outcomes and explicit limits. This is diagnostic evidence, not a general ranking or a basis for superiority advertising. |
| High | Three build candidates passed frozen checks but violated the published own-enumerable-key contract; the rejected Recurs repair source is missing. | Existing supplementary source probes remain authoritative alongside unchanged frozen grades. Exact failed-repair diagnosis cannot be reconstructed from missing source. Requirements for the next campaign are below. |
| Medium | Both terminal highlighting and outline modules eagerly imported TypeScript on `--help` and `--version`. | Load the compiler synchronously only when a supported highlight or outline is requested. Existing lexical/outline tests cover behavior; new bundled-command tests prevent eager-loading regressions. |
| Medium | The 80 ms animation path repeatedly requested the same terminal projection. Tree construction scanned all nodes again for each parent. | Cache the immutable projection until state changes; invalidate before notifying the listener. Index child relationships and execution membership once per projection. |
| Medium | Earlier snapshots shared mutable handoff counters and usage with later events. | Copy and freeze both nested structures. Regression coverage checks that earlier observations remain unchanged after a handoff. |
| Low | A benchmark slot opened a group of four attempts and focused its disclosure heading rather than the selected result. | Give every slot a unique controlled target; open the disclosure, focus and scroll to the exact attempt. All 12 target mappings are verified. |
| Low | The hero paragraph rule also enlarged the installation requirements note. | Scope the rule to the introductory paragraph; requirements retain their 12 px supporting style. Verified in the browser at desktop and 390 px width. |
| Low | Website documentation described removed activity tabs, historical chart selectors, and autoplay. | Rewrite it to match the shipped page, current comparison data, install choices and motion behavior. |

## Memory and responsiveness

The offline CLI probe launches a new process with a fresh synthetic home for each
sample. It discards one warmup and records five samples per command. It measures
wall time and the child process's peak resident set via Node `resourceUsage`,
and checks whether the TypeScript compiler entered Node's module cache. It makes
no model calls and does not read a user's saved Recurs configuration.

Local measurements: macOS arm64, Node 24.19.0, same dependencies and host.

| Command | Before peak RSS, median | After peak RSS, median | Reduction | Before wall time, median | After wall time, median |
| --- | ---: | ---: | ---: | ---: | ---: |
| `--version` | 175.55 MiB | 115.86 MiB | 34.0% | 330.9 ms | 211.0 ms |
| `--help` | 179.75 MiB | 114.00 MiB | 36.6% | 336.2 ms | 213.9 ms |

Raw samples and executable hashes: [before](quality/startup-before.json) and
[after](quality/startup-after.json). The compiler was loaded in every baseline
sample and none of the new samples. Timings are local observations and are
sensitive to host load; these are not cross-platform performance guarantees.

Reproduce the current measurements after `npm run build` with
`npm run performance:measure`. To compare a separately built baseline, pass its
absolute executable path to `node scripts/measure-cli-resources.mjs` with that
build's installed dependencies alongside it. Both revisions must use the same
Node runtime and dependencies. `package:check` runs the compiler-loading
regressions; it deliberately does not enforce machine-dependent millisecond or
RSS thresholds.

These samples measure short-lived parent CLI processes, not idle interactive
sessions, active model turns, subprocess trees, retained heap, or a leak-free
long-duration workload. The compiler's cost is deferred until it is needed,
not eliminated from sessions that use code intelligence.

The terminal projection now returns the same snapshot object while its inputs
are unchanged, avoiding repeated allocation on idle animation ticks. New events,
parent configuration changes, and restored execution inventories invalidate it.
This optimization does not cap history or drop execution records.

## Benchmark assessment

The comparison has useful strengths: a declared protocol, retained candidates,
source hashes, offline replay, explicit invalid slots, and no outcome-based
reruns. The site distinguishes unknown values from zero and does not invent a
dollar or token efficiency comparison. Detailed evidence remains in the
[comparison audit](../benchmarks/product-comparison/README.md).

It is not yet a strong marketing benchmark. Two attempts per task are too few
for a general success-rate estimate, and model mix confounds attribution to team
coordination. Shipment repetition 2 exceeded its declared deadline; the final
Codex scheduler attempt was interrupted without final metrics. Later runtime
fixes do not retrospectively improve those frozen results.

Before spending on another campaign:

1. Version the fixture/protocol and add the already reproduced enumerable-key
   probes to its verifier. Test correct references and deliberately broken
   implementations before freezing it; keep old results attached to old rules.
2. Retain every rejected, repaired, and accepted candidate with source hashes
   before cleanup. Bind reviewer findings to the exact candidate and preserve
   bounded failure diagnostics for aborted slots. Apply the existing public
   artifact allowlist/redaction boundary to anything exported.
3. Exercise deadlines, cancellation, interrupted finalization and reservation
   settlement offline against the exact candidate executable.
4. Predeclare separate questions for end-to-end product quality and same-model
   coordination effects. Choose repetition counts, cost limits and a varied
   task set before running; report every reserved slot and comparable usage.

A new real-model campaign consumes account usage and cannot restore missing
historical artifacts. This audit did not run one or extrapolate new scores.

## Architecture and remaining efficiency limits

The package direction separates contracts, providers/runtimes/tools, core
orchestration, and CLI presentation. The source suite covers execution leases,
permission ceilings, workspace boundaries, cancellation, persistence, recovery,
and provider adapters. This audit does not replace a dedicated adversarial
security review.

Terminal transcript and activity retention already have explicit limits: the
transcript retains at most 262,144 JavaScript string characters; the activity
list retains 32 entries, read previews retain up to 262,144 characters, and each
captured patch is limited to 1,048,576 characters. Those local
limits are useful but do not establish a whole-process memory ceiling.

Two scaling questions remain open and should be profiled with synthetic data:

- `JsonlSessionStore.list()` loads and validates each complete session log.
  Listing cost grows with stored history, and peak memory includes a complete
  parsed log. A future streaming or indexed listing must preserve corruption
  detection and metadata ordering; silently trusting an unvalidated cache would
  change persistence guarantees.
- The terminal retains the execution inventory for inspection. Projection
  caching removes idle rebuilds, but very large histories and active event
  streams still need a representative soak test. Provider CLI descendants also
  need process-tree accounting before making an active-agent RAM claim.

## Verification

- Full local `npm run check`: generated files, lint, types, source tests, build,
  package contracts, benchmark evidence and website tests: 2,518 source tests
  passed (4 skipped), 40 package-script tests, 34 benchmark-script tests and
  37 website tests passed.
- Installed-package terminal smoke: isolated home, fake local provider, real
  PTY, animated onboarding, draft/cancellation preservation, execution
  inspection, review modes and history across restart. It makes no paid calls.
- Browser: installation selection, selected-attempt focus, video play/pause,
  desktop and 390 px layout without horizontal page overflow; the requirements
  note computes to 12 px. Viewport overrides were reset after checking.
- `npm audit --omit=dev`: zero known production dependency advisories on the
  audit date. This does not prove absence of application vulnerabilities.

An initial full run timed out in benchmark tests under the machine's Node 26.
The focused scenario passed under both Node 24 and Node 26; the complete Node 24
run passed. There is insufficient evidence to blame the Node version. The
repository CI remains the cross-platform gate, including its exact minimum
Node 22.22.0 runtime and installed-package checks.
