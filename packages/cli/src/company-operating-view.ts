import type {
  CompanyBlueprintV2,
  CompanyGoalAssignmentV1,
  CompanyGoalRunV1,
} from "@recurs/contracts";

const ACTIVE_GOAL_STATUSES = new Set<CompanyGoalRunV1["status"]>([
  "created",
  "running",
  "waiting_for_approval",
  "interrupted",
]);
const TERMINAL_CONTROL = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;

function oneLine(value: string, maximum = 240): string {
  const safe = value.replace(TERMINAL_CONTROL, " ").replace(/\s+/gu, " ").trim();
  if (safe.length <= maximum) return safe;
  return `${safe.slice(0, Math.max(0, maximum - 1)).trimEnd()}…`;
}

function roles(blueprint: CompanyBlueprintV2): ReadonlyMap<string, string> {
  return new Map(blueprint.roles.map((role) => [
    role.id,
    oneLine(role.displayName, 100),
  ]));
}

function roleName(names: ReadonlyMap<string, string>, roleId: string): string {
  return names.get(roleId) ?? `Unknown role (${oneLine(roleId, 128)})`;
}

function progress(run: CompanyGoalRunV1): string {
  const total = run.plan.assignments.length;
  const count = (status: CompanyGoalAssignmentV1["status"]): number =>
    run.plan.assignments.filter((assignment) => assignment.status === status).length;
  const stopped = count("failed") + count("cancelled") + count("blocked");
  return [
    `Progress: ${count("completed")}/${total} completed`,
    `${count("running")} running`,
    `${count("pending")} pending`,
    `${stopped} failed/blocked`,
  ].join(" | ");
}

function accounting(run: CompanyGoalRunV1): readonly string[] {
  const unknownUsage = run.plan.assignments.filter((assignment) =>
    assignment.result?.usageSource === "unknown"
  ).length;
  return [
    `Budget: assignments ${run.budget.assignmentsStarted}/${run.budget.maxAssignments} | concurrency ${run.budget.maxConcurrentAssignments} max`,
    `Requests: ${run.budget.requestsUsed} used | ${run.budget.requestsReserved} reserved | ${run.budget.maxRequests} max`,
    `Reported cost: $${run.budget.reportedCostUsd.toFixed(4)} / $${run.budget.maxReportedCostUsd.toFixed(4)}${unknownUsage === 0 ? "" : ` | ${unknownUsage} completed assignment(s) with unknown usage`}`,
  ];
}

function execution(assignment: CompanyGoalAssignmentV1): string {
  const value = assignment.execution;
  if (value === undefined) return "not started";
  if ("teamRunId" in value) {
    return `team ${value.teamRunId} | ${value.teamRole}${
      value.taskIndex === null ? "" : ` task ${value.taskIndex}`
    }`;
  }
  return `child ${value.childSessionId} | task ${value.taskId}`;
}

function usage(assignment: CompanyGoalAssignmentV1): string {
  const result = assignment.result;
  if (result === null) return "not available";
  if (result.usage === null || result.usageSource === "unknown") return "unknown";
  const cost = result.usage.costUsd === undefined
    ? "reported cost unavailable"
    : `$${result.usage.costUsd.toFixed(4)}`;
  return `${result.usage.inputTokens} in / ${result.usage.outputTokens} out / ${cost}`;
}

function assignmentLines(
  assignment: CompanyGoalAssignmentV1,
  names: ReadonlyMap<string, string>,
): readonly string[] {
  const relationship = assignment.parentAssignmentId === null
    ? "top-level"
    : `parent ${assignment.parentAssignmentId}`;
  const dependencies = assignment.dependsOn.length === 0
    ? "no dependencies"
    : `depends on ${assignment.dependsOn.join(", ")}`;
  const lines = [
    `- ${assignment.status} | ${roleName(names, assignment.roleId)} | ${assignment.id} | ${relationship} | ${dependencies} | ${execution(assignment)}`,
    `  Work: ${oneLine(assignment.description)}`,
  ];
  if (assignment.result !== null) {
    lines.push(
      `  Evidence: ${assignment.result.evidence.length} item${assignment.result.evidence.length === 1 ? "" : "s"} | Usage: ${usage(assignment)}`,
      `  Summary: ${oneLine(assignment.result.summary, 500)}`,
    );
  }
  if (assignment.failure !== null) {
    lines.push(`  Failure: ${oneLine(assignment.failure, 500)}`);
  }
  return lines;
}

function dependenciesSatisfied(
  assignment: CompanyGoalAssignmentV1,
  assignments: ReadonlyMap<string, CompanyGoalAssignmentV1>,
): boolean {
  if (assignment.parentAssignmentId !== null &&
    assignments.get(assignment.parentAssignmentId)?.status !== "completed") {
    return false;
  }
  return assignment.dependsOn.every((id) =>
    assignments.get(id)?.status === "completed"
  );
}

