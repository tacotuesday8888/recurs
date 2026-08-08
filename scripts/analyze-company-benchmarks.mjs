#!/usr/bin/env node

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

import {
  deriveCompanyBenchmarkFailureAttribution,
  validateCompanyBenchmarkCampaignSummary,
  validateCompanyBenchmarkSlotSettlement,
} from "../packages/contracts/dist/index.js";
import {
  analyzeCompanyBenchmarkCampaign,
  COMPANY_BENCHMARK_RECOMMENDATION_THRESHOLDS,
  evaluateCompanyBenchmarkRecommendation,
  FileCompanyBenchmarkCampaignStore,
  FileCompanyBenchmarkSlotReservationStore,
  FileCompanyBenchmarkSlotSettlementStore,
  FileCompanyBenchmarkSummaryStore,
  FileCompanyBenchmarkTrialStore,
} from "../packages/core/dist/index.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const REPRESENTATIVE_FIXTURES = Object.freeze([
  "alias_registry",
  "layered_config",
  "retry_after",
]);

function usage() {
  return [
    "Usage: node scripts/analyze-company-benchmarks.mjs --campaign <id> [--campaign <id> ...] [--recurs-home <path>]",
    "",
    "Read-only: analyzes immutable Company Proof campaigns without network access.",
  ].join("\n");
}

function parseArguments(argv) {
  const campaignIds = [];
  let dataDirectory = process.env.RECURS_HOME ?? path.join(homedir(), ".recurs");
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument !== "--campaign" && argument !== "--recurs-home") {
      throw new TypeError(usage());
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new TypeError(usage());
    }
    if (argument === "--campaign") {
      if (!SAFE_ID.test(value) || campaignIds.includes(value)) {
        throw new TypeError(usage());
      }
      campaignIds.push(value);
    } else {
      dataDirectory = path.resolve(value);
    }
    index += 1;
  }
  if (campaignIds.length === 0 || campaignIds.length > 32) {
    throw new TypeError(usage());
  }
  return { help: false, campaignIds, dataDirectory };
}

function stores(dataDirectory) {
  const root = path.join(dataDirectory, "evaluations", "company-proof-v1");
  return {
    campaigns: new FileCompanyBenchmarkCampaignStore(path.join(root, "campaigns")),
    trials: new FileCompanyBenchmarkTrialStore(path.join(root, "trials")),
    summaries: new FileCompanyBenchmarkSummaryStore(path.join(root, "summaries")),
    reservations: new FileCompanyBenchmarkSlotReservationStore(path.join(root, "reservations")),
    settlements: new FileCompanyBenchmarkSlotSettlementStore(path.join(root, "settlements")),
  };
}

function rate(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function recordId(prefix, ...parts) {
  const digest = createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 32);
  return `${prefix}_${digest}`;
}

function completedSettlementMatchesTrial(settlement, trial) {
  return settlement.status === "completed" &&
    settlement.trialId === trial.id &&
    settlement.requestsCharged === trial.usage.requestsUsed &&
    settlement.reportedCostUsd === trial.usage.reportedCostUsd &&
    settlement.costChargedUsd >= (trial.usage.reportedCostUsd ?? 0) &&
    Date.parse(settlement.settledAt) >= Date.parse(trial.completedAt);
}

