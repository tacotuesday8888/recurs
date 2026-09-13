# Task-fit pilot findings

All twelve original slots completed and are preserved in
[task-fit-results.json](task-fit-results.json). This pilot does not establish a
team advantage. Two repetitions per arm on synthetic tasks are insufficient for
a general quality or efficiency claim.

| Task | Single agent | Mixed-model team | Interpretation |
| --- | --- | --- | --- |
| Option precedence | 2/2 verified; 114.034 s median; 408,985 input | 2/2 verified; 140.295 s median; 461,897 input | Mandatory review added time and input without an observed quality gain. Team output was lower: 7,089 vs 8,249 tokens. |
| Queue cancellation | 2/2 verified; 141.416 s median; 455,423 input | 0/2 verified; 230.489 s median; 768,641 input | One team attempt delivered no change; another was approved but retained a slot-release defect. |
| Independent utilities | 2/2 verified; 306.306 s median; 452,869 input | Two invalid setups; workers never started | The blueprint requested three Implement workers but the mode permitted two. No team-capability or parallelism conclusion is supported. |

Input totals include cached tokens. Medians include recorded failures. The
independent team consumed 53,278 input and 2,066 output tokens, with a 25.647 s
median before setup rejection. These are audit measurements, not comparable
task-completion times. The single-agent independent times varied from 111.890 s
to 500.721 s, illustrating why two observations do not establish stable latency.
Dollar cost is unknown throughout; subscription tokens are not observed spend.

Both parents used Luna medium. Implementation and repair used Terra medium;
review used Luna medium. The baseline structurally omitted delegation tools.
Arm order alternated, and every slot used a fresh fixture. There were 64 allowed
outer runtime invocations per campaign, a twenty-minute foreground time cap,
and no outcome-based reruns. Internal vendor turns are not counted individually.
Confirmation callbacks are not measurements of human intervention. Development
machine activity and provider/cache conditions limit timing comparisons.

## Queue audit

The original listener check compared the number of add/remove calls. Valid
repeated cleanup and once-only listeners can violate that equality without
leaking. Scenario v2 instead inspects actual retained abort listeners. Focused
positive controls accept both valid patterns; a deliberate leak still fails.
The frozen v1 verifier remains available.

All four retained final workspaces were replayed under both verifiers. Every
original outcome is unchanged. [queue-verifier-audit.json](queue-verifier-audit.json)
contains original recorded checks, both replay results and candidate hashes.
No model requests or replacement trials were used for this amendment.

The first team attempt made one implementation, two reviews and one repair but
did not produce an approved change. Its retained final workspace is identical
to the fixture. Rejected staged code and detailed review prose were cleaned up;
they are unavailable. The delivered workspace cannot establish whether an
intermediate staged patch was correct or whether its reviewer was justified.

The second team attempt was approved but resolves a job's exposed promise in
`.then()` before decrementing the active slot count in `.finally()`. After the
checked jobs are awaited, one active slot remains until another microtask runs.
Both verifiers reject this observable lifecycle defect. It is independent of
the listener-count issue.

The [retained artifacts](task-fit-artifacts/) contain every original final
workspace and fixture, with per-file hashes and trial identities. Files use a
`.txt` suffix to preserve model code as evidence without treating it as repository
source or discovering its fixture tests in the project suite. No credentials,
runtime homes or raw transcripts are included. Future captures additionally
retain bounded structured review findings and artifact hashes; staged code is
still explicitly marked unavailable.

Offline replay after building the project:

```sh
node scripts/benchmark-queue-audit.mjs
```

The replay uses temporary fixture workspaces, Node permissions and the harness's
OS sandbox with network denied. It rewrites only the separate audit report.

## Corrected independent protocol: not run

The v2 blueprint groups the same three modules into two disjoint worker scopes
and preflights the mode's actual worker cap. Fixture, objective and behavioral
verifier remain identical. [TASK_FIT_CORRECTION.md](TASK_FIT_CORRECTION.md)
predeclares one additional four-slot campaign using the same routes and limits.
It is awaiting authorization; no campaign or measurement is claimed. It must
remain additional evidence, preserving the original invalid setups.

The corrected source was frozen at `a715dcc`, with bundle SHA-256
`7fe8cb8857d2c00f2a586234c57de1d829f3eae7022a33a1cebedbe590b464be`.
Later prompt deduplication, diagnostic capture and terminal changes are excluded
from that bundle. The original twelve-slot source was `351c05a`, bundle SHA-256
`69e39cb6ed7ec1fd5d3d69292c7a62298f52554f7a6a30ab173c5c9ffd4bda42`.

## Separate prompt reduction

Commit `ade9c7b` omits an exactly repeated project purpose only when the complete
later goal remains visible. Distinct purpose text, authority, acceptance and
evidence requirements remain; truncation retains the early purpose.

Direct UTF-8 size measurements for the original v1 implementation assignments:

| Task | Before | After | Removed |
| --- | ---: | ---: | ---: |
| Option precedence | 2,666 bytes | 2,213 bytes | 453 bytes |
| Queue cancellation | 3,502 bytes | 2,641 bytes | 861 bytes |
| Independent utilities | 4,264 bytes | 3,067 bytes | 1,197 bytes |

These are prompt bytes, not measured vendor-token savings. Neither frozen
benchmark bundle includes this change; no outcome improvement is attributed to it.
