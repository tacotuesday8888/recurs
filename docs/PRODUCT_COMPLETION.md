# Product audit — September 12, 2026

Goal: make the existing Recurs terminal product coherent, useful, and reliable
across its supported workflows. Inspect every current feature area, fix observed
faults, exercise actual Codex-connected work, and deliver verified source and
clean terminal captures. Perfection is an aspiration, not a test result.

The parallel benchmark/website task is 01a09855-11e2-72b3-a2d0-64d3120e0fb7.
It owns benchmark evidence and website files. This branch owns the terminal,
connection UX, README, and captures. Preserve both older website worktrees.

## Audit ledger

| Area | Inspection / change | Verification |
| --- | --- | --- |
| GitHub images | Blank diff capture: resize predicate accepted stale footer. Require diff content before capture; remove added frame captions. | Passed packed PTY capture; opening, patch, diff and compact team visually inspected |
| Copy | Shorter README, onboarding, home, activity labels. Keep consequential permission information. | Passed installed first-run, home, chat and review walkthrough |
| Onboarding | Effort picker Escape must cancel. Discover all Codex models; preserve current model/effort on reconnect. | Catalog/reconnect and cancellation regressions passed |
| Model and effort | /effort, F4, actual parent effort, subtle high-effort ornament. Existing sessions retain immutable pins. | Mocked official catalog + immutable variant/reuse regression passed; real Codex run below |
| Home and chats | Existing home, new/reopen, rename/pin/archive/copy. Audit cancellation and restart. | Passed installed rename/pin/archive/restore/copy, cancellation and restart |
| Review | Explicit staged/unstaged/all/last-commit/last-turn views; local base revision; split/original/updated; file navigation; cache formatted diff rows. | Git base, unborn/untracked/credential filtering, numbered modes, file navigation and narrow-layout regressions passed |
| Files | Searchable /files picker and numbered, scrollable source view. | Safe selection, cancellation, literal filename, line range, Unicode/resize bounds passed |
| MCP and skills | Inspect discoverability, connection state, tool visibility and lifecycle. | Passed installed scoped Skill lifecycle, HTTP MCP tools/resources/prompts, guided/deep company formation |
| Agents | Parent/child hierarchy, model/effort and role identity, status, inspect, cancel, review/repair/apply. | Runtime/execution suites passed; actual child/parent, inspect and reduced-motion PTY checks passed |
| Recovery | Queues, cancellation, resume, copied chats, approvals, context, failure paths. | Draft and transition regressions passed; live benchmark exercised repair and re-review |
| Runtime | Profile startup, rendering, large views; change only measured bottlenecks. | Baseline version 582/433/441/449/442 ms; R frame average 4.63 ms. Cached 600-file diff scroll mean 0.082 ms (500 frames), first render 24.34 ms. Local diagnostics under concurrent checks. |
| Delivery | Build/package, macOS/Linux checks, review, PR and installed executable. | `npm run check`: 191 files, 2,426 tests passed, 4 platform skips; generated/lint/types/build/package passed. PR CI pending |

## References

- [Claude Code effort controls](https://code.claude.com/docs/en/model-config)
- [Codex code review](https://developers.openai.com/codex/app/review/)
- Earlier seven-product review: [UI verification](UI_VERIFICATION.md).

Use primary sources as interaction references. Do not invent provider activity,
quota, capabilities, or benchmark claims. Actual configured effort is a setting,
not evidence of how much reasoning a model performed.

## Actual Codex use

Campaign `company-proof-61c66464-2c24-4cba-9897-8e8ff170ed48` ran through the
supported foreground CLI using the existing Codex login. Both retry-after trials
passed the independent verifier. The team exercised one recovered repair round.

| Arm | Parent | Completion | Wall time | Reported input / output tokens |
| --- | --- | --- | --- | --- |
| Single | gpt-5.6-luna · medium | 1/1 | 90.432 s | 76,674 / 3,628 |
| Team | gpt-5.6-luna · medium | 1/1 | 229.438 s | 409,620 / 7,796 |

Team implementation/repair used Terra medium; review used Luna medium.
Costs remain unknown. One pair and incomplete usage attribution are insufficient
for correctness or efficiency superiority claims. The separate website task
exports these results and keeps historical campaigns separate.

Executed candidate SHA-256:
`760393acc9f3b3b9be2bcd20c0c095a1004156fd77f3fca3777cc2503e07142f`.
It was built from base `69c0fe5` with uncommitted product changes. This evidence
does not certify later source changes or a reconstruction from the base alone.

## Remaining product limits

This is a verified alpha readiness pass, not certification of every provider,
terminal, or workload. Git commit/push/PR and worktree changes are agent-assisted
workflows; provider quota visibility depends on provider support. Effort selection
uses the live Codex catalog and starts a fresh chat. Other providers use saved
model configurations. Review/source snapshots are bounded, and original/updated
views show hunk excerpts. The actual Codex sample is intentionally small.
