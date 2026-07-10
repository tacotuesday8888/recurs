import type { SessionBackendPin } from "@recurs/contracts";

import { SessionStoreError } from "./session-store-error.js";
import type { SessionRecordV2 } from "./session-v2.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const actual = Object.keys(value).sort();
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => key in value) && actual.every((key) => allowed.has(key));
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 32) {
    return false;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item, depth + 1));
  }
  return isObject(value) &&
    Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

function isToolCall(value: unknown): boolean {
  return isObject(value) &&
    hasExactKeys(value, ["id", "name", "arguments"]) &&
    typeof value.id === "string" && value.id.length > 0 &&
    typeof value.name === "string" && value.name.length > 0 &&
    isJsonValue(value.arguments);
}

function isContinuationHandle(value: unknown): boolean {
  return isObject(value) &&
    hasExactKeys(
      value,
      [
        "kind", "id", "storageClass", "recursSessionId", "connectionId",
        "adapterId", "modelId", "backendFingerprint", "stateVersion",
        "originTurnId", "continuationSequence", "status",
      ],
      ["ownerInstanceId", "expiresAt"],
    ) && value.kind === "direct" && typeof value.id === "string" &&
    (value.storageClass === "persistent_broker" ||
      value.storageClass === "process_scoped") &&
    typeof value.recursSessionId === "string" &&
    typeof value.connectionId === "string" && typeof value.adapterId === "string" &&
    typeof value.modelId === "string" && typeof value.backendFingerprint === "string" &&
    Number.isSafeInteger(value.stateVersion) && (value.stateVersion as number) >= 0 &&
    typeof value.originTurnId === "string" &&
    Number.isSafeInteger(value.continuationSequence) &&
    (value.continuationSequence as number) >= 0 &&
    (value.status === "committed" || value.status === "uncertain") &&
    (value.ownerInstanceId === undefined || typeof value.ownerInstanceId === "string") &&
    (value.expiresAt === undefined || typeof value.expiresAt === "string");
}

function isModelMessage(value: unknown): boolean {
  if (!(isObject(value) &&
    hasExactKeys(
      value,
      ["id", "role", "content"],
      ["toolCallId", "toolCalls", "providerStateHandle"],
    ) && typeof value.id === "string" && value.id.length > 0 &&
    (value.role === "system" || value.role === "user" ||
      value.role === "assistant" || value.role === "tool") &&
    typeof value.content === "string" &&
    (value.toolCallId === undefined || typeof value.toolCallId === "string") &&
    (value.toolCalls === undefined ||
      (Array.isArray(value.toolCalls) && value.toolCalls.every(isToolCall))) &&
    (value.providerStateHandle === undefined ||
      isContinuationHandle(value.providerStateHandle)))) {
    return false;
  }
  if (value.role === "tool") {
    return typeof value.toolCallId === "string" &&
      value.toolCalls === undefined && value.providerStateHandle === undefined;
  }
  if (value.role === "assistant") {
    return value.toolCallId === undefined;
  }
  return value.toolCallId === undefined && value.toolCalls === undefined &&
    value.providerStateHandle === undefined;
}

function isUsage(value: unknown): boolean {
  if (!isObject(value) || !hasExactKeys(
    value,
    ["inputTokens", "outputTokens"],
    [
      "cachedInputTokens", "cacheWriteInputTokens", "reasoningTokens",
      "costUsd",
    ],
  )) {
    return false;
  }
  return Object.values(value).every((item) =>
    typeof item === "number" && Number.isFinite(item) && item >= 0
  );
}

const failureDomains = new Set([
  "connection", "auth", "catalog", "policy", "provider", "runtime",
  "storage", "tool",
]);
const failureCodes = new Set([
  "adapter_unavailable", "connection_not_found", "connection_invalid",
  "account_mismatch", "authentication_required", "authentication_failed",
  "authorization_denied", "credential_unavailable", "credential_store_locked",
  "secure_storage_unavailable", "model_unavailable", "model_incompatible",
  "rate_limited", "plan_limit_reached", "quota_exhausted", "context_overflow",
  "protocol_mismatch", "policy_blocked", "policy_stale",
  "billing_policy_blocked", "session_conflict", "continuation_incompatible",
  "continuation_uncertain", "runtime_capability_missing", "transport", "timeout",
  "cancelled", "invalid_response", "tool_failed", "runtime_failed",
]);
const failureActions = new Set([
  "reauthenticate", "select_connection", "select_model", "confirm_billing",
  "fork_session", "unlock_store", "wait",
]);

