import { describe, expect, it } from "vitest";

import type {
  CompanyBenchmarkCampaignV1,
  CompanyBenchmarkFailureAttributionV1,
  CompanyBenchmarkRouteV1,
  CompanyBenchmarkTrialV1,
} from "@recurs/contracts";

import {
  analyzeCompanyBenchmarkCampaign,
  evaluateCompanyBenchmarkRecommendation,
} from "../src/company-benchmark-analysis.js";

function route(
  role: CompanyBenchmarkRouteV1["role"],
  modelId: string,
): CompanyBenchmarkRouteV1 {
  return {
    role,
    providerId: "openai-codex-chatgpt",
    adapterId: "codex-app-server",
    connectionId: `${modelId}-${role}`,
    modelId,
    reasoningEffort: "medium",
  };
}

function trial(input: {
  readonly armId: string;
  readonly kind: "single_agent" | "company";
  readonly repetition: number;
  readonly passed: boolean;
  readonly requests: number;
  readonly costUsd?: number;
}): CompanyBenchmarkTrialV1 {
  return {
    id: `trial-${input.armId}-${input.repetition}`,
    armId: input.armId,
    armKind: input.kind,
    repetition: input.repetition,
    executionStatus: input.passed ? "completed" : "failed",
    wallClockMs: input.repetition * 1_000,
    usage: {
      requestsUsed: input.requests,
      usageReports: input.requests,
      costReports: input.costUsd === undefined ? 0 : input.requests,
      tokenCoverage: "complete",
      costCoverage: input.costUsd === undefined ? "none" : "complete",
      inputTokens: input.requests * 100,
      outputTokens: input.requests * 10,
      cachedInputTokens: input.requests * 50,
      cacheWriteInputTokens: null,
      reasoningTokens: input.requests * 5,
      reportedCostUsd: input.costUsd ?? null,
    },
    verification: {
      status: input.passed ? "passed" : "failed",
      workspaceIntegrity: input.passed ? "passed" : "failed",
      checks: [],
    },
    review: {
      attempts: input.kind === "company" ? 1 : 0,
      approved: input.kind === "company" && input.passed ? 1 : 0,
      changesRequested: input.kind === "company" && !input.passed ? 1 : 0,
      unverified: 0,
      finalVerdict: input.kind === "company"
        ? input.passed ? "approved" : "changes_requested"
        : null,
      findings: input.kind === "company" && !input.passed ? 1 : 0,
      affectedPaths: input.kind === "company" && !input.passed
        ? ["src/config.js"]
        : [],
      evidenceItems: input.kind === "company" ? 1 : 0,
    },
    repairRounds: 0,
  } as CompanyBenchmarkTrialV1;
}

