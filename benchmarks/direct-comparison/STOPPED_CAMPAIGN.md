# Direct comparison: stopped setup

This attempt produced no valid Codex–Recurs comparison. The runner checked
versions and model routes but missed a known invocation restriction. That was
a harness error, not a measurement of Recurs's coding ability.

| Slot | Execution | Candidate checks | Elapsed |
| --- | --- | --- | ---: |
| Fix bugs · Codex · 1 | Completed | Passed | 60.286 s |
| Fix bugs · Recurs · 1 | Blocked before model execution | Unchanged fixture fails | 0.515 s |
| Fix bugs · Recurs · 2 | Blocked before model execution | Unchanged fixture fails | 0.493 s |
| Fix bugs · Codex · 2 | Cancelled by operator | Passed | 65.516 s |
| Remaining eight slots | Not attempted | Not graded | — |

The campaign was stopped after detecting the Recurs failures. A passing candidate
does not turn an interrupted model run into a completed attempt. Setup-failure
latency does not measure coding speed. None of these records is eligible for a
comparative chart, completion-rate ranking, or savings claim. No slot was retried.

## Cause and correction

`packages/cli/src/process-host.ts` stamps `recurs run` as one-shot, unattended,
scripted CLI execution, even inside a foreground terminal. The delegated Codex
connection guard in `packages/cli/src/assembly.ts` requires present, local, manual
CLI execution. Both Recurs traces contain only a `configuration_error` with
`policy_blocked`; neither contains a model start or tool event.

This is Recurs's activation contract, not a claim that all OpenAI subscription
automation is prohibited. No guard, connection, credential, permission policy,
prompt, fixture or executable was changed to continue the campaign.

The runner now checks invocation compatibility before creating a campaign or
starting either product. It also stops on a runtime configuration error instead
of advancing to another slot. Offline regression tests exercise both `preflight`
and `run` with local fake executables and verify exit 2, no model command, and no
artifact-directory creation. The corrected runner is a later version; its hash
does not replace the executed harness hashes in the saved provenance.

The existing interactive CLI and built-in company benchmark use different
execution protocols. The latter supports catalog scenarios, not these arbitrary
fixtures. A future comparison needs a separately declared, supported protocol;
wrapping this script in a PTY does not make its invocation manual.

## Candidate and trace audit

Both Codex candidates make the same three substantive repairs: require matching
tenant ownership before mutation, use an exclusive cursor, and construct public
records from an explicit field allowlist. Their new tests exercise the public
API for each repair. They preserve the package and original tests. No hardcoded
grader outcome or source-inspection test was found. The saved candidate changes
are linked in [the machine-readable export](stopped-campaign.json).

All four saved workspaces were graded again offline. Every grade field matched
the original record. The two Recurs workspaces contain only the original fixture.
The second Codex trace has no `turn.completed` event, so its passing candidate
checks remain separate from its cancelled execution status.

Both Codex traces include reads of installed skills outside the fixture. No
grader or reference reads, network requests, or dependency installs were observed
in the captured commands. These external skill reads deviate from the task's
workspace-only instruction and show that ignoring user configuration did not
establish a hermetic workspace. This additional confound must be addressed in a
future protocol; these attempts are not promoted to clean comparison evidence.

## Provenance and usage

[stopped-campaign.json](stopped-campaign.json) retains all twelve planned slots,
the original execution statuses, wall times, grades, executable and harness
hashes, and hashes of private traces. Exported candidate files have individual
hashes. Raw traces and private connection identifiers remain outside the repository.
The original plan, raw results and captured traces were not rewritten.

The completed Codex turn reports 149,804 input tokens, including 130,304 cached
input tokens, and 2,580 output tokens. Its additional native counters are retained
verbatim in the export without aggregation. The cancelled turn has no final
usage record. Unknown usage and dollar costs remain null. There is no measured
token or price comparison, and subscription token counts do not establish cost
per completed task.
