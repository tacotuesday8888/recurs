import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  companyBenchmarkTrialSlotId,
  parseCompanyBenchmarkCampaign,
  parseCompanyBenchmarkTrial,
  type CompanyBenchmarkCampaignSummaryV1,
  type CompanyBenchmarkCampaignV1,
  type CompanyBenchmarkRouteV1,
  type CompanyBenchmarkSlotReservationV1,
  type CompanyBenchmarkSlotSettlementV1,
  type CompanyBenchmarkTrialV1,
} from "@recurs/contracts";

import {
  CompanyBenchmarkRunner,
  type CompanyBenchmarkExecutionAdapter,
  type CompanyBenchmarkExecutionInput,
  type CompanyBenchmarkSlotReservationStore,
  type CompanyBenchmarkSlotSettlementStore,
  type CompanyBenchmarkSummaryStore,
  type CompanyBenchmarkTrialStore,
} from "../src/company-benchmark-runner.js";
import {
  FileCompanyBenchmarkCampaignStore,
  FileCompanyBenchmarkSlotReservationStore,
  FileCompanyBenchmarkSlotSettlementStore,
  FileCompanyBenchmarkSummaryStore,
  FileCompanyBenchmarkTrialStore,
} from "../src/file-company-benchmark-store.js";

const CREATED_AT = "2026-07-24T00:00:00.000Z";
const FIXTURE_SHA = "a".repeat(64);
const BLUEPRINT_SHA = "b".repeat(64);
const roots: string[] = [];

