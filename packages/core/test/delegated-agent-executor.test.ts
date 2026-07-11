import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  AgentRuntime,
  AgentRuntimeEvent,
  IntegrationFailure,
  RunAuthorization,
  RuntimeCapabilities,
  RuntimeApprovalRequest,
  RuntimeContinuationAuthority,
  SessionBackendPin,
  TrustedRunContext,
} from "@recurs/contracts";
import {
  CheckpointStore,
  ToolError,
  ToolRegistry,
  type Checkpoint,
  type Tool,
} from "@recurs/tools";
import { afterEach, describe, expect, it } from "vitest";

import {
  bindRunAuthorization,
  DelegatedAgentExecutor,
  type DelegatedAgentExecutorDependencies,
  JsonlSessionStore,
  ProcessScopedRuntimeContinuationStore,
} from "../src/index.js";

const directories: string[] = [];
const now = new Date("2026-07-11T00:00:00.000Z");
const context: TrustedRunContext = {
  invocation: "one_shot",
  presence: "present",
  location: "local",
  automation: "manual",
  embedding: "cli",
};

const pin: SessionBackendPin & { kind: "agent_runtime" } = {
  kind: "agent_runtime",
  runtimeCapabilityProfileRevisionAtCreation: "capabilities-v1",
  providerId: "agent",
  adapterId: "agent-v1",
  connectionId: "connection-1",
  modelId: "model-1",
  modelIdentityKind: "versioned",
  providerResolvedModelRevisionAtCreation: "model-1.0.0",
  catalogRevision: "catalog-1",
  policyRevisionAtCreation: "policy-1",
  billingPolicyRevisionAtCreation: "billing-1",
  primaryBillingSourceAtCreation: "included_subscription",
  billingSelectionAtCreation: {
    mode: "strict_primary_only",
    policyRevision: "billing-1",
    disclosureRevision: "disclosure-1",
    allowedSources: ["included_subscription"],
    acknowledgedAt: "2026-07-10T00:00:00.000Z",
  },
  accountSubjectFingerprint: `sha256:${"a".repeat(64)}`,
};

const capabilities: RuntimeCapabilities = {
  resume: true,
  cancellation: "protocol",
  fileEvents: true,
  usageEvents: true,
  supportedPermissionModes: [
    "ask_always",
    "approved_for_me",
    "full_access",
  ],
  approvalControl: "recurs_policy_bridge",
  planMode: "enforced",
  toolExecution: "host_tools",
  checkpointing: "host_tools",
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function authorization(
  sessionId: string,
  turnId: string,
  trustedContext = context,
): RunAuthorization {
  return bindRunAuthorization({
    id: `authorization-${turnId}`,
    operation: "run",
    sessionId,
    operationId: `operation-${turnId}`,
    turnId,
    pin,
    connectionRevision: 1,
    policyRevision: pin.policyRevisionAtCreation,
    context: trustedContext,
    maxRequests: 4,
    expiresAt: "2026-07-11T00:05:00.000Z",
  }, now);
}

type ExecutorOverrides = Partial<Pick<
  DelegatedAgentExecutorDependencies,
  | "continuationAuthority"
  | "tools"
  | "approvals"
  | "runtimeApprovals"
  | "limits"
>>;

async function fixture(overrides: ExecutorOverrides = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "recurs-delegated-"));
  directories.push(directory);
  const sessions = new JsonlSessionStore(path.join(directory, "sessions"));
  const session = await sessions.createPinnedSession({
    id: path.basename(directory).replaceAll(".", "-"),
    cwd: directory,
    backend: pin,
    at: now.toISOString(),
  });
  const continuations = new ProcessScopedRuntimeContinuationStore({
    now: () => new Date(now),
  });
  const emitted: unknown[] = [];
  const executor = new DelegatedAgentExecutor({
    continuationAuthority: overrides.continuationAuthority ??
      continuations.authority,
    tools: overrides.tools ?? new ToolRegistry(),
    approvals: overrides.approvals ?? { async request() { return "deny"; } },
    runtimeApprovals: overrides.runtimeApprovals ?? {
      async request() {
        return { decision: { outcome: "cancelled" }, scope: "cancel" };
      },
    },
    async emit(event) {
      emitted.push(event);
    },
    createToolContext(state, signal) {
      return {
        sessionId: state.id,
        cwd: state.cwd,
        executionMode: state.executionMode,
        signal,
        readRevisions: new Map(),
      };
    },
    now: () => new Date(now),
    createDiagnosticId: () => "diagnostic-1",
    ...(overrides.limits === undefined ? {} : { limits: overrides.limits }),
  });
  return { sessions, session, continuations, executor, emitted };
}

function scriptedRuntime(
  run: AgentRuntime["run"],
  overrides: Partial<Pick<
    AgentRuntime,
    "adapterId" | "connectionId" | "capabilities" | "capabilityProfileRevision"
  >> = {},
): AgentRuntime {
  return {
    adapterId: overrides.adapterId ?? pin.adapterId,
    connectionId: overrides.connectionId ?? pin.connectionId,
    capabilities: overrides.capabilities ?? structuredClone(capabilities),
    capabilityProfileRevision: overrides.capabilityProfileRevision ??
      pin.runtimeCapabilityProfileRevisionAtCreation,
    run,
    async reconcile() {
      return "gone";
    },
  };
}

function approvalRequest(
  overrides: Partial<RuntimeApprovalRequest> = {},
): RuntimeApprovalRequest {
  return {
    requestId: "approval-1",
    action: "write",
    resource: "src/file.ts",
    risk: "elevated",
    summary: "Update a source file",
    options: [
      { optionId: "allow-exact", name: "Allow once", kind: "allow_once" },
      { optionId: "reject-exact", name: "Reject", kind: "reject_once" },
    ],
    ...overrides,
  };
}

class RecordingCheckpoints extends CheckpointStore {
  readonly calls: string[] = [];

  async captureBefore(
    sessionId: string,
    toolCallId: string,
  ): Promise<Checkpoint> {
    this.calls.push(`before:${toolCallId}`);
    return {
      id: `checkpoint-${toolCallId}`,
      sessionId,
      toolCallId,
      before: {},
    };
  }

  async captureAfter(checkpoint: Checkpoint): Promise<Checkpoint> {
    this.calls.push(`after:${checkpoint.toolCallId}`);
    return { ...checkpoint, after: {} };
  }

  async undoLatest(): Promise<{ restored: string[]; deleted: string[] }> {
    return { restored: [], deleted: [] };
  }
}

function toolRegistry(
  tool: Tool<Record<string, unknown>>,
  checkpoints?: CheckpointStore,
): ToolRegistry {
  const registry = new ToolRegistry([], { checkpoints });
  registry.register(tool);
  return registry;
}

