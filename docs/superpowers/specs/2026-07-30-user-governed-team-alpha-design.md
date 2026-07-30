# User-Governed Team Alpha

**Status:** Approved product direction; implementation design for Recurs
`0.1.0` public alpha.

## Outcome

Recurs will ship a truthful public alpha where a user can form, constrain,
inspect, and run a bounded coding team. The default remains simple:

```text
Team         Balanced
Models       Auto
Roster       Recommended
Authority    Approved for Me
```

Advanced users can narrow the team size, concurrency, delegation depth,
workflow shape, escalation path, review requirement, repair attempts, request
ceiling, and reported-cost ceiling. These controls affect real execution and
can never expand the selected operating mode, approved company blueprint,
parent permissions, model eligibility, or tool authority.

The release goal also proves the complete Codex-backed journey, tunes it from
repeatable evidence, aligns the terminal and repository with implemented
reality, and publishes one verified artifact through npm, Bun installation,
curl, Homebrew, and GitHub Releases.

## Scope decomposition

This release goal contains four ordered milestones. They are one product
journey but remain separate reviewable pull requests:

1. **User-governed team policy:** the new implementation slice described in
   detail below.
2. **Real-provider proof and tuning:** use the existing immutable Company Proof
   fixtures and benchmark machinery; change orchestration only when repeated
   evidence identifies a concrete problem.
3. **Product presentation:** make onboarding, status, documentation, and
   troubleshooting communicate the proven behavior without redesigning the
   terminal interaction model.
4. **Public distribution:** execute the existing guarded release design and
   runbook after all product gates pass.

Persistent workers, a desktop client, autonomous deployment, arbitrary
peer-to-peer agent chat, silent self-modification, a marketplace, native Bun
execution, and unbounded recursive delegation remain outside this release.

## Product language

The primary promise is:

> **The best coding model is a team. You control the team.**

“Open-source deep-work mode” is a useful category comparison, not the product
name. Recurs will initially describe itself as project-adaptive, not as the
first self-improving coding harness. The implemented adaptation loop learns
attributable project facts, evaluates completed team configurations, and
proposes approval-gated future changes; it does not silently rewrite its own
code, prompts, skills, policies, or authority.

## Existing foundation

The implementation extends rather than replaces:

- versioned Economy through Max operating policies;
- immutable Company Blueprint V2 roles, reporting lines, delegation edges,
  activation rules, tool bundles, and model routes;
- validated company-goal assignment DAGs;
- permission monotonicity and shared request/reported-cost accounting;
- isolated implementation, independent review, bounded repair, staging, and
  explicit apply;
- durable sessions, leases, recovery, cancellation, normalized events, and
  historical policy snapshots; and
- evidence-backed Models Auto plus repeatable Company Proof fixtures.

The missing layer is a user-owned policy that narrows these existing
authorities and a concise CLI surface for inspecting and changing that policy.

## Team-control contract

Add a strict, versioned `TeamControlPolicyV1` contract with:

- `topology`: `recommended | focused | parallel | hierarchical |
  research_heavy | review_heavy`;
- `maxActiveAgents`;
- `maxConcurrentAgents`;
- `maxDelegationDepth`;
- `escalation`: `manager_only | root_allowed`;
- `independentReview`: `required | when_planned`;
- `maxRepairRounds`;
- `maxRequests`; and
- `maxReportedCostUsd`.

Stable identifiers are storage values. Display labels remain replaceable.
Unknown fields, invalid numbers, unsafe widening, and unsupported versions fail
closed.

The policy is a user preference for future work, not retroactive authority.
Every company goal freezes:

1. the operating-mode policy and version;
2. the approved blueprint and revision;
3. the selected `TeamControlPolicyV1`; and
4. the effective intersection used for execution.

Historical goals always retain their original snapshot.

### Effective-policy intersection

The effective policy is the minimum authority allowed by:

