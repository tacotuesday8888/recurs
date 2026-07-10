import {
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
} from "node:fs/promises";
import path from "node:path";

import type { SessionBackendPin } from "@recurs/contracts";

import type { AnySessionRecord, SessionRecord } from "./events.js";
import { parseSessionRecordV2 } from "./session-record-validator.js";
import { acquireSessionLock } from "./session-mutation-lease.js";
import type {
  PinnedSessionState,
  SessionRecordInputV2,
  SessionRecordV2,
} from "./session-v2.js";
import { isPinnedSessionState } from "./session-v2.js";
import { reduceSessionRecords, type SessionState } from "./session.js";
import { SessionStoreError } from "./session-store-error.js";

export { SessionStoreError } from "./session-store-error.js";
export type { SessionStoreErrorCode } from "./session-store-error.js";

export interface LoadedSessionRecords {
  records: AnySessionRecord[];
  recoveredPartialRecord: boolean;
}

export interface SessionListEntry {
  id: string;
  cwd: string;
  model: string;
  updatedAt: string;
  version: 1 | 2;
}

export interface CreatePinnedSessionOptions {
  id: string;
  cwd: string;
  backend: SessionBackendPin;
  at: string;
}

export interface SessionMutationLease {
  readonly sessionId: string;
  readonly fencingToken: number;
  readonly currentSequence: number;
  append(record: SessionRecordInputV2): Promise<SessionRecordV2>;
}

const activeSessionRuns = new Set<string>();

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
  value: Record<string, unknown>,
  key: string,
): boolean {
  return typeof value[key] === "string";
}

function isSessionRecord(value: unknown, sessionId: string): value is SessionRecord {
  if (!isObject(value)) {
    return false;
  }
  if (value.version !== 1) {
    throw new SessionStoreError(
      "unsupported_version",
      `Unsupported session record version: ${String(value.version)}`,
    );
  }
  if (value.sessionId !== sessionId) {
    throw new SessionStoreError(
      "session_mismatch",
      `Expected session ${sessionId}, received ${String(value.sessionId)}`,
    );
  }
  if (!requireString(value, "at") || !requireString(value, "type")) {
    return false;
  }

  switch (value.type) {
    case "session_created":
      return requireString(value, "cwd") && requireString(value, "model");
    case "turn_started":
      return requireString(value, "turnId") && requireString(value, "prompt");
    case "message_appended":
      return isObject(value.message);
    case "session_compacted":
      return (
        requireString(value, "summary") &&
        Array.isArray(value.retainedMessages) &&
        value.retainedMessages.every(isObject)
      );
    case "tool_started":
      return isObject(value.call);
    case "tool_completed":
      return requireString(value, "callId") && isObject(value.result);
    case "tool_failed":
      return requireString(value, "callId") && isObject(value.error);
    case "permission_resolved":
      return isObject(value.intent) && requireString(value, "decision");
    case "goal_updated":
      return value.goal === null || isObject(value.goal);
    case "mode_updated":
      return (
        (value.executionMode === "act" || value.executionMode === "plan") &&
        (value.permissionMode === "ask_always" ||
          value.permissionMode === "approved_for_me" ||
          value.permissionMode === "full_access")
      );
    case "files_changed":
      return Array.isArray(value.paths) && value.paths.every((item) => typeof item === "string");
    case "verification_recorded":
      return (
        Array.isArray(value.evidence) &&
        value.evidence.every((item) => typeof item === "string")
      );
    case "turn_completed":
      return isObject(value.usage) && Array.isArray(value.evidence);
    case "turn_failed":
      return isObject(value.error);
    default:
      return false;
  }
}

