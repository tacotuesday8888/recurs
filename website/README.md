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

- One 1120px column, one type scale and the terminal's palette. Every section
  has a heading and a one-line explanation beside it.
- The hero uses the terminal's shared full-size ASCII R geometry and 80 ms
  cadence. Animation stops offscreen, in hidden tabs, with reduced motion,
  or when disabled with the footer control.
- npm, Bun, and Homebrew buttons sit directly above the installation command.
  Each choice updates the command and requirements. Copy reports its outcome;
  without clipboard access it selects the command and says how to copy it.
- Inside Recurs shows a terminal poster. Play demo starts the captured workflow;
  pause, resume, replay, and media-error states have explicit controls. It does
  not autoplay or simulate live agent work. On narrow screens the capture keeps
  a legible size and scrolls sideways.
- Built to stay responsive shows three before/after engineering measurements
  from paired local runs, linked to their method and raw records. They are not
  model-quality or product-comparison claims.

The audited product comparison (`benchmarks/product-comparison/`) is still
parsed and validated on every build, but it appears on the homepage only with
`RECURS_SHOW_COMPARISON=1`. When shown, it is an interactive dot plot: every
declared attempt on a linear time axis from zero, the five-minute limit marked,
finished attempts filled, and each dot opening that exact attempt's record.

Tests cover exported numbers, missing outcomes, safe evidence links, installation
choices, contrast of every text color on every surface, demo controls, motion
interruption, reduced motion, keyboard behavior, and asset integrity. A local
build does not deploy or publish the site.
