import type { ProviderUsage, SessionBackendPin } from "@recurs/contracts";
import type { ModelMessage, ToolCall } from "@recurs/providers";
import type {
  ExecutionMode,
  PermissionMode,
  ToolResult,
} from "@recurs/tools";

import type {
  SerializableError,
  SessionRecord,
} from "./events.js";
import type { Goal } from "./goal.js";
import {
  reduceSessionRecordsV2,
  type SessionRecordV2,
} from "./session-v2.js";

export type ToolOutcome =
  | { type: "completed"; result: ToolResult }
  | { type: "failed"; error: SerializableError };

export interface SessionState {
  version: 1 | 2;
  id: string;
  cwd: string;
  model: string;
  backend:
    | { type: "legacy"; model: string }
    | { type: "pinned"; pin: SessionBackendPin };
  lastSequence: number | null;
  forkedFrom: { sessionId: string; sequence: number } | null;
  messages: ModelMessage[];
  messageTurnIds: Record<string, string>;
  summary: string | null;
  permissionMode: PermissionMode;
  executionMode: ExecutionMode;
  prePlanPermissionMode?: PermissionMode;
  goal: Goal | null;
  usage: ProviderUsage;
  lastProviderUsage?: ProviderUsage | null;
  evidence: string[];
  changedFiles: string[];
  pendingToolCalls: ToolCall[];
  toolOutcomes: Record<string, ToolOutcome>;
  openTurnId: string | null;
  pendingCompaction: {
    operationId: string;
    inputBaseSequence: number;
  } | null;
}

export interface CreateSessionStateOptions {
  id: string;
  cwd: string;
  model: string;
  permissionMode?: PermissionMode;
}

const optionalUsageFields = [
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "reasoningTokens",
  "costUsd",
] as const;

function addUsage(
  current: ProviderUsage,
  addition: ProviderUsage,
): ProviderUsage {
  const next: ProviderUsage = {
    inputTokens: current.inputTokens + addition.inputTokens,
    outputTokens: current.outputTokens + addition.outputTokens,
  };
  for (const field of optionalUsageFields) {
    if (current[field] !== undefined || addition[field] !== undefined) {
      next[field] = (current[field] ?? 0) + (addition[field] ?? 0);
    }
  }
  const tokenFields = [
    "inputTokens", "outputTokens", "cachedInputTokens",
    "cacheWriteInputTokens", "reasoningTokens",
  ] as const;
  if (tokenFields.some((field) =>
    next[field] !== undefined && !Number.isSafeInteger(next[field])
  ) || (next.costUsd !== undefined && !Number.isFinite(next.costUsd))) {
    throw new Error("Session usage exceeds the safe numeric range");
  }
  return next;
}

export function createSessionState(
  options: CreateSessionStateOptions,
): SessionState {
  return {
    version: 1,
    id: options.id,
    cwd: options.cwd,
    model: options.model,
    backend: { type: "legacy", model: options.model },
    lastSequence: null,
    forkedFrom: null,
    messages: [],
    messageTurnIds: {},
    summary: null,
    permissionMode: options.permissionMode ?? "ask_always",
    executionMode: "act",
    goal: null,
    usage: { inputTokens: 0, outputTokens: 0 },
    lastProviderUsage: null,
    evidence: [],
    changedFiles: [],
    pendingToolCalls: [],
    toolOutcomes: {},
    openTurnId: null,
    pendingCompaction: null,
  };
}

export function enterPlanMode(state: SessionState): SessionState {
  if (state.executionMode === "plan") {
    return state;
  }
  return {
    ...state,
    executionMode: "plan",
    prePlanPermissionMode: state.permissionMode,
  };
}

export function exitPlanMode(state: SessionState): SessionState {
  if (state.executionMode === "act") {
    return state;
  }
  const permissionMode = state.prePlanPermissionMode ?? state.permissionMode;
  const next: SessionState = {
    ...state,
    executionMode: "act",
    permissionMode,
  };
  delete next.prePlanPermissionMode;
  return next;
}

function withoutPendingCall(calls: ToolCall[], callId: string): ToolCall[] {
  return calls.filter((call) => call.id !== callId);
}

