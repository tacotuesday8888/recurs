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
  const unavailableOnboarding = Object.freeze({
    state: "failed" as const,
    code: "operation_unavailable" as const,
    safeMessage:
      "Native OpenAI onboarding is unavailable for this invocation." as const,
  });
  const nativeAuthority = Object.freeze({
    async status() {
      return unavailableStatus;
    },
    async beginOpenAIOnboarding() {
      return unavailableOnboarding;
    },
    async verifyOpenAIOnboarding() {
      return unavailableOnboarding;
    },
    async openAIOnboardingCatalogPage() {
      return unavailableOnboarding;
    },
    async finalizeOpenAIOnboarding() {
      return unavailableOnboarding;
    },
    async abortOpenAIOnboarding() {
      return unavailableOnboarding;
    },
    async reconcileOpenAIActivation() {
      return unavailableOnboarding;
    },
  });

  const { runCliProcess } = await import("./process-host.js");
  await runCliProcess(nativeAuthority);
}
