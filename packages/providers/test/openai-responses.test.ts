import { describe, expect, it } from "vitest";

import type {
  ProviderEvent,
  ProviderRequest,
  RunAuthorization,
} from "@recurs/contracts";
import {
  ProviderError,
  RemoteOpenAIResponsesProvider,
} from "../src/index.js";

function authorization(
  turnId: string,
  overrides: Partial<RunAuthorization> = {},
): RunAuthorization {
  return {
    kind: "run",
    id: `authorization-${turnId}`,
    operation: "run",
    sessionId: "session-1",
    operationId: `operation-${turnId}`,
    turnId,
    connectionId: "openai-env",
    modelId: "gpt-test",
    backendFingerprint: `sha256:${"a".repeat(64)}`,
    connectionRevision: 1,
    policyRevision: "policy-1",
    billingMode: "strict_primary_only",
    billingSelectionDigest: `sha256:${"b".repeat(64)}`,
    contextDigest: `sha256:${"c".repeat(64)}`,
    maxRequests: 16,
    expiresAt: "2099-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function request(
  turnId: string,
  messages: ProviderRequest["messages"],
): ProviderRequest {
  return {
    model: "gpt-test",
    messages,
    tools: [{
      name: "read_file",
      description: "Read one file",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    }],
    signal: new AbortController().signal,
    directContext: {
      authorization: authorization(turnId),
      expectedSessionRecordSequence: 1,
    },
  };
}

function event(sequence: number, type: string, body: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence, ...body })}`;
}

function response(events: readonly string[]): Response {
  return new Response(`${events.join("\n\n")}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function textCompletion(text = "done"): Response {
  const added = {
    id: "msg_1",
    type: "message",
    status: "in_progress",
    role: "assistant",
    content: [],
  };
  const completed = {
    ...added,
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  return response([
    event(0, "response.created", {
      response: { id: "resp_1", status: "in_progress", output: [] },
    }),
    event(1, "response.in_progress", {
      response: { id: "resp_1", status: "in_progress", output: [] },
    }),
    event(2, "response.output_item.added", { output_index: 0, item: added }),
    event(3, "response.content_part.added", {
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    }),
    event(4, "response.output_text.delta", {
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      delta: text,
    }),
    event(5, "response.output_text.done", {
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      text,
    }),
    event(6, "response.content_part.done", {
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text, annotations: [] },
    }),
    event(7, "response.output_item.done", { output_index: 0, item: completed }),
    event(8, "response.completed", {
      response: {
        id: "resp_1",
        status: "completed",
        output: [completed],
        usage: { input_tokens: 7, output_tokens: 2, total_tokens: 9 },
      },
    }),
  ]);
}

function toolCompletion(): Response {
  const reasoningAdded = {
    id: "reasoning_1",
    type: "reasoning",
    status: "in_progress",
    summary: [],
  };
  const reasoningCompleted = {
    ...reasoningAdded,
    status: "completed",
    summary: [{ type: "summary_text", text: "Need the file" }],
    encrypted_content: "encrypted-reasoning",
  };
  const added = {
    id: "fc_1",
    type: "function_call",
    status: "in_progress",
    call_id: "call_1",
    name: "read_file",
    arguments: "",
  };
  const completed = { ...added, status: "completed", arguments: "{\"path\":\"a.ts\"}" };
  return response([
    event(0, "response.created", {
      response: { id: "resp_tool", status: "in_progress", output: [] },
    }),
    event(1, "response.in_progress", {
      response: { id: "resp_tool", status: "in_progress", output: [] },
    }),
    event(2, "response.output_item.added", { output_index: 0, item: reasoningAdded }),
    event(3, "response.reasoning_summary_part.added", {
      item_id: "reasoning_1",
      output_index: 0,
      summary_index: 0,
      part: { type: "summary_text", text: "" },
    }),
    event(4, "response.reasoning_summary_text.delta", {
      item_id: "reasoning_1",
      output_index: 0,
      summary_index: 0,
      delta: "Need the file",
    }),
    event(5, "response.reasoning_summary_text.done", {
      item_id: "reasoning_1",
      output_index: 0,
      summary_index: 0,
      text: "Need the file",
    }),
    event(6, "response.reasoning_summary_part.done", {
      item_id: "reasoning_1",
      output_index: 0,
      summary_index: 0,
      part: { type: "summary_text", text: "Need the file" },
    }),
    event(7, "response.output_item.done", {
      output_index: 0,
      item: reasoningCompleted,
    }),
    event(8, "response.output_item.added", { output_index: 1, item: added }),
    event(9, "response.function_call_arguments.delta", {
      item_id: "fc_1",
      output_index: 1,
      delta: "{\"path\":",
    }),
    event(10, "response.function_call_arguments.delta", {
      item_id: "fc_1",
      output_index: 1,
      delta: "\"a.ts\"}",
    }),
    event(11, "response.function_call_arguments.done", {
      item_id: "fc_1",
      output_index: 1,
      name: "read_file",
      arguments: "{\"path\":\"a.ts\"}",
    }),
    event(12, "response.output_item.done", { output_index: 1, item: completed }),
    event(13, "response.completed", {
      response: {
        id: "resp_tool",
        status: "completed",
        output: [reasoningCompleted, completed],
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      },
    }),
  ]);
}

