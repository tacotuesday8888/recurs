import type { ModelReasoningEffort } from "./model.js";
import {
  parseCompanyEvaluationReport,
  type CompanyEvaluationReportV1,
} from "./company-evaluation.js";
import {
  contractDeepFreeze,
  contractEnum,
  contractExact,
  contractId,
  contractRecord,
  contractText,
  contractTimestamp,
} from "./company-contract-utils.js";

export type ModelTeamTaskClass = "general_coding";
export type ModelTeamRole = "parent" | "implement" | "review" | "repair";

export interface ModelTeamRouteV1 {
  readonly role: ModelTeamRole;
  readonly providerId: string;
  readonly adapterId: string;
  readonly connectionId: string;
  readonly modelId: string;
  readonly reasoningEffort: ModelReasoningEffort | null;
}

export interface ModelTeamEvaluationV1 {
  readonly id: string;
  readonly version: 1;
  readonly taskClass: ModelTeamTaskClass;
  readonly companyGoalRunId: string;
  readonly evaluatedAt: string;
  readonly lineup: readonly ModelTeamRouteV1[];
  readonly report: CompanyEvaluationReportV1;
}

/**
 * V2 distinguishes configured routes from roles that actually made a provider
 * request during the recorded company run. V1 records remain readable, but
 * cannot prove route activation and are therefore not Auto-selection evidence.
 */
export interface ModelTeamEvaluationV2 extends Omit<ModelTeamEvaluationV1, "version"> {
  readonly version: 2;
  readonly activatedRoles: readonly ModelTeamRole[];
}

export type ModelTeamEvaluation = ModelTeamEvaluationV1 | ModelTeamEvaluationV2;

export interface ModelTeamSelectionV1 {
  readonly id: string;
  readonly version: 1;
  readonly taskClass: ModelTeamTaskClass;
  readonly selectedAt: string;
  readonly lineup: readonly ModelTeamRouteV1[];
  readonly evidenceIds: readonly string[];
  readonly rationale: string;
}

/** V2 names the roles supported by repeated observed activation evidence. */
export interface ModelTeamSelectionV2 extends Omit<ModelTeamSelectionV1, "version"> {
  readonly version: 2;
  readonly evaluatedRoles: readonly ("parent" | "implement" | "review")[];
}

export type ModelTeamSelection = ModelTeamSelectionV1 | ModelTeamSelectionV2;

const roles = new Set<ModelTeamRole>([
  "parent",
  "implement",
  "review",
  "repair",
]);
const taskClasses = new Set<ModelTeamTaskClass>(["general_coding"]);
const efforts = new Set<ModelReasoningEffort>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

function parseBackendIdentifier(
  value: unknown,
  label: string,
  maximum = 256,
): string {
  const parsed = contractText(value, label, maximum);
  if (/\s/u.test(parsed)) {
    throw new TypeError(`${label} is invalid`);
  }
  return parsed;
}

function parseRoute(value: unknown): ModelTeamRouteV1 {
  const route = contractRecord(value, "Model-team route");
  contractExact(route, [
    "role",
    "providerId",
    "adapterId",
    "connectionId",
    "modelId",
    "reasoningEffort",
  ], "Model-team route");
  return {
    role: contractEnum(route.role, roles, "Model-team role"),
    providerId: parseBackendIdentifier(
      route.providerId,
      "Model-team provider",
      128,
    ),
    adapterId: parseBackendIdentifier(
      route.adapterId,
      "Model-team adapter",
      128,
    ),
    connectionId: parseBackendIdentifier(
      route.connectionId,
      "Model-team connection",
      128,
    ),
    modelId: parseBackendIdentifier(route.modelId, "Model-team model"),
    reasoningEffort: route.reasoningEffort === null
      ? null
      : contractEnum(
          route.reasoningEffort,
          efforts,
          "Model-team reasoning effort",
        ),
  };
}

