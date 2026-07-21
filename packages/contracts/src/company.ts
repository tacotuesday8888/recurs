import {
  getOperatingModePolicy,
  narrowAgentPermissionMode,
  type AgentPermissionMode,
  type AgentProfileId,
  type AgentTeamQualityStandard,
  type OperatingModeId,
  type OperatingModeVersion,
} from "./agents.js";

export const COMPANY_ROLE_IDS = Object.freeze([
  "orchestrator_v1",
  "product_planner_v1",
  "tool_curator_v1",
  "architect_v1",
  "implementation_lead_v1",
  "scoped_builder_v1",
  "qa_reviewer_v1",
  "security_release_reviewer_v1",
] as const);

export type CompanyRoleId = (typeof COMPANY_ROLE_IDS)[number];

export const COMPANY_DEPARTMENT_IDS = Object.freeze([
  "product",
  "engineering",
  "qa",
  "security",
  "tools",
  "deployment",
] as const);

export type CompanyDepartmentId = (typeof COMPANY_DEPARTMENT_IDS)[number];

export type CompanyDevelopmentStyle =
  | "layered_company"
  | "orchestrator"
  | "single_agent";

export type CompanyProjectType =
  | "ios_app"
  | "macos_app"
  | "web_app"
  | "backend"
  | "ai_ml"
  | "infrastructure"
  | "game"
  | "plugin"
  | "existing_project"
  | "other";

export type CompanyProjectStage =
  | "idea"
  | "prototype"
  | "active"
  | "maintenance";

export const COMPANY_REPOSITORY_MARKERS = Object.freeze([
  ".git",
  "package.json",
  "Package.swift",
  "Cargo.toml",
  "pyproject.toml",
  "go.mod",
  "Gemfile",
  "Podfile",
  "Dockerfile",
  "AGENTS.md",
] as const);

export type CompanyRepositoryMarker =
  (typeof COMPANY_REPOSITORY_MARKERS)[number];

export type CompanyToolBundleId =
  | "project_context_v1"
  | "source_control_v1"
  | "architecture_v1"
  | "implementation_v1"
  | "quality_v1"
  | "security_v1"
  | "release_v1";

export type CompanyModelRoute =
  | "parent"
  | "implement"
  | "review"
  | "repair";

export interface CompanyRepositoryFactsV1 {
  readonly inspected: boolean;
  readonly markers: readonly CompanyRepositoryMarker[];
}

export interface CompanyProjectV1 {
  readonly type: CompanyProjectType;
  readonly stage: CompanyProjectStage;
  readonly purpose: string;
  readonly constraints: readonly string[];
  readonly repository: CompanyRepositoryFactsV1;
}

export interface CompanyRoleV1 {
  readonly id: CompanyRoleId;
  readonly version: 1;
  readonly displayName: string;
  readonly department: CompanyDepartmentId;
  readonly responsibility: string;
  readonly instructions: string;
  readonly executionProfileId: AgentProfileId | null;
  readonly permissionMode: AgentPermissionMode;
  readonly modelRoute: CompanyModelRoute;
  readonly toolBundles: readonly CompanyToolBundleId[];
}

export interface CompanyToolRequirementV1 {
  readonly id: CompanyToolBundleId;
  readonly status: "available" | "required";
  readonly reason: string;
}

export interface CompanyQualityPlanV1 {
  readonly standard: AgentTeamQualityStandard;
  readonly maxImplementers: number;
  readonly initialReviewers: number;
  readonly maxReviewers: number;
  readonly maxRepairRounds: number;
  readonly approvalRule: "unanimous";
}

export interface CompanyBlueprintV1 {
  readonly id: string;
  readonly version: 1;
  readonly state: "proposed" | "approved";
  readonly createdAt: string;
  readonly approvedAt: string | null;
  readonly project: CompanyProjectV1;
  readonly developmentStyle: CompanyDevelopmentStyle;
  readonly authority: {
    readonly permissionMode: AgentPermissionMode;
    readonly operatingModeId: OperatingModeId;
    readonly operatingModeVersion: OperatingModeVersion;
  };
  readonly roles: readonly CompanyRoleV1[];
  readonly toolPlan: readonly CompanyToolRequirementV1[];
  readonly quality: CompanyQualityPlanV1;
  readonly initialGoal: string;
}

