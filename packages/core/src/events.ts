import type { ModelMessage, StopReason, ToolCall } from "@recurs/providers";
import type {
  IntegrationFailure,
  AgentProfileId,
  OperatingModeId,
  OperatingModeVersion,
  ProviderUsage,
  TeamRunBackendRoute,
  TeamRunExecution,
  TeamRunPhase,
  TeamRunRole,
  TeamRunStatus,
} from "@recurs/contracts";
import type {
  ApprovalResponse,
  ExecutionMode,
  PermissionIntent,
  PermissionMode,
  ToolResult,
} from "@recurs/tools";

import type { Goal } from "./goal.js";
import type { SessionRecordV2 } from "./session-v2.js";
import type {
  TeamRunRecord,
  TeamRunState,
} from "./team-run-state.js";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface SerializableError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface EventSink {
  emit(event: RecursEvent): Promise<void>;
}

interface EventBase {
  sessionId: string;
  at: string;
}

export interface AgentWorkflowUsage {
  childrenStarted: number;
  maxChildren: number;
  requestsReserved: number;
  requestsUsed: number;
  maxRequests: number;
  reportedCostUsd: number;
  maxReportedCostUsd: number;
}

export interface AgentBatchCounts {
  total: number;
  completed: number;
  failed: number;
  cancelled: number;
}

export interface DurableTeamActivityCounts {
  childrenReserved: number;
  childrenFinished: number;
  requestsReserved: number;
  requestsUsed: number;
  costReportedChildren: number;
  costMissingChildren: number;
  costCoverage: TeamRunState["accounting"]["costCoverage"];
}

export type AgentTeamStatus =
  | "approved"
  | "changes_requested"
  | "unverified";

export type AgentTeamFailurePhase = "implementation" | "integration";

