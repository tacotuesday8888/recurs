# Active-Use Release Candidate

**Evidence date:** 2026-08-08
**Starting revision:** `1e4347b42d0953b246aae5915feca78b9118b5f7`
**Package version:** `0.1.0-alpha.7`

This is current release-candidate evidence, not a rewrite of the dated research
archive. Website implementation was excluded. The already merged
[website-direction brief](product/WEBSITE_DIRECTION.md) was preserved, and both
paused website worktrees were left untouched.

## Interrupted local check

The four reported files reproduced exactly six failures inside the Codex
desktop sandbox: two loopback listeners failed with `listen EPERM`, and four
Recurs subprocesses exited 71 when macOS Seatbelt was nested under the desktop
sandbox. One onboarding test reported both its listener failure and cleanup
consequence.

The byte-identical command outside the desktop sandbox passed 110 tests with
four platform skips. Recent GitHub CI was therefore consistent with the local
evidence. These were host-specific nested-sandbox restrictions, not six Recurs
product defects. No retry, sleep, skip, weaker assertion, or production
workaround was added.

## Exact packed-artifact journey

After the required build step, `npm run package:smoke-install` packed the
current source artifact, installed it into an empty temporary prefix, and used
separate private homes for ordinary first use and company onboarding. The
journey passed:

- empty account state, local account setup, JSON readiness, human help/version,
  text/JSON/JSONL contracts, sanitized actionable failures, permissions, and
  workspace sandboxing;
- fresh sessions, exact-session resume, a distinct non-resumed session, ACP,
  Plan-only review and diagnostics, and durable JSONL state;
- Quick company formation and approval, layered lead/Implement/Review,
  independent change request, Repair, independent re-review, parent synthesis,
  explicit apply, and the external clamp fixture test; and
- unknown values remained unknown rather than becoming zero or an inferred
  dollar amount.

Focused cancellation, interruption, and company recovery remain covered by
the full runtime integration suite; the installed smoke does not claim that a
completed company run was interrupted merely to manufacture recovery evidence.

## Official Codex subscription dogfood

Authentication remained owned by the official Codex CLI. `codex-cli 0.145.0`
reported an existing ChatGPT login. No API key was requested, pasted, read, or
copied. User-present `account verify` passed separately for the saved Sol,
Terra, and Luna app-server routes; headless verification correctly refused to
run.

Quick formation produced evaluation
`evaluation_672394293dfd187b53ee1e6870bf8471` in 41.563 seconds with two model
requests. Interview, tailoring, decomposition, and evidence rubrics passed.
Its overall status was `partial` because provider-reported dollar cost was
unknown.

The frozen `alias_registry` repetition produced campaign
`company-proof-6c574347-8188-41bc-8eed-85b577e1df7a` with exact ceilings of two
trial slots, 192 requests, and $6 maximum *reported* cost:

| Arm | Activated routes | Result | Time | Requests | Tokens | Reported cost |
| --- | --- | --- | ---: | ---: | --- | --- |
| Single agent | Sol/high Parent | 7/7 verifier checks passed | 303.702s | 1 | 380,292 input; 324,608 cached; 13,825 output; 6,724 reasoning | unknown |
| Company | Sol/high Parent; Terra/medium Implement; Luna/medium Review | hidden registry-boundary check failed | 139.236s | 3 | 256,015 input; 198,912 cached; 5,298 output; 2,387 reasoning | unknown |

Luna approved the company candidate, but the hidden verifier failed. Repair
did not activate because Review approved. This is another observed false
approval in a single bounded run, not evidence of a general failure rate. The
run had complete token coverage and no dollar-cost coverage. It reinforces the
Round 2 `insufficient_evidence` decision and does not justify a Models: Auto or
worker-route promotion.

## Provider truth

Current source keeps four states separate:

1. catalog support from a reviewed manifest;
2. implemented adapter/onboarding capability;
3. readiness of an exact saved account; and
4. recent safe live verification.

Fixed-endpoint BYOK and coding-plan adapters can execute while still lacking a
provider-specific discovery/readiness probe; the capability matrix therefore
keeps those entries `cataloged` or `conditional`. Codex and GitHub Copilot use
official vendor runtimes. Claude subscription and Z.ai GLM Coding Plan remain
blocked, and catalog-only cloud identity paths remain non-runnable. No browser
credential, vendor credential store, or unofficial authentication path was
used.

## Distribution

- npm dist-tags were `alpha = 0.1.0-alpha.7` and
  `latest = 0.1.0-alpha.2`. Installation guidance therefore uses
  `recurs@alpha`; no tag was changed or silently promoted.
- npm, GitHub release, `SHA256SUMS`, checksum installer, and the official tap
  all identified the alpha.7 archive with SHA-256
  `448f85c272c504f67641de057f63ee02fbd49fcc068dd5d9d864a477b1d40052`
  and npm SHA-512 integrity
  `sha512-JWDjB0WBiZ5pktITvFKqHHxYRmVL/qb+1RRSMjKzbWjB84O6Gl4T2Qi4WwBRg9jS6JI6ViO1y+rsxH92VJXDSQ==`.
- The published archive was 463,703 bytes compressed and 2,050,637 bytes
  unpacked, below the 2.1 MB gate. The public checksum installer completed in
  an isolated prefix and the installed CLI reported `recurs 0.1.0-alpha.7`.
- A dry-run pack of the post-tag current source was 473,600 bytes compressed
  and 2,074,701 bytes unpacked, also below the gate. It is not byte-identical
  to the immutable public alpha.7 archive and is not presented as such.
- The official tap resolved alpha.7 and matched the release formula digest.
  A real install was blocked before the Recurs formula ran because this host
  could not establish TLS to the `ghcr.io` Homebrew bottle registry for the
  `ada-url` dependency.
- Official Bun 1.3.14 started the global-install smoke. This host then failed
  TLS validation for npm dependency manifests. TLS verification was not
  disabled. The repository's clean-network Bun CI lane remains the required
  acceptance check and continues to prove a Node shebang plus failure without
  Node.

The public alpha.7 archive is immutable tag output. Current `main` contains
post-tag source changes, including the official Copilot adapter; those changes
are not retroactively claimed as bytes in the published alpha.7 archive.

## Dependency triage

- `actions/attest` 4.2.1 passed the complete current-main check after refresh:
  171 test files, 2,200 tests passed, four platform skips, build, and 38 package
  checks. Fresh Linux, macOS, Bun-installer, and CodeQL checks passed before
  PR #145 was merged.
- `@types/node` 25 was closed because Recurs supports and type-checks the Node
  22 minimum runtime.
- Rolldown 1.2.1 was closed because Vitest still requires 1.1.5, producing a
  second large native binding tree without a demonstrated product benefit.
- Codex 0.146.0 was closed because the reviewed integrity/profile authority,
  the installed authenticated runtime, and `codex-acp` 1.1.7 all remain on
  0.145.0. Safe adoption requires a matching ACP update or a separately
  reviewed split-version design and fresh live/cross-platform evidence.

## Remaining exclusions

There is no website implementation, native Bun runtime, signed standalone
binary, Windows subprocess containment, persistent daemon, broad remote MCP or
OAuth support, universal model winner, known dollar cost, or claim that every
cataloged provider is runnable.
