import { describe, expect, it } from "vitest";

import {
  ProviderError,
  RemoteOpenAICompatibleProvider,
} from "../src/index.js";

function completion(): Response {
  return new Response([
    'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}',
    'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
    "data: [DONE]",
    "",
  ].join("\n\n"), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("remote OpenAI-compatible provider", () => {
  it("uses only the reviewed provider origin and keeps the key in the header", async () => {
    const key = "remote-key-canary";
    let url = "";
    let authorization = "";
    let body = "";
    const provider = new RemoteOpenAICompatibleProvider({
      providerId: "openrouter-api",
      connectionId: "openrouter-env",
      apiKey: key,
      fetch: async (input, init) => {
        url = String(input);
        authorization = new Headers(init?.headers).get("authorization") ?? "";
        body = String(init?.body ?? "");
        return completion();
      },
    });

    const events = [];
    for await (const event of provider.stream({
      model: "model-id",
      messages: [{ id: "user", role: "user", content: "work" }],
      tools: [],
      signal: new AbortController().signal,
    })) events.push(event);

    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(authorization).toBe(`Bearer ${key}`);
    expect(body).not.toContain(key);
    expect(events).toEqual([
      { type: "text_delta", text: "done" },
      { type: "usage", inputTokens: 3, outputTokens: 1 },
      { type: "done", stopReason: "complete" },
    ]);
    expect(provider).toMatchObject({
      id: "openrouter-api",
      adapterId: "openai-chat-completions",
      connectionId: "openrouter-env",
      harnessProfile: { id: "compatible_tool_use_v1", version: 1 },
    });
    expect(JSON.stringify(provider)).not.toContain(key);
  });

  it("rejects arbitrary endpoints and unsupported provider profiles", () => {
    for (const providerId of [
      "https://attacker.invalid/v1",
      "openai-api",
      "zai-glm-coding-plan",
      "unknown-provider",
    ]) {
      expect(() => new RemoteOpenAICompatibleProvider({
        providerId,
        connectionId: "connection",
        apiKey: "private-key",
      })).toThrow("reviewed Chat Completions endpoint");
    }
  });

  it("maps authentication and rate-limit responses without reading bodies", async () => {
    const key = "key-that-must-not-leak";
    for (const [status, code, retryable] of [
      [401, "authentication", false],
      [429, "rate_limit", true],
    ] as const) {
      const provider = new RemoteOpenAICompatibleProvider({
        providerId: "deepseek-api",
        connectionId: `connection-${status}`,
        apiKey: key,
        fetch: async () => new Response(`provider body ${key}`, {
          status,
          headers: status === 429 ? { "retry-after": "2" } : {},
        }),
      });
      let thrown: unknown;
      try {
        for await (const event of provider.stream({
          model: "model",
          messages: [{ id: "user", role: "user", content: "work" }],
          tools: [],
          signal: new AbortController().signal,
        })) void event;
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ProviderError);
      expect(thrown).toMatchObject({
        code,
        retryable,
        ...(status === 429 ? { retryAfterMs: 2_000 } : {}),
      });
      expect(String(thrown)).not.toContain(key);
    }
  });
});
