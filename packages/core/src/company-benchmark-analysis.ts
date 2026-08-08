import type {
  CompanyBenchmarkCampaignV1,
  CompanyBenchmarkFailureAttributionV1,
  CompanyBenchmarkRouteV1,
  CompanyBenchmarkTrialV1,
} from "@recurs/contracts";

export const COMPANY_BENCHMARK_RECOMMENDATION_THRESHOLDS = Object.freeze({
  minimumRepetitionsPerFixture: 3,
  minimumRosterInformativePairs: 9,
  minimumMatchedParentInformativePairs: 9,
  minimumReviewActivatedTrials: 9,
  minimumRepairAttempts: 3,
  minimumRecoveredTrials: 2,
  maximumFalseApprovals: 0,
  maximumCompanyCompletionRateDeficit: 0.1,
});

export interface CompanyBenchmarkRecommendationObservations {
  readonly representativeFixtures: boolean;
  readonly durableCampaignsComplete: boolean;
  readonly informativePairs: number;
  readonly matchedParentInformativePairs: number;
  readonly baselineOnlyPassed: number;
  readonly companyOnlyPassed: number;
  readonly matchedBaselineOnlyPassed: number;
  readonly matchedCompanyOnlyPassed: number;
  readonly baselineCompletionRate: number | null;
  readonly companyCompletionRate: number | null;
  readonly reviewActivatedTrials: number;
  readonly repairAttempts: number;
  readonly recoveredTrials: number;
  readonly falseApprovals: number;
  readonly completeTokenCoverage: boolean;
  readonly completeCostCoverage: boolean;
}

export function evaluateCompanyBenchmarkRecommendation(
  input: CompanyBenchmarkRecommendationObservations,
) {
  const thresholds = COMPANY_BENCHMARK_RECOMMENDATION_THRESHOLDS;
  const checks = Object.freeze({
    representativeFixtures: input.representativeFixtures,
    durableCampaignsComplete: input.durableCampaignsComplete,
    rosterInformativePairs:
      input.informativePairs >= thresholds.minimumRosterInformativePairs,
    matchedParentInformativePairs: input.matchedParentInformativePairs >=
      thresholds.minimumMatchedParentInformativePairs,
    qualityNonInferiorityScreen:
      input.companyOnlyPassed >= input.baselineOnlyPassed,
    matchedQualityNonInferiorityScreen:
      input.matchedCompanyOnlyPassed >= input.matchedBaselineOnlyPassed,
    reliabilityFloor: input.baselineCompletionRate !== null &&
      input.companyCompletionRate !== null &&
      input.companyCompletionRate +
          thresholds.maximumCompanyCompletionRateDeficit >=
        input.baselineCompletionRate,
    reviewActivation: input.reviewActivatedTrials >=
      thresholds.minimumReviewActivatedTrials,
    repairRecovery: input.repairAttempts >= thresholds.minimumRepairAttempts &&
      input.recoveredTrials >= thresholds.minimumRecoveredTrials,
    falseApprovalFloor:
      input.falseApprovals <= thresholds.maximumFalseApprovals,
    completeTokenCoverage: input.completeTokenCoverage,
    completeCostCoverage: input.completeCostCoverage,
  });
  const endToEndRouteStatus = checks.representativeFixtures &&
      checks.durableCampaignsComplete &&
      checks.rosterInformativePairs &&
      checks.qualityNonInferiorityScreen &&
      checks.reliabilityFloor &&
      checks.reviewActivation &&
      checks.repairRecovery &&
      checks.falseApprovalFloor &&
      checks.completeTokenCoverage
    ? "thresholds_met_for_end_to_end_review" as const
    : "insufficient_evidence" as const;
  return Object.freeze({
    checks,
    endToEndRouteStatus,
    recommendationStatus:
      endToEndRouteStatus === "thresholds_met_for_end_to_end_review" &&
        checks.matchedParentInformativePairs &&
        checks.matchedQualityNonInferiorityScreen
        ? "thresholds_met_for_policy_review" as const
        : "insufficient_evidence" as const,
    workerAttributionStatus: checks.matchedParentInformativePairs
      ? "thresholds_met_for_worker_review" as const
      : "insufficient_matched_parent_evidence" as const,
    costRecommendationStatus: checks.completeCostCoverage
      ? "reported_cost_comparable" as const
      : "insufficient_reported_cost" as const,
  });
}

