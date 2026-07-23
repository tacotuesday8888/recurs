# Contributing to Recurs

Recurs is an early alpha with a security-sensitive execution core. Contributions
are welcome when they make one boundary clearer, safer, or easier to verify.

## Before starting

1. Read the [public alpha status](docs/PUBLIC_ALPHA.md) and
   [feature inventory](docs/FEATURE_STATUS.md).
2. Search existing issues and pull requests.
3. Open a feature request before a broad architectural change. Small fixes and
   documentation corrections can go directly to a pull request.

Do not put credentials, private repository content, exploit details, or
personal data in an issue or pull request. Follow [SECURITY.md](SECURITY.md)
for vulnerabilities.

## Develop

Requirements are Node.js 22.22+, Git 2.45+, and ripgrep. Linux subprocess tests
also require Bubblewrap.

```bash
npm ci
npm run check
npm run package:smoke-install
```

Keep changes focused and follow existing package boundaries. Behavioral changes
should include a focused test when practical. Update current documentation when
a capability, command, security boundary, or release claim changes.

Generated files say which script owns them. Change the source and regenerate;
do not edit generated output alone.

## Pull requests

A useful pull request explains:

- the problem and why it belongs in Recurs;
- the smallest chosen solution;
- the relevant safety or compatibility boundary;
- the exact verification run; and
- anything intentionally left for later.

Before submitting, inspect the diff, make sure it contains no secrets or local
machine paths, and run the strongest relevant checks. A pull request should be
reviewable as one coherent change; unrelated cleanup belongs elsewhere.

By contributing, you agree that your contribution is licensed under the
repository's [Apache License 2.0](LICENSE).
