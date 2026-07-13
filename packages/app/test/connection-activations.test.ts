import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ConnectionActivationError,
  FileConnectionActivationStore,
  FileConnectionRegistry,
  connectionActivationPath,
  type BrokeredModelProviderConnectionRecord,
  type PendingConnectionActivation,
} from "../src/index.js";

const AT = "2026-07-14T00:00:00.000Z";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function root(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "recurs-activation-"));
  directories.push(directory);
  return directory;
}

function connection(
  overrides: Partial<BrokeredModelProviderConnectionRecord> = {},
): BrokeredModelProviderConnectionRecord {
  return {
    kind: "brokered_model_provider",
    id: "71000000-0000-4000-8000-000000000001",
    providerId: "openai-api",
    adapterId: "openai-responses",
    activationProfileId: "openai_api_v1",
    label: "OpenAI API",
    modelId: "gpt-5",
    credentialIdentityFingerprint: `sha256:${"b".repeat(64)}`,
    policyRevision: "openai-api-2026-07-11",
    billingPolicy: {
      revision: "billing:openai-api:2026-07-11",
      disclosureRevision: "billing-disclosure:openai-api:2026-07-11",
      primarySource: "metered_api",
      possibleAdditionalSources: [],
      providerFallback: "none",
      availableSelections: ["strict_primary_only"],
    },
    billingSelection: {
      mode: "strict_primary_only",
      policyRevision: "billing:openai-api:2026-07-11",
      disclosureRevision: "billing-disclosure:openai-api:2026-07-11",
      allowedSources: ["metered_api"],
      acknowledgedAt: AT,
    },
    verifiedAt: AT,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function activation(
  overrides: Partial<PendingConnectionActivation> = {},
): PendingConnectionActivation {
  return {
    connection: connection(),
    stagedAt: AT,
    ...overrides,
  };
}

async function writePrivate(filename: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  await writeFile(filename, contents, { mode: 0o600 });
  await chmod(filename, 0o600);
}

describe("FileConnectionActivationStore", () => {
  it("prepares one immutable private sidecar and reads absence as null", async () => {
    const directory = await root();
    const store = new FileConnectionActivationStore(directory);

    const empty = await store.read();
    expect(empty).toEqual({ schemaVersion: 1, activation: null });
    expect(Object.isFrozen(empty)).toBe(true);

    const prepared = await store.prepare(activation());

    expect(prepared).toEqual({ schemaVersion: 1, activation: activation() });
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.activation)).toBe(true);
    expect(Object.isFrozen(prepared.activation?.connection)).toBe(true);
    expect((await lstat(connectionActivationPath(directory))).mode & 0o777)
      .toBe(0o600);
  });

  it("replays only the exact pending activation and retains it on conflict", async () => {
    const directory = await root();
    const store = new FileConnectionActivationStore(directory);
    const expected = activation();
    await store.prepare(expected);
    const before = await lstat(connectionActivationPath(directory));

    await expect(store.prepare(structuredClone(expected))).resolves.toEqual({
      schemaVersion: 1,
      activation: expected,
    });
    expect((await lstat(connectionActivationPath(directory))).ino).toBe(
      before.ino,
    );

    const conflicting = activation({
      connection: connection({
        id: "71000000-0000-4000-8000-000000000002",
      }),
    });
    await expect(store.prepare(conflicting)).rejects.toEqual(
      new ConnectionActivationError(
        "activation_conflict",
        "Pending connection activation conflicts with this operation",
      ),
    );
    expect((await store.read()).activation).toEqual(expected);
  });

  it("serializes sidecar reads with registry mutations through the same lock", async () => {
    const directory = await root();
    const store = new FileConnectionActivationStore(directory);
    await store.prepare(activation());
    const registry = new FileConnectionRegistry(directory);
    const revision = (await registry.read()).revision;
    let entered: (() => void) | undefined;
    const mutationEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release: (() => void) | undefined;
    const mutationReleased = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mutation = registry.commit(revision, async () => {
      entered?.();
      await mutationReleased;
    });
    await mutationEntered;

    let readSettled = false;
    const reading = store.read().finally(() => {
      readSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(readSettled).toBe(false);

    release?.();
    await mutation;
    await expect(reading).resolves.toMatchObject({ activation: activation() });
  });

  it("strictly rejects malformed, secret-bearing, and oversized sidecars", async () => {
    const directory = await root();
    const filename = connectionActivationPath(directory);
    const valid = { schemaVersion: 1, activation: activation() };
    const canary = `sk-proj-${"A".repeat(48)}`;
    const invalid: string[] = [
      `{"schemaVersion":1,"schemaVersion":1,"activation":null}\n`,
      `${JSON.stringify({ ...valid, unexpected: true })}\n`,
      `${JSON.stringify({
        ...valid,
        activation: { ...activation(), attemptId: "native-private" },
      })}\n`,
      `${JSON.stringify({
        ...valid,
        activation: activation({
          connection: connection({ label: canary }),
        }),
      })}\n`,
      `${JSON.stringify({
        ...valid,
        activation: activation({ stagedAt: "2026-07-14" }),
      })}\n`,
    ];

    for (const contents of invalid) {
      await writePrivate(filename, contents);
      let caught: unknown;
      try {
        await new FileConnectionActivationStore(directory).read();
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: "registry_invalid" });
      expect(JSON.stringify(caught)).not.toContain(canary);
    }

    await writePrivate(filename, "x".repeat(64 * 1024 + 1));
    await expect(new FileConnectionActivationStore(directory).read()).rejects
      .toMatchObject({ code: "registry_invalid" });
  });

  it("rejects unsafe permissions and symlinks through the shared secure store", async () => {
    const directory = await root();
    const filename = connectionActivationPath(directory);
    const contents = `${JSON.stringify({
      schemaVersion: 1,
      activation: activation(),
    })}\n`;
    await writePrivate(filename, contents);
    await chmod(filename, 0o644);
    await expect(new FileConnectionActivationStore(directory).read()).rejects
      .toMatchObject({ code: "storage_unsafe" });

    const external = path.join(directory, "external.json");
    await writePrivate(external, contents);
    await rm(filename);
    await symlink(external, filename);
    await expect(new FileConnectionActivationStore(directory).read()).rejects
      .toMatchObject({ code: "storage_unsafe" });
    expect(await readFile(external, "utf8")).toBe(contents);
  });

  it("commits the first activation as primary while retaining the sidecar", async () => {
    const directory = await root();
    const store = new FileConnectionActivationStore(directory);
    await store.prepare(activation());

    const committed = await store.commitToRegistry(connection().id);

    expect(committed).toMatchObject({
      revision: 1,
      primaryConnectionId: connection().id,
      connections: [connection()],
    });
    expect((await store.read()).activation).toEqual(activation());

    const replay = await store.commitToRegistry(connection().id);
    expect(replay.revision).toBe(1);
    expect(replay).toEqual(committed);
  });

  it("keeps later activations secondary and preserves an explicit no-primary state", async () => {
    const directory = await root();
    const registry = new FileConnectionRegistry(directory);
    await registry.commit(0, (draft) => {
      draft.connections.push({
        kind: "local_openai_compatible",
        id: "local-existing",
        providerId: "local-openai-compatible",
        adapterId: "openai-chat-completions",
        label: "Local",
        baseUrl: "http://127.0.0.1:11434/v1",
        modelId: "qwen",
        createdAt: AT,
        updatedAt: AT,
      });
    });
    const store = new FileConnectionActivationStore(directory);
    await store.prepare(activation());

    const committed = await store.commitToRegistry(connection().id);

    expect(committed.primaryConnectionId).toBeNull();
    expect(committed.connections.map(({ id }) => id)).toEqual([
      "local-existing",
      connection().id,
    ]);
  });

  it("retains the sidecar when the registry contains a conflicting exact id", async () => {
    const directory = await root();
    const registry = new FileConnectionRegistry(directory);
    await registry.commit(0, (draft) => {
      draft.connections.push(connection({ modelId: "other-model" }));
      draft.primaryConnectionId = connection().id;
    });
    const store = new FileConnectionActivationStore(directory);
    await store.prepare(activation());

    await expect(store.commitToRegistry(connection().id)).rejects.toMatchObject({
      code: "activation_conflict",
    });
    expect((await store.read()).activation).toEqual(activation());
    expect((await registry.read()).connections[0]).toMatchObject({
      modelId: "other-model",
    });
  });

  it("discards only the exact activation and makes exact replay idempotent", async () => {
    const directory = await root();
    const store = new FileConnectionActivationStore(directory);
    await store.prepare(activation());

    await expect(store.discard("wrong-id")).rejects.toMatchObject({
      code: "activation_conflict",
    });
    expect((await store.read()).activation).not.toBeNull();

    await store.discard(connection().id);
    expect(await store.read()).toEqual({ schemaVersion: 1, activation: null });
    await expect(store.discard(connection().id)).resolves.toBeUndefined();
    await expect(lstat(connectionActivationPath(directory))).rejects
      .toMatchObject({ code: "ENOENT" });
  });

  it("recognizes a completed commit after the sidecar has already been removed", async () => {
    const directory = await root();
    const store = new FileConnectionActivationStore(directory);
    await store.prepare(activation());
    const committed = await store.commitToRegistry(connection().id);
    await store.discard(connection().id);

    await expect(store.commitToRegistry(connection().id)).resolves.toEqual(
      committed,
    );
    await expect(store.commitToRegistry("missing-id")).rejects.toMatchObject({
      code: "activation_not_found",
    });
  });

  it("leaves an old or new sidecar across atomic replace failures", async () => {
    const beforeDirectory = await root();
    const before = new FileConnectionActivationStore(beforeDirectory, {
      faultInjector(point) {
        if (point === "before_rename") throw new Error("before");
      },
    });
    await expect(before.prepare(activation())).rejects.toThrow("before");
    expect((await new FileConnectionActivationStore(beforeDirectory).read())
      .activation).toBeNull();

    const afterDirectory = await root();
    const after = new FileConnectionActivationStore(afterDirectory, {
      faultInjector(point) {
        if (point === "after_rename") throw new Error("after");
      },
    });
    await expect(after.prepare(activation())).rejects.toThrow("after");
    expect((await new FileConnectionActivationStore(afterDirectory).read())
      .activation).toEqual(activation());
  });

  it("replays a registry commit after an uncertain post-rename failure", async () => {
    const directory = await root();
    const normal = new FileConnectionActivationStore(directory);
    await normal.prepare(activation());
    const uncertain = new FileConnectionActivationStore(directory, {
      faultInjector(point) {
        if (point === "after_rename") throw new Error("uncertain");
      },
    });

    await expect(uncertain.commitToRegistry(connection().id)).rejects
      .toThrow("uncertain");
    const installed = await new FileConnectionRegistry(directory).read();
    expect(installed).toMatchObject({ revision: 1, connections: [connection()] });
    expect((await normal.read()).activation).toEqual(activation());
    await expect(normal.commitToRegistry(connection().id)).resolves.toEqual(
      installed,
    );
  });

  it("makes activation removal durable on either side of an injected crash", async () => {
    const beforeDirectory = await root();
    const beforeNormal = new FileConnectionActivationStore(beforeDirectory);
    await beforeNormal.prepare(activation());
    const before = new FileConnectionActivationStore(beforeDirectory, {
      faultInjector(point) {
        if (point === "before_remove") throw new Error("before remove");
      },
    });
    await expect(before.discard(connection().id)).rejects
      .toThrow("before remove");
    expect((await beforeNormal.read()).activation).toEqual(activation());

    const afterDirectory = await root();
    const afterNormal = new FileConnectionActivationStore(afterDirectory);
    await afterNormal.prepare(activation());
    const afterOriginal = await lstat(
      connectionActivationPath(afterDirectory),
    );
    const after = new FileConnectionActivationStore(afterDirectory, {
      faultInjector(point) {
        if (point === "after_remove") throw new Error("after remove");
      },
    });
    await expect(after.discard(connection().id)).rejects
      .toThrow("after remove");
    expect((await afterNormal.read()).activation).toBeNull();
    const retirements = (await readdir(path.join(afterDirectory, "config")))
      .filter((entry) => entry.startsWith(".connection-activations.remove."));
    expect(retirements).toHaveLength(1);
    const retired = await lstat(
      path.join(afterDirectory, "config", retirements[0]!),
    );
    expect({ dev: retired.dev, ino: retired.ino, size: retired.size })
      .toEqual({ dev: afterOriginal.dev, ino: afterOriginal.ino, size: 0 });
    expect(retired.mode & 0o777).toBe(0o600);
  });

  it("never deletes an inode substituted at the private retirement path", async () => {
    const directory = await root();
    const filename = connectionActivationPath(directory);
    const configDirectory = path.dirname(filename);
    const heldOriginal = path.join(configDirectory, ".held-original-activation");
    const normal = new FileConnectionActivationStore(directory);
    await normal.prepare(activation());
    const original = await lstat(filename);
    const originalContents = await readFile(filename, "utf8");
    const replacementContents = `${JSON.stringify({
      schemaVersion: 1,
      activation: activation({
        connection: connection({
          id: "71000000-0000-4000-8000-000000000002",
        }),
      }),
    })}\n`;
    let substituted = false;
    const adversarial = new FileConnectionActivationStore(directory, {
      async faultInjector(point) {
        if (point !== "after_remove_retirement") return;
        const retirement = (await readdir(configDirectory)).find((entry) =>
          entry.startsWith(".connection-activations.remove.")
        );
        if (retirement === undefined) throw new Error("missing removal retirement");
        const retirementPath = path.join(configDirectory, retirement);
        await rename(retirementPath, heldOriginal);
        await writePrivate(retirementPath, replacementContents);
        substituted = true;
      },
    });

    await expect(adversarial.discard(connection().id)).rejects.toMatchObject({
      code: "storage_unsafe",
    });

    expect(substituted).toBe(true);
    await expect(readFile(filename, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const held = await lstat(heldOriginal);
    expect({ dev: held.dev, ino: held.ino, size: held.size }).toEqual({
      dev: original.dev,
      ino: original.ino,
      size: original.size,
    });
    expect(await readFile(heldOriginal, "utf8")).toBe(originalContents);
    const retirements = (await readdir(configDirectory)).filter((entry) =>
      entry.startsWith(".connection-activations.remove.")
    );
    expect(retirements).toHaveLength(1);
    expect(
      await readFile(path.join(configDirectory, retirements[0]!), "utf8"),
    ).toBe(replacementContents);
  });

  it("truncates only the opened inode when retirement is swapped after its durable rename", async () => {
    const directory = await root();
    const filename = connectionActivationPath(directory);
    const configDirectory = path.dirname(filename);
    const heldOriginal = path.join(configDirectory, ".held-durable-activation");
    const normal = new FileConnectionActivationStore(directory);
    await normal.prepare(activation());
    const original = await lstat(filename);
    const replacementContents = `${JSON.stringify({
      schemaVersion: 1,
      activation: activation({
        connection: connection({
          id: "71000000-0000-4000-8000-000000000002",
        }),
      }),
    })}\n`;
    let replacementPath: string | undefined;
    const adversarial = new FileConnectionActivationStore(directory, {
      async faultInjector(point) {
        if (point !== "after_remove_durable_rename") return;
        const retirement = (await readdir(configDirectory)).find((entry) =>
          entry.startsWith(".connection-activations.remove.")
        );
        if (retirement === undefined) throw new Error("missing removal retirement");
        replacementPath = path.join(configDirectory, retirement);
        await rename(replacementPath, heldOriginal);
        await writePrivate(replacementPath, replacementContents);
      },
    });

    await expect(adversarial.discard(connection().id)).rejects.toMatchObject({
      code: "storage_unsafe",
    });

    await expect(readFile(filename, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const held = await lstat(heldOriginal);
    expect({ dev: held.dev, ino: held.ino, size: held.size }).toEqual({
      dev: original.dev,
      ino: original.ino,
      size: 0,
    });
    expect(await readFile(heldOriginal, "utf8")).toBe("");
    expect(replacementPath).toBeDefined();
    expect(await readFile(replacementPath!, "utf8")).toBe(replacementContents);
  });

  it("recovers with a fresh activation after a crash in the durable pre-truncate window", async () => {
    const directory = await root();
    const filename = connectionActivationPath(directory);
    const configDirectory = path.dirname(filename);
    const normal = new FileConnectionActivationStore(directory);
    await normal.prepare(activation());
    const original = await lstat(filename);
    const originalContents = await readFile(filename, "utf8");
    const crash = new Error("durable removal crash");
    const crashing = new FileConnectionActivationStore(directory, {
      faultInjector(point) {
        if (point === "after_remove_durable_rename") throw crash;
      },
    });

    await expect(crashing.discard(connection().id)).rejects.toBe(crash);

    await expect(readFile(filename, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const retirement = (await readdir(configDirectory)).find((entry) =>
      entry.startsWith(".connection-activations.remove.")
    );
    expect(retirement).toBeDefined();
    const retirementPath = path.join(configDirectory, retirement!);
    const retired = await lstat(retirementPath);
    expect({ dev: retired.dev, ino: retired.ino, size: retired.size }).toEqual({
      dev: original.dev,
      ino: original.ino,
      size: original.size,
    });
    expect(await readFile(retirementPath, "utf8")).toBe(originalContents);

    const fresh = activation({
      connection: connection({
        id: "71000000-0000-4000-8000-000000000002",
      }),
    });
    await expect(normal.prepare(fresh)).resolves.toMatchObject({
      activation: fresh,
    });
    await expect(normal.commitToRegistry(fresh.connection.id)).resolves
      .toMatchObject({ connections: [fresh.connection] });
  });

  it("rejects read-only tampering without retiring or changing the activation", async () => {
    const directory = await root();
    const filename = connectionActivationPath(directory);
    const configDirectory = path.dirname(filename);
    const store = new FileConnectionActivationStore(directory);
    await store.prepare(activation());
    const original = await lstat(filename);
    const originalContents = await readFile(filename, "utf8");
    await chmod(filename, 0o400);

    await expect(store.discard(connection().id)).rejects.toMatchObject({
      code: "storage_unsafe",
    });

    const retained = await lstat(filename);
    expect({ dev: retained.dev, ino: retained.ino, size: retained.size })
      .toEqual({ dev: original.dev, ino: original.ino, size: original.size });
    expect(retained.mode & 0o777).toBe(0o400);
    expect(await readFile(filename, "utf8")).toBe(originalContents);
    expect((await readdir(configDirectory)).filter((entry) =>
      entry.startsWith(".connection-activations.remove.")
    )).toEqual([]);
  });
});
