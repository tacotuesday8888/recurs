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

Browser validation uses bundled Playwright with installed Chrome because the
Browser plugin is not available. Check desktop and mobile layout, keyboard and
pointer capture selection, clipboard/fallback, campaign controls, incomplete
trials, reduced motion and no-JavaScript rendering. Screenshots stay outside the
repository. No deployment is implied by a local preview.

The pilot includes explicit invalid-setup labels, every final candidate as a
sanitized repository artifact, and a separate offline queue-verifier audit.
The predeclared corrected independent campaign remains visibly unrun.