async function appendAndSync(file: string, content: string): Promise<void> {
  const handle = await open(file, "a", 0o600);
  try {
    await handle.appendFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function replaceAndSync(file: string, content: string): Promise<void> {
  const handle = await open(file, "w", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class JsonlSessionStore {
  readonly directory: string;

  constructor(directory: string) {
    this.directory = path.resolve(directory);
  }

  #file(sessionId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(sessionId)) {
      throw new SessionStoreError(
        "invalid_session_id",
        `Invalid session id: ${sessionId}`,
      );
    }
    return path.join(this.directory, `${sessionId}.jsonl`);
  }

  async append(sessionId: string, record: SessionRecord): Promise<void> {
    if (record.sessionId !== sessionId) {
      throw new SessionStoreError(
        "session_mismatch",
        `Cannot append record for ${record.sessionId} to ${sessionId}`,
      );
    }
    const existing = await this.load(sessionId);
    if (existing.records[0]?.version === 2) {
      throw new SessionStoreError(
        "legacy_read_only",
        `Version 2 session ${sessionId} requires a mutation lease`,
      );
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await appendAndSync(this.#file(sessionId), `${JSON.stringify(record)}\n`);
  }

  async createPinnedSession(
    options: CreatePinnedSessionOptions,
  ): Promise<PinnedSessionState> {
    const file = this.#file(options.id);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lock = await acquireSessionLock(this.directory, options.id);
    try {
      const existing = await this.load(options.id);
      if (existing.records.length > 0) {
        throw new SessionStoreError(
          "session_conflict",
          `Session already exists: ${options.id}`,
        );
      }
      const created: SessionRecordV2 = {
        version: 2,
        type: "session_created",
        sessionId: options.id,
        sequence: 0,
        at: options.at,
        cwd: options.cwd,
        backend: options.backend,
      };
      parseSessionRecordV2(created, options.id);
      await appendAndSync(file, `${JSON.stringify(created)}\n`);
      const state = await this.loadState(options.id);
      if (!isPinnedSessionState(state)) {
        throw new SessionStoreError(
          "corrupt_log",
          `Expected pinned session ${options.id}`,
        );
      }
      return state;
    } finally {
      await lock.release();
    }
  }

  async withSessionMutation<T>(
    sessionId: string,
    expectedSequence: number,
    operation: (lease: SessionMutationLease) => Promise<T>,
  ): Promise<T> {
    if (!Number.isSafeInteger(expectedSequence) || expectedSequence < 0) {
      throw new SessionStoreError(
        "session_conflict",
        `Invalid expected sequence: ${expectedSequence}`,
      );
    }
    const lock = await acquireSessionLock(this.directory, sessionId);
    let active = true;
    try {
      const loaded = await this.load(sessionId);
      const first = loaded.records[0];
      const last = loaded.records.at(-1);
      if (first === undefined || last === undefined) {
        throw new SessionStoreError(
          "session_not_found",
          `Session not found: ${sessionId}`,
        );
      }
      if (first.version !== 2 || last.version !== 2) {
        throw new SessionStoreError(
          "legacy_read_only",
          `Legacy session ${sessionId} is read-only`,
        );
      }
      if (last.sequence !== expectedSequence) {
        throw new SessionStoreError(
          "session_conflict",
          `Expected session sequence ${expectedSequence}, received ${last.sequence}`,
        );
      }
      let currentSequence = last.sequence;
      const lease: SessionMutationLease = {
        sessionId,
        fencingToken: lock.fencingToken,
        get currentSequence() {
          return currentSequence;
        },
        append: async (input) => {
          if (!active) {
            throw new SessionStoreError(
              "session_conflict",
              `Mutation lease for ${sessionId} is no longer active`,
            );
          }
          if (input.type === "session_created") {
            throw new SessionStoreError(
              "invalid_record",
              "session_created may appear only at sequence zero",
            );
          }
          const record = {
            ...input,
            version: 2,
            sessionId,
            sequence: currentSequence + 1,
          } as SessionRecordV2;
          parseSessionRecordV2(record, sessionId);
          await appendAndSync(this.#file(sessionId), `${JSON.stringify(record)}\n`);
          currentSequence = record.sequence;
          return record;
        },
      };
      return await operation(lease);
    } finally {
      active = false;
      await lock.release();
    }
  }

  async withSessionRun<T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = this.#file(sessionId);
    if (activeSessionRuns.has(key)) {
      throw new SessionStoreError(
        "session_busy",
        `Session ${sessionId} already has an active run`,
      );
    }
    activeSessionRuns.add(key);
    try {
      return await operation();
    } finally {
      activeSessionRuns.delete(key);
    }
  }

  async load(sessionId: string): Promise<LoadedSessionRecords> {
    const file = this.#file(sessionId);
    let serialized: string;
    try {
      serialized = await readFile(file, "utf8");
    } catch (error) {
      if (isObject(error) && error.code === "ENOENT") {
        return { records: [], recoveredPartialRecord: false };
      }
      throw error;
    }

    const hasTerminatingNewline = serialized.endsWith("\n");
    const lines = serialized.split("\n");
    if (lines.at(-1) === "") {
      lines.pop();
    }

    const records: AnySessionRecord[] = [];
    for (const [index, line] of lines.entries()) {
      try {
        const parsed: unknown = JSON.parse(line);
        const record = isObject(parsed) && parsed.version === 2
          ? parseSessionRecordV2(parsed, sessionId)
          : isSessionRecord(parsed, sessionId)
            ? parsed
            : null;
        if (record === null) {
          throw new SessionStoreError(
            "invalid_record",
            `Invalid session record at line ${index + 1}`,
          );
        }
        const previous = records.at(-1);
        if (previous !== undefined && previous.version !== record.version) {
          throw new SessionStoreError(
            "invalid_record",
            `Mixed session record versions at line ${index + 1}`,
          );
        }
        if (record.version === 2 && record.sequence !== index) {
          throw new SessionStoreError(
            "invalid_record",
            `Expected sequence ${index} at line ${index + 1}`,
          );
        }
        records.push(record);
      } catch (error) {
        const isPartialTrailingRecord =
          index === lines.length - 1 && !hasTerminatingNewline;
        if (!isPartialTrailingRecord) {
          if (error instanceof SessionStoreError) {
            throw error;
          }
          throw new SessionStoreError(
            "corrupt_log",
            `Corrupt session record at line ${index + 1}`,
            { cause: error },
          );
        }

        await appendFile(`${file}.quarantine`, `${line}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        const recovered = lines.slice(0, index).join("\n");
        await replaceAndSync(file, recovered.length > 0 ? `${recovered}\n` : "");
        return { records, recoveredPartialRecord: true };
      }
    }

    return { records, recoveredPartialRecord: false };
  }

  async loadState(sessionId: string): Promise<SessionState> {
    const loaded = await this.load(sessionId);
    if (loaded.records.length === 0) {
      throw new SessionStoreError(
        "session_not_found",
        `Session not found: ${sessionId}`,
      );
    }
    try {
      return reduceSessionRecords(loaded.records);
    } catch (error) {
      throw new SessionStoreError(
        "corrupt_log",
        `Cannot restore session ${sessionId}`,
        { cause: error },
      );
    }
  }

  async list(): Promise<SessionListEntry[]> {
    let files: string[];
    try {
      files = (await readdir(this.directory))
        .filter((file) => file.endsWith(".jsonl"))
        .sort((left, right) => left.localeCompare(right));
    } catch (error) {
      if (isObject(error) && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const entries: SessionListEntry[] = [];
    for (const file of files) {
      const id = file.slice(0, -".jsonl".length);
      const loaded = await this.load(id);
      const first = loaded.records[0];
      const last = loaded.records.at(-1);
      if (first?.type !== "session_created" || last === undefined) {
        throw new SessionStoreError(
          "corrupt_log",
          `Cannot list malformed session ${id}`,
        );
      }
      entries.push({
        id,
        cwd: first.cwd,
        model: first.version === 1 ? first.model : first.backend.modelId,
        updatedAt: last.at,
        version: first.version,
      });
    }
    return entries.sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
  }
}
