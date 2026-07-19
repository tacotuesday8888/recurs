# Implementation Handoff: System Bubblewrap

## Selected Option

Implement Option 2 from the Linux process-containment proposal. The selection
is based on the user's explicit request for enforceable OS sandboxing while
keeping Recurs TypeScript-first and maintainable.

## Work Packages

1. Extend the shared process launcher with a Linux Bubblewrap launch plan.
   Validate the fixed helper and canonical roots before spawning.
2. Build the fixed mount/namespace policy for both `runProcess` and
   `startProcessSession`; preserve all current lifecycle bounds.
3. Make Linux standalone runtimes default to `workspace_sandboxed` while
   leaving Windows on `local_guarded`.
4. Add Linux-only live tests for writes, home/runtime hiding, network policy,
   and fail-closed helper behavior where practical.
5. Install Bubblewrap in Linux CI and update CLI/security/install docs with the
   exact dependency and limitations.

## Acceptance Criteria

- A sandboxed command can read/write its canonical workspace and private child
  directories.
- A write outside those roots does not modify the host.
- The real host home, `/tmp`, `/var/tmp`, and `/run` state are not ambiently
  visible, except where the selected workspace itself intentionally overlaps.
- Denied network cannot reach loopback; approved network can.
- Missing, writable, non-root-owned, symlinked, or setuid Bubblewrap launchers
  are rejected before child execution.
- One-shot and streaming child APIs use the same policy.
- Linux defaults to the sandbox and never silently downgrades.
- Focused tests, the full TypeScript check, native check, package smoke, and CI
  pass before merge.

## Rollback

Revert the focused launcher/default/test/doc commit set. No configuration or
session migration is required because the existing stable profile identifier
is reused.

## Deferred Strengthening

Do not add a native helper or syscall filter in this implementation. Record
that as residual risk and require a separate threat model, compatibility
matrix, and binary supply-chain plan before changing the launch architecture.