function isIntegrationFailure(value: unknown): boolean {
  return isObject(value) &&
    hasExactKeys(
      value,
      ["domain", "phase", "code", "safeMessage", "diagnosticId", "retryable"],
      ["retryAfterMs", "action"],
    ) && typeof value.domain === "string" && failureDomains.has(value.domain) &&
    (value.phase === "preflight" || value.phase === "started") &&
    typeof value.code === "string" && failureCodes.has(value.code) &&
    typeof value.safeMessage === "string" &&
    typeof value.diagnosticId === "string" &&
    typeof value.retryable === "boolean" &&
    (value.retryAfterMs === undefined ||
      (Number.isSafeInteger(value.retryAfterMs) && (value.retryAfterMs as number) >= 0)) &&
    (value.action === undefined ||
      (typeof value.action === "string" && failureActions.has(value.action)));
}

function isToolResult(value: unknown): boolean {
  return isObject(value) &&
    hasExactKeys(value, ["output"], ["metadata"]) &&
    typeof value.output === "string" &&
    (value.metadata === undefined || isJsonValue(value.metadata));
}

function isPermissionIntent(value: unknown): boolean {
  return isObject(value) &&
    hasExactKeys(value, ["category", "resource", "risk"]) &&
    typeof value.category === "string" &&
    new Set([
      "read", "write", "shell", "network", "external_path", "sensitive",
      "credential", "deploy",
    ]).has(value.category) &&
    typeof value.resource === "string" &&
    (value.risk === "normal" || value.risk === "elevated" ||
      value.risk === "destructive");
}

function isRunResult(value: unknown): boolean {
  return isObject(value) &&
    hasExactKeys(value, [
      "finalText", "usage", "usageSource", "steps", "changedFiles",
      "changedFilesSource", "evidence", "evidenceSource",
    ]) && typeof value.finalText === "string" &&
    (value.usage === null || isUsage(value.usage)) &&
    (value.usageSource === "provider" || value.usageSource === "runtime" ||
      value.usageSource === "unavailable") &&
    (value.steps === null ||
      (Number.isSafeInteger(value.steps) && (value.steps as number) >= 0)) &&
    strings(value.changedFiles) &&
    (value.changedFilesSource === "host_tools" ||
      value.changedFilesSource === "runtime" ||
      value.changedFilesSource === "workspace_diff") &&
    strings(value.evidence) &&
    (value.evidenceSource === "host_tools" || value.evidenceSource === "runtime" ||
      value.evidenceSource === "independent_verification" ||
      value.evidenceSource === "none");
}

function isGoal(value: unknown): boolean {
  return isObject(value) &&
    hasExactKeys(
      value,
      [
        "objective", "status", "createdAt", "updatedAt", "progress",
        "blockers", "evidence",
      ],
      ["stepBudget", "tokenBudget", "timeBudgetMs"],
    ) && typeof value.objective === "string" &&
    (value.status === "active" || value.status === "paused" ||
      value.status === "completed" || value.status === "failed" ||
      value.status === "cancelled") &&
    typeof value.createdAt === "string" && typeof value.updatedAt === "string" &&
    typeof value.progress === "string" && strings(value.blockers) &&
    strings(value.evidence) &&
    [value.stepBudget, value.tokenBudget, value.timeBudgetMs].every((budget) =>
      budget === undefined ||
      (typeof budget === "number" && Number.isSafeInteger(budget) && budget > 0)
    );
}

const billingSources = new Set([
  "metered_api",
  "included_subscription",
  "prepaid_credits",
  "cloud_account",
  "local_compute",
]);

