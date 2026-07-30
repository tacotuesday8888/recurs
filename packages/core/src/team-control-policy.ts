import {
  parseCompanyBlueprintV2,
  parseCompanyGoalPlan,
  parseEffectiveTeamControlPolicyV1,
  validateCompanyGoalPlanAgainstBlueprint,
  type CompanyBlueprintV2,
  type CompanyGoalAssignmentV1,
  type CompanyGoalPlanV1,
  type EffectiveTeamControlPolicyV1,
} from "@recurs/contracts";

export interface TeamEscalationInput {
  readonly assignmentId: string;
  readonly fromRoleId: string;
  readonly toRoleId: string;
  readonly summary: string;
  readonly evidence: readonly string[];
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const INVALID_TEXT = /[\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const encoder = new TextEncoder();

function assertControlBinding(
  blueprint: CompanyBlueprintV2,
  controls: EffectiveTeamControlPolicyV1,
): void {
  if (controls.blueprintId !== blueprint.id ||
    controls.blueprintRevision !== blueprint.revision ||
    controls.operatingModeId !== blueprint.authority.operatingModeId ||
    controls.operatingModeVersion !== blueprint.authority.operatingModeVersion) {
    throw new TypeError("Team controls target another approved company");
  }
}

function isImplementation(
  assignment: CompanyGoalAssignmentV1,
  blueprint: CompanyBlueprintV2,
): boolean {
  const profile = blueprint.roles.find((role) =>
    role.id === assignment.roleId
  )?.executionProfileId;
  return profile === "implement_v2" || profile === "repair_v1";
}

function dependencies(
  assignment: CompanyGoalAssignmentV1,
): readonly string[] {
  return [
    ...(assignment.parentAssignmentId === null
      ? []
      : [assignment.parentAssignmentId]),
    ...assignment.dependsOn,
  ];
}

function dependsTransitively(
  assignment: CompanyGoalAssignmentV1,
  dependencyId: string,
  assignments: ReadonlyMap<string, CompanyGoalAssignmentV1>,
): boolean {
  const visited = new Set<string>();
  const visit = (candidate: CompanyGoalAssignmentV1): boolean => {
    for (const id of dependencies(candidate)) {
      if (id === dependencyId) return true;
      if (!visited.has(id)) {
        visited.add(id);
        if (visit(assignments.get(id)!)) return true;
      }
    }
    return false;
  };
  return visit(assignment);
}

function roleDepth(
  roleId: string,
  blueprint: CompanyBlueprintV2,
): number {
  const roles = new Map(blueprint.roles.map((role) => [role.id, role] as const));
  let depth = 0;
  let current = roles.get(roleId)!;
  while (current.reportsTo !== null) {
    depth += 1;
    current = roles.get(current.reportsTo)!;
  }
  return depth;
}

export function validateCompanyGoalPlanAgainstTeamControls(
  planInput: CompanyGoalPlanV1,
  blueprintInput: CompanyBlueprintV2,
  controlsInput: EffectiveTeamControlPolicyV1,
): void {
  const plan = parseCompanyGoalPlan(planInput);
  const blueprint = parseCompanyBlueprintV2(blueprintInput);
  const controls = parseEffectiveTeamControlPolicyV1(controlsInput);
  assertControlBinding(blueprint, controls);
  validateCompanyGoalPlanAgainstBlueprint(plan, blueprint);
  if (plan.assignments.length > controls.maxActiveAgents) {
    throw new TypeError("Company plan exceeds the active-agent ceiling");
  }

  const assignments = new Map(
    plan.assignments.map((assignment) => [assignment.id, assignment] as const),
  );
  if (plan.assignments.some((assignment) =>
    roleDepth(assignment.roleId, blueprint) > controls.maxDelegationDepth
  )) {
    throw new TypeError("Company plan exceeds the delegation-depth ceiling");
  }

  const implementations = plan.assignments.filter((assignment) =>
    isImplementation(assignment, blueprint)
  );
  if (controls.topology === "focused" && implementations.length > 1) {
    throw new TypeError("Focused team controls permit one implementation branch");
  }

  if (controls.topology === "hierarchical") {
    const roles = new Map(blueprint.roles.map((role) => [role.id, role] as const));
    const rootRoleId = blueprint.authorityAnchors.rootRoleId;
    for (const assignment of plan.assignments) {
      const managerRoleId = roles.get(assignment.roleId)!.reportsTo;
      if (managerRoleId === rootRoleId) {
        if (assignment.parentAssignmentId !== null) {
          throw new TypeError(
            "Hierarchical root reports cannot name another assignment manager",
          );
        }
        continue;
      }
      const manager = assignment.parentAssignmentId === null
        ? undefined
        : assignments.get(assignment.parentAssignmentId);
      if (managerRoleId === null || manager?.roleId !== managerRoleId) {
        throw new TypeError(
          "Hierarchical assignment does not follow its reporting manager",
        );
      }
    }
  }

  if (controls.topology === "research_heavy") {
    const research = plan.assignments.filter((assignment) => {
      const role = blueprint.roles.find((candidate) =>
        candidate.id === assignment.roleId
      )!;
      return role.executionProfileId === "explore_v1" &&
        role.capabilities.includes("research");
    });
    for (const implementation of implementations) {
      if (research.some((assignment) =>
        !dependsTransitively(implementation, assignment.id, assignments)
      )) {
        throw new TypeError(
          "Research-heavy implementation must depend on its research evidence",
        );
      }
    }
  }

  if (controls.independentReview === "required" ||
    controls.topology === "review_heavy") {
    const reviewRoleIds = new Set(
      blueprint.authorityAnchors.independentReviewRoleIds,
    );
    const reviews = plan.assignments.filter((assignment) =>
      reviewRoleIds.has(assignment.roleId)
    );
    if (reviews.length === 0 || implementations.some((implementation) =>
      !reviews.some((review) =>
        dependsTransitively(review, implementation.id, assignments)
      )
    )) {
      throw new TypeError(
        "Independent review must cover every implementation assignment",
      );
    }
  }
}

function boundedText(value: string, label: string, maximum: number): void {
  let invalid = INVALID_TEXT.test(value);
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code <= 8 || code === 11 || code === 12 ||
      (code >= 14 && code <= 31) || code === 127) {
      invalid = true;
      break;
    }
  }
  if (value.length === 0 || encoder.encode(value).byteLength > maximum ||
    invalid) {
    throw new TypeError(`${label} must be bounded text`);
  }
}

