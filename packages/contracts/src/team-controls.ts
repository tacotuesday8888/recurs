import {
  getOperatingModePolicy,
  operatingModePolicies,
  type OperatingModeId,
  type OperatingModePolicy,
  type OperatingModeVersion,
} from "./agents.js";
import {
  contractDeepFreeze,
  contractEnum,
  contractExact,
  contractId,
  contractInteger,
  contractNumber,
  contractRecord,
} from "./company-contract-utils.js";
import {
  parseCompanyBlueprintV2,
  type CompanyBlueprintV2,
} from "./company-v2.js";

export const TEAM_TOPOLOGIES_V1 = Object.freeze([
  "recommended",
  "focused",
  "parallel",
  "hierarchical",
  "research_heavy",
  "review_heavy",
] as const);

export type TeamTopologyV1 = (typeof TEAM_TOPOLOGIES_V1)[number];
export type TeamEscalationV1 = "manager_only" | "root_allowed";
export type TeamIndependentReviewV1 = "required" | "when_planned";

interface TeamControlValuesV1 {
  readonly topology: TeamTopologyV1;
  readonly maxActiveAgents: number;
  readonly maxConcurrentAgents: number;
  readonly maxDelegationDepth: number;
  readonly escalation: TeamEscalationV1;
  readonly independentReview: TeamIndependentReviewV1;
  readonly maxRepairRounds: number;
  readonly maxRequests: number;
  readonly maxReportedCostUsd: number;
}

export interface TeamControlPolicyV1 extends TeamControlValuesV1 {
  readonly version: 1;
  readonly revision: number;
  readonly operatingModeId: OperatingModeId;
  readonly operatingModeVersion: OperatingModeVersion;
}

export interface EffectiveTeamControlPolicyV1 extends TeamControlValuesV1 {
  readonly version: 1;
  readonly sourceRevision: number;
  readonly operatingModeId: OperatingModeId;
  readonly operatingModeVersion: OperatingModeVersion;
  readonly blueprintId: string;
  readonly blueprintRevision: number;
}

const operatingModeIds = new Set<string>(
  operatingModePolicies.map((policy) => policy.id),
);
const topologies = new Set<string>(TEAM_TOPOLOGIES_V1);
const escalations = new Set<string>(["manager_only", "root_allowed"]);
const reviewPolicies = new Set<string>(["required", "when_planned"]);
const valueKeys = Object.freeze([
  "topology",
  "maxActiveAgents",
  "maxConcurrentAgents",
  "maxDelegationDepth",
  "escalation",
  "independentReview",
  "maxRepairRounds",
  "maxRequests",
  "maxReportedCostUsd",
] as const);

function currentCompanyMode(id: OperatingModeId): OperatingModePolicy {
  const mode = getOperatingModePolicy(id);
  if (mode.version !== 6 || mode.company === undefined ||
    mode.workflow.team === null) {
    throw new TypeError("Team controls require a current company operating mode");
  }
  return mode;
}

function parseModeBinding(
  value: Record<string, unknown>,
): {
  readonly id: OperatingModeId;
  readonly version: OperatingModeVersion;
  readonly mode: OperatingModePolicy;
} {
  const id = contractEnum<OperatingModeId>(
    value.operatingModeId,
    operatingModeIds,
    "Team-control operating mode",
  );
  const mode = currentCompanyMode(id);
  const version = contractInteger(
    value.operatingModeVersion,
    "Team-control operating-mode version",
    1,
    6,
  ) as OperatingModeVersion;
  if (version !== mode.version) {
    throw new TypeError("Team-control operating-mode version does not match");
  }
  return { id, version, mode };
}

