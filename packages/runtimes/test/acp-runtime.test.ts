import { fileURLToPath } from "node:url";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  AgentRunRequest,
  AgentRuntimeEvent,
  ContinuationReadCapability,
  ContinuationWriteCapability,
  RuntimeContinuationHandle,
  RuntimeContinuationStore,
} from "@recurs/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  authenticateAcpRuntime,
  createAcpRuntimeProfile,
  inspectAcpRuntime,
  ManagedAcpRuntime,
  type AcpRuntimeProfile,
} from "@recurs/runtimes";

const fixture = fileURLToPath(
  new URL("./fixtures/fake-acp-agent.mjs", import.meta.url),
);

const cwd = path.resolve(process.cwd());
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

function profile(
  scenario = "happy",
  options: {
    resume?: boolean;
    maxEvents?: number;
    maxEventBytes?: number;
    maxEventQueueEvents?: number;
    maxEventQueueBytes?: number;
    startupTimeoutMs?: number;
    promptTimeoutMs?: number;
    cancelSettlementTimeoutMs?: number;
    shutdownTimeoutMs?: number;
    extraArgs?: readonly string[];
  } = {},
): AcpRuntimeProfile {
  return createAcpRuntimeProfile({
    adapterId: "fake-acp",
    connectionId: "connection-1",
    capabilityProfileRevision: "fake-acp-profile-v1",
    protocol: "acp",
    protocolVersion: 1,
    command: process.execPath,
    args: [
      fixture,
      "--scenario",
      scenario,
      "--expect-client-info",
      ...(options.extraArgs ?? []),
    ],
    clientInfo: { name: "recurs", version: "0.0.0", title: "Recurs" },
    allowedEnvironmentKeys: [],
    usageSemantics: "prompt_response",
    mappings: [
      {
        modelId: "test-model",
        executionMode: "plan",
        permissionMode: "ask_always",
        modelSelector: {
          configId: "model",
          value: "test-model",
          category: "model",
        },
        executionModeSelector: {
          configId: "mode",
          value: "reviewed-plan",
          category: "mode",
        },
        modeId: "reviewed-plan",
        configOptions: [
          { configId: "model", value: "test-model" },
          { configId: "mode", value: "reviewed-plan" },
          { configId: "approval", value: "ask" },
        ],
      },
      {
        modelId: "test-model",
        executionMode: "act",
        permissionMode: "full_access",
        modelSelector: {
          configId: "model",
          value: "test-model",
          category: "model",
        },
        executionModeSelector: {
          configId: "mode",
          value: "reviewed-act",
          category: "mode",
        },
        modeId: "reviewed-act",
        configOptions: [
          { configId: "model", value: "test-model" },
          { configId: "mode", value: "reviewed-act" },
          { configId: "approval", value: "auto" },
        ],
      },
    ],
    capabilities: {
      resume: options.resume ?? true,
      cancellation: "protocol",
      fileEvents: true,
      usageEvents: true,
      supportedPermissionModes: ["ask_always", "full_access"],
      approvalControl: "host",
      planMode: "enforced",
      toolExecution: "opaque",
      checkpointing: "none",
    },
    bounds: {
      maxFrameBytes: 16 * 1_024,
      maxStdinBytes: 128 * 1_024,
      maxStdoutBytes: 128 * 1_024,
      maxStderrBytes: 1_024,
      maxFrames: 256,
      maxInboundQueueMessages: 32,
      maxInboundQueueBytes: 64 * 1_024,
      maxEvents: options.maxEvents ?? 64,
      maxEventBytes: options.maxEventBytes ?? 64 * 1_024,
      maxEventQueueEvents: options.maxEventQueueEvents ?? 32,
      maxEventQueueBytes: options.maxEventQueueBytes ?? 64 * 1_024,
      startupTimeoutMs: options.startupTimeoutMs ?? 1_000,
      promptTimeoutMs: options.promptTimeoutMs ?? 1_000,
      cancelSettlementTimeoutMs: options.cancelSettlementTimeoutMs ?? 500,
      shutdownTimeoutMs: options.shutdownTimeoutMs ?? 300,
    },
  });
}

class MemoryRuntimeStore implements RuntimeContinuationStore {
  readonly payloads = new Map<string, Uint8Array>();
  readonly handles: RuntimeContinuationHandle[] = [];

