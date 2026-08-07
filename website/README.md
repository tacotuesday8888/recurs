# Recurs website

The website is a framework-free static TypeScript/CSS surface kept outside the root
`packages/*` workspace. It does not enter the CLI package or runtime graph.

```bash
npm --prefix website run dev
```

The Node 22 preview rebuilds the site and serves its explicit static allowlist
at `http://127.0.0.1:4173`; it requires no global server utility.

```bash
npm --prefix website run check
```

`check` runs source-level behavior/accessibility tests, type-checks and creates a production
build in `website/dist`, and validates the built links and asset budget. The
`dist` directory is intentionally ignored.

The build is deployment-ready for any static host. A `404.html` copy is
generated for static-host fallback, but this lane does not enable or publish a
deployment.
