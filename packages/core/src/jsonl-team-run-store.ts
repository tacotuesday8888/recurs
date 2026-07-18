import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import type { TeamRunDescriptor } from "@recurs/contracts";

import { acquireSessionLock } from "./session-mutation-lease.js";
import { SessionStoreError } from "./session-store-error.js";
import {
  parseTeamRunRecord,
  reduceTeamRunRecord,
  reduceTeamRunRecords,
  type TeamRunRecord,
  type TeamRunRecordInput,
  type TeamRunState,
} from "./team-run-state.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_LOG_BYTES = 16 * 1024 * 1024;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export interface TeamRunListEntry {
  readonly id: string;
  readonly parentSessionId: string;
  readonly execution: TeamRunDescriptor["execution"];
  readonly operatingModeId: TeamRunDescriptor["operatingModeId"];
  readonly status: TeamRunState["status"];
  readonly phase: TeamRunState["phase"];
  readonly round: number;
  readonly childrenReserved: number;
  readonly childrenFinished: number;
  readonly usageReportedChildren: number;
  readonly usageMissingChildren: number;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cachedInputTokens?: number;
    readonly cacheWriteInputTokens?: number;
    readonly reasoningTokens?: number;
  } | null;
  readonly reportedCostUsd: number | null;
  readonly costCoverage: TeamRunState["accounting"]["costCoverage"];
  readonly manualAttentionRequired: boolean;
  readonly updatedAt: string;
  readonly lastSequence: number;
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error &&
      typeof error.code === "string"
    ? error.code
    : null;
}

function invalidRunId(runId: string): never {
  throw new SessionStoreError(
    "invalid_session_id",
    `Invalid team run id: ${runId}`,
  );
}

function validatePrivateDirectory(
  directory: string,
  details: Awaited<ReturnType<typeof lstat>>,
): void {
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new SessionStoreError(
      "corrupt_log",
      `Team run storage must be a real directory, not a symbolic link: ${directory}`,
    );
  }
  if ((Number(details.mode) & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    throw new SessionStoreError(
      "corrupt_log",
      `Team run storage must have private 0700 permissions: ${directory}`,
    );
  }
}

async function inspectPrivateDirectory(directory: string): Promise<boolean> {
  let details;
  try {
    details = await lstat(directory);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
  validatePrivateDirectory(directory, details);
  return true;
}

async function requirePrivateDirectory(directory: string): Promise<void> {
  let details;
  try {
    details = await lstat(directory);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    details = await lstat(directory);
  }
  validatePrivateDirectory(directory, details);
}

async function requirePrivateFile(file: string, allowMissing: boolean): Promise<boolean> {
  let details;
  try {
    details = await lstat(file);
  } catch (error) {
    if (allowMissing && errorCode(error) === "ENOENT") return false;
    throw error;
  }
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new SessionStoreError(
      "corrupt_log",
      `Team run log must be a regular file, not a symbolic link: ${file}`,
    );
  }
  if ((details.mode & 0o777) !== PRIVATE_FILE_MODE) {
    throw new SessionStoreError(
      "corrupt_log",
      `Team run log must have private 0600 permissions: ${file}`,
    );
  }
  return true;
}

