import { isDeepStrictEqual } from "node:util";

import type {
  AgentLifecycle,
  AgentResult,
  AgentSessionDescriptor,
  IntegrationFailure,
  ModelMessage,
  ProviderBackedMessage,
  ProviderUsage,
  RunResult,
  RuntimeApprovalDecision,
  RuntimeApprovalRequest,
  RuntimeContinuationHandle,
  SessionBackendPin,
  StopReason,
  ToolCall,
} from "@recurs/contracts";
import {
  DEFAULT_OPERATING_MODE_ID,
  LEGACY_OPERATING_MODE_ID,
  MAX_PENDING_QUEUED_TURNS,
  getAgentProfilePolicy,
  getOperatingModePolicy,
  narrowAgentPermissionMode,
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
import { createBackendFingerprint } from "./backend-authorization.js";
import { restoredRuntimePredecessor } from "./runtime-continuation-lifecycle.js";

export interface SessionRecordBaseV2 {
  version: 2;
  sessionId: string;
  sequence: number;
  at: string;
}

export interface QueuedTurn {
  readonly id: string;
  readonly prompt: string;
  readonly queuedAt: string;
  readonly sourceTurnId: string | null;
}

export interface SessionForkSnapshotV2 {
  readonly sourceSessionId: string;
  readonly sourceSequence: number;
  readonly messages: readonly ModelMessage[];
  readonly messageTurnIds: Readonly<Record<string, string>>;
  readonly summary: string | null;
  readonly prePlanPermissionMode?: PermissionMode;
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

export type RuntimeApprovalScope =
  | "allow_once"
  | "allow_session"
  | "deny"
  | "cancel";

export type RuntimeRecordProvenance = "user" | "policy" | "signal";

export interface RuntimeCompletionProvenance {
  adapterId: string;
  connectionId: string;
  modelId: string;
  backendFingerprint: string;
  capabilityProfileRevision: string;
}

export interface PendingRuntimeCompletion {
  turnId: string;
  result: RunResult;
  stopReason: "complete" | "length";
  continuation?: RuntimeContinuationHandle;
  provenance: RuntimeCompletionProvenance;
}

type RuntimeContinuationUpdatedRecordV2 = SessionRecordBaseV2 & {
  type: "runtime_continuation_updated";
  turnId: string;
  continuation: RuntimeContinuationHandle;
};

type RuntimeApprovalResolvedRecordV2 = SessionRecordBaseV2 & {
  type: "runtime_approval_resolved";
  turnId: string;
  request: RuntimeApprovalRequest;
  decision: RuntimeApprovalDecision;
  scope: RuntimeApprovalScope;
  provenance: RuntimeRecordProvenance;
};

type RuntimeCompletedRecordV2 = SessionRecordBaseV2 & {
  type: "runtime_completed";
  turnId: string;
  result: RunResult;
  stopReason: "complete" | "length";
  continuation?: RuntimeContinuationHandle;
  provenance: RuntimeCompletionProvenance;
};

type RuntimeContinuationReconciledRecordV2 = SessionRecordBaseV2 & {
  type: "runtime_continuation_reconciled";
  operationId: string;
  uncertainHandle: RuntimeContinuationHandle;
  outcome: "committed" | "gone";
  activeHandle: RuntimeContinuationHandle | null;
};

export type SessionRecordV2 =
  | (SessionRecordBaseV2 & {
      type: "session_created";
      cwd: string;
      backend: SessionBackendPin;
      agent?: AgentSessionDescriptor;
      fork?: SessionForkSnapshotV2;
    })
  | (SessionRecordBaseV2 & {
      type: "turn_started";
      turnId: string;
      prompt: string;
      queuedInputId?: string;
    })
  | (SessionRecordBaseV2 & {
      type: "prompt_queued";
      queuedInputId: string;
      prompt: string;
      sourceTurnId?: string;
    })
  | (SessionRecordBaseV2 & {
      type: "prompt_queue_cleared";
      queuedInputIds: string[];
    })
  | (SessionRecordBaseV2 & {
      type: "turn_steered";
      turnId: string;
      steeringId: string;
      prompt: string;
    })
  | RuntimeContinuationUpdatedRecordV2
  | RuntimeApprovalResolvedRecordV2
  | RuntimeCompletedRecordV2
  | RuntimeContinuationReconciledRecordV2
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
      continuation?: RuntimeContinuationHandle;
    })
  | (SessionRecordBaseV2 & {
      type: "turn_cancelled";
      turnId: string;
      reason: string;
      continuation?: RuntimeContinuationHandle;
    })
  | (SessionRecordBaseV2 & {
      type: "turn_interrupted";
      turnId: string;
      reason: string;
    })
  | (SessionRecordBaseV2 & {
      type: "agent_run_failed";
      failure: IntegrationFailure;
    })
  | (SessionRecordBaseV2 & {
      type: "agent_run_cancelled";
      reason: string;
    })
  | (SessionRecordBaseV2 & {
      type: "agent_policy_updated";
      operatingModeId: AgentSessionDescriptor["operatingMode"]["id"];
      operatingModeVersion: AgentSessionDescriptor["operatingMode"]["version"];
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
  runtimeContinuation: RuntimeContinuationHandle | null;
  runtimeContinuationPredecessor: RuntimeContinuationHandle | null;
  pendingRuntimeCompletion: PendingRuntimeCompletion | null;
  agent: AgentSessionDescriptor;
  agentLifecycle: AgentLifecycle;
  agentResult: AgentResult | null;
  queuedTurns: QueuedTurn[];
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

export function createRootAgentDescriptor(
  sessionId: string,
  backend: SessionBackendPin,
  operatingModeId = DEFAULT_OPERATING_MODE_ID,
  permissionMode: PermissionMode = "ask_always",
): AgentSessionDescriptor {
  const mode = getOperatingModePolicy(operatingModeId);
  return {
    id: `${sessionId}:agent`,
    role: "parent",
    profile: null,
    parentAgentId: null,
    parentSessionId: null,
    depth: 0,
    task: null,
    operatingMode: { id: mode.id, version: mode.version },
    backend: {
      strategy: "session_pin",
      adapterId: backend.adapterId,
      connectionId: backend.connectionId,
      modelId: backend.modelId,
    },
    permissions: {
      parentExecutionMode: "act",
      executionMode: "act",
      parentPermissionMode: permissionMode,
      permissionMode,
    },
    limits: mode.orchestration,
  };
}

function agentResult(result: RunResult): AgentResult {
  return {
    finalText: result.finalText,
    usage: result.usage,
    usageSource: result.usageSource,
    steps: result.steps,
    changedFiles: [...result.changedFiles],
    changedFilesSource: result.changedFilesSource,
    evidence: [...result.evidence],
    evidenceSource: result.evidenceSource,
  };
}

function terminalLifecycle(
  state: PinnedSessionState,
  child: AgentLifecycle,
): AgentLifecycle {
  return state.agent.role === "child" ? child : { status: "ready" };
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

const optionalUsageFields = [
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "reasoningTokens",
  "costUsd",
] as const;

function addUsage(
  current: ProviderUsage,
  addition: ProviderUsage | null,
): ProviderUsage {
  if (addition === null) {
    return current;
  }
  const next: ProviderUsage = {
    inputTokens: current.inputTokens + addition.inputTokens,
    outputTokens: current.outputTokens + addition.outputTokens,
  };
  for (const field of optionalUsageFields) {
    const currentValue = current[field];
    const additionValue = addition[field];
    if (currentValue !== undefined || additionValue !== undefined) {
      next[field] = (currentValue ?? 0) + (additionValue ?? 0);
    }
  }
  return next;
}

function addRuntimeUsage(
  current: ProviderUsage,
  addition: ProviderUsage | null,
): ProviderUsage {
  const next = addUsage(current, addition);
  const tokenFields = [
    "inputTokens",
    "outputTokens",
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "reasoningTokens",
  ] as const;
  if (
    tokenFields.some((field) =>
      next[field] !== undefined && !Number.isSafeInteger(next[field])
    ) ||
    (next.costUsd !== undefined && !Number.isFinite(next.costUsd))
  ) {
    throw new Error("Runtime usage exceeds the safe numeric range");
  }
  return next;
}

function runtimePin(
  state: PinnedSessionState,
): SessionBackendPin & { kind: "agent_runtime" } {
  const pin = state.backend.pin;
  if (pin.kind !== "agent_runtime") {
    throw new Error("Runtime records require an agent-runtime backend pin");
  }
  return pin as SessionBackendPin & { kind: "agent_runtime" };
}

function assertRuntimeHandleBinding(
  state: PinnedSessionState,
  handle: RuntimeContinuationHandle,
): void {
  const pin = runtimePin(state);
  if (
    handle.recursSessionId !== state.id ||
    handle.adapterId !== pin.adapterId ||
    handle.connectionId !== pin.connectionId ||
    handle.modelId !== pin.modelId ||
    handle.backendFingerprint !== createBackendFingerprint(pin)
  ) {
    throw new Error("Runtime continuation does not match the pinned session");
  }
}

function sameRuntimeHandleWithStatus(
  uncertain: RuntimeContinuationHandle,
  active: RuntimeContinuationHandle,
): boolean {
  return uncertain.status === "uncertain" &&
    active.status === "committed" &&
    isDeepStrictEqual({ ...uncertain, status: "committed" }, active);
}

function assertRuntimeContinuationSuccessor(
  state: PinnedSessionState,
  turnId: string,
  continuation: RuntimeContinuationHandle,
): void {
  assertRuntimeHandleBinding(state, continuation);
  const previous = state.runtimeContinuation;
  if (
    continuation.status !== "uncertain" ||
    continuation.originTurnId !== turnId ||
    state.runtimeContinuationPredecessor !== null ||
    previous?.status === "uncertain" ||
    continuation.continuationSequence !==
      (previous?.continuationSequence ?? 0) + 1 ||
    continuation.vendorTurnSequence !==
      (previous?.vendorTurnSequence ?? 0) + 1 ||
    (previous !== null &&
      (continuation.id === previous.id ||
        continuation.storageClass !== previous.storageClass ||
        continuation.ownerInstanceId !== previous.ownerInstanceId))
  ) {
    throw new Error("Runtime continuation is not the next committed successor");
  }
}

function assertExactUncertainTerminal(
  state: PinnedSessionState,
  continuation: RuntimeContinuationHandle,
): void {
  assertRuntimeHandleBinding(state, continuation);
  if (
    continuation.status !== "uncertain" ||
    !isDeepStrictEqual(state.runtimeContinuation, continuation)
  ) {
    throw new Error("Runtime terminal continuation does not match the uncertain tip");
  }
}

function pendingRuntimeCompletion(
  record: RuntimeCompletedRecordV2,
): PendingRuntimeCompletion {
  return structuredClone({
    turnId: record.turnId,
    result: record.result,
    stopReason: record.stopReason,
    ...(record.continuation === undefined
      ? {}
      : { continuation: record.continuation }),
    provenance: record.provenance,
  });
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
  if (record.type === "turn_started") {
    if (state.openTurnId !== null) {
      throw new Error(
        `Session ${state.id} already has an open turn ${state.openTurnId}`,
      );
    }
    if (state.pendingCompaction !== null) {
      throw new Error("Cannot start a turn while compaction is pending");
    }
    if (
      state.pendingRuntimeCompletion !== null ||
      state.runtimeContinuation?.status === "uncertain"
    ) {
      throw new Error("An uncertain delegated runtime turn must be resolved first");
    }
    if (state.agent.role === "child" && state.agentLifecycle.status !== "ready") {
      throw new Error("A terminal child agent cannot start another turn");
    }
    if (record.queuedInputId === undefined) {
      if (state.queuedTurns.length > 0) {
        throw new Error("Pending queued prompts must be resumed or cleared first");
      }
    } else {
      const queued = state.queuedTurns[0];
      if (
        queued?.id !== record.queuedInputId || queued.prompt !== record.prompt
      ) {
        throw new Error("Queued turn start does not match the FIFO queue head");
      }
    }
  } else if ("turnId" in record && state.openTurnId !== record.turnId) {
    throw new Error(`Record ${record.type} does not match the open turn`);
  }
  if (
    record.type === "tool_started" &&
    state.pendingToolCalls.some((call) => call.id === record.call.id)
  ) {
    throw new Error(`Tool call ${record.call.id} is already pending`);
  }
  if (
    record.type === "turn_steered" &&
    state.messages.some((message) =>
      message.id === `${record.turnId}:steer:${record.steeringId}`
    )
  ) {
    throw new Error(`Steering input ${record.steeringId} is already recorded`);
  }
  if (record.type === "prompt_queued") {
    if (state.agent.role !== "parent") {
      throw new Error("Only a parent session can queue another turn");
    }
    if (
      record.sourceTurnId === undefined
        ? state.openTurnId !== null
        : state.openTurnId !== record.sourceTurnId
    ) {
      throw new Error("Queued prompt source does not match the session turn state");
    }
    if (
      state.queuedTurns.length >= MAX_PENDING_QUEUED_TURNS ||
      state.queuedTurns.some((queued) => queued.id === record.queuedInputId)
    ) {
      throw new Error("Queued prompt capacity or identity is invalid");
    }
  }
  if (record.type === "prompt_queue_cleared") {
    if (
      state.openTurnId !== null ||
      !isDeepStrictEqual(
        record.queuedInputIds,
        state.queuedTurns.map((queued) => queued.id),
      )
    ) {
      throw new Error("Queue clearing requires the exact idle prompt queue");
    }
  }
  if (
    (record.type === "tool_completed" || record.type === "tool_failed") &&
    !state.pendingToolCalls.some((call) => call.id === record.callId)
  ) {
    throw new Error(`Tool call ${record.callId} is not pending`);
  }
  if (
    (record.type === "turn_completed" ||
      record.type === "turn_failed" ||
      record.type === "turn_cancelled" ||
      record.type === "turn_interrupted") &&
    state.pendingToolCalls.length > 0
  ) {
    throw new Error("Cannot close a turn with pending tool calls");
  }
  if (
    (record.type === "agent_run_failed" ||
      record.type === "agent_run_cancelled") &&
    (state.agent.role !== "child" || state.openTurnId !== null ||
      state.agentLifecycle.status !== "ready")
  ) {
    throw new Error("An agent preflight terminal requires a ready child");
  }
  if (
    record.type === "agent_policy_updated" &&
    (state.agent.role !== "parent" || state.openTurnId !== null)
  ) {
    throw new Error("Agent policy can change only on an idle parent");
  }
  if (record.type === "compaction_started") {
    if (
      state.openTurnId !== null || state.pendingCompaction !== null ||
      state.queuedTurns.length > 0
    ) {
      throw new Error("Compaction requires an idle session");
    }
    if (record.inputBaseSequence !== state.lastSequence) {
      throw new Error("Compaction input sequence is stale");
    }
  }
  if (
    (record.type === "session_compacted" ||
      record.type === "compaction_failed" ||
      record.type === "compaction_interrupted") &&
    state.pendingCompaction?.operationId !== record.operationId
  ) {
    throw new Error("Compaction terminal does not match the pending operation");
  }
  if (
    record.type === "runtime_continuation_reconciled" &&
    (state.openTurnId !== null || state.pendingCompaction !== null ||
      state.pendingRuntimeCompletion !== null)
  ) {
    throw new Error("Runtime continuation reconciliation requires an idle session");
  }
  let next: PinnedSessionState;
  switch (record.type) {
    case "session_created":
      throw new Error("session_created may appear only at sequence zero");
    case "turn_started":
      next = addMessage(
        {
          ...state,
          queuedTurns: record.queuedInputId === undefined
            ? state.queuedTurns
            : state.queuedTurns.slice(1),
          openTurnId: record.turnId,
          agentLifecycle: { status: "running", turnId: record.turnId },
        },
        {
          id: `${record.turnId}:user`,
          role: "user",
          content: record.prompt,
        },
        record.turnId,
      );
      break;
    case "prompt_queued":
      next = {
        ...state,
        queuedTurns: [...state.queuedTurns, {
          id: record.queuedInputId,
          prompt: record.prompt,
          queuedAt: record.at,
          sourceTurnId: record.sourceTurnId ?? null,
        }],
      };
      break;
    case "prompt_queue_cleared":
      next = { ...state, queuedTurns: [] };
      break;
    case "turn_steered":
      next = addMessage(
        state,
        {
          id: `${record.turnId}:steer:${record.steeringId}`,
          role: "user",
          content: record.prompt,
        },
        record.turnId,
      );
      break;
    case "runtime_continuation_updated":
      if (state.pendingRuntimeCompletion !== null) {
        throw new Error("Runtime completion is already pending");
      }
      assertRuntimeContinuationSuccessor(
        state,
        record.turnId,
        record.continuation,
      );
      next = {
        ...state,
        runtimeContinuationPredecessor: state.runtimeContinuation,
        runtimeContinuation: structuredClone(record.continuation),
      };
      break;
    case "runtime_approval_resolved":
      runtimePin(state);
      if (state.pendingRuntimeCompletion !== null) {
        throw new Error("Runtime completion is already pending");
      }
      next = state;
      break;
    case "runtime_completed": {
      const pin = runtimePin(state);
      if (
        state.pendingRuntimeCompletion !== null ||
        record.provenance.adapterId !== pin.adapterId ||
        record.provenance.connectionId !== pin.connectionId ||
        record.provenance.modelId !== pin.modelId ||
        record.provenance.backendFingerprint !== createBackendFingerprint(pin) ||
        record.provenance.capabilityProfileRevision !==
          pin.runtimeCapabilityProfileRevisionAtCreation
      ) {
        throw new Error("Runtime completion provenance does not match the session");
      }
      let activeContinuation = state.runtimeContinuation;
      if (record.continuation === undefined) {
        if (activeContinuation?.status === "uncertain") {
          throw new Error("Runtime completion did not resolve the uncertain tip");
        }
      } else {
        if (
          activeContinuation === null ||
          !sameRuntimeHandleWithStatus(activeContinuation, record.continuation)
        ) {
          throw new Error("Runtime completion did not commit the uncertain tip");
        }
        assertRuntimeHandleBinding(state, record.continuation);
        activeContinuation = structuredClone(record.continuation);
      }
      next = addMessage(
        {
          ...state,
          usage: addRuntimeUsage(state.usage, record.result.usage),
          changedFiles: unique([
            ...state.changedFiles,
            ...record.result.changedFiles,
          ]),
          evidence: unique([...state.evidence, ...record.result.evidence]),
          runtimeContinuation: activeContinuation,
          runtimeContinuationPredecessor: null,
          pendingRuntimeCompletion: pendingRuntimeCompletion(record),
        },
        {
          id: `${record.turnId}:runtime:assistant`,
          role: "assistant",
          content: record.result.finalText,
        },
        record.turnId,
      );
      break;
    }
    case "runtime_continuation_reconciled": {
      runtimePin(state);
      if (
        state.runtimeContinuation === null ||
        state.runtimeContinuation.status !== "uncertain" ||
        !isDeepStrictEqual(state.runtimeContinuation, record.uncertainHandle)
      ) {
        throw new Error("Runtime reconciliation does not match the uncertain tip");
      }
      assertRuntimeHandleBinding(state, record.uncertainHandle);
      if (record.outcome === "committed") {
        if (
          record.activeHandle === null ||
          !sameRuntimeHandleWithStatus(
            record.uncertainHandle,
            record.activeHandle,
          )
        ) {
          throw new Error("Committed reconciliation changed the runtime handle");
        }
        assertRuntimeHandleBinding(state, record.activeHandle);
      } else if (
        !isDeepStrictEqual(
          record.activeHandle,
          restoredRuntimePredecessor(
            state.runtimeContinuationPredecessor,
            record.uncertainHandle,
          ),
        )
      ) {
        throw new Error("Gone reconciliation did not restore the predecessor");
      }
      next = {
        ...state,
        runtimeContinuation: record.activeHandle === null
          ? null
          : structuredClone(record.activeHandle),
        runtimeContinuationPredecessor: null,
      };
      break;
    }
    case "model_completed":
      next = addMessage(
        {
          ...state,
          usage: {
            inputTokens:
              state.usage.inputTokens + (record.usage?.inputTokens ?? 0),
            outputTokens:
              state.usage.outputTokens + (record.usage?.outputTokens ?? 0),
          },
        },
        record.message,
        record.turnId,
      );
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
          content: record.error.domain === "tool" &&
            record.error.safeMessage.startsWith("Tool error [")
            ? record.error.safeMessage
            : `Tool error [${record.error.code}]: ${record.error.safeMessage}`,
          toolCallId: record.callId,
        },
        record.turnId,
      );
      break;
    case "goal_updated":
      next = { ...state, goal: record.goal };
      break;
    case "mode_updated": {
      if (state.agent.role === "child" &&
        (narrowAgentPermissionMode(
          state.agent.permissions.parentPermissionMode,
          record.permissionMode,
        ) !== record.permissionMode ||
          (state.agent.permissions.parentExecutionMode === "plan" &&
            record.executionMode !== "plan") ||
          (state.agent.profile !== null &&
            getAgentProfilePolicy(state.agent.profile.id).executionMode !==
              record.executionMode))) {
        throw new Error("Mode update violates the child agent profile");
      }
      next = {
        ...state,
        executionMode: record.executionMode,
        permissionMode: record.permissionMode,
        agent: {
          ...state.agent,
          permissions: {
            parentExecutionMode: state.agent.role === "parent"
              ? record.executionMode
              : state.agent.permissions.parentExecutionMode,
            executionMode: record.executionMode,
            parentPermissionMode: state.agent.role === "parent"
              ? record.permissionMode
              : state.agent.permissions.parentPermissionMode,
            permissionMode: record.permissionMode,
          },
        },
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
      if (state.pendingRuntimeCompletion !== null) {
        if (
          state.pendingRuntimeCompletion.turnId !== record.turnId ||
          !isDeepStrictEqual(state.pendingRuntimeCompletion.result, record.result)
        ) {
          throw new Error("Turn completion does not match runtime completion");
        }
        next = {
          ...state,
          openTurnId: null,
          pendingRuntimeCompletion: null,
          agentLifecycle: terminalLifecycle(state, {
            status: "completed",
            turnId: record.turnId,
          }),
          agentResult: agentResult(record.result),
        };
      } else {
        if (state.backend.pin.kind === "agent_runtime") {
          throw new Error("Delegated turns require a durable runtime completion");
        }
        next = {
          ...state,
          openTurnId: null,
          changedFiles: unique([
            ...state.changedFiles,
            ...record.result.changedFiles,
          ]),
          evidence: unique([...state.evidence, ...record.result.evidence]),
          agentLifecycle: terminalLifecycle(state, {
            status: "completed",
            turnId: record.turnId,
          }),
          agentResult: agentResult(record.result),
        };
      }
      break;
    case "turn_failed":
    case "turn_cancelled":
      if (state.pendingRuntimeCompletion !== null) {
        throw new Error("A completed runtime turn cannot fail or cancel");
      }
      if (
        state.runtimeContinuation?.status === "uncertain" &&
        record.continuation === undefined
      ) {
        throw new Error("A runtime terminal must preserve the uncertain tip");
      }
      if (record.continuation !== undefined) {
        assertExactUncertainTerminal(state, record.continuation);
      }
      next = {
        ...state,
        openTurnId: null,
        agentLifecycle: record.type === "turn_cancelled"
          ? terminalLifecycle(state, {
              status: "cancelled",
              turnId: record.turnId,
              reason: record.reason,
            })
          : terminalLifecycle(state, {
              status: "failed",
              turnId: record.turnId,
              failure: record.error,
            }),
        agentResult: null,
      };
      break;
    case "turn_interrupted":
      if (state.pendingRuntimeCompletion !== null) {
        throw new Error("A completed runtime turn must close successfully");
      }
      next = {
        ...state,
        openTurnId: null,
        agentLifecycle: terminalLifecycle(state, {
          status: "failed",
          turnId: record.turnId,
          failure: {
            domain: "runtime",
            phase: "started",
            code: "runtime_failed",
            safeMessage: record.reason,
            diagnosticId: `${state.id}:${record.turnId}:interrupted`,
            retryable: false,
          },
        }),
        agentResult: null,
      };
      break;
    case "agent_run_failed":
      next = {
        ...state,
        agentLifecycle: {
          status: "failed",
          turnId: null,
          failure: record.failure,
        },
        agentResult: null,
      };
      break;
    case "agent_run_cancelled":
      next = {
        ...state,
        agentLifecycle: {
          status: "cancelled",
          turnId: null,
          reason: record.reason,
        },
        agentResult: null,
      };
      break;
    case "agent_policy_updated": {
      const policy = getOperatingModePolicy(record.operatingModeId);
      if (record.operatingModeVersion !== policy.version) {
        throw new Error("Agent policy version does not match its stable id");
      }
      next = {
        ...state,
        agent: {
          ...state.agent,
          operatingMode: { id: policy.id, version: policy.version },
          limits: policy.orchestration,
        },
      };
      break;
    }
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
        pendingCompaction: null,
        messages,
        messageTurnIds: Object.fromEntries(
          Object.entries(state.messageTurnIds).filter(([id]) => ids.has(id)),
        ),
      };
      break;
    }
    case "permission_resolved":
      next = state;
      break;
    case "compaction_started":
      next = {
        ...state,
        pendingCompaction: {
          operationId: record.operationId,
          inputBaseSequence: record.inputBaseSequence,
        },
      };
      break;
    case "compaction_failed":
    case "compaction_interrupted":
      next = { ...state, pendingCompaction: null };
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
  const agent = first.agent ?? createRootAgentDescriptor(
    first.sessionId,
    first.backend,
    LEGACY_OPERATING_MODE_ID,
  );
  let state: PinnedSessionState = {
    version: 2,
    id: first.sessionId,
    cwd: first.cwd,
    model: first.backend.modelId,
    backend: { type: "pinned", pin: first.backend },
    lastSequence: 0,
    forkedFrom: first.fork === undefined ? null : {
      sessionId: first.fork.sourceSessionId,
      sequence: first.fork.sourceSequence,
    },
    messages: first.fork === undefined ? [] : [...structuredClone(first.fork.messages)],
    messageTurnIds: first.fork === undefined
      ? {}
      : structuredClone(first.fork.messageTurnIds),
    summary: first.fork?.summary ?? null,
    permissionMode: agent.permissions.permissionMode,
    executionMode: agent.permissions.executionMode,
    ...(first.fork?.prePlanPermissionMode === undefined
      ? {}
      : { prePlanPermissionMode: first.fork.prePlanPermissionMode }),
    goal: null,
    usage: { inputTokens: 0, outputTokens: 0 },
    evidence: [],
    changedFiles: [],
    pendingToolCalls: [],
    toolOutcomes: {},
    openTurnId: null,
    pendingCompaction: null,
    runtimeContinuation: null,
    runtimeContinuationPredecessor: null,
    pendingRuntimeCompletion: null,
    agent,
    agentLifecycle: { status: "ready" },
    agentResult: null,
    queuedTurns: [],
  };
  for (const record of records.slice(1)) {
    state = reduceSessionRecordV2(state, record);
  }
  return state;
}
