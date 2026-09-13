# Three fresh tasks: audited results

Codex CLI finished **3 of 6** declared attempts; Recurs finished **2 of 6**.
These twelve attempts on three small, authored Node projects do not establish
an overall product ranking. Both used the same Codex subscription, with Luna
medium for Codex and Recurs lead/review, and Terra medium for Recurs implementation/repair.

| Task | Codex CLI | Recurs |
| --- | --- | --- |
| Shipment quotes | 2/2 | 1/2 |
| Rebuild planning | 0/2 | 0/2 |
| Seeded regression checker | 1/2 | 1/2 |

“Finished” follows the [predeclared rules](PLAN.md): valid completed execution,
passing workspace and task checks, and source review against the published
contract. Every slot remains in [the audit](audit.json) and
[website export](website-results.json), including failures and invalid attempts.
Times and provider-reported counters remain per attempt; unknown values are not zero.

Three build candidates passed the frozen tests but violate the explicit
own-enumerable-key requirement. A separate [contract audit](contract-audit.json)
reproduces the failures with exact inputs, expected/actual results, source lines
and a reference that passes all four probes. Those attempts fail audited completion;
their original automated grades remain unchanged.

Recurs's independent reviewer raised the same valid membership concern in its
second build attempt. The repair did not deliver an accepted candidate. The
rejected staged source was not retained, so its exact behavior and the underlying
repair failure cannot be independently verified. See the
[repair diagnosis](REPAIR_DIAGNOSIS.md) and [retained review evidence](repair-diagnostics.json).
This is evidence of a useful review finding alongside an unsuccessful outcome.

Two attempts are invalid: Recurs shipment repetition 2 took **464.9 seconds**,
exceeding the declared **300-second** limit; the last Codex scheduler attempt was
interrupted when the controller stopped. The shipment candidate later passed an
offline replay, which does not rescue the timed attempt. The interrupted slot has
no retained final trial, candidate, elapsed time or token counters. Its offline
recovery charges are reservation bookkeeping, not measured usage or dollar bills.

## Records and limits

- [Frozen declaration](declaration.json), [selection](selection.json) and
  [original normalized results](results.json) preserve all twelve reserved slots,
  eleven trial records and the interrupted recovery settlement. No outcome-based retries.
- [Initial source-integrity/replay audit](candidate-audit.json): eleven candidates,
  nine automated replay passes and two unchanged-fixture failures. Its original
  `sourceReview` field means no prohibited grading tricks, **not full contract compliance**.
  Use `contractReview` in [the final audit](audit.json) for that decision.
- Candidate manifests below link all 67 retained source files and their byte-identical
  initial fixtures as inert `.txt` snapshots. Only declared files are included;
  no credentials, raw model traces or user configuration are published.
- [Native event inventory](native-event-inventory.json): no external skill reads
  or delegation events were observed in five retained completed native traces.
  Native delegation tools remained available. This does not prove hermetic
  instruction isolation or complete internal CLI telemetry.

| Task | Codex attempt 1 | Codex attempt 2 | Recurs attempt 1 | Recurs attempt 2 |
| --- | --- | --- | --- | --- |
| Shipment | [Files](artifacts/shipment_quote/slot_1_codex-cli/manifest.json) | [Files](artifacts/shipment_quote/slot_2_codex-cli/manifest.json) | [Files](artifacts/shipment_quote/slot_1_company-auto/manifest.json) | [Files](artifacts/shipment_quote/slot_2_company-auto/manifest.json) |
| Build | [Files](artifacts/incremental_build_repair/slot_1_codex-cli/manifest.json) | [Files](artifacts/incremental_build_repair/slot_2_codex-cli/manifest.json) | [Files](artifacts/incremental_build_repair/slot_1_company-auto/manifest.json) | [Files](artifacts/incremental_build_repair/slot_2_company-auto/manifest.json) |
| Scheduler | [Files](artifacts/release_window_regressions/slot_1_codex-cli/manifest.json) | Not retained | [Files](artifacts/release_window_regressions/slot_1_company-auto/manifest.json) | [Files](artifacts/release_window_regressions/slot_2_company-auto/manifest.json) |

For each manifest path, the snapshot is at `candidate/<path>.txt` and the original
fixture at `fixture/<path>.txt`. SHA-256 values cover file bytes; the combined
fixture hash also binds declared paths and modes. The supplementary public
contract report replaces its local audit path with a relative link and records
the private appendix hash; probe inputs, outputs, source lines and file hashes are unchanged.

The declaration and result export use different connection-alias hashing methods.
[The audit](audit.json) describes both methods and verified role relationships;
raw IDs and cross-alias mappings stay private.

Token totals are not a fair comparison with the final native counters missing.
Input includes cached input; do not add cached tokens again. Dollar cost is
unknown. Runtime request counts and reservation charges are not comparable
vendor model-call counts. The scheduler task tests three seeded regressions,
not general bug discovery. Later cancellation fixes are outside the frozen
measured executable. No model was rerun during source review or offline replay.
