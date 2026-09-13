# September revision

Audience: developers evaluating a terminal coding team. Show the actual workflow,
installation, and measured tradeoffs in that order.

Use the requested Recurs orange identity: warm neutral #faf8f5, ink #292724,
muted #6c6259, rust #ae3f1d, and quiet border #dfd5ca. Terminal captures retain
their actual colors. Avenir Next falls back to system sans; monospace is for code.

The first screen pairs a short introduction with installation controls above an
actual terminal recording. A narrow selector offers Activity, Changes, and
Approvals. The recording plays once with pause/replay and a native video link;
reduced-motion mode starts on the collapsed poster. Keyboard switching is instant.
The terminal stays near its native dimensions and fits the desktop first screen.

The evidence area shows all original tasks, paired observations, routes and
provenance. Mobile metrics stack with labels so time, tokens and cost remain
visible. Original invalid team setups and the completed corrected campaign remain separate.
The footer action is Try Recurs. No simulated editable terminal or model activity.

Verify Chrome desktop/mobile rendering, video controls, keyboard switching,
clipboard, all campaigns, reduced motion, no JavaScript and horizontal overflow.
Keep the previous preview at port 4173; this revision uses .build and port 4174.

Interactive chart plan: keep the terminal as the main visual. Add one compact
comparison plot with native Task and Measure selectors, two arm rows and both
individual trial marks. Use existing ink/orange identity, with labeled neutral
hatching for cached input and invalid setups. No chart animation: selections and
keyboard focus should update immediately. Retain all-task overview; collapse the
existing detailed campaign selector and tables into Inspect trials.

| Before | After | Why |
| --- | --- | --- |
| Multiple exposed tables | One metric explorer, overview, then native disclosure | Makes the comparison usable without a wall of numbers. |
| Medians alone in primary view | Both trial observations, zero-based common scales | Makes the tiny sample and runtime variation visible. |
| Unknown dollar costs | Explicit unavailable state | No invented prices, savings or zero-cost claim. |

Header identity uses the exact existing GitHub README wordmark asset at a
responsive readable size. Keep its orange pixels and charcoal backing intact.
The exact wordmark and compact favicon stay separate from the decorative motion added below.

## Charcoal and motion revision

Use the terminal's own palette: charcoal #191714, raised surface #221f1b,
warm text #f1e7da, secondary #b5a798, orange #efa564, border #494139.
Keep the GitHub wordmark readable and stationary, with a separate rotating
bracket ornament beside it. Let scroll movement give that ornament and a thin
reading-progress rail a short damped follow-through; content itself keeps native
scroll position. Reveal only the terminal once from 12px away with soft deceleration.
The desktop header stays visible so the scroll-driven ornament has a continuous
reference; the mobile header remains in native flow. Never hide tables or gate content on an observer.

| Before | After | Why |
| --- | --- | --- |
| Cream surfaces around a dark terminal | Coherent terminal charcoal/orange surfaces | Aligns the site and actual product. |
| Static header identity | Stationary GitHub wordmark plus separate rotating brackets | Restores the requested spinning identity without rotating text. |
| Abrupt decorative response | Brief damped progress/ornament response | Adds a sense of friction without overriding scrolling. |
| Uncontrolled continuous decoration | Pause motion, reduced-motion and offscreen suspension | Keeps the page comfortable and economical. |

Implementation reference: MDN's scroll-event guide warns that rAF is not a
throttle; use it only for the damped animation loop, with cheap passive event
updates. IntersectionObserver drives visibility/reveals; native scrolling is
untouched. WebKit's scroll-animation guide supports transform/opacity-only
progressive enhancement, but a small local loop supplies the requested temporal
follow-through consistently without a dependency.
https://developer.mozilla.org/en-US/docs/Web/API/Document/scroll_event
https://webkit.org/blog/17101/a-guide-to-scroll-driven-animations-with-just-css/

Verified in actual Chrome at 1440, 390 and 320px: idle ornament rotation, native wheel
scroll with damped settling, stationary wordmark, deep links and restored anchors
below the sticky header, visible skip link, End/Home, session pause persistence,
live reduced-motion changes, no-JavaScript content, and all five chart metrics.
A real browser recording and timed position samples were retained for visual review.

## Exact terminal R correction

Replace the bracket ornament with the terminal opening's actual beveled, extruded
ASCII-lit R to the left of the existing wordmark. Extract only the pure geometry
and cell renderer; share it with the site at build time. Preserve native terminal
output, the wordmark, palette and native scroll behavior. Render the R at the
terminal's 80ms cadence, with the existing damped scroll phase, and suspend its
timer offscreen, in the background, when paused or when reduced motion is enabled.

| Before | After | Why |
| --- | --- | --- |
| Separate rotating brackets | Exact shared terminal R geometry and lighting | Matches the user's explicitly requested terminal identity. |
| Original workspace setup only | Distinct v1 invalid and v2 corrected results | Preserves all outcomes and makes the correction reviewable. |

Eighty pre-extraction terminal frame hashes cover color on/off, compact layouts,
and phases 0, 8, 24 and 50; all remain identical after extraction.

Actual Chrome measurements across 80 representative R frames, including SVG DOM
replacement and forced layout: mean 3.19ms, p95 3.50ms, maximum 3.60ms on the
local development machine. These are UI rendering measurements, not benchmark
model timing. Fourteen website checks pass, including shared-cell equality and
full-rotation crop bounds.
