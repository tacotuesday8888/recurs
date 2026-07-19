import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createHostInvocation,
  deriveTrustedRunContext,
  getOperatingModePolicy,
  type BackendResolver,
} from "@recurs/contracts";
import { ScriptedProvider } from "@recurs/providers";
import { ToolRegistry } from "@recurs/tools";
import { afterEach, describe, expect, it } from "vitest";

import {
  AgentLoopDirectExecutor,
  BackendRunCoordinator,
  JsonlSessionStore,
  bindRunAuthorization,
} from "../src/index.js";
import { testAt, testBackendPin } from "../../../tests/support/backend.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("AgentLoopDirectExecutor", () => {
  it("runs the agent loop inside the coordinator's existing mutation lease", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "recurs-direct-executor-"));
    directories.push(directory);
    const sessions = new JsonlSessionStore(path.join(directory, "sessions"));
    const pin = testBackendPin();
    await sessions.createPinnedSession({
      id: "s2",
      cwd: directory,
      backend: pin,
      at: testAt,
    });
    const provider = new ScriptedProvider([
      [
        { type: "text_delta", text: "coordinated" },
        { type: "done", stopReason: "complete" },
      ],
    ]);
    let authorizedTurnId: string | null = null;
    const resolver: BackendResolver = {
      async resolve(input) {
        authorizedTurnId = input.turnId;
        return {
          kind: "direct",
          pin,
          authorization: bindRunAuthorization({
            id: "authorization",
            operation: "run",
            sessionId: input.sessionId,
            operationId: input.operationId,
            turnId: input.turnId,
            pin,
            connectionRevision: 1,
            policyRevision: pin.policyRevisionAtCreation,
            context: input.context,
            maxRequests: 4,
            expiresAt: "2099-01-01T00:00:00.000Z",
          }, new Date(testAt)),
          async createProvider() {
            return provider;
          },
        };
      },
    };
    let toolRunContext: unknown;
    const direct = new AgentLoopDirectExecutor({
      tools: new ToolRegistry(),
      approvals: { async request() { return "deny"; } },
      sessions,
      async emit() {},
      createToolContext(state, signal, runContext) {
        toolRunContext = runContext;
        return {
          sessionId: state.id,
          cwd: state.cwd,
          executionMode: state.executionMode,
          signal,
          readRevisions: new Map(),
        };
      },
    });
    const coordinator = new BackendRunCoordinator({
      sessions,
      resolver,
      direct,
    });

    const run = await coordinator.start({
      sessionId: "s2",
      expectedSessionRecordSequence: 0,
      prompt: "inspect",
      invocation: createHostInvocation({
        invocation: "one_shot",
        userPresent: false,
        remote: false,
        scripted: true,
        embedding: "cli",
      }),
      signal: new AbortController().signal,
    });

    await expect(run.outcome).resolves.toMatchObject({
      ok: true,
      result: { finalText: "coordinated" },
    });
    expect((await sessions.loadState("s2")).messages.map((message) => message.role))
      .toEqual(["user", "assistant"]);
    expect(
      (await sessions.load("s2")).records.find(
        (record) => record.type === "turn_started",
      ),
    ).toMatchObject({ turnId: authorizedTurnId });
    expect(toolRunContext).toEqual({
      invocation: "one_shot",
      presence: "unattended",
      location: "local",
      automation: "scripted",
      embedding: "cli",
    });
  });

  it("enforces the request budget carried by the run authorization", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "recurs-direct-budget-"));
    directories.push(directory);
    const sessions = new JsonlSessionStore(path.join(directory, "sessions"));
    const pin = testBackendPin();
    const session = await sessions.createPinnedSession({
      id: "s2",
      cwd: directory,
      backend: pin,
      at: testAt,
    });
    const executor = new AgentLoopDirectExecutor({
      tools: new ToolRegistry(),
      approvals: { async request() { return "deny"; } },
      sessions,
      async emit() {},
      createToolContext(state, signal) {
        return {
          sessionId: state.id,
          cwd: state.cwd,
          executionMode: state.executionMode,
          signal,
          readRevisions: new Map(),
        };
      },
    });
    const provider = new ScriptedProvider([
      [
        {
          type: "tool_call",
          call: { id: "call-1", name: "missing", arguments: {} },
        },
        { type: "done", stopReason: "tool_calls" },
      ],
      [
        { type: "text_delta", text: "must not reach a second request" },
        { type: "done", stopReason: "complete" },
      ],
    ]);

    await expect(
      sessions.withSessionMutation("s2", 0, (mutation) =>
        executor.run({
          session,
          turnId: "turn-1",
          prompt: "inspect",
          executionMode: "act",
          provider,
          authorization: {
            kind: "run",
            id: "authorization",
            operation: "run",
            sessionId: "s2",
            operationId: "operation-1",
            turnId: "turn-1",
            connectionId: pin.connectionId,
            modelId: pin.modelId,
            backendFingerprint: "fingerprint",
            connectionRevision: 1,
            policyRevision: pin.policyRevisionAtCreation,
            billingMode: "strict_primary_only",
            billingSelectionDigest: "billing",
            contextDigest: "context",
            maxRequests: 1,
            expiresAt: testAt,
          },
          context: deriveTrustedRunContext(createHostInvocation({
            invocation: "one_shot",
            userPresent: false,
            remote: false,
            scripted: true,
            embedding: "cli",
          })),
          mutation,
          signal: new AbortController().signal,
        })
      ),
    ).rejects.toMatchObject({ code: "step_budget_exceeded" });
  });

  it("clamps a child to its operating-mode request limit", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "recurs-child-budget-"));
    directories.push(directory);
    const sessions = new JsonlSessionStore(path.join(directory, "sessions"));
    const pin = testBackendPin();
    const mode = getOperatingModePolicy("economy_v2");
    const childRequestLimit = 4;
    const session = await sessions.createPinnedSession({
      id: "child-session",
      cwd: directory,
      backend: pin,
      at: testAt,
      agent: {
        id: "child-agent",
        role: "child",
        profile: { id: "explore_v1", version: 1 },
        parentAgentId: "parent-agent",
        parentSessionId: "parent-session",
        depth: 1,
        task: { id: "task", description: "Bounded task", prompt: "Inspect" },
        operatingMode: { id: mode.id, version: mode.version },
        backend: {
          strategy: "inherit_parent",
          adapterId: pin.adapterId,
          connectionId: pin.connectionId,
          modelId: pin.modelId,
        },
        permissions: {
          parentExecutionMode: "act",
          executionMode: "plan",
          parentPermissionMode: "ask_always",
          permissionMode: "ask_always",
        },
        limits: { ...mode.orchestration, maxRequests: childRequestLimit },
      },
    });
    const executor = new AgentLoopDirectExecutor({
      tools: new ToolRegistry(),
      approvals: { async request() { return "deny"; } },
      sessions,
      async emit() {},
      createToolContext(state, signal) {
        return {
          sessionId: state.id,
          cwd: state.cwd,
          executionMode: state.executionMode,
          signal,
          readRevisions: new Map(),
        };
      },
    });
    const provider = new ScriptedProvider([
      ...Array.from({ length: childRequestLimit }, (_, index) => [
        {
          type: "tool_call" as const,
          call: { id: `call-${index}`, name: `missing-${index}`, arguments: {} },
        },
        { type: "done" as const, stopReason: "tool_calls" as const },
      ]),
      [
        { type: "text_delta" as const, text: "must not reach request nine" },
        { type: "done" as const, stopReason: "complete" as const },
      ],
    ]);
    const context = deriveTrustedRunContext(createHostInvocation({
      invocation: "one_shot",
      userPresent: true,
      remote: false,
      scripted: false,
      embedding: "cli",
    }));

    await expect(sessions.withSessionMutation(session.id, 0, (mutation) =>
      executor.run({
        session,
        turnId: "child-turn",
        prompt: "Inspect",
        executionMode: "act",
        provider,
        authorization: {
          kind: "run",
          id: "authorization",
          operation: "run",
          sessionId: session.id,
          operationId: "operation",
          turnId: "child-turn",
          connectionId: pin.connectionId,
          modelId: pin.modelId,
          backendFingerprint: "fingerprint",
          connectionRevision: 1,
          policyRevision: pin.policyRevisionAtCreation,
          billingMode: "strict_primary_only",
          billingSelectionDigest: "billing",
          contextDigest: "context",
          maxRequests: 40,
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
        context,
        mutation,
        signal: new AbortController().signal,
      })
    )).rejects.toMatchObject({ code: "step_budget_exceeded" });
    expect(provider.requests).toHaveLength(childRequestLimit);
  });
});
