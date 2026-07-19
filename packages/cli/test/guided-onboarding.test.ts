import { describe, expect, it } from "vitest";

import {
  type AccountSummary,
  type ProviderSummary,
} from "../src/index.js";
import {
  GUIDED_PERMISSION_CHOICES,
  catalogProviderId,
  credentialEnvironmentSuggestion,
  filterCatalogModels,
  guidedConnectionChoices,
  guidedPermissionMode,
} from "../src/guided-onboarding.js";

const providers: readonly ProviderSummary[] = [
  {
    id: "openai-codex-chatgpt",
    displayName: "Codex with ChatGPT",
    status: "runnable",
    supportStatus: "conditional",
    adapterKind: "agent_runtime",
    accessKind: "subscription",
    protocol: "acp",
    connectionOwner: "vendor_runtime",
    billing: {
      primarySource: "included_subscription",
      possibleAdditionalSources: ["prepaid_credits"],
      providerFallback: "automatic",
    },
    restrictions: [],
  },
  {
    id: "openrouter-api",
    displayName: "OpenRouter API",
    status: "runnable_byok",
    supportStatus: "supported",
    adapterKind: "model_provider",
    accessKind: "api",
    protocol: "openai_chat",
    connectionOwner: "process_environment",
    billing: {
      primarySource: "prepaid_credits",
      possibleAdditionalSources: [],
      providerFallback: "none",
    },
    restrictions: [],
  },
  {
    id: "openai-api",
    displayName: "OpenAI API",
    status: "requires_native_broker",
    supportStatus: "supported",
    adapterKind: "model_provider",
    accessKind: "api",
    protocol: "openai_responses",
    connectionOwner: "recurs_broker",
    billing: {
      primarySource: "metered_api",
      possibleAdditionalSources: [],
      providerFallback: "none",
    },
    restrictions: [],
  },
];

const account: AccountSummary = {
  id: "saved-1",
  label: "Saved model",
  providerId: "openrouter-api",
  adapterId: "openai-chat-completions",
  kind: "environment_model_provider",
  modelId: "anthropic/claude-test",
  primary: true,
  account: "environment credential (value not stored)",
  execution: "Act + Plan",
  billingSources: ["prepaid_credits"],
};

describe("guided onboarding policy", () => {
  it("composes saved, detected, subscription, BYOK, and available native paths", () => {
    const choices = guidedConnectionChoices({
      accounts: [account],
      localRuntimes: [{
        id: "ollama",
        name: "Ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
        detected: true,
      }],
      providers,
      nativeProviders: new Set(["openai"]),
    });

    expect(choices.map((choice) => choice.id)).toEqual([
      "account:saved-1",
      "local:ollama",
      "codex",
      "byok:openrouter-api",
      "native:openai",
    ]);
    expect(choices.find((choice) => choice.id === "codex")?.detail)
      .toContain("Plan-only");
    expect(choices.find((choice) => choice.id === "byok:openrouter-api")?.detail)
      .toContain("environment key");
  });

  it("keeps model lookup deterministic and bounded", () => {
    expect(catalogProviderId("openrouter-api")).toBe("openrouter");
    expect(catalogProviderId("unknown-provider")).toBeNull();
    expect(filterCatalogModels([
      "anthropic/claude-fast",
      "anthropic/claude-pro",
      "openai/gpt",
    ], "claude-pro", 2)).toEqual(["anthropic/claude-pro"]);
    expect(filterCatalogModels(["c", "a", "b"], "", 2)).toEqual(["c", "a"]);
  });

  it("uses stable permission identifiers and safe credential suggestions", () => {
    expect(GUIDED_PERMISSION_CHOICES.map((choice) => choice.id)).toEqual([
      "approved_for_me",
      "ask_always",
      "full_access",
    ]);
    expect(guidedPermissionMode("approved_for_me")).toBe("approved_for_me");
    expect(guidedPermissionMode("yolo")).toBeNull();
    expect(credentialEnvironmentSuggestion("openrouter-api"))
      .toBe("OPENROUTER_API_KEY");
    expect(credentialEnvironmentSuggestion("kilo-gateway"))
      .toBe("KILO_API_KEY");
  });
});
