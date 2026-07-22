import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual, TextDecoder } from "node:util";

import {
  parseCompanyBlueprint,
  type CompanyBlueprintV1,
} from "@recurs/contracts";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_BLUEPRINT_BYTES = 256 * 1024;
const MAX_BLUEPRINTS = 512;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const decoder = new TextDecoder("utf-8", { fatal: true });
const publicationTails = new Map<string, Promise<void>>();

export type CompanyBlueprintStoreErrorCode =
  | "invalid_blueprint_id"
  | "blueprint_not_found"
  | "blueprint_conflict"
  | "corrupt_blueprint";

export class CompanyBlueprintStoreError extends Error {
  constructor(
    public readonly code: CompanyBlueprintStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CompanyBlueprintStoreError";
  }
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error &&
      typeof error.code === "string"
    ? error.code
    : null;
}

function corrupt(message: string, cause?: unknown): never {
  throw new CompanyBlueprintStoreError("corrupt_blueprint", message, { cause });
}

function validateId(id: string): void {
  if (!SAFE_ID.test(id)) {
    throw new CompanyBlueprintStoreError(
      "invalid_blueprint_id",
      `Invalid company blueprint id: ${id}`,
    );
  }
}

async function inspectDirectory(directory: string): Promise<boolean> {
  let details: Stats;
  try {
    details = await lstat(directory);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
  if (details.isSymbolicLink() || !details.isDirectory() ||
    (details.mode & 0o777) !== DIRECTORY_MODE) {
    corrupt("Company blueprint storage must be a private real directory");
  }
  return true;
}

async function requireCanonicalAncestor(target: string): Promise<void> {
  let ancestor = target;
  for (;;) {
    try {
      await lstat(ancestor);
      break;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  if (await realpath(ancestor) !== ancestor) {
    corrupt("Company blueprint storage cannot traverse symbolic links");
  }
}

async function requireDirectory(directory: string): Promise<void> {
  if (!await inspectDirectory(directory)) {
    await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
    if (!await inspectDirectory(directory)) {
      corrupt("Company blueprint storage could not be created safely");
    }
  }
  if (await realpath(directory) !== directory) {
    corrupt("Company blueprint storage must use its canonical path");
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!["EBADF", "EINVAL", "EISDIR", "EPERM"].includes(errorCode(error) ?? "")) {
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
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true });
  }
}

async function serializePublication<T>(
  file: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = publicationTails.get(file) ?? Promise.resolve();
  const publication = previous.catch(() => undefined).then(operation);
  const tail = publication.then(() => undefined, () => undefined);
  publicationTails.set(file, tail);
  try {
    return await publication;
  } finally {
    if (publicationTails.get(file) === tail) publicationTails.delete(file);
  }
}

function parseStoredBlueprint(bytes: Uint8Array): CompanyBlueprintV1 {
  try {
    return parseCompanyBlueprint(JSON.parse(decoder.decode(bytes)));
  } catch (error) {
    corrupt("Company blueprint record is invalid", error);
  }
}

async function readBlueprintFile(file: string): Promise<CompanyBlueprintV1> {
  let before: Stats;
  try {
    before = await lstat(file);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new CompanyBlueprintStoreError(
        "blueprint_not_found",
        "Company blueprint was not found",
      );
    }
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile() ||
    (before.mode & 0o777) !== FILE_MODE || !Number.isSafeInteger(before.size) ||
    before.size <= 0 || before.size > MAX_BLUEPRINT_BYTES) {
    corrupt("Company blueprint storage contains an unsafe file");
  }
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
      opened.size !== before.size || opened.mode !== before.mode) {
      corrupt("Company blueprint changed before it was read");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.byteLength !== opened.size || after.dev !== opened.dev ||
      after.ino !== opened.ino || after.size !== opened.size ||
      after.mode !== opened.mode || after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs) {
      corrupt("Company blueprint changed while it was read");
    }
    return parseStoredBlueprint(bytes);
  } finally {
    await handle?.close();
  }
}

export class FileCompanyBlueprintStore {
  readonly directory: string;

  constructor(directory: string) {
    this.directory = path.resolve(directory);
  }

  #file(id: string): string {
    validateId(id);
    return path.join(this.directory, `${id}.json`);
  }

  async create(
    input: CompanyBlueprintV1,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const blueprint = parseCompanyBlueprint(structuredClone(input));
    const content = `${JSON.stringify(blueprint)}\n`;
    if (Buffer.byteLength(content, "utf8") > MAX_BLUEPRINT_BYTES) {
      corrupt("Company blueprint record is too large");
    }
    const file = this.#file(blueprint.id);
    await serializePublication(file, async () => {
      signal?.throwIfAborted();
      await requireCanonicalAncestor(this.directory);
      await requireDirectory(this.directory);
      signal?.throwIfAborted();
      if (!await publishExclusive(this.directory, file, content)) {
        const existing = await this.load(blueprint.id, signal);
        if (!isDeepStrictEqual(existing, blueprint)) {
          throw new CompanyBlueprintStoreError(
            "blueprint_conflict",
            `Company blueprint ${blueprint.id} already contains different content`,
          );
        }
      }
    });
  }

  async load(id: string, signal?: AbortSignal): Promise<CompanyBlueprintV1> {
    signal?.throwIfAborted();
    const file = this.#file(id);
    if (!await inspectDirectory(this.directory)) {
      throw new CompanyBlueprintStoreError(
        "blueprint_not_found",
        `Company blueprint ${id} was not found`,
      );
    }
    if (await realpath(this.directory) !== this.directory) {
      corrupt("Company blueprint storage must use its canonical path");
    }
    signal?.throwIfAborted();
    return readBlueprintFile(file);
  }

  async list(signal?: AbortSignal): Promise<readonly CompanyBlueprintV1[]> {
    signal?.throwIfAborted();
    if (!await inspectDirectory(this.directory)) return Object.freeze([]);
    if (await realpath(this.directory) !== this.directory) {
      corrupt("Company blueprint storage must use its canonical path");
    }
    const entries = await readdir(this.directory, { withFileTypes: true });
    const ids = entries
      .filter((entry) => !entry.name.startsWith("."))
      .map((entry) => {
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
          corrupt("Company blueprint storage contains an unexpected entry");
        }
        const id = entry.name.slice(0, -5);
        validateId(id);
        return id;
      })
      .sort();
    if (ids.length > MAX_BLUEPRINTS) {
      corrupt("Company blueprint storage contains too many records");
    }
    const blueprints: CompanyBlueprintV1[] = [];
    for (const id of ids) {
      signal?.throwIfAborted();
      blueprints.push(await this.load(id, signal));
    }
    return Object.freeze(blueprints);
  }
}
