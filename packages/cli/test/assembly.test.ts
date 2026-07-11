import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  BackendResolver,
  RuntimeApprovalRequest,
  RuntimeContinuationAuthority,
  RuntimeContinuationStore,
  SessionBackendPin,
  TrustedRunContext,
} from "@recurs/contracts";
import {
  bindRunAuthorization,
  DelegatedAgentExecutor,
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
    runtimeApprovals: executorDependencies.runtimeApprovals,
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
      resource: "src/index.ts\n\u001b[31mspoofed",
      summary: "Update\rthe source file",
    })).resolves.toMatchObject({ scope: "allow_once" });
    expect(approvalPrompts.at(-1)).not.toContain("\n");
    expect(approvalPrompts.at(-1)).not.toContain("\r");
    expect(approvalPrompts.at(-1)).not.toContain("\u001b");
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
