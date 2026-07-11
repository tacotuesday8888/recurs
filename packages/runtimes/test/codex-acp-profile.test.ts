import { createHash } from "node:crypto";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

import type {
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
  RuntimeContinuationHandle,
  RuntimeContinuationStore,
} from "@recurs/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  CODEX_ACP_ADAPTER_INTEGRITY,
  CODEX_ACP_ADAPTER_VERSION,
  CODEX_ACP_PROFILE_REVISION,
  CODEX_CLI_INTEGRITY,
  CODEX_CLI_VERSION,
  authenticateCodexAcpChatGpt,
  createAcpRuntimeProfile,
  createCodexAcpProfile,
  inspectCodexAcp,
  probeCodexAcp,
  resolveCodexAcpInstallation,
  type AcpRuntimeProfile,
} from "@recurs/runtimes";

const fixture = fileURLToPath(
  new URL("./fixtures/fake-codex-acp-agent.mjs", import.meta.url),
);
const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

function fakeProfile(
  scenario = "existing-chatgpt",
  extraArgs: readonly string[] = [],
): AcpRuntimeProfile {
  return createAcpRuntimeProfile({
    adapterId: "codex-acp",
    connectionId: "codex-test",
    capabilityProfileRevision: CODEX_ACP_PROFILE_REVISION,
    protocol: "acp",
    protocolVersion: 1,
    command: process.execPath,
    args: [fixture, "--scenario", scenario, ...extraArgs],
    clientInfo: { name: "recurs", version: "0.0.0", title: "Recurs" },
    allowedEnvironmentKeys: [],
    usageSemantics: "prompt_response",
    mappings: [
      {
        modelId: "gpt-test",
        executionMode: "plan",
        permissionMode: "ask_always",
        modelSelector: {
          configId: "model",
          value: "gpt-test",
          category: "model",
        },
        executionModeSelector: {
          configId: "mode",
          value: "read-only",
          category: "mode",
        },
        modeId: "read-only",
        configOptions: [
          { configId: "mode", value: "read-only" },
          { configId: "model", value: "gpt-test" },
        ],
      },
    ],
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
    bounds: {
      maxFrameBytes: 128 * 1_024,
      maxStdinBytes: 512 * 1_024,
      maxStdoutBytes: 2 * 1_024 * 1_024,
      maxStderrBytes: 64 * 1_024,
      maxFrames: 2_048,
      maxInboundQueueMessages: 128,
      maxInboundQueueBytes: 512 * 1_024,
      maxEvents: 2_048,
      maxEventBytes: 2 * 1_024 * 1_024,
      maxEventQueueEvents: 128,
      maxEventQueueBytes: 512 * 1_024,
      startupTimeoutMs: 2_000,
      promptTimeoutMs: 2_000,
      cancelSettlementTimeoutMs: 500,
      shutdownTimeoutMs: 500,
    },
  });
}

function fingerprint(email: string): string {
  return `sha256:${createHash("sha256")
    .update(`openai-codex-chatgpt\0${email.toLocaleLowerCase("en-US")}`)
    .digest("hex")}`;
}

async function accountBoundRuntime(
  profile: AcpRuntimeProfile,
  expectedFingerprint: string,
  store: RuntimeContinuationStore,
): Promise<AgentRuntime> {
  const module = await import("@recurs/runtimes") as unknown as {
    createAccountBoundCodexAcpRuntime?: (
      profile: AcpRuntimeProfile,
      expectedFingerprint: string,
      store: RuntimeContinuationStore,
    ) => AgentRuntime;
  };
  const candidate = module.createAccountBoundCodexAcpRuntime;
  if (candidate === undefined) {
    throw new Error("same-process Codex account binding is unavailable");
  }
  return candidate(profile, expectedFingerprint, store);
}