function isBillingSelection(value: unknown): boolean {
  return isObject(value) &&
    hasExactKeys(value, [
      "mode",
      "policyRevision",
      "disclosureRevision",
      "allowedSources",
      "acknowledgedAt",
    ]) &&
    (value.mode === "provider_default" ||
      value.mode === "strict_primary_only" ||
      value.mode === "allow_declared_additional") &&
    typeof value.policyRevision === "string" &&
    typeof value.disclosureRevision === "string" &&
    strings(value.allowedSources) &&
    value.allowedSources.every((source) => billingSources.has(source)) &&
    typeof value.acknowledgedAt === "string";
}

function isBackendPin(value: unknown): value is SessionBackendPin {
  if (!isObject(value)) {
    return false;
  }
  return hasExactKeys(value, [
    "kind",
    "providerId",
    "adapterId",
    "connectionId",
    "modelId",
    "modelIdentityKind",
    "providerResolvedModelRevisionAtCreation",
    "catalogRevision",
    "policyRevisionAtCreation",
    "billingPolicyRevisionAtCreation",
    "primaryBillingSourceAtCreation",
    "billingSelectionAtCreation",
    "accountSubjectFingerprint",
  ]) &&
    (value.kind === "model_provider" || value.kind === "agent_runtime") &&
    typeof value.providerId === "string" &&
    typeof value.adapterId === "string" &&
    typeof value.connectionId === "string" &&
    typeof value.modelId === "string" &&
    (value.modelIdentityKind === "versioned" ||
      value.modelIdentityKind === "mutable_alias" ||
      value.modelIdentityKind === "router") &&
    (value.providerResolvedModelRevisionAtCreation === null ||
      typeof value.providerResolvedModelRevisionAtCreation === "string") &&
    (value.catalogRevision === null || typeof value.catalogRevision === "string") &&
    typeof value.policyRevisionAtCreation === "string" &&
    typeof value.billingPolicyRevisionAtCreation === "string" &&
    typeof value.primaryBillingSourceAtCreation === "string" &&
    billingSources.has(value.primaryBillingSourceAtCreation) &&
    isBillingSelection(value.billingSelectionAtCreation) &&
    typeof value.accountSubjectFingerprint === "string";
}

const base = ["version", "sessionId", "sequence", "at", "type"] as const;

function validBase(value: Record<string, unknown>, sessionId: string): boolean {
  return value.version === 2 &&
    value.sessionId === sessionId &&
    Number.isSafeInteger(value.sequence) &&
    (value.sequence as number) >= 0 &&
    typeof value.at === "string" &&
    typeof value.type === "string";
}

function recordKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  return hasExactKeys(value, [...base, ...required], optional);
}

