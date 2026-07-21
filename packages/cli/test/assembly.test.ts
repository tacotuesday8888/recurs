import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type {
  AgentRuntime,
  BackendResolver,
  RuntimeApprovalRequest,
  RuntimeContinuationAuthority,
  RuntimeContinuationStore,
  SessionBackendPin,
  TrustedRunContext,
  NativeOpenAIResponsesPort,
  TeamRunDescriptor,
  TeamRunPolicySnapshot,
} from "@recurs/contracts";
import { createHostInvocation, getOperatingModePolicy } from "@recurs/contracts";
import {
  ConnectionLifecycleService,
  FileConnectionRegistry,
  setupEnvironmentConnection,
  type BrokeredModelProviderConnectionRecord,
  type DelegatedConnectionRecord,
} from "@recurs/app";
import {
  bindRunAuthorization,
  CoordinatedRunError,
  DelegatedAgentExecutor,
  FileGitPatchArtifactStore,
  JsonlSessionStore,
  JsonlTeamRunStore,
  type RecursEvent,
  verifyRunAuthorization,
} from "@recurs/core";
import { ScriptedProvider } from "@recurs/providers";
import type { PtyDriver } from "@recurs/tools";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RuntimeError,
  createStandaloneRuntime,
  writeLocalConnection,
} from "../src/index.js";

const directories: string[] = [];
const execFileAsync = promisify(execFile);

const codexConnection: DelegatedConnectionRecord = {
  kind: "delegated_agent",
  id: "codex-connection",
  providerId: "openai-codex-chatgpt",
  adapterId: "codex-acp",
  label: "Codex with ChatGPT",
  accountLabel: "owner@example.com",
  organizationLabel: null,
  modelId: "gpt-test",
  accountSubjectFingerprint:
    "sha256:51ad6241d1bfb3fbf43e889bf15530e6ca0c985d6a816d3358c3d356b0a768fa",
  policyRevision: "openai-codex-chatgpt-2026-07-11",
  billingPolicy: {
    revision: "billing:openai-codex-chatgpt:2026-07-11",
    disclosureRevision:
      "billing-disclosure:openai-codex-chatgpt:2026-07-11",
    primarySource: "included_subscription",
    possibleAdditionalSources: ["prepaid_credits"],
    providerFallback: "automatic",
    availableSelections: ["allow_declared_additional"],
  },
  billingSelection: {
    mode: "allow_declared_additional",
    policyRevision: "billing:openai-codex-chatgpt:2026-07-11",
    disclosureRevision:
      "billing-disclosure:openai-codex-chatgpt:2026-07-11",
    allowedSources: ["included_subscription", "prepaid_credits"],
    acknowledgedAt: "2026-07-11T00:00:00.000Z",
  },
  verifiedAt: "2026-07-11T00:00:00.000Z",
  createdAt: "2026-07-11T00:00:00.000Z",
  updatedAt: "2026-07-11T00:00:00.000Z",
};

const brokeredConnection: BrokeredModelProviderConnectionRecord = {
  kind: "brokered_model_provider",
  id: "71000000-0000-4000-8000-000000000001",
  providerId: "openai-api",
  adapterId: "openai-responses",
  activationProfileId: "openai_api_v1",
  label: "OpenAI API",
  modelId: "gpt-5.6-sol",
  credentialIdentityFingerprint: `sha256:${"b".repeat(64)}`,
  policyRevision: "openai-api-2026-07-11",
  billingPolicy: {
    revision: "billing:openai-api:2026-07-11",
    disclosureRevision: "billing-disclosure:openai-api:2026-07-11",
    primarySource: "metered_api",
    possibleAdditionalSources: [],
    providerFallback: "none",
    availableSelections: ["strict_primary_only"],
  },
  billingSelection: {
    mode: "strict_primary_only",
    policyRevision: "billing:openai-api:2026-07-11",
    disclosureRevision: "billing-disclosure:openai-api:2026-07-11",
    allowedSources: ["metered_api"],
    acknowledgedAt: "2026-07-11T00:00:00.000Z",
  },
  verifiedAt: "2026-07-11T00:00:00.000Z",
  createdAt: "2026-07-11T00:00:00.000Z",
  updatedAt: "2026-07-11T00:00:00.000Z",
};

async function writeCodexConnection(directory: string): Promise<void> {
  const registry = new FileConnectionRegistry(directory);
  await registry.commit(0, (draft) => {
    draft.connections.push(structuredClone(codexConnection));
    draft.primaryConnectionId = codexConnection.id;
  });
}

function foundationFor(runtime: Awaited<ReturnType<typeof createStandaloneRuntime>>) {
  const dependencies = Reflect.get(runtime, "dependencies") as {
    coordinator?: {
      dependencies: {
        delegated?: DelegatedAgentExecutor;
        continuationAuthority?: RuntimeContinuationAuthority;
        resolver: BackendResolver & {
          runtimeContinuationStore?: RuntimeContinuationStore;
        };
      };
    };
  };
  const coordinator = dependencies.coordinator;
  const delegated = coordinator?.dependencies.delegated;
  const authority = coordinator?.dependencies.continuationAuthority;
  const runtimeStore = coordinator?.dependencies.resolver
    .runtimeContinuationStore;
  if (
    delegated === undefined || authority === undefined ||
    runtimeStore === undefined
  ) {
    throw new Error("Expected delegated runtime foundation");
  }
  const executorDependencies = Reflect.get(delegated, "dependencies") as {
    continuationAuthority: RuntimeContinuationAuthority;
    approvals: {
      request(intent: {
        category: "write";
        resource: string;
        risk: "elevated";
      }): Promise<unknown>;
    };
    runtimeApprovals: {
      request(request: RuntimeApprovalRequest): Promise<unknown>;
    };
  };
  return {
    delegated,
    authority,
    runtimeStore,
    resolver: coordinator.dependencies.resolver,
    executorAuthority: executorDependencies.continuationAuthority,
    toolApprovals: executorDependencies.approvals,
    runtimeApprovals: executorDependencies.runtimeApprovals,
  };
}

function resolverFor(
  runtime: Awaited<ReturnType<typeof createStandaloneRuntime>>,
): BackendResolver {
  const dependencies = Reflect.get(runtime, "dependencies") as {
    coordinator?: { dependencies: { resolver: BackendResolver } };
  };
  const resolver = dependencies.coordinator?.dependencies.resolver;
  if (resolver === undefined) throw new Error("Expected backend resolver");
  return resolver;
}

function localContext(): TrustedRunContext {
  return {
    invocation: "repl",
    presence: "present",
    location: "local",
    automation: "manual",
    embedding: "cli",
  };
}

