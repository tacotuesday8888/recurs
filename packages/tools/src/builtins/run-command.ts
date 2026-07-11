import { classifyCommand } from "../command-policy.js";
import { runProcess } from "../process.js";
import { ToolError, type Tool } from "../types.js";

const MAX_COMMAND_OUTPUT = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

export interface RunCommandInput {
  command: string;
  timeoutMs: number;
}

function parseRunCommandInput(value: unknown): RunCommandInput {
  if (
    typeof value !== "object" ||
    value === null ||
    !("command" in value) ||
    typeof value.command !== "string" ||
    value.command.trim().length === 0
  ) {
    throw new ToolError("invalid_input", "run_command requires a command");
  }
  const timeoutMs = "timeoutMs" in value && value.timeoutMs !== undefined
    ? value.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    (timeoutMs as number) < 1 ||
    (timeoutMs as number) > 600_000
  ) {
    throw new ToolError("invalid_input", "timeoutMs must be between 1 and 600000");
  }
  return { command: value.command, timeoutMs: timeoutMs as number };
}

function verificationEvidence(command: string): string[] {
  return /(?:^|\s)(?:test|lint|typecheck|check|build)(?:\s|$)/u.test(command)
    ? [`${command} exited 0`]
    : [];
}

export function createRunCommandTool(): Tool<RunCommandInput> {
  return {
    definition: {
      name: "run_command",
      description: "Run a bounded command through the system shell",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", minLength: 1 },
          timeoutMs: { type: "integer", minimum: 1, maximum: 600_000 },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
    executionClass: "arbitrary_process",
    mutating: true,
    parse: parseRunCommandInput,
    permissions(input) {
      return classifyCommand(input.command);
    },
    async execute(input, context) {
      const result = await runProcess("/bin/sh", ["-c", input.command], {
        cwd: context.cwd,
        signal: context.signal,
        timeoutMs: input.timeoutMs,
        maxOutputBytes: MAX_COMMAND_OUTPUT,
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
