import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  link,
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
const MAX_CLAIM_DEPTH = 32;
const CLAIMS_DIRECTORY = ".claims";
const CLAIM_FILE = "claim.json";
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

interface OwnerClaimRecord extends PrivateOwnerBinding {
  readonly version: 1;
  readonly ownerNonce: string;
  readonly nonce: string;
  readonly pid: number;
  readonly released: boolean;
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

class PrivateRecordChangedError extends ToolError {
  constructor(message: string) {
    super("permission_denied", message);
  }
}

function changed(message: string): never {
  throw new PrivateRecordChangedError(message);
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

function sameOwner(left: OwnerRecord, right: OwnerRecord): boolean {
  return sameBinding(left, right) &&
    left.nonce === right.nonce && left.pid === right.pid;
}

function serializeRecord(record: OwnerRecord | OwnerClaimRecord): string {
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

function exactOwnerClaim(
  value: unknown,
  observed: OwnerRecord,
): value is OwnerClaimRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "leaseId,nonce,ownerNonce,pid,released,repositoryRoot,revision,version,worktreeRoot") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.version === 1 && exactBinding(record) &&
    sameBinding(record, observed) && record.ownerNonce === observed.nonce &&
    typeof record.nonce === "string" && SAFE_NONCE.test(record.nonce) &&
    typeof record.pid === "number" && Number.isSafeInteger(record.pid) &&
    record.pid > 0 && typeof record.released === "boolean";
}

async function readPrivateRecord(file: string): Promise<unknown> {
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
      changed("Worktree owner record changed while it was opened");
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
        changed("Worktree owner record changed while it was read");
      }
      offset += read.bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    if ((await handle.read(extra, 0, 1, offset)).bytesRead !== 0) {
      changed("Worktree owner record changed while it was read");
    }
    const after = await handle.stat();
    if (after.dev !== opened.dev || after.ino !== opened.ino ||
      after.size !== opened.size || after.mode !== opened.mode ||
      after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      changed("Worktree owner record changed while it was read");
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
  return parsed;
}

async function readOwnerFile(file: string, leaseId: string): Promise<OwnerRecord> {
  const parsed = await readPrivateRecord(file);
  if (!exactOwner(parsed, leaseId)) {
    denied("Worktree owner record is invalid");
  }
  return parsed;
}

async function readOwner(lock: string, leaseId: string): Promise<OwnerRecord> {
  const owners = path.dirname(lock);
  await privateDirectory(path.dirname(owners), false);
  await privateDirectory(owners, false);
  await privateDirectory(lock, false);
  const entries = (await readdir(lock)).sort();
  const hasClaims = entries.length === 2 &&
    entries[0] === CLAIMS_DIRECTORY && entries[1] === "owner.json";
  if ((entries.length !== 1 || entries[0] !== "owner.json") && !hasClaims) {
    denied("Worktree owner lock has an invalid shape");
  }
  if (hasClaims) {
    await privateDirectory(path.join(lock, CLAIMS_DIRECTORY), false);
  }
  return readOwnerFile(path.join(lock, "owner.json"), leaseId);
}

async function validateConcurrentOwnerTransition(
  lock: string,
  leaseId: string,
): Promise<void> {
  try {
    await readOwner(lock, leaseId);
  } catch (error) {
    if (code(error) === "ENOENT") return;
    throw error;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return code(error) !== "ESRCH";
  }
}

async function ensurePrivateChild(
  parent: string,
  name: string,
): Promise<string> {
  await privateDirectory(parent, false);
  const child = path.join(parent, name);
  let created = false;
  try {
    await mkdir(child, { mode: DIRECTORY_MODE });
    created = true;
  } catch (error) {
    if (code(error) !== "EEXIST") throw error;
  }
  if (created) await syncDirectory(parent);
  await privateDirectory(child, false);
  return child;
}

async function ownerClaimRoot(
  lock: string,
  observed: OwnerRecord,
): Promise<string | null> {
  try {
    await readOwner(lock, observed.leaseId);
    const claims = await ensurePrivateChild(lock, CLAIMS_DIRECTORY);
    return await ensurePrivateChild(claims, observed.nonce);
  } catch (error) {
    if (code(error) === "ENOENT") return null;
    throw error;
  }
}

async function readOwnerClaim(
  root: string,
  file: string,
  observed: OwnerRecord,
): Promise<OwnerClaimRecord> {
  const claims = path.dirname(root);
  const lock = path.dirname(claims);
  const owners = path.dirname(lock);
  await privateDirectory(path.dirname(owners), false);
  await privateDirectory(owners, false);
  await privateDirectory(lock, false);
  await privateDirectory(claims, false);
  await privateDirectory(root, false);
  const parsed = await readPrivateRecord(path.join(root, file));
  if (!exactOwnerClaim(parsed, observed)) {
    denied("Worktree owner claim is invalid");
  }
  return parsed;
}

async function publishOwnerClaim(
  root: string,
  file: string,
  claim: OwnerClaimRecord,
): Promise<boolean> {
  const candidate = path.join(root, `.candidate.${randomUUID()}.json`);
  const destination = path.join(root, file);
  let handle;
  let linked = false;
  let operationFailure: unknown;
  let postLinkFailure: unknown;
  try {
    handle = await open(candidate, "wx", FILE_MODE);
    await handle.writeFile(serializeRecord(claim), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(candidate, destination);
      linked = true;
    } catch (error) {
      if (!["EEXIST", "ENOENT"].includes(code(error) ?? "")) throw error;
    }
    if (linked) {
      try {
        await syncDirectory(root);
      } catch (error) {
        postLinkFailure = error;
      }
    }
  } catch (error) {
    operationFailure = error;
  } finally {
    await handle?.close().catch(() => undefined);
    try {
      await rm(candidate, { force: true });
    } catch (error) {
      if (linked) postLinkFailure ??= error;
      else operationFailure ??= error;
    }
  }
  if (operationFailure !== undefined) throw operationFailure;
  if (!linked) return false;
  if (postLinkFailure !== undefined &&
    !await ownerClaimWasPublished(root, file, claim)) {
    throw postLinkFailure;
  }
  return true;
}

function activeOwnerClaim(
  observed: OwnerRecord,
  claimant: OwnerRecord,
): OwnerClaimRecord {
  return {
    version: 1,
    leaseId: observed.leaseId,
    repositoryRoot: observed.repositoryRoot,
    worktreeRoot: observed.worktreeRoot,
    revision: observed.revision,
    ownerNonce: observed.nonce,
    nonce: claimant.nonce,
    pid: claimant.pid,
    released: false,
  };
}

function sameClaimant(
  claim: OwnerClaimRecord,
  claimant: OwnerRecord,
): boolean {
  return !claim.released && sameBinding(claim, claimant) &&
    claim.nonce === claimant.nonce && claim.pid === claimant.pid;
}

function sameOwnerClaim(
  left: OwnerClaimRecord,
  right: OwnerClaimRecord,
): boolean {
  return sameBinding(left, right) && left.ownerNonce === right.ownerNonce &&
    left.nonce === right.nonce && left.pid === right.pid &&
    left.released === right.released;
}

async function ownerClaimWasPublished(
  root: string,
  file: string,
  claim: OwnerClaimRecord,
): Promise<boolean> {
  const observed: OwnerRecord = {
    version: 1,
    leaseId: claim.leaseId,
    repositoryRoot: claim.repositoryRoot,
    worktreeRoot: claim.worktreeRoot,
    revision: claim.revision,
    nonce: claim.ownerNonce,
    pid: claim.pid,
  };
  try {
    return sameOwnerClaim(await readOwnerClaim(root, file, observed), claim);
  } catch (error) {
    if (code(error) === "ENOENT") return false;
    throw error;
  }
}

async function claimOwner(
  lock: string,
  observed: OwnerRecord,
  claimant: OwnerRecord,
): Promise<boolean> {
  const root = await ownerClaimRoot(lock, observed);
  if (root === null) return false;
  const claim = activeOwnerClaim(observed, claimant);
  let file = CLAIM_FILE;
  for (let depth = 0; depth < MAX_CLAIM_DEPTH; depth += 1) {
    let current: OwnerClaimRecord;
    try {
      current = await readOwnerClaim(root, file, observed);
    } catch (error) {
      if (code(error) !== "ENOENT") throw error;
      if (!await privateDirectory(root, true)) return false;
      if (await publishOwnerClaim(root, file, claim)) return true;
      continue;
    }
    const successor = `${current.nonce}.claim.json`;
    try {
      await readOwnerClaim(root, successor, observed);
      file = successor;
      continue;
    } catch (error) {
      if (code(error) !== "ENOENT") throw error;
      if (!await privateDirectory(root, true)) return false;
    }
    if (sameClaimant(current, claimant)) return true;
    if (!current.released && processIsAlive(current.pid)) return false;
    if (depth === MAX_CLAIM_DEPTH - 1) {
      denied("Worktree owner claim chain exceeds its bounded depth");
    }
    if (await publishOwnerClaim(root, successor, claim)) return true;
    file = successor;
  }
  denied("Worktree owner claim chain exceeds its bounded depth");
}

async function releaseOwnerClaim(
  lock: string,
  observed: OwnerRecord,
  claimant: OwnerRecord,
): Promise<boolean> {
  const root = await ownerClaimRoot(lock, observed);
  if (root === null) return false;
  let file = CLAIM_FILE;
  for (let depth = 0; depth < MAX_CLAIM_DEPTH; depth += 1) {
    let current: OwnerClaimRecord;
    try {
      current = await readOwnerClaim(root, file, observed);
    } catch (error) {
      if (code(error) === "ENOENT") return false;
      throw error;
    }
    const successor = `${current.nonce}.claim.json`;
    try {
      const next = await readOwnerClaim(root, successor, observed);
      if (sameClaimant(current, claimant) && next.released &&
        next.pid === claimant.pid) {
        return true;
      }
      file = successor;
      continue;
    } catch (error) {
      if (code(error) !== "ENOENT") throw error;
      if (!await privateDirectory(root, true)) return false;
    }
    if (!sameClaimant(current, claimant)) return false;
    const released: OwnerClaimRecord = {
      ...activeOwnerClaim(observed, {
        ...claimant,
        nonce: randomUUID(),
      }),
      released: true,
    };
    if (await publishOwnerClaim(root, successor, released)) return true;
    try {
      const next = await readOwnerClaim(root, successor, observed);
      return next.released && next.pid === released.pid &&
        next.nonce === released.nonce;
    } catch (error) {
      if (code(error) === "ENOENT") return false;
      throw error;
    }
  }
  denied("Worktree owner claim chain exceeds its bounded depth");
}

async function replaceClaimedOwner(
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
    await handle.writeFile(serializeRecord(replacement), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    const current = await readOwner(lock, observed.leaseId);
    if (!sameOwner(current, observed) ||
      (requireDead && processIsAlive(current.pid))) {
      return false;
    }
    await rename(candidate, path.join(lock, "owner.json"));
    await syncDirectory(lock);
    const published = await readOwner(lock, replacement.leaseId);
    return sameOwner(published, replacement);
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
  let mutating = false;
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
      if (!sameOwner(observed, record)) {
        denied("Worktree owner lock is no longer owned by this process");
      }
    },
    async abandon() {
      if (released || retired !== null || mutating || abandoned === undefined) {
        denied("Worktree owner lock cannot be abandoned");
      }
      mutating = true;
      let claimed = false;
      try {
        claimed = await claimOwner(lock, record, record);
        if (!claimed || !await releaseOwnerClaim(lock, abandoned, record) ||
          !await replaceClaimedOwner(owners, lock, record, abandoned, false)) {
          denied("Worktree owner lock changed before it could be abandoned");
        }
        released = true;
      } catch (error) {
        if (claimed && !released) {
          await releaseOwnerClaim(lock, record, record).catch(() => undefined);
        }
        throw error;
      } finally {
        mutating = false;
      }
    },
    async release() {
      if (released) return;
      if (mutating) {
        denied("Worktree owner lock is already being changed");
      }
      mutating = true;
      let claimed = false;
      try {
        if (retired === null) {
          claimed = await claimOwner(lock, record, record);
          if (!claimed) {
            denied("Worktree owner lock is no longer owned by this process");
          }
          const observed = await readOwner(lock, record.leaseId);
          if (!sameOwner(observed, record)) {
            denied("Worktree owner lock is no longer owned by this process");
          }
          const destination = `${lock}.released.${record.nonce}`;
          await rename(lock, destination);
          retired = destination;
          claimed = false;
          await syncDirectory(owners);
        }
        await rm(retired, { recursive: true, force: true });
        await syncDirectory(owners);
        released = true;
      } catch (error) {
        if (claimed && retired === null) {
          await releaseOwnerClaim(lock, record, record).catch(() => undefined);
        }
        throw error;
      } finally {
        mutating = false;
      }
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
    await handle.writeFile(serializeRecord(record), "utf8");
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
    if (error instanceof PrivateRecordChangedError) {
      await validateConcurrentOwnerTransition(lock, stable.leaseId);
      return { status: "busy" };
    }
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
  let claimed = false;
  try {
    claimed = await claimOwner(lock, observed, replacement);
    if (!claimed) return { status: "busy" };
    if (!await replaceClaimedOwner(owners, lock, observed, replacement, true)) {
      await releaseOwnerClaim(lock, observed, replacement).catch(() => false);
      return { status: "busy" };
    }
  } catch (error) {
    if (!(error instanceof PrivateRecordChangedError)) throw error;
    await validateConcurrentOwnerTransition(lock, stable.leaseId);
    if (claimed) {
      await releaseOwnerClaim(lock, observed, replacement).catch(() => false);
    }
    return { status: "busy" };
  }
  return {
    status: "acquired",
    lock: acquiredLock(owners, lock, replacement, observed),
  };
}
