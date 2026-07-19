import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  RecursRuntime,
  createCommandRegistry,
  createStandaloneRuntime,
  isCancellation,
} from "@recurs/cli";
import {
  AgentLoopDirectExecutor,
  AgentReviewPanel,
  BackendRunCoordinator,
  ChildAgentBatchManager,
  ChildAgentManager,
  GitPatchArtifactManager,
  GitWorktreeLeaseManager,
  JsonlSessionStore,
  TeamAgentManager,
  bindRunAuthorization,
  isPinnedSessionState,
  type RecursEvent,
} from "@recurs/core";
import {
  createHostInvocation,
  type BackendResolver,
  type ConnectionBoundModelProvider,
  type ProviderRequest,
} from "@recurs/contracts";
import {
  ProviderError,
  ScriptedProvider,
  type ProviderEvent,
} from "@recurs/providers";
import {
  CheckpointStore,
  FileCheckpointStore,
  ToolError,
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
  type runProcess,
} from "@recurs/tools";
import { afterEach, describe, expect, it } from "vitest";

import { testAt, testBackendPin } from "../support/backend.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

const fastGitRunner: typeof runProcess = async (command, args, options) => {
  if (options.signal?.aborted === true) {
    throw new ToolError("cancelled", `${command} was cancelled`);
  }
  try {
    const result = await execFileAsync(command, [...args], {
      cwd: options.cwd,
      signal: options.signal,
      timeout: options.timeoutMs,
      maxBuffer: options.maxOutputBytes,
      encoding: "utf8",
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    if (options.signal?.aborted === true) {
      throw new ToolError("cancelled", `${command} was cancelled`, { cause: error });
    }
    const exitCode = typeof error === "object" && error !== null &&
      "code" in error && typeof error.code === "number"
      ? error.code
      : -1;
    const acceptable = options.acceptableExitCodes ?? [0];
    if (acceptable.includes(exitCode)) {
      const stdout = typeof error === "object" && error !== null &&
        "stdout" in error && typeof error.stdout === "string" ? error.stdout : "";
      const stderr = typeof error === "object" && error !== null &&
        "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
      return { stdout, stderr, exitCode };
    }
    throw new ToolError("process_failed", `${command} exited with ${exitCode}`, {
      cause: error,
    });
  }
};

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
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "recurs-e2e-")));
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
  await execFileAsync("git", [
    "-c", "user.name=Recurs Tests",
    "-c", "user.email=tests@recurs.invalid",
    "commit", "--quiet", "-m", "initial",
  ], { cwd: project });
  return {
    root,
    project,
    initialHash: createHash("sha256").update(initial).digest("hex"),
  };
}

interface TestRuntime {
  runtime: RecursRuntime;
  events: RecursEvent[];
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
  provider: ConnectionBoundModelProvider,
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
  const worktrees = new GitWorktreeLeaseManager({
    rootDirectory: path.join(root, "agent-worktrees"),
    processRunner: fastGitRunner,
  });
  const childBatches = new ChildAgentBatchManager({
    sessions,
    children: childAgents,
    worktrees,
    async emit(event) {
      events.push(event);
    },
  });
  tools.register(childBatches.createTool());
  const teams = new TeamAgentManager({
    sessions,
    children: childAgents,
    worktrees,
    patches: new GitPatchArtifactManager(),
    reviews: new AgentReviewPanel({ sessions, children: childAgents }),
    checkpoints,
    async emit(event) {
      events.push(event);
    },
  });
  tools.register(teams.createTool());
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
  return { runtime, events, sessions };
}

interface BatchScenarioTask {
  readonly key: string;
  readonly profile: "explore" | "review";
  readonly description: string;
  readonly fail?: boolean;
}

class BatchScenarioProvider implements ConnectionBoundModelProvider {
  readonly id = "scripted";
  readonly adapterId = "scripted-v1";
  readonly connectionId = "test-connection";
  readonly requests: ProviderRequest[] = [];
  readonly childrenReady: Promise<void>;
  readonly completionOrder: string[] = [];
  parentToolOutput: string | null = null;
  maxActiveChildren = 0;
  #activeChildren = 0;
  #startedChildren = 0;
  #resolveChildrenReady!: () => void;
  #finalRelease: Promise<void>;
  #resolveFinalRelease!: () => void;