export function parseModelTeamLineup(
  value: unknown,
): readonly ModelTeamRouteV1[] {
  if (!Array.isArray(value) || value.length !== roles.size) {
    throw new TypeError("Model-team lineup is invalid");
  }
  const lineup = value.map(parseRoute);
  if (
    new Set(lineup.map((route) => route.role)).size !== roles.size ||
    [...roles].some((role) => !lineup.some((route) => route.role === role))
  ) {
    throw new TypeError("Model-team lineup roles are invalid");
  }
  return contractDeepFreeze(lineup) as readonly ModelTeamRouteV1[];
}

function parseActivatedRoles(value: unknown): readonly ModelTeamRole[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > roles.size) {
    throw new TypeError("Model-team activated roles are invalid");
  }
  const parsed = value.map((role) =>
    contractEnum(role, roles, "Model-team activated role")
  );
  if (new Set(parsed).size !== parsed.length) {
    throw new TypeError("Model-team activated roles must be unique");
  }
  const ordered = [...parsed].sort((left, right) =>
    ["parent", "implement", "review", "repair"].indexOf(left) -
    ["parent", "implement", "review", "repair"].indexOf(right)
  );
  if (ordered.some((role, index) => role !== parsed[index])) {
    throw new TypeError("Model-team activated roles must be in role order");
  }
  return contractDeepFreeze(parsed) as readonly ModelTeamRole[];
}

export function parseModelTeamEvaluation(
  value: unknown,
): ModelTeamEvaluationV1 {
  const evaluation = contractRecord(value, "Model-team evaluation");
  contractExact(evaluation, [
    "id",
    "version",
    "taskClass",
    "companyGoalRunId",
    "evaluatedAt",
    "lineup",
    "report",
  ], "Model-team evaluation");
  if (evaluation.version !== 1) {
    throw new TypeError("Model-team evaluation version is invalid");
  }
  const report = parseCompanyEvaluationReport(evaluation.report);
  if (
    report.scenarioId !== "company_goal_execution_v1" ||
    report.mode !== "configured"
  ) {
    throw new TypeError("Model-team evidence must come from a configured goal");
  }
  return contractDeepFreeze({
    id: contractId(evaluation.id, "Model-team evaluation id"),
    version: 1,
    taskClass: contractEnum(
      evaluation.taskClass,
      taskClasses,
      "Model-team task class",
    ),
    companyGoalRunId: contractId(
      evaluation.companyGoalRunId,
      "Company goal run id",
    ),
    evaluatedAt: contractTimestamp(
      evaluation.evaluatedAt,
      "Model-team evaluation timestamp",
    ),
    lineup: parseModelTeamLineup(evaluation.lineup),
    report,
  }) as ModelTeamEvaluationV1;
}

export function parseModelTeamEvaluationV2(
  value: unknown,
): ModelTeamEvaluationV2 {
  const evaluation = contractRecord(value, "Model-team evaluation");
  contractExact(evaluation, [
    "id",
    "version",
    "taskClass",
    "companyGoalRunId",
    "evaluatedAt",
    "lineup",
    "activatedRoles",
    "report",
  ], "Model-team evaluation");
  if (evaluation.version !== 2) {
    throw new TypeError("Model-team evaluation version is invalid");
  }
  const report = parseCompanyEvaluationReport(evaluation.report);
  if (
    report.scenarioId !== "company_goal_execution_v1" ||
    report.mode !== "configured"
  ) {
    throw new TypeError("Model-team evidence must come from a configured goal");
  }
  return contractDeepFreeze({
    id: contractId(evaluation.id, "Model-team evaluation id"),
    version: 2,
    taskClass: contractEnum(
      evaluation.taskClass,
      taskClasses,
      "Model-team task class",
    ),
    companyGoalRunId: contractId(
      evaluation.companyGoalRunId,
      "Company goal run id",
    ),
    evaluatedAt: contractTimestamp(
      evaluation.evaluatedAt,
      "Model-team evaluation timestamp",
    ),
    lineup: parseModelTeamLineup(evaluation.lineup),
    activatedRoles: parseActivatedRoles(evaluation.activatedRoles),
    report,
  }) as ModelTeamEvaluationV2;
}

