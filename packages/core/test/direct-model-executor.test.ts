import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createHostInvocation, type BackendResolver } from "@recurs/contracts";
import { ScriptedProvider } from "@recurs/providers";
import { ToolRegistry } from "@recurs/tools";
import { afterEach, describe, expect, it } from "vitest";

import {
  AgentLoopDirectExecutor,
  BackendRunCoordinator,
  JsonlSessionStore,
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
    const resolver: BackendResolver = {
      async resolve(input) {
        return {
          kind: "direct",
          pin,
          authorization: {
            kind: "run",
            id: "authorization",
            operation: "run",
            sessionId: input.sessionId,
            operationId: input.operationId,
            turnId: input.turnId,
            connectionId: pin.connectionId,
            modelId: pin.modelId,
            backendFingerprint: "fingerprint",
            connectionRevision: 1,
            policyRevision: pin.policyRevisionAtCreation,
            billingMode: "strict_primary_only",
            billingSelectionDigest: "billing",
            contextDigest: "context",
            maxRequests: 4,
            expiresAt: testAt,
          },
          async createProvider() {
            return provider;
          },
        };
      },
    };
    const direct = new AgentLoopDirectExecutor({
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
  });
});
