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

import { acquireSessionLock } from "./session-mutation-lease.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const decoder = new TextDecoder("utf-8", { fatal: true });
const mutationTails = new Map<string, Promise<void>>();

export type CompanyStateStoreErrorCode =
  | "invalid_id"
  | "not_found"
  | "conflict"
  | "corrupt"
  | "sequence_conflict";

export class CompanyStateStoreError extends Error {
  constructor(
    public readonly code: CompanyStateStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CompanyStateStoreError";
  }
}

export interface SequencedCompanyState<T> {
  readonly sequence: number;
  readonly state: T;
}

interface SecureRead {
  readonly bytes: Uint8Array;
  readonly stats: Stats;
}

interface ImmutableOptions<T> {
  readonly label: string;
  readonly maximumBytes: number;
  readonly maximumRecords: number;
  readonly parse: (value: unknown) => T;
  readonly idOf: (value: T) => string;
}

interface JsonlOptions<T> extends ImmutableOptions<T> {
  readonly validateTransition?: (previous: T, next: T) => void;
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error &&
      typeof error.code === "string"
    ? error.code
    : null;
}

function fail(message: string, cause?: unknown): never {
  throw new CompanyStateStoreError("corrupt", message, { cause });
}

function validateId(id: string): void {
  if (!SAFE_ID.test(id)) {
    throw new CompanyStateStoreError("invalid_id", `Invalid state id: ${id}`);
  }
}

async function serializeMutation<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = mutationTails.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  const tail = next.then(() => undefined, () => undefined);
  mutationTails.set(key, tail);
  try {
    return await next;
  } finally {
    if (mutationTails.get(key) === tail) mutationTails.delete(key);
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
    fail("Company state storage must be a private real directory");
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
    fail("Company state storage cannot traverse symbolic links");
  }
}

async function requireDirectory(directory: string): Promise<void> {
  if (!await inspectDirectory(directory)) {
    await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
  }
  if (!await inspectDirectory(directory) || await realpath(directory) !== directory) {
    fail("Company state storage must use a canonical private directory");
  }
}

