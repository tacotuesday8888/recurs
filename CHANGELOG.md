# Changelog

Notable user-facing changes are recorded here when they ship.

## Unreleased

- Align the repository wordmark and real terminal captures with the default
  orange palette; simplify the front page and installation guidance.
- Add numbered unified/split code review and original/updated excerpts,
  lexical code highlighting, observed progress phases and elapsed time.
- Rename, pin, archive, restore and copy native chats; search selection lists,
  preserve archived history, and keep home navigation available after new chats.
- Show local branch context and offer source/worktree inspection, agent-assisted
  Git workflows and explicit usage availability. Improve short-terminal layouts
  and keep successful edit counts distinct from the final Git diff.

- Add `/export [path]` to save the complete durable conversation, including
  compacted turns, tool calls, and bounded tool results, as Markdown in the
  private data directory or at an explicit workspace path.
- Translate the ACP SDK 1.4 compaction updates from delegated runtimes as
  vendor-internal, keeping the Recurs durable record unchanged.
- Refresh reviewed runtime dependencies (ACP SDK 1.4.0, ws 8.21.3, yaml 2.9.1,
  zod 4.6.2) and verify that every workspace package pins the same versions
  as the published package.
- Stop a cancellation test from timing out on slow CI runners.

## 0.1.0-alpha.11 - 2026-09-09

- Add live terminal theme previews, persistent system/dark/light/contrast
  palettes, custom semantic colors, F2 access, and draft-preserving cancellation.
- Choose saved models interactively with `/model`; retain fresh-session
  confirmation and immutable existing model pins. Add `/agents routes` to
  explain configured specialist models, effort, inheritance, and eligibility.
- Preserve the active model and permissions when starting a new chat. Improve
  onboarding limit validation, effective-control summaries, missing-tool
  guidance, and recovery from an editor removing its temporary proposal draft.
- Scope team counts to the current goal, expose configured versus actual
  hierarchy, preserve distinct repeated roles, and show exact execution limits,
  usage, and recovery commands in the inspector.
- Expand source comparison to seven TypeScript CLI projects and add a
  reproducible three-case installed Recurs/Pi operational comparison. These
  fixtures test execution mechanics, not model intelligence or superiority.

## 0.1.0-alpha.10 - 2026-09-09

The unpublished alpha.9 tag is preserved. Its publication stopped on a
terminal-smoke npm 12 pack-report parsing error; alpha.10 fixes the harness
using the shared parser and pins macOS CI to the publication client.

- Start coding after model connection and permission selection; detailed Quick,
  Guided and Deep team onboarding remains available. Review full proposals in
  the terminal before approving them.
- Replace the company-floor display with a conventional team tree, Markdown
  conversation and actual execution picker. Add history scrolling, readable
  approvals, small-window layout and current model/permission status.
- Reconstruct ordinary, batch, team and company executions from durable child
  sessions. Inspect exact transcripts and artifacts; cancel an owned child and
  descendants. Keep unknown owners and unavailable vendor traces explicit.
- Add standard HTTP MCP, OAuth PKCE/refresh/logout, resources and prompts through
  the official MCP SDK; manage server lifecycle in user and project scope.
- Add skill installation from local, public HTTPS and commit-pinned GitHub
  sources, bundle resources, inspection, explicit invocation and scope controls.
- Fix process descendants surviving leader completion, OAuth credential
  confinement, unsafe OAuth endpoint discovery, and transcript mixing across
  reopened sessions. Preserve existing session/config formats and trust rules.
- Add packaged PTY acceptance with an isolated local provider and real terminal
  capture. Preserve the package size gate with name-preserving minification.
- Update test tooling for the Vitest security patch and refresh documentation
  with current ecosystem evidence and honest publication status.

## 0.1.0-alpha.8 - 2026-08-13

### Added

- The opt-in official GitHub Copilot SDK path and executable provider
  capability/readiness projections.
- Active-use release-candidate evidence now records the exact packed-artifact
  journey, current provider boundaries, public distribution integrity, and a
  bounded live Codex company run.

### Changed

- Current product documentation now uses Round 2 model-team evidence. Models:
  Auto remains insufficiently proven after one Round 2 false approval, limited
  Repair recovery, and unknown dollar cost.
- Fresh Codex setup saves the discovered Sol, Terra, and Luna alternatives but
  leaves specialist routes on the parent unless the user selects them or
  evidence-gated Models Auto applies them.

### Fixed

