import type {
  OwnedProcessManager,
  OwnedProcessSnapshot,
} from "../process-sessions.js";
import {
  MAX_PROCESS_SESSION_COLUMNS,
  MAX_PROCESS_SESSION_INPUT_BYTES,
  MAX_PROCESS_SESSION_ROWS,
  MAX_PROCESS_SESSION_YIELD_TIME_MS,
  MIN_PROCESS_SESSION_COLUMNS,
  MIN_PROCESS_SESSION_ROWS,
} from "../process-sessions.js";
import { ToolError, type Tool, type ToolResult } from "../types.js";

export interface ProcessSessionInput {
  readonly action: "poll" | "write" | "resize" | "stop";
  readonly sessionId: string;
  readonly input?: string;
  readonly closeStdin?: boolean;
  readonly columns?: number;
  readonly rows?: number;
  readonly yieldTimeMs: number;
}

function parseInput(value: unknown): ProcessSessionInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ToolError("invalid_input", "process_session requires an object");
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    "action",
    "sessionId",
    "input",
    "closeStdin",
    "columns",
    "rows",
    "yieldTimeMs",
  ]);
  if (
    Object.keys(input).some((key) => !allowed.has(key)) ||
    (input.action !== "poll" &&
      input.action !== "write" &&
      input.action !== "resize" &&
      input.action !== "stop") ||
    typeof input.sessionId !== "string" ||
    input.sessionId.length === 0 ||
    input.sessionId.length > 128
  ) {
    throw new ToolError("invalid_input", "process_session input is invalid");
  }
  if (
    input.input !== undefined &&
    (typeof input.input !== "string" ||
      Buffer.byteLength(input.input, "utf8") > MAX_PROCESS_SESSION_INPUT_BYTES)
  ) {
    throw new ToolError(
      "invalid_input",
      `input must be at most ${MAX_PROCESS_SESSION_INPUT_BYTES} UTF-8 bytes`,
    );
  }
  if (input.closeStdin !== undefined && typeof input.closeStdin !== "boolean") {
    throw new ToolError("invalid_input", "closeStdin must be a boolean");
  }
  if (
    input.action !== "write" &&
    (input.input !== undefined || input.closeStdin !== undefined)
  ) {
    throw new ToolError(
      "invalid_input",
      "Only the write action accepts input or closeStdin",
    );
  }
  if (
    input.action === "resize" &&
    (!Number.isSafeInteger(input.columns) ||
      (input.columns as number) < MIN_PROCESS_SESSION_COLUMNS ||
      (input.columns as number) > MAX_PROCESS_SESSION_COLUMNS ||
      !Number.isSafeInteger(input.rows) ||
      (input.rows as number) < MIN_PROCESS_SESSION_ROWS ||
      (input.rows as number) > MAX_PROCESS_SESSION_ROWS)
  ) {
    throw new ToolError(
      "invalid_input",
      `columns must be ${MIN_PROCESS_SESSION_COLUMNS}-${MAX_PROCESS_SESSION_COLUMNS} and rows must be ${MIN_PROCESS_SESSION_ROWS}-${MAX_PROCESS_SESSION_ROWS}`,
    );
  }
  if (
    input.action !== "resize" &&
    (input.columns !== undefined || input.rows !== undefined)
  ) {
    throw new ToolError(
      "invalid_input",
      "Only the resize action accepts columns or rows",
    );
  }
  const defaultYield = input.action === "stop" || input.action === "resize"
    ? 0
    : input.action === "write" && (input.input?.length ?? 0) > 0
      ? 250
      : 1_000;
  const yieldTimeMs = input.yieldTimeMs ?? defaultYield;
  if (
    !Number.isSafeInteger(yieldTimeMs) ||
    (yieldTimeMs as number) < 0 ||
    (yieldTimeMs as number) > MAX_PROCESS_SESSION_YIELD_TIME_MS
  ) {
    throw new ToolError(
      "invalid_input",
      `yieldTimeMs must be between 0 and ${MAX_PROCESS_SESSION_YIELD_TIME_MS}`,
    );
  }
  return {
    action: input.action,
    sessionId: input.sessionId,
    ...(input.input === undefined ? {} : { input: input.input }),
    ...(input.closeStdin === undefined
      ? {}
      : { closeStdin: input.closeStdin }),
    ...(input.columns === undefined ? {} : { columns: input.columns as number }),
    ...(input.rows === undefined ? {} : { rows: input.rows as number }),
    yieldTimeMs: yieldTimeMs as number,
  };
}