export type RecursEvent =
  | (EventBase & { type: "session_created"; cwd: string; model: string })
  | (EventBase & { type: "turn_started"; turnId: string; prompt: string })
  | (EventBase & { type: "model_text_delta"; turnId: string; text: string })
  | (EventBase & { type: "model_reasoning_delta"; turnId: string; text: string })
  | (EventBase & {
      type: "model_completed";
      turnId: string;
      message: ModelMessage;
      usage: Usage;
      stopReason: StopReason;
    })
  | (EventBase & { type: "tool_requested"; call: ToolCall })
  | (EventBase & { type: "tool_started"; call: ToolCall })
  | (EventBase & { type: "tool_completed"; callId: string; result: ToolResult })
  | (EventBase & { type: "tool_failed"; callId: string; error: SerializableError })
  | (EventBase & { type: "tool_denied"; callId: string; intent: PermissionIntent })
  | (EventBase & { type: "permission_requested"; intent: PermissionIntent })
  | (EventBase & {
      type: "permission_resolved";
      intent: PermissionIntent;
      decision: ApprovalResponse | "allowed_by_policy";
    })
  | (EventBase & { type: "goal_updated"; goal: Goal | null })
  | (EventBase & {
      type: "mode_updated";
      executionMode: ExecutionMode;
      permissionMode: PermissionMode;
      prePlanPermissionMode?: PermissionMode;
    })
  | (EventBase & { type: "warning"; code: string; message: string })
  | (EventBase & { type: "retry_scheduled"; attempt: number; delayMs: number })
  | (EventBase & { type: "turn_cancelled"; turnId: string })
  | (EventBase & { type: "files_changed"; paths: string[] })
  | (EventBase & { type: "verification_recorded"; evidence: string[] })
  | (EventBase & { type: "turn_completed"; usage: Usage | null; evidence: string[] })
  | (EventBase & { type: "turn_failed"; error: SerializableError })
  | (EventBase & {
      type: "agent_policy_updated";
      operatingModeId: OperatingModeId;
      operatingModeVersion: OperatingModeVersion;
    })
  | (EventBase & {
      type: "agent_team_activity";
      parentAgentId: string;
      teamId: string;
      sequence: number;
      status: TeamRunStatus;
      phase: TeamRunPhase | null;
      round: number;
      operatingModeId: OperatingModeId;
      execution: TeamRunExecution;
      activity: TeamRunRecord["type"];
      counts: DurableTeamActivityCounts;
      role?: TeamRunRole;
      index?: number;
      routeStrategy?: TeamRunBackendRoute["strategy"];
      routeReason?: TeamRunBackendRoute["reason"];
    })
  | (EventBase & {
      type: "agent_batch_started";
      parentAgentId: string;
      batchId: string;
      operatingModeId: OperatingModeId;
      taskCount: number;
      maxConcurrentChildren: number;
    })
  | (EventBase & {
      type: "agent_batch_completed";
      parentAgentId: string;
      batchId: string;
      operatingModeId: OperatingModeId;
      counts: AgentBatchCounts;
      workflow: AgentWorkflowUsage;
    })
  | (EventBase & {
      type: "agent_batch_failed";
      parentAgentId: string;
      batchId: string;
      operatingModeId: OperatingModeId;
      counts: AgentBatchCounts;
      workflow: AgentWorkflowUsage;
      partial: boolean;
      failure?: { code: string; message: string };
    })
  | (EventBase & {
      type: "agent_batch_cancelled";
      parentAgentId: string;
      batchId: string;
      operatingModeId: OperatingModeId;
      counts: AgentBatchCounts;
      workflow: AgentWorkflowUsage;
      reason: string;
    })
  | (EventBase & {
      type: "agent_team_started";
      parentAgentId: string;
      teamId: string;
      operatingModeId: OperatingModeId;
      description: string;
      implementerCount: number;
      qualityStandard: string;
    })
  | (EventBase & {
      type: "agent_team_patch_captured";
      parentAgentId: string;
      teamId: string;
      operatingModeId: OperatingModeId;
      teamIndex: number;
      childAgentId: string;
      childSessionId: string;
      artifactId: string;
      paths: string[];
    })
  | (EventBase & {
      type: "agent_team_patches_integrated";
      parentAgentId: string;
      teamId: string;
      operatingModeId: OperatingModeId;
      artifactIds: string[];
      changedFiles: string[];
      checkpointId: string;
    })
  | (EventBase & {
      type: "agent_team_review_recorded";
      parentAgentId: string;
      teamId: string;
      operatingModeId: OperatingModeId;
      reviewIndex: number;
      status: "completed" | "invalid" | "failed";
      verdict?: "approve" | "request_changes";
      summary?: string;
      evidence?: string[];
      failure?: { code: string; message: string };
    })
  | (EventBase & {
      type: "agent_team_completed";
      parentAgentId: string;
      teamId: string;
      operatingModeId: OperatingModeId;
      status: AgentTeamStatus;
      changedFiles: string[];
      evidence: string[];
      workflow: AgentWorkflowUsage;
    })
  | (EventBase & {
      type: "agent_team_failed";
      parentAgentId: string;
      teamId: string;
      operatingModeId: OperatingModeId;
      phase: AgentTeamFailurePhase;
      partial: boolean;
      failure: { code: string; message: string };
      workflow: AgentWorkflowUsage;
    })
  | (EventBase & {
      type: "agent_team_cancelled";
      parentAgentId: string;
      teamId: string;
      operatingModeId: OperatingModeId;
      phase: "implementation" | "integration" | "review";
      partial: boolean;
      reason: string;
      workflow: AgentWorkflowUsage;
    })
  | (EventBase & {
      type: "agent_started";
      parentAgentId: string;
      childAgentId: string;
      childSessionId: string;
      taskId: string;
      description: string;
      operatingModeId: OperatingModeId;
      profileId: AgentProfileId;
      batchId?: string;
      batchIndex?: number;
      teamId?: string;
      teamIndex?: number;
    })
  | (EventBase & {
      type: "agent_completed";
      parentAgentId: string;
      childAgentId: string;
      childSessionId: string;
      profileId: AgentProfileId;
      usage: ProviderUsage | null;
      changedFiles: string[];
      evidence: string[];
      costLimitExceeded: boolean;
      workflow: AgentWorkflowUsage;
      batchId?: string;
      batchIndex?: number;
      teamId?: string;
      teamIndex?: number;
    })
  | (EventBase & {
      type: "agent_failed";
      parentAgentId: string;
      childAgentId: string;
      childSessionId: string;
      profileId: AgentProfileId;
      failure: IntegrationFailure;
      batchId?: string;
      batchIndex?: number;
      teamId?: string;
      teamIndex?: number;
    })
  | (EventBase & {
      type: "agent_cancelled";
      parentAgentId: string;
      childAgentId: string;
      childSessionId: string;
      profileId: AgentProfileId;
      reason: string;
      batchId?: string;
      batchIndex?: number;
      teamId?: string;
      teamIndex?: number;
    });

