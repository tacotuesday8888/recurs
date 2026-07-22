import {
  getOperatingModePolicy,
  narrowAgentPermissionMode,
  type AgentPermissionMode,
  type AgentProfileId,
  type AgentTeamQualityStandard,
  type OperatingModeId,
  type OperatingModeVersion,
} from "./agents.js";
import {
  COMPANY_DEPARTMENT_IDS,
  COMPANY_REPOSITORY_MARKERS,
  parseCompanyBlueprint,
  type CompanyBlueprintV1,
  type CompanyModelRoute,
  type CompanyProjectStage,
  type CompanyProjectType,
  type CompanyRepositoryMarker,
  type CompanyToolBundleId,
  type CompanyToolRequirementV1,
} from "./company.js";

export const COMPANY_ONBOARDING_DEPTHS = Object.freeze([
  "quick",
  "guided",
  "deep",
] as const);

export type CompanyOnboardingDepth =
  (typeof COMPANY_ONBOARDING_DEPTHS)[number];

export const COMPANY_DESIGN_MODES = Object.freeze([
  "stable_core_specialists",
  "guardrailed_dynamic",
] as const);

export type CompanyDesignMode = (typeof COMPANY_DESIGN_MODES)[number];

export type CompanyRoleKind =
  | "orchestrator"
  | "lead"
  | "specialist"
  | "worker"
  | "reviewer";

export type CompanyRoleCapability =
  | "plan"
  | "research"
  | "implement"
  | "review"
  | "repair"
  | "tool_curation"
  | "release";

export interface CompanyRepositoryEvidenceV1 {
  readonly path: string;
  readonly finding: string;
}

export interface CompanyRepositoryFactsV2 {
  readonly inspected: boolean;
  readonly markers: readonly CompanyRepositoryMarker[];
  readonly evidence: readonly CompanyRepositoryEvidenceV1[];
}

export interface CompanyProjectV2 {
  readonly type: CompanyProjectType;
  readonly stage: CompanyProjectStage;
  readonly purpose: string;
  readonly users: readonly string[];
  readonly successCriteria: readonly string[];
  readonly constraints: readonly string[];
  readonly risks: readonly string[];
  readonly architecturePreferences: readonly string[];
  readonly deploymentTargets: readonly string[];
  readonly repository: CompanyRepositoryFactsV2;
}

export interface CompanyDepartmentV2 {
  readonly id: string;
  readonly version: 1;
  readonly displayName: string;
  readonly purpose: string;
}

export interface CompanyRoleV2 {
  readonly id: string;
  readonly version: 1;
  readonly displayName: string;
  readonly kind: CompanyRoleKind;
  readonly departmentId: string;
  readonly responsibility: string;
  readonly instructions: string;
  readonly reportsTo: string | null;
  readonly delegatesTo: readonly string[];
  readonly capabilities: readonly CompanyRoleCapability[];
  readonly executionProfileId: AgentProfileId | null;
  readonly permissionMode: AgentPermissionMode;
  readonly modelRoute: CompanyModelRoute;
  readonly toolBundles: readonly CompanyToolBundleId[];
  readonly expectedEvidence: readonly string[];
  readonly activation: "always" | "on_demand";
}

export interface CompanyQualityPlanV2 {
  readonly standard: AgentTeamQualityStandard;
  readonly maxImplementers: number;
  readonly initialReviewers: number;
  readonly maxReviewers: number;
  readonly maxRepairRounds: number;
  readonly approvalRule: "unanimous";
}

