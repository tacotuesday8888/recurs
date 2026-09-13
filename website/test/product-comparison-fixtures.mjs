/** Synthetic controls only. Never import from website/src or copy into live assets. */
export function syntheticProductComparison() {
  const tasks = ["shipment_quote", "incremental_build_repair", "release_window_regressions"];
  const armIds = ["codex-cli", "company-auto"];
  return {
    version: 1,
    kind: "audited-product-comparison",
    sourceRevision: "a".repeat(40),
    auditedAt: "2026-01-01T00:00:00.000Z",
    auditHref: "https://github.com/tacotuesday8888/recurs/blob/main/benchmarks/product-comparison/AUDIT.md",
    protocolHref: "https://github.com/tacotuesday8888/recurs/blob/main/benchmarks/product-comparison/PLAN.md",
    configurations: [
      { id: "codex-cli", routes: [{ role: "parent", modelId: "gpt-5.6-luna", reasoningEffort: "medium" }] },
      { id: "company-auto", routes: [
        { role: "parent", modelId: "gpt-5.6-luna", reasoningEffort: "medium" },
        { role: "review", modelId: "gpt-5.6-luna", reasoningEffort: "medium" },
        { role: "implement", modelId: "gpt-5.6-terra", reasoningEffort: "medium" },
        { role: "repair", modelId: "gpt-5.6-terra", reasoningEffort: "medium" },
      ] },
    ],
    tokenAccounting: { comparable: false, note: "SYNTHETIC-TEST-ONLY: token coverage has not been established." },
    attempts: tasks.flatMap((scenarioId, index) => [1, 2].flatMap(repetition => armIds.map((armId, armIndex) => ({
      scenarioId, armId, repetition,
      executionStatus: "completed", verificationStatus: "passed", workspaceIntegrity: "passed", sourceReview: "passed", validity: "valid", note: "SYNTHETIC-TEST-ONLY",
      elapsedMs: 12340 + index * 10000 + repetition * 1500 + armIndex * 4700,
      usage: { coverage: "complete", inputTokens: 123456, cachedInputTokens: 100000, outputTokens: 3210 },
    })))),
  };
}
