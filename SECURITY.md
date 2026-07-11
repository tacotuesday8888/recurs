# Security Policy

Recurs is pre-release software at version `0.0.0`. It does not yet accept or
store live provider credentials, and it must not be used as a credential-safe
sandbox. The current TypeScript safeguards reduce accidental disclosure through
built-in tools, checkpoints, child environments, and error messages; arbitrary
commands still run with the user's host filesystem, network, IPC, and process
authority.

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
the default `local_guarded` tool profile is not an OS sandbox. No live cloud or
subscription credential may enter this process until the separately reviewed
native broker, hardened storage, and tool sandbox boundary is implemented and
tested.

Recurs bounds process-group cleanup and closes its own output pipes so inherited
pipes alone cannot hold run settlement open before synthetic-directory cleanup.
An arbitrary child can still create a different process group or session and
survive or race that application-level cleanup. Preventing or accounting for
detached descendants is part of the required OS containment boundary.
