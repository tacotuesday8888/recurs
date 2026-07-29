# Public Alpha Status

**Status:** source-only public alpha candidate. Recurs is usable from a
checkout, but no package or release has been published.

## Installation reality

| Path | Status | What that means |
| --- | --- | --- |
| Source checkout with npm | Supported alpha path | Clone the repository, run `npm ci`, build, and `npm link` on Node.js 22.22+ |
| npm registry | Prepared, not published | Package metadata, verification, and installed-prefix smoke exist; `npm install -g recurs` does not work yet |
| GitHub release / curl | Prepared, not published | The release workflow can derive a checksum-verifying installer from the exact npm archive |
| Homebrew | Prepared, not published | A formula can be generated from that same archive; there is no tap |
| Bun global install | Prepared, not published | Bun 1.3.14 on Linux CI installs the exact npm tarball; Recurs still executes with Node.js 22.22+ |
| Bun runtime | Unsupported | No `bun run`, native Bun execution, broader Bun-version, or broad platform-compatibility claim |
| Signed binary / desktop | Not implemented | There is no standalone download or desktop application |

The package gate caps the unpacked Recurs artifact at 2.1 MB. On 2026-07-26 the
exact local alpha archive measured 414 KiB compressed / 1.79 MiB unpacked, and
a clean Apple-silicon production prefix measured about 38.7 MiB. It did not
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
Dollar cost was unavailable. Review approved the first candidate, so Repair did
not activate in that live run; deterministic integration tests cover the
request-changes, repair, and re-review branch.

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
Quick/Guided/Deep formation evaluations, a recommended bounded team, and an
explicit all-strong comparison option. The first full task-catalog pass is
recorded, but it does not substitute for repeated runs or alternative teams.

Other current limits include Windows subprocess containment, a persistent
worker daemon, a company operating UI, automatic plugin installation, remote
MCP/OAuth, and unattended commit, push, deployment, or messaging.

## Alpha release bar

A first public package should ship only after:

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
