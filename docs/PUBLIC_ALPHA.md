# Public Alpha Status

**Status:** `0.1.0-alpha.4` public alpha. Recurs is available as one verified
npm artifact through npm, Bun-as-installer, a checksum-verifying curl asset,
and a release Homebrew formula.

## Installation reality

| Path | Status | What that means |
| --- | --- | --- |
| Source checkout with npm | Supported alpha path | Clone the repository, run `npm ci`, build, and `npm link` on Node.js 22.22+ |
| npm registry | Published alpha path | `npm install --global recurs@0.1.0-alpha.4` installs the reviewed artifact |
| GitHub release / curl | Published alpha path | The release carries the exact archive and a checksum-verifying user-local installer |
| Homebrew | Published formula asset | The release formula installs the same npm archive; there is no tap |
| Bun global install | Verified installer path | `bun install --global recurs@0.1.0-alpha.4` installs the package; Node.js 22.22+ still executes it |
| Bun runtime | Unsupported | No `bun run`, native Bun execution, broader Bun-version, or broad platform-compatibility claim |
| Signed binary / desktop | Not implemented | There is no standalone download or desktop application |

The package gate caps the unpacked Recurs artifact at 2.1 MB. On 2026-07-30 the
exact `0.1.0-alpha.4` archive measured 433 KiB compressed / 1.87 MiB unpacked,
and a clean Apple-silicon production prefix measured about 38.8 MiB. It did not
install Codex. The full source-development dependency tree measured about
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

On 2026-07-29 a fresh Company Proof pair was also run for each of the three
hidden-verifier fixtures. The Sol/Terra/Luna company passed all three; the Sol
single-agent baseline passed two. The company was not uniformly cheaper or
faster: it used three requests and more input tokens on both shared successes,
was slower on one, and slightly faster on one. See
[Company evaluation](COMPANY_EVALUATION.md) for the exact results and limits.

## What is not proven

One run per scenario does not establish that the Sol/Terra/Luna lineup is a
universal winner, that a large team is cost-effective, or that it reliably
beats a strong single agent. Before publishing a default recommendation,
Recurs needs repeated, same-task comparisons that record:

- final quality and test results;
- review findings and repair rounds;
- elapsed time and failure rate;
- total and cached tokens; and
- provider-reported dollar cost when available.

The source contains the repeatable comparison machinery: three immutable
hidden-verifier fixtures, alternating campaign order, distinct
Quick/Guided/Deep formation evaluations, the selected parent-only baseline,
the currently configured saved role-route snapshot, and an explicit all-strong
comparison option. The first full task-catalog pass is recorded, but it does
not substitute for repeated runs or alternative teams.

Other current limits include Windows subprocess containment, a persistent
worker daemon, a company operating UI, automatic plugin installation, remote
MCP/OAuth, and unattended commit, push, deployment, or messaging.

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
