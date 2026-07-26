import { createHash } from "node:crypto";

import {
  deriveCompanyBenchmarkSummaryEvidence,
  parseCompanyBenchmarkCampaign,
  parseCompanyBenchmarkCampaignSummary,
  parseCompanyBenchmarkSlotReservation,
  parseCompanyBenchmarkSlotSettlement,
  parseCompanyBenchmarkTrial,
  validateCompanyBenchmarkCampaignSummary,
  validateCompanyBenchmarkSlotSettlement,
  validateCompanyBenchmarkTrialAgainstCampaign,
  type CompanyBenchmarkCampaignSummaryV1,
  type CompanyBenchmarkCampaignV1,
  type CompanyBenchmarkSlotReservationV1,
  type CompanyBenchmarkSlotSettlementV1,
  type CompanyBenchmarkTrialSlotV1,
  type CompanyBenchmarkTrialV1,
} from "@recurs/contracts";

export interface CompanyBenchmarkTrialStore {
  create(trial: CompanyBenchmarkTrialV1, signal?: AbortSignal): Promise<void>;
  list(signal?: AbortSignal): Promise<readonly CompanyBenchmarkTrialV1[]>;
}

export interface CompanyBenchmarkSummaryStore {
  create(
    summary: CompanyBenchmarkCampaignSummaryV1,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface CompanyBenchmarkSlotReservationStore {
  create(
    reservation: CompanyBenchmarkSlotReservationV1,
    signal?: AbortSignal,
  ): Promise<void>;
  list(
    signal?: AbortSignal,
  ): Promise<readonly CompanyBenchmarkSlotReservationV1[]>;
}

export interface CompanyBenchmarkSlotSettlementStore {
  create(
    settlement: CompanyBenchmarkSlotSettlementV1,
    signal?: AbortSignal,
  ): Promise<void>;
  list(
    signal?: AbortSignal,
  ): Promise<readonly CompanyBenchmarkSlotSettlementV1[]>;
}

export interface CompanyBenchmarkProviderRequest {
  readonly id: string;
}

export interface CompanyBenchmarkExecutionAllowance {
  readonly requestAllowance: number;
  readonly reportedCostAllowanceUsd: number;
  /**
   * Must be called before each provider request. The declared maximum is held
   * until `afterProviderResponse` reports the actual provider cost.
   */
  beforeProviderRequest(
    maximumReportedCostUsd: number,
  ): CompanyBenchmarkProviderRequest;
  afterProviderResponse(
    request: CompanyBenchmarkProviderRequest,
    reportedCostUsd: number | null,
  ): void;
}

export interface CompanyBenchmarkExecutionInput {
  readonly campaign: CompanyBenchmarkCampaignV1;
  readonly slot: CompanyBenchmarkTrialSlotV1;
  readonly allowance: CompanyBenchmarkExecutionAllowance;
  readonly signal?: AbortSignal;
}

export interface CompanyBenchmarkExecutionAdapter {
  execute(input: CompanyBenchmarkExecutionInput): Promise<CompanyBenchmarkTrialV1>;
}

export interface CompanyBenchmarkRunnerDependencies {
  readonly trials: CompanyBenchmarkTrialStore;
  readonly summaries: CompanyBenchmarkSummaryStore;
  readonly reservations: CompanyBenchmarkSlotReservationStore;
  readonly settlements: CompanyBenchmarkSlotSettlementStore;
  readonly adapter: CompanyBenchmarkExecutionAdapter;
  readonly now?: () => string;
}

export class CompanyBenchmarkRunnerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CompanyBenchmarkRunnerError";
  }
}

export class CompanyBenchmarkAllowanceError extends CompanyBenchmarkRunnerError {
  constructor(readonly failureCode: string) {
    super(`Company benchmark execution allowance failed: ${failureCode}`);
    this.name = "CompanyBenchmarkAllowanceError";
  }
}