  constructor(private readonly options: {
    readonly tasks: readonly BatchScenarioTask[];
    readonly parentFinal: string;
    readonly barrier?: boolean;
    readonly cancelChildren?: boolean;
    readonly readyChildren?: number;
    readonly toolCallId?: string;
    readonly holdFinalKey?: string;
    readonly releaseFinalOnKey?: string;
  }) {
    this.childrenReady = new Promise<void>((resolve) => {
      this.#resolveChildrenReady = resolve;
    });
    this.#finalRelease = new Promise<void>((resolve) => {
      this.#resolveFinalRelease = resolve;
    });
  }

  #task(request: ProviderRequest): BatchScenarioTask | undefined {
    const prompt = request.messages.findLast((message) => message.role === "user")
      ?.content;
    if (prompt === undefined || !prompt.includes("You are a Recurs")) {
      return undefined;
    }
    return this.options.tasks.find((task) =>
      prompt.includes(`scenario:${task.key}`)
    );
  }

  async #waitForCancellation(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    this.requests.push({
      ...request,
      messages: [...request.messages],
      tools: [...request.tools],
    });
    const task = this.#task(request);
    const toolCallId = this.options.toolCallId ?? "delegate-batch";
    if (task === undefined) {
      const toolResult = request.messages.findLast((message) =>
        message.role === "tool" && message.toolCallId === toolCallId
      );
      if (toolResult === undefined) {
        yield {
          type: "tool_call",
          call: {
            id: toolCallId,
            name: "delegate_tasks",
            arguments: {
              tasks: this.options.tasks.map((item) => ({
                profile: item.profile,
                description: item.description,
                prompt: `scenario:${item.key}`,
              })),
            },
          },
        };
        yield { type: "done", stopReason: "tool_calls" };
        return;
      }
      this.parentToolOutput = toolResult.content;
      yield { type: "text_delta", text: this.options.parentFinal };
      yield { type: "done", stopReason: "complete" };
      return;
    }

    const hasToolResult = request.messages.some((message) => message.role === "tool");
    if (hasToolResult) {
      if (task.key === this.options.releaseFinalOnKey) {
        this.#resolveFinalRelease();
      }
      if (task.key === this.options.holdFinalKey) {
        await this.#finalRelease;
      }
      this.completionOrder.push(task.key);
      yield {
        type: "text_delta",
        text: `${task.key} handoff with isolated evidence`,
      };
      yield { type: "done", stopReason: "complete" };
      return;
    }

    this.#activeChildren += 1;
    this.maxActiveChildren = Math.max(
      this.maxActiveChildren,
      this.#activeChildren,
    );
    this.#startedChildren += 1;
    const readyChildren = this.options.readyChildren ?? this.options.tasks.length;
    if (this.#startedChildren === readyChildren) this.#resolveChildrenReady();
    try {
      if (this.options.cancelChildren === true) {
        await this.#waitForCancellation(request.signal);
        throw new ProviderError("cancelled", "Child request cancelled", false);
      }
      if (this.options.barrier === true) await this.childrenReady;
      if (task.fail === true) {
        throw new ProviderError("transport", "Injected child transport failure", false);
      }
      yield {
        type: "tool_call",
        call: {
          id: `read-${task.key}`,
          name: "read_file",
          arguments: { path: "src/value.ts", startLine: 1, endLine: 1 },
        },
      };
      yield { type: "done", stopReason: "tool_calls" };
    } finally {
      this.#activeChildren -= 1;
    }
  }
}