export function processSnapshotResult(
  snapshot: OwnedProcessSnapshot,
): ToolResult {
  if (snapshot.status === "failed") {
    throw new ToolError(
      snapshot.failure?.code ?? "process_failed",
      snapshot.failure?.message ?? "The process session failed",
    );
  }
  if (snapshot.status === "exited" && snapshot.exitCode !== 0) {
    throw new ToolError(
      "process_failed",
      `Process exited with ${snapshot.exitCode ?? -1}`,
    );
  }
  const terminal = snapshot.status === "running"
    ? `Process session ${snapshot.sessionId} is running.`
    : `Process exited with code ${snapshot.exitCode ?? -1}.`;
  return {
    output: snapshot.output.length === 0
      ? terminal
      : `${snapshot.output}${snapshot.output.endsWith("\n") ? "" : "\n"}${terminal}`,
    metadata: {
      sessionId: snapshot.sessionId,
      status: snapshot.status,
      ...(snapshot.exitCode === undefined ? {} : { exitCode: snapshot.exitCode }),
      terminal: snapshot.terminal,
      ...(snapshot.checkpointId === undefined
        ? {}
        : { checkpointId: snapshot.checkpointId }),
      ...(snapshot.evidence === undefined
        ? {}
        : { evidence: [...snapshot.evidence] }),
      ...(snapshot.failure === undefined
        ? {}
        : { errorCode: snapshot.failure.code }),
    },
  };
}

export function createProcessSessionTool(
  processes: OwnedProcessManager,
): Tool<ProcessSessionInput> {
  return {
    definition: {
      name: "process_session",
      description: "Poll, write to, resize, or stop an owned running command",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["poll", "write", "resize", "stop"] },
          sessionId: { type: "string", minLength: 1, maxLength: 128 },
          input: {
            type: "string",
            maxLength: MAX_PROCESS_SESSION_INPUT_BYTES,
          },
          closeStdin: { type: "boolean" },
          columns: {
            type: "integer",
            minimum: MIN_PROCESS_SESSION_COLUMNS,
            maximum: MAX_PROCESS_SESSION_COLUMNS,
          },
          rows: {
            type: "integer",
            minimum: MIN_PROCESS_SESSION_ROWS,
            maximum: MAX_PROCESS_SESSION_ROWS,
          },
          yieldTimeMs: {
            type: "integer",
            minimum: 0,
            maximum: MAX_PROCESS_SESSION_YIELD_TIME_MS,
          },
        },
        required: ["action", "sessionId"],
        additionalProperties: false,
      },
    },
    executionClass: "arbitrary_process",
    mutating: false,
    checkpointOwnership: processes.ownsCheckpoints
      ? "self_managed"
      : "registry",
    isMutating(input) {
      return input.action !== "poll";
    },
    parse: parseInput,
    permissions(input) {
      return [{
        category: input.action === "poll" ? "read" : "shell",
        resource: `process session ${input.sessionId}`,
        risk: "normal",
      }];
    },
    async execute(input, context) {
      return processSnapshotResult(await processes.interact({
        ownerId: context.sessionId,
        sessionId: input.sessionId,
        ...(input.action !== "write"
          ? {}
          : {
              ...(input.input === undefined ? {} : { input: input.input }),
              ...(input.closeStdin === undefined
                ? {}
                : { closeStdin: input.closeStdin }),
            }),
        stop: input.action === "stop",
        ...(input.action === "resize"
          ? { resize: { columns: input.columns!, rows: input.rows! } }
          : {}),
        yieldTimeMs: input.yieldTimeMs,
      }));
    },
  };
}
