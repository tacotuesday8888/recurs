import { isDeepStrictEqual } from "node:util";

import type {
  IntegrationFailure,
  ProviderUsage,
  RuntimeApprovalRequest,
  RuntimeCapabilities,
  RuntimeContinuationHandle,
  ToolCall,
} from "@recurs/contracts";
import { ToolError, type ToolResult } from "@recurs/tools";

const DEFAULT_LIMITS = Object.freeze({
  maxEvents: 4_096,
  maxTextBytes: 1_048_576,
  maxReasoningBytes: 1_048_576,
  maxFinalTextBytes: 262_144,
  maxItemBytes: 16_384,
  maxDistinctItems: 1_024,
  maxActivityIds: 1_024,
  maxApprovalOptions: 64,
  maxApprovalJsonDepth: 16,
  maxApprovalJsonNodes: 4_096,
  maxApprovalJsonBytes: 131_072,
  maxIdBytes: 512,
});

export interface DelegatedAgentExecutorLimits {
  readonly maxEvents: number;
  readonly maxTextBytes: number;
  readonly maxReasoningBytes: number;
  readonly maxFinalTextBytes: number;
  readonly maxItemBytes: number;
  readonly maxDistinctItems: number;
  readonly maxActivityIds: number;
  readonly maxApprovalOptions: number;
  readonly maxApprovalJsonDepth: number;
  readonly maxApprovalJsonNodes: number;
  readonly maxApprovalJsonBytes: number;
  readonly maxIdBytes: number;
}

export class RuntimeProtocolError extends Error {
  constructor() {
    super("The delegated runtime returned an invalid response");
    this.name = "RuntimeProtocolError";
  }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => key in value) &&
    Object.keys(value).every((key) => allowed.has(key));
}

export function resolveLimits(
  overrides: Partial<DelegatedAgentExecutorLimits> | undefined,
): Readonly<DelegatedAgentExecutorLimits> {
  const resolved = { ...DEFAULT_LIMITS, ...overrides };
  if (!Object.values(resolved).every((value) =>
    Number.isSafeInteger(value) && value > 0
  )) {
    throw new TypeError("Delegated runtime limits must be positive safe integers");
  }
  return Object.freeze(resolved);
}

function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return false;
      }
      index += 1;
    } else if (current >= 0xdc00 && current <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function boundedString(
  value: unknown,
  maximumBytes: number,
): value is string {
  return typeof value === "string" && isWellFormed(value) &&
    utf8Bytes(value) <= maximumBytes;
}

export function boundedNonEmptyString(
  value: unknown,
  maximumBytes: number,
): value is string {
  return boundedString(value, maximumBytes) && value.length > 0 &&
    value === value.trim();
}

export function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return value;
}

interface JsonBudget {
  nodes: number;
  bytes: number;
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

function boundedJsonValue(
  value: unknown,
  limits: Readonly<DelegatedAgentExecutorLimits>,
  budget: JsonBudget,
  depth = 0,
): boolean {
  budget.nodes += 1;
  if (depth > limits.maxApprovalJsonDepth ||
    budget.nodes > limits.maxApprovalJsonNodes) {
    return false;
  }
  if (value === null || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) && !Object.is(value, -0);
  }
  if (typeof value === "string") {
    budget.bytes += utf8Bytes(value);
    return boundedString(value, limits.maxItemBytes) &&
      budget.bytes <= limits.maxApprovalJsonBytes;
  }
  if (typeof value !== "object" || budget.seen.has(value)) {
    return false;
  }
  budget.seen.add(value);
  if (Array.isArray(value)) {
    const items = plainJsonArrayItems(value, limits.maxDistinctItems);
    return items !== null && items.every((item) =>
      boundedJsonValue(item, limits, budget, depth + 1)
    );
  }
  const entries = plainJsonEntries(value, limits.maxDistinctItems);
  if (entries === null) {
    return false;
  }
  for (const [key, item] of entries) {
    budget.bytes += utf8Bytes(key);
    if (!boundedNonEmptyString(key, limits.maxIdBytes) ||
      budget.bytes > limits.maxApprovalJsonBytes ||
      !boundedJsonValue(item, limits, budget, depth + 1)) {
      return false;
    }
  }
  return true;
}

const secretCanaries = [
  /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{16,}\b/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
] as const;

function containsSecretCanary(
  value: unknown,
  seen = new WeakSet<object>(),
): boolean {
  if (typeof value === "string") {
    return secretCanaries.some((pattern) => pattern.test(value));
  }
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return false;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((item) => containsSecretCanary(item, seen));
  }
  return Object.entries(value).some(([key, item]) =>
    containsSecretCanary(key, seen) || containsSecretCanary(item, seen)
  );
}

const runtimeApprovalActions = new Set([
  "read", "write", "shell", "network", "external_path", "sensitive",
  "credential", "deploy", "unknown",
]);
const runtimeApprovalKinds = new Set([
  "allow_once", "allow_always", "reject_once", "reject_always",
]);

