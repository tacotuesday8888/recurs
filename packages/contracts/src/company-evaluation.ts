import {
  contractDeepFreeze,
  contractEnum,
  contractExact,
  contractId,
  contractInteger,
  contractNumber,
  contractRecord,
  contractText,
  contractTextArray,
  contractTimestamp,
} from "./company-contract-utils.js";

export const COMPANY_EVALUATION_DIMENSIONS = Object.freeze([
  "interview_quality",
  "blueprint_tailoring",
  "decomposition",
  "evidence",
  "synthesis",
  "efficiency",
] as const);

export type CompanyEvaluationDimension =
  (typeof COMPANY_EVALUATION_DIMENSIONS)[number];
export type CompanyEvaluationRubricStatus = "passed" | "failed" | "unknown" |
  "not_applicable";

export interface CompanyEvaluationRubricResultV1 {
  readonly dimension: CompanyEvaluationDimension;
  readonly status: CompanyEvaluationRubricStatus;
  readonly evidence: readonly string[];
}

export interface CompanyEvaluationReportV1 {
  readonly id: string;
  readonly version: 1;
  readonly scenarioId: string;
  readonly scenarioVersion: 1;
  readonly mode: "offline" | "configured";
  readonly status: "passed" | "partial" | "failed" | "cancelled";
  readonly startedAt: string;
  readonly completedAt: string;
  readonly latencyMs: number;
  readonly backend: {
    readonly providerId: string;
    readonly modelId: string;
    readonly fingerprint: string;
  };
  readonly usage: {
    readonly requestsUsed: number;
    readonly reportedCostUsd: number | null;
    readonly source: "provider" | "unknown";
  };
  readonly rubric: readonly CompanyEvaluationRubricResultV1[];
  readonly failures: readonly {
    readonly code: string;
    readonly message: string;
  }[];
}

const dimensions = new Set<string>(COMPANY_EVALUATION_DIMENSIONS);
const rubricStatuses = new Set<string>([
  "passed", "failed", "unknown", "not_applicable",
]);
const reportStatuses = new Set<string>([
  "passed", "partial", "failed", "cancelled",
]);

function rubricResult(value: unknown): CompanyEvaluationRubricResultV1 {
  const item = contractRecord(value, "Company evaluation rubric result");
  contractExact(item, ["dimension", "status", "evidence"], "Company evaluation rubric result");
  return {
    dimension: contractEnum<CompanyEvaluationDimension>(
      item.dimension,
      dimensions,
      "Company evaluation dimension",
    ),
    status: contractEnum<CompanyEvaluationRubricStatus>(
      item.status,
      rubricStatuses,
      "Company evaluation rubric status",
    ),
    evidence: contractTextArray(
      item.evidence,
      "Company evaluation evidence",
      16,
      2_000,
      false,
    ),
  };
}

export function parseCompanyEvaluationReport(
  value: unknown,
): CompanyEvaluationReportV1 {
  const report = contractRecord(value, "Company evaluation report");
  contractExact(report, [
    "id", "version", "scenarioId", "scenarioVersion", "mode", "status",
    "startedAt", "completedAt", "latencyMs", "backend", "usage", "rubric",
    "failures",
  ], "Company evaluation report");
  if (report.version !== 1 || report.scenarioVersion !== 1) {
    throw new TypeError("Company evaluation report version is unsupported");
  }
  const backend = contractRecord(report.backend, "Company evaluation backend");
  contractExact(backend, ["providerId", "modelId", "fingerprint"], "Company evaluation backend");
  const usage = contractRecord(report.usage, "Company evaluation usage");
  contractExact(usage, ["requestsUsed", "reportedCostUsd", "source"], "Company evaluation usage");
  if (!Array.isArray(report.rubric) || report.rubric.length !== dimensions.size) {
    throw new TypeError("Company evaluation rubric is incomplete");
  }
  const rubric = report.rubric.map(rubricResult);
  if (new Set(rubric.map((item) => item.dimension)).size !== dimensions.size) {
    throw new TypeError("Company evaluation rubric dimensions must be unique");
  }
  if (!Array.isArray(report.failures) || report.failures.length > 16) {
    throw new TypeError("Company evaluation failures are invalid");
  }
  const failures = report.failures.map((value) => {
    const item = contractRecord(value, "Company evaluation failure");
    contractExact(item, ["code", "message"], "Company evaluation failure");
    return {
      code: contractId(item.code, "Company evaluation failure code"),
      message: contractText(item.message, "Company evaluation failure message", 2_000),
    };
  });
  const usageSource = contractEnum<"provider" | "unknown">(
    usage.source,
    new Set(["provider", "unknown"]),
    "Company evaluation usage source",
  );
  const reportedCostUsd = usage.reportedCostUsd === null
    ? null
    : contractNumber(
        usage.reportedCostUsd,
        "Company evaluation reported cost",
        0,
        1_000_000,
      );
  if ((reportedCostUsd === null) !== (usageSource === "unknown")) {
    throw new TypeError("Company evaluation cost and usage source disagree");
  }
  const startedAt = contractTimestamp(report.startedAt, "Company evaluation start");
  const completedAt = contractTimestamp(
    report.completedAt,
    "Company evaluation completion",
  );
  if (Date.parse(completedAt) < Date.parse(startedAt)) {
    throw new TypeError("Company evaluation completion precedes its start");
  }
  const latencyMs = contractInteger(
    report.latencyMs,
    "Company evaluation latency",
    0,
  );
  if (latencyMs !== Date.parse(completedAt) - Date.parse(startedAt)) {
    throw new TypeError("Company evaluation latency is inconsistent");
  }
  const status = contractEnum<CompanyEvaluationReportV1["status"]>(
    report.status,
    reportStatuses,
    "Company evaluation status",
  );
  const expectedStatus: CompanyEvaluationReportV1["status"] = failures.some(
      (failure) => failure.code === "cancelled"
    )
    ? "cancelled"
    : failures.length > 0 || rubric.some((item) => item.status === "failed")
      ? "failed"
      : rubric.some((item) => item.status === "unknown")
        ? "partial"
        : "passed";
  if (status !== expectedStatus) {
    throw new TypeError("Company evaluation status is inconsistent");
  }
  return contractDeepFreeze({
    id: contractId(report.id, "Company evaluation report id"),
    version: 1,
    scenarioId: contractId(report.scenarioId, "Company evaluation scenario id"),
    scenarioVersion: 1,
    mode: contractEnum<"offline" | "configured">(
      report.mode,
      new Set(["offline", "configured"]),
      "Company evaluation mode",
    ),
    status,
    startedAt,
    completedAt,
    latencyMs,
    backend: {
      providerId: contractId(backend.providerId, "Company evaluation provider"),
      modelId: contractText(backend.modelId, "Company evaluation model", 256),
      fingerprint: contractId(backend.fingerprint, "Company evaluation backend fingerprint"),
    },
    usage: {
      requestsUsed: contractInteger(
        usage.requestsUsed,
        "Company evaluation request usage",
        0,
        10_000,
      ),
      reportedCostUsd,
      source: usageSource,
    },
    rubric,
    failures,
  });
}
