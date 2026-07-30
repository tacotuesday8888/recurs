import { describe, expect, it } from "vitest";

import {
  effectiveTeamControlPolicy,
  parseCompanyBlueprintV2,
  parseCompanyGoalPlan,
  recommendedTeamControlPolicy,
  type CompanyBlueprintV2,
  type CompanyGoalPlanV1,
  type EffectiveTeamControlPolicyV1,
} from "@recurs/contracts";
import * as core from "../src/index.js";
import { companyBlueprintV2Fixture } from "../../contracts/test/company-v2-fixture.js";

type TeamPolicyApi = {
  readonly validateCompanyGoalPlanAgainstTeamControls: (
    plan: CompanyGoalPlanV1,
    blueprint: CompanyBlueprintV2,
    controls: EffectiveTeamControlPolicyV1,
  ) => void;
  readonly validateTeamEscalation: (
    input: {
      readonly assignmentId: string;
      readonly fromRoleId: string;
      readonly toRoleId: string;
      readonly summary: string;
      readonly evidence: readonly string[];
    },
    blueprint: CompanyBlueprintV2,
    controls: EffectiveTeamControlPolicyV1,
  ) => void;
};

const api = core as unknown as TeamPolicyApi;

function assignment(
  id: string,
  roleId: string,
  options: {
    readonly parentAssignmentId?: string | null;
    readonly dependsOn?: readonly string[];
  } = {},
): CompanyGoalPlanV1["assignments"][number] {
  return {
    id,
    roleId,
    parentAssignmentId: options.parentAssignmentId ?? null,
    dependsOn: options.dependsOn ?? [],
    description: `Complete ${id}.`,
    prompt: `Complete only the bounded ${id} assignment.`,
    acceptance: [`${id} is verified.`],
    expectedEvidence: [`Evidence for ${id}.`],
    status: "pending",
    result: null,
    failure: null,
  };
}

function plan(
  assignments: readonly CompanyGoalPlanV1["assignments"][number][],
): CompanyGoalPlanV1 {
  return parseCompanyGoalPlan({
    revision: 1,
    createdAt: "2026-07-30T12:00:00.000Z",
    assignments,
  });
}

function blueprintWithSecondBuilder(): CompanyBlueprintV2 {
  const blueprint = companyBlueprintV2Fixture();
  const root = blueprint.roles[0]!;
  const reviewer = blueprint.roles[1]!;
  const builder = blueprint.roles[2]!;
  const second = {
    ...builder,
    id: "second_builder",
    displayName: "Second Builder",
  };
  return parseCompanyBlueprintV2({
    ...blueprint,
    roles: [
      { ...root, delegatesTo: [reviewer.id, builder.id, second.id] },
      reviewer,
      builder,
      second,
    ],
    activation: {
      defaultActiveRoleIds: [
        root.id,
        reviewer.id,
        builder.id,
        second.id,
      ],
    },
  });
}

function hierarchicalBlueprint(): CompanyBlueprintV2 {
  const blueprint = companyBlueprintV2Fixture();
  const root = blueprint.roles[0]!;
  const reviewer = blueprint.roles[1]!;
  const builder = blueprint.roles[2]!;
  const lead = {
    ...builder,
    id: "research_lead",
    displayName: "Research Lead",
    kind: "lead" as const,
    responsibility: "Research and scope implementation.",
    reportsTo: root.id,
    delegatesTo: [builder.id],
    capabilities: ["research" as const],
    executionProfileId: "explore_v1" as const,
    permissionMode: "ask_always" as const,
    modelRoute: "parent" as const,
    toolBundles: ["project_context_v1" as const],
    expectedEvidence: ["Repository evidence."],
    activation: "always" as const,
  };
  return parseCompanyBlueprintV2({
    ...blueprint,
    roles: [
      { ...root, delegatesTo: [reviewer.id, lead.id] },
      reviewer,
      lead,
      { ...builder, reportsTo: lead.id },
    ],
    activation: {
      defaultActiveRoleIds: [root.id, reviewer.id, lead.id, builder.id],
    },
  });
}

function controls(
  blueprint: CompanyBlueprintV2,
  topology: EffectiveTeamControlPolicyV1["topology"],
  overrides: Record<string, unknown> = {},
): EffectiveTeamControlPolicyV1 {
  return effectiveTeamControlPolicy({
    ...recommendedTeamControlPolicy("balanced_v6"),
    topology,
    ...overrides,
  }, blueprint);
}

