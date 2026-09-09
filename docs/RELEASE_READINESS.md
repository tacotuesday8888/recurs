# Release readiness work record

Objective: complete the September 2026 Recurs release-readiness request. This is
one continuing objective; milestones below are not claims of overall completion.

Current release: **0.1.0-alpha.10, published September 9, 2026**. Merged source,
platform CI, protected publication, attested assets, and fresh public npm/curl
installations are verified. The matching Homebrew tap update passed its
independent install/test gate and is merged.
Alpha.9 was tagged but not published after an npm 12 terminal-harness parser
failure; its tag and historical evidence are preserved without rewriting.

## Authority and starting state

- Canonical repository started clean at `e5999f5` on `main`, matching `origin/main`.
- Work branch: `codex/release-readiness`. Existing website worktrees are unrelated.
- GitHub login, admin access, push dry run, Actions visibility and registry
  connectivity verified. Installed Codex 0.145.0 reports ChatGPT login.
- The user explicitly authorized implementation, push, PR, green merges and,
  in their subsequent instruction, full completion without further questions.
  Publication remains subject to the repository's protected workflow.
- No personal MCP/skill configuration will be changed for testing.

## Decisions and confirmed changes

- Retain the TypeScript package architecture, pi-tui renderer, bounded tools,
  permission ceilings, isolated worktrees and durable execution journals.
- Replace decorative company-floor UI with conventional team/execution views.
- Fixed: agent selection now opens that exact execution's transcript and
  cancellation controls; the composer is explicitly the parent conversation.
- Completed: terminal execution projection now includes ordinary agent starts and
  reconstructs durable state on reopening.
- Completed: SDK-backed HTTP/OAuth and tools/resources/prompts extend stdio MCP;
  skills now support explicit-source installation and lifecycle management.
- Research decisions and current primary sources are recorded separately in
  `research/release-readiness-ecosystem-2026-09.md`.

## Ownership

| Workstream | Owner | Status |
| --- | --- | --- |
| Terminal, onboarding, integration, release workflow | Primary | Published, public installations verified, matching Homebrew tap merged |
| Execution inventory, inspection, controls, recovery | Execution agent | Implemented and verified |
| MCP transport/auth/capabilities/lifecycle | Extensions agent | Implemented and verified |
| Ecosystem research, skills lifecycle | Ecosystem agent | Implemented; installed skills and Guided/Deep journeys verified |

## Acceptance ledger

All entries require fresh evidence from the integrated artifact.

- [x] Clean install and first connection
- [x] Quick ordinary coding task
- [x] Quick, Guided, Deep onboarding and revisiting setup
- [x] Team customization and effective limits
- [x] All actual execution kinds, hierarchy and model attribution
- [x] Exact agent transcript, artifacts and intervention
- [x] Review, repair and explicit apply with independent verification
- [x] Local/remote/authenticated MCP and capability permissions
- [x] Skills addition, installation, inspection and invocation
- [x] Interruption, reopening, recovery and compatibility
- [x] Terminal resize, small windows, paste, long output, scrolling and no-color
- [x] Security finding revalidation and failure-path checks
- [x] Full checks and Linux/macOS CI
- [x] Packaged installed CLI verification and measured performance
- [x] Current README, real terminal capture, docs and contributor guidance
- [x] Green PR merge, canonical synchronization and branch accounting
- [x] Exact release artifact, protected publication and installed published check
- [x] Homebrew tap update with its independent formula install/test gate

## Verification log

Baseline: 2,222 tests passed, seven failed inside the outer tool sandbox.
The affected integration suite passed outside that outer restriction: 110
passed, four skipped. These failures involved denied loopback sockets and
nested OS sandbox startup, not assertion changes.

Integrated focused terminal/onboarding checks: 70 tests passed. Independent
execution, cancellation and recovery checks: 89 tests passed. Skills lifecycle:
12 tests passed, including adding the first skill to a running CLI and invoking
it through the real parent tool loop.

