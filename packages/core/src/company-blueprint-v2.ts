import { createHash } from "node:crypto";

import {
  COMPANY_DEPARTMENT_IDS,
  getOperatingModePolicy,
  narrowAgentPermissionMode,
  parseCompanyBlueprintV2,
  type AgentPermissionMode,
  type AgentProfileId,
  type CompanyBlueprintV2,
  type CompanyDepartmentV2,
  type CompanyDesignMode,
  type CompanyModelRoute,
  type CompanyOnboardingDepth,
  type CompanyProjectV2,
  type CompanyRoleCapability,
  type CompanyRoleKind,
  type CompanyRoleV2,
  type CompanyToolBundleId,
  type OperatingModeId,
} from "@recurs/contracts";

export interface CompanyDepartmentDraftV1 {
  readonly key: string;
  readonly displayName: string;
  readonly purpose: string;
}

export interface CompanyRoleDraftV1 {
  readonly key: string;
  readonly displayName: string;
  readonly kind: CompanyRoleKind;
  readonly departmentKey: string;
  readonly responsibility: string;
  readonly instructions: string;
  readonly reportsToKey: string | null;
  readonly capabilities: readonly CompanyRoleCapability[];
  readonly executionProfileId: AgentProfileId | null;
  readonly permissionMode: AgentPermissionMode;
  readonly toolBundles: readonly CompanyToolBundleId[];
  readonly expectedEvidence: readonly string[];
  readonly activation: "always" | "on_demand";
}

export interface CompanyOrganizationDraftV1 {
  readonly departments: readonly CompanyDepartmentDraftV1[];
  readonly roles: readonly CompanyRoleDraftV1[];
  readonly rootRoleKey: string;
  readonly independentReviewRoleKeys: readonly string[];
  readonly defaultActiveRoleKeys: readonly string[];
}

export interface CompileCompanyBlueprintV2Input {
  readonly id: string;
  readonly companyId: string;
  readonly revision: number;
  readonly previousBlueprintId: string | null;
  readonly createdAt: string;
  readonly onboardingRunId: string;
  readonly onboardingDepth: CompanyOnboardingDepth;
  readonly generatedBy: "deterministic" | "model_assisted";
  readonly designMode: CompanyDesignMode;
  readonly project: CompanyProjectV2;
  readonly permissionMode: AgentPermissionMode;
  readonly operatingModeId: OperatingModeId;
  readonly organization?: CompanyOrganizationDraftV1;
  readonly specialists?: readonly CompanyRoleDraftV1[];
  readonly availableToolBundles?: readonly CompanyToolBundleId[];
  readonly initialGoal: string;
  readonly roadmap: readonly string[];
}

const SAFE_KEY = /^[a-z][a-z0-9_]{0,63}$/u;

function opaqueId(prefix: "department" | "role", companyId: string, key: string): string {
  if (!SAFE_KEY.test(key)) throw new TypeError(`Unsafe company draft key: ${key}`);
  const digest = createHash("sha256")
    .update(`${companyId}\0${prefix}\0${key}`)
    .digest("hex")
    .slice(0, 24);
  return `${prefix}_${digest}`;
}

function route(profile: AgentProfileId | null): CompanyModelRoute {
  if (profile === null || profile === "explore_v1") return "parent";
  if (profile === "implement_v1" || profile === "implement_v2") return "implement";
  if (profile === "review_v1" || profile === "review_v2") return "review";
  return "repair";
}

function coreDepartments(): CompanyDepartmentDraftV1[] {
  return [{
    key: "product",
    displayName: "Product",
    purpose: "Clarify user outcomes, scope, and product decisions.",
  }, {
    key: "engineering",
    displayName: "Engineering",
    purpose: "Design and implement bounded, maintainable changes.",
  }, {
    key: "qa",
    displayName: "Quality Assurance",
    purpose: "Verify behavior independently and report concrete findings.",
  }, {
    key: "security",
    displayName: "Security",
    purpose: "Review security, privacy, and release risk.",
  }, {
    key: "tools",
    displayName: "Tools",
    purpose: "Match approved tools and model routes to company work.",
  }, {
    key: "deployment",
    displayName: "Deployment",
    purpose: "Define release readiness without assuming deployment authority.",
  }];
}

