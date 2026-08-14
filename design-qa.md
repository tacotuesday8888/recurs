# Recurs Terminal Design QA

Reference: the user-approved V19 company-floor prototype. Target: the real
interactive Recurs CLI, rendered from approved company blueprints and normalized
runtime events rather than demo data.

## Visual comparison

- [x] Black terminal canvas, compact `R↘ RECURS / PROJECT / VIEW` chrome.
- [x] One-to-four labeled reporting layers with progressively simpler pixel
  operators.
- [x] Curved dotted connectors with a moving activity point.
- [x] Stable color identity for Direct, Lead, Senior, and Work layers, with
  readable text labels when color is unavailable.
- [x] Goal state, active assignments, model routes, review/repair, evidence,
  request usage, and unknown cost remain visible and truthful.
- [x] Selection uses a small marker and activity rail, never a large box around
  an operator.
- [x] Short terminals switch to a bounded hierarchy list that keeps the selected
  role and controls visible; long labels remain width-bounded.

The V19 reference and the production renderer were captured at the same browser
viewport. The production terminal necessarily uses character-cell typography
and box-drawing curves instead of browser-positioned pixels. Hierarchy, spacing,
layer color, operator complexity, activity hierarchy, and control placement
match the reference's design language without claiming pixel-identical browser
geometry.

## Interaction coverage

- [x] Launch: workspace-scoped saved chats and Start New Project.
- [x] Onboarding: shared pixel brand, project chrome, choices, text input,
  cancellation, and explicit one-to-four-layer operating limits.
- [x] Company: complete approved roster; inactive roles are distinct from
  activated work; keyboard role selection opens context.
- [x] Tasks: `Ctrl+T` shows only real activated assignments and can jump to the
  corresponding role context.
- [x] Chat: command/file completion, image staging, owned-process attachment,
  company navigation, and truthful parent routing.
- [x] Decisions: approval, permission, and agent questions use one queued,
  labeled surface and restore unfinished drafts.
- [x] Safety: terminal control sanitization, no-color behavior, bounded buffers,
  cancellation, and session cleanup remain covered.

## Verification status

- Focused launcher, onboarding, company, task, chat, runtime, and responsive
  tests pass.
- TypeScript contract type-checking, lint, build, generated-policy checks, and
  the full repository suite pass.
- The packed npm artifact remains dependency-clean and within its reviewed
  2.10 MB bundle ceiling; installer and release-contract checks pass.
