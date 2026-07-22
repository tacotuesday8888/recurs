import type { ProviderUsage } from "./model.js";
import {
  parseCompanyBlueprintBindingV2,
  type CompanyBlueprintBindingV2,
  type CompanyBlueprintV2,
} from "./company-v2.js";
import {
  contractDeepFreeze,
  contractEnum,
  contractExact,
  contractId,
  contractIds,
  contractInteger,
  contractNumber,
  contractOptionalText,
  contractRecord,
  contractText,
  contractTextArray,
  contractTimestamp,
} from "./company-contract-utils.js";

export type CompanyGoalStatus =
  | "created"
  | "running"
  | "waiting_for_approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type CompanyGoalAssignmentStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "blocked";

export interface CompanyGoalAssignmentResultV1 {
  readonly summary: string;
  readonly evidence: readonly string[];
  readonly usage: ProviderUsage | null;
  readonly usageSource: "provider" | "runtime" | "unknown";
}

export interface CompanyGoalAssignmentExecutionV1 {
  readonly attempt: 1;
  readonly childAgentId: string;
  readonly childSessionId: string;
  readonly taskId: string;
  readonly startedAt: string;
  readonly completedAt: string | null;
}

export interface CompanyGoalAssignmentV1 {
  readonly id: string;
  readonly roleId: string;
  readonly parentAssignmentId: string | null;
  readonly dependsOn: readonly string[];
  readonly description: string;
  readonly prompt: string;
  readonly acceptance: readonly string[];
  readonly expectedEvidence: readonly string[];
  readonly status: CompanyGoalAssignmentStatus;
  /** Absent only on goal records written before execution correlation existed. */
  readonly execution?: CompanyGoalAssignmentExecutionV1;
  readonly result: CompanyGoalAssignmentResultV1 | null;
  readonly failure: string | null;
}

export interface CompanyGoalPlanV1 {
  readonly revision: number;
  readonly createdAt: string;
  readonly assignments: readonly CompanyGoalAssignmentV1[];
}

export interface CompanyGoalBudgetV1 {
  readonly maxAssignments: number;
  readonly assignmentsStarted: number;
  readonly maxConcurrentAssignments: number;
  readonly maxRequests: number;
  readonly requestsReserved: number;
  readonly requestsUsed: number;
  readonly maxReportedCostUsd: number;
  readonly reportedCostUsd: number;
}

export interface CompanyGoalRunV1 {
  readonly id: string;
  readonly version: 1;
  readonly parentSessionId: string;
  readonly goalId: string;
  readonly objective: string;
  readonly company: CompanyBlueprintBindingV2;
  readonly status: CompanyGoalStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly plan: CompanyGoalPlanV1;
  readonly budget: CompanyGoalBudgetV1;
  readonly result: {
    readonly summary: string;
    readonly evidence: readonly string[];
  } | null;
  readonly failure: string | null;
}

const assignmentStatuses = new Set<string>([
  "pending", "running", "completed", "failed", "cancelled", "blocked",
]);
const goalStatuses = new Set<string>([
  "created", "running", "waiting_for_approval", "completed", "failed",
  "cancelled", "interrupted",
]);

function parseUsage(value: unknown): ProviderUsage {
  const usage = contractRecord(value, "Company assignment provider usage");
  const allowed = new Set([
    "inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteInputTokens",
    "reasoningTokens", "costUsd",
  ]);
  if (Object.keys(usage).some((key) => !allowed.has(key))) {
    throw new TypeError("Company assignment provider usage has unknown fields");
  }
  const inputTokens = contractInteger(usage.inputTokens, "Input tokens", 0);
  const outputTokens = contractInteger(usage.outputTokens, "Output tokens", 0);
  return {
    inputTokens,
    outputTokens,
    ...(usage.cachedInputTokens === undefined
      ? {}
      : { cachedInputTokens: contractInteger(
        usage.cachedInputTokens,
        "Cached input tokens",
        0,
      ) }),
    ...(usage.cacheWriteInputTokens === undefined
      ? {}
      : { cacheWriteInputTokens: contractInteger(
        usage.cacheWriteInputTokens,
        "Cache-write input tokens",
        0,
      ) }),
    ...(usage.reasoningTokens === undefined
      ? {}
      : { reasoningTokens: contractInteger(
        usage.reasoningTokens,
        "Reasoning tokens",
        0,
      ) }),
    ...(usage.costUsd === undefined
      ? {}
      : { costUsd: contractNumber(usage.costUsd, "Provider cost", 0) }),
  };
}

