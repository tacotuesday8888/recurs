# Corrected campaign startup amendment

Declared before any corrected campaign trial or provider request.

The first approved launch of the frozen corrected bundle exited with status 1
after 0.42 seconds, reporting diagnostic
`968d9118-da7f-4721-a2e5-50fa0aed2351`. Independent, offline campaign creation
reproduced `TypeError: Company benchmark scenario version is unsupported`.
The fixture catalog advertised v2, but the campaign contract accepted only v1.
This happened before durable campaign creation, artifact creation, or any model
request. It is a pretrial harness failure, not a trial outcome or an additional
slot. The original twelve trial records remain immutable; the corrected campaign
still adds exactly four planned slots, for sixteen planned slots in total.

## Frozen amendment

- Original corrected source: `a715dcc`.
- Original corrected bundle SHA-256:
  `7fe8cb8857d2c00f2a586234c57de1d829f3eae7022a33a1cebedbe590b464be`.
- The original bundle was reproduced byte for byte from a fresh archive of that
  revision with its unchanged packaging script and installed dependencies.
- Apply only the compatibility change in
  `packages/contracts/src/company-benchmarks.ts`: accept and preserve scenario
  v2 for the declared `queue_cancellation` and `workspace_maintenance` fixtures;
  preserve legacy v1 support and reject undeclared versions.
- The patch produced by `git diff a715dcc --
  packages/contracts/src/company-benchmarks.ts` has SHA-256
  `3fb0c4946524ac31d7fe3fa126580a48ec71be615bcabaf2d8c94d0762cde7d1`.
- Rebuild with the original packaging script. Amended bundle SHA-256:
  `1dc58ace2efc4646646fe9443801be9ca3c7402ddb5e7be83306e1691932db3a`.

The amended executable contains no later prompt deduplication, runtime, artifact
capture, or UI changes. Source regression tests accept and round-trip both
declared v2 scenarios, reject undeclared versions, and create a valid campaign
for every latest fixture advertised by `benchmark company --list` using synthetic
saved connection records. All 57 targeted contract, CLI, scenario and blueprint
tests, lint, and full TypeScript checks passed. The amended frozen executable's
read-only scenario listing also passed.

All other terms of [the correction protocol](TASK_FIT_CORRECTION.md) remain fixed:
same fixture and verifier, Luna/Terra routes and reasoning, two repetitions per
arm in alternating order, 64 outer invocations, twenty-minute foreground cap,
and no purchases or outcome-based repeats. Keep the old executable and startup
failure record alongside this amendment. No corrected outcome is claimed here.
