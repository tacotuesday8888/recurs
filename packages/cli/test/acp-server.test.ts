import path from "node:path";

import * as acp from "@agentclientprotocol/sdk";
import type { HostInvocation, RunResult } from "@recurs/contracts";
import type { EventSink } from "@recurs/core";
import { describe, expect, it } from "vitest";

import {
  createRecursAcpApp,
  type AcpRuntime,
} from "../src/acp-server.js";

const cwd = path.resolve("/tmp/recurs-acp-test");

const runResult: RunResult = {
  finalText: "done",
  usage: null,
  usageSource: "unavailable",
  steps: 1,
  changedFiles: [],
  changedFilesSource: "none",
  evidence: [],
  evidenceSource: "none",
};

interface FakeRuntimeOptions {
  readonly run?: (
    events: EventSink,
    confirm: (message: string) => Promise<boolean>,
  ) => Promise<RunResult>;
}

class FakeRuntime implements AcpRuntime {
  #confirm: (message: string) => Promise<boolean> = async () => false;
  readonly invocations: HostInvocation[] = [];
  cancelled = false;
  closed = 0;

  constructor(
    private readonly events: EventSink,
    private readonly options: FakeRuntimeOptions = {},
  ) {}

  setConfirmHandler(confirm: (message: string) => Promise<boolean>): void {
    this.#confirm = confirm;
  }

  cancel(): boolean {
    this.cancelled = true;
    return true;
  }

  async close(): Promise<void> {
    this.closed += 1;
  }

  async submit(_input: string, invocation: HostInvocation): Promise<RunResult> {
    this.invocations.push(invocation);
    return this.options.run?.(this.events, this.#confirm) ?? runResult;
  }
}

function testClient(
  updates: acp.SessionNotification[],
  permissionRequests: acp.RequestPermissionRequest[],
): acp.ClientApp {
  return acp.client({ name: "recurs-test-client" })
    .onNotification(acp.methods.client.session.update, (context) => {
      updates.push(context.params);
    })
    .onRequest(acp.methods.client.session.requestPermission, (context) => {
      permissionRequests.push(context.params);
      return {
        outcome: { outcome: "selected", optionId: "recurs-allow-once" },
      };
    });
}

describe("Recurs ACP agent", () => {
  it("negotiates honestly and streams tools, permission, agents, and text", async () => {
    const updates: acp.SessionNotification[] = [];
    const permissions: acp.RequestPermissionRequest[] = [];
    let runtime: FakeRuntime | undefined;
    let receivedCwd: string | undefined;
    const app = createRecursAcpApp({
      async createRuntime(sessionCwd, events) {
        receivedCwd = sessionCwd;
        runtime = new FakeRuntime(events, {
          async run(sink, confirm) {
            const base = {
              sessionId: "recurs-internal",
              at: "2026-07-19T00:00:00.000Z",
            };
            await sink.emit({
              ...base,
              type: "tool_requested",
              call: {
                id: "tool-1",
                name: "apply_patch",
                arguments: { path: "src/index.ts" },
              },
            });
            await sink.emit({
              ...base,
              type: "tool_started",
              call: {
                id: "tool-1",
                name: "apply_patch",
                arguments: { path: "src/index.ts" },
              },
            });
            expect(await confirm("Allow write access?")).toBe(true);
            await sink.emit({
              ...base,
              type: "tool_completed",
              callId: "tool-1",
              result: { output: "patched" },
            });
            await sink.emit({
              ...base,
              type: "agent_started",
              parentAgentId: "parent-1",
              childAgentId: "child-1",
              childSessionId: "child-session-1",
              taskId: "task-1",
              description: "Review the patch",
              operatingModeId: "balanced_v4",
              profileId: "review_v2",
            });
            await sink.emit({
              ...base,
              type: "agent_completed",
              parentAgentId: "parent-1",
              childAgentId: "child-1",
              childSessionId: "child-session-1",
              profileId: "review_v2",
              usage: null,
              changedFiles: [],
              evidence: ["reviewed"],
              costLimitExceeded: false,
              workflow: {
                childrenStarted: 1,
                maxChildren: 2,
                requestsReserved: 1,
                requestsUsed: 1,
                maxRequests: 4,
                reportedCostUsd: 0,
                maxReportedCostUsd: 1,
              },
            });
            await sink.emit({
              ...base,
              type: "model_text_delta",
              turnId: "turn-1",
              text: "Finished safely.",
            });
            return { ...runResult, finalText: "Finished safely." };
          },
        });
        return runtime;
      },
    });

    await testClient(updates, permissions).connectWith(app, async (client) => {
      const initialized = await client.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "test", version: "1" },
      });
      expect(initialized).toEqual({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentInfo: { name: "recurs", version: "0.0.0" },
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: {},
          sessionCapabilities: { close: {} },
        },
        authMethods: [],
      });
      expect(initialized.agentCapabilities?.mcpCapabilities).toBeUndefined();

      const created = await client.request(acp.methods.agent.session.new, {
        cwd,
        mcpServers: [],
      });
      const response = await client.request(acp.methods.agent.session.prompt, {
        sessionId: created.sessionId,
        prompt: [
          { type: "text", text: "Inspect this" },
          {
            type: "resource_link",
            name: "README",
            uri: "file:///tmp/recurs-acp-test/README.md",
          },
        ],
      });

      expect(response).toEqual({ stopReason: "end_turn" });
      await client.request(acp.methods.agent.session.close, {
        sessionId: created.sessionId,
      });
    });

