# Recurs Documentation

Current documents:

- [Public alpha status](PUBLIC_ALPHA.md) — one-page installation,
  distribution, evidence, and remaining-risk summary.
- [Feature status](FEATURE_STATUS.md) — concise code-backed inventory of what is implemented, bounded, prepared-only, and absent.
- [CLI guide](CLI.md) — local and Codex setup, provider/account commands, permissions, storage, output, and limits.
- [Security policy](../SECURITY.md) — current support boundary, private reporting expectations, and credential-canary rules.
- [Release runbook](RELEASING.md) — verified artifact boundary, one-time npm bootstrap, trusted publishing, and later preview releases.
- [Base engine comparison](BASE_ENGINE_COMPARISON.md) — evidence from Kilo Code, OpenCode, and Codex and the resulting hardening decisions.
- [Sub-agent harness comparison](research/SUBAGENT_HARNESS_COMPARISON.md) — commit-pinned primary-source execution patterns from Codex, OpenCode, Kimi Code, Kilo Code, Roo Code, Pi, Goose, and Grok Build, plus the exact Recurs boundary derived from them.
- [Agent company onboarding](AGENT_COMPANY_ONBOARDING.md) — canonical product target for turning project intent into a tailored, durable agent company, including the implemented foundation and remaining gaps.
- [Company evaluation](COMPANY_EVALUATION.md) — deterministic offline and explicit configured-provider checks for the restricted formation path.
- [Auto model teams and simple controls](AUTO_MODEL_TEAMS.md) — implemented
  alpha for Economy-to-Max intensity, recommended rosters, and evidence-backed
  automatic four-role model lineups.
- [Architecture](../ARCHITECTURE.md) — implemented package boundaries and direct/delegated engine lifecycle.
- [Product direction](../PRODUCT.md) — CLI-first agent manager and sub-agent roadmap.

Reviewed specifications and implementation plans follow. These dated files are
design and delivery records; unchecked historical steps are not a live backlog.
Use [Feature status](FEATURE_STATUS.md), the CLI guide, and the architecture for
current product truth.