async function appendAndSync(file: string, serialized: string): Promise<void> {
  const current = await lstat(file);
  if (Number(current.size) + Buffer.byteLength(serialized, "utf8") > MAX_LOG_BYTES) {
    throw new SessionStoreError(
      "invalid_record",
      `Team run log exceeds ${MAX_LOG_BYTES} bytes`,
    );
  }
  const handle = await open(file, "a", PRIVATE_FILE_MODE);
  try {
    await handle.appendFile(serialized, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function truncateAndSync(file: string, byteLength: number): Promise<void> {
  const handle = await open(file, "r+", PRIVATE_FILE_MODE);
  try {
    await handle.truncate(byteLength);
    await handle.sync();
  } finally {
    await handle.close();
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

function decodeUtf8(bytes: Uint8Array, runId: string): string {
  if (bytes.byteLength > MAX_LOG_BYTES) {
    throw new SessionStoreError(
      "corrupt_log",
      `Team run ${runId} exceeds ${MAX_LOG_BYTES} bytes`,
    );
  }
  try {
    return utf8Decoder.decode(bytes);
  } catch (error) {
    throw new SessionStoreError(
      "corrupt_log",
      `Team run ${runId} contains invalid UTF-8`,
      { cause: error },
    );
  }
}

function requireBoundedLog(bytes: Uint8Array, runId: string): void {
  if (bytes.byteLength > MAX_LOG_BYTES) {
    throw new SessionStoreError(
      "corrupt_log",
      `Team run ${runId} exceeds ${MAX_LOG_BYTES} bytes`,
    );
  }
}

function parseDurableLines(serialized: string, runId: string): TeamRunState {
  if (!serialized.endsWith("\n")) {
    throw new SessionStoreError(
      "corrupt_log",
      `Team run ${runId} has an undurable final record`,
    );
  }
  const lines = serialized.slice(0, -1).split("\n");
  if (lines.length === 1 && lines[0] === "") {
    throw new SessionStoreError(
      "corrupt_log",
      `Team run ${runId} has no durable records`,
    );
  }
  const records: TeamRunRecord[] = lines.map((line, index) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new SessionStoreError(
        "corrupt_log",
        `Corrupt team run record at line ${index + 1}`,
        { cause: error },
      );
    }
    const record = parseTeamRunRecord(value, runId);
    if (record.sequence !== index) {
      throw new SessionStoreError(
        "invalid_record",
        `Expected team run sequence ${index} at line ${index + 1}`,
      );
    }
    return record;
  });
  return reduceTeamRunRecords(records);
}

export class JsonlTeamRunStore {
  readonly directory: string;

  constructor(directory: string) {
    this.directory = path.resolve(directory);
  }

  #file(runId: string): string {
    if (!SAFE_RUN_ID.test(runId)) invalidRunId(runId);
    return path.join(this.directory, `${runId}.jsonl`);
  }

  async #prepareMutationRoot(runId: string): Promise<void> {
    await requirePrivateDirectory(this.directory);
    await requirePrivateDirectory(path.join(this.directory, ".locks"));
    await requirePrivateDirectory(path.join(this.directory, ".fences"));
    const fence = path.join(this.directory, ".fences", `${runId}.fence`);
    await requirePrivateFile(fence, true);
    const lock = path.join(this.directory, ".locks", `${runId}.lock`);
    let lockDetails;
    try {
      lockDetails = await lstat(lock);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    if (lockDetails !== undefined) {
      validatePrivateDirectory(lock, lockDetails);
      await requirePrivateFile(path.join(lock, "owner"), false);
    }
  }

  async #readAndRepairUnderLock(runId: string): Promise<TeamRunState> {
    const file = this.#file(runId);
    const exists = await requirePrivateFile(file, true);
    if (!exists) {
      throw new SessionStoreError(
        "session_not_found",
        `Team run not found: ${runId}`,
      );
    }
    const bytes = await readFile(file);
    requireBoundedLog(bytes, runId);
    if (bytes.at(-1) === 0x0a) {
      return parseDurableLines(decodeUtf8(bytes, runId), runId);
    }

    const prefixLength = bytes.lastIndexOf(0x0a) + 1;
    if (prefixLength === 0) {
      throw new SessionStoreError(
        "corrupt_log",
        `Team run ${runId} has no durable record boundary`,
      );
    }
    const prefix = decodeUtf8(bytes.subarray(0, prefixLength), runId);
    const state = parseDurableLines(prefix, runId);
    await truncateAndSync(file, prefixLength);
    return state;
  }

  async create(descriptor: TeamRunDescriptor, at: string): Promise<TeamRunState> {
    const file = this.#file(descriptor.id);
    await this.#prepareMutationRoot(descriptor.id);
    const lock = await acquireSessionLock(this.directory, descriptor.id);
    try {
      if (await requirePrivateFile(file, true)) {
        throw new SessionStoreError(
          "session_conflict",
          `Team run already exists: ${descriptor.id}`,
        );
      }
      const record = parseTeamRunRecord({
        version: 1,
        runId: descriptor.id,
        sequence: 0,
        type: "team_created",
        descriptor,
        at,
      }, descriptor.id);
      const state = reduceTeamRunRecords([record]);
      let handle;
      try {
        handle = await open(file, "wx", PRIVATE_FILE_MODE);
      } catch (error) {
        if (errorCode(error) === "EEXIST") {
          throw new SessionStoreError(
            "session_conflict",
            `Team run already exists: ${descriptor.id}`,
          );
        }
        throw error;
      }
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await requirePrivateFile(file, false);
      await syncDirectory(this.directory);
      return state;
    } finally {
      await lock.release();
    }
  }

  async append(
    runId: string,
    expectedSequence: number,
    input: TeamRunRecordInput,
  ): Promise<TeamRunState> {
    this.#file(runId);
    if (!Number.isSafeInteger(expectedSequence) || expectedSequence < 0) {
      throw new SessionStoreError(
        "session_conflict",
        `Invalid expected team run sequence: ${expectedSequence}`,
      );
    }
    await this.#prepareMutationRoot(runId);
    const lock = await acquireSessionLock(this.directory, runId);
    try {
      const current = await this.#readAndRepairUnderLock(runId);
      if (current.lastSequence !== expectedSequence) {
        throw new SessionStoreError(
          "session_conflict",
          `Expected team run sequence ${expectedSequence}, received ${current.lastSequence}`,
        );
      }
      const record = {
        ...input,
        version: 1,
        runId,
        sequence: expectedSequence + 1,
      } as TeamRunRecord;
      const next = reduceTeamRunRecord(current, record);
      await appendAndSync(this.#file(runId), `${JSON.stringify(record)}\n`);
      return next;
    } finally {
      await lock.release();
    }
  }

  async load(runId: string): Promise<TeamRunState> {
    this.#file(runId);
    if (!await inspectPrivateDirectory(this.directory)) {
      throw new SessionStoreError(
        "session_not_found",
        `Team run not found: ${runId}`,
      );
    }
    const file = this.#file(runId);
    const exists = await requirePrivateFile(file, true);
    if (!exists) {
      throw new SessionStoreError(
        "session_not_found",
        `Team run not found: ${runId}`,
      );
    }
    const bytes = await readFile(file);
    requireBoundedLog(bytes, runId);
    if (bytes.at(-1) === 0x0a) {
      return parseDurableLines(decodeUtf8(bytes, runId), runId);
    }

    await this.#prepareMutationRoot(runId);
    const lock = await acquireSessionLock(this.directory, runId);
    try {
      return await this.#readAndRepairUnderLock(runId);
    } finally {
      await lock.release();
    }
  }

  async list(parentSessionId?: string): Promise<readonly TeamRunListEntry[]> {
    if (!await inspectPrivateDirectory(this.directory)) return [];
    const entries = await readdir(this.directory, { withFileTypes: true });
    const states: TeamRunState[] = [];
    for (const entry of entries
      .filter((candidate) => candidate.name.endsWith(".jsonl"))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new SessionStoreError(
          "corrupt_log",
          `Team run log must be a regular file: ${entry.name}`,
        );
      }
      const runId = entry.name.slice(0, -".jsonl".length);
      if (!SAFE_RUN_ID.test(runId)) invalidRunId(runId);
      const state = await this.load(runId);
      if (parentSessionId === undefined ||
        state.descriptor.parentSessionId === parentSessionId) {
        states.push(state);
      }
    }
    return states.map((state): TeamRunListEntry => ({
      id: state.descriptor.id,
      parentSessionId: state.descriptor.parentSessionId,
      execution: state.descriptor.execution,
      operatingModeId: state.descriptor.operatingModeId,
      status: state.status,
      phase: state.phase,
      round: state.round,
      childrenReserved: state.accounting.childrenReserved,
      childrenFinished: state.accounting.childrenFinished,
      usageReportedChildren: state.accounting.usageReportedChildren,
      usageMissingChildren: state.accounting.usageMissingChildren,
      usage: state.accounting.usage === null ? null : {
        inputTokens: state.accounting.usage.inputTokens,
        outputTokens: state.accounting.usage.outputTokens,
        ...(state.accounting.usage.cachedInputTokens === undefined ? {} : {
          cachedInputTokens: state.accounting.usage.cachedInputTokens,
        }),
        ...(state.accounting.usage.cacheWriteInputTokens === undefined ? {} : {
          cacheWriteInputTokens: state.accounting.usage.cacheWriteInputTokens,
        }),
        ...(state.accounting.usage.reasoningTokens === undefined ? {} : {
          reasoningTokens: state.accounting.usage.reasoningTokens,
        }),
      },
      reportedCostUsd: state.accounting.reportedCostUsd,
      costCoverage: state.accounting.costCoverage,
      manualAttentionRequired:
        state.interruption?.manualAttentionRequired ?? false,
      updatedAt: state.updatedAt,
      lastSequence: state.lastSequence,
    })).sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) ||
      left.id.localeCompare(right.id)
    );
  }
}
