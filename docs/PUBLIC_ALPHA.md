# Public alpha status

Source version: **0.1.0-alpha.10 release candidate**. The September 9, 2026
registry check found npm `alpha` at alpha.7 and `latest` at alpha.2. Prior docs
calling alpha.8 public were incorrect. Consult the [release record](RELEASE_READINESS.md)
for the exact source, packaged artifact, merged state and publication outcome.

## Supported paths

Use `npm install --global recurs@alpha` on macOS or Linux with Node.js 22.22+,
Git and ripgrep. Linux subprocess isolation requires Bubblewrap. Bun can install
the same npm archive but Node runs the CLI. The release pipeline also prepares
a checksum-verifying curl installer and Homebrew formula from those exact bytes.

A normal installation does not download Codex or Copilot. Their supported
vendor runtimes are supplied separately. See the [provider matrix](PROVIDER_CAPABILITY_MATRIX.md)
and [CLI guide](CLI.md).

## What this candidate changes

Quick coding startup, reviewable project onboarding, a conventional terminal,
a durable execution inventory, exact agent inspection/cancellation, standard
HTTP/OAuth MCP and practical skill installation. Core permission ceilings,
versioned sessions, isolated implementation, review/repair and explicit apply
remain in place. The [feature inventory](FEATURE_STATUS.md) describes precise
capabilities and boundaries.

Validation includes independent tests, isolated local protocol fixtures and
real PTY journeys against a packed installation. Deterministic fixtures prove
harness behavior, not model quality. Live evaluation evidence and exact
artifact measurements are linked from the release record.

## Boundaries

- Public alpha: expect changes; retain important source in Git.
- No persistent daemon, hosted worker, autonomous deployment or Windows sandbox.
- Vendor internals can be unavailable. The UI labels those gaps, unknown owners
  and unreported cost explicitly.
- Child transcripts support exact cancellation of owned work; targeted child
  steering is unavailable. Send follow-up instructions to the parent.
- MCP and skills use explicit scope/trust and permission boundaries. Compatibility
  does not mean every third-party integration has been tested.
- Larger teams and particular model lineups have no demonstrated universal
  advantage. Auto selection stays evidence-gated.

[Security](../SECURITY.md) · [Privacy](../PRIVACY.md) · [Contributing](../CONTRIBUTING.md)
