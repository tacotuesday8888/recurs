# Security Hardening Proposal: Linux Process Containment

## Decision

Choose how Recurs removes ambient Linux host authority from approved arbitrary
tool processes without replacing the TypeScript harness or introducing a
container daemon.

## Executive Recommendation

I recommend Option 2, a narrowly owned Bubblewrap launch policy using the
distribution-provided `/usr/bin/bwrap`. We can reuse the existing process,
permission, cancellation, and environment seams while gaining a real mount,
PID, user, and optional network namespace boundary. We should describe this as
workspace containment, not as a complete syscall sandbox.

## Evidence

| ID | Short title | What it establishes |
| --- | --- | --- |
| E001-E003 | Shared Recurs process boundary | Process lifecycle and environment isolation are centralized; approved intents already determine network policy. |
| E004-E007 | Linux fallback and disclosure | Linux defaults to guarded host execution and CI does not install a sandbox helper. |
| E008 | Current Codex Bubblewrap path | Codex uses Bubblewrap for filesystem/user/PID/network namespaces and separately applies seccomp plus `no_new_privs`. |
| E009-E010 | Bubblewrap policy constraints | The caller owns the security policy; `--new-session`, socket visibility, and mount arguments are security-relevant. |

The Recurs evidence is repository-local. The external sources are pinned to
[OpenAI Codex commit `0fb559f`](https://github.com/openai/codex/tree/0fb559f0f6e231a88ac02ea002d3ecd248e2b515),
including its [Bubblewrap launcher](https://github.com/openai/codex/blob/0fb559f0f6e231a88ac02ea002d3ecd248e2b515/codex-rs/linux-sandbox/src/bwrap.rs),
[Bubblewrap README](https://github.com/openai/codex/blob/0fb559f0f6e231a88ac02ea002d3ecd248e2b515/codex-rs/vendor/bubblewrap/README.md),
and [security policy](https://github.com/openai/codex/blob/0fb559f0f6e231a88ac02ea002d3ecd248e2b515/codex-rs/vendor/bubblewrap/SECURITY.md).

## Current Design And Failure Mode

Recurs evaluates permissions before tool execution, strips inherited secrets,
creates a private home and temporary tree, bounds output and time, and kills a
child process group on every terminal path. On macOS, the same boundary wraps
the command with Seatbelt. On Linux, `sandboxLaunch` rejects the profile, so
the CLI selects `local_guarded` instead.

This is not an approval bug: the user can knowingly approve a command. The
structural problem is that approval currently grants the command the same
filesystem, process, IPC, and network namespaces as Recurs. A malicious build
script can therefore act beyond the project even when its environment is
clean. Application-level command classification cannot enforce a kernel
boundary after `exec`.

## Desired Invariants

- A `workspace_sandboxed` Linux child cannot modify the host outside the
  canonical workspace and its one private temporary root.
- The child cannot observe host processes, runtime sockets, or known host
  credential paths; non-credential host files remain read-only so toolchains work.
- Network access is absent unless the already-approved intents include the
  network category.
- Recurs never falls back to ambient execution when the selected sandbox is
  unavailable or untrusted.
- Cancellation, timeout, output bounds, stdio, and process-group cleanup retain
  their current behavior.
- Documentation distinguishes namespace/mount containment from syscall
  filtering and from persistent-credential isolation.

## Constraints And Non-Goals

We preserve the current TypeScript APIs and Node spawn boundary. We do not add
Docker, a privileged daemon, a downloaded executable, Windows containment, or
a Recurs syscall filter in this slice. We also do not claim that Bubblewrap is
a privilege boundary between the local user and the operating system; our
policy limits authority available to the spawned child.

## Before Architecture

The [before diagram](../diagrams/linux-process-containment-before.mmd) shows
that filtering and approvals narrow what Recurs intends to grant, while the
Linux child still enters the host namespaces. The missing edge is an
enforcement layer between `runProcess` and the child.

## Options

### Option 1: Keep Guarded Host Execution

This baseline preserves every current compatibility property. We can continue
to improve classification and environment filtering without a system
dependency. It is attractive for unusual Linux environments where user
namespaces are disabled.

The security limit is fundamental: once an approved script starts, Recurs
cannot constrain its filesystem or socket use. Future command classifiers can
reduce accidental approvals but cannot make adversarial scripts safe. The
[baseline diagram](../diagrams/linux-process-containment-guarded-host-after.mmd)
therefore changes control quality, not the trust boundary. Rollback is trivial,
but the documented parity gap remains.

### Option 2: System Bubblewrap Boundary

Recurs validates one fixed, root-owned, non-writable, non-setuid
`/usr/bin/bwrap`, then supplies a fixed policy: a read-only host root, minimal
`/dev`, hidden host temporary/runtime state, masked credential paths, explicit
writable binds for the workspace and private child root, a fresh user and PID
namespace, a fresh `/proc`, `--new-session`, and a network namespace unless
the permission engine approved network access.

The attractive part is the fit. Both one-shot commands and streaming MCP
sessions already pass through the same launcher, so one implementation covers
both without duplicating policy. The [Bubblewrap diagram](../diagrams/linux-process-containment-system-bubblewrap-after.mmd)
also keeps network authority owned by the permission engine rather than by a
new configuration path.

Residual risk is explicit. Recurs does not yet install a seccomp filter, so the
child retains the host kernel syscall surface available inside its namespaces.
An approved network command uses the host network namespace. Non-credential
files mounted read-only remain readable unless covered by temporary/runtime masks.
Kernel or Bubblewrap defects remain external dependencies. These limits are
material, but they are still a large reduction from ambient host execution.

Startup adds one small helper process and namespace setup. Memory is limited
to namespace metadata and Bubblewrap's short-lived process. Availability now
depends on a distribution package and enabled unprivileged user namespaces;
Recurs should report a fixed `sandbox_unavailable` error rather than downgrade.
Migration is an install prerequisite plus CI coverage. Rollback is a normal
code/configuration revert, not a state migration.

### Option 3: Bundled Native Sandbox Helper

A Recurs-owned helper can apply `no_new_privs`, a reviewed seccomp filter, and
the same Bubblewrap policy from a smaller pre-exec process. This most closely
matches the current Codex composition and gives Recurs control over versioning
and diagnostics. The [native-helper diagram](../diagrams/linux-process-containment-native-helper-after.mmd)
shows the additional syscall boundary.

This option has the strongest eventual security case, particularly for
unattended agents. What gives me pause is the ownership cost: cross-architecture
builds, libc choices, signing/provenance, distribution packaging, syscall
compatibility, and safe updates all become release responsibilities. A too
narrow filter breaks compilers and language servers; a too broad filter creates
the appearance of protection without enough gain. It also expands the current
milestone far beyond the existing TypeScript seam.

We can introduce this later without changing the `processSandbox` contract.
Its rollback would select the system-Bubblewrap backend, so Option 2 is useful
groundwork rather than throwaway work. It becomes preferable once Recurs has a
binary release pipeline and a separate syscall-policy validation matrix.

## Tradeoff Comparison

| Dimension | Option 1: Guarded host | Option 2: System Bubblewrap | Option 3: Native helper |
| --- | --- | --- | --- |
| Security | Ambient host authority remains | Strong filesystem/process/IPC/network reduction; no Recurs seccomp | Adds owned syscall policy to Option 2 |
| Performance | No namespace startup | One helper and namespace setup per process | Similar namespace cost plus filter install |
| Memory | Neutral | Small transient helper/namespace metadata | Small helper plus shipped binary |
| Reliability | Broad compatibility | Fails closed when package or user namespaces are unavailable | More controlled diagnostics, broader compatibility testing burden |
| Operability | No dependency | One documented package and live CI checks | Multi-platform binary supply chain and update path |
| Migration | None | Linux install prerequisite; no data migration | Release/packaging migration; process API can remain stable |

All assessments are source-derived or analogous; none is a measured latency or
RSS result. CI should measure behavioral compatibility and repeated startup,
while release work can add performance budgets if startup becomes material.

## Evidence Coverage

| Evidence | Option 1 | Option 2 | Option 3 | Tactical work still required |
| --- | --- | --- | --- | --- |
| E001-E004: Linux lacks the selected profile | Unaffected | Addresses | Addresses | Yes: implement and test the launcher |
| E005-E007: disclosed limitation and CI gap | Unaffected | Addresses | Addresses | Yes: update docs and CI |
| E008-E010: namespace policy requirements | Unaffected | Mitigates with documented missing seccomp | Addresses more completely after a separate syscall review | Yes: keep exact residual-risk language |

## Recommendation

Under the project's TypeScript-first and concise-delivery constraints, Option
2 gives the best reduction in ambient authority per unit of new machinery. I
would change the recommendation to Option 3 if Recurs already had a mature
native Linux artifact pipeline or if a threat model required syscall filtering
before any unattended execution.

## Rollout And Validation

Land the launcher and unit/live tests together. Linux CI must install
Bubblewrap, prove workspace writes, prove host writes do not persist, prove host
credential and runtime paths are hidden, and prove deny/allow network behavior.
The CLI should then default Linux to `workspace_sandboxed`. Documentation and
install errors must name the prerequisite and residual syscall risk.

The rollout is fail-closed: if the helper path, ownership, mode, namespace
setup, or launch fails, the command fails. A rollback reverts the default and
launcher changes; there is no stored state to migrate.

## Open Questions

- Which non-Debian package names should the eventual installation guide list?
- When release binaries exist, should Recurs vendor a pinned Bubblewrap build or
  move directly to the native-helper option?
- Which syscall families should a later seccomp profile deny without breaking
  compilers, package managers, MCP servers, and language servers?
