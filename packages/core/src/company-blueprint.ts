import {
  COMPANY_ROLE_IDS,
  getOperatingModePolicy,
  parseCompanyBlueprint,
  type AgentPermissionMode,
  type AgentProfileId,
  type CompanyBlueprintV1,
  type CompanyDepartmentId,
  type CompanyDevelopmentStyle,
  type CompanyModelRoute,
  type CompanyProjectV1,
  type CompanyRoleId,
  type CompanyRoleV1,
  type CompanyToolBundleId,
  type OperatingModeId,
} from "@recurs/contracts";

export interface CompileCompanyBlueprintInput {
  readonly id: string;
  readonly createdAt: string;
  readonly project: CompanyProjectV1;
  readonly developmentStyle: CompanyDevelopmentStyle;
  readonly permissionMode: AgentPermissionMode;
  readonly operatingModeId: OperatingModeId;
}

interface RoleTemplate {
  readonly id: CompanyRoleId;
  readonly displayName: string;
  readonly department: CompanyDepartmentId;
  readonly responsibility: string;
  readonly directive: string;
  readonly executionProfileId: AgentProfileId | null;
  readonly modelRoute: CompanyModelRoute;
  readonly toolBundles: readonly CompanyToolBundleId[];
}

const ROLE_TEMPLATES: readonly RoleTemplate[] = Object.freeze([{
  id: "orchestrator_v1",
  displayName: "Orchestrator",
  department: "product",
  responsibility: "Own the project outcome, authority boundary, and handoffs.",
  directive: "Coordinate only approved roles and synthesize their evidence.",
  executionProfileId: null,
  modelRoute: "parent",
  toolBundles: ["project_context_v1", "source_control_v1"],
}, {
  id: "product_planner_v1",
  displayName: "Product Planner",
  department: "product",
  responsibility: "Turn project intent into bounded outcomes and acceptance criteria.",
  directive: "Clarify scope, dependencies, and measurable completion evidence.",
  executionProfileId: "explore_v1",
  modelRoute: "parent",
  toolBundles: ["project_context_v1"],
}, {
  id: "tool_curator_v1",
  displayName: "Tool Curator",
  department: "tools",
  responsibility: "Identify the smallest useful project tool set.",
  directive: "Recommend tools from observed needs without installing or trusting them.",
  executionProfileId: "explore_v1",
  modelRoute: "parent",
  toolBundles: ["project_context_v1", "source_control_v1"],
}, {
  id: "architect_v1",
  displayName: "Architect",
  department: "engineering",
  responsibility: "Map system boundaries, risks, and implementation seams.",
  directive: "Ground architecture decisions in repository evidence and project constraints.",
  executionProfileId: "explore_v1",
  modelRoute: "parent",
  toolBundles: ["project_context_v1", "architecture_v1"],
}, {
  id: "implementation_lead_v1",
  displayName: "Implementation Lead",
  department: "engineering",
  responsibility: "Prepare bounded implementation assignments and integration order.",
  directive: "Keep assignments independently reviewable and within the active mode.",
  executionProfileId: "explore_v1",
  modelRoute: "parent",
  toolBundles: ["project_context_v1", "architecture_v1", "source_control_v1"],
}, {
  id: "scoped_builder_v1",
  displayName: "Scoped Builder",
  department: "engineering",
  responsibility: "Implement one approved, bounded code change.",
  directive: "Change only what the assignment requires and return verification evidence.",
  executionProfileId: "implement_v1",
  modelRoute: "implement",
  toolBundles: ["implementation_v1", "source_control_v1"],
}, {
  id: "qa_reviewer_v1",
  displayName: "QA Reviewer",
  department: "qa",
  responsibility: "Independently review correctness, regressions, and test evidence.",
  directive: "Prefer concrete findings and acceptance evidence over style commentary.",
  executionProfileId: "review_v1",
  modelRoute: "review",
  toolBundles: ["quality_v1", "source_control_v1"],
}, {
  id: "security_release_reviewer_v1",
  displayName: "Security and Release Reviewer",
  department: "security",
  responsibility: "Review security boundaries and release readiness without deploying.",
  directive: "Report concrete risks and keep every deployment action approval-gated.",
  executionProfileId: "review_v1",
  modelRoute: "review",
  toolBundles: ["security_v1", "release_v1", "source_control_v1"],
}]);

const TOOL_REASONS: Readonly<Record<CompanyToolBundleId, string>> = {
  project_context_v1: "Share bounded project intent and instructions.",
  source_control_v1: "Inspect repository state and evidence.",
  architecture_v1: "Understand code structure before changing it.",
  implementation_v1: "Make and verify scoped changes.",
  quality_v1: "Review correctness and regression evidence.",
  security_v1: "Review security-sensitive boundaries.",
  release_v1: "Assess release readiness without deploying.",
};