async function prepareMutationRoot(directory: string, id: string): Promise<void> {
  await requireCanonicalAncestor(directory);
  await requireDirectory(directory);
  await requireDirectory(path.join(directory, ".locks"));
  await requireDirectory(path.join(directory, ".fences"));
  const fence = path.join(directory, ".fences", `${id}.fence`);
  try {
    const details = await lstat(fence);
    if (details.isSymbolicLink() || !details.isFile() ||
      (details.mode & 0o777) !== FILE_MODE) {
      fail("Company state fence is unsafe");
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

export function withPrivateStateMutationLock<T>(
  directory: string,
  id: string,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const resolved = path.resolve(directory);
  validateId(id);
  return serializeMutation(path.join(resolved, id), async () => {
    signal?.throwIfAborted();
    await prepareMutationRoot(resolved, id);
    const lock = await acquireSessionLock(resolved, id);
    try {
      signal?.throwIfAborted();
      const result = await operation();
      await lock.assertOwned();
      return result;
    } finally {
      await lock.release();
    }
  });
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

async function readSecure(
  file: string,
  maximumBytes: number,
  allowMissing: boolean,
): Promise<SecureRead | null> {
  let before: Stats;
  try {
    before = await lstat(file);
  } catch (error) {
    if (allowMissing && errorCode(error) === "ENOENT") return null;
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile() ||
    (before.mode & 0o777) !== FILE_MODE || before.size <= 0 ||
    !Number.isSafeInteger(before.size) || before.size > maximumBytes) {
    fail("Company state storage contains an unsafe file");
  }
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino ||
      opened.size !== before.size || opened.mode !== before.mode) {
      fail("Company state file changed before it was read");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.byteLength !== opened.size || after.dev !== opened.dev ||
      after.ino !== opened.ino || after.size !== opened.size ||
      after.mode !== opened.mode || after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs) {
      fail("Company state file changed while it was read");
    }
    return { bytes, stats: opened };
  } finally {
    await handle?.close();
  }
}

function decode(bytes: Uint8Array, label: string): string {
  try {
    return decoder.decode(bytes);
  } catch (error) {
    fail(`${label} contains invalid UTF-8`, error);
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

async function appendSecure(
  file: string,
  content: string,
  expected: Stats,
  maximumBytes: number,
): Promise<void> {
  if (expected.size + Buffer.byteLength(content, "utf8") > maximumBytes) {
    fail("Company state log exceeds its byte limit");
  }
  let handle;
  try {
    handle = await open(
      file,
      constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
    );
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== expected.dev ||
      opened.ino !== expected.ino || opened.size !== expected.size ||
      opened.mode !== expected.mode) {
      fail("Company state log changed before append");
    }
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function truncateSecure(
  file: string,
  size: number,
  expected: Stats,
): Promise<void> {
  let handle;
  try {
    handle = await open(file, constants.O_RDWR | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (opened.dev !== expected.dev || opened.ino !== expected.ino ||
      opened.size !== expected.size || opened.mode !== expected.mode) {
      fail("Company state log changed before repair");
    }
    await handle.truncate(size);
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

export class PrivateImmutableJsonStore<T> {
  readonly directory: string;
  #publicationTail: Promise<void> = Promise.resolve();

  constructor(directory: string, private readonly options: ImmutableOptions<T>) {
    this.directory = path.resolve(directory);
  }

  #file(id: string): string {
    validateId(id);
    return path.join(this.directory, `${id}.json`);
  }

  #parse(bytes: Uint8Array): T {
    try {
      return this.options.parse(JSON.parse(decode(bytes, this.options.label)));
    } catch (error) {
      fail(`${this.options.label} record is invalid`, error);
    }
  }

  async create(input: T, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const value = this.options.parse(structuredClone(input));
    const id = this.options.idOf(value);
    validateId(id);
    const content = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(content, "utf8") > this.options.maximumBytes) {
      fail(`${this.options.label} record exceeds its byte limit`);
    }
    const publication = this.#publicationTail.then(async () => {
      signal?.throwIfAborted();
      await requireCanonicalAncestor(this.directory);
      await requireDirectory(this.directory);
      if (!await publishExclusive(this.directory, this.#file(id), content)) {
        const existing = await this.load(id, signal);
        if (!isDeepStrictEqual(existing, value)) {
          throw new CompanyStateStoreError(
            "conflict",
            `${this.options.label} ${id} already contains different content`,
          );
        }
      }
    });
    this.#publicationTail = publication.catch(() => undefined);
    await publication;
  }

  async load(id: string, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const file = this.#file(id);
    if (!await inspectDirectory(this.directory)) {
      throw new CompanyStateStoreError("not_found", `${this.options.label} not found`);
    }
    if (await realpath(this.directory) !== this.directory) {
      fail("Company state storage must use its canonical path");
    }
    const read = await readSecure(file, this.options.maximumBytes, true);
    if (read === null) {
      throw new CompanyStateStoreError("not_found", `${this.options.label} not found`);
    }
    return this.#parse(read.bytes);
  }

  async list(signal?: AbortSignal): Promise<readonly T[]> {
    signal?.throwIfAborted();
    if (!await inspectDirectory(this.directory)) return Object.freeze([]);
    if (await realpath(this.directory) !== this.directory) {
      fail("Company state storage must use its canonical path");
    }
    const entries = await readdir(this.directory, { withFileTypes: true });
    const ids = entries.filter((entry) => !entry.name.startsWith(".")).map((entry) => {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        fail("Company state storage contains an unexpected entry");
      }
      const id = entry.name.slice(0, -5);
      validateId(id);
      return id;
    }).sort();
    if (ids.length > this.options.maximumRecords) {
      fail("Company state storage contains too many records");
    }
    const values: T[] = [];
    for (const id of ids) values.push(await this.load(id, signal));
    return Object.freeze(values);
  }
}

interface JsonlRecord<T> {
  readonly version: 1;
  readonly id: string;
  readonly sequence: number;
  readonly state: T;
}

export class PrivateJsonlStateStore<T> {
  readonly directory: string;

  constructor(directory: string, private readonly options: JsonlOptions<T>) {
    this.directory = path.resolve(directory);
  }

  #file(id: string): string {
    validateId(id);
    return path.join(this.directory, `${id}.jsonl`);
  }

  #records(serialized: string, expectedId: string): JsonlRecord<T>[] {
    if (!serialized.endsWith("\n")) {
      fail(`${this.options.label} has an undurable final record`);
    }
    const lines = serialized.slice(0, -1).split("\n");
    if (lines.length === 1 && lines[0] === "") {
      fail(`${this.options.label} has no records`);
    }
    return lines.map((line, sequence) => {
      let input: unknown;
      try {
        input = JSON.parse(line);
      } catch (error) {
        fail(`${this.options.label} record is invalid JSON`, error);
      }
      if (typeof input !== "object" || input === null || Array.isArray(input)) {
        fail(`${this.options.label} record must be an object`);
      }
      const record = input as Record<string, unknown>;
      if (Object.keys(record).sort().join(",") !== "id,sequence,state,version" ||
        record.version !== 1 || record.id !== expectedId ||
        record.sequence !== sequence) {
        fail(`${this.options.label} record identity or sequence is invalid`);
      }
      const state = this.options.parse(record.state);
      if (this.options.idOf(state) !== expectedId) {
        fail(`${this.options.label} state identity is invalid`);
      }
      if (sequence > 0) {
        try {
          this.options.validateTransition?.(
            this.options.parse(
              (JSON.parse(lines[sequence - 1]!) as { state: unknown }).state,
            ),
            state,
          );
        } catch (error) {
          fail(`${this.options.label} transition history is invalid`, error);
        }
      }
      return { version: 1, id: expectedId, sequence, state };
    });
  }

  async #read(id: string, repair: boolean): Promise<{
    readonly records: JsonlRecord<T>[];
    readonly read: SecureRead;
  }> {
    const file = this.#file(id);
    const read = await readSecure(file, this.options.maximumBytes, true);
    if (read === null) {
      throw new CompanyStateStoreError("not_found", `${this.options.label} not found`);
    }
    const serialized = decode(read.bytes, this.options.label);
    if (serialized.endsWith("\n")) {
      return { records: this.#records(serialized, id), read };
    }
    if (!repair) fail(`${this.options.label} has an undurable final record`);
    const prefixLength = read.bytes.lastIndexOf(0x0a) + 1;
    if (prefixLength === 0) fail(`${this.options.label} has no durable boundary`);
    const prefix = decode(read.bytes.subarray(0, prefixLength), this.options.label);
    const records = this.#records(prefix, id);
    await truncateSecure(file, prefixLength, read.stats);
    return {
      records,
      read: (await readSecure(file, this.options.maximumBytes, false))!,
    };
  }

  create(input: T, signal?: AbortSignal): Promise<SequencedCompanyState<T>> {
    const id = this.options.idOf(input);
    return serializeMutation(this.#file(id), () => this.#create(input, signal));
  }

  async #create(input: T, signal?: AbortSignal): Promise<SequencedCompanyState<T>> {
    signal?.throwIfAborted();
    const state = this.options.parse(structuredClone(input));
    const id = this.options.idOf(state);
    validateId(id);
    await prepareMutationRoot(this.directory, id);
    const lock = await acquireSessionLock(this.directory, id);
    try {
      if (await readSecure(this.#file(id), this.options.maximumBytes, true) !== null) {
        throw new CompanyStateStoreError("conflict", `${this.options.label} exists`);
      }
      const record: JsonlRecord<T> = { version: 1, id, sequence: 0, state };
      const content = `${JSON.stringify(record)}\n`;
      if (Buffer.byteLength(content, "utf8") > this.options.maximumBytes) {
        fail(`${this.options.label} exceeds its byte limit`);
      }
      let handle;
      try {
        handle = await open(this.#file(id), "wx", FILE_MODE);
        await handle.writeFile(content, "utf8");
        await handle.sync();
      } catch (error) {
        if (errorCode(error) === "EEXIST") {
          throw new CompanyStateStoreError("conflict", `${this.options.label} exists`);
        }
        throw error;
      } finally {
        await handle?.close();
      }
      await syncDirectory(this.directory);
      return Object.freeze({ sequence: 0, state });
    } finally {
      await lock.release();
    }
  }

  append(
    id: string,
    expectedSequence: number,
    input: T,
    signal?: AbortSignal,
  ): Promise<SequencedCompanyState<T>> {
    return serializeMutation(
      this.#file(id),
      () => this.#append(id, expectedSequence, input, signal),
    );
  }

  async #append(
    id: string,
    expectedSequence: number,
    input: T,
    signal?: AbortSignal,
  ): Promise<SequencedCompanyState<T>> {
    signal?.throwIfAborted();
    validateId(id);
    const state = this.options.parse(structuredClone(input));
    if (this.options.idOf(state) !== id) {
      throw new CompanyStateStoreError("conflict", `${this.options.label} id changed`);
    }
    await prepareMutationRoot(this.directory, id);
    const lock = await acquireSessionLock(this.directory, id);
    try {
      const current = await this.#read(id, true);
      const previous = current.records.at(-1)!;
      if (!Number.isSafeInteger(expectedSequence) ||
        previous.sequence !== expectedSequence) {
        throw new CompanyStateStoreError(
          "sequence_conflict",
          `${this.options.label} expected sequence ${expectedSequence}, received ${previous.sequence}`,
        );
      }
      this.options.validateTransition?.(previous.state, state);
      const sequence = previous.sequence + 1;
      const record: JsonlRecord<T> = { version: 1, id, sequence, state };
      await appendSecure(
        this.#file(id),
        `${JSON.stringify(record)}\n`,
        current.read.stats,
        this.options.maximumBytes,
      );
      return Object.freeze({ sequence, state });
    } finally {
      await lock.release();
    }
  }

  load(
    id: string,
    signal?: AbortSignal,
  ): Promise<SequencedCompanyState<T>> {
    return serializeMutation(this.#file(id), () => this.#load(id, signal));
  }

  loadReadOnly(
    id: string,
    signal?: AbortSignal,
  ): Promise<SequencedCompanyState<T>> {
    return serializeMutation(this.#file(id), async () => {
      signal?.throwIfAborted();
      validateId(id);
      if (!await inspectDirectory(this.directory)) {
        throw new CompanyStateStoreError(
          "not_found",
          `${this.options.label} not found`,
        );
      }
      const read = await this.#read(id, false);
      const last = read.records.at(-1)!;
      return Object.freeze({ sequence: last.sequence, state: last.state });
    });
  }

  async #load(
    id: string,
    signal?: AbortSignal,
  ): Promise<SequencedCompanyState<T>> {
    signal?.throwIfAborted();
    validateId(id);
    if (!await inspectDirectory(this.directory)) {
      throw new CompanyStateStoreError("not_found", `${this.options.label} not found`);
    }
    try {
      const read = await this.#read(id, false);
      const last = read.records.at(-1)!;
      return Object.freeze({ sequence: last.sequence, state: last.state });
    } catch (error) {
      if (!(error instanceof CompanyStateStoreError) || error.code !== "corrupt" ||
        !error.message.includes("undurable final record")) throw error;
      await prepareMutationRoot(this.directory, id);
      const lock = await acquireSessionLock(this.directory, id);
      try {
        const repaired = await this.#read(id, true);
        const last = repaired.records.at(-1)!;
        return Object.freeze({ sequence: last.sequence, state: last.state });
      } finally {
        await lock.release();
      }
    }
  }

  async list(signal?: AbortSignal): Promise<readonly SequencedCompanyState<T>[]> {
    signal?.throwIfAborted();
    if (!await inspectDirectory(this.directory)) return Object.freeze([]);
    const entries = await readdir(this.directory, { withFileTypes: true });
    const ids = entries
      .filter((entry) => !entry.name.startsWith("."))
      .map((entry) => {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
          fail("Company state storage contains an unexpected entry");
        }
        const id = entry.name.slice(0, -6);
        validateId(id);
        return id;
      })
      .sort();
    if (ids.length > this.options.maximumRecords) {
      fail("Company state storage contains too many records");
    }
    const states: SequencedCompanyState<T>[] = [];
    for (const id of ids) states.push(await this.load(id, signal));
    return Object.freeze(states);
  }
}
