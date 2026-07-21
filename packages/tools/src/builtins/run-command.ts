import { classifyCommand } from "../command-policy.js";
import { runProcess } from "../process.js";
import type { OwnedProcessManager } from "../process-sessions.js";
import { processSnapshotResult } from "./process-session.js";
import { ToolError, type Tool } from "../types.js";

const MAX_COMMAND_OUTPUT = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_YIELD_TIME_MS = 10_000;
const MIN_YIELD_TIME_MS = 250;
const MAX_YIELD_TIME_MS = 30_000;
const DEFAULT_TERMINAL_COLUMNS = 120;
const DEFAULT_TERMINAL_ROWS = 30;

export interface RunCommandInput {
  command: string;
  timeoutMs: number;
  yieldTimeMs?: number;
  tty?: boolean;
}

function parseRunCommandInput(value: unknown): RunCommandInput {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new ToolError("invalid_input", "run_command expects an object");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) =>
      key !== "command" && key !== "timeoutMs" && key !== "yieldTimeMs" &&
      key !== "tty"
    ) || typeof record.command !== "string" ||
    record.command.trim().length === 0
  ) {
    throw new ToolError("invalid_input", "run_command requires a command");
  }
  const timeoutMs = record.timeoutMs !== undefined
    ? record.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    (timeoutMs as number) < 1 ||
    (timeoutMs as number) > 600_000
  ) {
    throw new ToolError("invalid_input", "timeoutMs must be between 1 and 600000");
  }
  const yieldTimeMs = record.yieldTimeMs;
  if (
    yieldTimeMs !== undefined &&
    (!Number.isSafeInteger(yieldTimeMs) ||
      (yieldTimeMs as number) < MIN_YIELD_TIME_MS ||
      (yieldTimeMs as number) > MAX_YIELD_TIME_MS)
  ) {
    throw new ToolError(
      "invalid_input",
      `yieldTimeMs must be between ${MIN_YIELD_TIME_MS} and ${MAX_YIELD_TIME_MS}`,
    );
  }
  const tty = record.tty;
  if (tty !== undefined && typeof tty !== "boolean") {
    throw new ToolError("invalid_input", "tty must be a boolean");
  }
  return {
    command: record.command,
    timeoutMs: timeoutMs as number,
    ...(yieldTimeMs === undefined ? {} : { yieldTimeMs: yieldTimeMs as number }),
    ...(tty === undefined ? {} : { tty }),
  };
}

function verificationEvidence(command: string): string[] {
  return /(?:^|\s)(?:test|lint|typecheck|check|build)(?:\s|$)/u.test(command)
    ? [`${command} exited 0`]
    : [];
}

export function createRunCommandTool(
  processes?: OwnedProcessManager,
): Tool<RunCommandInput> {
  return {
    definition: {
      name: "run_command",
      description: "Run a bounded command through the system shell",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", minLength: 1 },
          timeoutMs: { type: "integer", minimum: 1, maximum: 600_000 },
          yieldTimeMs: {
            type: "integer",
            minimum: MIN_YIELD_TIME_MS,
            maximum: MAX_YIELD_TIME_MS,
          },
          tty: {
            type: "boolean",
            description: "Run the command in an interactive pseudo-terminal",
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
    executionClass: "arbitrary_process",
    mutating: true,
    checkpointOwnership: processes?.ownsCheckpoints === true
      ? "self_managed"
      : "registry",
    parse: parseRunCommandInput,
    permissions(input) {
      return classifyCommand(input.command);
    },
    async execute(input, context) {
      if (processes !== undefined) {
        return processSnapshotResult(await processes.start({
          ownerId: context.sessionId,
          command: "/bin/sh",
          args: ["-c", input.command],
          options: {
            cwd: context.cwd,
            signal: context.signal,
            timeoutMs: input.timeoutMs,
            maxOutputBytes: MAX_COMMAND_OUTPUT,
            ...(context.processSandbox === undefined
              ? {}
              : { sandbox: context.processSandbox }),
          },
          yieldTimeMs: input.yieldTimeMs ?? DEFAULT_YIELD_TIME_MS,
          terminalEvidence: verificationEvidence(input.command),
          ...(input.tty === true
            ? {
                terminal: {
                  columns: DEFAULT_TERMINAL_COLUMNS,
                  rows: DEFAULT_TERMINAL_ROWS,
                },
              }
            : {}),
        }));
      }
      if (input.yieldTimeMs !== undefined || input.tty === true) {
        throw new ToolError(
          "tool_unavailable",
          input.tty === true
            ? "Interactive terminal sessions are unavailable"
            : "Long-running command sessions are unavailable",
        );
      }
      const result = await runProcess("/bin/sh", ["-c", input.command], {
        cwd: context.cwd,
        signal: context.signal,
        timeoutMs: input.timeoutMs,
        maxOutputBytes: MAX_COMMAND_OUTPUT,
        ...(context.processSandbox === undefined
          ? {}
          : { sandbox: context.processSandbox }),
      });
      const output = result.stderr.length === 0
        ? result.stdout
        : `${result.stdout}${result.stderr}`;
      const evidence = verificationEvidence(input.command);
      return {
        output,
        metadata: {
          exitCode: result.exitCode,
          ...(evidence.length === 0 ? {} : { evidence }),
        },
      };
    },
  };
}
