# September 2026 release security closure

This report records source-level remediation and executable regression evidence
for the release-readiness branch. It is not a package publication record or a
claim that Recurs isolates hostile code from all same-user host authority.
Tests used temporary workspaces and obvious synthetic canaries; no owner
credentials, personal configuration, or third-party accounts were used.

## Findings and evidence

| Finding | Resolution | Verification |
| --- | --- | --- |
| Historical reusable grants and permission modes could cross session boundaries. | Retained session-scoped permission engines and the shared session mutation/run boundary. No relaxation was introduced for execution controls. | `agent-loop.test.ts` rechecks sequential grant isolation, interleaved Full Access/Ask Always runs, cancellation, and non-contradictory terminal outcomes. `session-mutation-lease.test.ts` and `session-runtime-records.test.ts` passed. |
| Historical file/search/Git/checkpoint paths and inherited child state could expose credentials. | Retained the shared credential-path policy, stable file identity checks, filtered process environment, and checkpoint exclusions. New OAuth storage uses the protected `credentials` basename, including temporary writes. | `permissions.test.ts` and `checkpoints.test.ts` recheck unconditional credential denial and credential/symlink exclusion. New credential canaries cover the OAuth storage layout. |
| Historical Linux tool execution retained ambient host authority. | The existing implementation requires trusted system Bubblewrap, applies workspace mount and namespace policy, and fails closed. New private-directory masks apply after workspace/support mounts. | Reviewed [the original finding](../security/linux-process-containment/hardening.md), [implementation contract](../security/linux-process-containment/implementation/system-bubblewrap.md), and current `process.ts`. Local execution evidence below is macOS; Linux live containment remains a Linux CI responsibility. |
| A normal streaming process-session exit could leave descendants alive. | Process sessions now finalize on the leader's exit, terminate its process group, drain/close output, and only then report completion. Cleanup failure remains a failure. | `process-session-cleanup.test.ts` starts real descendants with ignored and inherited stdio and verifies both are gone before successful completion. Existing owned-process tests also passed. |
| OAuth metadata could direct a public MCP connection toward a local/private service. | The HTTP requester binds authority to the configured endpoint, validates each destination, pins verified DNS addresses to the socket, and rejects redirects. Explicit loopback authority is limited to that origin. | `mcp-extensions.test.ts` exercises private/loopback destination rejection, protocol operations, cancellation, OAuth, refresh, and logout using controlled local fixtures. |
| Newly stored OAuth credentials were outside the existing file-tool and subprocess credential boundaries. | Credential files and staging files have the protected basename. Private `<data>/auth` directories are provisioned before processes start and denied to sandboxed tool, MCP, and lifecycle-hook processes. Runtime-specific paths support custom data directories as well as the default home. | `credential-directory-sandbox.test.ts` uses real positive-control reads and proves direct-tool and child-process denial with credential roots inside and outside the workspace. It also rejects a replaced symlink. `lifecycle-hooks.test.ts` proves a real hook can read a public file while being denied the private canary. |
| An OAuth token exchange could complete after cancellation. | The interactive auth flow aborts its network operations and checks cancellation before publishing credential state. | The delayed-token fixture in `mcp-extensions.test.ts` verifies cancellation remains terminal and no late token is stored. |
| Selecting a worker could relabel the parent conversation; ordinary executions were omitted. | Durable execution IDs now drive inventory, inspection, and scoped cancellation. Every ordinary, batch, team, and company child uses the same session identity. Unavailable live ownership is reported as unknown. | `agent-execution.test.ts`, `terminal-executions.test.ts`, `child-agent-manager.test.ts`, `runtime.test.ts`, and `session-commands.test.ts` cover ancestry, exact transcripts, foreign-session rejection, sibling-safe cancellation, and retained history. |

The historical foundations are documented in the
[base-harness review findings](../superpowers/plans/2026-07-10-recurs-base-harness-hardening.md)
and [host-safety plan](../superpowers/plans/2026-07-11-recurs-host-safety-foundation.md).
Those dated plans are context; the executable checks above establish current
behavior. The separate [review-integrity report](2026-08-10-RECURS-REVIEW-INTEGRITY-ALPHA8.md)
remains applicable: a model's approval is not an independent correctness proof.

## Verification performed

The final security regression run passed **15 test files / 220 tests**:

- Core: agent loop, session mutation leases, runtime records, team-child recovery.
- Tools: permissions, checkpoints, registry, process policy, private credential
  directories, and process-session descendant cleanup.
- CLI: lifecycle hooks, MCP client and extension integrations, Agent Skills and
  skill lifecycle operations.

The real sandbox and loopback fixtures ran outside the enclosing desktop
sandbox on macOS. Positive controls prevent an outer sandbox's inability to
launch a child from counting as successful credential protection. A separate
execution/command regression run passed **7 files / 89 tests**. These are
separate runs and must not be added together as unique test coverage.

`tsc -b --force --pretty false` passed after integration. The owned source and
test files passed ESLint. Full repository checks, installed-artifact acceptance,
Linux CI, and final merge status are recorded by the release owner separately.

### Linux hook launch follow-up

The first Linux release CI run exposed a real hook-launch gap: temporary roots
are hidden, so an explicitly configured hook executable under `/tmp` could not
start. Hooks now expose only their validated executable as a read-only file,
without exposing its directory or neighboring sockets. The mount point is
prepared before the temporary root becomes read-only, and credential masks
remain last, including when an exposed file is beneath a protected directory.
The workspace-write denial test now requires a successful public-read hook as
a positive control. Focused local verification passed **3 files / 17 tests**,
including Linux argument-generation assertions and real macOS sandbox runs;
typecheck, ESLint, and diff checks passed. Actual Linux execution of this fix
is pending the release CI rerun and is not implied by the local checks.

## Limits retained explicitly

- `local_guarded` intentionally retains host authority. Process groups are
  lifecycle cleanup, not containment of deliberately detached hostile daemons.
- The Node parent, same-user host tools, and vendor-owned runtimes are not made
  credential-safe by Recurs's tool subprocess masks. BYOK environment access
  and vendor runtime permissions retain the boundaries described in
  [SECURITY.md](../../SECURITY.md).
- Linux uses mount/namespaces and system Bubblewrap; this change does not add a
  Recurs-owned seccomp policy or Windows subprocess containment.
- Remote MCP currently supports public HTTPS and explicitly configured
  same-origin loopback HTTP(S). Arbitrary private-LAN endpoints are not enabled
  by the new requester. No claim is made that all third-party servers were tested.
- OAuth state is private file storage, not an OS keychain. The checks reduce
  accidental disclosure and reject unsafe paths; they do not defeat a hostile
  process with the same user's full filesystem authority.
- Exact child cancellation is supported. Targeted child steering and vendor
  internal transcripts are not invented: inspection explains which persisted
  prompts, responses, and tool results are available.
- A damaged unrelated session log does not hide healthy execution history.
  Read-only inventory flags incomplete history without repairing or truncating
  the damaged file. Recorded-running work without an attached owner remains
  unknown until its containing run is inspected or recovered.

Final platform closure: the exact-file hook mount, successful public read,
credential denial and workspace write denial passed actual Linux execution in
[CI 34305124016](https://github.com/tacotuesday8888/recurs/actions/runs/34305124016)
(2,286 tests passed), with macOS passing its full and installed gates too.
The remaining CodeQL annotation was separately established as an individual
[public-client-ID false positive](../security/mcp-oauth-client-id-hash-review.md)
with no query suppression or weakened cryptography.
