#!/usr/bin/env node

let markerDiscarded = false;
try {
  markerDiscarded = delete process.env.RECURS_NATIVE_FD;
} catch {
  // A hostile marker container must not reach the application graph.
}

if (!markerDiscarded) {
  process.exitCode = 1;
  process.stderr.write("Error: Recurs CLI is unavailable.\n");
} else {
  const unavailableStatus = Object.freeze({
    state: "unavailable" as const,
    reason: process.platform === "darwin"
      ? "launcher_unavailable" as const
      : "unsupported_platform" as const,
  });
  const nativeAuthority = Object.freeze({
    async status() {
      return unavailableStatus;
    },
  });

  const { runCliProcess } = await import("./process-host.js");
  await runCliProcess(nativeAuthority);
}
