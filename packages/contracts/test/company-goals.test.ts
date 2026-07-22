import { describe, expect, it } from "vitest";

import {
  parseCompanyGoalBudget,
  parseCompanyGoalPlan,
  parseCompanyGoalRun,
  reserveCompanyGoalBudget,
  validateCompanyGoalPlanAgainstBlueprint,
  type CompanyGoalPlanV1,
  type CompanyGoalRunV1,
} from "../src/index.js";
import { companyBlueprintV2Fixture } from "./company-v2-fixture.js";

function planFixture(): CompanyGoalPlanV1 {
  return {
    revision: 1,
    createdAt: "2026-07-22T01:00:00.000Z",
    assignments: [{
      id: "review-assignment",
      roleId: "quality_reviewer",
      parentAssignmentId: null,
      dependsOn: [],
      description: "Review the company goal plan.",
      prompt: "Inspect the plan against the approved blueprint.",
      acceptance: ["Report concrete findings or approval."],
      expectedEvidence: ["Citations to the reviewed plan."],
      status: "pending",
      result: null,
      failure: null,
    }],
  };
}

function runFixture(): CompanyGoalRunV1 {
  return {
    id: "company-goal-run",
    version: 1,
    parentSessionId: "parent-session",
    goalId: "goal-1",
    objective: "Deliver a reviewed company foundation.",
    company: {
      blueprintId: "company-v2-fixture",
      blueprintVersion: 2,
      blueprintRevision: 1,
      roleId: "root_orchestrator",
      roleVersion: 1,
    },
    status: "created",
    createdAt: "2026-07-22T01:00:00.000Z",
    updatedAt: "2026-07-22T01:00:00.000Z",
    plan: planFixture(),
    budget: {
      maxAssignments: 8,
      assignmentsStarted: 0,
      maxConcurrentAssignments: 3,
      maxRequests: 80,
      requestsReserved: 0,
      requestsUsed: 0,
      maxReportedCostUsd: 3,
      reportedCostUsd: 0,
    },
    result: null,
    failure: null,
  };
}

describe("company goal contracts", () => {
  it("parses a plan and validates roles against the approved blueprint", () => {
    const plan = parseCompanyGoalPlan(planFixture());
    expect(Object.isFrozen(plan.assignments)).toBe(true);
    expect(() => validateCompanyGoalPlanAgainstBlueprint(
      plan,
      companyBlueprintV2Fixture(),
    )).not.toThrow();
    expect(() => validateCompanyGoalPlanAgainstBlueprint({
      ...plan,
      assignments: [{ ...plan.assignments[0]!, roleId: "missing-role" }],
    }, companyBlueprintV2Fixture())).toThrow(/not executable/iu);
  });

  it("rejects dependency cycles and dishonest assignment terminals", () => {
    const assignment = planFixture().assignments[0]!;
    expect(() => parseCompanyGoalPlan({
      ...planFixture(),
      assignments: [{ ...assignment, id: "a", dependsOn: ["b"] }, {
        ...assignment,
        id: "b",
        dependsOn: ["a"],
      }],
    })).toThrow(/cyclic/iu);
    expect(() => parseCompanyGoalPlan({
      ...planFixture(),
      assignments: [{ ...assignment, status: "completed" }],
    })).toThrow(/lifecycle/iu);
  });

  it("reserves one immutable shared-budget allocation and fails closed", () => {
    const budget = parseCompanyGoalBudget(runFixture().budget);
    const reserved = reserveCompanyGoalBudget(budget, 10);
    expect(reserved).toMatchObject({
      assignmentsStarted: 1,
      requestsReserved: 10,
    });
    expect(budget.assignmentsStarted).toBe(0);
    expect(() => parseCompanyGoalBudget({
      ...budget,
      requestsUsed: 1,
    })).toThrow(/exceeds/iu);
    expect(() => reserveCompanyGoalBudget({
      ...budget,
      assignmentsStarted: budget.maxAssignments,
    }, 1)).toThrow(/exhausted/iu);
  });

  it("parses and freezes a durable goal run with truthful terminal state", () => {
    const run = parseCompanyGoalRun(runFixture());
    expect(run).toEqual(runFixture());
    expect(Object.isFrozen(run)).toBe(true);
    expect(() => parseCompanyGoalRun({
      ...runFixture(),
      status: "completed",
    })).toThrow(/terminal/iu);
    expect(() => parseCompanyGoalRun({
      ...runFixture(),
      status: "failed",
      failure: "Worker failed.",
    })).not.toThrow();
  });
});
