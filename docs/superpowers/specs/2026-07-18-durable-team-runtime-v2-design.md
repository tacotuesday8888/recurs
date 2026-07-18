# Durable Team Runtime v2 Design

**Status:** Approved for implementation by the user's explicit direction to set an aggressive goal and continue without intermediate approval stops.

## Purpose

Turn the existing foreground `delegate_team` proof into a durable, inspectable,
bounded Recurs team runtime. The runtime must survive ordinary process restarts
truthfully, support useful process-lifetime background work, repair valid review
findings within hard limits, and keep every child on the existing coordinator,
provider, permission, session, and event seams.

This milestone does not build a desktop company UI, a daemon, cloud workers, or
deep recursive delegation. The child depth ceiling remains one.

## Current foundation

Team v1 already supplies the important execution primitives:

- durable parent and child version-2 sessions;
- Explore, Implement, and Review profiles with monotonic permissions;
- one shared per-turn child/request/reported-cost budget;
- clean detached Git worktrees for parallel Implement workers;
- bounded, hash-addressed text patch capture and deterministic integration;
- exact checkpoint rollback on ordinary integration failure;
- strict adaptive review and normalized child/team events.

The audit found three blocking design gaps. Team phase and patch ownership are
process-local, so an abrupt exit cannot recover an integration. Review runs in
the dirty parent and may execute a child-modified package script, creating
unreported changes. Startup session selection can also pick a newer child that
shares the parent's backend pin. V2 must correct all three before adding more
autonomy.

## Approaches considered

### 1. Store team progress in the parent session log

Rejected. `BackendRunCoordinator` holds the parent session mutation lease for
the whole parent turn. Background workflow appends would contend with that
lease and mix conversational turn invariants with independently advancing team
state.

### 2. Add a separate durable team journal and in-process supervisor

Chosen. A small append-only, sequenced journal under project data owns team
state. The supervisor uses the existing `ChildAgentManager` and
`BackendRunCoordinator`, stages candidate changes outside the parent, exposes
foreground/background control, and recovers incomplete work conservatively.
This provides a complete local vertical without inventing another model loop.

### 3. Launch a daemon that continues after the CLI exits

Deferred. A daemon needs signed distribution, enforceable process/filesystem/
network containment, credential delegation, upgrade coordination, and a much
larger ownership protocol. Pretending an in-process promise is a daemon would
be dishonest. V2 calls its mode `background` only while the Recurs process is
alive; after restart an active run becomes `interrupted` and can be resumed
from a safe boundary.

## Architecture

### Durable contracts and policy

Add versioned team-run contracts in `@recurs/contracts`. A run freezes:

- team/run ID and schema version;
- root parent session and agent IDs;
- exact operating-mode ID/version and policy envelope;
- parent backend pin and provider-neutral routing decisions;
- parent execution/permission ceiling and trusted invocation classification;
- canonical repository root and exact base revision;
- bounded implementation tasks and review instructions;
- foreground/background execution choice;
- child/request/reported-cost allocation;
- child attempts, review rounds, repair rounds, artifacts, evidence, and safe
  failures.

New version-4 Economy, Standard, Balanced, Performance, and Max policies retain
stable non-display IDs. They add an explicit maximum repair-round count and a
worst-case team budget. V1-V3 IDs retain their historical values. Repair rounds
are new depth-one sibling children, not recursion or retries of a terminal
child.

Add stable `implement_v2`, `review_v2`, and `repair_v1` profiles for v4 teams.
They can read, edit through Recurs's bounded patch tool where appropriate, and
inspect Git state, but they cannot launch repository code or arbitrary commands.
The stricter review-v2 output contains bounded structured findings with a
workspace-relative path (or a whole-change marker), problem, acceptance
condition, and evidence. An approval must contain no repair findings. Invalid
or failed review output is `unverified` and never triggers repair.

### Team journal

