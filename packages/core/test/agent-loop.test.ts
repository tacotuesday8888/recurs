import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ModelProvider, ProviderRequest } from "@recurs/providers";
import {
  ProviderError,
  ScriptedProvider,
  type ProviderEvent,
} from "@recurs/providers";
import {
  ToolError,
  ToolRegistry,
  type ApprovalHandler,
  type Tool,
} from "@recurs/tools";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentLoop,
  JsonlSessionStore,
  activeGoal,
  runAgentLoop,
  type RecursEvent,
} from "../src/index.js";
import { testAt, testBackendPin } from "../../../tests/support/backend.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function echoTool(
  executions: string[] = [],
  metadata?: Record<string, unknown>,
): Tool<{ text: string }> {
  return {
    definition: {
      name: "echo",
      description: "Echo text",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
    },
    executionClass: "in_process",
    mutating: false,
    parse(input) {
      if (
        typeof input !== "object" ||
        input === null ||
        !("text" in input) ||
        typeof input.text !== "string"
      ) {
        throw new ToolError("invalid_input", "text must be a string");
      }
      return { text: input.text };
    },
    permissions(input) {
      return [{ category: "read", resource: input.text, risk: "normal" }];
    },
    async execute(input) {
      executions.push(input.text);
      return metadata === undefined
        ? { output: input.text }
        : { output: input.text, metadata };
    },
  };
}

function writeTool(executions: string[] = []): Tool<{ text: string }> {
  const base = echoTool(executions);
  return {
    ...base,
    definition: { ...base.definition, name: "write_text" },
    mutating: true,
    permissions(input) {
      return [{ category: "write", resource: input.text, risk: "normal" }];
    },
  };
}

const deny: ApprovalHandler = {
  async request() {
    return "deny";
  },
};

function dependencies(
  provider: ModelProvider,
  store: JsonlSessionStore,
  tools: Tool[],
  approvals: ApprovalHandler,
  events: RecursEvent[],
) {
  return {
    provider,
    tools: new ToolRegistry(tools),
    approvals,
    sessions: store,
    async emit(event: RecursEvent) {
      events.push(event);
    },
    createToolContext(state: { id: string; cwd: string; executionMode: "act" | "plan" }, signal: AbortSignal) {
      return {
        sessionId: state.id,
        cwd: state.cwd,
        signal,
        executionMode: state.executionMode,
        readRevisions: new Map(),
      };
    },
  };
}

async function harness(
  provider: ModelProvider,
  tools: Tool[] = [echoTool()],
  approvals: ApprovalHandler = deny,
): Promise<{
  loop: AgentLoop;
  store: JsonlSessionStore;
  events: RecursEvent[];
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "recurs-loop-"));
  temporaryDirectories.push(directory);
  const store = new JsonlSessionStore(directory);
  await store.createPinnedSession({
    id: "s1",
    at: testAt,
    cwd: "/workspace",
    backend: testBackendPin(),
  });
  const events: RecursEvent[] = [];
  return {
    store,
    events,
    loop: new AgentLoop(dependencies(provider, store, tools, approvals, events)),
  };
}

function toolTurn(id: string, text: string): ProviderEvent[] {
  return [
    {
      type: "tool_call",
      call: { id, name: "echo", arguments: { text } },
    },
    { type: "done", stopReason: "tool_calls" },
  ];
}

async function seedInterruptedTool(
  store: JsonlSessionStore,
  call: { id: string; name: string; arguments: unknown },
  outcome?: { type: "completed"; output: string } | { type: "failed"; message: string },
): Promise<void> {
  await store.withSessionMutation("s1", 0, async (lease) => {
    await lease.append({
      type: "turn_started",
      turnId: "crashed-turn",
      prompt: "before crash",
      at: "2026-07-10T00:00:01.000Z",
    });
    await lease.append({
      type: "model_completed",
      turnId: "crashed-turn",
      at: "2026-07-10T00:00:02.000Z",
      message: {
        id: "assistant-before-crash",
        role: "assistant",
        content: "",
        toolCalls: [call],
      },
      usage: null,
      stopReason: "tool_calls",
    });
    await lease.append({
      type: "tool_started",
      turnId: "crashed-turn",
      at: "2026-07-10T00:00:03.000Z",
      call,
    });
    if (outcome?.type === "completed") {
      await lease.append({
        type: "tool_completed",
        turnId: "crashed-turn",
        at: "2026-07-10T00:00:04.000Z",
        callId: call.id,
        result: { output: outcome.output },
      });
    } else if (outcome?.type === "failed") {
      await lease.append({
        type: "tool_failed",
        turnId: "crashed-turn",
        at: "2026-07-10T00:00:04.000Z",
        callId: call.id,
        error: {
          domain: "tool",
          phase: "started",
          code: "tool_failed",
          safeMessage: `Tool error [permission_denied]: ${outcome.message}`,
          diagnosticId: "seeded-tool-failure",
          retryable: false,
        },
      });
    }
  });
}

