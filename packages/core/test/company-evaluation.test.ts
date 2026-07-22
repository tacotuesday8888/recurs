import { describe, expect, it } from "vitest";

import { COMPANY_EVALUATION_DIMENSIONS } from "@recurs/contracts";

import {
  createCompanyEvaluationReport,
  sanitizeCompanyEvaluationText,
} from "../src/company-evaluation.js";

function rubric(status: "passed" | "failed" | "unknown" = "passed") {
  return Object.fromEntries(COMPANY_EVALUATION_DIMENSIONS.map((dimension) => [
    dimension,
    { status, evidence: [`${dimension} evidence`] },
  ])) as Parameters<typeof createCompanyEvaluationReport>[0]["rubric"];
}

function input() {
  return {
    scenarioId: "company_formation_v1",
    mode: "offline" as const,
    startedAt: "2026-07-22T00:00:00.000Z",
    completedAt: "2026-07-22T00:00:02.000Z",
    backend: {
      providerId: "scripted",
      modelId: "offline-baseline",
      fingerprint: "backend_fixture",
    },
    usage: { requestsUsed: 4, reportedCostUsd: 0 },
    rubric: rubric(),
  };
}

describe("company evaluation reports", () => {
  it("derives stable identity, status, latency, and usage provenance", () => {
    const first = createCompanyEvaluationReport(input());
    const second = createCompanyEvaluationReport(input());

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      status: "passed",
      latencyMs: 2_000,
      usage: { source: "provider", reportedCostUsd: 0 },
    });
  });

  it.each([
    ["failed", rubric("failed"), undefined],
    ["partial", rubric("unknown"), undefined],
    ["cancelled", rubric("unknown"), [{ code: "cancelled", message: "Stopped" }]],
  ] as const)("derives %s status truthfully", (status, results, failures) => {
    const report = createCompanyEvaluationReport({
      ...input(),
      rubric: results,
      ...(failures === undefined ? {} : { failures }),
    });
    expect(report.status).toBe(status);
  });

  it("represents unknown configured-provider cost without inventing zero", () => {
    const report = createCompanyEvaluationReport({
      ...input(),
      mode: "configured",
      usage: { requestsUsed: 2, reportedCostUsd: null },
      rubric: rubric("unknown"),
    });

    expect(report.usage).toEqual({
      requestsUsed: 2,
      reportedCostUsd: null,
      source: "unknown",
    });
  });

  it("redacts secret-shaped text and bounds oversized failures", () => {
    const secret = `sk-proj-${"a".repeat(30)}`;
    const report = createCompanyEvaluationReport({
      ...input(),
      failures: [{ code: "evaluation_failed", message: `${secret} ${"x".repeat(120_000)}` }],
    });
    const serialized = JSON.stringify(report);

    expect(serialized).not.toContain(secret);
    expect(serialized).toContain("[REDACTED]");
    expect(report.failures[0]!.message).toContain("[truncated]");
    expect(new TextEncoder().encode(report.failures[0]!.message).byteLength)
      .toBeLessThanOrEqual(2_000);
    expect(sanitizeCompanyEvaluationText("  ")).toBe(
      "No safe detail was reported.",
    );
  });

  it("rejects invalid and reversed timestamps", () => {
    expect(() => createCompanyEvaluationReport({
      ...input(),
      startedAt: "invalid",
    })).toThrow("timestamps are invalid");
    expect(() => createCompanyEvaluationReport({
      ...input(),
      completedAt: "2026-07-21T00:00:00.000Z",
    })).toThrow("precedes its start");
  });
});
