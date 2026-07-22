import { createHash } from "node:crypto";

import {
  COMPANY_EVALUATION_DIMENSIONS,
  parseCompanyEvaluationReport,
  type CompanyEvaluationDimension,
  type CompanyEvaluationReportV1,
  type CompanyEvaluationRubricStatus,
} from "@recurs/contracts";

const secretPatterns = [
  /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{16,}\b/giu,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/giu,
] as const;
const encoder = new TextEncoder();

function bounded(value: string, maximum = 2_000): string {
  let sanitized = value.slice(0, 100_000).trim();
  for (const pattern of secretPatterns) sanitized = sanitized.replace(pattern, "[REDACTED]");
  if (sanitized.length === 0) sanitized = "No safe detail was reported.";
  if (encoder.encode(sanitized).byteLength <= maximum) return sanitized;
  let output = "";
  let size = encoder.encode(" [truncated]").byteLength;
  for (const character of sanitized) {
    const characterSize = encoder.encode(character).byteLength;
    if (size + characterSize > maximum) break;
    output += character;
    size += characterSize;
  }
  return `${output.trimEnd()} [truncated]`;
}

export function sanitizeCompanyEvaluationText(value: string): string {
  return bounded(value);
}

export interface CompanyEvaluationReportInput {
  readonly scenarioId: string;
  readonly mode: "offline" | "configured";
  readonly startedAt: string;
  readonly completedAt: string;
  readonly backend: {
    readonly providerId: string;
    readonly modelId: string;
    readonly fingerprint: string;
  };
  readonly usage: {
    readonly requestsUsed: number;
    readonly reportedCostUsd: number | null;
  };
  readonly rubric: Readonly<Record<CompanyEvaluationDimension, {
    readonly status: CompanyEvaluationRubricStatus;
    readonly evidence: readonly string[];
  }>>;
  readonly failures?: readonly {
    readonly code: string;
    readonly message: string;
  }[];
}

export function createCompanyEvaluationReport(
  input: CompanyEvaluationReportInput,
): CompanyEvaluationReportV1 {
  const failures = (input.failures ?? []).map((failure) => ({
    code: failure.code,
    message: bounded(failure.message),
  }));
  const rubric = COMPANY_EVALUATION_DIMENSIONS.map((dimension) => ({
    dimension,
    status: input.rubric[dimension].status,
    evidence: input.rubric[dimension].evidence.map((item) => bounded(item)),
  }));
  const status: CompanyEvaluationReportV1["status"] = failures.some(
      (failure) => failure.code === "cancelled"
    )
    ? "cancelled"
    : failures.length > 0 || rubric.some((item) => item.status === "failed")
      ? "failed"
      : rubric.some((item) => item.status === "unknown")
        ? "partial"
        : "passed";
  const started = new Date(input.startedAt).valueOf();
  const completed = new Date(input.completedAt).valueOf();
  if (!Number.isFinite(started) || !Number.isFinite(completed)) {
    throw new TypeError("Company evaluation timestamps are invalid");
  }
  if (completed < started) {
    throw new TypeError("Company evaluation completion precedes its start");
  }
  const digest = createHash("sha256").update(JSON.stringify({
    scenarioId: input.scenarioId,
    mode: input.mode,
    startedAt: input.startedAt,
    backend: input.backend.fingerprint,
  })).digest("hex").slice(0, 32);
  return parseCompanyEvaluationReport({
    id: `evaluation_${digest}`,
    version: 1,
    scenarioId: input.scenarioId,
    scenarioVersion: 1,
    mode: input.mode,
    status,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    latencyMs: completed - started,
    backend: input.backend,
    usage: {
      requestsUsed: input.usage.requestsUsed,
      reportedCostUsd: input.usage.reportedCostUsd,
      source: input.usage.reportedCostUsd === null ? "unknown" : "provider",
    },
    rubric,
    failures,
  });
}
