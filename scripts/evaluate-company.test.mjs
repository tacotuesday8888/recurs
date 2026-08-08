import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { promisify } from "node:util";

import {
  companyBenchmarkTrialSlotId,
  parseCompanyBenchmarkCampaign,
  parseCompanyBenchmarkSlotReservation,
  parseCompanyBenchmarkSlotSettlement,
  parseCompanyBenchmarkTrial,
} from "../packages/contracts/dist/index.js";
import {
  createCompanyBenchmarkSummary,
  FileCompanyBenchmarkCampaignStore,
  FileCompanyBenchmarkSlotReservationStore,
  FileCompanyBenchmarkSlotSettlementStore,
  FileCompanyBenchmarkSummaryStore,
  FileCompanyBenchmarkTrialStore,
} from "../packages/core/dist/index.js";

const execute = promisify(execFile);
const script = path.resolve("scripts/evaluate-company.mjs");
const benchmarkScript = path.resolve(
  "scripts/analyze-company-benchmarks.mjs",
);

function benchmarkRoute(role) {
  return {
    role,
    providerId: "scripted",
    adapterId: "scripted",
    connectionId: `connection-${role}`,
    modelId: role === "parent" ? "strong-parent" : "bounded-worker",
    reasoningEffort: role === "parent" ? "high" : "medium",
  };
}

function benchmarkRecordId(prefix, ...parts) {
  const digest = createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 32);
  return `${prefix}_${digest}`;
}

function benchmarkCampaign({ id, repetitions, compareAllStrong = false }) {
  const baselineId = "custom-baseline";
  const companyIds = compareAllStrong
    ? ["company-auto", "company-strong"]
    : ["company-auto"];
  const armOrder = Array.from({ length: repetitions }, (_, index) => {
    const repetition = index + 1;
    const ids = repetition % 2 === 1
      ? [baselineId, ...companyIds]
      : [...companyIds].reverse().concat(baselineId);
    return ids.map((armId) => ({
      slotId: companyBenchmarkTrialSlotId(armId, repetition),
      armId,
      repetition,
    }));
  }).flat();
  return parseCompanyBenchmarkCampaign({
    id,
    version: 1,
    createdAt: "2026-08-01T00:00:00.000Z",
    scenario: {
      id: "alias_registry",
      version: 1,
      taskClass: "general_coding",
      difficulty: "medium",
      fixtureSha256: "a".repeat(64),
      verifierId: "alias_registry_hidden_v1",
      objectiveRevision: "alias_registry_objective_v1",
    },
    harnessRevision: "recurs-test",
    launchProtocolRevision: "company-benchmark-launch-v1",
    operatingModeId: "balanced_v6",
    operatingModeVersion: 6,
    permissionMode: "approved_for_me",
    repetitions,
    ceilings: {
      maxTrialSlots: armOrder.length,
      maxRequests: armOrder.length * 8,
      maxReportedCostUsd: armOrder.length,
    },
    blueprint: {
      id: "benchmark-blueprint",
      revision: 1,
      sha256: "b".repeat(64),
    },
    baseline: {
      id: baselineId,
      kind: "single_agent",
      configuredRoutes: [benchmarkRoute("parent")],
    },
    companyArms: companyIds.map((armId) => ({
      id: armId,
      kind: "company",
      configuredRoutes: [
        benchmarkRoute("parent"),
        benchmarkRoute("implement"),
        benchmarkRoute("review"),
        benchmarkRoute("repair"),
      ],
    })),
    armOrder,
  });
}

