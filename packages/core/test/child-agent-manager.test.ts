import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createHostInvocation,
  deriveTrustedRunContext,
  getOperatingModePolicy,
  type OperatingModeId,
  type BackendResolver,
  type CoordinatedRunInput,
  type RunCoordinator,
} from "@recurs/contracts";
import { ScriptedProvider } from "@recurs/providers";
import {
  ToolRegistry,
  createApplyPatchTool,
  createGitDiffTool,
  createGitStatusTool,
  createListFilesTool,
  createReadFileTool,
  createRunCommandTool,
  createSearchTextTool,
} from "@recurs/tools";
import { afterEach, describe, expect, it } from "vitest";

import {
  AgentLoopDirectExecutor,
  BackendRunCoordinator,
  ChildAgentManager,
  JsonlSessionStore,
  bindRunAuthorization,
  createDelegationBudget,
  type RecursEvent,
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

async function storeFixture(operatingModeId?: OperatingModeId) {
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
    if (operatingModeId !== undefined) {
      const policy = getOperatingModePolicy(operatingModeId);
      await lease.append({
        type: "agent_policy_updated",
        operatingModeId: policy.id,
        operatingModeVersion: policy.version,
        at: testAt,
      });
    }
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
    delegationBudget: createDelegationBudget(parent.agent),
  };
}

