import { randomUUID } from "node:crypto";

import {
  startPtyProcessSession,
  startProcessSession,
  type PtyDriver,
  type PtySize,
  type ProcessSession,
  type ProcessSessionOptions,
} from "./process.js";
import type { Checkpoint, CheckpointStore } from "./checkpoints.js";
import { ToolError, type ToolErrorCode } from "./types.js";

const DEFAULT_MAX_ACTIVE_SESSIONS = 4;
const MAX_ACTIVE_SESSIONS = 16;

export type OwnedProcessStatus = "running" | "exited" | "failed";

export interface OwnedProcessSnapshot {
  readonly sessionId: string;
  readonly status: OwnedProcessStatus;
  readonly output: string;
  readonly terminal: boolean;
  readonly exitCode?: number;
  readonly checkpointId?: string;
  readonly evidence?: readonly string[];
  readonly failure?: {
    readonly code: ToolErrorCode;
    readonly message: string;
  };
}

export interface OwnedProcessSummary {
  readonly sessionId: string;
  readonly status: OwnedProcessStatus;
  readonly terminal: boolean;
  readonly bufferedOutputBytes: number;
  readonly exitCode?: number;
  readonly failureCode?: ToolErrorCode;
}

interface OwnedProcessRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly process: ProcessSession;
  output: string;
  status: OwnedProcessStatus;
  exitCode?: number;
  checkpointId?: string;
  readonly terminalEvidence: readonly string[];
  readonly terminal: boolean;
  failure?: ToolError;
  revision: number;
  finalization: Promise<void>;
  readonly waiters: Set<() => void>;
}

export interface OwnedProcessManagerOptions {
  readonly maxActiveSessions?: number;
  readonly createId?: () => string;
  readonly startSession?: typeof startProcessSession;
  readonly ptyDriver?: PtyDriver;
  readonly startTerminalSession?: (
    command: string,
    args: readonly string[],
    options: ProcessSessionOptions,
    size: PtySize,
  ) => Promise<ProcessSession>;
  readonly checkpoints?: CheckpointStore;
}

export interface StartOwnedProcessInput {
  readonly ownerId: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly options: ProcessSessionOptions;
  readonly yieldTimeMs: number;
  readonly terminal?: PtySize;
  readonly terminalEvidence?: readonly string[];
}

export interface InteractWithOwnedProcessInput {
  readonly ownerId: string;
  readonly sessionId: string;
  readonly input?: string;
  readonly closeStdin?: boolean;
  readonly stop?: boolean;
  readonly resize?: PtySize;
  readonly yieldTimeMs: number;
}

function safeProcessFailure(error: unknown): ToolError {
  return error instanceof ToolError
    ? error
    : new ToolError("process_failed", "The process session failed");
}