function benchmarkTrial(campaign, slot) {
  const baseline = slot.armId === campaign.baseline.id;
  const arm = baseline
    ? campaign.baseline
    : campaign.companyArms.find((candidate) => candidate.id === slot.armId);
  const activatedRoutes = baseline
    ? arm.configuredRoutes
    : arm.configuredRoutes.filter((candidate) => candidate.role !== "repair");
  const usage = {
    requestsUsed: activatedRoutes.length,
    usageReports: activatedRoutes.length,
    costReports: 0,
    tokenCoverage: "complete",
    costCoverage: "none",
    inputTokens: activatedRoutes.length * 100,
    outputTokens: activatedRoutes.length * 10,
    cachedInputTokens: activatedRoutes.length * 50,
    cacheWriteInputTokens: null,
    reasoningTokens: activatedRoutes.length * 5,
    reportedCostUsd: null,
  };
  return parseCompanyBenchmarkTrial({
    id: `trial-${slot.slotId}`,
    version: 1,
    campaignId: campaign.id,
    slotId: slot.slotId,
    armId: slot.armId,
    armKind: arm.kind,
    repetition: slot.repetition,
    scenario: campaign.scenario,
    harnessRevision: campaign.harnessRevision,
    launchProtocolRevision: campaign.launchProtocolRevision,
    blueprint: baseline ? null : campaign.blueprint,
    configuredRoutes: arm.configuredRoutes,
    activatedRoutes,
    executionStatus: "completed",
    startedAt: "2026-08-01T00:01:00.000Z",
    completedAt: "2026-08-01T00:02:00.000Z",
    wallClockMs: 60_000,
    roles: activatedRoutes.map((route) => ({
      role: route.role,
      attempts: 1,
      completedAttempts: 1,
      failedAttempts: 0,
      cancelledAttempts: 0,
      wallClockMs: 1_000,
      attemptLatenciesMs: [1_000],
      usage: {
        ...usage,
        requestsUsed: 1,
        usageReports: 1,
        inputTokens: 100,
        outputTokens: 10,
        cachedInputTokens: 50,
        reasoningTokens: 5,
      },
      evidenceItems: 1,
      changedFiles: route.role === "parent" || route.role === "implement"
        ? ["src/alias-path.js", "src/alias-registry.js"]
        : [],
    })),
    usage,
    verification: {
      status: "passed",
      workspaceIntegrity: "passed",
      checks: [{ id: "hidden_behavior", status: "passed" }],
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
      automaticApprovals: 1,
      automaticDenials: 0,
    },
    evidence: { roleItems: activatedRoutes.length, finalItems: 1 },
    changedFiles: ["src/alias-path.js", "src/alias-registry.js"],
    overlap: {
      metric: "changed_file_overlap_v1",
      implementOverlappingPaths: [],
      implementDuplicateClaims: 0,
      repairTouchedImplementationPaths: [],
    },
    failures: [],
  });
}

function benchmarkFailedTrial(campaign, slot) {
  const arm = slot.armId === campaign.baseline.id
    ? campaign.baseline
    : campaign.companyArms.find((candidate) => candidate.id === slot.armId);
  const activatedRoutes = [arm.configuredRoutes[0]];
  const emptyUsage = {
    requestsUsed: 1,
    usageReports: 0,
    costReports: 0,
    tokenCoverage: "none",
    costCoverage: "none",
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    reasoningTokens: null,
    reportedCostUsd: null,
  };
  return parseCompanyBenchmarkTrial({
    id: `trial-${slot.slotId}`,
    version: 1,
    campaignId: campaign.id,
    slotId: slot.slotId,
    armId: slot.armId,
    armKind: arm.kind,
    repetition: slot.repetition,
    scenario: campaign.scenario,
    harnessRevision: campaign.harnessRevision,
    launchProtocolRevision: campaign.launchProtocolRevision,
    blueprint: arm.kind === "company" ? campaign.blueprint : null,
    configuredRoutes: arm.configuredRoutes,
    activatedRoutes,
    executionStatus: "failed",
    startedAt: "2026-08-01T00:01:00.000Z",
    completedAt: "2026-08-01T00:02:00.000Z",
    wallClockMs: 60_000,
    roles: [{
      role: "parent",
      attempts: 1,
      completedAttempts: 0,
      failedAttempts: 1,
      cancelledAttempts: 0,
      wallClockMs: 60_000,
      attemptLatenciesMs: [60_000],
      usage: emptyUsage,
      evidenceItems: 0,
      changedFiles: [],
    }],
    usage: emptyUsage,
    verification: {
      status: "failed",
      workspaceIntegrity: "failed",
      checks: [{ id: "hidden_behavior", status: "failed" }],
    },
    review: {
      attempts: 0,
      approved: 0,
      changesRequested: 0,
      unverified: 0,
      finalVerdict: null,
      findings: 0,
      affectedPaths: [],
      evidenceItems: 0,
    },
    repairRounds: 0,
    interventions: {
      externalConfirmationRequests: 0,
      userInputRequests: 0,
      automaticApprovals: 0,
      automaticDenials: 0,
    },
    evidence: { roleItems: 0, finalItems: 0 },
    changedFiles: [],
    overlap: {
      metric: "changed_file_overlap_v1",
      implementOverlappingPaths: [],
      implementDuplicateClaims: 0,
      repairTouchedImplementationPaths: [],
    },
    failures: [{
      stage: "execution",
      code: "coordinated_runtime_failed",
      scope: "runtime_execution",
      terminalStage: "parent",
    }],
  });
}

