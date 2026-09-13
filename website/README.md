# Recurs website

A static, dependency-light website using the existing terminal SVG captures and
validated benchmark records. No provider calls, analytics, external
fonts, simulated agent activity, or deployment configuration.

```sh
npm ci
npm run build
npm --prefix website run dev
# http://127.0.0.1:4173
```

`npm --prefix website run check` builds and tests the site. The production output
is `website/dist`; publish only when separately authorized. The build derives
version from the root package, benchmark tables from `benchmarks/results.json`
and `benchmarks/current-results.json`,
and copies terminal assets byte for byte from `docs/assets`. It renders the
default fresh pair into HTML so metrics remain readable without JavaScript.
Historical campaigns and the fresh candidate probe are separately labeled, with
exact parent routes and executed-candidate provenance visible in trial details.

The command guide switches real captured views; it is explicitly a browser
guide and runs no shell or model. Installation buttons and benchmark campaign
selection use native, keyboard-accessible controls. Motion is a brief CSS
entrance and respects reduced motion. No timers loop or block interaction.

Existing branches `codex/recurs-interactive-website-r2` and
`codex/sites-website-rebuild` were inspected and preserved. Build/dev structure
was adapted from the former; the latter remained a Next.js scaffold. The visual
direction uses the Recurs orange mark, quiet paper backgrounds, precise metric
typography and real terminal captures. The older website brief's simulated
company scene is replaced by actual capture exploration to honor the current
request for real behavior and measured evidence.
