import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createHostInvocation,
  deriveTrustedRunContext,
  getOperatingModePolicy,
  type OperatingModeId,
  type RunCoordinator,
} from "@recurs/contracts";
import {
  ToolError,
  type ToolContext,
} from "@recurs/tools";
import { afterEach, describe, expect, it } from "vitest";

import {
  ChildAgentBatchManager,
  ChildAgentManager,
  JsonlSessionStore,
  createDelegationBudget,
  type GitWorktreeLease,
  type GitWorktreeLeasePort,
  type RecursEvent,
} from "../src/index.js";
import { testAt, testBackendPin } from "../../../tests/support/backend.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

const trusted = deriveTrustedRunContext(createHostInvocation({
  invocation: "repl",
  userPresent: true,
  remote: false,
  scripted: false,
  embedding: "cli",
}));

async function storeFixture(
  operatingModeId: OperatingModeId = "balanced_v2",
  executionMode: "act" | "plan" = "act",
) {
  const directory = await mkdtemp(path.join(tmpdir(), "recurs-child-batch-"));
  directories.push(directory);
  const sessions = new JsonlSessionStore(path.join(directory, "sessions"));
  let parent = await sessions.createPinnedSession({
    id: "parent-session",
    cwd: directory,
    backend: testBackendPin(),
    at: testAt,
  });
  await sessions.withSessionMutation(parent.id, parent.lastSequence, async (lease) => {
    await lease.append({
      type: "mode_updated",
      source: "command",
      executionMode,
      permissionMode: "approved_for_me",
      at: testAt,
    });
    const policy = getOperatingModePolicy(operatingModeId);
    await lease.append({
      type: "agent_policy_updated",
      operatingModeId: policy.id,
      operatingModeVersion: policy.version,
      at: testAt,
    });
  });
  parent = await sessions.loadState(parent.id) as typeof parent;
  return { directory, sessions, parent };
}

function context(
  parent: Awaited<ReturnType<typeof storeFixture>>["parent"],
  signal = new AbortController().signal,
): ToolContext & { delegationBudget: NonNullable<ToolContext["delegationBudget"]> } {
  return {
    sessionId: parent.id,
    cwd: parent.cwd,
    executionMode: parent.executionMode,
    signal,
    readRevisions: new Map(),
    runContext: trusted,
    delegationBudget: createDelegationBudget(parent.agent),
  };
}

function success(text: string, costUsd?: number) {
  return {
    ok: true as const,
    result: {
      finalText: text,
      usage: costUsd === undefined
        ? null
        : { inputTokens: 2, outputTokens: 1, costUsd },
      usageSource: costUsd === undefined ? "unavailable" as const : "provider" as const,
      steps: 1,
      changedFiles: [],
      changedFilesSource: "none" as const,
      evidence: [`evidence for ${text}`],
      evidenceSource: "host_tools" as const,
    },
  };
}

function failed(message: string) {
  return {
    ok: false as const,
    failure: {
      domain: "runtime" as const,
      phase: "started" as const,
      code: "runtime_failed" as const,
      safeMessage: message,
      diagnosticId: `failure-${message}`,
      retryable: false,
    },
  };
}

class FakeWorktrees implements GitWorktreeLeasePort {
  readonly created: GitWorktreeLease[] = [];
  readonly released: GitWorktreeLease[] = [];
  readonly active = new Set<string>();
  failRelease = false;

  async create(repositoryRoot: string, signal: AbortSignal): Promise<GitWorktreeLease> {
    if (signal.aborted) {
      throw new ToolError("cancelled", "Git worktree creation was cancelled");
    }
    const id = `lease-${this.created.length + 1}`;
    const lease = {
      id,
      repositoryRoot,
      worktreeRoot: path.join(path.dirname(repositoryRoot), "leases", id),
      revision: String(this.created.length + 1).padStart(40, "a"),
    };
    this.created.push(lease);
    this.active.add(id);
    return lease;
  }

  async release(lease: GitWorktreeLease): Promise<void> {
    if (this.failRelease) {
      throw new ToolError("process_failed", "Git worktree cleanup failed");
    }
    this.active.delete(lease.id);
    this.released.push(lease);
  }
}