- [Core v0 design](superpowers/specs/2026-07-10-recurs-core-v0-design.md) — implemented single-agent foundation.
- [Provider, authentication, and onboarding design](superpowers/specs/2026-07-10-recurs-provider-auth-design.md) — historical umbrella design. The current portable TypeScript implementation retains the non-secret registry, local setup, environment BYOK, and official Codex delegated path; the obsolete private native provider engine was removed.
- [Saved public BYOK design](superpowers/specs/2026-07-19-saved-public-byok-design.md) — reviewed fixed-origin Chat/Anthropic providers, authenticated Anthropic model discovery, environment-reference setup, non-secret persistence, billing acknowledgement, immutable pins, and fail-closed runtime binding.
- [npm release-readiness design](superpowers/specs/2026-07-19-npm-release-readiness-design.md) — single-file Recurs bundle, exact runtime dependencies, minimal tarball allowlist, empty-prefix install smoke, hash-pinned Apache-2.0 preview metadata, and a protected publication gate. The implementation also derives checksum-bound curl and Homebrew assets plus GitHub attestations from the same exact tarball.
- [Provider Activation v1 design](superpowers/specs/2026-07-13-provider-activation-v1-design.md) — historical provider-policy work. The current implementation uses the portable TypeScript adapters and connection model described in the root architecture document.
- [Provider authentication matrix design](superpowers/specs/2026-07-11-provider-auth-matrix-design.md) and [implementation plan](superpowers/plans/2026-07-11-provider-auth-matrix.md) — exact catalog and first delegated-runtime slice.
- [Non-secret connection lifecycle design](superpowers/specs/2026-07-12-connection-lifecycle-design.md) and [implementation plan](superpowers/plans/2026-07-12-connection-lifecycle.md) — exact account management and immutable-pin routing for current runnable connections.
- [Base harness hardening plan](superpowers/plans/2026-07-10-recurs-base-harness-hardening.md).
- [Provider foundation Slice 0 plan](superpowers/plans/2026-07-10-recurs-provider-foundation-slice-0.md).
- [Tool safety foundation plan](superpowers/plans/2026-07-11-recurs-host-safety-foundation.md) — unified credential exclusions, checkpoint format gating, clean child state, tool profiles, and sanitized failures.
- [Recurs-owned child-agent plan](superpowers/plans/2026-07-17-recurs-owned-subagent-vertical.md), [multi-profile plan](superpowers/plans/2026-07-17-multi-approach-orchestration.md), [parallel analysis/review plan](superpowers/plans/2026-07-17-parallel-analysis-fanout.md), and [Team Orchestration v1 plan](superpowers/plans/2026-07-17-team-orchestration-v1.md) — durable parent/child state, exact profiles, shared budgets, versioned modes, isolated Git worktrees, safe patch integration/rollback, adaptive Review panels, and the original bounded foreground team.
- [Company blueprint v1 plan](superpowers/plans/2026-07-21-company-blueprint-v1.md) — implemented immutable tailored-company contracts and private storage, consent-gated root-marker intake, explicit roster/authority/tool/quality review, fresh orchestrator-bound activation, durable initial goal, and one real blueprint-aware parent-to-child synthesis path.
- [Complete CLI company foundation plan](superpowers/plans/2026-07-22-complete-cli-company-foundation.md) and [runtime quality plan](superpowers/plans/2026-07-22-company-runtime-quality.md) — implemented V2 company onboarding, validated assignment DAGs, multi-stage reviewed execution, role charters, attributable learning, amendments, exact Skill/MCP bindings, and deterministic/configured-provider evaluation.
- [Durable Team Runtime v2 design](superpowers/specs/2026-07-18-durable-team-runtime-v2-design.md) and [implementation plan](superpowers/plans/2026-07-18-durable-team-runtime-v2.md) — implemented Implement/Review/Repair profiles, sequenced journals, staged candidates, foreground/process-lifetime-background parity, owner fencing, explicit control/apply, restart recovery, explicit saved role routes, and bounded repair. Process-lifetime background is not a daemon; child-created unbounded recursion and automatic provider ranking remain absent.
- [MCP client v1 design](superpowers/specs/2026-07-19-mcp-client-v1-design.md) — bounded user-owned stdio configuration, isolated process execution, progressive tool discovery/calls, permission integration, explicit omissions, and the next safe interoperability slices.
- [Linux process-containment hardening review](security/linux-process-containment/hardening.md) — evidence, alternatives, tradeoffs, and the selected fail-closed system-Bubblewrap boundary for Linux tool subprocesses.

## Release status

Recurs is currently source-installable with npm and runs on Node.js. The
repository builds and verifies a minimal npm artifact, includes reviewed
direct-runtime dependency notices, installs it into an empty temporary prefix
in CI, and proves the installed binary's redacted readiness report can launch
the real OS sandbox. It also carries a manual fail-closed OIDC release
workflow. That workflow derives a checksum-verifying user-local installer and
Homebrew formula from the exact npm tarball, drafts and attests the GitHub
assets, verifies npm SRI on recovery, and publishes the release only after
package publication succeeds. No npm package, Bun runtime, Homebrew
tap/formula, curl installer, or signed binary has been published yet.

A pinned Linux CI smoke lets Bun globally install the prepared npm tarball,
then verifies that the `recurs` entry point runs through Node.js and fails when
Node is unavailable. This is package-manager compatibility, not a native Bun
runtime claim.

The CLI artifact is gated below 2.1 MB unpacked, but dependencies dominate the
installed footprint. The audited Apple-silicon source checkout used about
390 MiB for dependencies, including about 297 MiB for the Codex platform
package. See [Public alpha status](PUBLIC_ALPHA.md) for the current support and
evidence boundary.

The repository and `0.1.0-alpha.1` preview package are Apache-2.0 licensed and release-metadata ready. The one-time npm bootstrap, trusted-publisher relationship, exact release tag, and manual protected workflow remain owner-controlled; no registry package or GitHub release exists yet.

Earlier exploration is preserved in [historical research](research/README.md). It may use the old “Subagents IDE” working name or describe options that are not current commitments.