async function writeBenchmarkAuthority(
  dataDirectory,
  campaign,
  terminalFailedSlotIds = [],
  failedTrialSlotIds = [],
  settlementRequestDelta = 0,
) {
  const root = path.join(dataDirectory, "evaluations", "company-proof-v1");
  const campaigns = new FileCompanyBenchmarkCampaignStore(path.join(root, "campaigns"));
  const trials = new FileCompanyBenchmarkTrialStore(path.join(root, "trials"));
  const summaries = new FileCompanyBenchmarkSummaryStore(path.join(root, "summaries"));
  const reservations = new FileCompanyBenchmarkSlotReservationStore(path.join(root, "reservations"));
  const settlements = new FileCompanyBenchmarkSlotSettlementStore(path.join(root, "settlements"));
  const completedTrials = [];
  await campaigns.create(campaign);
  for (const slot of campaign.armOrder) {
    const reservation = parseCompanyBenchmarkSlotReservation({
      id: benchmarkRecordId("benchmark_reservation", campaign.id, slot.slotId),
      version: 1,
      campaignId: campaign.id,
      slotId: slot.slotId,
      attempt: 1,
      reservedAt: "2026-08-01T00:00:30.000Z",
      requestAllowance: 8,
      reportedCostAllowanceUsd: 1,
    });
    await reservations.create(reservation);
    if (terminalFailedSlotIds.includes(slot.slotId)) {
      await settlements.create(parseCompanyBenchmarkSlotSettlement({
        id: benchmarkRecordId("benchmark_settlement", reservation.id),
        version: 1,
        reservationId: reservation.id,
        campaignId: campaign.id,
        slotId: slot.slotId,
        status: "failed",
        settledAt: "2026-08-01T00:02:00.000Z",
        trialId: null,
        requestsCharged: 1,
        reportedCostUsd: null,
        costChargedUsd: 1,
        failureCode: "adapter_failed",
      }));
      continue;
    }
    const trial = failedTrialSlotIds.includes(slot.slotId)
      ? benchmarkFailedTrial(campaign, slot)
      : benchmarkTrial(campaign, slot);
    completedTrials.push(trial);
    await trials.create(trial);
    await settlements.create(parseCompanyBenchmarkSlotSettlement({
      id: benchmarkRecordId("benchmark_settlement", reservation.id),
      version: 1,
      reservationId: reservation.id,
      campaignId: campaign.id,
      slotId: slot.slotId,
      status: "completed",
      settledAt: trial.completedAt,
      trialId: trial.id,
      requestsCharged: trial.usage.requestsUsed + settlementRequestDelta,
      reportedCostUsd: null,
      costChargedUsd: 0,
      failureCode: null,
    }));
  }
  await summaries.create(createCompanyBenchmarkSummary(campaign, completedTrials));
}

