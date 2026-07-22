import { describe, expect, it } from "vitest";

import {
  getOperatingModePolicy,
  type CompanyBlueprintV2,
  type CompanyProjectV2,
  type OperatingModeId,
} from "@recurs/contracts";

import {
  approveCompanyBlueprintV2,
  compileCompanyBlueprintV2,
  type CompanyOrganizationDraftV1,
} from "../src/index.js";

const project: CompanyProjectV2 = {
  type: "existing_project",
  stage: "active",
  purpose: "Ship a dependable company-directed coding harness.",
  users: ["Software teams"],
  successCriteria: ["Every accepted change has independent evidence."],
  constraints: ["Children never exceed parent authority."],
  risks: ["Unbounded delegation"],
  architecturePreferences: ["Reuse existing runtime seams."],
  deploymentTargets: ["CLI"],
  repository: {
    inspected: true,
    markers: [".git", "package.json"],
    evidence: [{
      path: "package.json",
      finding: "The project is a TypeScript workspace.",
    }],
  },
};

function input(overrides: Partial<Parameters<typeof compileCompanyBlueprintV2>[0]> = {}) {
  return {
    id: "blueprint-1",
    companyId: "company-1",
    revision: 1,
    previousBlueprintId: null,
    createdAt: "2026-07-22T00:00:00.000Z",
    onboardingRunId: "onboarding-1",
    onboardingDepth: "guided" as const,
    generatedBy: "deterministic" as const,
    designMode: "stable_core_specialists" as const,
    project,
    permissionMode: "approved_for_me" as const,
    operatingModeId: "balanced_v6" as OperatingModeId,
    initialGoal: "Deliver the first independently reviewed company goal.",
    roadmap: ["Understand the project.", "Deliver a reviewed slice."],
    ...overrides,
  };
}

function dynamicOrganization(): CompanyOrganizationDraftV1 {
  return {
    departments: [{
      key: "leadership",
      displayName: "Leadership",
      purpose: "Own the goal and accountability.",
    }, {
      key: "delivery",
      displayName: "Delivery",
      purpose: "Deliver bounded changes.",
    }],
    roles: [{
      key: "root",
      displayName: "Root Orchestrator",
      kind: "orchestrator",
      departmentKey: "leadership",
      responsibility: "Own the approved goal.",
      instructions: "Delegate only through the approved organization.",
      reportsToKey: null,
      capabilities: ["plan"],
      executionProfileId: null,
      permissionMode: "full_access",
      toolBundles: ["project_context_v1"],
      expectedEvidence: ["A grounded synthesis."],
      activation: "always",
    }, {
      key: "builder",
      displayName: "Builder",
      kind: "worker",
      departmentKey: "delivery",
      responsibility: "Implement one bounded assignment.",
      instructions: "Change only the assigned scope.",
      reportsToKey: "root",
      capabilities: ["implement"],
      executionProfileId: "implement_v2",
      permissionMode: "full_access",
      toolBundles: ["implementation_v1"],
      expectedEvidence: ["Changed paths and tests."],
      activation: "on_demand",
    }, {
      key: "reviewer",
      displayName: "Independent Reviewer",
      kind: "reviewer",
      departmentKey: "leadership",
      responsibility: "Review independently.",
      instructions: "Return findings or evidence-backed approval.",
      reportsToKey: "root",
      capabilities: ["review"],
      executionProfileId: "review_v2",
      permissionMode: "ask_always",
      toolBundles: ["quality_v1"],
      expectedEvidence: ["Structured review findings."],
      activation: "always",
    }],
    rootRoleKey: "root",
    independentReviewRoleKeys: ["reviewer"],
    defaultActiveRoleKeys: ["root", "reviewer", "builder"],
  };
}

function maximumReportingDepth(blueprint: CompanyBlueprintV2): number {
  const roles = new Map(blueprint.roles.map((role) => [role.id, role]));
  return Math.max(...blueprint.roles.map((role) => {
    let depth = 0;
    let current = role;
    while (current.reportsTo !== null) {
      current = roles.get(current.reportsTo)!;
      depth += 1;
    }
    return depth;
  }));
}

