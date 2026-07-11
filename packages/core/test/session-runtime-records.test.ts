import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  IntegrationFailure,
  RunResult,
  RuntimeContinuationHandle,
  SessionBackendPin,
} from "@recurs/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  createBackendFingerprint,
  JsonlSessionStore,
} from "../src/index.js";

const directories: string[] = [];
const at = "2026-07-10T00:00:00.000Z";
const expiresAt = "2026-07-10T01:00:00.000Z";

const runtimeBackend: SessionBackendPin & { kind: "agent_runtime" } = {
  kind: "agent_runtime",
  providerId: "official-runtime",
  adapterId: "official-runtime-v1",
  connectionId: "runtime-connection",
  modelId: "runtime-model",
  modelIdentityKind: "versioned",
  providerResolvedModelRevisionAtCreation: "runtime-model-1",
  catalogRevision: "test-catalog-1",
  policyRevisionAtCreation: "test-policy-1",
  billingPolicyRevisionAtCreation: "test-billing-1",
  primaryBillingSourceAtCreation: "included_subscription",
  billingSelectionAtCreation: {
    mode: "strict_primary_only",
    policyRevision: "test-policy-1",
    disclosureRevision: "test-disclosure-1",
    allowedSources: ["included_subscription"],
    acknowledgedAt: at,
  },
  accountSubjectFingerprint: "test-account",
  runtimeCapabilityProfileRevisionAtCreation: "capabilities-v1",
};

function asDirectBackend(): SessionBackendPin {
  const direct: SessionBackendPin = { ...runtimeBackend, kind: "model_provider" };
  delete direct.runtimeCapabilityProfileRevisionAtCreation;
  return direct;
}

const directBackend = asDirectBackend();

const result: RunResult = {
  finalText: "delegated result",
  usage: {
    inputTokens: 7,
    outputTokens: 3,
    cachedInputTokens: 2,
    cacheWriteInputTokens: 1,
    reasoningTokens: 4,
    costUsd: 0.02,
  },
  usageSource: "runtime",
  steps: null,
  changedFiles: ["src/a.ts"],
  changedFilesSource: "runtime",
  evidence: ["focused tests passed"],
  evidenceSource: "runtime",
};

function continuation(
  overrides: Partial<RuntimeContinuationHandle> = {},
): RuntimeContinuationHandle {
  return {
    kind: "runtime",
    id: "runtime-continuation-1",
    storageClass: "process_scoped",
    ownerInstanceId: "runtime-owner-1",
    expiresAt,
    recursSessionId: "runtime-session",
    connectionId: runtimeBackend.connectionId,
    adapterId: runtimeBackend.adapterId,
    modelId: runtimeBackend.modelId,
    backendFingerprint: createBackendFingerprint(runtimeBackend),
    stateVersion: 1,
    originTurnId: "turn-1",
    continuationSequence: 1,
    status: "uncertain",
    vendorTurnSequence: 1,
    ...overrides,
  };
}

const failure: IntegrationFailure = {
  domain: "runtime",
  phase: "started",
  code: "runtime_failed",
  safeMessage: "The delegated runtime failed",
  diagnosticId: "diagnostic-1",
  retryable: false,
};

async function temporaryStore(): Promise<JsonlSessionStore> {
  const directory = await mkdtemp(path.join(tmpdir(), "recurs-runtime-records-"));
  directories.push(directory);
  return new JsonlSessionStore(directory);
}