function localManualInvocation() {
  return createHostInvocation({
    invocation: "repl",
    userPresent: true,
    remote: false,
    scripted: false,
    embedding: "cli",
  });
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("standalone assembly without a provider", () => {
  it("loads a delegated Codex record into a Plan-only immutable runtime pin", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-codex-assembly-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    const dataDirectory = path.join(root, "data");
    await writeCodexConnection(dataDirectory);
    let runtimeRuns = 0;
    const fakeRuntime: AgentRuntime = {
      adapterId: "codex-acp",
      connectionId: codexConnection.id,
      capabilityProfileRevision:
        "codex-acp-1.1.2-codex-0.144.0-plan-only-v2",
      capabilities: {
        resume: true,
        cancellation: "protocol",
        fileEvents: true,
        usageEvents: true,
        supportedPermissionModes: [
          "ask_always",
          "approved_for_me",
          "full_access",
        ],
        approvalControl: "host",
        planMode: "enforced",
        toolExecution: "opaque",
        checkpointing: "none",
      },
      async *run() {
        runtimeRuns += 1;
        yield {
          type: "failed",
          failure: {
            domain: "runtime",
            phase: "started",
            code: "runtime_failed",
            safeMessage: "Fake delegated runtime stopped",
            diagnosticId: "fake-runtime",
            retryable: false,
          },
        };
      },
      async reconcile() { return "uncertain"; },
    };

    const runtime = await createStandaloneRuntime(
      { async emit() {} },
      {
        cwd: workspace,
        dataDirectory,
        delegatedRuntimeFactory() { return fakeRuntime; },
      },
    );

    expect(runtime.state).toMatchObject({
      type: "session",
      session: {
        executionMode: "plan",
        model: "gpt-test",
        backend: {
          type: "pinned",
          pin: {
            kind: "agent_runtime",
            providerId: "openai-codex-chatgpt",
            adapterId: "codex-acp",
            connectionId: codexConnection.id,
            primaryBillingSourceAtCreation: "included_subscription",
            runtimeCapabilityProfileRevisionAtCreation:
              "codex-acp-1.1.2-codex-0.144.0-plan-only-v2",
          },
        },
      },
    });
    await expect(runtime.submit("/status")).resolves.toMatchObject({
      text: expect.stringContaining("Codex (Plan-only)"),
    });

    await expect(runtime.submit("implicit programmatic request")).rejects
      .toMatchObject({
        failure: { domain: "policy", code: "policy_blocked" },
      });
    expect(runtimeRuns).toBe(0);
    expect(runtime.session.messages).toEqual([]);

    const oneShot = createHostInvocation({
      invocation: "one_shot",
      userPresent: false,
      remote: false,
      scripted: true,
      embedding: "cli",
    });
    await expect(runtime.submit("unattended request", oneShot)).rejects
      .toMatchObject({
        failure: { domain: "policy", code: "policy_blocked" },
      });
    expect(runtimeRuns).toBe(0);
    expect(runtime.session.messages).toEqual([]);

    await runtime.submit("/plan exit");
    await expect(runtime.submit("unsafe Act request")).rejects
      .toBeInstanceOf(CoordinatedRunError);
    expect(runtimeRuns).toBe(0);
    expect(runtime.session.messages).toEqual([]);
  });

  it("loads a configured local connection into an exact pinned session", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-local-assembly-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    const dataDirectory = path.join(root, "data");
    const connection = await writeLocalConnection(dataDirectory, {
      baseUrl: "http://127.0.0.1:11434/v1",
      modelId: "qwen-coder",
      now: "2026-07-11T00:00:00.000Z",
    });

    const runtime = await createStandaloneRuntime(
      { async emit() {} },
      { cwd: workspace, dataDirectory },
    );

    expect(runtime.state).toMatchObject({
      type: "session",
      session: {
        model: "qwen-coder",
        backend: {
          type: "pinned",
          pin: {
            providerId: "local-openai-compatible",
            adapterId: "openai-chat-completions",
            connectionId: connection.id,
            primaryBillingSourceAtCreation: "local_compute",
          },
        },
      },
    });
  });

  it("creates a fresh direct session with Plan authority from sequence zero", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-plan-assembly-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    const dataDirectory = path.join(root, "data");
    await writeLocalConnection(dataDirectory, {
      baseUrl: "http://127.0.0.1:11434/v1",
      modelId: "qwen-coder",
      now: "2026-07-21T00:00:00.000Z",
    });

    const runtime = await createStandaloneRuntime(
      { async emit() {} },
      {
        cwd: workspace,
        dataDirectory,
        executionMode: "plan",
        permissionMode: "approved_for_me",
        reuseExistingSession: false,
      },
    );

    expect(runtime.session).toMatchObject({
      lastSequence: 0,
      executionMode: "plan",
      permissionMode: "approved_for_me",
      agent: {
        role: "parent",
        permissions: {
          parentExecutionMode: "plan",
          executionMode: "plan",
          parentPermissionMode: "approved_for_me",
          permissionMode: "approved_for_me",
        },
      },
    });
    await runtime.submit("/plan exit");
    expect(runtime.session).toMatchObject({
      lastSequence: 1,
      executionMode: "act",
      permissionMode: "approved_for_me",
    });
  });

  it("switches saved models by creating a fresh pinned session without changing primary", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-model-switch-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    const dataDirectory = path.join(root, "data");
    const first = await writeLocalConnection(dataDirectory, {
      baseUrl: "http://127.0.0.1:11434/v1",
      modelId: "model-a",
      now: "2026-07-20T00:00:00.000Z",
    });
    const second = await writeLocalConnection(dataDirectory, {
      baseUrl: "http://127.0.0.1:1234/v1",
      modelId: "model-b",
      now: "2026-07-20T00:01:00.000Z",
    });
    const runtime = await createStandaloneRuntime(
      { async emit() {} },
      {
        cwd: workspace,
        dataDirectory,
        operatingModeId: "performance_v5",
        permissionMode: "approved_for_me",
        reuseExistingSession: false,
      },
    );
    const originalSessionId = runtime.session.id;
    runtime.setConfirmHandler(async () => true);
    await runtime.submit("/plan");

    expect(await runtime.submit("/model")).toMatchObject({
      text: expect.stringMatching(
        new RegExp(`${first.id}.*model-a.*active.*primary[\\s\\S]*${second.id}.*model-b`, "u"),
      ),
    });
    expect(await runtime.submit(
      `/model ${second.id}`,
      localManualInvocation(),
    )).toMatchObject({
      text: expect.stringContaining("The previous session remains available"),
    });
    expect(runtime.session).toMatchObject({
      id: expect.not.stringMatching(new RegExp(`^${originalSessionId}$`, "u")),
      model: "model-b",
      executionMode: "plan",
      permissionMode: "approved_for_me",
      agent: { operatingMode: { id: "performance_v5", version: 5 } },
      backend: { pin: { connectionId: second.id } },
    });
    expect(await new FileConnectionRegistry(dataDirectory).read()).toMatchObject({
      primaryConnectionId: first.id,
    });

    await runtime.submit(`/resume ${originalSessionId}`);
    expect(runtime.session).toMatchObject({
      id: originalSessionId,
      model: "model-a",
      backend: { pin: { connectionId: first.id } },
    });
    expect(await runtime.submit(
      `/model ${first.id}`,
      localManualInvocation(),
    )).toMatchObject({
      text: "That exact model connection is already active",
      level: "warning",
    });
  });

  it("runs through an explicit cross-platform environment BYOK provider", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-environment-assembly-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    const key = "environment-key-canary";
    let authorization = "";
    const runtime = await createStandaloneRuntime(
      { async emit() {} },
      {
        cwd: workspace,
        dataDirectory: path.join(root, "data"),
        environment: {
          RECURS_PROVIDER: "openrouter-api",
          RECURS_MODEL: "provider/model",
          RECURS_API_KEY: key,
        },
        environmentFetch: async (_input, init) => {
          authorization = new Headers(init?.headers).get("authorization") ?? "";
          return new Response([
            'data: {"choices":[{"delta":{"content":"ready"},"finish_reason":"stop"}]}',
            'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1}}',
            "data: [DONE]",
            "",
          ].join("\n\n"), { status: 200 });
        },
      },
    );

    expect(runtime.session.backend.pin).toMatchObject({
      providerId: "openrouter-api",
      adapterId: "openai-chat-completions",
      connectionId: "environment:openrouter-api",
      modelId: "provider/model",
      primaryBillingSourceAtCreation: "prepaid_credits",
      accountSubjectFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    expect(JSON.stringify(runtime.session)).not.toContain(key);

    const result = await runtime.submit("Respond when ready");

    expect(result).toMatchObject({ finalText: "ready" });
    expect(authorization).toBe(`Bearer ${key}`);
    expect(JSON.stringify(runtime.session)).not.toContain(key);
  });

  it("runs the agent loop through explicit OpenAI Responses environment BYOK", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-openai-responses-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    const key = "openai-environment-key-canary";
    let requestUrl = "";
    let requestBody = "";
    const sse = (sequence: number, type: string, body: Record<string, unknown>) =>
      `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence, ...body })}`;
    const added = {
      id: "msg_1",
      type: "message",
      status: "in_progress",
      role: "assistant",
      content: [],
    };
    const completed = {
      ...added,
      status: "completed",
      content: [{ type: "output_text", text: "responses ready", annotations: [] }],
    };
    const runtime = await createStandaloneRuntime(
      { async emit() {} },
      {
        cwd: workspace,
        dataDirectory: path.join(root, "data"),
        environment: {
          RECURS_PROVIDER: "openai-api",
          RECURS_MODEL: "gpt-5.6-terra",
          RECURS_API_KEY: key,
        },
        environmentFetch: async (input, init) => {
          requestUrl = String(input);
          requestBody = String(init?.body ?? "");
          return new Response([
            sse(0, "response.created", {
              response: { id: "resp_1", status: "in_progress", output: [] },
            }),
            sse(1, "response.in_progress", {
              response: { id: "resp_1", status: "in_progress", output: [] },
            }),
            sse(2, "response.output_item.added", { output_index: 0, item: added }),
            sse(3, "response.content_part.added", {
              item_id: "msg_1",
              output_index: 0,
              content_index: 0,
              part: { type: "output_text", text: "", annotations: [] },
            }),
            sse(4, "response.output_text.delta", {
              item_id: "msg_1",
              output_index: 0,
              content_index: 0,
              delta: "responses ready",
            }),
            sse(5, "response.output_text.done", {
              item_id: "msg_1",
              output_index: 0,
              content_index: 0,
              text: "responses ready",
            }),
            sse(6, "response.content_part.done", {
              item_id: "msg_1",
              output_index: 0,
              content_index: 0,
              part: { type: "output_text", text: "responses ready", annotations: [] },
            }),
            sse(7, "response.output_item.done", { output_index: 0, item: completed }),
            sse(8, "response.completed", {
              response: {
                id: "resp_1",
                status: "completed",
                output: [completed],
                usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
              },
            }),
          ].join("\n\n") + "\n\n", {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        },
      },
    );

    expect(runtime.session.backend.pin).toMatchObject({
      providerId: "openai-api",
      adapterId: "openai-responses",
      connectionId: "environment:openai-api",
      modelId: "gpt-5.6-terra",
      primaryBillingSourceAtCreation: "metered_api",
    });
    await expect(runtime.submit("Respond when ready")).resolves.toMatchObject({
      finalText: "responses ready",
    });
    expect(requestUrl).toBe("https://api.openai.com/v1/responses");
    expect(requestBody).not.toContain(key);
    expect(JSON.stringify(runtime.session)).not.toContain(key);
    expect(runtime.session.messages.at(-1)).toMatchObject({ role: "assistant" });
    expect(runtime.session.messages.at(-1)).not.toHaveProperty("providerStateHandle");
  });

  it("runs through an explicit Anthropic Messages environment BYOK provider", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-anthropic-assembly-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    const key = "anthropic-environment-key-canary";
    let requestUrl = "";
    let apiKey = "";
    let version = "";
    let body = "";
    const runtime = await createStandaloneRuntime(
      { async emit() {} },
      {
        cwd: workspace,
        dataDirectory: path.join(root, "data"),
        environment: {
          RECURS_PROVIDER: "anthropic-api",
          RECURS_MODEL: "claude-test",
          RECURS_API_KEY: key,
        },
        environmentFetch: async (input, init) => {
          requestUrl = String(input);
          const headers = new Headers(init?.headers);
          apiKey = headers.get("x-api-key") ?? "";
          version = headers.get("anthropic-version") ?? "";
          body = String(init?.body ?? "");
          const event = (type: string, value: Record<string, unknown>) =>
            `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
          return new Response([
            event("message_start", {
              message: {
                id: "msg_1",
                type: "message",
                role: "assistant",
                model: "claude-test",
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 2, output_tokens: 1 },
              },
            }),
            event("content_block_start", {
              index: 0,
              content_block: { type: "text", text: "" },
            }),
            event("content_block_delta", {
              index: 0,
              delta: { type: "text_delta", text: "anthropic ready" },
            }),
            event("content_block_stop", { index: 0 }),
            event("message_delta", {
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 3 },
            }),
            event("message_stop", {}),
          ].join(""), { status: 200 });
        },
      },
    );

    expect(runtime.session.backend.pin).toMatchObject({
      providerId: "anthropic-api",
      adapterId: "anthropic-messages",
      connectionId: "environment:anthropic-api",
      modelId: "claude-test",
      primaryBillingSourceAtCreation: "metered_api",
    });
    await expect(runtime.submit("Respond when ready")).resolves.toMatchObject({
      finalText: "anthropic ready",
    });
    expect(requestUrl).toBe("https://api.anthropic.com/v1/messages");
    expect(apiKey).toBe(key);
    expect(version).toBe("2023-06-01");
    expect(body).not.toContain(key);
    expect(JSON.stringify(runtime.session)).not.toContain(key);
  });

  it("runs the agent loop through explicit Gemini environment BYOK", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-gemini-assembly-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    const key = "gemini-environment-key-canary";
    let requestUrl = "";
    let apiKey = "";
    let body = "";
    const runtime = await createStandaloneRuntime(
      { async emit() {} },
      {
        cwd: workspace,
        dataDirectory: path.join(root, "data"),
        environment: {
          RECURS_PROVIDER: "google-gemini-api",
          RECURS_MODEL: "gemini-test",
          RECURS_API_KEY: key,
        },
        environmentFetch: async (input, init) => {
          requestUrl = String(input);
          apiKey = new Headers(init?.headers).get("x-goog-api-key") ?? "";
          body = String(init?.body ?? "");
          return new Response(`data: ${JSON.stringify({
            candidates: [{
              index: 0,
              content: { role: "model", parts: [{ text: "gemini ready" }] },
              finishReason: "STOP",
            }],
            usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 2 },
          })}\n\n`, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        },
      },
    );

    expect(runtime.session.backend.pin).toMatchObject({
      providerId: "google-gemini-api",
      adapterId: "gemini-generate-content",
      connectionId: "environment:google-gemini-api",
      modelId: "gemini-test",
      primaryBillingSourceAtCreation: "metered_api",
    });
    await expect(runtime.submit("Respond when ready")).resolves.toMatchObject({
      finalText: "gemini ready",
    });
    expect(requestUrl).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:streamGenerateContent?alt=sse",
    );
    expect(apiKey).toBe(key);
    expect(body).not.toContain(key);
    expect(JSON.stringify(runtime.session)).not.toContain(key);
  });

  it("runs a saved BYOK account only with the exact configured environment credential", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-saved-byok-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    const dataDirectory = path.join(root, "data");
    const key = "saved-environment-key-canary";
    const connection = await setupEnvironmentConnection(dataDirectory, {
      providerId: "deepseek-api",
      modelId: "deepseek-chat",
      credentialEnvironmentVariable: "DEEPSEEK_API_KEY",
      billingSelection: "strict_primary_only",
      environment: { DEEPSEEK_API_KEY: key },
      now: "2026-07-19T00:00:00.000Z",
    }, {
      fetch: async () => new Response(JSON.stringify({
        object: "list",
        data: [{ id: "deepseek-chat", object: "model" }],
      })),
    });
    let authorization = "";
    const runtime = await createStandaloneRuntime(
      { async emit() {} },
      {
        cwd: workspace,
        dataDirectory,
        environment: { DEEPSEEK_API_KEY: key },
        environmentFetch: async (_input, init) => {
          authorization = new Headers(init?.headers).get("authorization") ?? "";
          return new Response([
            'data: {"choices":[{"delta":{"content":"saved ready"},"finish_reason":"stop"}]}',
            'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":2}}',
            "data: [DONE]",
            "",
          ].join("\n\n"), { status: 200 });
        },
      },
    );

    expect(runtime.session.backend.pin).toMatchObject({
      connectionId: connection.id,
      providerId: "deepseek-api",
      modelId: "deepseek-chat",
      primaryBillingSourceAtCreation: "metered_api",
    });
    await expect(runtime.submit("Respond when ready")).resolves.toMatchObject({
      finalText: "saved ready",
    });
    expect(authorization).toBe(`Bearer ${key}`);
    expect(JSON.stringify(runtime.session)).not.toContain(key);

    for (const environment of [
      {},
      { DEEPSEEK_API_KEY: "changed-environment-key" },
    ]) {
      const unavailable = await createStandaloneRuntime(
        { async emit() {} },
        { cwd: workspace, dataDirectory, environment },
      );
      expect(unavailable.state.type).toBe("workspace");
      await expect(unavailable.submit("must not run")).rejects.toMatchObject({
        code: "provider_not_configured",
        message: expect.stringContaining("DEEPSEEK_API_KEY"),
      });
    }

    await expect(createStandaloneRuntime(
      { async emit() {} },
      {
        cwd: workspace,
        dataDirectory,
        environment: {},
        resumeSessionId: runtime.session.id,
      },
    )).rejects.toMatchObject({
      code: "provider_not_configured",
      message: expect.stringContaining("pinned provider connection"),
    });
  });

  it("pins and reports a saved OpenAI reasoning effort without changing the credential boundary", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-saved-effort-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    const dataDirectory = path.join(root, "data");
    const key = "saved-openai-effort-key-canary";
    const connection = await setupEnvironmentConnection(dataDirectory, {
      providerId: "openai-api",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "max",
      credentialEnvironmentVariable: "OPENAI_API_KEY",
      billingSelection: "strict_primary_only",
      environment: { OPENAI_API_KEY: key },
      now: "2026-07-20T00:00:00.000Z",
    }, {
      fetch: async () => new Response(JSON.stringify({
        object: "list",
        data: [{ id: "gpt-5.6-sol", object: "model" }],
      })),
    });
    const runtime = await createStandaloneRuntime(
      { async emit() {} },
      {
        cwd: workspace,
        dataDirectory,
        environment: { OPENAI_API_KEY: key },
      },
    );

    expect(runtime.session.backend.pin).toMatchObject({
      connectionId: connection.id,
      modelId: "gpt-5.6-sol",
      reasoningEffortAtCreation: "max",
    });
    expect(await runtime.submit("/status")).toMatchObject({
      text: expect.stringContaining("Reasoning effort: max"),
    });
    expect(await runtime.submit("/model")).toMatchObject({
      text: expect.stringContaining("effort: max"),
    });
    expect(JSON.stringify(runtime.session)).not.toContain(key);
  });

  it("reopens the canonical parent instead of newer non-root or other-cwd sessions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-root-session-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    const childWorkspace = path.join(root, "child-worktree");
    await import("node:fs/promises").then(({ mkdir }) =>
      Promise.all([mkdir(workspace), mkdir(childWorkspace)])
    );
    const repositoryRoot = await realpath(workspace);
    const dataDirectory = path.join(root, "data");
    await writeLocalConnection(dataDirectory, {
      baseUrl: "http://127.0.0.1:11434/v1",
      modelId: "qwen-coder",
      now: "2026-07-11T00:00:00.000Z",
    });
    const parent = await createStandaloneRuntime(
      { async emit() {} },
      { cwd: repositoryRoot, dataDirectory },
    );
    const projectId = createHash("sha256")
      .update(repositoryRoot)
      .digest("hex")
      .slice(0, 24);
    const sessions = new JsonlSessionStore(
      path.join(dataDirectory, "projects", projectId, "sessions"),
    );
    await sessions.createPinnedSession({
      id: "newer-child-session",
      cwd: repositoryRoot,
      backend: parent.session.backend.pin,
      at: "9998-12-31T23:59:59.999Z",
      agent: {
        id: "newer-child-agent",
        role: "child",
        profile: { id: "review_v1", version: 1 },
        parentAgentId: parent.session.agent.id,
        parentSessionId: parent.session.id,
        depth: 1,
        task: {
          id: "newer-child-task",
          description: "Review the parent change",
          prompt: "Review the parent change",
        },
        operatingMode: parent.session.agent.operatingMode,
        backend: {
          strategy: "inherit_parent",
          adapterId: parent.session.backend.pin.adapterId,
          connectionId: parent.session.backend.pin.connectionId,
          modelId: parent.session.backend.pin.modelId,
        },
        permissions: {
          parentExecutionMode: "act",
          executionMode: "act",
          parentPermissionMode: "ask_always",
          permissionMode: "ask_always",
        },
        limits: parent.session.agent.limits,
      },
    });
    await sessions.createPinnedSession({
      id: "newer-other-cwd-parent-session",
      cwd: childWorkspace,
      backend: parent.session.backend.pin,
      at: "9999-12-31T23:59:59.999Z",
    });

    const restarted = await createStandaloneRuntime(
      { async emit() {} },
      { cwd: repositoryRoot, dataDirectory },
    );

    expect(restarted.session.id).toBe(parent.session.id);
    expect(restarted.session.agent.role).toBe("parent");
    expect(restarted.session.cwd).toBe(repositoryRoot);

    const fresh = await createStandaloneRuntime(
      { async emit() {} },
      { cwd: repositoryRoot, dataDirectory, reuseExistingSession: false },
    );
    expect(fresh.session.id).not.toBe(parent.session.id);

    const beforeExactResume = await sessions.list();
    const exact = await createStandaloneRuntime(
      { async emit() {} },
      {
        cwd: repositoryRoot,
        dataDirectory,
        resumeSessionId: parent.session.id,
        reuseExistingSession: false,
      },
    );
    expect(exact.session.id).toBe(parent.session.id);
    expect(await sessions.list()).toHaveLength(beforeExactResume.length);

    await expect(createStandaloneRuntime(
      { async emit() {} },
      {
        cwd: repositoryRoot,
        dataDirectory,
        resumeSessionId: "newer-child-session",
      },
    )).rejects.toMatchObject({
      code: "invalid_input",
      message: "Only a durable parent session can be resumed from one-shot mode",
    });
    await expect(createStandaloneRuntime(
      { async emit() {} },
      {
        cwd: repositoryRoot,
        dataDirectory,
        resumeSessionId: parent.session.id,
        permissionMode: "full_access",
      },
    )).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("keeps its existing connection"),
    });
    await expect(createStandaloneRuntime(
      { async emit() {} },
      {
        cwd: repositoryRoot,
        dataDirectory,
        resumeSessionId: parent.session.id,
        connectionId: parent.session.backend.pin.connectionId,
      },
    )).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("keeps its existing connection"),
    });
  });

  it("reconciles a prepared apply before stale provider policy blocks startup", async () => {
    const root = await realpath(
      await mkdtemp(path.join(tmpdir(), "recurs-team-restart-")),
    );
    directories.push(root);
    const workspace = path.join(root, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    await execFileAsync("git", ["init", "--quiet"], { cwd: workspace });
    await writeFile(path.join(workspace, "value.txt"), "before\n", "utf8");
    await execFileAsync("git", ["add", "value.txt"], { cwd: workspace });
    await execFileAsync("git", [
      "-c", "user.name=Recurs Tests",
      "-c", "user.email=tests@recurs.invalid",
      "commit", "--quiet", "-m", "initial",
    ], { cwd: workspace });
    const repositoryRoot = await realpath(workspace);
    const revision = (await execFileAsync(
      "git",
      ["rev-parse", "HEAD"],
      { cwd: repositoryRoot },
    )).stdout.trim();
    const dataDirectory = path.join(root, "data");
    const providerId = "team-restart-provider";
    const first = await createStandaloneRuntime(
      { async emit() {} },
      {
        cwd: repositoryRoot,
        dataDirectory,
        provider: new ScriptedProvider([], providerId),
      },
    );
    const projectId = createHash("sha256")
      .update(repositoryRoot)
      .digest("hex")
      .slice(0, 24);
    const teamRuns = new JsonlTeamRunStore(path.join(
      dataDirectory,
      "projects",
      projectId,
      "team-runs",
    ));
    const mode = structuredClone(
      getOperatingModePolicy("balanced_v4"),
    ) as TeamRunPolicySnapshot;
    const descriptor: TeamRunDescriptor = {
      id: "restart-team",
      version: 1,
      parentSessionId: first.session.id,
      parentAgentId: first.session.agent.id,
      execution: "background",
      parentExecutionMode: "act",
      parentPermissionMode: "full_access",
      invocation: {
        invocation: "repl",
        presence: "present",
        location: "local",
        automation: "manual",
        embedding: "cli",
      },
      operatingModeId: mode.id,
      operatingModeVersion: mode.version,
      policy: mode,
      allocation: {
        maxChildren: mode.workflow.maxChildrenPerRun,
        maxRequests: mode.workflow.maxRequestsPerRun,
        requestAllowance: 8,
        maxReportedCostUsd: mode.orchestration.maxReportedCostUsd,
      },
      routes: ([
        ["implement", "implement_v2"],
        ["review", "review_v2"],
        ["repair", "repair_v1"],
      ] as const).map(([role, profileId]) => ({
        role,
        profileId,
        executionMode: "act",
        permissionMode: "full_access",
        strategy: "inherit_parent",
        candidateId: "parent-session-pin",
        reason: "parent_fallback",
        pin: first.session.backend.pin,
      })),
      backend: first.session.backend.pin,
      repositoryRoot,
      baseRevision: revision,
      request: {
        description: "Recover the interrupted team",
        tasks: [{ description: "Implement value", prompt: "Change value.txt" }],
        review: { instructions: "Review the result" },
      },
    };
    await teamRuns.create(descriptor, "2026-07-18T00:00:00.000Z");
    await teamRuns.append("restart-team", 0, {
      type: "run_claimed",
      ownerId: "dead-owner",
      claimEpoch: 1,
      at: "2026-07-18T00:00:01.000Z",
    });
    await teamRuns.append("restart-team", 1, {
      type: "phase_started",
      phase: "implement",
      round: 0,
      at: "2026-07-18T00:00:02.000Z",
    });
    await teamRuns.append("restart-team", 2, {
      type: "child_reserved",
      child: {
        attemptId: "implement-attempt",
        role: "implement",
        index: 1,
        round: 0,
        childAgentId: "implement-agent",
        childSessionId: "implement-session",
        requestAllowance: 8,
      },
      at: "2026-07-18T00:00:03.000Z",
    });
    await teamRuns.append("restart-team", 3, {
      type: "child_finished",
      child: {
        attemptId: "implement-attempt",
        status: "completed",
        requestsUsed: 1,
        usage: null,
        usageSource: "unavailable",
        changedFiles: ["value.txt"],
        evidence: ["implementation completed"],
        failure: null,
      },
      at: "2026-07-18T00:00:04.000Z",
    });
    const candidatePatch = [
      "diff --git a/value.txt b/value.txt",
      "index 1111111..2222222 100644",
      "--- a/value.txt",
      "+++ b/value.txt",
      "@@ -1 +1 @@",
      "-before",
      "+after",
      "",
    ].join("\n");
    const candidate = {
      id: "restart-candidate",
      leaseId: "stale-stage-lease",
      baseRevision: revision,
      sha256: createHash("sha256").update(candidatePatch).digest("hex"),
      byteLength: Buffer.byteLength(candidatePatch, "utf8"),
      paths: ["value.txt"],
    } as const;
    const artifactStore = new FileGitPatchArtifactStore(path.join(
      dataDirectory,
      "projects",
      projectId,
      "team-patch-artifacts",
    ));
    await artifactStore.put({
      handle: candidate,
      repositoryRoot,
      patch: candidatePatch,
      after: [{
        path: "value.txt",
        kind: "file",
        sha256: createHash("sha256").update("after\n").digest("hex"),
        byteLength: 6,
        mode: "100644",
      }],
    });
    await teamRuns.append("restart-team", 4, {
      type: "artifact_linked",
      artifact: {
        kind: "worker",
        handle: { ...candidate, id: "restart-worker", leaseId: "stale-worker-lease" },
        round: 0,
        attemptId: "implement-attempt",
      },
      at: "2026-07-18T00:00:05.000Z",
    });
    await teamRuns.append("restart-team", 5, {
      type: "phase_started",
      phase: "stage",
      round: 0,
      at: "2026-07-18T00:00:06.000Z",
    });
    await teamRuns.append("restart-team", 6, {
      type: "phase_started",
      phase: "review",
      round: 0,
      at: "2026-07-18T00:00:07.000Z",
    });
    await teamRuns.append("restart-team", 7, {
      type: "child_reserved",
      child: {
        attemptId: "review-attempt",
        role: "review",
        index: 1,
        round: 0,
        childAgentId: "review-agent",
        childSessionId: "review-session",
        requestAllowance: 8,
      },
      at: "2026-07-18T00:00:08.000Z",
    });
    await teamRuns.append("restart-team", 8, {
      type: "child_finished",
      child: {
        attemptId: "review-attempt",
        status: "completed",
        requestsUsed: 1,
        usage: null,
        usageSource: "unavailable",
        changedFiles: [],
        evidence: ["review completed"],
        failure: null,
      },
      at: "2026-07-18T00:00:09.000Z",
    });
    await teamRuns.append("restart-team", 9, {
      type: "review_recorded",
      review: {
        round: 0,
        verdict: "approved",
        findings: [],
        evidence: ["review completed"],
      },
      at: "2026-07-18T00:00:10.000Z",
    });
    await teamRuns.append("restart-team", 10, {
      type: "artifact_linked",
      artifact: {
        kind: "staged_candidate",
        handle: candidate,
        round: 0,
        attemptId: null,
      },
      at: "2026-07-18T00:00:11.000Z",
    });
    await teamRuns.append("restart-team", 11, {
      type: "candidate_ready",
      artifact: candidate,
      changedFiles: ["value.txt"],
      at: "2026-07-18T00:00:12.000Z",
    });
    await teamRuns.append("restart-team", 12, {
      type: "phase_started",
      phase: "apply",
      round: 0,
      at: "2026-07-18T00:00:13.000Z",
    });
    await teamRuns.append("restart-team", 13, {
      type: "apply_prepared",
      checkpoint: {
        id: "restart-checkpoint",
        sessionId: first.session.id,
        toolCallId: "restart-team",
      },
      at: "2026-07-18T00:00:14.000Z",
    });
    await writeCodexConnection(dataDirectory);
    const registry = new FileConnectionRegistry(dataDirectory);
    const document = await registry.read();
    await registry.commit(document.revision, (draft) => {
      const connection = draft.connections.find((item) =>
        item.id === codexConnection.id
      );
      if (connection?.kind !== "delegated_agent") {
        throw new Error("Expected the stale Codex fixture");
      }
      connection.policyRevision = "stale-policy";
    });
    const events: RecursEvent[] = [];

    await expect(createStandaloneRuntime(
      { async emit(event) { events.push(event); } },
      {
        cwd: repositoryRoot,
        dataDirectory,
      },
    )).rejects.toMatchObject({ code: "policy_stale" });

    expect(await teamRuns.load("restart-team")).toMatchObject({
      status: "ready_to_apply",
      interruption: null,
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "agent_team_activity",
      teamId: "restart-team",
      activity: "apply_reset",
      status: "ready_to_apply",
    }));

    let recovered = await teamRuns.load("restart-team");
    const restartedApplyAt = new Date(
      Date.parse(recovered.updatedAt) + 1,
    ).toISOString();
    recovered = await teamRuns.append("restart-team", recovered.lastSequence, {
      type: "phase_started",
      phase: "apply",
      round: 0,
      at: restartedApplyAt,
    });
    await teamRuns.append("restart-team", recovered.lastSequence, {
      type: "apply_prepared",
      checkpoint: {
        id: "restart-checkpoint-2",
        sessionId: first.session.id,
        toolCallId: "restart-team",
      },
      at: new Date(Date.parse(restartedApplyAt) + 1).toISOString(),
    });
    await artifactStore.remove([candidate]);

    let startupFailure: unknown;
    try {
      await createStandaloneRuntime(
        { async emit(event) { events.push(event); } },
        { cwd: repositoryRoot, dataDirectory },
      );
    } catch (error) {
      startupFailure = error;
    }
    expect(startupFailure).toMatchObject({ code: "execution_failed" });
    const failedState = await teamRuns.load("restart-team");
    expect(failedState).toMatchObject({
      status: "interrupted",
      interruption: {
        manualAttentionRequired: true,
      },
    });
    const safeReason = failedState.interruption?.reason;
    expect(safeReason).toMatch(/^Team recovery /u);
    expect((startupFailure as Error).message).toBe(
      `Durable team recovery failed for restart-team: ${safeReason}`,
    );
    expect((startupFailure as Error).message).not.toContain(root);
  });

  it("starts a current session when stored connection metadata changed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-current-pin-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    const dataDirectory = path.join(root, "data");
    const connection = await writeLocalConnection(dataDirectory, {
      baseUrl: "http://127.0.0.1:11434/v1",
      modelId: "qwen-coder",
      now: "2026-07-11T00:00:00.000Z",
    });
    const historical = await createStandaloneRuntime(
      { async emit() {} },
      { cwd: workspace, dataDirectory },
    );
    const historicalFingerprint =
      historical.session.backend.pin.accountSubjectFingerprint;

    const registry = new FileConnectionRegistry(dataDirectory);
    const current = await registry.read();
    await registry.commit(current.revision, (draft) => {
      const record = draft.connections.find(
        (candidate) => candidate.id === connection.id,
      );
      if (record?.kind !== "local_openai_compatible") {
        throw new Error("missing local fixture");
      }
      record.baseUrl = "http://127.0.0.1:1234/v1";
      record.updatedAt = "2026-07-12T00:00:00.000Z";
    });

    const restarted = await createStandaloneRuntime(
      { async emit() {} },
      { cwd: workspace, dataDirectory },
    );

    expect(restarted.session.id).not.toBe(historical.session.id);
    expect(restarted.session.backend.pin).toMatchObject({
      connectionId: connection.id,
      modelId: "qwen-coder",
    });
    expect(restarted.session.backend.pin.accountSubjectFingerprint).not.toBe(
      historicalFingerprint,
    );
  });

  it("starts in a workspace shell without creating a fake session", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-workspace-shell-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    const dataDirectory = path.join(root, "data");
    const runtime = await createStandaloneRuntime(
      { async emit() {} },
      { cwd: workspace, dataDirectory },
    );

    expect(runtime.state).toMatchObject({
      type: "workspace",
      cwd: await realpath(workspace),
      permissionMode: "ask_always",
    });
    expect(await runtime.submit("/status")).toMatchObject({
      text: expect.stringContaining("No active session"),
    });
    const help = await runtime.submit("/help");
    expect(help).toMatchObject({ text: expect.stringContaining("/connect") });
    expect(help).not.toMatchObject({ text: expect.stringContaining("/goal") });
    expect(await runtime.submit("/goal ship it")).toMatchObject({
      level: "error",
      text: expect.stringContaining("requires an active model session"),
    });
    await expect(runtime.submit("inspect the project")).rejects.toEqual(
      new RuntimeError(
        "provider_not_configured",
        "No model connection is ready. Run recurs setup in an interactive terminal, then try again.",
      ),
    );

    const files = await readdir(dataDirectory, { recursive: true }).catch(() => []);
    expect(files.filter((file) => file.endsWith(".jsonl"))).toEqual([]);
  });

  it("pins guided permission and operating-mode choices into a fresh session", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-guided-permission-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));

    const runtime = await createStandaloneRuntime(
      { async emit() {} },
      {
        cwd: workspace,
        dataDirectory: path.join(root, "data"),
        provider: new ScriptedProvider([], "guided-provider"),
        operatingModeId: "performance_v5",
        permissionMode: "approved_for_me",
        reuseExistingSession: false,
      },
    );

    expect(runtime.state).toMatchObject({
      type: "session",
      session: {
        permissionMode: "approved_for_me",
        agent: {
          operatingMode: { id: "performance_v5", version: 5 },
          permissions: {
            parentPermissionMode: "approved_for_me",
            permissionMode: "approved_for_me",
          },
        },
      },
    });
  });

  it("keeps a brokered provider unavailable until run activation is wired", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-brokered-disabled-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    const dataDirectory = path.join(root, "data");
    const registry = new FileConnectionRegistry(dataDirectory);
    await registry.commit(0, (draft) => {
      draft.connections.push(structuredClone(brokeredConnection));
      draft.primaryConnectionId = brokeredConnection.id;
    });

    const runtime = await createStandaloneRuntime(
      { async emit() {} },
      { cwd: workspace, dataDirectory },
    );

    expect(runtime.state).toMatchObject({ type: "workspace" });
    await expect(runtime.submit("inspect")).rejects.toEqual(
      new RuntimeError(
        "provider_not_configured",
        "The selected brokered provider is connected, but brokered provider execution is not available yet.",
      ),
    );
  });

  it("runs a brokered OpenAI connection only through an injected native port", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-brokered-native-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    const dataDirectory = path.join(root, "data");
    const registry = new FileConnectionRegistry(dataDirectory);
    await registry.commit(0, (draft) => {
      draft.connections.push(structuredClone(brokeredConnection));
      draft.primaryConnectionId = brokeredConnection.id;
    });
    let receivedContext: unknown;
    const nativeOpenAIResponses: NativeOpenAIResponsesPort = {
      async *streamOpenAIResponses(request) {
        receivedContext = request.directContext;
        yield { type: "text_delta", text: "native complete" };
        yield { type: "usage", inputTokens: 2, outputTokens: 2 };
        yield { type: "done", stopReason: "complete" };
      },
    };
    const runtime = await createStandaloneRuntime(
      { async emit() {} },
      { cwd: workspace, dataDirectory, nativeOpenAIResponses },
    );

    await expect(runtime.submit("inspect")).resolves.toMatchObject({
      finalText: "native complete",
    });
    expect(receivedContext).toMatchObject({
      authorization: {
        operation: "run",
        connectionId: brokeredConnection.id,
        modelId: brokeredConnection.modelId,
      },
      expectedSessionRecordSequence: 1,
    });
  });

  it("runs a brokered Anthropic connection through the shared native port", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-anthropic-native-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    const dataDirectory = path.join(root, "data");
    const connection: BrokeredModelProviderConnectionRecord = {
      ...structuredClone(brokeredConnection),
      providerId: "anthropic-api",
      adapterId: "anthropic-messages",
      activationProfileId: "anthropic_api_v1",
      label: "Anthropic API",
      modelId: "claude-opus-4-6",
      policyRevision: "anthropic-api-2026-07-11",
      billingPolicy: {
        ...structuredClone(brokeredConnection.billingPolicy),
        revision: "billing:anthropic-api:2026-07-11",
        disclosureRevision: "billing-disclosure:anthropic-api:2026-07-11",
      },
      billingSelection: {
        ...structuredClone(brokeredConnection.billingSelection),
        policyRevision: "billing:anthropic-api:2026-07-11",
        disclosureRevision: "billing-disclosure:anthropic-api:2026-07-11",
      },
    };
    const registry = new FileConnectionRegistry(dataDirectory);
    await registry.commit(0, (draft) => {
      draft.connections.push(connection);
      draft.primaryConnectionId = connection.id;
    });
    let adapterId: string | undefined;
    const nativeOpenAIResponses: NativeOpenAIResponsesPort = {
      async *streamOpenAIResponses(_request, adapter) {
        adapterId = adapter;
        yield { type: "text_delta", text: "anthropic complete" };
        yield { type: "done", stopReason: "complete" };
      },
    };
    const runtime = await createStandaloneRuntime(
      { async emit() {} },
      { cwd: workspace, dataDirectory, nativeOpenAIResponses },
    );

    await expect(runtime.submit("inspect")).resolves.toMatchObject({
      finalText: "anthropic complete",
    });
    expect(adapterId).toBe("anthropic-messages");
  });

  it("does not choose a saved connection when no primary is explicit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-no-primary-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    const dataDirectory = path.join(root, "data");
    const registry = new FileConnectionRegistry(dataDirectory);
    await registry.commit(0, (draft) => {
      draft.connections.push({
        kind: "local_openai_compatible",
        id: "saved-secondary",
        providerId: "local-openai-compatible",
        adapterId: "openai-chat-completions",
        label: "Saved secondary",
        baseUrl: "http://127.0.0.1:11434/v1",
        modelId: "qwen",
        createdAt: "2026-07-12T00:00:00.000Z",
        updatedAt: "2026-07-12T00:00:00.000Z",
      });
    });

    const runtime = await createStandaloneRuntime(
      { async emit() {} },
      { cwd: workspace, dataDirectory },
    );

    expect(runtime.state).toMatchObject({ type: "workspace" });
    expect(await registry.read()).toMatchObject({
      primaryConnectionId: null,
      connections: [{ id: "saved-secondary" }],
    });
    runtime.setConfirmHandler(async () => true);
    expect(await runtime.submit(
      "/model saved-secondary",
      localManualInvocation(),
    )).toMatchObject({ text: expect.stringContaining("Started session") });
    expect(runtime.state).toMatchObject({
      type: "session",
      session: {
        model: "qwen",
        backend: { pin: { connectionId: "saved-secondary" } },
      },
    });
    expect(await registry.read()).toMatchObject({ primaryConnectionId: null });

    const headless = await createStandaloneRuntime(
      { async emit() {} },
      {
        cwd: workspace,
        dataDirectory,
        connectionId: "saved-secondary",
        reuseExistingSession: false,
      },
    );
    expect(headless.state).toMatchObject({
      type: "session",
      session: {
        model: "qwen",
        backend: { pin: { connectionId: "saved-secondary" } },
      },
    });
    expect(await registry.read()).toMatchObject({ primaryConnectionId: null });
    await expect(createStandaloneRuntime(
      { async emit() {} },
      { cwd: workspace, dataDirectory, connectionId: "missing" },
    )).rejects.toMatchObject({
      code: "invalid_input",
      message: "The requested saved connection was not found",
    });
    await expect(createStandaloneRuntime(
      { async emit() {} },
      {
        cwd: workspace,
        dataDirectory,
        connectionId: "saved-secondary",
        provider: new ScriptedProvider([]),
      },
    )).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("process-scoped provider"),
    });
  });

  it("resolves an old session by its immutable connection pin after primary changes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-pin-routing-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    const dataDirectory = path.join(root, "data");
    const firstConnection = await writeLocalConnection(dataDirectory, {
      baseUrl: "http://127.0.0.1:11434/v1",
      modelId: "model-a",
      now: "2026-07-12T00:00:00.000Z",
    });
    const secondConnection = await writeLocalConnection(dataDirectory, {
      baseUrl: "http://127.0.0.1:1234/v1",
      modelId: "model-b",
      now: "2026-07-12T00:01:00.000Z",
    });
    const firstRuntime = await createStandaloneRuntime(
      { async emit() {} },
      { cwd: workspace, dataDirectory },
    );
    const firstPin = structuredClone(firstRuntime.session.backend.pin);
    expect(firstPin).toMatchObject({
      connectionId: firstConnection.id,
      modelId: "model-a",
      accountSubjectFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    expect(firstPin.accountSubjectFingerprint).not.toContain(firstConnection.id);

    const registry = new FileConnectionRegistry(dataDirectory);
    await new ConnectionLifecycleService(registry).setPrimary(
      secondConnection.id,
    );
    const secondRuntime = await createStandaloneRuntime(
      { async emit() {} },
      { cwd: workspace, dataDirectory },
    );
    expect(secondRuntime.session.backend.pin.connectionId).toBe(
      secondConnection.id,
    );
    const resolver = resolverFor(secondRuntime);
    const input = {
      operation: "run" as const,
      operationId: "old-session-operation",
      sessionId: firstRuntime.session.id,
      turnId: "old-session-turn",
      pin: firstPin,
      context: localContext(),
      signal: new AbortController().signal,
    };

    await expect(resolver.resolve(input)).resolves.toMatchObject({
      kind: "direct",
      pin: firstPin,
      authorization: {
        connectionRevision: (await registry.read()).revision,
      },
    });

    const original = await registry.read();
    await registry.commit(original.revision, (draft) => {
      const record = draft.connections.find(
        (connection) => connection.id === firstConnection.id,
      );
      if (record?.kind !== "local_openai_compatible") {
        throw new Error("missing local fixture");
      }
      record.baseUrl = "http://127.0.0.1:9999/v1";
    });
    await expect(resolver.resolve(input)).rejects.toMatchObject({
      domain: "connection",
      phase: "preflight",
      code: "connection_invalid",
    });

    const changed = await registry.read();
    await registry.commit(changed.revision, (draft) => {
      const index = draft.connections.findIndex(
        (connection) => connection.id === firstConnection.id,
      );
      draft.connections.splice(index, 1);
    });
    await expect(resolver.resolve(input)).rejects.toMatchObject({
      domain: "connection",
      phase: "preflight",
      code: "connection_invalid",
    });
  });

  it("uses pinned version 2 sessions for an explicitly injected provider", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-pinned-assembly-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    const runtime = await createStandaloneRuntime(
      { async emit() {} },
      {
        cwd: workspace,
        dataDirectory: path.join(root, "data"),
        provider: new ScriptedProvider([
          [
            { type: "text_delta", text: "done" },
            { type: "done", stopReason: "complete" },
          ],
        ]),
      },
    );

    expect(runtime.state).toMatchObject({
      type: "session",
      session: { version: 2, backend: { type: "pinned" } },
    });
    await runtime.submit("/goal inspect safely");
    await expect(runtime.submit("inspect")).resolves.toMatchObject({
      finalText: "done",
    });
    expect(runtime.session.version).toBe(2);
    expect(runtime.session.goal).toMatchObject({
      objective: "inspect safely",
      progress: "done",
    });
  });

  it("creates distinct pinned sessions when host isolation disables reuse", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-isolated-session-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    const provider = new ScriptedProvider([]);
    const options = {
      cwd: workspace,
      dataDirectory: path.join(root, "data"),
      provider,
      reuseExistingSession: false,
    } as const;

    const first = await createStandaloneRuntime({ async emit() {} }, options);
    const second = await createStandaloneRuntime({ async emit() {} }, options);

    expect(second.session.id).not.toBe(first.session.id);
    expect(second.session.backend.pin).toMatchObject({
      kind: first.session.backend.pin.kind,
      providerId: first.session.backend.pin.providerId,
      adapterId: first.session.backend.pin.adapterId,
      connectionId: first.session.backend.pin.connectionId,
      modelId: first.session.backend.pin.modelId,
    });
  });

  it("assembles tools and reloads project instructions once per new turn", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-agent-tools-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    await writeFile(path.join(workspace, "AGENTS.md"), "first project policy\n");
    const provider = new ScriptedProvider([
      [
        { type: "text_delta", text: "ready" },
        { type: "done", stopReason: "complete" },
      ],
      [
        { type: "text_delta", text: "updated" },
        { type: "done", stopReason: "complete" },
      ],
    ]);
    const runtime = await createStandaloneRuntime(
      { async emit() {} },
      {
        cwd: workspace,
        dataDirectory: path.join(root, "data"),
        skillHomeDirectory: path.join(root, "home"),
        provider,
      },
    );

    await expect(runtime.submit("inspect available tools")).resolves.toMatchObject({
      finalText: "ready",
    });
    expect(provider.requests[0]?.tools.map((tool) => tool.name)).toEqual([
      "read_file",
      "list_files",
      "search_text",
      "code_outline",
      "typescript_diagnostics",
      "web_fetch",
      "apply_patch",
      "run_command",
      "process_session",
      "run_verification",
      "git_status",
      "git_diff",
      "git_history",
      "git_show",
      "delegate_task",
      "delegate_tasks",
      "delegate_team",
      "team_status",
      "wait_team",
      "cancel_team",
      "resume_team",
      "apply_team",
    ]);
    expect(JSON.stringify(provider.requests[0]?.messages))
      .toContain("first project policy");

    await writeFile(path.join(workspace, "AGENTS.md"), "second project policy\n");
    await expect(runtime.submit("inspect the updated context")).resolves
      .toMatchObject({ finalText: "updated" });
    expect(JSON.stringify(provider.requests[1]?.messages))
      .toContain("second project policy");
    expect(JSON.stringify(provider.requests[1]?.messages))
      .not.toContain("first project policy");
  });

  it("routes a model clarification through the local runtime host", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-user-input-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    const provider = new ScriptedProvider([
      [
        {
          type: "tool_call",
          call: {
            id: "question-1",
            name: "request_user_input",
            arguments: {
              question: "Which package should I change?",
              options: ["Core", "CLI"],
            },
          },
        },
        { type: "done", stopReason: "tool_calls" },
      ],
      [
        { type: "text_delta", text: "I will change the CLI." },
        { type: "done", stopReason: "complete" },
      ],
    ]);
    const runtime = await createStandaloneRuntime(
      { async emit() {} },
      {
        cwd: workspace,
        dataDirectory: path.join(root, "data"),
        skillHomeDirectory: path.join(root, "home"),
        provider,
      },
    );
    const ask = vi.fn(async () => "CLI");
    runtime.setUserInputHandler(ask);

    await expect(runtime.submit("implement it", localManualInvocation())).resolves
      .toMatchObject({ finalText: "I will change the CLI." });
    expect(provider.requests[0]?.tools.map((tool) => tool.name))
      .toContain("request_user_input");
    expect(ask).toHaveBeenCalledWith({
      question: "Which package should I change?",
      options: ["Core", "CLI"],
    }, expect.any(AbortSignal));
    expect(provider.requests[1]?.messages.findLast(
      (message) => message.role === "tool",
    )?.content).toContain('"answer":"CLI"');
  });

  it("returns bounded TypeScript diagnostics to a model in Plan mode", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-ts-diagnostics-assembly-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    await writeFile(path.join(workspace, "tsconfig.json"), JSON.stringify({
      compilerOptions: { strict: true },
      files: ["index.ts"],
    }));
    await writeFile(
      path.join(workspace, "index.ts"),
      "const answer: number = 'wrong';\n",
    );
    const provider = new ScriptedProvider([
      [
        {
          type: "tool_call",
          call: {
            id: "diagnostics-1",
            name: "typescript_diagnostics",
            arguments: {},
          },
        },
        { type: "done", stopReason: "tool_calls" },
      ],
      [
        { type: "text_delta", text: "The project has a type error." },
        { type: "done", stopReason: "complete" },
      ],
    ]);
    const runtime = await createStandaloneRuntime(
      { async emit() {} },
      {
        cwd: workspace,
        dataDirectory: path.join(root, "data"),
        skillHomeDirectory: path.join(root, "home"),
        provider,
        executionMode: "plan",
        permissionMode: "full_access",
      },
    );

    await expect(runtime.submit("type-check the project")).resolves
      .toMatchObject({ finalText: "The project has a type error." });
    expect(provider.requests[0]?.tools.map((tool) => tool.name))
      .toContain("typescript_diagnostics");
    expect(provider.requests[0]?.tools.map((tool) => tool.name))
      .not.toContain("apply_patch");
    const result = provider.requests[1]?.messages.findLast(
      (message) => message.role === "tool",
    );
    expect(result?.content).toContain("error TS2322");
    expect(result?.content).toContain("Type 'string' is not assignable to type 'number'");
  });

  it("returns structured bounded regex search evidence in Plan mode", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-search-assembly-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    await writeFile(
      path.join(workspace, "feature.ts"),
      "export const feature42 = true;\nexport const other = false;\n",
    );
    const provider = new ScriptedProvider([
      [
        {
          type: "tool_call",
          call: {
            id: "search-1",
            name: "search_text",
            arguments: {
              query: String.raw`feature\d+`,
              mode: "regex",
              glob: "*.ts",
              limit: 5,
            },
          },
        },
        { type: "done", stopReason: "tool_calls" },
      ],
      [
        { type: "text_delta", text: "I found the feature declaration." },
        { type: "done", stopReason: "complete" },
      ],
    ]);
    const runtime = await createStandaloneRuntime(
      { async emit() {} },
      {
        cwd: workspace,
        dataDirectory: path.join(root, "data"),
        skillHomeDirectory: path.join(root, "home"),
        provider,
        executionMode: "plan",
        permissionMode: "full_access",
      },
    );

    await expect(runtime.submit("find numbered feature declarations")).resolves
      .toMatchObject({ finalText: "I found the feature declaration." });
    expect(provider.requests[0]?.tools.map((tool) => tool.name))
      .toContain("search_text");
    expect(provider.requests[0]?.tools.map((tool) => tool.name))
      .not.toContain("apply_patch");
    const result = provider.requests[1]?.messages.findLast(
      (message) => message.role === "tool",
    );
    expect(result?.content).toContain('"path":"feature.ts"');
    expect(result?.content).toContain('"line":1');
    expect(result?.content).toContain("feature42");
  });

  it("returns bounded Git history and commit evidence in Plan mode", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-git-history-assembly-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    await execFileAsync("git", ["init", "--quiet"], { cwd: workspace });
    await writeFile(path.join(workspace, "feature.ts"), "export const ready = true;\n");
    await execFileAsync("git", ["add", "feature.ts"], { cwd: workspace });
    await execFileAsync("git", [
      "-c",
      "user.name=Recurs Test",
      "-c",
      "user.email=recurs@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "add the feature boundary",
    ], { cwd: workspace });
    const commit = (await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: workspace,
    })).stdout.trim();
    const provider = new ScriptedProvider([
      [
        {
          type: "tool_call",
          call: {
            id: "history-1",
            name: "git_history",
            arguments: { limit: 1 },
          },
        },
        { type: "done", stopReason: "tool_calls" },
      ],
      [
        {
          type: "tool_call",
          call: {
            id: "show-1",
            name: "git_show",
            arguments: { commit },
          },
        },
        { type: "done", stopReason: "tool_calls" },
      ],
      [
        { type: "text_delta", text: "The feature boundary is committed." },
        { type: "done", stopReason: "complete" },
      ],
    ]);
    const runtime = await createStandaloneRuntime(
      { async emit() {} },
      {
        cwd: workspace,
        dataDirectory: path.join(root, "data"),
        skillHomeDirectory: path.join(root, "home"),
        provider,
        executionMode: "plan",
        permissionMode: "full_access",
      },
    );

    await expect(runtime.submit("inspect recent history")).resolves
      .toMatchObject({ finalText: "The feature boundary is committed." });
    expect(provider.requests[0]?.tools.map((tool) => tool.name))
      .toContain("git_history");
    expect(provider.requests[0]?.tools.map((tool) => tool.name))
      .not.toContain("apply_patch");
    expect(provider.requests[1]?.messages.findLast(
      (message) => message.role === "tool",
    )?.content).toContain("add the feature boundary");
    expect(provider.requests[2]?.messages.findLast(
      (message) => message.role === "tool",
    )?.content).toContain("+export const ready = true;");
  });

  it("lets the owner write to and close a yielded command", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-process-owner-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    await execFileAsync("git", ["init"], { cwd: workspace });
    const script = [
      "process.stdout.write('ready\\n');",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', value => process.stdout.write('input:' + value));",
    ].join("");
    const provider = new ScriptedProvider([
      [
        {
          type: "tool_call",
          call: {
            id: "owned-process-call",
            name: "run_command",
            arguments: {
              command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
              timeoutMs: 30_000,
              yieldTimeMs: 250,
            },
          },
        },
        { type: "done", stopReason: "tool_calls" },
      ],
      [
        { type: "text_delta", text: "Background command started." },
        { type: "done", stopReason: "complete" },
      ],
    ]);
    const runtime = await createStandaloneRuntime(
      { async emit() {} },
      {
        cwd: workspace,
        dataDirectory: path.join(root, "data"),
        skillHomeDirectory: path.join(root, "home"),
        provider,
        permissionMode: "full_access",
      },
    );
    try {
      await expect(runtime.submit("start the watcher")).resolves.toMatchObject({
        finalText: "Background command started.",
      });
      expect(provider.requests[1]?.messages.findLast(
        (message) => message.role === "tool",
      )?.content).toContain("ready");
      const listed = await runtime.submit("/process");
      expect(listed).toMatchObject({
        type: "message",
        level: "info",
        text: expect.stringMatching(
          /^[0-9a-f-]{36} · running · piped(?: · \d+ buffered bytes)?$/u,
        ),
      });
      if (listed.type !== "message") throw new Error("Expected process list");
      const sessionId = listed.text.split(" · ")[0]!;
      await expect(runtime.submit(`/process ${sessionId} enter hello`)).resolves
        .toMatchObject({
          type: "message",
          text: expect.stringContaining("input:hello"),
        });
      await expect(runtime.submit(`/process ${sessionId} close`)).resolves
        .toMatchObject({
          type: "message",
          text: expect.stringContaining("Process exited with code 0."),
        });
    } finally {
      await runtime.close().catch(() => {});
    }
  });

  it("routes an explicit terminal command through the injected PTY boundary", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-pty-assembly-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    await execFileAsync("git", ["init", "--quiet"], { cwd: workspace });
    let dataListener: ((data: string) => void) | undefined;
    let exitListener: ((event: { exitCode: number }) => void) | undefined;
    const spawnPty = vi.fn(() => {
      queueMicrotask(() => {
        dataListener?.("terminal-output\r\n");
        exitListener?.({ exitCode: 0 });
      });
      return {
        pid: 2_000_000_000,
        onData(listener: (data: string) => void) {
          dataListener = listener;
          return { dispose() { dataListener = undefined; } };
        },
        onExit(listener: (event: { exitCode: number }) => void) {
          exitListener = listener;
          return { dispose() { exitListener = undefined; } };
        },
        write() {},
        resize() {},
        kill() {},
      };
    });
    const ptyDriver: PtyDriver = { spawn: spawnPty };
    const provider = new ScriptedProvider([
      [
        {
          type: "tool_call",
          call: {
            id: "terminal-command-call",
            name: "run_command",
            arguments: {
              command: "terminal-command",
              tty: true,
              timeoutMs: 5_000,
              yieldTimeMs: 1_000,
            },
          },
        },
        { type: "done", stopReason: "tool_calls" },
      ],
      [
        { type: "text_delta", text: "Terminal command completed." },
        { type: "done", stopReason: "complete" },
      ],
    ]);
    const runtime = await createStandaloneRuntime(
      { async emit() {} },
      {
        cwd: workspace,
        dataDirectory: path.join(root, "data"),
        skillHomeDirectory: path.join(root, "home"),
        provider,
        permissionMode: "full_access",
        ptyDriver,
      },
    );
    try {
      await expect(runtime.submit("run the terminal command")).resolves
        .toMatchObject({ finalText: "Terminal command completed." });
      expect(spawnPty).toHaveBeenCalledOnce();
      const launch = spawnPty.mock.calls[0];
      expect([launch?.[0], ...(launch?.[1] ?? [])].join(" "))
        .toContain("terminal-command");
      expect(launch?.[2]).toEqual(expect.objectContaining({
        columns: 120,
        rows: 30,
        cwd: await realpath(workspace),
      }));
      expect(provider.requests[1]?.messages.findLast(
        (message) => message.role === "tool",
      )?.content).toContain("terminal-output");
    } finally {
      await runtime.close();
    }
  });

  it("routes exact v4 team calls through the assembled durable supervisor", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-v4-team-assembly-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    const provider = new ScriptedProvider([
      [
        {
          type: "tool_call",
          call: {
            id: "durable-team-call",
            name: "delegate_team",
            arguments: {
              description: "Implement three bounded slices",
              tasks: [1, 2, 3].map((index) => ({
                description: `Implement slice ${index}`,
                prompt: `Change slice ${index}.`,
              })),
              review: { instructions: "Review the complete candidate." },
            },
          },
        },
        { type: "done", stopReason: "tool_calls" },
      ],
      [
        { type: "text_delta", text: "The durable v4 policy rejected excess width." },
        { type: "done", stopReason: "complete" },
      ],
    ]);
    const runtime = await createStandaloneRuntime(
      { async emit() {} },
      {
        cwd: workspace,
        dataDirectory: path.join(root, "data"),
        provider,
      },
    );
    runtime.setConfirmHandler(async () => true);
    await runtime.submit("/agents mode balanced_v4");

    await expect(runtime.submit("Run the requested team.")).resolves.toMatchObject({
      finalText: "The durable v4 policy rejected excess width.",
    });

    const toolFeedback = JSON.stringify(provider.requests[1]?.messages ?? []);
    expect(toolFeedback).toContain("supports at most 2 Implement workers");
    expect(toolFeedback).not.toContain("Legacy team execution");
  });

  it("freezes an explicitly configured secondary model into the v5 Implement route", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-v5-model-route-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    await execFileAsync("git", ["init", "--quiet"], { cwd: workspace });
    await writeFile(path.join(workspace, "README.md"), "base\n", "utf8");
    await execFileAsync("git", ["add", "README.md"], { cwd: workspace });
    await execFileAsync("git", [
      "-c", "user.name=Recurs Tests",
      "-c", "user.email=tests@recurs.invalid",
      "commit", "--quiet", "-m", "initial",
    ], { cwd: workspace });
    const dataDirectory = path.join(root, "data");
    const worker: BrokeredModelProviderConnectionRecord = {
      ...structuredClone(brokeredConnection),
      id: "72000000-0000-4000-8000-000000000002",
      providerId: "anthropic-api",
      adapterId: "anthropic-messages",
      activationProfileId: "anthropic_api_v1",
      label: "Anthropic worker",
      modelId: "claude-opus-4-6",
      policyRevision: "anthropic-api-2026-07-11",
      credentialIdentityFingerprint: `sha256:${"c".repeat(64)}`,
      billingPolicy: {
        ...structuredClone(brokeredConnection.billingPolicy),
        revision: "billing:anthropic-api:2026-07-11",
        disclosureRevision: "billing-disclosure:anthropic-api:2026-07-11",
      },
      billingSelection: {
        ...structuredClone(brokeredConnection.billingSelection),
        policyRevision: "billing:anthropic-api:2026-07-11",
        disclosureRevision: "billing-disclosure:anthropic-api:2026-07-11",
      },
    };
    const registry = new FileConnectionRegistry(dataDirectory);
    await registry.commit(0, (draft) => {
      draft.connections.push(structuredClone(brokeredConnection), worker);
      draft.primaryConnectionId = brokeredConnection.id;
      draft.agentRoutes = { ...draft.agentRoutes, implement: worker.id };
    });
    let parentCalls = 0;
    const nativeOpenAIResponses: NativeOpenAIResponsesPort = {
      async *streamOpenAIResponses(request) {
        const connectionId = request.directContext?.authorization.connectionId;
        if (connectionId === worker.id) {
          yield { type: "text_delta", text: "Worker inspected the task." };
          yield { type: "done", stopReason: "complete" };
          return;
        }
        parentCalls += 1;
        if (parentCalls === 1) {
          yield {
            type: "tool_call",
            call: {
              id: "route-team-call",
              name: "delegate_team",
              arguments: {
                description: "Prove model routing",
                tasks: [{
                  description: "Inspect the candidate",
                  prompt: "Inspect the repository without changing it.",
                }],
                review: { instructions: "Review the candidate." },
              },
            },
          };
          yield { type: "done", stopReason: "tool_calls" };
          return;
        }
        yield { type: "text_delta", text: "Routing attempt recorded." };
        yield { type: "done", stopReason: "complete" };
      },
    };
    const runtime = await createStandaloneRuntime(
      { async emit() {} },
      {
        cwd: workspace,
        dataDirectory,
        nativeOpenAIResponses,
      },
    );
    runtime.setConfirmHandler(async () => true);

    await expect(runtime.submit("Run the configured team.")).resolves.toMatchObject({
      finalText: "Routing attempt recorded.",
    });
    const projectId = createHash("sha256")
      .update(await realpath(workspace))
      .digest("hex")
      .slice(0, 24);
    const store = new JsonlTeamRunStore(path.join(
      dataDirectory,
      "projects",
      projectId,
      "team-runs",
    ));
    const [entry] = await store.list(runtime.session.id);
    if (entry === undefined) throw new Error("Expected a routed team run");
    const state = await store.load(entry.id);
    expect(state.descriptor.operatingModeId).toBe("balanced_v5");
    expect(state.descriptor.routes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "implement",
        strategy: "role_candidate",
        candidateId: `configured-${createHash("sha256").update(worker.id).digest("hex").slice(0, 32)}`,
        pin: expect.objectContaining({
          connectionId: worker.id,
          modelId: worker.modelId,
        }),
      }),
      expect.objectContaining({
        role: "review",
        strategy: "inherit_parent",
        candidateId: "parent-session-pin",
      }),
    ]));
  });

  it("assembles one shared delegated continuation foundation per runtime", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-delegated-foundation-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    const options = {
      cwd: workspace,
      dataDirectory: path.join(root, "data"),
      provider: new ScriptedProvider([], "foundation-provider"),
    };
    const runtime = await createStandaloneRuntime({ async emit() {} }, options);
    const secondRuntime = await createStandaloneRuntime(
      { async emit() {} },
      { ...options, dataDirectory: path.join(root, "data-2") },
    );
    const foundation = foundationFor(runtime);
    const secondFoundation = foundationFor(secondRuntime);

    expect(foundation.delegated).toBeInstanceOf(DelegatedAgentExecutor);
    expect(foundation.executorAuthority).toBe(foundation.authority);
    expect(foundation.authority.ownerInstanceId).not.toBe(
      secondFoundation.authority.ownerInstanceId,
    );

    const approvalPrompts: string[] = [];
    runtime.setConfirmHandler(async (message) => {
      approvalPrompts.push(message);
      return true;
    });
    const request: RuntimeApprovalRequest = {
      requestId: "approval-1",
      action: "write",
      resource: "src/index.ts",
      risk: "elevated",
      summary: "Update a source file",
      options: [
        { optionId: "always", name: "Always", kind: "allow_always" },
        { optionId: "allow-exact", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-exact", name: "Reject", kind: "reject_once" },
      ],
    };
    await expect(foundation.runtimeApprovals.request(request)).resolves.toEqual({
      decision: { outcome: "selected", optionId: "allow-exact" },
      scope: "allow_once",
    });
    await expect(foundation.runtimeApprovals.request({
      ...request,
      resource: "src/index.ts\n\u001b[31m\u009b32mspoofed",
      summary: "Update\rthe \u202esource file",
    })).resolves.toMatchObject({ scope: "allow_once" });
    expect(approvalPrompts.at(-1)).not.toContain("\n");
    expect(approvalPrompts.at(-1)).not.toContain("\r");
    expect(approvalPrompts.at(-1)).not.toContain("\u001b");
    expect(approvalPrompts.at(-1)).not.toContain("\u009b");
    expect(approvalPrompts.at(-1)).not.toContain("\u202e");
    await expect(foundation.toolApprovals.request({
      category: "write",
      resource: "src/index.ts\n\u001b]0;spoofed\u0007\u009b31m\u202etxt",
      risk: "elevated",
    })).resolves.toBe("allow_once");
    expect(approvalPrompts.at(-1)).not.toMatch(
      /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u,
    );
    expect(approvalPrompts.at(-1)).toContain("src/index.ts");
    const promptsBeforeCredential = approvalPrompts.length;
    await expect(foundation.runtimeApprovals.request({
      ...request,
      action: "credential",
    })).resolves.toEqual({
      decision: { outcome: "selected", optionId: "reject-exact" },
      scope: "deny",
    });
    expect(approvalPrompts).toHaveLength(promptsBeforeCredential);

    const delegatedPin: SessionBackendPin & { kind: "agent_runtime" } = {
      ...runtime.session.backend.pin,
      kind: "agent_runtime",
      runtimeCapabilityProfileRevisionAtCreation: "foundation-v1",
    };
    const context: TrustedRunContext = {
      invocation: "one_shot",
      presence: "present",
      location: "local",
      automation: "manual",
      embedding: "cli",
    };
    const delegatedAuthorization = bindRunAuthorization({
      id: "foundation-authorization",
      operation: "run",
      operationId: "foundation-operation",
      sessionId: runtime.session.id,
      turnId: "foundation-turn",
      pin: delegatedPin,
      connectionRevision: 1,
      policyRevision: delegatedPin.policyRevisionAtCreation,
      context,
      maxRequests: 1,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const writer = await foundation.authority.mintWriter({
      authorization: delegatedAuthorization,
      pin: delegatedPin,
      expectedSessionRecordSequence: 0,
      previous: null,
      stateVersion: 1,
    });
    await expect(foundation.runtimeStore.put({
      writer,
      payload: new Uint8Array([1]),
    })).resolves.toMatchObject({
      ownerInstanceId: foundation.authority.ownerInstanceId,
    });
  });

  it("issues canonical authorizations accepted for reordered pinned data", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-auth-assembly-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    const runtime = await createStandaloneRuntime(
      { async emit() {} },
      {
        cwd: workspace,
        dataDirectory: path.join(root, "data"),
        provider: new ScriptedProvider([], "canonical-provider"),
      },
    );
    if (runtime.session.backend.type !== "pinned") {
      throw new Error("Expected a pinned test session");
    }
    const pin = runtime.session.backend.pin;
    const reorderedPin = Object.fromEntries(
      Object.entries(pin).reverse(),
    ) as unknown as SessionBackendPin;
    reorderedPin.billingSelectionAtCreation = Object.fromEntries(
      Object.entries(pin.billingSelectionAtCreation).reverse(),
    ) as unknown as SessionBackendPin["billingSelectionAtCreation"];
    const context: TrustedRunContext = {
      embedding: "cli",
      automation: "manual",
      location: "local",
      presence: "present",
      invocation: "repl",
    };
    const dependencies = Reflect.get(runtime, "dependencies") as {
      coordinator: { dependencies: { resolver: BackendResolver } };
    };
    const startedAt = new Date();
    const resolved = await dependencies.coordinator.dependencies.resolver.resolve({
      operation: "run",
      operationId: "operation-canonical",
      sessionId: runtime.session.id,
      turnId: "turn-canonical",
      pin,
      context,
      signal: new AbortController().signal,
    });

    expect(() => verifyRunAuthorization(resolved.authorization, {
      id: resolved.authorization.id,
      operation: "run",
      sessionId: runtime.session.id,
      operationId: "operation-canonical",
      turnId: "turn-canonical",
      pin: reorderedPin,
      connectionRevision: 1,
      policyRevision: pin.policyRevisionAtCreation,
      context,
      maxRequests: 40,
      expiresAt: resolved.authorization.expiresAt,
    }, startedAt)).not.toThrow();
  });

  it("composes a provider runtime with no model tools when tools are disabled", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-tools-disabled-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    const provider = new ScriptedProvider([
      [
        { type: "text_delta", text: "done without tools" },
        { type: "done", stopReason: "complete" },
      ],
    ]);
    const runtime = await createStandaloneRuntime(
      { async emit() {} },
      {
        cwd: workspace,
        dataDirectory: path.join(root, "data"),
        provider,
        toolSecurityProfile: "tools_disabled",
      },
    );

    await expect(runtime.submit("inspect without tools")).resolves.toMatchObject({
      finalText: "done without tools",
    });
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.tools).toEqual([]);
  });

  it("starts a new pinned session instead of rebinding history to another provider", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-provider-pin-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    const options = { cwd: workspace, dataDirectory: path.join(root, "data") };
    const first = await createStandaloneRuntime(
      { async emit() {} },
      { ...options, provider: new ScriptedProvider([], "provider-a") },
    );
    const second = await createStandaloneRuntime(
      { async emit() {} },
      { ...options, provider: new ScriptedProvider([], "provider-b") },
    );

    expect(second.session.id).not.toBe(first.session.id);
    expect(second.session.backend).toMatchObject({
      type: "pinned",
      pin: {
        providerId: "provider-b",
        connectionId: "injected:provider-b",
      },
    });
  });
});
