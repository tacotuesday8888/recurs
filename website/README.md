# Recurs website

A static, dependency-light website using the actual installed-terminal recording and
validated benchmark records. No provider calls, analytics, external
fonts, simulated agent activity, or deployment configuration.

```sh
npm ci
npm run build
npm --prefix website run dev
# http://127.0.0.1:4174
```

`npm --prefix website run check` builds and tests the site. The production output
is `website/.build`; publish only when separately authorized. The build derives
version from the root package, benchmark tables from `benchmarks/results.json`
`benchmarks/current-results.json`, and `benchmarks/task-fit-results.json`,
and copies terminal assets byte for byte from `docs/assets`. It renders the
default option-precedence pilot into HTML so metrics remain readable without JavaScript.
Historical campaigns, the earlier candidate probe, and the twelve-slot pilot are separately labeled, with
exact parent routes and executed-candidate provenance visible in trial details.

Website buttons switch authentic captured views; no mock terminal or model calls.
Installation and benchmark selection use native keyboard-accessible controls.
The nine-second real workflow recording plays once, with pause/replay controls.
Reduced-motion mode starts on the collapsed-progress poster. Pointer-selected
capture changes fade briefly after decoding; keyboard view changes are immediate. The prior preview remains at port 4173;
this revision uses port 4174 and a separate build directory.

The benchmark view includes every paired observation, cached and uncached input,
role diagnostics and failure codes. Earlier baselines are labeled because the
old protocol exposed delegation tools. New pilot records use a parent-only
baseline, with the predeclared protocol in `benchmarks/TASK_FIT_PROTOCOL.md`.

Browser validation uses the connected in-app browser for desktop/mobile layout,
native scrolling, keyboard navigation, and evidence controls. Focused tests cover
static HTML, final accessible numbers, reduced motion, pause, visibility changes,
and interruption. Screenshots stay outside the repository. No deployment is
implied by a local preview.

The pilot includes explicit invalid-setup labels, every final candidate as a
sanitized repository artifact, and a separate offline queue-verifier audit.
The four corrected workspace v2 observations remain separate from the original v1 invalid setups, with explicit version labels and a separate download. The header renders the same extruded ASCII R geometry as the terminal opening, with native scrolling, session pause, reduced-motion and offscreen suspension.

The interactive pilot chart shows both original observations for each arm.
Measures are whole-trial runtime, externally verified completion, token parts
(uncached input + cached input + output), review/repair invocations, and actual
reported dollars when available. Both configurations run inside Recurs. Invalid
setups retain their measured labels but never receive comparison bars. Focus,
arrow keys, hover and touch expose exact outcome details; Escape dismisses a
tooltip. Chart changes do not animate. Detailed tables remain in Inspect trials.

The public benchmark view now starts with three plain-language task comparisons:
finished attempts and typical time. One shared note explains unmeasured outcomes
and unavailable dollar cost. Review/repair attempts and token use stay in the details.
It uses the original option/queue records and the corrected workspace v2 records.
Bug discovery is unmeasured, full development projects are untested, and dollar cost
is unreported. All technical charts, original invalid setups, model routes, and
raw records remain behind “See test details and data.” Both setups run inside Recurs.

Motion follows viewport entry, with no scroll-position listener, progress bar, or
scroll-linked R phase. Each task enters once (260 ms, 8 px, the existing ease-out
curve); visible numbers count to their recorded final value over 650 ms. The final
number is always present in HTML and accessible text. Keyboard navigation, direct
links, reduced motion, pause, and visibility loss use final values immediately.
The R keeps the terminal's independent 80 ms cadence and stops offscreen.

Design/motion guidance reviewed on 2026-09-13:
- [Vercel web-design-guidelines skill](https://github.com/vercel-labs/agent-skills/blob/main/skills/web-design-guidelines/SKILL.md) and its [current checklist](https://github.com/vercel-labs/web-interface-guidelines/blob/main/command.md): semantics, tabular numerals, reduced motion, interruptibility.
- [Emil's animate skill](https://github.com/emilkowalski/skills/blob/main/skills/animate/SKILL.md) and [animation review](https://github.com/emilkowalski/skills/blob/main/skills/review-animations/SKILL.md): restrained entry, instant keyboard interaction, existing easing tokens, and the smallest suitable implementation.
- [Motion inView](https://motion.dev/docs/inview) and [animate](https://motion.dev/docs/animate): once-per-entry observation and bounded animation. This static site uses native IntersectionObserver, WAAPI, and a short count-up frame loop; no new runtime dependency is needed.