test("company evaluation scenarios are stable and discoverable", async () => {
  const { stdout, stderr } = await execute(process.execPath, [
    script,
    "--list",
    "--json",
  ]);
  const catalog = JSON.parse(stdout);
  assert.equal(stderr, "");
  assert.deepEqual(catalog.scenarios.map((scenario) => scenario.id), [
    "company_formation_v1",
    "company_formation_quick_v1",
    "company_formation_guided_v1",
    "company_formation_deep_v1",
    "company_goal_execution_v1",
  ]);
});

test("offline company evaluation smoke emits safe deterministic structure", async () => {
  const { stdout, stderr } = await execute(process.execPath, [
    script,
    "--scenario",
    "company_formation_v1",
    "--project",
    process.cwd(),
    "--json",
  ]);
  const report = JSON.parse(stdout);

  assert.equal(stderr, "");
  assert.equal(report.status, "passed");
  assert.equal(report.mode, "offline");
  assert.equal(report.scenarioId, "company_formation_v1");
  assert.equal(report.rubric.length, 6);
  assert.equal(JSON.stringify(report).includes("What should this company"), false);
});

test("offline Quick, Guided, and Deep formation scenarios are independently reproducible", async () => {
  for (const [scenarioId, expectedRequests] of [
    ["company_formation_quick_v1", 2],
    ["company_formation_guided_v1", 5],
    ["company_formation_deep_v1", 5],
  ]) {
    const { stdout, stderr } = await execute(process.execPath, [
      script,
      "--scenario",
      scenarioId,
      "--project",
      process.cwd(),
      "--json",
    ]);
    const report = JSON.parse(stdout);
    assert.equal(stderr, "");
    assert.equal(report.status, "passed");
    assert.equal(report.scenarioId, scenarioId);
    assert.equal(report.usage.requestsUsed, expectedRequests);
    assert.equal(JSON.stringify(report).includes("What should this company"), false);
  }
});

test("configured evaluation requires explicit network opt-in", async () => {
  await assert.rejects(
    execute(process.execPath, [script, "--configured", "--json"]),
    (error) => {
      assert.match(error.stderr, /requires --allow-network/u);
      return true;
    },
  );
});

