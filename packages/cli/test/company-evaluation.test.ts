import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ScriptedProvider } from "@recurs/providers";
import {
  parseCompanyGoalRun,
  type CompanyBlueprintV2,
  type CompanyGoalRunV1,
} from "@recurs/contracts";
import {
  approveCompanyBlueprintV2,
  compileCompanyBlueprintV2,
} from "@recurs/core";

import { createStandaloneCompanyOnboarding } from "../src/assembly.js";
import {
  COMPANY_GOAL_EXECUTION_EVALUATION_SCENARIO,
  evaluateCompanyGoalExecution,
  evaluateCompanyFormation,
  renderCompanyEvaluationReport,
} from "../src/company-evaluation.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

function response(text: string, inputTokens = 10, outputTokens = 5) {
  return [
    { type: "text_delta" as const, text },
    { type: "usage" as const, inputTokens, outputTokens },
    { type: "done" as const, stopReason: "complete" as const },
  ];
}

function scriptedProvider() {
  return new ScriptedProvider([
    response(JSON.stringify({
      kind: "question",
      id: "product_outcome",
      question: "What should this company reliably deliver?",
    })),
    response(JSON.stringify({
      kind: "research",
      assignments: [{
        key: "package_shape",
        description: "Inspect the package manifest.",
        prompt: "Read package.json and identify the repository shape.",
      }],
    })),
    [
      {
        type: "tool_call",
        call: {
          id: "read-package",
          name: "read_file",
          arguments: { path: "package.json" },
        },
      },
      { type: "done", stopReason: "tool_calls" },
    ],
    response("The repository is a TypeScript workspace with a CLI package."),
    response(JSON.stringify({
      kind: "propose",
      project: {
        type: "existing_project",
        stage: "active",
        purpose: "Build Recurs as a dependable open-source coding-agent company for software maintainers.",
        users: ["Software maintainers"],
        successCriteria: [
          "Every implementation is independently reviewed with attributable evidence.",
        ],
        constraints: [
          "Delegated agents must remain within inherited authority and shared budgets.",
        ],
        risks: ["Unbounded or misleading delegation"],
        architecturePreferences: ["Reuse durable runtime and provider seams."],
        deploymentTargets: ["Recurs CLI"],
        repository: {
          inspected: true,
          markers: ["package.json"],
          evidence: [{
            path: "package.json",
            finding: "The repository is a TypeScript workspace with a CLI package.",
          }],
        },
      },
      initialGoal: "Deliver one bounded, independently reviewed company-directed coding change.",
      roadmap: [
        "Understand the current repository and authority boundaries.",
        "Implement and independently review the first bounded goal.",
      ],
    })),
  ], "scripted-evaluation");
}

async function fixture(provider: ScriptedProvider) {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "recurs-company-evaluation-")),
  );
  roots.push(root);
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "evaluation-fixture",
    workspaces: ["packages/*"],
  }));
  const service = await createStandaloneCompanyOnboarding({
    permissionMode: "approved_for_me",
    operatingModeId: "balanced_v6",
    repositoryConsent: true,
  }, {
    cwd: root,
    dataDirectory: path.join(root, "data"),
    skillHomeDirectory: path.join(root, "skill-home"),
    provider,
  });
  return { root, service };
}

