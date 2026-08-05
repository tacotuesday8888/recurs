import {
  validateCompanyBenchmarkTrialAgainstCampaign,
  type CompanyBenchmarkCampaignV1,
  type CompanyBenchmarkRouteV1,
  type CompanyBenchmarkTrialV1,
} from "./company-benchmarks.js";
import { contractDeepFreeze } from "./company-contract-utils.js";

export type CompanyBenchmarkRepetitionClassificationV1 =
  | "shared_parent_boundary_failure"
  | "roster_informative"
  | "incomplete";

export interface CompanyBenchmarkRepetitionAttributionV1 {
  readonly repetition: number;
  readonly classification: CompanyBenchmarkRepetitionClassificationV1;
  readonly trialIds: readonly string[];
  readonly commonFailureCode: string | null;
}

export interface CompanyBenchmarkFailureAttributionV1 {
  readonly version: 1;
  readonly trialCounts: {
    readonly reliability: number;
    readonly rosterInformative: number;
    readonly sharedParentBoundaryFailure: number;
  };
  readonly reliabilityTrialIds: readonly string[];
  readonly rosterInformativeTrialIds: readonly string[];
  readonly repetitions: readonly CompanyBenchmarkRepetitionAttributionV1[];
  readonly review: {
    readonly companyTrials: number;
    readonly activatedTrials: number;
    readonly finalApprovals: number;
    readonly finalChangesRequested: number;
    readonly finalUnverified: number;
  };
  readonly repair: {
    readonly attemptedTrials: number;
    readonly attempts: number;
    readonly completedAttempts: number;
    readonly recoveredTrials: number;
  };
}

function sameRoute(
  left: CompanyBenchmarkRouteV1,
  right: CompanyBenchmarkRouteV1,
): boolean {
  return left.role === right.role &&
    left.providerId === right.providerId &&
    left.adapterId === right.adapterId &&
    left.connectionId === right.connectionId &&
    left.modelId === right.modelId &&
    left.reasoningEffort === right.reasoningEffort;
}

function sharedParentBoundaryFailureCode(
  trials: readonly CompanyBenchmarkTrialV1[],
): string | null {
  if (trials.some((trial) => {
    const parent = trial.roles[0];
    return trial.executionStatus !== "failed" ||
      trial.activatedRoutes.length !== 1 ||
      trial.activatedRoutes[0]?.role !== "parent" ||
      trial.roles.length !== 1 ||
      parent?.role !== "parent" ||
      parent.completedAttempts !== 0 ||
      parent.failedAttempts === 0 ||
      trial.usage.usageReports !== 0;
  })) return null;

  const parentRoute = trials[0]?.activatedRoutes[0];
  if (parentRoute === undefined || trials.some((trial) =>
    !sameRoute(trial.activatedRoutes[0]!, parentRoute)
  )) return null;

  const executionCodes = trials.map((trial) => trial.failures
    .filter((failure) => failure.stage === "execution")
    .map((failure) => failure.code));
  const code = executionCodes[0]?.[0];
  return code !== undefined && executionCodes.every((codes) =>
      codes.length === 1 && codes[0] === code
    )
    ? code
    : null;
}

/**
 * Derives analysis from immutable V1 trials without rewriting durable records.
 * Shared parent-boundary failures remain in reliability and are excluded only
 * from roster evidence when every arm records the same narrow failure shape.
 */
export function deriveCompanyBenchmarkFailureAttribution(
  campaign: CompanyBenchmarkCampaignV1,
  inputTrials: readonly CompanyBenchmarkTrialV1[],
): CompanyBenchmarkFailureAttributionV1 {
  for (const trial of inputTrials) {
    validateCompanyBenchmarkTrialAgainstCampaign(trial, campaign);
  }
  if (new Set(inputTrials.map((trial) => trial.slotId)).size !==
    inputTrials.length) {
    throw new TypeError("Company benchmark attribution has duplicate trials");
  }
  const order = new Map(campaign.armOrder.map((slot, index) => [
    slot.slotId,
    index,
  ] as const));
  const trials = [...inputTrials].sort((left, right) =>
    order.get(left.slotId)! - order.get(right.slotId)!
  );
  const expectedArmIds = new Set([
    campaign.baseline.id,
    ...campaign.companyArms.map((arm) => arm.id),
  ]);
  const rosterInformativeTrialIds: string[] = [];
  const sharedParentBoundaryFailureTrialIds: string[] = [];
  const repetitions: CompanyBenchmarkRepetitionAttributionV1[] = [];

  for (let repetition = 1; repetition <= campaign.repetitions; repetition += 1) {
    const current = trials.filter((trial) => trial.repetition === repetition);
    const complete = current.length === expectedArmIds.size &&
      current.every((trial) => expectedArmIds.has(trial.armId));
    const commonFailureCode = complete
      ? sharedParentBoundaryFailureCode(current)
      : null;
    const classification = !complete
      ? "incomplete" as const
      : commonFailureCode !== null
      ? "shared_parent_boundary_failure" as const
      : "roster_informative" as const;
    if (classification === "shared_parent_boundary_failure") {
      sharedParentBoundaryFailureTrialIds.push(
        ...current.map((trial) => trial.id),
      );
    } else if (classification === "roster_informative") {
      rosterInformativeTrialIds.push(...current.map((trial) => trial.id));
    }
    repetitions.push({
      repetition,
      classification,
      trialIds: current.map((trial) => trial.id),
      commonFailureCode,
    });
  }

  const companyTrials = trials.filter((trial) => trial.armKind === "company");
  const repairTrials = companyTrials.filter((trial) => trial.repairRounds > 0);
  const repairRoles = repairTrials.flatMap((trial) => trial.roles.filter(
    (role) => role.role === "repair",
  ));
  const attribution: CompanyBenchmarkFailureAttributionV1 = {
    version: 1,
    trialCounts: {
      reliability: trials.length,
      rosterInformative: rosterInformativeTrialIds.length,
      sharedParentBoundaryFailure:
        sharedParentBoundaryFailureTrialIds.length,
    },
    reliabilityTrialIds: trials.map((trial) => trial.id),
    rosterInformativeTrialIds,
    repetitions,
    review: {
      companyTrials: companyTrials.length,
      activatedTrials: companyTrials.filter((trial) =>
        trial.activatedRoutes.some((route) => route.role === "review")
      ).length,
      finalApprovals: companyTrials.filter((trial) =>
        trial.review.finalVerdict === "approved"
      ).length,
      finalChangesRequested: companyTrials.filter((trial) =>
        trial.review.finalVerdict === "changes_requested"
      ).length,
      finalUnverified: companyTrials.filter((trial) =>
        trial.review.finalVerdict === "unverified"
      ).length,
    },
    repair: {
      attemptedTrials: repairTrials.length,
      attempts: repairRoles.reduce((sum, role) => sum + role.attempts, 0),
      completedAttempts: repairRoles.reduce(
        (sum, role) => sum + role.completedAttempts,
        0,
      ),
      recoveredTrials: repairTrials.filter((trial) => {
        const repair = trial.roles.find((role) => role.role === "repair");
        return repair !== undefined &&
          repair.completedAttempts > 0 &&
          trial.review.changesRequested > 0 &&
          trial.executionStatus === "completed" &&
          trial.verification.status === "passed" &&
          trial.review.finalVerdict === "approved";
      }).length,
    },
  };
  return contractDeepFreeze(
    structuredClone(attribution),
  ) as CompanyBenchmarkFailureAttributionV1;
}