export interface CompanyBenchmarkArmAnalysis {
  readonly armId: string;
  readonly kind: "single_agent" | "company";
  readonly trials: number;
  readonly completed: number;
  readonly verifierPassed: number;
  readonly wallClockMs: number;
  readonly requests: number;
  readonly usageReports: number;
  readonly costReports: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly reportedCostUsd: number | null;
}

export interface CompanyBenchmarkCampaignAnalysis {
  readonly version: 1;
  readonly campaignId: string;
  readonly comparisonDesign:
    | "shared_parent_v1"
    | "independent_company_parent_v1";
  readonly parentComparison: "matched" | "unmatched" | "mixed";
  readonly comparisons: readonly CompanyBenchmarkArmComparison[];
  readonly arms: readonly CompanyBenchmarkArmAnalysis[];
  readonly attribution: CompanyBenchmarkFailureAttributionV1;
}

interface CompanyBenchmarkPairOutcomes {
  readonly bothPassed: number;
  readonly baselineOnlyPassed: number;
  readonly companyOnlyPassed: number;
  readonly bothFailed: number;
  readonly incomplete: number;
}
type MutablePairOutcomes = {
  -readonly [Key in keyof CompanyBenchmarkPairOutcomes]:
    CompanyBenchmarkPairOutcomes[Key];
};

