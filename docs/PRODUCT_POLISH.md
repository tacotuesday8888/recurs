# Product polish — September 2026

Current source candidate: **0.1.0-alpha.11**. Publication is pending. Alpha.10's
completed release evidence remains in [the release record](RELEASE_READINESS.md).
This phase improves daily use of the existing TypeScript CLI and controlled
agent hierarchy; it does not claim perfection or general superiority.

## Comparison and decisions

[Seven-project source review](research/product-comparison-2026-09.md) covers
OpenCode, Kilo, Pi, Cline, Qwen Code, Continue, and Roo. Their exact CLI versions,
licenses, fork relationships and maintenance caveats are recorded. OpenCode,
Kilo, Pi, Cline and Qwen are the practical current peers; Continue and Roo are
historical design references. Antigravity is excluded as a primary peer.

Adopted patterns are transactional theme previews, a saved-model picker,
explicit specialist route summaries, and clearer separation of configured roles
from real executions. The underlying permission ceilings, immutable model pins,
worktree isolation, review/repair and explicit apply remain enforced.

A [matched installed Recurs/Pi experiment](research/product-harness-comparison-2026-09.md)
passed three deterministic cases on both products with identical final files
and request counts. Pi was faster in these runs. These small prescribed tasks
establish execution and recovery mechanics, not model quality, security parity,
or a reason to select deeper or more expensive teams automatically.

## Delivered behavior

- [Appearance](APPEARANCE.md): persistent system/dark/light/contrast presets,
  strict custom semantic colors, F2 and `/theme`, draft-preserving preview/cancel,
  visible save errors, and no-color support.
- `/model`: choose a saved connection, cancel without mutation, and retain the
  existing confirmation before starting a newly pinned session.
- `/agents routes`: inspect parent model/effort and configured specialist
  candidates, missing connections, inheritance, and mode restrictions. Future
  launch resolves eligibility; old execution pins never change.
- New chat reuses the selected model and permissions. Setup retries invalid team
  limits, displays saved controls before approval, and explains missing required
  tools. Proposal review remains usable if an editor removes or makes its temporary
  draft unreadable; the saved proposal is retained.
- Configured team role and active counts describe the current goal; the execution
  list retains prior goals and ordinary children. Repeated roles keep distinct
  execution identities, configured roles are marked inactive, and inspectors
  show actual limits, usage, permission ceilings, and exact recovery commands.

## Verification

The first integrated `npm run check` passed 182 test files / 2,330 tests with
four existing platform skips, plus all 38 package-script checks, generated-source
verification, lint, type checking, build, and package bounds. Subsequent focused
review added regressions for invalid appearance plus restored history, live
root-limit refresh after a mode change, and concurrent color writes. Final CI
must include those changes.

The installed terminal gate passed Start coding, saved-model cancellation,
theme preview with draft preservation, no-color saving, light-theme restart,
live dark switching, new chat, Markdown/code, paste, scrolling, 32×10 resize,
execution navigation, and durable reopening. Three local fixture responses;
no live inference. Archive SHA-256:
`be8b98214bf7f5bfe656530bcc3297d4d12144f80470db1e56b9ac68eff2978b`.
That candidate also passed the installed-agent gate. The earlier extension gate
passed archive `e5ee49527d3843b9870eaf2fca6a74b085e1bfe1de516f5a09b4708b1b311ca3`.

The captured candidate measured 572,047 compressed / 1,855,686 unpacked bytes,
with 47,810,485 installed regular-file bytes on macOS arm64 / Node 22.22.3.
Five `--version` startups were 780, 452, 457, 454, and 453 ms. These are local
measurements, excluding optional vendor runtimes, not universal performance claims.
Named palettes and captured layout were visually inspected. The existing
2.1 MB package ceiling remains enforced.

After the final review fixes, 242 focused terminal/runtime tests, whole-project
TypeScript checking, and full ESLint passed. The final installed terminal gate
passed archive `36cc49f554cd8464db3b34085c513e42672f0d728c59fc699e7b01659e60a8f5`:
572,137 compressed / 1,855,987 unpacked bytes. Production dependency audit found
zero known vulnerabilities. A changed-file secret-pattern scan and diff checks
passed; this is not a claim that static scanning proves the absence of secrets.

Linux/macOS and public distribution results will be appended after each gate completes. Candidate hashes in research records
identify only the bytes tested at that stage, even when their version string
still matched alpha.10. They do not certify later source changes.

## Boundaries

One additional hierarchy layer is useful only when it has a bounded task and
independent acceptance criteria. Start with a parent and direct specialists;
raise depth/concurrency deliberately using the existing controls. No evidence
here establishes an optimal universal number of levels. Configured organization
layers are not proof that those agents ran.

Inspectors support reading and cancellation of owned executions. Child-specific
message steering is not implemented; further direction goes through the parent.
There is no persistent daemon or Windows process isolation. Vendor internal
traces and monetary cost can remain unavailable. More real workloads and user
feedback can still reveal improvements after this release.

## Initial platform pass and bounded live result

[CI 34348611364](https://github.com/tacotuesday8888/recurs/actions/runs/34348611364)
passed on `d274775`: Linux 183 files / 2,338 tests; macOS 183 files / 2,334
passed and four platform skips. Both platforms passed all three installed gates
with archive `36cc49f554cd8464db3b34085c513e42672f0d728c59fc699e7b01659e60a8f5`.
Bun installation and both CodeQL analyses also passed. Final documentation and
install-link changes receive a fresh PR run before merge.

The [bounded live multi-file task](research/product-live-coding-acceptance-2026-09.md)
used historical Candidate A with the existing Codex login. Its independent
verifier improved from 3/24 to 24/24, exactly four allowed implementation files
changed, and the exact interrupted session reopened successfully. The resumed
turn hit its eight-minute deadline before final completion; marker recall and
live child execution were not proven. This is partial live acceptance, not a
clean completed-model-turn result. No more inference was launched after the bound.