function coreRoles(
  project: CompanyProjectV2,
  permissionMode: AgentPermissionMode,
  maximumDepth: number,
): CompanyRoleDraftV1[] {
  const context = [
    `Project outcome: ${project.purpose}`,
    ...project.constraints.map((constraint) => `Constraint: ${constraint}`),
  ].join("\n");
  const role = (
    input: Omit<CompanyRoleDraftV1, "permissionMode"> & {
      readonly permissionMode?: AgentPermissionMode;
    },
  ): CompanyRoleDraftV1 => ({
    ...input,
    permissionMode: narrowAgentPermissionMode(
      permissionMode,
      input.permissionMode ?? permissionMode,
    ),
    instructions: `${input.instructions}\n${context}`,
  });
  return [role({
    key: "orchestrator",
    displayName: "Company Orchestrator",
    kind: "orchestrator",
    departmentKey: "product",
    responsibility: "Own the approved goal, company budget, and final synthesis.",
    instructions: "Delegate through the approved organization and surface product decisions.",
    reportsToKey: null,
    capabilities: ["plan"],
    executionProfileId: null,
    toolBundles: ["project_context_v1", "source_control_v1"],
    expectedEvidence: ["A synthesized result tied to assignment evidence."],
    activation: "always",
  }), role({
    key: "product_planner",
    displayName: "Product Planner",
    kind: "specialist",
    departmentKey: "product",
    responsibility: "Translate the goal into product requirements and decisions.",
    instructions: "Separate verified requirements from assumptions.",
    reportsToKey: "orchestrator",
    capabilities: ["plan", "research"],
    executionProfileId: "explore_v1",
    toolBundles: ["project_context_v1"],
    expectedEvidence: ["Requirements, uncertainties, and decision gates."],
    activation: "on_demand",
  }), role({
    key: "tool_curator",
    displayName: "Tool Curator",
    kind: "specialist",
    departmentKey: "tools",
    responsibility: "Assess approved tool and model readiness for the goal.",
    instructions: "Never install, trust, or authenticate a tool silently.",
    reportsToKey: "orchestrator",
    capabilities: ["research", "tool_curation"],
    executionProfileId: "explore_v1",
    toolBundles: ["project_context_v1"],
    expectedEvidence: ["Available and missing capability evidence."],
    activation: "on_demand",
  }), role({
    key: "architect",
    displayName: "Architect",
    kind: "specialist",
    departmentKey: "engineering",
    responsibility: "Design the smallest safe architecture for the goal.",
    instructions: "Prefer existing seams and document tradeoffs.",
    reportsToKey: "orchestrator",
    capabilities: ["plan", "research"],
    executionProfileId: "explore_v1",
    toolBundles: ["project_context_v1", "architecture_v1"],
    expectedEvidence: ["Relevant paths, interfaces, constraints, and tradeoffs."],
    activation: "on_demand",
  }), role({
    key: "implementation_lead",
    displayName: "Implementation Lead",
    kind: "lead",
    departmentKey: "engineering",
    responsibility: "Decompose approved implementation into bounded workstreams.",
    instructions: "Assign only disjoint work with explicit acceptance evidence.",
    reportsToKey: "orchestrator",
    capabilities: ["plan", "research"],
    executionProfileId: "explore_v1",
    toolBundles: ["project_context_v1", "architecture_v1"],
    expectedEvidence: ["A dependency-aware implementation handoff."],
    activation: "on_demand",
  }), role({
    key: "scoped_builder",
    displayName: "Scoped Builder",
    kind: "worker",
    departmentKey: "engineering",
    responsibility: "Implement one bounded approved workstream.",
    instructions: "Change only assigned scope and return concrete evidence.",
    reportsToKey: maximumDepth >= 2 ? "implementation_lead" : "orchestrator",
    capabilities: ["implement"],
    executionProfileId: "implement_v2",
    toolBundles: ["project_context_v1", "implementation_v1"],
    expectedEvidence: ["Changed paths and verification evidence."],
    activation: "on_demand",
  }), role({
    key: "qa_reviewer",
    displayName: "Independent QA Reviewer",
    kind: "reviewer",
    departmentKey: "qa",
    responsibility: "Independently review behavior, regressions, and evidence.",
    instructions: "Approve only when no concrete finding remains.",
    reportsToKey: "orchestrator",
    capabilities: ["review"],
    executionProfileId: "review_v2",
    permissionMode: "ask_always",
    toolBundles: ["project_context_v1", "quality_v1"],
    expectedEvidence: ["Structured findings or evidence-backed approval."],
    activation: "always",
  }), role({
    key: "security_release_reviewer",
    displayName: "Security and Release Reviewer",
    kind: "reviewer",
    departmentKey: "security",
    responsibility: "Review security, privacy, and release readiness.",
    instructions: "Do not claim deployment or release without explicit authority.",
    reportsToKey: "orchestrator",
    capabilities: ["review", "release"],
    executionProfileId: "review_v2",
    permissionMode: "ask_always",
    toolBundles: ["security_v1", "release_v1"],
    expectedEvidence: ["Security findings and release-readiness evidence."],
    activation: "on_demand",
  })];
}

