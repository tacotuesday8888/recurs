import { describe, expect, it } from "vitest";

import {
  LocalOpenAICompatibleProvider,
  ProviderError,
  listLocalOpenAIModels,
  normalizeLoopbackOpenAIBaseUrl,
} from "../src/index.js";

function sse(lines: readonly unknown[]): Response {
  const body = lines.map((line) => `data: ${JSON.stringify(line)}\n\n`).join("") +
    "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("literal loopback URL validation", () => {
  it("normalizes exact IPv4 and IPv6 loopback base URLs", () => {
    expect(normalizeLoopbackOpenAIBaseUrl("http://127.0.0.1:11434/v1/"))
      .toBe("http://127.0.0.1:11434/v1");
    expect(normalizeLoopbackOpenAIBaseUrl("http://[::1]:1234/v1"))
      .toBe("http://[::1]:1234/v1");
  });

  it.each([
    "https://127.0.0.1:11434/v1",
    "http://localhost:11434/v1",
    "http://127.0.0.2:11434/v1",
    "http://192.168.1.2:11434/v1",
    "http://user@127.0.0.1:11434/v1",
    "http://127.0.0.1:11434/v1?next=https://example.com",
    "http://127.0.0.1:11434/v1#fragment",
  ])("rejects non-literal or ambiguous URL %s", (input) => {
    expect(() => normalizeLoopbackOpenAIBaseUrl(input)).toThrow(
      "Local model URL must be plain HTTP on literal 127.0.0.1 or [::1]",
    );
  });
});

describe("local OpenAI-compatible discovery", () => {
  it("returns a strict, sorted model catalog without following redirects", async () => {
    let redirect: RequestRedirect | undefined;
    const models = await listLocalOpenAIModels({
      baseUrl: "http://127.0.0.1:11434/v1",
      fetch: async (_input, init) => {
        redirect = init?.redirect;
        return Response.json({
          object: "list",
          data: [
            { id: "qwen-coder", object: "model", owned_by: "local" },
            { id: "deepseek-coder", object: "model", owned_by: "local" },
          ],
        });
      },
    });

    expect(redirect).toBe("manual");
    expect(models).toEqual([
      { id: "deepseek-coder", ownedBy: "local" },
      { id: "qwen-coder", ownedBy: "local" },
    ]);
  });

  it("rejects redirects and malformed catalogs", async () => {
    await expect(listLocalOpenAIModels({
      baseUrl: "http://127.0.0.1:11434/v1",
      fetch: async () => new Response(null, {
        status: 302,
        headers: { location: "https://example.com/models" },
      }),
    })).rejects.toMatchObject({ code: "transport" });

    await expect(listLocalOpenAIModels({
      baseUrl: "http://127.0.0.1:11434/v1",
      fetch: async () => Response.json({ data: [{ id: "" }] }),
    })).rejects.toMatchObject({ code: "invalid_response" });
  });
});

describe("LocalOpenAICompatibleProvider", () => {
  it("streams text, assembled tool calls, usage, and completion", async () => {
    const provider = new LocalOpenAICompatibleProvider({
      baseUrl: "http://127.0.0.1:11434/v1",
      connectionId: "local-test",
      fetch: async () => sse([
        { choices: [{ delta: { content: "I will inspect. " }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "read_file", arguments: "{\"pa" } }] }, finish_reason: null }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "th\":\"README.md\"}" } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 12, completion_tokens: 7 } },
      ]),
    });

    const events = [];
    for await (const event of provider.stream({
      model: "qwen-coder",
      messages: [{ id: "m1", role: "user", content: "inspect" }],
      tools: [{ name: "read_file", description: "Read", inputSchema: { type: "object" } }],
      signal: new AbortController().signal,
    })) events.push(event);

    expect(events).toEqual([
      { type: "text_delta", text: "I will inspect. " },
      { type: "tool_call", call: { id: "call-1", name: "read_file", arguments: { path: "README.md" } } },
      { type: "usage", inputTokens: 12, outputTokens: 7 },
      { type: "done", stopReason: "tool_calls" },
    ]);
    expect(provider).toMatchObject({
      adapterId: "openai-chat-completions",
      connectionId: "local-test",
    });
  });

  it("maps local transport failures to safe provider errors", async () => {
    const provider = new LocalOpenAICompatibleProvider({
      baseUrl: "http://127.0.0.1:1234/v1",
      connectionId: "local-test",
      fetch: async () => {
        throw new Error("SECRET_LOCAL_TRANSPORT_DETAIL");
      },
    });

    let thrown: unknown;
    try {
      for await (const event of provider.stream({
        model: "model",
        messages: [],
        tools: [],
        signal: new AbortController().signal,
      })) {
        void event;
      }
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProviderError);
    expect(thrown).toMatchObject({ code: "transport", retryable: true });
    expect(String(thrown)).not.toContain("SECRET_LOCAL_TRANSPORT_DETAIL");
  });

  it("reports cancellation distinctly from a retryable transport failure", async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = new LocalOpenAICompatibleProvider({
      baseUrl: "http://127.0.0.1:1234/v1",
      connectionId: "local-test",
      fetch: async () => { throw new Error("aborted transport"); },
    });
    const consume = async () => {
      for await (const event of provider.stream({
        model: "model",
        messages: [],
        tools: [],
        signal: controller.signal,
      })) void event;
    };
    await expect(consume()).rejects.toMatchObject({
      code: "cancelled",
      retryable: false,
    });
  });

  it("rejects an oversized event stream", async () => {
    const provider = new LocalOpenAICompatibleProvider({
      baseUrl: "http://127.0.0.1:1234/v1",
      connectionId: "local-test",
      fetch: async () => new Response("x".repeat(16 * 1024 * 1024 + 1), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    });
    const consume = async () => {
      for await (const event of provider.stream({
        model: "model",
        messages: [],
        tools: [],
        signal: new AbortController().signal,
      })) void event;
    };
    await expect(consume()).rejects.toMatchObject({
      code: "invalid_response",
      retryable: false,
    });
  });
});
