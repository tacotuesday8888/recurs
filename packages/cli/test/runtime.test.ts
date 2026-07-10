import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ScriptedProvider } from "@recurs/providers";
import {
  AgentLoop,
  JsonlSessionStore,
  type EventSink,
} from "@recurs/core";
import {
  PermissionEngine,
  ToolRegistry,
  type ApprovalHandler,
} from "@recurs/tools";
import { afterEach, describe, expect, it } from "vitest";

import {
  RecursRuntime,
  createCommandRegistry,
} from "../src/index.js";

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
  await sessions.append("s1", {
    version: 1,
    type: "session_created",
    sessionId: "s1",
    at: "2026-07-10T00:00:00.000Z",
    cwd: directory,
    model: "scripted",
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
    permissions: new PermissionEngine("ask_always"),
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
});