function withoutToolOutcomes(
  outcomes: Readonly<Record<string, ToolOutcome>>,
  callIds: readonly string[],
): Record<string, ToolOutcome> {
  const next = { ...outcomes };
  for (const callId of callIds) {
    delete next[callId];
  }
  return next;
}

function unresolvedToolCallIds(messages: readonly ModelMessage[]): Set<string> {
  const unresolved = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) {
        unresolved.add(call.id);
      }
    } else if (message.role === "tool" && message.toolCallId !== undefined) {
      unresolved.delete(message.toolCallId);
    }
  }
  return unresolved;
}

export function reduceSessionRecord(
  state: SessionState,
  record: SessionRecord,
): SessionState {
  if (record.sessionId !== state.id) {
    throw new Error(
      `Cannot apply record for session ${record.sessionId} to ${state.id}`,
    );
  }

  switch (record.type) {
    case "session_created":
    case "turn_started":
      return state;
    case "message_appended": {
      const resolvedIds = record.message.role === "tool" && record.message.toolCallId !== undefined
        ? [record.message.toolCallId]
        : record.message.role === "assistant"
          ? (record.message.toolCalls ?? []).map((call) => call.id)
          : [];
      return {
        ...state,
        messages: [...state.messages, record.message],
        toolOutcomes: withoutToolOutcomes(state.toolOutcomes, resolvedIds),
      };
    }
    case "session_compacted": {
      const retainedCallIds = unresolvedToolCallIds(record.retainedMessages);
      return {
        ...state,
        summary: record.summary,
        messages: [...record.retainedMessages],
        toolOutcomes: Object.fromEntries(
          Object.entries(state.toolOutcomes).filter(([callId]) =>
            retainedCallIds.has(callId),
          ),
        ),
      };
    }
    case "tool_started":
      return {
        ...state,
        pendingToolCalls: [...state.pendingToolCalls, record.call],
      };
    case "tool_completed":
      return {
        ...state,
        pendingToolCalls: withoutPendingCall(state.pendingToolCalls, record.callId),
        toolOutcomes: {
          ...state.toolOutcomes,
          [record.callId]: { type: "completed", result: record.result },
        },
      };
    case "tool_failed":
      return {
        ...state,
        pendingToolCalls: withoutPendingCall(state.pendingToolCalls, record.callId),
        toolOutcomes: {
          ...state.toolOutcomes,
          [record.callId]: { type: "failed", error: record.error },
        },
      };
    case "goal_updated":
      return { ...state, goal: record.goal };
    case "mode_updated": {
      const next: SessionState = {
        ...state,
        executionMode: record.executionMode,
        permissionMode: record.permissionMode,
      };
      if (record.prePlanPermissionMode === undefined) {
        delete next.prePlanPermissionMode;
        return next;
      }
      next.prePlanPermissionMode = record.prePlanPermissionMode;
      return next;
    }
    case "turn_completed":
      return {
        ...state,
        usage: addUsage(state.usage, record.usage),
        evidence: [...new Set([...state.evidence, ...record.evidence])],
      };
    case "files_changed":
      return {
        ...state,
        changedFiles: [...new Set([...state.changedFiles, ...record.paths])],
      };
    case "verification_recorded":
      return {
        ...state,
        evidence: [...new Set([...state.evidence, ...record.evidence])],
      };
    case "permission_resolved":
    case "agent_policy_updated":
    case "turn_failed":
      return state;
  }
}

export function reduceSessionRecords(
  records: readonly (SessionRecord | SessionRecordV2)[],
): SessionState {
  const first = records[0];
  if (first?.version === 2) {
    if (!records.every((record): record is SessionRecordV2 => record.version === 2)) {
      throw new Error("A session log cannot mix record versions");
    }
    return reduceSessionRecordsV2(records);
  }
  if (first?.type !== "session_created") {
    throw new Error("A session log must begin with session_created");
  }
  let state = createSessionState({
    id: first.sessionId,
    cwd: first.cwd,
    model: first.model,
  });
  for (const record of records.slice(1)) {
    if (record.version !== 1) {
      throw new Error("A session log cannot mix record versions");
    }
    state = reduceSessionRecord(state, record);
  }
  return state;
}