    expect(receivedCwd).toBe(cwd);
    expect(runtime?.invocations).toHaveLength(1);
    expect(runtime?.closed).toBe(1);
    expect(runtime?.invocations[0]).toMatchObject({
      invocation: "one_shot",
      userPresent: false,
      remote: false,
      scripted: true,
      embedding: "sdk",
    });
    expect(permissions).toHaveLength(1);
    expect(permissions[0]?.options.map((option) => option.kind)).toEqual([
      "allow_once",
      "reject_once",
    ]);
    expect(permissions[0]?.toolCall).toMatchObject({
      toolCallId: "tool-1",
      kind: "edit",
    });
    expect(updates.map((entry) => entry.update.sessionUpdate)).toEqual([
      "tool_call",
      "tool_call_update",
      "tool_call_update",
      "tool_call",
      "tool_call_update",
      "agent_message_chunk",
    ]);
    expect(updates[0]?.update).toMatchObject({
      toolCallId: "tool-1",
      locations: [{ path: path.join(cwd, "src/index.ts") }],
    });
  });

  it("cancels an active Recurs turn and reports the truthful stop reason", async () => {
    const updates: acp.SessionNotification[] = [];
    let runtime: FakeRuntime | undefined;
    let started: (() => void) | undefined;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    let finish: (() => void) | undefined;
    const finishPromise = new Promise<void>((resolve) => { finish = resolve; });
    const app = createRecursAcpApp({
      async createRuntime(_cwd, events) {
        runtime = new FakeRuntime(events, {
          async run() {
            started?.();
            await finishPromise;
            return runResult;
          },
        });
        return runtime;
      },
    });

    await testClient(updates, []).connectWith(app, async (client) => {
      const created = await client.request(acp.methods.agent.session.new, {
        cwd,
        mcpServers: [],
      });
      const prompt = client.request(acp.methods.agent.session.prompt, {
        sessionId: created.sessionId,
        prompt: [{ type: "text", text: "Keep working" }],
      });
      await startedPromise;
      await client.notify(acp.methods.agent.session.cancel, {
        sessionId: created.sessionId,
      });
      finish?.();
      await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
    });

    expect(runtime?.cancelled).toBe(true);
    expect(runtime?.closed).toBe(1);
  });

  it("rejects unsupported roots, MCP servers, content, and closed sessions", async () => {
    const app = createRecursAcpApp({
      async createRuntime(_cwd, events) {
        return new FakeRuntime(events);
      },
    });

    await testClient([], []).connectWith(app, async (client) => {
      await expect(client.request(acp.methods.agent.session.new, {
        cwd,
        additionalDirectories: [path.join(cwd, "other")],
        mcpServers: [],
      })).rejects.toMatchObject({ code: -32602 });
      await expect(client.request(acp.methods.agent.session.new, {
        cwd,
        mcpServers: [{
          name: "unsafe",
          command: "node",
          args: ["server.js"],
          env: [],
        }],
      })).rejects.toMatchObject({ code: -32602 });

      const created = await client.request(acp.methods.agent.session.new, {
        cwd,
        mcpServers: [],
      });
      await expect(client.request(acp.methods.agent.session.prompt, {
        sessionId: created.sessionId,
        prompt: [{ type: "image", data: "AA==", mimeType: "image/png" }],
      })).rejects.toMatchObject({ code: -32602 });
      await client.request(acp.methods.agent.session.close, {
        sessionId: created.sessionId,
      });
      await expect(client.request(acp.methods.agent.session.prompt, {
        sessionId: created.sessionId,
        prompt: [{ type: "text", text: "hello" }],
      })).rejects.toMatchObject({ code: -32002 });
    });
  });
});