  async put(input: {
    writer: ContinuationWriteCapability;
    payload: Uint8Array;
  }): Promise<RuntimeContinuationHandle> {
    const id = `runtime-handle-${String(this.handles.length + 1)}`;
    this.payloads.set(id, input.payload.slice());
    const handle: RuntimeContinuationHandle = {
      kind: "runtime",
      id,
      storageClass: "process_scoped",
      ownerInstanceId: "owner-1",
      expiresAt: "2099-01-01T00:00:00.000Z",
      recursSessionId: "session-1",
      connectionId: "connection-1",
      adapterId: "fake-acp",
      modelId: "test-model",
      backendFingerprint: "sha256:test",
      stateVersion: 1,
      originTurnId: "turn-1",
      continuationSequence: this.handles.length + 1,
      status: "uncertain",
      vendorTurnSequence: this.handles.length + 1,
    };
    this.handles.push(handle);
    return handle;
  }

  async load(input: {
    reader: ContinuationReadCapability;
    handle: RuntimeContinuationHandle;
  }): Promise<Uint8Array> {
    const payload = this.payloads.get(input.handle.id);
    if (!payload) throw new Error("missing continuation");
    return payload.slice();
  }
}

function request(
  overrides: Partial<AgentRunRequest> = {},
  signal = new AbortController().signal,
): AgentRunRequest {
  return {
    sessionId: "session-1",
    turnId: "turn-1",
    prompt: "hello",
    cwd,
    modelId: "test-model",
    executionMode: "plan",
    permissionMode: "ask_always",
    authorization: {
      kind: "run",
      id: "authorization-1",
      operation: "run",
      sessionId: "session-1",
      operationId: "operation-1",
      turnId: "turn-1",
      connectionId: "connection-1",
      modelId: "test-model",
      backendFingerprint: "sha256:test",
      connectionRevision: 1,
      policyRevision: "policy-v1",
      billingMode: "included_strict",
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

async function collect(runtime: ManagedAcpRuntime, run: AgentRunRequest): Promise<AgentRuntimeEvent[]> {
  const events: AgentRuntimeEvent[] = [];
  for await (const event of runtime.run(run, {
    requestApproval: async (approval) => {
      expect(approval.options.filter((option) => option.kind === "allow_once"))
        .toHaveLength(2);
      return { outcome: "selected", optionId: "once-b" };
    },
  })) {
    events.push(event);
  }
  return events;
}

async function eventFixture(): Promise<{ directory: string; eventsFile: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), "recurs-acp-cancel-"));
  temporaryDirectories.push(directory);
  const eventsFile = path.join(directory, "events.jsonl");
  await writeFile(eventsFile, "", { mode: 0o600 });
  return { directory, eventsFile };
}

async function waitForMethod(eventsFile: string, method: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const methods = (await readFile(eventsFile, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { method: string }).method);
    if (methods.includes(method)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`fake ACP agent did not receive ${method}`);
}

async function recordedMethods(eventsFile: string): Promise<string[]> {
  return (await readFile(eventsFile, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { method: string }).method);
}

function continuation(
  status: "committed" | "uncertain",
): RuntimeContinuationHandle {
  return {
    kind: "runtime",
    id: "runtime-handle-seed",
    storageClass: "process_scoped",
    ownerInstanceId: "owner-1",
    expiresAt: "2099-01-01T00:00:00.000Z",
    recursSessionId: "session-1",
    connectionId: "connection-1",
    adapterId: "fake-acp",
    modelId: "test-model",
    backendFingerprint: "sha256:test",
    stateVersion: 1,
    originTurnId: "turn-seed",
    continuationSequence: 1,
    status,
    vendorTurnSequence: 1,
  };
}

function seedContinuation(
  store: MemoryRuntimeStore,
  handle: RuntimeContinuationHandle,
): void {
  store.payloads.set(
    handle.id,
    new TextEncoder().encode(JSON.stringify({
      schemaVersion: 1,
      vendorSessionId: "vendor-session-secret-123",
      cwd,
    })),
  );
}

