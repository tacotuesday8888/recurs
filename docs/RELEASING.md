# Releasing Recurs

Recurs is Apache-2.0 licensed and its `0.1.0-alpha.1` portable npm artifact is
release-metadata ready. No npm package, GitHub release, curl installer, or
Homebrew formula is public yet. Publishing is an owner-controlled operation,
not a normal development or CI side effect.

## Verified artifact

Run these gates from a clean checkout of the exact commit that will be tagged:

```bash
npm ci
npm run check
npm run package:smoke-install
```

The package gate permits exactly `dist/cli/main.js`, `package.json`, `LICENSE`,
`README.md`, `SECURITY.md`, and `THIRD_PARTY_NOTICES.md`. It pins the official
Apache-2.0 license bytes, exact runtime dependencies, public npm registry,
provenance setting, package size, executable mode, and absence of workspace or
build-machine paths. The installed-artifact smoke runs the real CLI, local
provider loop, OS workspace sandbox, Agent Skills, stdio MCP, and ACP server
from a new temporary prefix.

The portable npm artifact contains the same TypeScript runtime verified in CI.

## Deferred distribution limitation

The prepared npm, curl, and Homebrew installation surfaces are not independent
distribution paths yet. The curl installer invokes npm, and the generated
Homebrew formula installs the same npm tarball with Node as a runtime
dependency. This is acceptable while Recurs remains unreleased, but it must not
be presented as three distinct delivery architectures.

Before a public release, revisit the intended installation experience and keep
only distribution surfaces that add real value beyond the npm artifact.

## One-time npm bootstrap

npm requires a package to exist before a trusted publisher can be configured.
Therefore the first `recurs` publication cannot use the final tokenless OIDC
relationship. Keep this exception narrow:

1. Configure a protected GitHub environment named `npm`, with required manual
   approval, and protect the intended `v0.1.0-alpha.1` tag.
2. Tag the reviewed commit and manually dispatch
   `.github/workflows/publish-npm.yml` from that exact tag. On the first run,
   verification, packaging, the draft GitHub release, and GitHub attestations
   complete before the workflow stops with its explicit first-package bootstrap
   requirement. Do not publish the draft release.
3. Download the exact `recurs-0.1.0-alpha.1.tgz` draft asset and verify its
   GitHub attestation and `SHA256SUMS` entry. Use an interactive npm account
   session with 2FA to publish that exact archive once. Because a local shell
   cannot produce npm CI provenance, explicitly override the package setting
   only for this bootstrap command:

   ```bash
   npm publish ./recurs-0.1.0-alpha.1.tgz --access public --provenance=false
   ```

4. Immediately configure the package's GitHub Actions trusted publisher for
   owner `tacotuesday8888`, repository `recurs`, workflow
   `publish-npm.yml`, environment `npm`, and `npm publish` permission. npm 12
   can express the same binding after interactive authentication:

   ```bash
   npm trust github recurs \
     --repo tacotuesday8888/recurs \
     --file publish-npm.yml \
     --env npm \
     --allow-publish
   ```

5. In npm package settings, require 2FA and disallow traditional token
   publishing. Do not create or store an automation token.
6. Rerun the exact tagged workflow. It verifies that npm's published SHA-512
   integrity equals the already attested archive, then publishes the GitHub
   release. A mismatch fails closed.

The bootstrap version will not carry npm's own provenance attestation; its
GitHub artifact attestation and exact integrity recovery remain verifiable.
Every later version is published by the trusted OIDC workflow and receives npm
provenance automatically.

## Later previews

For later releases, update the root package and lockfile to one new semantic
version, merge only after the normal checks pass, create the exact matching
`vVERSION` tag on `main`, and manually dispatch the protected workflow from
that tag. The workflow rejects a tag/version mismatch, a commit not reachable
from `main`, a private repository, the wrong workflow identity, disabled
provenance, or any long-lived npm token.

The workflow creates the npm tarball once, derives the checksummed user-local
installer and standalone Homebrew formula from it, drafts and attests all
assets, publishes or verifies the same npm bytes, and makes the GitHub release
public only after npm succeeds. A dedicated Homebrew tap remains a separate
post-release step.
