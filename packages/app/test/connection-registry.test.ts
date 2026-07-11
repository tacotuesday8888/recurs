import { randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ConnectionRegistryError,
  FileConnectionRegistry,
  connectionRegistryPath,
  legacyLocalConnectionPath,
  type DelegatedConnectionRecord,
  type LocalConnectionRecord,
} from "../src/index.js";

const AT = "2026-07-11T00:00:00.000Z";
const LATER = "2026-07-11T00:01:00.000Z";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function root(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "recurs-registry-"));
  directories.push(directory);
  return directory;
}

function local(
  overrides: Partial<LocalConnectionRecord> = {},
): LocalConnectionRecord {
  return {
    kind: "local_openai_compatible",
    id: "local-generic",
    providerId: "local-openai-compatible",
    adapterId: "openai-chat-completions",
    label: "Local model",
    baseUrl: "http://127.0.0.1:11434/v1",
    modelId: "qwen-coder",
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function delegated(
  overrides: Partial<DelegatedConnectionRecord> = {},
): DelegatedConnectionRecord {
  return {
    kind: "delegated_agent",
    id: "codex-chatgpt",
    providerId: "openai-codex-chatgpt",
    adapterId: "codex-acp",
    label: "Codex",
    accountLabel: "Personal ChatGPT account",
    organizationLabel: null,
    modelId: "gpt-5-codex",
    accountSubjectFingerprint: "a".repeat(64),
    policyRevision: "openai-codex-chatgpt-2026-07-11",
    billingPolicy: {
      revision: "billing:openai-codex-chatgpt:2026-07-11",
      disclosureRevision:
        "billing-disclosure:openai-codex-chatgpt:2026-07-11",
      primarySource: "included_subscription",
      possibleAdditionalSources: ["prepaid_credits"],
      providerFallback: "automatic",
      availableSelections: ["allow_declared_additional"],
    },
    billingSelection: {
      mode: "allow_declared_additional",
      policyRevision: "billing:openai-codex-chatgpt:2026-07-11",
      disclosureRevision:
        "billing-disclosure:openai-codex-chatgpt:2026-07-11",
      allowedSources: ["included_subscription", "prepaid_credits"],
      acknowledgedAt: AT,
    },
    verifiedAt: AT,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

async function writePrivate(filename: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  await writeFile(filename, contents, { mode: 0o600 });
  await chmod(filename, 0o600);
}

async function seedLegacy(
  directory: string,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const value = {
    schemaVersion: 1,
    kind: "local_openai_compatible",
    id: "legacy-local",
    label: "Compatible local endpoint",
    baseUrl: "http://127.0.0.1:8080/v1",
    modelId: "legacy-model",
    createdAt: AT,
    updatedAt: LATER,
    ...overrides,
  };
  await writePrivate(
    legacyLocalConnectionPath(directory),
    `${JSON.stringify(value)}\n`,
  );
  return value;
}

describe("FileConnectionRegistry", () => {
  it("reads an absent registry as an immutable revision-zero document", async () => {
    const registry = new FileConnectionRegistry(await root());

    const first = await registry.read();
    expect(first).toEqual({
      schemaVersion: 1,
      revision: 0,
      primaryConnectionId: null,
      connections: [],
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.connections)).toBe(true);
    expect(await registry.read()).not.toBe(first);
  });

  it("commits an exact CAS revision and owns the next revision", async () => {
    const directory = await root();
    const registry = new FileConnectionRegistry(directory);

    const saved = await registry.commit(0, (draft) => {
      draft.schemaVersion = 999 as never;
      draft.revision = 999;
      draft.connections.push(local());
      draft.primaryConnectionId = "local-generic";
    });

    expect(saved).toEqual({
      schemaVersion: 1,
      revision: 1,
      primaryConnectionId: "local-generic",
      connections: [local()],
    });
    expect((await lstat(connectionRegistryPath(directory))).mode & 0o777).toBe(
      0o600,
    );
    await expect(registry.commit(0, () => undefined)).rejects.toMatchObject({
      code: "revision_conflict",
      message: "Connection registry revision changed",
    });
  });

  it("serializes two instances racing the same revision", async () => {
    const directory = await root();
    const first = new FileConnectionRegistry(directory);
    const second = new FileConnectionRegistry(directory);
    let releaseFirst: (() => void) | undefined;
    const firstEntered = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let allowFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      allowFirst = resolve;
    });

    const one = first.commit(0, async (draft) => {
      firstEntered.then(() => undefined).catch(() => undefined);
      releaseFirst?.();
      await firstBlocked;
      draft.connections.push(local({ id: "first" }));
      draft.primaryConnectionId = "first";
    });
    await firstEntered;
    const two = second.commit(0, (draft) => {
      draft.connections.push(local({ id: "second" }));
      draft.primaryConnectionId = "second";
    });
    allowFirst?.();

    const results = await Promise.allSettled([one, two]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "revision_conflict" },
    });
    const final = await first.read();
    expect(final.revision).toBe(1);
    expect(final.connections).toHaveLength(1);
  });

  it("rejects malformed variants, duplicate ids, and an invalid primary", async () => {
    const directory = await root();
    const filename = connectionRegistryPath(directory);
    const invalidDocuments: unknown[] = [
      {
        schemaVersion: 1,
        revision: 0,
        primaryConnectionId: null,
        connections: [],
        unexpected: true,
      },
      {
        schemaVersion: 1,
        revision: 1,
        primaryConnectionId: "missing",
        connections: [local()],
      },
      {
        schemaVersion: 1,
        revision: 1,
        primaryConnectionId: "local-generic",
        connections: [local(), local()],
      },
      {
        schemaVersion: 1,
        revision: 1,
        primaryConnectionId: "local-generic",
        connections: [{ ...local(), headers: { authorization: "redacted" } }],
      },
      {
        schemaVersion: 1,
        revision: Number.MAX_SAFE_INTEGER,
        primaryConnectionId: null,
        connections: [],
      },
    ];

    for (const value of invalidDocuments) {
      await writePrivate(filename, `${JSON.stringify(value)}\n`);
      await expect(new FileConnectionRegistry(directory).read()).rejects.toMatchObject({
        code: "registry_invalid",
        message: "Connection registry is invalid",
      });
    }
  });

  it("rejects duplicate JSON members and malformed UTF-8", async () => {
    const directory = await root();
    const filename = connectionRegistryPath(directory);
    await writePrivate(
      filename,
      '{"schemaVersion":1,"revision":0,"revision":1,"primaryConnectionId":null,"connections":[]}\n',
    );
    await expect(new FileConnectionRegistry(directory).read()).rejects.toMatchObject({
      code: "registry_invalid",
    });

    await writeFile(filename, Buffer.from([0xff, 0xfe, 0xfd]), { mode: 0o600 });
    await chmod(filename, 0o600);
    await expect(new FileConnectionRegistry(directory).read()).rejects.toMatchObject({
      code: "registry_invalid",
    });

    await writePrivate(
      filename,
      '{"schemaVersion":1,"revision":0,"primaryConnectionId":null,"connections":[]}\u00a0',
    );
    await expect(new FileConnectionRegistry(directory).read()).rejects.toMatchObject({
      code: "registry_invalid",
    });
  });

  it("rejects secret-shaped keys and high-confidence secret values without echoing them", async () => {
    const directory = await root();
    const filename = connectionRegistryPath(directory);
    const canary = `sk-proj-${"A".repeat(48)}`;
    await writePrivate(
      filename,
      `${JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        primaryConnectionId: "local-generic",
        connections: [{ ...local(), label: canary }],
      })}\n`,
    );

    let caught: unknown;
    try {
      await new FileConnectionRegistry(directory).read();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConnectionRegistryError);
    expect((caught as Error).message).toBe("Connection registry is invalid");
    expect(JSON.stringify(caught)).not.toContain(canary);
  });

  it("rejects oversized, permission-unsafe, symlinked, and non-file documents", async () => {
    const directory = await root();
    const filename = connectionRegistryPath(directory);
    await writePrivate(filename, "x".repeat(256 * 1024 + 1));
    await expect(new FileConnectionRegistry(directory).read()).rejects.toMatchObject({
      code: "registry_invalid",
    });

    await writePrivate(
      filename,
      '{"schemaVersion":1,"revision":0,"primaryConnectionId":null,"connections":[]}\n',
    );
    await chmod(filename, 0o644);
    await expect(new FileConnectionRegistry(directory).read()).rejects.toMatchObject({
      code: "storage_unsafe",
    });

    const external = path.join(directory, "external.json");
    await writePrivate(
      external,
      '{"schemaVersion":1,"revision":0,"primaryConnectionId":null,"connections":[]}\n',
    );
    await rm(filename, { force: true });
    await symlink(external, filename);
    await expect(new FileConnectionRegistry(directory).read()).rejects.toMatchObject({
      code: "storage_unsafe",
    });
    expect(await readFile(external, "utf8")).toContain('"revision":0');

    await rm(filename, { force: true });
    await mkdir(filename);
    await expect(new FileConnectionRegistry(directory).read()).rejects.toMatchObject({
      code: "storage_unsafe",
    });
  });

  it("rejects a symlinked config directory without touching its target", async () => {
    const directory = await root();
    const target = path.join(directory, "outside");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, path.join(directory, "config"));

    await expect(
      new FileConnectionRegistry(directory).commit(0, () => undefined),
    ).rejects.toMatchObject({ code: "storage_unsafe" });
    expect(await readFile(path.join(target, "connections.json"), "utf8").catch(() => null)).toBeNull();
  });

  it("leaves a complete old or new document across injected replace failures", async () => {
    const beforeRoot = await root();
    const before = new FileConnectionRegistry(beforeRoot, {
      async faultInjector(point) {
        if (point === "before_rename") throw new Error("injected");
      },
    });
    await expect(
      before.commit(0, (draft) => {
        draft.connections.push(local());
        draft.primaryConnectionId = "local-generic";
      }),
    ).rejects.toThrow("injected");
    expect(await new FileConnectionRegistry(beforeRoot).read()).toMatchObject({
      revision: 0,
      connections: [],
    });

    const afterRoot = await root();
    const after = new FileConnectionRegistry(afterRoot, {
      async faultInjector(point) {
        if (point === "after_rename") throw new Error("injected");
      },
    });
    await expect(
      after.commit(0, (draft) => {
        draft.connections.push(local());
        draft.primaryConnectionId = "local-generic";
      }),
    ).rejects.toThrow("injected");
    expect(await new FileConnectionRegistry(afterRoot).read()).toMatchObject({
      revision: 1,
      primaryConnectionId: "local-generic",
      connections: [local()],
    });
  });

  it("returns defensive connection copies", async () => {
    const registry = new FileConnectionRegistry(await root());
    const saved = await registry.commit(0, (draft) => {
      draft.connections.push(delegated());
      draft.primaryConnectionId = "codex-chatgpt";
    });

    expect(Object.isFrozen(saved.connections[0])).toBe(true);
    const copy = structuredClone(saved) as {
      connections: Array<{ label: string }>;
    };
    copy.connections[0]!.label = "Changed";
    expect((await registry.read()).connections[0]?.label).toBe("Codex");
  });

  it("breaks only a proven-dead stale lock and never a live stale lock", async () => {
    const directory = await root();
    const lock = path.join(directory, "config", ".connections.lock");
    const staleAt = new Date(Date.now() - 60_000);
    await writePrivate(lock, `${JSON.stringify({
      version: 1,
      pid: 999_999_999,
      token: randomUUID(),
      createdAt: staleAt.getTime(),
    })}\n`);
    await utimes(lock, staleAt, staleAt);
    const recovered = new FileConnectionRegistry(directory, {
      staleLockMs: 1,
      lockTimeoutMs: 100,
    });
    await expect(recovered.commit(0, () => undefined)).resolves.toMatchObject({
      revision: 1,
    });

    const liveClaim = path.join(directory, "config", ".live-lock-claim");
    await writePrivate(liveClaim, `${JSON.stringify({
      version: 1,
      pid: process.pid,
      token: randomUUID(),
      createdAt: staleAt.getTime(),
    })}\n`);
    await link(liveClaim, lock);
    await utimes(lock, staleAt, staleAt);
    const live = new FileConnectionRegistry(directory, {
      staleLockMs: 1,
      lockTimeoutMs: 25,
    });
    await expect(live.commit(1, () => undefined)).rejects.toMatchObject({
      code: "lock_timeout",
    });
    expect(await lstat(lock)).toBeDefined();
  });

  it("aborts a bounded lock wait without disturbing the owner", async () => {
    const directory = await root();
    const lock = path.join(directory, "config", ".connections.lock");
    await writePrivate(lock, `${JSON.stringify({
      version: 1,
      pid: process.pid,
      token: randomUUID(),
      createdAt: Date.now(),
    })}\n`);
    const controller = new AbortController();
    controller.abort();

    await expect(
      new FileConnectionRegistry(directory, { lockTimeoutMs: 1_000 }).commit(
        0,
        () => undefined,
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: "lock_timeout" });
    expect(await lstat(lock)).toBeDefined();
  });
});

