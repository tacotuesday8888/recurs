import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import { ToolError } from "@recurs/tools";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_OWNER_BYTES = 4 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_NONCE = /^[a-f0-9-]{36}$/u;
const GIT_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface PrivateOwnerBinding {
  readonly leaseId: string;
  readonly repositoryRoot: string;
  readonly worktreeRoot: string;
  readonly revision: string;
}

interface OwnerRecord extends PrivateOwnerBinding {
  readonly version: 1;
  readonly nonce: string;
  readonly pid: number;
}

export interface PrivateOwnerLock {
  readonly binding: PrivateOwnerBinding;
  assertOwned(): Promise<void>;
  abandon(): Promise<void>;
  release(): Promise<void>;
}

export type PrivateOwnerReclaimResult =
  | { readonly status: "acquired"; readonly lock: PrivateOwnerLock }
  | { readonly status: "busy" | "missing" | "mismatch" };

function code(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error &&
      typeof error.code === "string"
    ? error.code
    : null;
}

function denied(message: string, cause?: unknown): never {
  throw new ToolError("permission_denied", message, { cause });
}

async function privateDirectory(
  directory: string,
  allowMissing: boolean,
): Promise<boolean> {
  let details;
  try {
    details = await lstat(directory);
  } catch (error) {
    if (allowMissing && code(error) === "ENOENT") return false;
    throw error;
  }
  if (!details.isDirectory() || details.isSymbolicLink() ||
    (details.mode & 0o777) !== DIRECTORY_MODE ||
    await realpath(directory) !== directory) {
    denied("Worktree owner storage must be a private canonical directory");
  }
  return true;
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!["EBADF", "EINVAL", "EISDIR", "EPERM"].includes(code(error) ?? "")) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

async function ownerRoot(root: string): Promise<string> {
  await privateDirectory(root, false);
  const owners = path.join(root, ".owners");
  if (!await privateDirectory(owners, true)) {
    try {
      await mkdir(owners, { mode: DIRECTORY_MODE });
    } catch (error) {
      if (code(error) !== "EEXIST") throw error;
    }
    await syncDirectory(root);
    await privateDirectory(owners, false);
  }
  return owners;
}

async function existingOwnerRoot(root: string): Promise<string | null> {
  await privateDirectory(root, false);
  const owners = path.join(root, ".owners");
  return await privateDirectory(owners, true) ? owners : null;
}

function exactBinding(value: unknown): value is PrivateOwnerBinding {
  return typeof value === "object" && value !== null &&
    "leaseId" in value && typeof value.leaseId === "string" &&
    SAFE_ID.test(value.leaseId) &&
    "repositoryRoot" in value && typeof value.repositoryRoot === "string" &&
    path.isAbsolute(value.repositoryRoot) &&
    path.resolve(value.repositoryRoot) === value.repositoryRoot &&
    "worktreeRoot" in value && typeof value.worktreeRoot === "string" &&
    path.isAbsolute(value.worktreeRoot) &&
    path.resolve(value.worktreeRoot) === value.worktreeRoot &&
    path.basename(value.worktreeRoot) === value.leaseId &&
    "revision" in value && typeof value.revision === "string" &&
    GIT_REVISION.test(value.revision);
}

function sameBinding(
  left: PrivateOwnerBinding,
  right: PrivateOwnerBinding,
): boolean {
  return left.leaseId === right.leaseId &&
    left.repositoryRoot === right.repositoryRoot &&
    left.worktreeRoot === right.worktreeRoot &&
    left.revision === right.revision;
}

function serializeOwner(record: OwnerRecord): string {
  const serialized = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_OWNER_BYTES) {
    denied("Worktree owner record exceeds its bounded format");
  }
  return serialized;
}

function exactOwner(value: unknown, leaseId: string): value is OwnerRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "leaseId,nonce,pid,repositoryRoot,revision,version,worktreeRoot") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.version === 1 && record.leaseId === leaseId && exactBinding(record) &&
    typeof record.nonce === "string" && SAFE_NONCE.test(record.nonce) &&
    typeof record.pid === "number" && Number.isSafeInteger(record.pid) &&
    record.pid > 0;
}

