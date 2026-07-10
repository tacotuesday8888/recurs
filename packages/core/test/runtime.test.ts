import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createHostInvocation,
  type IntegrationFailure,
  type RunCoordinator,
  type SessionBackendPin,
} from "@recurs/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CoordinatedRuntime,
  CoordinatedRunError,
  JsonlSessionStore,
} from "../src/index.js";

const directories: string[] = [];
const at = "2026-07-10T00:00:00.000Z";
const pin: SessionBackendPin = {
  kind: "model_provider",
  providerId: "scripted",
  adapterId: "scripted-v1",
  connectionId: "test-connection",
  modelId: "scripted-model",
  modelIdentityKind: "versioned",
  providerResolvedModelRevisionAtCreation: "scripted-model-1",
  catalogRevision: "test-catalog-1",
  policyRevisionAtCreation: "test-policy-1",
  billingPolicyRevisionAtCreation: "test-billing-1",
  primaryBillingSourceAtCreation: "local_compute",
  billingSelectionAtCreation: {
    mode: "strict_primary_only",
    policyRevision: "test-policy-1",
    disclosureRevision: "test-disclosure-1",
    allowedSources: ["local_compute"],
    acknowledgedAt: at,
  },
  accountSubjectFingerprint: "test-account",
};
const invocation = createHostInvocation({
  invocation: "repl",
  userPresent: true,
  remote: false,
  scripted: false,
  embedding: "cli",
});

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function setup(coordinator: RunCoordinator) {
  const directory = await mkdtemp(path.join(tmpdir(), "recurs-core-runtime-"));
  directories.push(directory);
  const sessions = new JsonlSessionStore(path.join(directory, "sessions"));
  const state = await sessions.createPinnedSession({
    id: "s2",
    cwd: directory,
    backend: pin,
    at,
  });
  return new CoordinatedRuntime({ sessions, coordinator }, state);
}

describe("CoordinatedRuntime", () => {
  it("passes the exact durable sequence and host invocation to the coordinator", async () => {
    const start = vi.fn<RunCoordinator["start"]>(async () => ({
      events: {
        [Symbol.asyncIterator]() {
          return { async next() { return { done: true, value: undefined }; } };
        },
      },
      outcome: Promise.resolve({
        ok: true,
        result: {
          finalText: "done",
          usage: null,
          usageSource: "unavailable",
          steps: null,
          changedFiles: [],
          changedFilesSource: "host_tools",
          evidence: [],
          evidenceSource: "none",
        },
      }),
    }));
    const runtime = await setup({ start });

    await expect(
      runtime.run("inspect", invocation, new AbortController().signal),
    ).resolves.toMatchObject({ finalText: "done" });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "s2",
      expectedSessionRecordSequence: 0,
      prompt: "inspect",
      invocation,
    }));
  });

  it("raises typed safe failures returned by preflight", async () => {
    const failure: IntegrationFailure = {
      domain: "policy",
      phase: "preflight",
      code: "policy_blocked",
      safeMessage: "This context is not allowed",
      diagnosticId: "policy-test",
      retryable: false,
    };
    const runtime = await setup({
      async start() {
        return {
          events: {
            [Symbol.asyncIterator]() {
              return { async next() { return { done: true, value: undefined }; } };
            },
          },
          outcome: Promise.resolve({ ok: false, failure }),
        };
      },
    });

    await expect(
      runtime.run("inspect", invocation, new AbortController().signal),
    ).rejects.toEqual(new CoordinatedRunError(failure));
  });
});