`JsonlTeamRunStore` is a separate project-data store with mode-0700 directories,
mode-0600 logs, strict IDs, exact record validation, monotonic sequences,
fsynced appends, and the existing cross-process lock/fencing primitive. It
provides create, append, load, list, and recovery queries.

The reduced state machine is:

```text
created -> running(implement) -> running(stage) -> running(review)
        -> running(repair) -> running(review) ...
        -> ready_to_apply -> applying -> approved
        -> changes_requested | unverified | failed | cancelled | interrupted
```

Only a valid `changes_requested` review can enter repair. Every loop is bounded
by the frozen v4 policy. Cancellation intent is durable and is checked before
every child, staging, review, repair, and apply boundary. Terminal states cannot
restart except `interrupted`, whose resume creates new sibling attempts while
retaining the original history.

Raw patch bodies are not written to the team log or events. Task prompts and
review instructions are persisted because deterministic resume needs them;
they stay in the local mode-0600 journal and are never rendered by list/status
surfaces.

### Staging and patch ownership

All v4 candidate work happens in a dedicated detached staging worktree at the
exact parent `HEAD`:

1. Implement children work in independent detached worktrees.
2. Recurs captures and validates their artifacts.
3. Recurs materializes artifacts in declared task order into the staging
   worktree, never the parent.
4. Review children inspect staging with `review_v2`. V4 Implement, Review, and
   Repair profiles do not execute repository code because the repository can
   change its own scripts and the current host has no OS containment.
5. A bounded Repair child may edit the same staging worktree from structured
   findings. Review then runs again.
6. Recurs captures one cumulative final artifact against the original base.

Patch artifacts become file-backed, content-addressed project data so an
approved background candidate can survive process restart. Every load rechecks
the handle, base revision, repository binding, byte length, path set, and SHA-
256 digest. Initial worker artifacts are deleted after a cumulative candidate
is safely captured; final artifacts are deleted only after apply or explicit
terminal cleanup.

Worktree ownership remains temporary. Startup reconciles only directories under
Recurs's private worktree root and removes stale Git registrations/directories
whose owning process is gone. It never scans or deletes arbitrary user paths.

### Foreground and background behavior

`delegate_team` keeps foreground as the default. Foreground uses the same
durable supervisor, waits for review/repair, and applies an approved cumulative
artifact before returning.

`execution: "background"` returns after the durable run is claimed. Background
work may edit through bounded Recurs file tools, stage, review, and repair, but
it never launches repository code or mutates the parent.
An approved background result stops at `ready_to_apply`; a later explicit
`apply_team` action performs the parent transaction while the normal CLI is
idle. Background is initially limited to eligible direct model-provider pins,
local/manual invocation, the v4 no-process profiles, and `full_access` so no
interactive approval is deferred beyond the initiating turn. External,
sensitive, credential, network, and deploy intents remain denied by the exact
profile even under `full_access`. Subscription/coding-plan paths whose policy
requires foreground presence fail closed.

Control surfaces are deliberately small:

- model tools: `delegate_team`, `team_status`, `wait_team`, `cancel_team`,
  `resume_team`, and `apply_team`;
- CLI: `/agents teams`, `/agents team <id>`, `/agents wait <id>`,
  `/agents cancel <id>`, `/agents resume <id>`, and `/agents apply <id>`.

Every lookup is scoped to the active parent session. Exact IDs are required for
mutation. Waits are bounded and cancellation-aware.

### Apply transaction and crash recovery

Parent apply is a two-phase transaction:

1. verify the exact parent role, cwd, backend/policy binding, clean base
   revision, candidate handle, and cancellation state;
2. capture a durable checkpoint and append `apply_prepared` before mutation;
3. apply the cumulative artifact and validate the complete dirty path set;
4. complete the checkpoint and append `apply_committed`;
5. emit presentation events best-effort and delete the artifact.

If Recurs restarts after `apply_prepared`, recovery compares the canonical
parent diff with the candidate. An exact match completes the journal
idempotently; an unchanged clean base returns to `ready_to_apply`; any other
state becomes `interrupted` with `manual_attention_required` and is never
silently overwritten or called approved.

