import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { SessionStoreError } from "./session-store-error.js";

export interface AcquiredSessionLock {
  fencingToken: number;
  release(): Promise<void>;
}

interface LockOwner {
  owner: string;
  pid: number;
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : null;
}

function parseOwner(serialized: string): LockOwner | null {
  try {
    const value: unknown = JSON.parse(serialized);
    if (
      typeof value === "object" &&
      value !== null &&
      "owner" in value &&
      typeof value.owner === "string" &&
      "pid" in value &&
      Number.isSafeInteger(value.pid) &&
      (value.pid as number) > 0
    ) {
      return { owner: value.owner, pid: value.pid as number };
    }
  } catch {
    // Invalid owner data is treated as busy rather than reclaimed unsafely.
  }
  return null;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

async function reclaimDeadOwner(lock: string): Promise<boolean> {
  let owner: LockOwner | null;
  try {
    owner = parseOwner(await readFile(path.join(lock, "owner"), "utf8"));
  } catch {
    return false;
  }
  if (owner === null || processIsAlive(owner.pid)) {
    return false;
  }
  const stale = `${lock}.stale.${randomUUID()}`;
  try {
    await rename(lock, stale);
  } catch (error) {
    return errorCode(error) === "ENOENT";
  }
  await rm(stale, { recursive: true, force: true });
  return true;
}

async function nextFence(root: string, sessionId: string): Promise<number> {
  const fences = path.join(root, ".fences");
  await mkdir(fences, { recursive: true, mode: 0o700 });
  const file = path.join(fences, `${sessionId}.fence`);
  let current = 0;
  try {
    const raw = await readFile(file, "utf8");
    current = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(current) || current < 0) {
      throw new SessionStoreError(
        "corrupt_log",
        `Invalid mutation fence for session ${sessionId}`,
      );
    }
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }
  const next = current + 1;
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${next}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
  return next;
}

export async function acquireSessionLock(
  root: string,
  sessionId: string,
): Promise<AcquiredSessionLock> {
  const locks = path.join(root, ".locks");
  await mkdir(locks, { recursive: true, mode: 0o700 });
  const lock = path.join(locks, `${sessionId}.lock`);
  const owner = randomUUID();
  const ownerRecord: LockOwner = { owner, pid: process.pid };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const candidate = path.join(locks, `.${sessionId}.${owner}.candidate`);
    await mkdir(candidate, { mode: 0o700 });
    try {
      await writeFile(
        path.join(candidate, "owner"),
        `${JSON.stringify(ownerRecord)}\n`,
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
      await rename(candidate, lock);
    } catch (error) {
      await rm(candidate, { recursive: true, force: true });
      const code = errorCode(error);
      if (code !== "EEXIST" && code !== "ENOTEMPTY") {
        throw error;
      }
      if (attempt === 0 && await reclaimDeadOwner(lock)) {
        continue;
      }
      throw new SessionStoreError(
        "session_busy",
        `Session ${sessionId} already has an active mutation`,
      );
    }
    try {
      const fencingToken = await nextFence(root, sessionId);
      return {
        fencingToken,
        async release() {
          let observed: LockOwner | null;
          try {
            observed = parseOwner(
              await readFile(path.join(lock, "owner"), "utf8"),
            );
          } catch {
            return;
          }
          if (observed?.owner === owner) {
            await rm(lock, { recursive: true, force: true });
          }
        },
      };
    } catch (error) {
      await rm(lock, { recursive: true, force: true });
      throw error;
    }
  }
  throw new SessionStoreError(
    "session_busy",
    `Session ${sessionId} already has an active mutation`,
  );
}
