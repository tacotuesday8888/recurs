import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  RecursRuntime,
  createCommandRegistry,
} from "@recurs/cli";
import {
  AgentLoopDirectExecutor,
  BackendRunCoordinator,
  ChildAgentManager,
  JsonlSessionStore,
  bindRunAuthorization,
  isPinnedSessionState,
  type RecursEvent,
} from "@recurs/core";
import {
  createHostInvocation,
  type BackendResolver,
} from "@recurs/contracts";
import {
  ScriptedProvider,
  type ProviderEvent,
} from "@recurs/providers";
import {
  CheckpointStore,
  FileCheckpointStore,
  ToolRegistry,
  createApplyPatchTool,
  createGitDiffTool,
  createGitStatusTool,
  createListFilesTool,
  createReadFileTool,
  createRunCommandTool,
  createRunVerificationTool,
  createSearchTextTool,
  type Checkpoint,
} from "@recurs/tools";
import { afterEach, describe, expect, it } from "vitest";

import { testAt, testBackendPin } from "../support/backend.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function toolTurn(
  id: string,
  name: string,
  arguments_: unknown,
): ProviderEvent[] {
  return [
    { type: "tool_call", call: { id, name, arguments: arguments_ } },
    { type: "done", stopReason: "tool_calls" },
  ];
}

