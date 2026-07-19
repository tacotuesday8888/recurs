import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual, TextDecoder } from "node:util";

import { isCredentialPath, ToolError } from "@recurs/tools";

import type {
  GitPatchArtifactHandle,
  GitPatchResultFingerprint,
  GitPatchArtifactStore,
  StoredGitPatchArtifact,
} from "./git-patch-artifacts.js";
import { hasExactKeys, isObject } from "./session-record-validator.js";
import { uniqueSortedStrings } from "./stable-order.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_PATCH_BYTES = 1024 * 1024;
const MAX_REF_BYTES = 256 * 1024;
const MAX_PATHS = 256;
const MAX_PATH_BYTES = 4_096;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const decoder = new TextDecoder("utf-8", { fatal: true });

interface ArtifactRef {
  readonly version: 1;
  readonly handle: GitPatchArtifactHandle;
  readonly repositoryRoot: string;
  readonly after: readonly GitPatchResultFingerprint[];
}

function code(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error &&
      typeof error.code === "string"
    ? error.code
    : null;
}

function denied(message: string, cause?: unknown): never {
  throw new ToolError("permission_denied", message, { cause });
}

function missing(message: string): never {
  throw new ToolError("not_found", message);
}

function safePath(value: unknown): value is string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES || path.isAbsolute(value) ||
    value.includes("\\") || value.includes("\0") || isCredentialPath(value)) {
    return false;
  }
  return value.split("/").every((part) =>
    part.length > 0 && part !== "." && part !== ".." &&
    ![...part].some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point <= 31 || (point >= 127 && point <= 159);
    })
  );
}

function within(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function exactPaths(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PATHS ||
    !value.every(safePath) || new Set(value).size !== value.length) {
    return false;
  }
  const sorted = uniqueSortedStrings(value);
  return value.every((item, index) => item === sorted[index]);
}

function exactHandle(value: unknown): value is GitPatchArtifactHandle {
  return isObject(value) && hasExactKeys(value, [
    "id", "leaseId", "baseRevision", "sha256", "byteLength", "paths",
  ]) && typeof value.id === "string" && ID.test(value.id) &&
    typeof value.leaseId === "string" && ID.test(value.leaseId) &&
    typeof value.baseRevision === "string" && REVISION.test(value.baseRevision) &&
    typeof value.sha256 === "string" && SHA256.test(value.sha256) &&
    typeof value.byteLength === "number" &&
    Number.isSafeInteger(value.byteLength) && value.byteLength > 0 &&
    value.byteLength <= MAX_PATCH_BYTES && exactPaths(value.paths);
}

function exactAfter(
  value: unknown,
  paths: readonly string[],
): value is GitPatchResultFingerprint[] {
  if (!Array.isArray(value) || value.length !== paths.length) return false;
  return value.every((item, index) => {
    if (!isObject(item) || item.path !== paths[index] || !safePath(item.path) ||
      (item.kind !== "file" && item.kind !== "deleted")) {
      return false;
    }
    if (item.kind === "deleted") {
      return hasExactKeys(item, ["path", "kind"]);
    }
    return hasExactKeys(item, [
      "path", "kind", "sha256", "byteLength", "mode",
    ]) && typeof item.sha256 === "string" && SHA256.test(item.sha256) &&
      typeof item.byteLength === "number" &&
      Number.isSafeInteger(item.byteLength) && item.byteLength >= 0 &&
      (item.mode === "100644" || item.mode === "100755");
  });
}

function exactRef(value: unknown): value is ArtifactRef {
  return isObject(value) && hasExactKeys(value, [
    "version", "handle", "repositoryRoot", "after",
  ]) && value.version === 1 && exactHandle(value.handle) &&
    typeof value.repositoryRoot === "string" &&
    path.isAbsolute(value.repositoryRoot) &&
    path.resolve(value.repositoryRoot) === value.repositoryRoot &&
    exactAfter(value.after, value.handle.paths);
}

function parseRef(
  bytes: Uint8Array,
  handle: GitPatchArtifactHandle,
): ArtifactRef {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decode(bytes));
  } catch (error) {
    if (error instanceof ToolError) throw error;
    denied("Patch artifact ref is invalid", error);
  }
  if (!exactRef(parsed) || !isDeepStrictEqual(parsed.handle, handle)) {
    denied("Patch artifact ref failed its integrity check");
  }
  return parsed;
}

function cloneFreeze<T>(value: T): T {
  const cloned = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (typeof item !== "object" || item === null || Object.isFrozen(item)) return;
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  };
  freeze(cloned);
  return cloned;
}

function snapshot<T>(value: T, message: string): T {
  try {
    return cloneFreeze(value);
  } catch (error) {
    denied(message, error);
  }
}