function runtimeRequest(
  overrides: Partial<AgentRunRequest> = {},
  signal = new AbortController().signal,
): AgentRunRequest {
  return {
    sessionId: "recurs-session",
    turnId: "turn-1",
    prompt: "inspect",
    cwd: path.resolve(process.cwd()),
    modelId: "gpt-test",
    executionMode: "plan",
    permissionMode: "ask_always",
    authorization: {
      kind: "run",
      id: "authorization-1",
      operation: "run",
      sessionId: "recurs-session",
      operationId: "operation-1",
      turnId: "turn-1",
      connectionId: "codex-test",
      modelId: "gpt-test",
      backendFingerprint: "sha256:test",
      connectionRevision: 1,
      policyRevision: "policy-v1",
      billingMode: "allow_declared_additional",
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
    ...overrides,
  };
}

function memoryStore(): RuntimeContinuationStore {
  const payloads = new Map<string, Uint8Array>();
  return {
    async put({ payload }) {
      payloads.set("continuation-1", payload.slice());
      return {
        kind: "runtime",
        id: "continuation-1",
        storageClass: "process_scoped",
        ownerInstanceId: "owner-1",
        expiresAt: "2099-01-01T00:00:00.000Z",
        recursSessionId: "recurs-session",
        connectionId: "codex-test",
        adapterId: "codex-acp",
        modelId: "gpt-test",
        backendFingerprint: "sha256:test",
        stateVersion: 1,
        originTurnId: "turn-1",
        continuationSequence: 1,
        status: "uncertain",
        vendorTurnSequence: 1,
      } satisfies RuntimeContinuationHandle;
    },
    async load({ handle }) {
      const payload = payloads.get(handle.id);
      if (payload === undefined) throw new Error("missing continuation");
      return payload.slice();
    },
  };
}

async function collect(
  runtime: AgentRuntime,
  request: AgentRunRequest = runtimeRequest(),
): Promise<AgentRuntimeEvent[]> {
  const events: AgentRuntimeEvent[] = [];
  for await (const event of runtime.run(request, {})) events.push(event);
  return events;
}

describe("official Codex ACP profile", () => {
  it("binds the account on the exact child before any vendor session work", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "recurs-codex-binding-"));
    temporaryDirectories.push(directory);
    const eventsFile = path.join(directory, "events.jsonl");
    const counterFile = path.join(directory, "counter");
    await writeFile(eventsFile, "", { mode: 0o600 });
    const profile = fakeProfile("account-switch-after-preflight", [
      "--event-file",
      eventsFile,
      "--counter-file",
      counterFile,
    ]);

    await expect(inspectCodexAcp(
      profile,
      new AbortController().signal,
    )).resolves.toMatchObject({
      status: { type: "chat-gpt", email: "owner@example.com" },
    });

    const runtime = await accountBoundRuntime(
      profile,
      fingerprint("owner@example.com"),
      memoryStore(),
    );
    await expect(collect(runtime)).resolves.toEqual([
      expect.objectContaining({
        type: "failed",
        failure: expect.objectContaining({
          domain: "auth",
          code: "account_mismatch",
          action: "select_connection",
        }),
      }),
    ]);
    const records = (await readFile(eventsFile, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as {
        pid: number;
        processOrdinal: number;
        method: string;
      });
    const activeChild = records.filter((record) => record.processOrdinal === 3);
    expect(activeChild.map((record) => record.method)).toEqual([
      "initialize",
      "authentication/status",
    ]);
    expect(new Set(activeChild.map((record) => record.pid)).size).toBe(1);
    expect(activeChild.some((record) => record.method === "session/new")).toBe(false);
  });

  it("rechecks the same-child account after setup and before prompting", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "recurs-codex-recheck-"));
    temporaryDirectories.push(directory);
    const eventsFile = path.join(directory, "events.jsonl");
    await writeFile(eventsFile, "", { mode: 0o600 });
    const runtime = await accountBoundRuntime(
      fakeProfile("account-switch-during-setup", ["--event-file", eventsFile]),
      fingerprint("owner@example.com"),
      memoryStore(),
    );

    const events = await collect(runtime);
    expect(events.at(-1)).toMatchObject({
      type: "failed",
      failure: expect.objectContaining({
        domain: "auth",
        code: "account_mismatch",
        action: "select_connection",
      }),
    });
    expect(events.some((event) => event.type === "continuation_updated")).toBe(false);
    const methods = (await readFile(eventsFile, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { method: string }).method);
    expect(methods.filter((method) => method === "authentication/status"))
      .toHaveLength(2);
    expect(methods).not.toContain("session/prompt");
  });

  it("checks the account after continuation loading and immediately before resume", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "recurs-codex-resume-binding-"));
    temporaryDirectories.push(directory);
    const eventsFile = path.join(directory, "events.jsonl");
    const accountFile = path.join(directory, "account");
    await writeFile(eventsFile, "", { mode: 0o600 });
    await writeFile(accountFile, "owner@example.com", { mode: 0o600 });
    const baseStore = memoryStore();
    const store: RuntimeContinuationStore = {
      put: (input) => baseStore.put(input),
      async load() {
        await writeFile(accountFile, "other@example.com", { mode: 0o600 });
        return new TextEncoder().encode(JSON.stringify({
          schemaVersion: 1,
          vendorSessionId: "temporary-vendor-session",
          cwd: path.resolve(process.cwd()),
        }));
      },
    };
    const runtime = await accountBoundRuntime(
      fakeProfile("existing-chatgpt", [
        "--event-file",
        eventsFile,
        "--account-file",
        accountFile,
      ]),
      fingerprint("owner@example.com"),
      store,
    );
    const continuation: RuntimeContinuationHandle = {
      kind: "runtime",
      id: "continuation-resume",
      storageClass: "process_scoped",
      ownerInstanceId: "owner-1",
      expiresAt: "2099-01-01T00:00:00.000Z",
      recursSessionId: "recurs-session",
      connectionId: "codex-test",
      adapterId: "codex-acp",
      modelId: "gpt-test",
      backendFingerprint: "sha256:test",
      stateVersion: 1,
      originTurnId: "turn-seed",
      continuationSequence: 1,
      status: "committed",
      vendorTurnSequence: 1,
    };

    const events = await collect(runtime, runtimeRequest({
      continuation,
      continuationReader: {
        id: "reader-resume",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    }));

    expect(events.at(-1)).toMatchObject({
      type: "failed",
      failure: expect.objectContaining({ code: "account_mismatch" }),
    });
    const methods = (await readFile(eventsFile, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { method: string }).method);
    expect(methods).not.toContain("session/resume");
  });
  it("pins and resolves the reviewed adapter and platform executable without importing it", async () => {
    const installation = resolveCodexAcpInstallation();
    expect(installation).toMatchObject({
      adapterVersion: CODEX_ACP_ADAPTER_VERSION,
      codexVersion: CODEX_CLI_VERSION,
    });
    expect(path.isAbsolute(installation.adapterEntry)).toBe(true);
    expect(installation.adapterEntry).toMatch(/codex-acp\/dist\/index\.js$/u);
    expect(path.isAbsolute(installation.platformPackageJson)).toBe(true);

    const lock = JSON.parse(
      await readFile(path.join(repositoryRoot, "package-lock.json"), "utf8"),
    ) as { packages: Record<string, { version?: string; integrity?: string }> };
    expect(lock.packages["node_modules/@agentclientprotocol/codex-acp"]).toMatchObject({
      version: CODEX_ACP_ADAPTER_VERSION,
      integrity: CODEX_ACP_ADAPTER_INTEGRITY,
    });
    expect(lock.packages["node_modules/@openai/codex"]).toMatchObject({
      version: CODEX_CLI_VERSION,
      integrity: CODEX_CLI_INTEGRITY,
    });
    expect(Object.keys(lock.packages)).not.toContain(
      "node_modules/@zed-industries/codex-acp",
    );
    expect(lock.packages[`node_modules/${installation.platformPackageId}`])
      .toMatchObject({
        version: installation.platformVersion,
        integrity: installation.platformIntegrity,
      });
  });

  it("creates an immutable Plan-only profile with a narrow non-secret environment", () => {
    const profile = createCodexAcpProfile({
      connectionId: "codex-connection",
      modelId: "gpt-test",
    });
    expect(profile.command).toBe(process.execPath);
    expect(profile.args).toHaveLength(1);
    expect(profile.capabilityProfileRevision).toBe(CODEX_ACP_PROFILE_REVISION);
    expect(profile.capabilities).toMatchObject({
      resume: true,
      cancellation: "protocol",
      fileEvents: true,
      usageEvents: true,
      approvalControl: "host",
      planMode: "enforced",
      toolExecution: "opaque",
      checkpointing: "none",
    });
    expect(profile.capabilities.supportedPermissionModes).toEqual([
      "ask_always",
      "approved_for_me",
      "full_access",
    ]);
    expect(profile.mappings).toHaveLength(3);
    expect(profile.mappings.every((mapping) =>
      mapping.executionMode === "plan" &&
      mapping.modeId === "read-only" &&
      mapping.modelSelector.category === "model" &&
      mapping.modelSelector.value === "gpt-test" &&
      mapping.executionModeSelector.category === "mode" &&
      mapping.executionModeSelector.value === "read-only" &&
      mapping.configOptions.some((option) =>
        option.configId === "mode" && option.value === "read-only"
      )
    )).toBe(true);
    for (const forbidden of [
      "APP_SERVER_LOGS",
      "DEFAULT_AUTH_REQUEST",
      "CODEX_PATH",
      "CODEX_CONFIG",
      "MODEL_PROVIDER",
      "INITIAL_AGENT_MODE",
      "DISABLE_MCP_CONFIG_FILTERING",
      "OPENAI_API_KEY",
      "CODEX_API_KEY",
      "HTTP_PROXY",
      "NODE_OPTIONS",
    ]) {
      expect(profile.allowedEnvironmentKeys).not.toContain(forbidden);
    }
    expect(profile.allowedEnvironmentKeys).toContain("CODEX_HOME");
    expect(Object.isFrozen(profile)).toBe(true);
  });

  it("reads only the bounded structured status and authenticates the exact advertised method", async () => {
    await expect(inspectCodexAcp(
      fakeProfile(),
      new AbortController().signal,
    )).resolves.toMatchObject({
      status: { type: "chat-gpt", email: "owner@example.com" },
      inspection: {
        authMethods: expect.arrayContaining([
          { id: "chat-gpt", name: "ChatGPT", type: "agent" },
        ]),
      },
    });
    await expect(authenticateCodexAcpChatGpt(
      fakeProfile("unauthenticated"),
      new AbortController().signal,
    )).resolves.toMatchObject({ authenticatedMethodId: "chat-gpt" });
    await expect(authenticateCodexAcpChatGpt(
      fakeProfile("no-browser"),
      new AbortController().signal,
    )).rejects.toThrow("not advertised");
  });

  it("creates and closes a temporary session after verifying model and read-only mode", async () => {
    await expect(probeCodexAcp({
      profile: fakeProfile(),
      cwd: path.resolve(process.cwd()),
    }, new AbortController().signal)).resolves.toEqual({
      modelId: "gpt-test",
      modeId: "read-only",
      executionMode: "plan",
    });
    await expect(probeCodexAcp({
      profile: fakeProfile(),
      cwd: path.resolve(process.cwd()),
      modelId: "missing-model",
    }, new AbortController().signal)).rejects.toThrow("model");
  });

  it("normalizes secret-bearing errors from status, authentication, and probe operations", async () => {
    const operations = [
      () => inspectCodexAcp(
        fakeProfile("secret-status-error"),
        new AbortController().signal,
      ),
      () => inspectCodexAcp(
        fakeProfile("invalid-secret-status"),
        new AbortController().signal,
      ),
      () => authenticateCodexAcpChatGpt(
        fakeProfile("secret-auth-error"),
        new AbortController().signal,
      ),
      () => probeCodexAcp({
        profile: fakeProfile("secret-session-error"),
        cwd: path.resolve(process.cwd()),
      }, new AbortController().signal),
    ];
    for (const operation of operations) {
      let caught: unknown;
      try {
        await operation();
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({
        name: "AcpOperationError",
        code: "request_rejected",
        message: "The ACP agent rejected the operation",
      });
      expect(String(caught)).not.toContain("SUPER_SECRET");
      expect(JSON.stringify(caught)).not.toContain("SUPER_SECRET");
      expect(caught).not.toHaveProperty("data");
      expect(caught).not.toHaveProperty("cause");
    }
  });
});
