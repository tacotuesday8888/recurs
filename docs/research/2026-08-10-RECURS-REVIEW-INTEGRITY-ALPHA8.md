# Recurs Review Integrity — Alpha.8

- **Evidence date:** 2026-08-10
- **Starting revision:** `3f2ad753673a4eaf0c82478690122c3e9a3ff0c9`
- **Candidate package:** `0.1.0-alpha.8`
- **Publication state:** prepared source candidate; not tagged or published

This report records one narrow release decision: whether the two preserved
false approvals proved a defect in Recurs review authority, context delivery,
or routing policy. It is not a general model ranking and does not replace the
versioned model-team evaluation reports.

## Preserved failures

Two immutable `alias_registry` company trials ended with Review approval and a
failed hidden registry-boundary check:

| Campaign | Trial | Activated lineup | Repair |
| --- | --- | --- | --- |
| `company-proof-51b3bdb1-4a05-4331-951a-14dc49545a9b` | `benchmark_trial_d80509a58f4d125ab08966840a609b31` | Terra Parent, Terra Implement, Luna Review | not activated |
| `company-proof-6c574347-8188-41bc-8eed-85b577e1df7a` | `benchmark_trial_ed2552d3b8d3f9e18cc06ac52e0bbeb7` | Sol Parent, Terra Implement, Luna Review | not activated |

The durable reviewer records contained the exact objective, boundary-specific
acceptance criteria, staged workspace and diff access, visible-test evidence,
and the explicit known risk that alias-boundary behavior might be incomplete.
The review runtime returned `approved`; Recurs preserved that verdict, skipped
finding-driven Repair, ran the independent hidden verifier, and recorded the
failure. No evidence showed missing review context, permission escalation,
state corruption, or dishonest failure projection.

This means a second reviewer, a new scheduler, or a weaker approval contract
would have been speculative. A model review can still be wrong even when the
harness supplies the right evidence.

## Proven product defect

Fresh Codex onboarding used model names as a static policy:

- Sol/high became Parent;
- Terra/medium became Implement and Repair; and
- Luna/medium became Review.

That silently promoted the same unevaluated specialist lineup implicated in
both false approvals. It contradicted Recurs's evidence policy: current
campaigns are `insufficient_evidence`, and missing or ineligible Auto evidence
must fall back to an explicit route or the parent.

Alpha.8 changes only that boundary:

- setup still saves the discovered Sol, Terra, and Luna connections;
- Sol/high remains the preferred parent when available;
- fresh Implement, Review, and Repair routes remain unset and therefore inherit
  the parent;
- routes the user already selected remain unchanged; and
- explicit `recurs account route ...` and confirmation-gated Models Auto remain
  available.

There is no registry migration and no existing user choice is reset.

## Deterministic proof

The implementation was test-first. The changed expectations failed against the
old setup behavior, then passed after the routing write was removed. Focused
coverage proves:

- fresh setup saves three reviewed alternatives without assigning roles;
- setup remains idempotent;
- re-running setup preserves explicit existing routes; and
- human CLI output distinguishes saved models from selected team routes.

The focused app/CLI suite passed 177 tests. The full local candidate gate then
passed generated-file checks, lint, type checks, 171 test files with 2,201
passing tests and four intentional platform skips, the build, and all 38
package-policy tests. The exact npm artifact also passed its empty-prefix
installed-agent smoke.

The candidate archive contained exactly the seven allowed files. It measured
474,004 bytes compressed and 2,075,530 bytes unpacked, below the enforced
2.1 MiB cap. A clean Apple-silicon production prefix measured 42,380 KiB
(41.4 MiB). Its pre-release SHA-256 was
`cfa2ed3c97d04d172a12f5fa753f67c65de3c7b5d14152f5e2c5870b3bdfc2ff`.
That digest is local candidate evidence only; published assets must be rebuilt
and attested from the exact tagged commit.

The local Bun 1.3.13 smoke reached npm dependency resolution but the host's Bun
TLS verifier rejected the registry manifests with
`UNKNOWN_CERTIFICATE_VERIFICATION_ERROR`. TLS verification was not disabled.
The pinned clean-network Bun CI lane remains the release authority for
Bun-as-installer compatibility; Bun is not the Recurs runtime.

## Fresh-home provider audit

The audit used temporary empty Recurs homes and did not alter the user's real
registry.

- Provider catalog, local detection, account list, and `doctor` remained
  truthful with no configured account.
- Ollama and LM Studio were not detected on the host.
- GitHub Copilot correctly remained unavailable without the exact optional
  `@github/copilot-sdk@1.0.8`; Recurs printed the opt-in installation command
  and did not install it.
- Official Codex setup reused the existing vendor-owned Codex login. No API key,
  browser cookie, or vendor credential was requested, copied, or stored.
- The authenticated catalog saved Sol, Terra, and Luna, selected Sol/high as
  Parent, and left all three specialist routes unset.
- A separate safe account verification passed through the official app-server.

No live request was made for any other provider, so catalog and implementation
support must not be read as account or live-turn evidence.

## Bounded Codex comparison

One fresh-home `alias_registry` repetition used the new parent-fallback policy:

`company-proof-e6ab24c1-3b62-40ba-b7ea-ffbc219ccc8b`

| Arm | Activated routes | Result | Time | Requests | Tokens | Reported cost |
| --- | --- | --- | ---: | ---: | --- | --- |
| Single agent | Sol/high Parent | 7/7 checks passed | 96.072s | 1 | 128,113 input; 102,656 cached; 4,487 output; 2,600 reasoning | unknown |
| Company | Sol/high Parent, Implement, Review | 7/7 checks passed; Review approved | 243.321s | 3 | 430,220 input; 333,824 cached; 9,401 output; 5,739 reasoning | unknown |

Repair was configured as parent fallback but did not activate. The durable
summary correctly remained `insufficient_evidence`: there was only one pair,
the company used more requests, tokens, and time, and provider-reported dollar
cost was absent.

The trial recorded harness revision `recurs_0_1_0-alpha_7` because the source
version was bumped only after the bounded run. The tested source already
contained the routing change. This is acceptable as a pre-release routing
proof but is not counted as alpha.8 comparative quality evidence.

## Release conclusion

The smallest justified correction is to make specialist routing explicit. It
removes an unsupported default without weakening review, Repair, authority,
budgets, provider boundaries, or existing choices.

What remains intentionally unclaimed:

- Sol-only teams are not a universal winner;
- a passing one-pair run does not estimate reliability;
- independent review is not guaranteed to catch every defect;
- Models Auto still lacks enough evidence for a default lineup; and
- dollar-cost efficiency remains unknown.

Alpha.8 may be prepared and verified as a release candidate. Tagging, npm
publication, GitHub release publication, and Homebrew update require separate
explicit owner authorization after the exact merged commit passes every release
gate.