test("missing durable goal lookup is sanitized and never contacts a provider", async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "recurs-eval-script-"));
  try {
    await assert.rejects(
      execute(process.execPath, [
        script,
        "--scenario",
        "company_goal_execution_v1",
        "--run",
        "missing-run",
        "--project",
        process.cwd(),
        "--recurs-home",
        dataDirectory,
        "--json",
      ]),
      (error) => {
        assert.equal(error.stdout, "");
        assert.equal(
          error.stderr,
          "The selected durable company goal could not be read.\n",
        );
        assert.equal(error.stderr.includes(dataDirectory), false);
        return true;
      },
    );
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("benchmark evidence analysis exposes frozen thresholds without network access", async () => {
  const { stdout, stderr } = await execute(process.execPath, [
    benchmarkScript,
    "--help",
  ]);

  assert.equal(stderr, "");
  assert.match(stdout, /--campaign <id>/u);
  assert.match(stdout, /Read-only/u);
});

test("missing benchmark evidence is sanitized", async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "recurs-eval-script-"));
  try {
    await assert.rejects(
      execute(process.execPath, [
        benchmarkScript,
        "--campaign",
        "missing-campaign",
        "--recurs-home",
        dataDirectory,
      ]),
      (error) => {
        assert.equal(error.stdout, "");
        assert.equal(
          error.stderr,
          "The selected benchmark campaign could not be read.\n",
        );
        assert.equal(error.stderr.includes(dataDirectory), false);
        return true;
      },
    );
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("benchmark analyzer reads a complete durable campaign without network access", async () => {
  const dataDirectory = await realpath(
    await mkdtemp(path.join(tmpdir(), "recurs-eval-script-")),
  );
  const campaign = benchmarkCampaign({
    id: "campaign-complete-authority",
    repetitions: 1,
  });
  try {
    await writeBenchmarkAuthority(dataDirectory, campaign);
    const { stdout, stderr } = await execute(process.execPath, [
      benchmarkScript,
      "--campaign",
      campaign.id,
      "--recurs-home",
      dataDirectory,
    ]);
    const report = JSON.parse(stdout);

    assert.equal(stderr, "");
    assert.equal(report.campaigns[0].durable.authorityValid, true);
    assert.equal(report.campaigns[0].durable.complete, true);
    assert.equal(
      report.campaigns[0].analysis.comparisons[0].parentComparison,
      "matched",
    );
    assert.equal(report.recommendationStatus, "insufficient_evidence");
    assert.equal(stdout.includes(dataDirectory), false);
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("benchmark analyzer charges terminal failed settlements to raw reliability", async () => {
  const dataDirectory = await realpath(
    await mkdtemp(path.join(tmpdir(), "recurs-eval-script-")),
  );
  const campaign = benchmarkCampaign({
    id: "campaign-six-of-nine",
    repetitions: 3,
    compareAllStrong: true,
  });
  const failedSlotIds = campaign.armOrder
    .filter((slot) => slot.repetition === 3)
    .map((slot) => slot.slotId);
  const failedTrialSlotId = campaign.armOrder.find((slot) =>
    slot.repetition === 2 && slot.armId === campaign.baseline.id
  ).slotId;
  try {
    await writeBenchmarkAuthority(
      dataDirectory,
      campaign,
      failedSlotIds,
      [failedTrialSlotId],
    );
    const { stdout } = await execute(process.execPath, [
      benchmarkScript,
      "--campaign",
      campaign.id,
      "--recurs-home",
      dataDirectory,
    ]);
    const report = JSON.parse(stdout);

    assert.equal(report.campaigns[0].durable.authorityValid, true);
    assert.equal(report.campaigns[0].durable.complete, false);
    assert.equal(report.campaigns[0].durable.trials, 6);
    assert.equal(report.campaigns[0].durable.failedSettlements, 3);
    assert.equal(
      report.campaigns[0].analysis.arms.find((arm) =>
        arm.kind === "single_agent"
      ).completed,
      1,
    );
    assert.deepEqual(report.observations.rawReliability, {
      baseline: { plannedSlots: 3, completedSlots: 2, completionRate: 2 / 3 },
      company: { plannedSlots: 6, completedSlots: 4, completionRate: 2 / 3 },
    });
    assert.equal(report.observations.baselineCompletionRate, 2 / 3);
    assert.equal(report.observations.companyCompletionRate, 2 / 3);
    assert.equal(report.observations.matchedParentInformativePairs, 0);
    assert.equal(report.observations.repairAttempts, 0);
    assert.equal(report.recommendationStatus, "insufficient_evidence");
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("benchmark analyzer rejects settlement usage that disagrees with its trial", async () => {
  const dataDirectory = await realpath(
    await mkdtemp(path.join(tmpdir(), "recurs-eval-script-")),
  );
  const campaign = benchmarkCampaign({
    id: "campaign-mismatched-settlement",
    repetitions: 1,
  });
  try {
    await writeBenchmarkAuthority(dataDirectory, campaign, [], [], 1);
    const { stdout } = await execute(process.execPath, [
      benchmarkScript,
      "--campaign",
      campaign.id,
      "--recurs-home",
      dataDirectory,
    ]);
    const report = JSON.parse(stdout);

    assert.equal(report.campaigns[0].durable.authorityValid, false);
    assert.equal(report.campaigns[0].durable.complete, false);
    assert.equal(report.recommendationStatus, "insufficient_evidence");
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
