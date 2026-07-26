import { describe, expect, it } from "vitest";

import {
  companyBenchmarkTrialSlotId,
  deriveCompanyBenchmarkSummaryEvidence,
  parseCompanyBenchmarkCampaign,
  parseCompanyBenchmarkCampaignSummary,
  parseCompanyBenchmarkSlotReservation,
  parseCompanyBenchmarkSlotSettlement,
  parseCompanyBenchmarkTrial,
  validateCompanyBenchmarkCampaignSummary,
  validateCompanyBenchmarkSlotSettlement,
  validateCompanyBenchmarkTrialAgainstCampaign,
  type CompanyBenchmarkRouteV1,
  type CompanyBenchmarkTrialV1,
} from "../src/index.js";

const AT = "2026-07-24T00:00:00.000Z";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function route(
  role: CompanyBenchmarkRouteV1["role"],
  connectionId = `connection-${role}`,
): CompanyBenchmarkRouteV1 {
  return {
    role,
    providerId: "openai-codex-chatgpt",
    adapterId: "codex-app-server",
    connectionId,
    modelId: role === "parent" ? "gpt-5.6-sol" : "gpt-5.6-terra",
    reasoningEffort: role === "parent" ? "high" : "medium",
  };
}

function lineup(suffix: string): readonly CompanyBenchmarkRouteV1[] {
  return [
    route("parent", "connection-parent"),
    route("implement", `connection-implement-${suffix}`),
    route("review", `connection-review-${suffix}`),
    route("repair", `connection-repair-${suffix}`),
  ];
}

function campaignValue() {
  const baselineId = "baseline-sol";
  const companyArmIds = ["company-balanced", "company-performance"];
  const order = [
    [baselineId, ...companyArmIds],
    [...companyArmIds].reverse().concat(baselineId),
    [baselineId, ...companyArmIds],
  ].flatMap((armIds, index) =>
    armIds.map((armId) => ({
      slotId: companyBenchmarkTrialSlotId(armId, index + 1),
      armId,
      repetition: index + 1,
    }))
  );
  return {
    id: "campaign-alpha",
    version: 1,
    createdAt: AT,
    scenario: {
      id: "typescript-path-normalization",
      version: 1,
      taskClass: "general_coding",
      difficulty: "small",
      fixtureSha256: SHA_A,
      verifierId: "typescript-path-normalization-verifier-v1",
      objectiveRevision: "typescript-path-normalization-objective-v1",
    },
    harnessRevision: "recurs-0-1-0-alpha-1",
    launchProtocolRevision: "company-benchmark-launch-v1",
    operatingModeId: "balanced_v6",
    operatingModeVersion: 6,
    permissionMode: "approved_for_me",
    repetitions: 3,
    ceilings: {
      maxTrialSlots: order.length,
      maxRequests: 600,
      maxReportedCostUsd: 30,
    },
    blueprint: {
      id: "blueprint-benchmark-v1",
      revision: 1,
      sha256: SHA_B,
    },
    baseline: {
      id: baselineId,
      kind: "single_agent",
      configuredRoutes: [route("parent", "connection-parent")],
    },
    companyArms: [{
      id: companyArmIds[0],
      kind: "company",
      configuredRoutes: lineup("balanced"),
    }, {
      id: companyArmIds[1],
      kind: "company",
      configuredRoutes: lineup("performance"),
    }],
    armOrder: order,
  };
}

function completeUsage(requestsUsed: number, cost = 0) {
  return {
    requestsUsed,
    usageReports: requestsUsed,
    costReports: requestsUsed,
    tokenCoverage: "complete",
    costCoverage: "complete",
    inputTokens: requestsUsed * 100,
    outputTokens: requestsUsed * 10,
    cachedInputTokens: 0,
    cacheWriteInputTokens: null,
    reasoningTokens: null,
    reportedCostUsd: cost,
  };
}

