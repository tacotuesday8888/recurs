import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  AgentRunRequest,
  AgentRuntimeEvent,
  AgentRuntimeHost,
  ToolDefinition,
} from "@recurs/contracts";
import { afterAll, describe, expect, it, vi } from "vitest";

import {
  createGitHubCopilotRuntime,
  inspectGitHubCopilotSubscription,
  type GitHubCopilotClient,
  type GitHubCopilotClientFactory,
  type GitHubCopilotModel,
  type GitHubCopilotSession,
  type GitHubCopilotSessionConfig,
} from "@recurs/runtimes";

type SessionEvent = Parameters<NonNullable<GitHubCopilotSessionConfig["onEvent"]>>[0];
const DATA_DIRECTORY = path.join(tmpdir(), `recurs-copilot-runtime-${process.pid}`);

afterAll(async () => {
  await rm(DATA_DIRECTORY, { recursive: true, force: true });
});

const recursTools: readonly ToolDefinition[] = Object.freeze([{
  name: "read_file",
  description: "Read one workspace file",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
}]);

function fingerprint(login = "octocat", host = "github.com"): string {
  return `sha256:${createHash("sha256")
    .update(`github-copilot-subscription\0${host}\0${login.toLocaleLowerCase("en-US")}`)
    .digest("hex")}`;
}