function parseAssignmentResult(value: unknown): CompanyGoalAssignmentResultV1 {
  const result = contractRecord(value, "Company assignment result");
  contractExact(result, ["summary", "evidence", "usage", "usageSource"],
    "Company assignment result");
  const usageSource = contractEnum<"provider" | "runtime" | "unknown">(
    result.usageSource,
    new Set(["provider", "runtime", "unknown"]),
    "Company assignment usage source",
  );
  const usage = result.usage === null ? null : parseUsage(result.usage);
  if ((usageSource !== "unknown") !== (usage !== null)) {
    throw new TypeError("Company assignment usage source is inconsistent");
  }
  return {
    summary: contractText(result.summary, "Company assignment summary", 8_192),
    evidence: contractTextArray(
      result.evidence,
      "Company assignment evidence",
      64,
      2_000,
      false,
    ),
    usage,
    usageSource,
  };
}

function parseAssignmentExecution(
  value: unknown,
): CompanyGoalAssignmentExecutionV1 {
  const execution = contractRecord(value, "Company assignment execution");
  contractExact(execution, [
    "attempt", "childAgentId", "childSessionId", "taskId", "startedAt",
    "completedAt",
  ], "Company assignment execution");
  if (execution.attempt !== 1) {
    throw new TypeError("Company assignment execution attempt is invalid");
  }
  const startedAt = contractTimestamp(
    execution.startedAt,
    "Company assignment execution start",
  );
  const completedAt = execution.completedAt === null
    ? null
    : contractTimestamp(
        execution.completedAt,
        "Company assignment execution completion",
      );
  if (completedAt !== null &&
    new Date(completedAt).valueOf() < new Date(startedAt).valueOf()) {
    throw new TypeError("Company assignment completion precedes its start");
  }
  return {
    attempt: 1,
    childAgentId: contractId(execution.childAgentId, "Company child agent id"),
    childSessionId: contractId(
      execution.childSessionId,
      "Company child session id",
    ),
    taskId: contractId(execution.taskId, "Company child task id"),
    startedAt,
    completedAt,
  };
}

function parseAssignment(value: unknown): CompanyGoalAssignmentV1 {
  const assignment = contractRecord(value, "Company goal assignment");
  const hasExecution = Object.hasOwn(assignment, "execution");
  contractExact(assignment, [
    "id", "roleId", "parentAssignmentId", "dependsOn", "description",
    "prompt", "acceptance", "expectedEvidence", "status",
    ...(hasExecution ? ["execution"] : []), "result", "failure",
  ], "Company goal assignment");
  const status = contractEnum<CompanyGoalAssignmentStatus>(
    assignment.status,
    assignmentStatuses,
    "Company assignment status",
  );
  const result = assignment.result === null
    ? null
    : parseAssignmentResult(assignment.result);
  const failure = contractOptionalText(
    assignment.failure,
    "Company assignment failure",
    2_000,
  );
  const execution = hasExecution
    ? parseAssignmentExecution(assignment.execution)
    : undefined;
  const failed = status === "failed" || status === "cancelled" ||
    status === "blocked";
  if ((status === "completed") !== (result !== null) ||
    failed !== (failure !== null)) {
    throw new TypeError("Company assignment lifecycle state is inconsistent");
  }
  if (execution !== undefined && (
    (status === "pending" || status === "blocked") ||
    (status === "running") !== (execution.completedAt === null)
  )) {
    throw new TypeError("Company assignment execution state is inconsistent");
  }
  return {
    id: contractId(assignment.id, "Company assignment id"),
    roleId: contractId(assignment.roleId, "Company assignment role id"),
    parentAssignmentId: assignment.parentAssignmentId === null
      ? null
      : contractId(assignment.parentAssignmentId, "Parent assignment id"),
    dependsOn: contractIds(
      assignment.dependsOn,
      "Company assignment dependency",
      24,
    ),
    description: contractText(
      assignment.description,
      "Company assignment description",
      512,
    ),
    prompt: contractText(assignment.prompt, "Company assignment prompt", 32_768),
    acceptance: contractTextArray(
      assignment.acceptance,
      "Company assignment acceptance criterion",
      16,
      1_024,
      false,
    ),
    expectedEvidence: contractTextArray(
      assignment.expectedEvidence,
      "Company assignment expected evidence",
      16,
      1_024,
      false,
    ),
    status,
    ...(execution === undefined ? {} : { execution }),
    result,
    failure,
  };
}

