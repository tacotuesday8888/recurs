# Recurs Documentation

Current documents:

- [CLI guide](CLI.md) — local and Codex setup, provider/account commands, permissions, storage, output, and limits.
- [Security policy](../SECURITY.md) — current support boundary, private reporting expectations, and credential-canary rules.
- [Base engine comparison](BASE_ENGINE_COMPARISON.md) — evidence from Kilo Code, OpenCode, and Codex and the resulting hardening decisions.
- [Sub-agent harness comparison](research/SUBAGENT_HARNESS_COMPARISON.md) — primary-source execution patterns from mature harnesses and the exact Recurs boundary derived from them.
- [Architecture](../ARCHITECTURE.md) — implemented package boundaries and direct/delegated engine lifecycle.
- [Product direction](../PRODUCT.md) — CLI-first agent manager and sub-agent roadmap.

Reviewed specifications and implementation plans:

- [Core v0 design](superpowers/specs/2026-07-10-recurs-core-v0-design.md) — implemented single-agent foundation.
- [Provider, authentication, and onboarding design](superpowers/specs/2026-07-10-recurs-provider-auth-design.md) — reviewed umbrella design; contracts, the 25-path catalog, non-secret registry, local setup, official Codex delegated path, and private native OpenAI/Anthropic/Kimi direct-provider verticals are implemented. Credential-bearing setup remains production-signed-macOS-only and is not yet distributed.
- [Provider Activation v1 design](superpowers/specs/2026-07-13-provider-activation-v1-design.md), [native-authority foundation plan](superpowers/plans/2026-07-13-native-provider-authority.md), and [native provider-binding plan](superpowers/plans/2026-07-13-native-provider-binding.md) — approved CLI-only architecture and implemented Keychain/recovery, exact-peer, lifecycle XPC, route-reservation, model-catalog, strict streaming, onboarding, and runtime assembly for OpenAI API, Anthropic API, and Kimi Code. The explicit public-HTTPS custom profile and installed-artifact production smoke remain outstanding.
- [Broker credential-state contract](superpowers/specs/2026-07-13-broker-credential-state-contract.md) and [broker journal contract](superpowers/specs/2026-07-13-broker-journal-contract.md) — reviewed native generation, fencing, reservation, crash-journal, recovery, and authoritative-projection invariants.
- [Provider authentication matrix design](superpowers/specs/2026-07-11-provider-auth-matrix-design.md) and [implementation plan](superpowers/plans/2026-07-11-provider-auth-matrix.md) — exact catalog and first delegated-runtime slice.
- [Non-secret connection lifecycle design](superpowers/specs/2026-07-12-connection-lifecycle-design.md) and [implementation plan](superpowers/plans/2026-07-12-connection-lifecycle.md) — exact account management and immutable-pin routing for current runnable connections.
- [Base harness hardening plan](superpowers/plans/2026-07-10-recurs-base-harness-hardening.md).
- [Provider foundation Slice 0 plan](superpowers/plans/2026-07-10-recurs-provider-foundation-slice-0.md).
- [Tool safety foundation plan](superpowers/plans/2026-07-11-recurs-host-safety-foundation.md) — unified credential exclusions, checkpoint format gating, clean child state, tool profiles, and sanitized failures.
- [Recurs-owned child-agent plan](superpowers/plans/2026-07-17-recurs-owned-subagent-vertical.md), [multi-profile plan](superpowers/plans/2026-07-17-multi-approach-orchestration.md), and [parallel analysis/review plan](superpowers/plans/2026-07-17-parallel-analysis-fanout.md) — durable parent/child state, exact profiles, shared budgets, versioned operating modes, isolated Git worktrees, and bounded foreground fan-out.

## Release status

Recurs is currently source-installable with npm and runs on Node.js; no npm package, Bun runtime, Homebrew formula, curl installer, or signed binary has been published. npm is the likely first preview channel. Bun may later install the npm package while Node remains the runtime; Homebrew and curl wait for versioned signed artifacts.

The repository is intended to become open source but has no license yet. It must be described as source-available, not legally open source, until the owner selects and adds a license.

Earlier exploration is preserved in [historical research](research/README.md). It may use the old “Subagents IDE” working name or describe options that are not current commitments.
