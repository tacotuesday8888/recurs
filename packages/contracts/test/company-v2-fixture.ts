import type { CompanyBlueprintV2 } from "../src/index.js";

export function companyBlueprintV2Fixture(options: {
  readonly id?: string;
  readonly revision?: number;
  readonly previousBlueprintId?: string | null;
  readonly state?: "proposed" | "approved";
  readonly onboardingRunId?: string;
} = {}): CompanyBlueprintV2 {
  const state = options.state ?? "approved";
  return {
    id: options.id ?? "company-v2-fixture",
    version: 2,
    revision: options.revision ?? 1,
    previousBlueprintId: options.previousBlueprintId ?? null,
    state,
    createdAt: "2026-07-22T00:00:00.000Z",
    approvedAt: state === "approved" ? "2026-07-22T00:01:00.000Z" : null,
    designMode: "guardrailed_dynamic",
    project: {
      type: "existing_project",
      stage: "active",
      purpose: "Operate a dependable agent company.",
      users: ["Technical founders"],
      successCriteria: ["Every accepted change has independent evidence."],
      constraints: ["Never widen child authority."],
      risks: [],
      architecturePreferences: ["Reuse the durable Recurs runtime."],
      deploymentTargets: ["CLI"],
      repository: {
        inspected: true,
        markers: [".git", "package.json"],
        evidence: [{
          path: "package.json",
          finding: "The project is a TypeScript workspace.",
        }],
      },
    },
    authority: {
      permissionMode: "approved_for_me",
      operatingModeId: "balanced_v6",
      operatingModeVersion: 6,
    },
    departments: [{
      id: "leadership",
      version: 1,
      displayName: "Leadership",
      purpose: "Own the goal and independent review.",
    }],
    roles: [{
      id: "root_orchestrator",
      version: 1,
      displayName: "Orchestrator",
      kind: "orchestrator",
      departmentId: "leadership",
      responsibility: "Own the approved project outcome.",
      instructions: "Delegate only through approved relationships.",
      reportsTo: null,
      delegatesTo: ["quality_reviewer"],
      capabilities: ["plan"],
      executionProfileId: null,
      permissionMode: "approved_for_me",
      modelRoute: "parent",
      toolBundles: ["project_context_v1"],
      expectedEvidence: ["A synthesized goal result."],
      activation: "always",
    }, {
      id: "quality_reviewer",
      version: 1,
      displayName: "Independent Reviewer",
      kind: "reviewer",
      departmentId: "leadership",
      responsibility: "Review work independently.",
      instructions: "Approve only evidence-backed work.",
      reportsTo: "root_orchestrator",
      delegatesTo: [],
      capabilities: ["review"],
      executionProfileId: "review_v2",
      permissionMode: "ask_always",
      modelRoute: "review",
      toolBundles: ["quality_v1"],
      expectedEvidence: ["Structured findings or approval evidence."],
      activation: "always",
    }],
    authorityAnchors: {
      rootRoleId: "root_orchestrator",
      independentReviewRoleIds: ["quality_reviewer"],
    },
    activation: {
      defaultActiveRoleIds: ["root_orchestrator", "quality_reviewer"],
    },
    toolPlan: [{
      id: "project_context_v1",
      status: "available",
      reason: "Understand approved project context.",
    }, {
      id: "quality_v1",
      status: "available",
      reason: "Review work independently.",
    }],
    quality: {
      standard: "balanced",
      maxImplementers: 2,
      initialReviewers: 1,
      maxReviewers: 2,
      maxRepairRounds: 1,
      approvalRule: "unanimous",
    },
    initialGoal: "Deliver the first reviewed company-directed change.",
    roadmap: ["Understand the project.", "Deliver the first slice."],
    provenance: {
      onboardingRunId: options.onboardingRunId ?? "onboarding-fixture",
      depth: "guided",
      generatedBy: "model_assisted",
    },
  };
}
