import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createHostInvocation,
  type BackendResolver,
  type IntegrationFailure,
  type ModelProvider,
  type RunResult as CoordinatedRunResult,
  type SessionBackendPin,
} from "@recurs/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BackendRunCoordinator,
  JsonlSessionStore,
  type DirectRunExecutor,
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

const result: CoordinatedRunResult = {
  finalText: "done",
  usage: { inputTokens: 1, outputTokens: 1 },
  usageSource: "provider",
  steps: 1,
  changedFiles: [],
  changedFilesSource: "host_tools",
  evidence: [],
  evidenceSource: "none",
};

const invocation = createHostInvocation({
  invocation: "one_shot",
  userPresent: false,
  remote: false,
  scripted: true,
  embedding: "cli",
});

async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), "recurs-coordinator-"));
  directories.push(directory);
  const sessions = new JsonlSessionStore(path.join(directory, "sessions"));
  await sessions.createPinnedSession({
    id: "s2",
    cwd: directory,
    backend: pin,
    at,
  });
  return { directory, sessions };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("BackendRunCoordinator", () => {
  it("resolves preflight before persisting a prompt", async () => {
    const { sessions } = await setup();
    const failure: IntegrationFailure = {
      domain: "policy",
      phase: "preflight",
      code: "policy_blocked",
      safeMessage: "This run context is not allowed",
      diagnosticId: "policy-test",
      retryable: false,
    };
    const resolver: BackendResolver = {
      resolve: vi.fn(async () => {
        throw failure;
      }),
    };
    const executor: DirectRunExecutor = {
      run: vi.fn(async () => result),
    };
    const coordinator = new BackendRunCoordinator({
      sessions,
      resolver,
      direct: executor,
      now: () => at,
      createId: () => "operation-1",
    });

    const run = await coordinator.start({
      sessionId: "s2",
      expectedSessionRecordSequence: 0,
      prompt: "inspect",
      invocation,
      signal: new AbortController().signal,
    });

    await expect(run.outcome).resolves.toEqual({ ok: false, failure });
    expect(executor.run).not.toHaveBeenCalled();
    expect((await sessions.load("s2")).records).toHaveLength(1);
  });

  it("creates a fresh connection-bound provider for every run", async () => {
    const { sessions } = await setup();
    let providers = 0;
    const resolver: BackendResolver = {
      async resolve() {
        return {
          kind: "direct",
          pin,
          authorization: {
            kind: "run",
            id: "authorization",
            operation: "run",
            sessionId: "s2",
            operationId: "operation",
            turnId: "turn",
            connectionId: pin.connectionId,
            modelId: pin.modelId,
            backendFingerprint: "fingerprint",
            connectionRevision: 1,
            policyRevision: pin.policyRevisionAtCreation,
            billingMode: "strict_primary_only",
            billingSelectionDigest: "billing",
            contextDigest: "context",
            maxRequests: 1,
            expiresAt: at,
          },
          async createProvider() {
            providers += 1;
            return {
              id: `provider-${providers}`,
              async *stream() {
                yield { type: "done", stopReason: "complete" } as const;
              },
            } satisfies ModelProvider;
          },
        };
      },
    };
    const seen: string[] = [];
    const executor: DirectRunExecutor = {
      async run(input) {
        seen.push(input.provider.id);
        return result;
      },
    };
    const coordinator = new BackendRunCoordinator({
      sessions,
      resolver,
      direct: executor,
      now: () => at,
    });
    const input = {
      sessionId: "s2",
      expectedSessionRecordSequence: 0,
      prompt: "inspect",
      invocation,
      signal: new AbortController().signal,
    } as const;

    await (await coordinator.start(input)).outcome;
    await (await coordinator.start(input)).outcome;

    expect(providers).toBe(2);
    expect(seen).toEqual(["provider-1", "provider-2"]);
  });
});
