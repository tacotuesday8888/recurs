# Product finishing pass — September 26–27, 2026

Baseline: `5f79544` (PR #226). This record lists what changed, the evidence for
each change, and what remains. Every product defect below was reproduced before
it was fixed, and every fix has a regression test.

## Reliability and speed

| Area | Finding | Change | Evidence |
| --- | --- | --- | --- |
| Streaming memory and speed (#227) | Each streamed chunk re-copied and re-collapsed the whole 256K-character transcript; each frame re-parsed all Markdown. Retained heap stayed ~40 MiB; the growth was garbage. | Cached transcript text, batched trimming from a line boundary, per-turn Markdown segments, one transcript read per frame. | [Active-session memory](ACTIVE_SESSION_MEMORY.md): median turn 501–521 → 124 ms; peak footprint over 120 turns ~400 → ~270 MiB. |
| History loading (#228) | Listing a chat's executions read and restored every session log in the workspace. | Find the conversation's session tree from each log's first record; validate only those logs. | 30 unrelated 5.9 MB chats: 1,060 ms → 8 ms. |
| Termination (#229) | Closing the terminal, `SIGTERM`, or Ctrl+C during `recurs run` left agent-started commands running; `SIGTERM` left the terminal in raw, mouse-reporting mode. | Signal handlers restore the terminal, close runtimes within five seconds, and exit 129/143/130. | The installed-package walkthrough now asserts it; the check fails without the fix. |
| Reopened chats (#232) | Reopening printed raw `assistant:`/`tool:` lines with full tool output and hid cancelled turns. | Durable records projected into prompts, replies, tool names and turn outcomes. | Verified in a real PTY after a crash. |
| Test determinism (#230) | A team-delegation ordering test raced on Linux CI. | Start barrier in the harness. | Stable across repeated runs. |

## Benchmark integrity

- **Timeout accounting (#231).** After a slot deadline, Recurs graded the
  candidate with the already-cancelled signal and recorded a failed workspace
  inventory without inspecting anything; the Codex arm recorded the same event
  as not run. The frozen shipment attempt 2 record carries exactly this
  signature although its candidate passes offline replay. Timed-out candidates
  are now graded, cancelled verification is `not_run`, and deadlines are
  recorded as `execution_deadline_exceeded`. Frozen outcomes are unchanged.
- **Three-way resource comparison (#235).** Protocol committed before measuring.
  Against one local model server: Recurs finished a long streamed answer in
  369 ms (Codex CLI 432 ms, Claude Code 495 ms) with 61% less peak memory than
  Claude Code; Codex CLI used the least memory; Recurs starts slowest.
- **Real-model campaign (#236).** Pre-registered Claude Code vs Codex CLI vs
  Recurs task comparison and a team-efficiency question, runnable with existing
  subscriptions. Not yet run; see its runbook.

## Website, README and terminal

One brand palette, wordmark and message across all three surfaces: "Coding
agents. Your terminal." and "Choose the models. Bound the team. Review every
change." The website uses one column and type scale, keeps the install choice
directly above the command, and shows only traced measurements (#233, #237).
The audited two-way comparison remains validated and available in the
repository. The terminal names chats by their first prompt with local times
(#234). The README demo is rendered at twice the previous resolution from the
installed-package walkthrough.

## Remaining limits

- The real-model three-way campaign has not been run.
- Session turns still reload the whole session log several times; peak memory
  still grows with very long sessions.
- The two-way comparison (Codex CLI 3 of 6, Recurs 2 of 6) stands as recorded.
- Measurements come from one macOS host; CI is the cross-platform gate.
