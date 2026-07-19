import { createHash } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileGitPatchArtifactStore,
  type StoredGitPatchArtifact,
} from "../src/index.js";

const directories: string[] = [];
const revision = "a".repeat(40);

async function fixture(): Promise<{
  root: string;
  repository: string;
  directory: string;
  store: FileGitPatchArtifactStore;
}> {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "recurs-file-artifacts-")),
  );
  directories.push(root);
  const repository = path.join(root, "repository");
  await mkdir(repository, { mode: 0o700 });
  const directory = path.join(root, "artifacts");
  return {
    root,
    repository,
    directory,
    store: new FileGitPatchArtifactStore(directory),
  };
}

function artifact(
  repositoryRoot: string,
  id = "artifact-1",
  patch = [
    "diff --git a/edit.txt b/edit.txt",
    "index 1111111..2222222 100644",
    "--- a/edit.txt",
    "+++ b/edit.txt",
    "@@ -1 +1 @@",
    "-before",
    "+after",
    "",
  ].join("\n"),
): StoredGitPatchArtifact {
  return {
    handle: {
      id,
      leaseId: "lease-1",
      baseRevision: revision,
      sha256: createHash("sha256").update(patch).digest("hex"),
      byteLength: Buffer.byteLength(patch, "utf8"),
      paths: ["delete.txt", "edit.txt"],
    },
    repositoryRoot,
    patch,
    after: [
      { path: "delete.txt", kind: "deleted" },
      {
        path: "edit.txt",
        kind: "file",
        sha256: createHash("sha256").update("after\n").digest("hex"),
        byteLength: 6,
        mode: "100644",
      },
    ],
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("FileGitPatchArtifactStore", () => {
  it("publishes an immutable content object before an exact private ref", async () => {
    const setup = await fixture();
    const value = artifact(setup.repository);

    await setup.store.put(value);
    const loaded = await setup.store.load(value.handle);

    expect(loaded).toEqual(value);
    expect(Object.isFrozen(loaded)).toBe(true);
    const object = path.join(
      setup.directory,
      "objects",
      `${value.handle.sha256}.patch`,
    );
    const ref = path.join(setup.directory, "refs", `${value.handle.id}.json`);
    expect(await readFile(object, "utf8")).toBe(value.patch);
    expect(JSON.parse(await readFile(ref, "utf8"))).not.toHaveProperty("patch");
    expect((await lstat(setup.directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(path.dirname(object))).mode & 0o777).toBe(0o700);
    expect((await lstat(path.dirname(ref))).mode & 0o777).toBe(0o700);
    expect((await lstat(object)).mode & 0o777).toBe(0o600);
    expect((await lstat(ref)).mode & 0o777).toBe(0o600);
  });

  it("is idempotent for the same artifact and fails closed on ID reuse", async () => {
    const setup = await fixture();
    const value = artifact(setup.repository);

    await Promise.all([setup.store.put(value), setup.store.put(value)]);
    await expect(setup.store.put({
      ...artifact(setup.repository, value.handle.id, "different patch\n"),
    })).rejects.toMatchObject({ code: "permission_denied" });
    expect(await setup.store.load(value.handle)).toEqual(value);

    const later = artifact(setup.repository, "artifact-after-conflict");
    await expect(setup.store.put(later)).resolves.toBeUndefined();
    await expect(setup.store.load(later.handle)).resolves.toEqual(later);
  });

  it("snapshots caller-owned input before asynchronous publication", async () => {
    const setup = await fixture();
    const value = artifact(setup.repository);
    const original = structuredClone(value);

    const pending = setup.store.put(value);
    (value.handle as { id: string }).id = "mutated-id";
    (value.after[0] as { path: string }).path = "mutated.txt";
    await pending;

    await expect(setup.store.load(original.handle)).resolves.toEqual(original);
    await expect(access(path.join(setup.directory, "refs", "mutated-id.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("snapshots load handles and removal lists before asynchronous access", async () => {
    const setup = await fixture();
    const first = artifact(setup.repository, "first-artifact");
    const second = artifact(setup.repository, "second-artifact");
    await setup.store.put(first);
    await setup.store.put(second);

    const requested = structuredClone(first.handle);
    const loading = setup.store.load(requested);
    (requested as { id: string }).id = second.handle.id;
    await expect(loading).resolves.toEqual(first);

    const removals = [first.handle];
    const removing = setup.store.remove(removals);
    removals.splice(0, 1, second.handle);
    await removing;
    await expect(setup.store.load(first.handle))
      .rejects.toMatchObject({ code: "not_found" });
    await expect(setup.store.load(second.handle)).resolves.toEqual(second);
  });

  it("rejects refs that exceed the bounded metadata format before publication", async () => {
    const setup = await fixture();
    const value = artifact(setup.repository);
    const paths = Array.from({ length: 256 }, (_, index) =>
      `path-${index.toString().padStart(3, "0")}/${Array.from(
        { length: 7 },
        () => "x".repeat(200),
      ).join("/")}.txt`
    );
    const oversized: StoredGitPatchArtifact = {
      ...value,
      handle: { ...value.handle, paths },
      after: paths.map((file) => ({ path: file, kind: "deleted" as const })),
    };

    await expect(setup.store.put(oversized))
      .rejects.toMatchObject({ code: "permission_denied" });
    await expect(access(setup.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("detects object, ref, and requested-handle tampering", async () => {
    const objectTamper = await fixture();
    const first = artifact(objectTamper.repository);
    await objectTamper.store.put(first);
    await writeFile(path.join(
      objectTamper.directory,
      "objects",
      `${first.handle.sha256}.patch`,
    ), "tampered", { mode: 0o600 });
    await expect(objectTamper.store.load(first.handle))
      .rejects.toMatchObject({ code: "permission_denied" });

    const refTamper = await fixture();
    const second = artifact(refTamper.repository);
    await refTamper.store.put(second);
    await writeFile(path.join(
      refTamper.directory,
      "refs",
      `${second.handle.id}.json`,
    ), "{}\n", { mode: 0o600 });
    await expect(refTamper.store.load(second.handle))
      .rejects.toMatchObject({ code: "permission_denied" });

    const handleTamper = await fixture();
    const third = artifact(handleTamper.repository);
    await handleTamper.store.put(third);
    await expect(handleTamper.store.load({
      ...third.handle,
      byteLength: third.handle.byteLength + 1,
    })).rejects.toMatchObject({ code: "permission_denied" });

    const oversized = await fixture();
    const fourth = artifact(oversized.repository);
    await oversized.store.put(fourth);
    await truncate(path.join(
      oversized.directory,
      "objects",
      `${fourth.handle.sha256}.patch`,
    ), 2 * 1024 * 1024);
    await expect(oversized.store.load(fourth.handle))
      .rejects.toMatchObject({ code: "permission_denied" });
  });

  it("removes refs idempotently while retaining content-addressed objects", async () => {
    const setup = await fixture();
    const value = artifact(setup.repository);
    await setup.store.remove([value.handle]);
    await mkdir(setup.directory, { mode: 0o700 });
    await setup.store.remove([value.handle]);
    await setup.store.put(value);

    await setup.store.remove([value.handle]);
    await setup.store.remove([value.handle]);

    await expect(setup.store.load(value.handle))
      .rejects.toMatchObject({ code: "not_found" });
    await expect(lstat(path.join(
      setup.directory,
      "objects",
      `${value.handle.sha256}.patch`,
    ))).resolves.toMatchObject({});

    const orphan = await fixture();
    const orphaned = artifact(orphan.repository);
    await orphan.store.put(orphaned);
    await rm(path.join(
      orphan.directory,
      "objects",
      `${orphaned.handle.sha256}.patch`,
    ));
    await rm(orphan.repository, { recursive: true });
    await expect(orphan.store.remove([orphaned.handle])).resolves.toBeUndefined();
    await expect(orphan.store.load(orphaned.handle))
      .rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects unsafe paths, noncanonical repositories, symlinks, and permissions", async () => {
    const unsafe = await fixture();
    const credential = artifact(unsafe.repository);
    await expect(unsafe.store.put({
      ...credential,
      handle: { ...credential.handle, paths: [".env"] },
      after: [{ path: ".env", kind: "deleted" }],
    })).rejects.toMatchObject({ code: "permission_denied" });

    const alias = path.join(unsafe.root, "repository-alias");
    await symlink(unsafe.repository, alias);
    await expect(unsafe.store.put(artifact(alias, "alias-artifact")))
      .rejects.toMatchObject({ code: "permission_denied" });

    const nestedDirectory = path.join(unsafe.repository, ".recurs-artifacts");
    const nested = new FileGitPatchArtifactStore(nestedDirectory);
    await expect(nested.put(artifact(unsafe.repository, "nested-artifact")))
      .rejects.toMatchObject({ code: "permission_denied" });
    await expect(access(nestedDirectory)).rejects.toMatchObject({ code: "ENOENT" });

    const linked = await fixture();
    const target = path.join(linked.root, "target");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, linked.directory);
    await expect(linked.store.put(artifact(linked.repository)))
      .rejects.toMatchObject({ code: "permission_denied" });

    const permissive = await fixture();
    await mkdir(permissive.directory, { mode: 0o755 });
    await chmod(permissive.directory, 0o755);
    await expect(permissive.store.put(artifact(permissive.repository)))
      .rejects.toMatchObject({ code: "permission_denied" });
  });

  it("rejects a storage ancestor replaced by a symlink after publication", async () => {
    const setup = await fixture();
    const storageParent = path.join(setup.root, "storage-parent");
    await mkdir(storageParent, { mode: 0o700 });
    const directory = path.join(storageParent, "artifacts");
    const store = new FileGitPatchArtifactStore(directory);
    const value = artifact(setup.repository);
    await store.put(value);

    const movedParent = path.join(setup.root, "moved-storage-parent");
    await rename(storageParent, movedParent);
    await symlink(movedParent, storageParent);

    await expect(store.load(value.handle))
      .rejects.toMatchObject({ code: "permission_denied" });
    await expect(store.remove([value.handle]))
      .rejects.toMatchObject({ code: "permission_denied" });
  });
});