async function readOwner(lock: string, leaseId: string): Promise<OwnerRecord> {
  const owners = path.dirname(lock);
  await privateDirectory(path.dirname(owners), false);
  await privateDirectory(owners, false);
  await privateDirectory(lock, false);
  const entries = await readdir(lock);
  if (entries.length !== 1 || entries[0] !== "owner.json") {
    denied("Worktree owner lock has an invalid shape");
  }
  const file = path.join(lock, "owner.json");
  const details = await lstat(file);
  if (!details.isFile() || details.isSymbolicLink() ||
    (details.mode & 0o777) !== FILE_MODE ||
    !Number.isSafeInteger(details.size) || details.size <= 0 ||
    details.size > MAX_OWNER_BYTES) {
    denied("Worktree owner record is unsafe");
  }
  let handle;
  let bytes: Buffer;
  try {
    handle = await open(
      file,
      constants.O_RDONLY |
        (constants.O_NONBLOCK ?? 0) |
        (constants.O_NOFOLLOW ?? 0),
    );
    const opened = await handle.stat();
    if (!opened.isFile() || (opened.mode & 0o777) !== FILE_MODE ||
      opened.dev !== details.dev || opened.ino !== details.ino ||
      opened.size !== details.size) {
      denied("Worktree owner record changed while it was opened");
    }
    bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = await handle.read(
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      );
      if (read.bytesRead === 0) {
        denied("Worktree owner record changed while it was read");
      }
      offset += read.bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    if ((await handle.read(extra, 0, 1, offset)).bytesRead !== 0) {
      denied("Worktree owner record changed while it was read");
    }
    const after = await handle.stat();
    if (after.dev !== opened.dev || after.ino !== opened.ino ||
      after.size !== opened.size || after.mode !== opened.mode ||
      after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      denied("Worktree owner record changed while it was read");
    }
  } finally {
    await handle?.close();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes));
  } catch (error) {
    denied("Worktree owner record is invalid", error);
  }
  if (!exactOwner(parsed, leaseId)) {
    denied("Worktree owner record is invalid");
  }
  return parsed;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return code(error) !== "ESRCH";
  }
}

