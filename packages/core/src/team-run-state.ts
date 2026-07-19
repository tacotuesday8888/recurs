import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  getOperatingModePolicy,
  parseOperatingModeId,
  type ProviderUsage,
  type TeamReviewFinding,
  type TeamRunDescriptor,
  type TeamRunNonApprovedTerminalStatus,
  type TeamRunPhase,
  type TeamRunRole,
} from "@recurs/contracts";

import type { GitPatchArtifactHandle } from "./git-patch-artifacts.js";
import { isCredentialPath } from "@recurs/tools";
import {
  boundedNonEmptyString,
  canonicalIso,
  hasExactKeys,
  isBackendPin,
  isObject,
  isUsage,
} from "./session-record-validator.js";
import { SessionStoreError } from "./session-store-error.js";
import { compareStrings } from "./stable-order.js";

const MAX_DESCRIPTION_BYTES = 1_024;
const MAX_PROMPT_BYTES = 32_768;
const MAX_TEXT_BYTES = 16_384;
const MAX_EVIDENCE = 64;
const MAX_FINDINGS = 12;
const MAX_FINDING_EVIDENCE = 8;
const MAX_PATHS = 256;
const MAX_PATH_BYTES = 4_096;
const MAX_PATCH_BYTES = 1024 * 1024;
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_REPORTED_COST_USD = 1_000_000_000;
const GIT_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_RUNTIME_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

export interface TeamRunChildReservation {
  readonly attemptId: string;
  readonly role: TeamRunRole;
  readonly index: number;
  readonly round: number;
  readonly childAgentId: string;
  readonly childSessionId: string;
  readonly requestAllowance: number;
  readonly taskId?: string;
  readonly workspaceLeaseId?: string;
  readonly assignmentSha256?: string;
}

export interface TeamRunChildRecord {
  readonly attemptId: string;
  readonly status: "completed" | "failed" | "cancelled";
  readonly requestsUsed: number;
  readonly usage: ProviderUsage | null;
  readonly usageSource: "provider" | "runtime" | "unavailable";
  readonly changedFiles: readonly string[];
  readonly evidence: readonly string[];
  readonly failure: { readonly code: string; readonly message: string } | null;
}

export interface TeamRunReviewRecord {
  readonly round: number;
  readonly verdict: "approved" | "changes_requested" | "unverified";
  readonly findings: readonly TeamReviewFinding[];
  readonly evidence: readonly string[];
}

export interface TeamRunReviewState extends TeamRunReviewRecord {
  readonly claimEpoch: number;
}

export interface TeamRunArtifactLink {
  readonly kind: "worker" | "staged_candidate";
  readonly handle: GitPatchArtifactHandle;
  readonly round: number;
  readonly attemptId: string | null;
}

export interface CheckpointRef {
  readonly id: string;
  readonly sessionId: string;
  readonly toolCallId: string;
}

export interface TeamRunOutcome {
  readonly changedFiles: readonly string[];
  readonly evidence: readonly string[];
  readonly failure: { readonly code: string; readonly message: string } | null;
}

export type TeamRunRecordInput =
  | {
      readonly type: "run_claimed";
      readonly ownerId: string;
      readonly claimEpoch: number;
      readonly at: string;
    }
  | {
      readonly type: "phase_started";
      readonly phase: TeamRunPhase;
      readonly round: number;
      readonly at: string;
    }
  | {
      readonly type: "child_reserved";
      readonly child: TeamRunChildReservation;
      readonly at: string;
    }
  | {
      readonly type: "child_finished";
      readonly child: TeamRunChildRecord;
      readonly at: string;
    }
  | {
      readonly type: "artifact_linked";
      readonly artifact: TeamRunArtifactLink;
      readonly at: string;
    }
  | {
      readonly type: "review_recorded";
      readonly review: TeamRunReviewRecord;
      readonly at: string;
    }
  | {
      readonly type: "candidate_ready";
      readonly artifact: GitPatchArtifactHandle;
      readonly changedFiles: readonly string[];
      readonly at: string;
    }
  | {
      readonly type: "cancel_requested";
      readonly reason: string;
      readonly at: string;
    }
  | {
      readonly type: "apply_prepared";
      readonly checkpoint: CheckpointRef;
      readonly at: string;
    }
  | {
      readonly type: "apply_reset";
      readonly reason: "clean_base";
      readonly at: string;
    }
  | {
      readonly type: "apply_committed";
      readonly checkpoint: CheckpointRef;
      readonly changedFiles: readonly string[];
      readonly at: string;
    }
  | {
      readonly type: "run_interrupted";
      readonly reason: string;
      readonly manualAttentionRequired: boolean;
      readonly at: string;
    }
  | {
      readonly type: "run_terminal";
      readonly status: TeamRunNonApprovedTerminalStatus;
      readonly outcome: TeamRunOutcome;
      readonly at: string;
    };

export type TeamRunRecord =
  | {
      readonly version: 1;
      readonly runId: string;
      readonly sequence: 0;
      readonly at: string;
      readonly type: "team_created";
      readonly descriptor: TeamRunDescriptor;
    }
  | ({
      readonly version: 1;
      readonly runId: string;
      readonly sequence: number;
    } & TeamRunRecordInput);

export interface TeamRunChildState {
  readonly reservation: TeamRunChildReservation & { readonly claimEpoch: number };
  readonly result: TeamRunChildRecord | null;
}

export interface TeamRunAccounting {
  readonly childrenReserved: number;
  readonly childrenFinished: number;
  readonly requestsReserved: number;
  readonly requestsUsed: number;
  readonly usage: ProviderUsage | null;
  readonly usageReportedChildren: number;
  readonly usageMissingChildren: number;
  readonly reportedCostUsd: number | null;
  readonly costReportedChildren: number;
  readonly costMissingChildren: number;
  readonly costCoverage: "none" | "partial" | "complete";
}

