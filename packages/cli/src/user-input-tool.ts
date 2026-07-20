import { Buffer } from "node:buffer";

import { ToolError, type Tool, type ToolContext } from "@recurs/tools";

export const MAX_USER_QUESTION_BYTES = 2_048;
export const MAX_USER_ANSWER_BYTES = 4_096;
export const MAX_USER_OPTION_BYTES = 128;
export const MAX_USER_OPTIONS = 4;

export interface UserInputRequest {
  readonly question: string;
  readonly options: readonly string[];
}

export type UserInputHandler = (
  request: UserInputRequest,
  signal: AbortSignal,
) => Promise<string | null>;

function boundedText(
  value: unknown,
  name: string,
  maximumBytes: number,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ToolError("invalid_input", `${name} must be a non-empty string`);
  }
  const text = value.trim();
  if (Buffer.byteLength(text, "utf8") > maximumBytes) {
    throw new ToolError(
      "invalid_input",
      `${name} exceeds ${maximumBytes} bytes`,
    );
  }
  return text;
}

function parseOptions(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_USER_OPTIONS) {
    throw new ToolError(
      "invalid_input",
      `options must contain between 2 and ${MAX_USER_OPTIONS} strings`,
    );
  }
  const options = value.map((option, index) =>
    boundedText(option, `options[${index}]`, MAX_USER_OPTION_BYTES)
  );
  if (new Set(options.map((option) => option.toLowerCase())).size !== options.length) {
    throw new ToolError("invalid_input", "options must be unique");
  }
  return options;
}

function parseRequest(value: unknown): UserInputRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ToolError("invalid_input", "request_user_input expects an object");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "question" && key !== "options")) {
    throw new ToolError("invalid_input", "request_user_input received an unknown field");
  }
  return {
    question: boundedText(record.question, "question", MAX_USER_QUESTION_BYTES),
    options: parseOptions(record.options),
  };
}

function userPresentLocalCli(context: ToolContext): boolean {
  const run = context.runContext;
  return run?.invocation === "repl" && run.presence === "present" &&
    run.location === "local" && run.automation === "manual" &&
    run.embedding === "cli";
}

export function createRequestUserInputTool(
  ask: UserInputHandler,
): Tool<UserInputRequest> {
  return {
    definition: {
      name: "request_user_input",
      description: "Ask the present local CLI user one necessary bounded clarification. Never request passwords, API keys, tokens, or other secrets.",
      inputSchema: {
        type: "object",
        properties: {
          question: {
            type: "string",
            minLength: 1,
            maxLength: MAX_USER_QUESTION_BYTES,
          },
          options: {
            type: "array",
            minItems: 2,
            maxItems: MAX_USER_OPTIONS,
            uniqueItems: true,
            items: {
              type: "string",
              minLength: 1,
              maxLength: MAX_USER_OPTION_BYTES,
            },
          },
        },
        required: ["question"],
        additionalProperties: false,
      },
    },
    executionClass: "in_process",
    mutating: false,
    available: userPresentLocalCli,
    parse: parseRequest,
    permissions() {
      return [];
    },
    async preflight(_input, context) {
      if (!userPresentLocalCli(context)) {
        throw new ToolError(
          "tool_unavailable",
          "User input is available only in the local manual interactive CLI",
        );
      }
    },
    async execute(input, context) {
      let answer: string | null;
      try {
        answer = await ask(input, context.signal);
      } catch (error) {
        if (context.signal.aborted) {
          throw new ToolError("cancelled", "User input was cancelled");
        }
        if (error instanceof ToolError) throw error;
        throw new ToolError("tool_unavailable", "User input is unavailable");
      }
      if (answer === null || answer.trim().length === 0) {
        return { output: JSON.stringify({ status: "declined" }) };
      }
      const normalized = answer.trim();
      if (Buffer.byteLength(normalized, "utf8") > MAX_USER_ANSWER_BYTES) {
        throw new ToolError(
          "output_limit",
          `User answer exceeds ${MAX_USER_ANSWER_BYTES} bytes`,
        );
      }
      return {
        output: JSON.stringify({ status: "answered", answer: normalized }),
      };
    },
  };
}
