import { isDeepStrictEqual } from "node:util";

import { parseCompanyGoalRun, type CompanyGoalRunV1 } from "@recurs/contracts";

import {
  CompanyStateStoreError,
  PrivateJsonlStateStore,
  type SequencedCompanyState,
} from "./private-state-store.js";

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_RUNS = 1_024;
const terminal = new Set(["completed", "failed", "cancelled"]);
const allowed: Readonly<Record<
  CompanyGoalRunV1["status"],
  ReadonlySet<CompanyGoalRunV1["status"]>
>> = {
  created: new Set(["running", "failed", "cancelled"]),
  running: new Set([
    "running", "waiting_for_approval", "completed", "failed", "cancelled",
    "interrupted",
  ]),
  waiting_for_approval: new Set([
    "running", "completed", "failed", "cancelled", "interrupted",
  ]),
  interrupted: new Set(["running", "failed", "cancelled"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};
const assignmentTransitions: Readonly<Record<
  CompanyGoalRunV1["plan"]["assignments"][number]["status"],
  ReadonlySet<CompanyGoalRunV1["plan"]["assignments"][number]["status"]>
>> = {
  pending: new Set(["pending", "running", "failed", "cancelled", "blocked"]),
  running: new Set(["running", "completed", "failed", "cancelled", "blocked"]),
  completed: new Set(["completed"]),
  failed: new Set(["failed"]),
  cancelled: new Set(["cancelled"]),
  blocked: new Set(["blocked"]),
};

function validateTransition(previous: CompanyGoalRunV1, next: CompanyGoalRunV1): void {
  if (terminal.has(previous.status) || !allowed[previous.status].has(next.status)) {
    throw new CompanyStateStoreError(
      "conflict",
      "Company goal cannot transition from its current state",
    );
  }
  if (previous.id !== next.id || previous.version !== next.version ||
    previous.parentSessionId !== next.parentSessionId ||
    previous.goalId !== next.goalId || previous.objective !== next.objective ||
    previous.createdAt !== next.createdAt ||
    !isDeepStrictEqual(previous.company, next.company) ||
    new Date(next.updatedAt).valueOf() < new Date(previous.updatedAt).valueOf() ||
    next.plan.revision < previous.plan.revision ||
    next.budget.maxAssignments !== previous.budget.maxAssignments ||
    next.budget.maxConcurrentAssignments !==
      previous.budget.maxConcurrentAssignments ||
    next.budget.maxRequests !== previous.budget.maxRequests ||
    next.budget.maxReportedCostUsd !== previous.budget.maxReportedCostUsd ||
    next.budget.assignmentsStarted < previous.budget.assignmentsStarted ||
    next.budget.requestsReserved < previous.budget.requestsReserved ||
    next.budget.requestsUsed < previous.budget.requestsUsed ||
    next.budget.reportedCostUsd < previous.budget.reportedCostUsd) {
    throw new CompanyStateStoreError(
      "conflict",
      "Company goal immutable or monotonic state changed",
    );
  }
  const nextAssignments = new Map(
    next.plan.assignments.map((assignment) => [assignment.id, assignment] as const),
  );
  for (const assignment of previous.plan.assignments) {
    const candidate = nextAssignments.get(assignment.id);
    if (candidate === undefined || candidate.roleId !== assignment.roleId ||
      candidate.parentAssignmentId !== assignment.parentAssignmentId ||
      !isDeepStrictEqual(candidate.dependsOn, assignment.dependsOn) ||
      candidate.description !== assignment.description ||
      candidate.prompt !== assignment.prompt ||
      !isDeepStrictEqual(candidate.acceptance, assignment.acceptance) ||
      !isDeepStrictEqual(candidate.expectedEvidence, assignment.expectedEvidence) ||
      !assignmentTransitions[assignment.status].has(candidate.status) ||
      ((assignment.status === "completed" || assignment.status === "failed" ||
        assignment.status === "cancelled" || assignment.status === "blocked") &&
        !isDeepStrictEqual(assignment, candidate))) {
      throw new CompanyStateStoreError(
        "conflict",
        "Company goal assignment history changed",
      );
    }
  }
}

export class JsonlCompanyGoalStore {
  readonly #store: PrivateJsonlStateStore<CompanyGoalRunV1>;

  constructor(readonly directory: string) {
    this.#store = new PrivateJsonlStateStore(directory, {
      label: "Company goal run",
      maximumBytes: MAX_BYTES,
      maximumRecords: MAX_RUNS,
      parse: parseCompanyGoalRun,
      idOf: (run) => run.id,
      validateTransition,
    });
  }

  create(
    run: CompanyGoalRunV1,
    signal?: AbortSignal,
  ): Promise<SequencedCompanyState<CompanyGoalRunV1>> {
    return this.#store.create(run, signal);
  }

  append(
    id: string,
    expectedSequence: number,
    run: CompanyGoalRunV1,
    signal?: AbortSignal,
  ): Promise<SequencedCompanyState<CompanyGoalRunV1>> {
    return this.#store.append(id, expectedSequence, run, signal);
  }

  load(
    id: string,
    signal?: AbortSignal,
  ): Promise<SequencedCompanyState<CompanyGoalRunV1>> {
    return this.#store.load(id, signal);
  }

  list(
    signal?: AbortSignal,
  ): Promise<readonly SequencedCompanyState<CompanyGoalRunV1>[]> {
    return this.#store.list(signal);
  }
}