async function createFixture(): Promise<{
  root: string;
  project: string;
  initialHash: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "recurs-e2e-"));
  roots.push(root);
  const project = path.join(root, "project");
  await mkdir(path.join(project, "src"), { recursive: true });
  await mkdir(path.join(project, "test"), { recursive: true });
  const initial = "export const value = 1;\n";
  await writeFile(path.join(project, "src", "value.ts"), initial, "utf8");
  await writeFile(
    path.join(project, "package.json"),
    `${JSON.stringify(
      {
        name: "recurs-e2e-fixture",
        private: true,
        type: "module",
        scripts: { test: "node --test" },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    path.join(project, "test", "value.test.js"),
    [
      'import assert from "node:assert/strict";',
      'import { readFile } from "node:fs/promises";',
      'import test from "node:test";',
      "",
      'test("agent changed value", async () => {',
      '  const source = await readFile(new URL("../src/value.ts", import.meta.url), "utf8");',
      '  assert.match(source, /value = 2/);',
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  await execFileAsync("git", ["init", "--quiet"], { cwd: project });
  await execFileAsync("git", ["add", "package.json", "src/value.ts", "test/value.test.js"], {
    cwd: project,
  });
  return {
    root,
    project,
    initialHash: createHash("sha256").update(initial).digest("hex"),
  };
}

interface TestRuntime {
  runtime: RecursRuntime;
  events: RecursEvent[];
  provider: ScriptedProvider;
  sessions: JsonlSessionStore;
}

class RecordingCheckpointStore extends CheckpointStore {
  readonly captures: Array<{
    phase: "before" | "after";
    sessionId: string;
    toolCallId: string;
  }> = [];

  async captureBefore(
    sessionId: string,
    toolCallId: string,
  ): Promise<Checkpoint> {
    this.captures.push({ phase: "before", sessionId, toolCallId });
    return {
      id: `checkpoint-${sessionId}-${toolCallId}`,
      sessionId,
      toolCallId,
      before: {},
    };
  }

  async captureAfter(
    checkpoint: Checkpoint,
  ): Promise<Checkpoint> {
    this.captures.push({
      phase: "after",
      sessionId: checkpoint.sessionId,
      toolCallId: checkpoint.toolCallId,
    });
    return { ...checkpoint, after: {} };
  }

  async undoLatest(): Promise<{ restored: string[]; deleted: string[] }> {
    return { restored: [], deleted: [] };
  }
}

async function createTestRuntime(
  root: string,
  project: string,
  provider: ScriptedProvider,
  sessionId?: string,
  checkpointStore?: CheckpointStore,
): Promise<TestRuntime> {
  const sessions = new JsonlSessionStore(path.join(root, "sessions"));
  const checkpoints = checkpointStore
    ?? new FileCheckpointStore(path.join(root, "checkpoints"));
  const id = sessionId ?? "session-1";
  if (sessionId === undefined) {
    await sessions.createPinnedSession({
      id,
      at: testAt,
      cwd: project,
      backend: testBackendPin(),
    });
  }
  const state = await sessions.loadState(id);
  if (!isPinnedSessionState(state)) {
    throw new Error("Expected a pinned test session");
  }
  const events: RecursEvent[] = [];
  const tools = new ToolRegistry([], { checkpoints });
  const coordinatorReference: { current?: BackendRunCoordinator } = {};
  const childAgents = new ChildAgentManager({
    sessions,
    getCoordinator: () => coordinatorReference.current,
    async emit(event) {
      events.push(event);
    },
  });
  tools.register(childAgents.createTool());
  tools.register(createReadFileTool());
  tools.register(createListFilesTool());
  tools.register(createSearchTextTool());
  tools.register(createApplyPatchTool());
  tools.register(createRunCommandTool());
  tools.register(createRunVerificationTool());
  tools.register(createGitStatusTool());
  tools.register(createGitDiffTool());
  const direct = new AgentLoopDirectExecutor({
    tools,
    approvals: { async request() { return "allow_once"; } },
    sessions,
    async emit(event) {
      events.push(event);
    },
    createToolContext(session, signal, runContext) {
      return {
        sessionId: session.id,
        cwd: session.cwd,
        signal,
        executionMode: session.executionMode,
        readRevisions: new Map(),
        ...(runContext === undefined ? {} : { runContext }),
      };
    },
  });
  const resolver: BackendResolver = {
    async resolve(input) {
      return {
        kind: "direct",
        pin: state.backend.pin,
        authorization: bindRunAuthorization({
          id: `authorization-${input.operationId}`,
          operation: input.operation,
          sessionId: input.sessionId,
          operationId: input.operationId,
          turnId: input.turnId,
          pin: state.backend.pin,
          connectionRevision: 1,
          policyRevision: state.backend.pin.policyRevisionAtCreation,
          context: input.context,
          maxRequests: 40,
          expiresAt: "2099-01-01T00:00:00.000Z",
        }, new Date(testAt)),
        async createProvider() { return provider; },
      };
    },
  };
  const coordinator = new BackendRunCoordinator({ sessions, resolver, direct });
  coordinatorReference.current = coordinator;
  const runtimeReference: { current?: RecursRuntime } = {};
  const commands = createCommandRegistry({
    sessions,
    provider,
    checkpoints,
    signal: () =>
      runtimeReference.current?.currentSignal() ?? new AbortController().signal,
  });
  const runtime = new RecursRuntime(
    {
      commands,
      coordinator,
      sessions,
      confirm: async () => true,
      now: () => "2026-07-10T00:00:00.000Z",
    },
    state,
  );
  runtimeReference.current = runtime;
  return { runtime, events, provider, sessions };
}

describe("Recurs end-to-end coding harness", () => {
  it("runs Explore, Implement, and Review children before parent synthesis", async () => {
    const fixture = await createFixture();
    const patch = [
      "diff --git a/src/value.ts b/src/value.ts",
      "--- a/src/value.ts",
      "+++ b/src/value.ts",
      "@@ -1 +1 @@",
      "-export const value = 1;",
      "+export const value = 2;",
      "",
    ].join("\n");
    const provider = new ScriptedProvider([
      toolTurn("delegate-explore", "delegate_task", {
        profile: "explore",
        description: "Inspect the value fixture",
        prompt: "Find the required value and cite the current source.",
      }),
      toolTurn("explore-read", "read_file", { path: "src/value.ts" }),
      [
        { type: "text_delta", text: "Explore handoff: value is still 1 in src/value.ts." },
        { type: "done", stopReason: "complete" },
      ],
      toolTurn("delegate-implement", "delegate_task", {
        profile: "implement",
        description: "Change the value fixture",
        prompt: "Change value from 1 to 2 and run the focused test.",
      }),
      toolTurn("implement-read", "read_file", { path: "src/value.ts" }),
      toolTurn("implement-patch", "apply_patch", {
        patch,
        files: [{ path: "src/value.ts", expected_hash: fixture.initialHash }],
      }),
      toolTurn("implement-test", "run_verification", { command: "npm test" }),
      [
        { type: "text_delta", text: "Implement handoff: changed value to 2; npm test passed." },
        { type: "done", stopReason: "complete" },
      ],
      toolTurn("delegate-review", "delegate_task", {
        profile: "review",
        description: "Review the value change",
        prompt: "Review the diff and independently rerun the focused test.",
      }),
      toolTurn("review-diff", "git_diff", {}),
      toolTurn("review-test", "run_verification", { command: "npm test" }),
      [
        { type: "text_delta", text: "Review handoff: diff is scoped and npm test passes." },
        { type: "done", stopReason: "complete" },
      ],
      toolTurn("delegate-over-limit", "delegate_task", {
        profile: "explore",
        description: "Unnecessary fourth child",
        prompt: "Inspect again.",
      }),
      [
        {
          type: "text_delta",
          text: "Parent synthesis: value is 2, implementation and independent review passed, and the child limit was enforced.",
        },
        { type: "done", stopReason: "complete" },
      ],
    ]);
    const checkpoints = new RecordingCheckpointStore();
    const harness = await createTestRuntime(
      fixture.root,
      fixture.project,
      provider,
      undefined,
      checkpoints,
    );
    const interactive = createHostInvocation({
      invocation: "repl",
      userPresent: true,
      remote: false,
      scripted: false,
      embedding: "cli",
    });

    await harness.runtime.submit("/permissions approved_for_me");
    await harness.runtime.submit("/agents mode standard");
    const result = await harness.runtime.submit(
      "Use specialized children to change value to 2 and verify it.",
      interactive,
    );

    const requestTrace = provider.requests.map((request, index) => ({
      index,
      prompt: request.messages.findLast((message) => message.role === "user")
        ?.content.slice(0, 120),
    }));
    expect(result, JSON.stringify(requestTrace, null, 2)).toMatchObject({
      finalText: expect.stringContaining("Parent synthesis"),
    });
    expect(await readFile(path.join(fixture.project, "src", "value.ts"), "utf8"))
      .toContain("value = 2");

    const entries = await harness.sessions.list();
    expect(entries).toHaveLength(4);
    const childStates = [];
    for (const entry of entries) {
      if (entry.id === harness.runtime.session.id) continue;
      const state = await harness.sessions.loadState(entry.id);
      if (!isPinnedSessionState(state)) {
        throw new Error("Expected a pinned child session");
      }
      childStates.push(state);
    }
    expect(childStates).toHaveLength(3);
    expect(childStates.map((state) => state.agent.profile?.id).sort()).toEqual([
      "explore_v1",
      "implement_v1",
      "review_v1",
    ]);
    expect(childStates.every((state) => state.agentLifecycle.status === "completed"))
      .toBe(true);
    const childByProfile = new Map(
      childStates.map((state) => [state.agent.profile!.id, state] as const),
    );
    expect(childByProfile.get("implement_v1")?.agentResult).toMatchObject({
      changedFiles: ["src/value.ts"],
      evidence: expect.arrayContaining(["npm test exited 0"]),
    });
    expect(childByProfile.get("review_v1")?.agentResult).toMatchObject({
      changedFiles: [],
      evidence: expect.arrayContaining(["npm test exited 0"]),
    });

    const parent = await harness.sessions.loadState(harness.runtime.session.id);
    if (!isPinnedSessionState(parent)) {
      throw new Error("Expected a pinned parent session");
    }
    const explore = parent.toolOutcomes["delegate-explore"];
    const implement = parent.toolOutcomes["delegate-implement"];
    const review = parent.toolOutcomes["delegate-review"];
    expect(explore).toMatchObject({
      type: "completed",
      result: { metadata: { profileId: "explore_v1" } },
    });
    expect(implement).toMatchObject({
      type: "completed",
      result: {
        metadata: {
          profileId: "implement_v1",
          changedFiles: ["src/value.ts"],
          evidence: expect.arrayContaining(["npm test exited 0"]),
          checkpointId: expect.any(String),
        },
      },
    });
    expect(review).toMatchObject({
      type: "completed",
      result: {
        metadata: {
          profileId: "review_v1",
          evidence: expect.arrayContaining(["npm test exited 0"]),
          checkpointId: expect.any(String),
        },
      },
    });
    expect(checkpoints.captures).toEqual(expect.arrayContaining([
      {
        phase: "before",
        sessionId: harness.runtime.session.id,
        toolCallId: "delegate-implement",
      },
      {
        phase: "after",
        sessionId: harness.runtime.session.id,
        toolCallId: "delegate-implement",
      },
      {
        phase: "before",
        sessionId: harness.runtime.session.id,
        toolCallId: "delegate-review",
      },
      {
        phase: "after",
        sessionId: harness.runtime.session.id,
        toolCallId: "delegate-review",
      },
    ]));
    if (explore?.type !== "completed") {
      throw new Error("Expected completed Explore delegation");
    }
    expect(explore.result.metadata).not.toHaveProperty("checkpointId");
    expect(parent.toolOutcomes["delegate-over-limit"]).toMatchObject({
      type: "failed",
      error: {
        code: "tool_failed",
        message: expect.stringContaining("Agent child limit reached (3)"),
      },
    });
    expect(parent.messages.filter((message) => message.role === "tool")
      .map((message) => message.content)).toEqual(expect.arrayContaining([
        expect.stringContaining("Explore handoff"),
        expect.stringContaining("Implement handoff"),
        expect.stringContaining("Review handoff"),
      ]));

    expect(harness.events.filter((event) =>
      event.type === "agent_started" || event.type === "agent_completed"
    ).map((event) => [event.type, event.profileId])).toEqual([
      ["agent_started", "explore_v1"],
      ["agent_completed", "explore_v1"],
      ["agent_started", "implement_v1"],
      ["agent_completed", "implement_v1"],
      ["agent_started", "review_v1"],
      ["agent_completed", "review_v1"],
    ]);
    expect(provider.requests[1]?.tools.map((tool) => tool.name)).toEqual([
      "read_file", "list_files", "search_text", "git_status", "git_diff",
    ]);
    expect(provider.requests[4]?.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["apply_patch", "run_verification"]),
    );
    expect(provider.requests[4]?.tools.map((tool) => tool.name))
      .not.toContain("delegate_task");
    expect(provider.requests[9]?.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["git_diff", "run_verification"]),
    );
    const reviewTools = provider.requests[9]?.tools.map((tool) => tool.name) ?? [];
    expect(reviewTools).not.toContain("apply_patch");
    expect(reviewTools).not.toContain("run_command");
    expect(reviewTools).not.toContain("delegate_task");
    expect(provider.requests).toHaveLength(14);
  }, 60_000);

  it("reads, patches, verifies, persists, resumes, reviews, and safely undoes", async () => {
    const fixture = await createFixture();
    const patch = [
      "diff --git a/src/value.ts b/src/value.ts",
      "--- a/src/value.ts",
      "+++ b/src/value.ts",
      "@@ -1 +1 @@",
      "-export const value = 1;",
      "+export const value = 2;",
      "",
    ].join("\n");
    const codingProvider = new ScriptedProvider([
      toolTurn("read-1", "read_file", { path: "src/value.ts" }),
      toolTurn("patch-1", "apply_patch", {
        patch,
        files: [
          { path: "src/value.ts", expected_hash: fixture.initialHash },
        ],
      }),
      toolTurn("test-1", "run_command", { command: "npm test" }),
      [
        {
          type: "text_delta",
          text: "Changed value to 2 and verified the fixture test passes.",
        },
        { type: "done", stopReason: "complete" },
      ],
    ]);
    const first = await createTestRuntime(
      fixture.root,
      fixture.project,
      codingProvider,
    );

    await first.runtime.submit("/permissions approved_for_me");
    await first.runtime.submit("/goal change value and verify tests");
    await first.runtime.submit("Change value to 2 and run tests");

    expect(codingProvider.requests[0]?.messages[0]?.content).toContain(
      "change value and verify tests",
    );

    expect(await readFile(path.join(fixture.project, "src", "value.ts"), "utf8")).toContain(
      "value = 2",
    );
    expect(first.events).toContainEqual(
      expect.objectContaining({
        type: "verification_recorded",
        evidence: ["npm test exited 0"],
      }),
    );
    expect(first.runtime.session.goal).toMatchObject({
      objective: "change value and verify tests",
      progress: "Changed value to 2 and verified the fixture test passes.",
      evidence: ["npm test exited 0"],
    });
    await first.runtime.submit("/goal complete");
    expect(first.runtime.session.goal?.status).toBe("completed");

    const reviewProvider = new ScriptedProvider([
      [
        { type: "text_delta", text: "No review findings." },
        { type: "done", stopReason: "complete" },
      ],
    ]);
    const resumed = await createTestRuntime(
      fixture.root,
      fixture.project,
      reviewProvider,
      first.runtime.session.id,
    );
    expect(resumed.runtime.session.goal).toMatchObject({
      objective: "change value and verify tests",
      status: "completed",
    });

    await resumed.runtime.submit("/review");
    expect(reviewProvider.requests[0]?.messages.at(-1)?.content).toContain(
      "+export const value = 2;",
    );
    expect(reviewProvider.requests[0]?.tools.map((tool) => tool.name)).not.toContain(
      "apply_patch",
    );
    await resumed.runtime.submit("/undo");

    expect(await readFile(path.join(fixture.project, "src", "value.ts"), "utf8")).toContain(
      "value = 1",
    );
  }, 60_000);
});
