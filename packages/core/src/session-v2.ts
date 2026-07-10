import type {
  IntegrationFailure,
  ModelMessage,
  ProviderBackedMessage,
  ProviderUsage,
  RunResult,
  SessionBackendPin,
  StopReason,
  ToolCall,
} from "@recurs/contracts";
import type {
  ApprovalResponse,
  ExecutionMode,
  PermissionIntent,
  PermissionMode,
  ToolResult,
} from "@recurs/tools";

import type { Goal } from "./goal.js";
import type { SessionState } from "./session.js";

export interface SessionRecordBaseV2 {
  version: 2;
  sessionId: string;
  sequence: number;
  at: string;
}

type GoalRecordV2 =
  | (SessionRecordBaseV2 & {
      type: "goal_updated";
      source: "command";
      goal: Goal | null;
    })
  | (SessionRecordBaseV2 & {
      type: "goal_updated";
      source: "turn";
      turnId: string;
      goal: Goal | null;
    });

type ModeRecordV2 =
  | (SessionRecordBaseV2 & {
      type: "mode_updated";
      source: "command";
      executionMode: ExecutionMode;
      permissionMode: PermissionMode;
      prePlanPermissionMode?: PermissionMode;
    })
  | (SessionRecordBaseV2 & {
      type: "mode_updated";
      source: "turn";
      turnId: string;
      executionMode: ExecutionMode;
      permissionMode: PermissionMode;
      prePlanPermissionMode?: PermissionMode;
    });

export type SessionRecordV2 =
  | (SessionRecordBaseV2 & {
      type: "session_created";
      cwd: string;
      backend: SessionBackendPin;
    })
  | (SessionRecordBaseV2 & {
      type: "turn_started";
      turnId: string;
      prompt: string;
    })
  | (SessionRecordBaseV2 & {
      type: "model_completed";
      turnId: string;
      message: ProviderBackedMessage;
      usage: ProviderUsage | null;
      stopReason: StopReason;
    })
  | (SessionRecordBaseV2 & {
      type: "tool_started";
      turnId: string;
      call: ToolCall;
    })
  | (SessionRecordBaseV2 & {
      type: "tool_completed";
      turnId: string;
      callId: string;
      result: ToolResult;
    })
  | (SessionRecordBaseV2 & {
      type: "tool_failed";
      turnId: string;
      callId: string;
      error: IntegrationFailure;
    })
  | (SessionRecordBaseV2 & {
      type: "permission_resolved";
      turnId: string;
      intent: PermissionIntent;
      decision: ApprovalResponse | "allowed_by_policy";
    })
  | GoalRecordV2
  | ModeRecordV2
  | (SessionRecordBaseV2 & {
      type: "files_changed";
      turnId: string;
      paths: string[];
    })
  | (SessionRecordBaseV2 & {
      type: "verification_recorded";
      turnId: string;
      evidence: string[];
    })
  | (SessionRecordBaseV2 & {
      type: "turn_completed";
      turnId: string;
      result: RunResult;
    })
  | (SessionRecordBaseV2 & {
      type: "turn_failed";
      turnId: string;
      error: IntegrationFailure;
    })
  | (SessionRecordBaseV2 & {
      type: "turn_cancelled";
      turnId: string;
      reason: string;
    })
  | (SessionRecordBaseV2 & {
      type: "turn_interrupted";
      turnId: string;
      reason: string;
    })
  | (SessionRecordBaseV2 & {
      type: "compaction_started";
      operationId: string;
      inputBaseSequence: number;
    })
  | (SessionRecordBaseV2 & {
      type: "session_compacted";
      operationId: string;
      inputBaseSequence: number;
      baseSequence: number;
      summary: string;
      retainedTurnIds: string[];
      usage: ProviderUsage | null;
      usageSource: "provider" | "unavailable";
    })
  | (SessionRecordBaseV2 & {
      type: "compaction_failed";
      operationId: string;
      error: IntegrationFailure;
      usage: ProviderUsage | null;
      usageSource: "provider" | "unavailable" | "unknown";
    })
  | (SessionRecordBaseV2 & {
      type: "compaction_interrupted";
      operationId: string;
      reason: string;
      usage: null;
      usageSource: "unknown";
    });

type WithoutRecordBase<T> = T extends SessionRecordBaseV2
  ? Omit<T, "version" | "sessionId" | "sequence">
  : never;

export type SessionRecordInputV2 = WithoutRecordBase<SessionRecordV2>;

export interface PinnedSessionState extends SessionState {
  version: 2;
  backend: { type: "pinned"; pin: SessionBackendPin };
  lastSequence: number;
}

