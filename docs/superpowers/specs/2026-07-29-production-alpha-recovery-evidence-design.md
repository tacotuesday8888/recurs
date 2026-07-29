# Production Alpha Recovery And Evidence Hardening

**Status:** Approved implementation direction

**Goal:** Close the concrete durability, least-authority, recovery,
discoverability, and evidence-honesty gaps found by the 2026-07-29
architecture, reliability, and product audits without replacing Recurs's
existing agent engine or introducing a speculative router.

## Starting evidence

At `15a2c9fad899cfb1101a1ee893e772348f9e1db6`, `main` matches
`origin/main`, the canonical checkout is clean, and a fresh install passes:

- 152 test files;
- 1,775 passing tests and 4 intentional skips;
- TypeScript contract checks, build, package checks, release-contract checks,
  and the deterministic company evaluation smoke.

The audits agree that the base harness is substantive: the pinned AgentLoop,
permissions, durable child and team execution, isolated worktrees, independent
review and repair, company formation, company-goal DAG execution, provider
routing, and benchmark recording are real. This milestone hardens specific
seams; it is not a harness rewrite.

## Design principles

1. Preserve public and on-disk compatibility unless a versioned contract is
   required.
2. Reuse the existing mutation lease, `CompanyGoalSupervisor`,
   `JsonlCompanyGoalStore`, benchmark stores, provider routes, and permission
   engine.
3. Make automatic behavior fail closed. Missing evidence means explicit
   routing or the parent, not a guessed company activation.
4. Use typed authority at execution boundaries. Presentation strings are not
   permission tokens.
5. Keep human control local, manual, user-present, and Act-only for recovery
   or workspace mutation.
6. Do not claim that structural success proves comparative quality.

## Slice A — session journal repair

Ordinary session reads currently repair an incomplete trailing record by
rewriting the journal without the writer lease. A reader can therefore race an
append and replace the file beneath the writer.

Public `load`, `loadState`, and `list` retain their compatible auto-recovery
behavior, but recovery becomes a two-stage operation:

1. read without mutation;
2. on a private typed incomplete-tail signal only, acquire the existing
   session mutation lock;
3. re-read under that lock;
4. truncate only the non-durable suffix, sync the file, and release.

Callers already holding the mutation lock use a private under-lease loader and
never recursively acquire it. Read-only APIs never mutate. Middle corruption,
newline-terminated corruption, invalid UTF-8, version errors, and sequence
errors remain fail-closed.

PID reuse in the directory-lock implementation is explicitly outside this
slice. It can cause a stale lock to remain busy but cannot steal a live
writer's UUID-owned lock. Node has no safe portable process-birth identity for
both macOS and Linux; a timeout or heartbeat would risk dual writers and is not
an acceptable shortcut.

## Slice B — benchmark least authority

Configured benchmarks currently turn a confirmation presentation string into
authority. Any `Allow shell access to ...?` text can be accepted.

`createStandaloneRuntime` will accept an optional internal typed approval
handler. Normal CLI operation retains the current human confirmation adapter.
The benchmark supplies a policy over `PermissionIntent`, permitting only:

- exact fixed team-candidate apply;
- exact fixed Git worktree orchestration; and
- exact built-in fixture verification commands required by the immutable
  scenarios.

Every other shell, network, credential, external-path, package-install,
environment, destructive, or unknown intent is denied. The benchmark records
the ordinary denial through existing events. The old string classifier is
removed.

## Slice C — durable company-goal recovery

`CompanyGoalSupervisor.resume()` already reconciles completed durable child and
team work, but assembly discards the supervisor after registering its tools.
The product therefore cannot resume the owning company-goal journal.

Assembly will retain the supervisor and expose a narrow command service:

- `/company resume <run-id>` accepts only an exact run belonging to the current
  parent session and immutable approved blueprint revision;
- the command is local, manual, user-present, Act-only;
- non-Full-Access sessions require explicit confirmation for reviewed
  candidate application;
- the existing supervisor revalidates session, project, backend, operating
  mode, permission, plan, budget, blueprint, and lower-level durable state;
- terminal completion is idempotent and failed/cancelled state stays truthful.

The supervisor—not only the CLI—will prevent duplicates. Start and resume take
the existing durable parent/run owner lease in a company-specific root, then
list the exact parent and blueprint revision while holding that lease. If a
created, running, waiting, or interrupted sibling already exists, no new
journal, provider request, child, team, or event is created. Legacy state with
multiple unresolved siblings fails closed for manual inspection. The
process-local active-run map remains a handoff lookup, not ownership authority.

`/goal <objective>` also performs an early exact check so it can give the user
the actionable `/company resume <id>` or `/company run <id>` command without
spending a model request. The supervisor check remains authoritative against
TOCTOU and cross-process launches.