export interface TeamRunState {
  readonly descriptor: TeamRunDescriptor;
  readonly status:
    | "created"
    | "running"
    | "ready_to_apply"
    | "applying"
    | "approved"
    | TeamRunNonApprovedTerminalStatus
    | "interrupted";
  readonly phase: TeamRunPhase | null;
  readonly round: number;
  readonly claim: { readonly ownerId: string; readonly claimEpoch: number } | null;
  readonly children: readonly TeamRunChildState[];
  readonly artifacts: readonly TeamRunArtifactLink[];
  readonly reviews: readonly TeamRunReviewState[];
  readonly candidate: {
    readonly artifact: GitPatchArtifactHandle;
    readonly changedFiles: readonly string[];
  } | null;
  readonly apply: {
    readonly checkpoint: CheckpointRef;
    readonly committed: boolean;
  } | null;
  readonly cancellation: { readonly reason: string; readonly at: string } | null;
  readonly interruption: {
    readonly reason: string;
    readonly manualAttentionRequired: boolean;
  } | null;
  readonly outcome: TeamRunOutcome | null;
  readonly accounting: TeamRunAccounting;
  readonly lastSequence: number;
  readonly updatedAt: string;
  readonly records: readonly TeamRunRecord[];
}

function invalid(message: string): never {
  throw new SessionStoreError("invalid_record", message);
}

function utf8(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === "string" && (allowEmpty || value.trim().length > 0) &&
    value === value.trim() && Buffer.byteLength(value, "utf8") <= maximum;
}

function integer(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function permission(value: unknown): value is TeamRunDescriptor["parentPermissionMode"] {
  return value === "ask_always" || value === "approved_for_me" ||
    value === "full_access";
}

function safePath(value: unknown): value is string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES || path.isAbsolute(value) ||
    value.includes("\\") || value.includes("\0")) {
    return false;
  }
  const parts = value.split("/");
  return !isCredentialPath(value) && parts.every((part) =>
    part.length > 0 && part !== "." && part !== ".." &&
    ![...part].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || (code >= 127 && code <= 159);
    }));
}

function boundedPaths(value: unknown, allowEmpty = true): value is string[] {
  if (!Array.isArray(value) || value.length > MAX_PATHS ||
    (!allowEmpty && value.length === 0) || !value.every(safePath)) {
    return false;
  }
  const unique = new Set(value);
  if (unique.size !== value.length) return false;
  const sorted = [...value].sort(compareStrings);
  return value.every((item, index) => item === sorted[index]);
}

function boundedEvidence(
  value: unknown,
  maximumItems = MAX_EVIDENCE,
  allowEmpty = true,
): value is string[] {
  return Array.isArray(value) && value.length <= maximumItems &&
    (allowEmpty || value.length > 0) && value.every((item) =>
      utf8(item, MAX_TEXT_BYTES)
    );
}

function exactFailure(value: unknown): value is { code: string; message: string } {
  return isObject(value) && hasExactKeys(value, ["code", "message"]) &&
    typeof value.code === "string" && SAFE_RUNTIME_ID.test(value.code) &&
    utf8(value.message, MAX_TEXT_BYTES);
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((item, index) => item === right[index]);
}

function exactArtifact(value: unknown): value is GitPatchArtifactHandle {
  return isObject(value) && hasExactKeys(value, [
    "id", "leaseId", "baseRevision", "sha256", "byteLength", "paths",
  ]) && typeof value.id === "string" && SAFE_ID.test(value.id) &&
    typeof value.leaseId === "string" && SAFE_ID.test(value.leaseId) &&
    typeof value.baseRevision === "string" && GIT_REVISION.test(value.baseRevision) &&
    typeof value.sha256 === "string" && SHA256.test(value.sha256) &&
    integer(value.byteLength, 1) && value.byteLength <= MAX_PATCH_BYTES &&
    boundedPaths(value.paths, false);
}

function exactCheckpoint(value: unknown): value is CheckpointRef {
  return isObject(value) && hasExactKeys(value, ["id", "sessionId", "toolCallId"]) &&
    typeof value.id === "string" && SAFE_RUNTIME_ID.test(value.id) &&
    typeof value.sessionId === "string" && SAFE_RUNTIME_ID.test(value.sessionId) &&
    typeof value.toolCallId === "string" && SAFE_RUNTIME_ID.test(value.toolCallId);
}

function exactFinding(value: unknown): value is TeamReviewFinding {
  return isObject(value) && hasExactKeys(value, [
    "path", "problem", "acceptance", "evidence",
  ]) && (value.path === "*" || safePath(value.path)) &&
    utf8(value.problem, MAX_TEXT_BYTES) && utf8(value.acceptance, MAX_TEXT_BYTES) &&
    boundedEvidence(value.evidence, MAX_FINDING_EVIDENCE, false);
}

function exactReview(value: unknown): value is TeamRunReviewRecord {
  if (!isObject(value) || !hasExactKeys(value, [
    "round", "verdict", "findings", "evidence",
  ]) || !integer(value.round) || !Array.isArray(value.findings) ||
    value.findings.length > MAX_FINDINGS || !value.findings.every(exactFinding) ||
    !boundedEvidence(value.evidence, MAX_EVIDENCE, false) ||
    (value.verdict !== "approved" && value.verdict !== "changes_requested" &&
      value.verdict !== "unverified")) {
    return false;
  }
  return value.verdict === "approved"
    ? value.findings.length === 0
    : value.verdict === "changes_requested"
      ? value.findings.length > 0
      : value.findings.length === 0;
}

