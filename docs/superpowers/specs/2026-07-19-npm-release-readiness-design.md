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
- `THIRD_PARTY_NOTICES.md`

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
- `npm pack --dry-run` reports only the five allowlisted files.

`npm run package:smoke-install` creates a package archive, installs it with
scripts disabled into a new temporary prefix and private home, then invokes
the installed `recurs` binary for help and an empty JSON account list. It also
configures a deterministic loopback model which requests `read_file`, proves
the installed agent executes that guarded tool, returns its result to the
model, and completes the turn through normalized JSONL events. CI runs this
after the full TypeScript check. This proves package assembly, dependency
installation, bin linking, module resolution, process startup, fresh-state
behavior, local-provider transport, and the core tool loop without touching
user configuration.

## Publication gate

The package stays at version `0.0.0`, has `private: true`, and declares
`UNLICENSED`. npm therefore cannot publish it accidentally. Reviewed notices
for all exact direct runtime dependencies are now included in the artifact.
Public preview release work must deliberately:

1. add the owner-selected project license;
2. make the source repository public so npm provenance can be generated;
3. choose a real semantic preview version;
4. change the package license field, package the license, remove the private
   gate, and add exact public npm registry metadata;
5. configure the `npm` protected GitHub environment and the package's trusted
   publisher relationship to `.github/workflows/publish-npm.yml`; and
6. dispatch that workflow from the exact `vVERSION` tag.

The prepared workflow uses GitHub-hosted OIDC, rejects long-lived npm tokens,
requires a public repository and a tag commit reachable from `main`, reruns the
Linux and package verification boundary, and relies on npm trusted publishing
for automatic provenance. `scripts/check-npm-release.mjs` keeps it inert until
all owner-controlled metadata is complete and mutually consistent.

Homebrew and curl distribution remain separate because their intended macOS
artifact must include a signed/notarized native bundle and installed-artifact
security tests rather than this source/npm CLI alone.
