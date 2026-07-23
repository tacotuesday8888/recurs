import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

import type {
  AgentRunRequest,
  AgentRuntimeEvent,
  RuntimeContinuationStore,
} from "@recurs/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  CODEX_APP_SERVER_PROFILE_REVISION,
  createAccountBoundCodexAppServerRuntime,
  type CodexAppServerProcessProfile,
} from "@recurs/runtimes";

const fixture = fileURLToPath(
  new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url),
);

function profile(scenario: string): CodexAppServerProcessProfile {
  return {
    command: process.execPath,
    args: [fixture, "--scenario", scenario],
    environment: {},
    bounds: {
      maxFrameBytes: 64 * 1_024,
      maxStdoutBytes: 2 * 1_024 * 1_024,
      maxStderrBytes: 64 * 1_024,
      maxFrames: 512,
      maxPendingRequests: 8,
      requestTimeoutMs: 2_000,
      shutdownTimeoutMs: 500,
    },
  };
}

function fingerprint(email = "person@example.com"): string {
  return `sha256:${createHash("sha256")
    .update(`openai-codex-chatgpt\0${email}`)
    .digest("hex")}`;
}

function request(
  signal = new AbortController().signal,
): AgentRunRequest {
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
      connectionId: "connection-1",
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
  };
}

const store: RuntimeContinuationStore = {
  async put() {
    throw new Error("V1 runtime must not persist vendor continuation state");
  },
  async load() {
    throw new Error("V1 runtime must not load vendor continuation state");
  },
};

async function collect(
  scenario: string,
  host: Parameters<ReturnType<typeof createAccountBoundCodexAppServerRuntime>["run"]>[1] = {},
  runRequest = request(),
  expectedFingerprint = fingerprint(),
  onEvent?: (event: AgentRuntimeEvent) => void,
): Promise<AgentRuntimeEvent[]> {
  const runtime = createAccountBoundCodexAppServerRuntime({
    connectionId: "connection-1",
    modelId: "gpt-test",
    reasoningEffort: "ultra",
    expectedAccountSubjectFingerprint: expectedFingerprint,
    store,
    processProfile: profile(scenario),
  });
  const events: AgentRuntimeEvent[] = [];
  for await (const event of runtime.run(runRequest, host)) {
    events.push(event);
    onEvent?.(event);
  }
  return events;
}

describe("Codex app-server runtime", () => {
  it("runs an exact read-only-environment turn and normalizes usage", async () => {
    const events = await collect("runtime-text");
    expect(events).toContainEqual({ type: "text_delta", text: "hello from Codex" });
    expect(events).toContainEqual({
      type: "usage",
      usage: {
        inputTokens: 10,
        cachedInputTokens: 3,
        outputTokens: 4,
        reasoningTokens: 2,
      },
    });
    expect(events.at(-1)).toEqual({
      type: "done",
      finalText: "hello from Codex",
      stopReason: "complete",
    });
  });

  it("routes dynamic tools only through the Recurs host", async () => {
    const executeTool = vi.fn(async () => ({ output: "README contents" }));
    const events = await collect("runtime-tool", {
      tools: [{
        name: "read_file",
        description: "Read one workspace file",
        inputSchema: { type: "object" },
      }],
      executeTool,
    });
    expect(executeTool).toHaveBeenCalledWith({
      id: "call-1",
      name: "read_file",
      arguments: { path: "README.md" },
    }, expect.any(AbortSignal));
    expect(events.at(-1)).toEqual({
      type: "done",
      finalText: "tool said: README contents",
      stopReason: "complete",
    });
  });

  it("interrupts the vendor turn when Recurs cancels", async () => {
    const controller = new AbortController();
    const events = await collect(
      "runtime-cancel",
      {},
      request(controller.signal),
      fingerprint(),
      (event) => {
        if (
          event.type === "activity" &&
          event.activity.name === "codex_turn"
        ) controller.abort();
      },
    );
    expect(events.at(-1)).toMatchObject({ type: "cancelled" });
  });

  it("fails before starting a thread when the account binding changes", async () => {
    const events = await collect(
      "runtime-text",
      {},
      request(),
      fingerprint("different@example.com"),
    );
    expect(events.at(-1)).toMatchObject({
      type: "failed",
      failure: { code: "account_mismatch" },
    });
  });

  it("advertises only capabilities implemented by the V1 bridge", () => {
    const runtime = createAccountBoundCodexAppServerRuntime({
      connectionId: "connection-1",
      modelId: "gpt-test",
      reasoningEffort: "ultra",
      expectedAccountSubjectFingerprint: fingerprint(),
      store,
      processProfile: profile("runtime-text"),
    });
    expect(runtime.capabilityProfileRevision).toBe(
      CODEX_APP_SERVER_PROFILE_REVISION,
    );
    expect(runtime.capabilities).toEqual(expect.objectContaining({
      resume: false,
      cancellation: "protocol",
      approvalControl: "host",
      planMode: "enforced",
      toolExecution: "host_tools",
      checkpointing: "host_tools",
    }));
  });
});
