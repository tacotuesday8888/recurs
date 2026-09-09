# Product polish — September 2026

Published release: **0.1.0-alpha.11**. Alpha.10's
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
2.1 MB JavaScript bundle and 2.30 MB unpacked-package budgets remain enforced.

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

## Review finding corrected before merge

The final-head CI and CodeQL jobs passed, but the required review-thread check
correctly blocked merging on CodeQL alert 7 in the comparison fixture. Its local
HTTP error response included raw exception details. The response now contains a
fixed generic message; diagnostics remain in the local comparison report. No
security rule was suppressed or branch policy bypassed. ESLint, syntax checking,
and a fresh six-case Recurs/Pi run passed after the fix. This script is not part
of the published package, so the final candidate archive bytes are unchanged.

## Merged release source and exact candidate

[PR #196](https://github.com/tacotuesday8888/recurs/pull/196) merged as
`328fb28fb1610c8a8144990f7cc66bfd938bc457`; tag `v0.1.0-alpha.11` points to
that source. Canonical main and origin/main matched and were clean after merge.
The merge used normal policy after the review finding was fixed and resolved.

[Final PR CI](https://github.com/tacotuesday8888/recurs/actions/runs/34349847824)
passed 183 test files on each platform: 2,338 Linux tests; 2,334 macOS tests and
four existing platform skips. All three installed gates, Bun installation and
both CodeQL analyses passed. Linux used Node 22.22.0; macOS used Node 24.18.0
and the same npm 12.0.1 client as publication.

Both platforms and the final local matched comparison produced identical bytes:

- Archive SHA-256: `a9f50accd9ee6096bed3184ee3ba062c2b43fcdaf2e51f210a58dc48893266bd`.
- Integrity: `sha512-HXxOTDbyXUAMZWxh6MOIr8cz+lGhOeaEOyZlnQwZdXN8h9QmMU3XoClZKoAcXp+LLUSf8MSwTqpkVE57YemtFg==`.
- Compressed / unpacked: 572,136 / 1,855,987 bytes.
- Installed regular files: 47,747,751 bytes on Linux; 47,810,786 on macOS,
  excluding cache and optional vendor runtimes.

The [final candidate comparison](research/product-harness-comparison-alpha11.json)
again passed all three cases for Recurs and Pi 0.85.1. Request counts were 6/6/5
for each; resulting files matched; interruption markers survived; independent
verifiers remained unchanged and passed. Recurs elapsed 3658/3076/2554 ms versus
Pi 336/580/330 ms. No comparative correctness or speed advantage is claimed.
The generic fixture-error response fix was then rerun successfully with the
same package bytes; no fixture errors occurred in either pass.

## Public release and installed GitHub artifact

The protected [publisher](https://github.com/tacotuesday8888/recurs/actions/runs/34350317221)
succeeded and made [alpha.11](https://github.com/tacotuesday8888/recurs/releases/tag/v0.1.0-alpha.11)
public at **2026-09-09 12:23:18 UTC**. The merged source also passed
[main CI](https://github.com/tacotuesday8888/recurs/actions/runs/34350311473)
and [main CodeQL](https://github.com/tacotuesday8888/recurs/actions/runs/34350329098).

All five downloaded GitHub assets passed attestation verification against the
publication workflow, exact alpha.11 tag, source `328fb28`, and run `34350317221`.
The archive checksum matches the exact final candidate above. The public
checksum-verifying curl installer installed into an isolated home/prefix;
`--version` returned alpha.11 and `doctor` reported six checks OK, one expected
unconfigured-provider warning, and zero failures, including real Seatbelt
execution with network denied.

The public installed executable SHA-256 is
`0b7d0e8fe760d1b5e5adf5c476c9724048ab2e6cd65e1ceb3f44556dc600ee6b`, identical to
the final matched candidate. It passed the complete public-installed extensions
gate: skills lifecycle including quoted resource paths, HTTP MCP discovery and
lifecycle, and Guided/Deep proposal save/reopen/approval. Each formation depth
used two local fixture responses; zero live model requests were made.

npm accepted the publication and initially reported processing. Its metadata
then exposed alpha.11 and the matching SRI before the tarball became available.
A cached archive 404 advertised a 300-second lifetime. The first Homebrew
install check hit that 404; the formula's style check passed. The tap merge was
held, with the exact attested formula retained, until normal download and
installation verification could succeed. Final registry/tap results follow.


The standard npm tarball URL subsequently returned HTTP 200. Its downloaded
bytes matched the attested GitHub archive exactly and its SHA-512 matched npm's
metadata. A fresh isolated npm home/cache/prefix installed `recurs@alpha` with
lifecycle scripts disabled; the executable returned `0.1.0-alpha.11`. Final
registry tags were `alpha: 0.1.0-alpha.11` and `latest: 0.1.0-alpha.2`. No release
was republished and no tag was overwritten to resolve the temporary cache.

## Homebrew and branch accounting

[Homebrew PR #5](https://github.com/tacotuesday8888/homebrew-recurs/pull/5)
passed its independent [installation workflow, attempt 2](https://github.com/tacotuesday8888/homebrew-recurs/actions/runs/34350900158/attempts/2)
after npm propagation, and merged as `d67dc5191b72fdd389fd27df3842f4eb690e65fd`.
The installed CLI check and formula style check passed. The formula matches the
attested `recurs.rb` exactly; tap main and origin/main matched and were clean.
Its merged feature branch was removed. No formula changes or gate bypasses
were used to work around the temporary registry cache.

The completed implementation branch was merged and removed. The separate,
intentionally unfinished website worktrees remain outside this CLI release:
`codex/recurs-interactive-website-r2` at `4bb4bf4` and
`codex/sites-website-rebuild` at `deb3230`. They were preserved. Dependabot
PRs #180–185 remain separate dependency work. Current-source publication docs
and the final candidate comparison are delivered through a documentation PR.
