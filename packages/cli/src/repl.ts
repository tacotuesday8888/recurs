import { stdin as processStdin, stdout as processStdout } from "node:process";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

import { createHostInvocation, type HostInvocation } from "@recurs/contracts";

import type { CommandResult } from "./commands/types.js";
import { safeCliErrorMessage } from "./error-rendering.js";
import { renderCommandResult, writeOutput } from "./render.js";
import { isCancellation, type RecursRuntime } from "./runtime.js";

export interface ReplOptions {
  input?: Readable;
  output?: Writable;
  terminal?: boolean;
  invocation?: HostInvocation;
}

function isCommandResult(value: unknown): value is CommandResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value.type === "message" ||
      value.type === "submit_prompt" ||
      value.type === "submit_queued_prompt" ||
      value.type === "quit")
  );
}

export async function startRepl(
  runtime: RecursRuntime,
  options: ReplOptions = {},
): Promise<void> {
  const input = options.input ?? processStdin;
  const output = options.output ?? processStdout;
  const invocation = options.invocation ?? createHostInvocation({
    invocation: "repl",
    userPresent: false,
    remote: false,
    scripted: true,
    embedding: "cli",
  });
  const readline = createInterface({
    input,
    output,
    terminal:
      options.terminal ??
      (output as Writable & { isTTY?: boolean }).isTTY === true,
  });
  let questionTail = Promise.resolve();
  const question = (prompt: string): Promise<string> => {
    const answer = questionTail.then(() => readline.question(prompt));
    questionTail = answer.then(() => undefined, () => undefined);
    return answer;
  };
  runtime.setConfirmHandler(async (message) => {
    const answer = await question(`${message} [y/N] `);
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  });
  readline.on("SIGINT", () => {
    if (!runtime.cancel()) {
      readline.close();
    }
  });

  await writeOutput(output, "Recurs — local harness mode\nType /help for commands.\n");
  if (runtime.state?.type === "workspace") {
    await writeOutput(
      output,
      "\nLet's connect the team to a model. Recurs will show saved accounts, safely detected local runtimes, and the public provider catalog.\n\n",
    );
    try {
      const discovery = await runtime.submit("/provider", invocation);
      if (isCommandResult(discovery)) {
        await renderCommandResult(discovery, output, output);
      }
    } catch (error) {
      await writeOutput(output, `Provider discovery: ${safeCliErrorMessage(error)}\n`);
    }
  }
  const activeSubmissions = new Set<Promise<void>>();
  const submitLine = async (inputLine: string): Promise<boolean> => {
    try {
      const result = await runtime.submit(inputLine, invocation);
      if (isCommandResult(result)) {
        if (result.type === "quit") return true;
        await renderCommandResult(result, output, output);
      }
    } catch (error) {
      if (isCancellation(error)) {
        await writeOutput(output, "Cancelled\n");
        return false;
      }
      await writeOutput(
        output,
        `Error: ${safeCliErrorMessage(error)}\n`,
      );
    }
    return false;
  };
  try {
    for (;;) {
      let inputLine: string;
      try {
        inputLine = await question("recurs> ");
      } catch {
        break;
      }
      if (inputLine.trim().length === 0) {
        continue;
      }
      const submission = submitLine(inputLine);
      if (runtime.canAcceptLiveInput) {
        const tracked = submission.then((quit) => {
          if (quit) readline.close();
        });
        activeSubmissions.add(tracked);
        void tracked.finally(() => activeSubmissions.delete(tracked));
        continue;
      }
      if (await submission) break;
    }
  } finally {
    readline.close();
    await runtime.close?.();
    await Promise.allSettled([...activeSubmissions]);
  }
}
