import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  getOperatingModePolicy,
  type AgentSessionDescriptor,
} from "@recurs/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  AgentActivityService,
  JsonlSessionStore,
} from "../src/index.js";
import { testBackendPin } from "../../../tests/support/backend.js";

const directories: string[] = [];
const backend = testBackendPin();

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "recurs-agent-activity-"));
  directories.push(root);
  const sessions = new JsonlSessionStore(path.join(root, "sessions"));
  const parent = await sessions.createPinnedSession({
    id: "parent-session",
    cwd: root,
    backend,
    at: "2026-07-17T00:00:00.000Z",
  });
  const foreignParent = await sessions.createPinnedSession({
    id: "foreign-parent",
    cwd: root,
    backend,
    at: "2026-07-17T00:00:00.000Z",
  });
  return { root, sessions, parent, foreignParent };
}

function childDescriptor(options: {
  agentId: string;
  parentSessionId: string;
  parentAgentId: string;
  description: string;
  isolated?: boolean;
}): AgentSessionDescriptor {
  const mode = getOperatingModePolicy("balanced_v3");
  return {
    id: options.agentId,
    role: "child",
    profile: { id: "implement_v1", version: 1 },
    parentAgentId: options.parentAgentId,
    parentSessionId: options.parentSessionId,
    depth: 1,
    task: {
      id: `${options.agentId}-task`,
      description: options.description,
      prompt: "The full prompt must not appear in activity output",
    },
    operatingMode: { id: mode.id, version: mode.version },
    backend: {
      strategy: "inherit_parent",
      adapterId: backend.adapterId,
      connectionId: backend.connectionId,
      modelId: backend.modelId,
    },
    permissions: {
      parentExecutionMode: "act",
      executionMode: "act",
      parentPermissionMode: "approved_for_me",
      permissionMode: "approved_for_me",
    },
    limits: { ...mode.orchestration, maxRequests: 8 },
    ...(options.isolated
      ? {
          workspace: {
            kind: "git_worktree" as const,
            version: 1 as const,
            leaseId: `${options.agentId}-lease`,
            repositoryRoot: "/private/repository",
        worktreeRoot: `/private/worktrees/${options.agentId}`,
            revision: "a".repeat(40),
          },
        }
      : {}),
  };
}

