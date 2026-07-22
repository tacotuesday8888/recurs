import { isDeepStrictEqual } from "node:util";

import {
  parseCompanyOnboardingRun,
  type CompanyOnboardingRunV1,
} from "@recurs/contracts";

import {
  CompanyStateStoreError,
  PrivateJsonlStateStore,
  type SequencedCompanyState,
} from "./private-state-store.js";

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_RUNS = 256;
const terminalStatuses = new Set([
  "approved", "abandoned", "cancelled", "failed",
]);
const allowedStatus: Readonly<Record<
  CompanyOnboardingRunV1["status"],
  ReadonlySet<CompanyOnboardingRunV1["status"]>
>> = {
  interviewing: new Set([
    "interviewing", "researching", "proposed", "abandoned", "cancelled",
    "failed",
  ]),
  researching: new Set([
    "researching", "interviewing", "proposed", "abandoned", "cancelled",
    "failed",
  ]),
  proposed: new Set([
    "proposed", "approved", "abandoned", "cancelled", "failed",
  ]),
  approved: new Set(),
  abandoned: new Set(),
  cancelled: new Set(),
  failed: new Set(),
};
const allowedResearchStatus: Readonly<Record<
  CompanyOnboardingRunV1["research"][number]["status"],
  ReadonlySet<CompanyOnboardingRunV1["research"][number]["status"]>
>> = {
  queued: new Set(["queued", "running", "failed", "cancelled"]),
  running: new Set(["running", "completed", "failed", "cancelled"]),
  completed: new Set(["completed"]),
  failed: new Set(["failed"]),
  cancelled: new Set(["cancelled"]),
};

function timestampMs(value: string): number {
  return new Date(value).valueOf();
}

function prefixEqual<T>(previous: readonly T[], next: readonly T[]): boolean {
  return previous.length <= next.length && previous.every((value, index) =>
    isDeepStrictEqual(value, next[index])
  );
}

function validInterviewTransition(
  previous: CompanyOnboardingRunV1["interview"],
  next: CompanyOnboardingRunV1["interview"],
  nextStatus: CompanyOnboardingRunV1["status"],
): boolean {
  const pending = previous.pendingQuestion;
  if (pending === null) {
    return next.answers.length === previous.answers.length;
  }
  if (isDeepStrictEqual(pending, next.pendingQuestion)) {
    return next.answers.length === previous.answers.length;
  }
  if (next.pendingQuestion !== null) return false;
  if (terminalStatuses.has(nextStatus) &&
    next.answers.length === previous.answers.length) {
    return true;
  }
  const answer = next.answers.at(-1);
  return next.answers.length === previous.answers.length + 1 &&
    answer?.id === pending.id && answer.question === pending.question;
}

function validateTransition(
  previous: CompanyOnboardingRunV1,
  next: CompanyOnboardingRunV1,
): void {
  if (terminalStatuses.has(previous.status) ||
    !allowedStatus[previous.status].has(next.status)) {
    throw new CompanyStateStoreError(
      "conflict",
      "Company onboarding cannot transition from its current state",
    );
  }
  if (previous.id !== next.id || previous.version !== next.version ||
    previous.companyId !== next.companyId ||
    previous.projectRoot !== next.projectRoot || previous.createdAt !== next.createdAt ||
    previous.depth !== next.depth || previous.designMode !== next.designMode ||
    !isDeepStrictEqual(previous.authority, next.authority) ||
    !isDeepStrictEqual(previous.backend, next.backend) ||
    !isDeepStrictEqual(previous.repositoryAccess, next.repositoryAccess) ||
    timestampMs(next.updatedAt) < timestampMs(previous.updatedAt) ||
    next.usage.modelRequests < previous.usage.modelRequests ||
    next.usage.reportedCostUsd < previous.usage.reportedCostUsd ||
    !prefixEqual(previous.interview.answers, next.interview.answers) ||
    !validInterviewTransition(previous.interview, next.interview, next.status) ||
    previous.interview.complete && !next.interview.complete) {
    throw new CompanyStateStoreError(
      "conflict",
      "Company onboarding immutable or monotonic state changed",
    );
  }
  const nextResearch = new Map(next.research.map((item) => [item.id, item] as const));
  for (const assignment of previous.research) {
    const candidate = nextResearch.get(assignment.id);
    if (candidate === undefined || candidate.description !== assignment.description ||
      candidate.prompt !== assignment.prompt ||
      !allowedResearchStatus[assignment.status].has(candidate.status) ||
      ((assignment.status === "completed" || assignment.status === "failed" ||
        assignment.status === "cancelled") &&
        !isDeepStrictEqual(assignment, candidate))) {
      throw new CompanyStateStoreError(
        "conflict",
        "Company onboarding research history changed",
      );
    }
  }
  if (previous.proposal !== null && next.proposal !== null) {
    const delta = next.proposal.revision - previous.proposal.revision;
    if (delta < 0 || delta > 1 ||
      (delta === 0 && !isDeepStrictEqual(previous.proposal, next.proposal))) {
      throw new CompanyStateStoreError(
        "conflict",
        "Company proposal revision history changed",
      );
    }
  }
}

export class FileCompanyOnboardingStore {
  readonly #store: PrivateJsonlStateStore<CompanyOnboardingRunV1>;

  constructor(readonly directory: string) {
    this.#store = new PrivateJsonlStateStore(directory, {
      label: "Company onboarding run",
      maximumBytes: MAX_BYTES,
      maximumRecords: MAX_RUNS,
      parse: parseCompanyOnboardingRun,
      idOf: (run) => run.id,
      validateTransition,
    });
  }

  create(
    run: CompanyOnboardingRunV1,
    signal?: AbortSignal,
  ): Promise<SequencedCompanyState<CompanyOnboardingRunV1>> {
    return this.#store.create(run, signal);
  }

  append(
    id: string,
    expectedSequence: number,
    run: CompanyOnboardingRunV1,
    signal?: AbortSignal,
  ): Promise<SequencedCompanyState<CompanyOnboardingRunV1>> {
    return this.#store.append(id, expectedSequence, run, signal);
  }

  load(
    id: string,
    signal?: AbortSignal,
  ): Promise<SequencedCompanyState<CompanyOnboardingRunV1>> {
    return this.#store.load(id, signal);
  }

  list(
    signal?: AbortSignal,
  ): Promise<readonly SequencedCompanyState<CompanyOnboardingRunV1>[]> {
    return this.#store.list(signal);
  }
}
