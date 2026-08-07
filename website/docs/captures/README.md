# Review captures

Deterministic Round 2 browser captures from the production static build:

- `desktop-home.png` — 1440 × 960, layered company home.
- `desktop-company-cli.png` — 1440 × 960, focused company-to-CLI state.
- `desktop-scroll-reveal.png` — 1440 × 960, first downstream section after reveal.
- `mobile-home.png` — 390 × 844, install choices and company entry.
- `mobile-company-cli.png` — 390 × 844, direct `#company` CLI route.

Captured from `http://127.0.0.1:4173/` after `npm --prefix website run
build`, using the in-app browser. These are review evidence, not runtime assets;
the website does not load or ship them in `dist`.
