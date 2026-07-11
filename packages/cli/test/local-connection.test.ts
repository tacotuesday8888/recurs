import { chmod, lstat, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  localConnectionPath,
  readLocalConnection,
  setupLocalConnection,
  writeLocalConnection,
} from "../src/index.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function root(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "recurs-local-connection-"));
  directories.push(directory);
  return directory;
}

describe("local connection configuration", () => {
  it("atomically round-trips non-secret metadata in a private file", async () => {
    const directory = await root();
    const saved = await writeLocalConnection(directory, {
      baseUrl: "http://127.0.0.1:11434/v1/",
      modelId: "qwen-coder",
      now: "2026-07-11T00:00:00.000Z",
    });

    expect(saved).toMatchObject({
      schemaVersion: 1,
      kind: "local_openai_compatible",
      baseUrl: "http://127.0.0.1:11434/v1",
      modelId: "qwen-coder",
    });
    expect(await readLocalConnection(directory)).toEqual(saved);
    expect((await lstat(localConnectionPath(directory))).mode & 0o777).toBe(0o600);
  });

  it("returns null when no connection exists", async () => {
    expect(await readLocalConnection(await root())).toBeNull();
  });

  it("rejects unknown fields and remote origins when loading", async () => {
    const directory = await root();
    await mkdir(path.dirname(localConnectionPath(directory)), { recursive: true });
    await writeFile(localConnectionPath(directory), JSON.stringify({
      schemaVersion: 1,
      kind: "local_openai_compatible",
      id: "local-1",
      label: "Local model",
      baseUrl: "http://example.com/v1",
      modelId: "model",
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z",
      unexpected: true,
    }));
    await chmod(localConnectionPath(directory), 0o600);

    await expect(readLocalConnection(directory)).rejects.toThrow(
      "Local connection configuration is invalid",
    );
  });

  it("verifies the selected model before persisting setup", async () => {
    const directory = await root();
    const saved = await setupLocalConnection(directory, {
      baseUrl: "http://127.0.0.1:11434/v1",
      modelId: "qwen-coder",
      fetch: async () => Response.json({
        data: [{ id: "qwen-coder", object: "model", owned_by: "local" }],
      }),
    });
    expect(saved.modelId).toBe("qwen-coder");
    expect(await readLocalConnection(directory)).toEqual(saved);

    await expect(setupLocalConnection(directory, {
      baseUrl: "http://127.0.0.1:11434/v1",
      modelId: "missing",
      fetch: async () => Response.json({ data: [{ id: "qwen-coder" }] }),
    })).rejects.toThrow("Selected local model was not reported by the server");
    expect((await readLocalConnection(directory))?.modelId).toBe("qwen-coder");
  });
});
