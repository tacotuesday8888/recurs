import { getAgentProfilePolicy, type AgentLifecycle, type AgentProfileId, type AgentSessionDescriptor, type ModelMessage, type ProviderUsage } from "@recurs/contracts";
import type { AnySessionRecord } from "./events.js";
import type { JsonlSessionStore } from "./jsonl-session-store.js";
import { isPinnedSessionState, type PinnedSessionState } from "./session-v2.js";

export interface AgentExecution {
  readonly executionId: string;
  readonly parentExecutionId: string | null;
  readonly agentId: string;
  readonly roleId: string;
  readonly roleName: string;
  readonly profileId: AgentProfileId | null;
  readonly description: string;
  readonly depth: number;
  readonly model: string;
  readonly effort: string | null;
  readonly permissions: AgentSessionDescriptor["permissions"];
  readonly limits: AgentSessionDescriptor["limits"];
  readonly status: AgentLifecycle["status"] | "unknown";
  readonly recordedStatus: AgentLifecycle["status"];
  readonly updatedAt: string;
  readonly usage: ProviderUsage | null;
  readonly changedFiles: readonly string[];
  readonly evidence: readonly string[];
  readonly detail: string | null;
  readonly teamRunId: string | null;
  readonly companyGoalRunId: string | null;
  readonly capabilities: { readonly cancel: boolean; readonly send: false; readonly reason: string };
}

export interface AgentExecutionDetail {
  readonly execution: AgentExecution;
  readonly messages: readonly ModelMessage[];
  readonly transcriptNotice: string | null;
}

/** The durable session is the execution identity. Roles and goal assignments are labels. */
export class AgentExecutionService {
  constructor(
    private readonly sessions: JsonlSessionStore,
    private readonly isActive: (sessionId: string) => boolean = () => false,
  ) {}

  #project(state: PinnedSessionState, updatedAt: string): AgentExecution {
    const agent = state.agent;
    const lifecycle = state.agentLifecycle;
    const active = this.isActive(state.id);
    const status = lifecycle.status === "running" && !active ? "unknown" : lifecycle.status;
    const detail = status === "unknown"
      ? "Last recorded running; no live owner is attached here. Inspect or recover the containing run before assuming work continues."
      : lifecycle.status === "failed" ? lifecycle.failure.safeMessage
      : lifecycle.status === "cancelled" ? lifecycle.reason : null;
    return {
      executionId: state.id,
      parentExecutionId: agent.parentSessionId,
      agentId: agent.id,
      roleId: agent.company?.roleId ?? agent.profile?.id ?? "parent",
      roleName: agent.profile === null ? "Parent" : getAgentProfilePolicy(agent.profile.id).displayName,
      profileId: agent.profile?.id ?? null,
      description: agent.task?.description ?? "Main conversation",
      depth: agent.depth,
      model: state.backend.pin.modelId,
      effort: state.backend.pin.reasoningEffortAtCreation ?? null,
      permissions: agent.permissions,
      limits: agent.limits,
      status,
      recordedStatus: lifecycle.status,
      updatedAt,
      usage: state.agentResult?.usage ?? null,
      changedFiles: state.agentResult?.changedFiles ?? state.changedFiles,
      evidence: state.agentResult?.evidence ?? state.evidence,
      detail,
      teamRunId: agent.team?.runId ?? null,
      companyGoalRunId: agent.companyGoal?.runId ?? null,
      capabilities: {
        cancel: active,
        send: false,
        reason: active
          ? "Cancel stops this execution and its descendants. Targeted child steering is unavailable; return to the parent to give instructions."
          : "No live execution is attached here. This transcript is read-only; return to the parent or recover the containing run.",
      },
    };
  }

  async list(rootSessionId: string): Promise<AgentExecution[]> {
    const states = new Map<string, { state: PinnedSessionState; updatedAt: string }>();
    const scanned = await this.sessions.scanReadOnly();
    for (const entry of scanned.sessions) {
      if (isPinnedSessionState(entry.state)) states.set(entry.state.id, { state: entry.state, updatedAt: entry.updatedAt });
    }
    const belongs = (state: PinnedSessionState): boolean => {
      const seen = new Set<string>();
      let current: PinnedSessionState | undefined = state;
      while (current !== undefined && !seen.has(current.id)) {
        if (current.id === rootSessionId) return true;
        seen.add(current.id);
        current = current.agent.parentSessionId === null ? undefined : states.get(current.agent.parentSessionId)?.state;
      }
      return false;
    };
    return [...states.values()].filter(({ state }) => belongs(state))
      .map(({ state, updatedAt }) => {
        const execution = this.#project(state, updatedAt);
        return state.id === rootSessionId && scanned.unavailableSessionIds.length > 0
          ? { ...execution, detail: `${scanned.unavailableSessionIds.length} session log(s) could not be read. Execution history may be incomplete.` }
          : execution;
      })
      .sort((left, right) => left.depth - right.depth || left.updatedAt.localeCompare(right.updatedAt) || left.executionId.localeCompare(right.executionId));
  }

  async inspect(rootSessionId: string, executionId: string): Promise<AgentExecutionDetail | null> {
    const execution = (await this.list(rootSessionId)).find((item) => item.executionId === executionId);
    if (execution === undefined) return null;
    const state = await this.sessions.loadStateReadOnly(executionId);
    if (!isPinnedSessionState(state)) return null;
    const { records } = await this.sessions.loadReadOnly(executionId);
    return {
      execution,
      messages: durableSessionMessages(records),
      transcriptNotice: state.backend.pin.kind === "agent_runtime"
        ? "This vendor runtime persists prompts and final responses. Its internal conversation and tool trace are not available here."
        : "Completed messages and tool results are durable. An in-flight partial model response is not yet recorded.",
    };
  }
}

/**
 * Reconstruct the complete durable conversation from version-2 session records.
 * Unlike the live session state, this keeps every message across compactions.
 */
export function durableSessionMessages(records: readonly AnySessionRecord[]): ModelMessage[] {
  const messages: ModelMessage[] = [];
  for (const record of records) {
    if (record.version !== 2) continue;
    switch (record.type) {
      case "session_created":
        if (record.fork !== undefined) messages.push(...structuredClone(record.fork.messages));
        break;
      case "turn_started":
      case "turn_steered":
        messages.push({ id: `${record.sequence}:user`, role: "user", content: record.prompt });
        break;
      case "model_completed":
        messages.push(structuredClone(record.message));
        break;
      case "runtime_completed":
        messages.push({ id: `${record.sequence}:runtime`, role: "assistant", content: record.result.finalText });
        break;
      case "tool_completed":
        messages.push({ id: `${record.sequence}:tool`, role: "tool", toolCallId: record.callId, content: record.result.output });
        break;
      case "tool_failed":
        messages.push({ id: `${record.sequence}:tool`, role: "tool", toolCallId: record.callId, content: record.error.safeMessage });
        break;
    }
  }
  return messages;
}
