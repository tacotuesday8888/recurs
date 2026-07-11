import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createHostInvocation,
  type AgentRuntime,
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
  type DelegatedRunExecutor,
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

async function setup(backend: SessionBackendPin = pin) {
  const directory = await mkdtemp(path.join(tmpdir(), "recurs-coordinator-"));
  directories.push(directory);
  const sessions = new JsonlSessionStore(path.join(directory, "sessions"));
  await sessions.createPinnedSession({
    id: "s2",
    cwd: directory,
    backend,
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

  it("rejects authorization that is not bound to the resolved run", async () => {
    const { sessions } = await setup();
    const createProvider = vi.fn(async () => ({
      id: "provider",
      async *stream() {
        yield { type: "done", stopReason: "complete" } as const;
      },
    } satisfies ModelProvider));
    const resolver: BackendResolver = {
      async resolve(input) {
        return {
          kind: "direct",
          pin,
          authorization: {
            kind: "run",
            id: "authorization",
            operation: "run",
            sessionId: "different-session",
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
            maxRequests: 1,
            expiresAt: at,
          },
          createProvider,
        };
      },
    };
    const executor: DirectRunExecutor = {
      run: vi.fn(async () => result),
    };
    const coordinator = new BackendRunCoordinator({
      sessions,
      resolver,
      direct: executor,
    });

    const run = await coordinator.start({
      sessionId: "s2",
      expectedSessionRecordSequence: 0,
      prompt: "inspect",
      invocation,
      signal: new AbortController().signal,
    });

    await expect(run.outcome).resolves.toMatchObject({
      ok: false,
      failure: {
        phase: "preflight",
        code: "authorization_denied",
      },
    });
    expect(createProvider).not.toHaveBeenCalled();
    expect(executor.run).not.toHaveBeenCalled();
    expect((await sessions.load("s2")).records).toHaveLength(1);
  });

  it("reports unknown executor failures with the existing diagnostic id", async () => {
    const { sessions } = await setup();
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
            maxRequests: 1,
            expiresAt: at,
          },
          async createProvider() {
            return {
              id: "provider",
              async *stream() {
                yield { type: "done", stopReason: "complete" } as const;
              },
            } satisfies ModelProvider;
          },
        };
      },
    };
    const coordinator = new BackendRunCoordinator({
      sessions,
      resolver,
      direct: {
        async run() {
          throw new Error("provider transport included sensitive details");
        },
      },
      createId: () => "coordinator-diagnostic",
    });

    const run = await coordinator.start({
      sessionId: "s2",
      expectedSessionRecordSequence: 0,
      prompt: "inspect",
      invocation,
      signal: new AbortController().signal,
    });

    await expect(run.outcome).resolves.toMatchObject({
      ok: false,
      failure: {
        domain: "runtime",
        phase: "started",
        code: "runtime_failed",
        safeMessage:
          "Unexpected failure (diagnostic coordinator-diagnostic)",
        diagnosticId: "coordinator-diagnostic",
      },
    });
    await expect(run.outcome).resolves.not.toEqual(
      expect.objectContaining({
        failure: expect.objectContaining({
          safeMessage: expect.stringContaining("sensitive details"),
        }),
      }),
    );
  });

  it("dispatches agent-runtime pins through the delegated lane", async () => {
    const runtimePin: SessionBackendPin = {
      ...pin,
      kind: "agent_runtime",
      providerId: "official-runtime",
      adapterId: "official-runtime-v1",
      connectionId: "runtime-connection",
      modelId: "runtime-model",
    };
    const { sessions } = await setup(runtimePin);
    const runtime: AgentRuntime = {
      adapterId: runtimePin.adapterId,
      connectionId: runtimePin.connectionId,
      async *run() {
        yield { type: "done", finalText: "done", stopReason: "complete" };
      },
    };
    const createRuntime = vi.fn(async () => runtime);
    const resolver: BackendResolver = {
      async resolve(input) {
        return {
          kind: "delegated",
          pin: runtimePin,
          authorization: {
            kind: "run",
            id: "authorization",
            operation: "run",
            sessionId: input.sessionId,
            operationId: input.operationId,
            turnId: input.turnId,
            connectionId: runtimePin.connectionId,
            modelId: runtimePin.modelId,
            backendFingerprint: "fingerprint",
            connectionRevision: 1,
            policyRevision: runtimePin.policyRevisionAtCreation,
            billingMode: "strict_primary_only",
            billingSelectionDigest: "billing",
            contextDigest: "context",
            maxRequests: 1,
            expiresAt: at,
          },
          createRuntime,
        };
      },
    };
    const direct: DirectRunExecutor = {
      run: vi.fn(async () => result),
    };
    const delegated: DelegatedRunExecutor = {
      run: vi.fn(async (input) => {
        expect(input.runtime).toBe(runtime);
        return result;
      }),
    };
    const coordinator = new BackendRunCoordinator({
      sessions,
      resolver,
      direct,
      delegated,
    });

    const run = await coordinator.start({
      sessionId: "s2",
      expectedSessionRecordSequence: 0,
      prompt: "inspect",
      invocation,
      signal: new AbortController().signal,
    });

    await expect(run.outcome).resolves.toMatchObject({ ok: true });
    expect(createRuntime).toHaveBeenCalledOnce();
    expect(direct.run).not.toHaveBeenCalled();
    expect(delegated.run).toHaveBeenCalledOnce();
  });

  it("holds the session mutation lease from preflight through execution", async () => {
    const { sessions } = await setup();
    let continueResolution!: () => void;
    const resolutionGate = new Promise<void>((resolve) => {
      continueResolution = resolve;
    });
    let enteredResolution!: () => void;
    const resolving = new Promise<void>((resolve) => {
      enteredResolution = resolve;
    });
    const resolver: BackendResolver = {
      async resolve(input) {
        enteredResolution();
        await resolutionGate;
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
            maxRequests: 1,
            expiresAt: at,
          },
          async createProvider() {
            return {
              id: "provider",
              async *stream() {
                yield { type: "done", stopReason: "complete" } as const;
              },
            } satisfies ModelProvider;
          },
        };
      },
    };
    const coordinator = new BackendRunCoordinator({
      sessions,
      resolver,
      direct: { async run() { return result; } },
    });
    const active = await coordinator.start({
      sessionId: "s2",
      expectedSessionRecordSequence: 0,
      prompt: "inspect",
      invocation,
      signal: new AbortController().signal,
    });
    await resolving;

    await expect(
      new JsonlSessionStore(sessions.directory).withSessionMutation(
        "s2",
        0,
        async () => undefined,
      ),
    ).rejects.toMatchObject({ code: "session_busy" });
    const competing = await coordinator.start({
      sessionId: "s2",
      expectedSessionRecordSequence: 0,
      prompt: "competing",
      invocation,
      signal: new AbortController().signal,
    });
    await expect(competing.outcome).resolves.toMatchObject({
      ok: false,
      failure: { code: "session_conflict" },
    });

    continueResolution();
    await expect(active.outcome).resolves.toMatchObject({ ok: true });
  });
});