function runRequest(signal = new AbortController().signal): AgentRunRequest {
  return {
    sessionId: "session-1",
    turnId: "turn-1",
    prompt: "Inspect the project",
    cwd: path.resolve(process.cwd()),
    modelId: "gpt-test",
    executionMode: "act",
    permissionMode: "ask_always",
    authorization: {
      kind: "run",
      id: "authorization-1",
      operation: "run",
      sessionId: "session-1",
      operationId: "turn-1",
      turnId: "turn-1",
      connectionId: "copilot-1",
      modelId: "gpt-test",
      backendFingerprint: "sha256:test",
      connectionRevision: 1,
      policyRevision: "policy-v1",
      billingMode: "strict_primary_only",
      billingSelectionDigest: "sha256:billing",
      contextDigest: "sha256:context",
      maxRequests: 1,
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
    continuationReader: null,
    continuationWriter: {
      id: "writer-1",
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
    continuation: null,
    signal,
  };
}

class FakeSession implements GitHubCopilotSession {
  readonly sessionId = "sdk-session-1";
  abortCalls = 0;
  disconnectCalls = 0;
  sendCalls: unknown[] = [];
  readonly usageEmitted: Promise<void>;
  readonly #usageResolve: () => void;

  constructor(
    private readonly config: GitHubCopilotSessionConfig,
    private readonly scenario:
      | "success"
      | "failure"
      | "cancel"
      | "tool_success"
      | "tool_failure"
      | "tool_oversized_arguments"
      | "tool_malformed_invocation"
      | "oversized_text"
      | "excessive_events"
      | "cumulative_reasoning"
      | "usage_model_mismatch"
      | "usage_optional_missing"
      | "usage_complete_then_missing"
      | "idle_aborted"
      | "error_authorization"
      | "error_quota"
      | "error_rate_limit"
      | "error_context_limit"
      | "error_unknown"
      | "malformed_event"
      | "tool_malformed_swallowed"
      | "cancel_silent",
  ) {
    let resolve!: () => void;
    this.usageEmitted = new Promise<void>((currentResolve) => { resolve = currentResolve; });
    this.#usageResolve = resolve;
  }

  async send(input: { readonly prompt: string }): Promise<void> {
    this.sendCalls.push(input);
    if (
      this.scenario === "tool_success" ||
      this.scenario === "tool_failure" ||
      this.scenario === "tool_oversized_arguments" ||
      this.scenario === "tool_malformed_invocation" ||
      this.scenario === "tool_malformed_swallowed"
    ) {
      const arguments_ = this.scenario === "tool_oversized_arguments"
        ? { value: "x".repeat(1024 * 1024 + 1) }
        : { path: "README.md" };
      try {
        const result = await this.config.tools?.[0]?.handler(
          arguments_,
          this.scenario === "tool_malformed_invocation" ||
              this.scenario === "tool_malformed_swallowed" ? null as never : {
            sessionId: this.sessionId,
            toolCallId: "call-1",
            toolName: "read_file",
            arguments: arguments_,
          },
        );
        this.config.onEvent?.({
          type: "assistant.message_delta",
          data: { deltaContent: String(result) },
        });
        this.config.onEvent?.({ type: "session.idle", data: {} });
      } catch {
        if (this.scenario === "tool_malformed_swallowed") {
          this.config.onEvent?.({ type: "session.idle", data: {} });
          return;
        }
        this.config.onEvent?.({
          type: "session.error",
          data: {
            errorType: "tool_execution",
            message: "host rejection ghp_secret /private/credentials.json",
          },
        });
      }
      return;
    }
    if (this.scenario === "malformed_event") {
      this.config.onEvent?.(null as never);
      return;
    }
    if (this.scenario === "oversized_text") {
      this.config.onEvent?.({
        type: "assistant.message_delta",
        data: { deltaContent: "x".repeat(4 * 1_024 * 1_024 + 1) },
      });
      return;
    }
    if (this.scenario === "excessive_events") {
      for (let index = 0; index < 4_097; index += 1) {
        this.config.onEvent?.({
          type: "assistant.reasoning_delta",
          data: { deltaContent: "r" },
        });
      }
      return;
    }
    if (this.scenario === "cumulative_reasoning") {
      for (let index = 0; index < 3_000; index += 1) {
        this.config.onEvent?.({
          type: "assistant.reasoning_delta",
          data: { deltaContent: "r".repeat(2_048) },
        });
      }
      return;
    }
    this.config.onEvent?.({
      type: "assistant.message_delta",
      data: { deltaContent: "hello from Copilot" },
    });
    this.config.onEvent?.({
      type: "assistant.usage",
      data: {
        model: this.scenario === "usage_model_mismatch" ? "rerouted-model" : "gpt-test",
        ...(this.scenario === "usage_optional_missing" ? {} : {
          inputTokens: 10,
          outputTokens: 4,
        }),
        reasoningTokens: 2,
        cacheReadTokens: 3,
        cacheWriteTokens: 5,
      },
    });
    this.#usageResolve();
    if (this.scenario === "usage_complete_then_missing") {
      this.config.onEvent?.({
        type: "assistant.usage",
        data: { model: "gpt-test", cacheReadTokens: 1 },
      });
    }
    if (this.scenario === "failure" || this.scenario.startsWith("error_")) {
      const errorType = this.scenario === "failure" ? "authentication"
        : this.scenario.slice("error_".length);
      this.config.onEvent?.({
        type: "session.error",
        data: {
          errorType,
          message: "raw token ghp_secret and /private/credentials.json",
          statusCode: 401,
        },
      });
      return;
    }
    if (this.scenario === "success" || this.scenario === "usage_optional_missing" ||
      this.scenario === "usage_complete_then_missing" ||
      this.scenario === "idle_aborted") {
      this.config.onEvent?.({
        type: "session.idle",
        data: this.scenario === "idle_aborted" ? { aborted: true } : {},
      });
    }
  }

  async abort(): Promise<void> {
    this.abortCalls += 1;
    if (this.scenario !== "cancel_silent") {
      this.config.onEvent?.({ type: "abort", data: { reason: "user initiated" } });
    }
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
  }

  emit(event: SessionEvent): void {
    this.config.onEvent?.(event);
  }
}

function fakeFactory(
  scenario:
    | "success"
    | "failure"
    | "cancel"
    | "tool_success"
    | "tool_failure"
    | "tool_oversized_arguments"
    | "tool_malformed_invocation"
    | "oversized_text"
    | "excessive_events"
    | "cumulative_reasoning"
    | "usage_model_mismatch"
    | "usage_optional_missing"
    | "usage_complete_then_missing"
    | "idle_aborted"
    | "error_authorization"
    | "error_quota"
    | "error_rate_limit"
    | "error_context_limit"
    | "error_unknown"
    | "malformed_event"
    | "tool_malformed_swallowed"
    | "cancel_silent" = "success",
  authType: "user" | "gh-cli" | "env" = "user",
  login = "octocat",
  options: {
    readonly host?: string;
    readonly authenticated?: boolean;
    readonly models?: readonly GitHubCopilotModel[];
    readonly onCreateSession?: () => void;
    readonly start?: () => Promise<void>;
    readonly onStart?: () => void;
    readonly stop?: () => Promise<void>;
    readonly onStop?: () => void;
    readonly onForceStop?: () => void;
    readonly authStatus?: unknown;
  } = {},
) {
  const clientConfigs: Record<string, unknown>[] = [];
  const sessionConfigs: GitHubCopilotSessionConfig[] = [];
  const sessions: FakeSession[] = [];
  let stopCalls = 0;
  let forceStopCalls = 0;
  let sessionCreatedResolve!: () => void;
  const sessionCreated = new Promise<void>((resolve) => { sessionCreatedResolve = resolve; });
  const factory: GitHubCopilotClientFactory = (config) => {
    if (config.mode === "empty" && config.baseDirectory === undefined) {
      throw new Error("empty mode requires explicit persistence");
    }
    clientConfigs.push(config);
    const client: GitHubCopilotClient = {
      async start() {
        options.onStart?.();
        await options.start?.();
      },
      async getAuthStatus() {
        if (options.authStatus !== undefined) return options.authStatus as never;
        return {
          isAuthenticated: options.authenticated ?? true,
          authType,
          login,
          host: options.host ?? "github.com",
        };
      },
      async listModels() {
        return options.models ?? [{
          id: "gpt-test",
          name: "GPT Test",
          capabilities: {
            supports: { vision: false, reasoningEffort: true },
            limits: { max_context_window_tokens: 128_000 },
          },
          policy: { state: "enabled", terms: "" },
          billing: { multiplier: 1 },
          supportedReasoningEfforts: ["low", "high"],
          defaultReasoningEffort: "low",
        }];
      },
      async createSession(config) {
        options.onCreateSession?.();
        sessionConfigs.push(config);
        const session = new FakeSession(config, scenario);
        sessions.push(session);
        sessionCreatedResolve();
        return session;
      },
      async stop() {
        stopCalls += 1;
        options.onStop?.();
        await options.stop?.();
      },
      async forceStop() {
        forceStopCalls += 1;
        options.onForceStop?.();
      },
    };
    return client;
  };
  return {
    factory,
    clientConfigs,
    sessionConfigs,
    sessions,
    stopCalls: () => stopCalls,
    forceStopCalls: () => forceStopCalls,
    sessionCreated,
  };
}

async function collect(
  factory: GitHubCopilotClientFactory,
  signal = new AbortController().signal,
  request = runRequest(signal),
  host: AgentRuntimeHost = {
    tools: recursTools,
    executeTool: async () => ({ output: "README contents" }),
  },
  reasoningEffort: "low" | "medium" | "high" | "xhigh" | null = "high",
): Promise<AgentRuntimeEvent[]> {
  const runtime = createGitHubCopilotRuntime({
    connectionId: "copilot-1",
    modelId: "gpt-test",
    expectedAccountSubjectFingerprint: fingerprint(),
    dataDirectory: DATA_DIRECTORY,
    ...(reasoningEffort === null ? {} : { reasoningEffort }),
    environment: {
      PATH: process.env.PATH,
      HOME: "/private/home",
      GH_TOKEN: "ghp_generic",
      GITHUB_TOKEN: "github_actions_generic",
      DATABASE_PASSWORD: "unrelated-secret",
      LANG: "en_US.UTF-8",
    },
    createClient: factory,
  });
  const events: AgentRuntimeEvent[] = [];
  for await (const event of runtime.run(request, host)) {
    events.push(event);
  }
  return events;
}

describe("GitHub Copilot official SDK runtime", () => {
  it("inspects signed-in-user auth and entitled models without a model turn", async () => {
    const fake = fakeFactory();
    const result = await inspectGitHubCopilotSubscription({
      dataDirectory: DATA_DIRECTORY,
      environment: {
        PATH: process.env.PATH,
        HOME: "/private/home",
        GH_TOKEN: "ghp_generic",
        GITHUB_TOKEN: "github_actions_generic",
        API_SECRET: "unrelated-secret",
        LANG: "en_US.UTF-8",
      },
      createClient: fake.factory,
    });

    expect(result).toEqual({
      accountLogin: "octocat",
      accountSubjectFingerprint: fingerprint(),
      authentication: "stored_oauth",
      models: [{
        id: "gpt-test",
        displayName: "GPT Test",
        maxContextTokens: 128_000,
        supportsReasoningEffort: true,
        reasoningEfforts: ["low", "high"],
        defaultReasoningEffort: "low",
        billingMultiplier: 1,
      }],
    });
    expect(fake.sessionConfigs).toHaveLength(0);
    expect(fake.stopCalls()).toBe(1);
    expect(fake.clientConfigs).toEqual([expect.objectContaining({
      mode: "empty",
      baseDirectory: path.join(await realpath(DATA_DIRECTORY), "runtimes", "github-copilot-home"),
      useLoggedInUser: true,
      env: expect.objectContaining({ LANG: "en_US.UTF-8" }),
    })]);
    const serialized = JSON.stringify(fake.clientConfigs);
    expect(serialized).not.toContain("GH_TOKEN");
    expect(serialized).not.toContain("GITHUB_TOKEN");
    expect(serialized).not.toContain("API_SECRET");
    expect(serialized).not.toContain("ghp_generic");
    expect(serialized).not.toContain("unrelated-secret");
  });

  it("rejects environment-token auth for the stored-account subscription path", async () => {
    const fake = fakeFactory("success", "env");
    await expect(inspectGitHubCopilotSubscription({
      dataDirectory: DATA_DIRECTORY,
      environment: process.env,
      createClient: fake.factory,
    })).rejects.toMatchObject({
      code: "wrong_authentication_method",
      message: "GitHub Copilot must use an explicit signed-in-user account",
    });
    expect(fake.stopCalls()).toBe(1);
  });

  it("reports signed-out vendor-default auth without reading credential stores", async () => {
    const fake = fakeFactory("success", "user", "octocat", {
      authenticated: false,
    });
    await expect(inspectGitHubCopilotSubscription({
      dataDirectory: DATA_DIRECTORY,
      environment: { HOME: "/private/home", PATH: process.env.PATH },
      createClient: fake.factory,
    })).rejects.toMatchObject({
      code: "authentication_required",
      message: "GitHub Copilot requires signed-in-user authentication",
    });
    expect(fake.clientConfigs[0]).toMatchObject({
      useLoggedInUser: true,
    });
    expect(fake.clientConfigs[0]).toHaveProperty(
      "baseDirectory",
      path.join(await realpath(DATA_DIRECTORY), "runtimes", "github-copilot-home"),
    );
    expect(fake.clientConfigs[0]?.env).not.toHaveProperty("COPILOT_HOME");
    expect((await stat(path.join(DATA_DIRECTORY, "runtimes", "github-copilot-home"))).mode & 0o777)
      .toBe(0o700);
    expect(fake.stopCalls()).toBe(1);
  });

  it.each(["runtimes", "home"] as const)(
    "rejects a Copilot storage symlink that collapses the %s authority",
    async (kind) => {
      const dataDirectory = await mkdtemp(path.join(tmpdir(), "recurs-copilot-storage-"));
      try {
        const runtimes = path.join(dataDirectory, "runtimes");
        if (kind === "runtimes") {
          await symlink(dataDirectory, runtimes, "dir");
        } else {
          await mkdir(runtimes, { mode: 0o700 });
          await symlink(runtimes, path.join(runtimes, "github-copilot-home"), "dir");
        }
        await expect(inspectGitHubCopilotSubscription({
          dataDirectory,
          createClient: fakeFactory().factory,
        })).rejects.toMatchObject({ code: "invalid_response" });
      } finally {
        await rm(dataDirectory, { recursive: true, force: true });
      }
    },
  );

  it.each([null, {}, { isAuthenticated: "yes" }])(
    "rejects malformed SDK authentication status %#",
    async (authStatus) => {
      const fake = fakeFactory("success", "user", "octocat", { authStatus });
      await expect(inspectGitHubCopilotSubscription({
        dataDirectory: DATA_DIRECTORY,
        createClient: fake.factory,
      })).rejects.toMatchObject({ code: "invalid_response" });
    },
  );

  it("cancels a never-resolving SDK preflight call and force-stops the client", async () => {
    const never = new Promise<void>(() => undefined);
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => { startedResolve = resolve; });
    const fake = fakeFactory("success", "user", "octocat", {
      start: () => never,
      onStart: startedResolve,
    });
    const controller = new AbortController();
    const result = collect(fake.factory, controller.signal);
    await started;
    controller.abort();

    await expect(result).resolves.toContainEqual({
      type: "cancelled",
      reason: "GitHub Copilot turn was interrupted",
    });
    expect(fake.forceStopCalls()).toBe(1);
  });

  it("force-stops a client that resolves after inspection cancellation", async () => {
    let releaseResolve!: () => void;
    let calledResolve!: () => void;
    let forcedResolve!: () => void;
    const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
    const called = new Promise<void>((resolve) => { calledResolve = resolve; });
    const forced = new Promise<void>((resolve) => { forcedResolve = resolve; });
    const base = fakeFactory("success", "user", "octocat", { onForceStop: forcedResolve });
    const delayed: GitHubCopilotClientFactory = async (config) => {
      calledResolve();
      await release;
      return await base.factory(config);
    };
    const controller = new AbortController();
    const inspection = inspectGitHubCopilotSubscription({
      dataDirectory: DATA_DIRECTORY,
      createClient: delayed,
      signal: controller.signal,
    });
    await called;
    controller.abort();
    await expect(inspection).rejects.toMatchObject({ code: "cancelled" });
    releaseResolve();
    await forced;
    expect(base.forceStopCalls()).toBe(1);
  });

  it("force-stops a client that resolves after turn cancellation", async () => {
    let releaseResolve!: () => void;
    let calledResolve!: () => void;
    let forcedResolve!: () => void;
    const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
    const called = new Promise<void>((resolve) => { calledResolve = resolve; });
    const forced = new Promise<void>((resolve) => { forcedResolve = resolve; });
    const base = fakeFactory("success", "user", "octocat", { onForceStop: forcedResolve });
    const delayed: GitHubCopilotClientFactory = async (config) => {
      calledResolve();
      await release;
      return await base.factory(config);
    };
    const controller = new AbortController();
    const turn = collect(delayed, controller.signal);
    await called;
    controller.abort();
    await expect(turn).resolves.toContainEqual({
      type: "cancelled",
      reason: "GitHub Copilot turn was interrupted",
    });
    releaseResolve();
    await forced;
    expect(base.forceStopCalls()).toBe(1);
  });

  it("returns one cancellation without resolving the SDK for an already-aborted turn", async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = fakeFactory();
    const events = await collect(fake.factory, controller.signal);
    expect(events).toEqual([{
      type: "cancelled",
      reason: "GitHub Copilot turn was interrupted",
    }]);
    expect(fake.clientConfigs).toHaveLength(0);
  });

  it("bounds never-resolving graceful cleanup and falls back to forceStop", async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<void>(() => undefined);
      let stoppingResolve!: () => void;
      const stopping = new Promise<void>((resolve) => { stoppingResolve = resolve; });
      const fake = fakeFactory("success", "user", "octocat", {
        stop: () => never,
        onStop: stoppingResolve,
      });
      const inspection = inspectGitHubCopilotSubscription({
        dataDirectory: DATA_DIRECTORY,
        createClient: fake.factory,
      });
      await stopping;
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(inspection).resolves.toMatchObject({ accountLogin: "octocat" });
      expect(fake.forceStopCalls()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses only Recurs custom tools and fails closed for every SDK permission", async () => {
    const fake = fakeFactory();
    const events = await collect(fake.factory);
    expect(events).toContainEqual({
      type: "usage",
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        reasoningTokens: 2,
        cachedInputTokens: 3,
        cacheWriteInputTokens: 5,
      },
    });
    expect(events.at(-1)).toEqual({
      type: "done",
      finalText: "hello from Copilot",
      stopReason: "complete",
    });
    expect(fake.sessionConfigs).toHaveLength(1);
    const config = fake.sessionConfigs[0]!;
    expect(config).toMatchObject({
      model: "gpt-test",
      reasoningEffort: "high",
      streaming: true,
      availableTools: ["custom:read_file"],
      excludedTools: ["builtin:*", "mcp:*"],
      enableConfigDiscovery: false,
      requestCanvasRenderer: false,
      requestExtensions: false,
      enableMcpApps: false,
      includeSubAgentStreamingEvents: false,
      mcpOAuthTokenStorage: "in-memory",
      mcpServers: {},
      customAgents: [],
      skillDirectories: [],
      pluginDirectories: [],
      instructionDirectories: [],
      skipCustomInstructions: true,
      customAgentsLocalOnly: true,
      coauthorEnabled: false,
      manageScheduleEnabled: false,
      enableSessionTelemetry: false,
      infiniteSessions: { enabled: false },
      memory: { enabled: false },
      enableManagedSettings: false,
      skipEmbeddingRetrieval: true,
      embeddingCacheStorage: "in-memory",
      enableOnDemandInstructionDiscovery: false,
      enableFileHooks: false,
      enableHostGitOperations: false,
      enableSessionStore: false,
      enableSkills: false,
      remoteSession: "off",
    });
    expect(config.tools).toEqual([expect.objectContaining({
      name: "read_file",
      overridesBuiltInTool: true,
      skipPermission: true,
      defer: "never",
    })]);
    await expect(config.onPermissionRequest?.({
      kind: "shell",
      fullCommandText: "rm -rf /",
    }, { sessionId: "sdk-session-1" })).resolves.toEqual({ kind: "denied-by-rules" });
    expect(fake.sessions[0]?.disconnectCalls).toBe(1);
    expect(fake.stopCalls()).toBe(1);
  });

  it("omits reasoning effort for a model that does not support it", async () => {
    const fake = fakeFactory("success", "user", "octocat", {
      models: [{
        id: "gpt-test",
        name: "GPT Test",
        capabilities: {
          supports: { vision: false, reasoningEffort: false },
          limits: { max_context_window_tokens: 128_000 },
        },
        policy: { state: "enabled", terms: "" },
      }],
    });
    const events = await collect(fake.factory, undefined, undefined, undefined, null);
    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect(fake.sessionConfigs[0]).not.toHaveProperty("reasoningEffort");
  });

  it("rejects usage attributed to a model other than the pinned model", async () => {
    const fake = fakeFactory("usage_model_mismatch");
    const events = await collect(fake.factory);
    expect(events.at(-1)).toMatchObject({
      type: "failed",
      failure: { domain: "runtime", code: "invalid_response" },
    });
  });

  it("does not invent token totals when official usage omits them", async () => {
    const events = await collect(fakeFactory("usage_optional_missing").factory);
    expect(events).not.toContainEqual(expect.objectContaining({ type: "usage" }));
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("withholds all turn usage when a later model call omits token totals", async () => {
    const events = await collect(fakeFactory("usage_complete_then_missing").factory);
    expect(events).not.toContainEqual(expect.objectContaining({ type: "usage" }));
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("treats an aborted idle event as cancellation", async () => {
    const events = await collect(fakeFactory("idle_aborted").factory);
    expect(events.at(-1)).toEqual({
      type: "cancelled",
      reason: "GitHub Copilot turn was interrupted",
    });
  });

  it.each([
    ["error_authorization", "auth", "authorization_denied"],
    ["error_quota", "provider", "quota_exhausted"],
    ["error_rate_limit", "provider", "rate_limited"],
    ["error_context_limit", "provider", "context_overflow"],
    ["error_unknown", "runtime", "runtime_failed"],
  ] as const)("maps %s through a fixed safe failure", async (scenario, domain, code) => {
    const events = await collect(fakeFactory(scenario).factory);
    expect(events.at(-1)).toMatchObject({
      type: "failed",
      failure: { domain, code },
    });
    expect(JSON.stringify(events)).not.toMatch(/ghp_|private|credentials/u);
  });

  it("terminates safely on a malformed SDK event", async () => {
    const events = await collect(fakeFactory("malformed_event").factory);
    expect(events.at(-1)).toMatchObject({
      type: "failed",
      failure: { domain: "runtime", code: "invalid_response" },
    });
  });

  it("routes a registered custom tool only through the active Recurs host call", async () => {
    const fake = fakeFactory("tool_success");
    const controller = new AbortController();
    const executeTool = vi.fn(async () => ({ output: "bounded host output" }));
    const events = await collect(
      fake.factory,
      controller.signal,
      runRequest(controller.signal),
      { tools: recursTools, executeTool },
    );

    expect(executeTool).toHaveBeenCalledOnce();
    expect(executeTool).toHaveBeenCalledWith({
      id: "call-1",
      name: "read_file",
      arguments: { path: "README.md" },
    }, controller.signal);
    expect(events).toContainEqual({
      type: "activity",
      activity: {
        id: "call-1",
        kind: "tool",
        name: "read_file",
        status: "started",
      },
    });
    expect(events).toContainEqual({
      type: "activity",
      activity: {
        id: "call-1",
        kind: "tool",
        name: "read_file",
        status: "completed",
      },
    });
    expect(events.at(-1)).toEqual({
      type: "done",
      finalText: "bounded host output",
      stopReason: "complete",
    });
  });

  it("maps host tool rejection without returning host or SDK diagnostics", async () => {
    const fake = fakeFactory("tool_failure");
    const events = await collect(
      fake.factory,
      undefined,
      undefined,
      {
        tools: recursTools,
        executeTool: async () => {
          throw new Error("ghp_host_secret /private/host-config.json");
        },
      },
    );
    expect(events.at(-1)).toMatchObject({
      type: "failed",
      failure: {
        domain: "tool",
        code: "tool_failed",
        safeMessage: "A Recurs tool call failed",
      },
    });
    expect(JSON.stringify(events)).not.toMatch(/ghp_|private|credentials|config\.json/u);
  });

  it("rejects a malformed custom-tool invocation without calling the host", async () => {
    const executeTool = vi.fn(async () => ({ output: "must not run" }));
    const events = await collect(
      fakeFactory("tool_malformed_invocation").factory,
      undefined,
      undefined,
      { tools: recursTools, executeTool },
    );
    expect(executeTool).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({
      type: "failed",
      failure: { domain: "tool", code: "tool_failed" },
    });
  });

  it("settles a malformed custom-tool boundary even when the SDK swallows the rejection", async () => {
    const executeTool = vi.fn(async () => ({ output: "must not run" }));
    const events = await collect(
      fakeFactory("tool_malformed_swallowed").factory,
      undefined,
      undefined,
      { tools: recursTools, executeTool },
    );
    expect(executeTool).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({
      type: "failed",
      failure: { domain: "tool", code: "tool_failed" },
    });
  });

  it("rechecks the signed-in account before every run", async () => {
    const fake = fakeFactory("success", "user", "switched-account");
    const events = await collect(fake.factory);
    expect(events.at(-1)).toMatchObject({
      type: "failed",
      failure: {
        domain: "auth",
        code: "account_mismatch",
      },
    });
    expect(fake.sessionConfigs).toHaveLength(0);
  });

  it("binds the canonical GitHub host and rejects a host switch", async () => {
    const fake = fakeFactory("success", "user", "octocat", {
      host: "github.example.test",
    });
    const events = await collect(fake.factory);
    expect(events.at(-1)).toMatchObject({
      type: "failed",
      failure: { domain: "auth", code: "account_mismatch" },
    });
    expect(fake.sessionConfigs).toHaveLength(0);
  });

  it("does not present policy-unconfigured models as ready", async () => {
    const fake = fakeFactory("success", "user", "octocat", {
      models: [{
      id: "gpt-test", name: "GPT Test",
      capabilities: { supports: { vision: false, reasoningEffort: true }, limits: { max_context_window_tokens: 1 } },
      policy: { state: "unconfigured", terms: "" },
      }],
    });
    const inspected = await inspectGitHubCopilotSubscription({
      dataDirectory: DATA_DIRECTORY,
      createClient: fake.factory,
    });
    expect(inspected.models).toEqual([]);
  });

  it("accepts an entitled model catalog exactly at the bounded picker limit", async () => {
    const models = Array.from({ length: 256 }, (_, index) => ({
      id: `model-${index}`,
      name: `Model ${index}`,
      capabilities: {
        supports: { vision: false, reasoningEffort: false },
        limits: { max_context_window_tokens: 1 },
      },
      policy: { state: "enabled" as const, terms: "" },
    }));
    const fake = fakeFactory("success", "user", "octocat", { models });
    const inspected = await inspectGitHubCopilotSubscription({
      dataDirectory: DATA_DIRECTORY,
      createClient: fake.factory,
    });
    expect(inspected.models).toHaveLength(256);
  });

  it.each([
    ["over-limit", Array.from({ length: 257 }, (_, index) => ({
      id: `model-${index}`,
      name: `Model ${index}`,
      capabilities: {
        supports: { vision: false, reasoningEffort: false },
        limits: { max_context_window_tokens: 1 },
      },
    }))],
    ["non-array", { id: "not-a-list" }],
  ])("rejects a %s SDK model catalog before projection", async (_name, models) => {
    const fake = fakeFactory("success", "user", "octocat", {
      models: models as never,
    });
    await expect(inspectGitHubCopilotSubscription({
      dataDirectory: DATA_DIRECTORY,
      createClient: fake.factory,
    })).rejects.toMatchObject({ code: "invalid_response" });
  });

  it.each([
    ["control character", [{
      id: "gpt-test\nunsafe", name: "GPT Test",
      capabilities: { supports: { vision: false, reasoningEffort: true }, limits: { max_context_window_tokens: 1 } },
    }]],
    ["duplicate id", [
      { id: "gpt-test", name: "One", capabilities: { supports: { vision: false, reasoningEffort: false }, limits: { max_context_window_tokens: 1 } } },
      { id: "gpt-test", name: "Two", capabilities: { supports: { vision: false, reasoningEffort: false }, limits: { max_context_window_tokens: 1 } } },
    ]],
    ["mixed-policy duplicate id", [
      { id: "gpt-test", name: "One", policy: { state: "enabled", terms: "" }, capabilities: { supports: { vision: false, reasoningEffort: false }, limits: { max_context_window_tokens: 1 } } },
      { id: "gpt-test", name: "Two", policy: { state: "disabled", terms: "" }, capabilities: { supports: { vision: false, reasoningEffort: false }, limits: { max_context_window_tokens: 1 } } },
    ]],
    ["null entry", [null]],
    ["null policy", [{
      id: "gpt-test", name: "GPT Test", policy: null,
      capabilities: { supports: { vision: false, reasoningEffort: false }, limits: { max_context_window_tokens: 1 } },
    }]],
    ["missing capabilities", [{ id: "gpt-test", name: "GPT Test" }]],
  ] as const)("rejects %s model metadata", async (_name, models) => {
    const fake = fakeFactory("success", "user", "octocat", {
      models: models as unknown as readonly GitHubCopilotModel[],
    });
    await expect(inspectGitHubCopilotSubscription({
      dataDirectory: DATA_DIRECTORY,
      createClient: fake.factory,
    })).rejects.toMatchObject({ code: "invalid_response" });
  });

  it.each([
    ["connection", (request: AgentRunRequest) => ({
      ...request,
      authorization: { ...request.authorization, connectionId: "other" },
    })],
    ["model", (request: AgentRunRequest) => ({ ...request, modelId: "other" })],
    ["authorized model", (request: AgentRunRequest) => ({
      ...request,
      authorization: { ...request.authorization, modelId: "other" },
    })],
    ["continuation", (request: AgentRunRequest) => ({
      ...request,
      continuation: {
        kind: "runtime" as const,
        id: "continuation-1",
        storageClass: "process_scoped" as const,
        recursSessionId: request.sessionId,
        connectionId: "copilot-1",
        adapterId: "github-copilot-sdk",
        modelId: "gpt-test",
        backendFingerprint: "sha256:test",
        stateVersion: 1,
        originTurnId: "turn-0",
        continuationSequence: 1,
        status: "committed" as const,
        vendorTurnSequence: 1,
      },
    })],
  ])("rejects a mismatched %s binding before SDK session creation", async (_name, mutate) => {
    const fake = fakeFactory();
    const request = mutate(runRequest());
    const events = await collect(fake.factory, request.signal, request);
    expect(events.at(-1)).toMatchObject({
      type: "failed",
      failure: { domain: "runtime", code: "runtime_capability_missing" },
    });
    expect(fake.sessionConfigs).toHaveLength(0);
  });

  it.each([
    ["accumulated text", "oversized_text"],
    ["event volume", "excessive_events"],
    ["cumulative reasoning text", "cumulative_reasoning"],
  ] as const)("fails safely when %s exceeds its runtime bound", async (_name, scenario) => {
    const fake = fakeFactory(scenario);
    const events = await collect(fake.factory);
    expect(events.at(-1)).toMatchObject({
      type: "failed",
      failure: { domain: "runtime", code: "invalid_response" },
    });
    expect(fake.sessions[0]?.disconnectCalls).toBe(1);
    expect(fake.stopCalls()).toBe(1);
  });

  it("rejects oversized host tool output before returning it to the SDK", async () => {
    const fake = fakeFactory("tool_failure");
    const events = await collect(fake.factory, undefined, undefined, {
      tools: recursTools,
      executeTool: async () => ({ output: "x".repeat(4 * 1_024 * 1_024 + 1) }),
    });
    expect(events.at(-1)).toMatchObject({
      type: "failed",
      failure: { domain: "tool", code: "tool_failed" },
    });
  });

  it("rejects oversized serialized tool arguments before calling the host", async () => {
    const fake = fakeFactory("tool_oversized_arguments");
    const executeTool = vi.fn(async () => ({ output: "unused" }));
    const events = await collect(fake.factory, undefined, undefined, {
      tools: recursTools,
      executeTool,
    });
    expect(executeTool).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({
      type: "failed",
      failure: { domain: "tool", code: "tool_failed" },
    });
  });

  it("aborts the active Copilot turn and cleans up when Recurs cancels", async () => {
    const fake = fakeFactory("cancel_silent");
    const controller = new AbortController();
    const eventsPromise = collect(fake.factory, controller.signal);
    await fake.sessionCreated;
    await fake.sessions[0]!.usageEmitted;
    controller.abort();
    const events = await eventsPromise;
    expect(fake.sessions[0]?.abortCalls).toBe(1);
    expect(fake.sessions[0]?.disconnectCalls).toBe(1);
    expect(fake.stopCalls()).toBe(1);
    expect(events.filter((event) => event.type === "usage")).toEqual([{
      type: "usage",
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        reasoningTokens: 2,
        cachedInputTokens: 3,
        cacheWriteInputTokens: 5,
      },
    }]);
    expect(events.at(-1)).toMatchObject({ type: "cancelled" });
  });

  it("cancels when the signal aborts during SDK session creation", async () => {
    const controller = new AbortController();
    const fake = fakeFactory("cancel_silent", "user", "octocat", {
      onCreateSession: () => controller.abort(),
    });
    const events = await collect(fake.factory, controller.signal);
    expect(fake.sessions[0]?.abortCalls).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: "cancelled" });
  });

  it("maps raw SDK failures to bounded safe events and still cleans up", async () => {
    const fake = fakeFactory("failure");
    const events = await collect(fake.factory);
    expect(events.at(-1)).toMatchObject({
      type: "failed",
      failure: {
        domain: "auth",
        code: "authentication_required",
        safeMessage: "The GitHub Copilot connection requires sign-in",
      },
    });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("ghp_secret");
    expect(serialized).not.toContain("credentials.json");
    expect(fake.sessions[0]?.disconnectCalls).toBe(1);
    expect(fake.stopCalls()).toBe(1);
  });
});
