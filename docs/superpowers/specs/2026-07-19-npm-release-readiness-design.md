# npm Release-Readiness Design

## Status

Implemented as a release-ready pre-publication boundary. The repository and
preview package are Apache-2.0 licensed, but no npm package or GitHub release
has been published.

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
- `LICENSE`
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
- `npm pack --dry-run` reports only the six allowlisted files.

`npm run package:smoke-install` creates a package archive, installs it with
scripts disabled into a new temporary prefix and private home, then invokes
the installed `recurs` binary for help and an empty JSON account list. It also
configures a deterministic loopback model which requests `run_command` and
`read_file`, proves the installed agent permits a workspace write while denying
an attempted parent-directory write, returns the workspace result to the model,
and completes the turn through normalized JSONL events. CI runs this after the
full TypeScript check. This proves package assembly, dependency installation,
bin linking, module resolution, process startup, fresh-state behavior,
local-provider transport, explicit headless permission pinning, the macOS/Linux
command sandbox, and the core tool loop without touching user configuration.

## Publication gate

The package is versioned `0.1.0-alpha.1`, declares Apache-2.0, packages the
official hash-pinned license text, and carries exact public-registry metadata
with provenance enabled. Reviewed notices for all exact direct runtime
dependencies are included in the artifact. Public preview release work must
still deliberately:

1. create the first package through the narrow interactive bootstrap documented
   in `docs/RELEASING.md`, because npm requires a package to exist before a
   trusted publisher can be configured;
2. configure the `npm` protected GitHub environment and the package's trusted
   publisher relationship to `.github/workflows/publish-npm.yml`; and
3. dispatch that workflow from the exact `vVERSION` tag reachable from `main`.

The prepared workflow uses GitHub-hosted OIDC, rejects long-lived npm tokens,
requires a public repository and a tag commit reachable from `main`, reruns the
Linux and package verification boundary, and relies on npm trusted publishing
for automatic provenance. `scripts/check-npm-release.mjs` keeps it inert until
all owner-controlled metadata is complete and mutually consistent.

The generated curl installer and standalone Homebrew formula intentionally
install this same portable source/npm artifact. A future native distribution
is a separate signed/notarized artifact with its own installed security tests.
