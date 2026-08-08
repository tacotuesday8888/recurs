# Recurs Support

Recurs is pre-release software with no support SLA.

Before opening an issue:

1. check the [CLI guide](docs/CLI.md) and
   [public alpha status](docs/PUBLIC_ALPHA.md);
2. run `recurs doctor` and redact local paths or account identifiers;
3. search existing issues; and
4. reduce the problem to the smallest repository and command that reproduce it.

Use the bug report form for a reproducible defect and the feature request form
for a product gap. Include the Recurs version or commit, operating system, Node
version, install path, expected behavior, and exact verification you ran.

Never post credentials, private source code, prompts from a private repository,
full Recurs data directories, or unredacted logs. Security vulnerabilities
follow [SECURITY.md](SECURITY.md), not public support issues.

The recommended alpha path is `npm install --global recurs@alpha` on Node.js
22.22+. The same reviewed package is available through the checksum-verifying
release installer and official Homebrew tap. Bun may install it globally, but
Node remains the runtime. Source checkout is also supported. Native Bun
execution, Windows subprocess tools, signed binaries, and the desktop
experience are outside today's support boundary.

## Common local verification blockers

- A Recurs subprocess exiting 71, TypeScript diagnostics disappearing behind
  exit 71, or loopback `listen EPERM` only inside another sandboxed desktop
  host usually means Recurs's Seatbelt/Bubblewrap boundary is nested beneath a
  stricter outer sandbox. Reproduce the exact command in a normal terminal;
  do not add sleeps, retries, or disable Recurs containment.
- `UNKNOWN_CERTIFICATE_VERIFICATION_ERROR` from Bun, or TLS failures fetching
  Homebrew bottles, means the package manager could not validate this host's
  registry chain. Do not disable TLS verification. Use the CI installer lane
  or correct the host trust store/proxy configuration.
- `recurs account verify` intentionally requires a user-present local terminal.
  Run it interactively; headless refusal is not an account failure.