function exactReservation(value: unknown): value is TeamRunChildReservation {
  if (!isObject(value)) return false;
  const legacyKeys = [
    "attemptId", "role", "index", "round", "childAgentId", "childSessionId",
    "requestAllowance",
  ];
  const bound = hasExactKeys(value, [
    ...legacyKeys,
    "taskId", "workspaceLeaseId", "assignmentSha256",
  ]);
  return (bound || hasExactKeys(value, legacyKeys)) &&
    typeof value.attemptId === "string" && SAFE_RUNTIME_ID.test(value.attemptId) &&
    (value.role === "implement" || value.role === "review" || value.role === "repair") &&
    integer(value.index, 1) && integer(value.round) &&
    typeof value.childAgentId === "string" && SAFE_RUNTIME_ID.test(value.childAgentId) &&
    typeof value.childSessionId === "string" && SAFE_RUNTIME_ID.test(value.childSessionId) &&
    integer(value.requestAllowance, 1) && (!bound || (
      typeof value.taskId === "string" && SAFE_RUNTIME_ID.test(value.taskId) &&
      typeof value.workspaceLeaseId === "string" && SAFE_ID.test(value.workspaceLeaseId) &&
      typeof value.assignmentSha256 === "string" && SHA256.test(value.assignmentSha256)
    ));
}

function exactTeamUsage(value: unknown): value is ProviderUsage {
  if (!isUsage(value) || !isObject(value)) return false;
  for (const key of [
    "inputTokens",
    "outputTokens",
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "reasoningTokens",
  ] as const) {
    const item = value[key];
    if (item !== undefined && (typeof item !== "number" ||
      !Number.isSafeInteger(item) || item < 0)) {
      return false;
    }
  }
  const cost = value.costUsd;
  return cost === undefined || (typeof cost === "number" &&
    cost <= MAX_REPORTED_COST_USD && Number.isFinite(cost));
}

function exactChildResult(value: unknown): value is TeamRunChildRecord {
  if (!isObject(value) || !hasExactKeys(value, [
    "attemptId", "status", "requestsUsed", "usage", "usageSource",
    "changedFiles", "evidence", "failure",
  ]) || typeof value.attemptId !== "string" ||
    !SAFE_RUNTIME_ID.test(value.attemptId) ||
    (value.status !== "completed" && value.status !== "failed" &&
      value.status !== "cancelled") || !integer(value.requestsUsed) ||
    (value.usage !== null && !exactTeamUsage(value.usage)) ||
    (value.usageSource !== "provider" && value.usageSource !== "runtime" &&
      value.usageSource !== "unavailable") ||
    (value.usage === null) !== (value.usageSource === "unavailable") ||
    !boundedPaths(value.changedFiles) || !boundedEvidence(value.evidence) ||
    (value.failure !== null && !exactFailure(value.failure))) {
    return false;
  }
  return value.status === "completed" ? value.failure === null : value.failure !== null;
}

function exactArtifactLink(value: unknown): value is TeamRunArtifactLink {
  return isObject(value) && hasExactKeys(value, [
    "kind", "handle", "round", "attemptId",
  ]) && (value.kind === "worker" || value.kind === "staged_candidate") &&
    exactArtifact(value.handle) && integer(value.round) &&
    (value.attemptId === null || (typeof value.attemptId === "string" &&
      SAFE_RUNTIME_ID.test(value.attemptId))) &&
    (value.kind === "worker" ? value.attemptId !== null : value.attemptId === null);
}

function exactOutcome(value: unknown): value is TeamRunOutcome {
  return isObject(value) && hasExactKeys(value, [
    "changedFiles", "evidence", "failure",
  ]) && boundedPaths(value.changedFiles) && boundedEvidence(value.evidence) &&
    (value.failure === null || exactFailure(value.failure));
}

function exactRoute(
  value: unknown,
  role: TeamRunRole,
  descriptor: TeamRunDescriptor,
): boolean {
  const expectedProfile = role === "implement"
    ? "implement_v2"
    : role === "review"
      ? "review_v2"
      : "repair_v1";
  if (!isObject(value) || !hasExactKeys(value, [
    "role", "profileId", "executionMode", "permissionMode", "strategy",
    "candidateId", "reason", "pin",
  ]) || value.role !== role || value.profileId !== expectedProfile ||
    value.executionMode !== "act" || value.permissionMode !== descriptor.parentPermissionMode ||
    (value.strategy !== "inherit_parent" && value.strategy !== "role_candidate") ||
    typeof value.candidateId !== "string" || !SAFE_RUNTIME_ID.test(value.candidateId) ||
    !isBackendPin(value.pin)) {
    return false;
  }
  if (value.strategy === "inherit_parent") {
    return value.reason === "parent_fallback" &&
      isDeepStrictEqual(value.pin, descriptor.backend);
  }
  return value.reason === "eligible_role_candidate";
}

function backgroundEligiblePin(pin: TeamRunDescriptor["backend"]): boolean {
  const safeSources = new Set(["local_compute", "metered_api"]);
  const selection = pin.billingSelectionAtCreation;
  return pin.kind === "model_provider" &&
    safeSources.has(pin.primaryBillingSourceAtCreation) &&
    selection.allowedSources.length > 0 &&
    selection.allowedSources.includes(pin.primaryBillingSourceAtCreation) &&
    selection.allowedSources.every((source) => safeSources.has(source));
}

