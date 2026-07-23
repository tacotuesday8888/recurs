import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ConnectionLifecycleService,
  FileConnectionRegistry,
  OnboardingCatalog,
  connectionRegistryPath,
  setupEnvironmentConnection,
  verifyEnvironmentConnection,
} from "../src/index.js";

const roots: string[] = [];
const AT = "2026-07-21T12:00:00.000Z";

function anthropicModels(...ids: string[]): Response {
  return new Response(JSON.stringify({
    data: ids.map((id) => ({
      id,
      type: "model",
      display_name: id,
      created_at: "2026-01-01T00:00:00Z",
      max_input_tokens: 200_000,
      max_tokens: 64_000,
    })),
    has_more: false,
    first_id: ids[0] ?? null,
    last_id: ids.at(-1) ?? null,
  }));
}

function openAIModels(...ids: string[]): Response {
  return new Response(JSON.stringify({
    object: "list",
    data: ids.map((id) => ({
      id,
      object: "model",
      context_length: 128_000,
      top_provider: { max_completion_tokens: 32_000 },
    })),
  }));
}

function openAIModelsWithoutLimits(...ids: string[]): Response {
  return new Response(JSON.stringify({
    object: "list",
    data: ids.map((id) => ({ id, object: "model" })),
  }));
}

function xaiModels(...ids: string[]): Response {
  return new Response(JSON.stringify({
    models: ids.map((id) => ({ id, object: "model", owned_by: "xai" })),
  }));
}

function geminiModels(...ids: string[]): Response {
  return new Response(JSON.stringify({
    models: ids.map((id) => ({
      name: `models/${id}`,
      displayName: id,
      inputTokenLimit: 1_000_000,
      outputTokenLimit: 65_536,
      supportedGenerationMethods: ["generateContent"],
    })),
  }));
}

