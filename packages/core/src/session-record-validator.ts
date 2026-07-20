import { Buffer } from "node:buffer";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";

import {
  getOperatingModePolicy,
  getAgentProfilePolicy,
  MAX_PENDING_QUEUED_TURNS,
  MAX_QUEUED_TURN_BYTES,
  narrowAgentPermissionMode,
  parseAgentProfileId,
  parseOperatingModeId,
} from "@recurs/contracts";
import type {
  AgentSessionDescriptor,
  ModelMessage,
  RuntimeApprovalDecision,
  RuntimeApprovalRequest,
  RuntimeContinuationHandle,
  SessionBackendPin,
} from "@recurs/contracts";

import { SessionStoreError } from "./session-store-error.js";
import type { SessionRecordV2 } from "./session-v2.js";

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasExactKeys(
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

const MAX_RUNTIME_ID_LENGTH = 512;
const MAX_RUNTIME_TEXT_LENGTH = 262_144;
const MAX_RUNTIME_ITEM_LENGTH = 16_384;
const MAX_RUNTIME_ITEMS = 1_024;
const MAX_RUNTIME_APPROVAL_OPTIONS = 64;
const MAX_RUNTIME_JSON_DEPTH = 16;
const MAX_RUNTIME_JSON_NODES = 4_096;
const MAX_RUNTIME_JSON_CHARACTERS = 131_072;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const GIT_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const LEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length <= maximum;
}

export function boundedNonEmptyString(
  value: unknown,
  maximum: number,
): value is string {
  return boundedString(value, maximum) &&
    value.length > 0 && value === value.trim();
}

function boundedStrings(
  value: unknown,
  maximumItems = MAX_RUNTIME_ITEMS,
): value is string[] {
  return Array.isArray(value) && value.length <= maximumItems &&
    value.every((item) => boundedNonEmptyString(item, MAX_RUNTIME_ITEM_LENGTH));
}

function boundedNonEmptyUtf8(
  value: unknown,
  maximumBytes: number,
): value is string {
  return typeof value === "string" && value.length > 0 &&
    value === value.trim() && Buffer.byteLength(value, "utf8") <= maximumBytes;
}

interface JsonBudget {
  nodes: number;
  characters: number;
  readonly seen: WeakSet<object>;
}

function plainJsonEntries(
  value: object,
  maximumItems: number,
): readonly (readonly [string, unknown])[] | null {
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      return null;
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length > maximumItems ||
      keys.some((key) => typeof key !== "string")) {
      return null;
    }
    const entries: [string, unknown][] = [];
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable ||
        !("value" in descriptor)) {
        return null;
      }
      entries.push([key, descriptor.value]);
    }
    return entries;
  } catch {
    return null;
  }
}

function plainJsonArrayItems(
  value: readonly unknown[],
  maximumItems: number,
): readonly unknown[] | null {
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > maximumItems) {
      return null;
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 ||
      keys.some((key) => typeof key !== "string")) {
      return null;
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (lengthDescriptor === undefined || !("value" in lengthDescriptor) ||
      lengthDescriptor.value !== value.length) {
      return null;
    }
    const items: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !descriptor.enumerable ||
        !("value" in descriptor)) {
        return null;
      }
      items.push(descriptor.value);
    }
    return items;
  } catch {
    return null;
  }
}

function isBoundedJsonValue(
  value: unknown,
  budget: JsonBudget,
  depth = 0,
): boolean {
  budget.nodes += 1;
  if (depth > MAX_RUNTIME_JSON_DEPTH || budget.nodes > MAX_RUNTIME_JSON_NODES) {
    return false;
  }
  if (value === null || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) && !Object.is(value, -0);
  }
  if (typeof value === "string") {
    budget.characters += value.length;
    return value.length <= MAX_RUNTIME_ITEM_LENGTH &&
      budget.characters <= MAX_RUNTIME_JSON_CHARACTERS;
  }
  if (typeof value !== "object" || value === null || budget.seen.has(value)) {
    return false;
  }
  budget.seen.add(value);
  if (Array.isArray(value)) {
    const items = plainJsonArrayItems(value, MAX_RUNTIME_ITEMS);
    return items !== null &&
      items.every((item) => isBoundedJsonValue(item, budget, depth + 1));
  }
  const entries = plainJsonEntries(value, MAX_RUNTIME_ITEMS);
  if (entries === null) {
    return false;
  }
  for (const [key, item] of entries) {
    budget.characters += key.length;
    if (
      !boundedNonEmptyString(key, MAX_RUNTIME_ID_LENGTH) ||
      budget.characters > MAX_RUNTIME_JSON_CHARACTERS ||
      !isBoundedJsonValue(item, budget, depth + 1)
    ) {
      return false;
    }
  }
  return true;
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