export function validRuntimeApprovalRequest(
  value: unknown,
  limits: Readonly<DelegatedAgentExecutorLimits>,
): value is RuntimeApprovalRequest {
  if (!(isObject(value) && exactKeys(
    value,
    ["requestId", "action", "resource", "risk", "summary", "options"],
    ["details"],
  ))) {
    return false;
  }
  if (!boundedNonEmptyString(value.requestId, limits.maxIdBytes) ||
    typeof value.action !== "string" || !runtimeApprovalActions.has(value.action) ||
    !boundedNonEmptyString(value.resource, limits.maxItemBytes) ||
    (value.risk !== "normal" && value.risk !== "elevated" &&
      value.risk !== "destructive") ||
    !boundedString(value.summary, limits.maxItemBytes) ||
    !Array.isArray(value.options) || value.options.length === 0 ||
    value.options.length > limits.maxApprovalOptions) {
    return false;
  }
  const optionIds = new Set<string>();
  for (const option of value.options) {
    if (!(isObject(option) && exactKeys(option, ["optionId", "name", "kind"])) ||
      !boundedNonEmptyString(option.optionId, limits.maxIdBytes) ||
      !boundedNonEmptyString(option.name, limits.maxItemBytes) ||
      typeof option.kind !== "string" || !runtimeApprovalKinds.has(option.kind) ||
      optionIds.has(option.optionId)) {
      return false;
    }
    optionIds.add(option.optionId);
  }
  if (value.details !== undefined &&
    (!isObject(value.details) || !boundedJsonValue(
      value.details,
      limits,
      { nodes: 0, bytes: 0, seen: new WeakSet() },
    ))) {
    return false;
  }
  return !containsSecretCanary(value);
}

export function validToolCall(
  value: unknown,
  limits: Readonly<DelegatedAgentExecutorLimits>,
): value is ToolCall {
  return isObject(value) && exactKeys(value, ["id", "name", "arguments"]) &&
    boundedNonEmptyString(value.id, limits.maxIdBytes) &&
    boundedNonEmptyString(value.name, limits.maxIdBytes) &&
    boundedJsonValue(
      value.arguments,
      limits,
      { nodes: 0, bytes: 0, seen: new WeakSet() },
    );
}

export function validToolResult(
  value: unknown,
  limits: Readonly<DelegatedAgentExecutorLimits>,
): value is ToolResult {
  return isObject(value) && exactKeys(value, ["output"], ["metadata"]) &&
    boundedString(value.output, limits.maxTextBytes) &&
    (value.metadata === undefined ||
      (isObject(value.metadata) && boundedJsonValue(
        value.metadata,
        limits,
        { nodes: 0, bytes: 0, seen: new WeakSet() },
      )));
}

export function boundedMetadataStrings(
  result: ToolResult,
  key: "changedFiles" | "evidence",
  limits: Readonly<DelegatedAgentExecutorLimits>,
): string[] | null {
  const raw = result.metadata?.[key];
  if (!Array.isArray(raw)) {
    return [];
  }
  const values = raw.filter((item): item is string => typeof item === "string");
  return values.length <= limits.maxDistinctItems &&
    values.every((item) => boundedNonEmptyString(item, limits.maxItemBytes))
    ? values
    : null;
}

export interface HostArtifacts {
  readonly changedFiles: string[];
  readonly evidence: string[];
  changedFilesContributed: boolean;
  evidenceContributed: boolean;
}

export function preflightFailure(
  code: IntegrationFailure["code"],
  safeMessage: string,
  diagnosticId: string,
  domain: IntegrationFailure["domain"] = "runtime",
): IntegrationFailure {
  return Object.freeze({
    domain,
    phase: "preflight",
    code,
    safeMessage,
    diagnosticId,
    retryable: false,
  });
}

export function startedFailure(
  code: IntegrationFailure["code"],
  safeMessage: string,
  diagnosticId: string,
  domain: IntegrationFailure["domain"] = "runtime",
  retryable = false,
): IntegrationFailure {
  return Object.freeze({
    domain,
    phase: "started",
    code,
    safeMessage,
    diagnosticId,
    retryable,
  });
}

export function safeToolFailure(
  error: unknown,
  diagnosticId: string,
): { readonly failure: IntegrationFailure; readonly output: string; readonly cancelled: boolean } {
  const code = error instanceof ToolError ? error.code : "execution_failed";
  const cancelled = code === "cancelled";
  const safeMessage = `Tool error [${code}]: The host tool request did not complete`;
  return {
    failure: startedFailure(
      "tool_failed",
      safeMessage,
      diagnosticId,
      "tool",
    ),
    output: safeMessage,
    cancelled,
  };
}

