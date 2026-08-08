# Public Alpha Status

**Status:** `0.1.0-alpha.7` public alpha. Recurs is available as one verified
npm artifact through npm, Bun-as-installer, a checksum-verifying curl asset,
and the official Homebrew tap.

## Installation reality

| Path | Status | What that means |
| --- | --- | --- |
| Source checkout with npm | Supported alpha path | Clone the repository, run `npm ci`, build, and `npm link` on Node.js 22.22+ |
| npm registry | Recommended path | `npm install --global recurs@alpha` installs the current reviewed alpha |
| GitHub release / curl | Published alpha path | The release carries the exact archive and a checksum-verifying user-local installer |
| Homebrew | Published tap path | `brew install tacotuesday8888/recurs/recurs` installs the same npm archive through the official tap |
| Bun global install | Verified installer path | `bun install --global recurs@0.1.0-alpha.7` installs the package; Node.js 22.22+ still executes it |
| Bun runtime | Unsupported | No `bun run`, native Bun execution, broader Bun-version, or broad platform-compatibility claim |
| Signed binary / desktop | Not implemented | There is no standalone download or desktop application |

The package gate caps the unpacked Recurs artifact at 2.1 MB. On 2026-08-06 the
exact `0.1.0-alpha.7` archive measured 453 KiB compressed / 1.96 MiB unpacked.
Its clean Apple-silicon production prefix measured 41.3 MiB. It did not install
Codex. The full source-development dependency tree measured about
402 MiB because it retains roughly 307 MiB of pinned Codex compatibility
fixtures. Exact size varies by platform and npm version.

npm's `alpha` dist-tag selects `0.1.0-alpha.7`; unqualified `latest` still
selects `0.1.0-alpha.2`. The public alpha.7 archive is immutable tag output.
Post-tag current-source capabilities, including GitHub Copilot, are for a later
deliberately tagged preview and are not retroactively part of these bytes.

## What is proven

The base harness, bounded company runtime, provider routes, permissions,
worktree isolation, independent review, repair state machine, recovery, and
explicit apply path are covered by automated tests. The installed-package gate
also drives the exact packed npm artifact from an empty private home through
Quick setup and company formation, approval, a layered lead/Implement/Review
goal, a failing first candidate, finding-driven Repair, independent re-review,
parent synthesis, approved application, and an external passing fixture test.
The deterministic local provider makes this proof reproducible without an API
key or network request. Ordinary session resume and normalized provider failure
remain covered by the same installed-artifact smoke; company interruption and
recovery remain covered by focused runtime integration tests.

Round 2 added reproducible current-harness and parent-matched Codex evidence.
It did not establish an Auto or worker-route winner. Complete campaigns
provided 12 informative pairs but only six parent-matched pairs. In matched
evidence the baseline-only count was two and the company-only count was zero.
One Luna approval failed the hidden verifier. Complete campaigns supplied
three Repair attempts and only one recovery. Provider-reported dollar cost was
unknown. See the [Round 2 evidence report](research/2026-08-07-RECURS-MODEL-TEAM-EVALUATION-V2.md).

The 2026-08-08 RC dogfood used the existing official Codex login without
copying credentials. Quick formation passed its substantive rubrics in 41.563
seconds with two requests and unknown cost. A frozen `alias_registry`
repetition then passed all seven checks for the Sol baseline, while the
Sol/Terra/Luna company used three requests, received Luna approval, and failed
the hidden registry-boundary check. Repair did not activate. This is another
single observed false approval, not a general rate estimate. Exact routes,
usage, latency, and campaign identifiers are in the
[active-use RC evidence](ACTIVE_USE_RELEASE_CANDIDATE.md).

## What is not proven

The evidence does not establish that Sol/Terra/Luna is a universal winner,
that a larger team is cost-effective, or that it reliably beats a strong
single agent. Round 2 failed the representative-fixture, durable-completeness,
matched-pair, non-inferiority, Repair-recovery, zero-false-approval, and
dollar-cost gates. Before publishing a default recommendation, Recurs still
needs repeated current-harness comparisons that record:

- final quality and test results;
- review findings and repair rounds;
- elapsed time and failure rate;
- total and cached tokens; and
- provider-reported dollar cost when available.

The source contains the repeatable comparison machinery: three immutable
hidden-verifier fixtures, alternating campaign order, distinct
Quick/Guided/Deep formation evaluations, the selected parent-only baseline,
the currently configured saved role-route snapshot, and an explicit all-strong
comparison option. Availability observations do not substitute for
model/effort crosses, repeated parent-matched runs, safe review evidence, or
real price coverage.

Other current limits include Windows subprocess containment, a persistent
worker daemon, a full company operations dashboard, automatic plugin
installation, remote MCP/OAuth, and unattended commit, push, deployment, or
messaging.

## Alpha release guarantees

Each public alpha is published only after:

- repository branch, tag, security, and release-environment protections are in
  place;
- Node minimum-version and supported-platform package smokes are green;
- the source, npm, Bun-installer, curl, and Homebrew instructions describe one
  truthful dependency chain with Node.js as the runtime;
- installed size is measured and disclosed;
- onboarding cancellation and provider guidance are polished; and
- the tagged artifact, npm integrity, GitHub assets, checksums, and attestations
  all identify the same bytes.

See [Feature status](FEATURE_STATUS.md) for the complete capability inventory,
[Company evaluation](COMPANY_EVALUATION.md) for the recorded dogfood evidence,
and [Release runbook](RELEASING.md) for the owner-controlled publication path.