describe("AgentActivityService", () => {
  it("lists only the parent's durable children in deterministic recency order", async () => {
    const { sessions, parent, foreignParent, root } = await fixture();
    const first = await sessions.createPinnedSession({
      id: "child-ready",
      cwd: root,
      backend,
      agent: childDescriptor({
        agentId: "agent-ready",
        parentSessionId: parent.id,
        parentAgentId: parent.agent.id,
        description: "Older ready task",
      }),
      at: "2026-07-17T00:01:00.000Z",
    });
    const completed = await sessions.createPinnedSession({
      id: "child-completed",
      cwd: "/private/worktrees/agent-completed",
      backend,
      agent: childDescriptor({
        agentId: "agent-completed",
        parentSessionId: parent.id,
        parentAgentId: parent.agent.id,
        description: "Newer completed task",
        isolated: true,
      }),
      at: "2026-07-17T00:02:00.000Z",
    });
    await sessions.withSessionMutation(
      completed.id,
      completed.lastSequence,
      async (lease) => {
        await lease.append({
          type: "turn_started",
          turnId: "completed-turn",
          prompt: "scoped prompt",
          at: "2026-07-17T00:03:00.000Z",
        });
        await lease.append({
          type: "model_completed",
          turnId: "completed-turn",
          message: {
            id: "completed-message",
            role: "assistant",
            content: "implemented",
            toolCalls: [],
          },
          usage: { inputTokens: 11, outputTokens: 7, costUsd: 0.04 },
          stopReason: "complete",
          at: "2026-07-17T00:03:01.000Z",
        });
        await lease.append({
          type: "turn_completed",
          turnId: "completed-turn",
          result: {
            finalText: "implemented",
            usage: { inputTokens: 11, outputTokens: 7, costUsd: 0.04 },
            usageSource: "provider",
            steps: 2,
            changedFiles: ["src/cache.ts"],
            changedFilesSource: "host_tools",
            evidence: ["npm test passed"],
            evidenceSource: "host_tools",
          },
          at: "2026-07-17T00:03:02.000Z",
        });
      },
    );
    await sessions.createPinnedSession({
      id: "foreign-child",
      cwd: root,
      backend,
      agent: childDescriptor({
        agentId: "foreign-agent",
        parentSessionId: foreignParent.id,
        parentAgentId: foreignParent.agent.id,
        description: "Foreign task",
      }),
      at: "2026-07-17T00:04:00.000Z",
    });

    const activity = await new AgentActivityService(sessions).list(parent.id);

    expect(activity.map((item) => item.childSessionId)).toEqual([
      "child-completed",
      "child-ready",
    ]);
    expect(activity[0]).toEqual({
      childSessionId: "child-completed",
      childAgentId: "agent-completed",
      parentSessionId: parent.id,
      profileId: "implement_v1",
      taskId: "agent-completed-task",
      description: "Newer completed task",
      status: "completed",
      updatedAt: "2026-07-17T00:03:02.000Z",
      usage: { inputTokens: 11, outputTokens: 7, costUsd: 0.04 },
      changedFiles: ["src/cache.ts"],
      evidence: ["npm test passed"],
      failure: null,
      isolation: {
        kind: "git_worktree",
        version: 1,
        leaseId: "agent-completed-lease",
        revision: "a".repeat(40),
      },
    });
    expect(activity[1]).toMatchObject({
      childAgentId: "agent-ready",
      status: "ready",
      usage: null,
      changedFiles: [],
      evidence: [],
      failure: null,
      isolation: null,
    });
    expect(JSON.stringify(activity)).not.toContain("full prompt");
    expect(JSON.stringify(activity)).not.toContain("/private/worktrees");
    expect(first.agentLifecycle.status).toBe("ready");
  });

  it("finds exact child/session IDs and does not cross the parent boundary", async () => {
    const { sessions, parent, foreignParent, root } = await fixture();
    const failed = await sessions.createPinnedSession({
      id: "failed-child-session",
      cwd: root,
      backend,
      agent: childDescriptor({
        agentId: "failed-child-agent",
        parentSessionId: parent.id,
        parentAgentId: parent.agent.id,
        description: "Failed task",
      }),
      at: "2026-07-17T00:01:00.000Z",
    });
    await sessions.withSessionMutation(failed.id, failed.lastSequence, async (lease) => {
      await lease.append({
        type: "agent_run_failed",
        failure: {
          domain: "policy",
          phase: "preflight",
          code: "authorization_denied",
          retryable: false,
          diagnosticId: "activity-test-failure",
          safeMessage: "The child could not start",
        },
        at: "2026-07-17T00:02:00.000Z",
      });
    });
    await sessions.createPinnedSession({
      id: "foreign-child-session",
      cwd: root,
      backend,
      agent: childDescriptor({
        agentId: "foreign-child-agent",
        parentSessionId: foreignParent.id,
        parentAgentId: foreignParent.agent.id,
        description: "Foreign task",
      }),
      at: "2026-07-17T00:03:00.000Z",
    });
    const service = new AgentActivityService(sessions);

    await expect(service.find(parent.id, "failed-child-session")).resolves
      .toMatchObject({
        childAgentId: "failed-child-agent",
        status: "failed",
        failure: {
          code: "authorization_denied",
          message: "The child could not start",
        },
      });
    await expect(service.find(parent.id, "failed-child-agent")).resolves
      .toMatchObject({ childSessionId: "failed-child-session" });
    await expect(service.find(parent.id, "foreign-child-session")).resolves.toBeNull();
    await expect(service.find(parent.id, "foreign-child-agent")).resolves.toBeNull();
    await expect(service.find(parent.id, "failed")).resolves.toBeNull();
  });
});