async function root(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "recurs-byok-"));
  roots.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("saved environment BYOK connections", () => {
  it("advertises reviewed Responses, Chat, Messages, and Gemini paths as BYOK without widening blocked providers", () => {
    const entries = new OnboardingCatalog(undefined, {
      now: () => new Date(AT),
    }).list({ includeBlocked: true });

    expect(entries.find((entry) => entry.id === "openrouter-api"))
      .toMatchObject({
        status: "runnable_byok",
        connectionOwner: "process_environment",
      });
    expect(entries.find((entry) => entry.id === "xai-api"))
      .toMatchObject({
        status: "runnable_byok",
        protocol: "openai_chat",
        connectionOwner: "process_environment",
      });
    expect(entries.find((entry) => entry.id === "kimi-code"))
      .toMatchObject({ status: "runnable_byok" });
    expect(entries.find((entry) => entry.id === "zai-glm-coding-plan"))
      .toMatchObject({ status: "blocked" });
    expect(entries.find((entry) => entry.id === "anthropic-api"))
      .toMatchObject({
        status: "runnable_byok",
        protocol: "anthropic_messages",
        connectionOwner: "process_environment",
      });
    expect(entries.find((entry) => entry.id === "openai-api"))
      .toMatchObject({
        status: "runnable_byok",
        protocol: "openai_responses",
        connectionOwner: "process_environment",
      });
    expect(entries.find((entry) => entry.id === "google-gemini-api"))
      .toMatchObject({
        status: "runnable_byok",
        protocol: "gemini_generate_content",
        connectionOwner: "process_environment",
      });
  });

  it("persists only a Responses binding after verified OpenAI model discovery", async () => {
    const directory = await root();
    const key = "openai-private-value";
    const configured = await setupEnvironmentConnection(directory, {
      providerId: "openai-api",
      modelId: "gpt-5.6-terra",
      credentialEnvironmentVariable: "OPENAI_API_KEY",
      billingSelection: "strict_primary_only",
      reasoningEffort: "max",
      environment: { OPENAI_API_KEY: key },
      now: AT,
    }, {
      fetch: async () => openAIModels("unrelated-model", "gpt-5.6-terra"),
    });

    const storedText = await readFile(connectionRegistryPath(directory), "utf8");
    expect(storedText).not.toContain(key);
    expect(configured.reasoningEffort).toBe("max");
    expect((await new FileConnectionRegistry(directory).read()).connections)
      .toEqual([
        expect.objectContaining({
          id: configured.id,
          kind: "environment_model_provider",
          providerId: "openai-api",
          adapterId: "openai-responses",
          modelId: "gpt-5.6-terra",
          reasoningEffort: "max",
        }),
      ]);
  });

  it("does not persist BYOK metadata when setup is cancelled after discovery", async () => {
    const directory = await root();
    const controller = new AbortController();

    await expect(setupEnvironmentConnection(directory, {
      providerId: "openai-api",
      modelId: "gpt-5.6-terra",
      credentialEnvironmentVariable: "OPENAI_API_KEY",
      billingSelection: "strict_primary_only",
      environment: { OPENAI_API_KEY: "openai-private-value" },
      now: AT,
    }, {
      signal: controller.signal,
      fetch: async () => {
        controller.abort();
        return openAIModels("gpt-5.6-terra");
      },
    })).rejects.toMatchObject({
      name: "EnvironmentConnectionError",
      code: "cancelled",
    });

    expect((await new FileConnectionRegistry(directory).read()).connections)
      .toEqual([]);
  });

  it("rejects a tampered saved reasoning effort outside the reviewed model profile", async () => {
    const directory = await root();
    const filename = connectionRegistryPath(directory);
    await setupEnvironmentConnection(directory, {
      providerId: "openai-api",
      modelId: "gpt-5.6-terra",
      credentialEnvironmentVariable: "OPENAI_API_KEY",
      billingSelection: "strict_primary_only",
      reasoningEffort: "max",
      environment: { OPENAI_API_KEY: "openai-private-value" },
      now: AT,
    }, {
      fetch: async () => openAIModels("gpt-5.6-terra"),
    });
    const stored = JSON.parse(await readFile(filename, "utf8")) as {
      connections: Array<Record<string, unknown>>;
    };
    stored.connections[0]!.reasoningEffort = "minimal";
    await writeFile(filename, `${JSON.stringify(stored)}\n`, "utf8");

    await expect(new FileConnectionRegistry(directory).read()).rejects
      .toMatchObject({
        code: "registry_invalid",
        message: "Connection registry is invalid",
      });
  });

  it("does not invent model limits when the authenticated catalog omits them", async () => {
    const directory = await root();
    const configured = await setupEnvironmentConnection(directory, {
      providerId: "openai-api",
      modelId: "gpt-5.6-terra",
      credentialEnvironmentVariable: "OPENAI_API_KEY",
      billingSelection: "strict_primary_only",
      environment: { OPENAI_API_KEY: "openai-private-value" },
      now: AT,
    }, {
      fetch: async () => openAIModelsWithoutLimits("gpt-5.6-terra"),
    });

    expect(configured.modelLimits).toBeUndefined();
    const stored = (await new FileConnectionRegistry(directory).read())
      .connections[0];
    expect(stored).not.toHaveProperty("modelLimits");
  });

  it("stores only an environment reference and fingerprint, then runs through account lifecycle", async () => {
    const directory = await root();
    const key = "byok-private-value";
    const configured = await setupEnvironmentConnection(directory, {
      providerId: "openrouter-api",
      modelId: "anthropic/claude-sonnet",
      credentialEnvironmentVariable: "OPENROUTER_API_KEY",
      billingSelection: "strict_primary_only",
      environment: { OPENROUTER_API_KEY: key },
      now: AT,
    }, {
      fetch: async () => openAIModels("anthropic/claude-sonnet"),
    });

    expect(configured).toMatchObject({
      providerId: "openrouter-api",
      modelId: "anthropic/claude-sonnet",
      credentialEnvironmentVariable: "OPENROUTER_API_KEY",
      primary: true,
      modelLimits: {
        source: "authenticated_provider_catalog",
        maxInputTokens: 128_000,
        maxOutputTokens: 32_000,
        verifiedAt: AT,
      },
    });
    const storedText = await readFile(connectionRegistryPath(directory), "utf8");
    expect(storedText).not.toContain(key);
    expect(storedText).toContain("OPENROUTER_API_KEY");
    const registry = new FileConnectionRegistry(directory);
    const stored = (await registry.read()).connections[0];
    expect(stored).toMatchObject({
      kind: "environment_model_provider",
      credentialIdentityFingerprint: expect.stringMatching(
        /^sha256:[a-f0-9]{64}$/u,
      ),
    });
    if (stored?.kind !== "environment_model_provider") {
      throw new Error("expected environment connection");
    }
    await expect(verifyEnvironmentConnection(stored, {
      OPENROUTER_API_KEY: key,
    })).resolves.toEqual({ status: "verified" });
    await expect(verifyEnvironmentConnection(stored, {})).resolves.toEqual({
      status: "failed",
      reason: "authentication_required",
    });
    await expect(verifyEnvironmentConnection(stored, {
      OPENROUTER_API_KEY: "different-private-value",
    })).resolves.toEqual({
      status: "failed",
      reason: "account_mismatch",
    });

    const service = new ConnectionLifecycleService(registry);
    await expect(service.list()).resolves.toEqual([
      expect.objectContaining({
        id: configured.id,
        kind: "environment_model_provider",
        account: "environment credential (value not stored)",
        primary: true,
      }),
    ]);
    await expect(service.disconnect(configured.id)).resolves.toMatchObject({
      connectionId: configured.id,
      primaryCleared: true,
    });
  });

  it("persists a verified xAI model binding without persisting its credential", async () => {
    const directory = await root();
    const key = "xai-private-value";
    const configured = await setupEnvironmentConnection(directory, {
      providerId: "xai-api",
      modelId: "grok-code-fast",
      credentialEnvironmentVariable: "XAI_API_KEY",
      billingSelection: "strict_primary_only",
      environment: { XAI_API_KEY: key },
      now: AT,
    }, {
      fetch: async () => xaiModels("grok-code-fast"),
    });

    expect(configured).toMatchObject({
      providerId: "xai-api",
      modelId: "grok-code-fast",
      credentialEnvironmentVariable: "XAI_API_KEY",
      primary: true,
    });
    expect(configured.modelLimits).toBeUndefined();
    const storedText = await readFile(connectionRegistryPath(directory), "utf8");
    expect(storedText).not.toContain(key);
    expect(storedText).toContain("XAI_API_KEY");
    expect((await new FileConnectionRegistry(directory).read()).connections)
      .toEqual([
        expect.objectContaining({
          kind: "environment_model_provider",
          providerId: "xai-api",
          adapterId: "openai-chat-completions",
          modelId: "grok-code-fast",
        }),
      ]);
  });

  it("persists an Anthropic Messages adapter without persisting its credential", async () => {
    const directory = await root();
    const key = "anthropic-private-value";
    const configured = await setupEnvironmentConnection(directory, {
      providerId: "anthropic-api",
      modelId: "claude-test",
      credentialEnvironmentVariable: "ANTHROPIC_API_KEY",
      billingSelection: "strict_primary_only",
      environment: { ANTHROPIC_API_KEY: key },
      now: AT,
    }, {
      fetch: async () => anthropicModels("claude-test"),
    });

    const storedText = await readFile(connectionRegistryPath(directory), "utf8");
    expect(storedText).not.toContain(key);
    expect(storedText).toContain("ANTHROPIC_API_KEY");
    expect((await new FileConnectionRegistry(directory).read()).connections)
      .toEqual([
        expect.objectContaining({
          id: configured.id,
          kind: "environment_model_provider",
          providerId: "anthropic-api",
          adapterId: "anthropic-messages",
          modelId: "claude-test",
          modelLimits: {
            source: "authenticated_provider_catalog",
            maxInputTokens: 200_000,
            maxOutputTokens: 64_000,
            verifiedAt: AT,
          },
        }),
      ]);
  });

  it("persists a verified Gemini adapter and model limits without persisting its credential", async () => {
    const directory = await root();
    const key = "gemini-private-value";
    const configured = await setupEnvironmentConnection(directory, {
      providerId: "google-gemini-api",
      modelId: "gemini-test",
      credentialEnvironmentVariable: "GEMINI_API_KEY",
      billingSelection: "strict_primary_only",
      environment: { GEMINI_API_KEY: key },
      now: AT,
    }, {
      fetch: async () => geminiModels("gemini-test"),
    });

    const storedText = await readFile(connectionRegistryPath(directory), "utf8");
    expect(storedText).not.toContain(key);
    expect(storedText).toContain("GEMINI_API_KEY");
    expect((await new FileConnectionRegistry(directory).read()).connections)
      .toEqual([
        expect.objectContaining({
          id: configured.id,
          kind: "environment_model_provider",
          providerId: "google-gemini-api",
          adapterId: "gemini-generate-content",
          modelId: "gemini-test",
          modelLimits: {
            source: "authenticated_provider_catalog",
            maxInputTokens: 1_000_000,
            maxOutputTokens: 65_536,
            verifiedAt: AT,
          },
        }),
      ]);
  });

  it("verifies Anthropic credential visibility before saving a model", async () => {
    const directory = await root();
    const input = {
      providerId: "anthropic-api",
      modelId: "claude-selected",
      credentialEnvironmentVariable: "ANTHROPIC_API_KEY",
      billingSelection: "strict_primary_only" as const,
      environment: { ANTHROPIC_API_KEY: "anthropic-private-value" },
      now: AT,
    };

    await expect(setupEnvironmentConnection(directory, input, {
      fetch: async () => anthropicModels("claude-other"),
    })).rejects.toMatchObject({ code: "model_unavailable" });
    await expect(setupEnvironmentConnection(directory, input, {
      fetch: async () => new Response("rejected", { status: 401 }),
    })).rejects.toMatchObject({ code: "credential_rejected" });
    await expect(new FileConnectionRegistry(directory).read()).resolves
      .toMatchObject({ connections: [], primaryConnectionId: null });
  });

  it("verifies reviewed OpenAI-style credential visibility before saving a model", async () => {
    const directory = await root();
    const input = {
      providerId: "openrouter-api",
      modelId: "anthropic/claude-selected",
      credentialEnvironmentVariable: "OPENROUTER_API_KEY",
      billingSelection: "strict_primary_only" as const,
      environment: { OPENROUTER_API_KEY: "openrouter-private-value" },
      now: AT,
    };

    await expect(setupEnvironmentConnection(directory, input, {
      fetch: async () => openAIModels("anthropic/claude-other"),
    })).rejects.toMatchObject({ code: "model_unavailable" });
    await expect(setupEnvironmentConnection(directory, input, {
      fetch: async () => new Response("rejected", { status: 401 }),
    })).rejects.toMatchObject({ code: "credential_rejected" });
    await expect(new FileConnectionRegistry(directory).read()).resolves
      .toMatchObject({ connections: [], primaryConnectionId: null });
  });

  it("updates an explicit provider/env binding without redirecting its stable identity", async () => {
    const directory = await root();
    const first = await setupEnvironmentConnection(directory, {
      providerId: "deepseek-api",
      modelId: "deepseek-chat",
      credentialEnvironmentVariable: "DEEPSEEK_API_KEY",
      billingSelection: "strict_primary_only",
      environment: { DEEPSEEK_API_KEY: "first-private-value" },
      now: AT,
    }, {
      fetch: async () => openAIModels("deepseek-chat"),
    });
    const second = await setupEnvironmentConnection(directory, {
      providerId: "deepseek-api",
      modelId: "deepseek-reasoner",
      credentialEnvironmentVariable: "DEEPSEEK_API_KEY",
      billingSelection: "strict_primary_only",
      environment: { DEEPSEEK_API_KEY: "second-private-value" },
      now: "2026-07-21T12:01:00.000Z",
    }, {
      fetch: async () => openAIModels("deepseek-reasoner"),
    });

    expect(second.id).toBe(first.id);
    expect(second.primary).toBe(true);
    expect((await new FileConnectionRegistry(directory).read()).connections)
      .toHaveLength(1);
  });

  it("fails closed for absent secrets, unsafe references, blocked providers, and billing mismatches", async () => {
    const directory = await root();
    const base = {
      modelId: "model",
      credentialEnvironmentVariable: "PROVIDER_API_KEY",
      billingSelection: "strict_primary_only" as const,
      environment: { PROVIDER_API_KEY: "private-value" },
      now: AT,
    };
    await expect(setupEnvironmentConnection(directory, {
      ...base,
      providerId: "openrouter-api",
      environment: {},
    })).rejects.toMatchObject({ code: "credential_unavailable" });
    await expect(setupEnvironmentConnection(directory, {
      ...base,
      providerId: "openrouter-api",
      credentialEnvironmentVariable: "PROVIDER_CREDENTIAL",
    })).rejects.toMatchObject({ code: "configuration_invalid" });
    await expect(setupEnvironmentConnection(directory, {
      ...base,
      providerId: "zai-glm-coding-plan",
    })).rejects.toMatchObject({ code: "provider_unsupported" });
    await expect(setupEnvironmentConnection(directory, {
      ...base,
      providerId: "openrouter-api",
      reasoningEffort: "high",
    })).rejects.toMatchObject({ code: "configuration_invalid" });
    await expect(setupEnvironmentConnection(directory, {
      ...base,
      providerId: "openai-api",
      modelId: "gpt-5.6-terra",
      reasoningEffort: "minimal",
    })).rejects.toMatchObject({ code: "configuration_invalid" });
    await expect(setupEnvironmentConnection(directory, {
      ...base,
      providerId: "openrouter-api",
      billingSelection: "allow_declared_additional",
    }, {
      fetch: async () => openAIModels("model"),
    })).rejects.toMatchObject({ code: "billing_policy_blocked" });
  });
});
