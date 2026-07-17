import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  getOperatingModePolicy,
  type AgentSessionDescriptor,
  type SessionBackendPin,
} from "@recurs/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { JsonlSessionStore } from "../src/index.js";

const directories: string[] = [];
const at = "2026-07-10T00:00:00.000Z";

const backend: SessionBackendPin = {
  kind: "model_provider",
  providerId: "scripted",
  adapterId: "scripted-v1",
  connectionId: "test-connection",
  modelId: "scripted-model",
  modelIdentityKind: "versioned",
  providerResolvedModelRevisionAtCreation: "scripted-model-1",
  catalogRevision: "test-catalog-1",
  policyRevisionAtCreation: "test-policy-1",
  billingPolicyRevisionAtCreation: "test-billing-1",
  primaryBillingSourceAtCreation: "local_compute",
  billingSelectionAtCreation: {
    mode: "strict_primary_only",
    policyRevision: "test-policy-1",
    disclosureRevision: "test-disclosure-1",
    allowedSources: ["local_compute"],
    acknowledgedAt: at,
  },
  accountSubjectFingerprint: "test-account",
};

async function temporaryStore(): Promise<JsonlSessionStore> {
  const directory = await mkdtemp(path.join(tmpdir(), "recurs-v2-session-"));
  directories.push(directory);
  return new JsonlSessionStore(directory);
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("version 2 sessions", () => {
  it("creates a durable root-agent descriptor for existing callers", async () => {
    const store = await temporaryStore();
    const state = await store.createPinnedSession({
      id: "root-session",
      cwd: "/workspace",
      backend,
      at,
    });

    expect(state.agent).toMatchObject({
      id: "root-session:agent",
      role: "parent",
      parentAgentId: null,
      parentSessionId: null,
      depth: 0,
      task: null,
      operatingMode: { id: "balanced_v1", version: 1 },
      backend: {
        strategy: "session_pin",
        adapterId: backend.adapterId,
        connectionId: backend.connectionId,
        modelId: backend.modelId,
      },
      permissions: {
        parentExecutionMode: "act",
        executionMode: "act",
        parentPermissionMode: "ask_always",
        permissionMode: "ask_always",
      },
    });
    expect(state.agentLifecycle).toEqual({ status: "ready" });
    expect(state.agentResult).toBeNull();
  });

  it("derives a root descriptor when replaying a pre-agent version-2 log", async () => {
    const store = await temporaryStore();
    await writeFile(
      path.join(store.directory, "older-session.jsonl"),
      `${JSON.stringify({
        version: 2,
        type: "session_created",
        sessionId: "older-session",
        sequence: 0,
        at,
        cwd: "/workspace",
        backend,
      })}\n`,
      "utf8",
    );

    const state = await store.loadState("older-session");
    expect(state).toMatchObject({
      agent: {
        id: "older-session:agent",
        role: "parent",
        operatingMode: { id: "balanced_v1", version: 1 },
      },
      agentLifecycle: { status: "ready" },
      agentResult: null,
    });
  });

  it("replays a bounded child lifecycle and its returned result", async () => {
    const store = await temporaryStore();
    const mode = getOperatingModePolicy("standard_v1");
    const agent: AgentSessionDescriptor = {
      id: "child-agent-1",
      role: "child",
      profile: { id: "explore_v1", version: 1 },
      parentAgentId: "parent-agent-1",
      parentSessionId: "parent-session-1",
      depth: 1,
      task: {
        id: "task-1",
        description: "Inspect cache",
        prompt: "Find the cache invalidation bug",
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
        executionMode: "plan",
        parentPermissionMode: "approved_for_me",
        permissionMode: "ask_always",
      },
      limits: mode.orchestration,
    };
    const initial = await store.createPinnedSession({
      id: "child-session-1",
      cwd: "/workspace",
      backend,
      agent,
      at,
    });
    expect(initial.agent).toEqual(agent);

    await store.withSessionMutation(initial.id, 0, async (lease) => {
      await lease.append({
        type: "turn_started",
        turnId: "child-turn-1",
        prompt: agent.task!.prompt,
        at,
      });
      await lease.append({
        type: "turn_completed",
        turnId: "child-turn-1",
        result: {
          finalText: "The cache key omits the namespace.",
          usage: { inputTokens: 11, outputTokens: 7, costUsd: 0.03 },
          usageSource: "provider",
          steps: 2,
          changedFiles: [],
          changedFilesSource: "none",
          evidence: ["cache.test.ts reproduced the collision"],
          evidenceSource: "host_tools",
        },
        at,
      });
    });

    const completed = await store.loadState(initial.id);
    expect(completed).toMatchObject({
      agentLifecycle: { status: "completed", turnId: "child-turn-1" },
      agentResult: {
        finalText: "The cache key omits the namespace.",
        usage: { inputTokens: 11, outputTokens: 7, costUsd: 0.03 },
        usageSource: "provider",
        steps: 2,
        changedFiles: [],
        evidence: ["cache.test.ts reproduced the collision"],
      },
    });
    await expect(store.withSessionMutation(initial.id, 2, async (lease) => {
      await lease.append({
        type: "turn_started",
        turnId: "child-turn-2",
        prompt: "Run again",
        at,
      });
    })).rejects.toThrow("terminal child agent");
  });

  it("rejects a child descriptor that widens parent permissions", async () => {
    const store = await temporaryStore();
    const mode = getOperatingModePolicy("balanced_v1");
    await expect(store.createPinnedSession({
      id: "unsafe-child",
      cwd: "/workspace",
      backend,
      at,
      agent: {
        id: "unsafe-agent",
        role: "child",
        profile: { id: "explore_v1", version: 1 },
        parentAgentId: "parent-agent",
        parentSessionId: "parent-session",
        depth: 1,
        task: { id: "task", description: "Unsafe", prompt: "Do it" },
        operatingMode: { id: mode.id, version: mode.version },
        backend: {
          strategy: "inherit_parent",
          adapterId: backend.adapterId,
          connectionId: backend.connectionId,
          modelId: backend.modelId,
        },
        permissions: {
          parentExecutionMode: "plan",
          executionMode: "act",
          parentPermissionMode: "ask_always",
          permissionMode: "full_access",
        },
        limits: mode.orchestration,
      },
    })).rejects.toMatchObject({ code: "invalid_record" });
  });

  it("rejects a durable mode update that would make Explore writable", async () => {
    const store = await temporaryStore();
    const mode = getOperatingModePolicy("balanced_v1");
    const child = await store.createPinnedSession({
      id: "explore-child",
      cwd: "/workspace",
      backend,
      at,
      agent: {
        id: "explore-agent",
        role: "child",
        profile: { id: "explore_v1", version: 1 },
        parentAgentId: "parent-agent",
        parentSessionId: "parent-session",
        depth: 1,
        task: { id: "task", description: "Inspect", prompt: "Find the bug" },
        operatingMode: { id: mode.id, version: mode.version },
        backend: {
          strategy: "inherit_parent",
          adapterId: backend.adapterId,
          connectionId: backend.connectionId,
          modelId: backend.modelId,
        },
        permissions: {
          parentExecutionMode: "act",
          executionMode: "plan",
          parentPermissionMode: "approved_for_me",
          permissionMode: "approved_for_me",
        },
        limits: mode.orchestration,
      },
    });

    await expect(store.withSessionMutation(
      child.id,
      child.lastSequence,
      async (lease) => {
        await lease.append({
          type: "mode_updated",
          source: "command",
          executionMode: "act",
          permissionMode: "approved_for_me",
          at,
        });
      },
    )).rejects.toThrow("agent profile");
  });

  it("creates a pinned sequence-zero session and appends exact next sequences", async () => {
    const store = await temporaryStore();
    const initial = await store.createPinnedSession({
      id: "s2",
      cwd: "/workspace",
      backend,
      at,
    });

    expect(initial).toMatchObject({
      version: 2,
      lastSequence: 0,
      backend: { type: "pinned", pin: backend },
    });

    await store.withSessionMutation("s2", 0, async (lease) => {
      const record = await lease.append({
        type: "turn_started",
        turnId: "turn-1",
        prompt: "inspect",
        at,
      });
      expect(record.sequence).toBe(1);
      expect(lease.currentSequence).toBe(1);
    });

    await expect(
      store.withSessionMutation("s2", 0, async () => undefined),
    ).rejects.toMatchObject({ code: "session_conflict" });
    expect((await store.loadState("s2")).messages).toEqual([
      {
        id: "turn-1:user",
        role: "user",
        content: "inspect",
      },
    ]);
  });

  it("rejects a competing process-style mutation lease", async () => {
    const store = await temporaryStore();
    await store.createPinnedSession({
      id: "s2",
      cwd: "/workspace",
      backend,
      at,
    });

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acquired!: () => void;
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const first = store.withSessionMutation("s2", 0, async () => {
      acquired();
      await held;
    });
    await ready;

    await expect(
      new JsonlSessionStore(store.directory).withSessionMutation(
        "s2",
        0,
        async () => undefined,
      ),
    ).rejects.toMatchObject({ code: "session_busy" });

    release();
    await first;
  });

  it("recovers a lock left by a process that no longer exists", async () => {
    const store = await temporaryStore();
    await store.createPinnedSession({
      id: "s2",
      cwd: "/workspace",
      backend,
      at,
    });
    const lock = path.join(store.directory, ".locks", "s2.lock");
    await mkdir(lock, { recursive: true });
    await writeFile(
      path.join(lock, "owner"),
      `${JSON.stringify({ owner: "crashed", pid: 2_147_483_647 })}\n`,
      "utf8",
    );

    await expect(
      store.withSessionMutation("s2", 0, async (lease) => lease.fencingToken),
    ).resolves.toBeGreaterThan(1);
  });

  it("rejects unknown fields in a committed version 2 record", async () => {
    const store = await temporaryStore();
    await writeFile(
      path.join(store.directory, "s2.jsonl"),
      `${JSON.stringify({
        version: 2,
        type: "session_created",
        sessionId: "s2",
        sequence: 0,
        at,
        cwd: "/workspace",
        backend,
        injected: "not allowed",
      })}\n`,
      "utf8",
    );

    await expect(store.load("s2")).rejects.toMatchObject({
      code: "invalid_record",
    });
  });

  it("rejects nested backend fields that are not part of the pin schema", async () => {
    const store = await temporaryStore();
    await writeFile(
      path.join(store.directory, "s2.jsonl"),
      `${JSON.stringify({
        version: 2,
        type: "session_created",
        sessionId: "s2",
        sequence: 0,
        at,
        cwd: "/workspace",
        backend: {
          ...backend,
          billingSelectionAtCreation: {
            ...backend.billingSelectionAtCreation,
            credentialRef: "must-not-be-accepted",
          },
        },
      })}\n`,
      "utf8",
    );

    await expect(store.load("s2")).rejects.toMatchObject({
      code: "invalid_record",
    });
  });

  it("rejects overlapping turns before writing the invalid record", async () => {
    const store = await temporaryStore();
    await store.createPinnedSession({
      id: "s2",
      cwd: "/workspace",
      backend,
      at,
    });

    await expect(
      store.withSessionMutation("s2", 0, async (lease) => {
        await lease.append({
          type: "turn_started",
          turnId: "turn-1",
          prompt: "first",
          at,
        });
        await lease.append({
          type: "turn_started",
          turnId: "turn-2",
          prompt: "second",
          at,
        });
      }),
    ).rejects.toThrow("already has an open turn");
    expect((await store.load("s2")).records).toHaveLength(2);
  });

  it("rejects unknown fields inside durable model messages", async () => {
    const store = await temporaryStore();
    await store.createPinnedSession({
      id: "s2",
      cwd: "/workspace",
      backend,
      at,
    });

    await expect(
      store.withSessionMutation("s2", 0, async (lease) => {
        await lease.append({
          type: "turn_started",
          turnId: "turn-1",
          prompt: "inspect",
          at,
        });
        await lease.append({
          type: "model_completed",
          turnId: "turn-1",
          at,
          message: {
            id: "assistant-1",
            role: "assistant",
            content: "done",
            credentialRef: "must-not-be-accepted",
          } as never,
          usage: null,
          stopReason: "complete",
        });
      }),
    ).rejects.toMatchObject({ code: "invalid_record" });
  });

  it("rejects unknown fields inside durable failures", async () => {
    const store = await temporaryStore();
    await store.createPinnedSession({
      id: "s2",
      cwd: "/workspace",
      backend,
      at,
    });
    await expect(
      store.withSessionMutation("s2", 0, async (lease) => {
        await lease.append({
          type: "turn_started",
          turnId: "turn-1",
          prompt: "inspect",
          at,
        });
        await lease.append({
          type: "turn_failed",
          turnId: "turn-1",
          at,
          error: {
            domain: "provider",
            phase: "started",
            code: "transport",
            safeMessage: "failed",
            diagnosticId: "diagnostic",
            retryable: false,
            rawToken: "must-not-be-accepted",
          } as never,
        });
      }),
    ).rejects.toMatchObject({ code: "invalid_record" });
  });

  it("keeps committed model usage when a turn is later interrupted", async () => {
    const store = await temporaryStore();
    await store.createPinnedSession({
      id: "s2",
      cwd: "/workspace",
      backend,
      at,
    });
    await store.withSessionMutation("s2", 0, async (lease) => {
      await lease.append({
        type: "turn_started",
        turnId: "turn-1",
        prompt: "inspect",
        at,
      });
      await lease.append({
        type: "model_completed",
        turnId: "turn-1",
        at,
        message: {
          id: "assistant-1",
          role: "assistant",
          content: "partial result",
        },
        usage: { inputTokens: 7, outputTokens: 3 },
        stopReason: "complete",
      });
      await lease.append({
        type: "turn_interrupted",
        turnId: "turn-1",
        reason: "process ended before terminal bookkeeping",
        at,
      });
    });

    expect((await store.loadState("s2")).usage).toEqual({
      inputTokens: 7,
      outputTokens: 3,
    });
  });

  it("keeps version 1 logs readable but refuses to mutate them", async () => {
    const store = await temporaryStore();
    const legacy = {
      version: 1,
      type: "session_created",
      sessionId: "legacy",
      at,
      cwd: "/workspace",
      model: "scripted",
    } as const;
    await writeFile(
      path.join(store.directory, "legacy.jsonl"),
      `${JSON.stringify(legacy)}\n`,
      "utf8",
    );

    expect((await store.loadState("legacy")).backend).toEqual({
      type: "legacy",
      model: "scripted",
    });
    await expect(
      store.append("legacy", {
        version: 1,
        type: "goal_updated",
        sessionId: "legacy",
        at,
        goal: null,
      }),
    ).rejects.toMatchObject({ code: "legacy_read_only" });
  });

  it("closes an orphaned compaction locally without retrying provider work", async () => {
    const store = await temporaryStore();
    await store.createPinnedSession({
      id: "s2",
      cwd: "/workspace",
      backend,
      at,
    });
    await store.withSessionMutation("s2", 0, async (lease) => {
      await lease.append({
        type: "compaction_started",
        operationId: "compact-1",
        inputBaseSequence: 0,
        at,
      });
    });

    await expect(
      store.recoverInterruptedOperations("s2", at),
    ).resolves.toBe(true);
    await expect(
      store.recoverInterruptedOperations("s2", at),
    ).resolves.toBe(false);
    const state = await store.loadState("s2");
    expect(state.pendingCompaction).toBeNull();
    expect((await store.load("s2")).records.at(-1)).toMatchObject({
      type: "compaction_interrupted",
      operationId: "compact-1",
      usage: null,
      usageSource: "unknown",
    });
  });
});
