# Recurs Company Efficiency Alpha — Auto Evidence Gate

- **Report version:** 1.0
- **Date:** 2026-08-05
- **Release provenance:** `v0.1.0-alpha.6` package line
- **Baseline source:** `9314d67503a262536d69d7b7b6112b6af971f642`
- **Implemented source:** `838dc9ea0b7b26e2a331a837cd6ce6e59df901a9`
- **Scope:** company Auto routing evidence, durable model-team contracts and
  stores, selection policy, and deterministic verification

## Finding

The prior Auto path could apply a configured four-route lineup after one
eligible company-goal evaluation. That record did not distinguish configured
routes from roles that actually made a provider request. In particular, Repair
could be presented within a selected lineup even when it had never activated.
This made a one-run selection look more evidentially complete than it was.

## Change

The source above adds immutable V2 model-team evidence and selection records.
V2 records keep the complete configured lineup while recording the ordered set
of actual activated roles. Auto now requires, for one exact configured lineup:

1. at least three eligible V2 evaluations;
2. passed decomposition, evidence, and synthesis; and
3. observed Parent, Implement, and Review activity in every eligible record.

Repair remains configured as a fallback. It is not included in the evaluated
role coverage unless a recorded run actually activated it. Legacy V1 evaluation
and selection records remain loadable, but cannot activate Auto because their
schema has no activation provenance.

This is an evidence-integrity improvement, not a claim that any named model
lineup is faster, cheaper, or better than a single strong agent.

## Verification

The implemented source passed:

```text
npm run check
```

That gate covers generated-policy checks, lint, TypeScript and contract type
checks, the full Vitest suite, package build, and package checks. Focused tests
also cover the exact three-run threshold, missing Review activation, V2 parsing,
legacy-record readability, and route application only after eligible observed
evidence.

The built CLI listed the three immutable Company Proof scenarios:
`alias_registry` v1, `layered_config` v1, and `retry_after` v1. The attempted
non-secret account inventory ended before any provider turn with the bounded
error `Connection registry changed; try again`. No configured campaign was
started, so this report records no new requests, token/cache usage, latency,
activations, failure-class trial records, or dollar cost. The error is retained
as provider/registry availability evidence and is not attributed to a model
roster.

## Evidence limits and next run

The existing alpha.6-line proof remains one matched passing pair and reports
the company as 32.6% slower with 3.37 times baseline input. It predates this
source revision and cannot measure this Auto evidence-gate change. A healthy
configured campaign should resume with three repetitions per immutable fixture
for the strong single-agent baseline, the current mixed company, and an
alternative bounded team. It must retain the existing strict shared-parent
outage attribution, external hidden verifier, request/cost ceilings, and
unknown-cost handling. Until then, Auto remains a conservative evidence gate;
it does not rank vendors or prescribe a default roster.
