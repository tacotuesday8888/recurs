# Auto Model Teams And Simple Controls

**Status:** Product direction. The operating policies, bounded sub-agent
runtime, tailored rosters, explicit role routes, permissions, budgets, and
evaluation foundation exist. Automatic model ranking and automatic model-team
selection do not.

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

Auto does not redesign the company. It:

1. classifies the goal by task type and difficulty;
2. determines which roles from the current roster are needed;
3. selects an eligible, available, evaluated model lineup for those roles;
4. freezes the routing evidence for the run; and
5. displays the selected models, rationale, evidence freshness, and fallback.

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

Today Recurs does not automatically rank models, select an evaluated model
lineup, or have enough authorized real-provider evidence to claim which lineup
is best.

## Delivery sequence

1. Dogfood representative real-provider goals through the implemented
   workflow.
2. Define a small, versioned task taxonomy and lineup catalog.
3. Compare lineups using quality, reliability, latency, and cost evidence.
4. Publish inspectable recommendations and evidence freshness.
5. Add Auto selection with explicit fallback and a truthful explanation.
6. Present Economy through Max as the simple team-size/intensity control.
7. Preserve Custom routing and advanced policy inspection.

Until that work is complete, public product copy should describe bounded
multi-model sub-agent teams without claiming automatic best-model selection.
