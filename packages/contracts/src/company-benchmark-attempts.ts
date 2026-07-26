import {
  contractDeepFreeze,
  contractEnum,
  contractExact,
  contractId,
  contractInteger,
  contractNumber,
  contractRecord,
  contractTimestamp,
} from "./company-contract-utils.js";

const MAX_REQUESTS = 100_000;
const MAX_REPORTED_COST_USD = 1_000_000;
const MAX_OBSERVED_COST_USD = Number.MAX_SAFE_INTEGER;
const SETTLEMENT_STATUSES = new Set<string>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "overrun",
]);

export type CompanyBenchmarkSlotSettlementStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "overrun";

export interface CompanyBenchmarkSlotReservationV1 {
  readonly id: string;
  readonly version: 1;
  readonly campaignId: string;
  readonly slotId: string;
  readonly attempt: 1;
  readonly reservedAt: string;
  readonly requestAllowance: number;
  readonly reportedCostAllowanceUsd: number;
}

export interface CompanyBenchmarkSlotSettlementV1 {
  readonly id: string;
  readonly version: 1;
  readonly reservationId: string;
  readonly campaignId: string;
  readonly slotId: string;
  readonly status: CompanyBenchmarkSlotSettlementStatus;
  readonly settledAt: string;
  readonly trialId: string | null;
  /** Conservatively charged requests; unknown interrupted work charges its reservation. */
  readonly requestsCharged: number;
  /** Provider-reported cost remains null when the provider did not report it. */
  readonly reportedCostUsd: number | null;
  /** Known cost or the pre-call reservation retained for unknown outcomes. */
  readonly costChargedUsd: number;
  readonly failureCode: string | null;
}

function exact(
  value: unknown,
  label: string,
  keys: readonly string[],
): Record<string, unknown> {
  const record = contractRecord(value, label);
  contractExact(record, keys, label);
  return record;
}

export function parseCompanyBenchmarkSlotReservation(
  value: unknown,
): CompanyBenchmarkSlotReservationV1 {
  const item = exact(value, "Company benchmark slot reservation", [
    "id",
    "version",
    "campaignId",
    "slotId",
    "attempt",
    "reservedAt",
    "requestAllowance",
    "reportedCostAllowanceUsd",
  ]);
  if (item.version !== 1 || item.attempt !== 1) {
    throw new TypeError(
      "Company benchmark slot reservation version or attempt is unsupported",
    );
  }
  return contractDeepFreeze({
    id: contractId(item.id, "Company benchmark slot reservation id"),
    version: 1,
    campaignId: contractId(
      item.campaignId,
      "Company benchmark reservation campaign id",
    ),
    slotId: contractId(
      item.slotId,
      "Company benchmark reservation slot id",
    ),
    attempt: 1,
    reservedAt: contractTimestamp(
      item.reservedAt,
      "Company benchmark reservation timestamp",
    ),
    requestAllowance: contractInteger(
      item.requestAllowance,
      "Company benchmark reservation request allowance",
      1,
      MAX_REQUESTS,
    ),
    reportedCostAllowanceUsd: contractNumber(
      item.reportedCostAllowanceUsd,
      "Company benchmark reservation reported-cost allowance",
      0,
      MAX_REPORTED_COST_USD,
    ),
  }) as CompanyBenchmarkSlotReservationV1;
}

export function parseCompanyBenchmarkSlotSettlement(
  value: unknown,
): CompanyBenchmarkSlotSettlementV1 {
  const item = exact(value, "Company benchmark slot settlement", [
    "id",
    "version",
    "reservationId",
    "campaignId",
    "slotId",
    "status",
    "settledAt",
    "trialId",
    "requestsCharged",
    "reportedCostUsd",
    "costChargedUsd",
    "failureCode",
  ]);
  if (item.version !== 1) {
    throw new TypeError("Company benchmark slot settlement version is unsupported");
  }
  const status = contractEnum<CompanyBenchmarkSlotSettlementStatus>(
    item.status,
    SETTLEMENT_STATUSES,
    "Company benchmark slot settlement status",
  );
  const trialId = item.trialId === null
    ? null
    : contractId(item.trialId, "Company benchmark settlement trial id");
  const failureCode = item.failureCode === null
    ? null
    : contractId(
      item.failureCode,
      "Company benchmark settlement failure code",
    );
  if ((status === "completed") !== (trialId !== null) ||
    (status === "completed") !== (failureCode === null)) {
    throw new TypeError(
      "Company benchmark slot settlement outcome is inconsistent",
    );
  }
  const reportedCostUsd = item.reportedCostUsd === null
    ? null
    : contractNumber(
      item.reportedCostUsd,
      "Company benchmark settlement reported cost",
      0,
      MAX_OBSERVED_COST_USD,
    );
  return contractDeepFreeze({
    id: contractId(item.id, "Company benchmark slot settlement id"),
    version: 1,
    reservationId: contractId(
      item.reservationId,
      "Company benchmark settlement reservation id",
    ),
    campaignId: contractId(
      item.campaignId,
      "Company benchmark settlement campaign id",
    ),
    slotId: contractId(item.slotId, "Company benchmark settlement slot id"),
    status,
    settledAt: contractTimestamp(
      item.settledAt,
      "Company benchmark settlement timestamp",
    ),
    trialId,
    requestsCharged: contractInteger(
      item.requestsCharged,
      "Company benchmark settlement charged requests",
      0,
      MAX_REQUESTS,
    ),
    reportedCostUsd,
    costChargedUsd: contractNumber(
      item.costChargedUsd,
      "Company benchmark settlement charged cost",
      0,
      MAX_OBSERVED_COST_USD,
    ),
    failureCode,
  }) as CompanyBenchmarkSlotSettlementV1;
}

export function validateCompanyBenchmarkSlotSettlement(
  settlement: CompanyBenchmarkSlotSettlementV1,
  reservation: CompanyBenchmarkSlotReservationV1,
): void {
  if (
    settlement.reservationId !== reservation.id ||
    settlement.campaignId !== reservation.campaignId ||
    settlement.slotId !== reservation.slotId ||
    Date.parse(settlement.settledAt) < Date.parse(reservation.reservedAt) ||
    (settlement.status !== "overrun" &&
      settlement.requestsCharged > reservation.requestAllowance) ||
    (settlement.status !== "overrun" &&
      settlement.costChargedUsd > reservation.reportedCostAllowanceUsd) ||
    settlement.reportedCostUsd !== null &&
      settlement.reportedCostUsd > settlement.costChargedUsd
  ) {
    throw new TypeError(
      "Company benchmark slot settlement exceeds or mismatches its reservation",
    );
  }
}
