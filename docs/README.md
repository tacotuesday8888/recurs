# Recurs Documentation

Current documents:

- [CLI guide](CLI.md) — commands, permissions, storage, output, and limits.
- [Security policy](../SECURITY.md) — current support boundary, private reporting expectations, and credential-canary rules.
- [Base engine comparison](BASE_ENGINE_COMPARISON.md) — evidence from Kilo Code, OpenCode, and Codex and the resulting hardening decisions.
- [Architecture](../ARCHITECTURE.md) — implemented package boundaries and engine lifecycle.
- [Product direction](../PRODUCT.md) — CLI-first agent manager and sub-agent roadmap.

Reviewed specifications and implementation plans:

- [Core v0 design](superpowers/specs/2026-07-10-recurs-core-v0-design.md) — implemented single-agent foundation.
- [Provider, authentication, and onboarding design](superpowers/specs/2026-07-10-recurs-provider-auth-design.md) — reviewed umbrella design; Slice 0 and the TypeScript safety precursor are implemented, while the native authority boundary and later provider/runtime slices remain.
- [Base harness hardening plan](superpowers/plans/2026-07-10-recurs-base-harness-hardening.md).
- [Provider foundation Slice 0 plan](superpowers/plans/2026-07-10-recurs-provider-foundation-slice-0.md).
- [Tool safety foundation plan](superpowers/plans/2026-07-11-recurs-host-safety-foundation.md) — unified credential exclusions, checkpoint format gating, clean child state, tool profiles, and sanitized failures.

## Release status

Recurs is currently source-installable with npm and runs on Node.js; no npm package, Bun runtime, Homebrew formula, curl installer, or signed binary has been published. npm is the likely first preview channel. Bun may later install the npm package while Node remains the runtime; Homebrew and curl wait for versioned signed artifacts.

The repository is intended to become open source but has no license yet. It must be described as source-available, not legally open source, until the owner selects and adds a license.

Earlier exploration is preserved in [historical research](research/README.md). It may use the old “Subagents IDE” working name or describe options that are not current commitments.