Presentation sink failures cannot change durable execution truth. Events are
best-effort projections after a journal transition; failures are sanitized and
do not make an applied team look failed.

### Provider-neutral role routing

Add a small routing contract that selects an eligible backend candidate for
Implement, Review, or Repair from capability facts rather than model brands.
Eligibility covers execution mode, host-tool control, background policy,
permission support, billing policy, and connection readiness. The frozen run
records the decision and why it fell back.

The current production assembly exposes only the parent's immutable pin as a
trusted candidate, so all live v2 children still inherit it. This is real and
truthful: the router enforces capability gates and records `inherit_parent`, but
the CLI does not imply that independent model routing is available until the
connection registry can supply reviewed role candidates. Tests exercise the
provider-neutral selection contract with deterministic candidates.

### Accounting and events

The journal is authoritative for started children, reserved/used requests,
reported provider cost, review/repair rounds, and final evidence. Counters are
monotonic and bounded by the frozen allocation. Unknown cost remains unknown;
it is never reported as zero. Reported-cost ceilings prevent subsequent work
but cannot claim to meter a provider/runtime that supplies no cost telemetry.

Normalized team events add run sequence, phase, attempt/round, routing, repair,
ready-to-apply, apply, interruption, and recovery facts. Child events retain
team/run correlation. Events never contain prompts, patch bodies, private
worktree paths, credentials, or account configuration.

## Failure and cancellation semantics

- The lowest input index is the canonical top-level implementation failure;
  wall-clock completion order cannot change the reported cause.
- One worker failure aborts siblings, releases all reachable leases, and leaves
  the parent unchanged.
- A valid change request repairs only while rounds and complete child/request/
  cost capacity remain. Exhaustion returns `changes_requested`.
- Invalid/failed reviews return `unverified`; they do not repair or apply.
- Cancellation propagates to active children and prevents the next phase. A
  background candidate already `ready_to_apply` can be cancelled and discarded
  without touching the parent.
- A process exit turns non-stable running phases into `interrupted`. Resume
  starts new sibling attempts at depth one; it never reuses a terminal child
  session or stale authorization.
- A dirty or revision-drifted parent causes apply/resume to fail closed.

## Security invariants

- Child permissions and execution mode never exceed the root parent.
- Child depth remains one; children never receive delegation tools.
- Review is read-only and cannot execute changed repository code until an
  enforceable containment layer exists.
- Background cannot depend on interactive approval or a foreground-only billing
  entitlement.
- Artifact and worktree paths are canonical, bounded, credential-denied, and
  owned under private project data.
- Parent mutation occurs only during explicit apply behind exact validation and
  checkpointing.
- No event or normal status output includes task prompts or patch content.

## Verification

Use test-first slices for:

- v4 policy/profile/routing contracts and historical replay;
- strict team record validation, sequencing, locking, recovery, and corruption;
- file-backed artifact integrity, staging, cleanup, and restart loading;
- root-session selection and interrupted-child reconciliation;
- foreground success, background ready/apply, wait/cancel/resume, permission and
  billing denial;
- structured review, repair success/exhaustion, unverified no-repair, cost and
  child/request limits;
- crash boundaries before/after apply preparation and mutation;
- event-sink failure, deterministic failure selection, conflict/no-parent-
  mutation guarantees, and complete end-to-end synthesis;
- full TypeScript verification and all relevant native checks, with unchanged
  host-blocked PTY suites reported honestly.

## Intentionally absent after v2

- a daemon or work that survives CLI exit without interruption;
- depth greater than one or child-created children;
- automatic task decomposition or a speculative company org chart;
- uncontained unattended arbitrary commands;
- silent apply, auto-commit, push, PR, deploy, or external messages;
- automatic provider ranking by brand or undocumented subscription reuse;
- claims that unknown provider cost is enforced exactly.