describe("compileCompanyBlueprintV2", () => {
  it("builds a bounded stable core with mandatory accountability", () => {
    const blueprint = compileCompanyBlueprintV2(input());

    expect(blueprint).toMatchObject({
      version: 2,
      companyId: "company-1",
      state: "proposed",
      designMode: "stable_core_specialists",
      approvedAt: null,
    });
    expect(blueprint.departments.map((department) => department.id)).toEqual([
      "product", "engineering", "qa", "security", "tools", "deployment",
    ]);
    expect(blueprint.roles).toHaveLength(8);
    const root = blueprint.roles.find((role) => role.id === blueprint.authorityAnchors.rootRoleId)!;
    const reviewer = blueprint.roles.find((role) =>
      role.id === blueprint.authorityAnchors.independentReviewRoleIds[0]
    )!;
    expect(root).toMatchObject({ kind: "orchestrator", reportsTo: null });
    expect(reviewer).toMatchObject({
      kind: "reviewer",
      activation: "always",
      reportsTo: root.id,
    });
    expect(blueprint.activation.defaultActiveRoleIds).toContain(root.id);
    expect(blueprint.activation.defaultActiveRoleIds).toContain(reviewer.id);
  });

  it("keeps opaque role IDs stable across blueprint revisions", () => {
    const first = compileCompanyBlueprintV2(input());
    const second = compileCompanyBlueprintV2(input({
      id: "blueprint-2",
      revision: 2,
      previousBlueprintId: first.id,
      initialGoal: "Deliver the next reviewed goal.",
    }));

    expect(second.roles.map((role) => role.id)).toEqual(
      first.roles.map((role) => role.id),
    );
    expect(second.id).not.toBe(first.id);
    expect(second.companyId).toBe(first.companyId);
  });

  it("clamps reporting depth and active roles to the operating mode", () => {
    const economy = compileCompanyBlueprintV2(input({
      operatingModeId: "economy_v6",
    }));
    const balanced = compileCompanyBlueprintV2(input());
    const economyRoot = economy.authorityAnchors.rootRoleId;
    const economyBuilder = economy.roles.find((role) => role.displayName === "Scoped Builder")!;
    const balancedLead = balanced.roles.find((role) =>
      role.displayName === "Implementation Lead"
    )!;
    const balancedBuilder = balanced.roles.find((role) =>
      role.displayName === "Scoped Builder"
    )!;

    expect(economy.activation.defaultActiveRoleIds).toHaveLength(3);
    expect(economyBuilder.reportsTo).toBe(economyRoot);
    expect(balancedBuilder.reportsTo).toBe(balancedLead.id);
  });

  it.each([
    "economy_v6",
    "standard_v6",
    "balanced_v6",
    "performance_v6",
    "max_v6",
  ] as const)("honors every %s company ceiling", (operatingModeId) => {
    const blueprint = compileCompanyBlueprintV2(input({ operatingModeId }));
    const policy = getOperatingModePolicy(operatingModeId).company!;

    expect(blueprint.departments.length).toBeLessThanOrEqual(policy.maxDepartments);
    expect(blueprint.roles.length).toBeLessThanOrEqual(policy.maxRoles);
    expect(blueprint.activation.defaultActiveRoleIds.length)
      .toBeLessThanOrEqual(policy.maxActiveRoles);
    expect(maximumReportingDepth(blueprint)).toBeLessThanOrEqual(policy.maxDepth);
  });

  it("compiles a dynamic organization while narrowing role authority", () => {
    const blueprint = compileCompanyBlueprintV2(input({
      designMode: "guardrailed_dynamic",
      organization: dynamicOrganization(),
      permissionMode: "approved_for_me",
      availableToolBundles: ["project_context_v1", "quality_v1"],
    }));

    expect(blueprint.departments.every((department) =>
      department.id.startsWith("department_")
    )).toBe(true);
    expect(blueprint.roles.every((role) => role.permissionMode !== "full_access"))
      .toBe(true);
    expect(blueprint.toolPlan.find((tool) => tool.id === "implementation_v1"))
      .toMatchObject({ status: "required" });
  });

  it("rejects missing mode-specific organization input and unknown references", () => {
    expect(() => compileCompanyBlueprintV2(input({
      designMode: "guardrailed_dynamic",
    }))).toThrow("requires an organization draft");
    expect(() => compileCompanyBlueprintV2(input({
      organization: dynamicOrganization(),
    }))).toThrow("owns its baseline organization");

    const organization = dynamicOrganization();
    const invalidOrganization: CompanyOrganizationDraftV1 = {
      ...organization,
      roles: organization.roles.map((role, index) => index === 1
        ? { ...role, reportsToKey: "missing" }
        : role),
    };
    expect(() => compileCompanyBlueprintV2(input({
      designMode: "guardrailed_dynamic",
      organization: invalidOrganization,
    }))).toThrow("unknown role or department");
  });

  it("requires an explicit proposed-to-approved transition", () => {
    const proposed = compileCompanyBlueprintV2(input());
    const approved = approveCompanyBlueprintV2(
      proposed,
      "2026-07-22T00:01:00.000Z",
    );

    expect(approved).toMatchObject({
      state: "approved",
      approvedAt: "2026-07-22T00:01:00.000Z",
    });
    expect(() => approveCompanyBlueprintV2(
      approved,
      "2026-07-22T00:02:00.000Z",
    )).toThrow("Only a proposed");
  });
});