function validateAcyclicAssignments(
  assignments: readonly CompanyGoalAssignmentV1[],
): void {
  const byId = new Map(assignments.map((item) => [item.id, item] as const));
  const dependencies = (assignment: CompanyGoalAssignmentV1) => [
    ...(assignment.parentAssignmentId === null
      ? []
      : [assignment.parentAssignmentId]),
    ...assignment.dependsOn,
  ];
  for (const assignment of assignments) {
    const edges = dependencies(assignment);
    if (edges.includes(assignment.id) || edges.some((id) => !byId.has(id))) {
      throw new TypeError("Company assignment references are invalid");
    }
    const visiting = new Set<string>();
    const visit = (id: string): void => {
      if (visiting.has(id)) throw new TypeError("Company assignment graph is cyclic");
      visiting.add(id);
      for (const edge of dependencies(byId.get(id)!)) visit(edge);
      visiting.delete(id);
    };
    visit(assignment.id);
  }
}

export function parseCompanyGoalPlan(value: unknown): CompanyGoalPlanV1 {
  const plan = contractRecord(value, "Company goal plan");
  contractExact(plan, ["revision", "createdAt", "assignments"],
    "Company goal plan");
  if (!Array.isArray(plan.assignments) || plan.assignments.length === 0 ||
    plan.assignments.length > 64) {
    throw new TypeError("Company goal assignments are invalid");
  }
  const assignments = plan.assignments.map(parseAssignment);
  if (new Set(assignments.map((item) => item.id)).size !== assignments.length) {
    throw new TypeError("Company assignment ids must be unique");
  }
  validateAcyclicAssignments(assignments);
  const parsed: CompanyGoalPlanV1 = {
    revision: contractInteger(plan.revision, "Company goal plan revision", 1),
    createdAt: contractTimestamp(plan.createdAt, "Company goal plan timestamp"),
    assignments,
  };
  return contractDeepFreeze(structuredClone(parsed)) as CompanyGoalPlanV1;
}

export function validateCompanyGoalPlanAgainstBlueprint(
  plan: CompanyGoalPlanV1,
  blueprint: CompanyBlueprintV2,
): void {
  const roles = new Map(blueprint.roles.map((role) => [role.id, role] as const));
  const assignments = new Map(plan.assignments.map((item) => [item.id, item] as const));
  for (const assignment of plan.assignments) {
    const role = roles.get(assignment.roleId);
    if (role === undefined || role.executionProfileId === null) {
      throw new TypeError("Company assignment role is not executable");
    }
    if (assignment.parentAssignmentId === null) continue;
    const parent = assignments.get(assignment.parentAssignmentId)!;
    const parentRole = roles.get(parent.roleId)!;
    if (!parentRole.delegatesTo.includes(role.id)) {
      throw new TypeError("Company assignment delegation is not approved");
    }
  }
}

