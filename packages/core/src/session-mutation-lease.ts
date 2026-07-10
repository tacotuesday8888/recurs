import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { SessionStoreError } from "./session-store-error.js";

export interface AcquiredSessionLock {
  fencingToken: number;
  release(): Promise<void>;
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
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      throw new SessionStoreError(
        "session_busy",
        `Session ${sessionId} already has an active mutation`,
      );
    }
    throw error;
  }
  try {
    await writeFile(path.join(lock, "owner"), `${owner}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    const fencingToken = await nextFence(root, sessionId);
    return {
      fencingToken,
      async release() {
        let observed: string;
        try {
          observed = (await readFile(path.join(lock, "owner"), "utf8")).trim();
        } catch {
          return;
        }
        if (observed === owner) {
          await rm(lock, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await rm(lock, { recursive: true, force: true });
    throw error;
  }
}
