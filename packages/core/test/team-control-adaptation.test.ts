import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  effectiveTeamControlPolicy,
  parseCompanyGoalRun,
  recommendedTeamControlPolicy,
  type CompanyGoalRun,
  type TeamControlPolicyV1,
} from "@recurs/contracts";
import {
  FileTeamControlPolicyStore,
  FileTeamControlRecommendationStore,
  TeamControlAdaptationService,
} from "../src/index.js";
import {
  companyBlueprintV2Fixture,
} from "../../contracts/test/company-v2-fixture.js";

const roots: string[] = [];
const workspace = "/tmp/recurs-adaptation-project";
const at = "2026-07-30T02:00:00.000Z";

async function stores() {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "recurs-adaptation-")),
  );
  roots.push(root);
  return {
    policies: new FileTeamControlPolicyStore(path.join(root, "policies")),
    recommendations: new FileTeamControlRecommendationStore(
      path.join(root, "recommendations"),
    ),
  };
}

function blueprint(policy: TeamControlPolicyV1) {
  if (policy.operatingModeId !== "balanced_v6") {
    throw new TypeError("The adaptation fixture requires balanced mode");
  }
  return companyBlueprintV2Fixture();
}

function completedRun(
  id: string,
  policy: TeamControlPolicyV1,
  assignmentsStarted: number,
  requestsUsed: number,
  cost: number | null,
): CompanyGoalRun {
  const approved = blueprint(policy);
  const assignment = {
    id: `assignment-${id}`,
    roleId: "worker",
    parentAssignmentId: null,
    dependsOn: [],
    description: "Complete the bounded task.",
    prompt: "Implement and return evidence.",
    acceptance: ["The task is complete."],
    expectedEvidence: ["A file path."],
    status: "completed" as const,
    result: {
      summary: "Completed.",
      evidence: ["packages/core/src/example.ts"],
      usage: cost === null
        ? null
        : { inputTokens: 10, outputTokens: 5, costUsd: cost },
      usageSource: cost === null ? "unknown" as const : "provider" as const,
    },
    failure: null,
  };
  return parseCompanyGoalRun({
    id,
    version: 2,
    parentSessionId: "parent-session",
    goalId: `goal-${id}`,
    objective: "Complete a bounded task.",
    company: {
      blueprintVersion: 2,
      blueprintId: approved.id,
      blueprintRevision: approved.revision,
      roleId: approved.authorityAnchors.rootRoleId,
      roleVersion: 1,
    },
    status: "completed",
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: `2026-07-30T01:0${id.endsWith("1") ? "1" : "2"}:00.000Z`,
    plan: {
      revision: 1,
      createdAt: "2026-07-30T00:00:00.000Z",
      assignments: [assignment],
    },
    budget: {
      maxAssignments: policy.maxActiveAgents,
      assignmentsStarted,
      maxConcurrentAssignments: policy.maxConcurrentAgents,
      maxRequests: policy.maxRequests,
      requestsReserved: requestsUsed,
      requestsUsed,
      maxReportedCostUsd: policy.maxReportedCostUsd,
      reportedCostUsd: cost ?? 0,
    },
    result: {
      summary: "Company goal completed.",
      evidence: ["packages/core/src/example.ts"],
    },
    failure: null,
    teamControl: {
      selected: policy,
      effective: effectiveTeamControlPolicy(policy, approved),
    },
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("TeamControlAdaptationService", () => {
  it("requires repeated compatible evidence and proposes only narrower limits", async () => {
    const state = await stores();
    const policy = recommendedTeamControlPolicy("balanced_v6");
    const first = completedRun("run-1", policy, 3, 20, 0.4);
    const second = completedRun("run-2", policy, 4, 24, null);
    let runs: readonly CompanyGoalRun[] = [first];
    const service = new TeamControlAdaptationService({
      ...state,
      runs: { async list() { return runs; } },
      createId: () => "recommendation-1",
    });

    await expect(service.recommendCompletedGoal({
      workspace,
      run: first,
      at,
    })).resolves.toBeNull();

    runs = [first, second];
    const recommendation = await service.recommendCompletedGoal({
      workspace,
      run: second,
      at,
    });

    expect(recommendation).toMatchObject({
      id: "recommendation-1",
      state: "proposed",
      blueprintId: "company-v2-fixture",
      blueprintRevision: 1,
      basePolicyRevision: null,
      supportingRuns: [
        { runId: "run-1", assignmentsStarted: 3, requestsUsed: 20 },
        {
          runId: "run-2",
          assignmentsStarted: 4,
          requestsUsed: 24,
          reportedCostUsd: null,
        },
      ],
      proposedPolicy: {
        revision: 1,
        maxActiveAgents: 4,
        maxRequests: 30,
        escalation: "manager_only",
        independentReview: "required",
      },
    });
    expect(recommendation!.reason).toMatch(/observed usage only/iu);
    expect(recommendation!.reason).not.toMatch(/better|superior|optimal/iu);
    expect(policy.maxActiveAgents).toBeGreaterThan(
      recommendation!.proposedPolicy.maxActiveAgents,
    );
    expect(policy.maxRequests).toBeGreaterThan(
      recommendation!.proposedPolicy.maxRequests,
    );

    const third = completedRun("run-3", policy, 3, 22, 0.3);
    runs = [first, second, third];
    await expect(service.recommendCompletedGoal({
      workspace,
      run: third,
      at,
    })).resolves.toEqual(recommendation);
    await expect(state.recommendations.list(workspace)).resolves.toHaveLength(1);
  });

  it("applies only after approval, preserves historical authority, and records rejection", async () => {
    const state = await stores();
    const policy = recommendedTeamControlPolicy("balanced_v6");
    const first = completedRun("run-1", policy, 3, 20, 0.4);
    const second = completedRun("run-2", policy, 4, 24, 0.5);
    const service = new TeamControlAdaptationService({
      ...state,
      runs: { async list() { return [first, second]; } },
      createId: () => "recommendation-approve",
    });
    const proposal = await service.recommendCompletedGoal({
      workspace,
      run: second,
      at,
    });

    await expect(state.policies.latest(workspace)).resolves.toBeNull();
    const approved = await service.approve({
      workspace,
      recommendationId: proposal!.id,
      company: second.company,
      at: "2026-07-30T03:00:00.000Z",
      decisionReason: "Use these limits for future goals.",
    });
    await expect(state.policies.latest(workspace)).resolves.toEqual(
      approved.proposedPolicy,
    );
    expect(approved.state).toBe("approved");
    expect(first.version === 2 && first.teamControl.selected).toEqual(policy);

    const rejectedState = await stores();
    const rejectionService = new TeamControlAdaptationService({
      ...rejectedState,
      runs: { async list() { return [first, second]; } },
      createId: () => "recommendation-reject",
    });
    const rejectedProposal = await rejectionService.recommendCompletedGoal({
      workspace,
      run: second,
      at,
    });
    const rejected = await rejectionService.reject({
      workspace,
      recommendationId: rejectedProposal!.id,
      company: second.company,
      at: "2026-07-30T03:00:00.000Z",
      decisionReason: "Keep the current headroom.",
    });

    expect(rejected.state).toBe("rejected");
    await expect(rejectedState.policies.latest(workspace)).resolves.toBeNull();
  });
});
