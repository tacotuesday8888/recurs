import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import path from "node:path";

import { isCredentialPath } from "./path-policy.js";
import { safeGitArguments } from "./git-safety.js";
import { runProcess } from "./process.js";
import { ToolError } from "./types.js";

const CHECKPOINT_FORMAT_FILE = ".format.json";
const CHECKPOINT_FORMAT = {
  version: 2,
  credentialPathsExcluded: true,
} as const;
const FORMAT_INITIALIZATION_ATTEMPTS = 20;

export interface WorkspaceManifestEntry {
  sha256: string;
  blob: string;
  size: number;
  kind: "file" | "symlink";
  mode: number;
}

export type WorkspaceManifest = Record<string, WorkspaceManifestEntry>;

export interface Checkpoint {
  id: string;
  sessionId: string;
  toolCallId: string;
  before: WorkspaceManifest;
  after?: WorkspaceManifest;
}

export abstract class CheckpointStore {
  abstract captureBefore(
    sessionId: string,
    toolCallId: string,
    cwd: string,
  ): Promise<Checkpoint>;
  abstract captureAfter(
    checkpoint: Checkpoint,
    cwd: string,
  ): Promise<Checkpoint>;
  abstract undoLatest(
    sessionId: string,
    cwd: string,
  ): Promise<{ restored: string[]; deleted: string[] }>;
}

interface StoredCheckpoint extends Checkpoint {
  createdAt: string;
  completedAt?: string;
  undoneAt?: string;
}

interface WorkspaceContent {
  entry: WorkspaceManifestEntry;
  bytes: Buffer;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

function migrationRequired(): ToolError {
  return new ToolError(
    "checkpoint_migration_required",
    "Legacy checkpoint storage must be reset before it can be used safely",
  );
}

function validCheckpointFormat(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 2 &&
    "version" in value &&
    value.version === CHECKPOINT_FORMAT.version &&
    "credentialPathsExcluded" in value &&
    value.credentialPathsExcluded === CHECKPOINT_FORMAT.credentialPathsExcluded
  );
}

async function initializationDelay(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function validateSessionId(sessionId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(sessionId)) {
    throw new ToolError("checkpoint_storage", `Invalid session id: ${sessionId}`);
  }
}

function validIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(value);
}