function trialValue(
  campaign: ReturnType<typeof campaignValue>,
  armId: string,
  repetition: number,
) {
  const baseline = armId === campaign.baseline.id;
  const arm = baseline
    ? campaign.baseline
    : campaign.companyArms.find((candidate) => candidate.id === armId)!;
  const activatedRoutes = baseline
    ? arm.configuredRoutes
    : arm.configuredRoutes.filter((candidate) => candidate.role !== "repair");
  const roles = activatedRoutes.map((candidate) => ({
    role: candidate.role,
    attempts: 1,
    completedAttempts: 1,
    failedAttempts: 0,
    cancelledAttempts: 0,
    wallClockMs: 1_000,
    attemptLatenciesMs: [1_000],
    usage: completeUsage(1, 0),
    evidenceItems: 1,
    changedFiles: candidate.role === "implement" ||
        baseline && candidate.role === "parent"
      ? ["src/normalize-path.ts"]
      : [],
  }));
  return {
    id: `trial-${armId}-${repetition}`,
    version: 1,
    campaignId: campaign.id,
    slotId: companyBenchmarkTrialSlotId(armId, repetition),
    armId,
    armKind: arm.kind,
    repetition,
    scenario: campaign.scenario,
    harnessRevision: campaign.harnessRevision,
    launchProtocolRevision: campaign.launchProtocolRevision,
    blueprint: baseline ? null : campaign.blueprint,
    configuredRoutes: arm.configuredRoutes,
    activatedRoutes,
    executionStatus: "completed",
    startedAt: "2026-07-24T00:01:00.000Z",
    completedAt: "2026-07-24T00:01:02.000Z",
    wallClockMs: 2_000,
    roles,
    usage: completeUsage(roles.length, 0),
    verification: {
      status: "passed",
      workspaceIntegrity: "passed",
      checks: [
        { id: "visible-tests", status: "passed" },
        { id: "hidden-edge-cases", status: "passed" },
      ],
    },
    review: {
      attempts: baseline ? 0 : 1,
      approved: baseline ? 0 : 1,
      changesRequested: 0,
      unverified: 0,
      finalVerdict: baseline ? null : "approved",
      findings: 0,
      affectedPaths: [],
      evidenceItems: baseline ? 0 : 1,
    },
    repairRounds: 0,
    interventions: {
      externalConfirmationRequests: 0,
      userInputRequests: 0,
      automaticApprovals: 2,
      automaticDenials: 0,
    },
    evidence: {
      roleItems: roles.length,
      finalItems: 2,
    },
    changedFiles: ["src/normalize-path.ts"],
    overlap: {
      metric: "changed_file_overlap_v1",
      implementOverlappingPaths: [],
      implementDuplicateClaims: 0,
      repairTouchedImplementationPaths: [],
    },
    failures: [],
  };
}

describe("company benchmark campaign contracts", () => {
  it("parses and freezes one baseline with bounded canonical company arms", () => {
    const parsed = parseCompanyBenchmarkCampaign(campaignValue());

    expect(parsed.companyArms).toHaveLength(2);
    expect(parsed.companyArms[0]?.configuredRoutes[0])
      .toEqual(parsed.baseline.configuredRoutes[0]);
    expect(parsed.armOrder.map((slot) => slot.armId)).toEqual([
      "baseline-sol",
      "company-balanced",
      "company-performance",
      "company-performance",
      "company-balanced",
      "baseline-sol",
      "baseline-sol",
      "company-balanced",
      "company-performance",
    ]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.companyArms[0]?.configuredRoutes)).toBe(true);
  });

  it("rejects route escalation, noncanonical slots, and campaign overreach", () => {
    const campaign = campaignValue();
    const mismatchedParent = structuredClone(campaign);
    mismatchedParent.companyArms[0]!.configuredRoutes[0] =
      route("parent", "different-parent");
    expect(() => parseCompanyBenchmarkCampaign(mismatchedParent)).toThrow(
      /parent route/u,
    );

    const wrongOrder = structuredClone(campaign);
    [wrongOrder.armOrder[0], wrongOrder.armOrder[1]] = [
      wrongOrder.armOrder[1]!,
      wrongOrder.armOrder[0]!,
    ];
    expect(() => parseCompanyBenchmarkCampaign(wrongOrder)).toThrow(
      /arm order/u,
    );

    const wrongCeiling = structuredClone(campaign);
    wrongCeiling.ceilings.maxTrialSlots -= 1;
    expect(() => parseCompanyBenchmarkCampaign(wrongCeiling)).toThrow(
      /trial-slot ceiling/u,
    );

    const wrongRouteOrder = structuredClone(campaign);
    [
      wrongRouteOrder.companyArms[0]!.configuredRoutes[1],
      wrongRouteOrder.companyArms[0]!.configuredRoutes[2],
    ] = [
      wrongRouteOrder.companyArms[0]!.configuredRoutes[2]!,
      wrongRouteOrder.companyArms[0]!.configuredRoutes[1]!,
    ];
    expect(() => parseCompanyBenchmarkCampaign(wrongRouteOrder)).toThrow(
      /configured route roles/u,
    );

    const tooMany = structuredClone(campaign);
    tooMany.companyArms.push({
      id: "company-extra-one",
      kind: "company",
      configuredRoutes: lineup("extra-one"),
    }, {
      id: "company-extra-two",
      kind: "company",
      configuredRoutes: lineup("extra-two"),
    });
    expect(() => parseCompanyBenchmarkCampaign(tooMany)).toThrow(
      /company arms/u,
    );

    expect(() => parseCompanyBenchmarkCampaign({
      ...campaign,
      winner: "company",
    })).toThrow(/exactly/u);
  });
});

