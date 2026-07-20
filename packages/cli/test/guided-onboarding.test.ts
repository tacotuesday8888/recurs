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

  it("offers only reviewed OpenAI reasoning efforts during guided BYOK setup", async () => {
    const selections = [
      "byok:openai-api",
      "gpt-5.6-sol",
      "max",
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
          id: "openai-api",
          displayName: "OpenAI API",
        }];
      },
      async discoverEnvironmentModels(providerId, environmentVariable) {
        expect(providerId).toBe("openai-api");
        expect(environmentVariable).toBe("OPENAI_API_KEY");
        return [{
          id: "gpt-5.6-sol",
          displayName: "GPT-5.6 Sol",
          createdAt: null,
          maxInputTokens: null,
          maxOutputTokens: null,
        }];
      },
      async selectChoice(message, choices) {
        const selected = selections.shift() ?? null;
        expect(choices.some((choice) => choice.id === selected)).toBe(true);
        if (message.includes("reasoning effort")) {
          expect(choices.map((choice) => choice.id)).toEqual([
            "provider-default",
            "none",
            "low",
            "medium",
            "high",
            "xhigh",
            "max",
          ]);
        }
        return selected;
      },
      async promptText(_message, suggestion) {
        expect(suggestion).toBe("OPENAI_API_KEY");
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
      "--provider", "openai-api",
      "--model", "gpt-5.6-sol",
      "--key-env", "OPENAI_API_KEY",
      "--reasoning-effort", "max",
    ]]);
  });

  it("retries BYOK setup after a missing environment credential", async () => {
    const selections = [
      "byok:openrouter-api",
      "retry_connection",
      "anthropic/claude-test",
      "ask_always",
      "balanced_v5",
    ];
    const environmentVariables = ["MISSING_API_KEY", "OPENROUTER_API_KEY"];
    const commands: string[][] = [];
    let errors = "";
    const stdout = new Writable({ write(_chunk, _encoding, done) { done(); } });
    const stderr = new Writable({
      write(chunk, _encoding, done) {
        errors += String(chunk);
        done();
      },
    });
    const outcome = await runGuidedOnboarding({
      stdout,
      stderr,
      interactive: true,
      automation: false,
      nativeProviders: new Set(),
      async listAccounts() { return []; },
      async detectProviders() { return []; },
      async listProviders() { return [providers[1]!]; },
      credentialEnvironmentAvailable(name) {
        return name === "OPENROUTER_API_KEY";
      },
      async discoverEnvironmentModels(providerId, environmentVariable) {
        expect(providerId).toBe("openrouter-api");
        expect(environmentVariable).toBe("OPENROUTER_API_KEY");
        return [{
          id: "anthropic/claude-test",
          displayName: "Claude Test",
          createdAt: null,
          maxInputTokens: 200_000,
          maxOutputTokens: null,
        }];
      },
      async selectChoice(_message, choices) {
        const selected = selections.shift() ?? null;
        expect(choices.some((choice) => choice.id === selected)).toBe(true);
        return selected;
      },
      async promptText(_message, suggestion) {
        expect(suggestion).toBe("OPENROUTER_API_KEY");
        return environmentVariables.shift() ?? null;
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
    expect(errors).toBe(
      "Error: Credential environment variable MISSING_API_KEY is not set in this Recurs process\n",
    );
    expect(commands).toEqual([[
      "setup", "byok",
      "--provider", "openrouter-api",
      "--model", "anthropic/claude-test",
      "--key-env", "OPENROUTER_API_KEY",
    ]]);
  });

  it("redacts a failed connection and can choose another provider path", async () => {
    const selections = [
      "byok:openrouter-api",
      "change_connection",
      "account:saved-1",
      "approved_for_me",
      "balanced_v5",
    ];
    const commands: string[][] = [];
    let errors = "";
    const stdout = new Writable({ write(_chunk, _encoding, done) { done(); } });
    const stderr = new Writable({
      write(chunk, _encoding, done) {
        errors += String(chunk);
        done();
      },
    });
    const outcome = await runGuidedOnboarding({
      stdout,
      stderr,
      interactive: true,
      automation: false,
      nativeProviders: new Set(),
      async listAccounts() { return [account]; },
      async detectProviders() { return []; },
      async listProviders() { return [providers[1]!]; },
      credentialEnvironmentAvailable() { return true; },
      async discoverEnvironmentModels() {
        throw new Error("private provider failure");
      },
      async selectChoice(_message, choices) {
        const selected = selections.shift() ?? null;
        expect(choices.some((choice) => choice.id === selected)).toBe(true);
        return selected;
      },
      async promptText(_message, suggestion) { return suggestion ?? null; },
      async executeCommand(argv) {
        commands.push([...argv]);
        return 0;
      },
    });

    expect(outcome).toEqual({
      state: "configured",
      permissionMode: "approved_for_me",
      operatingModeId: "balanced_v5",
    });
    expect(errors).toMatch(
      /^Error: Unexpected failure \(diagnostic [0-9a-f-]{36}\)\n$/u,
    );
    expect(errors).not.toContain("private provider failure");
    expect(commands).toEqual([
      ["account", "verify", "saved-1"],
      ["account", "set-primary", "saved-1"],
    ]);
  });

  it("does not offer connection recovery after cancellation", async () => {
    const messages: string[] = [];
    const sink = new Writable({ write(_chunk, _encoding, done) { done(); } });
    const outcome = await runGuidedOnboarding({
      stdout: sink,
      stderr: sink,
      interactive: true,
      automation: false,
      nativeProviders: new Set(),
      async listAccounts() { return [account]; },
      async detectProviders() { return []; },
      async listProviders() { return []; },
      async selectChoice(message, choices) {
        messages.push(message);
        return choices.some((choice) => choice.id === "account:saved-1")
          ? "account:saved-1"
          : null;
      },
      async promptText() { return null; },
      async executeCommand() { return 130; },
    });

    expect(outcome).toEqual({ state: "failed", exitCode: 130 });
    expect(messages).toEqual(["Choose how Recurs should access a model"]);
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

  it("creates a confirmed project brief without handling credential values", async () => {
    const selections = [
      "account:saved-1",
      "approved_for_me",
      "balanced_v5",
      "create",
    ];
    const prompts = [
      "Build a dependable multi-agent coding harness.",
      "Run npm test and keep permissions monotonic.",
    ];
    let brief: unknown;
    const sink = new Writable({ write(_chunk, _encoding, done) { done(); } });
    const outcome = await runGuidedOnboarding({
      stdout: sink,
      stderr: sink,
      interactive: true,
      automation: false,
      nativeProviders: new Set(),
      async listAccounts() { return [account]; },
      async detectProviders() { return []; },
      async listProviders() { return []; },
      async inspectProjectInstructions() { return []; },
      async createProjectInstructions(input) {
        brief = input;
        return "created";
      },
      async selectChoice(_message, choices) {
        const selected = selections.shift() ?? null;
        expect(choices.some((choice) => choice.id === selected)).toBe(true);
        return selected;
      },
      async promptText() { return prompts.shift() ?? null; },
      async confirm(message) {
        expect(message).toContain("never overwrite");
        return true;
      },
      async executeCommand() { return 0; },
    });

    expect(outcome).toEqual({
      state: "configured",
      permissionMode: "approved_for_me",
      operatingModeId: "balanced_v5",
    });
    expect(brief).toEqual({
      purpose: "Build a dependable multi-agent coding harness.",
      notes: "Run npm test and keep permissions monotonic.",
    });
  });
});
