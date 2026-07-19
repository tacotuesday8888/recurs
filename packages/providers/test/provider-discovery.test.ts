import { describe, expect, it, vi } from "vitest";

import {
  MODELS_DEV_CATALOG_URL,
  ProviderDiscoveryError,
  detectLocalRuntimes,
  fetchProviderCatalog,
  searchProviderCatalog,
} from "../src/index.js";

describe("provider discovery", () => {
  it("normalizes and deterministically searches the public catalog", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      zed: {
        name: "Zed Gateway",
        npm: "@ai-sdk/openai-compatible",
        api: "https://api.zed.example/v1/",
        models: { "zed-coder": {}, "zed-fast": {} },
      },
      anthropic: {
        name: "Anthropic",
        npm: "@ai-sdk/anthropic",
        models: { "claude-test": {} },
      },
      "bad id": { name: "ignored", models: {} },
    }), { headers: { "content-type": "application/json" } }));

    const snapshot = await fetchProviderCatalog({ fetch: fetcher });

    expect(fetcher).toHaveBeenCalledWith(MODELS_DEV_CATALOG_URL, expect.objectContaining({
      method: "GET",
      redirect: "error",
    }));
    expect(snapshot.providers).toEqual([
      { id: "anthropic", name: "Anthropic", wire: "anthropic", modelCount: 1 },
      {
        id: "zed",
        name: "Zed Gateway",
        api: "https://api.zed.example/v1",
        wire: "openai-compatible",
        modelCount: 2,
      },
    ]);
    expect(searchProviderCatalog(snapshot.providers, "zed compatible"))
      .toEqual([snapshot.providers[1]]);
    expect(Object.isFrozen(snapshot.providers)).toBe(true);
  });

  it("bounds remote bytes and rejects invalid catalog responses", async () => {
    await expect(fetchProviderCatalog({
      fetch: async () => new Response("{}", {
        headers: { "content-length": "100" },
      }),
      maxBytes: 10,
    })).rejects.toEqual(
      new ProviderDiscoveryError("The provider catalog response is too large"),
    );
    await expect(fetchProviderCatalog({
      fetch: async () => new Response("not-json"),
    })).rejects.toEqual(
      new ProviderDiscoveryError("The provider catalog response is not valid JSON"),
    );
  });

  it("probes only the two fixed loopback runtimes without following redirects", async () => {
    const calls: Array<{ url: string; redirect?: RequestRedirect }> = [];
    const results = await detectLocalRuntimes({
      fetch: async (input, init) => {
        calls.push({ url: String(input), redirect: init?.redirect });
        return new Response(null, { status: String(input).includes("11434") ? 200 : 503 });
      },
    });

    expect(calls).toEqual([
      { url: "http://127.0.0.1:11434/api/tags", redirect: "error" },
      { url: "http://127.0.0.1:1234/v1/models", redirect: "error" },
    ]);
    expect(results).toEqual([
      {
        id: "ollama",
        name: "Ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
        detected: true,
      },
      {
        id: "lm-studio",
        name: "LM Studio",
        baseUrl: "http://127.0.0.1:1234/v1",
        detected: false,
      },
    ]);
  });
});
