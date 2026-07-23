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
only the roles the task needs and, when supported by evidence, assigns the best
evaluated model lineup for that kind of work.

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

> Cursor Router chooses one model. Recurs Auto chooses the evaluated lineup of
> models that powers a bounded sub-agent team.

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
› Auto       Use the best current evaluated lineup for this task
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

An illustrative result:

```text
Auto selected a model team

Lead           frontier reasoning model
Research       fast long-context model
Implement      strong coding model
Review         independent review model

Selected for   large cross-package implementation
Optimized for  balanced quality and cost
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

Auto may recommend a lineup only when its evidence satisfies a declared quality
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

Today Recurs does select an evaluated model lineup through `/model auto`, but
only after eligible real completed-goal evidence exists. It does not have
enough repeated authorized real-provider evidence to claim a default
Sol/Terra/Luna winner, classify arbitrary tasks, expire stale benchmarks, or
optimize price automatically.

## Delivery sequence

1. Dogfood representative Sol/Terra/Luna goals through the implemented
   workflow and record them with `/model auto evaluate <run-id>`.
2. Repeat comparable goals before publishing a default recommendation.
3. Add a small versioned task taxonomy and evidence freshness policy.
4. Compare lineups using quality, reliability, latency, and cost evidence.
5. Preserve Custom routing and advanced policy inspection.

Until repeated evidence exists, public copy must describe evidence-backed Auto
without claiming that any named lineup is universally best.