export interface CompanyBenchmarkArmComparison {
  readonly armId: string;
  readonly parentComparison: "matched" | "unmatched";
  readonly reliabilityOutcomes: CompanyBenchmarkPairOutcomes;
  readonly rosterInformativeOutcomes: CompanyBenchmarkPairOutcomes;
  readonly excludedSharedParentBoundaryFailurePairs: number;
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

function passed(trial: CompanyBenchmarkTrialV1): boolean {
  return trial.executionStatus === "completed" &&
    trial.verification.status === "passed" &&
    trial.verification.workspaceIntegrity === "passed";
}

function optionalUsage(
  trials: readonly CompanyBenchmarkTrialV1[],
  key: "cachedInputTokens" | "reasoningTokens",
): number | null {
  if (trials.every((trial) => trial.usage.usageReports === 0) ||
    trials.some((trial) =>
      trial.usage.usageReports > 0 && trial.usage[key] === null
    )) return null;
  return trials.reduce((sum, trial) => sum + (trial.usage[key] ?? 0), 0);
}

function armAnalysis(
  armId: string,
  kind: "single_agent" | "company",
  trials: readonly CompanyBenchmarkTrialV1[],
): CompanyBenchmarkArmAnalysis {
  const selected = trials.filter((trial) => trial.armId === armId);
  const usageReports = selected.reduce(
    (sum, trial) => sum + trial.usage.usageReports,
    0,
  );
  const costReports = selected.reduce(
    (sum, trial) => sum + trial.usage.costReports,
    0,
  );
  return {
    armId,
    kind,
    trials: selected.length,
    completed: selected.filter((trial) =>
      trial.executionStatus === "completed"
    ).length,
    verifierPassed: selected.filter(passed).length,
    wallClockMs: selected.reduce((sum, trial) => sum + trial.wallClockMs, 0),
    requests: selected.reduce(
      (sum, trial) => sum + trial.usage.requestsUsed,
      0,
    ),
    usageReports,
    costReports,
    inputTokens: usageReports === 0
      ? null
      : selected.reduce(
          (sum, trial) => sum + (trial.usage.inputTokens ?? 0),
          0,
        ),
    outputTokens: usageReports === 0
      ? null
      : selected.reduce(
          (sum, trial) => sum + (trial.usage.outputTokens ?? 0),
          0,
        ),
    cachedInputTokens: optionalUsage(selected, "cachedInputTokens"),
    reasoningTokens: optionalUsage(selected, "reasoningTokens"),
    reportedCostUsd: costReports === 0
      ? null
      : selected.reduce(
          (sum, trial) => sum + (trial.usage.reportedCostUsd ?? 0),
          0,
        ),
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    if (!Object.isFrozen(value)) Object.freeze(value);
  }
  return value;
}

export function analyzeCompanyBenchmarkCampaign(input: {
  readonly campaign: CompanyBenchmarkCampaignV1;
  readonly trials: readonly CompanyBenchmarkTrialV1[];
  readonly attribution: CompanyBenchmarkFailureAttributionV1;
}): CompanyBenchmarkCampaignAnalysis {
  const baselineParent = input.campaign.baseline.configuredRoutes[0]!;
  const emptyOutcomes = (): MutablePairOutcomes => ({
    bothPassed: 0,
    baselineOnlyPassed: 0,
    companyOnlyPassed: 0,
    bothFailed: 0,
    incomplete: 0,
  });
  const record = (
    target: MutablePairOutcomes,
    baseline: CompanyBenchmarkTrialV1 | undefined,
    company: CompanyBenchmarkTrialV1 | undefined,
  ) => {
    if (baseline === undefined || company === undefined) {
      target.incomplete += 1;
    } else if (passed(baseline) && passed(company)) {
      target.bothPassed += 1;
    } else if (passed(baseline)) {
      target.baselineOnlyPassed += 1;
    } else if (passed(company)) {
      target.companyOnlyPassed += 1;
    } else {
      target.bothFailed += 1;
    }
  };
  const comparisons = input.campaign.companyArms.map((arm) => {
    const reliabilityOutcomes = emptyOutcomes();
    const rosterInformativeOutcomes = emptyOutcomes();
    let excludedSharedParentBoundaryFailurePairs = 0;
    for (
      let repetition = 1;
      repetition <= input.campaign.repetitions;
      repetition += 1
    ) {
      const baseline = input.trials.find((trial) =>
        trial.armId === input.campaign.baseline.id &&
        trial.repetition === repetition
      );
      const company = input.trials.find((trial) =>
        trial.armId === arm.id && trial.repetition === repetition
      );
      record(reliabilityOutcomes, baseline, company);
      const stratum = input.attribution.repetitions.find((item) =>
        item.repetition === repetition
      )?.classification;
      if (stratum === "shared_parent_boundary_failure") {
        excludedSharedParentBoundaryFailurePairs += 1;
      } else {
        record(rosterInformativeOutcomes, baseline, company);
      }
    }
    return Object.freeze({
      armId: arm.id,
      parentComparison: sameRoute(arm.configuredRoutes[0]!, baselineParent)
        ? "matched" as const
        : "unmatched" as const,
      reliabilityOutcomes: Object.freeze(reliabilityOutcomes),
      rosterInformativeOutcomes: Object.freeze(rosterInformativeOutcomes),
      excludedSharedParentBoundaryFailurePairs,
    });
  });
  const matchedParents = comparisons.filter((comparison) =>
    comparison.parentComparison === "matched"
  ).length;
  const parentComparison = matchedParents === comparisons.length
    ? "matched" as const
    : matchedParents === 0 ? "unmatched" as const : "mixed" as const;
  return deepFreeze({
    version: 1,
    campaignId: input.campaign.id,
    comparisonDesign: input.campaign.comparisonDesign ?? "shared_parent_v1",
    parentComparison,
    comparisons: Object.freeze(comparisons),
    arms: Object.freeze([
      armAnalysis(
        input.campaign.baseline.id,
        "single_agent",
        input.trials,
      ),
      ...input.campaign.companyArms.map((arm) =>
        armAnalysis(arm.id, "company", input.trials)
      ),
    ]),
    attribution: deepFreeze(structuredClone(input.attribution)),
  });
}