1. the parent session;
2. the selected operating mode;
3. the approved company blueprint;
4. the user’s team-control policy; and
5. the current execution profile.

Changing an operating mode may make a saved team policy invalid. Recurs must
show the mismatch and require an explicit reset or edit; it must not silently
widen or reinterpret the policy.

The `recommended` topology preserves the existing planner behavior. Other
topologies are bounded planner constraints:

- `focused`: prefer the smallest valid implementation and review path;
- `parallel`: permit independent ready assignments up to the concurrency
  ceiling;
- `hierarchical`: require delegation and reporting through approved lead
  roles;
- `research_heavy`: permit the maximum read-only exploration allowed by the
  effective policy before implementation; and
- `review_heavy`: require independent review and use the effective reviewer
  and repair ceilings.

These are constraints and preferences, not promises to activate every
available role.

## Communication model

Recurs will not add unrestricted agent chat. Communication remains structured
and attributable:

- a manager assigns work down an approved `delegatesTo` edge;
- a child returns results, evidence, or a blocker through `reportsTo`;
- an independent reviewer reports findings to the root orchestrator;
- `manager_only` restricts upward messages to the direct manager;
- `root_allowed` permits a bounded blocker escalation to the root while
  retaining the direct manager and full provenance; and
- dependency handoffs pass immutable evidence references, not shared mutable
  conversation state.

No communication changes permissions, tools, models, budget, delegation
edges, or assignment scope.

## Storage and lifecycle

Use the existing private durable-state patterns:

- strict canonical JSON;
- private directories and files;
- atomic publication;
- revision checks;
- immutable run snapshots; and
- bounded text and collection sizes.

Add a private `TeamControlPolicyStore` keyed by the canonical working-root
identity. It publishes the current project preference with an optimistic
revision. Completed goal authority belongs in the immutable company-goal
record, so a preference change applies only to subsequently created goals.

The default policy is derived deterministically from the current operating
mode and `recommended` topology. A new installation therefore gains no new
configuration burden.

## CLI experience

Keep `/agents` as the canonical surface rather than adding a competing command.

```text
/agents
/agents controls
/agents configure
/agents reset
/agents mode balanced
```

`/agents` continues to summarize active policy and operations.
`/agents controls` shows the saved policy, hard ceilings, and effective
values. `/agents configure` is a short interactive editor with validation
before publication. `/agents reset` restores the deterministic recommended
policy for the current operating mode.

The guided onboarding Team step continues to ask only for Economy through Max
by default, then offers optional advanced controls. It does not expose raw JSON
or require users to understand the assignment DAG.

Company proposal review continues to expose roles, reporting lines, and
delegation relationships. YAML remains the advanced roster-editing surface.
The team-control policy does not duplicate or mutate that blueprint.

Before a goal starts, Recurs displays a concise frozen summary:

```text
Team        Balanced · hierarchical
Limits      6 active · 3 concurrent · depth 2
Escalation  manager only
Review      independent · 1 repair
Budget      64 requests · $3 reported maximum
```

Runtime activity shows only activated agents, exact model assignments,
structured handoffs, review/repair state, and usage. Inactive roster members
must never appear to be working.

## Runtime integration

The parent remains the only authority that creates a company goal. Goal
planning receives the frozen effective policy and must produce a plan that
satisfies both the approved blueprint and topology constraints.

Validation occurs twice:

1. before any assignment starts; and
2. when each assignment is claimed, using the immutable run snapshot and
   shared ledger.

The existing `CompanyGoalSupervisor`, `TeamRunSupervisor`,
`CompanyAgentManager`, permission engine, route selection, capability
intersection, and event contracts remain the execution seams.

The implementation must not create a second scheduler or parallel budget
system. Team controls narrow values already consumed by those authorities.

## Failures, interruption, and recovery

- Invalid or widening configuration is rejected before publication.
- A goal plan that violates topology or communication rules starts no child.
- Budget exhaustion prevents new assignments; already-running work is reported
  truthfully.
