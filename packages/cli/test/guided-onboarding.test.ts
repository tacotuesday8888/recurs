import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  type AccountSummary,
  type ProviderSummary,
} from "../src/index.js";
import {
  GUIDED_OPERATING_MODE_CHOICES,
  GUIDED_PERMISSION_CHOICES,
  catalogProviderId,
  credentialEnvironmentSuggestion,
  filterCatalogModels,
  guidedConnectionChoices,
  guidedOperatingModeId,
  guidedPermissionMode,
  runGuidedOnboarding,
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
  agentRoles: [],
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

  it("offers only current stable operating-mode policies", () => {
    expect(GUIDED_OPERATING_MODE_CHOICES.map((choice) => choice.id)).toEqual([
      "economy_v5",
      "standard_v5",
      "balanced_v5",
      "performance_v5",
      "max_v5",
    ]);
    expect(guidedOperatingModeId("balanced_v5")).toBe("balanced_v5");
    expect(guidedOperatingModeId("balanced_v4")).toBeNull();
  });

  it("retains public-catalog model selection when authenticated discovery is not reviewed", async () => {
    const selections = [
      "byok:kilo-gateway",
      "kilo/model",
      "ask_always",
      "balanced_v5",
    ];
    const commands: string[][] = [];
    const sink = new Writable({ write(_chunk, _encoding, done) { done(); } });
    const outcome = await runGuidedOnboarding({
      stdout: sink,
      stderr: sink,
      interactive: true,
      automation: false,
      nativeProviders: new Set(),
      async listAccounts() { return []; },
      async detectProviders() { return []; },
      async listProviders() {
        return [{
          ...providers[1]!,
          id: "kilo-gateway",
          displayName: "Kilo Gateway",
        }];
      },
      async discoverProviders(query) {
        expect(query).toBe("kilo");
        return {
          source: "https://models.dev/api.json",
          providers: [{
            id: "kilo",
            name: "Kilo",
            wire: "openai-compatible",
            modelCount: 1,
            modelIds: ["kilo/model"],
          }],
        };
      },
      async discoverEnvironmentModels() {
        throw new Error("unreviewed authenticated discovery must not run");
      },
      async selectChoice(_message, choices) {
        const selected = selections.shift() ?? null;
        expect(choices.some((choice) => choice.id === selected)).toBe(true);
        return selected;
      },
      async promptText(_message, suggestion) {
        expect(suggestion).toBe("KILO_API_KEY");
        return suggestion ?? null;
      },
      async executeCommand(argv) {
        commands.push([...argv]);
        return 0;
      },
    });

    expect(outcome).toEqual({
      state: "configured",
      permissionMode: "ask_always",
      operatingModeId: "balanced_v5",
    });
    expect(commands).toEqual([[
      "setup", "byok",
      "--provider", "kilo-gateway",
      "--model", "kilo/model",
      "--key-env", "KILO_API_KEY",
    ]]);
  });

  it("configures eligible specialist routes without changing the parent", async () => {
    let roles: readonly string[] = [];
    const primary: AccountSummary = {
      ...account,
      id: "parent",
      label: "Parent model",
      modelId: "parent/model",
      primary: true,
      billingSources: ["metered_api"],
      agentRoles: [],
    };
    const specialist = (): AccountSummary => ({
      ...account,
      id: "specialist",
      label: "Specialist model",
      modelId: "specialist/model",
      primary: false,
      billingSources: ["metered_api"],
      agentRoles: roles as AccountSummary["agentRoles"],
    });
    const selections = [
      "account:parent",
      "approved_for_me",
      "performance_v5",
      "customize",
      "specialist",
      "specialist",
      "parent",
    ];
    const commands: string[][] = [];
    const sink = new Writable({ write(_chunk, _encoding, done) { done(); } });
    const outcome = await runGuidedOnboarding({
      stdout: sink,
      stderr: sink,
      interactive: true,
      automation: false,
      nativeProviders: new Set(),
      async listAccounts() { return [primary, specialist()]; },
      async detectProviders() { return []; },
      async listProviders() { return []; },
      async selectChoice(_message, choices) {
        const selected = selections.shift() ?? null;
        expect(choices.some((choice) => choice.id === selected)).toBe(true);
        return selected;
      },
      async promptText() { return null; },
      async executeCommand(argv) {
        commands.push([...argv]);
        if (argv[0] === "account" && argv[1] === "route") {
          const role = argv[2]!;
          roles = argv[3] === "parent"
            ? roles.filter((candidate) => candidate !== role)
            : [...new Set([...roles, role])];
        }
        return 0;
      },
    });

    expect(outcome).toEqual({
      state: "configured",
      permissionMode: "approved_for_me",
      operatingModeId: "performance_v5",
    });
    expect(commands).toEqual([
      ["account", "verify", "parent"],
      ["account", "set-primary", "parent"],
      ["account", "route", "implement", "specialist"],
      ["account", "route", "review", "specialist"],
    ]);
  });
});
