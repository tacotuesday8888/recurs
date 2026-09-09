# Release readiness work record

Objective: complete the September 2026 Recurs release-readiness request. This is
one continuing objective; milestones below are not claims of overall completion.

Current release target: **0.1.0-alpha.10**. Alpha.9 was tagged but not published;
its protected workflow stopped before uploads on an npm 12 pack-report parser
mismatch in the terminal test. The tag is preserved without history rewriting.
Alpha.10 reuses the shared parser and pins CI to the same npm 12.0.1 publisher.

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
| Terminal, onboarding, integration, release workflow | Primary | Implemented; release verification in progress |
| Execution inventory, inspection, controls, recovery | Execution agent | Implemented and verified |
| MCP transport/auth/capabilities/lifecycle | Extensions agent | Implemented and verified |
| Ecosystem research, skills lifecycle | Ecosystem agent | Implemented; installed journey verification in progress |

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
- [ ] Exact release artifact, protected publication and installed published check

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
acceptance ran against the resulting bundle. Final release measurements pending.

Registry verification found `alpha` points to alpha.7 and `latest` to alpha.2.
The prior docs' alpha.8 publication claim was not supported; a historical
publication workflow remains awaiting its protected environment review.

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
was approved by the authorized owner for this exact tag. Publication verification
is the remaining gate; tag creation alone is not publication.

## Publication harness correction

Alpha.9's protected run failed before draft assets or npm publication because
`smoke-terminal.mjs` assumed npm pack always returned an array. The repository
already has `parseSingleNpmPackReport`, covering both npm report shapes; the
terminal gate now uses it. All CI lanes pin the same npm 12.0.1 client as the
publisher, so this path is verified before the next tag. This is a harness
correction, not a skipped gate or rewritten release. Alpha.10 is the next
candidate; existing alpha.9 source/platform evidence remains labeled above.
