# Security Policy

Recurs is pre-release software at version `0.0.0`. The signed native provider
path keeps reusable credential bytes outside TypeScript. The public
environment-BYOK path deliberately receives one selected key in the Recurs
process but never persists, renders, or forwards it to tools. Recurs must not
be used as a credential-safe sandbox. The current safeguards reduce
accidental disclosure through built-in tools, checkpoints, child environments,
and error messages; arbitrary commands still run with the user's host
filesystem, network, IPC, and process authority.

The source tree now produces a minimal npm candidate containing only the
bundled public CLI, package metadata, README, and this security policy. Recurs-
owned workspace packages are bundled; pinned ACP, Codex, YAML, and schema
libraries remain normal exact npm dependencies. Package checks reject private
workspace imports, build-machine paths, unexpected files, missing executable
mode, and size drift, and CI installs the tarball into an empty prefix before
running it. This is packaging evidence, not a public release: the package is
still private, version `0.0.0`, and `UNLICENSED`, and it contains no signed
native credential authority.

The protected tagged-release workflow is designed around that one exact
tarball. It renders a curl installer with an embedded SHA-256 and a Homebrew
formula with the same checksum, creates only a draft release initially,
attests the assets, and publishes or verifies the tarball's npm SHA-512 SRI
before making the GitHub release public. The installer refuses an unverified
archive, disables npm lifecycle scripts, uses a user-owned prefix by default,
and health-checks the resulting CLI. This workflow is still inoperative by
design until the license, non-placeholder version, public repository, exact
tag, and protected npm/GitHub authority gates are satisfied.

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

`recurs acp` is a local stdio protocol endpoint over the public/source CLI. It
does not receive or expose provider credentials, grant trust to an editor, or
expand provider policy. Each ACP conversation gets a distinct pinned Recurs
session, while every prompt is classified as unattended, scripted SDK work.
Consequently, the manual user-present Codex subscription path remains denied.
The endpoint forwards only allow-once and reject-once permission choices to the
client, cancels active work on protocol cancellation or disconnect, and uses
Recurs-owned tools rather than client filesystem or terminal methods. It does
not advertise ACP client-supplied MCP support and rejects those server
declarations and additional workspace roots. Standard output is reserved
exclusively for ACP frames.

The separate direct-provider MCP client reads bounded private user configuration
below the Recurs data root. It also discovers a stable, owned, non-group-writable
`.recurs/mcp-servers.json`, but project servers remain disabled until a local,
user-present confirmation stores the canonical workspace and exact config
SHA-256 below that project's private Recurs data root. Replacement, unsafe
metadata, digest changes, or user/project ID collisions fail closed; untrust
disables the servers and closes their processes. Configuration accepts absolute
commands and literal arguments but no shell or configured environment variables.
Every operation still requires elevated shell approval (and explicit network
approval when declared), uses the clean managed-process environment and selected
sandbox profile. One runtime may retain a serialized session for an exact
server/workspace/sandbox identity; reuse requires MCP ping, a failed health check
may restart only before an operation, and an ambiguous call is never retried.
Cancellation, timeout, failure, and runtime close terminate the process group.
Server metadata and results are untrusted and cannot grant authority. Remote
transports/OAuth, cross-runtime daemons, and historical child/team access are not
admitted by this slice.

Connection management stores and removes Recurs metadata only.
`recurs account disconnect` does not revoke, sign out, or delete vendor
authentication. Public account output omits local endpoints, vendor account
labels, and one-way account fingerprints. Primary selection affects new
sessions only; every existing session must still match its complete pinned
connection before provider or runtime work begins.