function stableOrganization(
  input: CompileCompanyBlueprintV2Input,
  maximumDepth: number,
  maximumActiveRoles: number,
): CompanyOrganizationDraftV1 {
  const roles = [
    ...coreRoles(input.project, input.permissionMode, maximumDepth),
    ...(input.specialists ?? []),
  ];
  const preferredActive = [
    "orchestrator", "implementation_lead", "qa_reviewer",
    "product_planner", "architect", "tool_curator",
    "security_release_reviewer", "scoped_builder",
  ];
  return {
    departments: coreDepartments(),
    roles,
    rootRoleKey: "orchestrator",
    independentReviewRoleKeys: ["qa_reviewer"],
    defaultActiveRoleKeys: preferredActive.slice(0, maximumActiveRoles),
  };
}

function compileOrganization(
  input: CompileCompanyBlueprintV2Input,
  draft: CompanyOrganizationDraftV1,
): {
  readonly departments: readonly CompanyDepartmentV2[];
  readonly roles: readonly CompanyRoleV2[];
  readonly rootRoleId: string;
  readonly independentReviewRoleIds: readonly string[];
  readonly defaultActiveRoleIds: readonly string[];
} {
  const departmentIds = new Map<string, string>();
  for (const department of draft.departments) {
    if (!SAFE_KEY.test(department.key) || departmentIds.has(department.key)) {
      throw new TypeError("Company department draft keys must be unique and safe");
    }
    departmentIds.set(
      department.key,
      input.designMode === "stable_core_specialists" &&
          COMPANY_DEPARTMENT_IDS.includes(department.key as never)
        ? department.key
        : opaqueId("department", input.companyId, department.key),
    );
  }
  const roleIds = new Map<string, string>();
  for (const role of draft.roles) {
    if (!SAFE_KEY.test(role.key) || roleIds.has(role.key)) {
      throw new TypeError("Company role draft keys must be unique and safe");
    }
    roleIds.set(role.key, opaqueId("role", input.companyId, role.key));
  }
  const departments = draft.departments.map((department): CompanyDepartmentV2 => ({
    id: departmentIds.get(department.key)!,
    version: 1,
    displayName: department.displayName,
    purpose: department.purpose,
  }));
  const roles = draft.roles.map((role): CompanyRoleV2 => {
    const reportsTo = role.reportsToKey === null
      ? null
      : roleIds.get(role.reportsToKey);
    const departmentId = departmentIds.get(role.departmentKey);
    if (reportsTo === undefined || departmentId === undefined) {
      throw new TypeError("Company role draft references an unknown role or department");
    }
    const key = role.key;
    return {
      id: roleIds.get(key)!,
      version: 1,
      displayName: role.displayName,
      kind: role.kind,
      departmentId,
      responsibility: role.responsibility,
      instructions: role.instructions,
      reportsTo,
      delegatesTo: draft.roles
        .filter((candidate) => candidate.reportsToKey === key)
        .map((candidate) => roleIds.get(candidate.key)!),
      capabilities: role.capabilities,
      executionProfileId: role.executionProfileId,
      permissionMode: narrowAgentPermissionMode(
        input.permissionMode,
        role.permissionMode,
      ),
      modelRoute: route(role.executionProfileId),
      toolBundles: role.toolBundles,
      expectedEvidence: role.expectedEvidence,
      activation: role.activation,
    };
  });
  const mapKeys = (keys: readonly string[], label: string): string[] =>
    keys.map((key) => {
      const id = roleIds.get(key);
      if (id === undefined) throw new TypeError(`${label} references an unknown role`);
      return id;
    });
  return {
    departments,
    roles,
    rootRoleId: mapKeys([draft.rootRoleKey], "Company root")[0]!,
    independentReviewRoleIds: mapKeys(
      draft.independentReviewRoleKeys,
      "Company reviewer",
    ),
    defaultActiveRoleIds: mapKeys(
      draft.defaultActiveRoleKeys,
      "Company activation",
    ),
  };
}

