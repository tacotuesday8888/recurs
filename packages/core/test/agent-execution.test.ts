import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  getOperatingModePolicy,
  type AgentSessionDescriptor,
} from "@recurs/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentExecutionService,
  companyAgentLimits,
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

describe("durable execution inventory", () => {
  it("keeps healthy execution history available without modifying damaged unrelated logs", async () => {
    const { sessions, parent, root } = await fixture();
    const damagedPath = path.join(root, "sessions", "damaged.jsonl");
    const damaged = "{not valid JSON}\n";
    await writeFile(damagedPath, damaged);
    const inventory = await new AgentExecutionService(sessions).list(parent.id);
    expect(inventory.map((item) => item.executionId)).toEqual([parent.id]);
    expect(inventory[0]?.detail).toContain("history may be incomplete");
    expect(await readFile(damagedPath, "utf8")).toBe(damaged);
  });

  it("includes every descendant, retains separate executions of the same role, and rejects unrelated transcripts", async () => {
    const { sessions, parent, foreignParent, root } = await fixture();
    const child = await sessions.createPinnedSession({ id: "child", cwd: root, backend, at: "2026-07-17T00:01:00.000Z", agent: childDescriptor({ agentId: "child-agent", parentSessionId: parent.id, parentAgentId: parent.agent.id, description: "Child" }) });
    await sessions.createPinnedSession({ id: "grandchild", cwd: root, backend, at: "2026-07-17T00:02:00.000Z", agent: { ...childDescriptor({ agentId: "grandchild-agent", parentSessionId: child.id, parentAgentId: child.agent.id, description: "Grandchild" }), depth: 2, operatingMode: { id: "balanced_v6", version: 6 }, company: { blueprintId: "company", blueprintVersion: 2, blueprintRevision: 1, roleId: "worker", roleVersion: 1 }, companyGoal: { runId: "goal", assignmentId: "assignment", parentAssignmentId: "lead" }, limits: companyAgentLimits("balanced_v6", { blueprintId: "company", blueprintVersion: 2, blueprintRevision: 1, roleId: "worker", roleVersion: 1 }) } });
    await sessions.createPinnedSession({ id: "sibling", cwd: root, backend, at: "2026-07-17T00:03:00.000Z", agent: childDescriptor({ agentId: "sibling-agent", parentSessionId: parent.id, parentAgentId: parent.agent.id, description: "Another implementer" }) });
    const service = new AgentExecutionService(sessions);
    const inventory = await service.list(parent.id);
    expect(inventory.map((item) => item.executionId)).toEqual([parent.id, "child", "sibling", "grandchild"]);
    expect(inventory.find((item) => item.executionId === "grandchild")).toMatchObject({ parentExecutionId: "child", depth: 2, model: "scripted" });
    // The inspector must show this execution's persisted budget, not mode defaults.
    expect((await service.inspect(parent.id, child.id))?.execution.limits).toEqual(child.agent.limits);
    expect((await service.inspect(parent.id, child.id))?.execution.limits.maxRequests).toBe(8);
    expect(await service.inspect(parent.id, foreignParent.id)).toBeNull();
  });

  it("reads only the conversation's own logs in full", async () => {
    const { sessions, parent, foreignParent, root } = await fixture();
    const child = await sessions.createPinnedSession({ id: "child", cwd: root, backend, at: "2026-07-17T00:01:00.000Z", agent: childDescriptor({ agentId: "child-agent", parentSessionId: parent.id, parentAgentId: parent.agent.id, description: "Child" }) });
    const foreignChild = await sessions.createPinnedSession({ id: "foreign-child", cwd: root, backend, at: "2026-07-17T00:01:00.000Z", agent: childDescriptor({ agentId: "foreign-agent", parentSessionId: foreignParent.id, parentAgentId: foreignParent.agent.id, description: "Other chat" }) });
    // Unrelated history with a damaged later record is neither read nor reported.
    const foreignLog = path.join(root, "sessions", `${foreignChild.id}.jsonl`);
    await writeFile(foreignLog, `${await readFile(foreignLog, "utf8")}{not valid JSON}\n`);
    // A log whose first record is still being written is not yet an execution.
    await writeFile(path.join(root, "sessions", "creating.jsonl"), '{"version":2,"type":"session_created"');
    const read = vi.spyOn(sessions, "loadReadOnly");
    const inventory = await new AgentExecutionService(sessions).list(parent.id);
    expect(inventory.map((item) => item.executionId)).toEqual([parent.id, child.id]);
    expect(inventory[0]?.detail).toBeNull();
    expect(read.mock.calls.map(([id]) => id).sort()).toEqual([child.id, parent.id].sort());
  });

  it("excludes a descendant whose own log fails validation and says history is incomplete", async () => {
    const { sessions, parent, root } = await fixture();
    const child = await sessions.createPinnedSession({ id: "child", cwd: root, backend, at: "2026-07-17T00:01:00.000Z", agent: childDescriptor({ agentId: "child-agent", parentSessionId: parent.id, parentAgentId: parent.agent.id, description: "Child" }) });
    await sessions.createPinnedSession({ id: "grandchild", cwd: root, backend, at: "2026-07-17T00:02:00.000Z", agent: { ...childDescriptor({ agentId: "grandchild-agent", parentSessionId: child.id, parentAgentId: child.agent.id, description: "Grandchild" }), depth: 2, operatingMode: { id: "balanced_v6", version: 6 }, company: { blueprintId: "company", blueprintVersion: 2, blueprintRevision: 1, roleId: "worker", roleVersion: 1 }, companyGoal: { runId: "goal", assignmentId: "assignment", parentAssignmentId: "lead" }, limits: companyAgentLimits("balanced_v6", { blueprintId: "company", blueprintVersion: 2, blueprintRevision: 1, roleId: "worker", roleVersion: 1 }) } });
    const childLog = path.join(root, "sessions", `${child.id}.jsonl`);
    await writeFile(childLog, `${await readFile(childLog, "utf8")}{not valid JSON}\n`);
    const inventory = await new AgentExecutionService(sessions).list(parent.id);
    // The grandchild's validated ancestry passes through the unreadable child.
    expect(inventory.map((item) => item.executionId)).toEqual([parent.id]);
    expect(inventory[0]?.detail).toContain("1 session log(s) could not be read");
  });

  it("ignores parent cycles outside the conversation", async () => {
    const { sessions, parent, root } = await fixture();
    for (const [id, parentId] of [["loop-a", "loop-b"], ["loop-b", "loop-a"]] as const) {
      await sessions.createPinnedSession({ id, cwd: root, backend, at: "2026-07-17T00:01:00.000Z", agent: childDescriptor({ agentId: `${id}-agent`, parentSessionId: parentId, parentAgentId: `${parentId}-agent`, description: id }) });
    }
    expect((await new AgentExecutionService(sessions).list(parent.id)).map((item) => item.executionId)).toEqual([parent.id]);
  });

  it("reports unowned recorded activity honestly and reads the selected durable conversation", async () => {
    const { sessions, parent, root } = await fixture();
    const child = await sessions.createPinnedSession({ id: "child", cwd: root, backend, at: "2026-07-17T00:01:00.000Z", agent: childDescriptor({ agentId: "child-agent", parentSessionId: parent.id, parentAgentId: parent.agent.id, description: "Child" }) });
    await sessions.withSessionMutation(child.id, child.lastSequence, async (lease) => {
      await lease.append({ type: "turn_started", turnId: "turn", prompt: "Exact child prompt", at: "2026-07-17T00:02:00.000Z" });
      await lease.append({ type: "model_completed", turnId: "turn", message: { id: "response", role: "assistant", content: "Exact child response", toolCalls: [] }, usage: null, stopReason: "complete", at: "2026-07-17T00:03:00.000Z" });
    });
    const disconnected = new AgentExecutionService(sessions);
    const detail = await disconnected.inspect(parent.id, child.id);
    expect(detail?.execution).toMatchObject({ status: "unknown", recordedStatus: "running", capabilities: { cancel: false, send: false }, usage: null });
    expect(detail?.messages.map((message) => message.content)).toEqual(["Exact child prompt", "Exact child response"]);
    expect((await new AgentExecutionService(sessions, (id) => id === child.id).inspect(parent.id, child.id))?.execution).toMatchObject({ status: "running", capabilities: { cancel: true, send: false } });
    expect((await sessions.loadState(child.id)).agentLifecycle.status).toBe("running");
  });
});
