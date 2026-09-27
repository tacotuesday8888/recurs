# CLI resource comparison — protocol

Frozen September 27, 2026, before any measurement. Changing a measure, workload,
sample count or reporting rule after the first run requires a new protocol
version; results under this version are reported in full whatever they show.

## Question

How much time and memory does each coding-agent CLI itself use for the same
model output? This compares the programs, not model quality: every CLI talks to
the same deterministic local model server, so no provider account is used and
all three receive identical responses.

## Products

- Claude Code, the installed `claude` executable (`-p`, print mode).
- Codex CLI 0.145.0, the version Recurs pins (`codex exec`).
- Recurs, the built package from this repository (`recurs run`).

Each runs with a fresh temporary home and configuration, a temporary Git
workspace, a placeholder credential accepted only by the local server, and
non-essential network traffic disabled where the product supports it.

## Workloads

1. **Startup**: `--version`.
2. **Short answer**: one prompt; the server streams a one-sentence reply.
3. **Long answer**: one prompt; the server streams 6,000 lines (about 360 KB)
   in 90-character deltas.

The model never requests tools, so no product runs commands or edits files.

## Measures

For every run: wall time from launch to exit, peak resident memory of the
process and its children (`/usr/bin/time -l`), exit status, and whether the
product's standard output contains the final line of the reply. A run that
exits non-zero or omits the final line is **invalid** and reported as such.

## Samples and order

One discarded warmup, then five measured runs per product per workload.
Products alternate within each round (Claude Code, Codex, Recurs; then the
next round rotates the starting product) to spread host-load drift.

## Reporting

Report the median and the full list of samples for every product and workload,
including invalid runs and their reason. No sample is removed or repeated. The
result describes one host (macOS arm64) and one product version each; it does
not measure answer quality, cost, or behaviour with real model latency.
