# Company Evaluation

Recurs includes one versioned company-formation scenario that exercises the
real restricted onboarding coordinator. It evaluates adaptive interviewing,
blueprint tailoring, role decomposition, repository evidence, and request/cost
efficiency. Goal-result synthesis remains covered by deterministic runtime
integration tests and is marked `not_applicable` in this formation-only
scenario.

Run the deterministic offline baseline:

```sh
npm run eval:company -- --scenario company_formation_v1
```

Add `--json` for the strict `CompanyEvaluationReportV1` representation. The
offline run uses a scripted provider, reads only through the onboarding Plan
mode registry, performs no network request, and needs no API key.

To assess a real model, first configure a direct BYOK or local provider through
normal Recurs onboarding, make it the primary connection, and explicitly allow
the evaluation network request:

```sh
npm run eval:company -- \
  --scenario company_formation_v1 \
  --configured --allow-network --json
```

Configured evaluation creates a temporary private Recurs home and copies only
the selected non-secret connection record. Environment credentials remain in
their existing environment variable; their values are never copied into the
report or temporary registry. Delegated subscription and broker connections
are rejected because they do not expose Recurs's restricted pre-approval tool
boundary for company formation.

Reports contain a scenario version, sanitized provider/model identity,
backend fingerprint, latency, usage, reported cost when available, rubric
evidence, and bounded failures. They intentionally omit prompts, answers, raw
model output, environment values, and repository contents. Configured-provider
cost is marked unknown until the onboarding accounting seam can distinguish a
provider-reported zero from absent cost data.

Ordinary `npm test` and `npm run check` execute only the offline scenario. A
real provider is useful for qualitative comparisons between models, but is not
required to verify Recurs's contracts or authority boundaries.
