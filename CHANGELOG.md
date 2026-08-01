# Changelog

Notable user-facing changes are recorded here when they ship.

## 0.1.0-alpha.5 - 2026-08-01

### Added

- `recurs data path` reports the active durable-data directory without reading
  or deleting it, with a stable JSON form for scripts.
- Interactive slash-command completion includes canonical commands, aliases,
  and the local image-staging command.
- A concise privacy and local-data policy plus channel-specific upgrade,
  uninstall, retention, and deletion guidance.

### Changed

- The GitHub and terminal wordmarks now share a centered, forward-slanted
  pixel identity while operational output remains left-aligned.
- Public documentation reflects the shipped npm, curl-installer, Homebrew, and
  Bun-as-installer paths and distinguishes all of them from the Node runtime.
- Release checks now reject stale current-version and distribution claims.

## 0.1.0-alpha.4 - 2026-07-30

### Fixed

- Release recovery now accepts the exact scalar JSON emitted by npm 11 and the
  one-element array emitted by npm 12 while rejecting ambiguous registry
  responses.
- Trusted publication uses an explicit filesystem package path so npm 12
  cannot interpret the release directory as a Git dependency shorthand.

### Security

- Subsequent npm releases use the repository-bound trusted publisher with
  provenance. Traditional token publishing is disabled for the package.

## 0.1.0-alpha.2 - 2026-07-30

### Added

- Source-installable coding-agent CLI with durable sessions, permissions,
  provider routes, bounded sub-agents, isolated implementation, independent
  review, repair, recovery, and explicit apply.
- Tailored company onboarding, versioned operating modes, company-goal
  execution, evidence-backed model-team selection, and deterministic plus
  configured-provider evaluation.
- Prepared npm, checksum-verifying curl, and Homebrew release assets derived
  from one exact package archive.
- Pinned Linux compatibility smoke for installing that npm archive globally
  with Bun while retaining Node.js as the runtime.

### Known limitations

- There is no Homebrew tap, signed binary, native Bun runtime, Windows
  subprocess containment, or desktop app.
- One live comparison pair per built-in scenario is not enough evidence to
  recommend a universal default model lineup.

See [Public Alpha Status](docs/PUBLIC_ALPHA.md) for the current evidence and
release boundary.