type DurableTeamActivityEvent = Extract<
  RecursEvent,
  { type: "agent_team_activity" }
>;

function activityChild(
  state: TeamRunState,
  record: TeamRunRecord,
): TeamRunState["children"][number] | undefined {
  const attemptId = record.type === "child_reserved"
    ? record.child.attemptId
    : record.type === "child_finished"
      ? record.child.attemptId
      : record.type === "artifact_linked"
        ? record.artifact.attemptId ?? undefined
        : undefined;
  return attemptId === undefined
    ? undefined
    : state.children.find((child) => child.reservation.attemptId === attemptId);
}

function activityRole(
  state: TeamRunState,
  record: TeamRunRecord,
): { role: TeamRunRole; index?: number } | undefined {
  const child = activityChild(state, record);
  if (child !== undefined) {
    return {
      role: child.reservation.role,
      index: child.reservation.index,
    };
  }
  if (record.type === "phase_started" &&
    (record.phase === "implement" || record.phase === "review" ||
      record.phase === "repair")) {
    return { role: record.phase };
  }
  if (record.type === "review_recorded") return { role: "review" };
  return undefined;
}

export function projectTeamRunActivityEvent(
  state: TeamRunState,
): DurableTeamActivityEvent {
  const record = state.records.at(-1)!;
  const role = activityRole(state, record);
  const route = role === undefined
    ? undefined
    : state.descriptor.routes.find((candidate) => candidate.role === role.role);
  const accounting = state.accounting;
  return {
    type: "agent_team_activity",
    sessionId: state.descriptor.parentSessionId,
    at: record.at,
    parentAgentId: state.descriptor.parentAgentId,
    teamId: state.descriptor.id,
    sequence: state.lastSequence,
    status: state.status,
    phase: state.phase,
    round: state.round,
    operatingModeId: state.descriptor.operatingModeId,
    execution: state.descriptor.execution,
    activity: record.type,
    counts: {
      childrenReserved: accounting.childrenReserved,
      childrenFinished: accounting.childrenFinished,
      requestsReserved: accounting.requestsReserved,
      requestsUsed: accounting.requestsUsed,
      costReportedChildren: accounting.costReportedChildren,
      costMissingChildren: accounting.costMissingChildren,
      costCoverage: accounting.costCoverage,
    },
    ...(role === undefined ? {} : {
      role: role.role,
      ...(role.index === undefined ? {} : { index: role.index }),
    }),
    ...(route === undefined ? {} : {
      routeStrategy: route.strategy,
      routeReason: route.reason,
    }),
  };
}

export type SessionRecord =
  | ({ version: 1 } & Extract<RecursEvent, { type: "session_created" }>)
  | ({ version: 1 } & Extract<RecursEvent, { type: "turn_started" }>)
  | ({ version: 1 } & EventBase & { type: "message_appended"; message: ModelMessage })
  | ({ version: 1 } &
      EventBase & {
        type: "session_compacted";
        summary: string;
        retainedMessages: ModelMessage[];
      })
  | ({ version: 1 } & Extract<RecursEvent, { type: "tool_started" }>)
  | ({ version: 1 } & Extract<RecursEvent, { type: "tool_completed" }>)
  | ({ version: 1 } & Extract<RecursEvent, { type: "tool_failed" }>)
  | ({ version: 1 } & Extract<RecursEvent, { type: "permission_resolved" }>)
  | ({ version: 1 } & Extract<RecursEvent, { type: "goal_updated" }>)
  | ({ version: 1 } & Extract<RecursEvent, { type: "mode_updated" }>)
  | ({ version: 1 } & Extract<RecursEvent, { type: "agent_policy_updated" }>)
  | ({ version: 1 } & Extract<RecursEvent, { type: "files_changed" }>)
  | ({ version: 1 } & Extract<RecursEvent, { type: "verification_recorded" }>)
  | ({ version: 1 } & EventBase & {
      type: "turn_completed";
      usage: Usage;
      evidence: string[];
    })
  | ({ version: 1 } & Extract<RecursEvent, { type: "turn_failed" }>);

export type AnySessionRecord = SessionRecord | SessionRecordV2;