interface AllowanceSnapshot {
  readonly requestsCharged: number;
  readonly reportedCostUsd: number | null;
  readonly costChargedUsd: number;
}

class BoundedExecutionAllowance implements CompanyBenchmarkExecutionAllowance {
  readonly #open = new Map<
    string,
    {
      readonly token: CompanyBenchmarkProviderRequest;
      readonly maximumReportedCostUsd: number;
    }
  >();
  #requestsCharged = 0;
  #knownReportedCostUsd = 0;
  #costChargedUsd = 0;
  #hasUnknownCost = false;
  #nextRequest = 1;

  constructor(
    readonly requestAllowance: number,
    readonly reportedCostAllowanceUsd: number,
  ) {}

  beforeProviderRequest(
    maximumReportedCostUsd: number,
  ): CompanyBenchmarkProviderRequest {
    if (!Number.isFinite(maximumReportedCostUsd) ||
      maximumReportedCostUsd < 0) {
      throw new CompanyBenchmarkAllowanceError("invalid_cost_reservation");
    }
    if (this.#requestsCharged >= this.requestAllowance) {
      throw new CompanyBenchmarkAllowanceError("request_allowance_exceeded");
    }
    const openCost = [...this.#open.values()].reduce(
      (sum, request) => sum + request.maximumReportedCostUsd,
      0,
    );
    if (this.#costChargedUsd + openCost + maximumReportedCostUsd >
      this.reportedCostAllowanceUsd) {
      throw new CompanyBenchmarkAllowanceError(
        "reported_cost_allowance_exceeded",
      );
    }
    const token = Object.freeze({
      id: `provider_request_${this.#nextRequest}`,
    });
    this.#nextRequest += 1;
    this.#requestsCharged += 1;
    this.#open.set(token.id, { token, maximumReportedCostUsd });
    return token;
  }

  afterProviderResponse(
    request: CompanyBenchmarkProviderRequest,
    reportedCostUsd: number | null,
  ): void {
    const reserved = this.#open.get(request.id);
    if (reserved === undefined || reserved.token !== request) {
      throw new CompanyBenchmarkAllowanceError("request_reservation_invalid");
    }
    this.#open.delete(request.id);
    if (reportedCostUsd === null) {
      this.#hasUnknownCost = true;
      this.#costChargedUsd += reserved.maximumReportedCostUsd;
      return;
    }
    if (!Number.isFinite(reportedCostUsd) || reportedCostUsd < 0) {
      throw new CompanyBenchmarkAllowanceError("reported_cost_invalid");
    }
    this.#knownReportedCostUsd += reportedCostUsd;
    this.#costChargedUsd += reportedCostUsd;
    if (reportedCostUsd > reserved.maximumReportedCostUsd ||
      this.#costChargedUsd > this.reportedCostAllowanceUsd) {
      throw new CompanyBenchmarkAllowanceError(
        "reported_cost_allowance_exceeded",
      );
    }
  }

  seal(): AllowanceSnapshot {
    if (this.#open.size > 0) {
      this.#hasUnknownCost = true;
      this.#costChargedUsd += [...this.#open.values()].reduce(
        (sum, request) => sum + request.maximumReportedCostUsd,
        0,
      );
      this.#open.clear();
    }
    return {
      requestsCharged: this.#requestsCharged,
      reportedCostUsd: this.#hasUnknownCost
        ? null
        : this.#knownReportedCostUsd,
      costChargedUsd: this.#costChargedUsd,
    };
  }

  complete(): AllowanceSnapshot {
    if (this.#open.size > 0) {
      throw new CompanyBenchmarkAllowanceError(
        "provider_request_not_settled",
      );
    }
    return this.seal();
  }
}

function recordId(prefix: string, ...parts: readonly string[]): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 32);
  return `${prefix}_${digest}`;
}

function reservationId(campaignId: string, slotId: string): string {
  return recordId("benchmark_reservation", campaignId, slotId);
}

function settlementId(reservation: CompanyBenchmarkSlotReservationV1): string {
  return recordId("benchmark_settlement", reservation.id);
}

