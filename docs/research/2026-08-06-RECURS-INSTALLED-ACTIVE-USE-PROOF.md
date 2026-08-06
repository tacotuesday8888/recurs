# Recurs Installed Active-Use Proof

- **Date:** 2026-08-06
- **Source revision:** `6e6682a98f149bc6dcbb254058ac725267b6443c`
- **Package version:** `0.1.0-alpha.6`
- **Campaign:** `company-proof-05415347-3d0a-48c1-bbaa-48c8b4ab92a1`
- **Scenario:** `retry_after` v1
- **Decision:** insufficient evidence

## Scope

This probe tested current Recurs source and an exact locally packed installation
through the saved official Codex app-server routes. Authentication remained
owned by Codex. No credentials were copied into the fixture or report.

The archive was packed from the revision above, installed into an isolated Git
fixture, and executed through its installed `recurs` binary. It measured
463,309 bytes compressed and 2,048,810 bytes unpacked. Its SHA-512 digest was:

```text
cdcb5daebd2bddb8fd5fb119fb2248fc1f9cc1cc6cf0daae9dab9503887f5b382e0fe404ba82abed0aa3d45112dcb741f2d0699e23b04914ccfa4e8c0f03cedc
```

This is proof of the current alpha.6-versioned source artifact, not a claim
that these bytes are identical to the earlier registry publication.

## Formation probe

A configured Quick formation used Sol/high through the official saved Codex
route. It completed in 40.038 seconds with exactly two model requests, no
research child, six departments, eight roles, and one independent-review role.
Interview quality, blueprint tailoring, and decomposition passed. The report
remained `partial` because provider-reported dollar cost was unavailable.
Evaluation ID: `evaluation_1110f3bd06e84bd3e4c069c1f68e9c19`.

## Installed coding comparison

The installed artifact ran one byte-identical `retry_after` repetition with a
Sol/high parent-only baseline and the saved Sol/Terra/Luna company.

| Metric | Sol baseline | Sol/Terra/Luna company |
| --- | ---: | ---: |
| Verification checks | passed 7/7 | passed 2/7 |
| Wall time | 114.090s | 361.380s |
| Requests | 1 | 5 |
| Input tokens | 105,514 | 744,361 |
| Cached input | 83,456 | 559,616 |
| Output tokens | 3,807 | 14,123 |
| Reasoning tokens | 2,164 | 6,588 |
| Reported dollar cost | unknown | unknown |

The company activated all four configured roles. Terra Implement completed and
produced `src/retry-after.js`. Luna Review completed twice and requested
changes both times. Terra Repair completed once but reported no changed files,
so the candidate did not recover. Recurs did not apply the rejected candidate.
Verification failed the allowed-change, visible-test, hidden syntax, hidden
boundary, and hidden date checks.

The completed campaign was resumed through the installed binary in 0.37
seconds. Its two immutable slots and all recorded metrics were unchanged, so
the resume issued no new trial work.

## Product finding and correction

The run exposed a harness-level efficiency defect: an unchanged repair was
sent to a second independent review even though there was no new candidate to
review. The follow-up source correction:

- tells Repair to inspect the current diff and every finding path, make the
  smallest material patch, verify it, and inspect the final diff;
- records a durable `repair_stalled` event containing independently captured
  before/after artifact identities and matching content metadata;
- terminalizes truthfully as `changes_requested` when a completed repair is
  unchanged; and
- avoids spending another reviewer request on the identical candidate.

The invariant is covered by prompt, state-contract, and end-to-end supervisor
tests. It removes one known wasted request and preserves fail-closed behavior;
it does not prove that a future Repair model will successfully repair this
fixture.

## Interpretation

This probe proves that the installed artifact can load saved Codex routes, run
both arms, activate the full company path, preserve usage evidence, reject a
bad candidate, and resume durably. It is negative evidence for the tested
lineup on this repetition: the company was slower, used more requests and
tokens, and failed where the baseline passed. One repetition cannot establish
a universal model or team ranking.
