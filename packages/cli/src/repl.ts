import { stdin as processStdin, stdout as processStdout } from "node:process";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

import type { CommandResult } from "./commands/types.js";
import { safeCliErrorMessage } from "./error-rendering.js";
import { renderCommandResult, writeOutput } from "./render.js";
import { isCancellation, type RecursRuntime } from "./runtime.js";

export interface ReplOptions {
  input?: Readable;
  output?: Writable;
  terminal?: boolean;
}

function isCommandResult(value: unknown): value is CommandResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value.type === "message" ||
      value.type === "submit_prompt" ||
      value.type === "quit")
  );
}

export async function startRepl(
  runtime: RecursRuntime,
  options: ReplOptions = {},
): Promise<void> {
  const input = options.input ?? processStdin;
  const output = options.output ?? processStdout;
  const readline = createInterface({
    input,
    output,
    terminal:
      options.terminal ??
      (output as Writable & { isTTY?: boolean }).isTTY === true,
  });
  runtime.setConfirmHandler(async (message) => {
    const answer = await readline.question(`${message} [y/N] `);
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  });
  readline.on("SIGINT", () => {
    if (!runtime.cancel()) {
      readline.close();
    }
  });

  await writeOutput(output, "Recurs — local harness mode\nType /help for commands.\n");
  try {
    for (;;) {
      let inputLine: string;
      try {
        inputLine = await readline.question("recurs> ");
      } catch {
        break;
      }
      if (inputLine.trim().length === 0) {
        continue;
      }
      try {
        const result = await runtime.submit(inputLine);
        if (isCommandResult(result)) {
          if (result.type === "quit") {
            break;
          }
          await renderCommandResult(result, output, output);
        }
      } catch (error) {
        if (isCancellation(error)) {
          await writeOutput(output, "Cancelled\n");
          continue;
        }
        await writeOutput(
          output,
          `Error: ${safeCliErrorMessage(error)}\n`,
        );
      }
    }
  } finally {
    readline.close();
  }
}
