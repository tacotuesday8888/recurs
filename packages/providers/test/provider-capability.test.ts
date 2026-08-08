import { describe, expect, it } from "vitest";

import { providerTransportCapability } from "../src/index.js";

describe("provider transport capability", () => {
  it("projects the implemented Copilot delegated-runtime facts without live-turn evidence", () => {
    expect(providerTransportCapability("github-copilot-subscription")).toEqual({
      providerId: "github-copilot-subscription",
      cataloged: true,
      adapterId: "github-copilot-sdk",
      authentication: true,
      modelDiscoveryReadinessProbe: true,
      streaming: true,
      tools: true,
      usage: true,
      errors: true,
    });
  });

  it("reports complete executable facts for the OpenAI Responses path", () => {
    expect(providerTransportCapability("openai-api")).toEqual({
      providerId: "openai-api",
      cataloged: true,
      adapterId: "openai-responses",
      authentication: true,
      modelDiscoveryReadinessProbe: true,
      streaming: true,
      tools: true,
      usage: true,
      errors: true,
    });
  });

  it("does not mistake an implemented wire transport for complete readiness", () => {
    expect(providerTransportCapability("zai-api")).toEqual({
      providerId: "zai-api",
      cataloged: true,
      adapterId: "openai-chat-completions",
      authentication: true,
      modelDiscoveryReadinessProbe: false,
      streaming: true,
      tools: true,
      usage: true,
      errors: true,
    });
  });

  it.each([
    "openai-codex-chatgpt",
    "zai-glm-coding-plan",
    "aws-bedrock",
  ])("does not invent provider-package transport support for %s", (providerId) => {
    expect(providerTransportCapability(providerId)).toEqual({
      providerId,
      cataloged: true,
      adapterId: null,
      authentication: false,
      modelDiscoveryReadinessProbe: false,
      streaming: false,
      tools: false,
      usage: false,
      errors: false,
    });
  });

  it("returns a closed unsupported projection for an unknown provider", () => {
    expect(providerTransportCapability("unknown-provider")).toEqual({
      providerId: "unknown-provider",
      cataloged: false,
      adapterId: null,
      authentication: false,
      modelDiscoveryReadinessProbe: false,
      streaming: false,
      tools: false,
      usage: false,
      errors: false,
    });
  });
});