async function collect(provider: RemoteOpenAIResponsesProvider, input: ProviderRequest) {
  const events: ProviderEvent[] = [];
  for await (const providerEvent of provider.stream(input)) events.push(providerEvent);
  return events;
}

describe("RemoteOpenAIResponsesProvider", () => {
  it("uses the fixed OpenAI origin and a stateless Responses request", async () => {
    const key = "private-openai-key-canary";
    let url = "";
    let headers = new Headers();
    let body: Record<string, unknown> = {};
    const provider = new RemoteOpenAIResponsesProvider({
      connectionId: "openai-env",
      apiKey: key,
      fetch: async (input, init) => {
        url = String(input);
        headers = new Headers(init?.headers);
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return textCompletion();
      },
    });

    const events = await collect(provider, request("turn-1", [
      { id: "system", role: "system", content: "Be exact" },
      { id: "user", role: "user", content: "Work" },
    ]));

    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(headers.get("authorization")).toBe(`Bearer ${key}`);
    expect(JSON.stringify(body)).not.toContain(key);
    expect(body).toMatchObject({
      model: "gpt-test",
      stream: true,
      store: false,
      include: ["reasoning.encrypted_content"],
      tool_choice: "auto",
      parallel_tool_calls: true,
    });
    expect(body.tools).toEqual([{
      type: "function",
      name: "read_file",
      description: "Read one file",
      parameters: expect.any(Object),
    }]);
    expect(events).toEqual([
      { type: "text_delta", text: "done" },
      { type: "usage", inputTokens: 7, outputTokens: 2 },
      { type: "done", stopReason: "complete" },
    ]);
    expect(provider).toMatchObject({
      id: "openai-api",
      adapterId: "openai-responses",
      harnessProfile: { id: "native_tool_use_v2", version: 2 },
    });
    expect(JSON.stringify(provider)).not.toContain(key);
  });

  it("replays private response items for a tool continuation in the same process", async () => {
    const bodies: Record<string, unknown>[] = [];
    const responses = [toolCompletion(), textCompletion("contents received")];
    const provider = new RemoteOpenAIResponsesProvider({
      connectionId: "openai-env",
      apiKey: "private-openai-key",
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        const next = responses.shift();
        if (next === undefined) throw new Error("unexpected request");
        return next;
      },
    });
    const first = await collect(provider, request("turn-1", [
      { id: "user", role: "user", content: "read a.ts" },
    ]));
    const handle = first.find((item) => item.type === "provider_state")?.handle;
    if (handle === undefined) throw new Error("missing handle");
    expect(first).toContainEqual({
      type: "tool_call",
      call: { id: "call_1", name: "read_file", arguments: { path: "a.ts" } },
    });

    const restoredHandle = structuredClone(handle);
    const second = await collect(provider, request("turn-2", [
      { id: "user", role: "user", content: "read a.ts" },
      {
        id: "assistant",
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "read_file", arguments: { path: "a.ts" } }],
        providerStateHandle: restoredHandle,
      },
      { id: "tool", role: "tool", toolCallId: "call_1", content: "contents" },
    ] as ProviderRequest["messages"]));

    const secondInput = bodies[1]?.input;
    expect(secondInput).toEqual([
      { type: "message", role: "user", content: "read a.ts" },
      {
        id: "reasoning_1",
        type: "reasoning",
        status: "completed",
        summary: [{ type: "summary_text", text: "Need the file" }],
        encrypted_content: "encrypted-reasoning",
      },
      {
        id: "fc_1",
        type: "function_call",
        status: "completed",
        call_id: "call_1",
        name: "read_file",
        arguments: "{\"path\":\"a.ts\"}",
      },
      { type: "function_call_output", call_id: "call_1", output: "contents" },
    ]);
    expect(second).toContainEqual({ type: "text_delta", text: "contents received" });
    expect(second.find((item) => item.type === "provider_state")).toBeUndefined();
  });

  it("fails closed when process-scoped continuation state is unavailable", async () => {
    const providerWithToolState = new RemoteOpenAIResponsesProvider({
      connectionId: "openai-env",
      apiKey: "private-openai-key",
      fetch: async () => toolCompletion(),
    });
    const events = await collect(providerWithToolState, request("turn-1", [
      { id: "user", role: "user", content: "read a.ts" },
    ]));
    const handle = events.find((item) => item.type === "provider_state")?.handle;
    if (handle === undefined) throw new Error("missing handle");
    const replacement = new RemoteOpenAIResponsesProvider({
      connectionId: "openai-env",
      apiKey: "private-openai-key",
      fetch: async () => textCompletion(),
    });
    await expect(collect(replacement, request("turn-2", [{
      id: "assistant",
      role: "assistant",
      content: "work",
      providerStateHandle: handle,
    }] as ProviderRequest["messages"]))).rejects.toMatchObject({
      code: "invalid_response",
      message: "OpenAI continuation state is unavailable in this process",
    });
  });

  it("resumes a completed conversation from its last visible answer after restart", async () => {
    const original = new RemoteOpenAIResponsesProvider({
      connectionId: "openai-env",
      apiKey: "private-openai-key",
      fetch: async () => toolCompletion(),
    });
    const toolEvents = await collect(original, request("turn-1", [
      { id: "user-1", role: "user", content: "read a.ts" },
    ]));
    const handle = toolEvents.find((item) => item.type === "provider_state")?.handle;
    if (handle === undefined) throw new Error("missing handle");
    let body: Record<string, unknown> = {};
    const restarted = new RemoteOpenAIResponsesProvider({
      connectionId: "openai-env",
      apiKey: "private-openai-key",
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return textCompletion("continued");
      },
    });

    await expect(collect(restarted, request("turn-3", [
      { id: "system", role: "system", content: "current instructions" },
      { id: "user-1", role: "user", content: "read a.ts" },
      {
        id: "assistant-tool",
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "read_file", arguments: { path: "a.ts" } }],
        providerStateHandle: handle,
      },
      { id: "tool", role: "tool", toolCallId: "call_1", content: "contents" },
      { id: "assistant-final", role: "assistant", content: "Earlier final answer" },
      { id: "user-2", role: "user", content: "Continue" },
    ] as ProviderRequest["messages"]))).resolves.toContainEqual({
      type: "text_delta",
      text: "continued",
    });
    expect(body.input).toEqual([
      { type: "message", role: "system", content: "current instructions" },
      { type: "message", role: "assistant", content: "Earlier final answer" },
      { type: "message", role: "user", content: "Continue" },
    ]);
  });

  it("does not recover a continuation whose authority binding was changed", async () => {
    const original = new RemoteOpenAIResponsesProvider({
      connectionId: "openai-env",
      apiKey: "private-openai-key",
      fetch: async () => toolCompletion(),
    });
    const toolEvents = await collect(original, request("turn-1", [
      { id: "user-1", role: "user", content: "read a.ts" },
    ]));
    const handle = toolEvents.find((item) => item.type === "provider_state")?.handle;
    if (handle === undefined) throw new Error("missing handle");
    const tamperedHandle = {
      ...structuredClone(handle),
      backendFingerprint: `sha256:${"d".repeat(64)}`,
    };
    let requests = 0;
    const restarted = new RemoteOpenAIResponsesProvider({
      connectionId: "openai-env",
      apiKey: "private-openai-key",
      fetch: async () => {
        requests += 1;
        return textCompletion();
      },
    });

    await expect(collect(restarted, request("turn-3", [
      {
        id: "assistant-tool",
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "read_file", arguments: { path: "a.ts" } }],
        providerStateHandle: tamperedHandle,
      },
      { id: "tool", role: "tool", toolCallId: "call_1", content: "contents" },
      { id: "assistant-final", role: "assistant", content: "Earlier final answer" },
      { id: "user-2", role: "user", content: "Continue" },
    ] as ProviderRequest["messages"]))).rejects.toMatchObject({
      code: "invalid_response",
      message: "OpenAI continuation state is unavailable in this process",
    });
    expect(requests).toBe(0);
  });

  it("rejects malformed event ordering and split credential echo", async () => {
    const malformed = response([
      event(0, "response.created", {
        response: { id: "resp", status: "in_progress", output: [] },
      }),
      event(2, "response.in_progress", {
        response: { id: "resp", status: "in_progress", output: [] },
      }),
    ]);
    const malformedProvider = new RemoteOpenAIResponsesProvider({
      connectionId: "openai-env",
      apiKey: "private-openai-key",
      fetch: async () => malformed,
    });
    await expect(collect(malformedProvider, request("turn-1", [
      { id: "user", role: "user", content: "work" },
    ]))).rejects.toBeInstanceOf(ProviderError);

    const terminalMismatch = textCompletion();
    const terminalText = await terminalMismatch.text();
    const terminalItem = '"text":"done","annotations":[]}]';
    const terminalOffset = terminalText.lastIndexOf(terminalItem);
    if (terminalOffset === -1) throw new Error("missing terminal item");
    const inconsistentText = `${terminalText.slice(0, terminalOffset)}${
      terminalItem.replace('"done"', '"different"')
    }${terminalText.slice(terminalOffset + terminalItem.length)}`;
    const inconsistentProvider = new RemoteOpenAIResponsesProvider({
      connectionId: "openai-env",
      apiKey: "private-openai-key",
      fetch: async () => new Response(
        inconsistentText,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    });
    await expect(collect(inconsistentProvider, request("turn-1", [
      { id: "user", role: "user", content: "work" },
    ]))).rejects.toMatchObject({ code: "invalid_response" });

    const invalidUtf8Provider = new RemoteOpenAIResponsesProvider({
      connectionId: "openai-env",
      apiKey: "private-openai-key",
      fetch: async () => new Response(Uint8Array.of(0xff), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    });
    await expect(collect(invalidUtf8Provider, request("turn-1", [
      { id: "user", role: "user", content: "work" },
    ]))).rejects.toMatchObject({
      code: "invalid_response",
      message: "OpenAI response was not valid UTF-8",
    });

    const key = "split-private-key";
    const echoing = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: response.created\ndata: {\"type\":\"response.created\",\"sequence_number\":0,\"response\":{\"id\":\"resp\",\"status\":\"in_progress\",\"output\":[]}}\n\ndata: split-pri"));
        controller.enqueue(new TextEncoder().encode("vate-key\n\n"));
        controller.close();
      },
    }), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const echoProvider = new RemoteOpenAIResponsesProvider({
      connectionId: "openai-env",
      apiKey: key,
      fetch: async () => echoing,
    });
    await expect(collect(echoProvider, request("turn-1", [
      { id: "user", role: "user", content: "work" },
    ]))).rejects.toMatchObject({
      code: "invalid_response",
      message: "Provider response contained credential material",
    });
  });

  it("maps authentication, rate limits, redirects, and cancellation safely", async () => {
    for (const [status, code, retryable] of [
      [401, "authentication", false],
      [429, "rate_limit", true],
      [302, "transport", false],
    ] as const) {
      const provider = new RemoteOpenAIResponsesProvider({
        connectionId: "openai-env",
        apiKey: "private-openai-key",
        fetch: async () => new Response("secret provider body", { status }),
      });
      await expect(collect(provider, request("turn-1", [
        { id: "user", role: "user", content: "work" },
      ]))).rejects.toMatchObject({ code, retryable });
    }

    const controller = new AbortController();
    controller.abort();
    const provider = new RemoteOpenAIResponsesProvider({
      connectionId: "openai-env",
      apiKey: "private-openai-key",
      fetch: async () => { throw new Error("raw failure"); },
    });
    await expect(collect(provider, {
      ...request("turn-1", [{ id: "user", role: "user", content: "work" }]),
      signal: controller.signal,
    })).rejects.toMatchObject({ code: "cancelled", retryable: false });
  });
});
