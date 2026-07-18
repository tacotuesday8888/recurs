import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  getOperatingModePolicy,
  type AgentSessionDescriptor,
  type TeamRunDescriptor,
  type TeamRunPolicySnapshot,
} from "@recurs/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { JsonlSessionStore } from "../src/jsonl-session-store.js";
import { teamChildAssignmentSha256 } from "../src/team-child-binding.js";
import {
  recoverDurableTeamChild,
  recoverInterruptedTeamChild,
  type TeamChildRecoveryExpectation,
} from "../src/team-child-recovery.js";
import { testAt, testBackendPin } from "../../../tests/support/backend.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "recurs-team-child-recovery-"));
  directories.push(root);
  const sessions = new JsonlSessionStore(path.join(root, "sessions"));
  const pin = testBackendPin("team-child-model");
  const mode = getOperatingModePolicy("balanced_v4");
  const agent: AgentSessionDescriptor = {
    id: "child-agent",
    role: "child",
    profile: { id: "implement_v2", version: 2 },
    parentAgentId: "parent-agent",
    parentSessionId: "parent-session",
    depth: 1,
    task: {
      id: "child-task",
      description: "Implement the bounded child task",
      prompt: "Change src/value.ts.",
    },
    operatingMode: { id: mode.id, version: mode.version },
    backend: {
      strategy: "policy_route",
      candidateId: "parent",
      reason: "parent_fallback",
      adapterId: pin.adapterId,
      connectionId: pin.connectionId,
      modelId: pin.modelId,
    },
    permissions: {
      parentExecutionMode: "act",
      executionMode: "act",
      parentPermissionMode: "full_access",
      permissionMode: "full_access",
    },
    limits: { ...mode.orchestration, maxRequests: 8 },
    workspace: {
      kind: "git_worktree",
      version: 1,
      leaseId: "lease-1",
      repositoryRoot: root,
      worktreeRoot: path.join(root, "lease-1"),
      revision: "a".repeat(40),
    },
    team: {
      runId: "team-run",
      role: "implement",
      taskIndex: 1,
      round: 0,
      attemptId: "attempt-1",
    },
  };
  const child = await sessions.createPinnedSession({
    id: "child-session",
    cwd: path.join(root, "lease-1"),
    backend: pin,
    agent,
    at: testAt,
  });
  const expectation: TeamChildRecoveryExpectation = {
    childSessionId: child.id,
    childAgentId: agent.id,
    parentSessionId: "parent-session",
    parentAgentId: "parent-agent",
    runId: "team-run",
    attemptId: "attempt-1",
    role: "implement",
    index: 1,
    round: 0,
    at: "2026-07-18T00:00:01.000Z",
  };
  const descriptor: TeamRunDescriptor = {
    id: "team-run",
    version: 1,
    parentSessionId: "parent-session",
    parentAgentId: "parent-agent",
    execution: "background",
    parentExecutionMode: "act",
    parentPermissionMode: "full_access",
    invocation: {
      invocation: "repl",
      presence: "present",
      location: "local",
      automation: "manual",
      embedding: "cli",
    },
    operatingModeId: mode.id,
    operatingModeVersion: mode.version,
    policy: structuredClone(mode) as TeamRunPolicySnapshot,
    allocation: {
      maxChildren: mode.workflow.maxChildrenPerRun,
      maxRequests: mode.workflow.maxRequestsPerRun,
      requestAllowance: 8,
      maxReportedCostUsd: mode.orchestration.maxReportedCostUsd,
    },
    routes: ([
      ["implement", "implement_v2"],
      ["review", "review_v2"],
      ["repair", "repair_v1"],
    ] as const).map(([role, profileId]) => ({
      role,
      profileId,
      executionMode: "act",
      permissionMode: "full_access",
      strategy: "inherit_parent",
      candidateId: "parent",
      reason: "parent_fallback",
      pin,
    })),
    backend: pin,
    repositoryRoot: root,
    baseRevision: "a".repeat(40),
    request: {
      description: "Implement the bounded feature",
      tasks: [{
        description: "Implement the bounded child task",
        prompt: "Change src/value.ts.",
      }],
      review: { instructions: "Review the staged result" },
    },
  };
  return { sessions, child, expectation, descriptor };
}

