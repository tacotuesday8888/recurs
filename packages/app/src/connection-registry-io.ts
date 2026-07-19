import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";

import {
  MAX_CONNECTION_ACTIVATION_BYTES,
  emptyConnectionActivationDocument,
  parseConnectionActivationDocument,
  serializeConnectionActivationDocument,
  type ConnectionActivationDocument,
} from "./connection-activation-model.js";
import {
  ConnectionRegistryError,
  LOCK_UNAVAILABLE,
  MAX_LEGACY_BYTES,
  MAX_REGISTRY_BYTES,
  emptyRegistryDocument,
  invalidRegistry,
  isRecord,
  parseLegacyLocalRecord,
  parseRegistryDocument,
  parseStrictJson,
  serializeRegistryDocument,
  unsafeStorage,
  type ConnectionRegistryDocument,
  type FileConnectionRegistryOptions,
  type LocalConnectionRecord,
  type RegistryFaultPoint,
} from "./connection-registry-model.js";

const MAX_LOCK_BYTES = 1024;
const DEFAULT_LOCK_TIMEOUT_MS = 3_000;
const DEFAULT_STALE_LOCK_MS = 30_000;
const LOCK_POLL_MS = 10;

interface FileIdentity {
  dev: number;
  ino: number;
}

interface DirectoryContext {
  directory: string;
  handle: FileHandle;
  identity: FileIdentity;
}

interface StoredValue {
  value: unknown;
  identity: FileIdentity;
}

interface LockMetadata {
  version: 1;
  pid: number;
  token: string;
  createdAt: number;
}

export interface RegistrySnapshot {
  document: ConnectionRegistryDocument;
  identity: FileIdentity | null;
}

export interface ActivationSnapshot {
  document: ConnectionActivationDocument;
  identity: FileIdentity | null;
}

export interface LegacySnapshot {
  record: LocalConnectionRecord;
  identity: FileIdentity;
}

export interface LockedRegistryAccess {
  readRegistry(): Promise<RegistrySnapshot>;
  readActivation(): Promise<ActivationSnapshot>;
  readLegacy(): Promise<LegacySnapshot | null>;
  writeRegistry(
    document: ConnectionRegistryDocument,
    expected: FileIdentity | null,
  ): Promise<void>;
  writeActivation(
    document: ConnectionActivationDocument,
    expected: FileIdentity | null,
  ): Promise<void>;
  removeActivation(expected: FileIdentity): Promise<void>;
  removeLegacy(expected: FileIdentity): Promise<void>;
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code;
}

function fileIdentity(stat: Stats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function ownedByCurrentUser(stat: Stats): boolean {
  return typeof process.getuid !== "function" || stat.uid === process.getuid();
}

function validateDirectoryStat(stat: Stats): void {
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    !ownedByCurrentUser(stat) ||
    (stat.mode & 0o022) !== 0
  ) {
    throw unsafeStorage();
  }
}

function validatePrivateFileStat(stat: Stats, maximumLinks = 1): void {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    !ownedByCurrentUser(stat) ||
    (stat.nlink < 1 || stat.nlink > maximumLinks) ||
    (stat.mode & 0o077) !== 0 ||
    (stat.mode & 0o400) === 0
  ) {
    throw unsafeStorage();
  }
}

function validateRemovableActivationStat(stat: Stats): void {
  validatePrivateFileStat(stat);
  if ((stat.mode & 0o777) !== 0o600) throw unsafeStorage();
}

async function statNoFollow(filename: string): Promise<Stats | null> {
  try {
    return await lstat(filename);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw unsafeStorage(error);
  }
}

async function openConfigDirectory(
  dataDirectory: string,
  create: boolean,
): Promise<DirectoryContext | null> {
  const root = path.resolve(dataDirectory);
  let rootStat = await statNoFollow(root);
  if (rootStat === null && create) {
    try {
      await mkdir(root, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw unsafeStorage(error);
    }
    rootStat = await statNoFollow(root);
  }
  if (rootStat === null) return null;
  validateDirectoryStat(rootStat);

  const directory = path.join(root, "config");
  let directoryStat = await statNoFollow(directory);
  if (directoryStat === null && create) {
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw unsafeStorage(error);
    }
    directoryStat = await statNoFollow(directory);
  }
  if (directoryStat === null) return null;
  validateDirectoryStat(directoryStat);

  let handle: FileHandle;
  try {
    handle = await open(
      directory,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
    );
  } catch (error) {
    throw unsafeStorage(error);
  }
  try {
    const opened = await handle.stat();
    validateDirectoryStat(opened);
    if (!sameIdentity(fileIdentity(directoryStat), fileIdentity(opened))) {
      throw unsafeStorage();
    }
    return { directory, handle, identity: fileIdentity(opened) };
  } catch (error) {
    await handle.close().catch(() => undefined);
    if (error instanceof ConnectionRegistryError) throw error;
    throw unsafeStorage(error);
  }
}

