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
    isObject(value.billingSelectionAtCreation) &&
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
        typeof value.turnId === "string" && isObject(value.message) &&
        (value.usage === null || isObject(value.usage)) &&
        typeof value.stopReason === "string";
      break;
    case "tool_started":
      valid = recordKeys(value, ["turnId", "call"]) &&
        typeof value.turnId === "string" && isObject(value.call);
      break;
    case "tool_completed":
      valid = recordKeys(value, ["turnId", "callId", "result"]) &&
        typeof value.turnId === "string" && typeof value.callId === "string" &&
        isObject(value.result);
      break;
    case "tool_failed":
      valid = recordKeys(value, ["turnId", "callId", "error"]) &&
        typeof value.turnId === "string" && typeof value.callId === "string" &&
        isObject(value.error);
      break;
    case "permission_resolved":
      valid = recordKeys(value, ["turnId", "intent", "decision"]) &&
        typeof value.turnId === "string" && isObject(value.intent) &&
        typeof value.decision === "string";
      break;
    case "goal_updated":
      valid = recordKeys(
        value,
        ["source", "goal"],
        value.source === "turn" ? ["turnId"] : [],
      ) && (value.source === "command" || value.source === "turn") &&
        (value.goal === null || isObject(value.goal)) &&
        (value.source === "command" || typeof value.turnId === "string");
      break;
    case "mode_updated":
      valid = recordKeys(
        value,
        ["source", "executionMode", "permissionMode"],
        ["turnId", "prePlanPermissionMode"],
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
        typeof value.turnId === "string" && isObject(value.result);
      break;
    case "turn_failed":
      valid = recordKeys(value, ["turnId", "error"]) &&
        typeof value.turnId === "string" && isObject(value.error);
      break;
    case "turn_cancelled":
    case "turn_interrupted":
      valid = recordKeys(value, ["turnId", "reason"]) &&
        typeof value.turnId === "string" && typeof value.reason === "string";
      break;
    case "compaction_started":
      valid = recordKeys(value, ["operationId", "inputBaseSequence"]) &&
        typeof value.operationId === "string" &&
        Number.isSafeInteger(value.inputBaseSequence);
      break;
    case "session_compacted":
      valid = recordKeys(value, [
        "operationId", "inputBaseSequence", "baseSequence", "summary",
        "retainedTurnIds", "usage", "usageSource",
      ]) && typeof value.operationId === "string" &&
        Number.isSafeInteger(value.inputBaseSequence) &&
        Number.isSafeInteger(value.baseSequence) && typeof value.summary === "string" &&
        strings(value.retainedTurnIds) && (value.usage === null || isObject(value.usage)) &&
        (value.usageSource === "provider" || value.usageSource === "unavailable");
      break;
    case "compaction_failed":
      valid = recordKeys(value, ["operationId", "error", "usage", "usageSource"]) &&
        typeof value.operationId === "string" && isObject(value.error) &&
        (value.usage === null || isObject(value.usage)) &&
        typeof value.usageSource === "string";
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
