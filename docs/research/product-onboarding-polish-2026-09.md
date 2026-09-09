# Onboarding and returning-chat review

Reviewed the model connection, Start coding, Quick/Guided/Deep company setup,
saved team controls, specialist routing, proposal review, and tool-readiness
paths during the September 2026 product polish pass. These changes are part of the
alpha.11 source candidate, pending publication; the alpha.10 publication record
remains historical evidence for its exact archive.

## Changes

- A configured user's **Start new chat** now uses the existing `/new` command.
  It preserves the current pinned connection, permissions, and operating mode,
  including the existing company revision rules. A workspace without a model
  still opens guided setup. Explicit `recurs setup` remains available.
- Team setup displays saved limits and uses them as editing defaults. Numeric
  prompts show the operating-mode range, retry invalid entries locally, and
  restrict simultaneous agents to the selected active-agent count. Cancelling
  a limit prompt cannot save partially entered changes.
- Team summaries show agent counts and reporting layers. An approved V2 company
  uses the shared effective-policy calculation for the final summary.
- Connection choices explain sign-in directly; billing options use readable
  labels. Quick/Guided/Deep keep their existing execution and research limits.
- Missing required tool access now has explicit inspection, binding,
  enablement, trust, and connection-diagnosis commands. Installing an extension
  still does not grant roles access automatically.
- If an editor removes or makes its draft unreadable, proposal review receives
  a recoverable message and retains the saved proposal. No temporary path or
  raw filesystem error is printed.

## Model and execution integration

- Local `/model` opens an arrow-key saved-connection picker. Selection returns
  an exact ID to the existing confirmation/revalidation path and starts a fresh
  pinned session. Escape preserves the current session; unsupported hosts keep
  the list interface. Remote/automated invocation cannot use the picker to
  bypass model-switch authority checks.
- `/agents routes` reads one registry snapshot and shows the parent pin plus
  configured Implement/Review/Repair IDs, models, efforts, execution capability,
  and billing sources. Missing connections remain unresolved. It distinguishes
  configuration from launch-time resolution and never mutates existing pins.
- Setup route choices include provider/model, saved effort, and the current
  assignment. Connection summaries now preserve explicitly saved effort. When
  there are no eligible candidates, setup explains the actual mode restriction.
- The execution tree groups children by exact recorded parent IDs. Inspection
  includes depth, recorded limits, permission ceilings, available usage and
  containing-run recovery commands. Configured inactive roles stay distinct
  from executions; child inspection has no composer or unrestricted steering.

## Verification

Focused suites: `guided-onboarding`, `company-tool-readiness`,
`company-proposal-editor`, and `run-mode`: **208 tests passed**.
TypeScript build and focused ESLint passed. Regressions include a real runtime
and session store plus the real interactive shell for New chat, saved-limit preservation, invalid/concurrent
limit recovery, cancellation before persistence, and a deleted editor draft.

The model/route integration passed **98 focused tests** across session commands,
runtime, guided onboarding, and connection lifecycle, plus the assembly test
that checks a real registry route snapshot and a fresh-session model switch.
Project-reference TypeScript build, focused ESLint, and diff checks passed.
These checks made no live model requests. Separate theme/picker integration
review and final installed acceptance belong to the release owner's evidence.

This record covers source/runtime fixtures. The release owner runs the final
bundled installation and terminal checks alongside the terminal theme and
agent-hierarchy changes; this note does not claim those checks ran here.
