import { Readable, Writable } from "node:stream";

import type { EventSink } from "@recurs/core";
import { AgentLoop, AgentLoopError, JsonlSessionStore } from "@recurs/core";
import { ScriptedProvider } from "@recurs/providers";
import {
  PermissionEngine,
  ToolRegistry,
} from "@recurs/tools";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  RecursRuntime,
  RuntimeError,
  createCommandRegistry,
  runCli,
  type CliDependencies,
} from "../src/index.js";

class TextOutput extends Writable {
  value = "";

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.value += chunk.toString();
    callback();
  }
}

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createRuntime(sink: EventSink): Promise<RecursRuntime> {
  const directory = await mkdtemp(path.join(tmpdir(), "recurs-run-mode-"));
  directories.push(directory);
  const sessions = new JsonlSessionStore(path.join(directory, "sessions"));
  await sessions.append("s1", {
    version: 1,
    type: "session_created",
    sessionId: "s1",
    at: "2026-07-10T00:00:00.000Z",
    cwd: directory,
    model: "scripted",
  });
  const provider = new ScriptedProvider([
    [
      { type: "text_delta", text: "inspection complete" },
      { type: "usage", inputTokens: 3, outputTokens: 2 },
      { type: "done", stopReason: "complete" },
    ],
  ]);
  const loop = new AgentLoop({
    provider,
    tools: new ToolRegistry(),
    permissions: new PermissionEngine("ask_always"),
    approvals: { async request() { return "deny"; } },
    sessions,
    emit: sink.emit,
    createToolContext(session, signal) {
      return {
        sessionId: session.id,
        cwd: session.cwd,
        signal,
        executionMode: session.executionMode,
        readRevisions: new Map(),
      };
    },
  });
  return new RecursRuntime(
    {
      commands: createCommandRegistry({ sessions, provider }),
      loop,
      sessions,
      confirm: async () => false,
    },
    await sessions.loadState("s1"),
  );
}

function dependencies(stdout: TextOutput, stderr: TextOutput): CliDependencies {
  return { stdout, stderr, createRuntime };
}

describe("runCli", () => {
  it("emits normalized JSONL events in run mode", async () => {
    const stdout = new TextOutput();
    const stderr = new TextOutput();

    const exitCode = await runCli(
      ["run", "inspect", "--format", "jsonl"],
      dependencies(stdout, stderr),
    );
    const events = stdout.value
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; version?: number });

    expect(exitCode).toBe(0);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["turn_started", "model_completed", "turn_completed"]),
    );
    expect(events.every((event) => event.version === undefined)).toBe(true);
    expect(stderr.value).toBe("");
  });

  it("streams plain text without duplicating the final answer", async () => {
    const stdout = new TextOutput();
    const stderr = new TextOutput();

    const exitCode = await runCli(
      ["run", "inspect", "--format", "text"],
      dependencies(stdout, stderr),
    );

    expect(exitCode).toBe(0);
    expect(stdout.value.match(/inspection complete/gu)).toHaveLength(1);
    expect(stderr.value).toBe("");
  });

  it("returns usage errors without creating a runtime", async () => {
    const stdout = new TextOutput();
    const stderr = new TextOutput();
    let created = false;

    const exitCode = await runCli(["run", "--format", "xml"], {
      stdout,
      stderr,
      async createRuntime(sink) {
        created = true;
        return createRuntime(sink);
      },
    });

    expect(exitCode).toBe(2);
    expect(created).toBe(false);
    expect(stderr.value).toContain("Usage:");
  });

  it("prints help without requiring a provider", async () => {
    const stdout = new TextOutput();
    const stderr = new TextOutput();

    expect(
      await runCli(["--help"], {
        stdout,
        stderr,
        async createRuntime() {
          throw new Error("must not create runtime");
        },
      }),
    ).toBe(0);
    expect(stdout.value).toContain("recurs run <prompt>");
  });

  it("opens the interactive CLI and routes local quit without a prompt run", async () => {
    const stdout = new TextOutput();
    const stderr = new TextOutput();

    const exitCode = await runCli([], {
      stdin: Readable.from(["/quit\n"]),
      stdout,
      stderr,
      createRuntime,
    });

    expect(exitCode).toBe(0);
    expect(stdout.value).toContain("Recurs — local harness mode");
    expect(stderr.value).toBe("");
  });

  it.each([
    [new RuntimeError("provider_not_configured", "provider missing"), 2],
    [new AgentLoopError("cancelled", "cancelled"), 130],
    [new AgentLoopError("provider_failed", "provider failed"), 1],
  ] as const)("maps terminal errors to documented exit codes", async (error, code) => {
    const stdout = new TextOutput();
    const stderr = new TextOutput();

    const exitCode = await runCli(["run", "inspect"], {
      stdout,
      stderr,
      async createRuntime() {
        return {
          async submit() {
            throw error;
          },
        } as unknown as RecursRuntime;
      },
    });

    expect(exitCode).toBe(code);
    expect(stderr.value).toContain(error.message);
  });
});