describe("ManagedAcpRuntime", () => {
  it.each([
    ["initialize", "hang", "initialize", false],
    ["new session", "new-hang", "session/new", false],
    ["configuration", "config-hang", "session/set_mode", true],
  ] as const)(
    "cancels during %s without waiting for the operation timeout",
    async (_phase, scenario, awaitedMethod, expectsSessionCancel) => {
      const { eventsFile } = await eventFixture();
      const runtime = new ManagedAcpRuntime(profile(scenario, {
        startupTimeoutMs: 600,
        promptTimeoutMs: 600,
        cancelSettlementTimeoutMs: 50,
        shutdownTimeoutMs: 50,
        extraArgs: ["--event-file", eventsFile],
      }), new MemoryRuntimeStore());
      const controller = new AbortController();
      const running = collect(runtime, request({}, controller.signal));
      await waitForMethod(eventsFile, awaitedMethod);
      const startedAt = Date.now();
      controller.abort(new Error("test cancellation"));
      const events = await running;

      expect(Date.now() - startedAt).toBeLessThan(300);
      expect(events.at(-1)).toMatchObject({ type: "cancelled" });
      expect((await recordedMethods(eventsFile)).includes("session/cancel"))
        .toBe(expectsSessionCancel);
    },
  );

  it("cancels a resumed session before the resume timeout", async () => {
    const { eventsFile } = await eventFixture();
    const store = new MemoryRuntimeStore();
    const committed = continuation("committed");
    seedContinuation(store, committed);
    const runtime = new ManagedAcpRuntime(profile("resume-hang", {
      promptTimeoutMs: 600,
      cancelSettlementTimeoutMs: 50,
      shutdownTimeoutMs: 50,
      extraArgs: ["--event-file", eventsFile],
    }), store);
    const controller = new AbortController();
    const running = collect(runtime, request({
      continuation: committed,
      continuationReader: {
        id: "reader-1",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    }, controller.signal));
    await waitForMethod(eventsFile, "session/resume");
    const startedAt = Date.now();
    controller.abort(new Error("test cancellation"));
    const events = await running;

    expect(Date.now() - startedAt).toBeLessThan(300);
    expect(events.at(-1)).toMatchObject({ type: "cancelled" });
    expect(await recordedMethods(eventsFile)).toContain("session/cancel");
  });

  it("keeps cancellation dominant after setup but before a prompt is issued", async () => {
    const { eventsFile } = await eventFixture();
    const controller = new AbortController();
    const store = new class extends MemoryRuntimeStore {
      override async put(input: {
        writer: ContinuationWriteCapability;
        payload: Uint8Array;
      }): Promise<RuntimeContinuationHandle> {
        controller.abort(new Error("cancelled during continuation staging"));
        throw new Error(`staging failed for ${String(input.payload.byteLength)} bytes`);
      }
    }();
    const runtime = new ManagedAcpRuntime(profile("happy", {
      extraArgs: ["--event-file", eventsFile],
      cancelSettlementTimeoutMs: 50,
      shutdownTimeoutMs: 50,
    }), store);

    const events = await collect(runtime, request({}, controller.signal));

    expect(events.at(-1)).toMatchObject({ type: "cancelled" });
    expect(await recordedMethods(eventsFile)).toContain("session/cancel");
  });

  it("cancels the vendor session when staging finishes after an abort", async () => {
    const { eventsFile } = await eventFixture();
    const controller = new AbortController();
    const store = new class extends MemoryRuntimeStore {
      override async put(input: {
        writer: ContinuationWriteCapability;
        payload: Uint8Array;
      }): Promise<RuntimeContinuationHandle> {
        controller.abort(new Error("cancelled while staging continuation"));
        return await super.put(input);
      }
    }();
    const runtime = new ManagedAcpRuntime(profile("happy", {
      extraArgs: ["--event-file", eventsFile],
      cancelSettlementTimeoutMs: 50,
      shutdownTimeoutMs: 50,
    }), store);

    const events = await collect(runtime, request({}, controller.signal));

    expect(events.at(-1)).toMatchObject({ type: "cancelled" });
    expect(await recordedMethods(eventsFile)).toContain("session/cancel");
  });

  it("cancels reconciliation before the resume timeout", async () => {
    const { eventsFile } = await eventFixture();
    const store = new MemoryRuntimeStore();
    const uncertain = continuation("uncertain");
    seedContinuation(store, uncertain);
    const runtime = new ManagedAcpRuntime(profile("reconcile-hang", {
      promptTimeoutMs: 600,
      cancelSettlementTimeoutMs: 50,
      shutdownTimeoutMs: 50,
      extraArgs: ["--event-file", eventsFile],
    }), store);
    const controller = new AbortController();
    const running = runtime.reconcile({
      continuation: uncertain,
      reader: {
        id: "reader-reconcile",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
      authorization: {
        ...request().authorization,
        operation: "runtime_reconcile",
        turnId: null,
      },
      expectedSessionRecordSequence: 1,
      signal: controller.signal,
    });
    await waitForMethod(eventsFile, "session/resume");
    const startedAt = Date.now();
    controller.abort(new Error("test cancellation"));

    await expect(running).resolves.toBe("uncertain");
    expect(Date.now() - startedAt).toBeLessThan(300);
    expect(await recordedMethods(eventsFile)).toContain("session/cancel");
  });
  it("initializes, enforces reviewed settings, translates updates, and echoes exact permissions", async () => {
    const store = new MemoryRuntimeStore();
    const runtime = new ManagedAcpRuntime(profile(), store);
    const events = await collect(runtime, request());

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "continuation_updated" }),
      { type: "text_delta", text: "hello " },
      { type: "reasoning_delta", text: "reasoning" },
      expect.objectContaining({ type: "activity" }),
      expect.objectContaining({ type: "files_changed" }),
      {
        type: "usage",
        usage: {
          inputTokens: 9,
          outputTokens: 6,
          reasoningTokens: 2,
          cachedInputTokens: 3,
          cacheWriteInputTokens: 1,
        },
      },
      expect.objectContaining({ type: "done", stopReason: "complete" }),
    ]));
    expect(events.filter((event) => event.type === "usage")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("done");
    expect(JSON.stringify(events)).not.toContain("vendor-session-secret-123");
    expect(new TextDecoder().decode(store.payloads.get("runtime-handle-1")))
      .toContain("vendor-session-secret-123");
  });

  it("resumes only through the opaque continuation store", async () => {
    const store = new MemoryRuntimeStore();
    const first = new ManagedAcpRuntime(profile("simple"), store);
    const firstEvents = await collect(first, request());
    const continuation = firstEvents.find(
      (event): event is Extract<AgentRuntimeEvent, { type: "continuation_updated" }> =>
        event.type === "continuation_updated",
    )?.continuation;
    expect(continuation).toBeDefined();
    if (!continuation) throw new Error("missing test continuation");

    const resumed = new ManagedAcpRuntime(profile("simple"), store);
    const resumedEvents = await collect(resumed, request({
      continuation: { ...continuation, status: "committed" },
      continuationReader: {
        id: "reader-1",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    }));
    expect(resumedEvents.at(-1)).toMatchObject({ type: "done" });
    expect(JSON.stringify(resumedEvents)).not.toContain("vendor-session-secret-123");
  });

  it("fails before spawning for an unsupported mapping", async () => {
    const runtime = new ManagedAcpRuntime(profile(), new MemoryRuntimeStore());
    const events = await collect(runtime, request({ permissionMode: "approved_for_me" }));
    expect(events).toEqual([
      expect.objectContaining({
        type: "failed",
        failure: expect.objectContaining({
          phase: "preflight",
          code: "runtime_capability_missing",
        }),
      }),
    ]);
  });

  it.each([
    ["length", "done", "length"],
    ["refusal", "failed", undefined],
  ])("maps %s stop outcomes safely", async (scenario, type, stopReason) => {
    const runtime = new ManagedAcpRuntime(profile(scenario), new MemoryRuntimeStore());
    const events = await collect(runtime, request());
    expect(events.at(-1)).toMatchObject({
      type,
      ...(stopReason ? { stopReason } : {}),
      ...(scenario === "refusal"
        ? { failure: expect.objectContaining({ code: "runtime_failed" }) }
        : {}),
    });
  });

  it("requires cancellation to settle as cancelled", async () => {
    const controller = new AbortController();
    const runtime = new ManagedAcpRuntime(profile("cancel"), new MemoryRuntimeStore());
    const events: AgentRuntimeEvent[] = [];
    for await (const event of runtime.run(request({}, controller.signal), {
      requestApproval: async () => ({ outcome: "cancelled" }),
    })) {
      events.push(event);
      if (event.type === "text_delta") {
        controller.abort(new Error("user cancelled"));
      }
    }
    expect(events.at(-1)).toMatchObject({ type: "cancelled" });
  });

  it("treats normal completion after cancellation as a protocol failure", async () => {
    const controller = new AbortController();
    const runtime = new ManagedAcpRuntime(
      profile("cancel-normal"),
      new MemoryRuntimeStore(),
    );
    const events: AgentRuntimeEvent[] = [];
    for await (const event of runtime.run(request({}, controller.signal), {
      requestApproval: async () => ({ outcome: "cancelled" }),
    })) {
      events.push(event);
      if (event.type === "text_delta") {
        controller.abort(new Error("user cancelled"));
      }
    }
    expect(events.at(-1)).toMatchObject({
      type: "failed",
      failure: expect.objectContaining({ code: "protocol_mismatch" }),
    });
  });

  it("fails when cancellation does not settle within its independent bound", async () => {
    const controller = new AbortController();
    const runtime = new ManagedAcpRuntime(
      profile("cancel-hang", { cancelSettlementTimeoutMs: 40 }),
      new MemoryRuntimeStore(),
    );
    const events: AgentRuntimeEvent[] = [];
    for await (const event of runtime.run(request({}, controller.signal), {
      requestApproval: async () => ({ outcome: "cancelled" }),
    })) {
      events.push(event);
      if (event.type === "text_delta") controller.abort();
    }
    expect(events.at(-1)).toMatchObject({
      type: "failed",
      failure: expect.objectContaining({ code: "timeout" }),
    });
  });

  it("cancels a pending host approval when the prompt times out", async () => {
    const runtime = new ManagedAcpRuntime(
      profile("approval-hang", {
        promptTimeoutMs: 50,
        cancelSettlementTimeoutMs: 100,
      }),
      new MemoryRuntimeStore(),
    );
    const events: AgentRuntimeEvent[] = [];
    for await (const event of runtime.run(request(), {
      requestApproval: async () => await new Promise<never>(() => undefined),
    })) {
      events.push(event);
    }
    expect(events.at(-1)).toMatchObject({
      type: "failed",
      failure: expect.objectContaining({ code: "timeout" }),
    });
  });

  it("accepts the SDK cancellation error as a settled cancellation", async () => {
    const controller = new AbortController();
    const runtime = new ManagedAcpRuntime(
      profile("cancel-error"),
      new MemoryRuntimeStore(),
    );
    const events: AgentRuntimeEvent[] = [];
    for await (const event of runtime.run(request({}, controller.signal), {
      requestApproval: async () => ({ outcome: "cancelled" }),
    })) {
      events.push(event);
      if (event.type === "text_delta") controller.abort();
    }
    expect(events.at(-1)).toMatchObject({ type: "cancelled" });
  });

  it("rejects traffic after the prompt response", async () => {
    const runtime = new ManagedAcpRuntime(profile("post-terminal"), new MemoryRuntimeStore());
    const events = await collect(runtime, request());
    expect(events.at(-1)).toMatchObject({
      type: "failed",
      failure: expect.objectContaining({ code: "protocol_mismatch" }),
    });

    const delayed = new ManagedAcpRuntime(
      profile("delayed-post-terminal"),
      new MemoryRuntimeStore(),
    );
    expect((await collect(delayed, request())).at(-1)).toMatchObject({
      type: "failed",
      failure: expect.objectContaining({ code: "protocol_mismatch" }),
    });

    const latePermission = new ManagedAcpRuntime(
      profile("post-terminal-permission"),
      new MemoryRuntimeStore(),
    );
    expect((await collect(latePermission, request())).at(-1)).toMatchObject({
      type: "failed",
      failure: expect.objectContaining({ code: "protocol_mismatch" }),
    });
  });

  it("ignores bounded future display updates but rejects reviewed mode drift", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
    const future = new ManagedAcpRuntime(
      profile("future-update"),
      new MemoryRuntimeStore(),
    );
    expect((await collect(future, request())).at(-1)).toMatchObject({ type: "done" });

    const drift = new ManagedAcpRuntime(
      profile("mode-drift"),
      new MemoryRuntimeStore(),
    );
    expect((await collect(drift, request())).at(-1)).toMatchObject({
      type: "failed",
      failure: expect.objectContaining({ code: "protocol_mismatch" }),
    });
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("turns early exit, startup timeout, and prompt timeout into safe terminals", async () => {
    const exited = new ManagedAcpRuntime(
      profile("early-exit"),
      new MemoryRuntimeStore(),
    );
    expect((await collect(exited, request())).at(-1)).toMatchObject({
      type: "failed",
      failure: expect.objectContaining({ code: "protocol_mismatch" }),
    });

    const startup = new ManagedAcpRuntime(
      profile("hang", { startupTimeoutMs: 40 }),
      new MemoryRuntimeStore(),
    );
    expect((await collect(startup, request())).at(-1)).toMatchObject({
      type: "failed",
      failure: expect.objectContaining({ code: "protocol_mismatch" }),
    });

    const prompt = new ManagedAcpRuntime(
      profile("prompt-hang", {
        promptTimeoutMs: 40,
        cancelSettlementTimeoutMs: 40,
      }),
      new MemoryRuntimeStore(),
    );
    expect((await collect(prompt, request())).at(-1)).toMatchObject({
      type: "failed",
      failure: expect.objectContaining({ code: "timeout" }),
    });
  });

  it("gates resume and close behavior on negotiated lifecycle capabilities", async () => {
    const unsupported = new ManagedAcpRuntime(
      profile("no-lifecycle"),
      new MemoryRuntimeStore(),
    );
    expect((await collect(unsupported, request())).at(-1)).toMatchObject({
      type: "failed",
      failure: expect.objectContaining({
        phase: "started",
        code: "runtime_capability_missing",
      }),
    });

    const oneShot = new ManagedAcpRuntime(
      profile("no-lifecycle", { resume: false }),
      new MemoryRuntimeStore(),
    );
    expect((await collect(oneShot, request())).at(-1)).toMatchObject({ type: "done" });
  });

  it("enforces aggregate event count and byte bounds", async () => {
    const count = new ManagedAcpRuntime(
      profile("happy", { maxEvents: 2 }),
      new MemoryRuntimeStore(),
    );
    expect((await collect(count, request())).at(-1)).toMatchObject({
      type: "failed",
      failure: expect.objectContaining({ code: "invalid_response" }),
    });

    const bytes = new ManagedAcpRuntime(
      profile("happy", { maxEventBytes: 1_024 }),
      new MemoryRuntimeStore(),
    );
    expect((await collect(bytes, request())).at(-1)).toMatchObject({
      type: "failed",
      failure: expect.objectContaining({ code: "invalid_response" }),
    });

    const terminal = new ManagedAcpRuntime(
      profile("terminal-large", { maxEventBytes: 5_000 }),
      new MemoryRuntimeStore(),
    );
    const terminalEvents = await collect(terminal, request());
    expect(terminalEvents.at(-1)).toMatchObject({
      type: "failed",
      failure: expect.objectContaining({ code: "invalid_response" }),
    });
    expect(terminalEvents.reduce(
      (total, event) => total + Buffer.byteLength(JSON.stringify(event)),
      0,
    )).toBeLessThanOrEqual(5_000);

    const queued = new ManagedAcpRuntime(
      profile("happy", { maxEventQueueEvents: 2 }),
      new MemoryRuntimeStore(),
    );
    expect((await collect(queued, request())).at(-1)).toMatchObject({
      type: "failed",
      failure: expect.objectContaining({ code: "invalid_response" }),
    });

    const queuedBytes = new ManagedAcpRuntime(
      profile("happy", { maxEventQueueBytes: 1_024 }),
      new MemoryRuntimeStore(),
    );
    expect((await collect(queuedBytes, request())).at(-1)).toMatchObject({
      type: "failed",
      failure: expect.objectContaining({ code: "invalid_response" }),
    });
  });

  it("surfaces authentication-required as a safe actionable failure", async () => {
    const runtime = new ManagedAcpRuntime(
      profile("auth-required"),
      new MemoryRuntimeStore(),
    );
    const events = await collect(runtime, request());
    expect(events.at(-1)).toMatchObject({
      type: "failed",
      failure: expect.objectContaining({
        domain: "auth",
        code: "authentication_required",
        action: "reauthenticate",
      }),
    });
  });

  it("inspects sanitized dynamic auth methods and authenticates only an advertised ID", async () => {
    const inspected = await inspectAcpRuntime(profile("simple"), new AbortController().signal);
    expect(inspected).toMatchObject({
      protocolVersion: 1,
      agentInfo: { name: "fake-acp", version: "1.0.0" },
      authMethods: [
        { id: "browser-login", name: "Browser login", type: "agent" },
        { id: "api-key", name: "API key", type: "env_var" },
      ],
    });
    expect(JSON.stringify(inspected)).not.toContain("SECRET_KEY");

    await expect(authenticateAcpRuntime(
      profile("simple"),
      "browser-login",
      new AbortController().signal,
    )).resolves.toMatchObject({ authenticatedMethodId: "browser-login" });
    await expect(authenticateAcpRuntime(
      profile("simple"),
      "not-advertised",
      new AbortController().signal,
    )).rejects.toThrow("not advertised");
  });

  it("normalizes agent RequestError messages and data at public operation boundaries", async () => {
    for (const operation of [
      () => inspectAcpRuntime(
        profile("secret-initialize-error"),
        new AbortController().signal,
      ),
      () => authenticateAcpRuntime(
        profile("secret-auth-error"),
        "browser-login",
        new AbortController().signal,
      ),
    ]) {
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

  it.each([
    "duplicate-mode-id",
    "duplicate-config-id",
    "duplicate-select-value",
    "duplicate-group-value",
    "duplicate-group-id",
  ])("rejects ambiguous %s session metadata before matching", async (scenario) => {
    const runtime = new ManagedAcpRuntime(profile(scenario), new MemoryRuntimeStore());
    const events = await collect(runtime, request());
    expect(events.at(-1)).toMatchObject({
      type: "failed",
      failure: expect.objectContaining({
        phase: "started",
        code: "invalid_response",
      }),
    });
  });

  it("requires explicit model and execution-mode selectors and validates categories", async () => {
    const base = profile();
    const mapping = base.mappings[0];
    if (!mapping) throw new Error("missing test mapping");

    expect(() => createAcpRuntimeProfile({
      ...base,
      mappings: [{ ...mapping, modelSelector: undefined }],
    } as unknown as AcpRuntimeProfile)).toThrow("model selector");
    expect(() => createAcpRuntimeProfile({
      ...base,
      mappings: [{ ...mapping, executionModeSelector: undefined }],
    } as unknown as AcpRuntimeProfile)).toThrow("execution-mode selector");

    const runtime = new ManagedAcpRuntime(
      profile("wrong-selector-category"),
      new MemoryRuntimeStore(),
    );
    expect((await collect(runtime, request())).at(-1)).toMatchObject({
      type: "failed",
      failure: expect.objectContaining({
        phase: "started",
        code: "runtime_capability_missing",
      }),
    });

    const confirmation = new ManagedAcpRuntime(
      profile("selector-confirmation"),
      new MemoryRuntimeStore(),
    );
    expect((await collect(confirmation, request())).at(-1)).toMatchObject({
      type: "done",
      stopReason: "complete",
    });
  });

  it("reconciliation returns gone for a missing vendor session and otherwise remains uncertain", async () => {
    const store = new MemoryRuntimeStore();
    const seed = new ManagedAcpRuntime(profile("simple"), store);
    const seedEvents = await collect(seed, request());
    const continuation = seedEvents.find(
      (event): event is Extract<AgentRuntimeEvent, { type: "continuation_updated" }> =>
        event.type === "continuation_updated",
    )?.continuation;
    if (!continuation) throw new Error("missing test continuation");
    const input = {
      continuation,
      reader: {
        id: "reader-1",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
      authorization: {
        ...request().authorization,
        operation: "runtime_reconcile" as const,
        turnId: null,
      },
      expectedSessionRecordSequence: 4,
      signal: new AbortController().signal,
    };

    await expect(new ManagedAcpRuntime(profile("simple"), store).reconcile(input))
      .resolves.toBe("uncertain");
    await expect(new ManagedAcpRuntime(profile("resume-gone"), store).reconcile(input))
      .resolves.toBe("gone");
  });

  it("deep-freezes profiles and rejects unsafe environment keys", () => {
    const frozen = profile();
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.mappings)).toBe(true);
    expect(() => createAcpRuntimeProfile({
      ...frozen,
      allowedEnvironmentKeys: ["OPENAI_API_KEY"],
    })).toThrow("environment");
    expect(() => createAcpRuntimeProfile({
      ...frozen,
      allowedEnvironmentKeys: ["NODE_OPTIONS"],
    })).toThrow("environment");
    expect(() => createAcpRuntimeProfile({
      ...frozen,
      args: [fixture, "token=must-not-leak"],
    })).toThrow("arguments");
    expect(() => createAcpRuntimeProfile({
      ...frozen,
      args: [fixture, "--token", "opaque-value"],
    })).toThrow("arguments");
    expect(() => createAcpRuntimeProfile({
      ...frozen,
      allowedEnvironmentKeys: ["PYTHONPATH"],
    })).toThrow("environment");
  });
});
