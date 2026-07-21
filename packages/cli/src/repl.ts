import { stdin as processStdin, stdout as processStdout } from "node:process";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

import {
  createHostInvocation,
  MAX_MODEL_IMAGES,
  MAX_MODEL_IMAGE_TOTAL_BYTES,
  modelImagesByteLength,
  type HostInvocation,
  type ModelImageInput,
} from "@recurs/contracts";

import { parseCommand } from "./commands/parser.js";
import type { CommandResult } from "./commands/types.js";
import { safeCliErrorMessage } from "./error-rendering.js";
import { ImageInputError, loadImageInputs } from "./image-input.js";
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
  cwd?: string;
  invocation?: HostInvocation;
  attachProcess?: ProcessAttachmentHost;
  loadImages?: (
    paths: readonly string[],
    cwd: string,
  ) => Promise<readonly ModelImageInput[]>;
}

function stagedImagesText(images: readonly ModelImageInput[]): string {
  if (images.length === 0) {
    return "No images staged. Use /image <path> before the next prompt.\n";
  }
  const bytes = modelImagesByteLength(images);
  return `Images staged for the next prompt: ${images.length}/${MAX_MODEL_IMAGES}, ${bytes ?? 0}/${MAX_MODEL_IMAGE_TOTAL_BYTES} bytes.\n`;
}

function interactiveImagePath(args: string): string {
  const quote = args[0];
  if (quote === "'" || quote === '"') {
    if (args.length < 2 || args.at(-1) !== quote) {
      throw new ImageInputError("Image path quoting is invalid");
    }
    const inner = args.slice(1, -1);
    if (quote === "'") return inner;
    let decoded = "";
    for (let index = 0; index < inner.length; index += 1) {
      const character = inner[index] ?? "";
      if (character !== "\\") {
        decoded += character;
        continue;
      }
      const escaped = inner[index + 1];
      if (escaped === undefined) {
        throw new ImageInputError("Image path quoting is invalid");
      }
      if (escaped === "\\" || escaped === '"' || escaped === " ") {
        decoded += escaped;
        index += 1;
      } else {
        decoded += "\\";
      }
    }
    return decoded;
  }
  return args.replaceAll("\\ ", " ");
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
  const cwd = options.cwd ?? process.cwd();
  const loadImages = options.loadImages ?? loadImageInputs;
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
  let stagedImages: readonly ModelImageInput[] = Object.freeze([]);
  const handleImageCommand = async (args: string): Promise<void> => {
    if (args.length === 0) {
      await writeOutput(output, stagedImagesText(stagedImages));
      return;
    }
    if (args.toLowerCase() === "clear") {
      stagedImages = Object.freeze([]);
      await writeOutput(output, "Staged images cleared.\n");
      return;
    }
    if (runtime.hasActiveRun) {
      throw new ImageInputError(
        "Images can be staged only while the current agent turn is idle",
      );
    }
    const loaded = await loadImages([interactiveImagePath(args)], cwd);
    const combined = Object.freeze([...stagedImages, ...loaded]);
    if (modelImagesByteLength(combined) === null) {
      throw new ImageInputError(
        "Staged images exceed the four-image or five MiB total limit",
      );
    }
    stagedImages = combined;
    await writeOutput(output, stagedImagesText(stagedImages));
  };
  const submitLine = async (inputLine: string): Promise<boolean> => {
    try {
      const parsed = parseCommand(inputLine);
      if (parsed?.name === "image") {
        await handleImageCommand(parsed.args);
        return false;
      }
      const images = parsed === null && !inputLine.trimStart().startsWith("/") &&
          !runtime.hasActiveRun &&
          stagedImages.length > 0
        ? stagedImages
        : undefined;
      if (images !== undefined) stagedImages = Object.freeze([]);
      const result = await runtime.submit(
        inputLine,
        invocation,
        images === undefined ? {} : { images },
      );
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
        if (parsed?.name === "help") {
          await writeOutput(
            output,
            "/image [path|clear]            Stage, inspect, or clear images for the next prompt\n",
          );
        }
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