function summaryId(
  campaignId: string,
  trialIds: readonly string[],
): string {
  return recordId("benchmark_summary", campaignId, ...[...trialIds].sort());
}

function maximumTimestamp(
  campaign: CompanyBenchmarkCampaignV1,
  trials: readonly CompanyBenchmarkTrialV1[],
  now?: string,
): string {
  return [campaign.createdAt, ...trials.map((trial) => trial.completedAt), now]
    .filter((value): value is string => value !== undefined)
    .reduce((latest, value) => value > latest ? value : latest);
}

export function createCompanyBenchmarkSummary(
  campaign: CompanyBenchmarkCampaignV1,
  rawTrials: readonly CompanyBenchmarkTrialV1[],
  createdAt?: string,
): CompanyBenchmarkCampaignSummaryV1 {
  const slotIndex = new Map(campaign.armOrder.map((slot, index) => [
    slot.slotId,
    index,
  ] as const));
  const trials = [...rawTrials].sort((left, right) =>
    (slotIndex.get(left.slotId) ?? Number.MAX_SAFE_INTEGER) -
    (slotIndex.get(right.slotId) ?? Number.MAX_SAFE_INTEGER)
  );
  const evidence = deriveCompanyBenchmarkSummaryEvidence(campaign, trials);
  const summary = parseCompanyBenchmarkCampaignSummary({
    id: summaryId(campaign.id, trials.map((trial) => trial.id)),
    version: 1,
    campaignId: campaign.id,
    createdAt: maximumTimestamp(campaign, trials, createdAt),
    ...evidence,
    completedTrialIds: trials.map((trial) => trial.id),
  });
  validateCompanyBenchmarkCampaignSummary(summary, campaign, trials);
  return summary;
}

function campaignTrials(
  campaign: CompanyBenchmarkCampaignV1,
  allTrials: readonly CompanyBenchmarkTrialV1[],
): CompanyBenchmarkTrialV1[] {
  const slots = new Set<string>();
  const selected = allTrials.filter((trial) => trial.campaignId === campaign.id);
  for (const trial of selected) {
    validateCompanyBenchmarkTrialAgainstCampaign(trial, campaign);
    if (slots.has(trial.slotId)) {
      throw new CompanyBenchmarkRunnerError(
        "Company benchmark storage contains duplicate trial slots",
      );
    }
    slots.add(trial.slotId);
  }
  return selected;
}

function settlementFor(
  reservation: CompanyBenchmarkSlotReservationV1,
  input: {
    readonly status: CompanyBenchmarkSlotSettlementV1["status"];
    readonly settledAt: string;
    readonly trialId?: string | null;
    readonly snapshot: AllowanceSnapshot;
    readonly failureCode?: string | null;
  },
): CompanyBenchmarkSlotSettlementV1 {
  return parseCompanyBenchmarkSlotSettlement({
    id: settlementId(reservation),
    version: 1,
    reservationId: reservation.id,
    campaignId: reservation.campaignId,
    slotId: reservation.slotId,
    status: input.status,
    settledAt: input.settledAt,
    trialId: input.trialId ?? null,
    requestsCharged: input.snapshot.requestsCharged,
    reportedCostUsd: input.snapshot.reportedCostUsd,
    costChargedUsd: input.snapshot.costChargedUsd,
    failureCode: input.failureCode ?? null,
  });
}

function trialSnapshot(
  trial: CompanyBenchmarkTrialV1,
  reservation: CompanyBenchmarkSlotReservationV1,
): AllowanceSnapshot {
  return {
    requestsCharged: trial.usage.requestsUsed,
    reportedCostUsd: trial.usage.reportedCostUsd,
    costChargedUsd: trial.usage.reportedCostUsd ??
      reservation.reportedCostAllowanceUsd,
  };
}