describe("AgentLoop", () => {
  it("streams and persists a final assistant response", async () => {
    const provider = new ScriptedProvider([
      [
        { type: "text_delta", text: "all " },
        { type: "text_delta", text: "done" },
        { type: "usage", inputTokens: 7, outputTokens: 2 },
        { type: "done", stopReason: "complete" },
      ],
    ]);
    const { loop, store, events } = await harness(provider);

    const result = await loop.run({ sessionId: "s1", prompt: "work" });

    expect(result).toMatchObject({
      finalText: "all done",
      usage: { inputTokens: 7, outputTokens: 2 },
      steps: 1,
    });
    expect((await store.loadState("s1")).messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["turn_started", "model_text_delta", "model_completed", "turn_completed"]),
    );
    expect(events.some((event) => "version" in event)).toBe(false);
  });

  it("runs pinned sessions entirely through sequenced version 2 records", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "recurs-loop-v2-"));
    temporaryDirectories.push(directory);
    const store = new JsonlSessionStore(directory);
    await store.createPinnedSession({
      id: "s2",
      cwd: "/workspace",
      backend: testBackendPin(),
      at: "2026-07-10T00:00:00.000Z",
    });
    const provider = new ScriptedProvider([
      [
        { type: "text_delta", text: "pinned" },
        { type: "usage", inputTokens: 2, outputTokens: 1 },
        { type: "done", stopReason: "complete" },
      ],
    ]);
    const events: RecursEvent[] = [];
    const loop = new AgentLoop(dependencies(provider, store, [], deny, events));

    await expect(
      loop.run({ sessionId: "s2", prompt: "inspect" }),
    ).resolves.toMatchObject({ finalText: "pinned" });

    const loaded = await store.load("s2");
    expect(loaded.records.map((record) => record.version)).toEqual([2, 2, 2, 2]);
    expect(loaded.records.map((record) =>
      record.version === 2 ? record.sequence : -1,
    )).toEqual([0, 1, 2, 3]);
    expect((await store.loadState("s2")).messages.map((message) => message.role))
      .toEqual(["user", "assistant"]);
  });

  it("feeds sequential tool results back to the provider in call order", async () => {
    const executions: string[] = [];
    const provider = new ScriptedProvider([
      [
        { type: "tool_call", call: { id: "1", name: "echo", arguments: { text: "a" } } },
        { type: "tool_call", call: { id: "2", name: "echo", arguments: { text: "b" } } },
        { type: "done", stopReason: "tool_calls" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "done", stopReason: "complete" },
      ],
    ]);
    const { loop } = await harness(provider, [echoTool(executions)]);

    const result = await loop.run({ sessionId: "s1", prompt: "work", maxSteps: 8 });

    expect(result.finalText).toBe("done");
    expect(executions).toEqual(["a", "b"]);
    expect(provider.requests[1]?.messages.slice(-2).map((message) => message.content)).toEqual([
      "a",
      "b",
    ]);
  });

  it("shares current-turn read revisions across sequential tool calls", async () => {
    let secondSawRevision = false;
    const makeTool = (name: string, execute: Tool["execute"]): Tool => ({
      definition: {
        name,
        description: name,
        inputSchema: { type: "object", additionalProperties: false },
      },
      executionClass: "in_process",
      mutating: false,
      parse() {
        return {};
      },
      permissions() {
        return [{ category: "read", resource: name, risk: "normal" }];
      },
      execute,
    });
    const remember = makeTool("remember", async (_input, context) => {
      context.readRevisions.set("/workspace/a.ts", "hash");
      return { output: "remembered" };
    });
    const requireRevision = makeTool("require_revision", async (_input, context) => {
      secondSawRevision = context.readRevisions.get("/workspace/a.ts") === "hash";
      return { output: secondSawRevision ? "found" : "missing" };
    });
    const provider = new ScriptedProvider([
      [
        { type: "tool_call", call: { id: "1", name: "remember", arguments: {} } },
        {
          type: "tool_call",
          call: { id: "2", name: "require_revision", arguments: {} },
        },
        { type: "done", stopReason: "tool_calls" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "done", stopReason: "complete" },
      ],
    ]);
    const { loop } = await harness(provider, [remember, requireRevision]);

    await loop.run({ sessionId: "s1", prompt: "work" });

    expect(secondSawRevision).toBe(true);
  });

  it("emits permission request and resolution events around approval", async () => {
    const provider = new ScriptedProvider([
      [
        {
          type: "tool_call",
          call: { id: "1", name: "write_text", arguments: { text: "a" } },
        },
        { type: "done", stopReason: "tool_calls" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "done", stopReason: "complete" },
      ],
    ]);
    const base = echoTool();
    const mutating: Tool<{ text: string }> = {
      ...base,
      definition: { ...base.definition, name: "write_text" },
      mutating: true,
      permissions(input) {
        return [{ category: "write", resource: input.text, risk: "normal" }];
      },
    };
    const approvals: ApprovalHandler = {
      async request() {
        return "allow_once";
      },
    };
    const { loop, events } = await harness(provider, [mutating], approvals);

    await loop.run({ sessionId: "s1", prompt: "write" });

    expect(events).toContainEqual(
      expect.objectContaining({ type: "permission_requested" }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "permission_resolved",
        decision: "allow_once",
      }),
    );
  });

  it("supports a temporary read-only override without changing session mode", async () => {
    const provider = new ScriptedProvider([
      [
        { type: "text_delta", text: "reviewed" },
        { type: "done", stopReason: "complete" },
      ],
    ]);
    const base = echoTool();
    const mutating: Tool<{ text: string }> = {
      ...base,
      definition: { ...base.definition, name: "write_text" },
      mutating: true,
    };
    const { loop, store } = await harness(provider, [base, mutating]);

    await loop.run({
      sessionId: "s1",
      prompt: "review",
      executionMode: "plan",
    });

    expect(provider.requests[0]?.tools.map((tool) => tool.name)).toEqual(["echo"]);
    expect((await store.loadState("s1")).executionMode).toBe("act");
  });

  it("retries a retryable provider failure at most twice", async () => {
    const provider = new ScriptedProvider([
      new ProviderError("transport", "temporary", true),
      [
        { type: "text_delta", text: "recovered" },
        { type: "done", stopReason: "complete" },
      ],
    ]);
    const { loop, events } = await harness(provider);

    expect((await loop.run({ sessionId: "s1", prompt: "work" })).finalText).toBe(
      "recovered",
    );
    expect(provider.requests).toHaveLength(2);
    expect(events).toContainEqual(expect.objectContaining({ type: "retry_scheduled", attempt: 1 }));
  });

  it("does not make a fourth request after exhausting two retries", async () => {
    const provider = new ScriptedProvider([
      new ProviderError("transport", "temporary 1", true),
      new ProviderError("transport", "temporary 2", true),
      new ProviderError("transport", "temporary 3", true),
      new ProviderError("transport", "must not run", true),
    ]);
    const { loop } = await harness(provider);

    await expect(loop.run({ sessionId: "s1", prompt: "work" })).rejects.toMatchObject({
      code: "provider_failed",
    });
    expect(provider.requests).toHaveLength(3);
  });

  it("does not retry after semantic provider output", async () => {
    let requests = 0;
    const provider: ModelProvider = {
      id: "partial-failure",
      async *stream(): AsyncIterable<ProviderEvent> {
        requests += 1;
        yield { type: "text_delta", text: "partial" };
        throw new ProviderError("transport", "connection lost", true);
      },
    };
    const { loop, events } = await harness(provider);

    await expect(loop.run({ sessionId: "s1", prompt: "work" })).rejects.toMatchObject({
      code: "provider_failed",
    });
    expect(requests).toBe(1);
    expect(events.filter((event) => event.type === "retry_scheduled")).toEqual([]);
  });

  it("cancels an in-flight provider request", async () => {
    const started = vi.fn();
    const provider: ModelProvider = {
      id: "waiting",
      async *stream(request: ProviderRequest) {
        started();
        await new Promise<void>((resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
        yield { type: "done", stopReason: "cancelled" };
      },
    };
    const { loop } = await harness(provider);
    const controller = new AbortController();

    const running = loop.run({ sessionId: "s1", prompt: "wait", signal: controller.signal });
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    controller.abort();

    await expect(running).rejects.toMatchObject({ code: "cancelled" });
  });

  it("closes a started tool call when cancellation interrupts execution", async () => {
    const started = vi.fn();
    const waitingTool: Tool = {
      definition: {
        name: "wait",
        description: "Wait for cancellation",
        inputSchema: { type: "object", additionalProperties: false },
      },
      executionClass: "in_process",
      mutating: false,
      parse() {
        return {};
      },
      permissions() {
        return [{ category: "read", resource: "wait", risk: "normal" }];
      },
      async execute(_input, context) {
        started();
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener(
            "abort",
            () => reject(new ToolError("cancelled", "wait was cancelled")),
            { once: true },
          );
        });
        return { output: "unreachable" };
      },
    };
    const provider = new ScriptedProvider([
      [
        { type: "tool_call", call: { id: "wait-1", name: "wait", arguments: {} } },
        { type: "done", stopReason: "tool_calls" },
      ],
    ]);
    const { loop, store, events } = await harness(provider, [waitingTool]);
    const controller = new AbortController();

    const running = loop.run({ sessionId: "s1", prompt: "wait", signal: controller.signal });
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    controller.abort();

    await expect(running).rejects.toMatchObject({ code: "cancelled" });
    const restored = await store.loadState("s1");
    expect(restored.pendingToolCalls).toEqual([]);
    expect(restored.messages.at(-1)).toMatchObject({
      role: "tool",
      toolCallId: "wait-1",
      content: expect.stringContaining("cancelled"),
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool_failed", callId: "wait-1" }),
        expect.objectContaining({ type: "turn_cancelled" }),
      ]),
    );
  });

  it("reconciles a missing tool result before the next provider request", async () => {
    const provider = new ScriptedProvider([
      [
        { type: "text_delta", text: "continued" },
        { type: "done", stopReason: "complete" },
      ],
    ]);
    const { loop, store } = await harness(provider);
    const call = { id: "orphan-1", name: "echo", arguments: { text: "lost" } };
    await seedInterruptedTool(store, call);

    await loop.run({ sessionId: "s1", prompt: "continue" });

    expect(provider.requests[0]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          toolCallId: "orphan-1",
          content: expect.stringContaining("interrupted"),
        }),
      ]),
    );
    expect((await store.loadState("s1")).pendingToolCalls).toEqual([]);
  });

  it("recovers a completed tool result when only its message was lost", async () => {
    const provider = new ScriptedProvider([
      [
        { type: "text_delta", text: "continued" },
        { type: "done", stopReason: "complete" },
      ],
    ]);
    const { loop, store } = await harness(provider);
    const call = { id: "completed-1", name: "echo", arguments: { text: "done" } };
    await seedInterruptedTool(store, call, {
      type: "completed",
      output: "already completed",
    });

    await loop.run({ sessionId: "s1", prompt: "continue" });

    expect(provider.requests[0]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          toolCallId: call.id,
          content: "already completed",
        }),
      ]),
    );
  });

  it("recovers a recorded tool failure when only its message was lost", async () => {
    const provider = new ScriptedProvider([
      [
        { type: "text_delta", text: "continued" },
        { type: "done", stopReason: "complete" },
      ],
    ]);
    const { loop, store } = await harness(provider);
    const call = { id: "failed-1", name: "echo", arguments: { text: "denied" } };
    await seedInterruptedTool(store, call, {
      type: "failed",
      message: "write denied",
    });

    await loop.run({ sessionId: "s1", prompt: "continue" });

    expect(provider.requests[0]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          toolCallId: call.id,
          content: "Tool error [permission_denied]: write denied",
        }),
      ]),
    );
  });

  it("does not append a failed terminal after a completed-event sink failure", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "recurs-event-failure-"));
    temporaryDirectories.push(directory);
    const store = new JsonlSessionStore(directory);
    await store.createPinnedSession({
      id: "s1",
      at: testAt,
      cwd: "/workspace",
      backend: testBackendPin(),
    });
    const provider = new ScriptedProvider([toolTurn("call-1", "done")]);
    const deps = dependencies(provider, store, [echoTool()], deny, []);
    deps.emit = async (event: RecursEvent) => {
      if (event.type === "tool_completed") {
        throw new Error("event sink unavailable");
      }
    };

    await expect(new AgentLoop(deps).run({ sessionId: "s1", prompt: "work" })).rejects.toMatchObject({
      code: "provider_failed",
    });
    const terminalTypes = (await store.load("s1")).records
      .filter((record) =>
        (record.type === "tool_completed" || record.type === "tool_failed") &&
        record.callId === "call-1",
      )
      .map((record) => record.type);
    expect(terminalTypes).toEqual(["tool_completed"]);
  });

  it("rejects concurrent runs for the same session", async () => {
    const firstStarted = vi.fn();
    let requestCount = 0;
    const provider: ModelProvider = {
      id: "concurrency",
      async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
        requestCount += 1;
        if (requestCount === 1) {
          firstStarted();
          await new Promise<void>((_resolve, reject) => {
            request.signal.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          });
        }
        yield { type: "text_delta", text: "second" };
        yield { type: "done", stopReason: "complete" };
      },
    };
    const { loop } = await harness(provider);
    const controller = new AbortController();
    const first = loop.run({ sessionId: "s1", prompt: "first", signal: controller.signal });
    await vi.waitFor(() => expect(firstStarted).toHaveBeenCalledOnce());

    await expect(loop.run({ sessionId: "s1", prompt: "second" })).rejects.toMatchObject({
      code: "session_busy",
    });
    controller.abort();
    await expect(first).rejects.toMatchObject({ code: "cancelled" });
    expect(requestCount).toBe(1);
  });

  it("does not share reusable permission grants across sessions", async () => {
    const executions: string[] = [];
    let approvalRequests = 0;
    const provider = new ScriptedProvider([
      [
        {
          type: "tool_call",
          call: {
            id: "write-1",
            name: "write_text",
            arguments: { text: "same-resource" },
          },
        },
        { type: "done", stopReason: "tool_calls" },
      ],
      [
        { type: "text_delta", text: "first done" },
        { type: "done", stopReason: "complete" },
      ],
      [
        {
          type: "tool_call",
          call: {
            id: "write-2",
            name: "write_text",
            arguments: { text: "same-resource" },
          },
        },
        { type: "done", stopReason: "tool_calls" },
      ],
      [
        { type: "text_delta", text: "second done" },
        { type: "done", stopReason: "complete" },
      ],
    ]);
    const directory = await mkdtemp(path.join(tmpdir(), "recurs-permissions-"));
    temporaryDirectories.push(directory);
    const store = new JsonlSessionStore(directory);
    for (const sessionId of ["s1", "s2"]) {
      await store.createPinnedSession({
        id: sessionId,
        at: testAt,
        cwd: "/workspace",
        backend: testBackendPin("scripted", `connection-${sessionId}`),
      });
    }
    const approvals: ApprovalHandler = {
      async request() {
        approvalRequests += 1;
        return approvalRequests === 1 ? "allow_session" : "deny";
      },
    };
    const loop = new AgentLoop(
      dependencies(
        provider,
        store,
        [writeTool(executions)],
        approvals,
        [],
      ),
    );

    await loop.run({ sessionId: "s1", prompt: "first" });
    await loop.run({ sessionId: "s2", prompt: "second" });

    expect(approvalRequests).toBe(2);
    expect(executions).toEqual(["same-resource"]);
  });

  it("does not leak Full Access into an interleaved Ask Always run", async () => {
    const executions: string[] = [];
    const askStarted = vi.fn();
    let releaseAsk = () => {};
    const askGate = new Promise<void>((resolve) => {
      releaseAsk = resolve;
    });
    const requestCounts = new Map<string, number>();
    const provider: ModelProvider = {
      id: "interleaved-permissions",
      async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
        const prompt = [...request.messages]
          .reverse()
          .find((message) => message.role === "user")?.content ?? "";
        const count = (requestCounts.get(prompt) ?? 0) + 1;
        requestCounts.set(prompt, count);
        if (prompt === "ask" && count === 1) {
          askStarted();
          await askGate;
          yield {
            type: "tool_call",
            call: { id: "write-ask", name: "write_text", arguments: { text: "guarded" } },
          };
          yield { type: "done", stopReason: "tool_calls" };
          return;
        }
        yield { type: "text_delta", text: "done" };
        yield { type: "done", stopReason: "complete" };
      },
    };
    const directory = await mkdtemp(path.join(tmpdir(), "recurs-interleaved-"));
    temporaryDirectories.push(directory);
    const store = new JsonlSessionStore(directory);
    for (const sessionId of ["ask-session", "full-session"]) {
      await store.createPinnedSession({
        id: sessionId,
        at: testAt,
        cwd: "/workspace",
        backend: testBackendPin("scripted", `connection-${sessionId}`),
      });
    }
    await store.withSessionMutation("full-session", 0, async (lease) => {
      await lease.append({
        type: "mode_updated",
        source: "command",
        at: "2026-07-10T00:00:01.000Z",
        executionMode: "act",
        permissionMode: "full_access",
      });
    });
    const loop = new AgentLoop(
      dependencies(
        provider,
        store,
        [writeTool(executions)],
        deny,
        [],
      ),
    );

    const askRun = loop.run({ sessionId: "ask-session", prompt: "ask" });
    await vi.waitFor(() => expect(askStarted).toHaveBeenCalledOnce());
    await loop.run({ sessionId: "full-session", prompt: "full" });
    releaseAsk();
    await askRun;

    expect(executions).toEqual([]);
  });

  it("locks a session across AgentLoop and direct run entry points", async () => {
    const started = vi.fn();
    let requestCount = 0;
    const provider: ModelProvider = {
      id: "shared-lock",
      async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
        requestCount += 1;
        if (requestCount === 1) {
          started();
          await new Promise<void>((_resolve, reject) => {
            request.signal.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          });
        }
        yield { type: "text_delta", text: "unexpected" };
        yield { type: "done", stopReason: "complete" };
      },
    };
    const directory = await mkdtemp(path.join(tmpdir(), "recurs-lock-"));
    temporaryDirectories.push(directory);
    const store = new JsonlSessionStore(directory);
    await store.createPinnedSession({
      id: "s1",
      at: testAt,
      cwd: "/workspace",
      backend: testBackendPin(),
    });
    const deps = dependencies(provider, store, [echoTool()], deny, []);
    const loop = new AgentLoop(deps);
    const controller = new AbortController();
    const first = loop.run({ sessionId: "s1", prompt: "first", signal: controller.signal });
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());

    await expect(runAgentLoop(deps, { sessionId: "s1", prompt: "second" })).rejects.toMatchObject({
      code: "session_busy",
    });
    controller.abort();
    await expect(first).rejects.toMatchObject({ code: "cancelled" });
    expect(requestCount).toBe(1);
  });

  it("stops when the provider exceeds the step budget", async () => {
    const provider = new ScriptedProvider([toolTurn("1", "a")]);
    const { loop } = await harness(provider);

    await expect(
      loop.run({ sessionId: "s1", prompt: "work", maxSteps: 1 }),
    ).rejects.toMatchObject({ code: "step_budget_exceeded" });
  });

  it("stops repeated tool-call-and-result signatures", async () => {
    const provider = new ScriptedProvider([
      toolTurn("1", "same"),
      toolTurn("2", "same"),
      toolTurn("3", "same"),
    ]);
    const { loop } = await harness(provider);

    await expect(
      loop.run({ sessionId: "s1", prompt: "loop", maxSteps: 20 }),
    ).rejects.toMatchObject({ code: "stuck_loop" });
  });

  it("returns and persists changed files and verification evidence", async () => {
    const provider = new ScriptedProvider([
      toolTurn("1", "changed"),
      [
        { type: "text_delta", text: "done" },
        { type: "done", stopReason: "complete" },
      ],
    ]);
    const metadata = {
      changedFiles: ["src/a.ts"],
      evidence: ["npm test passed"],
    };
    const { loop, store } = await harness(provider, [echoTool([], metadata)]);
    await store.withSessionMutation("s1", 0, async (lease) => {
      await lease.append({
        type: "goal_updated",
        source: "command",
        at: testAt,
        goal: activeGoal("change a", testAt),
      });
    });

    const result = await loop.run({ sessionId: "s1", prompt: "work" });
    const restored = await store.loadState("s1");

    expect(result.changedFiles).toEqual(["src/a.ts"]);
    expect(result.evidence).toEqual(["npm test passed"]);
    expect(restored.changedFiles).toEqual(["src/a.ts"]);
    expect(restored.evidence).toEqual(["npm test passed"]);
    expect(restored.goal).toMatchObject({
      progress: "done",
      evidence: ["npm test passed"],
    });
  });
});