async function createRuntimeSession(
  store: JsonlSessionStore,
  id = "runtime-session",
): Promise<void> {
  await store.createPinnedSession({
    id,
    cwd: "/workspace",
    backend: runtimeBackend,
    at,
  });
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("delegated runtime session records", () => {
  it("requires a bounded capability profile only on delegated backend pins", async () => {
    const validStore = await temporaryStore();
    await expect(
      validStore.createPinnedSession({
        id: "valid-runtime-profile",
        cwd: "/workspace",
        backend: {
          ...runtimeBackend,
          runtimeCapabilityProfileRevisionAtCreation: "capabilities-v1",
        },
        at,
      }),
    ).resolves.toMatchObject({ backend: { type: "pinned" } });

    const missingStore = await temporaryStore();
    const missingProfileBackend: SessionBackendPin = { ...runtimeBackend };
    delete missingProfileBackend.runtimeCapabilityProfileRevisionAtCreation;
    await expect(
      missingStore.createPinnedSession({
        id: "missing-runtime-profile",
        cwd: "/workspace",
        backend: missingProfileBackend,
        at,
      }),
    ).rejects.toMatchObject({ code: "invalid_record" });

    for (const [id, backend] of [
      ["empty-runtime-profile", {
        ...runtimeBackend,
        runtimeCapabilityProfileRevisionAtCreation: "",
      }],
      ["oversized-runtime-profile", {
        ...runtimeBackend,
        runtimeCapabilityProfileRevisionAtCreation: "x".repeat(10_000),
      }],
      ["direct-runtime-profile", {
        ...directBackend,
        runtimeCapabilityProfileRevisionAtCreation: "capabilities-v1",
      }],
    ] as const) {
      const store = await temporaryStore();
      await expect(
        store.createPinnedSession({ id, cwd: "/workspace", backend, at }),
      ).rejects.toMatchObject({ code: "invalid_record" });
    }
  });

  it("replays one completed runtime result with exact approval and continuation provenance", async () => {
    const store = await temporaryStore();
    await createRuntimeSession(store);
    const uncertain = continuation();
    const committed = continuation({ status: "committed" });
    const approvalRequest = {
      requestId: "approval-1",
      action: "write" as const,
      resource: "src/a.ts",
      risk: "normal" as const,
      summary: "Update the source file",
      options: [
        { optionId: "yes-once", name: "Allow once", kind: "allow_once" as const },
        { optionId: "yes-session", name: "Allow for session", kind: "allow_always" as const },
        { optionId: "no", name: "Deny", kind: "reject_once" as const },
      ],
      details: { command: "apply patch", paths: ["src/a.ts"] },
    };

    await store.withSessionMutation("runtime-session", 0, async (lease) => {
      await lease.append({ type: "turn_started", turnId: "turn-1", prompt: "change it", at });
      await lease.append({
        type: "runtime_continuation_updated",
        turnId: "turn-1",
        continuation: uncertain,
        at,
      });
      await lease.append({
        type: "runtime_approval_resolved",
        turnId: "turn-1",
        request: approvalRequest,
        decision: { outcome: "selected", optionId: "yes-session" },
        scope: "allow_session",
        provenance: "user",
        at,
      });
      await lease.append({
        type: "runtime_completed",
        turnId: "turn-1",
        result,
        stopReason: "complete",
        continuation: committed,
        provenance: {
          adapterId: runtimeBackend.adapterId,
          connectionId: runtimeBackend.connectionId,
          modelId: runtimeBackend.modelId,
          backendFingerprint: createBackendFingerprint(runtimeBackend),
          capabilityProfileRevision: "capabilities-v1",
        },
        at,
      });
      await lease.append({ type: "turn_completed", turnId: "turn-1", result, at });
    });

    const state = await store.loadState("runtime-session");
    expect(state.messages).toEqual([
      { id: "turn-1:user", role: "user", content: "change it" },
      {
        id: "turn-1:runtime:assistant",
        role: "assistant",
        content: "delegated result",
      },
    ]);
    expect(state.usage).toEqual(result.usage);
    expect(state.changedFiles).toEqual(["src/a.ts"]);
    expect(state.evidence).toEqual(["focused tests passed"]);
    expect(state).toMatchObject({
      openTurnId: null,
      runtimeContinuation: committed,
      runtimeContinuationPredecessor: null,
      pendingRuntimeCompletion: null,
    });
    expect((await store.load("runtime-session")).records[3]).toMatchObject({
      type: "runtime_approval_resolved",
      request: approvalRequest,
      decision: { outcome: "selected", optionId: "yes-session" },
      scope: "allow_session",
      provenance: "user",
    });
  });

  it("snapshots runtime handles and results before caller-owned values can mutate", async () => {
    const store = await temporaryStore();
    await createRuntimeSession(store);
    const uncertain = continuation() as RuntimeContinuationHandle & { id: string };
    const mutableResult = structuredClone(result) as RunResult & { finalText: string };
    const originalResult = structuredClone(result);
    await store.withSessionMutation("runtime-session", 0, async (lease) => {
      await lease.append({ type: "turn_started", turnId: "turn-1", prompt: "change it", at });
      await lease.append({ type: "runtime_continuation_updated", turnId: "turn-1", continuation: uncertain, at });
      uncertain.id = "caller-mutated-id";
      await lease.append({
        type: "runtime_completed",
        turnId: "turn-1",
        result: mutableResult,
        stopReason: "complete",
        continuation: continuation({ status: "committed" }),
        provenance: {
          adapterId: runtimeBackend.adapterId,
          connectionId: runtimeBackend.connectionId,
          modelId: runtimeBackend.modelId,
          backendFingerprint: createBackendFingerprint(runtimeBackend),
          capabilityProfileRevision: "capabilities-v1",
        },
        at,
      });
      mutableResult.finalText = "caller-mutated-result";
      await lease.append({ type: "turn_completed", turnId: "turn-1", result: originalResult, at });
    });

    expect((await store.loadState("runtime-session")).messages.at(-1)?.content)
      .toBe("delegated result");
  });

  it("accepts a runtime result with no usage without inventing usage", async () => {
    const store = await temporaryStore();
    await createRuntimeSession(store);
    const withoutUsage: RunResult = {
      ...result,
      usage: null,
      usageSource: "unavailable",
      changedFiles: [],
      evidence: [],
      evidenceSource: "none",
    };

    await store.withSessionMutation("runtime-session", 0, async (lease) => {
      await lease.append({ type: "turn_started", turnId: "turn-1", prompt: "inspect", at });
      await lease.append({
        type: "runtime_completed",
        turnId: "turn-1",
        result: withoutUsage,
        stopReason: "length",
        provenance: {
          adapterId: runtimeBackend.adapterId,
          connectionId: runtimeBackend.connectionId,
          modelId: runtimeBackend.modelId,
          backendFingerprint: createBackendFingerprint(runtimeBackend),
          capabilityProfileRevision: "capabilities-v1",
        },
        at,
      });
      await lease.append({ type: "turn_completed", turnId: "turn-1", result: withoutUsage, at });
    });

    expect((await store.loadState("runtime-session")).usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it("rejects runtime completion from a different capability profile", async () => {
    const store = await temporaryStore();
    await createRuntimeSession(store);
    await expect(
      store.withSessionMutation("runtime-session", 0, async (lease) => {
        await lease.append({ type: "turn_started", turnId: "turn-1", prompt: "inspect", at });
        await lease.append({
          type: "runtime_completed",
          turnId: "turn-1",
          result,
          stopReason: "complete",
          provenance: {
            adapterId: runtimeBackend.adapterId,
            connectionId: runtimeBackend.connectionId,
            modelId: runtimeBackend.modelId,
            backendFingerprint: createBackendFingerprint(runtimeBackend),
            capabilityProfileRevision: "capabilities-v2",
          },
          at,
        });
      }),
    ).rejects.toThrow("provenance does not match");
  });

  it("rejects runtime usage aggregation outside the safe numeric range", async () => {
    const store = await temporaryStore();
    await createRuntimeSession(store);
    const provenance = {
      adapterId: runtimeBackend.adapterId,
      connectionId: runtimeBackend.connectionId,
      modelId: runtimeBackend.modelId,
      backendFingerprint: createBackendFingerprint(runtimeBackend),
      capabilityProfileRevision: "capabilities-v1",
    };
    const firstResult: RunResult = {
      ...result,
      usage: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 },
      changedFiles: [],
      evidence: [],
      evidenceSource: "none",
    };
    const secondResult: RunResult = {
      ...firstResult,
      usage: { inputTokens: 1, outputTokens: 0 },
    };
    await store.withSessionMutation("runtime-session", 0, async (lease) => {
      await lease.append({ type: "turn_started", turnId: "turn-1", prompt: "first", at });
      await lease.append({
        type: "runtime_completed",
        turnId: "turn-1",
        result: firstResult,
        stopReason: "complete",
        provenance,
        at,
      });
      await lease.append({ type: "turn_completed", turnId: "turn-1", result: firstResult, at });
    });

    await expect(
      store.withSessionMutation("runtime-session", 3, async (lease) => {
        await lease.append({ type: "turn_started", turnId: "turn-2", prompt: "second", at });
        await lease.append({
          type: "runtime_completed",
          turnId: "turn-2",
          result: secondResult,
          stopReason: "complete",
          provenance,
          at,
        });
      }),
    ).rejects.toThrow("safe numeric range");
  });

  it("rejects malformed, oversized, and inconsistent runtime approvals", async () => {
    const invalidApprovals = [
      {
        request: {
          requestId: "approval-1",
          action: "write",
          resource: "src/a.ts",
          risk: "normal",
          summary: "Update",
          options: [
            { optionId: "same", name: "Allow", kind: "allow_once" },
            { optionId: "same", name: "Deny", kind: "reject_once" },
          ],
        },
        decision: { outcome: "selected", optionId: "same" },
        scope: "allow_once",
        provenance: "user",
      },
      {
        request: {
          requestId: "approval-1",
          action: "write",
          resource: "src/a.ts",
          risk: "normal",
          summary: "Update",
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        },
        decision: { outcome: "selected", optionId: "missing" },
        scope: "allow_once",
        provenance: "user",
      },
      {
        request: {
          requestId: "approval-1",
          action: "write",
          resource: "src/a.ts",
          risk: "normal",
          summary: "Update",
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        },
        decision: { outcome: "selected", optionId: "allow" },
        scope: "allow_session",
        provenance: "user",
      },
      {
        request: {
          requestId: "approval-1",
          action: "write",
          resource: "src/a.ts",
          risk: "normal",
          summary: "x".repeat(1_000_000),
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
          details: { nested: { secret: "x".repeat(1_000_000) } },
        },
        decision: { outcome: "selected", optionId: "allow" },
        scope: "allow_once",
        provenance: "user",
      },
      {
        request: {
          requestId: "approval-1",
          action: "write",
          resource: "src/a.ts",
          risk: "normal",
          summary: "Update",
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        },
        decision: { outcome: "selected", optionId: "allow" },
        scope: "allow_once",
        provenance: "signal",
      },
      {
        request: {
          requestId: "approval-1",
          action: "write",
          resource: "src/a.ts",
          risk: "normal",
          summary: "Update",
          options: Array.from({ length: 65 }, (_, optionIndex) => ({
            optionId: `allow-${optionIndex}`,
            name: `Allow ${optionIndex}`,
            kind: "allow_once",
          })),
        },
        decision: { outcome: "selected", optionId: "allow-0" },
        scope: "allow_once",
        provenance: "user",
      },
    ];

    for (const [index, approval] of invalidApprovals.entries()) {
      const store = await temporaryStore();
      const id = `runtime-session-${index}`;
      await createRuntimeSession(store, id);
      await expect(
        store.withSessionMutation(id, 0, async (lease) => {
          await lease.append({ type: "turn_started", turnId: "turn-1", prompt: "inspect", at });
          await lease.append({
            type: "runtime_approval_resolved",
            turnId: "turn-1",
            ...approval,
            at,
          } as never);
        }),
      ).rejects.toMatchObject({ code: "invalid_record" });
    }
  });

  it("accepts exact denial and cancellation approval combinations", async () => {
    const store = await temporaryStore();
    await createRuntimeSession(store);
    const request = {
      requestId: "approval-1",
      action: "shell" as const,
      resource: "npm test",
      risk: "elevated" as const,
      summary: "Run the focused tests",
      options: [
        { optionId: "reject-once", name: "Reject", kind: "reject_once" as const },
        { optionId: "reject-session", name: "Always reject", kind: "reject_always" as const },
      ],
      details: { argv: ["npm", "test"] },
    };
    await store.withSessionMutation("runtime-session", 0, async (lease) => {
      await lease.append({ type: "turn_started", turnId: "turn-1", prompt: "test", at });
      await lease.append({
        type: "runtime_approval_resolved",
        turnId: "turn-1",
        request,
        decision: { outcome: "selected", optionId: "reject-once" },
        scope: "deny",
        provenance: "policy",
        at,
      });
      await lease.append({
        type: "runtime_approval_resolved",
        turnId: "turn-1",
        request,
        decision: { outcome: "cancelled" },
        scope: "cancel",
        provenance: "signal",
        at,
      });
      await lease.append({
        type: "turn_cancelled",
        turnId: "turn-1",
        reason: "cancelled",
        at,
      });
    });
    expect((await store.load("runtime-session")).records).toHaveLength(5);
  });

  it("rejects an unbounded timestamp on a runtime record", async () => {
    const store = await temporaryStore();
    await createRuntimeSession(store);
    await expect(
      store.withSessionMutation("runtime-session", 0, async (lease) => {
        await lease.append({ type: "turn_started", turnId: "turn-1", prompt: "test", at });
        await lease.append({
          type: "runtime_approval_resolved",
          turnId: "turn-1",
          request: {
            requestId: "approval-1",
            action: "read",
            resource: "src/a.ts",
            risk: "normal",
            summary: "Read the source",
            options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
          },
          decision: { outcome: "selected", optionId: "allow" },
          scope: "allow_once",
          provenance: "user",
          at: "x".repeat(1_000_000),
        });
      }),
    ).rejects.toMatchObject({ code: "invalid_record" });
  });

  it("rejects continuation status, sequence, binding, owner, and expiry mismatches", async () => {
    const invalidHandles: RuntimeContinuationHandle[] = [
      continuation({ status: "committed" }),
      continuation({ continuationSequence: 2 }),
      continuation({ continuationSequence: 0 }),
      continuation({ stateVersion: 0 }),
      continuation({ vendorTurnSequence: 0 }),
      continuation({ vendorTurnSequence: Number.MAX_SAFE_INTEGER + 1 }),
      continuation({ backendFingerprint: `sha256:${"0".repeat(64)}` }),
      continuation({ backendFingerprint: `sha256:${"A".repeat(64)}` }),
      continuation({ adapterId: "wrong-adapter" }),
      continuation({ originTurnId: "wrong-turn" }),
      continuation({ ownerInstanceId: "" }),
      continuation({ ownerInstanceId: undefined }),
      continuation({ expiresAt: "2026-07-10T00:00:00Z" }),
      continuation({ expiresAt: at }),
    ];

    for (const [index, handle] of invalidHandles.entries()) {
      const store = await temporaryStore();
      const id = `runtime-session-${index}`;
      await createRuntimeSession(store, id);
      await expect(
        store.withSessionMutation(id, 0, async (lease) => {
          await lease.append({ type: "turn_started", turnId: "turn-1", prompt: "inspect", at });
          await lease.append({
            type: "runtime_continuation_updated",
            turnId: "turn-1",
            continuation: { ...handle, recursSessionId: id },
            at,
          });
        }),
      ).rejects.toThrow();
    }
  });

  it("rejects rollback, gaps, owner changes, and terminal handle mutation", async () => {
    const invalidSuccessors: Partial<RuntimeContinuationHandle>[] = [
      { continuationSequence: 1 },
      { continuationSequence: 3 },
      { vendorTurnSequence: 1 },
      { vendorTurnSequence: 3 },
      { ownerInstanceId: "different-owner" },
    ];
    for (const [index, overrides] of invalidSuccessors.entries()) {
      const store = await temporaryStore();
      const id = `runtime-successor-${index}`;
      await createRuntimeSession(store, id);
      const firstUncertain = continuation({ recursSessionId: id });
      const firstCommitted = continuation({ recursSessionId: id, status: "committed" });
      await store.withSessionMutation(id, 0, async (lease) => {
        await lease.append({ type: "turn_started", turnId: "turn-1", prompt: "first", at });
        await lease.append({ type: "runtime_continuation_updated", turnId: "turn-1", continuation: firstUncertain, at });
        await lease.append({
          type: "runtime_completed",
          turnId: "turn-1",
          result,
          stopReason: "complete",
          continuation: firstCommitted,
          provenance: {
            adapterId: runtimeBackend.adapterId,
            connectionId: runtimeBackend.connectionId,
            modelId: runtimeBackend.modelId,
            backendFingerprint: createBackendFingerprint(runtimeBackend),
            capabilityProfileRevision: "capabilities-v1",
          },
          at,
        });
        await lease.append({ type: "turn_completed", turnId: "turn-1", result, at });
      });
      const invalid = continuation({
        id: "runtime-continuation-2",
        recursSessionId: id,
        originTurnId: "turn-2",
        continuationSequence: 2,
        vendorTurnSequence: 2,
        ...overrides,
      });
      await expect(
        store.withSessionMutation(id, 4, async (lease) => {
          await lease.append({ type: "turn_started", turnId: "turn-2", prompt: "second", at });
          await lease.append({ type: "runtime_continuation_updated", turnId: "turn-2", continuation: invalid, at });
        }),
      ).rejects.toThrow("next committed successor");
    }

    const store = await temporaryStore();
    await createRuntimeSession(store);
    const uncertain = continuation();
    await expect(
      store.withSessionMutation("runtime-session", 0, async (lease) => {
        await lease.append({ type: "turn_started", turnId: "turn-1", prompt: "inspect", at });
        await lease.append({ type: "runtime_continuation_updated", turnId: "turn-1", continuation: uncertain, at });
        await lease.append({
          type: "runtime_completed",
          turnId: "turn-1",
          result,
          stopReason: "complete",
          continuation: continuation({
            status: "committed",
            expiresAt: "2026-07-10T02:00:00.000Z",
          }),
          provenance: {
            adapterId: runtimeBackend.adapterId,
            connectionId: runtimeBackend.connectionId,
            modelId: runtimeBackend.modelId,
            backendFingerprint: createBackendFingerprint(runtimeBackend),
            capabilityProfileRevision: "capabilities-v1",
          },
          at,
        });
      }),
    ).rejects.toThrow("did not commit the uncertain tip");
  });

  it("preserves an exact uncertain continuation when a delegated turn fails or is cancelled", async () => {
    for (const terminal of ["turn_failed", "turn_cancelled"] as const) {
      const store = await temporaryStore();
      const id = `runtime-${terminal}`;
      await createRuntimeSession(store, id);
      const uncertain = continuation({ recursSessionId: id });
      await store.withSessionMutation(id, 0, async (lease) => {
        await lease.append({ type: "turn_started", turnId: "turn-1", prompt: "inspect", at });
        await lease.append({
          type: "runtime_continuation_updated",
          turnId: "turn-1",
          continuation: uncertain,
          at,
        });
        await lease.append(terminal === "turn_failed"
          ? { type: terminal, turnId: "turn-1", error: failure, continuation: uncertain, at }
          : { type: terminal, turnId: "turn-1", reason: "cancelled", continuation: uncertain, at });
      });

      expect(await store.loadState(id)).toMatchObject({
        openTurnId: null,
        runtimeContinuation: uncertain,
        runtimeContinuationPredecessor: null,
      });
    }
  });

  it("requires failure and cancellation records to carry an existing uncertain tip", async () => {
    for (const terminal of ["turn_failed", "turn_cancelled"] as const) {
      const store = await temporaryStore();
      const id = `missing-${terminal}`;
      await createRuntimeSession(store, id);
      const uncertain = continuation({ recursSessionId: id });
      await store.withSessionMutation(id, 0, async (lease) => {
        await lease.append({ type: "turn_started", turnId: "turn-1", prompt: "inspect", at });
        await lease.append({ type: "runtime_continuation_updated", turnId: "turn-1", continuation: uncertain, at });
      });
      await expect(
        store.withSessionMutation(id, 2, async (lease) => {
          await lease.append(terminal === "turn_failed"
            ? { type: terminal, turnId: "turn-1", error: failure, at }
            : { type: terminal, turnId: "turn-1", reason: "cancelled", at });
        }),
      ).rejects.toThrow("must preserve the uncertain tip");
    }
  });

  it("persists exact failure and cancellation tips after process expiry", async () => {
    for (const terminal of ["turn_failed", "turn_cancelled"] as const) {
      const store = await temporaryStore();
      const id = `expired-${terminal}`;
      await createRuntimeSession(store, id);
      const uncertain = continuation({ recursSessionId: id });
      await store.withSessionMutation(id, 0, async (lease) => {
        await lease.append({ type: "turn_started", turnId: "turn-1", prompt: "inspect", at });
        await lease.append({ type: "runtime_continuation_updated", turnId: "turn-1", continuation: uncertain, at });
        await lease.append(terminal === "turn_failed"
          ? {
              type: terminal,
              turnId: "turn-1",
              error: failure,
              continuation: uncertain,
              at: "2026-07-10T02:00:00.000Z",
            }
          : {
              type: terminal,
              turnId: "turn-1",
              reason: "cancelled",
              continuation: uncertain,
              at: "2026-07-10T02:00:00.000Z",
            });
      });
      expect(await store.loadState(id)).toMatchObject({
        openTurnId: null,
        runtimeContinuation: uncertain,
      });
    }
  });

  it("rejects mismatched failure and reconciliation continuation handles", async () => {
    const store = await temporaryStore();
    await createRuntimeSession(store);
    const uncertain = continuation();
    await store.withSessionMutation("runtime-session", 0, async (lease) => {
      await lease.append({ type: "turn_started", turnId: "turn-1", prompt: "inspect", at });
      await lease.append({ type: "runtime_continuation_updated", turnId: "turn-1", continuation: uncertain, at });
    });
    await expect(
      store.withSessionMutation("runtime-session", 2, async (lease) => {
        await lease.append({
          type: "turn_failed",
          turnId: "turn-1",
          error: failure,
          continuation: continuation({ id: "different-id" }),
          at,
        });
      }),
    ).rejects.toThrow("does not match the uncertain tip");

    await expect(
      store.withSessionMutation("runtime-session", 2, async (lease) => {
        await lease.append({ type: "turn_failed", turnId: "turn-1", error: failure, continuation: uncertain, at });
        await lease.append({
          type: "runtime_continuation_reconciled",
          operationId: "reconcile-1",
          uncertainHandle: uncertain,
          outcome: "gone",
          activeHandle: continuation({ status: "committed" }),
          at,
        });
      }),
    ).rejects.toThrow("did not restore the predecessor");
  });

  it("durably reconciles an uncertain continuation as committed or gone", async () => {
    const committedStore = await temporaryStore();
    await createRuntimeSession(committedStore);
    const uncertain = continuation();
    const committed = continuation({ status: "committed" });
    await committedStore.withSessionMutation("runtime-session", 0, async (lease) => {
      await lease.append({ type: "turn_started", turnId: "turn-1", prompt: "inspect", at });
      await lease.append({ type: "runtime_continuation_updated", turnId: "turn-1", continuation: uncertain, at });
      await lease.append({ type: "turn_failed", turnId: "turn-1", error: failure, continuation: uncertain, at });
      await lease.append({
        type: "runtime_continuation_reconciled",
        operationId: "reconcile-1",
        uncertainHandle: uncertain,
        outcome: "committed",
        activeHandle: committed,
        at,
      });
    });
    expect(await committedStore.loadState("runtime-session")).toMatchObject({
      runtimeContinuation: committed,
      runtimeContinuationPredecessor: null,
    });

    const goneStore = await temporaryStore();
    await createRuntimeSession(goneStore);
    const firstUncertain = continuation();
    const firstCommitted = continuation({ status: "committed" });
    const secondUncertain = continuation({
      id: "runtime-continuation-2",
      originTurnId: "turn-2",
      continuationSequence: 2,
      vendorTurnSequence: 2,
    });
    await goneStore.withSessionMutation("runtime-session", 0, async (lease) => {
      await lease.append({ type: "turn_started", turnId: "turn-1", prompt: "first", at });
      await lease.append({ type: "runtime_continuation_updated", turnId: "turn-1", continuation: firstUncertain, at });
      await lease.append({
        type: "runtime_completed",
        turnId: "turn-1",
        result,
        stopReason: "complete",
        continuation: firstCommitted,
        provenance: {
          adapterId: runtimeBackend.adapterId,
          connectionId: runtimeBackend.connectionId,
          modelId: runtimeBackend.modelId,
          backendFingerprint: createBackendFingerprint(runtimeBackend),
          capabilityProfileRevision: "capabilities-v1",
        },
        at,
      });
      await lease.append({ type: "turn_completed", turnId: "turn-1", result, at });
      await lease.append({ type: "turn_started", turnId: "turn-2", prompt: "second", at });
      await lease.append({ type: "runtime_continuation_updated", turnId: "turn-2", continuation: secondUncertain, at });
      await lease.append({ type: "turn_cancelled", turnId: "turn-2", reason: "cancelled", continuation: secondUncertain, at });
      await lease.append({
        type: "runtime_continuation_reconciled",
        operationId: "reconcile-2",
        uncertainHandle: secondUncertain,
        outcome: "gone",
        activeHandle: firstCommitted,
        at,
      });
    });
    expect(await goneStore.loadState("runtime-session")).toMatchObject({
      runtimeContinuation: firstCommitted,
      runtimeContinuationPredecessor: null,
    });

    const nullStore = await temporaryStore();
    await createRuntimeSession(nullStore);
    await nullStore.withSessionMutation("runtime-session", 0, async (lease) => {
      await lease.append({ type: "turn_started", turnId: "turn-1", prompt: "inspect", at });
      await lease.append({ type: "runtime_continuation_updated", turnId: "turn-1", continuation: uncertain, at });
      await lease.append({ type: "turn_failed", turnId: "turn-1", error: failure, continuation: uncertain, at });
      await lease.append({
        type: "runtime_continuation_reconciled",
        operationId: "reconcile-gone",
        uncertainHandle: uncertain,
        outcome: "gone",
        activeHandle: null,
        at: "2026-07-10T02:00:00.000Z",
      });
    });
    expect(await nullStore.loadState("runtime-session")).toMatchObject({
      runtimeContinuation: null,
      runtimeContinuationPredecessor: null,
    });
  });

  it("recovers a crash after runtime completion by closing locally exactly once", async () => {
    const store = await temporaryStore();
    await createRuntimeSession(store);
    await store.withSessionMutation("runtime-session", 0, async (lease) => {
      await lease.append({ type: "turn_started", turnId: "turn-1", prompt: "inspect", at });
      await lease.append({
        type: "runtime_completed",
        turnId: "turn-1",
        result,
        stopReason: "complete",
        provenance: {
          adapterId: runtimeBackend.adapterId,
          connectionId: runtimeBackend.connectionId,
          modelId: runtimeBackend.modelId,
          backendFingerprint: createBackendFingerprint(runtimeBackend),
          capabilityProfileRevision: "capabilities-v1",
        },
        at,
      });
    });

    expect(await store.loadState("runtime-session")).toMatchObject({
      openTurnId: "turn-1",
      pendingRuntimeCompletion: {
        turnId: "turn-1",
        result,
        stopReason: "complete",
      },
    });
    await expect(
      store.withSessionMutation("runtime-session", 2, async (lease) => {
        await lease.append({
          type: "turn_completed",
          turnId: "turn-1",
          result: { ...result, finalText: "different" },
          at,
        });
      }),
    ).rejects.toThrow("does not match runtime completion");

    await expect(store.recoverInterruptedOperations("runtime-session", at)).resolves.toBe(true);
    await expect(store.recoverInterruptedOperations("runtime-session", at)).resolves.toBe(false);
    const state = await store.loadState("runtime-session");
    expect(state.openTurnId).toBeNull();
    expect(state.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
    expect(state.usage).toEqual(result.usage);
    expect((await store.load("runtime-session")).records.at(-1)).toMatchObject({
      type: "turn_completed",
      turnId: "turn-1",
      result,
    });
  });

  it("interrupts an open delegated turn without discarding its uncertain tip", async () => {
    const store = await temporaryStore();
    await createRuntimeSession(store);
    const uncertain = continuation();
    await store.withSessionMutation("runtime-session", 0, async (lease) => {
      await lease.append({ type: "turn_started", turnId: "turn-1", prompt: "inspect", at });
      await lease.append({ type: "runtime_continuation_updated", turnId: "turn-1", continuation: uncertain, at });
    });

    await expect(store.recoverInterruptedOperations("runtime-session", at)).resolves.toBe(true);
    await expect(store.recoverInterruptedOperations("runtime-session", at)).resolves.toBe(false);
    expect(await store.loadState("runtime-session")).toMatchObject({
      openTurnId: null,
      runtimeContinuation: uncertain,
      runtimeContinuationPredecessor: null,
    });
  });

  it("leaves direct open turns for the existing direct agent-loop recovery path", async () => {
    const store = await temporaryStore();
    await store.createPinnedSession({
      id: "direct-session",
      cwd: "/workspace",
      backend: directBackend,
      at,
    });
    await store.withSessionMutation("direct-session", 0, async (lease) => {
      await lease.append({ type: "turn_started", turnId: "turn-1", prompt: "inspect", at });
    });

    await expect(store.recoverInterruptedOperations("direct-session", at)).resolves.toBe(false);
    expect((await store.loadState("direct-session")).openTurnId).toBe("turn-1");
  });

  it("keeps direct continuation handles readable and rejects runtime handles in provider messages", async () => {
    const store = await temporaryStore();
    await store.createPinnedSession({
      id: "direct-session",
      cwd: "/workspace",
      backend: directBackend,
      at,
    });
    const directHandle = {
      kind: "direct" as const,
      id: "direct-continuation",
      storageClass: "persistent_broker" as const,
      recursSessionId: "direct-session",
      connectionId: directBackend.connectionId,
      adapterId: directBackend.adapterId,
      modelId: directBackend.modelId,
      backendFingerprint: "legacy-direct-fingerprint",
      stateVersion: 0,
      originTurnId: "turn-1",
      continuationSequence: 0,
      status: "committed" as const,
    };
    await store.withSessionMutation("direct-session", 0, async (lease) => {
      await lease.append({ type: "turn_started", turnId: "turn-1", prompt: "inspect", at });
      await lease.append({
        type: "model_completed",
        turnId: "turn-1",
        message: {
          id: "assistant-1",
          role: "assistant",
          content: "done",
          providerStateHandle: directHandle,
        },
        usage: null,
        stopReason: "complete",
        at,
      });
    });
    expect((await store.loadState("direct-session")).messages.at(-1)).toMatchObject({
      providerStateHandle: directHandle,
    });

    await expect(
      store.withSessionMutation("direct-session", 2, async (lease) => {
        await lease.append({
          type: "model_completed",
          turnId: "turn-1",
          message: {
            id: "assistant-2",
            role: "assistant",
            content: "invalid",
            providerStateHandle: continuation({ recursSessionId: "direct-session" }),
          } as never,
          usage: null,
          stopReason: "complete",
          at,
        });
      }),
    ).rejects.toMatchObject({ code: "invalid_record" });
  });
});