describe("DelegatedAgentExecutor", () => {
  it("persists a fragmented runtime turn and reloads its exact committed result", async () => {
    const { sessions, session, continuations, executor, emitted } = await fixture();
    const turnId = "turn-1";
    let requestSeen = false;
    const runtime = scriptedRuntime(async function* (request) {
      requestSeen = true;
      expect(request.continuation).toBeNull();
      expect(request.continuationReader).toBeNull();
      yield { type: "text_delta", text: "streamed " };
      yield { type: "text_delta", text: "text" };
      yield {
        type: "usage",
        usage: {
          inputTokens: 3,
          outputTokens: 2,
          cachedInputTokens: 1,
          costUsd: 0.25,
        },
      };
      const continuation = await continuations.runtimeStore.put({
        writer: request.continuationWriter,
        payload: new TextEncoder().encode("opaque-vendor-state"),
      });
      yield { type: "continuation_updated", continuation };
      yield {
        type: "done",
        finalText: "terminal text",
        stopReason: "complete",
        continuation,
      };
    });

    const result = await sessions.withSessionMutation(
      session.id,
      session.lastSequence,
      (mutation) => executor.run({
        session,
        turnId,
        prompt: "inspect",
        executionMode: "act",
        runtime,
        authorization: authorization(session.id, turnId),
        context,
        mutation,
        signal: new AbortController().signal,
      }),
    );

    expect(requestSeen).toBe(true);
    expect(result).toEqual({
      finalText: "terminal text",
      usage: {
        inputTokens: 3,
        outputTokens: 2,
        cachedInputTokens: 1,
        costUsd: 0.25,
      },
      usageSource: "runtime",
      steps: null,
      changedFiles: [],
      changedFilesSource: "host_tools",
      evidence: [],
      evidenceSource: "none",
    });
    const records = (await sessions.load(session.id)).records;
    expect(records.map((record) => record.type)).toEqual([
      "session_created",
      "turn_started",
      "runtime_continuation_updated",
      "runtime_completed",
      "turn_completed",
    ]);
    expect(records[2]).toMatchObject({
      type: "runtime_continuation_updated",
      continuation: { status: "uncertain" },
    });
    expect(records[3]).toMatchObject({
      type: "runtime_completed",
      result,
      continuation: { status: "committed" },
      provenance: {
        adapterId: pin.adapterId,
        connectionId: pin.connectionId,
        modelId: pin.modelId,
        capabilityProfileRevision: "capabilities-v1",
      },
    });
    expect(records[4]).toMatchObject({ type: "turn_completed", result });
    const reloaded = await sessions.loadState(session.id);
    expect(reloaded.messages.map((message) => message.content)).toEqual([
      "inspect",
      "terminal text",
    ]);
    expect(reloaded.runtimeContinuation).toMatchObject({ status: "committed" });
    expect(emitted).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "turn_started", prompt: "inspect" }),
      expect.objectContaining({ type: "model_text_delta", text: "streamed " }),
      expect.objectContaining({ type: "model_text_delta", text: "text" }),
      expect.objectContaining({ type: "turn_completed" }),
    ]));
  });

  it.each([
    ["runtime adapter", { adapterId: "wrong-adapter" }, "act"],
    ["runtime connection", { connectionId: "wrong-connection" }, "act"],
    ["capability profile", { capabilityProfileRevision: "capabilities-v2" }, "act"],
    [
      "protocol cancellation",
      { capabilities: { ...capabilities, cancellation: "os_containment" as const } },
      "act",
    ],
    [
      "host tool execution",
      { capabilities: { ...capabilities, toolExecution: "opaque" as const } },
      "act",
    ],
    [
      "host checkpointing",
      { capabilities: { ...capabilities, checkpointing: "none" as const } },
      "act",
    ],
    [
      "enforced plan mode",
      { capabilities: { ...capabilities, planMode: "advisory" as const } },
      "plan",
    ],
    [
      "requested permission mode",
      { capabilities: { ...capabilities, supportedPermissionModes: [] } },
      "act",
    ],
  ] satisfies readonly [string, Parameters<typeof scriptedRuntime>[1], "act" | "plan"][]) (
    "fails %s preflight before prompt persistence or runtime execution",
    async (_name, overrides, executionMode) => {
      const { sessions, session, executor } = await fixture();
      let runCalls = 0;
      const runtime = scriptedRuntime(async function* () {
        runCalls += 1;
        yield { type: "done", finalText: "must not run", stopReason: "complete" };
      }, overrides);

      await expect(sessions.withSessionMutation(
        session.id,
        session.lastSequence,
        (mutation) => executor.run({
          session,
          turnId: "turn-preflight",
          prompt: "inspect",
          executionMode,
          runtime,
          authorization: authorization(session.id, "turn-preflight"),
          context,
          mutation,
          signal: new AbortController().signal,
        }),
      )).rejects.toMatchObject({
        phase: "preflight",
        code: "runtime_capability_missing",
      });
      expect(runCalls).toBe(0);
      expect((await sessions.load(session.id)).records).toHaveLength(1);
    },
  );

  it("verifies the trusted authorization context before starting", async () => {
    const { sessions, session, executor } = await fixture();
    let runCalls = 0;
    const runtime = scriptedRuntime(async function* () {
      runCalls += 1;
      yield { type: "done", finalText: "must not run", stopReason: "complete" };
    });
    const differentContext = { ...context, presence: "unattended" as const };

    await expect(sessions.withSessionMutation(
      session.id,
      session.lastSequence,
      (mutation) => executor.run({
        session,
        turnId: "turn-auth",
        prompt: "inspect",
        executionMode: "act",
        runtime,
        authorization: authorization(session.id, "turn-auth"),
        context: differentContext,
        mutation,
        signal: new AbortController().signal,
      }),
    )).rejects.toMatchObject({
      domain: "policy",
      phase: "preflight",
      code: "authorization_denied",
    });
    expect(runCalls).toBe(0);
    expect((await sessions.load(session.id)).records).toHaveLength(1);
  });

  it.each([
    ["missing", []],
    [
      "duplicate",
      [
        { type: "done", finalText: "first", stopReason: "complete" },
        { type: "done", finalText: "second", stopReason: "complete" },
      ],
    ],
    [
      "post-terminal",
      [
        { type: "done", finalText: "first", stopReason: "complete" },
        { type: "text_delta", text: "late" },
      ],
    ],
    ["unknown", [{ type: "vendor_extension", value: true }]],
  ])("rejects %s terminal/order traffic after consuming the iterator", async (
    _name,
    rawEvents,
  ) => {
    const { sessions, session, executor } = await fixture();
    let iteratorCompleted = false;
    const events = rawEvents as AgentRuntimeEvent[];
    const runtime = scriptedRuntime(async function* () {
      for (const event of events) {
        yield event;
      }
      iteratorCompleted = true;
    });

    await expect(sessions.withSessionMutation(
      session.id,
      session.lastSequence,
      (mutation) => executor.run({
        session,
        turnId: "turn-invalid",
        prompt: "inspect",
        executionMode: "act",
        runtime,
        authorization: authorization(session.id, "turn-invalid"),
        context,
        mutation,
        signal: new AbortController().signal,
      }),
    )).rejects.toMatchObject({
      domain: "runtime",
      phase: "started",
      code: "invalid_response",
    });
    expect(iteratorCompleted).toBe(true);
    expect((await sessions.load(session.id)).records.map((record) => record.type))
      .toEqual(["session_created", "turn_started", "turn_failed"]);
  });

  it("resumes one exact committed tip across a reloaded session", async () => {
    const { sessions, session, continuations, executor } = await fixture();
    const firstRuntime = scriptedRuntime(async function* (request) {
      const next = await continuations.runtimeStore.put({
        writer: request.continuationWriter,
        payload: new TextEncoder().encode("state-one"),
      });
      yield { type: "continuation_updated", continuation: next };
      yield { type: "done", finalText: "first", stopReason: "complete" };
    });
    await sessions.withSessionMutation(session.id, 0, (mutation) =>
      executor.run({
        session,
        turnId: "turn-one",
        prompt: "one",
        executionMode: "act",
        runtime: firstRuntime,
        authorization: authorization(session.id, "turn-one"),
        context,
        mutation,
        signal: new AbortController().signal,
      })
    );

    const reloaded = await sessions.loadState(session.id);
    expect(reloaded.runtimeContinuation).toMatchObject({
      status: "committed",
      continuationSequence: 1,
      vendorTurnSequence: 1,
    });
    const secondRuntime = scriptedRuntime(async function* (request) {
      expect(request.continuation).toEqual(reloaded.runtimeContinuation);
      expect(request.continuationReader).not.toBeNull();
      const bytes = await continuations.runtimeStore.load({
        reader: request.continuationReader!,
        handle: request.continuation!,
      });
      expect(new TextDecoder().decode(bytes)).toBe("state-one");
      const next = await continuations.runtimeStore.put({
        writer: request.continuationWriter,
        payload: new TextEncoder().encode("state-two"),
      });
      yield { type: "continuation_updated", continuation: next };
      yield { type: "done", finalText: "second", stopReason: "complete" };
    });
    await sessions.withSessionMutation(
      session.id,
      reloaded.lastSequence,
      (mutation) => executor.run({
        session: reloaded,
        turnId: "turn-two",
        prompt: "two",
        executionMode: "act",
        runtime: secondRuntime,
        authorization: authorization(session.id, "turn-two"),
        context,
        mutation,
        signal: new AbortController().signal,
      }),
    );

    expect((await sessions.loadState(session.id)).runtimeContinuation)
      .toMatchObject({
        status: "committed",
        continuationSequence: 2,
        vendorTurnSequence: 2,
      });
  });

  it("keeps usage unavailable when the runtime emits no usage", async () => {
    const { sessions, session, executor, emitted } = await fixture();
    const runtime = scriptedRuntime(async function* () {
      yield { type: "done", finalText: "no usage", stopReason: "length" };
    });

    const result = await sessions.withSessionMutation(session.id, 0, (mutation) =>
      executor.run({
        session,
        turnId: "turn-no-usage",
        prompt: "inspect",
        executionMode: "act",
        runtime,
        authorization: authorization(session.id, "turn-no-usage"),
        context,
        mutation,
        signal: new AbortController().signal,
      })
    );

    expect(result).toMatchObject({
      finalText: "no usage",
      usage: null,
      usageSource: "unavailable",
      steps: null,
    });
    expect(emitted).toContainEqual(expect.objectContaining({
      type: "turn_completed",
      usage: null,
    }));
  });

  it("sums every real optional usage field without inventing absent fields", async () => {
    const { sessions, session, executor } = await fixture();
    const runtime = scriptedRuntime(async function* () {
      yield {
        type: "usage",
        usage: {
          inputTokens: 2,
          outputTokens: 3,
          cachedInputTokens: 1,
          reasoningTokens: 2,
        },
      };
      yield {
        type: "usage",
        usage: {
          inputTokens: 5,
          outputTokens: 7,
          cacheWriteInputTokens: 4,
          reasoningTokens: 6,
          costUsd: 0.5,
        },
      };
      yield { type: "done", finalText: "used", stopReason: "complete" };
    });

    const result = await sessions.withSessionMutation(session.id, 0, (mutation) =>
      executor.run({
        session,
        turnId: "turn-usage",
        prompt: "inspect",
        executionMode: "act",
        runtime,
        authorization: authorization(session.id, "turn-usage"),
        context,
        mutation,
        signal: new AbortController().signal,
      })
    );
    expect(result.usage).toEqual({
      inputTokens: 7,
      outputTokens: 10,
      cachedInputTokens: 1,
      cacheWriteInputTokens: 4,
      reasoningTokens: 8,
      costUsd: 0.5,
    });
  });

  it("preserves ordered de-duplicated runtime files and evidence", async () => {
    const { sessions, session, executor } = await fixture();
    const runtime = scriptedRuntime(async function* () {
      yield { type: "files_changed", paths: ["b.ts", "a.ts", "b.ts"] };
      yield { type: "files_changed", paths: ["c.ts", "a.ts"] };
      yield { type: "evidence", items: ["test-b", "test-a", "test-b"] };
      yield { type: "evidence", items: ["test-c", "test-a"] };
      yield { type: "done", finalText: "changed", stopReason: "complete" };
    });

    const result = await sessions.withSessionMutation(session.id, 0, (mutation) =>
      executor.run({
        session,
        turnId: "turn-artifacts",
        prompt: "inspect",
        executionMode: "act",
        runtime,
        authorization: authorization(session.id, "turn-artifacts"),
        context,
        mutation,
        signal: new AbortController().signal,
      })
    );
    expect(result).toMatchObject({
      changedFiles: ["b.ts", "a.ts", "c.ts"],
      changedFilesSource: "runtime",
      evidence: ["test-b", "test-a", "test-c"],
      evidenceSource: "runtime",
    });
  });

  it.each([
    [
      "usage",
      { ...capabilities, usageEvents: false },
      { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } },
    ],
    [
      "files",
      { ...capabilities, fileEvents: false },
      { type: "files_changed", paths: ["a.ts"] },
    ],
  ] satisfies readonly [string, RuntimeCapabilities, AgentRuntimeEvent][])(
    "rejects %s events when the runtime capability is false",
    async (_name, runtimeCapabilities, event) => {
      const { sessions, session, executor } = await fixture();
      const runtime = scriptedRuntime(async function* () {
        yield event;
        yield { type: "done", finalText: "invalid", stopReason: "complete" };
      }, { capabilities: runtimeCapabilities });
      await expect(sessions.withSessionMutation(session.id, 0, (mutation) =>
        executor.run({
          session,
          turnId: "turn-disabled-event",
          prompt: "inspect",
          executionMode: "act",
          runtime,
          authorization: authorization(session.id, "turn-disabled-event"),
          context,
          mutation,
          signal: new AbortController().signal,
        })
      )).rejects.toMatchObject({ code: "invalid_response", phase: "started" });
    },
  );

  it.each([
    [
      "token overflow",
      [
        { type: "usage", usage: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 } },
        { type: "usage", usage: { inputTokens: 1, outputTokens: 0 } },
      ],
    ],
    [
      "negative usage",
      [{ type: "usage", usage: { inputTokens: -1, outputTokens: 0 } }],
    ],
    [
      "UTF-8 final bytes",
      [{ type: "done", finalText: "ééé", stopReason: "complete" }],
    ],
    [
      "distinct activity IDs",
      [
        {
          type: "activity",
          activity: { id: "one", kind: "other", name: "one", status: "started" },
        },
        {
          type: "activity",
          activity: { id: "two", kind: "other", name: "two", status: "started" },
        },
        { type: "done", finalText: "done", stopReason: "complete" },
      ],
    ],
  ])("rejects bounded %s traffic", async (_name, rawEvents) => {
    const { sessions, session, executor } = await fixture({
      limits: {
        maxEvents: 8,
        maxTextBytes: 8,
        maxReasoningBytes: 8,
        maxFinalTextBytes: 5,
        maxItemBytes: 32,
        maxDistinctItems: 2,
        maxActivityIds: 1,
      },
    });
    const runtime = scriptedRuntime(async function* () {
      for (const event of rawEvents as AgentRuntimeEvent[]) {
        yield event;
      }
      if (!(rawEvents as AgentRuntimeEvent[]).some((event) =>
        event.type === "done"
      )) {
        yield { type: "done", finalText: "done", stopReason: "complete" };
      }
    });
    await expect(sessions.withSessionMutation(session.id, 0, (mutation) =>
      executor.run({
        session,
        turnId: "turn-bounded",
        prompt: "go",
        executionMode: "act",
        runtime,
        authorization: authorization(session.id, "turn-bounded"),
        context,
        mutation,
        signal: new AbortController().signal,
      })
    )).rejects.toMatchObject({ code: "invalid_response", phase: "started" });
  });

  it("fails when the runtime mutates its capability snapshot or profile mid-run", async () => {
    for (const mutation of ["capabilities", "profile"] as const) {
      const { sessions, session, executor } = await fixture();
      const runtime: AgentRuntime = scriptedRuntime(async function* () {
        yield { type: "text_delta", text: "before" };
        if (mutation === "capabilities") {
          (runtime.capabilities as { resume: boolean }).resume = false;
        } else {
          (runtime as { capabilityProfileRevision: string })
            .capabilityProfileRevision = "capabilities-v2";
        }
        yield { type: "done", finalText: "after", stopReason: "complete" };
      });
      await expect(sessions.withSessionMutation(session.id, 0, (lease) =>
        executor.run({
          session,
          turnId: `turn-mutation-${mutation}`,
          prompt: "inspect",
          executionMode: "act",
          runtime,
          authorization: authorization(session.id, `turn-mutation-${mutation}`),
          context,
          mutation: lease,
          signal: new AbortController().signal,
        })
      )).rejects.toMatchObject({ code: "invalid_response", phase: "started" });
    }
  });

  it("recovers and durably preserves a staged handle dropped by the iterator", async () => {
    const { sessions, session, continuations, executor } = await fixture();
    const runtime = scriptedRuntime(async function* (request) {
      await continuations.runtimeStore.put({
        writer: request.continuationWriter,
        payload: new TextEncoder().encode("dropped-state"),
      });
      yield* [] as AgentRuntimeEvent[];
      throw new Error("child exited after put");
    });

    await expect(sessions.withSessionMutation(session.id, 0, (mutation) =>
      executor.run({
        session,
        turnId: "turn-dropped",
        prompt: "inspect",
        executionMode: "act",
        runtime,
        authorization: authorization(session.id, "turn-dropped"),
        context,
        mutation,
        signal: new AbortController().signal,
      })
    )).rejects.toMatchObject({ phase: "started" });
    const records = (await sessions.load(session.id)).records;
    expect(records.map((record) => record.type)).toEqual([
      "session_created",
      "turn_started",
      "runtime_continuation_updated",
      "turn_failed",
    ]);
    expect(records.at(-1)).toMatchObject({
      type: "turn_failed",
      continuation: (records[2] as { continuation: unknown }).continuation,
    });
    expect((await sessions.loadState(session.id)).runtimeContinuation)
      .toMatchObject({ status: "uncertain" });
  });

  it.each(["cancelled", "failed"] as const)(
    "persists an exact uncertain tip on runtime %s",
    async (terminalKind) => {
      const { sessions, session, continuations, executor } = await fixture();
      const vendorFailure: IntegrationFailure = {
        domain: "runtime",
        phase: "preflight",
        code: "transport",
        safeMessage: "vendor-sensitive-message",
        diagnosticId: "vendor-diagnostic",
        retryable: true,
      };
      const runtime = scriptedRuntime(async function* (request) {
        const staged = await continuations.runtimeStore.put({
          writer: request.continuationWriter,
          payload: new TextEncoder().encode("uncertain-state"),
        });
        yield { type: "continuation_updated", continuation: staged };
        yield terminalKind === "cancelled"
          ? { type: "cancelled", reason: "vendor reason", continuation: staged }
          : { type: "failed", failure: vendorFailure, continuation: staged };
      });
      await expect(sessions.withSessionMutation(session.id, 0, (mutation) =>
        executor.run({
          session,
          turnId: `turn-${terminalKind}`,
          prompt: "inspect",
          executionMode: "act",
          runtime,
          authorization: authorization(session.id, `turn-${terminalKind}`),
          context,
          mutation,
          signal: new AbortController().signal,
        })
      )).rejects.toMatchObject({
        phase: "started",
        code: terminalKind === "cancelled" ? "cancelled" : "transport",
        diagnosticId: "diagnostic-1",
      });
      const records = (await sessions.load(session.id)).records;
      expect(records.map((record) => record.type)).toEqual([
        "session_created",
        "turn_started",
        "runtime_continuation_updated",
        terminalKind === "cancelled" ? "turn_cancelled" : "turn_failed",
      ]);
      expect(records.at(-1)).toMatchObject({
        continuation: (records[2] as { continuation: unknown }).continuation,
      });
      expect(JSON.stringify(records.at(-1))).not.toContain("vendor-sensitive");
      expect(JSON.stringify(records.at(-1))).not.toContain("vendor-diagnostic");
    },
  );

  it("turns a continuation commit failure into a durable started failure", async () => {
    const base = new ProcessScopedRuntimeContinuationStore({
      now: () => new Date(now),
    });
    const authority: RuntimeContinuationAuthority = {
      ...base.authority,
      async commit() {
        throw new Error("commit unavailable");
      },
    };
    const { sessions, session, executor } = await fixture({
      continuationAuthority: authority,
    });
    const runtime = scriptedRuntime(async function* (request) {
      const staged = await base.runtimeStore.put({
        writer: request.continuationWriter,
        payload: new TextEncoder().encode("staged"),
      });
      yield { type: "continuation_updated", continuation: staged };
      yield { type: "done", finalText: "not committed", stopReason: "complete" };
    });
    await expect(sessions.withSessionMutation(session.id, 0, (mutation) =>
      executor.run({
        session,
        turnId: "turn-commit-failure",
        prompt: "inspect",
        executionMode: "act",
        runtime,
        authorization: authorization(session.id, "turn-commit-failure"),
        context,
        mutation,
        signal: new AbortController().signal,
      })
    )).rejects.toMatchObject({
      phase: "started",
      code: "runtime_failed",
    });
    expect((await sessions.load(session.id)).records.map((record) => record.type))
      .toEqual([
        "session_created",
        "turn_started",
        "runtime_continuation_updated",
        "turn_failed",
      ]);
  });

  it("attempts capability release without rewriting a durable success", async () => {
    const base = new ProcessScopedRuntimeContinuationStore({
      now: () => new Date(now),
    });
    let releases = 0;
    const authority: RuntimeContinuationAuthority = {
      ...base.authority,
      async release(capability) {
        releases += 1;
        await base.authority.release(capability);
        throw new Error("release failed after revocation");
      },
    };
    const { sessions, session, executor } = await fixture({
      continuationAuthority: authority,
    });
    const runtime = scriptedRuntime(async function* () {
      yield { type: "done", finalText: "durable", stopReason: "complete" };
    });
    await expect(sessions.withSessionMutation(session.id, 0, (mutation) =>
      executor.run({
        session,
        turnId: "turn-release",
        prompt: "inspect",
        executionMode: "act",
        runtime,
        authorization: authorization(session.id, "turn-release"),
        context,
        mutation,
        signal: new AbortController().signal,
      })
    )).resolves.toMatchObject({ finalText: "durable" });
    expect(releases).toBe(1);
    expect((await sessions.load(session.id)).records.at(-1)?.type)
      .toBe("turn_completed");
  });

  it("passes one immutable bounded request to the exact handler and persists its exact ID", async () => {
    let handlerCalls = 0;
    const { sessions, session, executor } = await fixture({
      runtimeApprovals: {
        async request(request) {
          handlerCalls += 1;
          expect(Object.isFrozen(request)).toBe(true);
          expect(Object.isFrozen(request.options)).toBe(true);
          expect(Object.isFrozen(request.options[0])).toBe(true);
          return {
            decision: { outcome: "selected", optionId: "allow-exact" },
            scope: "allow_once",
          };
        },
      },
    });
    let decision: unknown;
    const runtime = scriptedRuntime(async function* (_request, host) {
      decision = await host.requestApproval!(approvalRequest());
      yield { type: "done", finalText: "approved", stopReason: "complete" };
    });

    await sessions.withSessionMutation(session.id, 0, (mutation) =>
      executor.run({
        session,
        turnId: "turn-approval",
        prompt: "inspect",
        executionMode: "act",
        runtime,
        authorization: authorization(session.id, "turn-approval"),
        context,
        mutation,
        signal: new AbortController().signal,
      })
    );
    expect(handlerCalls).toBe(1);
    expect(decision).toEqual({ outcome: "selected", optionId: "allow-exact" });
    expect((await sessions.load(session.id)).records).toContainEqual(
      expect.objectContaining({
        type: "runtime_approval_resolved",
        request: approvalRequest(),
        decision,
        scope: "allow_once",
        provenance: "user",
      }),
    );
  });

  it("auto-selects only one exact policy-compatible allow/reject option", async () => {
    let handlerCalls = 0;
    const { sessions, session, executor } = await fixture({
      runtimeApprovals: {
        async request() {
          handlerCalls += 1;
          return { decision: { outcome: "cancelled" }, scope: "cancel" };
        },
      },
    });
    const decisions: unknown[] = [];
    const runtime = scriptedRuntime(async function* (_request, host) {
      decisions.push(await host.requestApproval!(approvalRequest({
        requestId: "read-1",
        action: "read",
        resource: "src/read.ts",
        risk: "normal",
        options: [
          { optionId: "read-once", name: "Allow", kind: "allow_once" },
          { optionId: "read-always", name: "Always", kind: "allow_always" },
        ],
      })));
      decisions.push(await host.requestApproval!(approvalRequest({
        requestId: "credential-1",
        action: "credential",
        resource: "credential-store",
        options: [
          { optionId: "credential-allow", name: "Allow", kind: "allow_once" },
          { optionId: "credential-reject", name: "Reject", kind: "reject_once" },
        ],
      })));
      yield { type: "done", finalText: "policy", stopReason: "complete" };
    });
    await sessions.withSessionMutation(session.id, 0, (mutation) =>
      executor.run({
        session,
        turnId: "turn-policy",
        prompt: "inspect",
        executionMode: "act",
        runtime,
        authorization: authorization(session.id, "turn-policy"),
        context,
        mutation,
        signal: new AbortController().signal,
      })
    );

    expect(handlerCalls).toBe(0);
    expect(decisions).toEqual([
      { outcome: "selected", optionId: "read-once" },
      { outcome: "selected", optionId: "credential-reject" },
    ]);
    const approvals = (await sessions.load(session.id)).records.filter(
      (record) => record.type === "runtime_approval_resolved",
    );
    expect(approvals).toEqual([
      expect.objectContaining({
        scope: "allow_once",
        provenance: "policy",
        decision: { outcome: "selected", optionId: "read-once" },
      }),
      expect.objectContaining({
        scope: "deny",
        provenance: "policy",
        decision: { outcome: "selected", optionId: "credential-reject" },
      }),
    ]);
  });

  it("maps unknown actions to sensitive/elevated and never guesses among allow IDs", async () => {
    let handlerRequest: RuntimeApprovalRequest | null = null;
    const { sessions, session, executor } = await fixture({
      runtimeApprovals: {
        async request(request) {
          handlerRequest = request;
          return {
            decision: { outcome: "selected", optionId: "allow-two" },
            scope: "allow_once",
          };
        },
      },
    });
    const request = approvalRequest({
      requestId: "unknown-1",
      action: "unknown",
      resource: "vendor extension",
      risk: "normal",
      options: [
        { optionId: "allow-one", name: "First", kind: "allow_once" },
        { optionId: "allow-two", name: "Second", kind: "allow_once" },
      ],
    });
    let decision: unknown;
    const runtime = scriptedRuntime(async function* (_run, host) {
      decision = await host.requestApproval!(request);
      yield { type: "done", finalText: "unknown", stopReason: "complete" };
    });
    await sessions.withSessionMutation(session.id, 0, (mutation) =>
      executor.run({
        session,
        turnId: "turn-unknown",
        prompt: "inspect",
        executionMode: "act",
        runtime,
        authorization: authorization(session.id, "turn-unknown"),
        context,
        mutation,
        signal: new AbortController().signal,
      })
    );
    expect(handlerRequest).toEqual(request);
    expect(decision).toEqual({ outcome: "selected", optionId: "allow-two" });
  });

  it.each(["allow_always", "reject_always"] as const)(
    "never echoes a persistent %s option even when the handler selects it",
    async (kind) => {
      const optionId = `persistent-${kind}`;
      const { sessions, session, executor } = await fixture({
        runtimeApprovals: {
          async request() {
            return {
              decision: { outcome: "selected", optionId },
              scope: kind === "allow_always" ? "allow_once" : "deny",
            };
          },
        },
      });
      let decision: unknown;
      const runtime = scriptedRuntime(async function* (_run, host) {
        decision = await host.requestApproval!(approvalRequest({
          options: [{ optionId, name: "Persistent", kind }],
        }));
        yield { type: "done", finalText: "safe", stopReason: "complete" };
      });
      await sessions.withSessionMutation(session.id, 0, (mutation) =>
        executor.run({
          session,
          turnId: `turn-${kind}`,
          prompt: "inspect",
          executionMode: "act",
          runtime,
          authorization: authorization(session.id, `turn-${kind}`),
          context,
          mutation,
          signal: new AbortController().signal,
        })
      );
      expect(decision).toEqual({ outcome: "cancelled" });
      expect((await sessions.load(session.id)).records).toContainEqual(
        expect.objectContaining({
          type: "runtime_approval_resolved",
          decision: { outcome: "cancelled" },
          scope: "cancel",
          provenance: "user",
        }),
      );
    },
  );

  it("reuses allow_session only for the same exact option in the same Recurs session", async () => {
    let handlerCalls = 0;
    const { sessions, session, executor } = await fixture({
      runtimeApprovals: {
        async request(request) {
          handlerCalls += 1;
          return request.options.some((option) => option.optionId === "session-id")
            ? {
                decision: { outcome: "selected", optionId: "session-id" },
                scope: "allow_session",
              }
            : { decision: { outcome: "cancelled" }, scope: "cancel" };
        },
      },
    });
    const decisions: unknown[] = [];
    const request = approvalRequest({
      requestId: "session-1",
      options: [
        { optionId: "session-id", name: "Allow this session", kind: "allow_once" },
      ],
    });
    const runtime = scriptedRuntime(async function* (_run, host) {
      decisions.push(await host.requestApproval!(request));
      decisions.push(await host.requestApproval!({
        ...request,
        requestId: "session-2",
      }));
      decisions.push(await host.requestApproval!({
        ...request,
        requestId: "session-3",
        options: [{ optionId: "different-id", name: "Different", kind: "allow_once" }],
      }));
      yield { type: "done", finalText: "session", stopReason: "complete" };
    });
    await sessions.withSessionMutation(session.id, 0, (mutation) =>
      executor.run({
        session,
        turnId: "turn-session-grant",
        prompt: "inspect",
        executionMode: "act",
        runtime,
        authorization: authorization(session.id, "turn-session-grant"),
        context,
        mutation,
        signal: new AbortController().signal,
      })
    );
    expect(handlerCalls).toBe(2);
    expect(decisions).toEqual([
      { outcome: "selected", optionId: "session-id" },
      { outcome: "selected", optionId: "session-id" },
      { outcome: "cancelled" },
    ]);
    const approvals = (await sessions.load(session.id)).records.filter(
      (record) => record.type === "runtime_approval_resolved",
    );
    expect(approvals[1]).toMatchObject({
      scope: "allow_session",
      provenance: "policy",
    });

    const other = await sessions.createPinnedSession({
      id: `${session.id}-other`,
      cwd: session.cwd,
      backend: pin,
      at: now.toISOString(),
    });
    const otherRuntime = scriptedRuntime(async function* (_run, host) {
      await host.requestApproval!({ ...request, requestId: "other-session" });
      yield { type: "done", finalText: "other", stopReason: "complete" };
    });
    await sessions.withSessionMutation(other.id, 0, (mutation) =>
      executor.run({
        session: other,
        turnId: "turn-other-session",
        prompt: "inspect",
        executionMode: "act",
        runtime: otherRuntime,
        authorization: authorization(other.id, "turn-other-session"),
        context,
        mutation,
        signal: new AbortController().signal,
      })
    );
    expect(handlerCalls).toBe(3);
  });

  it("does not reuse allow_session when summary or offered option semantics change", async () => {
    let handlerCalls = 0;
    const { sessions, session, executor } = await fixture({
      runtimeApprovals: {
        async request() {
          handlerCalls += 1;
          return handlerCalls === 1
            ? {
                decision: { outcome: "selected", optionId: "stable-id" },
                scope: "allow_session",
              }
            : { decision: { outcome: "cancelled" }, scope: "cancel" };
        },
      },
    });
    const base = approvalRequest({
      requestId: "meaning-1",
      summary: "Original meaning",
      options: [{ optionId: "stable-id", name: "Original label", kind: "allow_once" }],
    });
    const decisions: unknown[] = [];
    const runtime = scriptedRuntime(async function* (_run, host) {
      decisions.push(await host.requestApproval!(base));
      decisions.push(await host.requestApproval!({
        ...base,
        requestId: "meaning-2",
        summary: "Changed meaning",
      }));
      decisions.push(await host.requestApproval!({
        ...base,
        requestId: "meaning-3",
        options: [
          { optionId: "stable-id", name: "Changed label", kind: "allow_once" },
          { optionId: "new-reject", name: "Reject", kind: "reject_once" },
        ],
      }));
      yield { type: "done", finalText: "bounded", stopReason: "complete" };
    });
    await sessions.withSessionMutation(session.id, 0, (mutation) =>
      executor.run({
        session,
        turnId: "turn-grant-meaning",
        prompt: "inspect",
        executionMode: "act",
        runtime,
        authorization: authorization(session.id, "turn-grant-meaning"),
        context,
        mutation,
        signal: new AbortController().signal,
      })
    );
    expect(handlerCalls).toBe(3);
    expect(decisions).toEqual([
      { outcome: "selected", optionId: "stable-id" },
      { outcome: "cancelled" },
      { outcome: "cancelled" },
    ]);
  });

  it("records signal cancellation instead of an allow returned after abort", async () => {
    const controller = new AbortController();
    const { sessions, session, executor } = await fixture({
      runtimeApprovals: {
        async request() {
          controller.abort();
          return {
            decision: { outcome: "selected", optionId: "allow-exact" },
            scope: "allow_once",
          };
        },
      },
    });
    let decision: unknown;
    const runtime = scriptedRuntime(async function* (_run, host) {
      decision = await host.requestApproval!(approvalRequest());
      yield { type: "cancelled", reason: "aborted" };
    });
    await expect(sessions.withSessionMutation(session.id, 0, (mutation) =>
      executor.run({
        session,
        turnId: "turn-approval-abort",
        prompt: "inspect",
        executionMode: "act",
        runtime,
        authorization: authorization(session.id, "turn-approval-abort"),
        context,
        mutation,
        signal: controller.signal,
      })
    )).rejects.toMatchObject({ code: "cancelled", phase: "started" });
    expect(decision).toEqual({ outcome: "cancelled" });
    expect((await sessions.load(session.id)).records).toContainEqual(
      expect.objectContaining({
        type: "runtime_approval_resolved",
        decision: { outcome: "cancelled" },
        scope: "cancel",
        provenance: "signal",
      }),
    );
  });

  it.each([
    [
      "duplicate option IDs",
      approvalRequest({
        options: [
          { optionId: "duplicate", name: "One", kind: "allow_once" },
          { optionId: "duplicate", name: "Two", kind: "reject_once" },
        ],
      }),
      null,
    ],
    [
      "secret canary",
      approvalRequest({
        summary: "Use sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456",
        details: { token: "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456" },
      }),
      "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456",
    ],
  ] as const)("rejects %s before UI or approval persistence", async (
    _name,
    malformed,
    canary,
  ) => {
    let handlerCalls = 0;
    const { sessions, session, executor } = await fixture({
      runtimeApprovals: {
        async request() {
          handlerCalls += 1;
          return { decision: { outcome: "cancelled" }, scope: "cancel" };
        },
      },
    });
    const runtime = scriptedRuntime(async function* (_run, host) {
      try {
        await host.requestApproval!(malformed);
      } catch {
        // A hostile runtime may swallow the callback rejection.
      }
      yield { type: "done", finalText: "must still fail", stopReason: "complete" };
    });
    let failure: unknown;
    try {
      await sessions.withSessionMutation(session.id, 0, (mutation) =>
        executor.run({
          session,
          turnId: "turn-malformed-approval",
          prompt: "inspect",
          executionMode: "act",
          runtime,
          authorization: authorization(session.id, "turn-malformed-approval"),
          context,
          mutation,
          signal: new AbortController().signal,
        })
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "invalid_response", phase: "started" });
    expect(handlerCalls).toBe(0);
    const records = (await sessions.load(session.id)).records;
    expect(records.some((record) => record.type === "runtime_approval_resolved"))
      .toBe(false);
    if (canary !== null) {
      expect(JSON.stringify(records)).not.toContain(canary);
      expect(JSON.stringify(failure)).not.toContain(canary);
    }
  });

  it("rejects a reused runtime approval request ID before a second UI call", async () => {
    let handlerCalls = 0;
    const { sessions, session, executor } = await fixture({
      runtimeApprovals: {
        async request() {
          handlerCalls += 1;
          return { decision: { outcome: "cancelled" }, scope: "cancel" };
        },
      },
    });
    const request = approvalRequest({ requestId: "same-request" });
    const runtime = scriptedRuntime(async function* (_run, host) {
      await host.requestApproval!(request);
      try {
        await host.requestApproval!(request);
      } catch {
        // The executor must remember the protocol fault.
      }
      yield { type: "done", finalText: "must fail", stopReason: "complete" };
    });
    await expect(sessions.withSessionMutation(session.id, 0, (mutation) =>
      executor.run({
        session,
        turnId: "turn-duplicate-request",
        prompt: "inspect",
        executionMode: "act",
        runtime,
        authorization: authorization(session.id, "turn-duplicate-request"),
        context,
        mutation,
        signal: new AbortController().signal,
      })
    )).rejects.toMatchObject({ code: "invalid_response", phase: "started" });
    expect(handlerCalls).toBe(1);
    expect((await sessions.load(session.id)).records.filter(
      (record) => record.type === "runtime_approval_resolved",
    )).toHaveLength(1);
  });

  it("routes host tools through permissions, checkpoints, durable records, and metadata", async () => {
    const checkpoints = new RecordingCheckpoints();
    let toolExecutions = 0;
    const tool: Tool<Record<string, unknown>> = {
      definition: {
        name: "edit_file",
        description: "Edit one file",
        inputSchema: { type: "object" },
      },
      executionClass: "in_process",
      mutating: true,
      parse(input) {
        if (typeof input !== "object" || input === null) {
          throw new ToolError("invalid_input", "Expected an object");
        }
        return input as Record<string, unknown>;
      },
      permissions() {
        return [{ category: "write", resource: "src/file.ts", risk: "elevated" }];
      },
      async execute() {
        toolExecutions += 1;
        return {
          output: "edited",
          metadata: {
            changedFiles: ["b.ts", "a.ts", "b.ts"],
            evidence: ["focused test passed", "focused test passed"],
          },
        };
      },
    };
    let approvalCalls = 0;
    const { sessions, session, executor, emitted } = await fixture({
      tools: toolRegistry(tool, checkpoints),
      approvals: {
        async request() {
          approvalCalls += 1;
          return "allow_session";
        },
      },
    });
    let runtimeResult: unknown;
    const runtime = scriptedRuntime(async function* (_run, host) {
      runtimeResult = await host.executeTool!({
        id: "call-1",
        name: "edit_file",
        arguments: { path: "src/file.ts" },
      }, new AbortController().signal);
      yield { type: "done", finalText: "tool done", stopReason: "complete" };
    });

    const result = await sessions.withSessionMutation(session.id, 0, (mutation) =>
      executor.run({
        session,
        turnId: "turn-host-tool",
        prompt: "edit",
        executionMode: "act",
        runtime,
        authorization: authorization(session.id, "turn-host-tool"),
        context,
        mutation,
        signal: new AbortController().signal,
      })
    );

    expect(runtimeResult).toEqual({ output: "edited" });
    expect(toolExecutions).toBe(1);
    expect(approvalCalls).toBe(1);
    expect(checkpoints.calls).toEqual(["before:call-1", "after:call-1"]);
    expect(result).toMatchObject({
      changedFiles: ["b.ts", "a.ts"],
      changedFilesSource: "host_tools",
      evidence: ["focused test passed"],
      evidenceSource: "host_tools",
    });
    expect((await sessions.load(session.id)).records.map((record) => record.type))
      .toEqual([
        "session_created",
        "turn_started",
        "tool_started",
        "permission_resolved",
        "tool_completed",
        "files_changed",
        "verification_recorded",
        "runtime_completed",
        "turn_completed",
      ]);
    expect(emitted).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool_requested" }),
      expect.objectContaining({ type: "tool_started" }),
      expect.objectContaining({ type: "permission_requested" }),
      expect.objectContaining({ type: "permission_resolved" }),
      expect.objectContaining({ type: "tool_completed" }),
      expect.objectContaining({ type: "files_changed", paths: ["b.ts", "a.ts", "b.ts"] }),
      expect.objectContaining({ type: "verification_recorded" }),
    ]));
  });

  it("returns a bounded tool error after ordinary permission denial", async () => {
    let executions = 0;
    const tool: Tool<Record<string, unknown>> = {
      definition: {
        name: "deploy",
        description: "Deploy",
        inputSchema: { type: "object" },
      },
      executionClass: "in_process",
      mutating: true,
      parse(input) {
        return input as Record<string, unknown>;
      },
      permissions() {
        return [{ category: "deploy", resource: "production", risk: "destructive" }];
      },
      async execute() {
        executions += 1;
        return { output: "deployed" };
      },
    };
    const { sessions, session, executor } = await fixture({
      tools: toolRegistry(tool),
      approvals: { async request() { return "deny"; } },
    });
    let runtimeResult: { output: string } | null = null;
    const runtime = scriptedRuntime(async function* (_run, host) {
      runtimeResult = await host.executeTool!({
        id: "call-denied",
        name: "deploy",
        arguments: {},
      }, new AbortController().signal);
      yield { type: "done", finalText: "denied safely", stopReason: "complete" };
    });
    await sessions.withSessionMutation(session.id, 0, (mutation) =>
      executor.run({
        session,
        turnId: "turn-denied-tool",
        prompt: "deploy",
        executionMode: "act",
        runtime,
        authorization: authorization(session.id, "turn-denied-tool"),
        context,
        mutation,
        signal: new AbortController().signal,
      })
    );
    expect(executions).toBe(0);
    expect(runtimeResult?.output).toContain("permission_denied");
    const records = (await sessions.load(session.id)).records;
    expect(records.some((record) => record.type === "tool_failed")).toBe(true);
    expect(records.some((record) => record.type === "tool_completed")).toBe(false);
    expect(records).toContainEqual(expect.objectContaining({
      type: "permission_resolved",
      decision: "deny",
    }));
  });

  it("omits executeTool when the declared runtime capability is not host_tools", async () => {
    const { sessions, session, executor } = await fixture();
    const runtime = scriptedRuntime(async function* (_run, host) {
      expect(host.executeTool).toBeUndefined();
      expect(host.requestApproval).toBeUndefined();
      yield { type: "done", finalText: "opaque plan", stopReason: "complete" };
    }, {
      capabilities: {
        ...capabilities,
        approvalControl: "none",
        toolExecution: "opaque",
        checkpointing: "none",
      },
    });
    await expect(sessions.withSessionMutation(session.id, 0, (mutation) =>
      executor.run({
        session,
        turnId: "turn-opaque-plan",
        prompt: "plan",
        executionMode: "plan",
        runtime,
        authorization: authorization(session.id, "turn-opaque-plan"),
        context,
        mutation,
        signal: new AbortController().signal,
      })
    )).resolves.toMatchObject({ finalText: "opaque plan" });
  });

  it("serializes concurrent host callbacks and mutation appends", async () => {
    let active = 0;
    let maximumActive = 0;
    const tool: Tool<Record<string, unknown>> = {
      definition: {
        name: "serial",
        description: "Observe serialization",
        inputSchema: { type: "object" },
      },
      executionClass: "in_process",
      mutating: false,
      parse(input) {
        return input as Record<string, unknown>;
      },
      permissions() {
        return [];
      },
      async execute(input) {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return {
          output: String(input.id),
          metadata: { changedFiles: [`${String(input.id)}.ts`] },
        };
      },
    };
    let approvalCalls = 0;
    const { sessions, session, executor } = await fixture({
      tools: toolRegistry(tool),
      runtimeApprovals: {
        async request() {
          approvalCalls += 1;
          return { decision: { outcome: "cancelled" }, scope: "cancel" };
        },
      },
    });
    const runtime = scriptedRuntime(async function* (_run, host) {
      const first = host.executeTool!({
        id: "call-a",
        name: "serial",
        arguments: { id: "a" },
      }, new AbortController().signal);
      const second = host.executeTool!({
        id: "call-b",
        name: "serial",
        arguments: { id: "b" },
      }, new AbortController().signal);
      const approval = host.requestApproval!(approvalRequest({ requestId: "parallel" }));
      expect(await Promise.all([first, second, approval])).toEqual([
        { output: "a" },
        { output: "b" },
        { outcome: "cancelled" },
      ]);
      yield { type: "done", finalText: "serialized", stopReason: "complete" };
    });
    const result = await sessions.withSessionMutation(session.id, 0, (mutation) =>
      executor.run({
        session,
        turnId: "turn-concurrent",
        prompt: "inspect",
        executionMode: "act",
        runtime,
        authorization: authorization(session.id, "turn-concurrent"),
        context,
        mutation,
        signal: new AbortController().signal,
      })
    );
    expect(maximumActive).toBe(1);
    expect(approvalCalls).toBe(1);
    expect(result.changedFiles).toEqual(["a.ts", "b.ts"]);
    const records = (await sessions.load(session.id)).records;
    expect(records.map((record) => record.sequence)).toEqual(
      records.map((_record, index) => index),
    );
    expect(records.map((record) => record.type)).toEqual([
      "session_created",
      "turn_started",
      "tool_started",
      "tool_completed",
      "files_changed",
      "tool_started",
      "tool_completed",
      "files_changed",
      "runtime_approval_resolved",
      "runtime_completed",
      "turn_completed",
    ]);
  });

  it("rejects malformed fire-and-forget tool calls before persistence", async () => {
    const { sessions, session, executor } = await fixture();
    const runtime = scriptedRuntime(async function* (_run, host) {
      void host.executeTool!({
        id: "",
        name: "missing",
        arguments: {},
      }, new AbortController().signal).catch(() => undefined);
      yield { type: "done", finalText: "must fail", stopReason: "complete" };
    });
    await expect(sessions.withSessionMutation(session.id, 0, (mutation) =>
      executor.run({
        session,
        turnId: "turn-fire-forget",
        prompt: "inspect",
        executionMode: "act",
        runtime,
        authorization: authorization(session.id, "turn-fire-forget"),
        context,
        mutation,
        signal: new AbortController().signal,
      })
    )).rejects.toMatchObject({ code: "invalid_response", phase: "started" });
    expect((await sessions.load(session.id)).records.some((record) =>
      record.type === "tool_started"
    )).toBe(false);
  });

  it("rejects a host callback made after the runtime terminal", async () => {
    const { sessions, session, executor } = await fixture();
    const runtime = scriptedRuntime(async function* (_run, host) {
      yield { type: "done", finalText: "premature", stopReason: "complete" };
      try {
        await host.executeTool!({
          id: "late-call",
          name: "missing",
          arguments: {},
        }, new AbortController().signal);
      } catch {
        // The executor still remembers the post-terminal callback.
      }
    });
    await expect(sessions.withSessionMutation(session.id, 0, (mutation) =>
      executor.run({
        session,
        turnId: "turn-late-callback",
        prompt: "inspect",
        executionMode: "act",
        runtime,
        authorization: authorization(session.id, "turn-late-callback"),
        context,
        mutation,
        signal: new AbortController().signal,
      })
    )).rejects.toMatchObject({ code: "invalid_response", phase: "started" });
  });

  it("persists tool cancellation before cancelling the runtime turn", async () => {
    const controller = new AbortController();
    const tool: Tool<Record<string, unknown>> = {
      definition: {
        name: "cancel_tool",
        description: "Cancel",
        inputSchema: { type: "object" },
      },
      executionClass: "in_process",
      mutating: false,
      parse(input) {
        return input as Record<string, unknown>;
      },
      permissions() {
        return [];
      },
      async execute(_input, toolContext) {
        controller.abort();
        expect(toolContext.signal.aborted).toBe(true);
        throw new ToolError("cancelled", "sensitive cancellation detail");
      },
    };
    const { sessions, session, executor } = await fixture({
      tools: toolRegistry(tool),
    });
    const runtime = scriptedRuntime(async function* (_run, host) {
      try {
        await host.executeTool!({
          id: "cancel-call",
          name: "cancel_tool",
          arguments: {},
        }, controller.signal);
      } catch {
        // Runtime reports its own terminal after the host cancellation.
      }
      yield { type: "cancelled", reason: "cancelled" };
    });
    await expect(sessions.withSessionMutation(session.id, 0, (mutation) =>
      executor.run({
        session,
        turnId: "turn-tool-cancel",
        prompt: "inspect",
        executionMode: "act",
        runtime,
        authorization: authorization(session.id, "turn-tool-cancel"),
        context,
        mutation,
        signal: controller.signal,
      })
    )).rejects.toMatchObject({ code: "cancelled", phase: "started" });
    const records = (await sessions.load(session.id)).records;
    expect(records.map((record) => record.type)).toEqual([
      "session_created",
      "turn_started",
      "tool_started",
      "tool_failed",
      "turn_cancelled",
    ]);
    expect(JSON.stringify(records)).not.toContain("sensitive cancellation detail");
  });

  it("does not expose arbitrary tool exceptions to the runtime or session", async () => {
    const canary = "sensitive-tool-exception-canary";
    const tool: Tool<Record<string, unknown>> = {
      definition: {
        name: "explode",
        description: "Explode",
        inputSchema: { type: "object" },
      },
      executionClass: "in_process",
      mutating: false,
      parse(input) {
        return input as Record<string, unknown>;
      },
      permissions() {
        return [];
      },
      async execute() {
        throw new Error(canary);
      },
    };
    const { sessions, session, executor } = await fixture({
      tools: toolRegistry(tool),
    });
    let output = "";
    const runtime = scriptedRuntime(async function* (_run, host) {
      output = (await host.executeTool!({
        id: "explode-call",
        name: "explode",
        arguments: {},
      }, new AbortController().signal)).output;
      yield { type: "done", finalText: "handled", stopReason: "complete" };
    });
    await sessions.withSessionMutation(session.id, 0, (mutation) =>
      executor.run({
        session,
        turnId: "turn-tool-exception",
        prompt: "inspect",
        executionMode: "act",
        runtime,
        authorization: authorization(session.id, "turn-tool-exception"),
        context,
        mutation,
        signal: new AbortController().signal,
      })
    );
    expect(output).not.toContain(canary);
    expect(JSON.stringify((await sessions.load(session.id)).records))
      .not.toContain(canary);
  });
});
