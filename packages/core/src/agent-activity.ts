import type {
  AgentLifecycle,
  AgentProfileId,
  ProviderUsage,
} from "@recurs/contracts";

import type {
  JsonlSessionStore,
  SessionListEntry,
} from "./jsonl-session-store.js";
import {
  isPinnedSessionState,
  type PinnedSessionState,
} from "./session-v2.js";

export interface AgentActivityIsolation {
  readonly kind: "git_worktree";
  readonly version: 1;
  readonly leaseId: string;
  readonly revision: string;
}

export interface AgentActivityFailure {
  readonly code: string;
  readonly message: string;
}

export interface AgentActivity {
  readonly childSessionId: string;
  readonly childAgentId: string;
  readonly parentSessionId: string;
  readonly profileId: AgentProfileId;
  readonly taskId: string;
  readonly description: string;
  readonly status: AgentLifecycle["status"];
  readonly updatedAt: string;
  readonly usage: ProviderUsage | null;
  readonly changedFiles: readonly string[];
  readonly evidence: readonly string[];
  readonly failure: AgentActivityFailure | null;
  readonly isolation: AgentActivityIsolation | null;
}

function activityFailure(
  lifecycle: AgentLifecycle,
): AgentActivityFailure | null {
  switch (lifecycle.status) {
    case "failed":
      return {
        code: lifecycle.failure.code,
        message: lifecycle.failure.safeMessage,
      };
    case "cancelled":
      return { code: "cancelled", message: lifecycle.reason };
    case "ready":
    case "running":
    case "completed":
      return null;
  }
}

function projectActivity(
  entry: SessionListEntry,
  state: PinnedSessionState,
): AgentActivity | null {
  const { agent } = state;
  if (
    agent.role !== "child" ||
    agent.profile === null ||
    agent.parentSessionId === null ||
    agent.task === null
  ) {
    return null;
  }
  return {
    childSessionId: state.id,
    childAgentId: agent.id,
    parentSessionId: agent.parentSessionId,
    profileId: agent.profile.id,
    taskId: agent.task.id,
    description: agent.task.description,
    status: state.agentLifecycle.status,
    updatedAt: entry.updatedAt,
    usage: state.agentResult?.usage ?? null,
    changedFiles: [...(state.agentResult?.changedFiles ?? [])],
    evidence: [...(state.agentResult?.evidence ?? [])],
    failure: activityFailure(state.agentLifecycle),
    isolation: agent.workspace === undefined
      ? null
      : {
          kind: agent.workspace.kind,
          version: agent.workspace.version,
          leaseId: agent.workspace.leaseId,
          revision: agent.workspace.revision,
        },
  };
}

export class AgentActivityService {
  constructor(private readonly sessions: JsonlSessionStore) {}

  async list(parentSessionId: string): Promise<AgentActivity[]> {
    const activity: AgentActivity[] = [];
    for (const entry of await this.sessions.list()) {
      if (entry.version !== 2) continue;
      const state = await this.sessions.loadState(entry.id);
      if (!isPinnedSessionState(state)) continue;
      const projected = projectActivity(entry, state);
      if (projected?.parentSessionId === parentSessionId) {
        activity.push(projected);
      }
    }
    return activity.sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) ||
      left.childSessionId.localeCompare(right.childSessionId)
    );
  }

  async find(
    parentSessionId: string,
    exactChildOrSessionId: string,
  ): Promise<AgentActivity | null> {
    const activity = await this.list(parentSessionId);
    return activity.find((item) =>
      item.childSessionId === exactChildOrSessionId ||
      item.childAgentId === exactChildOrSessionId
    ) ?? null;
  }
}
