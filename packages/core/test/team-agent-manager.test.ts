import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createHostInvocation,
  deriveTrustedRunContext,
  getOperatingModePolicy,
  type OperatingModeId,
} from "@recurs/contracts";
import {
  CheckpointStore,
  ToolError,
  type Checkpoint,
  type ToolContext,
} from "@recurs/tools";
import { afterEach, describe, expect, it } from "vitest";

import {
  JsonlSessionStore,
  TeamAgentManager,
  createDelegationBudget,
  type AgentReviewPanelResult,
  type ChildAgentManager,
  type ChildDelegationResult,
  type GitPatchArtifactHandle,
  type GitPatchIntegrationOutcome,
  type GitWorktreeLease,
  type RecursEvent,
} from "../src/index.js";
import type { TeamRunSupervisor } from "../src/team-run-supervisor.js";
import { testAt, testBackendPin } from "../../../tests/support/backend.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

class UnusedCheckpoints extends CheckpointStore {
  async captureBefore(): Promise<Checkpoint> { throw new Error("unused"); }
  async captureAfter(): Promise<Checkpoint> { throw new Error("unused"); }
  async undoLatest() { throw new Error("unused"); }
}

function childResult(index: number): ChildDelegationResult {
  return {
    output: `Implemented task ${index}`,
    metadata: {
      childAgentId: `implement-agent-${index}`,
      childSessionId: `implement-session-${index}`,
      taskId: `implement-task-${index}`,
      attempts: 1,
      retries: 0,
      operatingModeId: "balanced_v3",
      profileId: "implement_v1",
      usage: { inputTokens: 20, outputTokens: 10, costUsd: 0.02 },
      usageSource: "provider",
      requestsUsed: 1,
      evidenceSource: "host_tools",
      changedFiles: [`file-${index}.ts`],
      evidence: [`task ${index} tests passed`],
      costLimitUsd: 3,
      costLimitExceeded: false,
      workflow: {
        childrenStarted: index,
        maxChildren: 4,
        requestsReserved: index * 8,
        requestsUsed: index,
        maxRequests: 32,
        reportedCostUsd: index * 0.02,
        maxReportedCostUsd: 3,
      },
    },
  };
}

function patchHandle(index: number): GitPatchArtifactHandle {
  return Object.freeze({
    id: `patch-${index}`,
    leaseId: `lease-${index}`,
    baseRevision: "a".repeat(40),
    sha256: String(index).repeat(64),
    byteLength: 100 + index,
    paths: Object.freeze([`file-${index}.ts`]),
  });
}

function reviewResult(
  verdict: AgentReviewPanelResult["verdict"] = "approved",
): AgentReviewPanelResult {
  return {
    verdict,
    operatingModeId: "balanced_v3",
    qualityStandard: "balanced",
    initialReviewers: 1,
    maxReviewers: 2,
    escalated: verdict !== "approved",
    reviews: [{
      index: 1,
      status: "completed",
      childAgentId: "review-agent-1",
      childSessionId: "review-session-1",
      verdict: verdict === "changes_requested" ? "request_changes" : "approve",
      summary: "Review complete",
      evidence: ["review verification passed"],
    }],
    evidence: ["review verification passed"],
  };
}

interface HarnessOptions {
  modeId?: OperatingModeId;
  supervisor?: Pick<
    TeamRunSupervisor,
    "preflight" | "startForeground" | "startBackground"
  >;
  delegate?: Pick<ChildAgentManager, "delegate">["delegate"];
  capture?: (lease: GitWorktreeLease) => Promise<GitPatchArtifactHandle | null>;
  discard?: (handles: readonly GitPatchArtifactHandle[]) => Promise<void>;
  release?: (lease: GitWorktreeLease) => Promise<void>;
  integration?: GitPatchIntegrationOutcome;
  review?: AgentReviewPanelResult | Error;
  emit?: (event: RecursEvent) => Promise<void>;
  signal?: AbortSignal;
  createId?: () => string;
}

