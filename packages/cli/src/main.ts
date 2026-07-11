#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  stderr as processStderr,
  stdin as processStdin,
  stdout as processStdout,
} from "node:process";
import type { Readable, Writable } from "node:stream";

import {
  createHostInvocation,
  type IntegrationFailure,
} from "@recurs/contracts";
import { CoordinatedRunError, type EventSink } from "@recurs/core";

import { createStandaloneRuntime } from "./assembly.js";
import {
  LocalConnectionError,
  setupLocalConnection,
  type LocalConnectionConfiguration,
} from "./local-connection.js";
import type { CommandResult } from "./commands/types.js";
import {
  JsonlEventRenderer,
  TextEventRenderer,
  renderCommandResult,
  writeOutput,
} from "./render.js";
import { safeCliErrorMessage } from "./error-rendering.js";
import { startRepl } from "./repl.js";
import {
  RuntimeError,
  isCancellation,
  type RecursRuntime,
} from "./runtime.js";

const help = `Recurs coding-agent harness

Usage:
  recurs                         Open the interactive CLI
  recurs run <prompt>            Run one prompt
  recurs run <prompt> --format text|jsonl
  recurs setup local --url <loopback-url> --model <model-id>
  recurs --help                  Show this help

Local setup supports credential-free OpenAI-compatible servers on literal loopback only.
`;

export interface CliDependencies {
  stdout: Writable;
  stderr: Writable;
  stdin?: Readable;
  createRuntime(events: EventSink): Promise<RecursRuntime>;
  setupLocal?(input: { baseUrl: string; modelId: string }): Promise<Pick<LocalConnectionConfiguration, "label" | "baseUrl" | "modelId">>;
}

interface RunArguments {
  prompt: string;
  format: "text" | "jsonl";
}

function parseRunArguments(args: readonly string[]): RunArguments | null {
  let format: RunArguments["format"] = "text";
  const prompt: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (argument === "--format") {
      const value = args[index + 1];
      if (value !== "text" && value !== "jsonl") {
        return null;
      }
      format = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) {
      return null;
    }
    prompt.push(argument);
  }
  const joined = prompt.join(" ").trim();
  return joined.length === 0 ? null : { prompt: joined, format };
}

function parseLocalSetupArguments(
  args: readonly string[],
): { baseUrl: string; modelId: string } | null {
  if (args[0] !== "local") return null;
  let baseUrl: string | undefined;
  let modelId: string | undefined;
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) return null;
    if (flag === "--url" && baseUrl === undefined) baseUrl = value;
    else if (flag === "--model" && modelId === undefined) modelId = value;
    else return null;
  }
  return baseUrl === undefined || modelId === undefined
    ? null
    : { baseUrl, modelId };
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

function exitCodeFor(error: unknown): number {
  if (isCancellation(error)) {
    return 130;
  }
  if (
    error instanceof RuntimeError &&
    (error.code === "invalid_input" || error.code === "provider_not_configured")
  ) {
    return 2;
  }
  if (error instanceof LocalConnectionError) return 2;
  if (error instanceof CoordinatedRunError && error.failure.phase === "preflight") {
    return 2;
  }
  return 1;
}

function configurationFailure(error: unknown): IntegrationFailure | null {
  if (error instanceof CoordinatedRunError && error.failure.phase === "preflight") {
    return error.failure;
  }
  if (
    error instanceof RuntimeError &&
    (error.code === "invalid_input" || error.code === "provider_not_configured")
  ) {
    return {
      domain: "connection",
      phase: "preflight",
      code: "connection_invalid",
      safeMessage: error.message,
      diagnosticId: randomUUID(),
      retryable: false,
      action: "select_connection",
    };
  }
  return null;
}

export async function runCli(
  argv: readonly string[],
  dependencies: CliDependencies,
): Promise<number> {
  if (
    argv.length === 1 &&
    (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help")
  ) {
    await writeOutput(dependencies.stdout, help);
    return 0;
  }

  if (argv.length === 0) {
    const renderer = new TextEventRenderer(dependencies.stdout);
    try {
      const runtime = await dependencies.createRuntime(renderer);
      await startRepl(runtime, {
        ...(dependencies.stdin === undefined ? {} : { input: dependencies.stdin }),
        output: dependencies.stdout,
      });
      return 0;
    } catch (error) {
      await writeOutput(
        dependencies.stderr,
        `Error: ${safeCliErrorMessage(error)}\n`,
      );
      return exitCodeFor(error);
    }
  }

  if (argv[0] === "setup") {
    const input = parseLocalSetupArguments(argv.slice(1));
    if (input === null || dependencies.setupLocal === undefined) {
      await writeOutput(dependencies.stderr, help);
      return 2;
    }
    try {
      const connection = await dependencies.setupLocal(input);
      await writeOutput(
        dependencies.stdout,
        `Ready — ${connection.label} · ${connection.modelId}\nEndpoint: ${connection.baseUrl}\n`,
      );
      return 0;
    } catch (error) {
      await writeOutput(dependencies.stderr, `Error: ${safeCliErrorMessage(error)}\n`);
      return exitCodeFor(error);
    }
  }

  if (argv[0] !== "run") {
    await writeOutput(dependencies.stderr, help);
    return 2;
  }
  const parsed = parseRunArguments(argv.slice(1));
  if (parsed === null) {
    await writeOutput(dependencies.stderr, help);
    return 2;
  }
  const renderer = parsed.format === "jsonl"
    ? new JsonlEventRenderer(dependencies.stdout)
    : new TextEventRenderer(dependencies.stdout);
  try {
    const runtime = await dependencies.createRuntime(renderer);
    const result = await runtime.submit(
      parsed.prompt,
      createHostInvocation({
        invocation: "one_shot",
        userPresent: false,
        remote: false,
        scripted: true,
        embedding: "cli",
      }),
    );
    if (isCommandResult(result)) {
      await renderCommandResult(result, dependencies.stdout, dependencies.stderr);
    }
    return 0;
  } catch (error) {
    const failure = configurationFailure(error);
    if (parsed.format === "jsonl" && failure !== null) {
      await writeOutput(
        dependencies.stdout,
        `${JSON.stringify({
          version: 1,
          type: "configuration_error",
          error: failure,
        })}\n`,
      );
      return 2;
    }
    await writeOutput(
      dependencies.stderr,
      `Error: ${safeCliErrorMessage(error)}\n`,
    );
    return exitCodeFor(error);
  }
}

async function main(): Promise<void> {
  process.exitCode = await runCli(process.argv.slice(2), {
    stdin: processStdin,
    stdout: processStdout,
    stderr: processStderr,
    createRuntime: (events) => createStandaloneRuntime(events),
    setupLocal: (input) => setupLocalConnection(
      process.env.RECURS_HOME ?? path.join(homedir(), ".recurs"),
      input,
    ),
  });
}

const entry = process.argv[1];
if (
  entry !== undefined &&
  (path.resolve(entry) === fileURLToPath(import.meta.url) ||
    path.basename(entry) === "recurs")
) {
  void main();
}
