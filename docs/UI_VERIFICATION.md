# Terminal design and verification

This pass aligns Recurs's repository front page with its orange terminal and
makes daily coding work easier to follow. The R opening and agent floor remain
one interface, following the earlier design decisions. The wordmark uses the
same native block lettering and ember/orange colors as the terminal.

## Product comparisons

Primary sources reviewed on September 12, 2026. These informed interaction
choices; they are not claims of feature parity or copied product designs.

| Reference | Detail considered | Recurs implementation |
| --- | --- | --- |
| [Claude Code interactive mode](https://code.claude.com/docs/en/interactive-mode) | Diff visibility, progress, keyboard access | Numbered unified/split review, original/updated excerpts, phase and elapsed time |
| [Codex features](https://developers.openai.com/codex/app/features/) and [worktrees](https://developers.openai.com/codex/app/worktrees/) | Conversation organization and explicit Git environment | Rename/pin/archive/copy, branch header, local worktree inspection, agent-assisted Git workflows |
| [Cursor Agent](https://cursor.com/docs/agent/overview) | Clear relationship between conversations, agent actions and code | Source snapshots and changes available from chat; existing execution inspector and approvals retained |
| [OpenCode TUI](https://opencode.ai/docs/tui/) | Discoverable commands, details and session control | Searchable selection lists, compact keyboard hints, bounded review modes |
| [Gemini CLI sessions](https://geminicli.com/docs/cli/session-management/) | Finding and reopening conversations | Search by label/details, persistent titles, archived chat picker, restart tests |
| [Aider commands](https://aider.chat/docs/usage/commands.html) | Direct access to source and Git operations | `/source`, `/diff`, `/workspace`, `/usage`; explicit read-only versus agent-assisted actions |
| [Goose session management](https://goose-docs.ai/docs/guides/sessions/session-management/) | Resumable work and session organization | Durable cosmetic metadata separate from execution history; archive without deletion |
| [Crush](https://github.com/charmbracelet/crush), [OpenCode](https://github.com/anomalyco/opencode), [Aider](https://github.com/Aider-AI/aider) | Repository presentation: clear purpose, actual interface, quick installation | Shared wordmark, authentic terminal captures, concise feature explanations, all install channels and support links |

## Behavioral boundaries

- Thinking is shown only for an observed reasoning event. Elapsed time stops at
  completion, cancellation or failure. A waiting connection is not labeled as
  thinking. Completed tool outcomes and patch counts remain visible.
- Patch counts describe observed successful operations in the current turn.
  `/diff` is the Git snapshot; edits that replace a line with the same text can
  make those totals differ. Failed or denied patches are not counted as applied.
- Original/updated review modes show hunk excerpts. `/source` reads full bounded
  source or an explicit line range. Review snapshots are capped and label partial
  previews. Split review falls back to unified below 90 columns.
- Chat metadata is cosmetic and does not alter execution logs. Concurrent
  metadata updates preserve independent fields. Archived chats are excluded
  from automatic reopen; exact reopening remains available. Copy uses native
  completed-conversation forks. Vendor runtime continuations cannot be copied.
- Branch and changed-file information comes from local Git. Ahead/behind uses
  local refs, without fetching. Commit, push, PR and branch selections ask the
  agent to inspect and prepare a confirmed operation; they are not direct native
  Git buttons or automatic worktree handoffs.
- Usage totals include only reported usage. Account quotas remain unavailable
  unless a connection exposes them; token totals are not substituted for quota.
- TS/JS/JSON highlighting uses the shipped lexical scanner. Other languages and
  large code blocks remain readable plain code. No color and reduced motion
  continue to work.

## Reproducible checks

`npm run check` checks generated branding, lint, types, the test suite, the
production build, documentation/install contracts and packed-package contents.

Focused regressions cover phase transitions, failed/completed patches,
header-like diff content, exact source preservation, long diffs, compact layouts,
empty and 1,000-item pickers, search cancellation, durable rename/pin/archive/copy,
concurrent metadata changes, source bounds, workspace commands and archived
startup behavior. Layouts are checked at widths down to one column and heights
down to one row; those extreme sizes preserve bounds rather than promising a
full interface.

`npm run package:smoke-terminal -- --update-capture` installs the exact archive
in a temporary home, starts a deterministic local model server and drives the
actual terminal through a PTY and VT emulator. It exercises onboarding, streamed
Markdown/code, long output, repeated resizes, draft preservation, theme and
permission dialogs, real file-edit approval, child execution/inspection, code
review modes, narrow split fallback, source and workspace inspection, usage,
chat search/rename/pin/archive/restore/copy and restart. Screenshots under
`docs/assets/terminal-*.svg` are serialized terminal cells from that run.

The fixture proves these interactions and actual local tools, not live model
quality or every vendor's sign-in, quota, and network behavior. Linux and macOS
CI also run installed-package and extension smoke tests.

## Current product pass

See [the product audit](PRODUCT_COMPLETION.md) for the fixes, installed checks,
measured rendering diagnostics, and actual Codex trial evidence. Review now has
scope and changed-file pickers. `/files` opens a numbered source viewer; `/mcp`
opens server actions. `/effort` and F4 select live supported Codex effort levels
through a new immutable chat configuration. Reconnection retains saved choices.
GitHub captures contain the rendered terminal cells without editorial captions.

## September 13 review and composer pass

The prompt has a complete orange frame and a neutral interior. Wrapping,
Unicode input, cursor placement, history, and completion stay with the existing
editor. Setup, chat, and team entry use the same composer. The parent glyph now
keeps its hierarchy level while activity animates.

Chat keeps code collapsed by default. `Ctrl+O` expands code blocks and patch
details without changing the stored transcript or draft. Tool rows use readable
labels and action glyphs; task lists remain visible. Underlined files open the
recorded read range or applied patch. The changes summary above the composer
opens all observed patches from this turn. Mouse tracking is released outside
chat and when exiting or attaching a process; the wheel scrolls the transcript. The README animation records actual PTY frames
at 100 ms intervals through approval, completion, expand, and collapse.

Explicit review opens with file names, syntax-colored source, line-number gutters, and
shaded additions/removals. `R` reveals patch metadata. `N`/`P` move between
files; changing review mode keeps the current file. The last short file can open
at its heading without being pulled back into the previous file.

The captured parser example now fixes comma-separated input handling. The
installed walkthrough checks spaces, empty input, empty entries, and Unicode
against the resulting file. It remains a deterministic UI fixture, not a model
benchmark. Captures are rendered from the installed terminal; no interface is
drawn separately for the README.

Website design references were installed at pinned revisions:

- [Anthropic frontend design](https://github.com/anthropics/skills/tree/34040c9c568585f6929bedeaad110ad08f079624/skills/frontend-design)
- [Emil Kowalski design engineering](https://github.com/emilkowalski/skills/tree/d23d7f88a2e21c9e4b1418c7abe420f5c1052ba7/skills/emil-design-eng)

The website/benchmark task owns their application and browser verification.
Benchmark results must retain failed runs and the small-task negative control;
new measurements cannot be presented as a general efficiency advantage.

Verification for this pass: the integrated suite passed 192 files / 2,434 tests
with four existing platform skips, plus generated files, lint, types, build,
package, benchmark-export and website checks. Later compact-transcript changes
received focused terminal regression checks and the installed walkthrough.
The walkthrough also checks mouse opening of read/edit/summary snapshots and
returning with the draft intact. Installed Skills/MCP/company onboarding passed.
A local 600-file review diagnostic measured 149 ms for construction plus first
render and 0.090 ms mean cached scrolling across 500 frames; these are local
rendering diagnostics, not model benchmark results.

The follow-up keeps the animated R visible while drafting and hides it on the
first submitted message. The chat-history home reserves space for the same R,
even with many saved chats, and scrolls the list instead. Only the normal editor
cursor is highlighted; typing does not tint the whole prompt. Regression tests
cover typing, submission, animation frames and a 30-chat history at 24 rows.
The updated packed-terminal walkthrough captures an unsent draft and chat
history, and supplies the 90-frame GIF and video with archive and media hashes
in `docs/assets/terminal-workflow.json`. The integrated check passed 2,516 tests
with four platform skips; the clean package-install and terminal walkthroughs
also passed. These checks do not establish live-model quality or feature parity
with other coding agents.