describe("company formation evaluation", () => {
  it("runs the real restricted onboarding path and returns a safe report", async () => {
    const provider = scriptedProvider();
    const setup = await fixture(provider);
    const timestamps = [
      "2026-07-22T00:00:00.000Z",
      "2026-07-22T00:00:01.250Z",
    ];
    const progress: unknown[] = [];
    const report = await evaluateCompanyFormation({
      service: setup.service,
      mode: "offline",
      backend: { providerId: provider.id, modelId: "offline-baseline" },
      now: () => timestamps.shift()!,
      async onProgress(event) { progress.push(event); },
    });

    expect(report).toMatchObject({
      status: "passed",
      latencyMs: 1_250,
      usage: { requestsUsed: 5, reportedCostUsd: 0, source: "provider" },
    });
    expect(report.rubric.find((item) => item.dimension === "synthesis"))
      .toMatchObject({ status: "not_applicable" });
    expect(provider.requests).toHaveLength(5);
    expect(progress).toEqual([
      { phase: "preparing", message: "Preparing company_formation_v1." },
      { phase: "interview", message: "Company interview · question 1" },
      {
        phase: "research",
        message: "Project understanding · 1 bounded investigation complete",
      },
      { phase: "proposal", message: "Company proposal · ready for review" },
      { phase: "scoring", message: "Scoring company_formation_v1." },
    ]);
    expect(provider.requests.every((request) => request.tools.every((tool) =>
      !["apply_patch", "run_command", "web_fetch"].includes(tool.name)
    ))).toBe(true);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("What should this company");
    expect(serialized).not.toContain("Build Recurs as");
    expect(renderCompanyEvaluationReport(report)).toContain("Status: passed");
  });

  it("fails safely on invalid model output without persisting raw output", async () => {
    const secret = `sk-proj-${"q".repeat(30)}`;
    const provider = new ScriptedProvider([
      response(`not-json ${secret}`),
    ], "scripted-evaluation");
    const setup = await fixture(provider);
    const timestamps = [
      "2026-07-22T00:00:00.000Z",
      "2026-07-22T00:00:00.100Z",
    ];

    const report = await evaluateCompanyFormation({
      service: setup.service,
      mode: "offline",
      backend: { providerId: provider.id, modelId: "offline-baseline" },
      now: () => timestamps.shift()!,
    });

    expect(report.status).toBe("failed");
    expect(report.failures).toEqual([
      expect.objectContaining({ code: "evaluation_failed" }),
    ]);
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it("reports pre-start cancellation truthfully", async () => {
    const provider = scriptedProvider();
    const setup = await fixture(provider);
    const controller = new AbortController();
    controller.abort();
    const timestamps = [
      "2026-07-22T00:00:00.000Z",
      "2026-07-22T00:00:00.000Z",
    ];

    const report = await evaluateCompanyFormation({
      service: setup.service,
      mode: "configured",
      backend: { providerId: provider.id, modelId: "configured-model" },
      signal: controller.signal,
      now: () => timestamps.shift()!,
    });

    expect(report).toMatchObject({
      status: "cancelled",
      usage: { requestsUsed: 0, reportedCostUsd: null, source: "unknown" },
      failures: [{ code: "cancelled" }],
    });
    expect(provider.requests).toHaveLength(0);
  });

  it("fails safely when a progress consumer fails", async () => {
    const provider = scriptedProvider();
    const setup = await fixture(provider);
    const secret = `sk-proj-${"p".repeat(30)}`;

    const report = await evaluateCompanyFormation({
      service: setup.service,
      mode: "offline",
      backend: { providerId: provider.id, modelId: "offline-baseline" },
      async onProgress() { throw new Error(`private progress ${secret}`); },
    });

    expect(report).toMatchObject({
      status: "failed",
      usage: { requestsUsed: 0 },
      failures: [{ code: "evaluation_failed" }],
    });
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(provider.requests).toHaveLength(0);
  });
});

function executionBlueprint(): CompanyBlueprintV2 {
  const common = {
    departmentKey: "delivery",
    permissionMode: "approved_for_me" as const,
    activation: "always" as const,
  };
  return approveCompanyBlueprintV2(compileCompanyBlueprintV2({
    id: "blueprint-evaluation-execution",
    companyId: "company-evaluation-execution",
    revision: 1,
    previousBlueprintId: null,
    createdAt: "2026-07-22T01:00:00.000Z",
    onboardingRunId: "onboarding-evaluation-execution",
    onboardingDepth: "guided",
    generatedBy: "deterministic",
    designMode: "guardrailed_dynamic",
    project: {
      type: "existing_project",
      stage: "active",
      purpose: "Evaluate one bounded and independently reviewed company goal.",
      users: ["Maintainers"],
      successCriteria: ["Every assignment returns attributable evidence."],
      constraints: ["Never widen delegated authority."],
      risks: [],
      architecturePreferences: ["Use the durable company supervisor."],
      deploymentTargets: ["CLI"],
      repository: { inspected: true, markers: ["package.json"], evidence: [] },
    },
    permissionMode: "approved_for_me",
    operatingModeId: "balanced_v6",
    organization: {
      departments: [{
        key: "delivery",
        displayName: "Delivery",
        purpose: "Plan, implement, and independently review bounded work.",
      }],
      roles: [{
        ...common,
        key: "orchestrator",
        displayName: "Orchestrator",
        kind: "orchestrator",
        responsibility: "Own the goal and shared budget.",
        instructions: "Delegate only through the approved graph.",
        reportsToKey: null,
        capabilities: ["plan"],
        executionProfileId: null,
        toolBundles: ["project_context_v1"],
        expectedEvidence: ["A final synthesis."],
      }, {
        ...common,
        key: "lead",
        displayName: "Delivery Lead",
        kind: "lead",
        responsibility: "Plan one bounded implementation frontier.",
        instructions: "Return concrete repository evidence.",
        reportsToKey: "orchestrator",
        capabilities: ["plan", "research"],
        executionProfileId: "explore_v1",
        toolBundles: ["project_context_v1"],
        expectedEvidence: ["A cited implementation seam."],
      }, {
        ...common,
        key: "worker",
        displayName: "Implementation Worker",
        kind: "worker",
        responsibility: "Implement and repair one bounded change.",
        instructions: "Work only in the isolated candidate workspace.",
        reportsToKey: "lead",
        capabilities: ["implement", "repair"],
        executionProfileId: "implement_v2",
        toolBundles: ["project_context_v1", "implementation_v1"],
        expectedEvidence: ["A verified implementation patch."],
      }, {
        ...common,
        key: "reviewer",
        displayName: "Independent Reviewer",
        kind: "reviewer",
        responsibility: "Review every company handoff independently.",
        instructions: "Approve only with attributable evidence.",
        reportsToKey: "orchestrator",
        capabilities: ["review"],
        executionProfileId: "review_v2",
        permissionMode: "ask_always",
        toolBundles: ["quality_v1"],
        expectedEvidence: ["Evidence-backed approval or findings."],
      }],
      rootRoleKey: "orchestrator",
      independentReviewRoleKeys: ["reviewer"],
      defaultActiveRoleKeys: ["orchestrator", "lead", "worker", "reviewer"],
    },
    availableToolBundles: [
      "project_context_v1",
      "implementation_v1",
      "quality_v1",
    ],
    initialGoal: "Complete one evaluated company goal.",
    roadmap: ["Evaluate the durable goal result."],
  }), "2026-07-22T01:00:01.000Z");
}

function executionRun(
  blueprint: CompanyBlueprintV2,
  overrides: Partial<CompanyGoalRunV1> = {},
): CompanyGoalRunV1 {
  const lead = blueprint.roles.find((role) => role.executionProfileId === "explore_v1")!;
  const worker = blueprint.roles.find((role) => role.executionProfileId === "implement_v2")!;
  const reviewer = blueprint.roles.find((role) => role.executionProfileId === "review_v2")!;
  const result = (summary: string, evidence: string) => ({
    summary,
    evidence: [evidence],
    usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.02 },
    usageSource: "provider" as const,
  });
  return parseCompanyGoalRun({
    id: "run-evaluation-execution",
    version: 1,
    parentSessionId: "session-evaluation-execution",
    goalId: "goal-evaluation-execution",
    objective: "Deliver one evaluated and independently reviewed change.",
    company: {
      blueprintId: blueprint.id,
      blueprintVersion: 2,
      blueprintRevision: blueprint.revision,
      roleId: blueprint.authorityAnchors.rootRoleId,
      roleVersion: 1,
    },
    status: "completed",
    createdAt: "2026-07-22T01:00:02.000Z",
    updatedAt: "2026-07-22T01:00:05.000Z",
    plan: {
      revision: 1,
      createdAt: "2026-07-22T01:00:02.000Z",
      assignments: [{
        id: "lead-assignment",
        roleId: lead.id,
        parentAssignmentId: null,
        dependsOn: [],
        description: "Plan the bounded change.",
        prompt: "Return a concrete plan.",
        acceptance: ["Identify the implementation seam."],
        expectedEvidence: lead.expectedEvidence,
        status: "completed",
        result: result("Located the company evaluation seam.", "packages/cli/src/company-evaluation.ts"),
        failure: null,
      }, {
        id: "implementation-assignment",
        roleId: worker.id,
        parentAssignmentId: "lead-assignment",
        dependsOn: [],
        description: "Implement the bounded change.",
        prompt: "Implement and verify the change.",
        acceptance: ["Return a verified patch."],
        expectedEvidence: worker.expectedEvidence,
        status: "completed",
        result: result("Implemented and verified the change.", "verification:passed"),
        failure: null,
      }, {
        id: "review-assignment",
        roleId: reviewer.id,
        parentAssignmentId: null,
        dependsOn: ["lead-assignment", "implementation-assignment"],
        description: "Independently review the complete result.",
        prompt: "Review every non-review assignment.",
        acceptance: ["Approve or return concrete findings."],
        expectedEvidence: reviewer.expectedEvidence,
        status: "completed",
        result: result("Approved the complete result.", "review:approved"),
        failure: null,
      }],
    },
    budget: {
      maxAssignments: 8,
      assignmentsStarted: 3,
      maxConcurrentAssignments: 3,
      maxRequests: 80,
      requestsReserved: 24,
      requestsUsed: 3,
      maxReportedCostUsd: 3,
      reportedCostUsd: 0.06,
    },
    result: {
      summary: "The bounded implementation completed with independent review.",
      evidence: ["verification:passed", "review:approved"],
    },
    failure: null,
    ...overrides,
  });
}

describe("company goal execution evaluation", () => {
  it("scores one completed reviewed durable run without claiming interview quality", () => {
    const blueprint = executionBlueprint();
    const report = evaluateCompanyGoalExecution({
      run: executionRun(blueprint),
      blueprint,
      mode: "offline",
      backend: { providerId: "scripted", modelId: "offline-execution" },
      startedAt: "2026-07-22T01:00:00.000Z",
      completedAt: "2026-07-22T01:00:06.000Z",
    });

    expect(COMPANY_GOAL_EXECUTION_EVALUATION_SCENARIO.id)
      .toBe("company_goal_execution_v1");
    expect(report).toMatchObject({
      scenarioId: "company_goal_execution_v1",
      status: "passed",
      usage: { requestsUsed: 3, reportedCostUsd: 0.06, source: "provider" },
    });
    expect(report.rubric.find((item) => item.dimension === "interview_quality"))
      .toMatchObject({ status: "not_applicable" });
    expect(report.rubric.find((item) => item.dimension === "blueprint_tailoring"))
      .toMatchObject({ status: "not_applicable" });
    expect(report.rubric.filter((item) =>
      ["decomposition", "evidence", "synthesis", "efficiency"].includes(item.dimension)
    ).every((item) => item.status === "passed")).toBe(true);
  });

  it("reports unknown cost and structural rubric failures without inventing quality", () => {
    const blueprint = executionBlueprint();
    const stored = executionRun(blueprint);
    const withoutReview = executionRun(blueprint, {
      plan: {
        ...stored.plan,
        assignments: stored.plan.assignments.filter((assignment) =>
          assignment.id !== "review-assignment"
        ).map((assignment, index) => index === 0
          ? {
              ...assignment,
              result: { ...assignment.result!, usage: null, usageSource: "unknown" as const },
            }
          : assignment),
      },
      result: {
        summary: "The result lacks independent review evidence.",
        evidence: ["implementation:evidence"],
      },
    });

    const first = evaluateCompanyGoalExecution({
      run: withoutReview,
      blueprint,
      mode: "configured",
      backend: { providerId: "configured", modelId: "configured-model" },
      startedAt: "2026-07-22T01:00:00.000Z",
      completedAt: "2026-07-22T01:00:06.000Z",
    });
    const second = evaluateCompanyGoalExecution({
      run: withoutReview,
      blueprint,
      mode: "configured",
      backend: { providerId: "configured", modelId: "configured-model" },
      startedAt: "2026-07-22T01:00:00.000Z",
      completedAt: "2026-07-22T01:00:06.000Z",
    });

    expect(first).toEqual(second);
    expect(first.status).toBe("failed");
    expect(first.usage).toEqual({
      requestsUsed: 3,
      reportedCostUsd: null,
      source: "unknown",
    });
    expect(first.rubric.find((item) => item.dimension === "decomposition"))
      .toMatchObject({ status: "failed" });
    expect(first.rubric.find((item) => item.dimension === "evidence"))
      .toMatchObject({ status: "passed" });
    expect(first.rubric.find((item) => item.dimension === "efficiency"))
      .toMatchObject({ status: "unknown" });
  });

  it.each(["failed", "interrupted", "cancelled"] as const)(
    "reports a %s durable run truthfully and sanitizes its failure",
    (status) => {
      const blueprint = executionBlueprint();
      const secret = `sk-proj-${"z".repeat(30)}`;
      const terminal = executionRun(blueprint, {
        status,
        result: null,
        failure: status === "interrupted" ? null : `${status} ${secret}`,
      });
      const report = evaluateCompanyGoalExecution({
        run: terminal,
        blueprint,
        mode: "offline",
        backend: { providerId: "scripted", modelId: "offline-execution" },
        startedAt: "2026-07-22T01:00:00.000Z",
        completedAt: "2026-07-22T01:00:06.000Z",
      });

      expect(report.status).toBe(status === "cancelled" ? "cancelled" : "failed");
      expect(JSON.stringify(report)).not.toContain(secret);
      expect(report.failures).toHaveLength(1);
    },
  );

  it("fails an observed cost overrun and rejects corrupt missing evidence", () => {
    const blueprint = executionBlueprint();
    const stored = executionRun(blueprint);
    const overrun = executionRun(blueprint, {
      budget: { ...stored.budget, reportedCostUsd: 4 },
    });
    const overrunReport = evaluateCompanyGoalExecution({
      run: overrun,
      blueprint,
      mode: "offline",
      backend: { providerId: "scripted", modelId: "offline-execution" },
      startedAt: "2026-07-22T01:00:00.000Z",
      completedAt: "2026-07-22T01:00:06.000Z",
    });
    expect(overrunReport.status).toBe("failed");
    expect(overrunReport.rubric.find((item) => item.dimension === "efficiency"))
      .toMatchObject({ status: "failed" });

    const corrupt = {
      ...stored,
      result: { ...stored.result!, evidence: [] },
    } as CompanyGoalRunV1;
    const corruptReport = evaluateCompanyGoalExecution({
      run: corrupt,
      blueprint,
      mode: "offline",
      backend: { providerId: "scripted", modelId: "offline-execution" },
      startedAt: "2026-07-22T01:00:00.000Z",
      completedAt: "2026-07-22T01:00:06.000Z",
    });
    expect(corruptReport).toMatchObject({
      status: "failed",
      failures: [{ code: "evaluation_failed" }],
    });
  });

  it("fails closed when a run is bound to a different blueprint revision", () => {
    const blueprint = executionBlueprint();
    const stored = executionRun(blueprint);
    const stale = {
      ...stored,
      company: { ...stored.company, blueprintRevision: 2 },
    } as CompanyGoalRunV1;
    const report = evaluateCompanyGoalExecution({
      run: stale,
      blueprint,
      mode: "offline",
      backend: { providerId: "scripted", modelId: "offline-execution" },
      startedAt: "2026-07-22T01:00:00.000Z",
      completedAt: "2026-07-22T01:00:06.000Z",
    });

    expect(report).toMatchObject({
      status: "failed",
      failures: [{ code: "evaluation_failed" }],
    });
  });
});