describe("ChildAgentManager", () => {
  it("requires an exact profile and classifies only effectful children as mutating", async () => {
    const { sessions, parent } = await storeFixture();
    const manager = new ChildAgentManager({
      sessions,
      getCoordinator: () => null,
      async emit() {},
    });
    const tool = manager.createTool();
    const explore = tool.parse({
      profile: "Explore",
      description: "Inspect",
      prompt: "Find the cause",
    });
    const implement = tool.parse({
      profile: "implement_v1",
      description: "Fix",
      prompt: "Fix the cause",
    });
    const review = tool.parse({
      profile: "review",
      description: "Review",
      prompt: "Review the fix",
    });

    expect(explore).toMatchObject({ profile: "explore_v1" });
    expect(implement).toMatchObject({ profile: "implement_v1" });
    expect(review).toMatchObject({ profile: "review_v1" });
    expect(tool.isMutating?.(explore, context(parent))).toBe(false);
    expect(tool.isMutating?.(implement, context(parent))).toBe(true);
    expect(tool.isMutating?.(review, context(parent))).toBe(true);
    expect(() => tool.parse({
      profile: "rev",
      description: "Review",
      prompt: "Review the fix",
    })).toThrow("Unknown agent profile");

    await expect(tool.execute(implement, {
      ...context(parent),
      executionMode: "plan",
    })).rejects.toMatchObject({ code: "plan_mode_denied" });
  });

  it("creates exact Explore, Implement, and Review descriptors and prompts", async () => {
    const { sessions, pin, parent } = await storeFixture();
    const starts: CoordinatedRunInput[] = [];
    const coordinator: RunCoordinator = {
      async start(input) {
        starts.push(input);
        const effectful = input.executionMode === "act";
        return {
          events: { async *[Symbol.asyncIterator]() {} },
          outcome: Promise.resolve({
            ok: true,
            result: {
              finalText: `handoff ${input.executionMode}`,
              usage: { inputTokens: 4, outputTokens: 2, costUsd: 0.25 },
              usageSource: "provider",
              steps: 1,
              changedFiles: effectful ? ["src/a.ts"] : [],
              changedFilesSource: effectful ? "host_tools" : "none",
              evidence: ["focused verification passed"],
              evidenceSource: "host_tools",
            },
          }),
        };
      },
    };
    const events: RecursEvent[] = [];
    const manager = new ChildAgentManager({
      sessions,
      getCoordinator: () => coordinator,
      async emit(event) { events.push(event); },
      createId: (() => {
        const ids = [
          "explore-session", "explore-agent", "explore-task",
          "implement-session", "implement-agent", "implement-task",
          "review-session", "review-agent", "review-task",
        ];
        return () => ids.shift()!;
      })(),
      now: () => testAt,
    });
    const tool = manager.createTool();
    const runContext = context(parent);
    const cases = [
      ["explore", "explore_v1", "plan", "Recurs Explore agent", "Findings"],
      ["implement", "implement_v1", "act", "Recurs Implement agent", "Changes"],
      ["review", "review_v1", "act", "Recurs Review agent", "Verdict"],
    ] as const;

    for (const [index, item] of cases.entries()) {
      const [name, profileId, executionMode, promptMarker, heading] = item;
      const result = await tool.execute(tool.parse({
        profile: name,
        description: `${name} cache behavior`,
        prompt: `${name} the cache behavior carefully`,
      }), runContext);
      const child = await sessions.loadState(`${name}-session`);
      expect(child).toMatchObject({
        executionMode,
        agent: {
          limits: { maxRequests: 6 },
          profile: { id: profileId, version: 1 },
          backend: {
            strategy: "inherit_parent",
            adapterId: pin.adapterId,
            connectionId: pin.connectionId,
            modelId: pin.modelId,
          },
          permissions: {
            parentExecutionMode: "act",
            executionMode,
            parentPermissionMode: "approved_for_me",
            permissionMode: "approved_for_me",
          },
        },
      });
      expect(starts.at(-1)).toMatchObject({ executionMode });
      expect(starts.at(-1)?.prompt).toContain(promptMarker);
      expect(starts.at(-1)?.prompt).toContain(heading);
      expect(result.metadata).toMatchObject({
        profileId,
        workflow: {
          childrenStarted: index + 1,
          maxRequests: 24,
          requestsReserved: (index + 1) * 6,
          requestsUsed: index + 1,
        },
      });
    }

    expect(events).toHaveLength(6);
    expect(events.every((event) =>
      !event.type.startsWith("agent_") || "profileId" in event
    )).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: "agent_completed",
      profileId: "review_v1",
      changedFiles: ["src/a.ts"],
      workflow: {
        childrenStarted: 3,
        maxChildren: 4,
        maxRequests: 24,
        requestsReserved: 18,
        requestsUsed: 3,
        reportedCostUsd: 0.75,
        maxReportedCostUsd: 3,
      },
    });
  });

  it("runs a child in a host-owned workspace and persists its isolation identity", async () => {
    const { directory, sessions, parent } = await storeFixture();
    const worktreeRoot = await mkdtemp(path.join(tmpdir(), "recurs-child-worktree-"));
    directories.push(worktreeRoot);
    const workspace = {
      kind: "git_worktree" as const,
      version: 1 as const,
      leaseId: "lease-a",
      repositoryRoot: directory,
      worktreeRoot,
      revision: "a".repeat(40),
    };
    let observedChild: Awaited<ReturnType<JsonlSessionStore["loadState"]>>;
    const coordinator: RunCoordinator = {
      async start(input) {
        observedChild = await sessions.loadState(input.sessionId);
        return {
          events: { async *[Symbol.asyncIterator]() {} },
          outcome: Promise.resolve({
            ok: true,
            result: {
              finalText: "isolated evidence",
              usage: null,
              usageSource: "unavailable",
              steps: 1,
              changedFiles: [],
              changedFilesSource: "none",
              evidence: ["read isolated.ts:1-1"],
              evidenceSource: "host_tools",
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
        const values = ["isolated-session", "isolated-agent", "isolated-task"];
        return () => values.shift()!;
      })(),
      now: () => testAt,
    });
    const input = manager.createTool().parse({
      profile: "explore",
      description: "Inspect isolated code",
      prompt: "Inspect isolated.ts",
    });

    const result = await manager.delegate(input, context(parent), {
      cwd: worktreeRoot,
      workspace,
    });

    expect(observedChild!).toMatchObject({
      id: "isolated-session",
      cwd: worktreeRoot,
      agent: { workspace },
    });
    expect(result).toMatchObject({
      output: "isolated evidence",
      metadata: {
        childSessionId: "isolated-session",
        evidence: ["read isolated.ts:1-1"],
        workspace,
      },
    });
    const reloadedParent = await sessions.loadState(parent.id);
    expect(reloadedParent).toMatchObject({
      id: parent.id,
      cwd: directory,
    });
    expect(reloadedParent.agent).not.toHaveProperty("workspace");
  });

  it("reserves a bounded request share before concurrent v2 children start", async () => {
    const { sessions, parent } = await storeFixture();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let starts = 0;
    let allStarted!: () => void;
    const ready = new Promise<void>((resolve) => { allStarted = resolve; });
    const coordinator: RunCoordinator = {
      async start() {
        starts += 1;
        if (starts === 3) allStarted();
        return {
          events: { async *[Symbol.asyncIterator]() {} },
          outcome: held.then(() => ({
            ok: true as const,
            result: {
              finalText: "done",
              usage: null,
              usageSource: "unavailable" as const,
              steps: 2,
              changedFiles: [],
              changedFilesSource: "none" as const,
              evidence: [],
              evidenceSource: "none" as const,
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
        return () => `shared-budget-${++value}`;
      })(),
      now: () => testAt,
    });
    const tool = manager.createTool();
    const runContext = context(parent);
    const input = tool.parse({
      profile: "explore",
      description: "Inspect",
      prompt: "Inspect one bounded area",
    });
    const running = Array.from({ length: 3 }, () => tool.execute(input, runContext));
    for (const promise of running) void promise.catch(() => {});

    await ready;
    expect(runContext.delegationBudget).toMatchObject({
      maxRequests: 24,
      requestsReserved: 18,
      requestsUsed: 0,
      childrenStarted: 3,
    });
    release();
    await expect(Promise.all(running)).resolves.toHaveLength(3);
    expect(runContext.delegationBudget).toMatchObject({
      requestsReserved: 18,
      requestsUsed: 6,
    });
  });

  it("charges an opaque successful runtime its full request reservation", async () => {
    const { sessions, parent } = await storeFixture();
    const coordinator: RunCoordinator = {
      async start() {
        return {
          events: { async *[Symbol.asyncIterator]() {} },
          outcome: Promise.resolve({
            ok: true,
            result: {
              finalText: "opaque result",
              usage: null,
              usageSource: "unavailable",
              steps: null,
              changedFiles: [],
              changedFilesSource: "none",
              evidence: [],
              evidenceSource: "none",
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
        let value = 0;
        return () => `opaque-${++value}`;
      })(),
      now: () => testAt,
    });
    const tool = manager.createTool();
    const runContext = context(parent);

    await tool.execute(tool.parse({
      profile: "explore",
      description: "Inspect opaquely",
      prompt: "Inspect",
    }), runContext);

    expect(runContext.delegationBudget).toMatchObject({
      maxRequests: 24,
      requestsReserved: 6,
      requestsUsed: 6,
    });
  });

  it("returns a child handoff to the parent model for synthesis", async () => {
    const { directory, sessions, pin, parent } = await storeFixture();
    await writeFile(
      path.join(directory, "cache.ts"),
      "export const cacheKey = 'id';\n",
      "utf8",
    );
    const provider = new ScriptedProvider([
      [
        {
          type: "tool_call",
          call: {
            id: "delegate-call",
            name: "delegate_task",
            arguments: {
              profile: "explore",
              description: "Inspect cache key",
              prompt: "Find the cache invalidation bug.",
            },
          },
        },
        { type: "done", stopReason: "tool_calls" },
      ],
      [
        {
          type: "tool_call",
          call: {
            id: "read-cache",
            name: "read_file",
            arguments: { path: "cache.ts", startLine: 1, endLine: 1 },
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
    tools.register(createReadFileTool());
    tools.register(createListFilesTool());
    tools.register(createSearchTextTool());
    tools.register(createApplyPatchTool());
    tools.register(createRunCommandTool());
    tools.register(createGitStatusTool());
    tools.register(createGitDiffTool());
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
    expect(reloaded.toolOutcomes["delegate-call"]).toMatchObject({
      type: "completed",
      result: {
        metadata: {
          evidence: [expect.stringMatching(
            /^read cache\.ts:1-1 \(sha256 [0-9a-f]{64}\)$/u,
          )],
        },
      },
    });
    expect(await sessions.loadState("synthesis-child-session")).toMatchObject({
      executionMode: "plan",
      agent: {
        profile: { id: "explore_v1", version: 1 },
        permissions: { executionMode: "plan" },
      },
      agentLifecycle: { status: "completed" },
      agentResult: {
        evidence: [expect.stringMatching(
          /^read cache\.ts:1-1 \(sha256 [0-9a-f]{64}\)$/u,
        )],
      },
    });
    expect(provider.requests[1]?.tools.map((tool) => tool.name)).toEqual([
      "read_file",
      "list_files",
      "search_text",
      "git_status",
      "git_diff",
    ]);
    const childUserPrompt = provider.requests[1]?.messages.findLast(
      (message) => message.role === "user",
    )?.content;
    expect(childUserPrompt).toContain("Recurs Explore agent");
    expect(childUserPrompt).toContain("Find the cache invalidation bug.");
    expect(childUserPrompt).toContain("Evidence");
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
    const events: RecursEvent[] = [];
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
      profile: "explore",
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
        profile: { id: "explore_v1", version: 1 },
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
    expect(events[1]).toMatchObject({
      type: "agent_completed",
      profileId: "explore_v1",
      changedFiles: [],
      workflow: {
        childrenStarted: 1,
        maxChildren: 4,
        reportedCostUsd: 0,
      },
    });
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
    const events: RecursEvent[] = [];
    const manager = new ChildAgentManager({
      sessions,
      getCoordinator: () => coordinator,
      async emit(event) { events.push(event); },
      createId: (() => {
        const ids = ["failed-session", "failed-agent", "failed-task"];
        return () => ids.shift()!;
      })(),
      now: () => testAt,
    });
    const tool = manager.createTool();

    const runContext = context(parent);
    await expect(tool.execute(tool.parse({
      profile: "explore",
      description: "Fail safely",
      prompt: "Inspect",
    }), runContext))
      .rejects.toMatchObject({ code: "execution_failed" });
    expect(runContext.delegationBudget.childrenStarted).toBe(1);
    expect(runContext.delegationBudget).toMatchObject({
      requestsReserved: 6,
      requestsUsed: 0,
    });
    expect(events[1]).toMatchObject({
      type: "agent_failed",
      profileId: "explore_v1",
    });
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
    const events: RecursEvent[] = [];
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

    const runContext = context(parent);
    await expect(tool.execute(tool.parse({
      profile: "review",
      description: "Cancel safely",
      prompt: "Inspect",
    }), runContext))
      .rejects.toMatchObject({ code: "cancelled" });
    expect(runContext.delegationBudget.childrenStarted).toBe(1);
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
    expect(events[1]).toMatchObject({ profileId: "review_v1" });
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
        profile: { id: "explore_v1", version: 1 },
        parentAgentId: parent.agent.id,
        parentSessionId: parent.id,
        depth: 1,
        task: { id: "existing-task", description: "Existing", prompt: "Inspect" },
        backend: { ...parent.agent.backend, strategy: "inherit_parent" },
        permissions: {
          ...parent.agent.permissions,
          executionMode: "plan",
        },
      },
    });
    const manager = new ChildAgentManager({
      sessions,
      getCoordinator: () => null,
      async emit() {},
    });
    const tool = manager.createTool();

    await expect(tool.execute(tool.parse({
      profile: "explore",
      description: "Nested",
      prompt: "Inspect",
    }), context(child)))
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
      profile: "explore",
      description: "Inspect",
      prompt: "Do it",
      background: true,
    })).toThrow("exactly profile, description, and prompt");
    expect(() => tool.parse({
      profile: "explore",
      description: "Inspect",
      prompt: "Do it",
      cwd: "/model-controlled",
      workspace: { kind: "git_worktree" },
    })).toThrow("exactly profile, description, and prompt");
    expect(() => tool.parse({
      profile: "explore",
      description: " ",
      prompt: "Do it",
    })).toThrow(
      "empty or too large",
    );
  });

  it("rejects work at the per-run child and cumulative reported-cost ceilings", async () => {
    const { sessions, parent } = await storeFixture();
    let starts = 0;
    const coordinator: RunCoordinator = {
      async start() {
        starts += 1;
        throw new Error("must not start");
      },
    };
    const manager = new ChildAgentManager({
      sessions,
      getCoordinator: () => coordinator,
      async emit() {},
    });
    const tool = manager.createTool();
    const input = tool.parse({
      profile: "explore",
      description: "Inspect",
      prompt: "Inspect the workspace",
    });
    const childLimited = context(parent);
    childLimited.delegationBudget.childrenStarted =
      childLimited.delegationBudget.maxChildren;
    const costLimited = context(parent);
    costLimited.delegationBudget.reportedCostUsd =
      costLimited.delegationBudget.maxReportedCostUsd;
    const requestLimited = context(parent);
    requestLimited.delegationBudget.requestsReserved =
      requestLimited.delegationBudget.maxRequests;

    await expect(tool.execute(input, childLimited)).rejects.toMatchObject({
      code: "permission_denied",
      message: "Agent child limit reached (4)",
    });
    await expect(tool.execute(input, costLimited)).rejects.toMatchObject({
      code: "permission_denied",
      message: "Agent reported-cost limit reached ($3)",
    });
    await expect(tool.execute(input, requestLimited)).rejects.toMatchObject({
      code: "permission_denied",
      message: "Agent request limit reached (24)",
    });
    expect(starts).toBe(0);
  });

  it("returns the child that crosses the reported-cost ceiling and blocks the next one", async () => {
    const { sessions, parent } = await storeFixture();
    let starts = 0;
    const coordinator: RunCoordinator = {
      async start() {
        starts += 1;
        return {
          events: { async *[Symbol.asyncIterator]() {} },
          outcome: Promise.resolve({
            ok: true,
            result: {
              finalText: "completed before the ceiling was known",
              usage: { inputTokens: 1, outputTokens: 1, costUsd: 3.5 },
              usageSource: "provider",
              steps: 1,
              changedFiles: [],
              changedFilesSource: "none",
              evidence: [],
              evidenceSource: "none",
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
        let value = 0;
        return () => `cost-${++value}`;
      })(),
      now: () => testAt,
    });
    const tool = manager.createTool();
    const input = tool.parse({
      profile: "explore",
      description: "Inspect",
      prompt: "Inspect the workspace",
    });
    const runContext = context(parent);

    await expect(tool.execute(input, runContext)).resolves.toMatchObject({
      metadata: {
        costLimitExceeded: true,
        workflow: { reportedCostUsd: 3.5, maxReportedCostUsd: 3 },
      },
    });
    await expect(tool.execute(input, runContext)).rejects.toMatchObject({
      code: "permission_denied",
      message: "Agent reported-cost limit reached ($3)",
    });
    expect(starts).toBe(1);
  });

  it("enforces the explicit one-child concurrency limit", async () => {
    const { sessions, parent } = await storeFixture("balanced_v1");
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
      tool.parse({
        profile: "explore",
        description: "First child",
        prompt: "Inspect first",
      }),
      context(parent),
    );
    void first.catch(() => {});
    await ready;

    await expect(tool.execute(
      tool.parse({
        profile: "explore",
        description: "Second child",
        prompt: "Inspect second",
      }),
      context(parent),
    )).rejects.toThrow("concurrency limit");
    release();
    await expect(first).rejects.toMatchObject({ code: "execution_failed" });
  });
});
