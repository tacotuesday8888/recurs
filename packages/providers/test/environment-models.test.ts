import { describe, expect, it } from "vitest";

import {
  listEnvironmentProviderModels,
  ProviderError,
} from "../src/index.js";

function page(
  ids: readonly string[],
  hasMore: boolean,
): Response {
  return new Response(JSON.stringify({
    data: ids.map((id) => ({
      id,
      type: "model",
      display_name: id.replaceAll("-", " "),
      created_at: "2026-01-01T00:00:00Z",
      max_input_tokens: 200_000,
      max_tokens: 64_000,
      capabilities: { effort: { supported: true } },
    })),
    has_more: hasMore,
    first_id: ids[0] ?? null,
    last_id: ids.at(-1) ?? null,
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("environment provider model discovery", () => {
  it("paginates the fixed Anthropic origin with required headers and preserves recency order", async () => {
    const key = "anthropic-model-key-canary";
    const requests: Array<{ url: string; headers: Headers; redirect: RequestRedirect }> = [];
    const models = await listEnvironmentProviderModels({
      providerId: "anthropic-api",
      apiKey: key,
      fetch: async (input, init) => {
        requests.push({
          url: String(input),
          headers: new Headers(init?.headers),
          redirect: init?.redirect ?? "follow",
        });
        return requests.length === 1
          ? page(["claude-opus-current", "claude-sonnet-current"], true)
          : page(["claude-haiku-current"], false);
      },
    });

    expect(requests.map((request) => request.url)).toEqual([
      "https://api.anthropic.com/v1/models?limit=100",
      "https://api.anthropic.com/v1/models?limit=100&after_id=claude-sonnet-current",
    ]);
    expect(requests.every((request) => request.redirect === "manual")).toBe(true);
    expect(requests.every((request) =>
      request.headers.get("x-api-key") === key &&
      request.headers.get("anthropic-version") === "2023-06-01" &&
      request.headers.get("accept") === "application/json"
    )).toBe(true);
    expect(requests.every((request) => !request.url.includes(key))).toBe(true);
    expect(models.map((model) => model.id)).toEqual([
      "claude-opus-current",
      "claude-sonnet-current",
      "claude-haiku-current",
    ]);
    expect(models[0]).toMatchObject({
      displayName: "claude opus current",
      maxInputTokens: 200_000,
      maxOutputTokens: 64_000,
    });
  });

  it("rejects unreviewed profiles, repeated cursors, and duplicate model IDs", async () => {
    await expect(listEnvironmentProviderModels({
      providerId: "openrouter-api",
      apiKey: "private-key",
      fetch: async () => page([], false),
    })).rejects.toThrow("reviewed model discovery");

    await expect(listEnvironmentProviderModels({
      providerId: "anthropic-api",
      apiKey: "private-key",
      fetch: async () => page(["claude-repeat"], true),
    })).rejects.toMatchObject({ code: "invalid_response", retryable: false });

    let calls = 0;
    await expect(listEnvironmentProviderModels({
      providerId: "anthropic-api",
      apiKey: "private-key",
      fetch: async () => {
        calls += 1;
        return calls === 1
          ? page(["claude-a"], true)
          : page(["claude-a"], false);
      },
    })).rejects.toMatchObject({ code: "invalid_response", retryable: false });
  });

  it("rejects terminal-control metadata and honors pre-request cancellation", async () => {
    await expect(listEnvironmentProviderModels({
      providerId: "anthropic-api",
      apiKey: "private-key",
      fetch: async () => new Response(JSON.stringify({
        data: [{
          id: "claude-safe-id",
          type: "model",
          display_name: "Claude\u001b[31m",
          created_at: "2026-01-01T00:00:00Z",
          max_input_tokens: 200_000,
          max_tokens: 64_000,
        }],
        has_more: false,
        first_id: "claude-safe-id",
        last_id: "claude-safe-id",
      })),
    })).rejects.toMatchObject({ code: "invalid_response", retryable: false });

    const controller = new AbortController();
    controller.abort();
    let fetched = false;
    await expect(listEnvironmentProviderModels({
      providerId: "anthropic-api",
      apiKey: "private-key",
      signal: controller.signal,
      fetch: async () => {
        fetched = true;
        return page([], false);
      },
    })).rejects.toMatchObject({ code: "cancelled", retryable: false });
    expect(fetched).toBe(false);
  });

  it("maps authentication and redirects without reading credential-bearing bodies", async () => {
    const key = "credential-that-must-not-leak";
    for (const [status, code, retryable] of [
      [401, "authentication", false],
      [429, "rate_limit", true],
      [302, "transport", false],
    ] as const) {
      let thrown: unknown;
      try {
        await listEnvironmentProviderModels({
          providerId: "anthropic-api",
          apiKey: key,
          fetch: async () => new Response(`provider body ${key}`, { status }),
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ProviderError);
      expect(thrown).toMatchObject({ code, retryable });
      expect(String(thrown)).not.toContain(key);
    }
  });

  it("detects credential echo split across JSON response chunks", async () => {
    const key = "split-model-credential-canary";
    const encoder = new TextEncoder();
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('{"data":[],"has_more":false,"first_id":null,"last_id":null,"note":"split-model-'));
        controller.enqueue(encoder.encode('credential-canary"}'));
        controller.close();
      },
    }));
    await expect(listEnvironmentProviderModels({
      providerId: "anthropic-api",
      apiKey: key,
      fetch: async () => response,
    })).rejects.toMatchObject({ code: "invalid_response", retryable: false });
  });

  it("maps a body-read cancellation without exposing response details", async () => {
    const controller = new AbortController();
    let reading: (() => void) | undefined;
    const readingStarted = new Promise<void>((resolve) => {
      reading = resolve;
    });
    const response = new Response(new ReadableStream({
      start(stream) {
        controller.signal.addEventListener("abort", () => {
          stream.error(new DOMException("private provider detail", "AbortError"));
        }, { once: true });
      },
      pull() {
        reading?.();
      },
    }));
    const result = listEnvironmentProviderModels({
      providerId: "anthropic-api",
      apiKey: "private-key",
      signal: controller.signal,
      fetch: async () => response,
    });
    await readingStarted;
    controller.abort();
    await expect(result).rejects.toMatchObject({
      code: "cancelled",
      retryable: false,
    });
    await expect(result).rejects.not.toThrow("private provider detail");
  });
});
