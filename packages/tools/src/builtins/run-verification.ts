import { runProcess } from "../process.js";
import { ToolError, type Tool } from "../types.js";

const MAX_COMMAND_LENGTH = 4_096;
const MAX_COMMAND_OUTPUT = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const SCRIPT_NAME = /^(?:test|lint|build|typecheck|check)(?::[a-z0-9_-]+)*$/u;
const MUTATING_FLAGS = new Set([
  "--accept",
  "--bless",
  "--fix",
  "--update",
  "--update-snapshot",
  "--update-snapshots",
  "--updatesnapshot",
  "--write",
  "-u",
  "-w",
]);

export interface RunVerificationInput {
  readonly command: string;
  readonly timeoutMs: number;
}

export interface VerificationCommand {
  readonly program: string;
  readonly args: readonly string[];
  readonly canonical: string;
}

function tokenize(command: string): string[] {
  if (
    command.length === 0 ||
    command.length > MAX_COMMAND_LENGTH ||
    /\p{Cc}/u.test(command) ||
    /[;|&<>`]/u.test(command) ||
    command.includes("$(")
  ) {
    throw new ToolError("invalid_input", "Verification command is not safe");
  }

  const tokens: string[] = [];
  let token = "";
  let tokenStarted = false;
  let quote: "'" | '"' | null = null;
  let escaped = false;

  const flush = (): void => {
    if (tokenStarted) {
      tokens.push(token);
      token = "";
      tokenStarted = false;
    }
  };

  for (const character of command) {
    if (escaped) {
      token += character;
      tokenStarted = true;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      tokenStarted = true;
      continue;
    }
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      } else {
        token += character;
      }
      tokenStarted = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
      continue;
    }
    if (/\s/u.test(character)) {
      flush();
      continue;
    }
    token += character;
    tokenStarted = true;
  }

  if (escaped || quote !== null) {
    throw new ToolError("invalid_input", "Verification command has invalid quoting");
  }
  flush();
  if (tokens.length < 2 || tokens.some((item) => item.length === 0)) {
    throw new ToolError("invalid_input", "Verification command is incomplete");
  }
  return tokens;
}

function formatToken(token: string): string {
  return /^[a-zA-Z0-9_./:@+-]+$/u.test(token)
    ? token
    : JSON.stringify(token);
}

function assertNonMutatingArguments(args: readonly string[]): void {
  const unsafe = args.find((argument) =>
    MUTATING_FLAGS.has(argument.toLowerCase().split("=", 1)[0] ?? "")
  );
  if (unsafe !== undefined) {
    throw new ToolError(
      "invalid_input",
      `Verification command cannot use mutating flag ${unsafe}`,
    );
  }
}

function isPackageVerification(
  program: "npm" | "pnpm" | "yarn" | "bun",
  args: readonly string[],
): boolean {
  if (args[0] === "test") {
    return true;
  }
  if (args[0] !== "run" || args.length < 2) {
    return false;
  }
  const script = args[1] ?? "";
  return SCRIPT_NAME.test(script) &&
    !(program === "npm" && args.includes("--workspaces-update"));
}

function isAllowedVerification(program: string, args: readonly string[]): boolean {
  switch (program) {
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun":
      return isPackageVerification(program, args);
    case "cargo":
      return args[0] === "test" || args[0] === "check";
    case "go":
      return args[0] === "test";
    case "pytest":
      return true;
    case "python":
    case "python3":
      return args[0] === "-m" && args[1] === "pytest";
    case "swift":
      return args[0] === "test";
    default:
      return false;
  }
}

export function parseVerificationCommand(command: string): VerificationCommand {
  if (command.length > MAX_COMMAND_LENGTH) {
    throw new ToolError("invalid_input", "Verification command is too long");
  }
  const tokens = tokenize(command.trim());
  const [program = "", ...args] = tokens;
  assertNonMutatingArguments(args);
  if (!isAllowedVerification(program, args)) {
    throw new ToolError(
      "invalid_input",
      "Command is not an allowlisted verification task",
    );
  }
  return {
    program,
    args,
    canonical: [program, ...args].map(formatToken).join(" "),
  };
}

function parseInput(value: unknown): RunVerificationInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ToolError("invalid_input", "run_verification requires an object");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => key !== "command" && key !== "timeoutMs") ||
    typeof record.command !== "string"
  ) {
    throw new ToolError("invalid_input", "run_verification requires a command");
  }
  const timeoutMs = record.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    (timeoutMs as number) < 1 ||
    (timeoutMs as number) > 600_000
  ) {
    throw new ToolError("invalid_input", "timeoutMs must be between 1 and 600000");
  }
  const parsed = parseVerificationCommand(record.command);
  return { command: parsed.canonical, timeoutMs: timeoutMs as number };
}

export function createRunVerificationTool(): Tool<RunVerificationInput> {
  return {
    definition: {
      name: "run_verification",
      description: "Run an allowlisted test, lint, build, or type-check command without a shell",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", minLength: 1, maxLength: MAX_COMMAND_LENGTH },
          timeoutMs: { type: "integer", minimum: 1, maximum: 600_000 },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
    executionClass: "fixed_process",
    mutating: true,
    parse: parseInput,
    permissions(input) {
      return [{ category: "shell", resource: input.command, risk: "normal" }];
    },
    async execute(input, context) {
      const { program, args, canonical } = parseVerificationCommand(input.command);
      const result = await runProcess(program, args, {
        cwd: context.cwd,
        signal: context.signal,
        timeoutMs: input.timeoutMs,
        maxOutputBytes: MAX_COMMAND_OUTPUT,
      });
      return {
        output: result.stderr.length === 0
          ? result.stdout
          : `${result.stdout}${result.stderr}`,
        metadata: {
          exitCode: result.exitCode,
          evidence: [`${canonical} exited 0`],
        },
      };
    },
  };
}
