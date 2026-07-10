#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  stderr as processStderr,
  stdin as processStdin,
  stdout as processStdout,
} from "node:process";
import type { Readable, Writable } from "node:stream";

import type { EventSink } from "@recurs/core";

import { createStandaloneRuntime } from "./assembly.js";
import type { CommandResult } from "./commands/types.js";
import {
  JsonlEventRenderer,
  TextEventRenderer,
  renderCommandResult,
  writeOutput,
} from "./render.js";
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
  recurs --help                  Show this help

The core harness is provider-neutral. Live LLM provider configuration is deferred.
`;

export interface CliDependencies {
  stdout: Writable;
  stderr: Writable;
  stdin?: Readable;
  createRuntime(events: EventSink): Promise<RecursRuntime>;
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
  return 1;
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
        `Error: ${error instanceof Error ? error.message : "Unknown failure"}\n`,
      );
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
    const result = await runtime.submit(parsed.prompt);
    if (isCommandResult(result)) {
      await renderCommandResult(result, dependencies.stdout, dependencies.stderr);
    }
    return 0;
  } catch (error) {
    await writeOutput(
      dependencies.stderr,
      `Error: ${error instanceof Error ? error.message : "Unknown failure"}\n`,
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