function exactDescriptor(value: unknown, runId: string): value is TeamRunDescriptor {
  if (!isObject(value) || !hasExactKeys(value, [
    "id", "version", "parentSessionId", "parentAgentId", "execution",
    "parentExecutionMode", "parentPermissionMode", "invocation",
    "operatingModeId", "operatingModeVersion", "policy", "allocation", "routes",
    "backend", "repositoryRoot", "baseRevision", "request",
  ]) || value.id !== runId || typeof value.id !== "string" ||
    !SAFE_RUNTIME_ID.test(value.id) || value.version !== 1 ||
    typeof value.parentSessionId !== "string" ||
    !SAFE_RUNTIME_ID.test(value.parentSessionId) ||
    !boundedNonEmptyString(value.parentAgentId, 512) ||
    (value.execution !== "foreground" && value.execution !== "background") ||
    value.parentExecutionMode !== "act" || !permission(value.parentPermissionMode) ||
    !isObject(value.invocation) || !hasExactKeys(value.invocation, [
      "invocation", "presence", "location", "automation", "embedding",
    ]) || (value.invocation.invocation !== "repl" &&
      value.invocation.invocation !== "one_shot" && value.invocation.invocation !== "goal") ||
    (value.invocation.presence !== "present" && value.invocation.presence !== "unattended") ||
    (value.invocation.location !== "local" && value.invocation.location !== "remote") ||
    (value.invocation.automation !== "manual" && value.invocation.automation !== "scripted") ||
    (value.invocation.embedding !== "cli" && value.invocation.embedding !== "desktop" &&
      value.invocation.embedding !== "sdk" && value.invocation.embedding !== "ci") ||
    typeof value.operatingModeId !== "string" ||
    parseOperatingModeId(value.operatingModeId) !== value.operatingModeId ||
    !isBackendPin(value.backend) || typeof value.repositoryRoot !== "string" ||
    !path.isAbsolute(value.repositoryRoot) ||
    path.resolve(value.repositoryRoot) !== value.repositoryRoot ||
    Buffer.byteLength(value.repositoryRoot, "utf8") > MAX_PATH_BYTES ||
    typeof value.baseRevision !== "string" || !GIT_REVISION.test(value.baseRevision) ||
    !isObject(value.request) || !hasExactKeys(value.request, [
      "description", "tasks", "review",
    ]) || !utf8(value.request.description, MAX_DESCRIPTION_BYTES) ||
    !Array.isArray(value.request.tasks) || value.request.tasks.length === 0 ||
    !isObject(value.request.review) ||
    !hasExactKeys(value.request.review, ["instructions"]) ||
    !utf8(value.request.review.instructions, MAX_PROMPT_BYTES)) {
    return false;
  }

  const mode = getOperatingModePolicy(value.operatingModeId);
  if (mode.version < 4 || value.operatingModeVersion !== mode.version ||
    !isDeepStrictEqual(value.policy, mode) || mode.workflow.team === null ||
    mode.workflow.team.maxRepairRounds === undefined ||
    !isObject(value.allocation) || !hasExactKeys(value.allocation, [
      "maxChildren", "maxRequests", "requestAllowance", "maxReportedCostUsd",
    ]) || value.allocation.maxChildren !== mode.workflow.maxChildrenPerRun ||
    value.allocation.maxRequests !== mode.workflow.maxRequestsPerRun ||
    value.allocation.requestAllowance !== Math.floor(
      mode.workflow.maxRequestsPerRun / mode.workflow.maxChildrenPerRun,
    ) || value.allocation.maxReportedCostUsd !== mode.orchestration.maxReportedCostUsd ||
    value.request.tasks.length > mode.workflow.team.maxImplementers ||
    !value.request.tasks.every((task) =>
      isObject(task) && hasExactKeys(task, ["description", "prompt"]) &&
      utf8(task.description, MAX_DESCRIPTION_BYTES) &&
      utf8(task.prompt, MAX_PROMPT_BYTES)
    ) || !Array.isArray(value.routes) || value.routes.length !== 3) {
    return false;
  }
  const descriptor = value as unknown as TeamRunDescriptor;
  const exactRoutes = (["implement", "review", "repair"] as const).every((role) => {
    const matches = (value.routes as unknown[]).filter((route) =>
      isObject(route) && route.role === role
    );
    return matches.length === 1 && exactRoute(matches[0], role, descriptor);
  });
  if (!exactRoutes) return false;
  return descriptor.execution !== "background" || (
    descriptor.parentPermissionMode === "full_access" &&
    descriptor.invocation.presence === "present" &&
    descriptor.invocation.location === "local" &&
    descriptor.invocation.automation === "manual" &&
    descriptor.invocation.invocation !== "one_shot" &&
    backgroundEligiblePin(descriptor.backend) &&
    descriptor.routes.every((route) => backgroundEligiblePin(route.pin))
  );
}

const baseKeys = ["version", "runId", "sequence", "at", "type"] as const;

function keys(value: Record<string, unknown>, required: readonly string[]): boolean {
  return hasExactKeys(value, [...baseKeys, ...required]);
}

