import {
  appendFile,
  mkdir,
  open,
  readFile,
} from "node:fs/promises";
import path from "node:path";

import type { SessionRecord } from "./events.js";
import { reduceSessionRecords, type SessionState } from "./session.js";

export type SessionStoreErrorCode =
  | "invalid_session_id"
  | "session_not_found"
  | "session_mismatch"
  | "unsupported_version"
  | "invalid_record"
  | "corrupt_log";

export class SessionStoreError extends Error {
  constructor(
    public readonly code: SessionStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SessionStoreError";
  }
}

export interface LoadedSessionRecords {
  records: SessionRecord[];
  recoveredPartialRecord: boolean;
}

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
  constructor(private readonly directory: string) {}

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
    await mkdir(this.directory, { recursive: true });
    await appendAndSync(this.#file(sessionId), `${JSON.stringify(record)}\n`);
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

    const records: SessionRecord[] = [];
    for (const [index, line] of lines.entries()) {
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isSessionRecord(parsed, sessionId)) {
          throw new SessionStoreError(
            "invalid_record",
            `Invalid session record at line ${index + 1}`,
          );
        }
        records.push(parsed);
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
}