Saved environment-BYOK records contain a reviewed provider/model/policy/billing
binding, an environment-variable name, and a provider-bound SHA-256 credential
fingerprint. They never contain the credential value. The fingerprint detects a
missing or changed high-entropy provider key; it is not encryption, a password
store, or durable proof that the provider currently accepts the key. Anthropic,
OpenRouter, DeepSeek, and MiniMax setup authenticates once while listing
credential-visible models; other public BYOK paths authenticate on the first
generation request. Environment keys
remain visible to the Recurs process and any same-user host authority able to
inspect that process. Managed tool and MCP subprocess environments remove
credential, provider, cloud, proxy, Keychain, and socket variables. The standalone Linux
default additionally contains arbitrary commands with Bubblewrap; Windows and
an explicitly selected `local_guarded` profile retain broad host authority.
Public model discovery accepts only bundled, exact provider origins, uses the
provider's reviewed authentication header, denies redirects, bounds response
sizes and model counts, validates exact model metadata, and detects the complete
credential even when it spans response chunks. The Anthropic Messages adapter
also pins the reviewed API version, bounds requests/events, and strictly
reconstructs native tool calls. This is
still process-environment BYOK, not native credential custody; same-user host
authority can inspect the Recurs process.

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
are defense in depth. On macOS, the standalone CLI additionally runs shell and
verification children under a fail-closed Seatbelt profile. On Linux it uses a
fixed, trusted `/usr/bin/bwrap` policy with read-only host mounts, masked host
credential paths, hidden host temporary/runtime state, writable workspace and private process roots,
fresh user/PID/IPC/UTS namespaces, and a fresh network namespace unless the
approved command intent requires network. Tool children receive only standard
descriptors `0`–`2` and do not inherit the launcher descriptor,
native-authority markers, Keychain/token variables, provider/cloud variables,
or proxy variables. Bubblewrap setup fails closed and does not yet include a
Recurs-owned seccomp filter. Windows still selects `local_guarded` but rejects
subprocess tools as unsupported; an embedding may explicitly select guarded
host-authority execution on macOS/Linux. No sandbox profile makes TypeScript a
persistent-credential authority; environment BYOK remains the explicit weaker
process-local path described above.

The Linux policy refuses a selected workspace that contains the host home or
is itself within a known host credential directory. This prevents the writable
workspace bind from reopening the home tree that Bubblewrap hid.

Parallel Explore/Review batches and team Implement workers run in detached
worktrees only after the parent is verified as the canonical root of a clean
Git repository at exact committed `HEAD`. The worktrees omit ignored local
state and live under private project data. Batch changes are discarded. A team
can retain only a parent-owned, hash-verified, text-only patch after exact path,
credential-path, mode, binary, symlink, submodule, size, base-revision, and
ownership checks.

The default version-4 team path applies worker artifacts to a private staging
worktree and uses exact Implement, Review, and Repair profiles with no
arbitrary-command or verification tools. Only hardened Git inspection may
spawn a process, and project scripts cannot be executed by these roles. Only valid
bounded Review findings can start a Repair sibling, and the frozen policy caps
the rounds, children, requests, concurrency, and reported cost. Child depth
remains one, permissions cannot exceed the parent, and delegation tools are not
visible to children. The private team journal and spawned child session logs
persist assigned prompts and tool calls. `/agents` projections and
`agent_team_activity` omit prompts, patch bodies, private paths, credentials,
and account data; the general JSONL transcript can include prompts and tool
arguments and is not a redacted audit feed.

An approved foreground candidate is imported through a durable two-phase
checkpoint transaction. An approved background candidate never mutates the
parent until explicit apply, and background is only process-lifetime work—not a
daemon. Starting or resuming background work requires a local, manual,
user-present Act session, Full Access, and an eligible backend; apply requires
Full Access or one explicit elevated write approval. Cross-process owner leases prevent
two live writers but are not an OS security boundary.

Startup recovery validates the frozen parent, task, workspace lease, assignment
hash, child session, and artifact bindings before trusting durable work. It
removes only owned stale paths below Recurs's private worktree root. An
interrupted apply is completed only when the parent exactly matches the
candidate, reset to `ready_to_apply` only when the base is unchanged, and
otherwise marked for manual attention without overwriting the workspace.
Recovery runs before provider/session activation, sanitizes per-run failures,
and blocks startup with one safe error if any run cannot be reconciled.
These controls constrain the import and lifecycle boundaries; they still do
not restrict host filesystem, network, IPC, or process authority and do not
make children credential-safe sandboxes.

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
Under `local_guarded`, an arbitrary child can still create a different process
group or session and survive or race application-level cleanup. The default
macOS/Linux OS profiles add their platform containment boundary; Windows and
explicit guarded embeddings retain this limitation.
