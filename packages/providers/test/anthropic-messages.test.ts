import { describe, expect, it } from "vitest";

import {
  ProviderError,
  RemoteAnthropicMessagesProvider,
} from "../src/index.js";

function event(type: string, value: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
}

function response(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function toolStream(): string {
  return [
    event("message_start", {
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-test",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 7,
          output_tokens: 1,
          cache_read_input_tokens: 2,
          cache_creation_input_tokens: 3,
        },
      },
    }),
    event("content_block_start", {
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    event("content_block_delta", {
      index: 0,
      delta: { type: "text_delta", text: "checking" },
    }),
    event("content_block_stop", { index: 0 }),
    event("content_block_start", {
      index: 1,
      content_block: {
        type: "tool_use",
        id: "toolu_2",
        name: "read_file",
        input: {},
      },
    }),
    event("content_block_delta", {
      index: 1,
      delta: { type: "input_json_delta", partial_json: "{\"path\":" },
    }),
    event("content_block_delta", {
      index: 1,
      delta: { type: "input_json_delta", partial_json: "\"README.md\"}" },
    }),
    event("content_block_stop", { index: 1 }),
    event("message_delta", {
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 9 },
    }),
    event("message_stop", {}),
  ].join("");
}

describe("remote Anthropic Messages provider", () => {
  it("uses the reviewed origin, native tool blocks, and required Anthropic headers", async () => {
    const key = "anthropic-key-canary";
    let url = "";
    let headers = new Headers();
    let body: Record<string, unknown> = {};
    const provider = new RemoteAnthropicMessagesProvider({
      providerId: "anthropic-api",
      connectionId: "anthropic-env",
      apiKey: key,
      fetch: async (input, init) => {
        url = String(input);
        headers = new Headers(init?.headers);
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return response([toolStream()]);
      },
    });

    const events = [];
    for await (const providerEvent of provider.stream({
      model: "claude-test",
      messages: [
        { id: "system", role: "system", content: "Use workspace tools." },
        { id: "user", role: "user", content: "Inspect the project." },
        {
          id: "assistant",
          role: "assistant",
          content: "I will inspect it.",
          toolCalls: [{
            id: "toolu_1",
            name: "read_file",
            arguments: { path: "package.json" },
          }],
        },
        {
          id: "tool",
          role: "tool",
          content: "package contents",
          toolCallId: "toolu_1",
        },
      ],
      tools: [{
        name: "read_file",
        description: "Read one workspace file",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      }],
      signal: new AbortController().signal,
    })) events.push(providerEvent);

    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(headers.get("x-api-key")).toBe(key);
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(headers.get("accept")).toBe("text/event-stream");
    expect(JSON.stringify(body)).not.toContain(key);
    expect(body).toEqual({
      model: "claude-test",
      max_tokens: 8192,
      stream: true,
      system: "Use workspace tools.",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "Inspect the project." }],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "I will inspect it." },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "read_file",
              input: { path: "package.json" },
            },
          ],
        },
        {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: "package contents",
          }],
        },
      ],
      tools: [{
        name: "read_file",
        description: "Read one workspace file",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      }],
    });
    expect(events).toEqual([
      { type: "text_delta", text: "checking" },
      {
        type: "tool_call",
        call: {
          id: "toolu_2",
          name: "read_file",
          arguments: { path: "README.md" },
        },
      },
      { type: "usage", inputTokens: 12, outputTokens: 9 },
      { type: "done", stopReason: "tool_calls" },
    ]);
    expect(provider).toMatchObject({
      id: "anthropic-api",
      adapterId: "anthropic-messages",
      connectionId: "anthropic-env",
      harnessProfile: { id: "native_tool_use_v2", version: 2 },
    });
    expect(JSON.stringify(provider)).not.toContain(key);
  });

  it("rejects arbitrary origins and non-Anthropic provider profiles", () => {
    for (const providerId of [
      "https://attacker.invalid/v1",
      "openai-api",
      "openrouter-api",
      "unknown-provider",
    ]) {
      expect(() => new RemoteAnthropicMessagesProvider({
        providerId,
        connectionId: "connection",
        apiKey: "private-key",
      })).toThrow("reviewed Anthropic Messages endpoint");
    }
  });

  it("fails closed when credential material is split across response chunks", async () => {
    const key = "split-credential-canary";
    const provider = new RemoteAnthropicMessagesProvider({
      providerId: "anthropic-api",
      connectionId: "connection",
      apiKey: key,
      fetch: async () => response([
        event("message_start", {
          message: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-test",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        }) + event("content_block_start", {
          index: 0,
          content_block: { type: "text", text: "" },
        }) + "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"split-cre",
        "dential-canary\"}}\n\n",
      ]),
    });

    let thrown: unknown;
    try {
      for await (const providerEvent of provider.stream({
        model: "claude-test",
        messages: [{ id: "user", role: "user", content: "work" }],
        tools: [],
        signal: new AbortController().signal,
      })) void providerEvent;
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProviderError);
    expect(thrown).toMatchObject({ code: "invalid_response", retryable: false });
    expect(String(thrown)).not.toContain(key);
  });

  it("maps authentication, rate limits, request size, and redirects without reading bodies", async () => {
    const key = "key-that-must-not-leak";
    for (const [status, code, retryable] of [
      [401, "authentication", false],
      [429, "rate_limit", true],
      [413, "context_overflow", false],
      [302, "transport", false],
    ] as const) {
      const provider = new RemoteAnthropicMessagesProvider({
        providerId: "anthropic-api",
        connectionId: `connection-${status}`,
        apiKey: key,
        fetch: async () => new Response(`provider body ${key}`, { status }),
      });
      let thrown: unknown;
      try {
        for await (const providerEvent of provider.stream({
          model: "claude-test",
          messages: [{ id: "user", role: "user", content: "work" }],
          tools: [],
          signal: new AbortController().signal,
        })) void providerEvent;
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ProviderError);
      expect(thrown).toMatchObject({ code, retryable });
      expect(String(thrown)).not.toContain(key);
    }
  });
});
