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
  return store.authority.commit({ authorization: auth, handle: uncertain });
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
    const committed = await store.authority.commit({
      authorization: auth1,
      handle: uncertain,
    });
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

    const committed = await store.authority.commit({
      authorization: auth1,
      handle: uncertain,
    });
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

    const committedSecond = await store.authority.commit({
      authorization: auth2,
      handle: second,
    });
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
    await expect(committedStore.authority.commit({
      authorization: reconcile,
      handle: uncertain,
    })).resolves.toMatchObject({ status: "committed" });

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
    const secondUncertain = await goneStore.runtimeStore.put({
      writer: secondWriter,
      payload: new Uint8Array([2]),
    });
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
    await goneStore.authority.discard({
      authorization: reconcileGone,
      handle: secondUncertain,
    });
    await expect(goneStore.authority.mintWriter({
      authorization: authorization("gone-turn-3"),
      pin,
      expectedSessionRecordSequence: 4,
      previous: first,
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
    await expect(store.authority.commit({
      authorization: { ...auth1, operationId: "wrong" },
      handle: committed,
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