export function parseSessionRecordV2(
  value: unknown,
  sessionId: string,
): SessionRecordV2 {
  if (!isObject(value) || !validBase(value, sessionId)) {
    throw new SessionStoreError("invalid_record", "Invalid version 2 record base");
  }
  let valid = false;
  switch (value.type) {
    case "session_created":
      valid = recordKeys(value, ["cwd", "backend"]) &&
        typeof value.cwd === "string" &&
        isBackendPin(value.backend);
      break;
    case "turn_started":
      valid = recordKeys(value, ["turnId", "prompt"]) &&
        typeof value.turnId === "string" &&
        typeof value.prompt === "string";
      break;
    case "model_completed":
      valid = recordKeys(value, ["turnId", "message", "usage", "stopReason"]) &&
        typeof value.turnId === "string" && isModelMessage(value.message) &&
        (value.usage === null || isUsage(value.usage)) &&
        (value.stopReason === "complete" || value.stopReason === "tool_calls" ||
          value.stopReason === "length" || value.stopReason === "cancelled" ||
          value.stopReason === "error");
      break;
    case "tool_started":
      valid = recordKeys(value, ["turnId", "call"]) &&
        typeof value.turnId === "string" && isToolCall(value.call);
      break;
    case "tool_completed":
      valid = recordKeys(value, ["turnId", "callId", "result"]) &&
        typeof value.turnId === "string" && typeof value.callId === "string" &&
        isToolResult(value.result);
      break;
    case "tool_failed":
      valid = recordKeys(value, ["turnId", "callId", "error"]) &&
        typeof value.turnId === "string" && typeof value.callId === "string" &&
        isIntegrationFailure(value.error);
      break;
    case "permission_resolved":
      valid = recordKeys(value, ["turnId", "intent", "decision"]) &&
        typeof value.turnId === "string" && isObject(value.intent) &&
        isPermissionIntent(value.intent) &&
        (value.decision === "allow_once" || value.decision === "allow_session" ||
          value.decision === "deny" || value.decision === "allowed_by_policy");
      break;
    case "goal_updated":
      valid = recordKeys(
        value,
        ["source", "goal"],
        value.source === "turn" ? ["turnId"] : [],
      ) && (value.source === "command" || value.source === "turn") &&
        (value.goal === null || isGoal(value.goal)) &&
        (value.source === "command" || typeof value.turnId === "string");
      break;
    case "mode_updated":
      valid = recordKeys(
        value,
        ["source", "executionMode", "permissionMode"],
        value.source === "turn"
          ? ["turnId", "prePlanPermissionMode"]
          : ["prePlanPermissionMode"],
      ) && (value.source === "command" || value.source === "turn") &&
        (value.executionMode === "act" || value.executionMode === "plan") &&
        (value.permissionMode === "ask_always" ||
          value.permissionMode === "approved_for_me" ||
          value.permissionMode === "full_access") &&
        (value.source === "command" || typeof value.turnId === "string");
      break;
    case "files_changed":
      valid = recordKeys(value, ["turnId", "paths"]) &&
        typeof value.turnId === "string" && strings(value.paths);
      break;
    case "verification_recorded":
      valid = recordKeys(value, ["turnId", "evidence"]) &&
        typeof value.turnId === "string" && strings(value.evidence);
      break;
    case "turn_completed":
      valid = recordKeys(value, ["turnId", "result"]) &&
        typeof value.turnId === "string" && isRunResult(value.result);
      break;
    case "turn_failed":
      valid = recordKeys(value, ["turnId", "error"]) &&
        typeof value.turnId === "string" && isIntegrationFailure(value.error);
      break;
    case "turn_cancelled":
    case "turn_interrupted":
      valid = recordKeys(value, ["turnId", "reason"]) &&
        typeof value.turnId === "string" && typeof value.reason === "string";
      break;
    case "compaction_started":
      valid = recordKeys(value, ["operationId", "inputBaseSequence"]) &&
        typeof value.operationId === "string" &&
        Number.isSafeInteger(value.inputBaseSequence) &&
        (value.inputBaseSequence as number) >= 0;
      break;
    case "session_compacted":
      valid = recordKeys(value, [
        "operationId", "inputBaseSequence", "baseSequence", "summary",
        "retainedTurnIds", "usage", "usageSource",
      ]) && typeof value.operationId === "string" &&
        Number.isSafeInteger(value.inputBaseSequence) &&
        (value.inputBaseSequence as number) >= 0 &&
        Number.isSafeInteger(value.baseSequence) && (value.baseSequence as number) >= 0 &&
        typeof value.summary === "string" &&
        strings(value.retainedTurnIds) && (value.usage === null || isUsage(value.usage)) &&
        (value.usageSource === "provider" || value.usageSource === "unavailable");
      break;
    case "compaction_failed":
      valid = recordKeys(value, ["operationId", "error", "usage", "usageSource"]) &&
        typeof value.operationId === "string" && isIntegrationFailure(value.error) &&
        (value.usage === null || isUsage(value.usage)) &&
        (value.usageSource === "provider" ||
          value.usageSource === "unavailable" || value.usageSource === "unknown");
      break;
    case "compaction_interrupted":
      valid = recordKeys(value, ["operationId", "reason", "usage", "usageSource"]) &&
        typeof value.operationId === "string" && typeof value.reason === "string" &&
        value.usage === null && value.usageSource === "unknown";
      break;
  }
  if (!valid) {
    throw new SessionStoreError(
      "invalid_record",
      `Invalid version 2 ${String(value.type)} record`,
    );
  }
  return value as unknown as SessionRecordV2;
}