function snapshotsMatch(
  trial: CompanyBenchmarkTrialV1,
  snapshot: AllowanceSnapshot,
): boolean {
  return trial.usage.requestsUsed === snapshot.requestsCharged &&
    (trial.usage.reportedCostUsd === snapshot.reportedCostUsd ||
      trial.usage.requestsUsed === 0 &&
        trial.usage.reportedCostUsd === null &&
        snapshot.reportedCostUsd === 0) &&
    (trial.usage.reportedCostUsd ?? 0) <= snapshot.costChargedUsd;
}

function completedSettlementMatchesTrial(
  settlement: CompanyBenchmarkSlotSettlementV1,
  trial: CompanyBenchmarkTrialV1,
): boolean {
  return settlement.status === "completed" &&
    settlement.trialId === trial.id &&
    settlement.requestsCharged === trial.usage.requestsUsed &&
    settlement.reportedCostUsd === trial.usage.reportedCostUsd &&
    settlement.costChargedUsd >= (trial.usage.reportedCostUsd ?? 0) &&
    Date.parse(settlement.settledAt) >= Date.parse(trial.completedAt);
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true ||
    error instanceof DOMException && error.name === "AbortError";
}

export class CompanyBenchmarkRunner {
  readonly #trials: CompanyBenchmarkTrialStore;
  readonly #summaries: CompanyBenchmarkSummaryStore;
  readonly #reservations: CompanyBenchmarkSlotReservationStore;
  readonly #settlements: CompanyBenchmarkSlotSettlementStore;
  readonly #adapter: CompanyBenchmarkExecutionAdapter;
  readonly #now: () => string;

  constructor(dependencies: CompanyBenchmarkRunnerDependencies) {
    this.#trials = dependencies.trials;
    this.#summaries = dependencies.summaries;
    this.#reservations = dependencies.reservations;
    this.#settlements = dependencies.settlements;
    this.#adapter = dependencies.adapter;
    this.#now = dependencies.now ?? (() => new Date().toISOString());
  }