async function replaceOwner(
  owners: string,
  lock: string,
  observed: OwnerRecord,
  replacement: OwnerRecord,
  requireDead: boolean,
): Promise<boolean> {
  const candidate = path.join(
    owners,
    `.${observed.leaseId}.${replacement.nonce}.owner.tmp`,
  );
  let handle;
  try {
    handle = await open(candidate, "wx", FILE_MODE);
    await handle.writeFile(serializeOwner(replacement), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    const current = await readOwner(lock, observed.leaseId);
    if (!sameBinding(current, observed) ||
      current.nonce !== observed.nonce || current.pid !== observed.pid ||
      (requireDead && processIsAlive(current.pid))) {
      return false;
    }
    await rename(candidate, path.join(lock, "owner.json"));
    await syncDirectory(lock);
    const published = await readOwner(lock, replacement.leaseId);
    return sameBinding(published, replacement) &&
      published.nonce === replacement.nonce &&
      published.pid === replacement.pid;
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(candidate, { force: true });
  }
}

function acquiredLock(
  owners: string,
  lock: string,
  record: OwnerRecord,
  abandoned?: OwnerRecord,
): PrivateOwnerLock {
  let retired: string | null = null;
  let released = false;
  return {
    binding: Object.freeze({
      leaseId: record.leaseId,
      repositoryRoot: record.repositoryRoot,
      worktreeRoot: record.worktreeRoot,
      revision: record.revision,
    }),
    async assertOwned() {
      if (retired !== null || released) {
        denied("Worktree owner lock is no longer active");
      }
      const observed = await readOwner(lock, record.leaseId);
      if (!sameBinding(observed, record) ||
        observed.nonce !== record.nonce || observed.pid !== record.pid) {
        denied("Worktree owner lock is no longer owned by this process");
      }
    },
    async abandon() {
      if (released || retired !== null || abandoned === undefined) {
        denied("Worktree owner lock cannot be abandoned");
      }
      if (!await replaceOwner(owners, lock, record, abandoned, false)) {
        denied("Worktree owner lock changed before it could be abandoned");
      }
      released = true;
    },
    async release() {
      if (released) return;
      if (retired === null) {
        const observed = await readOwner(lock, record.leaseId);
        if (!sameBinding(observed, record) ||
          observed.nonce !== record.nonce || observed.pid !== record.pid) {
          denied("Worktree owner lock is no longer owned by this process");
        }
        retired = `${lock}.released.${record.nonce}`;
        await rename(lock, retired);
        await syncDirectory(owners);
      }
      await rm(retired, { recursive: true, force: true });
      await syncDirectory(owners);
      released = true;
    },
  };
}

async function publishOwner(
  owners: string,
  leaseId: string,
  record: OwnerRecord,
): Promise<boolean> {
  const candidate = path.join(
    owners,
    `.${leaseId}.${record.nonce}.candidate`,
  );
  const lock = path.join(owners, `${leaseId}.lock`);
  await mkdir(candidate, { mode: DIRECTORY_MODE });
  let published = false;
  let handle;
  try {
    handle = await open(path.join(candidate, "owner.json"), "wx", FILE_MODE);
    await handle.writeFile(serializeOwner(record), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await syncDirectory(candidate);
    try {
      await rename(candidate, lock);
      published = true;
      await syncDirectory(owners);
      return true;
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(code(error) ?? "")) throw error;
      return false;
    }
  } finally {
    await handle?.close().catch(() => undefined);
    if (!published) await rm(candidate, { recursive: true, force: true });
  }
}

export async function acquirePrivateOwnerLock(
  root: string,
  binding: PrivateOwnerBinding,
): Promise<PrivateOwnerLock | null> {
  if (!exactBinding(binding)) denied("Worktree owner binding is invalid");
  const stable = Object.freeze({ ...binding });
  const owners = await ownerRoot(root);
  const lock = path.join(owners, `${stable.leaseId}.lock`);
  const record: OwnerRecord = {
    version: 1,
    ...stable,
    nonce: randomUUID(),
    pid: process.pid,
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await publishOwner(owners, stable.leaseId, record)) {
      return acquiredLock(owners, lock, record);
    }
    try {
      await readOwner(lock, stable.leaseId);
      return null;
    } catch (error) {
      if (code(error) === "ENOENT") continue;
      throw error;
    }
  }
  return null;
}

export async function reclaimPrivateOwnerLock(
  root: string,
  expected: PrivateOwnerBinding,
): Promise<PrivateOwnerReclaimResult> {
  if (!exactBinding(expected)) {
    denied("Worktree owner binding is invalid");
  }
  const stable = Object.freeze({ ...expected });
  const owners = await existingOwnerRoot(root);
  if (owners === null) return { status: "missing" };
  const lock = path.join(owners, `${stable.leaseId}.lock`);
  let observed: OwnerRecord;
  try {
    observed = await readOwner(lock, stable.leaseId);
  } catch (error) {
    if (code(error) === "ENOENT") return { status: "missing" };
    throw error;
  }
  if (!sameBinding(observed, stable)) {
    return { status: "mismatch" };
  }
  if (processIsAlive(observed.pid)) return { status: "busy" };
  const replacement: OwnerRecord = {
    ...observed,
    nonce: randomUUID(),
    pid: process.pid,
  };
  if (!await replaceOwner(
    owners,
    lock,
    observed,
    replacement,
    true,
  )) {
    return { status: "busy" };
  }
  return {
    status: "acquired",
    lock: acquiredLock(owners, lock, replacement, observed),
  };
}