async function harness(options: HarnessOptions = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "recurs-team-manager-"));
  directories.push(root);
  const sessions = new JsonlSessionStore(path.join(root, "sessions"));
  let parent = await sessions.createPinnedSession({
    id: "team-parent",
    cwd: root,
    backend: testBackendPin(),
    at: testAt,
  });
  const mode = getOperatingModePolicy(options.modeId ?? "balanced_v3");
  await sessions.withSessionMutation(parent.id, parent.lastSequence, async (lease) => {
    await lease.append({
      type: "mode_updated",
      source: "command",
      executionMode: "act",
      permissionMode: "approved_for_me",
      at: testAt,
    });
    await lease.append({
      type: "agent_policy_updated",
      operatingModeId: mode.id,
      operatingModeVersion: mode.version,
      at: testAt,
    });
  });
  parent = await sessions.loadState(parent.id) as typeof parent;
  const log: string[] = [];
  const events: RecursEvent[] = [];
  let leaseId = 0;
  let childIndex = 0;
  const children: Pick<ChildAgentManager, "delegate"> = {
    delegate: options.delegate ?? (async () => childResult(++childIndex)),
  };
  const integration = options.integration ?? {
    ok: true,
    artifactIds: ["patch-1", "patch-2"],
    changedFiles: ["file-1.ts", "file-2.ts"],
    checkpointId: "checkpoint-1",
  };
  const discarded: GitPatchArtifactHandle[][] = [];
  const integrated: GitPatchArtifactHandle[][] = [];
  let preflightCalls = 0;
  const manager = new TeamAgentManager({
    sessions,
    ...(options.supervisor === undefined
      ? {}
      : { supervisor: options.supervisor }),
    children,
    worktrees: {
      async create() {
        const index = ++leaseId;
        log.push(`create:${index}`);
        return {
          id: `lease-${index}`,
          repositoryRoot: root,
          worktreeRoot: path.join(root, `worktree-${index}`),
          revision: "a".repeat(40),
        };
      },
      async release(lease) {
        log.push(`release:${lease.id}`);
        await options.release?.(lease);
      },
    },
    patches: {
      async preflightParent() {
        preflightCalls += 1;
        return { repositoryRoot: root, revision: "a".repeat(40) };
      },
      async capture(lease) {
        log.push(`capture:${lease.id}`);
        return options.capture?.(lease) ??
          patchHandle(Number.parseInt(lease.id.slice("lease-".length), 10));
      },
      async discard(handles) {
        discarded.push([...handles]);
        await options.discard?.(handles);
      },
      async integrate(input) {
        integrated.push([...input.artifacts]);
        return integration;
      },
    },
    reviews: {
      async run() {
        if (options.review instanceof Error) throw options.review;
        return options.review ?? reviewResult();
      },
    },
    checkpoints: new UnusedCheckpoints(),
    async emit(event) {
      events.push(event);
      await options.emit?.(event);
    },
    createId: options.createId ?? (() => "team-1"),
    now: () => testAt,
  });
  const context: ToolContext = {
    sessionId: parent.id,
    cwd: parent.cwd,
    executionMode: "act",
    signal: options.signal ?? new AbortController().signal,
    readRevisions: new Map(),
    runContext: deriveTrustedRunContext(createHostInvocation({
      invocation: "repl",
      userPresent: true,
      remote: false,
      scripted: false,
      embedding: "cli",
    })),
    delegationBudget: createDelegationBudget(parent.agent),
  };
  return {
    manager,
    tool: manager.createTool(),
    context,
    events,
    log,
    integrated,
    discarded,
    get preflightCalls() { return preflightCalls; },
  };
}

function input(taskCount = 2) {
  return {
    description: "Implement cache isolation",
    tasks: Array.from({ length: taskCount }, (_, index) => ({
      description: `Implementation ${index + 1}`,
      prompt: `Implement bounded change ${index + 1}`,
    })),
    review: { instructions: "Check behavior, tests, and regressions." },
  };
}