async function analyze(parsed) {
  const state = stores(parsed.dataDirectory);
  let campaigns;
  try {
    campaigns = await Promise.all(parsed.campaignIds.map((id) =>
      state.campaigns.load(id)
    ));
  } catch {
    throw new Error("The selected benchmark campaign could not be read.");
  }
  const [allTrials, allSummaries, allReservations, allSettlements] =
    await Promise.all([
      state.trials.list(),
      state.summaries.list(),
      state.reservations.list(),
      state.settlements.list(),
    ]);
  const reports = campaigns.map((campaign) => {
    const trials = allTrials.filter((trial) => trial.campaignId === campaign.id);
    const summaries = allSummaries.filter((summary) =>
      summary.campaignId === campaign.id
    );
    const reservations = allReservations.filter((reservation) =>
      reservation.campaignId === campaign.id
    );
    const settlements = allSettlements.filter((settlement) =>
      settlement.campaignId === campaign.id
    );
    let durableAuthorityValid;
    let rawReliability;
    try {
      const reservationsBySlot = new Map(reservations.map((reservation) => [
        reservation.slotId,
        reservation,
      ]));
      const settlementsByReservation = new Map(settlements.map((settlement) => [
        settlement.reservationId,
        settlement,
      ]));
      durableAuthorityValid = reservations.length === campaign.armOrder.length &&
        settlements.length === campaign.armOrder.length &&
        trials.length <= campaign.armOrder.length &&
        reservationsBySlot.size === reservations.length &&
        settlementsByReservation.size === settlements.length &&
        campaign.armOrder.every((slot) => {
          const reservation = reservationsBySlot.get(slot.slotId);
          const settlement = reservation === undefined
            ? undefined
            : settlementsByReservation.get(reservation.id);
          const trial = trials.find((candidate) =>
            candidate.slotId === slot.slotId
          );
          if (reservation === undefined || settlement === undefined ||
            reservation.id !== recordId(
              "benchmark_reservation",
              campaign.id,
              slot.slotId,
            ) || settlement.id !== recordId(
              "benchmark_settlement",
              reservation.id,
            ) || Date.parse(reservation.reservedAt) <
              Date.parse(campaign.createdAt) ||
            reservation.requestAllowance > campaign.ceilings.maxRequests ||
            reservation.reportedCostAllowanceUsd >
              campaign.ceilings.maxReportedCostUsd) return false;
          validateCompanyBenchmarkSlotSettlement(settlement, reservation);
          return settlement.status === "completed"
            ? trial !== undefined &&
              completedSettlementMatchesTrial(settlement, trial)
            : trial === undefined;
        }) && new Set(trials.map((trial) => trial.slotId)).size === trials.length &&
        trials.every((trial) =>
          campaign.armOrder.some((slot) => slot.slotId === trial.slotId)
        ) && summaries.length === 1;
      if (durableAuthorityValid) {
        validateCompanyBenchmarkCampaignSummary(
          summaries[0],
          campaign,
          trials,
        );
      }
    } catch {
      durableAuthorityValid = false;
    }
    const trialBySlot = new Map(trials.map((trial) => [trial.slotId, trial]));
    const reservationBySlot = new Map(reservations.map((reservation) => [
      reservation.slotId,
      reservation,
    ]));
    const settlementByReservation = new Map(settlements.map((settlement) => [
      settlement.reservationId,
      settlement,
    ]));
    const reliabilityFor = (kind) => {
      const planned = campaign.armOrder.filter((slot) =>
        kind === "single_agent"
          ? slot.armId === campaign.baseline.id
          : slot.armId !== campaign.baseline.id
      );
      return {
        plannedSlots: planned.length,
        completedSlots: planned.filter((slot) => {
          const reservation = reservationBySlot.get(slot.slotId);
          const settlement = reservation === undefined
            ? undefined
            : settlementByReservation.get(reservation.id);
          const trial = trialBySlot.get(slot.slotId);
          return settlement?.status === "completed" && trial !== undefined &&
            settlement.trialId === trial.id;
        }).length,
      };
    };
    rawReliability = {
      baseline: reliabilityFor("single_agent"),
      company: reliabilityFor("company"),
    };
    return {
      campaign: {
        id: campaign.id,
        scenario: campaign.scenario,
        harnessRevision: campaign.harnessRevision,
        launchProtocolRevision: campaign.launchProtocolRevision,
        repetitions: campaign.repetitions,
        plannedSlots: campaign.armOrder.length,
      },
      durable: {
        trials: trials.length,
        reservations: reservations.length,
        settlements: settlements.length,
        completedSettlements: settlements.filter((settlement) =>
          settlement.status === "completed"
        ).length,
        failedSettlements: settlements.filter((settlement) =>
          settlement.status !== "completed"
        ).length,
        summaries: summaries.length,
        authorityValid: durableAuthorityValid,
        complete: trials.length === campaign.armOrder.length &&
          reservations.length === campaign.armOrder.length &&
          settlements.length === campaign.armOrder.length &&
          settlements.every((settlement) => settlement.status === "completed") &&
          summaries.length === 1 && durableAuthorityValid,
        rawReliability,
      },
      analysis: analyzeCompanyBenchmarkCampaign({
        campaign,
        trials,
        attribution: deriveCompanyBenchmarkFailureAttribution(campaign, trials),
      }),
      falseApprovals: trials.filter((trial) =>
        trial.armKind === "company" &&
        trial.review.finalVerdict === "approved" &&
        trial.verification.status !== "passed"
      ).length,
    };
  });
  const comparisonReports = reports.filter((report) => report.durable.complete);
  const scenarioRepetitions = Object.fromEntries(REPRESENTATIVE_FIXTURES.map(
    (scenarioId) => [
      scenarioId,
      Math.max(0, ...comparisonReports.filter((report) =>
        report.campaign.scenario.id === scenarioId
      ).map((report) => report.campaign.repetitions)),
    ],
  ));
  const comparisons = comparisonReports.flatMap((report) =>
    report.analysis.comparisons
  );
  const informativePairs = comparisons.reduce((sum, comparison) => {
    const outcomes = comparison.rosterInformativeOutcomes;
    return sum + outcomes.bothPassed + outcomes.baselineOnlyPassed +
      outcomes.companyOnlyPassed + outcomes.bothFailed;
  }, 0);
  const matchedParentInformativePairs = comparisons
    .filter((comparison) => comparison.parentComparison === "matched")
    .reduce((sum, comparison) => {
      const outcomes = comparison.rosterInformativeOutcomes;
      return sum + outcomes.bothPassed + outcomes.baselineOnlyPassed +
        outcomes.companyOnlyPassed + outcomes.bothFailed;
    }, 0);
  const matchedBaselineOnlyPassed = comparisons
    .filter((comparison) => comparison.parentComparison === "matched")
    .reduce((sum, comparison) =>
      sum + comparison.rosterInformativeOutcomes.baselineOnlyPassed, 0);
  const matchedCompanyOnlyPassed = comparisons
    .filter((comparison) => comparison.parentComparison === "matched")
    .reduce((sum, comparison) =>
      sum + comparison.rosterInformativeOutcomes.companyOnlyPassed, 0);
  const baselineOnlyPassed = comparisons.reduce(
    (sum, comparison) =>
      sum + comparison.rosterInformativeOutcomes.baselineOnlyPassed,
    0,
  );
  const companyOnlyPassed = comparisons.reduce(
    (sum, comparison) =>
      sum + comparison.rosterInformativeOutcomes.companyOnlyPassed,
    0,
  );
  const reviewActivatedTrials = comparisonReports.reduce(
    (sum, report) => sum + report.analysis.attribution.review.activatedTrials,
    0,
  );
  const repairAttempts = comparisonReports.reduce(
    (sum, report) => sum + report.analysis.attribution.repair.attempts,
    0,
  );
  const recoveredTrials = comparisonReports.reduce(
    (sum, report) => sum + report.analysis.attribution.repair.recoveredTrials,
    0,
  );
  const falseApprovals = comparisonReports.reduce(
    (sum, report) => sum + report.falseApprovals,
    0,
  );
  const armMetrics = comparisonReports.flatMap((report) =>
    report.analysis.arms
  );
  const rawReliability = {
    baseline: {
      plannedSlots: reports.reduce(
        (sum, report) => sum + report.durable.rawReliability.baseline.plannedSlots,
        0,
      ),
      completedSlots: reports.reduce(
        (sum, report) => sum + report.durable.rawReliability.baseline.completedSlots,
        0,
      ),
    },
    company: {
      plannedSlots: reports.reduce(
        (sum, report) => sum + report.durable.rawReliability.company.plannedSlots,
        0,
      ),
      completedSlots: reports.reduce(
        (sum, report) => sum + report.durable.rawReliability.company.completedSlots,
        0,
      ),
    },
  };
  const baselineCompletion = rate(
    rawReliability.baseline.completedSlots,
    rawReliability.baseline.plannedSlots,
  );
  const companyCompletion = rate(
    rawReliability.company.completedSlots,
    rawReliability.company.plannedSlots,
  );
  rawReliability.baseline.completionRate = baselineCompletion;
  rawReliability.company.completionRate = companyCompletion;
  const recommendation = evaluateCompanyBenchmarkRecommendation({
    representativeFixtures: REPRESENTATIVE_FIXTURES.every((scenarioId) =>
      scenarioRepetitions[scenarioId] >=
        COMPANY_BENCHMARK_RECOMMENDATION_THRESHOLDS
          .minimumRepetitionsPerFixture
    ),
    durableCampaignsComplete: reports.every((report) => report.durable.complete),
    informativePairs,
    matchedParentInformativePairs,
    baselineOnlyPassed,
    companyOnlyPassed,
    matchedBaselineOnlyPassed,
    matchedCompanyOnlyPassed,
    baselineCompletionRate: baselineCompletion,
    companyCompletionRate: companyCompletion,
    reviewActivatedTrials,
    repairAttempts,
    recoveredTrials,
    falseApprovals,
    completeTokenCoverage: armMetrics.length > 0 && armMetrics.every((arm) =>
      arm.usageReports === arm.requests
    ),
    completeCostCoverage: armMetrics.length > 0 && armMetrics.every((arm) =>
      arm.costReports === arm.requests
    ),
  });
  return {
    version: 1,
    thresholds: COMPANY_BENCHMARK_RECOMMENDATION_THRESHOLDS,
    representativeFixtures: REPRESENTATIVE_FIXTURES,
    observations: {
      scenarioRepetitions,
      informativePairs,
      matchedParentInformativePairs,
      baselineOnlyPassed,
      companyOnlyPassed,
      matchedBaselineOnlyPassed,
      matchedCompanyOnlyPassed,
      reviewActivatedTrials,
      repairAttempts,
      recoveredTrials,
      falseApprovals,
      rawReliability,
      baselineCompletionRate: baselineCompletion,
      companyCompletionRate: companyCompletion,
    },
    ...recommendation,
    campaigns: reports,
  };
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(await analyze(parsed), null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Benchmark evidence analysis failed."}\n`);
  process.exitCode = 1;
});
