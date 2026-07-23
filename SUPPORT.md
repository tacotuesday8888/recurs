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

The current supported alpha path is a source checkout with npm on Node.js
22.22+. The prepared package can be globally installed by the pinned Bun
compatibility lane, but it still requires Node and cannot be obtained from the
registry yet. Native Bun execution, Windows subprocess tools, signed binaries,
and the desktop experience are outside today's support boundary.
