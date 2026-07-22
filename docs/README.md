# Recurs Documentation

Current documents:

- [Feature status](FEATURE_STATUS.md) — concise code-backed inventory of what is implemented, bounded, prepared-only, and absent.
- [CLI guide](CLI.md) — local and Codex setup, provider/account commands, permissions, storage, output, and limits.
- [Security policy](../SECURITY.md) — current support boundary, private reporting expectations, and credential-canary rules.
- [Release runbook](RELEASING.md) — verified artifact boundary, one-time npm bootstrap, trusted publishing, and later preview releases.
- [Base engine comparison](BASE_ENGINE_COMPARISON.md) — evidence from Kilo Code, OpenCode, and Codex and the resulting hardening decisions.
- [Sub-agent harness comparison](research/SUBAGENT_HARNESS_COMPARISON.md) — commit-pinned primary-source execution patterns from Codex, OpenCode, Kimi Code, Kilo Code, Roo Code, Pi, Goose, and Grok Build, plus the exact Recurs boundary derived from them.
- [Agent company onboarding](AGENT_COMPANY_ONBOARDING.md) — canonical product target for turning project intent into a tailored, durable agent company, including the implemented foundation and remaining gaps.
- [Company evaluation](COMPANY_EVALUATION.md) — deterministic offline and explicit configured-provider checks for the restricted formation path.
- [Architecture](../ARCHITECTURE.md) — implemented package boundaries and direct/delegated engine lifecycle.
- [Product direction](../PRODUCT.md) — CLI-first agent manager and sub-agent roadmap.

Reviewed specifications and implementation plans follow. These dated files are
design and delivery records; unchecked historical steps are not a live backlog.
Use [Feature status](FEATURE_STATUS.md), the CLI guide, and the architecture for
current product truth.

- [Core v0 design](superpowers/specs/2026-07-10-recurs-core-v0-design.md) — implemented single-agent foundation.
- [Provider, authentication, and onboarding design](superpowers/specs/2026-07-10-recurs-provider-auth-design.md) — reviewed umbrella design; contracts, its original 25-path catalog plus the reviewed xAI API path, non-secret registry, local setup, official Codex delegated path, and private native OpenAI/Anthropic/Kimi direct-provider verticals are implemented. Persistent credential-bearing setup remains production-signed-macOS-only and is not yet distributed; source/npm environment BYOK is the documented weaker path.
- [Saved public BYOK design](superpowers/specs/2026-07-19-saved-public-byok-design.md) — reviewed fixed-origin Chat/Anthropic providers, authenticated Anthropic model discovery, environment-reference setup, non-secret persistence, billing acknowledgement, immutable pins, and fail-closed runtime binding.
- [npm release-readiness design](superpowers/specs/2026-07-19-npm-release-readiness-design.md) — single-file Recurs bundle, exact runtime dependencies, minimal tarball allowlist, empty-prefix install smoke, hash-pinned Apache-2.0 preview metadata, and a protected publication gate. The implementation also derives checksum-bound curl and Homebrew assets plus GitHub attestations from the same exact tarball.
- [Provider Activation v1 design](superpowers/specs/2026-07-13-provider-activation-v1-design.md), [native-authority foundation plan](superpowers/plans/2026-07-13-native-provider-authority.md), and [native provider-binding plan](superpowers/plans/2026-07-13-native-provider-binding.md) — approved CLI-only architecture and implemented Keychain/recovery, exact-peer, lifecycle XPC, route-reservation, model-catalog, strict streaming, onboarding, and runtime assembly for OpenAI API, Anthropic API, and Kimi Code. The explicit public-HTTPS custom profile and installed-artifact production smoke remain outstanding.
- [Broker credential-state contract](superpowers/specs/2026-07-13-broker-credential-state-contract.md) and [broker journal contract](superpowers/specs/2026-07-13-broker-journal-contract.md) — reviewed native generation, fencing, reservation, crash-journal, recovery, and authoritative-projection invariants.
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

Recurs is currently source-installable with npm and runs on Node.js. The repository builds and verifies a minimal npm artifact, includes reviewed direct-runtime dependency notices, installs it into an empty temporary prefix in CI, and proves the installed binary's redacted readiness report can launch the real OS sandbox. It also carries a manual fail-closed OIDC release workflow. That workflow derives a checksum-verifying user-local installer and Homebrew formula from the exact npm tarball, drafts and attests the GitHub assets, verifies npm SRI on recovery, and publishes the release only after package publication succeeds. No npm package, Bun runtime, Homebrew tap/formula, curl installer, or signed binary has been published yet.

The repository and `0.1.0-alpha.1` preview package are Apache-2.0 licensed and release-metadata ready. The one-time npm bootstrap, trusted-publisher relationship, exact release tag, and manual protected workflow remain owner-controlled; no registry package or GitHub release exists yet.

Earlier exploration is preserved in [historical research](research/README.md). It may use the old “Subagents IDE” working name or describe options that are not current commitments.
