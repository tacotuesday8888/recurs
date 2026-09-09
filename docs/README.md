# Recurs Documentation

Source `0.1.0-alpha.10` release candidate. Current documents:

- [Release readiness](RELEASE_READINESS.md) — current implementation and verification record.
- [MCP](MCP.md) — local and remote servers, trust, authentication and troubleshooting.
- [Agent Skills](SKILLS.md) — installation, explicit use, scope and permissions.
- [Current ecosystem decisions](research/release-readiness-ecosystem-2026-09.md) — primary-source comparison and reuse decisions.

- [Public alpha status](PUBLIC_ALPHA.md) — one-page installation,
  distribution, evidence, and remaining-risk summary.
- [Alpha.7 active-use release candidate](ACTIVE_USE_RELEASE_CANDIDATE.md) —
  preserved artifact journey, live Codex dogfood, provider, dependency, and
  distribution verification evidence.
- [Alpha.8 review integrity](research/2026-08-10-RECURS-REVIEW-INTEGRITY-ALPHA8.md)
  — root-cause evidence, explicit routing change, and bounded live proof.
- [Feature status](FEATURE_STATUS.md) — concise code-backed inventory of what is implemented, bounded, prepared-only, and absent.
- [CLI guide](CLI.md) — local and Codex setup, provider/account commands, permissions, storage, output, and limits.
- [Security policy](../SECURITY.md) — current support boundary, private reporting expectations, and credential-canary rules.
- [Privacy and local data](../PRIVACY.md) — provider data flow, local storage, telemetry boundary, retention, and deletion.
- [Release runbook](RELEASING.md) — verified artifact boundary, one-time npm bootstrap, trusted publishing, and later preview releases.
- [Base engine comparison](BASE_ENGINE_COMPARISON.md) — source evidence from
  leading coding-agent and adjacent agent engines and the resulting hardening
  decisions.
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
The [design and delivery archive guide](superpowers/README.md) defines their
authority. Use [Feature status](FEATURE_STATUS.md), the CLI guide, and the
architecture for current product truth.

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

Source `0.1.0-alpha.10` is the current release candidate. At preflight, npm
`alpha` selects alpha.7 and `latest` selects alpha.2. Publication requires the
protected trusted-publisher workflow; see [current evidence](RELEASE_READINESS.md).

Recurs runs on Node.js and distributes one npm artifact. The checksum-verifying
curl installer and official Homebrew tap install that same artifact. Bun is
verified as an installer on the pinned Linux lane; it does not replace Node.js.
There is no signed standalone binary or desktop application.

The CLI artifact is gated below 2.1 MB unpacked. Final package size and installed
footprint belong to the exact artifact in the release record, not the source
tree containing Codex test fixtures. The repository is Apache-2.0 licensed;
runtime dependency licenses are listed in the third-party notices.

Earlier exploration is preserved in [historical research](research/README.md).
It may use the old “Subagents IDE” name or describe superseded commitments.
