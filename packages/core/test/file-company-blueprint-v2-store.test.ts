import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { companyBlueprintV2Fixture } from "../../contracts/test/company-v2-fixture.js";
import { FileCompanyBlueprintV2Store } from "../src/index.js";

const roots: string[] = [];

async function fixture() {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "recurs-company-v2-")),
  );
  roots.push(root);
  const directory = path.join(root, "blueprints");
  return { directory, store: new FileCompanyBlueprintV2Store(directory) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("FileCompanyBlueprintV2Store", () => {
  it("publishes one immutable proposal idempotently", async () => {
    const setup = await fixture();
    const blueprint = companyBlueprintV2Fixture({ state: "proposed" });

    await Promise.all([
      setup.store.create(blueprint),
      new FileCompanyBlueprintV2Store(setup.directory).create(blueprint),
    ]);

    await expect(setup.store.load(blueprint.id)).resolves.toEqual(blueprint);
    await expect(setup.store.list()).resolves.toEqual([blueprint]);
  });

  it("fails closed when an immutable blueprint id is reused", async () => {
    const setup = await fixture();
    const blueprint = companyBlueprintV2Fixture({ state: "proposed" });
    await setup.store.create(blueprint);

    const conflicting = {
      ...blueprint,
      project: { ...blueprint.project, purpose: "A conflicting purpose." },
    };
    await expect(setup.store.create(conflicting))
      .rejects.toMatchObject({ code: "conflict" });
    await expect(setup.store.load(blueprint.id)).resolves.toEqual(blueprint);
  });
});