function nextState(run: CompanyGoalRunV1): string {
  if (run.status === "completed") {
    return `The goal completed with ${run.result?.evidence.length ?? 0} final evidence item(s).`;
  }
  if (run.status === "failed") {
    return `The goal failed; no agent is assumed active.${
      run.failure === null ? "" : ` ${oneLine(run.failure, 500)}`
    }`;
  }
  if (run.status === "cancelled") {
    return `The goal was cancelled; no agent is assumed active.${
      run.failure === null ? "" : ` ${oneLine(run.failure, 500)}`
    }`;
  }
  if (run.status === "interrupted") {
    return "The goal is interrupted; no agent is assumed to still be running.";
  }
  if (run.status === "waiting_for_approval") {
    return "The goal is waiting for explicit approval; no additional work is assumed to progress.";
  }
  if (run.status === "created") {
    return "The goal is created; execution has not started.";
  }
  const running = run.plan.assignments.filter((assignment) =>
    assignment.status === "running"
  ).length;
  if (running > 0) {
    return `${running} assignment${running === 1 ? " is" : "s are"} running; no additional role is implied active.`;
  }
  const byId = new Map(run.plan.assignments.map((assignment) => [
    assignment.id,
    assignment,
  ]));
  const pending = run.plan.assignments.filter((assignment) =>
    assignment.status === "pending"
  );
  const ready = pending.filter((assignment) => dependenciesSatisfied(assignment, byId));
  return ready.length === 0
    ? "No pending assignment has satisfied dependencies; durable state may need recovery."
    : `${ready.length} pending assignment(s) have satisfied dependencies.`;
}

function sortedRuns(runs: readonly CompanyGoalRunV1[]): readonly CompanyGoalRunV1[] {
  return [...runs].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)
  ).slice(0, 20);
}

function activeRoleNames(
  blueprint: CompanyBlueprintV2,
  runs: readonly CompanyGoalRunV1[],
): readonly string[] {
  const names = roles(blueprint);
  return [...new Set(runs.flatMap((run) =>
    ACTIVE_GOAL_STATUSES.has(run.status)
      ? run.plan.assignments.filter((assignment) =>
          assignment.status === "running"
        ).map((assignment) => roleName(names, assignment.roleId))
      : []
  ))].sort((left, right) => left.localeCompare(right));
}

export function renderCompanyOperations(
  blueprint: CompanyBlueprintV2,
  values: readonly CompanyGoalRunV1[],
): string {
  const runs = sortedRuns(values);
  const count = (status: CompanyGoalRunV1["status"]): number =>
    runs.filter((run) => run.status === status).length;
  const active = runs.filter((run) => ACTIVE_GOAL_STATUSES.has(run.status)).length;
  const activeRoles = activeRoleNames(blueprint, runs);
  const lines = [
    "Company operations",
    `Company: ${oneLine(blueprint.companyId, 128)} | Blueprint: ${oneLine(blueprint.id, 128)} r${blueprint.revision}`,
    `Goals: ${runs.length} total | ${active} active | ${count("completed")} completed | ${count("failed")} failed | ${count("cancelled")} cancelled`,
    `Active roles: ${activeRoles.length === 0 ? "none" : activeRoles.join(", ")}`,
  ];
  if (runs.length === 0) {
    lines.push("No company goal runs exist for this session and blueprint.");
    return lines.join("\n");
  }
  const current = runs.find((run) => ACTIVE_GOAL_STATUSES.has(run.status)) ?? runs[0]!;
  lines.push(
    `Current: ${current.status} | ${current.id} | ${oneLine(current.objective, 300)} | ${current.updatedAt}`,
    progress(current),
    ...accounting(current),
    `Next: ${nextState(current)}`,
    "Recent goals:",
    ...runs.map((run) =>
      `- ${run.status} | ${run.id} | ${oneLine(run.objective, 180)} | ${run.updatedAt}`
    ),
  );
  return lines.join("\n");
}

export function renderCompanyGoalRun(
  blueprint: CompanyBlueprintV2,
  run: CompanyGoalRunV1,
): string {
  const names = roles(blueprint);
  const lines = [
    `Goal: ${run.id} | ${run.status}`,
    `Objective: ${oneLine(run.objective, 500)}`,
    `Company: ${oneLine(blueprint.companyId, 128)} | Blueprint: ${oneLine(blueprint.id, 128)} r${blueprint.revision}`,
    `Created: ${run.createdAt} | Updated: ${run.updatedAt}`,
    progress(run),
    ...accounting(run),
    "Assignments:",
    ...run.plan.assignments.flatMap((assignment) =>
      assignmentLines(assignment, names)
    ),
  ];
  if (run.result === null) {
    lines.push("Result: not available");
  } else {
    lines.push(
      `Result: ${oneLine(run.result.summary, 1_000)}`,
      `Final evidence: ${run.result.evidence.length} item(s)`,
    );
  }
  if (run.failure !== null) lines.push(`Failure: ${oneLine(run.failure, 1_000)}`);
  lines.push(`Next: ${nextState(run)}`);
  return lines.join("\n");
}
