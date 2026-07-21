import { describe, expect, it } from "vitest";

import {
  hasEnvironmentProviderModelDiscovery,
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

function openAIModels(...ids: string[]): Response {
  return new Response(JSON.stringify({
    object: "list",
    data: ids.map((id, index) => ({
      id,
      object: "model",
      name: `Model ${index + 1}`,
      created: 1_767_225_600 + index,
      context_length: 128_000,
      top_provider: { max_completion_tokens: 32_000 },
    })),
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function geminiModels(
  ids: readonly string[],
  nextPageToken?: string,
): Response {
  return new Response(JSON.stringify({
    models: ids.map((id, index) => ({
      name: `models/${id}`,
      baseModelId: id,
      version: "001",
      displayName: `Gemini ${index + 1}`,
      inputTokenLimit: 1_000_000,
      outputTokenLimit: 65_536,
      supportedGenerationMethods: ["generateContent", "countTokens"],
    })),
    ...(nextPageToken === undefined ? {} : { nextPageToken }),
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("environment provider model discovery", () => {
  it("paginates credential-visible Gemini generation models without placing the key in the URL", async () => {
    const key = "gemini-model-key-canary";
    const requests: Array<{ url: string; headers: Headers; redirect: RequestRedirect }> = [];
    const models = await listEnvironmentProviderModels({
      providerId: "google-gemini-api",
      apiKey: key,
      fetch: async (input, init) => {
        requests.push({
          url: String(input),
          headers: new Headers(init?.headers),
          redirect: init?.redirect ?? "follow",
        });
        return requests.length === 1
          ? geminiModels(["gemini-pro", "gemini-flash"], "next-token")
          : geminiModels(["gemini-lite"]);
      },
    });

    expect(requests.map((request) => request.url)).toEqual([
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=100",
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=100&pageToken=next-token",
    ]);
    expect(requests.every((request) => request.redirect === "manual")).toBe(true);
    expect(requests.every((request) =>
      request.headers.get("x-goog-api-key") === key &&
      request.headers.get("x-goog-api-client")?.startsWith("recurs/") === true &&
      request.headers.get("accept") === "application/json" &&
      !request.url.includes(key)
    )).toBe(true);
    expect(models).toEqual([
      {
        id: "gemini-pro",
        displayName: "Gemini 1",
        createdAt: null,
        maxInputTokens: 1_000_000,
        maxOutputTokens: 65_536,
      },
      {
        id: "gemini-flash",
        displayName: "Gemini 2",
        createdAt: null,
        maxInputTokens: 1_000_000,
        maxOutputTokens: 65_536,
      },
      {
        id: "gemini-lite",
        displayName: "Gemini 1",
        createdAt: null,
        maxInputTokens: 1_000_000,
        maxOutputTokens: 65_536,
      },
    ]);
    expect(hasEnvironmentProviderModelDiscovery("google-gemini-api")).toBe(true);
  });

  it("filters non-generation Gemini models and rejects duplicate IDs or cursors", async () => {
    const key = "private-key";
    const embedding = JSON.parse(await geminiModels(["embedding"]).text());
    embedding.models[0].supportedGenerationMethods = ["embedContent"];
    await expect(listEnvironmentProviderModels({
      providerId: "google-gemini-api",
      apiKey: key,
      fetch: async () => new Response(JSON.stringify(embedding)),
    })).resolves.toEqual([]);

    await expect(listEnvironmentProviderModels({
      providerId: "google-gemini-api",
      apiKey: key,
      fetch: async () => geminiModels(["duplicate", "duplicate"]),
    })).rejects.toMatchObject({ code: "invalid_response", retryable: false });

    await expect(listEnvironmentProviderModels({
      providerId: "google-gemini-api",
      apiKey: key,
      fetch: async () => geminiModels(["repeat"], "same-token"),
    })).rejects.toMatchObject({ code: "invalid_response", retryable: false });
  });

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

  it.each([
    ["openai-api", "https://api.openai.com/v1/models"],
    ["openrouter-api", "https://openrouter.ai/api/v1/models"],
    ["deepseek-api", "https://api.deepseek.com/models"],
    ["minimax-api", "https://api.minimax.io/v1/models"],
  ] as const)(
    "discovers credential-visible models from the reviewed %s endpoint",
    async (providerId, expectedUrl) => {
      const key = `${providerId}-private-key`;
      let request: { url: string; headers: Headers; redirect: RequestRedirect } | undefined;
      const models = await listEnvironmentProviderModels({
        providerId,
        apiKey: key,
        fetch: async (input, init) => {
          request = {
            url: String(input),
            headers: new Headers(init?.headers),
            redirect: init?.redirect ?? "follow",
          };
          return openAIModels("provider/model-a", "provider/model-b");
        },
      });

      expect(request).toEqual({
        url: expectedUrl,
        headers: expect.any(Headers),
        redirect: "manual",
      });
      expect(request?.headers.get("authorization")).toBe(`Bearer ${key}`);
      expect(request?.headers.get("accept")).toBe("application/json");
      expect(request?.url).not.toContain(key);
      expect(models).toEqual([
        {
          id: "provider/model-a",
          displayName: "Model 1",
          createdAt: "2026-01-01T00:00:00.000Z",
          maxInputTokens: 128_000,
          maxOutputTokens: 32_000,
        },
        {
          id: "provider/model-b",
          displayName: "Model 2",
          createdAt: "2026-01-01T00:00:01.000Z",
          maxInputTokens: 128_000,
          maxOutputTokens: 32_000,
        },
      ]);
      expect(hasEnvironmentProviderModelDiscovery(providerId)).toBe(true);
    },
  );

  it("accepts minimal OpenAI-style entries and normalizes absent metadata", async () => {
    const models = await listEnvironmentProviderModels({
      providerId: "deepseek-api",
      apiKey: "private-key",
      fetch: async () => new Response(JSON.stringify({
        object: "list",
        data: [{ id: "deepseek-chat", object: "model", owned_by: "deepseek" }],
      })),
    });

    expect(models).toEqual([{
      id: "deepseek-chat",
      displayName: "deepseek-chat",
      createdAt: null,
      maxInputTokens: null,
      maxOutputTokens: null,
    }]);
  });

  it("rejects unreviewed profiles, repeated cursors, and duplicate model IDs", async () => {
    await expect(listEnvironmentProviderModels({
      providerId: "kilo-gateway",
      apiKey: "private-key",
      fetch: async () => page([], false),
    })).rejects.toThrow("reviewed model discovery");
    expect(hasEnvironmentProviderModelDiscovery("kilo-gateway")).toBe(false);

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

  it("rejects malformed or duplicate OpenAI-style model catalogs", async () => {
    for (const data of [
      [{ id: "unsafe id", object: "model" }],
      [{ id: "safe", object: "unexpected" }],
      [{ id: "safe", name: "Model\u001b[31m" }],
      [{ id: "safe", context_length: -1 }],
      [{ id: "safe" }, { id: "safe" }],
    ]) {
      await expect(listEnvironmentProviderModels({
        providerId: "openrouter-api",
        apiKey: "private-key",
        fetch: async () => new Response(JSON.stringify({ object: "list", data })),
      })).rejects.toMatchObject({ code: "invalid_response", retryable: false });
    }
  });

  it("bounds OpenAI-style catalog count and bytes before returning metadata", async () => {
    await expect(listEnvironmentProviderModels({
      providerId: "openrouter-api",
      apiKey: "private-key",
      fetch: async () => new Response(JSON.stringify({
        object: "list",
        data: Array.from({ length: 1_001 }, (_, index) => ({
          id: `model-${index}`,
        })),
      })),
    })).rejects.toMatchObject({ code: "invalid_response", retryable: false });

    await expect(listEnvironmentProviderModels({
      providerId: "openrouter-api",
      apiKey: "private-key",
      fetch: async () => new Response("{}", {
        headers: { "content-length": String(4 * 1_024 * 1_024 + 1) },
      }),
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
