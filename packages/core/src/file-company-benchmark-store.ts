import {
  parseCompanyBenchmarkCampaign,
  parseCompanyBenchmarkCampaignSummary,
  parseCompanyBenchmarkSlotReservation,
  parseCompanyBenchmarkSlotSettlement,
  parseCompanyBenchmarkTrial,
  type CompanyBenchmarkCampaignSummaryV1,
  type CompanyBenchmarkCampaignV1,
  type CompanyBenchmarkSlotReservationV1,
  type CompanyBenchmarkSlotSettlementV1,
  type CompanyBenchmarkTrialV1,
} from "@recurs/contracts";

import { PrivateImmutableJsonStore } from "./private-state-store.js";

const MAXIMUM_RECORDS = 4_096;

export class FileCompanyBenchmarkCampaignStore {
  readonly #store: PrivateImmutableJsonStore<CompanyBenchmarkCampaignV1>;

  constructor(readonly directory: string) {
    this.#store = new PrivateImmutableJsonStore(directory, {
      label: "Company benchmark campaign",
      maximumBytes: 2 * 1024 * 1024,
      maximumRecords: MAXIMUM_RECORDS,
      parse: parseCompanyBenchmarkCampaign,
      idOf: (campaign) => campaign.id,
    });
  }

  create(campaign: CompanyBenchmarkCampaignV1, signal?: AbortSignal): Promise<void> {
    return this.#store.create(campaign, signal);
  }

  load(id: string, signal?: AbortSignal): Promise<CompanyBenchmarkCampaignV1> {
    return this.#store.load(id, signal);
  }

  list(signal?: AbortSignal): Promise<readonly CompanyBenchmarkCampaignV1[]> {
    return this.#store.list(signal);
  }
}

export class FileCompanyBenchmarkTrialStore {
  readonly #store: PrivateImmutableJsonStore<CompanyBenchmarkTrialV1>;

  constructor(readonly directory: string) {
    this.#store = new PrivateImmutableJsonStore(directory, {
      label: "Company benchmark trial",
      maximumBytes: 4 * 1024 * 1024,
      maximumRecords: MAXIMUM_RECORDS,
      parse: parseCompanyBenchmarkTrial,
      idOf: (trial) => trial.id,
    });
  }

  create(trial: CompanyBenchmarkTrialV1, signal?: AbortSignal): Promise<void> {
    return this.#store.create(trial, signal);
  }

  load(id: string, signal?: AbortSignal): Promise<CompanyBenchmarkTrialV1> {
    return this.#store.load(id, signal);
  }

  list(signal?: AbortSignal): Promise<readonly CompanyBenchmarkTrialV1[]> {
    return this.#store.list(signal);
  }
}

export class FileCompanyBenchmarkSummaryStore {
  readonly #store: PrivateImmutableJsonStore<CompanyBenchmarkCampaignSummaryV1>;

  constructor(readonly directory: string) {
    this.#store = new PrivateImmutableJsonStore(directory, {
      label: "Company benchmark summary",
      maximumBytes: 2 * 1024 * 1024,
      maximumRecords: MAXIMUM_RECORDS,
      parse: parseCompanyBenchmarkCampaignSummary,
      idOf: (summary) => summary.id,
    });
  }

  create(
    summary: CompanyBenchmarkCampaignSummaryV1,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.#store.create(summary, signal);
  }

  load(
    id: string,
    signal?: AbortSignal,
  ): Promise<CompanyBenchmarkCampaignSummaryV1> {
    return this.#store.load(id, signal);
  }

  list(
    signal?: AbortSignal,
  ): Promise<readonly CompanyBenchmarkCampaignSummaryV1[]> {
    return this.#store.list(signal);
  }
}

export class FileCompanyBenchmarkSlotReservationStore {
  readonly #store: PrivateImmutableJsonStore<
    CompanyBenchmarkSlotReservationV1
  >;

  constructor(readonly directory: string) {
    this.#store = new PrivateImmutableJsonStore(directory, {
      label: "Company benchmark slot reservation",
      maximumBytes: 64 * 1024,
      maximumRecords: MAXIMUM_RECORDS,
      parse: parseCompanyBenchmarkSlotReservation,
      idOf: (reservation) => reservation.id,
    });
  }

  create(
    reservation: CompanyBenchmarkSlotReservationV1,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.#store.create(reservation, signal);
  }

  list(
    signal?: AbortSignal,
  ): Promise<readonly CompanyBenchmarkSlotReservationV1[]> {
    return this.#store.list(signal);
  }
}

export class FileCompanyBenchmarkSlotSettlementStore {
  readonly #store: PrivateImmutableJsonStore<CompanyBenchmarkSlotSettlementV1>;

  constructor(readonly directory: string) {
    this.#store = new PrivateImmutableJsonStore(directory, {
      label: "Company benchmark slot settlement",
      maximumBytes: 64 * 1024,
      maximumRecords: MAXIMUM_RECORDS,
      parse: parseCompanyBenchmarkSlotSettlement,
      idOf: (settlement) => settlement.id,
    });
  }

  create(
    settlement: CompanyBenchmarkSlotSettlementV1,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.#store.create(settlement, signal);
  }

  list(
    signal?: AbortSignal,
  ): Promise<readonly CompanyBenchmarkSlotSettlementV1[]> {
    return this.#store.list(signal);
  }
}