describe("company benchmark evidence analysis", () => {
  it("never promotes an end-to-end screen without matched-parent evidence", () => {
    const observations = {
      representativeFixtures: true,
      durableCampaignsComplete: true,
      informativePairs: 9,
      matchedParentInformativePairs: 0,
      baselineOnlyPassed: 1,
      companyOnlyPassed: 1,
      matchedBaselineOnlyPassed: 0,
      matchedCompanyOnlyPassed: 0,
      baselineCompletionRate: 1,
      companyCompletionRate: 1,
      reviewActivatedTrials: 9,
      repairAttempts: 3,
      recoveredTrials: 2,
      falseApprovals: 0,
      completeTokenCoverage: true,
      completeCostCoverage: false,
    };

    const unmatched = evaluateCompanyBenchmarkRecommendation(observations);
    const matched = evaluateCompanyBenchmarkRecommendation({
      ...observations,
      matchedParentInformativePairs: 9,
      matchedBaselineOnlyPassed: 1,
      matchedCompanyOnlyPassed: 1,
    });

    expect(unmatched.endToEndRouteStatus).toBe(
      "thresholds_met_for_end_to_end_review",
    );
    expect(unmatched.recommendationStatus).toBe("insufficient_evidence");
    expect(unmatched.workerAttributionStatus).toBe(
      "insufficient_matched_parent_evidence",
    );
    expect(unmatched.costRecommendationStatus).toBe(
      "insufficient_reported_cost",
    );
    expect(matched.recommendationStatus).toBe(
      "thresholds_met_for_policy_review",
    );
    expect(Object.hasOwn(matched, "winner")).toBe(false);

    const unmatchedDeltaCannotTipPolicy =
      evaluateCompanyBenchmarkRecommendation({
        ...observations,
        matchedParentInformativePairs: 9,
        baselineOnlyPassed: 1,
        companyOnlyPassed: 2,
        matchedBaselineOnlyPassed: 2,
        matchedCompanyOnlyPassed: 1,
      });
    expect(unmatchedDeltaCannotTipPolicy.endToEndRouteStatus).toBe(
      "thresholds_met_for_end_to_end_review",
    );
    expect(unmatchedDeltaCannotTipPolicy.recommendationStatus).toBe(
      "insufficient_evidence",
    );
  });

  it("treats an explicit independent label with the same parent as matched", () => {
    const parent = route("parent", "gpt-5.6-sol");
    const campaign = {
      id: "campaign-explicit-independent-same-parent",
      comparisonDesign: "independent_company_parent_v1",
      repetitions: 1,
      baseline: {
        id: "single-strong",
        kind: "single_agent",
        configuredRoutes: [parent],
      },
      companyArms: [{
        id: "company-auto",
        kind: "company",
        configuredRoutes: [
          parent,
          route("implement", "gpt-5.6-terra"),
          route("review", "gpt-5.6-luna"),
          route("repair", "gpt-5.6-terra"),
        ],
      }],
    } as CompanyBenchmarkCampaignV1;
    const attribution = {
      version: 1,
      trialCounts: {
        reliability: 0,
        rosterInformative: 0,
        sharedParentBoundaryFailure: 0,
      },
      reliabilityTrialIds: [],
      rosterInformativeTrialIds: [],
      repetitions: [{
        repetition: 1,
        classification: "incomplete",
        trialIds: [],
        commonFailureCode: null,
      }],
      review: {
        companyTrials: 0,
        activatedTrials: 0,
        finalApprovals: 0,
        finalChangesRequested: 0,
        finalUnverified: 0,
      },
      repair: {
        attemptedTrials: 0,
        attempts: 0,
        completedAttempts: 0,
        recoveredTrials: 0,
      },
    } satisfies CompanyBenchmarkFailureAttributionV1;

    const analysis = analyzeCompanyBenchmarkCampaign({
      campaign,
      trials: [],
      attribution,
    });

    expect(analysis.comparisonDesign).toBe(
      "independent_company_parent_v1",
    );
    expect(analysis.parentComparison).toBe("matched");
  });

  it("labels different parents as unmatched and keeps every co-failure in reliability", () => {
    const baselineId = "custom-baseline";
    const companyId = "company-auto";
    const campaign = {
      id: "campaign-independent",
      comparisonDesign: "independent_company_parent_v1",
      repetitions: 3,
      baseline: {
        id: baselineId,
        kind: "single_agent",
        configuredRoutes: [route("parent", "gpt-5.6-sol")],
      },
      companyArms: [{
        id: companyId,
        kind: "company",
        configuredRoutes: [
          route("parent", "gpt-5.6-terra"),
          route("implement", "gpt-5.6-terra"),
          route("review", "gpt-5.6-luna"),
          route("repair", "gpt-5.6-terra"),
        ],
      }],
    } as CompanyBenchmarkCampaignV1;
    const trials = [
      trial({ armId: baselineId, kind: "single_agent", repetition: 1, passed: true, requests: 1 }),
      trial({ armId: companyId, kind: "company", repetition: 1, passed: false, requests: 3 }),
      trial({ armId: baselineId, kind: "single_agent", repetition: 2, passed: false, requests: 1 }),
      trial({ armId: companyId, kind: "company", repetition: 2, passed: false, requests: 2 }),
      trial({ armId: baselineId, kind: "single_agent", repetition: 3, passed: false, requests: 1 }),
      trial({ armId: companyId, kind: "company", repetition: 3, passed: true, requests: 3 }),
    ];
    const attribution = {
      version: 1,
      trialCounts: {
        reliability: 6,
        rosterInformative: 6,
        sharedParentBoundaryFailure: 0,
      },
      reliabilityTrialIds: trials.map((item) => item.id),
      rosterInformativeTrialIds: trials.map((item) => item.id),
      repetitions: [1, 2, 3].map((repetition) => ({
        repetition,
        classification: "roster_informative" as const,
        trialIds: trials.filter((item) => item.repetition === repetition)
          .map((item) => item.id),
        commonFailureCode: null,
      })),
      review: {
        companyTrials: 3,
        activatedTrials: 3,
        finalApprovals: 1,
        finalChangesRequested: 2,
        finalUnverified: 0,
      },
      repair: {
        attemptedTrials: 0,
        attempts: 0,
        completedAttempts: 0,
        recoveredTrials: 0,
      },
    } satisfies CompanyBenchmarkFailureAttributionV1;

    const analysis = analyzeCompanyBenchmarkCampaign({
      campaign,
      trials,
      attribution,
    });

    expect(analysis.parentComparison).toBe("unmatched");
    expect(analysis.comparisons[0]?.rosterInformativeOutcomes).toEqual({
      bothPassed: 0,
      baselineOnlyPassed: 1,
      companyOnlyPassed: 1,
      bothFailed: 1,
      incomplete: 0,
    });
    expect(analysis.comparisons[0]?.reliabilityOutcomes).toEqual(
      analysis.comparisons[0]?.rosterInformativeOutcomes,
    );
    expect(analysis.comparisons[0]?.excludedSharedParentBoundaryFailurePairs)
      .toBe(0);
    expect(analysis.attribution.trialCounts).toEqual({
      reliability: 6,
      rosterInformative: 6,
      sharedParentBoundaryFailure: 0,
    });
    expect(Object.isFrozen(analysis.attribution)).toBe(true);
    expect(Object.isFrozen(analysis.arms[0])).toBe(true);
    Reflect.set(attribution.trialCounts, "reliability", 0);
    expect(analysis.attribution.trialCounts.reliability).toBe(6);
    expect(analysis.arms).toEqual([
      expect.objectContaining({
        armId: baselineId,
        kind: "single_agent",
        requests: 3,
        inputTokens: 300,
        cachedInputTokens: 150,
        reportedCostUsd: null,
        costReports: 0,
      }),
      expect.objectContaining({
        armId: companyId,
        kind: "company",
        requests: 8,
        inputTokens: 800,
        cachedInputTokens: 400,
        reportedCostUsd: null,
        costReports: 0,
      }),
    ]);
  });

  it("excludes an aggregate same-parent outage only from roster outcomes", () => {
    const parent = route("parent", "gpt-5.6-sol");
    const campaign = {
      id: "campaign-shared",
      repetitions: 1,
      baseline: {
        id: "single-strong",
        kind: "single_agent",
        configuredRoutes: [parent],
      },
      companyArms: [{
        id: "company-auto",
        kind: "company",
        configuredRoutes: [
          parent,
          route("implement", "gpt-5.6-terra"),
          route("review", "gpt-5.6-luna"),
          route("repair", "gpt-5.6-terra"),
        ],
      }],
    } as CompanyBenchmarkCampaignV1;
    const trials = [
      trial({ armId: "single-strong", kind: "single_agent", repetition: 1, passed: false, requests: 1 }),
      trial({ armId: "company-auto", kind: "company", repetition: 1, passed: false, requests: 1 }),
    ];
    const attribution = {
      version: 1,
      trialCounts: {
        reliability: 2,
        rosterInformative: 0,
        sharedParentBoundaryFailure: 2,
      },
      reliabilityTrialIds: trials.map((item) => item.id),
      rosterInformativeTrialIds: [],
      repetitions: [{
        repetition: 1,
        classification: "shared_parent_boundary_failure",
        trialIds: trials.map((item) => item.id),
        commonFailureCode: "coordinated_runtime_failed",
      }],
      review: {
        companyTrials: 1,
        activatedTrials: 0,
        finalApprovals: 0,
        finalChangesRequested: 0,
        finalUnverified: 0,
      },
      repair: {
        attemptedTrials: 0,
        attempts: 0,
        completedAttempts: 0,
        recoveredTrials: 0,
      },
    } satisfies CompanyBenchmarkFailureAttributionV1;

    const analysis = analyzeCompanyBenchmarkCampaign({
      campaign,
      trials,
      attribution,
    });

    expect(analysis.parentComparison).toBe("matched");
    expect(analysis.comparisons[0]?.reliabilityOutcomes.bothFailed).toBe(1);
    expect(analysis.comparisons[0]?.rosterInformativeOutcomes).toEqual({
      bothPassed: 0,
      baselineOnlyPassed: 0,
      companyOnlyPassed: 0,
      bothFailed: 0,
      incomplete: 0,
    });
    expect(analysis.comparisons[0]?.excludedSharedParentBoundaryFailurePairs)
      .toBe(1);
  });

  it("keeps matched and unmatched company-arm outcomes in separate buckets", () => {
    const baselineParent = route("parent", "gpt-5.6-sol");
    const campaign = {
      id: "campaign-mixed-parents",
      comparisonDesign: "independent_company_parent_v1",
      repetitions: 1,
      baseline: {
        id: "single-strong",
        kind: "single_agent",
        configuredRoutes: [baselineParent],
      },
      companyArms: [{
        id: "company-auto",
        kind: "company",
        configuredRoutes: [
          route("parent", "gpt-5.6-terra"),
          route("implement", "gpt-5.6-terra"),
          route("review", "gpt-5.6-luna"),
          route("repair", "gpt-5.6-terra"),
        ],
      }, {
        id: "company-strong",
        kind: "company",
        configuredRoutes: [
          baselineParent,
          route("implement", "gpt-5.6-sol"),
          route("review", "gpt-5.6-sol"),
          route("repair", "gpt-5.6-sol"),
        ],
      }],
    } as CompanyBenchmarkCampaignV1;
    const trials = [
      trial({ armId: "single-strong", kind: "single_agent", repetition: 1, passed: true, requests: 1 }),
      trial({ armId: "company-auto", kind: "company", repetition: 1, passed: false, requests: 3 }),
      trial({ armId: "company-strong", kind: "company", repetition: 1, passed: true, requests: 3 }),
    ];
    const attribution = {
      version: 1,
      trialCounts: {
        reliability: 3,
        rosterInformative: 3,
        sharedParentBoundaryFailure: 0,
      },
      reliabilityTrialIds: trials.map((item) => item.id),
      rosterInformativeTrialIds: trials.map((item) => item.id),
      repetitions: [{
        repetition: 1,
        classification: "roster_informative",
        trialIds: trials.map((item) => item.id),
        commonFailureCode: null,
      }],
      review: {
        companyTrials: 2,
        activatedTrials: 2,
        finalApprovals: 1,
        finalChangesRequested: 1,
        finalUnverified: 0,
      },
      repair: {
        attemptedTrials: 0,
        attempts: 0,
        completedAttempts: 0,
        recoveredTrials: 0,
      },
    } satisfies CompanyBenchmarkFailureAttributionV1;

    const analysis = analyzeCompanyBenchmarkCampaign({
      campaign,
      trials,
      attribution,
    });

    expect(analysis.parentComparison).toBe("mixed");
    expect(analysis.comparisons).toEqual([
      expect.objectContaining({
        armId: "company-auto",
        parentComparison: "unmatched",
        rosterInformativeOutcomes: expect.objectContaining({
          baselineOnlyPassed: 1,
        }),
      }),
      expect.objectContaining({
        armId: "company-strong",
        parentComparison: "matched",
        rosterInformativeOutcomes: expect.objectContaining({
          bothPassed: 1,
        }),
      }),
    ]);
  });
});
