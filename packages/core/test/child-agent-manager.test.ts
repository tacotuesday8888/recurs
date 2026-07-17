import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createHostInvocation,
  deriveTrustedRunContext,
  type BackendResolver,
  type RunCoordinator,
} from "@recurs/contracts";
import { ScriptedProvider } from "@recurs/providers";
import { ToolRegistry } from "@recurs/tools";
import { afterEach, describe, expect, it } from "vitest";

import {
  AgentLoopDirectExecutor,
  BackendRunCoordinator,
  ChildAgentManager,
  JsonlSessionStore,
  bindRunAuthorization,
} from "../src/index.js";
import { testAt, testBackendPin } from "../../../tests/support/backend.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

const trusted = deriveTrustedRunContext(createHostInvocation({
  invocation: "repl",
  userPresent: true,
  remote: false,
  scripted: false,
  embedding: "cli",
}));

async function storeFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "recurs-child-manager-"));
  directories.push(directory);
  const sessions = new JsonlSessionStore(path.join(directory, "sessions"));
  const pin = testBackendPin();
  let parent = await sessions.createPinnedSession({
    id: "parent-session",
    cwd: directory,
    backend: pin,
    at: testAt,
  });
  await sessions.withSessionMutation(parent.id, parent.lastSequence, async (lease) => {
    await lease.append({
      type: "mode_updated",
      source: "command",
      executionMode: "act",
      permissionMode: "approved_for_me",
      at: testAt,
    });
  });
  parent = await sessions.loadState(parent.id) as typeof parent;
  return { directory, sessions, pin, parent };
}

function context(parent: Awaited<ReturnType<typeof storeFixture>>["parent"]) {
  return {
    sessionId: parent.id,
    cwd: parent.cwd,
    executionMode: parent.executionMode,
    signal: new AbortController().signal,
    readRevisions: new Map<string, string>(),
    runContext: trusted,
  };
}