function isDirectContinuationHandle(value: unknown): boolean {
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

export function canonicalIso(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value;
}

function canonicalExpiryAfterRecord(value: unknown, at: unknown): boolean {
  return canonicalIso(value) && canonicalIso(at) &&
    Date.parse(value) > Date.parse(at);
}

function isRuntimeContinuationHandle(
  value: unknown,
  at: unknown,
  allowExpired = false,
): value is RuntimeContinuationHandle {
  if (!(isObject(value) && hasExactKeys(
    value,
    [
      "kind", "id", "storageClass", "recursSessionId", "connectionId",
      "adapterId", "modelId", "backendFingerprint", "stateVersion",
      "originTurnId", "continuationSequence", "status",
      "vendorTurnSequence",
    ],
    ["ownerInstanceId", "expiresAt"],
  ))) {
    return false;
  }
  if (
    value.kind !== "runtime" ||
    (value.storageClass !== "persistent_broker" &&
      value.storageClass !== "process_scoped") ||
    !boundedNonEmptyString(value.id, MAX_RUNTIME_ID_LENGTH) ||
    !boundedNonEmptyString(value.recursSessionId, MAX_RUNTIME_ID_LENGTH) ||
    !boundedNonEmptyString(value.connectionId, MAX_RUNTIME_ID_LENGTH) ||
    !boundedNonEmptyString(value.adapterId, MAX_RUNTIME_ID_LENGTH) ||
    !boundedNonEmptyString(value.modelId, MAX_RUNTIME_ID_LENGTH) ||
    typeof value.backendFingerprint !== "string" ||
    !SHA256_DIGEST.test(value.backendFingerprint) ||
    !Number.isSafeInteger(value.stateVersion) ||
    (value.stateVersion as number) <= 0 ||
    !boundedNonEmptyString(value.originTurnId, MAX_RUNTIME_ID_LENGTH) ||
    !Number.isSafeInteger(value.continuationSequence) ||
    (value.continuationSequence as number) <= 0 ||
    (value.status !== "committed" && value.status !== "uncertain") ||
    !Number.isSafeInteger(value.vendorTurnSequence) ||
    (value.vendorTurnSequence as number) <= 0
  ) {
    return false;
  }
  if (value.storageClass === "process_scoped") {
    return boundedNonEmptyString(value.ownerInstanceId, MAX_RUNTIME_ID_LENGTH) &&
      (allowExpired
        ? canonicalIso(value.expiresAt)
        : canonicalExpiryAfterRecord(value.expiresAt, at));
  }
  return value.ownerInstanceId === undefined &&
    (value.expiresAt === undefined ||
      (allowExpired
        ? canonicalIso(value.expiresAt)
        : canonicalExpiryAfterRecord(value.expiresAt, at)));
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
      isDirectContinuationHandle(value.providerStateHandle)))) {
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

export function isUsage(value: unknown): boolean {
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
      value.changedFilesSource === "mixed" ||
      value.changedFilesSource === "none" ||
      value.changedFilesSource === "workspace_diff") &&
    strings(value.evidence) &&
    (value.evidenceSource === "host_tools" || value.evidenceSource === "runtime" ||
      value.evidenceSource === "mixed" ||
      value.evidenceSource === "independent_verification" ||
      value.evidenceSource === "none");
}

function isBoundedRuntimeRunResult(value: unknown): boolean {
  if (!isRunResult(value) || !isObject(value)) {
    return false;
  }
  return boundedString(value.finalText, MAX_RUNTIME_TEXT_LENGTH) &&
    boundedStrings(value.changedFiles) &&
    boundedStrings(value.evidence) &&
    (value.usage === null
      ? value.usageSource === "unavailable"
      : value.usageSource === "runtime" && isSafeRuntimeUsage(value.usage));
}

function isSafeRuntimeUsage(value: unknown): boolean {
  if (!isUsage(value) || !isObject(value)) {
    return false;
  }
  return [
    value.inputTokens,
    value.outputTokens,
    value.cachedInputTokens,
    value.cacheWriteInputTokens,
    value.reasoningTokens,
  ].every((item) => item === undefined || Number.isSafeInteger(item));
}