describe("company benchmark trial contracts", () => {
  it("keeps configured and activated routes distinct and preserves unknown cost", () => {
    const campaign = parseCompanyBenchmarkCampaign(campaignValue());
    const raw = trialValue(campaignValue(), "company-balanced", 1);
    raw.usage = {
      ...raw.usage,
      costReports: 0,
      costCoverage: "none",
      reportedCostUsd: null,
    };
    for (const role of raw.roles) {
      role.usage = {
        ...role.usage,
        costReports: 0,
        costCoverage: "none",
        reportedCostUsd: null,
      };
    }
    const trial = parseCompanyBenchmarkTrial(raw);

    expect(trial.configuredRoutes.map((item) => item.role)).toEqual([
      "parent", "implement", "review", "repair",
    ]);
    expect(trial.activatedRoutes.map((item) => item.role)).toEqual([
      "parent", "implement", "review",
    ]);
    expect(trial.usage).toMatchObject({
      costCoverage: "none",
      reportedCostUsd: null,
    });
    expect(() =>
      validateCompanyBenchmarkTrialAgainstCampaign(trial, campaign)
    ).not.toThrow();
    expect(Object.isFrozen(trial.roles[0]?.attemptLatenciesMs)).toBe(true);
  });

  it("rejects impossible coverage, unsafe paths, latency errors, and fake activation", () => {
    const campaign = campaignValue();

    const impossibleCoverage = trialValue(campaign, "baseline-sol", 1);
    impossibleCoverage.usage.costCoverage = "none";
    expect(() => parseCompanyBenchmarkTrial(impossibleCoverage)).toThrow(
      /cost coverage/u,
    );

    const unsafePath = trialValue(campaign, "company-balanced", 1);
    unsafePath.changedFiles = ["../private.env"];
    expect(() => parseCompanyBenchmarkTrial(unsafePath)).toThrow(/path/u);

    const windowsPath = trialValue(campaign, "company-balanced", 1);
    windowsPath.changedFiles = ["C:/private.env"];
    expect(() => parseCompanyBenchmarkTrial(windowsPath)).toThrow(/path/u);

    const latency = trialValue(campaign, "company-balanced", 1);
    latency.wallClockMs = 1;
    expect(() => parseCompanyBenchmarkTrial(latency)).toThrow(/wall-clock/u);

    const activation = trialValue(campaign, "company-balanced", 1);
    activation.activatedRoutes[0] = route("parent", "invented-parent");
    expect(() => parseCompanyBenchmarkTrial(activation)).toThrow(
      /activated route/u,
    );
  });

  it("does not turn missing optional usage fields into zero", () => {
    const campaign = campaignValue();
    const raw = trialValue(campaign, "company-balanced", 1);
    raw.roles[0]!.usage.cachedInputTokens = null;
    raw.usage.cachedInputTokens = 0;
    expect(() => parseCompanyBenchmarkTrial(raw)).toThrow(
      /aggregate usage/u,
    );

    raw.usage.cachedInputTokens = null;
    expect(parseCompanyBenchmarkTrial(raw).usage.cachedInputTokens).toBeNull();
  });

  it("preserves partial usage coverage without inventing missing totals", () => {
    const raw = trialValue(campaignValue(), "baseline-sol", 1);
    raw.roles[0]!.usage = {
      ...raw.roles[0]!.usage,
      requestsUsed: 2,
      usageReports: 1,
      costReports: 1,
      tokenCoverage: "partial",
      costCoverage: "partial",
    };
    raw.usage = structuredClone(raw.roles[0]!.usage);

    expect(parseCompanyBenchmarkTrial(raw).usage).toMatchObject({
      requestsUsed: 2,
      usageReports: 1,
      costReports: 1,
      tokenCoverage: "partial",
      costCoverage: "partial",
    });
  });

  it("preserves a change request followed by successful repair and approval", () => {
    const campaign = campaignValue();
    const value = trialValue(campaign, "company-balanced", 1);
    value.activatedRoutes = value.configuredRoutes;
    const review = value.roles.find((role) => role.role === "review")!;
    Object.assign(review, {
      attempts: 3,
      completedAttempts: 3,
      attemptLatenciesMs: [350, 350, 300],
      usage: completeUsage(3, 0),
    });
    value.roles.push({
      role: "repair",
      attempts: 1,
      completedAttempts: 1,
      failedAttempts: 0,
      cancelledAttempts: 0,
      wallClockMs: 500,
      attemptLatenciesMs: [500],
      usage: completeUsage(1, 0),
      evidenceItems: 1,
      changedFiles: ["src/normalize-path.ts"],
    });
    value.usage = completeUsage(6, 0);
    value.review = {
      attempts: 2,
      approved: 1,
      changesRequested: 1,
      unverified: 0,
      finalVerdict: "approved",
      findings: 1,
      affectedPaths: ["src/normalize-path.ts"],
      evidenceItems: 2,
    };
    value.repairRounds = 1;
    value.evidence.roleItems = 4;
    value.overlap.repairTouchedImplementationPaths = [
      "src/normalize-path.ts",
    ];

    expect(parseCompanyBenchmarkTrial(value).review).toMatchObject({
      attempts: 2,
      approved: 1,
      changesRequested: 1,
      finalVerdict: "approved",
    });
  });

  it("fails closed when a trial is replayed under different campaign authority", () => {
    const trial = parseCompanyBenchmarkTrial(
      trialValue(campaignValue(), "company-balanced", 1),
    );
    const stale = parseCompanyBenchmarkCampaign({
      ...campaignValue(),
      harnessRevision: "recurs-different",
    });

    expect(() =>
      validateCompanyBenchmarkTrialAgainstCampaign(trial, stale)
    ).toThrow(/campaign authority/u);
  });
});

