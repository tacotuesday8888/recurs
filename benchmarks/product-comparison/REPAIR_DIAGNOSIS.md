# Why the two Recurs attempts did not finish

This diagnosis uses [retained normalized role and review records](repair-diagnostics.json).
The reviews describe rejected code that is no longer available, so their
code-level observations cannot all be independently verified.

**Build, attempt 2:** execution failed after 162.6 seconds. Implementation,
review and repair each recorded a completed attempt. The reviewer requested
own-enumerable membership in `planBuild`, an explicit requirement. Repair ran
for 46.5 seconds and recorded no changed paths; no second review followed.
The final workspace is the unchanged fixture and fails the task checks.
This is consistent with a repair that made no material change, but the retained
record has no repair tool evidence or durable `repair_stalled` event establishing why.

**Scheduler, attempt 2:** execution failed after 299.3 seconds. Implementation
and one repair changed the checker; both reviews requested changes. The first
review requested empty-array and zero-priority cases. The second requested
conversion of non-Error API failures to an Error, as required by the checker
contract. No candidate was accepted; the retained no-op checker fails every
seeded mutant. The records do not establish a runtime or patch-loss defect.

Both attempts finished before the limit and recorded no failed/cancelled role
attempts. Their final failure codes are generic goal and verification failures.
Both nested review diagnostics are truncated even though the top-level run-count
truncation flag is false. Missing staged files are intentional retention behavior:
the supervisor cleans staging before the benchmark archive is written. Only an
approved candidate is applied to the final workspace.

Review `wallClockMs` spans the first review start through the last review finish,
including an intervening repair. For the scheduler it is 158.3 seconds, while
the two review attempt latencies sum to 106.6 seconds. Do not sum role spans to
estimate total work or infer a timing bug from this difference.

The separate [contract audit](contract-audit.json) confirms the membership defect
in three other retained build candidates. It supports the review concern's
substance, not a claim that the unavailable rejected candidate was independently
replayed. Further diagnosis needs durable repair execution evidence and safely
retained rejected snapshots. No extra live runs were made.