export function parseTeamRunRecord(
  value: unknown,
  expectedRunId: string,
): TeamRunRecord {
  if (!isObject(value) || value.version !== 1 || value.runId !== expectedRunId ||
    !integer(value.sequence) || !canonicalIso(value.at) || typeof value.type !== "string") {
    return invalid(`Invalid team run record for ${expectedRunId}`);
  }
  let recordBytes: number;
  try {
    recordBytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return invalid(`Invalid team run record for ${expectedRunId}`);
  }
  if (recordBytes > MAX_RECORD_BYTES) {
    invalid(`Team run record exceeds ${MAX_RECORD_BYTES} bytes`);
  }
  if (value.type === "team_created" && value.sequence !== 0) {
    invalid("team_created must appear at sequence zero");
  }
  if (value.type !== "team_created" && value.sequence === 0) {
    invalid(`${value.type} cannot appear at sequence zero`);
  }
  if (value.type === "review_recorded" && isObject(value.review) &&
    value.review.verdict === "approved" && Array.isArray(value.review.findings) &&
    value.review.findings.length > 0) {
    invalid("An approved review cannot contain findings");
  }
  let valid: boolean;
  switch (value.type) {
    case "team_created":
      valid = value.sequence === 0 && keys(value, ["descriptor"]) &&
        exactDescriptor(value.descriptor, expectedRunId);
      break;
    case "run_claimed":
      valid = value.sequence > 0 && keys(value, ["ownerId", "claimEpoch"]) &&
        typeof value.ownerId === "string" && SAFE_RUNTIME_ID.test(value.ownerId) &&
        integer(value.claimEpoch, 1);
      break;
    case "phase_started":
      valid = value.sequence > 0 && keys(value, ["phase", "round"]) &&
        (value.phase === "implement" || value.phase === "stage" ||
          value.phase === "review" || value.phase === "repair" ||
          value.phase === "apply") && integer(value.round);
      break;
    case "child_reserved":
      valid = value.sequence > 0 && keys(value, ["child"]) &&
        exactReservation(value.child);
      break;
    case "child_finished":
      valid = value.sequence > 0 && keys(value, ["child"]) &&
        exactChildResult(value.child);
      break;
    case "artifact_linked":
      valid = value.sequence > 0 && keys(value, ["artifact"]) &&
        exactArtifactLink(value.artifact);
      break;
    case "review_recorded":
      valid = value.sequence > 0 && keys(value, ["review"]) && exactReview(value.review);
      break;
    case "candidate_ready":
      valid = value.sequence > 0 && keys(value, ["artifact", "changedFiles"]) &&
        exactArtifact(value.artifact) && boundedPaths(value.changedFiles, false) &&
        samePaths(value.artifact.paths, value.changedFiles);
      break;
    case "cancel_requested":
      valid = value.sequence > 0 && keys(value, ["reason"]) &&
        utf8(value.reason, MAX_TEXT_BYTES);
      break;
    case "apply_prepared":
      valid = value.sequence > 0 && keys(value, ["checkpoint"]) &&
        exactCheckpoint(value.checkpoint);
      break;
    case "apply_reset":
      valid = value.sequence > 0 && keys(value, ["reason"]) &&
        value.reason === "clean_base";
      break;
    case "apply_committed":
      valid = value.sequence > 0 && keys(value, ["checkpoint", "changedFiles"]) &&
        exactCheckpoint(value.checkpoint) && boundedPaths(value.changedFiles, false);
      break;
    case "run_interrupted":
      valid = value.sequence > 0 && keys(value, ["reason", "manualAttentionRequired"]) &&
        utf8(value.reason, MAX_TEXT_BYTES) &&
        typeof value.manualAttentionRequired === "boolean";
      break;
    case "run_terminal":
      valid = value.sequence > 0 && keys(value, ["status", "outcome"]) &&
        (value.status === "changes_requested" || value.status === "unverified" ||
          value.status === "failed" || value.status === "cancelled") &&
        exactOutcome(value.outcome);
      break;
    default:
      valid = false;
  }
  if (!valid) return invalid(`Invalid team run ${value.type} record`);
  return deepFreeze(structuredClone(value)) as TeamRunRecord;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function zeroAccounting(): TeamRunAccounting {
  return {
    childrenReserved: 0,
    childrenFinished: 0,
    requestsReserved: 0,
    requestsUsed: 0,
    usage: null,
    usageReportedChildren: 0,
    usageMissingChildren: 0,
    reportedCostUsd: null,
    costReportedChildren: 0,
    costMissingChildren: 0,
    costCoverage: "none",
  };
}

function aggregateUsage(children: readonly TeamRunChildState[]): TeamRunAccounting {
  const finished = children.flatMap((child) => child.result === null ? [] : [child.result]);
  const reported = finished.filter((child) => child.usage !== null);
  const costs = reported.flatMap((child) => child.usage?.costUsd === undefined
    ? []
    : [child.usage.costUsd]);
  const checkedAdd = (left: number, right: number, label: string): number => {
    const total = left + right;
    if (!Number.isSafeInteger(total) || total < 0) {
      invalid(`Team ${label} accounting overflowed`);
    }
    return total;
  };
  const usage = reported.length === 0 ? null : reported.reduce<ProviderUsage>(
    (total, child) => {
      const next = child.usage!;
      const optional = (
        key: "cachedInputTokens" | "cacheWriteInputTokens" | "reasoningTokens",
      ): void => {
        if (next[key] !== undefined || total[key] !== undefined) {
          total[key] = checkedAdd(
            total[key] ?? 0,
            next[key] ?? 0,
            key,
          );
        }
      };
      total.inputTokens = checkedAdd(total.inputTokens, next.inputTokens, "input token");
      total.outputTokens = checkedAdd(total.outputTokens, next.outputTokens, "output token");
      optional("cachedInputTokens");
      optional("cacheWriteInputTokens");
      optional("reasoningTokens");
      return total;
    },
    { inputTokens: 0, outputTokens: 0 },
  );
  return {
    childrenReserved: children.length,
    childrenFinished: finished.length,
    requestsReserved: children.reduce(
      (sum, child) => sum + child.reservation.requestAllowance,
      0,
    ),
    requestsUsed: finished.reduce((sum, child) => sum + child.requestsUsed, 0),
    usage,
    usageReportedChildren: reported.length,
    usageMissingChildren: finished.length - reported.length,
    reportedCostUsd: costs.length === 0
      ? null
      : costs.reduce((sum, cost) => {
          const total = sum + cost;
          if (!Number.isFinite(total) || total > MAX_REPORTED_COST_USD) {
            invalid("Team reported-cost accounting overflowed");
          }
          return total;
        }, 0),
    costReportedChildren: costs.length,
    costMissingChildren: finished.length - costs.length,
    costCoverage: costs.length === 0
      ? "none"
      : costs.length === finished.length
        ? "complete"
        : "partial",
  };
}

function assertMutable(state: TeamRunState): void {
  if (state.status === "approved" || state.status === "changes_requested" ||
    state.status === "unverified" || state.status === "failed" ||
    state.status === "cancelled") {
    invalid(`Team run is terminal (${state.status})`);
  }
}

function latestReview(state: TeamRunState): TeamRunReviewState | null {
  return state.reviews.at(-1) ?? null;
}

function currentClaimReview(state: TeamRunState): TeamRunReviewState | null {
  const review = latestReview(state);
  return review?.claimEpoch === state.claim?.claimEpoch ? review : null;
}

function childrenFor(
  state: TeamRunState,
  role: TeamRunRole,
  round: number,
): readonly TeamRunChildState[] {
  return state.children.filter((child) =>
    child.reservation.role === role && child.reservation.round === round
  );
}

function latestChildrenFor(
  state: TeamRunState,
  role: TeamRunRole,
  round: number,
): readonly TeamRunChildState[] {
  const latest = new Map<number, TeamRunChildState>();
  for (const child of childrenFor(state, role, round)) {
    if (child.reservation.claimEpoch !== state.claim?.claimEpoch) continue;
    latest.set(child.reservation.index, child);
  }
  return [...latest.values()].sort((left, right) =>
    left.reservation.index - right.reservation.index
  );
}

function allCompleted(children: readonly TeamRunChildState[]): boolean {
  return children.length > 0 && children.every((child) =>
    child.result?.status === "completed"
  );
}

function allFinished(children: readonly TeamRunChildState[]): boolean {
  return children.length > 0 && children.every((child) => child.result !== null);
}

function workerReady(state: TeamRunState, index: number): boolean {
  const attempts = state.children.filter((child) =>
    child.reservation.role === "implement" && child.reservation.index === index &&
    child.reservation.claimEpoch === state.claim?.claimEpoch
  );
  const latest = attempts.at(-1);
  return latest?.result?.status === "completed" && state.artifacts.some((artifact) =>
    artifact.kind === "worker" &&
    artifact.attemptId === latest.reservation.attemptId
  );
}

function ensurePhase(state: TeamRunState, expected: TeamRunPhase): void {
  if (state.status !== "running" || state.phase !== expected) {
    invalid(`Team run is not in the ${expected} phase`);
  }
}

function cloneState(state: TeamRunState): {
  -readonly [K in keyof TeamRunState]: TeamRunState[K];
} {
  return structuredClone(state) as {
    -readonly [K in keyof TeamRunState]: TeamRunState[K];
  };
}

function initialState(record: Extract<TeamRunRecord, { type: "team_created" }>): TeamRunState {
  return deepFreeze({
    descriptor: structuredClone(record.descriptor),
    status: "created" as const,
    phase: null,
    round: 0,
    claim: null,
    children: [],
    artifacts: [],
    reviews: [],
    candidate: null,
    apply: null,
    cancellation: null,
    interruption: null,
    outcome: null,
    accounting: zeroAccounting(),
    lastSequence: 0,
    updatedAt: record.at,
    records: [record],
  });
}

function roleForPhase(phase: TeamRunPhase): TeamRunRole | null {
  return phase === "implement" ? "implement" : phase === "review" ? "review" :
    phase === "repair" ? "repair" : null;
}

export function reduceTeamRunRecord(
  current: TeamRunState,
  input: TeamRunRecord,
): TeamRunState {
  const record = parseTeamRunRecord(input, current.descriptor.id);
  if (record.sequence !== current.lastSequence + 1) {
    invalid(`Expected team run sequence ${current.lastSequence + 1}`);
  }
  if (Date.parse(record.at) < Date.parse(current.updatedAt)) {
    invalid("Team run timestamps must be monotonic");
  }
  if (record.type === "team_created") {
    invalid("team_created may appear only at sequence zero");
  }
  assertMutable(current);
  const state = cloneState(current);
  const children = [...state.children];
  const artifacts = [...state.artifacts];
  const reviews = [...state.reviews];

  switch (record.type) {
    case "run_claimed": {
      if (state.status === "created") {
        if (state.claim !== null || record.claimEpoch !== 1) {
          invalid("Initial team claim epoch must be 1");
        }
      } else if (state.status === "interrupted") {
        if (state.interruption?.manualAttentionRequired === true) {
          invalid("A manual attention run cannot be reclaimed");
        }
        if (record.claimEpoch !== (state.claim?.claimEpoch ?? 0) + 1) {
          invalid("Team claim epoch must increase exactly once");
        }
      } else {
        invalid("Team run already has an active claim");
      }
      state.claim = { ownerId: record.ownerId, claimEpoch: record.claimEpoch };
      state.interruption = null;
      break;
    }
    case "phase_started": {
      if (state.claim === null) invalid("Team run must be claimed before work");
      if (state.cancellation !== null) invalid("Cancelled team work cannot start");
      if (record.phase === "implement") {
        if (record.round !== 0 || (state.status !== "created" &&
          state.status !== "interrupted")) {
          invalid("Implement must start a created or resumed team run");
        }
      } else if (record.phase === "stage") {
        ensurePhase(current, "implement");
        if (record.round !== 0 || !current.descriptor.request.tasks.every(
          (_task, index) => workerReady(current, index + 1),
        )) {
          invalid("Stage requires every implementation artifact");
        }
      } else if (record.phase === "review") {
        if (record.round === 0) {
          ensurePhase(current, "stage");
        } else {
          ensurePhase(current, "repair");
          if (record.round !== current.round ||
            !allCompleted(latestChildrenFor(current, "repair", record.round))) {
            invalid("Review requires a completed repair round");
          }
        }
      } else if (record.phase === "repair") {
        ensurePhase(current, "review");
        const review = currentClaimReview(current);
        const maximum = current.descriptor.policy.workflow.team.maxRepairRounds;
        if (review?.verdict !== "changes_requested" ||
          record.round !== review.round + 1 || record.round > maximum) {
          invalid("Repair requires a bounded valid change request");
        }
      } else {
        if (state.status !== "ready_to_apply" || state.candidate === null ||
          record.round !== state.round) {
          invalid("Apply requires a ready candidate");
        }
      }
      state.status = record.phase === "apply" ? "applying" : "running";
      state.phase = record.phase;
      state.round = record.round;
      state.apply = null;
      break;
    }
    case "child_reserved": {
      if (state.cancellation !== null) invalid("Cancelled team work cannot start a child");
      const role = state.phase === null ? null : roleForPhase(state.phase);
      if (state.status !== "running" || role === null || record.child.role !== role ||
        record.child.round !== state.round) {
        invalid("Child role does not match the active team phase");
      }
      if (record.child.requestAllowance !== state.descriptor.allocation.requestAllowance) {
        invalid("Child request allowance does not match the frozen allocation");
      }
      if (children.some((child) =>
        child.reservation.attemptId === record.child.attemptId ||
        child.reservation.childAgentId === record.child.childAgentId ||
        child.reservation.childSessionId === record.child.childSessionId
      )) {
        invalid("Child attempt identity must be unique");
      }
      const sameIndex = childrenFor(state, record.child.role, record.child.round)
        .filter((child) => child.reservation.index === record.child.index);
      const sameIndexInClaim = sameIndex.filter((child) =>
        child.reservation.claimEpoch === state.claim?.claimEpoch
      );
      if (sameIndexInClaim.length > 0) {
        invalid("A child index can start only once per claim epoch");
      }
      const team = state.descriptor.policy.workflow.team;
      if ((role === "implement" && record.child.index > state.descriptor.request.tasks.length) ||
        (role === "review" && record.child.index > team.maxReviewers) ||
        (role === "repair" && record.child.index !== 1)) {
        invalid("Child index exceeds the frozen team policy");
      }
      const logical = latestChildrenFor(
        state,
        record.child.role,
        record.child.round,
      );
      if (record.child.index !== (logical.at(-1)?.reservation.index ?? 0) + 1) {
        invalid("New child indexes must be reserved sequentially");
      }
      if (state.accounting.childrenReserved + 1 > state.descriptor.allocation.maxChildren) {
        invalid("Team child limit reached");
      }
      if (state.accounting.requestsReserved + record.child.requestAllowance >
        state.descriptor.allocation.maxRequests) {
        invalid("Team request limit reached");
      }
      if (state.accounting.reportedCostUsd !== null &&
        state.accounting.reportedCostUsd >= state.descriptor.allocation.maxReportedCostUsd) {
        invalid("Team reported-cost limit reached");
      }
      children.push({
        reservation: { ...record.child, claimEpoch: state.claim!.claimEpoch },
        result: null,
      });
      state.children = children;
      break;
    }
    case "child_finished": {
      const index = children.findIndex((child) =>
        child.reservation.attemptId === record.child.attemptId
      );
      const found = children[index];
      if (found === undefined) invalid("Child must be reserved before it finishes");
      if (found.result !== null) invalid("Child attempt already has a terminal result");
      if (record.child.requestsUsed > found.reservation.requestAllowance) {
        invalid("Child requests exceed its reservation");
      }
      if (found.reservation.role === "review" &&
        record.child.changedFiles.length > 0) {
        invalid("Read-only review children cannot report changed files");
      }
      children[index] = { ...found, result: record.child };
      state.children = children;
      break;
    }
    case "artifact_linked": {
      if (record.artifact.handle.baseRevision !== state.descriptor.baseRevision ||
        artifacts.some((artifact) => artifact.handle.id === record.artifact.handle.id)) {
        invalid("Artifact base or identity does not match the team run");
      }
      if (record.artifact.kind === "worker") {
        ensurePhase(current, "implement");
        const child = children.find((candidate) =>
          candidate.reservation.attemptId === record.artifact.attemptId
        );
        if (child?.reservation.role !== "implement" ||
          child.reservation.claimEpoch !== current.claim?.claimEpoch ||
          child.reservation.round !== record.artifact.round ||
          record.artifact.round !== current.round ||
          child.result?.status !== "completed" ||
          !samePaths(child.result.changedFiles, record.artifact.handle.paths)) {
          invalid("Worker artifact requires a completed implementation attempt");
        }
      } else {
        ensurePhase(current, "review");
        if (currentClaimReview(current)?.verdict !== "approved" ||
          record.artifact.round !== current.round) {
          invalid("Staged candidate requires an approved review");
        }
      }
      artifacts.push(record.artifact);
      state.artifacts = artifacts;
      break;
    }
    case "review_recorded": {
      ensurePhase(current, "review");
      const reviewers = latestChildrenFor(
        current,
        "review",
        record.review.round,
      );
      const team = current.descriptor.policy.workflow.team;
      const priorInClaim = reviews.some((review) =>
        review.round === record.review.round &&
        review.claimEpoch === current.claim?.claimEpoch
      );
      const enoughReviewers = record.review.verdict === "approved"
        ? reviewers.length >= team.initialReviewers && allCompleted(reviewers)
        : record.review.verdict === "changes_requested"
          ? reviewers.length === team.maxReviewers && allCompleted(reviewers)
          : allFinished(reviewers);
      if (record.review.round !== current.round || priorInClaim ||
        !enoughReviewers) {
        invalid("Review requires completed reviewer children for the active round");
      }
      reviews.push({
        ...record.review,
        claimEpoch: current.claim!.claimEpoch,
      });
      state.reviews = reviews;
      break;
    }
    case "candidate_ready": {
      ensurePhase(current, "review");
      const linked = artifacts.find((artifact) =>
        artifact.kind === "staged_candidate" &&
        artifact.handle.id === record.artifact.id
      );
      if (currentClaimReview(current)?.verdict !== "approved" || linked === undefined ||
        !isDeepStrictEqual(linked.handle, record.artifact) ||
        !samePaths(record.changedFiles, record.artifact.paths)) {
        invalid("Candidate requires a linked artifact and approved review");
      }
      state.status = "ready_to_apply";
      state.candidate = {
        artifact: record.artifact,
        changedFiles: record.changedFiles,
      };
      break;
    }
    case "cancel_requested": {
      if (state.cancellation !== null) invalid("Cancellation was already requested");
      if (state.apply !== null && !state.apply.committed) {
        invalid("Prepared apply must be reconciled before cancellation");
      }
      state.cancellation = { reason: record.reason, at: record.at };
      break;
    }
    case "apply_prepared": {
      if (state.cancellation !== null) {
        invalid("A cancelled team run cannot prepare an apply");
      }
      if (state.status !== "applying" || state.phase !== "apply" ||
        state.candidate === null || state.apply !== null ||
        record.checkpoint.sessionId !== state.descriptor.parentSessionId ||
        record.checkpoint.toolCallId !== state.descriptor.id) {
        invalid("Apply preparation does not match the team run");
      }
      state.apply = { checkpoint: record.checkpoint, committed: false };
      break;
    }
    case "apply_reset": {
      if ((state.status !== "applying" && state.status !== "interrupted") ||
        state.phase !== "apply" || state.candidate === null ||
        state.cancellation !== null || state.apply?.committed === true) {
        invalid("Only an unresolved apply can reset to the clean base");
      }
      state.status = "ready_to_apply";
      state.apply = null;
      state.interruption = null;
      break;
    }
    case "apply_committed": {
      if ((state.status !== "applying" && state.status !== "interrupted") ||
        state.apply === null || state.cancellation !== null ||
        !isDeepStrictEqual(state.apply.checkpoint, record.checkpoint) ||
        state.candidate === null ||
        !samePaths(state.candidate.changedFiles, record.changedFiles)) {
        invalid("Apply commit does not match its prepared candidate");
      }
      state.status = "approved";
      state.apply = { checkpoint: record.checkpoint, committed: true };
      state.interruption = null;
      state.outcome = {
        changedFiles: record.changedFiles,
        evidence: [],
        failure: null,
      };
      break;
    }
    case "run_interrupted": {
      if (state.status === "interrupted") {
        invalid("Team run is already interrupted");
      }
      if (state.status === "ready_to_apply") {
        invalid("A stable ready candidate is not interrupted by restart");
      }
      if (state.apply !== null && !record.manualAttentionRequired) {
        invalid("An uncertain apply requires manual attention");
      }
      state.status = "interrupted";
      state.interruption = {
        reason: record.reason,
        manualAttentionRequired: record.manualAttentionRequired,
      };
      break;
    }
    case "run_terminal": {
      if (state.apply !== null && !state.apply.committed) {
        invalid("A prepared apply must be reconciled before terminalization");
      }
      const review = currentClaimReview(state);
      if (record.outcome.changedFiles.length > 0) {
        invalid("A non-approved team outcome cannot report parent changes");
      }
      if ((record.status === "failed" || record.status === "cancelled") &&
        record.outcome.failure === null) {
        invalid(`${record.status} team outcome requires a failure reason`);
      }
      if (record.status === "cancelled" && state.cancellation === null) {
        invalid("Cancelled terminal state requires durable cancellation intent");
      }
      if (record.status === "unverified" && review?.verdict !== "unverified") {
        invalid("Unverified terminal state requires an unverified review");
      }
      if (record.status === "changes_requested" && (
        review?.verdict !== "changes_requested" ||
        review.round < state.descriptor.policy.workflow.team.maxRepairRounds
      )) {
        invalid("Changes requested is terminal only after repair exhaustion");
      }
      state.status = record.status;
      state.outcome = record.outcome;
      break;
    }
  }

  state.accounting = aggregateUsage(state.children);
  state.lastSequence = record.sequence;
  state.updatedAt = record.at;
  state.records = [...state.records, record];
  return deepFreeze(state as TeamRunState);
}

export function reduceTeamRunRecords(records: readonly TeamRunRecord[]): TeamRunState {
  const first = records[0];
  if (first === undefined || first.type !== "team_created") {
    invalid("Team run log must begin with team_created");
  }
  const parsed = parseTeamRunRecord(first, first.runId);
  if (parsed.type !== "team_created") {
    invalid("Team run log must begin with team_created");
  }
  let state = initialState(parsed);
  for (const record of records.slice(1)) {
    state = reduceTeamRunRecord(state, record);
  }
  return state;
}