export function parseModelTeamEvidence(value: unknown): ModelTeamEvaluation {
  const record = contractRecord(value, "Model-team evaluation");
  return record.version === 1
    ? parseModelTeamEvaluation(value)
    : record.version === 2
    ? parseModelTeamEvaluationV2(value)
    : (() => {
      throw new TypeError("Model-team evaluation version is invalid");
    })();
}

export function parseModelTeamSelection(
  value: unknown,
): ModelTeamSelectionV1 {
  const selection = contractRecord(value, "Model-team selection");
  contractExact(selection, [
    "id",
    "version",
    "taskClass",
    "selectedAt",
    "lineup",
    "evidenceIds",
    "rationale",
  ], "Model-team selection");
  if (
    selection.version !== 1 ||
    !Array.isArray(selection.evidenceIds) ||
    selection.evidenceIds.length === 0 ||
    selection.evidenceIds.length > 64
  ) {
    throw new TypeError("Model-team selection is invalid");
  }
  const evidenceIds = selection.evidenceIds.map((id) =>
    contractId(id, "Model-team evidence id")
  );
  if (new Set(evidenceIds).size !== evidenceIds.length) {
    throw new TypeError("Model-team evidence ids must be unique");
  }
  return contractDeepFreeze({
    id: contractId(selection.id, "Model-team selection id"),
    version: 1,
    taskClass: contractEnum(
      selection.taskClass,
      taskClasses,
      "Model-team task class",
    ),
    selectedAt: contractTimestamp(
      selection.selectedAt,
      "Model-team selection timestamp",
    ),
    lineup: parseModelTeamLineup(selection.lineup),
    evidenceIds,
    rationale: contractText(
      selection.rationale,
      "Model-team selection rationale",
      2_000,
    ),
  }) as ModelTeamSelectionV1;
}

export function parseModelTeamSelectionV2(
  value: unknown,
): ModelTeamSelectionV2 {
  const selection = contractRecord(value, "Model-team selection");
  contractExact(selection, [
    "id",
    "version",
    "taskClass",
    "selectedAt",
    "lineup",
    "evaluatedRoles",
    "evidenceIds",
    "rationale",
  ], "Model-team selection");
  if (
    selection.version !== 2 || !Array.isArray(selection.evidenceIds) ||
    selection.evidenceIds.length === 0 || selection.evidenceIds.length > 64
  ) {
    throw new TypeError("Model-team selection is invalid");
  }
  const evaluatedRoles = parseActivatedRoles(selection.evaluatedRoles);
  if (
    evaluatedRoles.length !== 3 ||
    evaluatedRoles.join(",") !== "parent,implement,review"
  ) {
    throw new TypeError("Model-team selection must name observed core roles");
  }
  const evidenceIds = selection.evidenceIds.map((id) =>
    contractId(id, "Model-team evidence id")
  );
  if (new Set(evidenceIds).size !== evidenceIds.length) {
    throw new TypeError("Model-team evidence ids must be unique");
  }
  return contractDeepFreeze({
    id: contractId(selection.id, "Model-team selection id"),
    version: 2,
    taskClass: contractEnum(
      selection.taskClass,
      taskClasses,
      "Model-team task class",
    ),
    selectedAt: contractTimestamp(
      selection.selectedAt,
      "Model-team selection timestamp",
    ),
    lineup: parseModelTeamLineup(selection.lineup),
    evaluatedRoles: evaluatedRoles as readonly ("parent" | "implement" | "review")[],
    evidenceIds,
    rationale: contractText(
      selection.rationale,
      "Model-team selection rationale",
      2_000,
    ),
  }) as ModelTeamSelectionV2;
}

export function parseModelTeamSelectionEvidence(
  value: unknown,
): ModelTeamSelection {
  const record = contractRecord(value, "Model-team selection");
  return record.version === 1
    ? parseModelTeamSelection(value)
    : record.version === 2
    ? parseModelTeamSelectionV2(value)
    : (() => {
      throw new TypeError("Model-team selection version is invalid");
    })();
}
