import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CompanyCapabilityBindingSetV1 } from "@recurs/contracts";

import {
  CompanyStateStoreError,
  FileCompanyCapabilityStore,
} from "../src/index.js";

const roots: string[] = [];
const at = "2026-07-22T10:00:00.000Z";

async function directory(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "recurs-capabilities-")));
  roots.push(root);
  return path.join(root, "bindings");
}

function fixture(overrides: Partial<CompanyCapabilityBindingSetV1> = {}): CompanyCapabilityBindingSetV1 {
  return {
    companyId: "company-capability-store",
    version: 1,
    revision: 1,
    blueprintId: "blueprint-capability-store",
    blueprintRevision: 1,
    updatedAt: at,
    bindings: [{
      id: "binding-release-check",
      bundleId: "quality_v1",
      source: { type: "agent_skill", id: "release-check", scope: "user" },
      approvedAt: at,
    }],
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("FileCompanyCapabilityStore", () => {
  it("creates immutable revisions, loads latest, and treats exact replay as idempotent", async () => {
    const store = new FileCompanyCapabilityStore(await directory());
    const first = fixture();
    const second = fixture({
      revision: 2,
      updatedAt: "2026-07-22T10:01:00.000Z",
      bindings: [],
    });

    await store.create(first);
    await store.create(first);
    await store.create(second);

    await expect(store.load(first.companyId, 1)).resolves.toEqual(first);
    await expect(store.latest(first.companyId)).resolves.toEqual(second);
    await expect(store.list(first.companyId)).resolves.toEqual([first, second]);
  });

  it("fails closed on revision gaps, stale blueprint lineage, and ID reuse", async () => {
    const store = new FileCompanyCapabilityStore(await directory());
    await expect(store.create(fixture({ revision: 2 }))).rejects.toMatchObject({
      code: "sequence_conflict",
    });
    await store.create(fixture());
    await expect(store.create(fixture({
      revision: 2,
      blueprintId: "another-blueprint",
    }))).rejects.toMatchObject({ code: "conflict" });
    await expect(store.create(fixture({ bindings: [] }))).rejects.toMatchObject({
      code: "conflict",
    });

    await expect(store.create(fixture({
      revision: 2,
      blueprintId: "blueprint-capability-store-r3",
      blueprintRevision: 3,
      updatedAt: "2026-07-22T10:02:00.000Z",
    }))).resolves.toBeUndefined();
  });

  it("serializes same-instance and cross-instance publication races", async () => {
    const location = await directory();
    const first = new FileCompanyCapabilityStore(location);
    const second = new FileCompanyCapabilityStore(location);
    const value = fixture();

    await expect(Promise.all([
      first.create(value),
      first.create(value),
      second.create(value),
    ])).resolves.toEqual([undefined, undefined, undefined]);
    await expect(first.list(value.companyId)).resolves.toEqual([value]);
  });

  it("rejects corrupt, public, and symlinked state", async () => {
    const location = await directory();
    const store = new FileCompanyCapabilityStore(location);
    const value = fixture();
    await store.create(value);
    const record = (await readdir(location)).find((name) => name.endsWith(".json"))!;
    const recordPath = path.join(location, record);
    const original = await readFile(recordPath, "utf8");

    await writeFile(recordPath, `${original.trimEnd()}x\n`, "utf8");
    await expect(store.load(value.companyId, 1)).rejects.toBeInstanceOf(
      CompanyStateStoreError,
    );
    await writeFile(recordPath, original, { encoding: "utf8", mode: 0o600 });
    await chmod(recordPath, 0o644);
    await expect(store.load(value.companyId, 1)).rejects.toMatchObject({ code: "corrupt" });

    const aliasRoot = await realpath(await mkdtemp(path.join(tmpdir(), "recurs-capability-alias-")));
    roots.push(aliasRoot);
    const alias = path.join(aliasRoot, "bindings");
    await symlink(location, alias);
    await expect(new FileCompanyCapabilityStore(alias).list()).rejects.toMatchObject({
      code: "corrupt",
    });
  });
});
