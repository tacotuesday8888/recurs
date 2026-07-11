import type {
  RunAuthorization,
  SessionBackendPin,
} from "@recurs/contracts";
import { describe, expect, it } from "vitest";

import {
  bindRunAuthorization,
  ProcessScopedRuntimeContinuationStore,
  RuntimeContinuationStoreError,
} from "../src/index.js";

const pin: SessionBackendPin = {
  kind: "agent_runtime",
  runtimeCapabilityProfileRevisionAtCreation: "capabilities-v1",
  providerId: "agent",
  adapterId: "agent-v1",
  connectionId: "connection-1",
  modelId: "model-1",
  modelIdentityKind: "versioned",
  providerResolvedModelRevisionAtCreation: "1",
  catalogRevision: "1",
  policyRevisionAtCreation: "policy-1",
  billingPolicyRevisionAtCreation: "billing-1",
  primaryBillingSourceAtCreation: "included_subscription",
  billingSelectionAtCreation: {
    mode: "strict_primary_only",
    policyRevision: "billing-1",
    disclosureRevision: "disclosure-1",
    allowedSources: ["included_subscription"],
    acknowledgedAt: "2026-07-10T00:00:00.000Z",
  },
  accountSubjectFingerprint: `sha256:${"b".repeat(64)}`,
};

let time = Date.parse("2026-07-11T00:00:00.000Z");

function authorization(turnId: string, id = `auth-${turnId}`): RunAuthorization {
  return bindRunAuthorization({
    id,
    operation: "run",
    sessionId: "session-1",
    operationId: `operation-${turnId}`,
    turnId,
    pin,
    connectionRevision: 1,
    policyRevision: pin.policyRevisionAtCreation,
    context: {
      invocation: "one_shot",
      presence: "present",
      location: "local",
      automation: "manual",
      embedding: "cli",
    },
    maxRequests: 1,
    expiresAt: new Date(time + 60_000).toISOString(),
  }, new Date(time));
}

function reconcileAuthorization(id: string): RunAuthorization {
  return bindRunAuthorization({
    id,
    operation: "runtime_reconcile",
    sessionId: "session-1",
    operationId: `operation-${id}`,
    turnId: null,
    pin,
    connectionRevision: 1,
    policyRevision: pin.policyRevisionAtCreation,
    context: {
      invocation: "one_shot",
      presence: "present",
      location: "local",
      automation: "manual",
      embedding: "cli",
    },
    maxRequests: 1,
    expiresAt: new Date(time + 60_000).toISOString(),
  }, new Date(time));
}

function createStore(maxPayloadBytes = 64) {
  return new ProcessScopedRuntimeContinuationStore({
    now: () => new Date(time),
    capabilityTtlMs: 5_000,
    continuationTtlMs: 30_000,
    maxPayloadBytes,
  });
}

function rebindAuthorization(
  base: RunAuthorization,
  sessionId: string,
  turnId: string,
): RunAuthorization {
  return {
    ...base,
    id: `${base.id}-${sessionId}`,
    sessionId,
    operationId: `${base.operationId}-${sessionId}`,
    turnId,
  };
}

async function writeAndCommit(
  store: ProcessScopedRuntimeContinuationStore,
  auth: RunAuthorization,
  previous = null,
  payload = new TextEncoder().encode("vendor-canary-session"),
) {
  const writer = await store.authority.mintWriter({
    authorization: auth,
    pin,
    expectedSessionRecordSequence: previous === null ? 0 : 2,
    previous,
    stateVersion: 1,
  });
  const uncertain = await store.runtimeStore.put({
    writer,
    payload,
  });
  const expectedSessionRecordSequence = previous === null ? 1 : 3;
  const prepared = await store.authority.prepareFinalization({
    authorization: auth,
    handle: uncertain,
    outcome: "committed",
    expectedSessionRecordSequence,
  });
  await store.authority.acknowledgeFinalization({
    authorization: auth,
    receipt: prepared.receipt,
    durableSessionRecordSequence: expectedSessionRecordSequence + 1,
  });
  if (prepared.activeHandle === null) {
    throw new Error("Expected committed continuation");
  }
  return prepared.activeHandle;
}