  async run(
    input: CompanyBenchmarkCampaignV1,
    signal?: AbortSignal,
  ): Promise<CompanyBenchmarkCampaignSummaryV1> {
    signal?.throwIfAborted();
    const campaign = parseCompanyBenchmarkCampaign(structuredClone(input));
    const trials = campaignTrials(campaign, await this.#trials.list(signal));
    const reservations = (await this.#reservations.list(signal))
      .filter((reservation) => reservation.campaignId === campaign.id);
    const settlements = (await this.#settlements.list(signal))
      .filter((settlement) => settlement.campaignId === campaign.id);
    const bySlot = new Map(trials.map((trial) => [trial.slotId, trial] as const));
    const reservationBySlot = new Map<string, CompanyBenchmarkSlotReservationV1>();
    const settlementByReservation = new Map<
      string,
      CompanyBenchmarkSlotSettlementV1
    >();

    for (const reservation of reservations) {
      const slot = campaign.armOrder.find((candidate) =>
        candidate.slotId === reservation.slotId
      );
      if (slot === undefined || reservation.id !==
          reservationId(campaign.id, reservation.slotId) ||
        Date.parse(reservation.reservedAt) < Date.parse(campaign.createdAt) ||
        reservation.requestAllowance > campaign.ceilings.maxRequests ||
        reservation.reportedCostAllowanceUsd >
          campaign.ceilings.maxReportedCostUsd ||
        reservationBySlot.has(reservation.slotId)) {
        throw new CompanyBenchmarkRunnerError(
          "Company benchmark reservation storage is inconsistent",
        );
      }
      reservationBySlot.set(reservation.slotId, reservation);
    }
    for (const settlement of settlements) {
      const reservation = reservations.find((candidate) =>
        candidate.id === settlement.reservationId
      );
      if (reservation === undefined ||
        settlementByReservation.has(settlement.reservationId)) {
        throw new CompanyBenchmarkRunnerError(
          "Company benchmark settlement storage is inconsistent",
        );
      }
      validateCompanyBenchmarkSlotSettlement(settlement, reservation);
      settlementByReservation.set(settlement.reservationId, settlement);
    }
    if (trials.some((trial) => !reservationBySlot.has(trial.slotId))) {
      throw new CompanyBenchmarkRunnerError(
        "Company benchmark trial has no durable reservation",
      );
    }

    let unresolvedPriorAttempt = false;
    for (const reservation of reservations) {
      const trial = bySlot.get(reservation.slotId);
      const settlement = settlementByReservation.get(reservation.id);
      if (settlement?.status === "completed" &&
        (trial === undefined ||
          !completedSettlementMatchesTrial(settlement, trial)) ||
        settlement !== undefined && settlement.status !== "completed" &&
          trial !== undefined) {
        throw new CompanyBenchmarkRunnerError(
          "Company benchmark trial and settlement storage disagree",
        );
      }
      if (settlement === undefined && trial !== undefined) {
        if (Date.parse(trial.startedAt) < Date.parse(reservation.reservedAt)) {
          throw new CompanyBenchmarkRunnerError(
            "Company benchmark trial predates its durable reservation",
          );
        }
        const recovered = settlementFor(reservation, {
          status: "completed",
          settledAt: this.#now(),
          trialId: trial.id,
          snapshot: trialSnapshot(trial, reservation),
        });
        validateCompanyBenchmarkSlotSettlement(recovered, reservation);
        await this.#settlements.create(recovered);
        settlementByReservation.set(reservation.id, recovered);
      } else if (settlement === undefined) {
        const interrupted = settlementFor(reservation, {
          status: "interrupted",
          settledAt: this.#now(),
          snapshot: {
            requestsCharged: reservation.requestAllowance,
            reportedCostUsd: null,
            costChargedUsd: reservation.reportedCostAllowanceUsd,
          },
          failureCode: "prior_attempt_outcome_unknown",
        });
        validateCompanyBenchmarkSlotSettlement(interrupted, reservation);
        await this.#settlements.create(interrupted);
        settlementByReservation.set(reservation.id, interrupted);
        unresolvedPriorAttempt = true;
      }
    }

    let requestsCharged = [...settlementByReservation.values()].reduce(
      (sum, settlement) => sum + settlement.requestsCharged,
      0,
    );
    let costChargedUsd = [...settlementByReservation.values()].reduce(
      (sum, settlement) => sum + settlement.costChargedUsd,
      0,
    );

    if (!unresolvedPriorAttempt) {
      for (const slot of campaign.armOrder) {
        signal?.throwIfAborted();
        if (reservationBySlot.has(slot.slotId)) continue;
        const remainingSlots = campaign.armOrder.reduce(
          (count, candidate) =>
            count + (reservationBySlot.has(candidate.slotId) ? 0 : 1),
          0,
        );
        const remainingRequests = campaign.ceilings.maxRequests -
          requestsCharged;
        const remainingReportedCostUsd =
          campaign.ceilings.maxReportedCostUsd - costChargedUsd;
        const requestAllowance = Math.floor(
          remainingRequests / remainingSlots,
        );
        const reportedCostAllowanceUsd =
          remainingReportedCostUsd / remainingSlots;
        if (requestAllowance <= 0 || reportedCostAllowanceUsd < 0) break;

        const reservation = parseCompanyBenchmarkSlotReservation({
          id: reservationId(campaign.id, slot.slotId),
          version: 1,
          campaignId: campaign.id,
          slotId: slot.slotId,
          attempt: 1,
          reservedAt: this.#now(),
          requestAllowance,
          reportedCostAllowanceUsd,
        });
        // This publication is the pre-call authority; do not let a concurrent
        // cancellation erase evidence that a provider call may follow.
        await this.#reservations.create(reservation);
        reservationBySlot.set(slot.slotId, reservation);
        const allowance = new BoundedExecutionAllowance(
          requestAllowance,
          reportedCostAllowanceUsd,
        );
        if (signal?.aborted === true) {
          const cancelled = settlementFor(reservation, {
            status: "cancelled",
            settledAt: this.#now(),
            snapshot: allowance.seal(),
            failureCode: "cancelled_before_execution",
          });
          await this.#settlements.create(cancelled);
          signal.throwIfAborted();
        }

        let rawTrial: CompanyBenchmarkTrialV1;
        try {
          rawTrial = await this.#adapter.execute({
            campaign,
            slot,
            allowance,
            ...(signal === undefined ? {} : { signal }),
          });
        } catch (error) {
          const snapshot = allowance.seal();
          const overrun = error instanceof CompanyBenchmarkAllowanceError;
          const settlement = settlementFor(reservation, {
            status: overrun
              ? "overrun"
              : isAbort(error, signal) ? "cancelled" : "failed",
            settledAt: this.#now(),
            snapshot,
            failureCode: overrun
              ? error.failureCode
              : isAbort(error, signal)
                ? "execution_cancelled"
                : "adapter_failed",
          });
          await this.#settlements.create(settlement);
          settlementByReservation.set(reservation.id, settlement);
          requestsCharged += settlement.requestsCharged;
          costChargedUsd += settlement.costChargedUsd;
          if (isAbort(error, signal)) throw error;
          if (overrun) throw error;
          continue;
        }

        let snapshot: AllowanceSnapshot;
        try {
          snapshot = allowance.complete();
        } catch (error) {
          const sealed = allowance.seal();
          const settlement = settlementFor(reservation, {
            status: "failed",
            settledAt: this.#now(),
            snapshot: sealed,
            failureCode: error instanceof CompanyBenchmarkAllowanceError
              ? error.failureCode
              : "allowance_contract_failed",
          });
          await this.#settlements.create(settlement);
          throw error;
        }
        const trial = parseCompanyBenchmarkTrial(structuredClone(rawTrial));
        if (trial.slotId !== slot.slotId) {
          const settlement = settlementFor(reservation, {
            status: "failed",
            settledAt: this.#now(),
            snapshot,
            failureCode: "adapter_slot_mismatch",
          });
          await this.#settlements.create(settlement);
          throw new CompanyBenchmarkRunnerError(
            "Company benchmark adapter returned a different trial slot",
          );
        }
        if (!snapshotsMatch(trial, snapshot)) {
          const settlement = settlementFor(reservation, {
            status: "failed",
            settledAt: this.#now(),
            snapshot,
            failureCode: "adapter_usage_mismatch",
          });
          await this.#settlements.create(settlement);
          throw new CompanyBenchmarkRunnerError(
            "Company benchmark adapter usage does not match its enforced allowance",
          );
        }
        if (Date.parse(trial.startedAt) < Date.parse(reservation.reservedAt)) {
          const settlement = settlementFor(reservation, {
            status: "failed",
            settledAt: this.#now(),
            snapshot,
            failureCode: "trial_predates_reservation",
          });
          await this.#settlements.create(settlement);
          throw new CompanyBenchmarkRunnerError(
            "Company benchmark trial predates its durable reservation",
          );
        }
        validateCompanyBenchmarkTrialAgainstCampaign(trial, campaign);
        await this.#trials.create(trial);
        const completed = settlementFor(reservation, {
          status: "completed",
          settledAt: this.#now(),
          trialId: trial.id,
          snapshot: {
            ...snapshot,
            reportedCostUsd: trial.usage.reportedCostUsd,
          },
        });
        validateCompanyBenchmarkSlotSettlement(completed, reservation);
        await this.#settlements.create(completed);
        trials.push(trial);
        bySlot.set(slot.slotId, trial);
        settlementByReservation.set(reservation.id, completed);
        requestsCharged += completed.requestsCharged;
        costChargedUsd += completed.costChargedUsd;
      }
    }

    const summary = createCompanyBenchmarkSummary(
      campaign,
      trials,
    );
    await this.#summaries.create(summary);
    return summary;
  }
}