describe("company benchmark summary contracts", () => {
  it("accepts three exact comparable pairs per company arm without choosing a winner", () => {
    const campaign = parseCompanyBenchmarkCampaign(campaignValue());
    const trials: CompanyBenchmarkTrialV1[] = [];
    for (let repetition = 1; repetition <= 3; repetition += 1) {
      for (const armId of [
        campaign.baseline.id,
        ...campaign.companyArms.map((arm) => arm.id),
      ]) {
        trials.push(parseCompanyBenchmarkTrial(
          trialValue(campaignValue(), armId, repetition),
        ));
      }
    }
    const pairs = campaign.companyArms.flatMap((arm) =>
      [1, 2, 3].map((repetition) => ({
        companyArmId: arm.id,
        repetition,
        baselineTrialId: `trial-${campaign.baseline.id}-${repetition}`,
        companyTrialId: `trial-${arm.id}-${repetition}`,
      }))
    );
    const summary = parseCompanyBenchmarkCampaignSummary({
      id: "summary-campaign-alpha",
      version: 1,
      campaignId: campaign.id,
      createdAt: "2026-07-24T00:02:00.000Z",
      correctnessEligibility: "comparable",
      efficiencyEligibility: "comparable",
      tokenCoverage: "complete",
      costCoverage: "complete",
      completedTrialIds: trials.map((trial) => trial.id),
      comparablePairs: pairs,
      efficiencyComparablePairs: pairs,
      rationale: ["minimum_comparable_pairs_met"],
    });

    expect(() =>
      validateCompanyBenchmarkCampaignSummary(summary, campaign, trials)
    ).not.toThrow();
    expect("winner" in summary).toBe(false);
    expect(Object.isFrozen(summary.comparablePairs)).toBe(true);
  });

  it("keeps partial evidence insufficient and rejects incomplete comparable claims", () => {
    const campaign = parseCompanyBenchmarkCampaign(campaignValue());
    const baseline = parseCompanyBenchmarkTrial(
      trialValue(campaignValue(), "baseline-sol", 1),
    );
    const company = parseCompanyBenchmarkTrial(
      trialValue(campaignValue(), "company-balanced", 1),
    );
    const insufficient = parseCompanyBenchmarkCampaignSummary({
      id: "summary-campaign-alpha",
      version: 1,
      campaignId: campaign.id,
      createdAt: "2026-07-24T00:02:00.000Z",
      correctnessEligibility: "insufficient_evidence",
      efficiencyEligibility: "insufficient_evidence",
      tokenCoverage: "complete",
      costCoverage: "complete",
      completedTrialIds: [baseline.id, company.id],
      comparablePairs: [{
        companyArmId: "company-balanced",
        repetition: 1,
        baselineTrialId: baseline.id,
        companyTrialId: company.id,
      }],
      efficiencyComparablePairs: [{
        companyArmId: "company-balanced",
        repetition: 1,
        baselineTrialId: baseline.id,
        companyTrialId: company.id,
      }],
      rationale: [
        "minimum_comparable_pairs_not_met",
        "campaign_incomplete",
      ],
    });
    expect(() =>
      validateCompanyBenchmarkCampaignSummary(
        insufficient,
        campaign,
        [baseline, company],
      )
    ).not.toThrow();

    const overstated = {
      ...insufficient,
      correctnessEligibility: "comparable",
      rationale: ["minimum_comparable_pairs_met"],
    } as const;
    expect(() =>
      validateCompanyBenchmarkCampaignSummary(
        parseCompanyBenchmarkCampaignSummary(overstated),
        campaign,
        [baseline, company],
      )
    ).toThrow(/derivation/u);
  });

  it("derives not-run and usage coverage rationale exactly once", () => {
    const campaign = parseCompanyBenchmarkCampaign(campaignValue());
    const raw = trialValue(campaignValue(), "company-balanced", 1);
    raw.executionStatus = "failed";
    raw.verification = {
      status: "not_run",
      workspaceIntegrity: "not_run",
      checks: [],
    };
    raw.failures = [{ stage: "execution", code: "adapter_failed" }];
    raw.usage = {
      ...raw.usage,
      costReports: 0,
      costCoverage: "none",
      reportedCostUsd: null,
    };
    for (const role of raw.roles) {
      role.usage = {
        ...role.usage,
        costReports: 0,
        costCoverage: "none",
        reportedCostUsd: null,
      };
    }
    const trial = parseCompanyBenchmarkTrial(raw);
    const derived = deriveCompanyBenchmarkSummaryEvidence(campaign, [trial]);

    expect(derived).toMatchObject({
      correctnessEligibility: "insufficient_evidence",
      efficiencyEligibility: "insufficient_evidence",
      tokenCoverage: "complete",
      costCoverage: "none",
      rationale: [
        "minimum_comparable_pairs_not_met",
        "campaign_incomplete",
        "verification_not_run",
        "verification_or_safety_failed",
        "usage_incomplete",
      ],
    });
  });
});

describe("company benchmark slot-attempt contracts", () => {
  it("binds terminal settlements to immutable pre-call reservations", () => {
    const reservation = parseCompanyBenchmarkSlotReservation({
      id: "reservation-1",
      version: 1,
      campaignId: "campaign-alpha",
      slotId: "slot-alpha",
      attempt: 1,
      reservedAt: AT,
      requestAllowance: 4,
      reportedCostAllowanceUsd: 2,
    });
    const settlement = parseCompanyBenchmarkSlotSettlement({
      id: "settlement-1",
      version: 1,
      reservationId: reservation.id,
      campaignId: reservation.campaignId,
      slotId: reservation.slotId,
      status: "completed",
      settledAt: AT,
      trialId: "trial-1",
      requestsCharged: 2,
      reportedCostUsd: 1,
      costChargedUsd: 1,
      failureCode: null,
    });

    expect(() =>
      validateCompanyBenchmarkSlotSettlement(settlement, reservation)
    ).not.toThrow();
    expect(() =>
      validateCompanyBenchmarkSlotSettlement({
        ...settlement,
        requestsCharged: 5,
      }, reservation)
    ).toThrow(/reservation/u);
  });
});