function benchmarkClock(): () => string {
  let calls = 0;
  return () => {
    const at = calls % 2 === 0
      ? "2026-07-24T00:10:00.000Z"
      : "2026-07-24T00:30:00.000Z";
    calls += 1;
    return at;
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

function route(role: CompanyBenchmarkRouteV1["role"]): CompanyBenchmarkRouteV1 {
  return {
    role,
    providerId: "scripted",
    adapterId: "scripted",
    connectionId: `connection-${role}`,
    modelId: role === "parent" ? "strong-parent" : "bounded-worker",
    reasoningEffort: role === "parent" ? "high" : "medium",
  };
}

function campaign(repetitions = 1, maxRequests = repetitions * 8) {
  const baselineId = "baseline";
  const companyId = "company-balanced";
  const armOrder = Array.from({ length: repetitions }, (_, index) => {
    const repetition = index + 1;
    const ids = repetition % 2 === 1
      ? [baselineId, companyId]
      : [companyId, baselineId];
    return ids.map((armId) => ({
      slotId: companyBenchmarkTrialSlotId(armId, repetition),
      armId,
      repetition,
    }));
  }).flat();
  return parseCompanyBenchmarkCampaign({
    id: `campaign-${repetitions}-${maxRequests}`,
    version: 1,
    createdAt: CREATED_AT,
    scenario: {
      id: "alias_registry",
      version: 1,
      taskClass: "general_coding",
      difficulty: "medium",
      fixtureSha256: FIXTURE_SHA,
      verifierId: "alias_registry_hidden_v1",
      objectiveRevision: "alias_registry_objective_v1",
    },
    harnessRevision: "recurs-alpha",
    launchProtocolRevision: "company-benchmark-launch-v1",
    operatingModeId: "balanced_v6",
    operatingModeVersion: 6,
    permissionMode: "approved_for_me",
    repetitions,
    ceilings: {
      maxTrialSlots: armOrder.length,
      maxRequests,
      maxReportedCostUsd: 10,
    },
    blueprint: {
      id: "benchmark-blueprint",
      revision: 1,
      sha256: BLUEPRINT_SHA,
    },
    baseline: {
      id: baselineId,
      kind: "single_agent",
      configuredRoutes: [route("parent")],
    },
    companyArms: [{
      id: companyId,
      kind: "company",
      configuredRoutes: [
        route("parent"),
        route("implement"),
        route("review"),
        route("repair"),
      ],
    }],
    armOrder,
  });
}

function usage(requests: number) {
  return {
    requestsUsed: requests,
    usageReports: requests,
    costReports: requests,
    tokenCoverage: "complete" as const,
    costCoverage: "complete" as const,
    inputTokens: requests * 100,
    outputTokens: requests * 10,
    cachedInputTokens: 0,
    cacheWriteInputTokens: null,
    reasoningTokens: null,
    reportedCostUsd: 0,
  };
}

function successfulTrial(
  authority: CompanyBenchmarkCampaignV1,
  slot: CompanyBenchmarkCampaignV1["armOrder"][number],
): CompanyBenchmarkTrialV1 {
  const baseline = slot.armId === authority.baseline.id;
  const arm = baseline ? authority.baseline : authority.companyArms[0]!;
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
    usage: usage(1),
    evidenceItems: 1,
    changedFiles: candidate.role === "implement" ||
        baseline && candidate.role === "parent"
      ? ["src/alias-path.js", "src/alias-registry.js"]
      : [],
  }));
  return parseCompanyBenchmarkTrial({
    id: `trial-${slot.slotId}`,
    version: 1,
    campaignId: authority.id,
    slotId: slot.slotId,
    armId: slot.armId,
    armKind: arm.kind,
    repetition: slot.repetition,
    scenario: authority.scenario,
    harnessRevision: authority.harnessRevision,
    launchProtocolRevision: authority.launchProtocolRevision,
    blueprint: baseline ? null : authority.blueprint,
    configuredRoutes: arm.configuredRoutes,
    activatedRoutes,
    executionStatus: "completed",
    startedAt: "2026-07-24T00:20:00.000Z",
    completedAt: "2026-07-24T00:20:01.000Z",
    wallClockMs: 1_000,
    roles,
    usage: usage(roles.length),
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
    evidence: { roleItems: roles.length, finalItems: 1 },
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

function failedTrial(
  authority: CompanyBenchmarkCampaignV1,
  slot: CompanyBenchmarkCampaignV1["armOrder"][number],
): CompanyBenchmarkTrialV1 {
  const arm = slot.armId === authority.baseline.id
    ? authority.baseline
    : authority.companyArms[0]!;
  return parseCompanyBenchmarkTrial({
    id: `trial-${slot.slotId}`,
    version: 1,
    campaignId: authority.id,
    slotId: slot.slotId,
    armId: slot.armId,
    armKind: arm.kind,
    repetition: slot.repetition,
    scenario: authority.scenario,
    harnessRevision: authority.harnessRevision,
    launchProtocolRevision: authority.launchProtocolRevision,
    blueprint: arm.kind === "company" ? authority.blueprint : null,
    configuredRoutes: arm.configuredRoutes,
    activatedRoutes: [],
    executionStatus: "failed",
    startedAt: "2026-07-24T00:20:00.000Z",
    completedAt: "2026-07-24T00:20:00.000Z",
    wallClockMs: 0,
    roles: [],
    usage: {
      requestsUsed: 0,
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
    },
    verification: {
      status: "not_run",
      workspaceIntegrity: "not_run",
      checks: [],
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
    failures: [{ stage: "execution", code: "adapter_failed" }],
  });
}

function accountForTrial(
  input: CompanyBenchmarkExecutionInput,
  trial: CompanyBenchmarkTrialV1,
): CompanyBenchmarkTrialV1 {
  for (let index = 0; index < trial.usage.requestsUsed; index += 1) {
    const request = input.allowance.beforeProviderRequest(0);
    input.allowance.afterProviderResponse(request, 0);
  }
  return trial;
}

class MemoryTrialStore implements CompanyBenchmarkTrialStore {
  readonly values = new Map<string, CompanyBenchmarkTrialV1>();

  async create(trial: CompanyBenchmarkTrialV1): Promise<void> {
    const current = this.values.get(trial.id);
    if (current !== undefined && JSON.stringify(current) !== JSON.stringify(trial)) {
      throw new Error("conflicting trial");
    }
    this.values.set(trial.id, trial);
  }

  async list(): Promise<readonly CompanyBenchmarkTrialV1[]> {
    return [...this.values.values()];
  }
}

class MemorySummaryStore implements CompanyBenchmarkSummaryStore {
  readonly values = new Map<string, CompanyBenchmarkCampaignSummaryV1>();

  async create(summary: CompanyBenchmarkCampaignSummaryV1): Promise<void> {
    this.values.set(summary.id, summary);
  }
}

class MemoryReservationStore implements CompanyBenchmarkSlotReservationStore {
  readonly values = new Map<string, CompanyBenchmarkSlotReservationV1>();

  async create(value: CompanyBenchmarkSlotReservationV1): Promise<void> {
    const current = this.values.get(value.id);
    if (current !== undefined &&
      JSON.stringify(current) !== JSON.stringify(value)) {
      throw new Error("conflicting reservation");
    }
    this.values.set(value.id, value);
  }

  async list(): Promise<readonly CompanyBenchmarkSlotReservationV1[]> {
    return [...this.values.values()];
  }
}

class MemorySettlementStore implements CompanyBenchmarkSlotSettlementStore {
  readonly values = new Map<string, CompanyBenchmarkSlotSettlementV1>();

  async create(value: CompanyBenchmarkSlotSettlementV1): Promise<void> {
    const current = this.values.get(value.id);
    if (current !== undefined &&
      JSON.stringify(current) !== JSON.stringify(value)) {
      throw new Error("conflicting settlement");
    }
    this.values.set(value.id, value);
  }

  async list(): Promise<readonly CompanyBenchmarkSlotSettlementV1[]> {
    return [...this.values.values()];
  }
}

function memoryAttemptStores() {
  return {
    reservations: new MemoryReservationStore(),
    settlements: new MemorySettlementStore(),
  };
}

describe("CompanyBenchmarkRunner", () => {
  it("runs canonical slots sequentially and resumes without repeating them", async () => {
    const authority = campaign();
    const trials = new MemoryTrialStore();
    const summaries = new MemorySummaryStore();
    const attempts = memoryAttemptStores();
    const calls: string[] = [];
    const adapter: CompanyBenchmarkExecutionAdapter = {
      async execute(input) {
        calls.push(input.slot.slotId);
        return accountForTrial(
          input,
          successfulTrial(input.campaign, input.slot),
        );
      },
    };
    const runner = new CompanyBenchmarkRunner({
      trials,
      summaries,
      ...attempts,
      adapter,
      now: benchmarkClock(),
    });

    const first = await runner.run(authority);
    const resumed = await runner.run(authority);

    expect(calls).toEqual(authority.armOrder.map((slot) => slot.slotId));
    expect(resumed).toEqual(first);
    expect(first).toMatchObject({
      correctnessEligibility: "insufficient_evidence",
      efficiencyEligibility: "insufficient_evidence",
      rationale: ["minimum_comparable_pairs_not_met"],
    });
    expect(first.comparablePairs).toHaveLength(1);
    expect(trials.values).toHaveLength(2);
    expect(summaries.values).toHaveLength(1);
  });

  it("reserves a fair per-slot share so unknown subscription cost does not consume later trials", async () => {
    const authority = campaign(3, 24);
    const trials = new MemoryTrialStore();
    const attempts = memoryAttemptStores();
    const calls: string[] = [];
    const runner = new CompanyBenchmarkRunner({
      trials,
      summaries: new MemorySummaryStore(),
      ...attempts,
      adapter: {
        async execute(input) {
          calls.push(input.slot.slotId);
          const value = structuredClone(
            successfulTrial(input.campaign, input.slot),
          );
          for (const role of value.roles) {
            role.usage.costReports = 0;
            role.usage.costCoverage = "none";
            role.usage.reportedCostUsd = null;
          }
          value.usage.costReports = 0;
          value.usage.costCoverage = "none";
          value.usage.reportedCostUsd = null;
          const trial = parseCompanyBenchmarkTrial(value);
          const maximum = input.allowance.reportedCostAllowanceUsd /
            trial.usage.requestsUsed;
          for (let index = 0; index < trial.usage.requestsUsed; index += 1) {
            const request = input.allowance.beforeProviderRequest(maximum);
            input.allowance.afterProviderResponse(request, null);
          }
          return trial;
        },
      },
      now: benchmarkClock(),
    });

    const summary = await runner.run(authority);

    expect(calls).toEqual(authority.armOrder.map((slot) => slot.slotId));
    expect(trials.values).toHaveLength(authority.armOrder.length);
    expect(summary.correctnessEligibility).toBe("comparable");
    expect(summary.efficiencyEligibility).toBe("insufficient_evidence");
    expect([...attempts.settlements.values.values()].every(
      (settlement) => settlement.status === "completed",
    )).toBe(true);
  });

  it("persists terminal failure evidence returned by the adapter and continues", async () => {
    const authority = campaign();
    const trials = new MemoryTrialStore();
    const attempts = memoryAttemptStores();
    const adapter: CompanyBenchmarkExecutionAdapter = {
      async execute(input) {
        if (input.slot.armId !== authority.baseline.id) {
          return accountForTrial(
            input,
            failedTrial(input.campaign, input.slot),
          );
        }
        return accountForTrial(
          input,
          successfulTrial(input.campaign, input.slot),
        );
      },
    };
    const runner = new CompanyBenchmarkRunner({
      trials,
      summaries: new MemorySummaryStore(),
      ...attempts,
      adapter,
      now: benchmarkClock(),
    });

    const summary = await runner.run(authority);
    const failed = [...trials.values.values()].find((trial) =>
      trial.executionStatus === "failed"
    );

    expect(failed).toMatchObject({
      activatedRoutes: [],
      failures: [{ stage: "execution", code: "adapter_failed" }],
      usage: { costCoverage: "none", reportedCostUsd: null },
    });
    expect(summary.rationale).toContain("verification_or_safety_failed");
  });

  it("requires three comparable repetitions without selecting a winner", async () => {
    const authority = campaign(3, 24);
    const attempts = memoryAttemptStores();
    const runner = new CompanyBenchmarkRunner({
      trials: new MemoryTrialStore(),
      summaries: new MemorySummaryStore(),
      ...attempts,
      adapter: {
        execute: async (input) => accountForTrial(
          input,
          successfulTrial(input.campaign, input.slot),
        ),
      },
      now: benchmarkClock(),
    });

    const summary = await runner.run(authority);

    expect(summary.correctnessEligibility).toBe("comparable");
    expect(summary.efficiencyEligibility).toBe("comparable");
    expect(summary.comparablePairs).toHaveLength(3);
    expect(summary.rationale).toEqual(["minimum_comparable_pairs_met"]);
    expect("winner" in summary).toBe(false);
  });

  it("stops before another provider call when the request ceiling is exhausted", async () => {
    const authority = campaign(1, 2);
    const trials = new MemoryTrialStore();
    const attempts = memoryAttemptStores();
    let calls = 0;
    const runner = new CompanyBenchmarkRunner({
      trials,
      summaries: new MemorySummaryStore(),
      ...attempts,
      adapter: {
        async execute(input) {
          calls += 1;
          for (let index = 0; index < 3; index += 1) {
            const request = input.allowance.beforeProviderRequest(0);
            input.allowance.afterProviderResponse(request, 0);
          }
          return successfulTrial(input.campaign, input.slot);
        },
      },
      now: benchmarkClock(),
    });

    await expect(runner.run(authority)).rejects.toThrow(
      "request_allowance_exceeded",
    );
    expect(calls).toBe(1);
    expect(trials.values).toHaveLength(0);
    expect([...attempts.settlements.values.values()]).toContainEqual(
      expect.objectContaining({
        status: "overrun",
        failureCode: "request_allowance_exceeded",
      }),
    );
  });

  it("persists a provider-reported cost overrun truthfully", async () => {
    const authority = campaign();
    const attempts = memoryAttemptStores();
    const runner = new CompanyBenchmarkRunner({
      trials: new MemoryTrialStore(),
      summaries: new MemorySummaryStore(),
      ...attempts,
      adapter: {
        async execute(input) {
          const request = input.allowance.beforeProviderRequest(1);
          input.allowance.afterProviderResponse(request, 11);
          return successfulTrial(input.campaign, input.slot);
        },
      },
      now: benchmarkClock(),
    });

    await expect(runner.run(authority)).rejects.toThrow(
      "reported_cost_allowance_exceeded",
    );
    expect([...attempts.settlements.values.values()]).toContainEqual(
      expect.objectContaining({
        status: "overrun",
        reportedCostUsd: 11,
        costChargedUsd: 11,
        failureCode: "reported_cost_allowance_exceeded",
      }),
    );
  });

  it("durably resumes after cancellation without replaying a completed slot", async () => {
    const root = await realpath(
      await mkdtemp(path.join(tmpdir(), "recurs-benchmark-cancel-")),
    );
    roots.push(root);
    const authority = campaign();
    const trials = new FileCompanyBenchmarkTrialStore(path.join(root, "trials"));
    const summaries = new FileCompanyBenchmarkSummaryStore(
      path.join(root, "summaries"),
    );
    const reservations = new FileCompanyBenchmarkSlotReservationStore(
      path.join(root, "reservations"),
    );
    const settlements = new FileCompanyBenchmarkSlotSettlementStore(
      path.join(root, "settlements"),
    );
    const controller = new AbortController();
    const calls: string[] = [];
    const adapter: CompanyBenchmarkExecutionAdapter = {
      async execute(input) {
        calls.push(input.slot.slotId);
        const result = accountForTrial(
          input,
          successfulTrial(input.campaign, input.slot),
        );
        if (calls.length === 1) controller.abort();
        return result;
      },
    };
    const runner = new CompanyBenchmarkRunner({
      trials,
      summaries,
      reservations,
      settlements,
      adapter,
      now: benchmarkClock(),
    });

    await expect(runner.run(authority, controller.signal))
      .rejects.toThrow("aborted");
    expect(await trials.list()).toHaveLength(1);
    await new CompanyBenchmarkRunner({
      trials,
      summaries,
      reservations,
      settlements,
      adapter,
      now: benchmarkClock(),
    }).run(authority);
    expect(calls).toEqual(authority.armOrder.map((slot) => slot.slotId));
    expect(await trials.list()).toHaveLength(2);
    expect(await settlements.list()).toHaveLength(2);
  });

  it("fails closed on an orphaned durable reservation instead of replaying spend", async () => {
    const root = await realpath(
      await mkdtemp(path.join(tmpdir(), "recurs-benchmark-crash-")),
    );
    roots.push(root);
    const authority = campaign();
    const trials = new FileCompanyBenchmarkTrialStore(path.join(root, "trials"));
    const summaries = new FileCompanyBenchmarkSummaryStore(
      path.join(root, "summaries"),
    );
    const reservations = new FileCompanyBenchmarkSlotReservationStore(
      path.join(root, "reservations"),
    );
    const settlements = new FileCompanyBenchmarkSlotSettlementStore(
      path.join(root, "settlements"),
    );
    let simulateCrash = true;
    const crashingReservations: CompanyBenchmarkSlotReservationStore = {
      list: (signal) => reservations.list(signal),
      async create(reservation, signal) {
        await reservations.create(reservation, signal);
        if (simulateCrash) {
          simulateCrash = false;
          throw new Error("simulated process crash");
        }
      },
    };
    let providerCalls = 0;
    const adapter: CompanyBenchmarkExecutionAdapter = {
      async execute(input) {
        providerCalls += 1;
        return accountForTrial(
          input,
          successfulTrial(input.campaign, input.slot),
        );
      },
    };
    await expect(new CompanyBenchmarkRunner({
      trials,
      summaries,
      reservations: crashingReservations,
      settlements,
      adapter,
      now: benchmarkClock(),
    }).run(authority)).rejects.toThrow("simulated process crash");

    const summary = await new CompanyBenchmarkRunner({
      trials,
      summaries,
      reservations,
      settlements,
      adapter,
      now: benchmarkClock(),
    }).run(authority);

    expect(providerCalls).toBe(0);
    expect(await trials.list()).toHaveLength(0);
    const [reservation] = await reservations.list();
    expect(await settlements.list()).toEqual([
      expect.objectContaining({
        status: "interrupted",
        requestsCharged: reservation!.requestAllowance,
        costChargedUsd: reservation!.reportedCostAllowanceUsd,
        failureCode: "prior_attempt_outcome_unknown",
      }),
    ]);
    expect(summary.rationale).toEqual([
      "minimum_comparable_pairs_not_met",
      "campaign_incomplete",
    ]);
  });

  it("publishes immutable private campaign, trial, and summary records", async () => {
    const root = await realpath(
      await mkdtemp(path.join(tmpdir(), "recurs-benchmark-store-")),
    );
    roots.push(root);
    const authority = campaign();
    const campaigns = new FileCompanyBenchmarkCampaignStore(
      path.join(root, "campaigns"),
    );
    const trials = new FileCompanyBenchmarkTrialStore(path.join(root, "trials"));
    const summaries = new FileCompanyBenchmarkSummaryStore(
      path.join(root, "summaries"),
    );
    const reservations = new FileCompanyBenchmarkSlotReservationStore(
      path.join(root, "reservations"),
    );
    const settlements = new FileCompanyBenchmarkSlotSettlementStore(
      path.join(root, "settlements"),
    );
    await campaigns.create(authority);
    const runner = new CompanyBenchmarkRunner({
      trials,
      summaries,
      reservations,
      settlements,
      adapter: {
        execute: async (input) => accountForTrial(
          input,
          successfulTrial(input.campaign, input.slot),
        ),
      },
      now: benchmarkClock(),
    });

    const summary = await runner.run(authority);
    await campaigns.create(authority);

    expect(await campaigns.load(authority.id)).toEqual(authority);
    expect(await trials.list()).toHaveLength(2);
    expect(await summaries.load(summary.id)).toEqual(summary);
    expect(await reservations.list()).toHaveLength(2);
    expect(await settlements.list()).toHaveLength(2);
    for (const directory of [
      "campaigns",
      "trials",
      "summaries",
      "reservations",
      "settlements",
    ]) {
      expect((await lstat(path.join(root, directory))).mode & 0o777).toBe(0o700);
    }
    await expect(campaigns.create({
      ...authority,
      permissionMode: "ask_always",
    })).rejects.toMatchObject({ code: "conflict" });
  });
});