async function inspectDirectory(directory: string): Promise<boolean> {
  let details;
  try {
    details = await lstat(directory);
  } catch (error) {
    if (code(error) === "ENOENT") return false;
    throw error;
  }
  if (details.isSymbolicLink() || !details.isDirectory() ||
    (details.mode & 0o777) !== DIRECTORY_MODE) {
    denied("Patch artifact storage must be a private real directory");
  }
  return true;
}

async function inspectCanonicalDirectory(directory: string): Promise<boolean> {
  if (!await inspectDirectory(directory)) return false;
  if (await realpath(directory) !== directory) {
    denied("Patch artifact storage must use its canonical path");
  }
  return true;
}

async function requireDirectory(directory: string): Promise<void> {
  if (!await inspectDirectory(directory)) {
    await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
    if (!await inspectDirectory(directory)) {
      denied("Patch artifact storage could not be created safely");
    }
  }
}

async function requireFile(file: string, allowMissing: boolean): Promise<Stats | null> {
  let details;
  try {
    details = await lstat(file);
  } catch (error) {
    if (allowMissing && code(error) === "ENOENT") return null;
    throw error;
  }
  if (details.isSymbolicLink() || !details.isFile() ||
    (details.mode & 0o777) !== FILE_MODE) {
    denied("Patch artifact storage contains an unsafe file");
  }
  return details;
}

async function readPrivateFile(
  file: string,
  options: {
    readonly allowMissing: boolean;
    readonly maxBytes: number;
    readonly exactBytes?: number;
    readonly label: "object" | "ref";
  },
): Promise<Buffer | null> {
  const before = await requireFile(file, options.allowMissing);
  if (before === null) return null;
  let handle;
  try {
    handle = await open(file, "r");
    const opened = await handle.stat();
    if (!opened.isFile() || (opened.mode & 0o777) !== FILE_MODE ||
      opened.dev !== before.dev || opened.ino !== before.ino ||
      !Number.isSafeInteger(opened.size) || opened.size < 0 ||
      opened.size > options.maxBytes ||
      (options.exactBytes !== undefined && opened.size !== options.exactBytes)) {
      denied(`Patch artifact ${options.label} failed its size or type check`);
    }
    const bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      );
      if (result.bytesRead === 0) {
        denied(`Patch artifact ${options.label} changed while it was read`);
      }
      offset += result.bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    if ((await handle.read(extra, 0, 1, offset)).bytesRead !== 0) {
      denied(`Patch artifact ${options.label} changed while it was read`);
    }
    const after = await handle.stat();
    if (after.dev !== opened.dev || after.ino !== opened.ino ||
      after.size !== opened.size || after.mode !== opened.mode ||
      after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      denied(`Patch artifact ${options.label} changed while it was read`);
    }
    return bytes;
  } finally {
    await handle?.close();
  }
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

async function publishExclusive(
  directory: string,
  file: string,
  content: string,
): Promise<boolean> {
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporary, "wx", FILE_MODE);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporary, file);
    await syncDirectory(directory);
    return true;
  } catch (error) {
    if (code(error) === "EEXIST") return false;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true });
  }
}

function decode(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch (error) {
    denied("Patch artifact storage contains invalid UTF-8", error);
  }
}

function verifyPatch(handle: GitPatchArtifactHandle, patch: string): void {
  if (Buffer.byteLength(patch, "utf8") !== handle.byteLength ||
    createHash("sha256").update(patch).digest("hex") !== handle.sha256) {
    denied("Patch artifact content failed its integrity check");
  }
}

async function canonicalRepository(repositoryRoot: string): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(repositoryRoot);
  } catch (error) {
    denied("Patch artifact repository is unavailable", error);
  }
  if (canonical !== repositoryRoot) {
    denied("Patch artifact repository must use its canonical path");
  }
  const details = await lstat(canonical);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    denied("Patch artifact repository must be a real directory");
  }
  return canonical;
}

