import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  parseCompanyGoalRun,
  parseCompanyBlueprintBindingV2,
  parseTeamControlPolicyV1,
  parseTeamControlRecommendationV1,
  recommendedTeamControlPolicy,
  type CompanyGoalRun,
  type CompanyBlueprintBindingV2,
  type TeamControlPolicyV1,
  type TeamControlRecommendationRunV1,
  type TeamControlRecommendationV1,
} from "@recurs/contracts";

import type { FileTeamControlPolicyStore } from "./file-team-control-policy-store.js";
import type {
  FileTeamControlRecommendationStore,
} from "./file-team-control-recommendation-store.js";
import { withPrivateStateMutationLock } from "./private-state-store.js";

export type TeamControlAdaptationErrorCode =
  | "invalid_input"
  | "stale_base"
  | "already_decided"
  | "corrupt_state";

export class TeamControlAdaptationError extends Error {
  constructor(
    public readonly code: TeamControlAdaptationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TeamControlAdaptationError";
  }
}

interface RecommendationDecisionInput {
  readonly workspace: string;
  readonly recommendationId: string;
  readonly company: CompanyBlueprintBindingV2;
  readonly at: string;
  readonly decisionReason: string;
  readonly signal?: AbortSignal;
}

export interface TeamControlAdaptationDependencies {
  readonly policies: Pick<FileTeamControlPolicyStore, "latest" | "publish">;
  readonly recommendations: Pick<
    FileTeamControlRecommendationStore,
    "directory" | "create" | "decide" | "load" | "list"
  >;
  readonly runs: {
    list(signal?: AbortSignal): Promise<readonly (
      CompanyGoalRun | { readonly state: CompanyGoalRun }
    )[]>;
  };
  readonly createId?: () => string;
}

const numericLimits = Object.freeze([
  "maxActiveAgents",
  "maxConcurrentAgents",
  "maxDelegationDepth",
  "maxRepairRounds",
  "maxRequests",
  "maxReportedCostUsd",
] as const);

function assertNarrower(
  base: TeamControlPolicyV1,
  proposed: TeamControlPolicyV1,
  baseRevision: number | null = base.revision,
): void {
  if (base.operatingModeId !== proposed.operatingModeId ||
    base.operatingModeVersion !== proposed.operatingModeVersion ||
    proposed.revision !== (baseRevision ?? 0) + 1 ||
    numericLimits.some((key) => proposed[key] > base[key]) ||
    (base.escalation === "manager_only" &&
      proposed.escalation !== "manager_only") ||
    (base.independentReview === "required" &&
      proposed.independentReview !== "required")) {
    throw new TeamControlAdaptationError(
      "invalid_input",
      "A team-control recommendation may not widen authority or limits",
    );
  }
  const sameValues = proposed.topology === base.topology &&
    proposed.escalation === base.escalation &&
    proposed.independentReview === base.independentReview &&
    numericLimits.every((key) => proposed[key] === base[key]);
  if (sameValues) {
    throw new TeamControlAdaptationError(
      "invalid_input",
      "A team-control recommendation must change a future preference",
    );
  }
}

function costKnown(run: CompanyGoalRun): boolean {
  return run.plan.assignments.every((assignment) =>
    assignment.result !== null &&
    assignment.result.usageSource !== "unknown" &&
    assignment.result.usage?.costUsd !== undefined
  );
}

function evidence(run: CompanyGoalRun): TeamControlRecommendationRunV1 {
  return {
    runId: run.id,
    completedAt: run.updatedAt,
    assignmentsStarted: run.budget.assignmentsStarted,
    requestsUsed: run.budget.requestsUsed,
    reportedCostUsd: costKnown(run) ? run.budget.reportedCostUsd : null,
  };
}

