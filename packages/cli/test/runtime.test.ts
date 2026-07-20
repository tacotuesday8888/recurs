import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ScriptedProvider,
  type ModelProvider,
  type ProviderRequest,
} from "@recurs/providers";
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
  CommandRegistry,
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

async function runtimeWith(
  provider: ModelProvider,
  eventSink: EventSink = sink,
): Promise<RecursRuntime> {
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
    emit: eventSink.emit,
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
  it("disposes owned resources exactly once and rejects later submissions", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "recurs-runtime-close-"));
    directories.push(directory);
    const sessions = new JsonlSessionStore(path.join(directory, "sessions"));
    let disposals = 0;
    const runtime = new RecursRuntime(
      {
        commands: createCommandRegistry({ sessions }),
        sessions,
        async dispose() { disposals += 1; },
      },
      createWorkspaceShell(directory),
    );

    await Promise.all([runtime.close(), runtime.close()]);

    expect(disposals).toBe(1);
    await expect(runtime.submit("/help")).rejects.toMatchObject({
      code: "busy",
      message: "Runtime is closed",
    });
  });

  it("threads the exact trusted host invocation into slash-command context", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "recurs-command-invocation-"));
    directories.push(directory);
    const sessions = new JsonlSessionStore(path.join(directory, "sessions"));
    const session = await sessions.createPinnedSession({
      id: "s1",
      at: testAt,
      cwd: directory,
      backend: testBackendPin(),
    });
    let received: unknown;
    const commands = new CommandRegistry([{
      name: "capture",
      description: "Capture command trust context",
      usage: "/capture",
      async execute(_args, context) {
        received = context.invocation;
        return { type: "message", level: "info", text: "captured" };
      },
    }]);
    const runtime = new RecursRuntime({ commands, sessions }, session);
    const invocation = createHostInvocation({
      invocation: "repl",
      userPresent: true,
      remote: false,
      scripted: false,
      embedding: "cli",
    });

    await expect(runtime.submit("/capture", invocation)).resolves.toMatchObject({
      text: "captured",
    });
    expect(received).toBe(invocation);
  });

  it("explains agent modes honestly before onboarding creates a session", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "recurs-agent-mode-guide-"));
    directories.push(directory);
    const sessions = new JsonlSessionStore(path.join(directory, "sessions"));
    const runtime = new RecursRuntime(
      {
        commands: createCommandRegistry({ sessions }),
        sessions,
        confirm: async () => true,
      },
      createWorkspaceShell(directory),
    );

    await expect(runtime.submit("/agents")).resolves.toMatchObject({
      type: "message",
      level: "info",
      text: expect.stringContaining("default to Balanced"),
    });
    await expect(runtime.submit("/agents profiles")).resolves.toMatchObject({
      type: "message",
      level: "info",
      text: expect.stringMatching(/Explore[\s\S]*Implement[\s\S]*Review/u),
    });
    await expect(runtime.submit("/agents mode economy")).resolves.toMatchObject({
      type: "message",
      level: "warning",
      text: expect.stringContaining("Connect a model"),
    });
  });

  it("serves one shared provider guide from the sessionless shell", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "recurs-provider-guide-"));
    directories.push(directory);
    const sessions = new JsonlSessionStore(path.join(directory, "sessions"));
    const queries: string[] = [];
    const runtime = new RecursRuntime(
      {
        commands: createCommandRegistry({ sessions }),
        sessions,
        confirm: async () => true,
        async providerGuide(query) {
          queries.push(query);
          return "Connected\n  None yet\n\nDetected locally\n  Ollama";
        },
      },
      createWorkspaceShell(directory),
    );

    await expect(runtime.submit("/provider kimi")).resolves.toMatchObject({
      type: "message",
      text: expect.stringContaining("Detected locally"),
    });
    await expect(runtime.submit("/connect")).resolves.toMatchObject({
      type: "message",
      text: expect.stringContaining("Connected"),
    });
    expect(queries).toEqual(["kimi", ""]);
  });

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

  it("queues plain input into the exact active direct-provider turn", async () => {
    let releaseFirst!: () => void;
    let markStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const requests: ProviderRequest[] = [];
    const provider: ModelProvider = {
      id: "runtime-steering-provider",
      async *stream(request) {
        requests.push(request);
        if (requests.length === 1) {
          markStarted();
          await firstRelease;
          yield { type: "text_delta", text: "initial" };
        } else {
          yield { type: "text_delta", text: "focused" };
        }
        yield { type: "done", stopReason: "complete" };
      },
    };
    const runtime = await runtimeWith(provider);

    const run = runtime.submit("inspect everything");
    await firstStarted;
    const turnId = runtime.activeTurnId;
    expect(turnId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(runtime.canAcceptSteering).toBe(true);
    await expect(runtime.submit("focus on tests")).resolves.toMatchObject({
      type: "message",
      level: "info",
      text: expect.stringContaining(`turn ${turnId}`),
    });
    releaseFirst();

    await expect(run).resolves.toMatchObject({ finalText: "focused", steps: 2 });
    expect(runtime.canAcceptSteering).toBe(false);
    expect(requests).toHaveLength(2);
    expect(runtime.session.messages.map((message) => message.content)).toEqual([
      "inspect everything",
      "initial",
      "focus on tests",
      "focused",
    ]);
  });

  it("durably queues a separate turn and runs it after the active turn", async () => {
    let releaseFirst!: () => void;
    let markStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const requests: ProviderRequest[] = [];
    const provider: ModelProvider = {
      id: "runtime-turn-queue-provider",
      async *stream(request) {
        requests.push(request);
        if (requests.length === 1) {
          markStarted();
          await firstRelease;
          yield { type: "text_delta", text: "first complete" };
        } else {
          yield { type: "text_delta", text: "second complete" };
        }
        yield { type: "done", stopReason: "complete" };
      },
    };
    const runtime = await runtimeWith(provider);

    const run = runtime.submit("first task");
    await firstStarted;
    expect(runtime.canAcceptLiveInput).toBe(true);
    const admission = runtime.submit("/queue second task");
    await Promise.resolve();
    releaseFirst();

    await expect(admission).resolves.toMatchObject({
      type: "message",
      level: "info",
      text: expect.stringContaining("Queued separate turn"),
    });
    await expect(run).resolves.toMatchObject({ finalText: "second complete" });
    expect(requests).toHaveLength(2);
    expect(runtime.session.queuedTurns).toEqual([]);
    expect(runtime.session.messages.map((message) => message.content)).toEqual([
      "first task",
      "first complete",
      "second task",
      "second complete",
    ]);
  });

  it("requires explicit recovery for a queue persisted while idle", async () => {
    const provider = new ScriptedProvider([[
      { type: "text_delta", text: "recovered" },
      { type: "done", stopReason: "complete" },
    ]]);
    const runtime = await runtimeWith(provider);

    await expect(runtime.submit("/queue saved task")).resolves.toMatchObject({
      type: "message",
      text: expect.stringContaining("explicit resume"),
    });
    expect(runtime.session.queuedTurns).toHaveLength(1);
    await expect(runtime.submit("unrelated task")).rejects.toMatchObject({
      code: "busy",
      message: expect.stringContaining("/queue resume"),
    });
    await expect(runtime.submit("/queue list")).resolves.toMatchObject({
      type: "message",
      text: expect.stringContaining("Queued turns: 1"),
    });

    await expect(runtime.submit("/queue resume")).resolves.toMatchObject({
      finalText: "recovered",
    });
    expect(runtime.session.queuedTurns).toEqual([]);
    expect(provider.requests).toHaveLength(1);
    expect(runtime.session.messages[0]?.content).toBe("saved task");
  });

  it("preserves a durably admitted turn when cancellation wins completion", async () => {
    let releaseFirst!: () => void;
    let markStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const runtimeRef: { current?: RecursRuntime } = {};
    const provider: ModelProvider = {
      id: "runtime-queued-cancel-provider",
      async *stream() {
        markStarted();
        await firstRelease;
        yield { type: "text_delta", text: "almost complete" };
        yield { type: "done", stopReason: "complete" };
      },
    };
    const runtime = await runtimeWith(provider, {
      async emit(event) {
        if (event.type === "prompt_queued") await runtimeRef.current?.cancel();
      },
    });
    runtimeRef.current = runtime;

    const run = runtime.submit("first task");
    await firstStarted;
    const admission = runtime.submit("/queue recover me");
    releaseFirst();

    await expect(admission).resolves.toMatchObject({
      type: "message",
      level: "info",
    });
    await expect(run).rejects.toMatchObject({
      failure: { code: "cancelled" },
    });
    expect(runtime.session.queuedTurns).toHaveLength(1);
    expect(runtime.session.queuedTurns[0]?.prompt).toBe("recover me");
  });

  it("keeps read-only slash commands safe during an active turn", async () => {
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const provider: ModelProvider = {
      id: "runtime-live-command-provider",
      async *stream() {
        markStarted();
        await blocked;
        yield { type: "text_delta", text: "done" };
        yield { type: "done", stopReason: "complete" };
      },
    };
    const runtime = await runtimeWith(provider);

    const run = runtime.submit("work");
    await started;
    await expect(runtime.submit("/status")).resolves.toMatchObject({
      type: "message",
      text: expect.stringContaining("Session: s1"),
    });
    await expect(runtime.submit("/help")).resolves.toMatchObject({
      type: "message",
      text: expect.stringContaining("/queue"),
    });
    release();
    await expect(run).resolves.toMatchObject({ finalText: "done" });
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