const runtimeApprovalActions = new Set([
  "read", "write", "shell", "network", "external_path", "sensitive",
  "credential", "deploy", "unknown",
]);
const runtimeApprovalKinds = new Set([
  "allow_once", "allow_always", "reject_once", "reject_always",
]);

function isRuntimeApprovalRequest(
  value: unknown,
): value is RuntimeApprovalRequest {
  if (!(isObject(value) && hasExactKeys(
    value,
    ["requestId", "action", "resource", "risk", "summary", "options"],
    ["details"],
  ))) {
    return false;
  }
  if (
    !boundedNonEmptyString(value.requestId, MAX_RUNTIME_ID_LENGTH) ||
    typeof value.action !== "string" ||
    !runtimeApprovalActions.has(value.action) ||
    !boundedNonEmptyString(value.resource, MAX_RUNTIME_ITEM_LENGTH) ||
    (value.risk !== "normal" && value.risk !== "elevated" &&
      value.risk !== "destructive") ||
    !boundedString(value.summary, MAX_RUNTIME_ITEM_LENGTH) ||
    !Array.isArray(value.options) || value.options.length === 0 ||
    value.options.length > MAX_RUNTIME_APPROVAL_OPTIONS
  ) {
    return false;
  }
  const optionIds = new Set<string>();
  for (const option of value.options) {
    if (!(isObject(option) && hasExactKeys(
      option,
      ["optionId", "name", "kind"],
    )) ||
      !boundedNonEmptyString(option.optionId, MAX_RUNTIME_ID_LENGTH) ||
      !boundedNonEmptyString(option.name, MAX_RUNTIME_ITEM_LENGTH) ||
      typeof option.kind !== "string" ||
      !runtimeApprovalKinds.has(option.kind) ||
      optionIds.has(option.optionId)) {
      return false;
    }
    optionIds.add(option.optionId);
  }
  return value.details === undefined ||
    (isObject(value.details) && isBoundedJsonValue(
      value.details,
      { nodes: 0, characters: 0, seen: new WeakSet() },
    ));
}

function isRuntimeApprovalDecision(
  value: unknown,
): value is RuntimeApprovalDecision {
  return isObject(value) &&
    (value.outcome === "cancelled"
      ? hasExactKeys(value, ["outcome"])
      : value.outcome === "selected" &&
        hasExactKeys(value, ["outcome", "optionId"]) &&
        boundedNonEmptyString(value.optionId, MAX_RUNTIME_ID_LENGTH));
}

function validRuntimeApprovalResolution(
  request: unknown,
  decision: unknown,
  scope: unknown,
  provenance: unknown,
): boolean {
  if (
    !isRuntimeApprovalRequest(request) ||
    !isRuntimeApprovalDecision(decision) ||
    (provenance !== "user" && provenance !== "policy" &&
      provenance !== "signal")
  ) {
    return false;
  }
  if (decision.outcome === "cancelled") {
    return scope === "cancel";
  }
  if (provenance === "signal") {
    return false;
  }
  const selected = request.options.find(
    (option) => option.optionId === decision.optionId,
  );
  if (selected === undefined) {
    return false;
  }
  switch (selected.kind) {
    case "allow_once":
      return scope === "allow_once" || scope === "allow_session";
    case "reject_once":
      return scope === "deny";
    case "allow_always":
    case "reject_always":
      return false;
  }
}

function isRuntimeCompletionProvenance(value: unknown): boolean {
  return isObject(value) && hasExactKeys(value, [
    "adapterId", "connectionId", "modelId", "backendFingerprint",
    "capabilityProfileRevision",
  ]) &&
    boundedNonEmptyString(value.adapterId, MAX_RUNTIME_ID_LENGTH) &&
    boundedNonEmptyString(value.connectionId, MAX_RUNTIME_ID_LENGTH) &&
    boundedNonEmptyString(value.modelId, MAX_RUNTIME_ID_LENGTH) &&
    typeof value.backendFingerprint === "string" &&
    SHA256_DIGEST.test(value.backendFingerprint) &&
    boundedNonEmptyString(
      value.capabilityProfileRevision,
      MAX_RUNTIME_ID_LENGTH,
    );
}