function parseValues(value: Record<string, unknown>): TeamControlValuesV1 {
  const maxActiveAgents = contractInteger(
    value.maxActiveAgents,
    "Maximum active agents",
    1,
    64,
  );
  const maxConcurrentAgents = contractInteger(
    value.maxConcurrentAgents,
    "Maximum concurrent agents",
    1,
    64,
  );
  if (maxConcurrentAgents > maxActiveAgents) {
    throw new TypeError("Concurrent agents cannot exceed active agents");
  }
  return {
    topology: contractEnum<TeamTopologyV1>(
      value.topology,
      topologies,
      "Team topology",
    ),
    maxActiveAgents,
    maxConcurrentAgents,
    maxDelegationDepth: contractInteger(
      value.maxDelegationDepth,
      "Maximum delegation depth",
      1,
      16,
    ),
    escalation: contractEnum<TeamEscalationV1>(
      value.escalation,
      escalations,
      "Team escalation policy",
    ),
    independentReview: contractEnum<TeamIndependentReviewV1>(
      value.independentReview,
      reviewPolicies,
      "Team independent-review policy",
    ),
    maxRepairRounds: contractInteger(
      value.maxRepairRounds,
      "Maximum repair rounds",
      0,
      16,
    ),
    maxRequests: contractInteger(
      value.maxRequests,
      "Maximum team requests",
      1,
      10_000,
    ),
    maxReportedCostUsd: contractNumber(
      value.maxReportedCostUsd,
      "Maximum reported team cost",
      Number.EPSILON,
      1_000_000,
    ),
  };
}

function assertWithinMode(
  values: TeamControlValuesV1,
  mode: OperatingModePolicy,
): void {
  const company = mode.company!;
  const team = mode.workflow.team!;
  if (values.maxActiveAgents > company.maxActiveRoles ||
    values.maxConcurrentAgents > company.maxConcurrentAssignments ||
    values.maxDelegationDepth > company.maxDepth ||
    values.maxRepairRounds > (team.maxRepairRounds ?? 0) ||
    values.maxRequests > company.maxGoalRequests ||
    values.maxReportedCostUsd > company.maxReportedCostUsd) {
    throw new TypeError("Team controls exceed their operating-mode ceiling");
  }
}

export function parseTeamControlPolicyV1(
  value: unknown,
): TeamControlPolicyV1 {
  const record = contractRecord(value, "Team-control policy");
  contractExact(record, [
    "version",
    "revision",
    "operatingModeId",
    "operatingModeVersion",
    ...valueKeys,
  ], "Team-control policy");
  if (record.version !== 1) {
    throw new TypeError("Team-control policy version is invalid");
  }
  const binding = parseModeBinding(record);
  const values = parseValues(record);
  assertWithinMode(values, binding.mode);
  return contractDeepFreeze({
    version: 1,
    revision: contractInteger(
      record.revision,
      "Team-control policy revision",
      1,
    ),
    operatingModeId: binding.id,
    operatingModeVersion: binding.version,
    ...values,
  }) as TeamControlPolicyV1;
}

export function validateTeamControlPolicyAgainstMode(
  policy: TeamControlPolicyV1,
  operatingModeId: OperatingModeId,
): void {
  const parsed = parseTeamControlPolicyV1(policy);
  const mode = currentCompanyMode(operatingModeId);
  if (parsed.operatingModeId !== mode.id ||
    parsed.operatingModeVersion !== mode.version) {
    throw new TypeError("Team controls target another operating mode");
  }
  assertWithinMode(parsed, mode);
}

export function recommendedTeamControlPolicy(
  operatingModeId: OperatingModeId,
  revision = 1,
): TeamControlPolicyV1 {
  const mode = currentCompanyMode(operatingModeId);
  return parseTeamControlPolicyV1({
    version: 1,
    revision,
    operatingModeId: mode.id,
    operatingModeVersion: mode.version,
    topology: "recommended",
    maxActiveAgents: mode.company!.maxActiveRoles,
    maxConcurrentAgents: mode.company!.maxConcurrentAssignments,
    maxDelegationDepth: mode.company!.maxDepth,
    escalation: "manager_only",
    independentReview: "required",
    maxRepairRounds: mode.workflow.team!.maxRepairRounds ?? 0,
    maxRequests: mode.company!.maxGoalRequests,
    maxReportedCostUsd: mode.company!.maxReportedCostUsd,
  });
}

