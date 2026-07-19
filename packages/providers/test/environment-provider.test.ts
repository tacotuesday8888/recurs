import { describe, expect, it } from "vitest";

import {
  EnvironmentProviderError,
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

  it("fails closed for partial, invalid, or unsupported selection", async () => {
    for (const environment of [
      { RECURS_PROVIDER: "openrouter-api" },
      {
        RECURS_PROVIDER: "openrouter-api",
        RECURS_MODEL: "model with spaces",
        RECURS_API_KEY: "key",
      },
      {
        RECURS_PROVIDER: "openai-api",
        RECURS_MODEL: "model",
        RECURS_API_KEY: "key",
      },
    ]) {
      await expect(resolveEnvironmentProvider(environment)).rejects.toThrow(
        EnvironmentProviderError,
      );
    }
  });
});