function selectedRoleIds(style: CompanyDevelopmentStyle): ReadonlySet<CompanyRoleId> {
  if (style === "single_agent") return new Set(["orchestrator_v1"]);
  if (style === "orchestrator") {
    return new Set([
      "orchestrator_v1", "scoped_builder_v1", "qa_reviewer_v1",
    ]);
  }
  return new Set(COMPANY_ROLE_IDS);
}

function roleInstructions(template: RoleTemplate, project: CompanyProjectV1): string {
  const markers = project.repository.markers.length === 0
    ? "No repository markers were approved or observed."
    : `Approved repository markers: ${project.repository.markers.join(", ")}.`;
  const constraints = project.constraints.length === 0
    ? "No additional project constraints were supplied."
    : `Project constraints: ${project.constraints.join("; ")}.`;
  return [
    template.directive,
    `Project purpose: ${project.purpose}`,
    `Project type and stage: ${project.type}; ${project.stage}.`,
    constraints,
    markers,
  ].join("\n");
}

export function compileCompanyBlueprint(
  input: CompileCompanyBlueprintInput,
): CompanyBlueprintV1 {
  const mode = getOperatingModePolicy(input.operatingModeId);
  const team = mode.workflow.team;
  if (team === null) {
    throw new TypeError("Company blueprints require a team-capable operating mode");
  }
  const selected = selectedRoleIds(input.developmentStyle);
  const roles: CompanyRoleV1[] = ROLE_TEMPLATES
    .filter((template) => selected.has(template.id))
    .map((template) => ({
      id: template.id,
      version: 1,
      displayName: template.displayName,
      department: template.department,
      responsibility: template.responsibility,
      instructions: roleInstructions(template, input.project),
      executionProfileId: template.executionProfileId,
      permissionMode: input.permissionMode,
      modelRoute: template.modelRoute,
      toolBundles: [...template.toolBundles],
    }));
  const bundleIds = [...new Set(roles.flatMap((role) => role.toolBundles))].sort();
  const available = new Set<CompanyToolBundleId>(["project_context_v1"]);
  if (input.project.repository.markers.includes(".git")) {
    available.add("source_control_v1");
  }
  const proposed: CompanyBlueprintV1 = {
    id: input.id,
    version: 1,
    state: "proposed",
    createdAt: input.createdAt,
    approvedAt: null,
    project: input.project,
    developmentStyle: input.developmentStyle,
    authority: {
      permissionMode: input.permissionMode,
      operatingModeId: mode.id,
      operatingModeVersion: mode.version,
    },
    roles,
    toolPlan: bundleIds.map((id) => ({
      id,
      status: available.has(id) ? "available" : "required",
      reason: TOOL_REASONS[id],
    })),
    quality: {
      standard: team.qualityStandard,
      maxImplementers: team.maxImplementers,
      initialReviewers: team.initialReviewers,
      maxReviewers: team.maxReviewers,
      maxRepairRounds: team.maxRepairRounds ?? 0,
      approvalRule: team.approvalRule,
    },
    initialGoal: `Deliver a reviewed first slice for: ${input.project.purpose}`,
  };
  return parseCompanyBlueprint(proposed);
}

export function approveCompanyBlueprint(
  blueprint: CompanyBlueprintV1,
  approvedAt: string,
): CompanyBlueprintV1 {
  if (blueprint.state !== "proposed" || blueprint.approvedAt !== null) {
    throw new TypeError("Only a proposed company blueprint can be approved");
  }
  return parseCompanyBlueprint({
    ...blueprint,
    state: "approved",
    approvedAt,
  });
}

export function companyContextInstructions(
  blueprint: CompanyBlueprintV1,
): readonly string[] {
  if (blueprint.state !== "approved") {
    throw new TypeError("Only an approved company blueprint can enter model context");
  }
  const executable = blueprint.roles
    .filter((role) => role.executionProfileId !== null)
    .map((role) => `${role.id} (${role.displayName})`)
    .join(", ");
  return Object.freeze([
    `Approved Recurs company ${blueprint.id} is active for this session.`,
    `Project purpose: ${blueprint.project.purpose}`,
    `Initial company goal: ${blueprint.initialGoal}`,
    `Executable approved roles: ${executable || "none"}.`,
    "Use delegate_company_task for a blueprint-aware handoff to an approved executable role.",
    "Roster membership does not authorize automatic work, extra spend, wider permissions, deployment, or deeper delegation.",
  ]);
}