function validHash(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

function normalizedPath(input: string): string {
  return input.split(path.sep).join("/");
}

function isCredentialAbsolute(root: string, candidate: string): boolean {
  return isCredentialPath(normalizedPath(path.relative(root, candidate)));
}

type UnsafeCheckpointPathCode =
  | "checkpoint_conflict"
  | "checkpoint_corrupt";

function rejectOrExcludeCredential(code: UnsafeCheckpointPathCode): void {
  if (code === "checkpoint_conflict") {
    throw new ToolError(
      code,
      "Undo refused because a checkpoint path resolves to credential storage",
    );
  }
}

async function workspaceAbsolute(cwd: string, relative: string): Promise<string> {
  const root = await realpath(cwd);
  const absolute = path.resolve(root, relative);
  if (!isWithin(root, absolute)) {
    throw new ToolError(
      "checkpoint_corrupt",
      `Checkpoint path escapes the workspace: ${relative}`,
    );
  }
  return absolute;
}

async function canonicalWorkspaceEntry(
  root: string,
  absolute: string,
  code: UnsafeCheckpointPathCode,
): Promise<string> {
  let ancestor = path.dirname(absolute);
  const suffix = [path.basename(absolute)];
  for (;;) {
    try {
      const resolvedAncestor = await realpath(ancestor);
      const resolved = path.resolve(resolvedAncestor, ...suffix);
      if (!isWithin(root, resolved)) {
        throw new ToolError(
          code,
          `Checkpoint path has an external parent: ${absolute}`,
        );
      }
      return resolved;
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) {
        throw new ToolError(code, `Cannot resolve checkpoint path: ${absolute}`);
      }
      suffix.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

async function assertSafeCheckpointTarget(
  cwd: string,
  absolute: string,
  code: UnsafeCheckpointPathCode,
): Promise<void> {
  const root = await realpath(cwd);
  const canonical = await canonicalWorkspaceEntry(root, absolute, code);
  if (isCredentialAbsolute(root, canonical)) {
    rejectOrExcludeCredential(code);
  }
}

function hashWorkspaceContent(
  kind: WorkspaceManifestEntry["kind"],
  mode: number,
  bytes: Buffer,
): string {
  return createHash("sha256")
    .update(kind)
    .update("\0")
    .update(String(mode))
    .update("\0")
    .update(bytes)
    .digest("hex");
}

function hashBlob(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readWorkspaceContent(
  cwd: string,
  relative: string,
  unsafePathCode: UnsafeCheckpointPathCode = "checkpoint_corrupt",
): Promise<WorkspaceContent | null> {
  const root = await realpath(cwd);
  const absolute = await workspaceAbsolute(root, relative);
  const canonicalEntry = await canonicalWorkspaceEntry(
    root,
    absolute,
    unsafePathCode,
  );
  if (isCredentialAbsolute(root, canonicalEntry)) {
    rejectOrExcludeCredential(unsafePathCode);
    return null;
  }
  let stats;
  try {
    stats = await lstat(absolute);
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
  let kind: WorkspaceManifestEntry["kind"];
  let bytes: Buffer;
  if (stats.isSymbolicLink()) {
    kind = "symlink";
    bytes = Buffer.from(await readlink(absolute), "utf8");
  } else if (stats.isFile()) {
    const resolved = await realpath(absolute);
    if (!isWithin(root, resolved)) {
      throw new ToolError(
        unsafePathCode,
        `Checkpoint file resolves outside the workspace: ${relative}`,
      );
    }
    if (isCredentialAbsolute(root, resolved)) {
      rejectOrExcludeCredential(unsafePathCode);
      return null;
    }
    kind = "file";
    bytes = await readFile(resolved);
  } else {
    return null;
  }
  const mode = stats.mode & 0o777;
  return {
    entry: {
      sha256: hashWorkspaceContent(kind, mode, bytes),
      blob: hashBlob(bytes),
      size: bytes.byteLength,
      kind,
      mode,
    },
    bytes,
  };
}

function entriesEqual(
  left: WorkspaceManifestEntry | undefined,
  right: WorkspaceManifestEntry | undefined,
): boolean {
  return left?.sha256 === right?.sha256;
}

function manifestsDiffer(
  before: WorkspaceManifest,
  after: WorkspaceManifest,
): boolean {
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...paths].some((file) => !entriesEqual(before[file], after[file]));
}

function isManifestEntry(value: unknown): value is WorkspaceManifestEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    "sha256" in value &&
    typeof value.sha256 === "string" &&
    validHash(value.sha256) &&
    "blob" in value &&
    typeof value.blob === "string" &&
    validHash(value.blob) &&
    "size" in value &&
    typeof value.size === "number" &&
    "kind" in value &&
    (value.kind === "file" || value.kind === "symlink") &&
    "mode" in value &&
    typeof value.mode === "number" &&
    Number.isInteger(value.mode) &&
    value.mode >= 0 &&
    value.mode <= 0o777
  );
}

function isManifest(value: unknown): value is WorkspaceManifest {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(isManifestEntry)
  );
}

function parseStoredCheckpoint(value: unknown): StoredCheckpoint {
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    typeof value.id !== "string" ||
    !validIdentifier(value.id) ||
    !("sessionId" in value) ||
    typeof value.sessionId !== "string" ||
    !validIdentifier(value.sessionId) ||
    !("toolCallId" in value) ||
    typeof value.toolCallId !== "string" ||
    value.toolCallId.length === 0 ||
    value.toolCallId.length > 512 ||
    !("createdAt" in value) ||
    typeof value.createdAt !== "string" ||
    !("before" in value) ||
    !isManifest(value.before) ||
    ("after" in value && value.after !== undefined && !isManifest(value.after)) ||
    ("completedAt" in value &&
      value.completedAt !== undefined &&
      typeof value.completedAt !== "string") ||
    ("undoneAt" in value &&
      value.undoneAt !== undefined &&
      typeof value.undoneAt !== "string")
  ) {
    throw new ToolError("checkpoint_corrupt", "Invalid checkpoint record");
  }
  return value as StoredCheckpoint;
}

export class FileCheckpointStore extends CheckpointStore {
  #initialization: Promise<void> | undefined;

  constructor(private readonly dataDirectory: string) {
    super();
  }

  initialize(): Promise<void> {
    this.#initialization ??= this.#initialize();
    return this.#initialization;
  }

