# Public Alpha Status

**Status:** `0.1.0-alpha.6` public alpha. Recurs is available as one verified
npm artifact through npm, Bun-as-installer, a checksum-verifying curl asset,
and the official Homebrew tap.

## Installation reality

| Path | Status | What that means |
| --- | --- | --- |
| Source checkout with npm | Supported alpha path | Clone the repository, run `npm ci`, build, and `npm link` on Node.js 22.22+ |
| npm registry | Recommended path | `npm install --global recurs@alpha` installs the current reviewed alpha |
| GitHub release / curl | Published alpha path | The release carries the exact archive and a checksum-verifying user-local installer |
| Homebrew | Published tap path | `brew install tacotuesday8888/recurs/recurs` installs the same npm archive through the official tap |
| Bun global install | Verified installer path | `bun install --global recurs@0.1.0-alpha.6` installs the package; Node.js 22.22+ still executes it |
| Bun runtime | Unsupported | No `bun run`, native Bun execution, broader Bun-version, or broad platform-compatibility claim |
| Signed binary / desktop | Not implemented | There is no standalone download or desktop application |

The package gate caps the unpacked Recurs artifact at 2.1 MB. On 2026-08-05 the
exact `0.1.0-alpha.6` archive measured 445 KiB compressed / 1.92 MiB unpacked.
Its clean Apple-silicon production prefix measured 38.9 MiB. It did not install
Codex. The full source-development dependency tree measured about
402 MiB because it retains roughly 307 MiB of pinned Codex compatibility
fixtures. Exact size varies by platform and npm version.

## What is proven

The base harness, bounded company runtime, provider routes, permissions,
worktree isolation, independent review, repair state machine, recovery, and
explicit apply path are covered by automated tests.

One real Codex subscription dogfood on 2026-07-23 also completed:

1. Quick company formation and approval;
2. a Balanced three-assignment coding goal;
3. isolated Terra implementation;
4. independent Luna review;
5. Sol synthesis and explicit apply; and
6. evidence-backed Auto lineup activation.

The run changed two files and passed four fixture tests. It reported 216,879
input tokens, including 161,024 cached input tokens, and 3,274 output tokens.
Dollar cost was unavailable. Review approved the first candidate, so the
configured Repair fallback did not activate in that live run; deterministic
integration tests cover the request-changes, repair, and re-review branch.

The frozen evaluation now covers 11 campaigns and 30 trials across three
harness revisions. Raw hidden-verifier passes were 9/13 for the Sol baseline,
7/13 for mixed Auto, and 1/4 for the all-Sol company. Two repetitions were
correlated upstream parent/provider failures across all three arms; excluding
only those six roster-non-informative trials leaves 9/11, 7/11, and 1/2. The
mixed company used three times as many requests and 1.82 times as many input
tokens on the six matched pairs where both it and the baseline passed. Dollar
cost remained unknown for all 30 trials. See the
[versioned evidence report](research/2026-08-04-RECURS-MODEL-TEAM-EVALUATION-V1.md)
for the complete results and limitations.

## What is not proven

The current evidence does not establish that the Sol/Terra/Luna lineup is a
universal winner, that a large team is cost-effective, or that it reliably
beats a strong single agent. The frozen multi-campaign report covers harness
revisions through alpha.5, but its alpha.5 subset includes no `layered_config`
campaign. One post-tag, alpha.6-labeled current-source `alias_registry` pair
now passes both arms, but the company was 32.6% slower and used 3.37 times as
many input tokens. That remains below the three-pair comparability floor. See
the [pinned current-source live proof](research/2026-08-05-RECURS-ALPHA6-LIVE-COMPANY-PROOF.md).
Before publishing a default recommendation, Recurs needs repeated
current-harness comparisons that record:

- final quality and test results;
- review findings and repair rounds;
- elapsed time and failure rate;
- total and cached tokens; and
- provider-reported dollar cost when available.

The source contains the repeatable comparison machinery: three immutable
hidden-verifier fixtures, alternating campaign order, distinct
Quick/Guided/Deep formation evaluations, the selected parent-only baseline,
the currently configured saved role-route snapshot, and an explicit all-strong
comparison option. Terra Implement completed all 10 observed attempts and seven
final Luna approvals all passed the verifier, but Terra Repair recovered 0/2
candidates. Those role-confounded samples do not substitute for model/effort
crosses, repeated current-harness runs, or real price coverage.

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