function proposedPolicy(
  base: TeamControlPolicyV1,
  baseRevision: number | null,
  runs: readonly CompanyGoalRun[],
): TeamControlPolicyV1 | null {
  const maxAssignments = Math.max(...runs.map((run) =>
    run.budget.assignmentsStarted
  ));
  const maxRequests = Math.max(...runs.map((run) => run.budget.requestsUsed));
  const activeLimit = Math.min(
    base.maxActiveAgents,
    Math.max(base.maxConcurrentAgents, maxAssignments),
  );
  const requestLimit = Math.min(
    base.maxRequests,
    Math.max(1, maxRequests + 1, Math.ceil(maxRequests * 1.25)),
  );
  const knownCosts = runs.every(costKnown);
  const maximumCost = Math.max(...runs.map((run) => run.budget.reportedCostUsd));
  const costLimit = knownCosts && maximumCost > 0
    ? Math.min(
        base.maxReportedCostUsd,
        Math.ceil(maximumCost * 1.25 * 10_000) / 10_000,
      )
    : base.maxReportedCostUsd;
  const proposed = parseTeamControlPolicyV1({
    ...base,
    revision: (baseRevision ?? 0) + 1,
    maxActiveAgents: activeLimit,
    maxReportedCostUsd: costLimit,
    maxRequests: requestLimit,
  });
  try {
    assertNarrower(base, proposed, baseRevision);
  } catch (error) {
    if (error instanceof TeamControlAdaptationError &&
      error.message.includes("must change")) return null;
    throw error;
  }
  return proposed;
}

function sameRunEvidence(
  left: readonly TeamControlRecommendationRunV1[],
  right: readonly TeamControlRecommendationRunV1[],
): boolean {
  return isDeepStrictEqual(
    left.map((run) => run.runId),
    right.map((run) => run.runId),
  );
}

function lockId(workspace: string): string {
  return `adaptation_${createHash("sha256").update(workspace).digest("hex")}`;
}

export class TeamControlAdaptationService {
  readonly #createId: () => string;

  constructor(readonly dependencies: TeamControlAdaptationDependencies) {
    this.#createId = dependencies.createId ?? randomUUID;
  }

  async recommendCompletedGoal(input: {
    readonly workspace: string;
    readonly run: CompanyGoalRun;
    readonly at: string;
    readonly signal?: AbortSignal;
  }): Promise<TeamControlRecommendationV1 | null> {
    const currentRun = parseCompanyGoalRun(input.run);
    if (currentRun.version !== 2 || currentRun.status !== "completed") {
      return null;
    }
    const saved = await this.dependencies.policies.latest(
      input.workspace,
      input.signal,
    );
    const base = saved ?? currentRun.teamControl.selected;
    if (saved !== null && !isDeepStrictEqual(
      saved,
      currentRun.teamControl.selected,
    )) {
      return null;
    }
    const compatible = (await this.dependencies.runs.list(input.signal))
      .map((record) =>
        parseCompanyGoalRun("state" in record ? record.state : record)
      )
      .filter((run): run is Extract<CompanyGoalRun, { version: 2 }> =>
        run.version === 2 && run.status === "completed" &&
        run.company.blueprintId === currentRun.company.blueprintId &&
        run.company.blueprintRevision === currentRun.company.blueprintRevision &&
        isDeepStrictEqual(run.teamControl.selected, base)
      )
      .sort((left, right) =>
        Date.parse(left.updatedAt) - Date.parse(right.updatedAt)
      )
      .slice(-8);
    if (compatible.length < 2) return null;
    const proposed = proposedPolicy(base, saved?.revision ?? null, compatible);
    if (proposed === null) return null;
    const supportingRuns = compatible.map(evidence);
    const recommendations = await this.dependencies.recommendations.list(
      input.workspace,
      input.signal,
    );
    const pending = recommendations.find((item) =>
      item.state === "proposed" &&
      item.basePolicyRevision === (saved?.revision ?? null) &&
      item.blueprintId === currentRun.company.blueprintId &&
      item.blueprintRevision === currentRun.company.blueprintRevision
    );
    if (pending !== undefined) return pending;
    const existing = recommendations.find((item) =>
      item.basePolicyRevision === (saved?.revision ?? null) &&
      item.blueprintId === currentRun.company.blueprintId &&
      item.blueprintRevision === currentRun.company.blueprintRevision &&
      isDeepStrictEqual(item.proposedPolicy, proposed) &&
      sameRunEvidence(item.supportingRuns, supportingRuns)
    );
    if (existing !== undefined) return existing;
    const recommendation = parseTeamControlRecommendationV1({
      id: this.#createId(),
      version: 1,
      state: "proposed",
      operatingModeId: base.operatingModeId,
      operatingModeVersion: base.operatingModeVersion,
      blueprintId: currentRun.company.blueprintId,
      blueprintRevision: currentRun.company.blueprintRevision,
      basePolicyRevision: saved?.revision ?? null,
      createdAt: input.at,
      decidedAt: null,
      reason: [
        `Observed usage only across ${compatible.length} compatible completed goals.`,
        `Peak usage was ${Math.max(...compatible.map((run) => run.budget.assignmentsStarted))} activated agents and ${Math.max(...compatible.map((run) => run.budget.requestsUsed))} requests.`,
        "No comparative quality claim is made; review the limits before applying them to future goals.",
      ].join(" "),
      supportingRuns,
      proposedPolicy: proposed,
      appliedPolicyRevision: null,
      decisionReason: null,
    });
    await this.dependencies.recommendations.create(
      input.workspace,
      recommendation,
      input.signal,
    );
    return await this.dependencies.recommendations.load(
      input.workspace,
      recommendation.id,
      input.signal,
    );
  }

