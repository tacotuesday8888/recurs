# Security Policy

Recurs is pre-release software at version `0.0.0`. The Recurs TypeScript process
does not accept, import, expose, or store provider credential bytes, and it must
not be used as a credential-safe sandbox. The current safeguards reduce
accidental disclosure through built-in tools, checkpoints, child environments,
and error messages; arbitrary commands still run with the user's host
filesystem, network, IPC, and process authority.

The repository includes a macOS 14.4+ native process boundary and complete
private OpenAI API, Anthropic API, and Kimi Code activation/generation
verticals. It has tested Data Protection Keychain, credential-state/journal
recovery, exact-peer identity, private lifecycle and generation XPC, bounded
native frames, fixed signed-bundle path validation, exact child lifecycle,
foreground terminal capture, strict provider codecs, and redacted diagnostics.
Production broker startup validates the exact launcher signing requirement and
Keychain configuration, completely recovers one credential authority, and only
then activates its listener. The production-gated launcher directly spawns only
its fixed sealed Node engine over an anonymous descriptor-3 socket and reaps the
exact child. The public npm/source CLI deletes an injected native marker and
writes zero bytes to that descriptor. Source, unsigned, and ad-hoc launchers
cannot select an engine through `PATH`, cwd, environment, or arguments and fail
the private engine path closed.

The native credential journal is now schema v2. Every record authenticates one
exact provider/profile binding; a custom binding also authenticates canonical
host, port, base path, and model-catalog behavior. Native component `0.2.0`
carries the same identity through bounded non-secret private stage metadata,
while replies, TypeScript, and descriptor 3 remain free of that authority.
The broker owns opaque setup/run/maintenance route capabilities.
It derives and rechecks exact authenticated binding plus candidate or usable-
ready generation state, reserves only that matching Keychain generation, and
debits scope, cancellation, expiry, and checked budgets only after one final
authoritative recheck. Pre-authorization failures clean up without a debit; a
returned one-use reservation is conservatively charged exactly once. Exact
provider transports consume those reservations inside the broker; reusable
request authority never enters the TypeScript process.
Schema-v1 journals fail closed with no inferred or in-place migration because
no credential-bearing artifact has shipped; development users reset the
unpublished journal and reconnect.

The signed-path executable performs bounded no-echo foreground capture,
provider-verified model discovery, and crash-safe Keychain/non-secret-registry
commit. One coordinator owns launcher termination signals and capture-only
suspension handling; controlling-PTY tests prove exact restoration and no input
echo across interrupt, termination, hangup, and suspend/resume. Owned and
transient secret buffers are erased on every tested outcome; no reusable secret
enters Node, descriptor 3, arguments, environment, configuration, or logs.
Broker-owned streaming uses OpenAI Responses, Anthropic Messages, or Kimi's
OpenAI Chat Completions profile with bounded strict parsing, header/body
credential-echo filtering, redirect and alternate-auth rejection, request-
scoped cancellation, normalized usage, and macOS system proxy/root policy.
OpenAI continuation state is encrypted behind opaque handles; Anthropic and
Kimi rely on the durable transcript.

These provider verticals are implemented but not distributed. No
signed/notarized installed artifact or successful production credential-canary
smoke exists, and source/npm or ad-hoc builds cannot activate the authority.
A directly injected descriptor and its peer's self-attestation cannot prove
native provenance, so a claimed ready result is still downgraded to
`peer_identity_unverified` without a JavaScript or environment bypass. There is
no plaintext fallback. Broker-owned providers beyond the three exact verticals
remain disabled until their complete profile and release evidence exist.

The one implemented subscription path is deliberately narrower than a Recurs-
owned credential flow: Recurs launches the pinned official Codex ACP adapter as
a vendor-authenticated child runtime and lets that runtime use an existing
ChatGPT login. Recurs never reads or stores the login token, auth-file contents,
or browser cookies. This path is local, manual, user-present, and Plan-only;
one-shot, unattended, recognized CI (including CI with a TTY), remote,
scripted, implicit SDK, and Act-mode use fails closed. The active account is
verified on the exact ACP child before session work and again immediately
before prompting. Plan mode rejects every non-read runtime approval even under
`Approved for Me` or `Full Access`.

That delegated Codex path is available only through the public npm/source CLI.
The sealed private engine explicitly returns a fixed safe unavailable error for
Codex and does not resolve an ambient adapter or binary. It remains denied there
until both have a reviewed fixed signed-bundle layout.

