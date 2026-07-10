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
  PermissionEngine,
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
  type RecursEvent,
} from "../src/index.js";

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

const deny: ApprovalHandler = {
  async request() {
    return "deny";
  },
};

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
  await store.append("s1", {
    version: 1,
    type: "session_created",
    sessionId: "s1",
    at: "2026-07-10T00:00:00.000Z",
    cwd: "/workspace",
    model: "scripted",
  });
  const events: RecursEvent[] = [];
  return {
    store,
    events,
    loop: new AgentLoop({
      provider,
      tools: new ToolRegistry(tools),
      permissions: new PermissionEngine("full_access"),
      approvals,
      sessions: store,
      async emit(event) {
        events.push(event);
      },
      createToolContext(state, signal) {
        return {
          sessionId: state.id,
          cwd: state.cwd,
          signal,
          executionMode: state.executionMode,
          readRevisions: new Map(),
        };
      },
    }),
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
    await store.append("s1", {
      version: 1,
      type: "goal_updated",
      sessionId: "s1",
      at: "2026-07-10T00:00:00.000Z",
      goal: activeGoal("change a", "2026-07-10T00:00:00.000Z"),
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
