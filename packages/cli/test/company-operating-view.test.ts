import { describe, expect, it } from "vitest";

import {
  parseCompanyGoalRun,
  type CompanyBlueprintV2,
  type CompanyGoalAssignmentV1,
  type CompanyGoalRunV1,
} from "@recurs/contracts";
import {
  approveCompanyBlueprintV2,
  compileCompanyBlueprintV2,
} from "@recurs/core";

import {
  renderCompanyGoalRun,
  renderCompanyOperations,
} from "../src/company-operating-view.js";

const at = "2026-07-22T10:00:00.000Z";

function blueprint(): CompanyBlueprintV2 {
  return approveCompanyBlueprintV2(compileCompanyBlueprintV2({
    id: "blueprint-operations",
    companyId: "company-operations",
    revision: 1,
    previousBlueprintId: null,
    createdAt: at,
    onboardingRunId: "onboarding-operations",
    onboardingDepth: "guided",
    generatedBy: "deterministic",
    designMode: "stable_core_specialists",
    project: {
      type: "existing_project",
      stage: "active",
      purpose: "Operate a bounded coding-agent company from the Recurs CLI.",
      users: ["Maintainers"],
      successCriteria: ["Every implementation receives independent review."],
      constraints: ["Never widen delegated authority."],
      risks: [],
      architecturePreferences: ["Reuse durable company state."],
      deploymentTargets: ["CLI"],
      repository: { inspected: false, markers: [], evidence: [] },
    },
    permissionMode: "approved_for_me",
    operatingModeId: "balanced_v6",
    availableToolBundles: [
      "project_context_v1",
      "source_control_v1",
      "architecture_v1",
      "implementation_v1",
      "quality_v1",
      "security_v1",
      "release_v1",
    ],
    initialGoal: "Deliver one bounded and independently reviewed change.",
    roadmap: ["Inspect company operations."],
  }), at);
}

function assignments(company: CompanyBlueprintV2): readonly CompanyGoalAssignmentV1[] {
  const lead = company.roles.find((role) => role.executionProfileId === "explore_v1")!;
  const worker = company.roles.find((role) => role.executionProfileId === "implement_v2")!;
  const reviewer = company.roles.find((role) => role.executionProfileId === "review_v2")!;
  return [{
    id: "lead-assignment",
    roleId: lead.id,
    parentAssignmentId: null,
    dependsOn: [],
    description: "Plan the implementation frontier.",
    prompt: "Return a bounded plan.",
    acceptance: ["Identify one implementation seam."],
    expectedEvidence: lead.expectedEvidence,
    status: "completed",
    execution: {
      attempt: 1,
      childAgentId: "child-lead",
      childSessionId: "session-lead",
      taskId: "task-lead",
      startedAt: at,
      completedAt: "2026-07-22T10:00:01.000Z",
    },
    result: {
      summary: "Located the company command seam.",
      evidence: ["packages/cli/src/commands/company.ts"],
      usage: { inputTokens: 10, outputTokens: 4, costUsd: 0.01 },
      usageSource: "provider",
    },
    failure: null,
  }, {
    id: "implementation-assignment",
    roleId: worker.id,
    parentAssignmentId: "lead-assignment",
    dependsOn: [],
    description: "Implement the operating view.",
    prompt: "Implement and verify the view.",
    acceptance: ["Return a verified patch."],
    expectedEvidence: worker.expectedEvidence,
    status: "running",
    execution: {
      attempt: 1,
      teamRunId: "team-operations",
      teamRole: "implement",
      taskIndex: 1,
      startedAt: "2026-07-22T10:00:01.000Z",
      completedAt: null,
    },
    result: null,
    failure: null,
  }, {
    id: "review-assignment",
    roleId: reviewer.id,
    parentAssignmentId: null,
    dependsOn: ["lead-assignment", "implementation-assignment"],
    description: "Independently review the complete result.",
    prompt: "Review the complete candidate.",
    acceptance: ["Approve or return concrete findings."],
    expectedEvidence: reviewer.expectedEvidence,
    status: "pending",
    result: null,
    failure: null,
  }];
}

function run(
  company: CompanyBlueprintV2,
  overrides: Partial<CompanyGoalRunV1> = {},
): CompanyGoalRunV1 {
  return parseCompanyGoalRun({
    id: "run-operations",
    version: 1,
    parentSessionId: "session-parent",
    goalId: "goal-operations",
    objective: "Ship a truthful company operating view.",
    company: {
      blueprintId: company.id,
      blueprintVersion: 2,
      blueprintRevision: company.revision,
      roleId: company.authorityAnchors.rootRoleId,
      roleVersion: 1,
    },
    status: "running",
    createdAt: at,
    updatedAt: "2026-07-22T10:00:02.000Z",
    plan: { revision: 1, createdAt: at, assignments: assignments(company) },
    budget: {
      maxAssignments: 8,
      assignmentsStarted: 2,
      maxConcurrentAssignments: 3,
      maxRequests: 80,
      requestsReserved: 16,
      requestsUsed: 5,
      maxReportedCostUsd: 3,
      reportedCostUsd: 0.01,
    },
    result: null,
    failure: null,
    ...overrides,
  });
}

