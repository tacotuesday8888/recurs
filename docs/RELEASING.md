# Releasing Recurs

Recurs is Apache-2.0 licensed. `0.1.0-alpha.2` is the first portable npm
artifact prepared for public release after the original `alpha.1` workflow
failed closed before packaging. It completed the one-time package bootstrap;
`0.1.0-alpha.3` then failed closed after attestation when npm 12 interpreted a
relative package path as a Git shorthand. `0.1.0-alpha.4` is the first
subsequent trusted-publisher release. Publishing is an owner-controlled
operation, not a normal development or CI side effect.

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
Its package gate caps the unpacked artifact at 2.1 MB; that is not the installed
footprint. npm resolves runtime dependencies separately, but Codex is not a
default runtime dependency. The exact `0.1.0-alpha.2` artifact measured 433 KiB
compressed / 1.87 MiB unpacked and about 38.8 MiB in a clean Apple-silicon
production prefix on 2026-07-30. The source-development tree was about 402 MiB because it
retains roughly 307 MiB of pinned Codex compatibility fixtures. Record a clean
installed-prefix measurement for every release candidate and disclose it in
release notes.

The Bun compatibility gate is similarly narrow: the pinned Linux lane globally
installs this npm tarball, preserves its Node shebang, launches it through
Node.js, and verifies that it fails without Node. Release notes may document
Bun as an alternative global installer only; they must not imply native Bun
execution, `bun run` support, or untested version/platform coverage.

## Deferred distribution limitation

The prepared npm, curl, and Homebrew installation surfaces are not independent
distribution paths yet. The curl installer invokes npm, and the generated
Homebrew formula installs the same npm tarball with Node as a runtime
dependency. This is acceptable during the alpha, but it must not be presented
as three distinct delivery architectures.

For each public release, recheck this dependency chain and keep only
distribution surfaces that add real value beyond the npm artifact.

## Completed one-time npm bootstrap

npm requires a package to exist before a trusted publisher can be configured.
The first `recurs` publication therefore used the narrow sequence below; later
versions must not repeat the interactive publishing exception:

1. Configure a protected GitHub environment named `npm`, with required manual
   approval, and protect the intended `v0.1.0-alpha.2` tag.
2. Tag the reviewed commit and manually dispatch
   `.github/workflows/publish-npm.yml` from that exact tag. On the first run,
   verification, packaging, the draft GitHub release, and GitHub attestations
   complete before the workflow stops with its explicit first-package bootstrap
   requirement. Do not publish the draft release.
3. Download the exact `recurs-0.1.0-alpha.2.tgz` draft asset and verify its
   GitHub attestation and `SHA256SUMS` entry. Use an interactive npm account
   session with 2FA to publish that exact archive once. Because a local shell
   cannot produce npm CI provenance, explicitly override the package setting
   only for this bootstrap command:

   ```bash
   npm publish ./recurs-0.1.0-alpha.2.tgz --access public --provenance=false
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
installer and Homebrew formula from it, drafts and attests all assets,
publishes or verifies the same npm bytes, and makes the GitHub release public
only after npm succeeds. While Recurs uses prerelease versions, the workflow
marks the GitHub release as a prerelease and explicitly leaves the `latest`
label unset; promoting a stable version requires an intentional policy change.
After publication, update
`tacotuesday8888/homebrew-recurs/Formula/recurs.rb` so its package URL and
SHA-256 exactly match the attested release formula, review any platform
dependency metadata separately, open a tap pull request, and merge it only
after its formula install and test workflow passes. The tap is intentionally a
separate repository so `brew install tacotuesday8888/recurs/recurs` does not
clone the full Recurs source history.