describe("interrupted durable team child recovery", () => {
  it("fails closed on a correlation mismatch without mutating the child", async () => {
    const test = await fixture();
    await expect(recoverInterruptedTeamChild(test.sessions, {
      ...test.expectation,
      attemptId: "foreign-attempt",
    })).rejects.toMatchObject({ code: "permission_denied" });
    expect(await test.sessions.loadState(test.child.id)).toMatchObject({
      lastSequence: test.child.lastSequence,
      agentLifecycle: { status: "ready" },
    });
  });

  it("terminalizes a child that never started without charging started work", async () => {
    const test = await fixture();
    const recovered = await recoverInterruptedTeamChild(
      test.sessions,
      test.expectation,
    );

    expect(recovered).toMatchObject({
      status: "failed",
      started: false,
      result: null,
      failure: { code: "runtime_failed" },
    });
    expect(await test.sessions.loadState(test.child.id)).toMatchObject({
      agentLifecycle: {
        status: "failed",
        turnId: null,
        failure: { code: "runtime_failed" },
      },
    });
  });

  it("fails pending tools before interrupting a running child", async () => {
    const test = await fixture();
    await test.sessions.withSessionMutation(
      test.child.id,
      test.child.lastSequence,
      async (lease) => {
        await lease.append({
          type: "turn_started",
          turnId: "child-turn",
          prompt: "Change src/value.ts.",
          at: testAt,
        });
        await lease.append({
          type: "tool_started",
          turnId: "child-turn",
          call: { id: "tool-1", name: "read_file", arguments: { path: "src/value.ts" } },
          at: testAt,
        });
      },
    );

    const recovered = await recoverInterruptedTeamChild(
      test.sessions,
      test.expectation,
    );
    expect(recovered).toMatchObject({
      status: "failed",
      started: true,
      result: null,
    });
    const loaded = await test.sessions.load(test.child.id);
    expect(loaded.records.slice(-2).map((record) => record.type)).toEqual([
      "tool_failed",
      "turn_interrupted",
    ]);
    expect(await test.sessions.loadState(test.child.id)).toMatchObject({
      pendingToolCalls: [],
      openTurnId: null,
      agentLifecycle: { status: "failed", turnId: "child-turn" },
    });
  });

  it("preserves an already durable completed child without another append", async () => {
    const test = await fixture();
    await test.sessions.withSessionMutation(
      test.child.id,
      test.child.lastSequence,
      async (lease) => {
        await lease.append({
          type: "turn_started",
          turnId: "child-turn",
          prompt: "Change src/value.ts.",
          at: testAt,
        });
        await lease.append({
          type: "turn_completed",
          turnId: "child-turn",
          result: {
            finalText: "Implemented the bounded change.",
            usage: { inputTokens: 8, outputTokens: 3, costUsd: 0.01 },
            usageSource: "provider",
            steps: 1,
            changedFiles: ["src/value.ts"],
            changedFilesSource: "host_tools",
            evidence: ["Verified src/value.ts"],
            evidenceSource: "host_tools",
          },
          at: testAt,
        });
      },
    );
    const before = await test.sessions.loadState(test.child.id);

    const recovered = await recoverInterruptedTeamChild(
      test.sessions,
      test.expectation,
    );
    expect(recovered).toMatchObject({
      status: "completed",
      started: true,
      result: {
        finalText: "Implemented the bounded change.",
        changedFiles: ["src/value.ts"],
      },
      failure: null,
    });
    expect((await test.sessions.loadState(test.child.id)).lastSequence)
      .toBe(before.lastSequence);
  });

  it("projects only an exactly bound completed child into team accounting", async () => {
    const test = await fixture();
    await test.sessions.withSessionMutation(
      test.child.id,
      test.child.lastSequence,
      async (lease) => {
        await lease.append({
          type: "turn_started",
          turnId: "child-turn",
          prompt: "Change src/value.ts.",
          at: testAt,
        });
        await lease.append({
          type: "turn_completed",
          turnId: "child-turn",
          result: {
            finalText: "Implemented.",
            usage: { inputTokens: 8, outputTokens: 3, costUsd: 0.01 },
            usageSource: "provider",
            steps: 1,
            changedFiles: ["src/value.ts"],
            changedFilesSource: "workspace_diff",
            evidence: ["Verified src/value.ts"],
            evidenceSource: "independent_verification",
          },
          at: testAt,
        });
      },
    );
    const reservation = {
      attemptId: "attempt-1",
      role: "implement" as const,
      index: 1,
      round: 0,
      childAgentId: "child-agent",
      childSessionId: "child-session",
      requestAllowance: 8,
      taskId: "child-task",
      workspaceLeaseId: "lease-1",
      assignmentSha256: teamChildAssignmentSha256(
        "implement_v2",
        "Implement the bounded child task",
        "Change src/value.ts.",
      ),
    };

    await expect(recoverDurableTeamChild(test.sessions, {
      descriptor: test.descriptor,
      reservation,
      at: test.expectation.at,
    })).resolves.toMatchObject({
      status: "completed",
      requestsUsed: 1,
      changedFiles: ["src/value.ts"],
      usageSource: "provider",
      failure: null,
    });
    await expect(recoverDurableTeamChild(test.sessions, {
      descriptor: {
        ...test.descriptor,
        routes: test.descriptor.routes.map((route) =>
          route.role === "implement"
            ? { ...route, candidateId: "foreign-candidate" }
            : route
        ),
      },
      reservation,
      at: test.expectation.at,
    })).resolves.toMatchObject({
      status: "failed",
      requestsUsed: 1,
      failure: { code: "invalid_child_result" },
    });
    await expect(recoverDurableTeamChild(test.sessions, {
      descriptor: test.descriptor,
      reservation: { ...reservation, workspaceLeaseId: "foreign-lease" },
      at: test.expectation.at,
    })).resolves.toMatchObject({
      status: "failed",
      failure: { code: "invalid_child_result" },
    });
  });

  it("bounds multibyte evidence by the team journal UTF-8 limit", async () => {
    const test = await fixture();
    await test.sessions.withSessionMutation(
      test.child.id,
      test.child.lastSequence,
      async (lease) => {
        await lease.append({
          type: "turn_started",
          turnId: "child-turn",
          prompt: "Change src/value.ts.",
          at: testAt,
        });
        await lease.append({
          type: "turn_completed",
          turnId: "child-turn",
          result: {
            finalText: "Implemented.",
            usage: null,
            usageSource: "unavailable",
            steps: 1,
            changedFiles: ["src/value.ts"],
            changedFilesSource: "workspace_diff",
            evidence: ["界".repeat(8_000)],
            evidenceSource: "independent_verification",
          },
          at: testAt,
        });
      },
    );
    const recovered = await recoverDurableTeamChild(test.sessions, {
      descriptor: test.descriptor,
      reservation: {
        attemptId: "attempt-1",
        role: "implement",
        index: 1,
        round: 0,
        childAgentId: "child-agent",
        childSessionId: "child-session",
        requestAllowance: 8,
        taskId: "child-task",
        workspaceLeaseId: "lease-1",
        assignmentSha256: teamChildAssignmentSha256(
          "implement_v2",
          "Implement the bounded child task",
          "Change src/value.ts.",
        ),
      },
      at: test.expectation.at,
    });

    expect(recovered.status).toBe("completed");
    expect(Buffer.byteLength(recovered.evidence[0] ?? "", "utf8"))
      .toBeLessThanOrEqual(16_384);
  });
});
