import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { acquireSessionLock } from "../src/session-mutation-lease.js";
import {
  TeamRunOwnerLeaseManager,
} from "../src/team-run-owner-lease.js";

const directories: string[] = [];

async function fixture(): Promise<{
  readonly root: string;
  readonly manager: TeamRunOwnerLeaseManager;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "recurs-team-owner-"));
  directories.push(root);
  return {
    root,
    manager: new TeamRunOwnerLeaseManager({ rootDirectory: root }),
  };
}

function acquired<T extends { readonly status: string }>(
  result: T,
): asserts result is T & { readonly status: "acquired" } {
  expect(result.status).toBe("acquired");
}

async function writeDeadLock(root: string, id: string): Promise<void> {
  const lock = path.join(root, ".locks", `${id}.lock`);
  await mkdir(lock, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(lock, "owner"),
    `${JSON.stringify({ owner: "crashed", pid: 2_147_483_647 })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("TeamRunOwnerLeaseManager", () => {
  it("holds parent admission and per-run leases with stable fencing", async () => {
    const { manager } = await fixture();
    const first = await manager.tryAcquire("run-1", "parent-1");
    acquired(first);

    expect(first.lease.ownerId).toMatch(/^[a-f0-9-]{36}$/u);
    expect(first.lease.fencingToken).toBeGreaterThan(0);
    await expect(first.lease.assertOwned()).resolves.toBeUndefined();

    await expect(manager.tryAcquire("run-2", "parent-1")).resolves.toEqual({
      status: "busy",
    });
    await expect(manager.tryAcquire("run-1", "parent-2")).resolves.toEqual({
      status: "busy",
    });

    const independent = await manager.tryAcquire("run-2", "parent-2");
    acquired(independent);
    await independent.lease.release();

    await Promise.all([first.lease.release(), first.lease.release()]);
    await expect(first.lease.assertOwned()).rejects.toMatchObject({
      code: "session_busy",
    });

    const next = await manager.tryAcquire("run-1", "parent-1");
    acquired(next);
    expect(next.lease.fencingToken).toBeGreaterThan(first.lease.fencingToken);
    expect(next.lease.ownerId).not.toBe(first.lease.ownerId);
    await next.lease.release();
  });

  it("reclaims dead owners in both lock namespaces", async () => {
    const { root, manager } = await fixture();
    const leases = path.join(root, ".team-run-owner-leases");
    await writeDeadLock(path.join(leases, "parents"), "parent-1");
    await writeDeadLock(path.join(leases, "runs"), "run-1");

    const result = await manager.tryAcquire("run-1", "parent-1");
    acquired(result);
    await expect(result.lease.assertOwned()).resolves.toBeUndefined();
    await result.lease.release();
  });

  it("keeps owner leases separate from journal append locks", async () => {
    const { root, manager } = await fixture();
    const journal = await acquireSessionLock(root, "run-1");

    const result = await manager.tryAcquire("run-1", "parent-1");
    acquired(result);
    await expect(result.lease.assertOwned()).resolves.toBeUndefined();

    await result.lease.release();
    await journal.release();
  });

  it("asserts both parent admission and per-run ownership", async () => {
    const { root, manager } = await fixture();
    const result = await manager.tryAcquire("run-1", "parent-1");
    acquired(result);
    await rm(path.join(
      root,
      ".team-run-owner-leases",
      "parents",
      ".locks",
      "parent-1.lock",
    ), { recursive: true, force: true });

    await expect(result.lease.assertOwned()).rejects.toMatchObject({
      code: "session_busy",
    });
    await result.lease.release();
  });

  it("refuses owner storage that is not private", async () => {
    const { root, manager } = await fixture();
    const directory = path.join(root, ".team-run-owner-leases");
    await mkdir(directory, { mode: 0o700 });
    await chmod(directory, 0o755);

    await expect(manager.tryAcquire("run-1", "parent-1")).rejects.toMatchObject({
      code: "corrupt_log",
    });
  });

  it("rejects unsafe identifiers before creating owner storage", async () => {
    const { root, manager } = await fixture();

    await expect(manager.tryAcquire("../run", "parent-1")).rejects.toMatchObject({
      code: "invalid_session_id",
    });
    await expect(manager.tryAcquire("run-1", "../parent")).rejects.toMatchObject({
      code: "invalid_session_id",
    });
    await expect(readdir(root)).resolves.toEqual([]);
  });
});
