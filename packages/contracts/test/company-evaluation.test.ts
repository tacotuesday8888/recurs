import { describe, expect, it } from "vitest";

import {
  COMPANY_EVALUATION_DIMENSIONS,
  parseCompanyEvaluationReport,
} from "../src/company-evaluation.js";

function report() {
  return {
    id: "evaluation_fixture",
    version: 1,
    scenarioId: "company_formation_v1",
    scenarioVersion: 1,
    mode: "offline",
    status: "passed",
    startedAt: "2026-07-22T00:00:00.000Z",
    completedAt: "2026-07-22T00:00:01.000Z",
    latencyMs: 1_000,
    backend: {
      providerId: "scripted",
      modelId: "offline-baseline",
      fingerprint: "backend_fixture",
    },
    usage: { requestsUsed: 4, reportedCostUsd: 0, source: "provider" },
    rubric: COMPANY_EVALUATION_DIMENSIONS.map((dimension) => ({
      dimension,
      status: dimension === "synthesis" ? "not_applicable" : "passed",
      evidence: [`${dimension} was evaluated.`],
    })),
    failures: [],
  };
}

describe("company evaluation report contract", () => {
  it("accepts and freezes a complete versioned report", () => {
    const parsed = parseCompanyEvaluationReport(report());

    expect(parsed.rubric.map((item) => item.dimension)).toEqual(
      COMPANY_EVALUATION_DIMENSIONS,
    );
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it.each([
    ["unknown field", (value: ReturnType<typeof report>) =>
      Object.assign(value, { prompt: "must not be stored" })],
    ["duplicate rubric dimension", (value: ReturnType<typeof report>) => {
      value.rubric[1] = { ...value.rubric[0]! };
    }],
    ["empty rubric evidence", (value: ReturnType<typeof report>) => {
      value.rubric[0]!.evidence = [];
    }],
    ["inconsistent usage source", (value: ReturnType<typeof report>) => {
      value.usage.reportedCostUsd = null as never;
    }],
    ["inconsistent latency", (value: ReturnType<typeof report>) => {
      value.latencyMs = 999;
    }],
    ["inconsistent status", (value: ReturnType<typeof report>) => {
      value.status = "partial";
    }],
    ["reversed timestamps", (value: ReturnType<typeof report>) => {
      value.completedAt = "2026-07-21T23:59:59.000Z";
      value.latencyMs = 0;
    }],
  ])("rejects %s", (_label, mutate) => {
    const value = report();
    mutate(value);
    expect(() => parseCompanyEvaluationReport(value)).toThrow(TypeError);
  });
});