export function validateTeamEscalation(
  input: TeamEscalationInput,
  blueprintInput: CompanyBlueprintV2,
  controlsInput: EffectiveTeamControlPolicyV1,
): void {
  const blueprint = parseCompanyBlueprintV2(blueprintInput);
  const controls = parseEffectiveTeamControlPolicyV1(controlsInput);
  assertControlBinding(blueprint, controls);
  if (!SAFE_ID.test(input.assignmentId) || !SAFE_ID.test(input.fromRoleId) ||
    !SAFE_ID.test(input.toRoleId)) {
    throw new TypeError("Team escalation identity is invalid");
  }
  boundedText(input.summary, "Team escalation summary", 2_000);
  if (!Array.isArray(input.evidence) || input.evidence.length === 0 ||
    input.evidence.length > 16 ||
    new Set(input.evidence).size !== input.evidence.length) {
    throw new TypeError("Team escalation requires unique bounded evidence");
  }
  for (const evidence of input.evidence) {
    boundedText(evidence, "Team escalation evidence", 2_000);
  }

  const roles = new Map(blueprint.roles.map((role) => [role.id, role] as const));
  const source = roles.get(input.fromRoleId);
  const target = roles.get(input.toRoleId);
  if (source === undefined || target === undefined ||
    source.id === blueprint.authorityAnchors.rootRoleId ||
    source.id === target.id) {
    throw new TypeError("Team escalation roles are invalid");
  }
  const directManager = source.reportsTo === target.id;
  const permittedRoot = controls.escalation === "root_allowed" &&
    target.id === blueprint.authorityAnchors.rootRoleId;
  if (!directManager && !permittedRoot) {
    throw new TypeError("Team escalation path is not approved");
  }
}