function isCommittedVersionOf(
  uncertain: RuntimeContinuationHandle,
  active: RuntimeContinuationHandle,
): boolean {
  return uncertain.status === "uncertain" && active.status === "committed" &&
    isDeepStrictEqual({ ...uncertain, status: "committed" }, active);
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

export function isBackendPin(value: unknown): value is SessionBackendPin {
  if (!isObject(value)) {
    return false;
  }
  const required = [
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
  ];
  if (value.kind === "agent_runtime") {
    required.push("runtimeCapabilityProfileRevisionAtCreation");
  }
  const modelLimits = value.modelLimitsAtCreation;
  const validModelLimits = modelLimits === undefined || (
    isObject(modelLimits) &&
    hasExactKeys(modelLimits, [
      "source",
      "maxInputTokens",
      "maxOutputTokens",
      "verifiedAt",
    ]) &&
    modelLimits.source === "authenticated_provider_catalog" &&
    Number.isSafeInteger(modelLimits.maxInputTokens) &&
    Number(modelLimits.maxInputTokens) > 0 &&
    (modelLimits.maxOutputTokens === null ||
      (Number.isSafeInteger(modelLimits.maxOutputTokens) &&
        Number(modelLimits.maxOutputTokens) > 0)) &&
    canonicalIso(modelLimits.verifiedAt)
  );
  return hasExactKeys(value, required, ["modelLimitsAtCreation"]) &&
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
    typeof value.accountSubjectFingerprint === "string" &&
    validModelLimits &&
    (value.kind === "agent_runtime"
      ? boundedNonEmptyString(
          value.runtimeCapabilityProfileRevisionAtCreation,
          MAX_RUNTIME_ID_LENGTH,
        ) && value.modelLimitsAtCreation === undefined
      : value.runtimeCapabilityProfileRevisionAtCreation === undefined);
}

function isAgentPermissionMode(
  value: unknown,
): value is AgentSessionDescriptor["permissions"]["permissionMode"] {
  return value === "ask_always" || value === "approved_for_me" ||
    value === "full_access";
}

function isAgentExecutionMode(
  value: unknown,
): value is AgentSessionDescriptor["permissions"]["executionMode"] {
  return value === "act" || value === "plan";
}

function isAgentDescriptor(
  value: unknown,
  backend: SessionBackendPin,
  cwd: string,
): value is AgentSessionDescriptor {
  if (!isObject(value) || !hasExactKeys(value, [
    "id", "role", "profile", "parentAgentId", "parentSessionId", "depth", "task",
    "operatingMode", "backend", "permissions", "limits",
  ], ["workspace", "team"]) || !boundedNonEmptyString(value.id, MAX_RUNTIME_ID_LENGTH) ||
    (value.role !== "parent" && value.role !== "child") ||
    !Number.isSafeInteger(value.depth) || (value.depth as number) < 0 ||
    !isObject(value.operatingMode) ||
    !hasExactKeys(value.operatingMode, ["id", "version"]) ||
    typeof value.operatingMode.id !== "string" ||
    parseOperatingModeId(value.operatingMode.id) !== value.operatingMode.id ||
    !isObject(value.backend) ||
    !hasExactKeys(
      value.backend,
      value.backend.strategy === "policy_route"
        ? [
            "strategy", "candidateId", "reason", "adapterId", "connectionId",
            "modelId",
          ]
        : ["strategy", "adapterId", "connectionId", "modelId"],
    ) ||
    (value.backend.strategy !== "session_pin" &&
      value.backend.strategy !== "inherit_parent" &&
      value.backend.strategy !== "policy_route") ||
    (value.backend.strategy === "policy_route" && (
      !boundedNonEmptyString(value.backend.candidateId, MAX_RUNTIME_ID_LENGTH) ||
      (value.backend.reason !== "eligible_role_candidate" &&
        value.backend.reason !== "parent_fallback")
    )) ||
    value.backend.adapterId !== backend.adapterId ||
    value.backend.connectionId !== backend.connectionId ||
    value.backend.modelId !== backend.modelId ||
    !isObject(value.permissions) ||
    !hasExactKeys(value.permissions, [
      "parentExecutionMode", "executionMode", "parentPermissionMode",
      "permissionMode",
    ]) ||
    !isAgentExecutionMode(value.permissions.parentExecutionMode) ||
    !isAgentExecutionMode(value.permissions.executionMode) ||
    !isAgentPermissionMode(value.permissions.parentPermissionMode) ||
    !isAgentPermissionMode(value.permissions.permissionMode) ||
    !isObject(value.limits) ||
    !hasExactKeys(value.limits, [
      "maxDepth", "maxConcurrentChildren", "maxRetries", "maxRequests",
      "maxReportedCostUsd",
    ])) {
    return false;
  }
  const modeId = value.operatingMode.id;
  const policy = getOperatingModePolicy(modeId);
  const maxRequests = value.limits.maxRequests;
  if (value.operatingMode.version !== policy.version ||
    !Number.isSafeInteger(maxRequests) || (maxRequests as number) <= 0 ||
    (maxRequests as number) > policy.orchestration.maxRequests ||
    !isDeepStrictEqual(
      value.limits,
      { ...policy.orchestration, maxRequests },
    ) ||
    (value.depth as number) > policy.orchestration.maxDepth ||
    narrowAgentPermissionMode(
      value.permissions.parentPermissionMode,
      value.permissions.permissionMode,
    ) !== value.permissions.permissionMode ||
    (value.permissions.parentExecutionMode === "plan" &&
      value.permissions.executionMode !== "plan")) {
    return false;
  }
  if (value.role === "parent") {
    return value.profile === null &&
      value.parentAgentId === null && value.parentSessionId === null &&
      value.depth === 0 && value.task === null &&
      value.workspace === undefined && value.team === undefined &&
      isDeepStrictEqual(value.limits, policy.orchestration) &&
      value.backend.strategy === "session_pin" &&
      value.permissions.parentExecutionMode === value.permissions.executionMode &&
      value.permissions.parentPermissionMode === value.permissions.permissionMode;
  }
  if (!isObject(value.profile) ||
    !hasExactKeys(value.profile, ["id", "version"]) ||
    typeof value.profile.id !== "string") {
    return false;
  }
  const profileId = parseAgentProfileId(value.profile.id);
  if (profileId === null || profileId !== value.profile.id) {
    return false;
  }
  const profile = getAgentProfilePolicy(profileId);
  if (value.profile.version !== profile.version ||
    profile.executionMode !== value.permissions.executionMode) {
    return false;
  }
  const workspace = value.workspace;
  const validWorkspace = workspace === undefined || (
    isObject(workspace) &&
    hasExactKeys(workspace, [
      "kind", "version", "leaseId", "repositoryRoot", "worktreeRoot", "revision",
    ]) &&
    workspace.kind === "git_worktree" && workspace.version === 1 &&
    typeof workspace.leaseId === "string" && LEASE_ID.test(workspace.leaseId) &&
    boundedNonEmptyString(workspace.repositoryRoot, MAX_RUNTIME_TEXT_LENGTH) &&
    boundedNonEmptyString(workspace.worktreeRoot, MAX_RUNTIME_TEXT_LENGTH) &&
    path.isAbsolute(workspace.repositoryRoot) &&
    path.resolve(workspace.repositoryRoot) === workspace.repositoryRoot &&
    path.isAbsolute(workspace.worktreeRoot) &&
    path.resolve(workspace.worktreeRoot) === workspace.worktreeRoot &&
    workspace.repositoryRoot !== workspace.worktreeRoot &&
    workspace.worktreeRoot === cwd &&
    typeof workspace.revision === "string" && GIT_REVISION.test(workspace.revision)
  );
  const expectedTeamRole = profile.id === "implement_v2"
    ? "implement"
    : profile.id === "review_v2"
      ? "review"
      : profile.id === "repair_v1"
        ? "repair"
        : null;
  const team = value.team;
  const validTeam = team === undefined || (
    expectedTeamRole !== null && policy.version >= 4 && isObject(team) &&
    hasExactKeys(team, ["runId", "role", "taskIndex", "round", "attemptId"]) &&
    boundedNonEmptyString(team.runId, MAX_RUNTIME_ID_LENGTH) &&
    team.role === expectedTeamRole &&
    Number.isSafeInteger(team.taskIndex) && (team.taskIndex as number) >= 1 &&
    Number.isSafeInteger(team.round) && (team.round as number) >= 0 &&
    boundedNonEmptyString(team.attemptId, MAX_RUNTIME_ID_LENGTH)
  );
  return validWorkspace &&
    validTeam &&
    (expectedTeamRole === null || (
      policy.version >= 4 && workspace !== undefined && team !== undefined &&
      value.backend.strategy === "policy_route"
    )) &&
    boundedNonEmptyString(value.parentAgentId, MAX_RUNTIME_ID_LENGTH) &&
    boundedNonEmptyString(value.parentSessionId, MAX_RUNTIME_ID_LENGTH) &&
    (value.depth as number) > 0 &&
    (value.backend.strategy === "inherit_parent" || (
      value.backend.strategy === "policy_route" &&
      policy.version >= 4 && expectedTeamRole !== null
    )) &&
    isObject(value.task) && hasExactKeys(value.task, [
      "id", "description", "prompt",
    ]) && boundedNonEmptyString(value.task.id, MAX_RUNTIME_ID_LENGTH) &&
    boundedNonEmptyString(value.task.description, MAX_RUNTIME_ITEM_LENGTH) &&
    boundedNonEmptyString(value.task.prompt, MAX_RUNTIME_TEXT_LENGTH);
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

function isSessionForkSnapshot(
  value: unknown,
  sessionId: string,
  agent: unknown,
): boolean {
  if (!isObject(value) || !isObject(agent) || !hasExactKeys(
    value,
    ["sourceSessionId", "sourceSequence", "messages", "messageTurnIds", "summary"],
    ["prePlanPermissionMode"],
  ) || !boundedNonEmptyString(value.sourceSessionId, MAX_RUNTIME_ID_LENGTH) ||
    value.sourceSessionId === sessionId ||
    !Number.isSafeInteger(value.sourceSequence) || (value.sourceSequence as number) < 0 ||
    !Array.isArray(value.messages) || !value.messages.every(isModelMessage) ||
    !isObject(value.messageTurnIds) ||
    (value.summary !== null && !boundedString(value.summary, MAX_RUNTIME_TEXT_LENGTH))) {
    return false;
  }
  const messages = value.messages as ModelMessage[];
  const messageTurnIds = value.messageTurnIds as Record<string, unknown>;
  const permissions = isObject(agent.permissions) ? agent.permissions : {};
  const messageIds = new Set(messages.map((message) => message.id));
  const mappedIds = Object.keys(messageTurnIds);
  if (messageIds.size !== value.messages.length || mappedIds.length !== messageIds.size ||
    mappedIds.some((id) =>
      !messageIds.has(id) ||
      !boundedNonEmptyString(messageTurnIds[id], MAX_RUNTIME_ID_LENGTH)
    )) {
    return false;
  }
  const prePlan = value.prePlanPermissionMode;
  return prePlan === undefined
    ? permissions.executionMode !== "plan"
    : permissions.executionMode === "plan" && isAgentPermissionMode(prePlan);
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
      valid = recordKeys(value, ["cwd", "backend"], ["agent", "fork"]) &&
        typeof value.cwd === "string" &&
        isBackendPin(value.backend) &&
        (value.agent === undefined || isAgentDescriptor(value.agent, value.backend, value.cwd)) &&
        (value.fork === undefined || (
          value.agent !== undefined &&
          isSessionForkSnapshot(value.fork, sessionId, value.agent)
        ));
      break;
    case "turn_started":
      valid = recordKeys(value, ["turnId", "prompt"], ["queuedInputId"]) &&
        typeof value.turnId === "string" &&
        typeof value.prompt === "string" &&
        (value.queuedInputId === undefined ||
          boundedNonEmptyString(value.queuedInputId, MAX_RUNTIME_ID_LENGTH));
      break;
    case "prompt_queued":
      valid = recordKeys(
        value,
        ["queuedInputId", "prompt"],
        ["sourceTurnId"],
      ) &&
        boundedNonEmptyString(value.queuedInputId, MAX_RUNTIME_ID_LENGTH) &&
        boundedNonEmptyUtf8(value.prompt, MAX_QUEUED_TURN_BYTES) &&
        (value.sourceTurnId === undefined ||
          boundedNonEmptyString(value.sourceTurnId, MAX_RUNTIME_ID_LENGTH));
      break;
    case "prompt_queue_cleared":
      valid = recordKeys(value, ["queuedInputIds"]) &&
        Array.isArray(value.queuedInputIds) &&
        value.queuedInputIds.length <= MAX_PENDING_QUEUED_TURNS &&
        value.queuedInputIds.every((id) =>
          boundedNonEmptyString(id, MAX_RUNTIME_ID_LENGTH)
        );
      break;
    case "turn_steered":
      valid = recordKeys(value, ["turnId", "steeringId", "prompt"]) &&
        boundedNonEmptyString(value.turnId, MAX_RUNTIME_ID_LENGTH) &&
        boundedNonEmptyString(value.steeringId, MAX_RUNTIME_ID_LENGTH) &&
        boundedNonEmptyString(value.prompt, MAX_RUNTIME_ITEM_LENGTH);
      break;
    case "runtime_continuation_updated":
      valid = recordKeys(value, ["turnId", "continuation"]) && canonicalIso(value.at) &&
        boundedNonEmptyString(value.turnId, MAX_RUNTIME_ID_LENGTH) &&
        isRuntimeContinuationHandle(value.continuation, value.at) &&
        value.continuation.status === "uncertain";
      break;
    case "runtime_approval_resolved":
      valid = recordKeys(value, [
        "turnId", "request", "decision", "scope", "provenance",
      ]) && canonicalIso(value.at) &&
        boundedNonEmptyString(value.turnId, MAX_RUNTIME_ID_LENGTH) &&
        validRuntimeApprovalResolution(
          value.request,
          value.decision,
          value.scope,
          value.provenance,
        );
      break;
    case "runtime_completed":
      valid = recordKeys(
        value,
        ["turnId", "result", "stopReason", "provenance"],
        ["continuation"],
      ) && canonicalIso(value.at) &&
        boundedNonEmptyString(value.turnId, MAX_RUNTIME_ID_LENGTH) &&
        isBoundedRuntimeRunResult(value.result) &&
        (value.stopReason === "complete" || value.stopReason === "length") &&
        isRuntimeCompletionProvenance(value.provenance) &&
        (value.continuation === undefined ||
          (isRuntimeContinuationHandle(value.continuation, value.at) &&
            value.continuation.status === "committed"));
      break;
    case "runtime_continuation_reconciled":
      valid = recordKeys(value, [
        "operationId", "uncertainHandle", "outcome", "activeHandle",
      ]) && canonicalIso(value.at) &&
        boundedNonEmptyString(value.operationId, MAX_RUNTIME_ID_LENGTH) &&
        isRuntimeContinuationHandle(
          value.uncertainHandle,
          value.at,
          value.outcome === "gone",
        ) &&
        value.uncertainHandle.status === "uncertain" &&
        (value.outcome === "committed" || value.outcome === "gone") &&
        (value.activeHandle === null ||
          (isRuntimeContinuationHandle(
            value.activeHandle,
            value.at,
            value.outcome === "gone",
          ) &&
            value.activeHandle.status === "committed")) &&
        (value.outcome !== "committed" ||
          (value.activeHandle !== null &&
            isCommittedVersionOf(value.uncertainHandle, value.activeHandle)));
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
      valid = recordKeys(value, ["turnId", "error"], ["continuation"]) &&
        typeof value.turnId === "string" && isIntegrationFailure(value.error) &&
        (value.continuation === undefined ||
          (isRuntimeContinuationHandle(value.continuation, value.at, true) &&
            value.continuation.status === "uncertain"));
      break;
    case "turn_cancelled":
      valid = recordKeys(value, ["turnId", "reason"], ["continuation"]) &&
        typeof value.turnId === "string" && typeof value.reason === "string" &&
        (value.continuation === undefined ||
          (isRuntimeContinuationHandle(value.continuation, value.at, true) &&
            value.continuation.status === "uncertain"));
      break;
    case "turn_interrupted":
      valid = recordKeys(value, ["turnId", "reason"]) &&
        typeof value.turnId === "string" && typeof value.reason === "string";
      break;
    case "agent_run_failed":
      valid = recordKeys(value, ["failure"]) &&
        isIntegrationFailure(value.failure);
      break;
    case "agent_run_cancelled":
      valid = recordKeys(value, ["reason"]) &&
        boundedNonEmptyString(value.reason, MAX_RUNTIME_ITEM_LENGTH);
      break;
    case "agent_policy_updated":
      valid = recordKeys(value, ["operatingModeId", "operatingModeVersion"]) &&
        typeof value.operatingModeId === "string" &&
        parseOperatingModeId(value.operatingModeId) === value.operatingModeId &&
        value.operatingModeVersion === getOperatingModePolicy(
          value.operatingModeId as AgentSessionDescriptor["operatingMode"]["id"],
        ).version;
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
