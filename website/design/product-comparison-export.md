# Audited product comparison export

The build optionally reads `benchmarks/product-comparison/website-results.json`.
An absent file adds no section or placeholder. A present malformed export fails
the build. Do not copy synthetic test fixtures into that path.

The exact TypeScript contract and runtime validator are in
`website/src/product-comparison.ts`. Export version 1 with kind
`audited-product-comparison`, the full frozen source revision, an ISO audit time,
audit and protocol links, two configurations, the token-accounting decision and
all twelve declared slots. The three task IDs and two product IDs come from the
frozen product campaign; each product/task must have repetitions 1 and 2 exactly
once. Missing trials require an explicit status: `not_started` when never launched,
or `cancelled` for the interrupted reserved slot with no retained trial. Never omit a row.

Each attempt records execution status, task verification, workspace integrity,
source review, validity, an audit note, nullable elapsed milliseconds and usage.
Completion requires valid comparison status, completed execution and passed
verification, integrity and source review. Passing files after a timeout remain
an unfinished attempt. Invalid setups keep their duration and explanation in the
record, with no speed or success claim inferred from them.

Use `timed_out` when execution actually timed out. A recorded completed execution
that exceeded the declared limit keeps that recorded status and elapsed time,
with invalid comparison status and an explanation. `not_started` has null time and counters, no usage coverage,
and `not_run` for each check/review. An invalid slot requires an explanatory note.
Measured zero is a number; missing values are null. Do not use settlement charges
or deadline ceilings as measured time or tokens.

`tokenAccounting.comparable` is an explicit audit conclusion, not an inference
from counter availability. The note should describe native subagent coverage and
any limitation. The display shows per-attempt input/output only when that audit
is positive and all twelve slots have complete input/output coverage and valid
comparison status. Cached input may remain null: it is shown as unknown and does
not suppress otherwise complete, comparable input/output counters. Cached input
is a portion of input, never added to it. The display makes no dollar-cost claim.

Use public HTTPS links under `github.com/tacotuesday8888/recurs/`, preferably
immutable references to audited artifacts. Relative links must start with `./`
and resolve to files already present in the website output when the optional
build hook runs. Missing local targets fail the build. The hook does not copy new
audit artifacts automatically or contact GitHub to verify remote publication;
check remote links when delivering the audited result.

The component reuses the existing `task-result`, `data-scroll-reveal` and
`data-count-to` hooks. Final accessible counts exist in static HTML before
JavaScript. Native disclosure elements expose attempt details and configured
model routes. No new motion controller, palette or logo asset is introduced.
When real data is present, the existing evidence section is labeled as earlier
tests inside Recurs; its stored data and detailed records remain unchanged.
The Benchmarks navigation link points to the fresh comparison.

The live build also reads `benchmarks/product-comparison/review-finding.json`.
This separate version-1 observation contains exactly `title`, `summary`,
`reviewerObservation`, `auditObservation` and `outcome` strings. Text is validated
and escaped. Keep reviewer observations separate from independently reproduced
candidate behavior; disclose an unsuccessful repair and unavailable rejected
source. Its content hash is bound in the final audit. This sidecar does not alter
the comparison schema or the frozen automated scores.
Only the title and short summary are expanded initially; a native disclosure
holds the detailed observation, reproduction and outcome.

Run `npm --prefix website run check` for the build and offline display tests.
For manual layout checks only, run
`node website/test/preview-product-comparison.mjs` after building. It prints an
ephemeral localhost URL and shows a persistent synthetic-data banner. It serves
test controls in memory, never writes them into website output, and refuses to
mix them with an already built real comparison. Stop that preview after testing.