export interface CompanyBlueprintBinding {
  readonly blueprintId: string;
  readonly blueprintVersion: 1;
  readonly roleId: CompanyRoleId;
  readonly roleVersion: 1;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const INVALID_TEXT =
  /[\p{Cf}\p{Cs}\p{Zl}\p{Zp}]|[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const utf8Encoder = new TextEncoder();
const roleIds = new Set<string>(COMPANY_ROLE_IDS);
const departments = new Set<string>(COMPANY_DEPARTMENT_IDS);
const markers = new Set<string>(COMPANY_REPOSITORY_MARKERS);
const projectTypes = new Set<string>([
  "ios_app", "macos_app", "web_app", "backend", "ai_ml",
  "infrastructure", "game", "plugin", "existing_project", "other",
]);
const projectStages = new Set<string>([
  "idea", "prototype", "active", "maintenance",
]);
const developmentStyles = new Set<string>([
  "layered_company", "orchestrator", "single_agent",
]);
const permissionModes = new Set<string>([
  "ask_always", "approved_for_me", "full_access",
]);
const toolBundles = new Set<string>([
  "project_context_v1", "source_control_v1", "architecture_v1",
  "implementation_v1", "quality_v1", "security_v1", "release_v1",
]);
const modelRoutes = new Set<string>([
  "parent", "implement", "review", "repair",
]);
const profiles = new Set<string>([
  "explore_v1", "implement_v1", "review_v1",
]);

const expectedRoleProfiles: Readonly<Record<CompanyRoleId, AgentProfileId | null>> = {
  orchestrator_v1: null,
  product_planner_v1: "explore_v1",
  tool_curator_v1: "explore_v1",
  architect_v1: "explore_v1",
  implementation_lead_v1: "explore_v1",
  scoped_builder_v1: "implement_v1",
  qa_reviewer_v1: "review_v1",
  security_release_reviewer_v1: "review_v1",
};

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

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 ||
    utf8Encoder.encode(value).byteLength > maximum || INVALID_TEXT.test(value)) {
    throw new TypeError(`${label} must be valid bounded text`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const parsed = text(value, label, 64);
  const date = new Date(parsed);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== parsed) {
    throw new TypeError(`${label} must be a canonical timestamp`);
  }
  return parsed;
}

function integer(value: unknown, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new TypeError(`${label} must be a safe integer`);
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

function parseProject(value: unknown): CompanyProjectV1 {
  const project = record(value, "Company project");
  exact(project, ["type", "stage", "purpose", "constraints", "repository"],
    "Company project");
  if (!Array.isArray(project.constraints) || project.constraints.length > 16) {
    throw new TypeError("Company project constraints are invalid");
  }
  const repository = record(project.repository, "Company repository facts");
  exact(repository, ["inspected", "markers"], "Company repository facts");
  if (typeof repository.inspected !== "boolean" ||
    !Array.isArray(repository.markers) || repository.markers.length > 10) {
    throw new TypeError("Company repository facts are invalid");
  }
  const parsedMarkers = repository.markers.map((marker) =>
    enumValue<CompanyRepositoryMarker>(marker, markers, "Repository marker")
  );
  if (new Set(parsedMarkers).size !== parsedMarkers.length ||
    [...parsedMarkers].sort().some((marker, index) => marker !== parsedMarkers[index]) ||
    (!repository.inspected && parsedMarkers.length > 0)) {
    throw new TypeError("Repository markers must be unique, sorted, and inspected");
  }
  return {
    type: enumValue(project.type, projectTypes, "Company project type"),
    stage: enumValue(project.stage, projectStages, "Company project stage"),
    purpose: text(project.purpose, "Company project purpose", 2_000),
    constraints: project.constraints.map((constraint) =>
      text(constraint, "Company project constraint", 512)
    ),
    repository: {
      inspected: repository.inspected,
      markers: parsedMarkers,
    },
  };
}

function parseRole(value: unknown): CompanyRoleV1 {
  const role = record(value, "Company role");
  exact(role, [
    "id", "version", "displayName", "department", "responsibility",
    "instructions", "executionProfileId", "permissionMode", "modelRoute",
    "toolBundles",
  ], "Company role");
  const id = enumValue<CompanyRoleId>(role.id, roleIds, "Company role id");
  if (role.version !== 1) throw new TypeError("Company role version is invalid");
  const profile = role.executionProfileId === null
    ? null
    : enumValue<AgentProfileId>(
      role.executionProfileId,
      profiles,
      "Company execution profile",
    );
  if (expectedRoleProfiles[id] !== profile) {
    throw new TypeError(`Company role ${id} has an invalid execution profile`);
  }
  if (!Array.isArray(role.toolBundles) || role.toolBundles.length === 0 ||
    role.toolBundles.length > 7) {
    throw new TypeError("Company role tool bundles are invalid");
  }
  const parsedBundles = role.toolBundles.map((bundle) =>
    enumValue<CompanyToolBundleId>(bundle, toolBundles, "Company tool bundle")
  );
  if (new Set(parsedBundles).size !== parsedBundles.length) {
    throw new TypeError("Company role tool bundles must be unique");
  }
  return {
    id,
    version: 1,
    displayName: text(role.displayName, "Company role display name", 128),
    department: enumValue(role.department, departments, "Company department"),
    responsibility: text(role.responsibility, "Company role responsibility", 1_024),
    instructions: text(role.instructions, "Company role instructions", 4_096),
    executionProfileId: profile,
    permissionMode: enumValue(role.permissionMode, permissionModes,
      "Company role permission"),
    modelRoute: enumValue(role.modelRoute, modelRoutes, "Company model route"),
    toolBundles: parsedBundles,
  };
}

function parseTool(value: unknown): CompanyToolRequirementV1 {
  const tool = record(value, "Company tool requirement");
  exact(tool, ["id", "status", "reason"], "Company tool requirement");
  return {
    id: enumValue(tool.id, toolBundles, "Company tool requirement id"),
    status: enumValue(tool.status, new Set(["available", "required"]),
      "Company tool requirement status"),
    reason: text(tool.reason, "Company tool requirement reason", 512),
  };
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function parseCompanyBlueprint(value: unknown): CompanyBlueprintV1 {
  const blueprint = record(value, "Company blueprint");
  exact(blueprint, [
    "id", "version", "state", "createdAt", "approvedAt", "project",
    "developmentStyle", "authority", "roles", "toolPlan", "quality",
    "initialGoal",
  ], "Company blueprint");
  if (blueprint.version !== 1) {
    throw new TypeError("Company blueprint version is invalid");
  }
  const id = text(blueprint.id, "Company blueprint id", 128);
  if (!SAFE_ID.test(id)) throw new TypeError("Company blueprint id is invalid");
  const state = enumValue<CompanyBlueprintV1["state"]>(
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
    permissionModes,
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
  if (authority.operatingModeVersion !== mode.version) {
    throw new TypeError("Company operating mode version is invalid");
  }
  if (!Array.isArray(blueprint.roles) || blueprint.roles.length === 0 ||
    blueprint.roles.length > COMPANY_ROLE_IDS.length) {
    throw new TypeError("Company roles are invalid");
  }
  const roles = blueprint.roles.map(parseRole);
  if (new Set(roles.map((role) => role.id)).size !== roles.length) {
    throw new TypeError("Company role ids must be unique");
  }
  if (roles.filter((role) => role.id === "orchestrator_v1").length !== 1) {
    throw new TypeError("Company requires one orchestrator role");
  }
  for (const role of roles) {
    if (narrowAgentPermissionMode(permissionMode, role.permissionMode) !==
      role.permissionMode) {
      throw new TypeError("Company role permission exceeds parent permission");
    }
  }
  if (!Array.isArray(blueprint.toolPlan) || blueprint.toolPlan.length === 0 ||
    blueprint.toolPlan.length > 7) {
    throw new TypeError("Company tool plan is invalid");
  }
  const toolPlan = blueprint.toolPlan.map(parseTool);
  if (new Set(toolPlan.map((tool) => tool.id)).size !== toolPlan.length) {
    throw new TypeError("Company tool plan ids must be unique");
  }
  const quality = record(blueprint.quality, "Company quality plan");
  exact(quality, [
    "standard", "maxImplementers", "initialReviewers", "maxReviewers",
    "maxRepairRounds", "approvalRule",
  ], "Company quality plan");
  const team = mode.workflow.team;
  if (team === null || quality.standard !== team.qualityStandard ||
    quality.maxImplementers !== team.maxImplementers ||
    quality.initialReviewers !== team.initialReviewers ||
    quality.maxReviewers !== team.maxReviewers ||
    quality.maxRepairRounds !== (team.maxRepairRounds ?? 0) ||
    quality.approvalRule !== team.approvalRule) {
    throw new TypeError("Company quality plan does not match its operating mode");
  }
  const parsed: CompanyBlueprintV1 = {
    id,
    version: 1,
    state,
    createdAt: timestamp(blueprint.createdAt, "Company blueprint createdAt timestamp"),
    approvedAt,
    project: parseProject(blueprint.project),
    developmentStyle: enumValue(
      blueprint.developmentStyle,
      developmentStyles,
      "Company development style",
    ),
    authority: {
      permissionMode,
      operatingModeId: mode.id,
      operatingModeVersion: mode.version,
    },
    roles,
    toolPlan,
    quality: {
      standard: team.qualityStandard,
      maxImplementers: integer(quality.maxImplementers, "maxImplementers", 1),
      initialReviewers: integer(quality.initialReviewers, "initialReviewers", 1),
      maxReviewers: integer(quality.maxReviewers, "maxReviewers", 1),
      maxRepairRounds: integer(quality.maxRepairRounds, "maxRepairRounds", 0),
      approvalRule: "unanimous",
    },
    initialGoal: text(blueprint.initialGoal, "Company initial goal", 2_000),
  };
  return deepFreeze(structuredClone(parsed)) as CompanyBlueprintV1;
}
