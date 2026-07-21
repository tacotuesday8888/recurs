import { describe, expect, expectTypeOf, it } from "vitest";

import {
  COMPANY_DEPARTMENT_IDS,
  COMPANY_ROLE_IDS,
  parseCompanyBlueprint,
  parseCompanyBlueprintBinding,
  type CompanyBlueprintBinding,
  type CompanyBlueprintV1,
  type CompanyDevelopmentStyle,
} from "../src/index.js";

const validBlueprint: CompanyBlueprintV1 = {
  id: "company-1",
  version: 1,
  state: "approved",
  createdAt: "2026-07-21T00:00:00.000Z",
  approvedAt: "2026-07-21T00:01:00.000Z",
  project: {
    type: "web_app",
    stage: "prototype",
    purpose: "Build a dependable agent manager.",
    constraints: ["Keep authority monotonic."],
    repository: {
      inspected: true,
      markers: [".git", "package.json"],
    },
  },
  developmentStyle: "layered_company",
  authority: {
    permissionMode: "approved_for_me",
    operatingModeId: "balanced_v5",
    operatingModeVersion: 5,
  },
  roles: [{
    id: "orchestrator_v1",
    version: 1,
    displayName: "Orchestrator",
    department: "product",
    responsibility: "Own the project outcome.",
    instructions: "Coordinate the approved company without exceeding its limits.",
    executionProfileId: null,
    permissionMode: "approved_for_me",
    modelRoute: "parent",
    toolBundles: ["project_context_v1"],
  }, {
    id: "scoped_builder_v1",
    version: 1,
    displayName: "Scoped Builder",
    department: "engineering",
    responsibility: "Implement bounded changes.",
    instructions: "Change only what the task requires.",
    executionProfileId: "implement_v1",
    permissionMode: "approved_for_me",
    modelRoute: "implement",
    toolBundles: ["implementation_v1"],
  }],
  toolPlan: [{
    id: "project_context_v1",
    status: "available",
    reason: "Share bounded project context.",
  }, {
    id: "implementation_v1",
    status: "required",
    reason: "Make and verify scoped changes.",
  }],
  quality: {
    standard: "balanced",
    maxImplementers: 2,
    initialReviewers: 1,
    maxReviewers: 2,
    maxRepairRounds: 1,
    approvalRule: "unanimous",
  },
  initialGoal: "Produce the first reviewed implementation slice.",
};

describe("company blueprint contracts", () => {
  it("keeps stable role, department, style, and binding identifiers", () => {
    expect(COMPANY_ROLE_IDS).toEqual([
      "orchestrator_v1",
      "product_planner_v1",
      "tool_curator_v1",
      "architect_v1",
      "implementation_lead_v1",
      "scoped_builder_v1",
      "qa_reviewer_v1",
      "security_release_reviewer_v1",
    ]);
    expect(COMPANY_DEPARTMENT_IDS).toEqual([
      "product",
      "engineering",
      "qa",
      "security",
      "tools",
      "deployment",
    ]);
    expectTypeOf<CompanyDevelopmentStyle>().toEqualTypeOf<
      "layered_company" | "orchestrator" | "single_agent"
    >();
    expectTypeOf<CompanyBlueprintBinding>().toMatchTypeOf<{
      readonly blueprintId: string;
      readonly blueprintVersion: 1;
      readonly roleId: (typeof COMPANY_ROLE_IDS)[number];
      readonly roleVersion: 1;
    }>();
  });

  it("parses and deeply freezes one exact version-1 blueprint", () => {
    const parsed = parseCompanyBlueprint(validBlueprint);

    expect(parsed).toEqual(validBlueprint);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.project)).toBe(true);
    expect(Object.isFrozen(parsed.project.constraints)).toBe(true);
    expect(Object.isFrozen(parsed.roles)).toBe(true);
    expect(Object.isFrozen(parsed.roles[0])).toBe(true);
    expect(Object.isFrozen(parsed.roles[0]?.toolBundles)).toBe(true);
    expect(Object.isFrozen(parsed.toolPlan)).toBe(true);
    expect(Object.isFrozen(parsed.quality)).toBe(true);
  });

  it("rejects unknown versions, excess keys, and noncanonical timestamps", () => {
    expect(() => parseCompanyBlueprint({ ...validBlueprint, version: 2 }))
      .toThrow(/version/iu);
    expect(() => parseCompanyBlueprint({ ...validBlueprint, extra: true }))
      .toThrow(/exact/iu);
    expect(() => parseCompanyBlueprint({
      ...validBlueprint,
      approvedAt: "not-a-time",
    })).toThrow(/timestamp/iu);
  });

  it("rejects duplicate roles and invalid authority or role mappings", () => {
    expect(() => parseCompanyBlueprint({
      ...validBlueprint,
      roles: [...validBlueprint.roles, validBlueprint.roles[0]],
    })).toThrow(/unique/iu);
    expect(() => parseCompanyBlueprint({
      ...validBlueprint,
      authority: { ...validBlueprint.authority, operatingModeVersion: 4 },
    })).toThrow(/operating mode/iu);
    expect(() => parseCompanyBlueprint({
      ...validBlueprint,
      roles: validBlueprint.roles.map((role) => role.id === "scoped_builder_v1"
        ? { ...role, executionProfileId: "review_v1" }
        : role),
    })).toThrow(/execution profile/iu);
  });

  it("rejects escalation, unsafe repository facts, and invalid state transitions", () => {
    expect(() => parseCompanyBlueprint({
      ...validBlueprint,
      authority: { ...validBlueprint.authority, permissionMode: "ask_always" },
      roles: validBlueprint.roles.map((role) => ({
        ...role,
        permissionMode: "full_access" as const,
      })),
    })).toThrow(/permission/iu);
    expect(() => parseCompanyBlueprint({
      ...validBlueprint,
      project: {
        ...validBlueprint.project,
        repository: { inspected: true, markers: [".env"] },
      },
    })).toThrow(/marker/iu);
    expect(() => parseCompanyBlueprint({
      ...validBlueprint,
      state: "proposed",
    })).toThrow(/approvedAt/iu);
  });

  it("parses an exact immutable session binding", () => {
    const binding = parseCompanyBlueprintBinding({
      blueprintId: "company-1",
      blueprintVersion: 1,
      roleId: "scoped_builder_v1",
      roleVersion: 1,
    });

    expect(binding).toEqual({
      blueprintId: "company-1",
      blueprintVersion: 1,
      roleId: "scoped_builder_v1",
      roleVersion: 1,
    });
    expect(Object.isFrozen(binding)).toBe(true);
    expect(() => parseCompanyBlueprintBinding({ ...binding, roleVersion: 2 }))
      .toThrow(/version/iu);
    expect(() => parseCompanyBlueprintBinding({ ...binding, extra: true }))
      .toThrow(/exact/iu);
  });
});
