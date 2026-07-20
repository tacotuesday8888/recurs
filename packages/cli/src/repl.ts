import { stdin as processStdin, stdout as processStdout } from "node:process";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

import { createHostInvocation, type HostInvocation } from "@recurs/contracts";

import type { CommandResult } from "./commands/types.js";
import { safeCliErrorMessage } from "./error-rendering.js";
import { renderCommandResult, writeOutput } from "./render.js";
import { isCancellation, type RecursRuntime } from "./runtime.js";
import {
  attachOwnedTerminalProcess,
  type ProcessAttachmentHost,
} from "./terminal-attach.js";
import type { UserInputRequest } from "./user-input-tool.js";

export interface ReplOptions {
  input?: Readable;
  output?: Writable;
  terminal?: boolean;
  invocation?: HostInvocation;
  attachProcess?: ProcessAttachmentHost;
}

function isCommandResult(value: unknown): value is CommandResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value.type === "message" ||
      value.type === "attach_process" ||
      value.type === "submit_prompt" ||
      value.type === "submit_queued_prompt" ||
      value.type === "quit")
  );
}

function userInputPrompt(request: UserInputRequest): string {
  const choices = request.options.map((option, index) =>
    `  ${index + 1}. ${option}`
  );
  return [
    "",
    request.question,
    ...choices,
    choices.length === 0
      ? "Answer (leave blank to decline): "
      : "Answer with a number or text (leave blank to decline): ",
  ].join("\n");
}

function selectedAnswer(
  answer: string,
  options: readonly string[],
): string | null {
  const normalized = answer.trim();
  if (normalized.length === 0) return null;
  if (/^[1-9][0-9]*$/u.test(normalized)) {
    const selected = options[Number.parseInt(normalized, 10) - 1];
    if (selected !== undefined) return selected;
  }
  return normalized;
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
  const attachProcess = options.attachProcess ?? attachOwnedTerminalProcess;
  const createReadline = () => createInterface({
    input,
    output,
    terminal:
      options.terminal ??
      (output as Writable & { isTTY?: boolean }).isTTY === true,
  });
  let readline = createReadline();
  let questionTail = Promise.resolve();
  const question = (prompt: string, signal?: AbortSignal): Promise<string> => {
    const answer = questionTail.then(() =>
      signal === undefined
        ? readline.question(prompt)
        : readline.question(prompt, { signal })
    );
    questionTail = answer.then(() => undefined, () => undefined);
    return answer;
  };
  let pendingMainQuestion:
    | { readonly controller: AbortController; preempted: boolean }
    | undefined;
  const prioritizedQuestion = (
    prompt: string,
    signal?: AbortSignal,
  ): Promise<string> => {
    if (
      pendingMainQuestion !== undefined &&
      !pendingMainQuestion.controller.signal.aborted
    ) {
      pendingMainQuestion.preempted = true;
      pendingMainQuestion.controller.abort();
    }
    return question(prompt, signal);
  };
  runtime.setConfirmHandler(async (message) => {
    const answer = await prioritizedQuestion(
      `${message} [y/N] `,
      runtime.currentSignal(),
    );
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  });
  runtime.setUserInputHandler?.(async (request, signal) => {
    const answer = await prioritizedQuestion(userInputPrompt(request), signal);
    return selectedAnswer(answer, request.options);
  });
  const installSignalHandler = (): void => {
    readline.on("SIGINT", () => {
      if (!runtime.cancel()) {
        readline.close();
      }
    });
  };
  installSignalHandler();

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
        if (result.type === "attach_process") {
          readline.close();
          try {
            await attachProcess(
              runtime,
              result.sessionId,
              input,
              output,
            );
          } finally {
            readline = createReadline();
            installSignalHandler();
          }
          return false;
        }
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
      const mainQuestion = {
        controller: new AbortController(),
        preempted: false,
      };
      pendingMainQuestion = mainQuestion;
      try {
        inputLine = await question("recurs> ", mainQuestion.controller.signal);
      } catch {
        if (mainQuestion.preempted) continue;
        break;
      } finally {
        if (pendingMainQuestion === mainQuestion) {
          pendingMainQuestion = undefined;
        }
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
