# Release readiness work record

Objective: complete the September 2026 Recurs release-readiness request. This is
one continuing objective; milestones below are not claims of overall completion.

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
- [ ] Full checks and Linux/macOS CI
- [x] Packaged installed CLI verification and measured performance
- [x] Current README, real terminal capture, docs and contributor guidance
- [ ] Green PR merge, canonical synchronization and branch accounting
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

Final source alpha.9 measurement (macOS arm64, Node 22.22.3): 565,375
bytes compressed, 1,833,516 unpacked, 47,788,312 installed regular-file bytes.
Five `--version` process starts: 752, 461, 467, 465, 468 ms (median 467 ms).
These are local observations, not cross-machine performance claims. The
published workflow artifact receives its own final hash and measurements.

Final installed PTY and extensions/onboarding gates tested the same archive:
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