  async approve(
    input: RecommendationDecisionInput,
  ): Promise<TeamControlRecommendationV1> {
    return await withPrivateStateMutationLock(
      path.join(this.dependencies.recommendations.directory, ".authority"),
      lockId(input.workspace),
      async () => {
        const recommendation = await this.dependencies.recommendations.load(
          input.workspace,
          input.recommendationId,
          input.signal,
        );
        const company = parseCompanyBlueprintBindingV2(input.company);
        if (recommendation.blueprintId !== company.blueprintId ||
          recommendation.blueprintRevision !== company.blueprintRevision) {
          throw new TeamControlAdaptationError(
            "stale_base",
            "The team-control recommendation targets another company revision",
          );
        }
        if (recommendation.state === "rejected") {
          throw new TeamControlAdaptationError(
            "already_decided",
            "The team-control recommendation was already rejected",
          );
        }
        const current = await this.dependencies.policies.latest(
          input.workspace,
          input.signal,
        );
        if (recommendation.state === "approved") {
          if (!isDeepStrictEqual(current, recommendation.proposedPolicy)) {
            throw new TeamControlAdaptationError(
              "corrupt_state",
              "The approved team-control recommendation is not active",
            );
          }
          return recommendation;
        }
        const base = current ?? recommendedTeamControlPolicy(
          recommendation.operatingModeId,
        );
        if ((current?.revision ?? null) !== recommendation.basePolicyRevision) {
          if (!isDeepStrictEqual(current, recommendation.proposedPolicy)) {
            throw new TeamControlAdaptationError(
              "stale_base",
              "The team-control recommendation base revision is stale",
            );
          }
        } else {
          assertNarrower(
            base,
            recommendation.proposedPolicy,
            recommendation.basePolicyRevision,
          );
          await this.dependencies.policies.publish(
            input.workspace,
            recommendation.proposedPolicy,
            recommendation.basePolicyRevision,
            input.signal,
          );
        }
        const decision = parseTeamControlRecommendationV1({
          ...recommendation,
          state: "approved",
          decidedAt: input.at,
          appliedPolicyRevision: recommendation.proposedPolicy.revision,
          decisionReason: input.decisionReason,
        });
        await this.dependencies.recommendations.decide(
          input.workspace,
          decision,
          input.signal,
        );
        return await this.dependencies.recommendations.load(
          input.workspace,
          recommendation.id,
          input.signal,
        );
      },
      input.signal,
    );
  }

  async reject(
    input: RecommendationDecisionInput,
  ): Promise<TeamControlRecommendationV1> {
    return await withPrivateStateMutationLock(
      path.join(this.dependencies.recommendations.directory, ".authority"),
      lockId(input.workspace),
      async () => {
        const recommendation = await this.dependencies.recommendations.load(
          input.workspace,
          input.recommendationId,
          input.signal,
        );
        const company = parseCompanyBlueprintBindingV2(input.company);
        if (recommendation.blueprintId !== company.blueprintId ||
          recommendation.blueprintRevision !== company.blueprintRevision) {
          throw new TeamControlAdaptationError(
            "stale_base",
            "The team-control recommendation targets another company revision",
          );
        }
        if (recommendation.state === "approved") {
          throw new TeamControlAdaptationError(
            "already_decided",
            "The team-control recommendation was already approved",
          );
        }
        if (recommendation.state === "rejected") return recommendation;
        const decision = parseTeamControlRecommendationV1({
          ...recommendation,
          state: "rejected",
          decidedAt: input.at,
          appliedPolicyRevision: null,
          decisionReason: input.decisionReason,
        });
        await this.dependencies.recommendations.decide(
          input.workspace,
          decision,
          input.signal,
        );
        return await this.dependencies.recommendations.load(
          input.workspace,
          recommendation.id,
          input.signal,
        );
      },
      input.signal,
    );
  }
}