Installed PTY acceptance passed using a newly packed alpha.8 source artifact
and isolated home on macOS: connection, Quick start, paste, streaming Markdown,
code block, 65-line output, scroll, 32x10 resize, execution navigation, clean
exit and durable reopen. Two deterministic model requests. Capture generated
from terminal output in `docs/assets/terminal-session.svg`. This is harness
verification, not a model-quality result.

Bundle measurement before variable mangling: 2,113,491 bytes. Enabling
rolldown variable mangling while preserving function/class names reduced the
bundle to 1,661,112 bytes; the original 2.10 MB ceiling is retained. Installed
acceptance ran against the resulting bundle. Final alpha.10 measurements are
recorded below.

Preflight registry verification found `alpha` at alpha.7 and `latest` at alpha.2.
The prior docs' alpha.8 publication claim was not supported. Its obsolete
publication workflow was later cancelled after alpha.10 published successfully.

Security review reproduced and fixed an owned subprocess orphan on natural
exit. New tests cover descendants with inherited and ignored output pipes.
Independent review also found OAuth metadata SSRF and OAuth credential masking
gaps; both are fixed and covered by the linked closure evidence. Prior alpha.8 evidence
is historical and does not verify this new release.

## Integrated alpha.9 verification

- Full `npm run check`: 180 test files; 2,277 tests passed, four existing
  platform/capability skips; 38 script checks passed; lint, type checking,
  generated sources, build, package metadata and package bounds passed.
- Packaged installed-agent smoke passed: independent fixture verification,
  company formation, hierarchy, rejection, repair, re-review, synthesis and
  approved application; local provider, skills, stdio MCP and ACP.
- Real PTY alpha.9 smoke passed: isolated clean install, Start coding, paste,
  streaming, long output, scrolling, 32×10 resize, execution list and restart.
- Additional sustained-output test retains a bounded 256 KiB recent transcript
  after 1 MiB of output and renders correctly at 32×10.
- One bounded live installed Codex coding task passed its independent hidden
  verifier, improving 2/7 to 7/7 cases. Vendor internal model-request counts and
  cost were unavailable; no comparative superiority is inferred.
- Read-only live DeepWiki MCP discovery passed. OAuth and expiry/refresh use
  an independently implemented local issuer, never real test secrets.
- See [MCP acceptance](research/release-mcp-acceptance-2026-09.md) and
  [security closure](research/release-security-closure-2026-09.md).

Pre-Linux-hook-fix alpha.9 measurement (macOS arm64, Node 22.22.3): 565,375
bytes compressed, 1,833,516 unpacked, 47,788,312 installed regular-file bytes.
Five `--version` process starts: 752, 461, 467, 465, 468 ms (median 467 ms).
These are local observations, not cross-machine performance claims. The
published workflow artifact receives its own final hash and measurements.

The pre-Linux-hook-fix installed PTY and extensions/onboarding gates tested the same archive:
`081b872e5c6908e7fe743b73228ddda5de7ed710273c20da8f25e589e3faf9de`
(SHA-256). Guided and Deep each used two local fixture requests, saved their
proposal, exited, reopened and approved it without another model request.
Installed testing exposed and fixed the previously broken saved-proposal resume.
Skill paths with whitespace, apostrophes, quotes and backslashes round-trip;
invocation without a model now fails with actionable setup guidance. See the
[live and installed acceptance report](research/release-live-acceptance-2026-09.md)
for exact evidence and the distinction between fixture and live model checks.

Production dependency audit: zero known vulnerabilities at final preflight.
The final package keeps the existing 2.1 MB unpacked ceiling. Current source
uses the SDK, pi-tui and preserved TypeScript architecture; no language rewrite
or copied upstream application was needed. Deprecated V19 reference files were
removed after the conventional UI passed its acceptance checks.

Final installed company smoke also passed explicit `--resume` execution listing,
exact Implement transcript inspection, and an honest no-live-owner response when
stopping historical work. A fresh `recurs run` intentionally starts a new session.