export function snapshotCapabilities(value: unknown): Readonly<RuntimeCapabilities> {
  if (!(isObject(value) && exactKeys(value, [
    "resume", "cancellation", "fileEvents", "usageEvents",
    "supportedPermissionModes", "approvalControl", "planMode",
    "toolExecution", "checkpointing",
  ], ["containmentProfileId"]))) {
    throw new TypeError("Invalid delegated runtime capabilities");
  }
  const permissionModes = value.supportedPermissionModes;
  if (typeof value.resume !== "boolean" ||
    (value.cancellation !== "protocol" &&
      value.cancellation !== "os_containment" &&
      value.cancellation !== "unsupported") ||
    typeof value.fileEvents !== "boolean" || typeof value.usageEvents !== "boolean" ||
    !Array.isArray(permissionModes) || permissionModes.some((item) =>
      item !== "ask_always" && item !== "approved_for_me" &&
      item !== "full_access"
    ) || new Set(permissionModes).size !== permissionModes.length ||
    (value.approvalControl !== "host" &&
      value.approvalControl !== "recurs_policy_bridge" &&
      value.approvalControl !== "none") ||
    (value.planMode !== "enforced" && value.planMode !== "advisory" &&
      value.planMode !== "unsupported") ||
    (value.toolExecution !== "host_tools" &&
      value.toolExecution !== "recurs_os_containment" &&
      value.toolExecution !== "opaque") ||
    (value.checkpointing !== "host_tools" &&
      value.checkpointing !== "turn_snapshot" &&
      value.checkpointing !== "none") ||
    (value.containmentProfileId !== undefined &&
      !boundedNonEmptyString(value.containmentProfileId, 512))) {
    throw new TypeError("Invalid delegated runtime capabilities");
  }
  return deepFreeze(structuredClone(value) as unknown as RuntimeCapabilities);
}

const usageOptionalFields = [
  "cachedInputTokens", "cacheWriteInputTokens", "reasoningTokens", "costUsd",
] as const;
const tokenFields = [
  "inputTokens", "outputTokens", "cachedInputTokens",
  "cacheWriteInputTokens", "reasoningTokens",
] as const;

export function validUsage(value: unknown): value is ProviderUsage {
  if (!(isObject(value) && exactKeys(
    value,
    ["inputTokens", "outputTokens"],
    usageOptionalFields,
  ))) {
    return false;
  }
  for (const field of tokenFields) {
    const item = value[field];
    if (item !== undefined &&
      (typeof item !== "number" || !Number.isSafeInteger(item) || item < 0)) {
      return false;
    }
  }
  return value.costUsd === undefined ||
    (typeof value.costUsd === "number" && Number.isFinite(value.costUsd) &&
      value.costUsd >= 0 && value.costUsd <= Number.MAX_SAFE_INTEGER);
}

export function addUsage(
  current: ProviderUsage | null,
  addition: ProviderUsage,
): ProviderUsage {
  const next: ProviderUsage = {
    inputTokens: (current?.inputTokens ?? 0) + addition.inputTokens,
    outputTokens: (current?.outputTokens ?? 0) + addition.outputTokens,
  };
  for (const field of usageOptionalFields) {
    const currentValue = current?.[field];
    const additionValue = addition[field];
    if (currentValue !== undefined || additionValue !== undefined) {
      next[field] = (currentValue ?? 0) + (additionValue ?? 0);
    }
  }
  if (!validUsage(next)) {
    throw new RuntimeProtocolError();
  }
  return next;
}

export function addUniqueBounded(
  target: string[],
  additions: unknown,
  limits: Readonly<DelegatedAgentExecutorLimits>,
): boolean {
  if (!Array.isArray(additions) || additions.length > limits.maxDistinctItems) {
    return false;
  }
  for (const addition of additions) {
    if (!boundedNonEmptyString(addition, limits.maxItemBytes)) {
      return false;
    }
    if (!target.includes(addition)) {
      if (target.length >= limits.maxDistinctItems) {
        return false;
      }
      target.push(addition);
    }
  }
  return true;
}

const integrationDomains = new Set([
  "connection", "auth", "catalog", "policy", "provider", "runtime",
  "storage", "tool",
]);
const integrationCodes = new Set([
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
const integrationActions = new Set([
  "reauthenticate", "select_connection", "select_model", "confirm_billing",
  "fork_session", "unlock_store", "wait",
]);

export function validRuntimeFailure(
  value: unknown,
  limits: Readonly<DelegatedAgentExecutorLimits>,
): value is IntegrationFailure {
  if (!(isObject(value) && exactKeys(
    value,
    ["domain", "phase", "code", "safeMessage", "diagnosticId", "retryable"],
    ["retryAfterMs", "action"],
  ))) {
    return false;
  }
  return typeof value.domain === "string" && integrationDomains.has(value.domain) &&
    (value.phase === "preflight" || value.phase === "started") &&
    typeof value.code === "string" && integrationCodes.has(value.code) &&
    boundedString(value.safeMessage, limits.maxItemBytes) &&
    boundedNonEmptyString(value.diagnosticId, limits.maxItemBytes) &&
    typeof value.retryable === "boolean" &&
    (value.retryAfterMs === undefined ||
      (Number.isSafeInteger(value.retryAfterMs) &&
        (value.retryAfterMs as number) >= 0)) &&
    (value.action === undefined ||
      (typeof value.action === "string" && integrationActions.has(value.action)));
}

export function committedVersion(
  uncertain: RuntimeContinuationHandle,
  committed: RuntimeContinuationHandle,
): boolean {
  return uncertain.status === "uncertain" && committed.status === "committed" &&
    isDeepStrictEqual({ ...uncertain, status: "committed" }, committed);
}