describe("company operating views", () => {
  it("renders an empty company snapshot without depicting idle roles as active", () => {
    const company = blueprint();

    expect(renderCompanyOperations(company, [])).toBe([
      "Company operations",
      "Company: company-operations | Blueprint: blueprint-operations r1",
      "Goals: 0 total | 0 active | 0 completed | 0 failed | 0 cancelled",
      "Active roles: none",
      "No company goal runs exist for this session and blueprint.",
    ].join("\n"));
  });

  it("renders bounded aggregate progress, accounting, and only actually running roles", () => {
    const company = blueprint();
    const running = run(company);
    const completed = run(company, {
      id: "run-completed",
      goalId: "goal-completed",
      objective: "Complete the earlier company goal.",
      status: "completed",
      updatedAt: "2026-07-22T09:00:00.000Z",
      plan: {
        revision: 1,
        createdAt: at,
        assignments: assignments(company).map((assignment) => ({
          ...assignment,
          status: "completed" as const,
          execution: assignment.execution === undefined
            ? {
                attempt: 1 as const,
                childAgentId: `child-${assignment.id}`,
                childSessionId: `session-${assignment.id}`,
                taskId: `task-${assignment.id}`,
                startedAt: at,
                completedAt: "2026-07-22T10:00:03.000Z",
              }
            : { ...assignment.execution, completedAt: "2026-07-22T10:00:03.000Z" },
          result: {
            summary: `Completed ${assignment.id}.`,
            evidence: [`evidence:${assignment.id}`],
            usage: null,
            usageSource: "unknown" as const,
          },
          failure: null,
        })),
      },
      result: {
        summary: "The earlier company goal completed.",
        evidence: ["evidence:goal"],
      },
    });

    const rendered = renderCompanyOperations(company, [completed, running]);

    expect(rendered).toContain(
      "Goals: 2 total | 1 active | 1 completed | 0 failed | 0 cancelled",
    );
    expect(rendered).toContain("Current: running | run-operations");
    expect(rendered).toContain("Progress: 1/3 completed | 1 running | 1 pending");
    expect(rendered).toContain("Requests: 5 used | 16 reserved | 80 max");
    expect(rendered).toContain("Reported cost: $0.0100 / $3.0000");
    expect(rendered).toContain(
      `Active roles: ${company.roles.find((role) => role.executionProfileId === "implement_v2")!.displayName}`,
    );
    expect(rendered).not.toContain(
      `Active roles: ${company.roles.find((role) => role.executionProfileId === "review_v2")!.displayName}`,
    );
  });

  it("renders exact assignment correlation, dependencies, evidence, and next state", () => {
    const company = blueprint();
    const stored = run(company);
    const unsafe = {
      ...stored,
      plan: {
        ...stored.plan,
        assignments: stored.plan.assignments.map((assignment) =>
          assignment.id === "implementation-assignment"
            ? { ...assignment, description: `${assignment.description}\u0007` }
            : assignment
        ),
      },
    } as CompanyGoalRunV1;
    const rendered = renderCompanyGoalRun(company, unsafe);

    expect(rendered).toContain("Goal: run-operations | running");
    expect(rendered).toContain("Progress: 1/3 completed | 1 running | 1 pending");
    expect(rendered).toContain("Assignments:");
    expect(rendered).toContain("child session-lead | task task-lead");
    expect(rendered).toContain("team team-operations | implement task 1");
    expect(rendered).toContain("depends on lead-assignment, implementation-assignment");
    expect(rendered).toContain("Evidence: 1 item | Usage: 10 in / 4 out / $0.0100");
    expect(rendered).toContain("Next: 1 assignment is running; no additional role is implied active.");
    expect(rendered).not.toContain("\u0007");
  });

  it("renders interruption, failure, unknown roles, and unknown usage truthfully", () => {
    const company = blueprint();
    const interrupted = run(company, {
      status: "interrupted",
      plan: {
        revision: 1,
        createdAt: at,
        assignments: assignments(company).map((assignment, index) => index === 0
          ? {
              ...assignment,
              roleId: "retired-role",
              result: { ...assignment.result!, usage: null, usageSource: "unknown" as const },
            }
          : assignment),
      },
    });
    const failedAssignments = assignments(company).map((assignment, index) => index === 1
      ? {
          ...assignment,
          status: "failed" as const,
          execution: {
            ...assignment.execution!,
            completedAt: "2026-07-22T10:00:03.000Z",
          },
          result: null,
          failure: "Verification failed.",
        }
      : assignment);
    const failed = run(company, {
      status: "failed",
      plan: { revision: 1, createdAt: at, assignments: failedAssignments },
      result: null,
      failure: "Verification failed.",
    });

    expect(renderCompanyGoalRun(company, interrupted)).toContain(
      "Next: The goal is interrupted; no agent is assumed to still be running.",
    );
    expect(renderCompanyGoalRun(company, interrupted)).toContain(
      "Unknown role (retired-role)",
    );
    expect(renderCompanyGoalRun(company, interrupted)).toContain("Usage: unknown");
    const unsafeFailed = {
      ...failed,
      failure: "Verification failed.\u001b[31m",
      plan: {
        ...failed.plan,
        assignments: failed.plan.assignments.map((assignment) =>
          assignment.id === "implementation-assignment"
            ? { ...assignment, failure: "Verification failed.\u001b[31m" }
            : assignment
        ),
      },
    } as CompanyGoalRunV1;
    const failedText = renderCompanyGoalRun(company, unsafeFailed);
    expect(failedText).toContain("Failure: Verification failed. [31m");
    expect(failedText).not.toContain("\u001b");
  });
});