export function parseCompanyGoalBudget(value: unknown): CompanyGoalBudgetV1 {
  const budget = contractRecord(value, "Company goal budget");
  contractExact(budget, [
    "maxAssignments", "assignmentsStarted", "maxConcurrentAssignments",
    "maxRequests", "requestsReserved", "requestsUsed", "maxReportedCostUsd",
    "reportedCostUsd",
  ], "Company goal budget");
  const parsed: CompanyGoalBudgetV1 = {
    maxAssignments: contractInteger(budget.maxAssignments, "Maximum assignments", 1),
    assignmentsStarted: contractInteger(
      budget.assignmentsStarted,
      "Assignments started",
      0,
    ),
    maxConcurrentAssignments: contractInteger(
      budget.maxConcurrentAssignments,
      "Maximum concurrent assignments",
      1,
    ),
    maxRequests: contractInteger(budget.maxRequests, "Maximum requests", 1),
    requestsReserved: contractInteger(
      budget.requestsReserved,
      "Reserved requests",
      0,
    ),
    requestsUsed: contractInteger(budget.requestsUsed, "Used requests", 0),
    maxReportedCostUsd: contractNumber(
      budget.maxReportedCostUsd,
      "Maximum reported cost",
      0,
    ),
    reportedCostUsd: contractNumber(
      budget.reportedCostUsd,
      "Reported cost",
      0,
    ),
  };
  if (parsed.assignmentsStarted > parsed.maxAssignments ||
    parsed.maxConcurrentAssignments > parsed.maxAssignments ||
    parsed.requestsUsed > parsed.requestsReserved ||
    parsed.requestsReserved > parsed.maxRequests) {
    throw new TypeError("Company goal budget usage exceeds its limits");
  }
  return contractDeepFreeze(parsed) as CompanyGoalBudgetV1;
}

export function reserveCompanyGoalBudget(
  budget: CompanyGoalBudgetV1,
  requestAllowance: number,
): CompanyGoalBudgetV1 {
  const allowance = contractInteger(requestAllowance, "Request allowance", 1);
  if (budget.assignmentsStarted >= budget.maxAssignments ||
    budget.requestsReserved + allowance > budget.maxRequests ||
    budget.reportedCostUsd >= budget.maxReportedCostUsd) {
    throw new RangeError("Company goal budget is exhausted");
  }
  return parseCompanyGoalBudget({
    ...budget,
    assignmentsStarted: budget.assignmentsStarted + 1,
    requestsReserved: budget.requestsReserved + allowance,
  });
}

export function parseCompanyGoalRun(value: unknown): CompanyGoalRunV1 {
  const run = contractRecord(value, "Company goal run");
  contractExact(run, [
    "id", "version", "parentSessionId", "goalId", "objective", "company",
    "status", "createdAt", "updatedAt", "plan", "budget", "result", "failure",
  ], "Company goal run");
  if (run.version !== 1) throw new TypeError("Company goal run version is invalid");
  const status = contractEnum<CompanyGoalStatus>(
    run.status,
    goalStatuses,
    "Company goal status",
  );
  let result: CompanyGoalRunV1["result"] = null;
  if (run.result !== null) {
    const record = contractRecord(run.result, "Company goal result");
    contractExact(record, ["summary", "evidence"], "Company goal result");
    result = {
      summary: contractText(record.summary, "Company goal summary", 16_384),
      evidence: contractTextArray(
        record.evidence,
        "Company goal evidence",
        128,
        2_000,
        false,
      ),
    };
  }
  const failure = contractOptionalText(run.failure, "Company goal failure", 4_000);
  const failed = status === "failed" || status === "cancelled";
  if ((status === "completed") !== (result !== null) || failed !== (failure !== null)) {
    throw new TypeError("Company goal terminal state is inconsistent");
  }
  const parsed: CompanyGoalRunV1 = {
    id: contractId(run.id, "Company goal run id"),
    version: 1,
    parentSessionId: contractId(run.parentSessionId, "Parent session id"),
    goalId: contractId(run.goalId, "Goal id"),
    objective: contractText(run.objective, "Company goal objective", 4_000),
    company: parseCompanyBlueprintBindingV2(run.company),
    status,
    createdAt: contractTimestamp(run.createdAt, "Company goal created timestamp"),
    updatedAt: contractTimestamp(run.updatedAt, "Company goal updated timestamp"),
    plan: parseCompanyGoalPlan(run.plan),
    budget: parseCompanyGoalBudget(run.budget),
    result,
    failure,
  };
  return contractDeepFreeze(structuredClone(parsed)) as CompanyGoalRunV1;
}