export interface CompanyBlueprintV2 {
  readonly id: string;
  readonly version: 2;
  readonly revision: number;
  readonly previousBlueprintId: string | null;
  readonly state: "proposed" | "approved";
  readonly createdAt: string;
  readonly approvedAt: string | null;
  readonly designMode: CompanyDesignMode;
  readonly project: CompanyProjectV2;
  readonly authority: {
    readonly permissionMode: AgentPermissionMode;
    readonly operatingModeId: OperatingModeId;
    readonly operatingModeVersion: OperatingModeVersion;
  };
  readonly departments: readonly CompanyDepartmentV2[];
  readonly roles: readonly CompanyRoleV2[];
  readonly authorityAnchors: {
    readonly rootRoleId: string;
    readonly independentReviewRoleIds: readonly string[];
  };
  readonly activation: {
    readonly defaultActiveRoleIds: readonly string[];
  };
  readonly toolPlan: readonly CompanyToolRequirementV1[];
  readonly quality: CompanyQualityPlanV2;
  readonly initialGoal: string;
  readonly roadmap: readonly string[];
  readonly provenance: {
    readonly onboardingRunId: string;
    readonly depth: CompanyOnboardingDepth;
    readonly generatedBy: "deterministic" | "model_assisted";
  };
}

export type CompanyBlueprint = CompanyBlueprintV1 | CompanyBlueprintV2;

