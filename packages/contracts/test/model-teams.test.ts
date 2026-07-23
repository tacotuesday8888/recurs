import { describe, expect, it } from "vitest";

import {
  COMPANY_EVALUATION_DIMENSIONS,
  parseModelTeamEvaluation,
  parseModelTeamSelection,
} from "../src/index.js";

const lineup = [
  ["parent", "gpt-5.6-sol", "high"],
  ["implement", "gpt-5.6-terra", "medium"],
  ["review", "gpt-5.6-luna", "medium"],
  ["repair", "gpt-5.6-terra", "medium"],
].map(([role, modelId, reasoningEffort]) => ({
  role,
  providerId: "openai-codex-chatgpt",
  adapterId: "codex-app-server",
  connectionId: `connection-${role}`,
  modelId,
  reasoningEffort,
}));

function report() {
  return {
    id: "company-evaluation-1",
    version: 1,
    scenarioId: "company_goal_execution_v1",
    scenarioVersion: 1,
    mode: "configured",
    status: "passed",
    startedAt: "2026-07-23T00:00:00.000Z",
    completedAt: "2026-07-23T00:00:01.000Z",
    latencyMs: 1_000,
    backend: {
      providerId: "openai-codex-chatgpt",
      modelId: "gpt-5.6-sol",
      fingerprint: "backend-1",
    },
    usage: {
      requestsUsed: 8,
      reportedCostUsd: 0,
      source: "provider",
    },
    rubric: COMPANY_EVALUATION_DIMENSIONS.map((dimension) => ({
      dimension,
      status: "passed",
      evidence: [`${dimension} passed.`],
    })),
    failures: [],
  };
}

function evaluation() {
  return {
    id: "model-team-evaluation-1",
    version: 1,
    taskClass: "general_coding",
    companyGoalRunId: "company-goal-1",
    evaluatedAt: "2026-07-23T00:00:02.000Z",
    lineup,
    report: report(),
  };
}

describe("model-team contracts", () => {
  it("accepts complete immutable configured-goal evidence and selections", () => {
    const parsed = parseModelTeamEvaluation(evaluation());
    const selection = parseModelTeamSelection({
      id: "model-team-selection-1",
      version: 1,
      taskClass: "general_coding",
      selectedAt: "2026-07-23T00:00:03.000Z",
      lineup,
      evidenceIds: [parsed.id],
      rationale: "One eligible configured company-goal evaluation supports this lineup.",
    });

    expect(parsed.lineup.map((route) => route.role)).toEqual([
      "parent",
      "implement",
      "review",
      "repair",
    ]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(selection)).toBe(true);
  });

  it.each([
    ["unknown field", (value: ReturnType<typeof evaluation>) =>
      Object.assign(value, { rank: 1 })],
    ["missing role", (value: ReturnType<typeof evaluation>) => {
      value.lineup[3] = { ...value.lineup[2]! };
    }],
    ["offline evidence", (value: ReturnType<typeof evaluation>) => {
      value.report.mode = "offline";
    }],
    ["wrong scenario", (value: ReturnType<typeof evaluation>) => {
      value.report.scenarioId = "company_formation_v1";
    }],
    ["unknown effort", (value: ReturnType<typeof evaluation>) => {
      value.lineup[0]!.reasoningEffort = "extreme";
    }],
  ])("rejects %s", (_label, mutate) => {
    const value = evaluation();
    mutate(value);
    expect(() => parseModelTeamEvaluation(value)).toThrow(TypeError);
  });

  it("rejects empty or duplicate selection evidence", () => {
    const base = {
      id: "model-team-selection-1",
      version: 1,
      taskClass: "general_coding",
      selectedAt: "2026-07-23T00:00:03.000Z",
      lineup,
      rationale: "Eligible configured evidence supports this lineup.",
    };
    expect(() =>
      parseModelTeamSelection({ ...base, evidenceIds: [] })
    ).toThrow(TypeError);
    expect(() =>
      parseModelTeamSelection({
        ...base,
        evidenceIds: ["evidence-1", "evidence-1"],
      })
    ).toThrow(TypeError);
  });
});
