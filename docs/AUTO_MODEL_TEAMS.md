# Auto Model Teams And Simple Controls

**Status:** Alpha implemented for one `general_coding` task class. The
operating policies, bounded sub-agent runtime, tailored rosters, explicit role
routes, permissions, budgets, immutable configured-goal evaluations, and
evidence-backed model-team selection exist. Automatic task classification,
freshness expiry, price optimization, and a published default winner do not.

## Product idea

Recurs should make a deep multi-agent coding run feel simple:

```text
Team size     Balanced
Models        Auto
Roster        Recommended
Permissions   Approved for Me
```

The user chooses how much sub-agent capacity is available. Recurs activates
only the roles the task needs and, when supported by evidence, assigns the
most-supported eligible recorded configured lineup. That selection is not a
comparative winner.

The product metaphor is an agent company. The technical mechanism is a bounded
team of sub-agents.

## Inspiration

These products are useful internal references, not required public positioning:

- [Claude Code Ultracode](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code)
  combines `xhigh` reasoning with automatic dynamic workflows.
- [Codex Ultra](https://learn.chatgpt.com/docs/agent-configuration/subagents#choosing-models-and-reasoning)
  combines maximum reasoning with proactive sub-agent delegation on supported
  accounts and models.
- [Cursor Router](https://cursor.com/blog/router) classifies a request and
  selects one model according to task, context, complexity, and the chosen
  cost/intelligence tradeoff.

The corresponding Recurs direction is:

> Cursor Router chooses one model. Recurs Auto chooses the most-supported
> eligible recorded configured lineup that powers a bounded sub-agent team.

## One primary intensity control

The current operating modes should become one clear segmented slider:

```text
Economy ─── Standard ─── Balanced ─── Performance ─── Max
                              ●
```

The selected mode remains a versioned policy, not a cosmetic preference. It
controls ceilings for active roles, concurrency, delegation depth, research,
requests, review, repair, eligible billing classes, and reported cost.

| Mode | Active-role ceiling | Concurrent assignments | Depth | Reported-cost ceiling |
| --- | ---: | ---: | ---: | ---: |
| Economy | 3 | 1 | 1 | $0.25 |
| Standard | 5 | 2 | 2 | $1 |
| Balanced | 8 | 3 | 2 | $3 |
| Performance | 12 | 4 | 3 | $10 |
| Max | 16 | 6 | 3 | $25 |

The slider grants capacity; it does not require Recurs to use every available
role. A small task under Balanced may need only an Implement sub-agent and an
independent Review sub-agent.

The current CLI also exposes an advanced project overlay. A user can choose
`recommended`, `focused`, `parallel`, `hierarchical`, `research_heavy`, or
`review_heavy` and narrow active-agent, concurrency, depth, escalation,
review, repair, request, and reported-cost limits. Recurs intersects that
selection with the slider's hard ceiling and the approved roster, then freezes
both the selected and effective policy into the goal.

In a graphical surface the control may be draggable. In the terminal it should
be a keyboard-accessible segmented choice. Advanced details may expose exact
limits without making them part of the normal path.

## Keep the other controls distinct

Recurs currently uses “mode” for several concepts. They should not appear as
one undifferentiated list.

### Operating intensity

Economy, Standard, Balanced, Performance, and Max control the available
sub-agent capacity and run boundaries.

### Onboarding depth

- **Quick:** short interview without project-research sub-agents.
- **Guided:** adaptive interview with up to three bounded investigations.
- **Deep:** longer interview with up to eight mode-clamped investigations.

This controls how thoroughly Recurs learns the project, not the size of every
later run.

### Roster design

- **Stable Core + Specialists:** fixed accountability roles plus
  project-tailored specialists.
- **Guardrailed Dynamic:** project-specific roles with mandatory orchestration
  and independent review.

Stable Core + Specialists should remain the approachable default.

### Execution and authority

Act, Plan, and temporary Review are execution states. Ask Always, Approved for
Me, and Full Access are permission presets. They remain safety boundaries and
must never be presented as performance settings.

## Recommended roster

Onboarding may recommend an available bench after consented project
inspection. That bench can contain:

- built-in specialists for recognizable work such as architecture, UI,
  testing, security, research, and documentation;
- generic Explore, Implement, Review, and Repair profiles; and
- user-defined roles with explicit instructions, tools, skills, model
  preferences, and restrictions.

The roster is the set of roles Recurs may activate. It is not a promise that
every role runs on every goal.

## Auto model lineup

Model selection should have one simple default and one escape hatch:

```text
Models
› Auto       Use the most-supported eligible recorded configured lineup
  Custom     Choose the parent and role routes manually
```

Auto does not redesign the company. The current alpha:

1. records an exact completed `general_coding` company goal;
2. requires passed decomposition, evidence, and synthesis;
3. groups and ranks exact Parent/Implement/Review/Repair lineups by passed
   rubric dimensions, eligible sample count, recency, and a deterministic key;
4. revalidates every saved connection before confirmation-gated activation;
5. applies the selected routes to future sessions and goals; and
6. displays the selected models, efforts, evidence count, and rationale.

Repair is one route in the configured snapshot. It remains a fallback and may
not activate in the recorded goal that supplies the evidence.

An illustrative result:

```text
Auto selected a model team

Parent         configured parent model
Implement      configured implementation model
Review         configured independent review model
Repair         configured fallback; may not activate

Selection      most-supported eligible recorded configured lineup
Evidence       exact completed goals and visible rationale
```

Actual model names and claims must come from current evaluation results, never
from a static marketing preference.

## Evaluation requirement

Recurs should test a bounded catalog of useful lineups through the existing
sub-agent workflow. It does not need to exhaust every possible model
combination.

Evaluation should record:

- task category and difficulty;
- exact model, provider, and reasoning effort per role;
- completion and test results;
- review findings and repair rounds;
- final judged quality and reliability across repeated runs;
- latency, tokens, reported cost, and relevant cache effects; and
- scenario version, evaluation date, sample size, and harness version.

Auto may select a lineup only when its evidence satisfies a declared quality
floor and is current for the selected models and harness. Missing, stale, or
ineligible evidence must fall back to explicit saved routing or the parent
model.

## Honest current boundary

Today Recurs already has:

- versioned Economy through Max policies;
- bounded Explore, Implement, Review, and Repair sub-agents;
- parallel work, independent review, staged candidates, and explicit apply;
- tailored and durable company rosters;
- explicit saved Implement, Review, and Repair routes;
- permissions, request limits, cost ceilings, recovery, and evaluation
  infrastructure.
- local, confirmation-gated team-control editing; structured
  manager/root escalation; and repeated-run recommendations that can only
  narrow future limits.

The last item is bounded adaptation, not autonomous self-rewriting. It requires
at least two compatible completed goals, stores exact run metrics, makes no
comparative quality claim, and changes nothing until a user approves it.

Today Recurs does select an evaluated model lineup through `/model auto`, but
only after eligible real completed-goal evidence exists. It does not have
enough repeated authorized real-provider evidence to claim a default
Sol/Terra/Luna winner, classify arbitrary tasks, expire stale benchmarks, or
optimize price automatically. The first completed Codex dogfood reported
216,879 input tokens (161,024 cached), 3,274 output tokens, and unknown dollar
cost. It proved execution and evidence capture, not team efficiency.

The frozen evaluation now contains 11 campaigns and 30 trials. Raw
hidden-verifier passes were 9/13 for the Sol baseline, 7/13 for mixed Auto, and
1/4 for the all-Sol company. Two repetitions were correlated upstream
parent/provider failures before workers activated; removing only those six
trials from roster comparison leaves 9/11, 7/11, and 1/2. This still does not
establish a winner. On the six matched successes, mixed Auto used three times
as many requests and 1.82 times as many input tokens. Dollar cost was unknown
for every trial. See the
[versioned evidence report](research/2026-08-04-RECURS-MODEL-TEAM-EVALUATION-V1.md).

The runs demonstrate that the machinery, routing, independent review, hidden
verification, and comparable-arm recording execute correctly. Terra Implement
completed 10/10 observed attempts and seven final Luna approvals all passed the
verifier, but Terra Repair recovered 0/2 candidates. These role-confounded
samples do not establish a quality or efficiency advantage.

The repeatable Company Proof surface now supplies three immutable tasks. Its
default compares the selected parent-only baseline with the currently
configured saved role-route snapshot; when saved worker routes differ,
`--compare-all-strong` explicitly adds an all-strong bounded team. Distinct
Quick, Guided, and Deep formation scenarios make onboarding cost and quality
separately observable. No configured result is claimed until the corresponding
durable trials actually exist.

## Delivery sequence

1. Complete at least three current-harness repetitions of every immutable
   fixture with a strong single agent, the recorded Sol/Terra/Luna lineup, and
   at least one alternative team.
2. Record every eligible run with `/model auto evaluate <run-id>` and compare
   quality, review value, latency, total/cached tokens, and reported cost.
3. Cross Sol/Terra/Luna and supported efforts by role, including Repair,
   planning/synthesis, and exploration.
4. Separate shared upstream availability from roster scoring while retaining
   those failures in reliability.
5. Add price coverage, a small versioned task taxonomy, and evidence freshness
   before publishing a default recommendation.
6. Preserve Custom routing and advanced policy inspection.

Until repeated evidence exists, public copy must describe evidence-backed Auto
without claiming that any named lineup is universally best.