describe("ChildAgentManager", () => {
  it("returns a child handoff to the parent model for synthesis", async () => {
    const { sessions, pin, parent } = await storeFixture();
    const provider = new ScriptedProvider([
      [
        {
          type: "tool_call",
          call: {
            id: "delegate-call",
            name: "delegate_task",
            arguments: {
              description: "Inspect cache key",
              prompt: "Find the cache invalidation bug.",
            },
          },
        },
        { type: "done", stopReason: "tool_calls" },
      ],
      [
        { type: "text_delta", text: "Child found the missing namespace." },
        { type: "done", stopReason: "complete" },
      ],
      [
        { type: "text_delta", text: "The cache key must include its namespace." },
        { type: "done", stopReason: "complete" },
      ],
    ]);
    const resolver: BackendResolver = {
      async resolve(input) {
        return {
          kind: "direct",
          pin,
          authorization: bindRunAuthorization({
            id: `auth-${input.operationId}`,
            operation: input.operation,
            sessionId: input.sessionId,
            operationId: input.operationId,
            turnId: input.turnId,
            pin,
            connectionRevision: 1,
            policyRevision: pin.policyRevisionAtCreation,
            context: input.context,
            maxRequests: 40,
            expiresAt: "2099-01-01T00:00:00.000Z",
          }, new Date(testAt)),
          async createProvider() { return provider; },
        };
      },
    };
    const coordinatorRef: { current?: BackendRunCoordinator } = {};
    const tools = new ToolRegistry();
    const manager = new ChildAgentManager({
      sessions,
      getCoordinator: () => coordinatorRef.current,
      async emit() {},
      createId: (() => {
        const ids = ["synthesis-child-session", "synthesis-child-agent", "synthesis-task"];
        return () => ids.shift()!;
      })(),
      now: () => testAt,
    });
    tools.register(manager.createTool());
    const direct = new AgentLoopDirectExecutor({
      tools,
      approvals: { async request() { return "deny"; } },
      sessions,
      async emit() {},
      createToolContext(state, signal, runContext) {
        return {
          sessionId: state.id,
          cwd: state.cwd,
          executionMode: state.executionMode,
          signal,
          readRevisions: new Map(),
          ...(runContext === undefined ? {} : { runContext }),
        };
      },
    });
    const coordinator = new BackendRunCoordinator({ sessions, resolver, direct });
    coordinatorRef.current = coordinator;

    const run = await coordinator.start({
      sessionId: parent.id,
      expectedSessionRecordSequence: parent.lastSequence,
      prompt: "Diagnose the cache bug",
      invocation: createHostInvocation({
        invocation: "repl",
        userPresent: true,
        remote: false,
        scripted: false,
        embedding: "cli",
      }),
      signal: new AbortController().signal,
    });

    await expect(run.outcome).resolves.toMatchObject({
      ok: true,
      result: { finalText: "The cache key must include its namespace." },
    });
    const reloaded = await sessions.loadState(parent.id);
    expect(reloaded.messages).toContainEqual(expect.objectContaining({
      role: "tool",
      content: "Child found the missing namespace.",
      toolCallId: "delegate-call",
    }));
    expect(await sessions.loadState("synthesis-child-session")).toMatchObject({
      agentLifecycle: { status: "completed" },
    });
  });

  it("runs one child through the existing coordinator and returns evidence to its parent", async () => {
    const { sessions, pin, parent } = await storeFixture();
    const provider = new ScriptedProvider([[
      { type: "text_delta", text: "Cache namespace is missing." },
      { type: "usage", inputTokens: 12, outputTokens: 6 },
      { type: "done", stopReason: "complete" },
    ]]);
    const resolver: BackendResolver = {
      async resolve(input) {
        return {
          kind: "direct",
          pin,
          authorization: bindRunAuthorization({
            id: `auth-${input.operationId}`,
            operation: input.operation,
            sessionId: input.sessionId,
            operationId: input.operationId,
            turnId: input.turnId,
            pin,
            connectionRevision: 1,
            policyRevision: pin.policyRevisionAtCreation,
            context: input.context,
            maxRequests: 40,
            expiresAt: "2099-01-01T00:00:00.000Z",
          }, new Date(testAt)),
          async createProvider() { return provider; },
        };
      },
    };
    const direct = new AgentLoopDirectExecutor({
      tools: new ToolRegistry(),
      approvals: { async request() { return "deny"; } },
      sessions,
      async emit() {},
      createToolContext(state, signal, runContext) {
        return {
          sessionId: state.id,
          cwd: state.cwd,
          executionMode: state.executionMode,
          signal,
          readRevisions: new Map(),
          ...(runContext === undefined ? {} : { runContext }),
        };
      },
    });
    const coordinator = new BackendRunCoordinator({ sessions, resolver, direct });
    const events: Array<{ type: string }> = [];
    const manager = new ChildAgentManager({
      sessions,
      getCoordinator: () => coordinator,
      async emit(event) { events.push(event); },
      createId: (() => {
        const ids = ["child-session", "child-agent", "child-task"];
        return () => ids.shift()!;
      })(),
      now: () => testAt,
    });
    const tool = manager.createTool();
    const input = tool.parse({
      description: "Inspect cache key",
      prompt: "Find the cache invalidation bug and return evidence.",
    });

    const result = await tool.execute(input, context(parent));

    expect(result.output).toContain("Cache namespace is missing.");
    expect(result.metadata).toMatchObject({
      childAgentId: "child-agent",
      childSessionId: "child-session",
      attempts: 1,
      usage: { inputTokens: 12, outputTokens: 6 },
    });
    const child = await sessions.loadState("child-session");
    expect(child).toMatchObject({
      permissionMode: "approved_for_me",
      agent: {
        role: "child",
        parentAgentId: parent.agent.id,
        parentSessionId: parent.id,
        depth: 1,
        backend: { strategy: "inherit_parent", modelId: pin.modelId },
      },
      agentLifecycle: { status: "completed" },
      agentResult: { finalText: "Cache namespace is missing." },
    });
    expect(events.map((event) => event.type)).toEqual([
      "agent_started",
      "agent_completed",
    ]);
  });

  it("persists a truthful terminal failure when the coordinator fails preflight", async () => {
    const { sessions, parent } = await storeFixture();
    const coordinator: RunCoordinator = {
      async start() {
        return {
          events: { async *[Symbol.asyncIterator]() {} },
          outcome: Promise.resolve({
            ok: false,
            failure: {
              domain: "policy",
              phase: "preflight",
              code: "authorization_denied",
              safeMessage: "Child execution is blocked",
              diagnosticId: "blocked-child",
              retryable: false,
            },
          }),
        };
      },
    };
    const manager = new ChildAgentManager({
      sessions,
      getCoordinator: () => coordinator,
      async emit() {},
      createId: (() => {
        const ids = ["failed-session", "failed-agent", "failed-task"];
        return () => ids.shift()!;
      })(),
      now: () => testAt,
    });
    const tool = manager.createTool();

    await expect(tool.execute(tool.parse({ description: "Fail safely", prompt: "Inspect" }), context(parent)))
      .rejects.toMatchObject({ code: "execution_failed" });
    expect(await sessions.loadState("failed-session")).toMatchObject({
      agentLifecycle: {
        status: "failed",
        failure: { code: "authorization_denied", phase: "preflight" },
      },
    });
  });

  it("propagates cancellation as cancellation and persists it on the child", async () => {
    const { sessions, parent } = await storeFixture();
    const coordinator: RunCoordinator = {
      async start() {
        return {
          events: { async *[Symbol.asyncIterator]() {} },
          outcome: Promise.resolve({
            ok: false,
            failure: {
              domain: "provider",
              phase: "preflight",
              code: "cancelled",
              safeMessage: "The child was cancelled",
              diagnosticId: "cancelled-child",
              retryable: false,
            },
          }),
        };
      },
    };
    const events: Array<{ type: string }> = [];
    const manager = new ChildAgentManager({
      sessions,
      getCoordinator: () => coordinator,
      async emit(event) { events.push(event); },
      createId: (() => {
        const ids = ["cancelled-session", "cancelled-agent", "cancelled-task"];
        return () => ids.shift()!;
      })(),
      now: () => testAt,
    });
    const tool = manager.createTool();

    await expect(tool.execute(tool.parse({ description: "Cancel safely", prompt: "Inspect" }), context(parent)))
      .rejects.toMatchObject({ code: "cancelled" });
    expect(await sessions.loadState("cancelled-session")).toMatchObject({
      agentLifecycle: {
        status: "cancelled",
        turnId: null,
        reason: "The child was cancelled",
      },
    });
    expect(events.map((event) => event.type)).toEqual([
      "agent_started",
      "agent_cancelled",
    ]);
  });

  it("rejects nested delegation at the explicit depth-one boundary", async () => {
    const { sessions, pin, parent } = await storeFixture();
    const child = await sessions.createPinnedSession({
      id: "existing-child-session",
      cwd: parent.cwd,
      backend: pin,
      at: testAt,
      agent: {
        ...parent.agent,
        id: "existing-child-agent",
        role: "child",
        parentAgentId: parent.agent.id,
        parentSessionId: parent.id,
        depth: 1,
        task: { id: "existing-task", description: "Existing", prompt: "Inspect" },
        backend: { ...parent.agent.backend, strategy: "inherit_parent" },
      },
    });
    const manager = new ChildAgentManager({
      sessions,
      getCoordinator: () => null,
      async emit() {},
    });
    const tool = manager.createTool();

    await expect(tool.execute(tool.parse({ description: "Nested", prompt: "Inspect" }), context(child)))
      .rejects.toMatchObject({ code: "permission_denied" });
  });

  it("rejects malformed task input before creating any child", async () => {
    const { sessions } = await storeFixture();
    const manager = new ChildAgentManager({
      sessions,
      getCoordinator: () => null,
      async emit() {},
    });
    const tool = manager.createTool();

    expect(() => tool.parse({
      description: "Inspect",
      prompt: "Do it",
      background: true,
    })).toThrow("exactly description and prompt");
    expect(() => tool.parse({ description: " ", prompt: "Do it" })).toThrow(
      "empty or too large",
    );
  });

  it("enforces the explicit one-child concurrency limit", async () => {
    const { sessions, parent } = await storeFixture();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const coordinator: RunCoordinator = {
      async start() {
        started();
        return {
          events: { async *[Symbol.asyncIterator]() {} },
          outcome: held.then(() => ({
            ok: false as const,
            failure: {
              domain: "runtime" as const,
              phase: "preflight" as const,
              code: "runtime_failed" as const,
              safeMessage: "First child stopped",
              diagnosticId: "first-child",
              retryable: false,
            },
          })),
        };
      },
    };
    const manager = new ChildAgentManager({
      sessions,
      getCoordinator: () => coordinator,
      async emit() {},
      createId: (() => {
        let value = 0;
        return () => `concurrency-${++value}`;
      })(),
      now: () => testAt,
    });
    const tool = manager.createTool();
    const first = tool.execute(
      tool.parse({ description: "First child", prompt: "Inspect first" }),
      context(parent),
    );
    void first.catch(() => {});
    await ready;

    await expect(tool.execute(
      tool.parse({ description: "Second child", prompt: "Inspect second" }),
      context(parent),
    )).rejects.toThrow("concurrency limit");
    release();
    await expect(first).rejects.toMatchObject({ code: "execution_failed" });
  });
});
