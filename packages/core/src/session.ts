import type { ModelMessage, ToolCall } from "@recurs/providers";
import type { ExecutionMode, PermissionMode } from "@recurs/tools";

import type { SessionRecord, Usage } from "./events.js";
import type { Goal } from "./goal.js";

export interface SessionState {
  id: string;
  cwd: string;
  model: string;
  messages: ModelMessage[];
  permissionMode: PermissionMode;
  executionMode: ExecutionMode;
  prePlanPermissionMode?: PermissionMode;
  goal: Goal | null;
  usage: Usage;
  evidence: string[];
  changedFiles: string[];
  pendingToolCalls: ToolCall[];
}

export interface CreateSessionStateOptions {
  id: string;
  cwd: string;
  model: string;
  permissionMode?: PermissionMode;
}

export function createSessionState(
  options: CreateSessionStateOptions,
): SessionState {
  return {
    id: options.id,
    cwd: options.cwd,
    model: options.model,
    messages: [],
    permissionMode: options.permissionMode ?? "ask_always",
    executionMode: "act",
    goal: null,
    usage: { inputTokens: 0, outputTokens: 0 },
    evidence: [],
    changedFiles: [],
    pendingToolCalls: [],
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
    case "message_appended":
      return { ...state, messages: [...state.messages, record.message] };
    case "tool_started":
      return {
        ...state,
        pendingToolCalls: [...state.pendingToolCalls, record.call],
      };
    case "tool_completed":
    case "tool_failed":
      return {
        ...state,
        pendingToolCalls: withoutPendingCall(state.pendingToolCalls, record.callId),
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
        usage: {
          inputTokens: state.usage.inputTokens + record.usage.inputTokens,
          outputTokens: state.usage.outputTokens + record.usage.outputTokens,
        },
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
    case "turn_failed":
      return state;
  }
}

export function reduceSessionRecords(
  records: readonly SessionRecord[],
): SessionState {
  const first = records[0];
  if (first?.type !== "session_created") {
    throw new Error("A session log must begin with session_created");
  }
  let state = createSessionState({
    id: first.sessionId,
    cwd: first.cwd,
    model: first.model,
  });
  for (const record of records.slice(1)) {
    state = reduceSessionRecord(state, record);
  }
  return state;
}