describe("legacy local migration", () => {
  it("preserves legacy identity, label, endpoint, model, and timestamps", async () => {
    const directory = await root();
    const legacy = await seedLegacy(directory);
    const registry = new FileConnectionRegistry(directory);

    const migrated = await registry.migrateLegacyLocal();

    expect(migrated).toMatchObject({
      revision: 1,
      primaryConnectionId: legacy.id,
      connections: [
        {
          kind: "local_openai_compatible",
          id: legacy.id,
          providerId: "local-openai-compatible",
          adapterId: "openai-chat-completions",
          label: legacy.label,
          baseUrl: legacy.baseUrl,
          modelId: legacy.modelId,
          createdAt: legacy.createdAt,
          updatedAt: legacy.updatedAt,
        },
      ],
    });
    expect(await readFile(legacyLocalConnectionPath(directory), "utf8").catch(() => null)).toBeNull();
    expect(await registry.migrateLegacyLocal()).toEqual(migrated);
  });

  it("preserves an existing primary while adding the legacy local record", async () => {
    const directory = await root();
    const registry = new FileConnectionRegistry(directory);
    await registry.commit(0, (draft) => {
      draft.connections.push(delegated());
      draft.primaryConnectionId = "codex-chatgpt";
    });
    await seedLegacy(directory);

    const migrated = await registry.migrateLegacyLocal();

    expect(migrated.revision).toBe(2);
    expect(migrated.primaryConnectionId).toBe("codex-chatgpt");
    expect(migrated.connections.map((entry) => entry.id)).toEqual([
      "codex-chatgpt",
      "legacy-local",
    ]);
  });

  it("is idempotent when two instances migrate concurrently", async () => {
    const directory = await root();
    await seedLegacy(directory);

    const results = await Promise.all([
      new FileConnectionRegistry(directory).migrateLegacyLocal(),
      new FileConnectionRegistry(directory).migrateLegacyLocal(),
    ]);

    expect(results[0]).toEqual(results[1]);
    expect(results[0]?.revision).toBe(1);
    expect(results[0]?.connections).toHaveLength(1);
  });

  it("rejects a same-id content collision and retains the valid legacy file", async () => {
    const directory = await root();
    const registry = new FileConnectionRegistry(directory);
    await registry.commit(0, (draft) => {
      draft.connections.push(local({ id: "legacy-local", modelId: "different" }));
      draft.primaryConnectionId = "legacy-local";
    });
    await seedLegacy(directory);

    await expect(registry.migrateLegacyLocal()).rejects.toMatchObject({
      code: "migration_conflict",
      message: "Legacy local connection conflicts with the registry",
    });
    expect(await readFile(legacyLocalConnectionPath(directory), "utf8")).toContain(
      "legacy-model",
    );
    expect((await registry.read()).connections[0]).toMatchObject({
      modelId: "different",
    });
  });

  it("rejects secret-bearing legacy data without deleting it", async () => {
    const directory = await root();
    const canary = `ghp_${"A".repeat(40)}`;
    await seedLegacy(directory, { label: canary });

    await expect(
      new FileConnectionRegistry(directory).migrateLegacyLocal(),
    ).rejects.toMatchObject({ code: "registry_invalid" });
    expect(await readFile(legacyLocalConnectionPath(directory), "utf8")).toContain(
      canary,
    );
  });
});
