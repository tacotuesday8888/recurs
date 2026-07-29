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
      dependsOn: ["implementation-assignment"],
      description: "Review the company goal plan.",
      prompt: "Inspect the plan against the approved blueprint.",
      acceptance: ["Report concrete findings or approval."],
      expectedEvidence: ["Citations to the reviewed plan."],
      status: "pending",
      result: null,
      failure: null,
    }, {
      id: "implementation-assignment",
      roleId: "scoped_builder",
      parentAssignmentId: null,
      dependsOn: [],
      description: "Implement the bounded company goal.",
      prompt: "Implement the approved scope and return concrete evidence.",
      acceptance: ["Return a verified bounded implementation."],
      expectedEvidence: ["Changed paths and verification evidence."],
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

  it("treats default-active roles as the complete executable assignment set", () => {
    const blueprint = companyBlueprintV2Fixture();
    const root = blueprint.roles[0]!;
    const reviewer = blueprint.roles[1]!;
    const planner = {
      ...reviewer,
      id: "active_planner",
      displayName: "Active Planner",
      kind: "specialist" as const,
      reportsTo: root.id,
      capabilities: ["plan" as const],
      executionProfileId: "explore_v1" as const,
      modelRoute: "parent" as const,
      toolBundles: ["project_context_v1" as const],
      activation: "on_demand" as const,
    };
    const reserve = {
      ...planner,
      id: "inactive_reserve",
      displayName: "Inactive Reserve",
    };
    const roster = {
      ...blueprint,
      roles: [
        { ...root, delegatesTo: [reviewer.id, planner.id, reserve.id] },
        reviewer,
        planner,
        reserve,
      ],
      activation: {
        defaultActiveRoleIds: [root.id, reviewer.id, planner.id],
      },
    };
    const review = planFixture().assignments[0]!;
    const plannerAssignment = {
      ...review,
      id: "planner-assignment",
      roleId: planner.id,
    };

    expect(() => validateCompanyGoalPlanAgainstBlueprint(
      { ...planFixture(), assignments: [review] },
      roster,
    )).toThrow(/every default-active role/iu);
    expect(() => validateCompanyGoalPlanAgainstBlueprint(
      {
        ...planFixture(),
        assignments: [
          review,
          { ...plannerAssignment, id: "reserve-assignment", roleId: reserve.id },
        ],
      },
      roster,
    )).toThrow(/not active/iu);
    expect(() => validateCompanyGoalPlanAgainstBlueprint(
      { ...planFixture(), assignments: [review, plannerAssignment] },
      roster,
    )).not.toThrow();
  });

  it("keeps historical inactive-role plans parseable but rejects their execution", () => {
    const blueprint = companyBlueprintV2Fixture();
    const root = blueprint.roles[0]!;
    const reviewer = blueprint.roles[1]!;
    const reserve = {
      ...reviewer,
      id: "historical_reserve",
      displayName: "Historical Reserve",
      kind: "specialist" as const,
      capabilities: ["research" as const],
      executionProfileId: "explore_v1" as const,
      modelRoute: "parent" as const,
      toolBundles: ["project_context_v1" as const],
      activation: "on_demand" as const,
    };
    const roster = {
      ...blueprint,
      roles: [
        { ...root, delegatesTo: [reviewer.id, reserve.id] },
        reviewer,
        reserve,
      ],
    };
    const historicalPlan = {
      ...planFixture(),
      assignments: [{
        ...planFixture().assignments[0]!,
        id: "historical-assignment",
        roleId: reserve.id,
        dependsOn: [],
      }],
    };

    expect(() => parseCompanyGoalPlan(historicalPlan)).not.toThrow();
    const historicalRun = parseCompanyGoalRun({
      ...runFixture(),
      plan: historicalPlan,
    });
    expect(historicalRun.plan.assignments[0]?.roleId).toBe(reserve.id);
    expect(() => validateCompanyGoalPlanAgainstBlueprint(
      historicalRun.plan,
      roster,
    )).toThrow(/not active/iu);
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
    expect(() => parseCompanyGoalPlan({
      ...planFixture(),
      assignments: [{
        ...assignment,
        dependsOn: [],
        status: "running",
        execution: {
          attempt: 1,
          childAgentId: "child-agent",
          childSessionId: "child-session",
          taskId: "child-task",
          startedAt: "2026-07-22T01:00:00.000Z",
          completedAt: "2026-07-22T00:59:59.000Z",
        },
      }],
    })).toThrow(/precedes/iu);
  });

  it("accepts an immutable team execution correlation without changing child records", () => {
    const assignment = planFixture().assignments[0]!;
    const team = parseCompanyGoalPlan({
      ...planFixture(),
      assignments: [{
        ...assignment,
        dependsOn: [],
        status: "running",
        execution: {
          attempt: 1,
          teamRunId: "team-run-1",
          teamRole: "review",
          taskIndex: null,
          startedAt: "2026-07-22T01:00:00.000Z",
          completedAt: null,
        },
      }],
    });
    expect(team.assignments[0]?.execution).toMatchObject({
      teamRunId: "team-run-1",
      teamRole: "review",
    });

    expect(() => parseCompanyGoalPlan({
      ...planFixture(),
      assignments: [{
        ...assignment,
        dependsOn: [],
        status: "running",
        execution: {
          attempt: 1,
          teamRunId: "team-run-1",
          teamRole: "implement",
          taskIndex: null,
          startedAt: "2026-07-22T01:00:00.000Z",
          completedAt: null,
        },
      }],
    })).toThrow(/task index/iu);
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
    expect(() => parseCompanyGoalBudget({
      ...budget,
      reportedCostUsd: budget.maxReportedCostUsd + 1,
    })).not.toThrow();
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
