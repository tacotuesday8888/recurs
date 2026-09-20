# Recurs website

A static website built from the shared Recurs brand, an installed-terminal
recording, and validated benchmark records. It makes no provider calls and
loads no analytics or external fonts.

```sh
npm ci
npm run build
npm --prefix website run dev
# http://127.0.0.1:4174
```

`npm --prefix website run check` builds and tests the site. Output goes to
`website/.build`. The version comes from the root package; terminal assets are
copied byte for byte from `docs/assets`.

## Current experience

- The hero uses the terminal's shared full-size ASCII R geometry and 80 ms
  cadence. Animation stops offscreen, in hidden tabs, with reduced motion,
  or when disabled with the footer control.
- npm, Bun, and Homebrew buttons sit directly above the installation command.
  Each choice updates the command and requirements; Copy reports its outcome.
  Bun is an installer for the Node package, not an alternative runtime.
- Inside Recurs shows a terminal poster. Play demo starts the captured workflow;
  pause, resume, replay, and media-error states have explicit controls. It does
  not autoplay or simulate live agent work.
- The benchmark overview shows every declared slot in the audited three-task
  product comparison. Selecting a slot opens the evidence and focuses that exact attempt.
  Native disclosure controls keep the detailed attempts accessible without
  JavaScript. Completion counts require valid execution, passing verification,
  workspace integrity, and source review.
- Route details, failed/invalid/unstarted outcomes, and unavailable token/cost
  comparisons remain explicit. Historical campaigns are downloadable artifacts;
  they are not promoted on the homepage.

The public comparison is sourced from
`benchmarks/product-comparison/website-results.json`, with its protocol and audit
linked alongside the chart. Twelve attempts do not establish a product ranking.
The builder validates the export and its local artifact links. It also preserves
historical evidence downloads from the four root benchmark result files.

Tests cover exported numbers, missing outcomes, safe evidence links, installation
choices, demo controls, motion interruption, reduced motion, keyboard behavior,
and asset integrity. Browser validation additionally checks desktop/mobile
layout, scrolling, focus, and native media behavior. Screenshots stay outside the
repository. A local build does not deploy or publish the site.
