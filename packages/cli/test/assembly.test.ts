import { createHash } from "node:crypto";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  AgentRuntime,
  BackendResolver,
  RuntimeApprovalRequest,
  RuntimeContinuationAuthority,
  RuntimeContinuationStore,
  SessionBackendPin,
  TrustedRunContext,
  NativeOpenAIResponsesPort,
} from "@recurs/contracts";
import { createHostInvocation } from "@recurs/contracts";
import {
  ConnectionLifecycleService,
  FileConnectionRegistry,
  type BrokeredModelProviderConnectionRecord,
  type DelegatedConnectionRecord,
} from "@recurs/app";
import {
  bindRunAuthorization,
  CoordinatedRunError,
  DelegatedAgentExecutor,
  JsonlSessionStore,
  verifyRunAuthorization,
} from "@recurs/core";
import { ScriptedProvider } from "@recurs/providers";
import { afterEach, describe, expect, it } from "vitest";

import {
  RuntimeError,
  createStandaloneRuntime,
  writeLocalConnection,
} from "../src/index.js";

const directories: string[] = [];

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

  it("registers single and batch delegation through the assembled provider runtime", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-agent-tools-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    const provider = new ScriptedProvider([[
      { type: "text_delta", text: "ready" },
      { type: "done", stopReason: "complete" },
    ]]);
    const runtime = await createStandaloneRuntime(
      { async emit() {} },
      {
        cwd: workspace,
        dataDirectory: path.join(root, "data"),
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
      "apply_patch",
      "run_command",
      "run_verification",
      "git_status",
      "git_diff",
      "delegate_task",
      "delegate_tasks",
      "delegate_team",
    ]);
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