There is no automatic background restart and no fresh provider request during
startup.

## Slice D — blueprint activation is executable policy

The blueprint's root and independent reviewers are already mandatory.
`defaultActiveRoleIds` and per-role `activation`, however, are currently
display-only.

The smallest enforceable policy is:

- the root remains implicit;
- only `defaultActiveRoleIds` are runnable in this alpha;
- every non-root default-active role must have an assignment;
- a non-default `on_demand` role is visible as inactive roster capacity but
  cannot be activated by model-authored plan prose;
- mandatory independent review cannot be removed;
- existing role, delegation, depth, concurrency, request, retry, cost, tool,
  and permission limits continue to apply.

The deterministic stable-company compiler will keep only the minimum default
executable spine—root, implementation, and independent review—in every mode.
The operating-mode role count is a ceiling rather than a target; optional
roster capacity remains inactive until a future explicit activation surface.
Historical goal records remain loadable, but a stored plan using a non-default
role fails policy validation before resume or execution. This milestone will
not turn model output into authority.

Execution support is validated against the product that actually ships:
`explore_v1` and `review_v1` can run as direct children, while
`implement_v2` and independent-review `review_v2` run through the paired team
engine. Standalone `implement_v1`, `repair_v1`, and non-anchor `review_v2`
assignments are rejected before work begins. Conditional Repair may use only a
repair-capable role already represented by an active implementation
assignment; the runtime never searches the inactive roster for extra
authority.

Implementation and review are sequential phases inside one durable team.
Company concurrency accounts for the maximum simultaneously active phase, not
the count of both durable assignment records, so Economy can run one builder
then one reviewer without exceeding its concurrency of one. If review requests
changes and the approved company correlation contains no Repair authority, the
team reserves no repair capacity and terminates truthfully as
`changes_requested`; it does not widen authority or spend a doomed repair
request.

## Slice E — Auto evidence honesty and fail-closed routing

Current Models Auto ranks structurally successful completed company goals. It
does not compare those lineups with a parent-only baseline, so “strongest” and
“best” are unsupported.

This milestone makes the existing separation explicit:

- **recorded lineup evidence:** a configured company goal completed with the
  required structural evidence;
- **comparative benchmark evidence:** immutable paired attempts and
  comparability, without a winner in V1.

Models Auto may still apply the most-supported eligible **recorded configured
lineup** after local confirmation. The CLI and documentation will not call it
strongest, best, benchmark-winning, or universally evaluated. Routes not
observed during a run—especially Repair—are described as configured fallbacks,
not proven performers.

Benchmark V1 remains intentionally non-prescriptive. It requires repeated
comparable pairs and exact hidden-verifier, integrity, route, blueprint,
harness, and launch-protocol evidence, but it does not contain a winner
contract. A future versioned recommendation can count every paired attempt and
define freshness, ambiguity, and strict-advantage policy after sufficient real
evidence exists.

General goal routing does not infer task type from keywords. Company versus
parent remains explicit/approved-blueprint driven. Within an approved company,
Review remains mandatory and Repair remains selectively activated only after
`changes_requested`.

## Slice F — product truth and discoverability

The flagship `/company` surface is registered but missing from interactive
help and the common CLI examples. It will be listed with status, operations,
run inspection, and resume examples.

First-run copy will state that company formation is optional. When onboarding
finishes without an active roster, the summary will say how to return:
`recurs setup`. No choices, security boundaries, or flow semantics change.

Company operations will calculate totals, unresolved/current state, and live
roles from the complete durable history, then cap only the recent-history
projection. Interrupted runs do not depict stale running-shaped assignments as
active. Public help will advertise only real commands and will distinguish
selected/current route snapshots from comparative recommendations.

## Verification and delivery

Each behavioral slice starts with a failing focused test, lands as a focused
commit, and receives an independent review. Final proof includes:

- repeated focused race/permission/recovery tests;
- the complete `npm run check`;
- installed npm package smoke and pinned Bun installer smoke;
- safe offline company formation and goal execution;
- a safe, bounded real Codex onboarding/company-goal dogfood when the installed
  subscription runtime remains available;
- diff, generated-file, and secret inspection;
- independent correctness, security, and product-truth reviews;
- PR checks on Linux, macOS, and Bun;
- merge and non-destructive synchronization of local and remote `main`.

Public npm, curl, or Homebrew publication remains an owner-controlled release
event. This milestone proves the repository artifacts and workflows; it does
not silently publish a package.

## Explicit non-goals

- Rust or Ratatui rewrite;
- desktop UI;
- a second agent engine or planning framework;
- keyword-based “smart” routing;
- unbounded recursion, concurrency, retries, or spend;
- automatic MCP/Skill installation;
- PID-lock reclamation based on timeouts;
- public package publication without explicit release authority.