async function validateDirectoryIdentity(
  context: DirectoryContext,
): Promise<void> {
  const lexical = await statNoFollow(context.directory);
  if (lexical === null) throw unsafeStorage();
  validateDirectoryStat(lexical);
  let opened: Stats;
  try {
    opened = await context.handle.stat();
  } catch (error) {
    throw unsafeStorage(error);
  }
  validateDirectoryStat(opened);
  if (
    !sameIdentity(fileIdentity(lexical), context.identity) ||
    !sameIdentity(fileIdentity(opened), context.identity)
  ) {
    throw unsafeStorage();
  }
}

async function readBounded(
  handle: FileHandle,
  limit: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= limit) {
    const length = Math.min(16 * 1024, limit + 1 - total);
    if (length <= 0) break;
    const chunk = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(chunk, 0, length, null);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  if (total > limit) throw invalidRegistry();
  return Buffer.concat(chunks, total);
}

async function writeFully(handle: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(
      bytes,
      offset,
      bytes.length - offset,
      null,
    );
    if (bytesWritten <= 0) throw unsafeStorage();
    offset += bytesWritten;
  }
}

async function readStoredValue(
  context: DirectoryContext,
  filename: string,
  limit: number,
): Promise<StoredValue | null> {
  await validateDirectoryIdentity(context);
  const before = await statNoFollow(filename);
  if (before === null) return null;
  validatePrivateFileStat(before);
  if (before.size > limit) throw invalidRegistry();
  let handle: FileHandle;
  try {
    handle = await open(
      filename,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    throw unsafeStorage(error);
  }
  try {
    const opened = await handle.stat();
    validatePrivateFileStat(opened);
    if (!sameIdentity(fileIdentity(before), fileIdentity(opened))) {
      throw unsafeStorage();
    }
    const bytes = await readBounded(handle, limit);
    await validateDirectoryIdentity(context);
    const after = await statNoFollow(filename);
    if (
      after === null ||
      !sameIdentity(fileIdentity(opened), fileIdentity(after))
    ) {
      throw unsafeStorage();
    }
    return { value: parseStrictJson(bytes), identity: fileIdentity(opened) };
  } catch (error) {
    if (error instanceof ConnectionRegistryError) throw error;
    throw invalidRegistry(error);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readRegistry(
  context: DirectoryContext,
): Promise<RegistrySnapshot> {
  const stored = await readStoredValue(
    context,
    path.join(context.directory, "connections.json"),
    MAX_REGISTRY_BYTES,
  );
  if (stored === null) {
    return { document: emptyRegistryDocument(), identity: null };
  }
  return {
    document: parseRegistryDocument(stored.value),
    identity: stored.identity,
  };
}

async function readActivation(
  context: DirectoryContext,
): Promise<ActivationSnapshot> {
  const stored = await readStoredValue(
    context,
    path.join(context.directory, "connection-activations.json"),
    MAX_CONNECTION_ACTIVATION_BYTES,
  );
  if (stored === null) {
    return { document: emptyConnectionActivationDocument(), identity: null };
  }
  return {
    document: parseConnectionActivationDocument(stored.value),
    identity: stored.identity,
  };
}

async function assertTargetUnchanged(
  filename: string,
  expected: FileIdentity | null,
): Promise<void> {
  const current = await statNoFollow(filename);
  if (expected === null) {
    if (current !== null) throw unsafeStorage();
    return;
  }
  if (
    current === null ||
    !sameIdentity(fileIdentity(current), expected)
  ) {
    throw unsafeStorage();
  }
  validatePrivateFileStat(current);
}

async function unlinkIfSame(
  filename: string,
  expected: FileIdentity,
): Promise<boolean> {
  const current = await statNoFollow(filename);
  if (current === null) return false;
  if (!sameIdentity(fileIdentity(current), expected)) throw unsafeStorage();
  try {
    await unlink(filename);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw unsafeStorage(error);
  }
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) {
    return Promise.reject(
      new ConnectionRegistryError("lock_timeout", LOCK_UNAVAILABLE),
    );
  }
  return new Promise((resolve, reject) => {
    const aborted = (): void => {
      clearTimeout(timer);
      reject(new ConnectionRegistryError("lock_timeout", LOCK_UNAVAILABLE));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

function parseLockMetadata(value: unknown): LockMetadata | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "createdAt,pid,token,version") return null;
  if (
    value.version !== 1 ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) <= 0 ||
    typeof value.token !== "string" ||
    !/^[0-9a-f-]{36}$/u.test(value.token) ||
    !Number.isSafeInteger(value.createdAt) ||
    (value.createdAt as number) <= 0
  ) {
    return null;
  }
  return {
    version: 1,
    pid: value.pid as number,
    token: value.token,
    createdAt: value.createdAt as number,
  };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, "ESRCH");
  }
}

async function inspectLock(
  context: DirectoryContext,
  lockPath: string,
  afterStat?: () => void | Promise<void>,
  afterOpen?: () => void | Promise<void>,
): Promise<{
  metadata: LockMetadata | null;
  identity: FileIdentity;
  mtimeMs: number;
} | null> {
  const before = await statNoFollow(lockPath);
  if (before === null) return null;
  validatePrivateFileStat(before, 2);
  await afterStat?.();
  let handle: FileHandle;
  try {
    handle = await open(
      lockPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw unsafeStorage(error);
  }
  try {
    await afterOpen?.();
    const opened = await handle.stat();
    // The owner may release or another contender may replace a valid lock
    // between path inspection and opening. Neither inode is authoritative;
    // retrying the hard-link claim preserves exclusion without treating a
    // normal release as unsafe storage.
    if (opened.nlink === 0) {
      await validateDirectoryIdentity(context);
      return null;
    }
    validatePrivateFileStat(opened, 2);
    if (!sameIdentity(fileIdentity(before), fileIdentity(opened))) {
      await validateDirectoryIdentity(context);
      return null;
    }
    const bytes = await readBounded(handle, MAX_LOCK_BYTES).catch(() => null);
    let metadata: LockMetadata | null = null;
    if (bytes !== null) {
      try {
        metadata = parseLockMetadata(parseStrictJson(bytes));
      } catch {
        metadata = null;
      }
    }
    await validateDirectoryIdentity(context);
    return {
      metadata,
      identity: fileIdentity(opened),
      mtimeMs: opened.mtimeMs,
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export class RegistryFileStore {
  readonly #dataDirectory: string;
  readonly #lockTimeoutMs: number;
  readonly #staleLockMs: number;
  readonly #faultInjector:
    | ((point: RegistryFaultPoint) => void | Promise<void>)
    | undefined;

  constructor(
    dataDirectory: string,
    options: FileConnectionRegistryOptions = {},
  ) {
    this.#dataDirectory = path.resolve(dataDirectory);
    this.#lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.#staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
    this.#faultInjector = options.faultInjector;
    if (
      !Number.isSafeInteger(this.#lockTimeoutMs) ||
      this.#lockTimeoutMs < 1 ||
      !Number.isSafeInteger(this.#staleLockMs) ||
      this.#staleLockMs < 1
    ) {
      throw new TypeError("Connection registry lock options are invalid");
    }
  }

  async read(): Promise<ConnectionRegistryDocument> {
    const context = await openConfigDirectory(this.#dataDirectory, false);
    if (context === null) return emptyRegistryDocument();
    try {
      return (await readRegistry(context)).document;
    } finally {
      await context.handle.close().catch(() => undefined);
    }
  }

  async transaction<T>(
    signal: AbortSignal | undefined,
    operation: (access: LockedRegistryAccess) => Promise<T>,
  ): Promise<T> {
    const context = await openConfigDirectory(this.#dataDirectory, true);
    if (context === null) throw unsafeStorage();
    let release: (() => Promise<void>) | undefined;
    try {
      release = await this.#acquireLock(context, signal);
      const access: LockedRegistryAccess = {
        readRegistry: () => readRegistry(context),
        readActivation: () => readActivation(context),
        async readLegacy() {
          const stored = await readStoredValue(
            context,
            path.join(context.directory, "local-connection.json"),
            MAX_LEGACY_BYTES,
          );
          return stored === null
            ? null
            : {
                record: parseLegacyLocalRecord(stored.value),
                identity: stored.identity,
              };
        },
        writeRegistry: (document, expected) =>
          this.#writeRegistry(context, document, expected),
        writeActivation: (document, expected) =>
          this.#writeActivation(context, document, expected),
        removeActivation: (expected) =>
          this.#removeActivation(context, expected),
        async removeLegacy(expected) {
          await validateDirectoryIdentity(context);
          await unlinkIfSame(
            path.join(context.directory, "local-connection.json"),
            expected,
          );
          try {
            await context.handle.sync();
          } catch (error) {
            throw unsafeStorage(error);
          }
        },
      };
      return await operation(access);
    } finally {
      await release?.();
      await context.handle.close().catch(() => undefined);
    }
  }

  async #writeRegistry(
    context: DirectoryContext,
    document: ConnectionRegistryDocument,
    expected: FileIdentity | null,
  ): Promise<void> {
    await this.#writeStoredValue(
      context,
      "connections.json",
      ".connections",
      serializeRegistryDocument(document),
      expected,
    );
  }

  async #writeActivation(
    context: DirectoryContext,
    document: ConnectionActivationDocument,
    expected: FileIdentity | null,
  ): Promise<void> {
    await this.#writeStoredValue(
      context,
      "connection-activations.json",
      ".connection-activations",
      serializeConnectionActivationDocument(document),
      expected,
    );
  }

  async #writeStoredValue(
    context: DirectoryContext,
    targetName: string,
    temporaryPrefix: string,
    bytes: Buffer,
    expected: FileIdentity | null,
  ): Promise<void> {
    const target = path.join(context.directory, targetName);
    const temporary = path.join(
      context.directory,
      `${temporaryPrefix}.${process.pid}.${randomUUID()}.tmp`,
    );
    let handle: FileHandle | undefined;
    let injected = false;
    let injectedError: unknown;
    const inject = async (point: RegistryFaultPoint): Promise<void> => {
      try {
        await this.#faultInjector?.(point);
      } catch (error) {
        injected = true;
        injectedError = error;
        throw error;
      }
    };
    try {
      await validateDirectoryIdentity(context);
      handle = await open(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      await handle.chmod(0o600);
      validatePrivateFileStat(await handle.stat());
      await writeFully(handle, bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await inject("before_rename");
      await validateDirectoryIdentity(context);
      await assertTargetUnchanged(target, expected);
      await rename(temporary, target);
      await validateDirectoryIdentity(context);
      const installed = await statNoFollow(target);
      if (installed === null) throw unsafeStorage();
      validatePrivateFileStat(installed);
      await context.handle.sync();
      await inject("after_rename");
    } catch (error) {
      if (error instanceof ConnectionRegistryError) throw error;
      if (injected && error === injectedError) throw error;
      throw unsafeStorage(error);
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }

  async #removeActivation(
    context: DirectoryContext,
    expected: FileIdentity,
  ): Promise<void> {
    await this.#faultInjector?.("before_remove");
    const target = path.join(
      context.directory,
      "connection-activations.json",
    );
    const retirement = path.join(
      context.directory,
      `.connection-activations.remove.${process.pid}.${randomUUID()}`,
    );
    let handle: FileHandle | undefined;
    let injected = false;
    let injectedError: unknown;
    const inject = async (point: RegistryFaultPoint): Promise<void> => {
      try {
        await this.#faultInjector?.(point);
      } catch (error) {
        injected = true;
        injectedError = error;
        throw error;
      }
    };
    try {
      await validateDirectoryIdentity(context);
      await assertTargetUnchanged(target, expected);
      handle = await open(
        target,
        constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const opened = await handle.stat();
      validateRemovableActivationStat(opened);
      if (!sameIdentity(fileIdentity(opened), expected)) throw unsafeStorage();
      await assertTargetUnchanged(target, expected);
      await rename(target, retirement);
      await validateDirectoryIdentity(context);
      await inject("after_remove_retirement");
      const moved = await statNoFollow(retirement);
      if (
        moved === null ||
        !sameIdentity(fileIdentity(moved), expected)
      ) {
        throw unsafeStorage();
      }
      validateRemovableActivationStat(moved);
      if (await statNoFollow(target) !== null) throw unsafeStorage();
      await context.handle.sync();
      await inject("after_remove_durable_rename");
      // Node has no inode-addressed unlink. Retire the exact opened inode to a
      // zero-byte private path so a same-UID path swap can never be deleted.
      await handle.truncate(0);
      await handle.sync();
      await validateDirectoryIdentity(context);
      const retired = await statNoFollow(retirement);
      if (
        retired === null ||
        retired.size !== 0 ||
        !sameIdentity(fileIdentity(retired), expected)
      ) {
        throw unsafeStorage();
      }
      validateRemovableActivationStat(retired);
      if (await statNoFollow(target) !== null) throw unsafeStorage();
      await context.handle.sync();
    } catch (error) {
      if (error instanceof ConnectionRegistryError) throw error;
      if (injected && error === injectedError) throw error;
      throw unsafeStorage(error);
    } finally {
      await handle?.close().catch(() => undefined);
    }
    await this.#faultInjector?.("after_remove");
  }

  async #acquireLock(
    context: DirectoryContext,
    signal: AbortSignal | undefined,
  ): Promise<() => Promise<void>> {
    const token = randomUUID();
    const metadata: LockMetadata = {
      version: 1,
      pid: process.pid,
      token,
      createdAt: Date.now(),
    };
    const lockPath = path.join(context.directory, ".connections.lock");
    const claimPath = path.join(
      context.directory,
      `.connections.lock.claim.${process.pid}.${token}`,
    );
    let claimHandle: FileHandle | undefined;
    let claimIdentity: FileIdentity | undefined;
    let ownsLock = false;
    try {
      claimHandle = await open(
        claimPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      await claimHandle.chmod(0o600);
      await writeFully(
        claimHandle,
        Buffer.from(`${JSON.stringify(metadata)}\n`, "utf8"),
      );
      await claimHandle.sync();
      claimIdentity = fileIdentity(await claimHandle.stat());
      await claimHandle.close();
      claimHandle = undefined;

      const deadline = Date.now() + this.#lockTimeoutMs;
      while (true) {
        if (signal?.aborted === true) {
          throw new ConnectionRegistryError("lock_timeout", LOCK_UNAVAILABLE);
        }
        await validateDirectoryIdentity(context);
        try {
          await link(claimPath, lockPath);
          ownsLock = true;
          await unlink(claimPath);
          await context.handle.sync();
          const ownedIdentity = claimIdentity;
          return async () => {
            if (ownedIdentity === undefined) return;
            await validateDirectoryIdentity(context);
            const current = await statNoFollow(lockPath);
            if (
              current !== null &&
              sameIdentity(fileIdentity(current), ownedIdentity)
            ) {
              await unlink(lockPath).catch((error: unknown) => {
                if (!isErrno(error, "ENOENT")) throw unsafeStorage(error);
              });
              await context.handle.sync().catch((error: unknown) => {
                throw unsafeStorage(error);
              });
            }
          };
        } catch (error) {
          if (!isErrno(error, "EEXIST")) {
            if (ownsLock && claimIdentity !== undefined) {
              await unlinkIfSame(lockPath, claimIdentity).catch(() => false);
              ownsLock = false;
            }
            throw unsafeStorage(error);
          }
        }

        const lock = await inspectLock(
          context,
          lockPath,
          () => this.#faultInjector?.("after_lock_stat"),
          () => this.#faultInjector?.("after_lock_open"),
        );
        if (lock === null) continue;
        const now = Date.now();
        if (
          lock.metadata !== null &&
          now - lock.mtimeMs >= this.#staleLockMs &&
          now - lock.metadata.createdAt >= this.#staleLockMs &&
          !processIsAlive(lock.metadata.pid)
        ) {
          await unlinkIfSame(lockPath, lock.identity);
          await context.handle.sync();
          continue;
        }
        if (now >= deadline) {
          throw new ConnectionRegistryError("lock_timeout", LOCK_UNAVAILABLE);
        }
        await delay(LOCK_POLL_MS, signal);
      }
    } finally {
      await claimHandle?.close().catch(() => undefined);
      if (!ownsLock && claimIdentity !== undefined) {
        const claim = await statNoFollow(claimPath).catch(() => null);
        if (
          claim !== null &&
          sameIdentity(fileIdentity(claim), claimIdentity)
        ) {
          await unlink(claimPath).catch(() => undefined);
        }
      }
    }
  }
}
