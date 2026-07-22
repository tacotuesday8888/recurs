import { describe, expect, expectTypeOf, it } from "vitest";

import {
  parseCompanyBlueprintBindingV2,
  parseCompanyBlueprintV2,
  type CompanyBlueprintV2,
  type CompanyDesignMode,
  type CompanyOnboardingDepth,
} from "../src/index.js";

const validBlueprint: CompanyBlueprintV2 = {
  id: "company-v2-1",
  version: 2,
  revision: 1,
  previousBlueprintId: null,
  state: "approved",
  createdAt: "2026-07-22T00:00:00.000Z",
  approvedAt: "2026-07-22T00:01:00.000Z",
  designMode: "guardrailed_dynamic",
  project: {
    type: "existing_project",
    stage: "active",
    purpose: "Operate a dependable agent company.",
    users: ["Technical founders"],
    successCriteria: ["Every accepted change has independent evidence."],
    constraints: ["Never widen child authority."],
    risks: ["Unbounded delegation could waste resources."],
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
    purpose: "Own the approved goal and decisions.",
  }, {
    id: "engineering",
    version: 1,
    displayName: "Engineering",
    purpose: "Plan and implement bounded work.",
  }, {
    id: "quality",
    version: 1,
    displayName: "Quality",
    purpose: "Review work independently.",
  }],
  roles: [{
    id: "root_orchestrator",
    version: 1,
    displayName: "Orchestrator",
    kind: "orchestrator",
    departmentId: "leadership",
    responsibility: "Own the approved project outcome.",
    instructions: "Delegate only through approved company relationships.",
    reportsTo: null,
    delegatesTo: ["engineering_lead", "quality_reviewer"],
    capabilities: ["plan"],
    executionProfileId: null,
    permissionMode: "approved_for_me",
    modelRoute: "parent",
    toolBundles: ["project_context_v1"],
    expectedEvidence: ["A synthesized goal result."],
    activation: "always",
  }, {
    id: "engineering_lead",
    version: 1,
    displayName: "Engineering Lead",
    kind: "lead",
    departmentId: "engineering",
    responsibility: "Turn the goal into bounded engineering assignments.",
    instructions: "Return evidence and surface uncertainty.",
    reportsTo: "root_orchestrator",
    delegatesTo: ["scoped_builder"],
    capabilities: ["plan", "research"],
    executionProfileId: "explore_v1",
    permissionMode: "approved_for_me",
    modelRoute: "parent",
    toolBundles: ["project_context_v1", "architecture_v1"],
    expectedEvidence: ["A dependency-aware implementation plan."],
    activation: "always",
  }, {
    id: "scoped_builder",
    version: 1,
    displayName: "Scoped Builder",
    kind: "worker",
    departmentId: "engineering",
    responsibility: "Implement one bounded assignment.",
    instructions: "Change only the assigned scope.",
    reportsTo: "engineering_lead",
    delegatesTo: [],
    capabilities: ["implement"],
    executionProfileId: "implement_v2",
    permissionMode: "approved_for_me",
    modelRoute: "implement",
    toolBundles: ["implementation_v1"],
    expectedEvidence: ["Changed paths and verification evidence."],
    activation: "on_demand",
  }, {
    id: "quality_reviewer",
    version: 1,
    displayName: "Independent Quality Reviewer",
    kind: "reviewer",
    departmentId: "quality",
    responsibility: "Review accepted work independently.",
    instructions: "Approve only evidence-backed work.",
    reportsTo: "root_orchestrator",
    delegatesTo: [],
    capabilities: ["review"],
    executionProfileId: "review_v2",
    permissionMode: "ask_always",
    modelRoute: "review",
    toolBundles: ["quality_v1"],
    expectedEvidence: ["Structured findings or an evidence-backed approval."],
    activation: "always",
  }],
  authorityAnchors: {
    rootRoleId: "root_orchestrator",
    independentReviewRoleIds: ["quality_reviewer"],
  },
  activation: {
    defaultActiveRoleIds: [
      "root_orchestrator",
      "engineering_lead",
      "quality_reviewer",
    ],
  },
  toolPlan: [{
    id: "project_context_v1",
    status: "available",
    reason: "Understand the approved project context.",
  }, {
    id: "architecture_v1",
    status: "available",
    reason: "Plan bounded architecture changes.",
  }, {
    id: "implementation_v1",
    status: "available",
    reason: "Implement approved assignments.",
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
  roadmap: ["Understand the project.", "Deliver and review the first slice."],
  provenance: {
    onboardingRunId: "onboarding-1",
    depth: "guided",
    generatedBy: "model_assisted",
  },
};

describe("company blueprint V2 contracts", () => {
  it("keeps stable onboarding and design identifiers", () => {
    expectTypeOf<CompanyOnboardingDepth>().toEqualTypeOf<
      "quick" | "guided" | "deep"
    >();
    expectTypeOf<CompanyDesignMode>().toEqualTypeOf<
      "stable_core_specialists" | "guardrailed_dynamic"
    >();
  });

  it("parses and deeply freezes a guardrailed dynamic company", () => {
    const parsed = parseCompanyBlueprintV2(validBlueprint);
    expect(parsed).toEqual(validBlueprint);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.roles)).toBe(true);
    expect(Object.isFrozen(parsed.roles[1]?.delegatesTo)).toBe(true);
    expect(Object.isFrozen(parsed.project.repository.evidence)).toBe(true);
  });

  it("rejects missing accountability, cycles, escalation, and invalid routes", () => {
    expect(() => parseCompanyBlueprintV2({
      ...validBlueprint,
      authorityAnchors: { ...validBlueprint.authorityAnchors, independentReviewRoleIds: [] },
    })).toThrow(/review authority/iu);
    expect(() => parseCompanyBlueprintV2({
      ...validBlueprint,
      roles: validBlueprint.roles.map((role) => role.id === "engineering_lead"
        ? { ...role, reportsTo: "scoped_builder" }
        : role),
    })).toThrow(/delegation graph|acyclic/iu);
    expect(() => parseCompanyBlueprintV2({
      ...validBlueprint,
      authority: { ...validBlueprint.authority, permissionMode: "ask_always" },
    })).toThrow(/role policy/iu);
    expect(() => parseCompanyBlueprintV2({
      ...validBlueprint,
      roles: validBlueprint.roles.map((role) => role.id === "scoped_builder"
        ? { ...role, modelRoute: "review" }
        : role),
    })).toThrow(/role policy/iu);
  });

  it("rejects excess keys, unsafe evidence paths, and mode-bound overflow", () => {
    expect(() => parseCompanyBlueprintV2({ ...validBlueprint, extra: true }))
      .toThrow(/exact/iu);
    expect(() => parseCompanyBlueprintV2({
      ...validBlueprint,
      project: {
        ...validBlueprint.project,
        repository: {
          ...validBlueprint.project.repository,
          evidence: [{ path: "../.env", finding: "secret" }],
        },
      },
    })).toThrow(/unsafe/iu);
    expect(() => parseCompanyBlueprintV2({
      ...validBlueprint,
      authority: {
        ...validBlueprint.authority,
        operatingModeId: "economy_v6",
      },
    })).toThrow(/operating mode|depth|policy/iu);
  });

  it("parses an exact immutable V2 role binding", () => {
    const binding = parseCompanyBlueprintBindingV2({
      blueprintId: validBlueprint.id,
      blueprintVersion: 2,
      blueprintRevision: 1,
      roleId: "engineering_lead",
      roleVersion: 1,
    });
    expect(binding).toEqual({
      blueprintId: validBlueprint.id,
      blueprintVersion: 2,
      blueprintRevision: 1,
      roleId: "engineering_lead",
      roleVersion: 1,
    });
    expect(Object.isFrozen(binding)).toBe(true);
    expect(() => parseCompanyBlueprintBindingV2({ ...binding, extra: true }))
      .toThrow(/exact/iu);
  });
});
