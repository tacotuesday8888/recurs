# CLI time and memory: Claude Code, Codex CLI and Recurs

Measured September 27, 2026 under the [frozen protocol](PROTOCOL.md)
(SHA-256 `1847778e…`), which was committed before the first measurement.
All three CLIs talked to the same deterministic local model server, so they
received identical replies and no provider account was used. Every sample is
in [results.json](results.json); all 45 measured runs were valid.

| Workload | Claude Code 2.1.283 | Codex CLI 0.145.0 | Recurs 0.1.0-alpha.11 |
| --- | ---: | ---: | ---: |
| Long streamed answer (6,000 lines) | 495 ms · 421 MiB | 432 ms · 107 MiB | **369 ms** · 166 MiB |
| Short answer | 344 ms · 224 MiB | 328 ms · 88 MiB | **316 ms** · 126 MiB |
| Startup (`--version`) | **15 ms** · 25 MiB | 82 ms · 54 MiB | 205 ms · 122 MiB |

Medians of five runs: wall time from launch to exit, and peak resident memory
of the process and its children.

## What this shows

- Recurs completed a long streamed answer fastest: 15% less time than Codex CLI
  and 25% less than Claude Code, with the widest margin as output grows.
- On that workload Recurs used 61% less peak memory than Claude Code. Codex CLI,
  a native program, used the least memory in every workload.
- Recurs starts slowest. `--version` loads the Node.js bundle; Claude Code's
  native executable answers in 15 ms.

## Limits

One macOS arm64 host, one version of each product, a local server with no model
latency, and headless modes (`claude -p`, `codex exec`, `recurs run`). This
measures the programs' own overhead, not answer quality, cost, or interactive
sessions. Reproduce with `npm run build && node scripts/compare-cli-resources.mjs`.