function blueprintDepth(blueprint: CompanyBlueprintV2): number {
  const roles = new Map(blueprint.roles.map((role) => [role.id, role] as const));
  const depths = new Map<string, number>();
  const depth = (roleId: string): number => {
    const cached = depths.get(roleId);
    if (cached !== undefined) return cached;
    const role = roles.get(roleId)!;
    const value = role.reportsTo === null ? 0 : depth(role.reportsTo) + 1;
    depths.set(roleId, value);
    return value;
  };
  return Math.max(1, ...blueprint.roles.map((role) => depth(role.id)));
}

export function effectiveTeamControlPolicy(
  policy: TeamControlPolicyV1,
  blueprintInput: CompanyBlueprintV2,
): EffectiveTeamControlPolicyV1 {
  const selected = parseTeamControlPolicyV1(policy);
  const blueprint = parseCompanyBlueprintV2(blueprintInput);
  if (blueprint.state !== "approved") {
    throw new TypeError("Effective team controls require an approved company");
  }
  validateTeamControlPolicyAgainstMode(
    selected,
    blueprint.authority.operatingModeId,
  );
  const mode = currentCompanyMode(selected.operatingModeId);
  const independentReviewerActive =
    blueprint.authorityAnchors.independentReviewRoleIds.some((roleId) =>
      blueprint.activation.defaultActiveRoleIds.includes(roleId)
    );
  return parseEffectiveTeamControlPolicyV1({
    version: 1,
    sourceRevision: selected.revision,
    operatingModeId: selected.operatingModeId,
    operatingModeVersion: selected.operatingModeVersion,
    blueprintId: blueprint.id,
    blueprintRevision: blueprint.revision,
    topology: selected.topology,
    maxActiveAgents: Math.min(
      selected.maxActiveAgents,
      mode.company!.maxActiveRoles,
    ),
    maxConcurrentAgents: Math.min(
      selected.maxConcurrentAgents,
      mode.company!.maxConcurrentAssignments,
    ),
    maxDelegationDepth: Math.min(
      selected.maxDelegationDepth,
      mode.company!.maxDepth,
      blueprintDepth(blueprint),
    ),
    escalation: selected.escalation,
    independentReview:
      selected.independentReview === "required" || independentReviewerActive
        ? "required"
        : "when_planned",
    maxRepairRounds: Math.min(
      selected.maxRepairRounds,
      mode.workflow.team!.maxRepairRounds ?? 0,
      blueprint.quality.maxRepairRounds,
    ),
    maxRequests: Math.min(
      selected.maxRequests,
      mode.company!.maxGoalRequests,
    ),
    maxReportedCostUsd: Math.min(
      selected.maxReportedCostUsd,
      mode.company!.maxReportedCostUsd,
    ),
  });
}

export function parseEffectiveTeamControlPolicyV1(
  value: unknown,
): EffectiveTeamControlPolicyV1 {
  const record = contractRecord(value, "Effective team-control policy");
  contractExact(record, [
    "version",
    "sourceRevision",
    "operatingModeId",
    "operatingModeVersion",
    "blueprintId",
    "blueprintRevision",
    ...valueKeys,
  ], "Effective team-control policy");
  if (record.version !== 1) {
    throw new TypeError("Effective team-control policy version is invalid");
  }
  const binding = parseModeBinding(record);
  const values = parseValues(record);
  assertWithinMode(values, binding.mode);
  return contractDeepFreeze({
    version: 1,
    sourceRevision: contractInteger(
      record.sourceRevision,
      "Team-control source revision",
      1,
    ),
    operatingModeId: binding.id,
    operatingModeVersion: binding.version,
    blueprintId: contractId(record.blueprintId, "Team-control blueprint id"),
    blueprintRevision: contractInteger(
      record.blueprintRevision,
      "Team-control blueprint revision",
      1,
    ),
    ...values,
  }) as EffectiveTeamControlPolicyV1;
}
