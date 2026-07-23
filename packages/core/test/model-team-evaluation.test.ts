import { describe, expect, it } from "vitest";

import {
  COMPANY_EVALUATION_DIMENSIONS,
  parseModelTeamEvaluation,
  type CompanyEvaluationRubricStatus,
  type ModelTeamRole,
} from "@recurs/contracts";

import {
  eligibleModelTeamEvaluation,
  selectEvaluatedModelTeam,
} from "../src/index.js";

function evaluation(input: {
  id: string;
  lineup: string;
  evaluatedAt?: string;
  statuses?: Partial<Record<
    (typeof COMPANY_EVALUATION_DIMENSIONS)[number],
    CompanyEvaluationRubricStatus
  >>;
}) {
  const statuses = input.statuses ?? {};
  const failures = Object.values(statuses).includes("failed")
    ? [{ code: "evaluation_failed", message: "A rubric dimension failed." }]
    : [];
  const hasUnknown = Object.values(statuses).includes("unknown");
  const roles: readonly ModelTeamRole[] = [
    "parent",
    "implement",
    "review",
    "repair",
  ];
  return parseModelTeamEvaluation({
    id: input.id,
    version: 1,
    taskClass: "general_coding",
    companyGoalRunId: `goal-${input.id}`,
    evaluatedAt: input.evaluatedAt ?? "2026-07-23T00:00:02.000Z",
    lineup: roles.map((role) => ({
      role,
      providerId: "provider",
      adapterId: "adapter",
      connectionId: `${input.lineup}-${role}`,
      modelId: `${input.lineup}-${role}-model`,
      reasoningEffort: role === "parent" ? "high" : "medium",
    })),
    report: {
      id: `report-${input.id}`,
      version: 1,
      scenarioId: "company_goal_execution_v1",
      scenarioVersion: 1,
      mode: "configured",
      status: failures.length > 0 ? "failed" : hasUnknown ? "partial" : "passed",
      startedAt: "2026-07-23T00:00:00.000Z",
      completedAt: "2026-07-23T00:00:01.000Z",
      latencyMs: 1_000,
      backend: {
        providerId: "provider",
        modelId: `${input.lineup}-parent-model`,
        fingerprint: `backend-${input.lineup}`,
      },
      usage: { requestsUsed: 8, reportedCostUsd: 0, source: "provider" },
      rubric: COMPANY_EVALUATION_DIMENSIONS.map((dimension) => ({
        dimension,
        status: statuses[dimension] ?? "passed",
        evidence: [`${dimension} was checked.`],
      })),
      failures,
    },
  });
}

describe("evidence-backed model-team selection", () => {
  it("requires passed decomposition, evidence, and synthesis", () => {
    expect(eligibleModelTeamEvaluation(evaluation({
      id: "eligible",
      lineup: "balanced",
      statuses: { efficiency: "unknown" },
    }))).toBe(true);
    expect(eligibleModelTeamEvaluation(evaluation({
      id: "unknown-synthesis",
      lineup: "balanced",
      statuses: { synthesis: "unknown" },
    }))).toBe(false);
    expect(eligibleModelTeamEvaluation(evaluation({
      id: "failed-evidence",
      lineup: "balanced",
      statuses: { evidence: "failed" },
    }))).toBe(false);
  });

  it("ranks quality, repeated evidence, recency, then a stable key", () => {
    const weaker = evaluation({
      id: "weaker",
      lineup: "weaker",
      statuses: { efficiency: "unknown" },
    });
    const balancedOne = evaluation({
      id: "balanced-1",
      lineup: "balanced",
      evaluatedAt: "2026-07-23T00:00:03.000Z",
    });
    const balancedTwo = evaluation({
      id: "balanced-2",
      lineup: "balanced",
      evaluatedAt: "2026-07-23T00:00:04.000Z",
    });

    const selected = selectEvaluatedModelTeam({
      evaluations: [weaker, balancedTwo, balancedOne],
      selectedAt: "2026-07-23T00:00:05.000Z",
    });

    expect(selected?.lineup[0]?.connectionId).toBe("balanced-parent");
    expect(selected?.evidenceIds).toEqual(["balanced-1", "balanced-2"]);
    expect(selected?.rationale).toContain("2 eligible");
  });

  it("returns no selection when no real configured goal is eligible", () => {
    expect(selectEvaluatedModelTeam({
      evaluations: [evaluation({
        id: "ineligible",
        lineup: "lineup",
        statuses: { decomposition: "unknown" },
      })],
      selectedAt: "2026-07-23T00:00:05.000Z",
    })).toBeNull();
  });
});