Connection management stores and removes Recurs metadata only.
`recurs account disconnect` does not revoke, sign out, or delete vendor
authentication. Public account output omits local endpoints, vendor account
labels, and one-way account fingerprints. Primary selection affects new
sessions only; every existing session must still match its complete pinned
connection before provider or runtime work begins.

## Supported versions

Until Recurs reaches a tagged public preview, only the current `main` branch is
considered for security fixes. There is no supported stable release line or
backport policy yet. This policy will be revised before the first public
release.

The private-engine bundler is configured to preserve legal comments, but that
is not a complete third-party notices inventory. Release packaging still
requires an explicit license/notices review for every shipped runtime and
dependency.

## Reporting a vulnerability

Do not open a public issue, discussion, pull request, or chat containing a
credential, exploit details, private repository data, or another user's data.

Once GitHub private vulnerability reporting is enabled for this repository,
use **Security → Report a vulnerability** so maintainers can coordinate through
a private security advisory. Private vulnerability reporting is not configured
for this pre-release repository yet; maintainers must enable it before a public
launch. Until then, use a private channel you already share with the repository
owner and send only the minimum redacted reproduction needed to establish the
problem.

Include:

- the affected commit and platform;
- the smallest safe reproduction;
- the boundary crossed and expected behavior;
- whether data reached tool output, checkpoint storage, session events, logs,
  terminal streams, or a child process; and
- any containment steps already taken.

## Credentials and canaries

Never use a real API key, OAuth token, browser cookie, private key, cloud
credential, or production secret in a test or report. Security tests must use
obviously fake, unique canary values and must prove that the complete canary is
absent from output, events, sessions, errors, checkpoints, and child state.

If a real secret may have been exposed, stop using it and rotate or revoke it
at its issuer. Report the type and exposure path, not the secret bytes. Do not
assume deleting a Git commit, issue, log, or checkpoint invalidates a copied
credential.

## Current security boundary

The permanent built-in credential-path denial and clean subprocess environment
are defense in depth. They are not a promise that model-selected code cannot
reach host credentials indirectly. `Full Access` is not credential-safe, and
the default `local_guarded` tool profile is not an OS sandbox. Tool children
receive only standard descriptors `0`–`2` and do not inherit the launcher
descriptor, native-authority markers, Keychain/token variables, provider/cloud
variables, or proxy variables, but they retain the user's ordinary host
authority.

Parallel Explore/Review batches and team Implement workers run in detached
worktrees only after the parent is verified as the canonical root of a clean
Git repository at exact committed `HEAD`. The worktrees omit ignored local
state, live outside the repository, and are removed before settlement. Batch
changes are discarded. A team can import only a parent-owned, hash-verified,
text-only patch after exact path, credential-path, mode, binary, symlink,
submodule, size, base-revision, and ownership checks. Artifacts are applied in
declared order behind an exact checkpoint, and any conflict after mutation
triggers whole-transaction rollback. Successful integration stays uncommitted;
a rejected or unavailable Review leaves that visible change for correction or
`/undo`. These controls separate sibling workspace effects and constrain the
import boundary, but they do not restrict host filesystem, network, IPC, or
process authority and do not make children credential-safe sandboxes.

The private signed path implements OpenAI API, Anthropic API, and Kimi Code.
Other direct API, coding-plan, OAuth, and cloud-identity credential flows remain
disabled until each complete provider vertical supplies reviewed request/stream
codecs, TTY onboarding and a fenced connection lifecycle, provider
verification, exact route-bound credential reservation, policy/runtime
binding, a compatible signed artifact, and installed-artifact credential-canary
tests. A manifest boolean cannot bypass that gate. The production broker
release smoke must use an ephemeral macOS user and a dedicated production test
Keychain access group; overriding `HOME` cannot safely redirect its live journal
root or Keychain configuration. Native HTTPS ignores repository proxy/CA
environment variables while trusting macOS system proxy and root configuration
as host policy. That trust is not certificate or proxy pinning. The official
Codex child-runtime path above does not make the TypeScript process
credential-safe or authorize other subscription adapters.

Recurs bounds process-group cleanup and closes its own output pipes so inherited
pipes alone cannot hold run settlement open before synthetic-directory cleanup.
An arbitrary child can still create a different process group or session and
survive or race that application-level cleanup. Preventing or accounting for
detached descendants is part of the required OS containment boundary.
