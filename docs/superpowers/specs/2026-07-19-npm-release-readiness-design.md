# npm Release-Readiness Design

## Status

Implemented as a pre-publication boundary. No npm package is published and the
repository remains source-available because the owner has not selected a
license.

## Goal

Prove that the public Recurs CLI can be delivered as a normal npm command
without publishing private workspace packages, shipping the repository, or
claiming that the signed native credential authority is included.

## Artifact boundary

`npm run build` compiles the workspaces and builds `dist/cli/main.js` from the
public CLI source. Rolldown resolves only `@recurs/*` imports to their reviewed
workspace source and emits one ESM executable. Node built-ins and these exact
runtime packages remain external:

- `@agentclientprotocol/codex-acp` 1.1.2
- `@agentclientprotocol/sdk` 1.2.1
- `@openai/codex` 0.144.0
- `yaml` 2.9.0
- `zod` 4.4.3

Keeping third-party packages external preserves their package boundaries and
licenses and lets the Codex runtime resolve its platform artifact normally.
The bundle retains legal comments, has no source map, and is replaced through
one temporary file rather than exposing a partial build.

The npm tarball allowlist is exactly:

- `dist/cli/main.js`
- `package.json`
- `README.md`
- `SECURITY.md`

It excludes TypeScript source, tests, research, native source and resources,
local state, worktrees, and development configuration. The public npm artifact
therefore supplies source/npm provider paths only. It does not contain the
production-signed macOS launcher, broker, Keychain authority, or native
provider activation.

## Verification

`npm run package:check` fails unless:

- package name, binary path, exact dependencies, and license gate match;
- the bundle retains its shebang and executable mode;
- no private `@recurs/*` import or absolute build-machine path remains;
- the bundle and package stay within explicit size ceilings; and
- `npm pack --dry-run` reports only the four allowlisted files.

`npm run package:smoke-install` creates a package archive, installs it with
scripts disabled into a new temporary prefix and private home, then invokes
the installed `recurs` binary for help and an empty JSON account list. CI runs
this after the full TypeScript check. This proves package assembly, dependency
installation, bin linking, module resolution, process startup, and fresh-state
behavior without touching user configuration.

## Publication gate

The package stays at version `0.0.0`, has `private: true`, and declares
`UNLICENSED`. npm therefore cannot publish it accidentally. Public preview
release work must deliberately:

1. add the owner-selected project license;
2. complete and ship third-party notices;
3. choose a real semantic preview version and release/tag policy;
4. change the package license field and remove the private gate;
5. verify provenance and package signatures in release CI; and
6. publish from a protected GitHub environment with no long-lived npm token.

Homebrew and curl distribution remain separate because their intended macOS
artifact must include a signed/notarized native bundle and installed-artifact
security tests rather than this source/npm CLI alone.