export class OwnedProcessManager {
  readonly #records = new Map<string, OwnedProcessRecord>();
  readonly #maxActiveSessions: number;
  readonly #createId: () => string;
  readonly #startSession: typeof startProcessSession;
  readonly #startTerminalSession: OwnedProcessManagerOptions["startTerminalSession"];
  readonly #checkpoints: CheckpointStore | undefined;
  readonly #reservedIds = new Set<string>();
  readonly #pendingStartWaiters = new Set<() => void>();
  #pendingStarts = 0;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(options: OwnedProcessManagerOptions = {}) {
    const maxActiveSessions = options.maxActiveSessions ??
      DEFAULT_MAX_ACTIVE_SESSIONS;
    if (
      !Number.isSafeInteger(maxActiveSessions) ||
      maxActiveSessions < 1 ||
      maxActiveSessions > MAX_ACTIVE_SESSIONS
    ) {
      throw new TypeError(
        `maxActiveSessions must be between 1 and ${MAX_ACTIVE_SESSIONS}`,
      );
    }
    this.#maxActiveSessions = maxActiveSessions;
    this.#createId = options.createId ?? randomUUID;
    this.#startSession = options.startSession ?? startProcessSession;
    const ptyDriver = options.ptyDriver;
    this.#startTerminalSession = options.startTerminalSession ??
      (ptyDriver === undefined
        ? undefined
        : (command, args, sessionOptions, size) =>
          startPtyProcessSession(
            ptyDriver,
            command,
            args,
            sessionOptions,
            size,
          ));
    this.#checkpoints = options.checkpoints;
  }

  get ownsCheckpoints(): boolean {
    return this.#checkpoints !== undefined;
  }

  list(ownerId: string): readonly OwnedProcessSummary[] {
    return [...this.#records.values()]
      .filter((record) => record.ownerId === ownerId)
      .map((record) => ({
        sessionId: record.id,
        status: record.status,
        terminal: record.terminal,
        bufferedOutputBytes: Buffer.byteLength(record.output, "utf8"),
        ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
        ...(record.failure === undefined
          ? {}
          : { failureCode: record.failure.code }),
      }))
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  }

  #notify(record: OwnedProcessRecord): void {
    record.revision += 1;
    for (const resolve of record.waiters) resolve();
    record.waiters.clear();
  }

  #reserveId(): string {
    let id = this.#createId();
    while (this.#records.has(id) || this.#reservedIds.has(id)) {
      id = this.#createId();
    }
    this.#reservedIds.add(id);
    return id;
  }

  #releasePendingStart(id: string): void {
    this.#reservedIds.delete(id);
    this.#pendingStarts -= 1;
    if (this.#pendingStarts === 0) {
      for (const resolve of this.#pendingStartWaiters) resolve();
      this.#pendingStartWaiters.clear();
    }
  }

  async #waitForPendingStarts(): Promise<void> {
    if (this.#pendingStarts === 0) return;
    await new Promise<void>((resolve) => this.#pendingStartWaiters.add(resolve));
  }

  async #completeCheckpoint(
    checkpoint: Checkpoint | undefined,
    cwd: string,
  ): Promise<{
    readonly checkpointId?: string;
    readonly failure?: ToolError;
  }> {
    if (checkpoint === undefined || this.#checkpoints === undefined) {
      return {};
    }
    try {
      const completed = await this.#checkpoints.captureAfter(checkpoint, cwd);
      return { checkpointId: completed.id };
    } catch {
      return {
        failure: new ToolError(
          "checkpoint_storage",
          "The process session checkpoint could not be completed",
        ),
      };
    }
  }

  #ownedRecord(ownerId: string, sessionId: string): OwnedProcessRecord {
    const record = this.#records.get(sessionId);
    if (record === undefined || record.ownerId !== ownerId) {
      throw new ToolError("not_found", "Process session not found");
    }
    return record;
  }

  async #waitForActivity(
    record: OwnedProcessRecord,
    yieldTimeMs: number,
  ): Promise<void> {
    if (
      yieldTimeMs === 0 ||
      record.output.length > 0 ||
      record.status !== "running"
    ) {
      return;
    }
    const revision = record.revision;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        record.waiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, yieldTimeMs);
      record.waiters.add(finish);
      if (record.revision !== revision) finish();
    });
  }

  async #waitForStartYield(
    record: OwnedProcessRecord,
    yieldTimeMs: number,
  ): Promise<void> {
    if (record.status !== "running") return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, yieldTimeMs);
      void record.finalization.then(finish, finish);
    });
  }

  #snapshot(record: OwnedProcessRecord): OwnedProcessSnapshot {
    const output = record.output;
    record.output = "";
    const snapshot: OwnedProcessSnapshot = {
      sessionId: record.id,
      status: record.status,
      output,
      terminal: record.terminal,
      ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
      ...(record.checkpointId === undefined
        ? {}
        : { checkpointId: record.checkpointId }),
      ...(record.status === "exited" &&
          record.exitCode === 0 &&
          record.terminalEvidence.length > 0
        ? { evidence: [...record.terminalEvidence] }
        : {}),
      ...(record.failure === undefined
        ? {}
        : {
            failure: {
              code: record.failure.code,
              message: record.failure.message,
            },
          }),
    };
    if (record.status !== "running") this.#records.delete(record.id);
    return snapshot;
  }

  async start(input: StartOwnedProcessInput): Promise<OwnedProcessSnapshot> {
    if (this.#closed) {
      throw new ToolError("tool_unavailable", "Process sessions are closed");
    }
    if (
      this.#records.size + this.#pendingStarts >= this.#maxActiveSessions
    ) {
      throw new ToolError(
        "execution_failed",
        "The active process session limit has been reached",
      );
    }
    if (input.terminal !== undefined && this.#startTerminalSession === undefined) {
      throw new ToolError(
        "tool_unavailable",
        "Interactive terminal sessions are unavailable in this Recurs build",
      );
    }
    const id = this.#reserveId();
    this.#pendingStarts += 1;
    let checkpoint: Checkpoint | undefined;
    let process: ProcessSession | undefined;
    try {
      checkpoint = await this.#checkpoints?.captureBefore(
        input.ownerId,
        id,
        input.options.cwd,
      );
      process = input.terminal === undefined
        ? await this.#startSession(input.command, input.args, input.options)
        : await this.#startTerminalSession!(
            input.command,
            input.args,
            input.options,
            input.terminal,
          );
      if (this.#closed) {
        await process.close().catch(() => {});
        const checkpointCompletion = await this.#completeCheckpoint(
          checkpoint,
          input.options.cwd,
        );
        if (checkpointCompletion.failure !== undefined) {
          throw checkpointCompletion.failure;
        }
        throw new ToolError("tool_unavailable", "Process sessions are closed");
      }
      const record: OwnedProcessRecord = {
        id,
        ownerId: input.ownerId,
        process,
        output: "",
        status: "running",
        revision: 0,
        terminalEvidence: [...(input.terminalEvidence ?? [])],
        terminal: input.terminal !== undefined,
        finalization: Promise.resolve(),
        waiters: new Set(),
      };
      this.#records.set(id, record);
      process.stdout.setEncoding("utf8");
      process.stderr.setEncoding("utf8");
      const capture = (chunk: string | Buffer): void => {
        record.output += chunk.toString();
        this.#notify(record);
      };
      process.stdout.on("data", capture);
      process.stderr.on("data", capture);
      record.finalization = process.completion.then(
        async (exitCode) => {
          const checkpointCompletion = await this.#completeCheckpoint(
            checkpoint,
            input.options.cwd,
          );
          if (checkpointCompletion.failure === undefined) {
            record.status = "exited";
            record.exitCode = exitCode;
            if (checkpointCompletion.checkpointId !== undefined) {
              record.checkpointId = checkpointCompletion.checkpointId;
            }
          } else {
            record.status = "failed";
            record.failure = checkpointCompletion.failure;
          }
          this.#notify(record);
        },
        async (error: unknown) => {
          const checkpointCompletion = await this.#completeCheckpoint(
            checkpoint,
            input.options.cwd,
          );
          record.status = "failed";
          record.failure = checkpointCompletion.failure ?? safeProcessFailure(error);
          if (checkpointCompletion.checkpointId !== undefined) {
            record.checkpointId = checkpointCompletion.checkpointId;
          }
          this.#notify(record);
        },
      );
      void record.finalization.catch(() => {});
      await this.#waitForStartYield(record, input.yieldTimeMs);
      return this.#snapshot(record);
    } catch (error) {
      if (process === undefined) {
        const checkpointCompletion = await this.#completeCheckpoint(
          checkpoint,
          input.options.cwd,
        );
        if (checkpointCompletion.failure !== undefined) {
          throw checkpointCompletion.failure;
        }
      }
      throw error;
    } finally {
      this.#releasePendingStart(id);
    }
  }

  async interact(
    input: InteractWithOwnedProcessInput,
  ): Promise<OwnedProcessSnapshot> {
    if (this.#closed) {
      throw new ToolError("tool_unavailable", "Process sessions are closed");
    }
    const record = this.#ownedRecord(input.ownerId, input.sessionId);
    if (input.stop === true && record.status === "running") {
      try {
        await record.process.close();
      } catch (error) {
        record.status = "failed";
        record.failure = safeProcessFailure(error);
        this.#notify(record);
      }
      await record.finalization;
    } else if (record.status === "running") {
      if (record.terminal && input.closeStdin === true) {
        throw new ToolError(
          "invalid_input",
          "Interactive terminal sessions do not support closing stdin; send terminal input or stop the session",
        );
      }
      if (input.resize !== undefined) {
        if (!record.terminal || record.process.resize === undefined) {
          throw new ToolError(
            "invalid_input",
            "Only interactive terminal sessions can be resized",
          );
        }
        record.process.resize(input.resize.columns, input.resize.rows);
      }
      if (input.input !== undefined && input.input.length > 0) {
        await new Promise<void>((resolve, reject) => {
          record.process.stdin.write(input.input, (error) => {
            if (error === null || error === undefined) resolve();
            else reject(new ToolError(
              "process_failed",
              "Process session input could not be written",
            ));
          });
        });
      }
      if (input.closeStdin === true) record.process.stdin.end();
      await this.#waitForActivity(record, input.yieldTimeMs);
    }
    return this.#snapshot(record);
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = (async () => {
      await this.#waitForPendingStarts();
      const records = [...this.#records.values()];
      const settled = await Promise.allSettled(
        records.map(async (record) => {
          let closeFailure: unknown;
          try {
            await record.process.close();
          } catch (error) {
            closeFailure = error;
          }
          await record.finalization;
          if (closeFailure !== undefined) throw closeFailure;
        }),
      );
      this.#records.clear();
      for (const record of records) this.#notify(record);
      if (settled.some((result) => result.status === "rejected")) {
        throw new ToolError(
          "process_failed",
          "One or more process sessions could not be cleaned up",
        );
      }
    })();
    return this.#closePromise;
  }
}
