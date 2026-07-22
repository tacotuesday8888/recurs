import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  approveCompanyBlueprint,
  compileCompanyBlueprint,
  CompanyBlueprintStoreError,
  FileCompanyBlueprintStore,
} from "../src/index.js";

const directories: string[] = [];

async function fixture(): Promise<{
  readonly root: string;
  readonly directory: string;
  readonly store: FileCompanyBlueprintStore;
}> {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "recurs-company-blueprints-")),
  );
  directories.push(root);
  const directory = path.join(root, "blueprints");
  return { root, directory, store: new FileCompanyBlueprintStore(directory) };
}

function blueprint(id = "company-1", purpose = "Ship a reliable CLI") {
  return approveCompanyBlueprint(compileCompanyBlueprint({
    id,
    createdAt: "2026-07-21T00:00:00.000Z",
    project: {
      type: "existing_project",
      stage: "active",
      purpose,
      constraints: ["Keep changes reviewable"],
      repository: { inspected: true, markers: [".git", "package.json"] },
    },
    developmentStyle: "layered_company",
    permissionMode: "approved_for_me",
    operatingModeId: "balanced_v5",
  }), "2026-07-21T00:01:00.000Z");
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("FileCompanyBlueprintStore", () => {
  it("atomically creates and loads a private immutable blueprint", async () => {
    const setup = await fixture();
    const value = blueprint();

    await setup.store.create(value);
    const loaded = await setup.store.load(value.id);

    expect(loaded).toEqual(value);
    expect(Object.isFrozen(loaded)).toBe(true);
    expect((await lstat(setup.directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(path.join(setup.directory, `${value.id}.json`))).mode & 0o777)
      .toBe(0o600);
    expect(JSON.parse(await readFile(
      path.join(setup.directory, `${value.id}.json`),
      "utf8",
    ))).toEqual(value);
  });

  it("is idempotent under concurrent creation and rejects ID reuse", async () => {
    const setup = await fixture();
    const value = blueprint();

    const stores = [
      setup.store,
      ...Array.from(
        { length: 15 },
        () => new FileCompanyBlueprintStore(setup.directory),
      ),
    ];
    await Promise.all(stores.map((store) => store.create(value)));
    await expect(setup.store.create(blueprint(value.id, "Different purpose")))
      .rejects.toMatchObject({ code: "blueprint_conflict" });
    await expect(setup.store.load(value.id)).resolves.toEqual(value);
  });

  it("lists bounded valid records in stable ID order", async () => {
    const setup = await fixture();
    await setup.store.create(blueprint("company-z"));
    await setup.store.create(blueprint("company-a"));

    await expect(setup.store.list()).resolves.toEqual([
      blueprint("company-a"),
      blueprint("company-z"),
    ]);
  });

  it("fails closed for unknown, malformed, oversized, and non-private records", async () => {
    const setup = await fixture();
    await expect(setup.store.load("missing"))
      .rejects.toMatchObject({ code: "blueprint_not_found" });
    await setup.store.create(blueprint());
    const file = path.join(setup.directory, "company-1.json");

    await writeFile(file, "{\"version\":1}\n", { mode: 0o600 });
    await expect(setup.store.load("company-1"))
      .rejects.toMatchObject({ code: "corrupt_blueprint" });

    await writeFile(file, Buffer.alloc(300_000, 0x61), { mode: 0o600 });
    await expect(setup.store.load("company-1"))
      .rejects.toMatchObject({ code: "corrupt_blueprint" });

    await writeFile(file, JSON.stringify(blueprint()), { mode: 0o600 });
    await chmod(file, 0o644);
    await expect(setup.store.load("company-1"))
      .rejects.toMatchObject({ code: "corrupt_blueprint" });
  });

  it("rejects unsafe IDs, symbolic links, and caller mutation", async () => {
    const setup = await fixture();
    await expect(setup.store.load("../escape"))
      .rejects.toMatchObject({ code: "invalid_blueprint_id" });

    const value = structuredClone(blueprint());
    const original = structuredClone(value);
    const creating = setup.store.create(value);
    (value.project as { purpose: string }).purpose = "mutated";
    await creating;
    await expect(setup.store.load(value.id)).resolves.toEqual(original);

    const linked = await fixture();
    await symlink(setup.directory, linked.directory);
    await expect(linked.store.list())
      .rejects.toMatchObject({ code: "corrupt_blueprint" });
  });

  it("honors cancellation before any storage mutation", async () => {
    const setup = await fixture();
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));

    await expect(setup.store.create(blueprint(), controller.signal))
      .rejects.toThrow("cancelled");
    await expect(lstat(setup.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("exposes stable domain errors", () => {
    expect(new CompanyBlueprintStoreError("blueprint_conflict", "conflict"))
      .toMatchObject({ name: "CompanyBlueprintStoreError", code: "blueprint_conflict" });
  });
});