async function requireCanonicalAncestor(target: string): Promise<void> {
  let ancestor = target;
  for (;;) {
    try {
      await lstat(ancestor);
      break;
    } catch (error) {
      if (code(error) !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  if (await realpath(ancestor) !== ancestor) {
    denied("Patch artifact storage cannot traverse symbolic links");
  }
}

export class FileGitPatchArtifactStore implements GitPatchArtifactStore {
  readonly directory: string;
  #publicationTail: Promise<void> = Promise.resolve();

  constructor(directory: string) {
    this.directory = path.resolve(directory);
  }

  #object(handle: GitPatchArtifactHandle): string {
    return path.join(this.directory, "objects", `${handle.sha256}.patch`);
  }

  #ref(handle: GitPatchArtifactHandle): string {
    return path.join(this.directory, "refs", `${handle.id}.json`);
  }

  async #prepare(): Promise<void> {
    await requireCanonicalAncestor(this.directory);
    await requireDirectory(this.directory);
    if (await realpath(this.directory) !== this.directory) {
      denied("Patch artifact storage must use its canonical path");
    }
    await requireDirectory(path.join(this.directory, "objects"));
    await requireDirectory(path.join(this.directory, "refs"));
  }

  async put(input: StoredGitPatchArtifact): Promise<void> {
    const artifact = snapshot(input, "Patch artifact input is invalid");
    if (!isObject(artifact) || !hasExactKeys(artifact, [
      "handle", "repositoryRoot", "patch", "after",
    ]) || !exactHandle(artifact.handle) ||
      typeof artifact.repositoryRoot !== "string" ||
      !path.isAbsolute(artifact.repositoryRoot) ||
      path.resolve(artifact.repositoryRoot) !== artifact.repositoryRoot ||
      typeof artifact.patch !== "string" ||
      !exactAfter(artifact.after, artifact.handle.paths)) {
      denied("Patch artifact input is invalid");
    }
    verifyPatch(artifact.handle, artifact.patch);
    const ref: ArtifactRef = {
      version: 1,
      handle: artifact.handle,
      repositoryRoot: artifact.repositoryRoot,
      after: artifact.after,
    };
    const refContent = `${JSON.stringify(ref)}\n`;
    if (Buffer.byteLength(refContent, "utf8") > MAX_REF_BYTES) {
      denied("Patch artifact ref is too large");
    }
    const publication = this.#publicationTail.then(async () => {
      const repositoryRoot = await canonicalRepository(artifact.repositoryRoot);
      if (within(repositoryRoot, this.directory)) {
        denied("Patch artifact storage must be outside the repository");
      }
      await this.#prepare();

      const object = this.#object(artifact.handle);
      if (!await publishExclusive(path.dirname(object), object, artifact.patch)) {
        const existing = await readPrivateFile(object, {
          allowMissing: false,
          maxBytes: MAX_PATCH_BYTES,
          exactBytes: artifact.handle.byteLength,
          label: "object",
        });
        if (existing === null) missing("Patch artifact object was not found");
        verifyPatch(artifact.handle, decode(existing));
      }
      const refFile = this.#ref(artifact.handle);
      if (!await publishExclusive(
        path.dirname(refFile),
        refFile,
        refContent,
      )) {
        const existing = await this.load(artifact.handle);
        if (!isDeepStrictEqual(existing, artifact)) {
          denied("Patch artifact ID is already bound to different content");
        }
      }
    });
    this.#publicationTail = publication.catch(() => undefined);
    await publication;
  }

  async load(input: GitPatchArtifactHandle): Promise<StoredGitPatchArtifact> {
    const handle = snapshot(input, "Patch artifact handle is invalid");
    if (!exactHandle(handle)) denied("Patch artifact handle is invalid");
    if (!await inspectCanonicalDirectory(this.directory) ||
      !await inspectDirectory(path.join(this.directory, "objects")) ||
      !await inspectDirectory(path.join(this.directory, "refs"))) {
      missing("Patch artifact was not found");
    }
    const refBytes = await readPrivateFile(this.#ref(handle), {
      allowMissing: true,
      maxBytes: MAX_REF_BYTES,
      label: "ref",
    });
    if (refBytes === null) missing("Patch artifact was not found");
    const parsed = parseRef(refBytes, handle);
    await canonicalRepository(parsed.repositoryRoot);
    const object = this.#object(handle);
    const bytes = await readPrivateFile(object, {
      allowMissing: true,
      maxBytes: MAX_PATCH_BYTES,
      exactBytes: handle.byteLength,
      label: "object",
    });
    if (bytes === null) denied("Patch artifact object is missing");
    const patch = decode(bytes);
    verifyPatch(handle, patch);
    return cloneFreeze({
      handle: parsed.handle,
      repositoryRoot: parsed.repositoryRoot,
      patch,
      after: parsed.after,
    });
  }

  async remove(input: readonly GitPatchArtifactHandle[]): Promise<void> {
    const handles = snapshot(input, "Patch artifact removal input is invalid");
    if (!Array.isArray(handles) || handles.length > MAX_PATHS) {
      denied("Patch artifact removal input is invalid");
    }
    if (!await inspectCanonicalDirectory(this.directory)) return;
    const refs = path.join(this.directory, "refs");
    if (!await inspectDirectory(refs)) return;
    for (const handle of handles) {
      if (!exactHandle(handle)) denied("Patch artifact handle is invalid");
      const ref = this.#ref(handle);
      const bytes = await readPrivateFile(ref, {
        allowMissing: true,
        maxBytes: MAX_REF_BYTES,
        label: "ref",
      });
      if (bytes === null) continue;
      parseRef(bytes, handle);
      try {
        await rm(ref);
      } catch (error) {
        if (code(error) !== "ENOENT") throw error;
      }
    }
    await syncDirectory(refs);
  }
}
