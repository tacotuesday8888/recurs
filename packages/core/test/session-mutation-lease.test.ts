import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import { acquireSessionLock } from "../src/session-mutation-lease.js";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "recurs-session-lock-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

it("exposes a stable safe owner identity and verifies ownership", async () => {
  const directory = await temporaryDirectory();
  const lock = await acquireSessionLock(directory, "session-1");
  const ownerId = lock.ownerId;

  expect(ownerId).toMatch(/^[a-f0-9-]{36}$/u);
  expect(lock.fencingToken).toBeGreaterThan(0);
  await expect(lock.assertOwned()).resolves.toBeUndefined();
  expect(lock.ownerId).toBe(ownerId);

  await lock.release();
  await expect(lock.assertOwned()).rejects.toMatchObject({
    code: "session_busy",
  });
});

it("detects replacement instead of releasing another owner lock", async () => {
  const directory = await temporaryDirectory();
  const lock = await acquireSessionLock(directory, "session-1");
  const ownerFile = path.join(
    directory,
    ".locks",
    "session-1.lock",
    "owner",
  );
  await rm(path.dirname(ownerFile), { recursive: true, force: true });
  await mkdir(path.dirname(ownerFile), { recursive: true, mode: 0o700 });
  await writeFile(
    ownerFile,
    `${JSON.stringify({ owner: "replacement", pid: process.pid })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  await expect(lock.assertOwned()).rejects.toMatchObject({
    code: "session_busy",
  });
  await lock.release();
  await expect(acquireSessionLock(directory, "session-1")).rejects.toMatchObject({
    code: "session_busy",
  });
});

it("refuses to issue a fencing token outside the safe integer range", async () => {
  const directory = await temporaryDirectory();
  const fences = path.join(directory, ".fences");
  await mkdir(fences, { mode: 0o700 });
  await writeFile(
    path.join(fences, "session-1.fence"),
    `${Number.MAX_SAFE_INTEGER}\n`,
    { encoding: "utf8", mode: 0o600 },
  );

  await expect(acquireSessionLock(directory, "session-1")).rejects.toMatchObject({
    code: "corrupt_log",
  });
});