export interface CompanyBlueprintBindingV2 {
  readonly blueprintId: string;
  readonly blueprintVersion: 2;
  readonly blueprintRevision: number;
  readonly roleId: string;
  readonly roleVersion: 1;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const INVALID_TEXT = /[\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const encoder = new TextEncoder();
const projectTypes = new Set<string>([
  "ios_app", "macos_app", "web_app", "backend", "ai_ml",
  "infrastructure", "game", "plugin", "existing_project", "other",
]);
const projectStages = new Set<string>([
  "idea", "prototype", "active", "maintenance",
]);
const markers = new Set<string>(COMPANY_REPOSITORY_MARKERS);
const permissions = new Set<string>([
  "ask_always", "approved_for_me", "full_access",
]);
const designModes = new Set<string>(COMPANY_DESIGN_MODES);
const depths = new Set<string>(COMPANY_ONBOARDING_DEPTHS);
const roleKinds = new Set<string>([
  "orchestrator", "lead", "specialist", "worker", "reviewer",
]);
const capabilities = new Set<string>([
  "plan", "research", "implement", "review", "repair", "tool_curation",
  "release",
]);
const profiles = new Set<string>([
  "explore_v1", "implement_v1", "review_v1", "implement_v2",
  "review_v2", "repair_v1",
]);
const routes = new Set<string>(["parent", "implement", "review", "repair"]);
const bundles = new Set<string>([
  "project_context_v1", "source_control_v1", "architecture_v1",
  "implementation_v1", "quality_v1", "security_v1", "release_v1",
]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} must contain exactly ${expected.join(", ")}`);
  }
}

function invalidText(value: string): boolean {
  if (INVALID_TEXT.test(value)) return true;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code <= 8 || code === 11 || code === 12 ||
      (code >= 14 && code <= 31) || code === 127) return true;
  }
  return false;
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 ||
    encoder.encode(value).byteLength > maximum || invalidText(value)) {
    throw new TypeError(`${label} must be valid bounded text`);
  }
  return value;
}

function safeId(value: unknown, label: string): string {
  const parsed = text(value, label, 128);
  if (!SAFE_ID.test(parsed)) throw new TypeError(`${label} is invalid`);
  return parsed;
}

function timestamp(value: unknown, label: string): string {
  const parsed = text(value, label, 64);
  const date = new Date(parsed);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== parsed) {
    throw new TypeError(`${label} must be a canonical timestamp`);
  }
  return parsed;
}

function integer(
  value: unknown,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum ||
    (value as number) > maximum) {
    throw new TypeError(`${label} must be a bounded safe integer`);
  }
  return value as number;
}

function enumValue<T extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string,
): T {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value as T;
}

function uniqueTextArray(
  value: unknown,
  label: string,
  maximumItems: number,
  maximumBytes: number,
  allowEmpty = true,
): string[] {
  if (!Array.isArray(value) || value.length > maximumItems ||
    (!allowEmpty && value.length === 0)) {
    throw new TypeError(`${label} is invalid`);
  }
  const parsed = value.map((item) => text(item, label, maximumBytes));
  if (new Set(parsed).size !== parsed.length) {
    throw new TypeError(`${label} must be unique`);
  }
  return parsed;
}

function safeRelativePath(value: unknown): string {
  const parsed = text(value, "Company repository evidence path", 512);
  if (parsed.startsWith("/") || parsed.includes("\\") ||
    parsed.split("/").some((part) => part === "" || part === "..")) {
    throw new TypeError("Company repository evidence path is unsafe");
  }
  return parsed;
}

function parseProject(value: unknown): CompanyProjectV2 {
  const project = record(value, "Company V2 project");
  exact(project, [
    "type", "stage", "purpose", "users", "successCriteria", "constraints",
    "risks", "architecturePreferences", "deploymentTargets", "repository",
  ], "Company V2 project");
  const repository = record(project.repository, "Company V2 repository facts");
  exact(repository, ["inspected", "markers", "evidence"],
    "Company V2 repository facts");
  if (typeof repository.inspected !== "boolean" ||
    !Array.isArray(repository.markers) || repository.markers.length > 10 ||
    !Array.isArray(repository.evidence) || repository.evidence.length > 64) {
    throw new TypeError("Company V2 repository facts are invalid");
  }
  const parsedMarkers = repository.markers.map((marker) =>
    enumValue<CompanyRepositoryMarker>(marker, markers, "Repository marker")
  );
  if (new Set(parsedMarkers).size !== parsedMarkers.length ||
    [...parsedMarkers].sort().some((marker, index) => marker !== parsedMarkers[index])) {
    throw new TypeError("Repository markers must be unique and sorted");
  }
  const evidence = repository.evidence.map((item) => {
    const entry = record(item, "Company repository evidence");
    exact(entry, ["path", "finding"], "Company repository evidence");
    return {
      path: safeRelativePath(entry.path),
      finding: text(entry.finding, "Company repository evidence finding", 2_000),
    };
  });
  if (new Set(evidence.map((item) => item.path)).size !== evidence.length ||
    (!repository.inspected && (parsedMarkers.length > 0 || evidence.length > 0))) {
    throw new TypeError("Repository evidence must be unique and inspected");
  }
  return {
    type: enumValue(project.type, projectTypes, "Company project type"),
    stage: enumValue(project.stage, projectStages, "Company project stage"),
    purpose: text(project.purpose, "Company project purpose", 4_000),
    users: uniqueTextArray(project.users, "Company project users", 16, 512),
    successCriteria: uniqueTextArray(
      project.successCriteria,
      "Company project success criterion",
      32,
      1_024,
      false,
    ),
    constraints: uniqueTextArray(
      project.constraints,
      "Company project constraint",
      32,
      1_024,
    ),
    risks: uniqueTextArray(project.risks, "Company project risk", 32, 1_024),
    architecturePreferences: uniqueTextArray(
      project.architecturePreferences,
      "Company architecture preference",
      32,
      1_024,
    ),
    deploymentTargets: uniqueTextArray(
      project.deploymentTargets,
      "Company deployment target",
      16,
      512,
    ),
    repository: { inspected: repository.inspected, markers: parsedMarkers, evidence },
  };
}

function parseDepartment(value: unknown): CompanyDepartmentV2 {
  const department = record(value, "Company department");
  exact(department, ["id", "version", "displayName", "purpose"],
    "Company department");
  if (department.version !== 1) {
    throw new TypeError("Company department version is invalid");
  }
  return {
    id: safeId(department.id, "Company department id"),
    version: 1,
    displayName: text(department.displayName, "Company department name", 128),
    purpose: text(department.purpose, "Company department purpose", 1_024),
  };
}

function parseRole(value: unknown): CompanyRoleV2 {
  const role = record(value, "Company V2 role");
  exact(role, [
    "id", "version", "displayName", "kind", "departmentId",
    "responsibility", "instructions", "reportsTo", "delegatesTo",
    "capabilities", "executionProfileId", "permissionMode", "modelRoute",
    "toolBundles", "expectedEvidence", "activation",
  ], "Company V2 role");
  if (role.version !== 1 || !Array.isArray(role.delegatesTo) ||
    role.delegatesTo.length > 24 || !Array.isArray(role.capabilities) ||
    role.capabilities.length === 0 || role.capabilities.length > 7 ||
    !Array.isArray(role.toolBundles) || role.toolBundles.length === 0 ||
    role.toolBundles.length > 7) {
    throw new TypeError("Company V2 role collections are invalid");
  }
  const delegatesTo = role.delegatesTo.map((id) =>
    safeId(id, "Company delegated role id")
  );
  const parsedCapabilities = role.capabilities.map((capability) =>
    enumValue<CompanyRoleCapability>(
      capability,
      capabilities,
      "Company role capability",
    )
  );
  const toolBundles = role.toolBundles.map((bundle) =>
    enumValue<CompanyToolBundleId>(bundle, bundles, "Company tool bundle")
  );
  for (const [items, label] of [
    [delegatesTo, "delegation targets"],
    [parsedCapabilities, "capabilities"],
    [toolBundles, "tool bundles"],
  ] as const) {
    if (new Set(items).size !== items.length) {
      throw new TypeError(`Company role ${label} must be unique`);
    }
  }
  return {
    id: safeId(role.id, "Company role id"),
    version: 1,
    displayName: text(role.displayName, "Company role display name", 128),
    kind: enumValue(role.kind, roleKinds, "Company role kind"),
    departmentId: safeId(role.departmentId, "Company role department id"),
    responsibility: text(role.responsibility, "Company role responsibility", 2_000),
    instructions: text(role.instructions, "Company role instructions", 8_192),
    reportsTo: role.reportsTo === null
      ? null
      : safeId(role.reportsTo, "Company role manager id"),
    delegatesTo,
    capabilities: parsedCapabilities,
    executionProfileId: role.executionProfileId === null
      ? null
      : enumValue<AgentProfileId>(
        role.executionProfileId,
        profiles,
        "Company role execution profile",
      ),
    permissionMode: enumValue(
      role.permissionMode,
      permissions,
      "Company role permission",
    ),
    modelRoute: enumValue(role.modelRoute, routes, "Company role model route"),
    toolBundles,
    expectedEvidence: uniqueTextArray(
      role.expectedEvidence,
      "Company role expected evidence",
      16,
      512,
      false,
    ),
    activation: enumValue(
      role.activation,
      new Set(["always", "on_demand"]),
      "Company role activation",
    ),
  };
}

function parseTool(value: unknown): CompanyToolRequirementV1 {
  const tool = record(value, "Company tool requirement");
  exact(tool, ["id", "status", "reason"], "Company tool requirement");
  return {
    id: enumValue(tool.id, bundles, "Company tool requirement id"),
    status: enumValue(
      tool.status,
      new Set(["available", "required"]),
      "Company tool requirement status",
    ),
    reason: text(tool.reason, "Company tool requirement reason", 512),
  };
}

function expectedRoute(profile: AgentProfileId | null): CompanyModelRoute {
  if (profile === null || profile === "explore_v1") return "parent";
  if (profile === "implement_v1" || profile === "implement_v2") return "implement";
  if (profile === "review_v1" || profile === "review_v2") return "review";
  return "repair";
}

function validateRoleGraph(
  roles: readonly CompanyRoleV2[],
  rootRoleId: string,
  maximumDepth: number,
): void {
  const byId = new Map(roles.map((role) => [role.id, role] as const));
  for (const role of roles) {
    if (role.id === role.reportsTo || role.delegatesTo.includes(role.id) ||
      role.delegatesTo.some((id) => !byId.has(id)) ||
      (role.reportsTo !== null && !byId.has(role.reportsTo))) {
      throw new TypeError("Company role relationship references are invalid");
    }
    const expectedChildren = roles
      .filter((candidate) => candidate.reportsTo === role.id)
      .map((candidate) => candidate.id)
      .sort();
    if ([...role.delegatesTo].sort().some((id, index) =>
      id !== expectedChildren[index]
    ) || role.delegatesTo.length !== expectedChildren.length) {
      throw new TypeError("Company delegation graph must match reporting lines");
    }
  }
  for (const role of roles) {
    let current = role;
    const seen = new Set<string>();
    let depth = 0;
    while (current.id !== rootRoleId) {
      if (seen.has(current.id) || current.reportsTo === null) {
        throw new TypeError("Company reporting graph must be acyclic and rooted");
      }
      seen.add(current.id);
      current = byId.get(current.reportsTo)!;
      depth += 1;
      if (depth > maximumDepth) {
        throw new TypeError("Company reporting graph exceeds operating depth");
      }
    }
  }
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function parseCompanyBlueprintV2(value: unknown): CompanyBlueprintV2 {
  const blueprint = record(value, "Company V2 blueprint");
  exact(blueprint, [
    "id", "version", "revision", "previousBlueprintId", "state",
    "createdAt", "approvedAt", "designMode", "project", "authority",
    "departments", "roles", "authorityAnchors", "activation", "toolPlan",
    "quality", "initialGoal", "roadmap", "provenance",
  ], "Company V2 blueprint");
  if (blueprint.version !== 2) {
    throw new TypeError("Company V2 blueprint version is invalid");
  }
  const id = safeId(blueprint.id, "Company blueprint id");
  const revision = integer(blueprint.revision, "Company blueprint revision", 1);
  const previousBlueprintId = blueprint.previousBlueprintId === null
    ? null
    : safeId(blueprint.previousBlueprintId, "Previous company blueprint id");
  if ((revision === 1) !== (previousBlueprintId === null) ||
    previousBlueprintId === id) {
    throw new TypeError("Company blueprint revision lineage is invalid");
  }
  const state = enumValue<CompanyBlueprintV2["state"]>(
    blueprint.state,
    new Set(["proposed", "approved"]),
    "Company blueprint state",
  );
  const approvedAt = blueprint.approvedAt === null
    ? null
    : timestamp(blueprint.approvedAt, "Company blueprint approvedAt timestamp");
  if ((state === "approved") !== (approvedAt !== null)) {
    throw new TypeError("Company blueprint state and approvedAt must agree");
  }
  const authority = record(blueprint.authority, "Company authority");
  exact(authority, ["permissionMode", "operatingModeId", "operatingModeVersion"],
    "Company authority");
  const permissionMode = enumValue<AgentPermissionMode>(
    authority.permissionMode,
    permissions,
    "Company permission mode",
  );
  if (typeof authority.operatingModeId !== "string") {
    throw new TypeError("Company operating mode is invalid");
  }
  let mode;
  try {
    mode = getOperatingModePolicy(authority.operatingModeId as OperatingModeId);
  } catch {
    throw new TypeError("Company operating mode is invalid");
  }
  if (authority.operatingModeVersion !== mode.version || mode.version !== 6 ||
    mode.company === undefined) {
    throw new TypeError("Company V2 requires an exact V6 operating mode");
  }
  const designMode = enumValue<CompanyDesignMode>(
    blueprint.designMode,
    designModes,
    "Company design mode",
  );
  if (!Array.isArray(blueprint.departments) || blueprint.departments.length === 0 ||
    blueprint.departments.length > mode.company.maxDepartments ||
    !Array.isArray(blueprint.roles) || blueprint.roles.length < 2 ||
    blueprint.roles.length > mode.company.maxRoles) {
    throw new TypeError("Company organization exceeds operating policy");
  }
  const departments = blueprint.departments.map(parseDepartment);
  const roles = blueprint.roles.map(parseRole);
  if (new Set(departments.map((item) => item.id)).size !== departments.length ||
    new Set(roles.map((item) => item.id)).size !== roles.length) {
    throw new TypeError("Company department and role ids must be unique");
  }
  if (designMode === "stable_core_specialists") {
    const departmentIds = new Set(departments.map((item) => item.id));
    if (COMPANY_DEPARTMENT_IDS.some((department) => !departmentIds.has(department))) {
      throw new TypeError("Stable-core companies require every core department");
    }
  }
  const departmentIds = new Set(departments.map((item) => item.id));
  const roleIds = new Set(roles.map((item) => item.id));
  const anchors = record(blueprint.authorityAnchors, "Company authority anchors");
  exact(anchors, ["rootRoleId", "independentReviewRoleIds"],
    "Company authority anchors");
  const rootRoleId = safeId(anchors.rootRoleId, "Company root role id");
  if (!Array.isArray(anchors.independentReviewRoleIds) ||
    anchors.independentReviewRoleIds.length === 0 ||
    anchors.independentReviewRoleIds.length > mode.workflow.team!.maxReviewers) {
    throw new TypeError("Company independent review authority is invalid");
  }
  const independentReviewRoleIds = anchors.independentReviewRoleIds.map((roleId) =>
    safeId(roleId, "Company independent review role id")
  );
  if (!roleIds.has(rootRoleId) ||
    new Set(independentReviewRoleIds).size !== independentReviewRoleIds.length ||
    independentReviewRoleIds.some((roleId) => !roleIds.has(roleId))) {
    throw new TypeError("Company authority anchors reference unknown roles");
  }
  const root = roles.find((role) => role.id === rootRoleId)!;
  if (root.kind !== "orchestrator" || root.reportsTo !== null ||
    root.executionProfileId !== null || root.modelRoute !== "parent" ||
    !root.capabilities.includes("plan")) {
    throw new TypeError("Company root orchestrator authority is invalid");
  }
  for (const role of roles) {
    if (!departmentIds.has(role.departmentId) ||
      narrowAgentPermissionMode(permissionMode, role.permissionMode) !==
        role.permissionMode || expectedRoute(role.executionProfileId) !== role.modelRoute) {
      throw new TypeError("Company role policy is invalid");
    }
    if (role.id !== rootRoleId && role.reportsTo === null) {
      throw new TypeError("Every non-root company role requires a manager");
    }
  }
  for (const reviewRoleId of independentReviewRoleIds) {
    const reviewer = roles.find((role) => role.id === reviewRoleId)!;
    if (reviewer.kind !== "reviewer" || reviewer.reportsTo !== rootRoleId ||
      reviewer.executionProfileId !== "review_v2" ||
      !reviewer.capabilities.includes("review") || reviewer.activation !== "always") {
      throw new TypeError("Company independent reviewer authority is invalid");
    }
  }
  validateRoleGraph(roles, rootRoleId, mode.company.maxDepth);

  const activation = record(blueprint.activation, "Company activation plan");
  exact(activation, ["defaultActiveRoleIds"], "Company activation plan");
  if (!Array.isArray(activation.defaultActiveRoleIds) ||
    activation.defaultActiveRoleIds.length === 0 ||
    activation.defaultActiveRoleIds.length > mode.company.maxActiveRoles) {
    throw new TypeError("Company activation plan is invalid");
  }
  const defaultActiveRoleIds = activation.defaultActiveRoleIds.map((roleId) =>
    safeId(roleId, "Company active role id")
  );
  const requiredActive = roles
    .filter((role) => role.activation === "always")
    .map((role) => role.id);
  if (new Set(defaultActiveRoleIds).size !== defaultActiveRoleIds.length ||
    defaultActiveRoleIds.some((roleId) => !roleIds.has(roleId)) ||
    requiredActive.some((roleId) => !defaultActiveRoleIds.includes(roleId)) ||
    !defaultActiveRoleIds.includes(rootRoleId) ||
    independentReviewRoleIds.some((roleId) => !defaultActiveRoleIds.includes(roleId))) {
    throw new TypeError("Company activation plan must include mandatory roles");
  }
  if (!Array.isArray(blueprint.toolPlan) || blueprint.toolPlan.length === 0 ||
    blueprint.toolPlan.length > 7) {
    throw new TypeError("Company tool plan is invalid");
  }
  const toolPlan = blueprint.toolPlan.map(parseTool);
  const plannedBundles = new Set(toolPlan.map((tool) => tool.id));
  if (plannedBundles.size !== toolPlan.length ||
    roles.some((role) => role.toolBundles.some((bundle) => !plannedBundles.has(bundle)))) {
    throw new TypeError("Company role tools must exist in the tool plan");
  }
  const quality = record(blueprint.quality, "Company quality plan");
  exact(quality, [
    "standard", "maxImplementers", "initialReviewers", "maxReviewers",
    "maxRepairRounds", "approvalRule",
  ], "Company quality plan");
  const team = mode.workflow.team!;
  if (quality.standard !== team.qualityStandard ||
    quality.maxImplementers !== team.maxImplementers ||
    quality.initialReviewers !== team.initialReviewers ||
    quality.maxReviewers !== team.maxReviewers ||
    quality.maxRepairRounds !== (team.maxRepairRounds ?? 0) ||
    quality.approvalRule !== team.approvalRule) {
    throw new TypeError("Company quality plan does not match its operating mode");
  }
  const provenance = record(blueprint.provenance, "Company provenance");
  exact(provenance, ["onboardingRunId", "depth", "generatedBy"],
    "Company provenance");
  const parsed: CompanyBlueprintV2 = {
    id,
    version: 2,
    revision,
    previousBlueprintId,
    state,
    createdAt: timestamp(blueprint.createdAt, "Company blueprint createdAt timestamp"),
    approvedAt,
    designMode,
    project: parseProject(blueprint.project),
    authority: {
      permissionMode,
      operatingModeId: mode.id,
      operatingModeVersion: mode.version,
    },
    departments,
    roles,
    authorityAnchors: { rootRoleId, independentReviewRoleIds },
    activation: { defaultActiveRoleIds },
    toolPlan,
    quality: {
      standard: team.qualityStandard,
      maxImplementers: integer(quality.maxImplementers, "maxImplementers", 1),
      initialReviewers: integer(quality.initialReviewers, "initialReviewers", 1),
      maxReviewers: integer(quality.maxReviewers, "maxReviewers", 1),
      maxRepairRounds: integer(quality.maxRepairRounds, "maxRepairRounds", 0),
      approvalRule: "unanimous",
    },
    initialGoal: text(blueprint.initialGoal, "Company initial goal", 4_000),
    roadmap: uniqueTextArray(
      blueprint.roadmap,
      "Company roadmap milestone",
      16,
      2_000,
      false,
    ),
    provenance: {
      onboardingRunId: safeId(provenance.onboardingRunId, "Onboarding run id"),
      depth: enumValue(provenance.depth, depths, "Company onboarding depth"),
      generatedBy: enumValue(
        provenance.generatedBy,
        new Set(["deterministic", "model_assisted"]),
        "Company generator",
      ),
    },
  };
  return deepFreeze(structuredClone(parsed)) as CompanyBlueprintV2;
}

export function parseCompanyBlueprintBindingV2(
  value: unknown,
): CompanyBlueprintBindingV2 {
  const binding = record(value, "Company V2 blueprint binding");
  exact(binding, [
    "blueprintId", "blueprintVersion", "blueprintRevision", "roleId",
    "roleVersion",
  ], "Company V2 blueprint binding");
  if (binding.blueprintVersion !== 2 || binding.roleVersion !== 1) {
    throw new TypeError("Company V2 blueprint binding version is invalid");
  }
  return Object.freeze({
    blueprintId: safeId(binding.blueprintId, "Company blueprint binding id"),
    blueprintVersion: 2,
    blueprintRevision: integer(
      binding.blueprintRevision,
      "Company blueprint binding revision",
      1,
    ),
    roleId: safeId(binding.roleId, "Company blueprint binding role"),
    roleVersion: 1,
  });
}

export function parseAnyCompanyBlueprint(value: unknown): CompanyBlueprint {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Company blueprint must be an object");
  }
  return (value as { readonly version?: unknown }).version === 2
    ? parseCompanyBlueprintV2(value)
    : parseCompanyBlueprint(value);
}