The first PR CI run passed macOS (2,281 tests and four existing skips), all
installed gates, Bun, and code analysis. Linux's positive-control hook test
exposed a temporary executable hidden by the sandbox. The follow-up mounts only
that approved file read-only; the full Linux rerun is required before merge.
A local `--version` measurement on the earlier alpha.9 artifact recorded
207,060,992 bytes maximum RSS / 157,835,648 bytes peak memory footprint and
0.46 s elapsed on macOS arm64. This is startup evidence, not a workload memory
benchmark. The npm README uses release-neutral status wording so immutable
published packages do not retain a stale registry snapshot.

## Final merged source and platform gates

[PR #193](https://github.com/tacotuesday8888/recurs/pull/193) merged as
`01c78e62e711a3420334865fed93b8cf3c3493d7`; canonical `main` matched
`origin/main` and was clean. Release tag: `v0.1.0-alpha.9`.

[Final CI](https://github.com/tacotuesday8888/recurs/actions/runs/34305124016)
passed on the exact PR head:

| Gate | Verified result |
| --- | --- |
| Linux / Node 22.22.0 | 180 files, 2,286 tests passed; all three installed gates passed |
| macOS / Node 24.18.0 | 180 files, 2,282 tests passed, four existing platform skips; all installed gates passed |
| Package scripts | 38 checks passed, package allowlist and 2.1 MB ceiling retained |
| Bun 1.3.14 / Linux | Install and Node entrypoint checks passed |
| CodeQL | Both analyses and overall check passed after individual false-positive review |

The Linux hook fix passed actual Bubblewrap execution in final CI; it is no
longer awaiting platform verification. [CodeQL review](security/mcp-oauth-client-id-hash-review.md)
records why hashing a public OAuth client ID for directory selection is not
password storage; the security rule remains enabled.

Both platform installed gates produced the same tarball SHA-256:
`1976e9cb21e590e4fae3903aa0020e61b70e06de7fb4a11e4254ab6f2d160d0b`.
Exact size: 565,497 compressed bytes / 1,834,086 unpacked bytes / eight files.
Installed regular-file sizes: 47,725,847 bytes (Linux), 47,788,882 (macOS),
excluding npm cache and optional vendor runtimes. These are platform-specific
measurements, not universal size or speed guarantees.

The protected [publication run](https://github.com/tacotuesday8888/recurs/actions/runs/34305523427)
was approved by the authorized owner for this exact tag, then failed before
publication as recorded below. Alpha.9 remains an unpublished, preserved tag.

## Publication harness correction

Alpha.9's protected run failed before draft assets or npm publication because
`smoke-terminal.mjs` assumed npm pack always returned an array. The repository
already has `parseSingleNpmPackReport`, covering both npm report shapes; the
terminal gate now uses it. The macOS lane pins the same npm 12.0.1 client as the
publisher, so this path is verified before the next tag. Linux retains the
exact supported minimum Node 22.22.0 and its bundled npm; npm 12 itself requires
Node 22.22.2 or newer. This is a harness
correction, not a skipped gate or rewritten release. Existing alpha.9
source/platform evidence remains labeled above.


## Alpha.10 merged source and platform verification

[PR #194](https://github.com/tacotuesday8888/recurs/pull/194) merged as
`eeafaf651920f8a4cce2c8d662cadd4acd51d504`. The release harness correction is
included in this source; alpha.9 history was preserved. The same merged source
also passed [main-branch CI](https://github.com/tacotuesday8888/recurs/actions/runs/34306624979)
and [main-branch CodeQL](https://github.com/tacotuesday8888/recurs/actions/runs/34306622760).

[Alpha.10 CI](https://github.com/tacotuesday8888/recurs/actions/runs/34306302672)
passed every required gate:

| Gate | Verified result |
| --- | --- |
| Linux / Node 22.22.0 and bundled npm | 180 files, 2,286 tests passed; all three installed gates passed |
| macOS / Node 24.18.0 and npm 12.0.1 | 180 files, 2,282 tests passed, four existing platform skips; all three installed gates passed |
| Bun 1.3.14 / Linux | Install and Node entrypoint checks passed |
| CodeQL | Both analyses and overall check passed |

The installed-agent, terminal PTY, and extensions/onboarding gates all passed
on both platforms. The terminal and extensions gates recorded matching archive
SHA-256: `f6e0572f2539b0f8d4b94214816f2926af05f4f82c07a20f3ee07d187fdf3c67`.

- Compressed archive: **565,501 bytes**.
- Unpacked package: **1,834,091 bytes**.
- Installed regular-file bytes: **47,725,855** on Linux and **47,788,890** on macOS,
  excluding npm cache and optional vendor runtimes.
- Archive integrity: `sha512-uSVU0zh1E/L0qV9oU6DzczH018wG4n2ll8/CfYswKT0Ogoe0VdEtZoKqOSDdiKPx3KROl6k/0kpDqwyq9PAZtw==`.

These values identify the tested alpha.10 artifact; the earlier alpha.8 and
alpha.9 live runs, measurements, and hashes retain their historical scope.
No additional live model task was performed for the harness correction.

## Alpha.10 public publication and installation

The protected [publication run](https://github.com/tacotuesday8888/recurs/actions/runs/34306661860)
succeeded. The [GitHub prerelease](https://github.com/tacotuesday8888/recurs/releases/tag/v0.1.0-alpha.10)
was published at **2026-09-09 03:23:19 UTC** with curated release notes and five
assets: the npm archive, `install.sh`, `recurs.rb`, `SHA256SUMS`, and
`npm-integrity.txt`.

All five downloaded assets matched their attested SHA-256 values. GitHub
attestation verification selected the publication workflow as signer and
confirmed `refs/tags/v0.1.0-alpha.10`, source commit
`eeafaf651920f8a4cce2c8d662cadd4acd51d504`, and publication run `34306661860`.
The package SHA-256 and SHA-512 integrity match the artifact recorded above.

The public npm registry now serves `recurs@alpha` as `0.1.0-alpha.10`, while
`latest` remains `0.1.0-alpha.2`. A direct registry archive download was
byte-for-byte identical to the attested GitHub archive. A fresh isolated
home/cache/prefix installed `recurs@alpha` with lifecycle scripts disabled;
`recurs --version` returned `0.1.0-alpha.10` and `recurs --help` exited 0.

The public checksum-verifying curl script also installed successfully into an
isolated home/prefix. Its executable returned `0.1.0-alpha.10`; `doctor`
reported six checks OK, one expected unconfigured-provider warning, and zero
failures after a real macOS Seatbelt check outside the enclosing test sandbox.
That public installation then passed the skills lifecycle, HTTP MCP discovery,
and Guided/Deep save/reopen/approval journeys. Each formation depth used two
local fixture responses; the complete public-installed extension check made
zero live model requests.

The [Homebrew tap update, PR #4](https://github.com/tacotuesday8888/homebrew-recurs/pull/4),
passed its independent [formula install/test gate](https://github.com/tacotuesday8888/homebrew-recurs/actions/runs/34307090288)
and merged as `44200e5e48aeb5f95e5f882d6d71e8e73c972e66`. The tap's formula
matches the attested release formula exactly; local tap `main` matched
`origin/main` at that exact commit and was clean. The separate
[post-merge check](https://github.com/tacotuesday8888/homebrew-recurs/actions/runs/34307191091)
also passed. Both the reviewed PR and merged tap state have green installation
verification.


## Subsequent alpha.11 product polish

Alpha.11 shipped from PR #196 with persistent terminal appearance, a saved-model
picker, specialist route previews, onboarding corrections, and more accurate
execution/limit presentation. [Product polish and release evidence](PRODUCT_POLISH.md)
is the authoritative record for its exact source, artifact, platform checks,
public installations, comparative experiments, and live-test limitations.
The alpha.10 and earlier evidence above remains historical and unchanged.