describe("Recurs end-to-end coding harness", () => {
  it("runs an assembled durable v4 team through repair, approval, and cleanup", async () => {
    const fixture = await createFixture();
    const dataDirectory = path.join(fixture.root, "assembled-data");
    const implemented = "export const value = 2;\n";
    const implementedHash = createHash("sha256").update(implemented).digest("hex");
    const implementationPatch = [
      "diff --git a/src/value.ts b/src/value.ts",
      "--- a/src/value.ts",
      "+++ b/src/value.ts",
      "@@ -1 +1 @@",
      "-export const value = 1;",
      "+export const value = 2;",
      "",
    ].join("\n");
    const repairPatch = [
      "diff --git a/src/value.ts b/src/value.ts",
      "--- a/src/value.ts",
      "+++ b/src/value.ts",
      "@@ -1 +1,2 @@",
      " export const value = 2;",
      "+// Repair evidence: the focused fixture test covers this value.",
      "",
    ].join("\n");
    const requestChanges = JSON.stringify({
      verdict: "request_changes",
      summary: "The candidate needs explicit focused-test evidence in the source.",
      findings: [{
        path: "src/value.ts",
        problem: "The staged source does not record the focused verification intent.",
        acceptance: "Add the bounded verification note without changing value 2.",
        evidence: ["The staged diff only changes the numeric value."],
      }],
      evidence: ["Inspected the complete staged diff."],
    });
    const approve = JSON.stringify({
      verdict: "approve",
      summary: "The repaired candidate is scoped and satisfies the fixture objective.",
      findings: [],
      evidence: ["Inspected the repaired staged diff and focused-test evidence."],
    });
    const provider = new ScriptedProvider([
      toolTurn("durable-team", "delegate_team", {
        description: "Change the value fixture and repair any review findings",
        tasks: [{
          description: "Implement value two",
          prompt: "Change value from 1 to 2 and run the focused fixture test.",
        }],
        review: {
          instructions: "Review the exact staged diff and require explicit evidence.",
        },
      }),
      toolTurn("implement-read", "read_file", { path: "src/value.ts" }),
      toolTurn("implement-patch", "apply_patch", {
        patch: implementationPatch,
        files: [{ path: "src/value.ts", expected_hash: fixture.initialHash }],
      }),
      toolTurn("implement-test", "run_verification", { command: "npm test" }),
      [
        { type: "text_delta", text: "Implemented value 2 and the fixture test passed." },
        { type: "done", stopReason: "complete" },
      ],
      toolTurn("review-one-diff", "git_diff", {}),
      [
        { type: "text_delta", text: requestChanges },
        { type: "done", stopReason: "complete" },
      ],
      toolTurn("review-two-diff", "git_diff", {}),
      [
        { type: "text_delta", text: approve },
        { type: "done", stopReason: "complete" },
      ],
      toolTurn("repair-read", "read_file", { path: "src/value.ts" }),
      toolTurn("repair-patch", "apply_patch", {
        patch: repairPatch,
        files: [{ path: "src/value.ts", expected_hash: implementedHash }],
      }),
      toolTurn("repair-test", "run_verification", { command: "npm test" }),
      [
        { type: "text_delta", text: "Repaired the finding and reran the fixture test." },
        { type: "done", stopReason: "complete" },
      ],
      toolTurn("review-repaired-diff", "git_diff", {}),
      [
        { type: "text_delta", text: approve },
        { type: "done", stopReason: "complete" },
      ],
      [
        {
          type: "text_delta",
          text: "Parent synthesis: the durable team repaired and approved the candidate.",
        },
        { type: "done", stopReason: "complete" },
      ],
    ]);
    const events: RecursEvent[] = [];
    const runtime = await createStandaloneRuntime(
      { async emit(event) { events.push(event); } },
      {
        cwd: fixture.project,
        dataDirectory,
        provider,
      },
    );
    runtime.setConfirmHandler(async () => true);
    const interactive = createHostInvocation({
      invocation: "repl",
      userPresent: true,
      remote: false,
      scripted: false,
      embedding: "cli",
    });

    await runtime.submit("/permissions approved_for_me");
    await runtime.submit("/agents mode standard_v4");
    const result = await runtime.submit(
      "Run the durable implementation and review team.",
      interactive,
    );

    expect(result.finalText).toContain("repaired and approved");
    expect(await readFile(path.join(fixture.project, "src/value.ts"), "utf8"))
      .toBe([
        "export const value = 2;",
        "// Repair evidence: the focused fixture test covers this value.",
        "",
      ].join("\n"));
    const projectId = createHash("sha256")
      .update(fixture.project)
      .digest("hex")
      .slice(0, 24);
    const projectData = path.join(dataDirectory, "projects", projectId);
    const sessions = new JsonlSessionStore(path.join(projectData, "sessions"));
    const parent = await sessions.loadState(runtime.session.id);
    if (!isPinnedSessionState(parent)) throw new Error("Expected pinned parent");
    expect(parent.toolOutcomes["durable-team"]).toMatchObject({
      type: "completed",
      result: {
        metadata: {
          status: "approved",
          operatingModeId: "standard_v4",
          repairRounds: 1,
          changedFiles: ["src/value.ts"],
        },
      },
    });

    const children = [];
    for (const entry of await sessions.list()) {
      if (entry.id === parent.id) continue;
      const child = await sessions.loadState(entry.id);
      if (!isPinnedSessionState(child)) throw new Error("Expected pinned child");
      children.push(child);
    }
    expect(children).toHaveLength(5);
    expect(children.every((child) =>
      child.agent.depth === 1 &&
      child.agent.parentAgentId === parent.agent.id &&
      child.agent.parentSessionId === parent.id &&
      child.agent.team?.runId !== undefined &&
      child.agentLifecycle.status === "completed"
    )).toBe(true);
    expect(children.map((child) =>
      `${child.agent.team?.role}:${child.agent.team?.round}`
    ).sort()).toEqual([
      "implement:0",
      "repair:1",
      "review:0",
      "review:0",
      "review:1",
    ]);
    expect(events.filter((event) =>
      event.type === "agent_team_activity" &&
      event.activity === "review_recorded"
    ).map((event) => event.round)).toEqual([0, 1]);
    expect((await readdir(path.join(projectData, "agent-worktrees")))
      .filter((entry) => entry !== ".owners")).toEqual([]);
    expect((await execFileAsync("git", ["worktree", "list", "--porcelain"], {
      cwd: fixture.project,
    })).stdout).not.toContain(`${path.sep}agent-worktrees${path.sep}`);
  }, 60_000);

  it("fans out in isolated worktrees and returns ordered evidence for parent synthesis", async () => {
    const fixture = await createFixture();
    const provider = new BatchScenarioProvider({
      barrier: true,
      tasks: [
        {
          key: "alpha",
          profile: "explore",
          description: "Inspect the value source",
        },
        {
          key: "beta",
          profile: "review",
          description: "Review the value source independently",
        },
      ],
      holdFinalKey: "alpha",
      releaseFinalOnKey: "beta",
      parentFinal: "Parent synthesis used both isolated child handoffs.",
    });
    const harness = await createTestRuntime(
      fixture.root,
      fixture.project,
      provider,
      undefined,
      new RecordingCheckpointStore(),
    );
    const result = await harness.runtime.submit(
      "Investigate the value source with independent children and synthesize.",
      createHostInvocation({
        invocation: "repl",
        userPresent: true,
        remote: false,
        scripted: false,
        embedding: "cli",
      }),
    );

    expect(result).toMatchObject({
      finalText: "Parent synthesis used both isolated child handoffs.",
    });
    const parent = await harness.sessions.loadState(harness.runtime.session.id);
    if (!isPinnedSessionState(parent)) throw new Error("Expected pinned parent");
    const outcome = parent.toolOutcomes["delegate-batch"];
    expect(outcome).toMatchObject({
      type: "completed",
      result: {
        metadata: {
          status: "completed",
          counts: { total: 2, completed: 2, failed: 0, cancelled: 0 },
          results: [
            {
              index: 0,
              profileId: "explore_v1",
              status: "completed",
              output: "alpha handoff with isolated evidence",
              evidence: [expect.stringMatching(
                /^read src\/value\.ts:1-1 \(sha256 [0-9a-f]{64}\)$/u,
              )],
            },
            {
              index: 1,
              profileId: "review_v1",
              status: "completed",
              output: "beta handoff with isolated evidence",
              evidence: [expect.stringMatching(
                /^read src\/value\.ts:1-1 \(sha256 [0-9a-f]{64}\)$/u,
              )],
            },
          ],
        },
      },
    });
    expect(provider.maxActiveChildren).toBe(2);
    expect(provider.completionOrder).toEqual(["beta", "alpha"]);
    expect(provider.parentToolOutput).toContain("alpha handoff");
    expect(provider.parentToolOutput).toContain("beta handoff");
    expect(provider.parentToolOutput!.indexOf("alpha handoff"))
      .toBeLessThan(provider.parentToolOutput!.indexOf("beta handoff"));

    const revision = (await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: fixture.project,
    })).stdout.trim();
    const entries = await harness.sessions.list();
    const children = [];
    for (const entry of entries) {
      if (entry.id === parent.id) continue;
      const child = await harness.sessions.loadState(entry.id);
      if (!isPinnedSessionState(child)) throw new Error("Expected pinned child");
      children.push(child);
    }
    expect(children).toHaveLength(2);
    expect(new Set(children.map((child) => child.cwd)).size).toBe(2);
    expect(children.every((child) =>
      child.agent.workspace?.repositoryRoot === fixture.project &&
      child.agent.workspace.revision === revision &&
      child.agent.workspace.worktreeRoot === child.cwd &&
      child.agentLifecycle.status === "completed"
    )).toBe(true);
    expect(children.every((child) =>
      child.cwd.startsWith(path.join(fixture.root, "agent-worktrees"))
    )).toBe(true);
    expect((await readdir(path.join(fixture.root, "agent-worktrees")))
      .filter((entry) => entry !== ".owners")).toEqual([]);
    expect(harness.events.filter((event) => event.type.startsWith("agent_batch_"))
      .map((event) => event.type)).toEqual([
      "agent_batch_started",
      "agent_batch_completed",
    ]);
  }, 60_000);

  it("preserves successful evidence when one parallel child fails", async () => {
    const fixture = await createFixture();
    const provider = new BatchScenarioProvider({
      barrier: true,
      tasks: [
        {
          key: "success",
          profile: "explore",
          description: "Inspect the source successfully",
        },
        {
          key: "failure",
          profile: "explore",
          description: "Exercise a child failure",
          fail: true,
        },
      ],
      parentFinal: "Parent synthesis retained the successful sibling evidence.",
    });
    const harness = await createTestRuntime(
      fixture.root,
      fixture.project,
      provider,
    );

    const result = await harness.runtime.submit(
      "Run both investigations and preserve any successful evidence.",
    );

    expect(result).toMatchObject({
      finalText: "Parent synthesis retained the successful sibling evidence.",
    });
    const parent = await harness.sessions.loadState(harness.runtime.session.id);
    if (!isPinnedSessionState(parent)) throw new Error("Expected pinned parent");
    expect(parent.toolOutcomes["delegate-batch"]).toMatchObject({
      type: "completed",
      result: {
        metadata: {
          status: "partial",
          counts: { completed: 1, failed: 1 },
          results: [
            {
              index: 0,
              status: "completed",
              evidence: [expect.stringMatching(/^read src\/value\.ts:1-1/u)],
            },
            {
              index: 1,
              status: "failed",
              error: { code: "execution_failed" },
            },
          ],
        },
      },
    });
    expect(provider.parentToolOutput).toContain("success handoff");
    expect(provider.parentToolOutput).toContain("failed");
    expect(harness.events.find((event) =>
      event.type === "agent_batch_failed"
    )).toMatchObject({
      type: "agent_batch_failed",
      partial: true,
      counts: { completed: 1, failed: 1 },
    });
    expect((await readdir(path.join(fixture.root, "agent-worktrees")))
      .filter((entry) => entry !== ".owners")).toEqual([]);
  }, 60_000);

  it("cancels active children, skips queued work, and removes every lease", async () => {
    const fixture = await createFixture();
    const provider = new BatchScenarioProvider({
      cancelChildren: true,
      readyChildren: 2,
      toolCallId: "delegate-cancel",
      tasks: [
        { key: "one", profile: "explore", description: "Hold first child" },
        { key: "two", profile: "explore", description: "Hold second child" },
        { key: "three", profile: "explore", description: "Queue third child" },
      ],
      parentFinal: "must not synthesize",
    });
    const harness = await createTestRuntime(
      fixture.root,
      fixture.project,
      provider,
    );
    await harness.runtime.submit("/agents mode standard");
    const running = harness.runtime.submit("Start a cancellable batch.");
    void running.catch(() => {});

    await provider.childrenReady;
    expect(harness.runtime.cancel()).toBe(true);
    let cancellation: unknown;
    try {
      await running;
    } catch (error) {
      cancellation = error;
    }

    expect(isCancellation(cancellation)).toBe(true);
    const entries = await harness.sessions.list();
    expect(entries).toHaveLength(3);
    const childStates = [];
    for (const entry of entries) {
      if (entry.id === harness.runtime.session.id) continue;
      const child = await harness.sessions.loadState(entry.id);
      if (!isPinnedSessionState(child)) throw new Error("Expected pinned child");
      childStates.push(child);
    }
    expect(childStates).toHaveLength(2);
    expect(childStates.every((child) =>
      child.agentLifecycle.status === "cancelled"
    )).toBe(true);
    expect(harness.events.findLast((event) =>
      event.type.startsWith("agent_batch_")
    )).toMatchObject({
      type: "agent_batch_cancelled",
      counts: { total: 3, completed: 0, cancelled: 3 },
    });
    expect((await readdir(path.join(fixture.root, "agent-worktrees")))
      .filter((entry) => entry !== ".owners")).toEqual([]);
  }, 60_000);

  it("runs the complete Recurs-owned implementation and review team workflow", async () => {
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
      toolTurn("delegate-team", "delegate_team", {
        description: "Change and independently verify the value fixture",
        tasks: [{
          description: "Implement the value change",
          prompt: "Change value from 1 to 2 and run the focused test.",
        }],
        review: {
          instructions: "Inspect the exact diff and its implementation evidence.",
        },
      }),
      toolTurn("team-implement-read", "read_file", { path: "src/value.ts" }),
      toolTurn("team-implement-patch", "apply_patch", {
        patch,
        files: [{ path: "src/value.ts", expected_hash: fixture.initialHash }],
      }),
      toolTurn("team-implement-test", "run_verification", { command: "npm test" }),
      [
        {
          type: "text_delta",
          text: "Changed value to 2 and the focused test passed.",
        },
        { type: "done", stopReason: "complete" },
      ],
      toolTurn("team-review-diff", "git_diff", {}),
      [
        {
          type: "text_delta",
          text: JSON.stringify({
            verdict: "approve",
            summary: "The integrated diff is scoped to the requested value change.",
            evidence: ["inspected the integrated parent diff"],
          }),
        },
        { type: "done", stopReason: "complete" },
      ],
      [
        {
          type: "text_delta",
          text: "Parent synthesis: the isolated implementation was integrated and independently approved.",
        },
        { type: "done", stopReason: "complete" },
      ],
    ]);
    const harness = await createTestRuntime(
      fixture.root,
      fixture.project,
      provider,
    );
    const interactive = createHostInvocation({
      invocation: "repl",
      userPresent: true,
      remote: false,
      scripted: false,
      embedding: "cli",
    });

    await harness.runtime.submit("/permissions approved_for_me");
    await harness.runtime.submit("/agents mode standard_v3");
    const result = await harness.runtime.submit(
      "Use a Recurs team to implement and independently review the value change.",
      interactive,
    );

    expect(result).toMatchObject({
      finalText: expect.stringContaining("independently approved"),
    });
    expect(await readFile(path.join(fixture.project, "src", "value.ts"), "utf8"))
      .toContain("value = 2");
    const parent = await harness.sessions.loadState(harness.runtime.session.id);
    if (!isPinnedSessionState(parent)) {
      throw new Error("Expected a pinned parent session");
    }
    expect(parent.toolOutcomes["delegate-team"]).toMatchObject({
      type: "completed",
      result: {
        metadata: {
          status: "approved",
          operatingModeId: "standard_v3",
          changedFiles: ["src/value.ts"],
          implementations: [{
            status: "completed",
            patch: {
              sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
              paths: ["src/value.ts"],
            },
          }],
          review: { verdict: "approved" },
        },
      },
    });

    const children = [];
    for (const entry of await harness.sessions.list()) {
      if (entry.id === parent.id) continue;
      const child = await harness.sessions.loadState(entry.id);
      if (!isPinnedSessionState(child)) {
        throw new Error("Expected a pinned child session");
      }
      children.push(child);
    }
    expect(children).toHaveLength(2);
    expect(children.map((child) => child.agent.profile?.id).sort()).toEqual([
      "implement_v1",
      "review_v1",
    ]);
    expect(children.every((child) =>
      child.agent.depth === 1 &&
      child.agent.parentAgentId === parent.agent.id &&
      child.agent.backend.strategy === "inherit_parent" &&
      child.agent.permissions.parentPermissionMode === "approved_for_me" &&
      child.agent.permissions.permissionMode === "approved_for_me" &&
      child.agentLifecycle.status === "completed"
    )).toBe(true);

    const teamEvents = harness.events.filter((event) =>
      event.type.startsWith("agent_team_")
    );
    expect(teamEvents.map((event) => event.type)).toEqual([
      "agent_team_started",
      "agent_team_patch_captured",
      "agent_team_patches_integrated",
      "agent_team_review_recorded",
      "agent_team_completed",
    ]);
    const teamId = teamEvents[0]?.type === "agent_team_started"
      ? teamEvents[0].teamId
      : null;
    expect(teamId).not.toBeNull();
    expect(harness.events.filter((event) =>
      event.type === "agent_started" && event.teamId === teamId
    )).toHaveLength(2);
    expect((await readdir(path.join(fixture.root, "agent-worktrees")))
      .filter((entry) => entry !== ".owners")).toEqual([]);

    const implementRequest = provider.requests.find((request) =>
      request.messages.some((message) =>
        message.role === "user" && message.content.includes("Recurs Implement")
      )
    );
    const reviewRequest = provider.requests.find((request) =>
      request.messages.some((message) =>
        message.role === "user" && message.content.includes("Recurs Review")
      )
    );
    expect(implementRequest?.tools.map((tool) => tool.name))
      .not.toContain("delegate_team");
    expect(reviewRequest?.tools.map((tool) => tool.name))
      .not.toContain("delegate_team");
  }, 60_000);

  it("rolls back the parent when isolated team patches conflict", async () => {
    const fixture = await createFixture();
    const patchTo = (value: number) => [
      "diff --git a/src/value.ts b/src/value.ts",
      "--- a/src/value.ts",
      "+++ b/src/value.ts",
      "@@ -1 +1 @@",
      "-export const value = 1;",
      `+export const value = ${value};`,
      "",
    ].join("\n");
    const provider = new ScriptedProvider([
      toolTurn("delegate-conflicting-team", "delegate_team", {
        description: "Exercise deterministic conflict recovery",
        tasks: [
          { description: "Implement candidate two", prompt: "Set value to 2." },
          { description: "Implement candidate three", prompt: "Set value to 3." },
        ],
        review: { instructions: "Review only if integration succeeds." },
      }),
      toolTurn("candidate-two-read", "read_file", { path: "src/value.ts" }),
      toolTurn("candidate-three-read", "read_file", { path: "src/value.ts" }),
      toolTurn("candidate-two-patch", "apply_patch", {
        patch: patchTo(2),
        files: [{ path: "src/value.ts", expected_hash: fixture.initialHash }],
      }),
      toolTurn("candidate-three-patch", "apply_patch", {
        patch: patchTo(3),
        files: [{ path: "src/value.ts", expected_hash: fixture.initialHash }],
      }),
      [
        { type: "text_delta", text: "Candidate implementation complete." },
        { type: "done", stopReason: "complete" },
      ],
      [
        { type: "text_delta", text: "Candidate implementation complete." },
        { type: "done", stopReason: "complete" },
      ],
      [
        {
          type: "text_delta",
          text: "Parent synthesis: the conflict was reported and the parent stayed clean.",
        },
        { type: "done", stopReason: "complete" },
      ],
    ]);
    const harness = await createTestRuntime(fixture.root, fixture.project, provider);
    await harness.runtime.submit("/permissions approved_for_me");
    await harness.runtime.submit("/agents mode balanced_v3");

    const result = await harness.runtime.submit(
      "Run both conflicting implementation candidates.",
      createHostInvocation({
        invocation: "repl",
        userPresent: true,
        remote: false,
        scripted: false,
        embedding: "cli",
      }),
    );

    expect(result.finalText).toContain("parent stayed clean");
    expect(await readFile(path.join(fixture.project, "src", "value.ts"), "utf8"))
      .toBe("export const value = 1;\n");
    expect((await execFileAsync("git", ["status", "--porcelain"], {
      cwd: fixture.project,
    })).stdout).toBe("");
    const parent = await harness.sessions.loadState(harness.runtime.session.id);
    if (!isPinnedSessionState(parent)) throw new Error("Expected pinned parent");
    expect(parent.toolOutcomes["delegate-conflicting-team"]).toMatchObject({
      type: "completed",
      result: {
        metadata: {
          status: "failed",
          integration: {
            ok: false,
            code: "patch_failed",
            rolledBack: true,
            integratedArtifactIds: [expect.any(String)],
          },
          review: null,
          changedFiles: [],
        },
      },
    });
    expect(harness.events.filter((event) =>
      event.type.startsWith("agent_team_")
    ).map((event) => event.type)).toEqual([
      "agent_team_started",
      "agent_team_patch_captured",
      "agent_team_patch_captured",
      "agent_team_failed",
    ]);
    expect((await readdir(path.join(fixture.root, "agent-worktrees")))
      .filter((entry) => entry !== ".owners")).toEqual([]);
  }, 60_000);

  it("keeps integrated changes unverified when Review output is malformed", async () => {
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
      toolTurn("delegate-unverified-team", "delegate_team", {
        description: "Change the value with strict review",
        tasks: [{
          description: "Implement value two",
          prompt: "Set value to 2.",
        }],
        review: { instructions: "Return the required exact verdict." },
      }),
      toolTurn("unverified-read", "read_file", { path: "src/value.ts" }),
      toolTurn("unverified-patch", "apply_patch", {
        patch,
        files: [{ path: "src/value.ts", expected_hash: fixture.initialHash }],
      }),
      [
        { type: "text_delta", text: "Implementation complete." },
        { type: "done", stopReason: "complete" },
      ],
      [
        { type: "text_delta", text: "I approve, but this is not JSON." },
        { type: "done", stopReason: "complete" },
      ],
      [
        {
          type: "text_delta",
          text: "Parent synthesis: the change remains visible but is unverified.",
        },
        { type: "done", stopReason: "complete" },
      ],
    ]);
    const harness = await createTestRuntime(fixture.root, fixture.project, provider);
    await harness.runtime.submit("/permissions approved_for_me");
    await harness.runtime.submit("/agents mode economy_v3");

    const result = await harness.runtime.submit(
      "Implement the value change and enforce strict review output.",
      createHostInvocation({
        invocation: "repl",
        userPresent: true,
        remote: false,
        scripted: false,
        embedding: "cli",
      }),
    );

    expect(result.finalText).toContain("unverified");
    expect(await readFile(path.join(fixture.project, "src", "value.ts"), "utf8"))
      .toContain("value = 2");
    const parent = await harness.sessions.loadState(harness.runtime.session.id);
    if (!isPinnedSessionState(parent)) throw new Error("Expected pinned parent");
    expect(parent.toolOutcomes["delegate-unverified-team"]).toMatchObject({
      type: "completed",
      result: {
        metadata: {
          status: "unverified",
          changedFiles: ["src/value.ts"],
          review: {
            verdict: "unverified",
            reviews: [{ status: "invalid" }],
          },
        },
      },
    });
    expect(harness.events.findLast((event) =>
      event.type.startsWith("agent_team_")
    )).toMatchObject({
      type: "agent_team_completed",
      status: "unverified",
    });
  }, 60_000);

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
        prompt: "Review the diff and the Implement child's test evidence.",
      }),
      toolTurn("review-diff", "git_diff", {}),
      [
        { type: "text_delta", text: "Review handoff: the diff is scoped and the implementation evidence reports a passing test." },
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
    await harness.runtime.submit("/agents mode standard_v3");
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
      evidence: expect.arrayContaining(["inspected working-tree git diff for ."]),
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
          evidence: expect.arrayContaining(["inspected working-tree git diff for ."]),
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
    ]));
    expect(checkpoints.captures).not.toContainEqual(expect.objectContaining({
      toolCallId: "delegate-review",
    }));
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
    expect(provider.requests[9]?.tools.map((tool) => tool.name)).toEqual([
      "read_file", "list_files", "search_text", "git_status", "git_diff",
    ]);
    const reviewTools = provider.requests[9]?.tools.map((tool) => tool.name) ?? [];
    expect(reviewTools).not.toContain("apply_patch");
    expect(reviewTools).not.toContain("run_command");
    expect(reviewTools).not.toContain("delegate_task");
    expect(provider.requests).toHaveLength(13);
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
