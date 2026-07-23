import { Writable } from "node:stream";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CompanyOnboardingCoordinator,
  FileCompanyBlueprintV2Store,
  FileCompanyOnboardingStore,
} from "@recurs/core";

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
  inspectCompanyRepositoryFacts,
  runGuidedOnboarding,
} from "../src/guided-onboarding.js";
import type { ProjectBriefInput } from "../src/project-instructions.js";
import { CompanyProposalEditor } from "../src/company-proposal-editor.js";

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
    id: "xai-api",
    displayName: "xAI API",
    status: "runnable_byok",
    supportStatus: "supported",
    adapterKind: "model_provider",
    accessKind: "api",
    protocol: "openai_chat",
    connectionOwner: "process_environment",
    billing: {
      primarySource: "metered_api",
      possibleAdditionalSources: [],
      providerFallback: "none",
    },
    restrictions: [],
  },
  {
    id: "openai-api",
    displayName: "OpenAI API",
    status: "blocked",
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
  it("composes saved, detected, subscription, BYOK, and portable provider paths", () => {
    const choices = guidedConnectionChoices({
      accounts: [account],
      localRuntimes: [{
        id: "ollama",
        name: "Ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
        detected: true,
      }],
      providers,
    });

    expect(choices.map((choice) => choice.id)).toEqual([
      "account:saved-1",
      "local:ollama",
      "codex",
      "byok:openrouter-api",
      "byok:xai-api",
    ]);
    expect(choices.find((choice) => choice.id === "codex")?.detail)
      .toContain("Act + Plan");
    expect(choices.find((choice) => choice.id === "byok:openrouter-api")?.detail)
      .toContain("environment key");
  });

  it("keeps model lookup deterministic and bounded", () => {
    expect(catalogProviderId("openrouter-api")).toBe("openrouter");
    expect(catalogProviderId("xai-api")).toBe("xai");
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
    expect(credentialEnvironmentSuggestion("xai-api"))
      .toBe("XAI_API_KEY");
    expect(credentialEnvironmentSuggestion("kilo-gateway"))
      .toBe("KILO_API_KEY");
    expect(credentialEnvironmentSuggestion("google-gemini-api"))
      .toBe("GEMINI_API_KEY");
  });

  it("offers only current stable operating-mode policies", () => {
    expect(GUIDED_OPERATING_MODE_CHOICES.map((choice) => choice.id)).toEqual([
      "economy_v6",
      "standard_v6",
      "balanced_v6",
      "performance_v6",
      "max_v6",
    ]);
    expect(guidedOperatingModeId("balanced_v6")).toBe("balanced_v6");
    expect(guidedOperatingModeId("balanced_v4")).toBeNull();
  });

  it("retains public-catalog model selection when authenticated discovery is not reviewed", async () => {
    const selections = [
      "byok:kilo-gateway",
      "kilo/model",
      "ask_always",
      "balanced_v6",
    ];
    const commands: string[][] = [];
    const sink = new Writable({ write(_chunk, _encoding, done) { done(); } });
    const outcome = await runGuidedOnboarding({
      stdout: sink,
      stderr: sink,
      interactive: true,
      automation: false,
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
      operatingModeId: "balanced_v6",
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
      "balanced_v6",
    ];
    const commands: string[][] = [];
    const sink = new Writable({ write(_chunk, _encoding, done) { done(); } });
    const outcome = await runGuidedOnboarding({
      stdout: sink,
      stderr: sink,
      interactive: true,
      automation: false,
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
      operatingModeId: "balanced_v6",
    });
    expect(commands).toEqual([[
      "setup", "byok",
      "--provider", "openai-api",
      "--model", "gpt-5.6-sol",
      "--key-env", "OPENAI_API_KEY",
      "--reasoning-effort", "max",
    ]]);
  });

  it("uses authenticated Gemini discovery in the guided BYOK path", async () => {
    const selections = [
      "byok:google-gemini-api",
      "gemini-test",
      "ask_always",
      "balanced_v6",
    ];
    const commands: string[][] = [];
    const sink = new Writable({ write(_chunk, _encoding, done) { done(); } });
    const gemini: ProviderSummary = {
      ...providers[1]!,
      id: "google-gemini-api",
      displayName: "Google Gemini API",
      protocol: "gemini_generate_content",
      billing: {
        primarySource: "metered_api",
        possibleAdditionalSources: [],
        providerFallback: "none",
      },
    };
    const outcome = await runGuidedOnboarding({
      stdout: sink,
      stderr: sink,
      interactive: true,
      automation: false,
      async listAccounts() { return []; },
      async detectProviders() { return []; },
      async listProviders() { return [gemini]; },
      async discoverEnvironmentModels(providerId, environmentVariable) {
        expect(providerId).toBe("google-gemini-api");
        expect(environmentVariable).toBe("GEMINI_API_KEY");
        return [{
          id: "gemini-test",
          displayName: "Gemini Test",
          createdAt: null,
          maxInputTokens: 1_000_000,
          maxOutputTokens: 65_536,
        }];
      },
      async selectChoice(_message, choices) {
        const selected = selections.shift() ?? null;
        expect(choices.some((choice) => choice.id === selected)).toBe(true);
        return selected;
      },
      async promptText(_message, suggestion) {
        expect(suggestion).toBe("GEMINI_API_KEY");
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
      operatingModeId: "balanced_v6",
    });
    expect(commands).toEqual([[
      "setup", "byok",
      "--provider", "google-gemini-api",
      "--model", "gemini-test",
      "--key-env", "GEMINI_API_KEY",
    ]]);
  });

  it("retries BYOK setup after a missing environment credential", async () => {
    const selections = [
      "byok:openrouter-api",
      "retry_connection",
      "anthropic/claude-test",
      "ask_always",
      "balanced_v6",
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
      operatingModeId: "balanced_v6",
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
      "balanced_v6",
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
      operatingModeId: "balanced_v6",
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
      "performance_v6",
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
      operatingModeId: "performance_v6",
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
      "balanced_v6",
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
      operatingModeId: "balanced_v6",
    });
    expect(brief).toEqual({
      purpose: "Build a dependable multi-agent coding harness.",
      notes: "Run npm test and keep permissions monotonic.",
    });
  });

  it("inspects only fixed root markers and ignores symbolic links", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-company-facts-"));
    try {
      await mkdir(path.join(root, ".git"));
      await writeFile(path.join(root, "package.json"), "secret content");
      await writeFile(path.join(root, ".env"), "must-not-be-discovered");
      await symlink(path.join(root, "package.json"), path.join(root, "Cargo.toml"));

      await expect(inspectCompanyRepositoryFacts(root)).resolves.toEqual({
        inspected: true,
        markers: [".git", "package.json"],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reviews and approves a tailored company without repeating project intake", async () => {
    const selections = [
      "account:saved-1",
      "approved_for_me",
      "balanced_v6",
      "create",
      "existing_project",
      "active",
      "layered_company",
      "create",
    ];
    const prompts = [
      "Build a dependable multi-agent coding harness.",
      "Keep permissions monotonic and run focused verification.",
    ];
    const confirmations: string[] = [];
    let brief: ProjectBriefInput | undefined;
    const output: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, done) {
        output.push(String(chunk));
        done();
      },
    });
    const outcome = await runGuidedOnboarding({
      stdout: sink,
      stderr: sink,
      interactive: true,
      automation: false,
      async listAccounts() { return [account]; },
      async detectProviders() { return []; },
      async listProviders() { return []; },
      async inspectProjectInstructions() { return []; },
      async inspectCompanyRepositoryFacts() {
        return { inspected: true, markers: [".git", "AGENTS.md"] };
      },
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
        confirmations.push(message);
        return true;
      },
      async executeCommand() { return 0; },
    });

    expect(outcome).toMatchObject({
      state: "configured",
      permissionMode: "approved_for_me",
      operatingModeId: "balanced_v6",
      companyBlueprint: {
        version: 1,
        state: "approved",
        developmentStyle: "layered_company",
        project: {
          purpose: "Build a dependable multi-agent coding harness.",
          repository: { inspected: true, markers: [".git", "AGENTS.md"] },
        },
        authority: {
          permissionMode: "approved_for_me",
          operatingModeId: "balanced_v6",
        },
      },
    });
    expect(outcome.state === "configured" && outcome.companyBlueprint?.roles)
      .toHaveLength(8);
    expect(brief).toEqual({
      purpose: "Build a dependable multi-agent coding harness.",
      notes: "Keep permissions monotonic and run focused verification.",
    });
    expect(prompts).toEqual([]);
    expect(confirmations).toHaveLength(3);
    expect(confirmations[0]).toContain("will not read file contents");
    expect(confirmations[1]).toContain("Approve and activate");
    expect(confirmations[2]).toContain("never overwrite");
    expect(output.join("")).toContain("6 / 6 · Project context");
  });

  it("runs the durable V2 interview and approval path when the restricted runtime is ready", async () => {
    const root = await realpath(
      await mkdtemp(path.join(tmpdir(), "recurs-guided-company-v2-")),
    );
    const runs = new FileCompanyOnboardingStore(path.join(root, "runs"));
    const blueprints = new FileCompanyBlueprintV2Store(
      path.join(root, "blueprints"),
    );
    const decisions: unknown[] = [{
      kind: "question",
      id: "desired_outcome",
      question: "What outcome should this company own?",
    }, {
      kind: "research",
      assignments: [{
        key: "repository_shape",
        description: "Inspect the repository shape.",
        prompt: "Read the package manifest and report the workspace shape.",
      }],
    }, {
      kind: "propose",
      project: {
        type: "existing_project",
        stage: "active",
        purpose: "Ship a dependable open-source agent company.",
        users: ["Software teams"],
        successCriteria: ["Every change has independent evidence."],
        constraints: ["Never widen child authority."],
        risks: ["Unbounded delegation"],
        architecturePreferences: ["Reuse existing runtime seams."],
        deploymentTargets: ["CLI"],
        repository: {
          inspected: true,
          markers: [".git", "package.json"],
          evidence: [{
            path: "package.json",
            finding: "The project is a TypeScript workspace.",
          }],
        },
      },
      initialGoal: "Deliver the first independently reviewed company goal.",
      roadmap: ["Understand the project.", "Deliver a reviewed slice."],
    }];
    const coordinator = new CompanyOnboardingCoordinator({
      runs,
      blueprints,
      model: {
        async decide() {
          return {
            decision: decisions.shift(),
            requestsUsed: 1,
            reportedCostUsd: 0,
          };
        },
      },
      research: {
        async run() {
          return {
            evidence: ["package.json: TypeScript workspace"],
            requestsUsed: 1,
            reportedCostUsd: 0,
          };
        },
      },
    });
    const selections = [
      "account:saved-1",
      "approved_for_me",
      "balanced_v6",
      "create",
      "guided",
      "stable_core_specialists",
      "approve",
    ];
    const output: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, done) {
        output.push(String(chunk));
        done();
      },
    });
    try {
      const outcome = await runGuidedOnboarding({
        stdout: sink,
        stderr: sink,
        interactive: true,
        automation: false,
        async listAccounts() { return [account]; },
        async detectProviders() { return []; },
        async listProviders() { return []; },
        async selectChoice(_message, choices) {
          const selected = selections.shift() ?? null;
          expect(choices.some((choice) => choice.id === selected)).toBe(true);
          return selected;
        },
        async promptText(message) {
          expect(message).toBe("What outcome should this company own?");
          return "A trustworthy coding-agent company.";
        },
        async confirm() { return true; },
        async executeCommand() { return 0; },
        async createCompanyOnboarding() {
          return {
            coordinator,
            proposalEditor: new CompanyProposalEditor({
              coordinator,
              model: {
                async revise() {
                  throw new Error("proposal revision was not requested");
                },
              },
              environment: {},
            }),
            projectRoot: root,
            backendFingerprint: "backend-fixture",
          };
        },
      });

      expect(outcome).toMatchObject({
        state: "configured",
        permissionMode: "approved_for_me",
        operatingModeId: "balanced_v6",
        companyBlueprintV2: {
          version: 2,
          state: "approved",
          designMode: "stable_core_specialists",
          project: { purpose: "Ship a dependable open-source agent company." },
        },
      });
      expect(
        outcome.state === "configured" && outcome.companyBlueprintV2?.roles,
      ).toHaveLength(8);
      expect(selections).toEqual([]);
      expect(decisions).toEqual([]);
      expect(output.join(""))
        .toContain("Company interview · question 1");
      expect(output.join(""))
        .toContain("Project understanding · 1 bounded investigation complete");
      expect(output.join(""))
        .toContain("Company proposal · ready for review");
      expect(output.join(""))
        .toContain("Company approved · 6 department(s), 8 role(s)");
      expect(output.join(""))
        .toContain("Company capability readiness");
      expect(output.join(""))
        .toContain("Agent Skills: not inspected");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