- Unknown provider cost remains unknown and is never represented as zero.
- Cancellation propagates through the existing supervisor and owned processes.
- Interruption leaves the immutable effective policy available for exact
  resumption.
- A changed current policy never alters an interrupted historical run.
- A blocked escalation is recorded as a blocker, not silently rerouted.
- Corrupt or tampered durable state fails closed with actionable recovery
  guidance.

## Adaptation boundary

After a completed goal, existing evidence and learning services may:

- retain attributable project knowledge;
- score the exact configured model lineup;
- summarize activation, review value, repair, latency, and usage; and
- propose a future team-control or blueprint amendment.

No proposal becomes active without user approval. Automated comparison may
recommend a narrower or different topology only after repeated compatible
evidence. It may never recommend wider permissions or tool authority.

## Verification

Focused contract tests cover:

- exact parsing and version rejection;
- every topology;
- operating-mode intersection;
- permission and budget non-escalation;
- invalid depth, concurrency, review, repair, and cost combinations; and
- immutable historical snapshots.

Runtime tests prove:

- focused, parallel, and hierarchical assignment behavior;
- read-only research-heavy planning;
- mandatory review-heavy execution;
- manager-only and root-allowed escalation;
- claim-time policy enforcement;
- shared accounting;
- cancellation, interruption, and resumption; and
- no authority changes after a current-policy edit.

CLI and onboarding tests cover:

- defaults requiring no extra input;
- inspection, configuration, reset, and validation;
- clear hard-ceiling versus effective-value rendering; and
- visible activated roles, routes, rationale, and usage.

Security tests prove:

- the overlay cannot widen permissions, tools, routes, billing eligibility, or
  blueprint delegation edges;
- untrusted model output cannot publish control policy;
- escalation carries bounded attributable data; and
- private durable state remains outside repository artifacts.

After focused suites, run `npm run check`, npm installed-package smoke, the
pinned Bun installation smoke, and supported-platform CI.

## Real-provider proof

Use the existing immutable fixtures and explicit user-present Codex connection.
For every built-in scenario, run at least three alternating pairs for:

1. the strong parent-only baseline;
2. the selected configured company; and
3. one authorized alternative team.

Report pass rate, hidden-verifier result, activated roles, review findings,
repair rounds, wall time, requests, input/cached/output tokens, and
provider-reported cost when available. Do not publish a universal model or
team winner unless the evidence supports that exact claim.

Tune context, activation, review, or topology only from reproducible failures
or material measured waste. Preserve raw evidence privately and publish only
sanitized reports.

## Presentation and release

Presentation work updates the existing README, CLI guide, feature status,
public-alpha status, security explanation, troubleshooting, and release notes.
It must preserve the established terminal interaction model and distinguish
implemented, bounded, prepared, and planned behavior.

The release uses the existing single-artifact chain:

1. build and verify the npm tarball;
2. publish that exact package through the protected npm workflow;
3. derive the checksum-verifying curl installer and Homebrew formula from the
   same archive;
4. publish matching GitHub assets, checksums, and attestations; and
5. smoke clean npm, Bun installation, curl, and Homebrew paths with Node.js as
   the runtime.

Publication remains owner-controlled. A missing npm bootstrap, environment
approval, or registry credential blocks only the external publication step;
it must not weaken release verification or cause secrets to enter the
repository.

## Delivery and acceptance

Work proceeds through isolated feature branches, focused commits, pull
requests, green Linux/macOS CI, merge, and clean synchronization of local and
remote `main`.

The release goal is complete when:

- user controls alter real bounded team execution;
- the full Codex-backed onboarding-to-apply journey passes;
- repeated evidence and limitations are published truthfully;
- repository and terminal documentation match the code;
- the exact package is installable through npm, Bun installation, curl,
  Homebrew, and GitHub Releases;
- canonical `main` is clean and equals `origin/main`; and
- no completed feature commit remains stranded in another worktree.