  async #initialize(): Promise<void> {
    await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
    const directoryStats = await lstat(this.dataDirectory);
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
      throw migrationRequired();
    }

    const marker = path.join(this.dataDirectory, CHECKPOINT_FORMAT_FILE);
    for (
      let attempt = 0;
      attempt < FORMAT_INITIALIZATION_ATTEMPTS;
      attempt += 1
    ) {
      try {
        const markerStats = await lstat(marker);
        if (
          !markerStats.isFile() ||
          markerStats.isSymbolicLink() ||
          (markerStats.mode & 0o077) !== 0
        ) {
          throw migrationRequired();
        }
        try {
          const value: unknown = JSON.parse(await readFile(marker, "utf8"));
          if (validCheckpointFormat(value)) {
            return;
          }
        } catch (error) {
          if (error instanceof ToolError) {
            throw error;
          }
        }
        if (attempt + 1 < FORMAT_INITIALIZATION_ATTEMPTS) {
          await initializationDelay();
          continue;
        }
        throw migrationRequired();
      } catch (error) {
        if (!isMissing(error)) {
          throw error;
        }
      }

      const entries = await readdir(this.dataDirectory);
      if (entries.length > 0) {
        if (
          entries.length === 1 &&
          entries[0] === CHECKPOINT_FORMAT_FILE &&
          attempt + 1 < FORMAT_INITIALIZATION_ATTEMPTS
        ) {
          await initializationDelay();
          continue;
        }
        throw migrationRequired();
      }

      let handle;
      try {
        handle = await open(marker, "wx", 0o600);
        await handle.writeFile(`${JSON.stringify(CHECKPOINT_FORMAT)}\n`, "utf8");
        await handle.sync();
        return;
      } catch (error) {
        if (!isAlreadyExists(error)) {
          throw error;
        }
        if (attempt + 1 < FORMAT_INITIALIZATION_ATTEMPTS) {
          await initializationDelay();
        }
      } finally {
        await handle?.close();
      }
    }
    throw migrationRequired();
  }

  #sessionDirectory(sessionId: string): string {
    validateSessionId(sessionId);
    return path.join(this.dataDirectory, "sessions", sessionId);
  }

  #checkpointFile(sessionId: string, id: string): string {
    return path.join(this.#sessionDirectory(sessionId), `${id}.json`);
  }

  async #assertStorageLocation(cwd: string): Promise<void> {
    const root = await realpath(cwd);
    const requestedStorage = path.resolve(this.dataDirectory);
    let ancestor = requestedStorage;
    const suffix: string[] = [];
    let resolvedAncestor: string;
    for (;;) {
      try {
        resolvedAncestor = await realpath(ancestor);
        break;
      } catch (error) {
        if (!isMissing(error)) {
          throw error;
        }
        const parent = path.dirname(ancestor);
        if (parent === ancestor) {
          throw new ToolError(
            "checkpoint_storage",
            `Cannot resolve checkpoint storage: ${this.dataDirectory}`,
          );
        }
        suffix.unshift(path.basename(ancestor));
        ancestor = parent;
      }
    }
    const storage = path.resolve(resolvedAncestor, ...suffix);
    if (isWithin(root, storage)) {
      throw new ToolError(
        "checkpoint_storage",
        "Checkpoint storage must be outside the project workspace",
      );
    }
  }

  async #writeBlob(hash: string, bytes: Buffer): Promise<void> {
    const directory = path.join(this.dataDirectory, "blobs");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, hash);
    let handle;
    try {
      handle = await open(file, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "EEXIST"
      ) {
        throw error;
      }
    } finally {
      await handle?.close();
    }
  }

  async #captureManifest(cwd: string): Promise<WorkspaceManifest> {
    const args = await safeGitArguments(cwd, [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
    const listed = await runProcess(
      "git",
      args,
      { cwd, maxOutputBytes: 16 * 1024 * 1024 },
    );
    const files = listed.stdout
      .split("\0")
      .filter((file) => file.length > 0)
      .filter((file) => !isCredentialPath(file));
    const manifest = Object.create(null) as WorkspaceManifest;
    for (const file of files) {
      const content = await readWorkspaceContent(cwd, file);
      if (content === null) {
        continue;
      }
      await this.#writeBlob(content.entry.blob, content.bytes);
      manifest[normalizedPath(file)] = content.entry;
    }
    return manifest;
  }

  async #writeCheckpoint(checkpoint: StoredCheckpoint): Promise<void> {
    const directory = this.#sessionDirectory(checkpoint.sessionId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = this.#checkpointFile(checkpoint.sessionId, checkpoint.id);
    const temporary = `${target}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(checkpoint)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
  }

  async #readCheckpoint(file: string): Promise<StoredCheckpoint> {
    try {
      const value: unknown = JSON.parse(await readFile(file, "utf8"));
      return parseStoredCheckpoint(value);
    } catch (error) {
      if (error instanceof ToolError) {
        throw error;
      }
      throw new ToolError("checkpoint_corrupt", `Cannot read ${file}`, {
        cause: error,
      });
    }
  }

  async captureBefore(
    sessionId: string,
    toolCallId: string,
    cwd: string,
  ): Promise<Checkpoint> {
    await this.#assertStorageLocation(cwd);
    await this.initialize();
    const stored: StoredCheckpoint = {
      id: randomUUID(),
      sessionId,
      toolCallId,
      before: await this.#captureManifest(cwd),
      createdAt: new Date().toISOString(),
    };
    await this.#writeCheckpoint(stored);
    return stored;
  }

  async captureAfter(
    checkpoint: Checkpoint,
    cwd: string,
  ): Promise<Checkpoint> {
    await this.#assertStorageLocation(cwd);
    await this.initialize();
    const stored = await this.#readCheckpoint(
      this.#checkpointFile(checkpoint.sessionId, checkpoint.id),
    );
    const completed: StoredCheckpoint = {
      ...stored,
      after: await this.#captureManifest(cwd),
      completedAt: new Date().toISOString(),
    };
    await this.#writeCheckpoint(completed);
    return completed;
  }

  async #latest(sessionId: string): Promise<StoredCheckpoint> {
    const directory = this.#sessionDirectory(sessionId);
    let files: string[];
    try {
      files = (await readdir(directory))
        .filter((file) => file.endsWith(".json"))
        .map((file) => path.join(directory, file));
    } catch (error) {
      if (isMissing(error)) {
        throw new ToolError(
          "checkpoint_not_found",
          `No checkpoint exists for session ${sessionId}`,
        );
      }
      throw error;
    }
    const checkpoints = await Promise.all(
      files.map((file) => this.#readCheckpoint(file)),
    );
    if (checkpoints.some((checkpoint) => checkpoint.sessionId !== sessionId)) {
      throw new ToolError(
        "checkpoint_corrupt",
        `Checkpoint session does not match ${sessionId}`,
      );
    }
    const candidates = checkpoints
      .filter(
        (checkpoint) =>
          checkpoint.after !== undefined &&
          checkpoint.undoneAt === undefined &&
          manifestsDiffer(checkpoint.before, checkpoint.after),
      )
      .sort((left, right) =>
        (right.completedAt ?? "").localeCompare(left.completedAt ?? ""),
      );
    const latest = candidates[0];
    if (latest === undefined) {
      throw new ToolError(
        "checkpoint_not_found",
        `No recoverable checkpoint exists for session ${sessionId}`,
      );
    }
    return latest;
  }

  async undoLatest(
    sessionId: string,
    cwd: string,
  ): Promise<{ restored: string[]; deleted: string[] }> {
    await this.#assertStorageLocation(cwd);
    await this.initialize();
    const checkpoint = await this.#latest(sessionId);
    const after = checkpoint.after;
    if (after === undefined) {
      throw new ToolError("checkpoint_corrupt", "Checkpoint has no after state");
    }
    const paths = [...new Set([
      ...Object.keys(checkpoint.before),
      ...Object.keys(after),
    ])]
      .filter((file) => !entriesEqual(checkpoint.before[file], after[file]))
      .sort((left, right) => left.localeCompare(right));

    const conflicts: string[] = [];
    for (const file of paths) {
      const current = await readWorkspaceContent(cwd, file, "checkpoint_conflict");
      if (!entriesEqual(current?.entry, after[file])) {
        conflicts.push(file);
      }
    }
    if (conflicts.length > 0) {
      throw new ToolError(
        "checkpoint_conflict",
        `Undo refused because files changed after the agent: ${conflicts.join(", ")}`,
      );
    }

    const restoreBlobs = new Map<string, Buffer>();
    for (const file of paths) {
      const before = checkpoint.before[file];
      if (before === undefined) {
        continue;
      }
      const bytes = await readFile(path.join(this.dataDirectory, "blobs", before.blob));
      if (
        hashBlob(bytes) !== before.blob ||
        hashWorkspaceContent(before.kind, before.mode, bytes) !== before.sha256
      ) {
        throw new ToolError(
          "checkpoint_corrupt",
          `Checkpoint blob is corrupt for ${file}`,
        );
      }
      restoreBlobs.set(file, bytes);
    }
    for (const file of paths) {
      const absolute = await workspaceAbsolute(cwd, file);
      await assertSafeCheckpointTarget(cwd, absolute, "checkpoint_conflict");
    }

    const restored: string[] = [];
    const deleted: string[] = [];
    for (const file of paths) {
      const absolute = await workspaceAbsolute(cwd, file);
      await assertSafeCheckpointTarget(cwd, absolute, "checkpoint_conflict");
      const before = checkpoint.before[file];
      if (before === undefined) {
        await rm(absolute, { force: true });
        deleted.push(file);
        continue;
      }
      const bytes = restoreBlobs.get(file);
      if (bytes === undefined) {
        throw new ToolError("checkpoint_corrupt", `Missing blob for ${file}`);
      }
      await mkdir(path.dirname(absolute), { recursive: true });
      if (before.kind === "symlink") {
        await rm(absolute, { force: true });
        await symlink(bytes.toString("utf8"), absolute);
      } else {
        const temporary = `${absolute}.${randomUUID()}.recurs-undo`;
        const handle = await open(temporary, "wx", before.mode);
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, absolute);
        await chmod(absolute, before.mode);
      }
      restored.push(file);
    }

    await this.#writeCheckpoint({
      ...checkpoint,
      undoneAt: new Date().toISOString(),
    });
    return { restored, deleted };
  }
}