describe("ProcessScopedRuntimeContinuationStore", () => {
  it("shares copied opaque state across fresh runtime facets without serializing it", async () => {
    time = Date.parse("2026-07-11T00:00:00.000Z");
    const store = createStore();
    const firstFacet = store.runtimeStore;
    const auth1 = authorization("turn-1");
    const writer = await store.authority.mintWriter({
      authorization: auth1,
      pin,
      expectedSessionRecordSequence: 0,
      previous: null,
      stateVersion: 1,
    });
    const source = new TextEncoder().encode("vendor-canary-session");
    const uncertain = await firstFacet.put({ writer, payload: source });
    source.fill(0);
    expect(uncertain).toMatchObject({
      storageClass: "process_scoped",
      ownerInstanceId: store.ownerInstanceId,
      status: "uncertain",
      continuationSequence: 1,
      vendorTurnSequence: 1,
      originTurnId: "turn-1",
    });
    const prepared = await store.authority.prepareFinalization({
      authorization: auth1,
      handle: uncertain,
      outcome: "committed",
      expectedSessionRecordSequence: 1,
    });
    await store.authority.acknowledgeFinalization({
      authorization: auth1,
      receipt: prepared.receipt,
      durableSessionRecordSequence: 2,
    });
    const committed = prepared.activeHandle!;
    const auth2 = authorization("turn-2");
    const reader = await store.authority.mintReader({
      authorization: auth2,
      pin,
      expectedSessionRecordSequence: 2,
      purpose: "run",
      activeHandles: [committed],
    });
    const secondFacet = store.runtimeStore;
    expect(secondFacet).not.toBe(firstFacet);
    const loaded = await secondFacet.load({ reader, handle: committed });
    expect(new TextDecoder().decode(loaded)).toBe("vendor-canary-session");
    loaded.fill(0);
    expect(JSON.stringify(committed)).not.toContain("vendor-canary-session");
    expect(JSON.stringify(store)).not.toContain("vendor-canary-session");
  });

  it("computes monotonic sequences from the exact committed predecessor", async () => {
    const store = createStore();
    const first = await writeAndCommit(store, authorization("turn-1"));
    const second = await writeAndCommit(store, authorization("turn-2"), first);
    expect(second).toMatchObject({
      continuationSequence: 2,
      vendorTurnSequence: 2,
      status: "committed",
    });

    for (const previous of [
      { ...first, continuationSequence: 0 },
      { ...first, continuationSequence: 2 },
      { ...first, vendorTurnSequence: 3 },
      { ...first, status: "uncertain" as const },
      { ...first, ownerInstanceId: "wrong-owner" },
      { ...first, ownerInstanceId: undefined },
      { ...first, expiresAt: undefined },
      { ...first, storageClass: "persistent_broker" as const },
      { ...first, adapterId: "wrong-adapter" },
    ]) {
      await expect(store.authority.mintWriter({
        authorization: authorization("turn-3", `auth-${Math.random()}`),
        pin,
        expectedSessionRecordSequence: 4,
        previous,
        stateVersion: 1,
      })).rejects.toBeInstanceOf(RuntimeContinuationStoreError);
    }
  });

  it("uses short-lived single-use capabilities and exact committed allowlists", async () => {
    const store = createStore();
    const auth1 = authorization("turn-1");
    const writer = await store.authority.mintWriter({
      authorization: auth1,
      pin,
      expectedSessionRecordSequence: 0,
      previous: null,
      stateVersion: 1,
    });
    expect(writer.id.length).toBeGreaterThanOrEqual(32);
    const uncertain = await store.runtimeStore.put({
      writer,
      payload: new Uint8Array([1, 2, 3]),
    });
    await expect(store.runtimeStore.put({
      writer,
      payload: new Uint8Array([1]),
    })).rejects.toBeInstanceOf(RuntimeContinuationStoreError);
    await expect(store.authority.mintReader({
      authorization: authorization("turn-2"),
      pin,
      expectedSessionRecordSequence: 1,
      purpose: "run",
      activeHandles: [uncertain],
    })).rejects.toBeInstanceOf(RuntimeContinuationStoreError);

    const prepared = await store.authority.prepareFinalization({
      authorization: auth1,
      handle: uncertain,
      outcome: "committed",
      expectedSessionRecordSequence: 1,
    });
    await store.authority.acknowledgeFinalization({
      authorization: auth1,
      receipt: prepared.receipt,
      durableSessionRecordSequence: 2,
    });
    const committed = prepared.activeHandle!;
    const reader = await store.authority.mintReader({
      authorization: authorization("turn-2"),
      pin,
      expectedSessionRecordSequence: 2,
      purpose: "run",
      activeHandles: [committed],
    });
    await expect(store.runtimeStore.load({
      reader,
      handle: { ...committed, id: "forged" },
    })).rejects.toBeInstanceOf(RuntimeContinuationStoreError);
    await expect(store.runtimeStore.load({ reader, handle: committed }))
      .rejects.toBeInstanceOf(RuntimeContinuationStoreError);

    const revocable = await store.authority.mintWriter({
      authorization: authorization("turn-2", "auth-revocable"),
      pin,
      expectedSessionRecordSequence: 2,
      previous: committed,
      stateVersion: 1,
    });
    await store.authority.release(revocable);
    await expect(store.runtimeStore.put({
      writer: revocable,
      payload: new Uint8Array([1]),
    })).rejects.toBeInstanceOf(RuntimeContinuationStoreError);
  });

  it("recovers an exact staged handle after the runtime drops it", async () => {
    const noPutStore = createStore();
    const noPutAuthorization = authorization("no-put-turn");
    const noPutWriter = await noPutStore.authority.mintWriter({
      authorization: noPutAuthorization,
      pin,
      expectedSessionRecordSequence: 0,
      previous: null,
      stateVersion: 1,
    });
    await noPutStore.authority.release(noPutWriter);
    await expect(noPutStore.authority.recoverStaged({
      authorization: noPutAuthorization,
      writer: noPutWriter,
    })).resolves.toBeNull();

    const store = createStore();
    const auth = authorization("dropped-turn");
    const writer = await store.authority.mintWriter({
      authorization: auth,
      pin,
      expectedSessionRecordSequence: 0,
      previous: null,
      stateVersion: 1,
    });

    await expect(store.authority.recoverStaged({
      authorization: auth,
      writer,
    })).resolves.toBeNull();
    const staged = await store.runtimeStore.put({
      writer,
      payload: new TextEncoder().encode("dropped-runtime-canary"),
    });
    await store.authority.release(writer);

    await expect(store.authority.recoverStaged({
      authorization: auth,
      writer,
    })).resolves.toEqual(staged);
    await expect(store.authority.recoverStaged({
      authorization: auth,
      writer,
    })).resolves.toEqual(staged);
    expect(JSON.stringify(staged)).not.toContain("dropped-runtime-canary");
  });

  it("fails closed for forged recovery and removes recovery on resolution", async () => {
    const store = createStore();
    const auth = authorization("recovery-turn");
    const writer = await store.authority.mintWriter({
      authorization: auth,
      pin,
      expectedSessionRecordSequence: 0,
      previous: null,
      stateVersion: 1,
    });
    await store.runtimeStore.put({
      writer,
      payload: new Uint8Array([1]),
    });

    await expect(store.authority.recoverStaged({
      authorization: { ...auth, operationId: "wrong-operation" },
      writer,
    })).rejects.toBeInstanceOf(RuntimeContinuationStoreError);
    await expect(store.authority.recoverStaged({
      authorization: auth,
      writer: { ...writer, id: "forged-writer" },
    })).rejects.toBeInstanceOf(RuntimeContinuationStoreError);
    await expect(store.authority.recoverStaged({
      authorization: auth,
      writer: { ...writer, expiresAt: "2026-07-11T00:00:01.000Z" },
    })).rejects.toBeInstanceOf(RuntimeContinuationStoreError);

    const recovered = await store.authority.recoverStaged({
      authorization: auth,
      writer,
    });
    if (recovered === null) {
      throw new Error("Expected staged continuation recovery");
    }
    const prepared = await store.authority.prepareFinalization({
      authorization: auth,
      handle: recovered,
      outcome: "committed",
      expectedSessionRecordSequence: 1,
    });
    await store.authority.acknowledgeFinalization({
      authorization: auth,
      receipt: prepared.receipt,
      durableSessionRecordSequence: 2,
    });
    await expect(store.authority.recoverStaged({
      authorization: auth,
      writer,
    })).rejects.toBeInstanceOf(RuntimeContinuationStoreError);

    const expiringStore = new ProcessScopedRuntimeContinuationStore({
      now: () => new Date(time),
      capabilityTtlMs: 5_000,
      continuationTtlMs: 1_000,
      maxPayloadBytes: 1,
      maxStoredBytes: 1,
      maxStoredContinuations: 1,
    });
    const expiringAuth = authorization("expiring-recovery");
    const expiringWriter = await expiringStore.authority.mintWriter({
      authorization: expiringAuth,
      pin,
      expectedSessionRecordSequence: 0,
      previous: null,
      stateVersion: 1,
    });
    await expiringStore.runtimeStore.put({
      writer: expiringWriter,
      payload: new Uint8Array([9]),
    });
    time += 1_001;
    await expect(expiringStore.authority.recoverStaged({
      authorization: expiringAuth,
      writer: expiringWriter,
    })).rejects.toBeInstanceOf(RuntimeContinuationStoreError);
    expiringStore.dispose();
    await expect(expiringStore.authority.recoverStaged({
      authorization: expiringAuth,
      writer: expiringWriter,
    })).rejects.toBeInstanceOf(RuntimeContinuationStoreError);
  });

  it("requires positive state versions and bounds aggregate retained bytes", async () => {
    const store = new ProcessScopedRuntimeContinuationStore({
      now: () => new Date(time),
      capabilityTtlMs: 5_000,
      continuationTtlMs: 30_000,
      maxPayloadBytes: 3,
      maxStoredBytes: 6,
      maxStoredContinuations: 3,
    });
    const auth1 = authorization("turn-1");
    await expect(store.authority.mintWriter({
      authorization: auth1,
      pin,
      expectedSessionRecordSequence: 0,
      previous: null,
      stateVersion: 0,
    })).rejects.toBeInstanceOf(RuntimeContinuationStoreError);
    await expect(store.authority.mintWriter({
      authorization: { ...auth1, policyRevision: "different-policy" },
      pin,
      expectedSessionRecordSequence: 0,
      previous: null,
      stateVersion: 1,
    })).rejects.toBeInstanceOf(RuntimeContinuationStoreError);

    const first = await writeAndCommit(
      store,
      auth1,
      null,
      new Uint8Array([1, 2, 3]),
    );
    const auth2 = authorization("turn-2");
    const writer2 = await store.authority.mintWriter({
      authorization: auth2,
      pin,
      expectedSessionRecordSequence: 2,
      previous: first,
      stateVersion: 1,
    });
    const second = await store.runtimeStore.put({
      writer: writer2,
      payload: new Uint8Array([4, 5, 6]),
    });
    const otherAuthorization = rebindAuthorization(
      authorization("other-turn"),
      "other-session",
      "other-turn",
    );
    const otherWriter = await store.authority.mintWriter({
      authorization: otherAuthorization,
      pin,
      expectedSessionRecordSequence: 0,
      previous: null,
      stateVersion: 1,
    });
    await expect(store.runtimeStore.put({
      writer: otherWriter,
      payload: new Uint8Array([7]),
    })).rejects.toThrow("Continuation state is invalid");

    const preparedSecond = await store.authority.prepareFinalization({
      authorization: auth2,
      handle: second,
      outcome: "committed",
      expectedSessionRecordSequence: 3,
    });
    await store.authority.acknowledgeFinalization({
      authorization: auth2,
      receipt: preparedSecond.receipt,
      durableSessionRecordSequence: 4,
    });
    const committedSecond = preparedSecond.activeHandle!;
    const auth3 = authorization("turn-3");
    const writer3 = await store.authority.mintWriter({
      authorization: auth3,
      pin,
      expectedSessionRecordSequence: 4,
      previous: committedSecond,
      stateVersion: 1,
    });
    await expect(store.runtimeStore.put({
      writer: writer3,
      payload: new Uint8Array([7, 8, 9]),
    })).resolves.toMatchObject({ continuationSequence: 3 });
  });

  it("resolves the exact latest uncertain state as committed or gone", async () => {
    const committedStore = createStore();
    const runAuthorization = authorization("turn-1");
    const writer = await committedStore.authority.mintWriter({
      authorization: runAuthorization,
      pin,
      expectedSessionRecordSequence: 0,
      previous: null,
      stateVersion: 1,
    });
    const uncertain = await committedStore.runtimeStore.put({
      writer,
      payload: new TextEncoder().encode("reconcile-canary"),
    });
    const reconcile = reconcileAuthorization("reconcile-commit");
    const reconcileReader = await committedStore.authority.mintReader({
      authorization: reconcile,
      pin,
      expectedSessionRecordSequence: 1,
      purpose: "reconcile",
      activeHandles: [uncertain],
    });
    await expect(committedStore.runtimeStore.load({
      reader: reconcileReader,
      handle: uncertain,
    })).resolves.toEqual(new TextEncoder().encode("reconcile-canary"));
    const preparedCommit = await committedStore.authority.prepareFinalization({
      authorization: reconcile,
      handle: uncertain,
      outcome: "committed",
      expectedSessionRecordSequence: 1,
    });
    expect(preparedCommit.activeHandle).toMatchObject({ status: "committed" });
    await committedStore.authority.acknowledgeFinalization({
      authorization: reconcile,
      receipt: preparedCommit.receipt,
      durableSessionRecordSequence: 2,
    });

    const goneStore = createStore();
    const first = await writeAndCommit(
      goneStore,
      authorization("gone-turn-1"),
      null,
      new Uint8Array([1]),
    );
    const secondAuthorization = authorization("gone-turn-2");
    const secondWriter = await goneStore.authority.mintWriter({
      authorization: secondAuthorization,
      pin,
      expectedSessionRecordSequence: 2,
      previous: first,
      stateVersion: 1,
    });
    await goneStore.runtimeStore.put({
      writer: secondWriter,
      payload: new Uint8Array([2]),
    });
    await goneStore.authority.release(secondWriter);
    const secondUncertain = await goneStore.authority.recoverStaged({
      authorization: secondAuthorization,
      writer: secondWriter,
    });
    if (secondUncertain === null) {
      throw new Error("Expected dropped staged handle recovery");
    }
    const reconcileGone = reconcileAuthorization("reconcile-gone");
    const goneReader = await goneStore.authority.mintReader({
      authorization: reconcileGone,
      pin,
      expectedSessionRecordSequence: 3,
      purpose: "reconcile",
      activeHandles: [secondUncertain],
    });
    await goneStore.runtimeStore.load({
      reader: goneReader,
      handle: secondUncertain,
    });
    const preparedGone = await goneStore.authority.prepareFinalization({
      authorization: reconcileGone,
      handle: secondUncertain,
      outcome: "gone",
      expectedSessionRecordSequence: 3,
    });
    await goneStore.authority.acknowledgeFinalization({
      authorization: reconcileGone,
      receipt: preparedGone.receipt,
      durableSessionRecordSequence: 4,
    });
    await expect(goneStore.authority.recoverStaged({
      authorization: secondAuthorization,
      writer: secondWriter,
    })).rejects.toBeInstanceOf(RuntimeContinuationStoreError);
    await expect(goneStore.authority.mintWriter({
      authorization: authorization("gone-turn-3"),
      pin,
      expectedSessionRecordSequence: 4,
      previous: first,
      stateVersion: 1,
    })).resolves.toMatchObject({ id: expect.any(String) });
  });

  it("prepares a retryable committed view before acknowledging durable completion", async () => {
    const store = createStore();
    const first = await writeAndCommit(
      store,
      authorization("prepared-commit-1"),
      null,
      new Uint8Array([1]),
    );
    const secondAuthorization = authorization("prepared-commit-2");
    const writer = await store.authority.mintWriter({
      authorization: secondAuthorization,
      pin,
      expectedSessionRecordSequence: 2,
      previous: first,
      stateVersion: 1,
    });
    const uncertain = await store.runtimeStore.put({
      writer,
      payload: new Uint8Array([2]),
    });
    const reconcile = reconcileAuthorization("prepared-commit");
    const reconcileReader = await store.authority.mintReader({
      authorization: reconcile,
      pin,
      expectedSessionRecordSequence: 3,
      purpose: "reconcile",
      activeHandles: [uncertain],
    });
    await store.runtimeStore.load({ reader: reconcileReader, handle: uncertain });

    const prepared = await store.authority.prepareFinalization({
      authorization: reconcile,
      handle: uncertain,
      outcome: "committed",
      expectedSessionRecordSequence: 3,
    });
    await expect(store.authority.prepareFinalization({
      authorization: reconcile,
      handle: uncertain,
      outcome: "committed",
      expectedSessionRecordSequence: 3,
    })).resolves.toEqual(prepared);
    expect(prepared).toMatchObject({
      activeHandle: { ...uncertain, status: "committed" },
      receipt: {
        ownerInstanceId: store.ownerInstanceId,
        authorizationId: reconcile.id,
        continuationId: uncertain.id,
        expectedSessionRecordSequence: 3,
        outcome: "committed",
      },
    });
    await expect(store.authority.recoverStaged({
      authorization: secondAuthorization,
      writer,
    })).resolves.toEqual(uncertain);

    const retry = reconcileAuthorization("prepared-commit-retry");
    const retryReader = await store.authority.mintReader({
      authorization: retry,
      pin,
      expectedSessionRecordSequence: 3,
      purpose: "reconcile",
      activeHandles: [uncertain],
    });
    await expect(store.runtimeStore.load({
      reader: retryReader,
      handle: uncertain,
    })).resolves.toEqual(new Uint8Array([2]));

    const nextRun = authorization("prepared-commit-3");
    await expect(store.authority.mintReader({
      authorization: nextRun,
      pin,
      expectedSessionRecordSequence: 3,
      purpose: "run",
      activeHandles: [prepared.activeHandle!],
    })).rejects.toBeInstanceOf(RuntimeContinuationStoreError);
    const activeReader = await store.authority.mintReader({
      authorization: nextRun,
      pin,
      expectedSessionRecordSequence: 4,
      purpose: "run",
      activeHandles: [prepared.activeHandle!],
    });
    await expect(store.runtimeStore.load({
      reader: activeReader,
      handle: prepared.activeHandle!,
    })).resolves.toEqual(new Uint8Array([2]));

    await expect(store.authority.acknowledgeFinalization({
      authorization: reconcile,
      receipt: prepared.receipt,
      durableSessionRecordSequence: 5,
    })).rejects.toBeInstanceOf(RuntimeContinuationStoreError);
    await expect(store.authority.acknowledgeFinalization({
      authorization: { ...reconcile, operationId: "forged-operation" },
      receipt: prepared.receipt,
      durableSessionRecordSequence: 4,
    })).rejects.toBeInstanceOf(RuntimeContinuationStoreError);
    await expect(store.authority.acknowledgeFinalization({
      authorization: reconcile,
      receipt: { ...prepared.receipt, ownerInstanceId: "forged-owner" },
      durableSessionRecordSequence: 4,
    })).rejects.toBeInstanceOf(RuntimeContinuationStoreError);

    await store.authority.acknowledgeFinalization({
      authorization: reconcile,
      receipt: prepared.receipt,
      durableSessionRecordSequence: 4,
    });
    await expect(store.authority.acknowledgeFinalization({
      authorization: reconcile,
      receipt: prepared.receipt,
      durableSessionRecordSequence: 4,
    })).resolves.toBeUndefined();
    await expect(store.authority.recoverStaged({
      authorization: secondAuthorization,
      writer,
    })).rejects.toBeInstanceOf(RuntimeContinuationStoreError);
  });

  it("bounds pending reconciliation proofs independently of reader release", async () => {
    const store = new ProcessScopedRuntimeContinuationStore({
      now: () => new Date(time),
      capabilityTtlMs: 5_000,
      continuationTtlMs: 30_000,
      maxPayloadBytes: 1,
      maxStoredBytes: 1,
      maxStoredContinuations: 1,
    });
    const auth = authorization("bounded-proof");
    const writer = await store.authority.mintWriter({
      authorization: auth,
      pin,
      expectedSessionRecordSequence: 0,
      previous: null,
      stateVersion: 1,
    });
    const uncertain = await store.runtimeStore.put({
      writer,
      payload: new Uint8Array([1]),
    });
    const first = reconcileAuthorization("bounded-proof-1");
    const firstReader = await store.authority.mintReader({
      authorization: first,
      pin,
      expectedSessionRecordSequence: 1,
      purpose: "reconcile",
      activeHandles: [uncertain],
    });
    await store.runtimeStore.load({ reader: firstReader, handle: uncertain });
    const second = reconcileAuthorization("bounded-proof-2");
    const secondReader = await store.authority.mintReader({
      authorization: second,
      pin,
      expectedSessionRecordSequence: 1,
      purpose: "reconcile",
      activeHandles: [uncertain],
    });
    await expect(store.runtimeStore.load({
      reader: secondReader,
      handle: uncertain,
    })).rejects.toBeInstanceOf(RuntimeContinuationStoreError);
  });

  it("replaces a prepared receipt when the same uncertain sequence is retried", async () => {
    const store = new ProcessScopedRuntimeContinuationStore({
      now: () => new Date(time),
      capabilityTtlMs: 5_000,
      continuationTtlMs: 30_000,
      maxPayloadBytes: 1,
      maxStoredBytes: 1,
      maxStoredContinuations: 1,
    });
    const auth = authorization("replace-receipt");
    const writer = await store.authority.mintWriter({
      authorization: auth,
      pin,
      expectedSessionRecordSequence: 0,
      previous: null,
      stateVersion: 1,
    });
    const uncertain = await store.runtimeStore.put({
      writer,
      payload: new Uint8Array([1]),
    });
    const firstAuthorization = reconcileAuthorization("replace-receipt-1");
    const firstReader = await store.authority.mintReader({
      authorization: firstAuthorization,
      pin,
      expectedSessionRecordSequence: 1,
      purpose: "reconcile",
      activeHandles: [uncertain],
    });
    await store.runtimeStore.load({ reader: firstReader, handle: uncertain });
    const first = await store.authority.prepareFinalization({
      authorization: firstAuthorization,
      handle: uncertain,
      outcome: "committed",
      expectedSessionRecordSequence: 1,
    });

    const retryAuthorization = reconcileAuthorization("replace-receipt-2");
    const retryReader = await store.authority.mintReader({
      authorization: retryAuthorization,
      pin,
      expectedSessionRecordSequence: 1,
      purpose: "reconcile",
      activeHandles: [uncertain],
    });
    await expect(store.runtimeStore.load({
      reader: retryReader,
      handle: uncertain,
    })).resolves.toEqual(new Uint8Array([1]));
    const retry = await store.authority.prepareFinalization({
      authorization: retryAuthorization,
      handle: uncertain,
      outcome: "gone",
      expectedSessionRecordSequence: 1,
    });
    expect(retry.activeHandle).toBeNull();
    await expect(store.authority.acknowledgeFinalization({
      authorization: firstAuthorization,
      receipt: first.receipt,
      durableSessionRecordSequence: 2,
    })).rejects.toBeInstanceOf(RuntimeContinuationStoreError);
    await expect(store.authority.acknowledgeFinalization({
      authorization: retryAuthorization,
      receipt: retry.receipt,
      durableSessionRecordSequence: 2,
    })).resolves.toBeUndefined();
  });

  it("expires an unacknowledged receipt without poisoning its continuation lane", async () => {
    const store = new ProcessScopedRuntimeContinuationStore({
      now: () => new Date(time),
      capabilityTtlMs: 5_000,
      continuationTtlMs: 1_000,
      maxPayloadBytes: 1,
      maxStoredBytes: 1,
      maxStoredContinuations: 1,
    });
    const auth = authorization("expiring-finalization");
    const writer = await store.authority.mintWriter({
      authorization: auth,
      pin,
      expectedSessionRecordSequence: 0,
      previous: null,
      stateVersion: 1,
    });
    const uncertain = await store.runtimeStore.put({
      writer,
      payload: new Uint8Array([1]),
    });
    const prepared = await store.authority.prepareFinalization({
      authorization: auth,
      handle: uncertain,
      outcome: "committed",
      expectedSessionRecordSequence: 1,
    });

    time += 1_001;
    await expect(store.authority.acknowledgeFinalization({
      authorization: auth,
      receipt: prepared.receipt,
      durableSessionRecordSequence: 2,
    })).rejects.toBeInstanceOf(RuntimeContinuationStoreError);
    await expect(store.authority.mintWriter({
      authorization: authorization("after-expired-finalization"),
      pin,
      expectedSessionRecordSequence: 2,
      previous: null,
      stateVersion: 1,
    })).resolves.toMatchObject({ id: expect.any(String) });
  });

  it("prepares gone without deleting the uncertain tip or its committed predecessor", async () => {
    const store = createStore();
    const first = await writeAndCommit(
      store,
      authorization("prepared-gone-1"),
      null,
      new Uint8Array([1]),
    );
    const secondAuthorization = authorization("prepared-gone-2");
    const writer = await store.authority.mintWriter({
      authorization: secondAuthorization,
      pin,
      expectedSessionRecordSequence: 2,
      previous: first,
      stateVersion: 1,
    });
    const uncertain = await store.runtimeStore.put({
      writer,
      payload: new Uint8Array([2]),
    });
    const reconcile = reconcileAuthorization("prepared-gone");
    const reconcileReader = await store.authority.mintReader({
      authorization: reconcile,
      pin,
      expectedSessionRecordSequence: 3,
      purpose: "reconcile",
      activeHandles: [uncertain],
    });
    await store.runtimeStore.load({ reader: reconcileReader, handle: uncertain });

    const prepared = await store.authority.prepareFinalization({
      authorization: reconcile,
      handle: uncertain,
      outcome: "gone",
      expectedSessionRecordSequence: 3,
    });
    expect(prepared.activeHandle).toEqual(first);
    await expect(store.authority.recoverStaged({
      authorization: secondAuthorization,
      writer,
    })).resolves.toEqual(uncertain);

    const retry = reconcileAuthorization("prepared-gone-retry");
    const retryReader = await store.authority.mintReader({
      authorization: retry,
      pin,
      expectedSessionRecordSequence: 3,
      purpose: "reconcile",
      activeHandles: [uncertain],
    });
    await expect(store.runtimeStore.load({
      reader: retryReader,
      handle: uncertain,
    })).resolves.toEqual(new Uint8Array([2]));

    const nextRun = authorization("prepared-gone-3");
    const predecessorReader = await store.authority.mintReader({
      authorization: nextRun,
      pin,
      expectedSessionRecordSequence: 4,
      purpose: "run",
      activeHandles: [first],
    });
    await expect(store.runtimeStore.load({
      reader: predecessorReader,
      handle: first,
    })).resolves.toEqual(new Uint8Array([1]));

    await store.authority.acknowledgeFinalization({
      authorization: reconcile,
      receipt: prepared.receipt,
      durableSessionRecordSequence: 4,
    });
    await expect(store.authority.acknowledgeFinalization({
      authorization: reconcile,
      receipt: prepared.receipt,
      durableSessionRecordSequence: 4,
    })).resolves.toBeUndefined();
    await expect(store.authority.recoverStaged({
      authorization: secondAuthorization,
      writer,
    })).rejects.toBeInstanceOf(RuntimeContinuationStoreError);
    await expect(store.authority.mintWriter({
      authorization: authorization("prepared-gone-4"),
      pin,
      expectedSessionRecordSequence: 4,
      previous: first,
      stateVersion: 1,
    })).resolves.toMatchObject({ id: expect.any(String) });
  });

  it("materializes a prepared committed predecessor before creating its successor", async () => {
    const store = createStore();
    const firstAuthorization = authorization("lazy-committed-1");
    const firstWriter = await store.authority.mintWriter({
      authorization: firstAuthorization,
      pin,
      expectedSessionRecordSequence: 0,
      previous: null,
      stateVersion: 1,
    });
    const firstUncertain = await store.runtimeStore.put({
      writer: firstWriter,
      payload: new Uint8Array([1]),
    });
    const firstPrepared = await store.authority.prepareFinalization({
      authorization: firstAuthorization,
      handle: firstUncertain,
      outcome: "committed",
      expectedSessionRecordSequence: 1,
    });

    const secondAuthorization = authorization("lazy-committed-2");
    const secondWriter = await store.authority.mintWriter({
      authorization: secondAuthorization,
      pin,
      expectedSessionRecordSequence: 2,
      previous: firstPrepared.activeHandle,
      stateVersion: 1,
    });
    const secondUncertain = await store.runtimeStore.put({
      writer: secondWriter,
      payload: new Uint8Array([2]),
    });
    const reconciliation = reconcileAuthorization("lazy-committed-gone");
    const reader = await store.authority.mintReader({
      authorization: reconciliation,
      pin,
      expectedSessionRecordSequence: 3,
      purpose: "reconcile",
      activeHandles: [secondUncertain],
    });
    await store.runtimeStore.load({ reader, handle: secondUncertain });
    await expect(store.authority.prepareFinalization({
      authorization: reconciliation,
      handle: secondUncertain,
      outcome: "gone",
      expectedSessionRecordSequence: 3,
    })).resolves.toMatchObject({ activeHandle: firstPrepared.activeHandle });
    await expect(store.authority.acknowledgeFinalization({
      authorization: firstAuthorization,
      receipt: firstPrepared.receipt,
      durableSessionRecordSequence: 2,
    })).resolves.toBeUndefined();
  });

  it("preserves a prepared renewed expiry through a shorter-lived successor", async () => {
    time = Date.parse("2026-07-11T00:00:00.000Z");
    const startedAt = time;
    const store = new ProcessScopedRuntimeContinuationStore({
      now: () => new Date(time),
      capabilityTtlMs: 5_000,
      continuationTtlMs: 1_000,
      maxPayloadBytes: 1,
      maxStoredBytes: 2,
      maxStoredContinuations: 2,
    });
    const first = await writeAndCommit(
      store,
      authorization("lazy-renewed-1"),
      null,
      new Uint8Array([1]),
    );

    time = startedAt + 900;
    const secondAuthorization = authorization("lazy-renewed-2");
    const secondWriter = await store.authority.mintWriter({
      authorization: secondAuthorization,
      pin,
      expectedSessionRecordSequence: 2,
      previous: first,
      stateVersion: 1,
    });
    const second = await store.runtimeStore.put({
      writer: secondWriter,
      payload: new Uint8Array([2]),
    });

    time = startedAt + 1_001;
    const firstReconciliation = reconcileAuthorization("lazy-renewed-gone-1");
    const firstReader = await store.authority.mintReader({
      authorization: firstReconciliation,
      pin,
      expectedSessionRecordSequence: 3,
      purpose: "reconcile",
      activeHandles: [second],
    });
    await store.runtimeStore.load({ reader: firstReader, handle: second });
    const firstGone = await store.authority.prepareFinalization({
      authorization: firstReconciliation,
      handle: second,
      outcome: "gone",
      expectedSessionRecordSequence: 3,
    });

    time = startedAt + 1_100;
    const thirdAuthorization = {
      ...authorization("lazy-renewed-3"),
      expiresAt: new Date(startedAt + 1_500).toISOString(),
    };
    const thirdWriter = await store.authority.mintWriter({
      authorization: thirdAuthorization,
      pin,
      expectedSessionRecordSequence: 4,
      previous: firstGone.activeHandle,
      stateVersion: 1,
    });
    const third = await store.runtimeStore.put({
      writer: thirdWriter,
      payload: new Uint8Array([3]),
    });
    expect(Date.parse(third.expiresAt!)).toBeLessThan(
      Date.parse(firstGone.activeHandle!.expiresAt!),
    );

    time = startedAt + 1_200;
    const secondReconciliation = reconcileAuthorization("lazy-renewed-gone-2");
    const secondReader = await store.authority.mintReader({
      authorization: secondReconciliation,
      pin,
      expectedSessionRecordSequence: 5,
      purpose: "reconcile",
      activeHandles: [third],
    });
    await store.runtimeStore.load({ reader: secondReader, handle: third });
    await expect(store.authority.prepareFinalization({
      authorization: secondReconciliation,
      handle: third,
      outcome: "gone",
      expectedSessionRecordSequence: 5,
    })).resolves.toMatchObject({ activeHandle: firstGone.activeHandle });
    await expect(store.authority.acknowledgeFinalization({
      authorization: firstReconciliation,
      receipt: firstGone.receipt,
      durableSessionRecordSequence: 4,
    })).resolves.toBeUndefined();
  });

  it("keeps a live prepared predecessor reachable after its successor expires", async () => {
    time = Date.parse("2026-07-11T00:00:00.000Z");
    const startedAt = time;
    const store = new ProcessScopedRuntimeContinuationStore({
      now: () => new Date(time),
      capabilityTtlMs: 5_000,
      continuationTtlMs: 10_000,
      maxPayloadBytes: 1,
      maxStoredBytes: 2,
      maxStoredContinuations: 2,
    });
    const first = await writeAndCommit(
      store,
      authorization("lazy-pruned-1"),
      null,
      new Uint8Array([1]),
    );

    time = startedAt + 1_000;
    const secondAuthorization = {
      ...authorization("lazy-pruned-2"),
      expiresAt: new Date(startedAt + 2_000).toISOString(),
    };
    const secondWriter = await store.authority.mintWriter({
      authorization: secondAuthorization,
      pin,
      expectedSessionRecordSequence: 2,
      previous: first,
      stateVersion: 1,
    });
    const second = await store.runtimeStore.put({
      writer: secondWriter,
      payload: new Uint8Array([2]),
    });

    time = startedAt + 1_500;
    const reconciliation = reconcileAuthorization("lazy-pruned-gone");
    const reconcileReader = await store.authority.mintReader({
      authorization: reconciliation,
      pin,
      expectedSessionRecordSequence: 3,
      purpose: "reconcile",
      activeHandles: [second],
    });
    await store.runtimeStore.load({ reader: reconcileReader, handle: second });
    const prepared = await store.authority.prepareFinalization({
      authorization: reconciliation,
      handle: second,
      outcome: "gone",
      expectedSessionRecordSequence: 3,
    });
    expect(prepared.activeHandle).toEqual(first);

    time = startedAt + 2_001;
    const nextReader = await store.authority.mintReader({
      authorization: authorization("lazy-pruned-3"),
      pin,
      expectedSessionRecordSequence: 4,
      purpose: "run",
      activeHandles: [first],
    });
    await expect(store.runtimeStore.load({
      reader: nextReader,
      handle: first,
    })).resolves.toEqual(new Uint8Array([1]));
  });

  it("materializes a prepared empty lane before enforcing storage bounds", async () => {
    const store = new ProcessScopedRuntimeContinuationStore({
      now: () => new Date(time),
      capabilityTtlMs: 5_000,
      continuationTtlMs: 30_000,
      maxPayloadBytes: 1,
      maxStoredBytes: 1,
      maxStoredContinuations: 1,
    });
    const firstAuthorization = authorization("lazy-empty-1");
    const firstWriter = await store.authority.mintWriter({
      authorization: firstAuthorization,
      pin,
      expectedSessionRecordSequence: 0,
      previous: null,
      stateVersion: 1,
    });
    const uncertain = await store.runtimeStore.put({
      writer: firstWriter,
      payload: new Uint8Array([1]),
    });
    const reconciliation = reconcileAuthorization("lazy-empty-gone");
    const reader = await store.authority.mintReader({
      authorization: reconciliation,
      pin,
      expectedSessionRecordSequence: 1,
      purpose: "reconcile",
      activeHandles: [uncertain],
    });
    await store.runtimeStore.load({ reader, handle: uncertain });
    const prepared = await store.authority.prepareFinalization({
      authorization: reconciliation,
      handle: uncertain,
      outcome: "gone",
      expectedSessionRecordSequence: 1,
    });
    expect(prepared.activeHandle).toBeNull();

    const nextAuthorization = authorization("lazy-empty-2");
    const nextWriter = await store.authority.mintWriter({
      authorization: nextAuthorization,
      pin,
      expectedSessionRecordSequence: 2,
      previous: null,
      stateVersion: 1,
    });
    await expect(store.authority.acknowledgeFinalization({
      authorization: reconciliation,
      receipt: prepared.receipt,
      durableSessionRecordSequence: 2,
    })).resolves.toBeUndefined();
    await expect(store.runtimeStore.put({
      writer: nextWriter,
      payload: new Uint8Array([2]),
    })).resolves.toMatchObject({ status: "uncertain" });
  });

  it("renews a gone predecessor transitively only through each live successor", async () => {
    time = Date.parse("2026-07-11T00:00:00.000Z");
    const startedAt = time;
    const store = new ProcessScopedRuntimeContinuationStore({
      now: () => new Date(time),
      capabilityTtlMs: 5_000,
      continuationTtlMs: 1_000,
      maxPayloadBytes: 1,
      maxStoredBytes: 2,
      maxStoredContinuations: 2,
    });
    const first = await writeAndCommit(
      store,
      authorization("renewed-gone-1"),
      null,
      new Uint8Array([1]),
    );

    time = startedAt + 900;
    const secondAuthorization = authorization("renewed-gone-2");
    const secondWriter = await store.authority.mintWriter({
      authorization: secondAuthorization,
      pin,
      expectedSessionRecordSequence: 2,
      previous: first,
      stateVersion: 1,
    });
    const second = await store.runtimeStore.put({
      writer: secondWriter,
      payload: new Uint8Array([2]),
    });
    expect(Date.parse(second.expiresAt!)).toBeGreaterThan(
      Date.parse(first.expiresAt!),
    );

    time = startedAt + 1_001;
    const firstReconciliation = reconcileAuthorization("renewed-gone-first");
    const firstReader = await store.authority.mintReader({
      authorization: firstReconciliation,
      pin,
      expectedSessionRecordSequence: 3,
      purpose: "reconcile",
      activeHandles: [second],
    });
    await store.runtimeStore.load({ reader: firstReader, handle: second });
    const firstGone = await store.authority.prepareFinalization({
      authorization: firstReconciliation,
      handle: second,
      outcome: "gone",
      expectedSessionRecordSequence: 3,
    });
    expect(firstGone.activeHandle).toEqual({
      ...first,
      expiresAt: second.expiresAt,
    });
    const preparedReader = await store.authority.mintReader({
      authorization: authorization("renewed-gone-prepared-view"),
      pin,
      expectedSessionRecordSequence: 4,
      purpose: "run",
      activeHandles: [firstGone.activeHandle!],
    });
    await expect(store.runtimeStore.load({
      reader: preparedReader,
      handle: firstGone.activeHandle!,
    })).resolves.toEqual(new Uint8Array([1]));
    await store.authority.acknowledgeFinalization({
      authorization: firstReconciliation,
      receipt: firstGone.receipt,
      durableSessionRecordSequence: 4,
    });
    const firstRestored = firstGone.activeHandle!;

    time = startedAt + 1_800;
    const thirdAuthorization = authorization("renewed-gone-3");
    const thirdWriter = await store.authority.mintWriter({
      authorization: thirdAuthorization,
      pin,
      expectedSessionRecordSequence: 4,
      previous: firstRestored,
      stateVersion: 1,
    });
    const third = await store.runtimeStore.put({
      writer: thirdWriter,
      payload: new Uint8Array([3]),
    });

    time = startedAt + 1_901;
    const secondReconciliation = reconcileAuthorization("renewed-gone-second");
    const secondReader = await store.authority.mintReader({
      authorization: secondReconciliation,
      pin,
      expectedSessionRecordSequence: 5,
      purpose: "reconcile",
      activeHandles: [third],
    });
    await store.runtimeStore.load({ reader: secondReader, handle: third });
    const secondGone = await store.authority.prepareFinalization({
      authorization: secondReconciliation,
      handle: third,
      outcome: "gone",
      expectedSessionRecordSequence: 5,
    });
    expect(secondGone.activeHandle).toEqual({
      ...firstRestored,
      expiresAt: third.expiresAt,
    });
    await store.authority.acknowledgeFinalization({
      authorization: secondReconciliation,
      receipt: secondGone.receipt,
      durableSessionRecordSequence: 6,
    });
    const secondRestored = secondGone.activeHandle!;
    const restoredReader = await store.authority.mintReader({
      authorization: authorization("renewed-gone-4"),
      pin,
      expectedSessionRecordSequence: 6,
      purpose: "run",
      activeHandles: [secondRestored],
    });
    await expect(store.runtimeStore.load({
      reader: restoredReader,
      handle: secondRestored,
    })).resolves.toEqual(new Uint8Array([1]));

    time = Date.parse(third.expiresAt!) + 1;
    await expect(store.authority.mintWriter({
      authorization: authorization("renewed-gone-after-expiry"),
      pin,
      expectedSessionRecordSequence: 6,
      previous: null,
      stateVersion: 1,
    })).resolves.toMatchObject({ id: expect.any(String) });
  });

  it("rejects expired state/capabilities, mismatched authorization, and oversized bytes safely", async () => {
    time = Date.parse("2026-07-11T00:00:00.000Z");
    const store = createStore(3);
    const auth1 = authorization("turn-1");
    const oversizedWriter = await store.authority.mintWriter({
      authorization: auth1,
      pin,
      expectedSessionRecordSequence: 0,
      previous: null,
      stateVersion: 1,
    });
    await expect(store.runtimeStore.put({
      writer: oversizedWriter,
      payload: new TextEncoder().encode("secret-canary"),
    })).rejects.toThrow("Continuation state is invalid");
    await expect(store.runtimeStore.put({
      writer: oversizedWriter,
      payload: new Uint8Array([1]),
    })).rejects.toThrow("Continuation capability is invalid");

    const committed = await writeAndCommit(
      store,
      auth1,
      null,
      new Uint8Array([1, 2, 3]),
    );
    await expect(store.authority.prepareFinalization({
      authorization: { ...auth1, operationId: "wrong" },
      handle: committed,
      outcome: "committed",
      expectedSessionRecordSequence: 2,
    })).rejects.toBeInstanceOf(RuntimeContinuationStoreError);
    time += 31_000;
    await expect(store.authority.mintReader({
      authorization: authorization("turn-2"),
      pin,
      expectedSessionRecordSequence: 2,
      purpose: "run",
      activeHandles: [committed],
    })).rejects.toBeInstanceOf(RuntimeContinuationStoreError);
    expect(() => JSON.stringify(store)).not.toThrow();
    expect(JSON.stringify(store)).not.toContain("secret-canary");
  });

  it("zeroes and revokes process state on disposal", async () => {
    const store = createStore();
    const auth1 = authorization("turn-1");
    const committed = await writeAndCommit(store, auth1);
    const reader = await store.authority.mintReader({
      authorization: authorization("turn-2"),
      pin,
      expectedSessionRecordSequence: 2,
      purpose: "run",
      activeHandles: [committed],
    });
    store.dispose();
    await expect(store.runtimeStore.load({ reader, handle: committed }))
      .rejects.toBeInstanceOf(RuntimeContinuationStoreError);
    await expect(store.authority.mintWriter({
      authorization: authorization("turn-2"),
      pin,
      expectedSessionRecordSequence: 2,
      previous: committed,
      stateVersion: 1,
    })).rejects.toBeInstanceOf(RuntimeContinuationStoreError);
  });
});
