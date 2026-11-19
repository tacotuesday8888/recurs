# Public alpha status

**The source candidate is `0.1.0-alpha.12`.** It adds direct chat reopening,
search across active and archived chats, and a guided first session with a local
model. Its new review window covers nine hosted routes and two local runtimes
from November 18, 2026 until February 18, 2027 at 00:00 UTC. Eight hosted
routes remain closed. The provider review used public documentation and made
no authenticated requests. [Provider review](research/provider-review-2026-11.md)
· [Changelog](../CHANGELOG.md)

**The published preview is `0.1.0-alpha.11`.** npm `alpha` selects
`0.1.0-alpha.11` and `latest` selects `0.1.0-alpha.2` (verified November 18,
2026). The
[GitHub prerelease](https://github.com/tacotuesday8888/recurs/releases/tag/v0.1.0-alpha.11)
contains the attested package, installer, formula, and checksums. See the
[product polish release record](PRODUCT_POLISH.md) for exact source, integrity,
platform checks, comparisons and public installation evidence. Previous release
evidence remains in [the historical release record](RELEASE_READINESS.md).

## Supported paths

Use `npm install --global recurs@alpha` on macOS or Linux with Node.js 22.22+,
Git and ripgrep. Linux subprocess isolation requires Bubblewrap. Bun can install
the same npm archive but Node runs the CLI. The published release includes
a checksum-verifying curl installer and Homebrew formula from those exact bytes.
The Homebrew tap update passed its install/test gate and is merged.

For alpha.11, start an Ollama or LM Studio server with a tool-capable model.
Alpha.11’s hosted reviews expired in October 2026. A normal installation does
not download Codex or Copilot. Their supported
vendor runtimes are supplied separately. See the [provider matrix](PROVIDER_CAPABILITY_MATRIX.md)
and [CLI guide](CLI.md).

## What shipped in alpha.11

Persistent terminal themes and custom colors, an interactive saved-model picker,
explicit specialist route previews, clearer team-limit editing, new-chat model
preservation, and accurate configured-versus-actual execution views. Existing
HTTP/OAuth MCP, skills, permission ceilings, isolated implementation, review/repair
and explicit apply remain in place. The [feature inventory](FEATURE_STATUS.md)
describes precise capabilities and boundaries.

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
