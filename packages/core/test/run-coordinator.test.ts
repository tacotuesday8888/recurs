import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createHostInvocation,
  deriveTrustedRunContext,
  type RuntimeCapabilities,
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
  ProcessScopedRuntimeContinuationStore,
  bindRunAuthorization,
  type DelegatedRunExecutor,
  type DirectRunExecutor,
} from "../src/index.js";

const directories: string[] = [];
const at = "2026-07-10T00:00:00.000Z";
const expiresAt = "2099-01-01T00:00:00.000Z";
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

const delegatedPin: SessionBackendPin & { kind: "agent_runtime" } = {
  ...pin,
  kind: "agent_runtime",
  runtimeCapabilityProfileRevisionAtCreation: "capabilities-v1",
  providerId: "official-runtime",
  adapterId: "official-runtime-v1",
  connectionId: "runtime-connection",
  modelId: "runtime-model",
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

const runtimeCapabilities: RuntimeCapabilities = {
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
  toolExecution: "host_tools",
  checkpointing: "host_tools",
};

function authorizationFor(
  input: Parameters<BackendResolver["resolve"]>[0],
  backend: SessionBackendPin,
) {
  return bindRunAuthorization({
    id: `authorization-${input.operationId}`,
    operation: input.operation,
    sessionId: input.sessionId,
    operationId: input.operationId,
    turnId: input.turnId,
    pin: backend,
    connectionRevision: 1,
    policyRevision: backend.policyRevisionAtCreation,
    context: input.context,
    maxRequests: 40,
    expiresAt,
  }, new Date(at));
}

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

function runtimeFor(
  backend: SessionBackendPin & { kind: "agent_runtime" } = delegatedPin,
  overrides: Partial<AgentRuntime> = {},
): AgentRuntime {
  return {
    adapterId: backend.adapterId,
    connectionId: backend.connectionId,
    capabilities: runtimeCapabilities,
    capabilityProfileRevision:
      backend.runtimeCapabilityProfileRevisionAtCreation ?? "missing",
    async *run() {
      yield { type: "done", finalText: "done", stopReason: "complete" };
    },
    async reconcile() {
      return "uncertain";
    },
    ...overrides,
  };
}

async function seedUncertainContinuation(
  sessions: JsonlSessionStore,
  store: ProcessScopedRuntimeContinuationStore,
  sessionId = "s2",
) {
  const authorization = bindRunAuthorization({
    id: "seed-authorization",
    operation: "run",
    sessionId,
    operationId: "seed-operation",
    turnId: "seed-turn",
    pin: delegatedPin,
    connectionRevision: 1,
    policyRevision: delegatedPin.policyRevisionAtCreation,
    context: deriveTrustedRunContext(invocation),
    maxRequests: 1,
    expiresAt,
  }, new Date(at));
  const writer = await store.authority.mintWriter({
    authorization,
    pin: delegatedPin,
    expectedSessionRecordSequence: 0,
    previous: null,
    stateVersion: 1,
  });
  const continuation = await store.runtimeStore.put({
    writer,
    payload: new TextEncoder().encode("vendor-session"),
  });
  const interrupted: IntegrationFailure = {
    domain: "runtime",
    phase: "started",
    code: "runtime_failed",
    safeMessage: "The delegated runtime stopped before completion",
    diagnosticId: "seed-failure",
    retryable: false,
  };
  await sessions.withSessionMutation(sessionId, 0, async (mutation) => {
    await mutation.append({
      type: "turn_started",
      turnId: "seed-turn",
      prompt: "seed",
      at,
    });
    await mutation.append({
      type: "runtime_continuation_updated",
      turnId: "seed-turn",
      continuation,
      at,
    });
    await mutation.append({
      type: "turn_failed",
      turnId: "seed-turn",
      error: interrupted,
      continuation,
      at,
    });
  });
  return continuation;
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
          authorization: authorizationFor(input, pin),
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
            ...authorizationFor(input, pin),
            sessionId: "different-session",
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
          authorization: authorizationFor(input, pin),
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
    const runtimePin = delegatedPin;
    const { sessions } = await setup(runtimePin);
    const runtime = runtimeFor(runtimePin);
    const createRuntime = vi.fn(async () => runtime);
    const resolver: BackendResolver = {
      async resolve(input) {
        return {
          kind: "delegated",
          pin: runtimePin,
          authorization: authorizationFor(input, runtimePin),
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
        expect(input.context).toEqual({
          invocation: "one_shot",
          presence: "unattended",
          location: "local",
          automation: "scripted",
          embedding: "cli",
        });
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

  it("rejects a delegated resolution for a direct pin before its factory", async () => {
    const { sessions } = await setup();
    const createRuntime = vi.fn(async () => runtimeFor(delegatedPin));
    const resolver: BackendResolver = {
      async resolve(input) {
        return {
          kind: "delegated",
          pin,
          authorization: authorizationFor(input, pin),
          createRuntime,
        };
      },
    };
    const coordinator = new BackendRunCoordinator({
      sessions,
      resolver,
      direct: { async run() { return result; } },
      delegated: { async run() { return result; } },
    });

    const outcome = (await coordinator.start({
      sessionId: "s2",
      expectedSessionRecordSequence: 0,
      prompt: "inspect",
      invocation,
      signal: new AbortController().signal,
    })).outcome;

    await expect(outcome).resolves.toMatchObject({
      ok: false,
      failure: { phase: "preflight" },
    });
    expect(createRuntime).not.toHaveBeenCalled();
    expect((await sessions.load("s2")).records).toHaveLength(1);
  });

  it("rejects a direct resolution for an agent-runtime pin before its factory", async () => {
    const { sessions } = await setup(delegatedPin);
    const createProvider = vi.fn(async () => ({
      id: "wrong-lane",
      async *stream() {
        yield { type: "done", stopReason: "complete" } as const;
      },
    } satisfies ModelProvider));
    const resolver: BackendResolver = {
      async resolve(input) {
        return {
          kind: "direct",
          pin: delegatedPin,
          authorization: authorizationFor(input, delegatedPin),
          createProvider,
        };
      },
    };
    const coordinator = new BackendRunCoordinator({
      sessions,
      resolver,
      direct: { async run() { return result; } },
      delegated: { async run() { return result; } },
    });

    const outcome = (await coordinator.start({
      sessionId: "s2",
      expectedSessionRecordSequence: 0,
      prompt: "inspect",
      invocation,
      signal: new AbortController().signal,
    })).outcome;

    await expect(outcome).resolves.toMatchObject({
      ok: false,
      failure: { phase: "preflight" },
    });
    expect(createProvider).not.toHaveBeenCalled();
    expect((await sessions.load("s2")).records).toHaveLength(1);
  });

  it("verifies canonical authorization digests before constructing a backend", async () => {
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
            ...authorizationFor(input, pin),
            contextDigest: `sha256:${"0".repeat(64)}`,
          },
          createProvider,
        };
      },
    };
    const coordinator = new BackendRunCoordinator({
      sessions,
      resolver,
      direct: { async run() { return result; } },
    });

    const outcome = (await coordinator.start({
      sessionId: "s2",
      expectedSessionRecordSequence: 0,
      prompt: "inspect",
      invocation,
      signal: new AbortController().signal,
    })).outcome;

    await expect(outcome).resolves.toMatchObject({
      ok: false,
      failure: {
        domain: "policy",
        phase: "preflight",
        code: "authorization_denied",
      },
    });
    expect(createProvider).not.toHaveBeenCalled();
  });

  it("rejects an authorization that expires before backend construction", async () => {
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
          authorization: bindRunAuthorization({
            id: "short-authorization",
            operation: "run",
            sessionId: input.sessionId,
            operationId: input.operationId,
            turnId: input.turnId,
            pin,
            connectionRevision: 1,
            policyRevision: pin.policyRevisionAtCreation,
            context: input.context,
            maxRequests: 1,
            expiresAt: "2026-07-10T00:01:00.000Z",
          }, new Date(at)),
          createProvider,
        };
      },
    };
    const coordinator = new BackendRunCoordinator({
      sessions,
      resolver,
      direct: { async run() { return result; } },
      now: () => "2026-07-10T00:02:00.000Z",
    });

    const outcome = (await coordinator.start({
      sessionId: "s2",
      expectedSessionRecordSequence: 0,
      prompt: "inspect",
      invocation,
      signal: new AbortController().signal,
    })).outcome;

    await expect(outcome).resolves.toMatchObject({
      ok: false,
      failure: {
        phase: "preflight",
        code: "authorization_denied",
        safeMessage: expect.stringContaining("expired"),
      },
    });
    expect(createProvider).not.toHaveBeenCalled();
  });

  it.each([
    ["adapter", { adapterId: "wrong-adapter" }],
    ["connection", { connectionId: "wrong-connection" }],
    ["capability profile", { capabilityProfileRevision: "wrong-profile" }],
  ] satisfies readonly [string, Partial<AgentRuntime>][]) (
    "rejects a mismatched delegated %s before executor or prompt persistence",
    async (_name, overrides) => {
      const { sessions } = await setup(delegatedPin);
      const runtime = runtimeFor(delegatedPin, overrides);
      const delegated: DelegatedRunExecutor = {
        run: vi.fn(async () => result),
      };
      const resolver: BackendResolver = {
        async resolve(input) {
          return {
            kind: "delegated",
            pin: delegatedPin,
            authorization: authorizationFor(input, delegatedPin),
            async createRuntime() {
              return runtime;
            },
          };
        },
      };
      const coordinator = new BackendRunCoordinator({
        sessions,
        resolver,
        direct: { async run() { return result; } },
        delegated,
      });

      const outcome = (await coordinator.start({
        sessionId: "s2",
        expectedSessionRecordSequence: 0,
        prompt: "inspect",
        invocation,
        signal: new AbortController().signal,
      })).outcome;

      await expect(outcome).resolves.toMatchObject({
        ok: false,
        failure: { phase: "preflight" },
      });
      expect(delegated.run).not.toHaveBeenCalled();
      expect((await sessions.load("s2")).records).toHaveLength(1);
    },
  );

  it.each(["committed", "gone"] as const)(
    "reconciles an uncertain delegated continuation as %s before a fresh run",
    async (reconciliationOutcome) => {
      const { sessions } = await setup(delegatedPin);
      const continuations = new ProcessScopedRuntimeContinuationStore();
      const uncertain = await seedUncertainContinuation(sessions, continuations);
      const operations: string[] = [];
      const runtime = runtimeFor(delegatedPin, {
        async reconcile(input) {
          const payload = await continuations.runtimeStore.load({
            reader: input.reader,
            handle: input.continuation,
          });
          expect(new TextDecoder().decode(payload)).toBe("vendor-session");
          return reconciliationOutcome;
        },
      });
      const resolver: BackendResolver = {
        async resolve(input) {
          operations.push(input.operation);
          return {
            kind: "delegated",
            pin: delegatedPin,
            authorization: authorizationFor(input, delegatedPin),
            async createRuntime() {
              return runtime;
            },
          };
        },
      };
      const delegated: DelegatedRunExecutor = {
        run: vi.fn(async (input) => {
          expect(input.session.lastSequence).toBe(4);
          expect(input.mutation.currentSequence).toBe(4);
          expect(input.session.runtimeContinuation).toEqual(
            reconciliationOutcome === "committed"
              ? { ...uncertain, status: "committed" }
              : null,
          );
          return result;
        }),
      };
      const coordinator = new BackendRunCoordinator({
        sessions,
        resolver,
        direct: { async run() { return result; } },
        delegated,
        continuationAuthority: continuations.authority,
      });

      const outcome = (await coordinator.start({
        sessionId: "s2",
        expectedSessionRecordSequence: 3,
        prompt: "continue",
        invocation,
        signal: new AbortController().signal,
      })).outcome;

      await expect(outcome).resolves.toMatchObject({ ok: true });
      expect(operations).toEqual(["runtime_reconcile", "run"]);
      expect(delegated.run).toHaveBeenCalledOnce();
      expect((await sessions.load("s2")).records.at(4)).toMatchObject({
        type: "runtime_continuation_reconciled",
        uncertainHandle: uncertain,
        outcome: reconciliationOutcome,
      });
    },
  );

  it("keeps an uncertain continuation fail-closed without starting a new run", async () => {
    const { sessions } = await setup(delegatedPin);
    const continuations = new ProcessScopedRuntimeContinuationStore();
    await seedUncertainContinuation(sessions, continuations);
    const resolver: BackendResolver = {
      async resolve(input) {
        return {
          kind: "delegated",
          pin: delegatedPin,
          authorization: authorizationFor(input, delegatedPin),
          async createRuntime() {
            return runtimeFor(delegatedPin, {
              async reconcile(reconcileInput) {
                await continuations.runtimeStore.load({
                  reader: reconcileInput.reader,
                  handle: reconcileInput.continuation,
                });
                return "uncertain";
              },
            });
          },
        };
      },
    };
    const delegated: DelegatedRunExecutor = {
      run: vi.fn(async () => result),
    };
    const coordinator = new BackendRunCoordinator({
      sessions,
      resolver,
      direct: { async run() { return result; } },
      delegated,
      continuationAuthority: continuations.authority,
    });

    const outcome = (await coordinator.start({
      sessionId: "s2",
      expectedSessionRecordSequence: 3,
      prompt: "continue",
      invocation,
      signal: new AbortController().signal,
    })).outcome;

    await expect(outcome).resolves.toMatchObject({
      ok: false,
      failure: {
        phase: "preflight",
        code: "continuation_uncertain",
      },
    });
    expect(delegated.run).not.toHaveBeenCalled();
    expect((await sessions.load("s2")).records).toHaveLength(4);
  });

  it("rejects mismatched reconciliation authorization before its runtime factory", async () => {
    const { sessions } = await setup(delegatedPin);
    const continuations = new ProcessScopedRuntimeContinuationStore();
    await seedUncertainContinuation(sessions, continuations);
    const createRuntime = vi.fn(async () => runtimeFor(delegatedPin));
    const resolver: BackendResolver = {
      async resolve(input) {
        return {
          kind: "delegated",
          pin: delegatedPin,
          authorization: {
            ...authorizationFor(input, delegatedPin),
            billingSelectionDigest: `sha256:${"0".repeat(64)}`,
          },
          createRuntime,
        };
      },
    };
    const coordinator = new BackendRunCoordinator({
      sessions,
      resolver,
      direct: { async run() { return result; } },
      delegated: { async run() { return result; } },
      continuationAuthority: continuations.authority,
    });

    const outcome = (await coordinator.start({
      sessionId: "s2",
      expectedSessionRecordSequence: 3,
      prompt: "continue",
      invocation,
      signal: new AbortController().signal,
    })).outcome;

    await expect(outcome).resolves.toMatchObject({
      ok: false,
      failure: { phase: "preflight", code: "authorization_denied" },
    });
    expect(createRuntime).not.toHaveBeenCalled();
    expect((await sessions.load("s2")).records).toHaveLength(4);
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
          authorization: authorizationFor(input, pin),
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
