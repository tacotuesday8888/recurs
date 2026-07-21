import { describe, expect, it } from "vitest";

import {
  EnvironmentProviderError,
  createEnvironmentProviderConfiguration,
  BUNDLED_PROVIDER_MANIFESTS,
  environmentByokProviderIds,
  environmentCredentialFingerprint,
  isEnvironmentByokManifest,
  resolveEnvironmentProvider,
} from "../src/index.js";

describe("environment provider resolution", () => {
  it("does nothing when no explicit BYOK selection is present", async () => {
    await expect(resolveEnvironmentProvider({ PATH: "/usr/bin" }))
      .resolves.toBeNull();
  });

  it("creates a non-secret, fingerprinted provider configuration", async () => {
    const key = "private-environment-key";
    const resolved = await resolveEnvironmentProvider({
      RECURS_PROVIDER: "openrouter-api",
      RECURS_MODEL: "provider/model",
      RECURS_API_KEY: key,
    }, async () => new Response(null, { status: 500 }));

    expect(resolved).toMatchObject({
      providerId: "openrouter-api",
      modelId: "provider/model",
      connectionId: "environment:openrouter-api",
      credentialFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      provider: {
        id: "openrouter-api",
        adapterId: "openai-chat-completions",
      },
    });
    expect(JSON.stringify(resolved)).not.toContain(key);
  });

  it("selects the Anthropic Messages adapter from reviewed manifest protocol", async () => {
    const key = "anthropic-environment-key";
    const resolved = await resolveEnvironmentProvider({
      RECURS_PROVIDER: "anthropic-api",
      RECURS_MODEL: "claude-test",
      RECURS_API_KEY: key,
    });

    expect(resolved).toMatchObject({
      providerId: "anthropic-api",
      modelId: "claude-test",
      connectionId: "environment:anthropic-api",
      provider: {
        id: "anthropic-api",
        adapterId: "anthropic-messages",
      },
    });
    expect(JSON.stringify(resolved)).not.toContain(key);
  });

  it("fails closed for partial, invalid, or unsupported selection", async () => {
    for (const environment of [
      { RECURS_PROVIDER: "openrouter-api" },
      {
        RECURS_PROVIDER: "openrouter-api",
        RECURS_MODEL: "model with spaces",
        RECURS_API_KEY: "key",
      },
      {
        RECURS_PROVIDER: "aws-bedrock",
        RECURS_MODEL: "model",
        RECURS_API_KEY: "key",
      },
    ]) {
      await expect(resolveEnvironmentProvider(environment)).rejects.toThrow(
        EnvironmentProviderError,
      );
    }
  });

  it("exposes only reviewed fixed-origin BYOK profiles, including one coding plan", async () => {
    expect(environmentByokProviderIds()).toEqual(expect.arrayContaining([
      "openai-api",
      "anthropic-api",
      "openrouter-api",
      "opencode-go",
      "kilo-gateway",
      "alibaba-model-studio-api",
      "kimi-platform-api",
      "kimi-code",
      "minimax-api",
      "zai-api",
      "deepseek-api",
      "google-gemini-api",
    ]));
    expect(environmentByokProviderIds()).not.toContain("zai-glm-coding-plan");
    expect(environmentByokProviderIds()).not.toContain("alibaba-coding-plan");

    const openai = await createEnvironmentProviderConfiguration({
      providerId: "openai-api",
      modelId: "gpt-test",
      connectionId: "saved-openai",
      apiKey: "openai-private-value",
    });
    expect(openai).toMatchObject({
      providerId: "openai-api",
      connectionId: "saved-openai",
      provider: { adapterId: "openai-responses" },
    });

    const configured = await createEnvironmentProviderConfiguration({
      providerId: "kimi-code",
      modelId: "kimi-for-coding",
      connectionId: "saved-kimi",
      apiKey: "coding-plan-private-value",
    });
    expect(configured).toMatchObject({
      providerId: "kimi-code",
      connectionId: "saved-kimi",
      provider: { adapterId: "openai-chat-completions" },
    });
    expect(await environmentCredentialFingerprint(
      "kimi-code",
      "coding-plan-private-value",
    )).toBe(configured.credentialFingerprint);

    const gemini = await createEnvironmentProviderConfiguration({
      providerId: "google-gemini-api",
      modelId: "gemini-test",
      connectionId: "saved-gemini",
      apiKey: "gemini-private-value",
    });
    expect(gemini).toMatchObject({
      providerId: "google-gemini-api",
      connectionId: "saved-gemini",
      provider: { adapterId: "gemini-generate-content" },
    });
  });

  it("does not admit an Anthropic-shaped manifest at an unimplemented origin", () => {
    const anthropic = BUNDLED_PROVIDER_MANIFESTS.find(
      (manifest) => manifest.id === "anthropic-api",
    );
    if (anthropic === undefined) throw new Error("missing Anthropic manifest");
    expect(isEnvironmentByokManifest({
      ...structuredClone(anthropic),
      id: "unreviewed-anthropic",
      endpoints: [{ kind: "origin", value: "https://attacker.invalid/v1" }],
    })).toBe(false);
  });
});
