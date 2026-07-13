# Security Policy

Recurs is pre-release software at version `0.0.0`. The Recurs TypeScript process
does not accept, import, expose, or store provider credential bytes, and it must
not be used as a credential-safe sandbox. The current safeguards reduce
accidental disclosure through built-in tools, checkpoints, child environments,
and error messages; arbitrary commands still run with the user's host
filesystem, network, IPC, and process authority.

The repository now includes a macOS 14.4+ native-authority component
foundation. It has tested Data Protection Keychain and credential-state/journal
libraries, exact-peer code-identity checks, a handshake/health XPC broker and
headless launcher skeleton, a no-secret framed TypeScript client for an injected
descriptor, child-process descriptor denial, and fixed redacted diagnostics.
The intended production architecture makes a signed broker the sole credential
and reusable-authority owner, but that path is not operational yet: the launcher
does not create the socket pair or spawn/bridge Node, credential operations are
not connected to the broker service, and no signed/notarized artifact exists.
The handshake-only broker advertises persistent credentials as unavailable.
The injected descriptor and its peer's self-attestation cannot prove native
provenance, so the inherited-descriptor factory also downgrades any claimed
ready result to peer-identity-unverified without a JavaScript or environment
bypass. Ordinary macOS source execution fails closed as launcher-unavailable,
while other platforms report unsupported. A connected native peer without
production and persistent authority reports production-signing-required. There
is no plaintext fallback. No current CLI command
collects a direct-provider secret and all broker-owned providers remain disabled.

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

Direct API, coding-plan, OAuth, and cloud-identity credential flows remain
disabled until a complete provider vertical supplies a reviewed native request
codec and endpoint profile, hidden-input onboarding and fenced connection
lifecycle, policy/runtime binding, the missing launcher/credential-service
wiring, a compatible signed artifact, and installed-artifact credential-canary
tests. A manifest boolean cannot bypass that gate.
The future native HTTPS transport will ignore repository proxy/CA environment
variables while trusting macOS system proxy and root configuration as host
policy. That trust must be disclosed; it is not equivalent to certificate or
proxy pinning. The official Codex child-runtime path above does not make the
TypeScript process credential-safe or authorize other subscription adapters.

Recurs bounds process-group cleanup and closes its own output pipes so inherited
pipes alone cannot hold run settlement open before synthetic-directory cleanup.
An arbitrary child can still create a different process group or session and
survive or race that application-level cleanup. Preventing or accounting for
detached descendants is part of the required OS containment boundary.
