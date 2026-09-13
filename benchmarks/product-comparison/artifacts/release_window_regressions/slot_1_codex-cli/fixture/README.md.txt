# Release windows: write a reusable regression checker

Implement async checkReleaseWindow(api) in checks/release-contract.js. It should
exercise api.selectRelease(windows, nowMs), returning normally when the API obeys
the contract and throwing an Error (for example node:assert/strict assertions)
when observed behavior violates it. Do not repair the scheduler. Change only
checks/release-contract.js. Run npm test; tests and src/release.js are immutable.

Public API contract:
- windows is an array of records with unique nonempty string ids, finite safe
  integer startMs/endMs (startMs < endMs), boolean paused, and integer priority.
  nowMs is a finite safe integer. Only these valid inputs need testing.
- A window is eligible when startMs <= nowMs < endMs and paused is false.
- Select the eligible window with highest priority; if priorities tie, choose
  the id first in JavaScript string comparison order. Return null if none qualify.
- Otherwise return a fresh record with exactly {id, startMs, endMs, priority}.
  Do not mutate the windows array, its order, or any input record.
- Time is explicit; do not use system time or random inputs.

Checker contract:
- Test only the supplied api through documented behavior, with your own valid
  inputs. Do not import the fixture implementation as an oracle, inspect source,
  function names/descriptors, process/environment/filesystem, or grader metadata,
  and do not change globals or supplied functions. For imports, use only Node
  assertion built-ins; no dependencies, network, subprocesses or additional files.
- The checker may be called repeatedly against different conforming or faulty
  APIs. Keep calls independent: do not rely on call order, persistent counters,
  implementation identity, or hidden case labels. All inputs are yours to create.
- Passing visible tests only proves acceptance of the working fixture. Evaluation
  separately checks acceptance of conforming APIs and rejection of behaviorally
  faulty APIs; a no-op checker, always-throwing checker or reported bug labels
  earn no completed-task credit. Every rejection must be an Error caused by an
  observed contract violation. Candidate checkers are also reviewed for these
  restrictions before results are used.

Scope: authored contract regression-check effectiveness, not general bug discovery
or a production test-suite benchmark. A finite hidden mutation set cannot prove
all contract properties. No team-only prompt or division of labor is prescribed.