describe("TeamAgentManager", () => {
  it("accepts one exact bounded schema and classifies the workflow as mutating", async () => {
    const setup = await harness();
    const parsed = setup.tool.parse(input());

    expect(parsed).toEqual(input());
    expect(setup.tool.mutating).toBe(true);
    expect(setup.tool.permissions(parsed, setup.context)).toEqual([
      { category: "write", resource: "team workspace integration", risk: "elevated" },
      { category: "shell", resource: "fixed Git worktree orchestration", risk: "normal" },
    ]);
    expect(setup.tool.parse({ ...input(), execution: "background" })).toEqual({
      ...input(),
      execution: "background",
    });
    expect(() => setup.tool.parse({ ...input(), background: true })).toThrow(
      "description, tasks, review, and optional execution",
    );
    expect(() => setup.tool.parse({ ...input(), tasks: [] })).toThrow("between 1 and 4");
    expect(() => setup.tool.parse(input(5))).toThrow("between 1 and 4");
    expect(() => setup.tool.parse({
      ...input(),
      tasks: [{ profile: "implement", ...input(1).tasks[0] }],
    })).toThrow("exactly description and prompt");
  });

  it("preflights Act, v3 mode capacity, and complete review budget", async () => {
    const standard = await harness({ modeId: "standard_v3" });
    await expect(standard.tool.preflight?.(
      standard.tool.parse(input(2)),
      standard.context,
    )).rejects.toMatchObject({
      code: "permission_denied",
      message: "Standard mode supports at most 1 Implement worker",
    });
    await expect(standard.tool.preflight?.(
      standard.tool.parse(input(1)),
      { ...standard.context, executionMode: "plan" },
    )).rejects.toMatchObject({ code: "plan_mode_denied" });
    standard.context.delegationBudget!.childrenStarted = 1;
    await expect(standard.tool.preflight?.(
      standard.tool.parse(input(1)),
      standard.context,
    )).rejects.toMatchObject({
      code: "permission_denied",
      message: expect.stringContaining("complete adaptive review budget"),
    });
    const historical = await harness({ modeId: "balanced_v2" });
    await expect(historical.tool.preflight?.(
      historical.tool.parse(input()),
      historical.context,
    )).rejects.toMatchObject({ code: "tool_unavailable" });
  });

  it("rejects every non-v3 policy before workspace or child side effects", async () => {
    const setup = await harness({ modeId: "balanced_v4" });

    await expect(setup.tool.execute(
      setup.tool.parse(input()),
      setup.context,
    )).rejects.toMatchObject({
      code: "tool_unavailable",
      message: expect.stringMatching(/version-3/u),
    });
    expect(setup.preflightCalls).toBe(0);
    expect(setup.log).toEqual([]);
    expect(setup.integrated).toEqual([]);
    expect(setup.context.delegationBudget).toMatchObject({
      childrenStarted: 0,
      requestsReserved: 0,
    });
  });

  it("routes an authenticated v4 parent through the durable supervisor", async () => {
    const calls: Array<{ method: string; input: unknown; context: ToolContext }> = [];
    const supervised = {
      output: "Durable team approved",
      metadata: {
        teamId: "durable-team-1",
        status: "approved" as const,
        operatingModeId: "balanced_v4" as const,
        repairRounds: 0,
        accounting: {
          childrenReserved: 0,
          childrenFinished: 0,
          requestsReserved: 0,
          requestsUsed: 0,
          usage: null,
          usageReportedChildren: 0,
          usageMissingChildren: 0,
          reportedCostUsd: null,
          costReportedChildren: 0,
          costMissingChildren: 0,
          costCoverage: "none" as const,
        },
        changedFiles: ["src/cache.ts"],
        evidence: ["durable review approved"],
      },
    };
    const setup = await harness({
      modeId: "balanced_v4",
      supervisor: {
        async preflight(value, context) {
          calls.push({ method: "preflight", input: value, context });
        },
        async startForeground(value, context) {
          calls.push({ method: "startForeground", input: value, context });
          return supervised;
        },
        async startBackground(value, context) {
          calls.push({ method: "startBackground", input: value, context });
          return supervised;
        },
      },
    });
    const parsed = setup.tool.parse(input());

    await setup.tool.preflight?.(parsed, setup.context);
    const result = await setup.tool.execute(parsed, setup.context);

    expect(calls).toEqual([
      { method: "preflight", input: parsed, context: setup.context },
      { method: "startForeground", input: parsed, context: setup.context },
    ]);
    expect(result).toBe(supervised);
    expect(setup.preflightCalls).toBe(0);
    expect(setup.log).toEqual([]);
    expect(setup.integrated).toEqual([]);

    const background = setup.tool.parse({ ...input(), execution: "background" });
    await setup.tool.execute(background, setup.context);
    expect(calls.at(-1)).toEqual({
      method: "startBackground",
      input: background,
      context: setup.context,
    });
  });

  it("runs isolated Implement workers concurrently, captures before cleanup, integrates in order, and reviews", async () => {
    let active = 0;
    let maxActive = 0;
    let started = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let ready!: () => void;
    const allReady = new Promise<void>((resolve) => { ready = resolve; });
    const setup = await harness({
      async delegate(_input, context) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        started += 1;
        if (started === 2) ready();
        await held;
        if (context.signal.aborted) throw new ToolError("cancelled", "cancelled");
        active -= 1;
        return childResult(started === 2 && active === 1 ? 1 : 2);
      },
    });
    const running = setup.tool.execute(setup.tool.parse(input()), setup.context);

    await allReady;
    expect(maxActive).toBe(2);
    release();
    const result = await running;

    expect(result.metadata).toMatchObject({
      teamId: "team-1",
      status: "approved",
      operatingModeId: "balanced_v3",
      changedFiles: ["file-1.ts", "file-2.ts"],
      review: { verdict: "approved" },
    });
    expect(setup.integrated[0]?.map((artifact) => artifact.id)).toEqual([
      "patch-1",
      "patch-2",
    ]);
    expect(setup.log.indexOf("capture:lease-1"))
      .toBeLessThan(setup.log.indexOf("release:lease-1"));
    expect(setup.log.indexOf("capture:lease-2"))
      .toBeLessThan(setup.log.indexOf("release:lease-2"));
    expect(setup.events.map((event) => event.type)).toEqual([
      "agent_team_started",
      "agent_team_patch_captured",
      "agent_team_patch_captured",
      "agent_team_patches_integrated",
      "agent_team_review_recorded",
      "agent_team_completed",
    ]);
  });

  it("keeps durable team truth when presentation events fail", async () => {
    const setup = await harness({
      async emit() { throw new Error("sink"); },
    });

    const result = await setup.tool.execute(
      setup.tool.parse(input()),
      setup.context,
    );

    expect(result.metadata.status).toBe("approved");
    expect(setup.integrated[0]?.map((artifact) => artifact.id)).toEqual([
      "patch-1",
      "patch-2",
    ]);
  });

  it("reports the lowest task index regardless of completion order", async () => {
    let taskOneStarted!: () => void;
    const started = new Promise<void>((resolve) => { taskOneStarted = resolve; });
    const setup = await harness({
      async delegate(task, context) {
        if (task.description === "Implementation 1") {
          taskOneStarted();
          await new Promise<void>((resolve) => {
            context.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          throw new ToolError("execution_failed", "Task 1 failed");
        }
        await started;
        throw new ToolError("execution_failed", "Task 2 failed first");
      },
    });

    const result = await setup.tool.execute(
      setup.tool.parse(input()),
      setup.context,
    );

    expect(result.output).toContain("Task 1 failed");
  });

  it("does not let sibling cancellation hide a genuine implementation failure", async () => {
    let taskOneStarted!: () => void;
    const started = new Promise<void>((resolve) => { taskOneStarted = resolve; });
    const setup = await harness({
      async delegate(task, context) {
        if (task.description === "Implementation 1") {
          taskOneStarted();
          await new Promise<void>((resolve) => {
            context.signal.addEventListener("abort", () => resolve(), { once: true });
          });
          throw new ToolError("cancelled", "Task 1 stopped after sibling failure");
        }
        await started;
        throw new ToolError("execution_failed", "Task 2 genuinely failed");
      },
    });

    const result = await setup.tool.execute(
      setup.tool.parse(input()),
      setup.context,
    );

    expect(result.output).toContain("Task 2 genuinely failed");
    expect(setup.events.at(-1)).toMatchObject({
      type: "agent_team_failed",
      failure: { code: "execution_failed", message: "Task 2 genuinely failed" },
    });
    expect(setup.events.some((event) => event.type === "agent_team_cancelled"))
      .toBe(false);
  });

  it("gates integration on every implementation and discards successful sibling patches", async () => {
    let call = 0;
    const setup = await harness({
      async delegate() {
        call += 1;
        if (call === 1) return childResult(1);
        throw new ToolError("execution_failed", "Second implementation failed");
      },
    });

    const result = await setup.tool.execute(setup.tool.parse(input()), setup.context);

    expect(result.metadata).toMatchObject({ status: "failed", changedFiles: [] });
    expect(setup.integrated).toHaveLength(0);
    expect(setup.discarded.flat().map((artifact) => artifact.id)).toEqual(["patch-1"]);
    expect(setup.events.at(-1)).toMatchObject({
      type: "agent_team_failed",
      phase: "implementation",
      partial: false,
    });
  });

  it("does not let best-effort artifact cleanup hide an implementation failure", async () => {
    let call = 0;
    const setup = await harness({
      async delegate() {
        call += 1;
        if (call === 1) return childResult(1);
        throw new ToolError("execution_failed", "Canonical implementation failure");
      },
      async discard() {
        throw new ToolError("process_failed", "Injected artifact cleanup failure");
      },
    });

    const result = await setup.tool.execute(setup.tool.parse(input()), setup.context);

    expect(result.output).toContain("Canonical implementation failure");
    expect(result.metadata).toMatchObject({ status: "failed" });
    expect(setup.events.at(-1)).toMatchObject({
      type: "agent_team_failed",
      failure: { message: "Canonical implementation failure" },
    });
  });

  it("reports integration rollback without review and keeps review rejection/unverified truth", async () => {
    const integrationFailure = await harness({
      modeId: "standard_v3",
      integration: {
        ok: false,
        code: "patch_failed",
        message: "A child patch conflicted with earlier team changes",
        artifactId: "patch-1",
        integratedArtifactIds: [],
        rolledBack: false,
        restored: [],
        deleted: [],
      },
    });
    const failed = await integrationFailure.tool.execute(
      integrationFailure.tool.parse(input(1)),
      integrationFailure.context,
    );
    expect(failed.metadata).toMatchObject({
      status: "failed",
      integration: { ok: false, code: "patch_failed" },
      review: null,
    });
    expect(integrationFailure.events.at(-1)).toMatchObject({
      type: "agent_team_failed",
      phase: "integration",
    });

    for (const verdict of ["changes_requested", "unverified"] as const) {
      const setup = await harness({
        modeId: "standard_v3",
        integration: {
          ok: true,
          artifactIds: ["patch-1"],
          changedFiles: ["file-1.ts"],
          checkpointId: "checkpoint-1",
        },
        review: reviewResult(verdict),
      });
      const result = await setup.tool.execute(
        setup.tool.parse(input(1)),
        setup.context,
      );
      expect(result.metadata).toMatchObject({ status: verdict });
      expect(setup.events.at(-1)).toMatchObject({
        type: "agent_team_completed",
        status: verdict,
      });
    }
  });

  it("keeps integrated changes explicitly unverified when review infrastructure fails", async () => {
    const setup = await harness({
      modeId: "standard_v3",
      integration: {
        ok: true,
        artifactIds: ["patch-1"],
        changedFiles: ["file-1.ts"],
        checkpointId: "checkpoint-1",
      },
      review: new ToolError("execution_failed", "Review service failed"),
    });

    const result = await setup.tool.execute(
      setup.tool.parse(input(1)),
      setup.context,
    );

    expect(result.metadata).toMatchObject({
      status: "unverified",
      changedFiles: ["file-1.ts"],
      review: null,
      reviewFailure: { code: "execution_failed" },
    });
    expect(setup.events.at(-1)).toMatchObject({
      type: "agent_team_completed",
      status: "unverified",
    });
  });

  it("fails closed on worktree cleanup or empty patch capture", async () => {
    const cleanup = await harness({
      modeId: "standard_v3",
      async release() {
        throw new ToolError("process_failed", "Injected cleanup failure");
      },
    });
    const cleanupResult = await cleanup.tool.execute(
      cleanup.tool.parse(input(1)),
      cleanup.context,
    );
    expect(cleanupResult.metadata).toMatchObject({ status: "failed" });
    expect(cleanup.discarded.flat().map((artifact) => artifact.id)).toEqual([
      "patch-1",
    ]);
    expect(cleanup.integrated).toHaveLength(0);

    const empty = await harness({
      modeId: "standard_v3",
      async capture() { return null; },
    });
    const emptyResult = await empty.tool.execute(
      empty.tool.parse(input(1)),
      empty.context,
    );
    expect(emptyResult.metadata).toMatchObject({
      status: "failed",
      implementations: [{
        status: "failed",
        failure: { message: expect.stringContaining("without a patch artifact") },
      }],
    });
    expect(empty.integrated).toHaveLength(0);
  });

  it("links parent cancellation through the team and always releases the lease", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const childStarted = new Promise<void>((resolve) => { started = resolve; });
    const setup = await harness({
      modeId: "standard_v3",
      signal: controller.signal,
      async delegate(_input, context) {
        started();
        await new Promise<void>((resolve) => {
          context.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new ToolError("cancelled", "Parent cancelled");
      },
    });
    const running = setup.tool.execute(setup.tool.parse(input(1)), setup.context);
    await childStarted;
    controller.abort();

    await expect(running).rejects.toMatchObject({ code: "cancelled" });
    expect(setup.log).toContain("release:lease-1");
    expect(setup.integrated).toHaveLength(0);
    expect(setup.events.at(-1)).toMatchObject({
      type: "agent_team_cancelled",
      phase: "implementation",
      partial: false,
    });
  });

  it("rejects unsafe internal team identifiers before starting activity", async () => {
    const setup = await harness({ createId: () => "../unsafe-team" });

    await expect(setup.tool.execute(setup.tool.parse(input()), setup.context))
      .rejects.toMatchObject({ code: "tool_unavailable" });
    expect(setup.events).toHaveLength(0);
  });
});
