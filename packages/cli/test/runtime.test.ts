import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ScriptedProvider } from "@recurs/providers";
import {
  createHostInvocation,
  type CoordinatedRunInput,
  type RunCoordinator,
} from "@recurs/contracts";
import {
  AgentLoop,
  JsonlSessionStore,
  createWorkspaceShell,
  type EventSink,
} from "@recurs/core";
import {
  ToolRegistry,
  type ApprovalHandler,
} from "@recurs/tools";
import { afterEach, describe, expect, it } from "vitest";

import {
  RecursRuntime,
  createCommandRegistry,
} from "../src/index.js";
import { testAt, testBackendPin } from "../../../tests/support/backend.js";

const directories: string[] = [];
const sink: EventSink = { async emit() {} };

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function runtimeWith(provider: ScriptedProvider): Promise<RecursRuntime> {
  const directory = await mkdtemp(path.join(tmpdir(), "recurs-runtime-"));
  directories.push(directory);
  const sessions = new JsonlSessionStore(path.join(directory, "sessions"));
  await sessions.createPinnedSession({
    id: "s1",
    at: testAt,
    cwd: directory,
    backend: testBackendPin(),
  });
  const state = await sessions.loadState("s1");
  const approvals: ApprovalHandler = {
    async request() {
      return "deny";
    },
  };
  const loop = new AgentLoop({
    provider,
    tools: new ToolRegistry(),
    approvals,
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
      confirm: async () => true,
      now: () => "2026-07-10T00:00:00.000Z",
    },
    state,
  );
}

describe("RecursRuntime", () => {
  it("sanitizes an AgentLoop failure after compatibility wrapping", async () => {
    const canary = "RECURS_COMPATIBILITY_TOOL_NAME_CANARY";
    const provider = new ScriptedProvider(
      ["one", "two", "three"].map((id) => [
        {
          type: "tool_call" as const,
          call: { id, name: canary, arguments: { value: "same" } },
        },
        { type: "done" as const, stopReason: "tool_calls" as const },
      ]),
    );
    const runtime = await runtimeWith(provider);
    let thrown: unknown;

    try {
      await runtime.submit("repeat");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      message: "Repeated tool interaction detected",
      failure: {
        phase: "started",
        code: "runtime_failed",
        safeMessage: "Repeated tool interaction detected",
      },
    });
    expect(JSON.stringify(thrown)).not.toContain(canary);
  });

  it("routes slash commands locally and prompts through the same loop", async () => {
    const provider = new ScriptedProvider([
      [
        { type: "text_delta", text: "inspected" },
        { type: "done", stopReason: "complete" },
      ],
    ]);
    const runtime = await runtimeWith(provider);

    await runtime.submit("/goal ship auth");
    expect(runtime.session.goal?.objective).toBe("ship auth");
    expect(provider.requests).toHaveLength(0);

    const result = await runtime.submit("inspect the repo");
    expect(result).toMatchObject({ finalText: "inspected" });
    expect(provider.requests).toHaveLength(1);
    expect(runtime.session.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  it("does not send malformed or unknown slash commands to the provider", async () => {
    const provider = new ScriptedProvider([]);
    const runtime = await runtimeWith(provider);

    expect(await runtime.submit("/missing")).toMatchObject({ level: "error" });
    expect(await runtime.submit("/bad! command")).toMatchObject({ level: "error" });
    expect(provider.requests).toHaveLength(0);
  });

  it("runs /review-style submit results with their temporary mode override", async () => {
    const provider = new ScriptedProvider([
      [
        { type: "text_delta", text: "planned" },
        { type: "done", stopReason: "complete" },
      ],
    ]);
    const runtime = await runtimeWith(provider);

    const result = await runtime.submit("/plan inspect auth");

    expect(result).toMatchObject({ finalText: "planned" });
    expect(provider.requests[0]?.messages[0]?.content).toContain(
      '"executionMode":"plan"',
    );
  });

  it("resumes exact pinned history from the workspace shell and activates its coordinator", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "recurs-workspace-resume-"));
    directories.push(directory);
    const sessions = new JsonlSessionStore(path.join(directory, "sessions"));
    await sessions.createPinnedSession({
      id: "historical",
      at: testAt,
      cwd: directory,
      backend: testBackendPin(),
    });
    const started: CoordinatedRunInput[] = [];
    const coordinator: RunCoordinator = {
      async start(input) {
        started.push(input);
        return {
          events: (async function* () {})(),
          outcome: Promise.resolve({
            ok: true,
            result: {
              finalText: "resumed run",
              usage: null,
              usageSource: "unavailable",
              steps: null,
              changedFiles: [],
              changedFilesSource: "none",
              evidence: [],
              evidenceSource: "none",
            },
          }),
        };
      },
    };
    const runtime = new RecursRuntime(
      {
        commands: createCommandRegistry({ sessions }),
        coordinator,
        sessions,
        confirm: async () => true,
      },
      createWorkspaceShell(directory),
    );

    await expect(runtime.submit("/resume historical")).resolves.toMatchObject({
      type: "message",
      text: "Resumed session historical",
    });
    expect(runtime.state).toMatchObject({
      type: "session",
      session: { id: "historical" },
    });

    await expect(runtime.submit("continue", createHostInvocation({
      invocation: "repl",
      userPresent: true,
      remote: false,
      scripted: false,
      embedding: "cli",
    }))).resolves.toMatchObject({ finalText: "resumed run" });
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      sessionId: "historical",
      prompt: "continue",
    });
  });
});
