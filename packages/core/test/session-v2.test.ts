import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { SessionBackendPin } from "@recurs/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { JsonlSessionStore } from "../src/index.js";

const directories: string[] = [];
const at = "2026-07-10T00:00:00.000Z";

const backend: SessionBackendPin = {
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

async function temporaryStore(): Promise<JsonlSessionStore> {
  const directory = await mkdtemp(path.join(tmpdir(), "recurs-v2-session-"));
  directories.push(directory);
  return new JsonlSessionStore(directory);
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("version 2 sessions", () => {
  it("creates a pinned sequence-zero session and appends exact next sequences", async () => {
    const store = await temporaryStore();
    const initial = await store.createPinnedSession({
      id: "s2",
      cwd: "/workspace",
      backend,
      at,
    });

    expect(initial).toMatchObject({
      version: 2,
      lastSequence: 0,
      backend: { type: "pinned", pin: backend },
    });

    await store.withSessionMutation("s2", 0, async (lease) => {
      const record = await lease.append({
        type: "turn_started",
        turnId: "turn-1",
        prompt: "inspect",
        at,
      });
      expect(record.sequence).toBe(1);
      expect(lease.currentSequence).toBe(1);
    });

    await expect(
      store.withSessionMutation("s2", 0, async () => undefined),
    ).rejects.toMatchObject({ code: "session_conflict" });
    expect((await store.loadState("s2")).messages).toEqual([
      {
        id: "turn-1:user",
        role: "user",
        content: "inspect",
      },
    ]);
  });

  it("rejects a competing process-style mutation lease", async () => {
    const store = await temporaryStore();
    await store.createPinnedSession({
      id: "s2",
      cwd: "/workspace",
      backend,
      at,
    });

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acquired!: () => void;
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const first = store.withSessionMutation("s2", 0, async () => {
      acquired();
      await held;
    });
    await ready;

    await expect(
      new JsonlSessionStore(store.directory).withSessionMutation(
        "s2",
        0,
        async () => undefined,
      ),
    ).rejects.toMatchObject({ code: "session_busy" });

    release();
    await first;
  });

  it("rejects unknown fields in a committed version 2 record", async () => {
    const store = await temporaryStore();
    await writeFile(
      path.join(store.directory, "s2.jsonl"),
      `${JSON.stringify({
        version: 2,
        type: "session_created",
        sessionId: "s2",
        sequence: 0,
        at,
        cwd: "/workspace",
        backend,
        injected: "not allowed",
      })}\n`,
      "utf8",
    );

    await expect(store.load("s2")).rejects.toMatchObject({
      code: "invalid_record",
    });
  });
});
