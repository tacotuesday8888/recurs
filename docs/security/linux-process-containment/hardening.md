# Security Hardening Review: Linux Tool Processes

## Evidence Basis

We inspected the shared Recurs process boundary, its isolated child
environment, permission-to-sandbox mapping, CLI default, CI, and current
security documentation at commit `8a3ba6c`. We also inspected the current
Bubblewrap path in OpenAI Codex at pinned commit `0fb559f`. The evidence shows
one clear structural gap: Linux commands are bounded and approval-gated, but
retain ambient host filesystem, process, IPC, and network authority.

## Constraints

The selected change must stay TypeScript-first, preserve the existing tool and
permission contracts, avoid a container daemon, and fail closed rather than
quietly falling back. No measured latency or memory budget was supplied, so we
use a balanced profile and validate startup cost in CI rather than inventing a
target. Windows containment and a Recurs-owned seccomp filter are non-goals for
this slice.

## Opportunity Portfolio

| Opportunity | Evidence | Options | Recommendation | Proposal |
| --- | --- | --- | --- | --- |
| Remove ambient Linux authority from tool children | Current Linux fallback and documented limitation (E001, E004-E007); current Codex/Bubblewrap design constraints (E008-E010) | Keep guarded host execution; use a system Bubblewrap boundary; bundle a native sandbox helper | Use system Bubblewrap now, while recording the missing syscall filter honestly | [Linux process containment](proposals/linux-process-containment.md) |

## Recommendation Summary

I recommend the external Bubblewrap option under the current constraints. It
fits the existing `processSandbox` seam, removes host write authority outside
the workspace, hides host home/runtime state, and lets the permission engine
continue to own network decisions. The important residual risk is syscall
surface: this is a namespace and mount-policy boundary, not the full Codex
seccomp composition. A bundled native helper becomes preferable when Recurs is
ready to own cross-distribution packaging and a reviewed syscall policy.

## Next Decisions

Implement the selected option behind the existing `workspace_sandboxed`
profile, require a trusted non-setuid `/usr/bin/bwrap`, exercise the real
boundary on Linux CI, and publish exact limitations. Revisit the native-helper
option only with a separate threat model and packaging plan.
