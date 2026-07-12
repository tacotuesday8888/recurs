import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileConnectionRegistry,
  setupLocalConnection,
  verifyLocalConnection,
  type LocalConnectionRecord,
} from "../src/index.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function temporaryRoot(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "recurs-app-local-"));
  directories.push(directory);
  return directory;
}

function modelList(...modelIds: string[]): typeof globalThis.fetch {
  return async () => Response.json({
    object: "list",
    data: modelIds.map((id) => ({
      id,
      object: "model",
      created: 0,
      owned_by: "local",
    })),
  });
}

function localRecord(
  id: string,
  baseUrl: string,
  modelId: string,
): LocalConnectionRecord {
  return {
    kind: "local_openai_compatible",
    id,
    providerId: "local-openai-compatible",
    adapterId: "openai-chat-completions",
    label: "Local model",
    baseUrl,
    modelId,
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
  };
}

describe("application local connection onboarding", () => {
  it("keeps a later local origin secondary", async () => {
    const root = await temporaryRoot();

    const first = await setupLocalConnection(root, {
      baseUrl: "http://127.0.0.1:11434/v1",
      modelId: "qwen",
      fetch: modelList("qwen"),
    });
    const second = await setupLocalConnection(root, {
      baseUrl: "http://127.0.0.1:1234/v1",
      modelId: "codestral",
      fetch: modelList("codestral"),
    });

    expect(first.primary).toBe(true);
    expect(second.primary).toBe(false);
    const document = await new FileConnectionRegistry(root).read();
    expect(document.primaryConnectionId).toBe(first.id);
    expect(document.connections).toHaveLength(2);
  });

  it("updates the exact normalized origin without changing its primary state", async () => {
    const root = await temporaryRoot();
    const original = await setupLocalConnection(root, {
      baseUrl: "http://127.0.0.1:11434/v1/",
      modelId: "old",
      fetch: modelList("old"),
    });
    await setupLocalConnection(root, {
      baseUrl: "http://127.0.0.1:1234/v1",
      modelId: "secondary",
      fetch: modelList("secondary"),
    });
    const updated = await setupLocalConnection(root, {
      baseUrl: "http://127.0.0.1:11434/v1",
      modelId: "new",
      fetch: modelList("new"),
    });

    expect(updated).toMatchObject({
      id: original.id,
      baseUrl: "http://127.0.0.1:11434/v1",
      modelId: "new",
      primary: true,
    });
    expect((await new FileConnectionRegistry(root).read()).connections)
      .toHaveLength(2);
  });

  it("does not choose a primary when records already exist without one", async () => {
    const root = await temporaryRoot();
    const registry = new FileConnectionRegistry(root);
    await registry.commit(0, (draft) => {
      draft.connections.push(localRecord(
        "local-existing",
        "http://127.0.0.1:8080/v1",
        "existing",
      ));
    });

    const added = await setupLocalConnection(root, {
      baseUrl: "http://127.0.0.1:11434/v1",
      modelId: "new",
      fetch: modelList("new"),
    });

    expect(added.primary).toBe(false);
    expect((await registry.read()).primaryConnectionId).toBeNull();
  });

  it("fails closed when one normalized origin has duplicate records", async () => {
    const root = await temporaryRoot();
    const registry = new FileConnectionRegistry(root);
    await registry.commit(0, (draft) => {
      draft.connections.push(
        localRecord(
          "local-first",
          "http://127.0.0.1:11434/v1",
          "one",
        ),
        localRecord(
          "local-second",
          "http://127.0.0.1:11434/v1",
          "two",
        ),
      );
      draft.primaryConnectionId = "local-first";
    });

    await expect(setupLocalConnection(root, {
      baseUrl: "http://127.0.0.1:11434/v1",
      modelId: "three",
      fetch: modelList("three"),
    })).rejects.toThrow("duplicate local connection records");

    expect((await registry.read()).connections).toHaveLength(2);
  });

  it("verifies the exact stored model without mutating registry state", async () => {
    const root = await temporaryRoot();
    const registry = new FileConnectionRegistry(root);
    const configured = await setupLocalConnection(root, {
      baseUrl: "http://127.0.0.1:11434/v1",
      modelId: "qwen",
      fetch: modelList("qwen"),
    });
    const before = await registry.read();
    const record = before.connections.find(
      (entry): entry is LocalConnectionRecord => entry.id === configured.id,
    );
    expect(record).toBeDefined();

    await expect(verifyLocalConnection(record!, {
      fetch: modelList("qwen"),
    })).resolves.toEqual({ status: "verified" });
    await expect(verifyLocalConnection(record!, {
      fetch: modelList("another"),
    })).resolves.toEqual({ status: "failed", reason: "model_unavailable" });
    expect((await registry.read()).revision).toBe(before.revision);
  });
});