export function compileCompanyBlueprintV2(
  input: CompileCompanyBlueprintV2Input,
): CompanyBlueprintV2 {
  const mode = getOperatingModePolicy(input.operatingModeId);
  if (mode.version !== 6 || mode.company === undefined || mode.workflow.team === null) {
    throw new TypeError("Company V2 compilation requires a V6 company mode");
  }
  if (input.designMode === "guardrailed_dynamic" && input.organization === undefined) {
    throw new TypeError("Dynamic company compilation requires an organization draft");
  }
  if (input.designMode === "stable_core_specialists" && input.organization !== undefined) {
    throw new TypeError("Stable-core compilation owns its baseline organization");
  }
  const draft = input.organization ?? stableOrganization(
    input,
    mode.company.maxDepth,
    mode.company.maxActiveRoles,
  );
  const organization = compileOrganization(input, draft);
  const usedBundles = [...new Set(
    organization.roles.flatMap((role) => role.toolBundles),
  )].sort() as CompanyToolBundleId[];
  const available = new Set(input.availableToolBundles ?? [
    "project_context_v1",
    "source_control_v1",
  ]);
  return parseCompanyBlueprintV2({
    id: input.id,
    companyId: input.companyId,
    version: 2,
    revision: input.revision,
    previousBlueprintId: input.previousBlueprintId,
    state: "proposed",
    createdAt: input.createdAt,
    approvedAt: null,
    designMode: input.designMode,
    project: input.project,
    authority: {
      permissionMode: input.permissionMode,
      operatingModeId: mode.id,
      operatingModeVersion: mode.version,
    },
    departments: organization.departments,
    roles: organization.roles,
    authorityAnchors: {
      rootRoleId: organization.rootRoleId,
      independentReviewRoleIds: organization.independentReviewRoleIds,
    },
    activation: {
      defaultActiveRoleIds: organization.defaultActiveRoleIds,
    },
    toolPlan: usedBundles.map((id) => ({
      id,
      status: available.has(id) ? "available" : "required",
      reason: available.has(id)
        ? "This approved capability is available to assigned roles."
        : "An assigned role requires this capability before it can execute.",
    })),
    quality: {
      standard: mode.workflow.team.qualityStandard,
      maxImplementers: mode.workflow.team.maxImplementers,
      initialReviewers: mode.workflow.team.initialReviewers,
      maxReviewers: mode.workflow.team.maxReviewers,
      maxRepairRounds: mode.workflow.team.maxRepairRounds ?? 0,
      approvalRule: mode.workflow.team.approvalRule,
    },
    initialGoal: input.initialGoal,
    roadmap: input.roadmap,
    provenance: {
      onboardingRunId: input.onboardingRunId,
      depth: input.onboardingDepth,
      generatedBy: input.generatedBy,
    },
  });
}

export function approveCompanyBlueprintV2(
  blueprint: CompanyBlueprintV2,
  approvedAt: string,
): CompanyBlueprintV2 {
  const proposed = parseCompanyBlueprintV2(blueprint);
  if (proposed.state !== "proposed") {
    throw new TypeError("Only a proposed V2 company blueprint can be approved");
  }
  return parseCompanyBlueprintV2({
    ...proposed,
    state: "approved",
    approvedAt,
  });
}

export function companyContextInstructionsV2(
  blueprint: CompanyBlueprintV2,
): readonly string[] {
  if (blueprint.state !== "approved") {
    throw new TypeError("Only an approved V2 company blueprint can enter model context");
  }
  const executable = blueprint.roles
    .filter((role) => role.executionProfileId !== null)
    .map((role) => `${role.id} (${role.displayName})`)
    .join(", ");
  return Object.freeze([
    `Approved Recurs company ${blueprint.companyId} revision ${blueprint.revision} is active for this session.`,
    `Project purpose: ${blueprint.project.purpose}`,
    `Approved initial goal: ${blueprint.initialGoal}`,
    `Executable approved roles: ${executable || "none"}.`,
    "Use delegate_company_goal for one goal-scoped assignment DAG. Include every independent-review authority and use only approved delegation relationships.",
    "Implementation roles run through Recurs's isolated worktree, review, repair, and apply engine. Roster membership alone does not imply activity.",
    "Never widen permissions, delegation depth, tool bundles, model eligibility, concurrency, requests, or reported-cost limits beyond the approved blueprint and operating mode.",
  ]);
}