export function isPinnedSessionState(
  state: SessionState,
): state is PinnedSessionState {
  return state.version === 2 &&
    state.backend.type === "pinned" &&
    state.lastSequence !== null;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function withoutPendingCall(calls: ToolCall[], callId: string): ToolCall[] {
  return calls.filter((call) => call.id !== callId);
}

function addMessage(
  state: PinnedSessionState,
  message: ModelMessage,
  turnId: string,
): PinnedSessionState {
  return {
    ...state,
    messages: [...state.messages, message],
    messageTurnIds: { ...state.messageTurnIds, [message.id]: turnId },
  };
}

export function reduceSessionRecordV2(
  state: PinnedSessionState,
  record: SessionRecordV2,
): PinnedSessionState {
  if (record.sessionId !== state.id) {
    throw new Error(
      `Cannot apply record for session ${record.sessionId} to ${state.id}`,
    );
  }
  if (record.sequence !== state.lastSequence + 1) {
    throw new Error(
      `Expected session sequence ${state.lastSequence + 1}, received ${record.sequence}`,
    );
  }
  let next: PinnedSessionState;
  switch (record.type) {
    case "session_created":
      throw new Error("session_created may appear only at sequence zero");
    case "turn_started":
      next = addMessage(
        { ...state, openTurnId: record.turnId },
        {
          id: `${record.turnId}:user`,
          role: "user",
          content: record.prompt,
        },
        record.turnId,
      );
      break;
    case "model_completed":
      next = addMessage(state, record.message, record.turnId);
      break;
    case "tool_started":
      next = {
        ...state,
        pendingToolCalls: [...state.pendingToolCalls, record.call],
      };
      break;
    case "tool_completed":
      next = addMessage(
        {
          ...state,
          pendingToolCalls: withoutPendingCall(
            state.pendingToolCalls,
            record.callId,
          ),
          toolOutcomes: {
            ...state.toolOutcomes,
            [record.callId]: { type: "completed", result: record.result },
          },
        },
        {
          id: `${record.turnId}:tool:${record.callId}`,
          role: "tool",
          content: record.result.output,
          toolCallId: record.callId,
        },
        record.turnId,
      );
      break;
    case "tool_failed":
      next = addMessage(
        {
          ...state,
          pendingToolCalls: withoutPendingCall(
            state.pendingToolCalls,
            record.callId,
          ),
          toolOutcomes: {
            ...state.toolOutcomes,
            [record.callId]: {
              type: "failed",
              error: {
                code: record.error.code,
                message: record.error.safeMessage,
                retryable: record.error.retryable,
              },
            },
          },
        },
        {
          id: `${record.turnId}:tool:${record.callId}`,
          role: "tool",
          content: `Tool error [${record.error.code}]: ${record.error.safeMessage}`,
          toolCallId: record.callId,
        },
        record.turnId,
      );
      break;
    case "goal_updated":
      next = { ...state, goal: record.goal };
      break;
    case "mode_updated": {
      next = {
        ...state,
        executionMode: record.executionMode,
        permissionMode: record.permissionMode,
      };
      if (record.prePlanPermissionMode === undefined) {
        delete next.prePlanPermissionMode;
      } else {
        next.prePlanPermissionMode = record.prePlanPermissionMode;
      }
      break;
    }
    case "files_changed":
      next = {
        ...state,
        changedFiles: unique([...state.changedFiles, ...record.paths]),
      };
      break;
    case "verification_recorded":
      next = {
        ...state,
        evidence: unique([...state.evidence, ...record.evidence]),
      };
      break;
    case "turn_completed":
      next = {
        ...state,
        openTurnId: null,
        usage: {
          inputTokens:
            state.usage.inputTokens + (record.result.usage?.inputTokens ?? 0),
          outputTokens:
            state.usage.outputTokens + (record.result.usage?.outputTokens ?? 0),
        },
        changedFiles: unique([
          ...state.changedFiles,
          ...record.result.changedFiles,
        ]),
        evidence: unique([...state.evidence, ...record.result.evidence]),
      };
      break;
    case "turn_failed":
    case "turn_cancelled":
    case "turn_interrupted":
      next = { ...state, openTurnId: null };
      break;
    case "session_compacted": {
      const retained = new Set(record.retainedTurnIds);
      const messages = state.messages.filter((message) => {
        const turnId = state.messageTurnIds[message.id];
        return turnId !== undefined && retained.has(turnId);
      });
      const ids = new Set(messages.map((message) => message.id));
      next = {
        ...state,
        summary: record.summary,
        messages,
        messageTurnIds: Object.fromEntries(
          Object.entries(state.messageTurnIds).filter(([id]) => ids.has(id)),
        ),
      };
      break;
    }
    case "permission_resolved":
    case "compaction_started":
    case "compaction_failed":
    case "compaction_interrupted":
      next = state;
      break;
  }
  return { ...next, lastSequence: record.sequence };
}

export function reduceSessionRecordsV2(
  records: readonly SessionRecordV2[],
): PinnedSessionState {
  const first = records[0];
  if (first?.type !== "session_created" || first.sequence !== 0) {
    throw new Error(
      "A version 2 session log must begin with session_created at sequence zero",
    );
  }
  let state: PinnedSessionState = {
    version: 2,
    id: first.sessionId,
    cwd: first.cwd,
    model: first.backend.modelId,
    backend: { type: "pinned", pin: first.backend },
    lastSequence: 0,
    messages: [],
    messageTurnIds: {},
    summary: null,
    permissionMode: "ask_always",
    executionMode: "act",
    goal: null,
    usage: { inputTokens: 0, outputTokens: 0 },
    evidence: [],
    changedFiles: [],
    pendingToolCalls: [],
    toolOutcomes: {},
    openTurnId: null,
  };
  for (const record of records.slice(1)) {
    state = reduceSessionRecordV2(state, record);
  }
  return state;
}