async function harness(options: {
  readonly coordinator: RunCoordinator;
  readonly operatingModeId?: OperatingModeId;
  readonly executionMode?: "act" | "plan";
  readonly worktrees?: FakeWorktrees;
}) {
  const fixture = await storeFixture(
    options.operatingModeId,
    options.executionMode,
  );
  const events: RecursEvent[] = [];
  const worktrees = options.worktrees ?? new FakeWorktrees();
  let childId = 0;
  const children = new ChildAgentManager({
    sessions: fixture.sessions,
    getCoordinator: () => options.coordinator,
    async emit(event) { events.push(event); },
    createId: () => `child-${++childId}`,
    now: () => testAt,
  });
  const batch = new ChildAgentBatchManager({
    sessions: fixture.sessions,
    children,
    worktrees,
    async emit(event) { events.push(event); },
    createId: () => "batch-1",
    now: () => testAt,
  });
  return {
    ...fixture,
    events,
    worktrees,
    tool: batch.createTool(),
  };
}

function tasks(count: number, profile: "explore" | "review" = "explore") {
  return Array.from({ length: count }, (_, index) => ({
    profile,
    description: `Task ${index + 1}`,
    prompt: `prompt-${index + 1}`,
  }));
}

describe("ChildAgentBatchManager", () => {
  it("accepts only an exact bounded Explore/Review task array", async () => {
    const setup = await harness({
      coordinator: { async start() { throw new Error("must not start"); } },
    });

    const parsed = setup.tool.parse({ tasks: [
      { profile: "Explore", description: "One", prompt: "Inspect one" },
      { profile: "review_v1", description: "Two", prompt: "Review two" },
    ] });
    expect(parsed).toEqual({ tasks: [
      { profile: "explore_v1", description: "One", prompt: "Inspect one" },
      { profile: "review_v1", description: "Two", prompt: "Review two" },
    ] });
    expect(setup.tool.isMutating?.(parsed, context(setup.parent)) ??
      setup.tool.mutating).toBe(false);
    expect(() => setup.tool.parse({ tasks: tasks(1) })).toThrow("between 2 and 8");
    expect(() => setup.tool.parse({ tasks: tasks(9) })).toThrow("between 2 and 8");
    expect(() => setup.tool.parse({ tasks: tasks(2), background: true }))
      .toThrow("exactly tasks");
    expect(() => setup.tool.parse({ tasks: [
      { profile: "implement", description: "One", prompt: "Change one" },
      { profile: "explore", description: "Two", prompt: "Inspect two" },
    ] })).toThrow("only Explore and Review");
    expect(() => setup.tool.parse({ tasks: [
      { profile: "explore", description: "One", prompt: "Inspect", cwd: "/tmp" },
      { profile: "review", description: "Two", prompt: "Review" },
    ] })).toThrow("exactly profile, description, and prompt");
  });

  it("runs a mode-bounded worker pool and preserves input order", async () => {
    let active = 0;
    let maxActive = 0;
    let started = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let allStarted!: () => void;
    const ready = new Promise<void>((resolve) => { allStarted = resolve; });
    const coordinator: RunCoordinator = {
      async start(input) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        started += 1;
        if (started === 3) allStarted();
        return {
          events: { async *[Symbol.asyncIterator]() {} },
          outcome: held.then(() => {
            active -= 1;
            return success(input.prompt.includes("prompt-1") ? "first" : input.prompt);
          }),
        };
      },
    };
    const setup = await harness({ coordinator, operatingModeId: "balanced_v2" });
    const running = setup.tool.execute(
      setup.tool.parse({ tasks: tasks(4) }),
      context(setup.parent),
    );

    await ready;
    expect(maxActive).toBe(3);
    expect(started).toBe(3);
    release();
    const result = await running;

    expect(result.metadata).toMatchObject({
      batchId: "batch-1",
      status: "completed",
      maxConcurrentChildren: 3,
      counts: { total: 4, completed: 4, failed: 0, cancelled: 0 },
      results: [
        { index: 0, status: "completed", description: "Task 1" },
        { index: 1, status: "completed", description: "Task 2" },
        { index: 2, status: "completed", description: "Task 3" },
        { index: 3, status: "completed", description: "Task 4" },
      ],
    });
    expect(setup.worktrees.created).toHaveLength(4);
    expect(setup.worktrees.released).toHaveLength(4);
    expect(setup.worktrees.active.size).toBe(0);
  });

  it("falls back to sequential work in Economy mode", async () => {
    let active = 0;
    let maxActive = 0;
    const coordinator: RunCoordinator = {
      async start(input) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        return {
          events: { async *[Symbol.asyncIterator]() {} },
          outcome: Promise.resolve().then(() => {
            active -= 1;
            return success(input.prompt);
          }),
        };
      },
    };
    const setup = await harness({ coordinator, operatingModeId: "economy_v2" });

    const result = await setup.tool.execute(
      setup.tool.parse({ tasks: tasks(2) }),
      context(setup.parent),
    );

    expect(maxActive).toBe(1);
    expect(result.metadata).toMatchObject({
      maxConcurrentChildren: 1,
      counts: { completed: 2 },
    });
  });

  it("enforces the selected mode's batch size before creating worktrees", async () => {
    let starts = 0;
    const setup = await harness({
      operatingModeId: "economy_v2",
      coordinator: {
        async start() {
          starts += 1;
          throw new Error("must not start");
        },
      },
    });

    await expect(setup.tool.execute(
      setup.tool.parse({ tasks: tasks(3) }),
      context(setup.parent),
    )).rejects.toMatchObject({
      code: "permission_denied",
      message: "Agent batch task limit reached (2)",
    });
    expect(starts).toBe(0);
    expect(setup.worktrees.created).toHaveLength(0);
  });

  it("allows Explore in Plan mode and rejects Review before batch startup", async () => {
    const executions: string[] = [];
    const explore = await harness({
      executionMode: "plan",
      coordinator: {
        async start(input) {
          executions.push(input.executionMode ?? "plan");
          return {
            events: { async *[Symbol.asyncIterator]() {} },
            outcome: Promise.resolve(success(input.prompt)),
          };
        },
      },
    });
    await expect(explore.tool.execute(
      explore.tool.parse({ tasks: tasks(2, "explore") }),
      context(explore.parent),
    )).resolves.toMatchObject({ metadata: { status: "completed" } });
    expect(executions).toEqual(["plan", "plan"]);

    const review = await harness({
      executionMode: "plan",
      coordinator: { async start() { throw new Error("must not start"); } },
    });
    await expect(review.tool.execute(
      review.tool.parse({ tasks: tasks(2, "review") }),
      context(review.parent),
    )).rejects.toMatchObject({ code: "plan_mode_denied" });
    expect(review.worktrees.created).toHaveLength(0);
    expect(review.events).toHaveLength(0);
  });

  it("retains successful siblings and returns deterministic partial failure", async () => {
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let started = 0;
    let allStarted!: () => void;
    const ready = new Promise<void>((resolve) => { allStarted = resolve; });
    const coordinator: RunCoordinator = {
      async start(input) {
        started += 1;
        if (started === 3) allStarted();
        const prompt = input.prompt;
        return {
          events: { async *[Symbol.asyncIterator]() {} },
          outcome: prompt.includes("prompt-1")
            ? firstHeld.then(() => success("first result"))
            : Promise.resolve(prompt.includes("prompt-2")
              ? failed("second child failed")
              : success("third result")),
        };
      },
    };
    const setup = await harness({ coordinator });
    const running = setup.tool.execute(
      setup.tool.parse({ tasks: tasks(3) }),
      context(setup.parent),
    );

    await ready;
    releaseFirst();
    const result = await running;

    expect(result.metadata).toMatchObject({
      status: "partial",
      counts: { total: 3, completed: 2, failed: 1, cancelled: 0 },
      results: [
        { index: 0, status: "completed", output: "first result" },
        { index: 1, status: "failed", error: { message: "second child failed" } },
        { index: 2, status: "completed", output: "third result" },
      ],
    });
    expect(result.output).toContain("first result");
    expect(result.output).toContain("second child failed");
    expect(result.output).toContain("third result");
    expect(setup.events.at(-1)).toMatchObject({
      type: "agent_batch_failed",
      batchId: "batch-1",
      partial: true,
    });
    expect(setup.worktrees.active.size).toBe(0);
  });

  it("shares the parent child/request budget across concurrently queued tasks", async () => {
    let starts = 0;
    const setup = await harness({
      coordinator: {
        async start(input) {
          starts += 1;
          return {
            events: { async *[Symbol.asyncIterator]() {} },
            outcome: Promise.resolve(success(input.prompt)),
          };
        },
      },
    });
    const runContext = context(setup.parent);
    runContext.delegationBudget.childrenStarted = 3;
    runContext.delegationBudget.requestsReserved = 18;
    runContext.delegationBudget.requestsUsed = 3;

    const result = await setup.tool.execute(
      setup.tool.parse({ tasks: tasks(2) }),
      runContext,
    );

    expect(result.metadata).toMatchObject({
      status: "partial",
      counts: { completed: 1, failed: 1 },
      workflow: {
        childrenStarted: 4,
        maxChildren: 4,
        requestsReserved: 24,
        maxRequests: 24,
      },
    });
    expect(starts).toBe(1);
    expect(setup.worktrees.created).toHaveLength(2);
    expect(setup.worktrees.released).toHaveLength(2);
    const childEvents = setup.events.filter((event) =>
      event.type === "agent_started" || event.type === "agent_completed"
    );
    expect(childEvents).toHaveLength(2);
    const startedIndex = childEvents[0]?.type === "agent_started"
      ? childEvents[0].batchIndex
      : undefined;
    expect([0, 1]).toContain(startedIndex);
    expect(childEvents[0]).toMatchObject({
      type: "agent_started",
      batchId: "batch-1",
    });
    expect(childEvents[1]).toMatchObject({
      type: "agent_completed",
      batchId: "batch-1",
      batchIndex: startedIndex,
    });
  });

  it("refuses a known reported-cost ceiling without leasing a worktree", async () => {
    let starts = 0;
    const setup = await harness({
      coordinator: {
        async start() {
          starts += 1;
          throw new Error("must not start");
        },
      },
    });
    const runContext = context(setup.parent);
    runContext.delegationBudget.reportedCostUsd =
      runContext.delegationBudget.maxReportedCostUsd;

    const result = await setup.tool.execute(
      setup.tool.parse({ tasks: tasks(2) }),
      runContext,
    );

    expect(result.metadata).toMatchObject({
      status: "failed",
      counts: { completed: 0, failed: 2 },
      results: [
        { status: "failed", error: { message: "Agent reported-cost limit reached ($3)" } },
        { status: "failed", error: { message: "Agent reported-cost limit reached ($3)" } },
      ],
    });
    expect(starts).toBe(0);
    expect(setup.worktrees.created).toHaveLength(0);
  });

  it("rejects a malformed trusted workflow budget before batch startup", async () => {
    const setup = await harness({
      coordinator: { async start() { throw new Error("must not start"); } },
    });
    const runContext = context(setup.parent);
    (runContext.delegationBudget as { maxRequests: number }).maxRequests += 1;

    await expect(setup.tool.execute(
      setup.tool.parse({ tasks: tasks(2) }),
      runContext,
    )).rejects.toMatchObject({ code: "tool_unavailable" });
    expect(setup.events).toHaveLength(0);
    expect(setup.worktrees.created).toHaveLength(0);
  });

  it("cancels active children, suppresses queued starts, and awaits cleanup", async () => {
    const controller = new AbortController();
    let started = 0;
    let activeStarted!: () => void;
    const ready = new Promise<void>((resolve) => { activeStarted = resolve; });
    const coordinator: RunCoordinator = {
      async start(input) {
        started += 1;
        if (started === 2) activeStarted();
        return {
          events: { async *[Symbol.asyncIterator]() {} },
          outcome: new Promise((resolve) => {
            const cancel = () => resolve({
              ok: false as const,
              failure: {
                domain: "provider" as const,
                phase: "started" as const,
                code: "cancelled" as const,
                safeMessage: "The child was cancelled",
                diagnosticId: `cancelled-${started}`,
                retryable: false,
              },
            });
            if (input.signal.aborted) cancel();
            else input.signal.addEventListener("abort", cancel, { once: true });
          }),
        };
      },
    };
    const setup = await harness({ coordinator, operatingModeId: "standard_v2" });
    const running = setup.tool.execute(
      setup.tool.parse({ tasks: tasks(3) }),
      context(setup.parent, controller.signal),
    );
    void running.catch(() => {});

    await ready;
    controller.abort();

    await expect(running).rejects.toMatchObject({ code: "cancelled" });
    expect(started).toBe(2);
    expect(setup.worktrees.created).toHaveLength(2);
    expect(setup.worktrees.released).toHaveLength(2);
    expect(setup.worktrees.active.size).toBe(0);
    expect(setup.events.at(-1)).toMatchObject({
      type: "agent_batch_cancelled",
      batchId: "batch-1",
      counts: { total: 3, completed: 0, cancelled: 3 },
    });
  });

  it("fails closed when an owned worktree cannot be cleaned up", async () => {
    const worktrees = new FakeWorktrees();
    worktrees.failRelease = true;
    const setup = await harness({
      worktrees,
      coordinator: {
        async start(input) {
          return {
            events: { async *[Symbol.asyncIterator]() {} },
            outcome: Promise.resolve(success(input.prompt)),
          };
        },
      },
      operatingModeId: "economy_v2",
    });

    await expect(setup.tool.execute(
      setup.tool.parse({ tasks: tasks(2) }),
      context(setup.parent),
    )).rejects.toMatchObject({
      code: "process_failed",
      message: "Git worktree cleanup failed",
    });
    expect(setup.events.at(-1)).toMatchObject({
      type: "agent_batch_failed",
      batchId: "batch-1",
    });
  });
});
