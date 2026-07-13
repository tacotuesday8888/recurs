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
  type RuntimeContinuationAuthority,
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

  it("lets cancellation after resolution prevent a backend factory", async () => {
    const { sessions } = await setup();
    const controller = new AbortController();
    const createProvider = vi.fn(async () => ({
      id: "provider",
      async *stream() {
        yield { type: "done", stopReason: "complete" } as const;
      },
    } satisfies ModelProvider));
    const resolver: BackendResolver = {
      async resolve(input) {
        controller.abort();
        return {
          kind: "direct",
          pin,
          authorization: authorizationFor(input, pin),
          createProvider,
        };
      },
    };
    const direct: DirectRunExecutor = {
      run: vi.fn(async () => result),
    };
    const coordinator = new BackendRunCoordinator({ sessions, resolver, direct });

    const outcome = (await coordinator.start({
      sessionId: "s2",
      expectedSessionRecordSequence: 0,
      prompt: "inspect",
      invocation,
      signal: controller.signal,
    })).outcome;

    await expect(outcome).resolves.toMatchObject({
      ok: false,
      failure: { phase: "preflight", code: "cancelled" },
    });
    expect(createProvider).not.toHaveBeenCalled();
    expect(direct.run).not.toHaveBeenCalled();
    expect((await sessions.load("s2")).records).toHaveLength(1);
  });

  it("normalizes a resolver rejection after cancellation as preflight cancellation", async () => {
    const { sessions } = await setup();
    const controller = new AbortController();
    const resolver: BackendResolver = {
      async resolve() {
        controller.abort();
        throw new Error("resolver transport details must not win over abort");
      },
    };
    const direct: DirectRunExecutor = {
      run: vi.fn(async () => result),
    };
    const coordinator = new BackendRunCoordinator({ sessions, resolver, direct });

    const outcome = (await coordinator.start({
      sessionId: "s2",
      expectedSessionRecordSequence: 0,
      prompt: "inspect",
      invocation,
      signal: controller.signal,
    })).outcome;

    await expect(outcome).resolves.toMatchObject({
      ok: false,
      failure: { phase: "preflight", code: "cancelled" },
    });
    expect(direct.run).not.toHaveBeenCalled();
    expect((await sessions.load("s2")).records).toHaveLength(1);
  });

  it("lets cancellation during a backend factory prevent executor dispatch", async () => {
    const { sessions } = await setup();
    const controller = new AbortController();
    const resolver: BackendResolver = {
      async resolve(input) {
        return {
          kind: "direct",
          pin,
          authorization: authorizationFor(input, pin),
          async createProvider() {
            controller.abort();
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
    const direct: DirectRunExecutor = {
      run: vi.fn(async () => result),
    };
    const coordinator = new BackendRunCoordinator({ sessions, resolver, direct });

    const outcome = (await coordinator.start({
      sessionId: "s2",
      expectedSessionRecordSequence: 0,
      prompt: "inspect",
      invocation,
      signal: controller.signal,
    })).outcome;

    await expect(outcome).resolves.toMatchObject({
      ok: false,
      failure: { phase: "preflight", code: "cancelled" },
    });
    expect(direct.run).not.toHaveBeenCalled();
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
              id: pin.providerId,
              adapterId: pin.adapterId,
              connectionId: pin.connectionId,
              async *stream() {
                yield { type: "done", stopReason: "complete" } as const;
              },
            } satisfies ModelProvider;
          },
        };
      },
    };
    const seen: ModelProvider[] = [];
    const executor: DirectRunExecutor = {
      async run(input) {
        seen.push(input.provider);
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
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });

  it.each([
    [
      "provider",
      {
        id: "wrong-provider",
        adapterId: pin.adapterId,
        connectionId: pin.connectionId,
      },
    ],
    ["adapter", { adapterId: "wrong-adapter", connectionId: pin.connectionId }],
    ["connection", { adapterId: pin.adapterId, connectionId: "wrong-connection" }],
  ] as const)(
    "rejects a mismatched direct-provider %s before execution or prompt persistence",
    async (_name, identity) => {
      const { sessions } = await setup();
      const direct: DirectRunExecutor = {
        run: vi.fn(async () => result),
      };
      const resolver: BackendResolver = {
        async resolve(input) {
          return {
            kind: "direct",
            pin,
            authorization: authorizationFor(input, pin),
            async createProvider() {
              return {
                id: pin.providerId,
                ...identity,
                async *stream() {
                  yield { type: "done", stopReason: "complete" } as const;
                },
              };
            },
          };
        },
      };
      const coordinator = new BackendRunCoordinator({
        sessions,
        resolver,
        direct,
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
          domain: "connection",
          phase: "preflight",
          code: "connection_invalid",
        },
      });
      expect(direct.run).not.toHaveBeenCalled();
      expect((await sessions.load("s2")).records).toHaveLength(1);
    },
  );

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
              id: pin.providerId,
              adapterId: pin.adapterId,
              connectionId: pin.connectionId,
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

  it("reconciles gone after renewing an expired predecessor through its live successor", async () => {
    const { sessions } = await setup(delegatedPin);
    let currentTime = Date.parse(at);
    const continuations = new ProcessScopedRuntimeContinuationStore({
      now: () => new Date(currentTime),
      capabilityTtlMs: 5_000,
      continuationTtlMs: 1_000,
    });
    const trustedContext = deriveTrustedRunContext(invocation);
    const seedAuthorization = (turnId: string) => bindRunAuthorization({
      id: `seed-${turnId}`,
      operation: "run",
      sessionId: "s2",
      operationId: `seed-operation-${turnId}`,
      turnId,
      pin: delegatedPin,
      connectionRevision: 1,
      policyRevision: delegatedPin.policyRevisionAtCreation,
      context: trustedContext,
      maxRequests: 1,
      expiresAt,
    }, new Date(at));
    const firstAuthorization = seedAuthorization("turn-1");
    const firstWriter = await continuations.authority.mintWriter({
      authorization: firstAuthorization,
      pin: delegatedPin,
      expectedSessionRecordSequence: 0,
      previous: null,
      stateVersion: 1,
    });
    const firstUncertain = await continuations.runtimeStore.put({
      writer: firstWriter,
      payload: new TextEncoder().encode("first-vendor-session"),
    });
    const firstFinalization = await continuations.authority.prepareFinalization({
      authorization: firstAuthorization,
      handle: firstUncertain,
      outcome: "committed",
      expectedSessionRecordSequence: 2,
    });
    await continuations.authority.acknowledgeFinalization({
      authorization: firstAuthorization,
      receipt: firstFinalization.receipt,
      durableSessionRecordSequence: 3,
    });
    const firstCommitted = firstFinalization.activeHandle!;
    const seededResult: CoordinatedRunResult = {
      finalText: "first",
      usage: null,
      usageSource: "unavailable",
      steps: null,
      changedFiles: [],
      changedFilesSource: "none",
      evidence: [],
      evidenceSource: "none",
    };
    await sessions.withSessionMutation("s2", 0, async (mutation) => {
      await mutation.append({ type: "turn_started", turnId: "turn-1", prompt: "first", at });
      await mutation.append({ type: "runtime_continuation_updated", turnId: "turn-1", continuation: firstUncertain, at });
      await mutation.append({
        type: "runtime_completed",
        turnId: "turn-1",
        result: seededResult,
        stopReason: "complete",
        continuation: firstCommitted,
        provenance: {
          adapterId: delegatedPin.adapterId,
          connectionId: delegatedPin.connectionId,
          modelId: delegatedPin.modelId,
          backendFingerprint: firstCommitted.backendFingerprint,
          capabilityProfileRevision: "capabilities-v1",
        },
        at,
      });
      await mutation.append({ type: "turn_completed", turnId: "turn-1", result: seededResult, at });
    });

    currentTime += 900;
    const secondAuthorization = seedAuthorization("turn-2");
    const secondWriter = await continuations.authority.mintWriter({
      authorization: secondAuthorization,
      pin: delegatedPin,
      expectedSessionRecordSequence: 4,
      previous: firstCommitted,
      stateVersion: 1,
    });
    const secondUncertain = await continuations.runtimeStore.put({
      writer: secondWriter,
      payload: new TextEncoder().encode("second-vendor-session"),
    });
    const interrupted: IntegrationFailure = {
      domain: "runtime",
      phase: "started",
      code: "runtime_failed",
      safeMessage: "The delegated runtime stopped before completion",
      diagnosticId: "seed-second-failure",
      retryable: false,
    };
    await sessions.withSessionMutation("s2", 4, async (mutation) => {
      await mutation.append({ type: "turn_started", turnId: "turn-2", prompt: "second", at });
      await mutation.append({ type: "runtime_continuation_updated", turnId: "turn-2", continuation: secondUncertain, at });
      await mutation.append({ type: "turn_failed", turnId: "turn-2", error: interrupted, continuation: secondUncertain, at });
    });

    currentTime += 101;
    const runtime = runtimeFor(delegatedPin, {
      async reconcile(input) {
        await continuations.runtimeStore.load({
          reader: input.reader,
          handle: input.continuation,
        });
        return "gone";
      },
    });
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
    const renewedPredecessor = {
      ...firstCommitted,
      expiresAt: secondUncertain.expiresAt,
    };
    const delegated: DelegatedRunExecutor = {
      run: vi.fn(async (input) => {
        expect(input.session.runtimeContinuation).toEqual(renewedPredecessor);
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
      expectedSessionRecordSequence: 7,
      prompt: "continue",
      invocation,
      signal: new AbortController().signal,
    })).outcome;

    await expect(outcome).resolves.toMatchObject({ ok: true });
    expect(delegated.run).toHaveBeenCalledOnce();
    expect((await sessions.load("s2")).records.at(-1)).toMatchObject({
      type: "runtime_continuation_reconciled",
      outcome: "gone",
      activeHandle: renewedPredecessor,
    });
  });

  it.each(["committed", "gone"] as const)(
    "retries %s reconciliation after its durable append fails",
    async (reconciliationOutcome) => {
      const { sessions } = await setup(delegatedPin);
      const continuations = new ProcessScopedRuntimeContinuationStore();
      const uncertain = await seedUncertainContinuation(sessions, continuations);
      let failReconciliationAppend = true;
      const realWithSessionMutation = sessions.withSessionMutation.bind(sessions);
      vi.spyOn(sessions, "withSessionMutation").mockImplementation(
        async (sessionId, expectedSequence, operation) =>
          realWithSessionMutation(
            sessionId,
            expectedSequence,
            async (mutation) => operation({
              sessionId: mutation.sessionId,
              fencingToken: mutation.fencingToken,
              get currentSequence() {
                return mutation.currentSequence;
              },
              async append(record) {
                if (
                  failReconciliationAppend &&
                  record.type === "runtime_continuation_reconciled"
                ) {
                  throw new Error("reconciliation append unavailable");
                }
                return mutation.append(record);
              },
            }),
          ),
      );
      const runtime = runtimeFor(delegatedPin, {
        async reconcile(input) {
          await continuations.runtimeStore.load({
            reader: input.reader,
            handle: input.continuation,
          });
          return reconciliationOutcome;
        },
      });
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
      const input = {
        sessionId: "s2",
        expectedSessionRecordSequence: 3,
        prompt: "continue",
        invocation,
        signal: new AbortController().signal,
      } as const;

      await expect((await coordinator.start(input)).outcome).resolves
        .toMatchObject({ ok: false });
      expect((await sessions.load("s2")).records).toHaveLength(4);

      const retryAuthorization = bindRunAuthorization({
        id: `retry-${reconciliationOutcome}`,
        operation: "runtime_reconcile",
        sessionId: "s2",
        operationId: `retry-operation-${reconciliationOutcome}`,
        turnId: null,
        pin: delegatedPin,
        connectionRevision: 1,
        policyRevision: delegatedPin.policyRevisionAtCreation,
        context: deriveTrustedRunContext(invocation),
        maxRequests: 1,
        expiresAt,
      }, new Date(at));
      const retryReader = await continuations.authority.mintReader({
        authorization: retryAuthorization,
        pin: delegatedPin,
        expectedSessionRecordSequence: 3,
        purpose: "reconcile",
        activeHandles: [uncertain],
      });
      await expect(continuations.runtimeStore.load({
        reader: retryReader,
        handle: uncertain,
      })).resolves.toEqual(new TextEncoder().encode("vendor-session"));

      failReconciliationAppend = false;
      await expect((await coordinator.start(input)).outcome).resolves
        .toMatchObject({ ok: true });
      expect(delegated.run).toHaveBeenCalledOnce();
      expect((await sessions.load("s2")).records).toHaveLength(5);
    },
  );

  it("lets cancellation during reconciliation prevent durable resolution and a fresh run", async () => {
    const { sessions } = await setup(delegatedPin);
    const continuations = new ProcessScopedRuntimeContinuationStore();
    const uncertain = await seedUncertainContinuation(sessions, continuations);
    const controller = new AbortController();
    const operations: string[] = [];
    const createRuntime = vi.fn(async () => runtimeFor(delegatedPin, {
      async reconcile(input) {
        await continuations.runtimeStore.load({
          reader: input.reader,
          handle: input.continuation,
        });
        controller.abort();
        return "committed";
      },
    }));
    const resolver: BackendResolver = {
      async resolve(input) {
        operations.push(input.operation);
        return {
          kind: "delegated",
          pin: delegatedPin,
          authorization: authorizationFor(input, delegatedPin),
          createRuntime,
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
      signal: controller.signal,
    })).outcome;

    await expect(outcome).resolves.toMatchObject({
      ok: false,
      failure: { phase: "preflight", code: "cancelled" },
    });
    expect(operations).toEqual(["runtime_reconcile"]);
    expect(createRuntime).toHaveBeenCalledOnce();
    expect(delegated.run).not.toHaveBeenCalled();
    expect((await sessions.load("s2")).records).toHaveLength(4);

    const retryAuthorization = authorizationFor({
      operation: "runtime_reconcile",
      operationId: "retry-after-abort",
      sessionId: "s2",
      turnId: null,
      pin: delegatedPin,
      context: deriveTrustedRunContext(invocation),
      signal: new AbortController().signal,
    }, delegatedPin);
    const retryReader = await continuations.authority.mintReader({
      authorization: retryAuthorization,
      pin: delegatedPin,
      expectedSessionRecordSequence: 3,
      purpose: "reconcile",
      activeHandles: [uncertain],
    });
    await expect(continuations.runtimeStore.load({
      reader: retryReader,
      handle: uncertain,
    })).resolves.toEqual(new TextEncoder().encode("vendor-session"));
  });

  it("releases a reconciliation reader when cancellation wins its mint await", async () => {
    const { sessions } = await setup(delegatedPin);
    const continuations = new ProcessScopedRuntimeContinuationStore();
    await seedUncertainContinuation(sessions, continuations);
    const controller = new AbortController();
    let releases = 0;
    const authority: RuntimeContinuationAuthority = {
      ...continuations.authority,
      async mintReader(input) {
        const reader = await continuations.authority.mintReader(input);
        controller.abort();
        return reader;
      },
      async release(capability) {
        releases += 1;
        await continuations.authority.release(capability);
      },
    };
    const reconcile = vi.fn(async () => "committed" as const);
    const resolver: BackendResolver = {
      async resolve(input) {
        return {
          kind: "delegated",
          pin: delegatedPin,
          authorization: authorizationFor(input, delegatedPin),
          async createRuntime() {
            return runtimeFor(delegatedPin, { reconcile });
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
      continuationAuthority: authority,
    });

    const outcome = (await coordinator.start({
      sessionId: "s2",
      expectedSessionRecordSequence: 3,
      prompt: "continue",
      invocation,
      signal: controller.signal,
    })).outcome;

    await expect(outcome).resolves.toMatchObject({
      ok: false,
      failure: { phase: "preflight", code: "cancelled" },
    });
    expect(reconcile).not.toHaveBeenCalled();
    expect(releases).toBe(1);
    expect(delegated.run).not.toHaveBeenCalled();
    expect((await sessions.load("s2")).records).toHaveLength(4);
  });

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
              id: pin.providerId,
              adapterId: pin.adapterId,
              connectionId: pin.connectionId,
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