describe("company team-control validation", () => {
  it("keeps focused goals to one implementation branch", () => {
    const blueprint = blueprintWithSecondBuilder();
    const candidate = plan([
      assignment("build-a", "scoped_builder"),
      assignment("build-b", "second_builder"),
      assignment("review", "quality_reviewer", {
        dependsOn: ["build-a", "build-b"],
      }),
    ]);

    expect(() => api.validateCompanyGoalPlanAgainstTeamControls(
      candidate,
      blueprint,
      controls(blueprint, "focused"),
    )).toThrow(/focused/iu);
  });

  it("allows independent implementation branches under parallel controls", () => {
    const blueprint = blueprintWithSecondBuilder();
    const candidate = plan([
      assignment("build-a", "scoped_builder"),
      assignment("build-b", "second_builder"),
      assignment("review", "quality_reviewer", {
        dependsOn: ["build-a", "build-b"],
      }),
    ]);

    expect(() => api.validateCompanyGoalPlanAgainstTeamControls(
      candidate,
      blueprint,
      controls(blueprint, "parallel"),
    )).not.toThrow();
  });

  it("requires hierarchical assignments to follow reporting managers", () => {
    const blueprint = hierarchicalBlueprint();
    const valid = plan([
      assignment("research", "research_lead"),
      assignment("build", "scoped_builder", {
        parentAssignmentId: "research",
      }),
      assignment("review", "quality_reviewer", {
        dependsOn: ["build"],
      }),
    ]);
    const invalid = plan([
      assignment("research", "research_lead"),
      assignment("build", "scoped_builder"),
      assignment("review", "quality_reviewer", {
        dependsOn: ["build"],
      }),
    ]);

    expect(() => api.validateCompanyGoalPlanAgainstTeamControls(
      valid,
      blueprint,
      controls(blueprint, "hierarchical"),
    )).not.toThrow();
    expect(() => api.validateCompanyGoalPlanAgainstTeamControls(
      invalid,
      blueprint,
      controls(blueprint, "hierarchical"),
    )).toThrow(/manager/iu);
  });

  it("requires research to precede mutation in research-heavy goals", () => {
    const blueprint = hierarchicalBlueprint();
    const valid = plan([
      assignment("research", "research_lead"),
      assignment("build", "scoped_builder", {
        dependsOn: ["research"],
      }),
      assignment("review", "quality_reviewer", {
        dependsOn: ["build"],
      }),
    ]);
    const invalid = plan([
      assignment("research", "research_lead"),
      assignment("build", "scoped_builder"),
      assignment("review", "quality_reviewer", {
        dependsOn: ["build"],
      }),
    ]);

    expect(() => api.validateCompanyGoalPlanAgainstTeamControls(
      valid,
      blueprint,
      controls(blueprint, "research_heavy"),
    )).not.toThrow();
    expect(() => api.validateCompanyGoalPlanAgainstTeamControls(
      invalid,
      blueprint,
      controls(blueprint, "research_heavy"),
    )).toThrow(/research/iu);
  });

  it("requires independent review to cover every mutation", () => {
    const blueprint = companyBlueprintV2Fixture();
    const candidate = plan([
      assignment("build", "scoped_builder"),
      assignment("review", "quality_reviewer"),
    ]);

    expect(() => api.validateCompanyGoalPlanAgainstTeamControls(
      candidate,
      blueprint,
      controls(blueprint, "review_heavy"),
    )).toThrow(/review/iu);
  });

  it("enforces active-agent and delegation-depth ceilings", () => {
    const blueprint = hierarchicalBlueprint();
    const candidate = plan([
      assignment("research", "research_lead"),
      assignment("build", "scoped_builder", {
        parentAssignmentId: "research",
      }),
      assignment("review", "quality_reviewer", {
        dependsOn: ["build"],
      }),
    ]);

    expect(() => api.validateCompanyGoalPlanAgainstTeamControls(
      candidate,
      blueprint,
      controls(blueprint, "recommended", { maxActiveAgents: 2 }),
    )).toThrow(/active/iu);
    expect(() => api.validateCompanyGoalPlanAgainstTeamControls(
      candidate,
      blueprint,
      controls(blueprint, "hierarchical", { maxDelegationDepth: 1 }),
    )).toThrow(/depth/iu);
  });

  it("allows only direct-manager or explicitly approved root escalation", () => {
    const blueprint = hierarchicalBlueprint();
    const managerOnly = controls(blueprint, "hierarchical");
    const rootAllowed = controls(blueprint, "hierarchical", {
      escalation: "root_allowed",
    });
    const escalation = {
      assignmentId: "build",
      fromRoleId: "scoped_builder",
      toRoleId: "root_orchestrator",
      summary: "The assigned interface is ambiguous.",
      evidence: ["src/interface.ts:12"],
    };

    expect(() => api.validateTeamEscalation(
      { ...escalation, toRoleId: "research_lead" },
      blueprint,
      managerOnly,
    )).not.toThrow();
    expect(() => api.validateTeamEscalation(
      escalation,
      blueprint,
      managerOnly,
    )).toThrow(/escalation/iu);
    expect(() => api.validateTeamEscalation(
      escalation,
      blueprint,
      rootAllowed,
    )).not.toThrow();
    expect(() => api.validateTeamEscalation(
      { ...escalation, evidence: [] },
      blueprint,
      rootAllowed,
    )).toThrow(/evidence/iu);
    expect(() => api.validateTeamEscalation(
      { ...escalation, summary: "Blocked\u0000hidden" },
      blueprint,
      rootAllowed,
    )).toThrow(/summary/iu);
  });
});
