# Recurs CLI V19 contract

The recovered [`recurs-full-cli-v19-reference.html`](./recurs-full-cli-v19-reference.html)
is the visual source of truth for the interactive terminal experience. Its sample
company is illustrative; production views must use the approved onboarding
blueprint and normalized runtime events.

## Product journey

1. **Projects** lists real saved chats and offers **Start new project**.
2. **Setup** begins with saved, detected, or new model connections, then collects
   company depth, operating mode, authority, and approval.
3. **Company** appears only after a blueprint is approved. It renders the actual
   one-to-four-layer reporting structure, activation, model route, and status.
4. **Chat** is a conventional coding-agent transcript with the selected role,
   composer, questions, approvals, and cancellation kept visible.
5. **Tasks** contains only assignments that actually activated.

## Visual rules

- The interactive color surface is a pure black terminal canvas.
- Navigation uses the compact `R↘ RECURS / PROJECT / VIEW` breadcrumb. The large
  repository wordmark is not repeated inside operational screens.
- Company layers use the V19 order and palette: Direct, Lead, Senior, Work.
- Pixel operators become simpler at lower layers. A small `>` marks selection;
  no box surrounds a selected operator.
- Dotted curved connectors represent approved reporting paths. Motion may signal
  live activity, and must stop when reduced motion or animation is disabled.
- The composer and controls remain at the bottom of full-screen views.
- Narrow terminals use a truthful compact list; `NO_COLOR` remains escape-free.
- Inactive roles are visibly inactive and never portrayed as working.

## State rules

- A legacy chat without a company blueprint opens as chat, not as a fabricated
  one-person company.
- Provider catalog entries never imply authentication or live readiness.
- Usage, cost, review, repair, evidence, cancellation, and failures are shown
  only from authoritative events; unknown data stays labeled unknown.
- The static names and model routes in the HTML reference must never be copied
  into runtime state.
