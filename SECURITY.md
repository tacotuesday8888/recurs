# Security policy

Recurs is public alpha software. Security fixes target the current `main`
branch and the latest public alpha.

Recurs reduces accidental disclosure and unsafe tool execution. It is not a
credential-safe sandbox, a hardened multi-tenant service, or a substitute for
host isolation.

## Reporting a vulnerability

Do not open a public issue, discussion, pull request, or chat containing a
credential, exploit details, private repository data, or another user’s data.

Use GitHub's
[private vulnerability report](https://github.com/tacotuesday8888/recurs/security/advisories/new)
to contact the maintainers without publishing the report. Send only the
smallest redacted reproduction needed to establish the problem. If the report
itself could expose another party's secret or private data, first submit a
minimal notice and coordinate a safer transfer channel with the maintainers.

Include:

- the affected commit and platform;
- the boundary crossed and expected behavior;
- the smallest safe reproduction;
- whether data reached tool output, session events, checkpoints, logs, terminal
  streams, or a child process; and
- any containment steps already taken.

## Credential boundary

Recurs supports two credential ownership models:

- A delegated vendor runtime owns its own login and tokens.
- A direct BYOK connection reads one named environment variable in the Recurs
  process.

Recurs stores provider/model routing metadata, the environment-variable name,
and a one-way credential fingerprint. It does not persist the credential value.
The exact named value must be present and match the saved fingerprint before a
provider request begins.

Environment BYOK is deliberately weaker than vendor-owned authentication. The
credential exists in the parent Node.js process and may be observable by
same-user host authority, debuggers, injected code, or a compromised runtime.
Do not run Recurs with unrelated high-value credentials in its environment.

Built-in tools receive a filtered child environment. Provider keys, tokens,
cloud credentials, proxy settings, real home/config paths, and unrelated
process variables are not forwarded.

## Provider boundary

Provider manifests are untrusted policy data and never grant execution
authority by themselves. A remote provider is runnable only when all of the
following agree:

- a built-in reviewed adapter;
- a fixed HTTPS origin and protocol;
- a current usage policy;
- a valid billing acknowledgement; and
- a matching connection record and credential fingerprint.

Redirects, endpoint drift, malformed streams, oversized events, unsupported
tool calls, and credential echoes fail closed. Errors are normalized before
they reach model-visible output.

Recurs does not silently select providers, rank models, or fall back across
billing sources.

## Tool and subprocess boundary

Tools are registered by capability. Agent roles see only the tools allowed by
their frozen operating-mode and permission policies.

Filesystem and Git tools canonicalize paths and enforce the selected workspace
root. Credential paths, symlinks, non-regular files, oversized content, and
files that change during a protected read are rejected where applicable.

Subprocesses receive standard descriptors `0`–`2`, a private synthetic
home/config/cache/temp tree, a filtered absolute `PATH`, and selected
locale/terminal values.

- macOS uses a fail-closed Seatbelt profile.
- Linux uses `/usr/bin/bwrap`, read-only host mounts, masked credential paths,
  private process state, fresh user/PID/IPC/UTS namespaces, and a fresh network
  namespace unless the approved command requires network.
- Windows subprocess tools are unsupported and fail closed.

An explicitly selected guarded host profile retains broad host authority.
Application-level command classification, approvals, timeouts, process groups,
and output bounds are defense in depth, not containment.

User lifecycle hooks are executable local configuration, never repository
configuration. Recurs accepts them only from a private, owned, single-link file
under its data directory. Hooks receive sanitized lifecycle envelopes and run
with a read-only workspace, a private filtered environment, denied network,
bounded output, and hard per-hook and aggregate event time limits. Each command
must be one private, owned, single-link executable outside the workspace; Recurs
binds its file identity at startup and revalidates it before every launch. Hooks
run from a bounded asynchronous queue, so they cannot block or mutate the parent
event, prompt, tool call/result, permission, or agent authority. Bounded
shutdown drains completed work and cancels unfinished owned hook processes.
Hook failures are normalized and do not change the agent result. Treat any
configured executable as user-authorized code
despite these limits.

Persistent permission rules also come only from a private, owned, single-link
user file. They match one canonical workspace, category, resource, and risk
exactly; repository files and wildcard patterns grant nothing. Credential
access is always denied, destructive intents cannot be persistently allowed,
and Plan mode, role tool policy, parent ceilings, path guards, and subprocess
containment remain authoritative. Persistent allow rules apply only to the root
agent; child agents retain ask/deny rules but must earn authority through their
narrowed parent and profile policy. Rules are a convenience layer, not a
sandbox.

## Worktree and team boundary

Parallel agent work starts only from a clean canonical Git root at committed
`HEAD`. Implement children use private detached worktrees. Explore and Review
children are read-only.

Candidate patches are text-only and checked for ownership, path, base revision,
mode, size, symlink, submodule, binary, and credential-path violations before
the parent may apply them. The parent remains the apply authority.

Child depth, concurrency, requests, retries, cost reports, and tools are
bounded by a versioned policy. Children cannot widen parent permissions or
delegate recursively without an explicit future policy.

## Durable data

Recurs stores private session events, prompts, tool arguments, checkpoints,
team-run journals, and company state below its data directory. These files are
not a redacted audit feed and may contain sensitive repository context.

Writes use private directories, bounded canonical documents, revision checks,
and atomic replacement. Recovery validates ownership and identity before
touching stale worktrees or resuming an interrupted apply.

Back up, retain, and delete the Recurs data directory according to the
sensitivity of the repositories used with it. Run `recurs data path` to locate
the active directory. See [PRIVACY.md](PRIVACY.md) for data flow, retention,
and deletion guidance.

## Credentials and canaries

Never use a real API key, OAuth token, browser cookie, private key, cloud
credential, or production secret in a test or report. Tests must use obvious,
unique canaries and prove the complete value is absent from output, events,
sessions, errors, checkpoints, and child state.

If a real secret may have been exposed, stop using it and rotate or revoke it
at its issuer. Report the type and exposure path, not the secret bytes. Deleting
a Git commit, issue, log, or checkpoint does not invalidate a copied secret.

## Release boundary

The public alpha package contains the bundled CLI, package metadata, license,
README, privacy policy, this policy, and third-party notices. Package checks
reject workspace imports, build-machine paths, unexpected files, missing
executable mode, and size drift.

The release workflow remains owner-controlled and publishes only reviewed,
tagged previews after its verification and provenance gates pass. A public
alpha is not a claim that a stable release exists.