- Process cleanup and cancellation ordering now settles owned subprocesses
  before teardown without weakening the OS sandbox or adding retries.
- Codex onboarding no longer turns an unevaluated model-name heuristic into a
  default Implement, Review, and Repair lineup.

## 0.1.0-alpha.7 - 2026-08-06

### Added

- Interactive first run now stays inside the same terminal surface used for
  company activity and chat.
- The packed-package release gate now proves an empty-home journey from Quick
  company formation through layered implementation, independent review,
  finding-driven Repair, synthesis, approved apply, and external verification.

### Changed

- Company activity presents only agents that actually activate, with durable
  role, route, state, and usage evidence carried into the terminal view.
- Current product documentation distinguishes deterministic installed proof
  from real-provider model-quality evidence.

### Fixed

- A completed Repair that makes no material change now stops truthfully as
  stalled instead of paying for a redundant review of identical content.

## 0.1.0-alpha.6 - 2026-08-05

### Added

- Private exact-workspace permission rules and observe-only lifecycle hooks
  provide auditable local policy and integration seams without expanding
  project or agent authority.
- Coding-plan onboarding now covers the reviewed Kimi Code, OpenCode Go,
  Alibaba Coding Plan, and MiniMax Token Plan policies alongside existing
  local, BYOK, and Codex subscription paths.
- Durable Company Proof reports now separate shared parent-boundary failures
  from roster evidence and expose Review outcomes and Repair recovery without
  claiming a model winner.

### Changed

- Interactive tool approvals now distinguish one-time access from an exact
  session-scoped grant while continuing to deny by default.
- Live team activity reports failed and cancelled children truthfully and
  surfaces review verdicts, findings counts, phase changes, and candidate
  readiness without exposing raw evidence.
- A valid structured change request proceeds directly to Repair instead of
  spending another reviewer on a decision that cannot reverse the outcome.
- Approved onboarding hands its first goal to `/goal launch`, reports real
  model/tool readiness, and keeps unavailable capabilities visibly blocked.
- Routed child activity shows the activated model, effort, route rationale,
  usage, and one truthful terminal outcome without duplicate activation lines.

### Fixed

- Repair instructions now preserve the bounded `run_verification` tool while
  continuing to prohibit arbitrary process execution, network access,
  credentials, and deployment.

## 0.1.0-alpha.5 - 2026-08-01

### Added

- `recurs data path` reports the active durable-data directory without reading
  or deleting it, with a stable JSON form for scripts.
- Interactive slash-command completion includes canonical commands, aliases,
  and the local image-staging command.
- A concise privacy and local-data policy plus channel-specific upgrade,
  uninstall, retention, and deletion guidance.

### Changed

- The GitHub and terminal wordmarks now share a centered, forward-slanted
  pixel identity while operational output remains left-aligned.
- Public documentation reflects the shipped npm, curl-installer, Homebrew, and
  Bun-as-installer paths and distinguishes all of them from the Node runtime.
- Release checks now reject stale current-version and distribution claims.

## 0.1.0-alpha.4 - 2026-07-30

### Fixed

- Release recovery now accepts the exact scalar JSON emitted by npm 11 and the
  one-element array emitted by npm 12 while rejecting ambiguous registry
  responses.
- Trusted publication uses an explicit filesystem package path so npm 12
  cannot interpret the release directory as a Git dependency shorthand.

### Security

- Subsequent npm releases use the repository-bound trusted publisher with
  provenance. Traditional token publishing is disabled for the package.

## 0.1.0-alpha.2 - 2026-07-30

### Added

- Source-installable coding-agent CLI with durable sessions, permissions,
  provider routes, bounded sub-agents, isolated implementation, independent
  review, repair, recovery, and explicit apply.
- Tailored company onboarding, versioned operating modes, company-goal
  execution, evidence-backed model-team selection, and deterministic plus
  configured-provider evaluation.
- Prepared npm, checksum-verifying curl, and Homebrew release assets derived
  from one exact package archive.
- Pinned Linux compatibility smoke for installing that npm archive globally
  with Bun while retaining Node.js as the runtime.

### Known limitations

- There is no Homebrew tap, signed binary, native Bun runtime, Windows
  subprocess containment, or desktop app.
- One live comparison pair per built-in scenario is not enough evidence to
  recommend a universal default model lineup.

See [Public Alpha Status](docs/PUBLIC_ALPHA.md) for the current evidence and
release boundary.
