import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createHostInvocation,
  deriveTrustedRunContext,
  getOperatingModePolicy,
  type CoordinatedRunInput,
  type IntegrationFailure,
  type RunCoordinator,
  type RunResult,
} from "@recurs/contracts";
import {
  CheckpointStore,
  type Checkpoint,
  type ToolContext,
} from "@recurs/tools";
import { afterEach, describe, expect, it } from "vitest";

import { AgentBackendRouter } from "../src/agent-backend-router.js";
import {
  AgentReviewPanel,
  type AgentReviewVerdictV2,
} from "../src/agent-review-panel.js";
import {
  ChildAgentManager,
  type ChildDelegationOptions,
  type ChildIdentityReservationOptions,
  type DelegateTaskInput,
} from "../src/child-agent-manager.js";
import { createDelegationBudget } from "../src/agent-profile.js";
import type {
  GitPatchArtifactHandle,
  GitPatchBase,
} from "../src/git-patch-artifacts.js";
import type { GitWorktreeLease } from "../src/git-worktree-leases.js";
import { JsonlSessionStore } from "../src/jsonl-session-store.js";
import { JsonlTeamRunStore } from "../src/jsonl-team-run-store.js";
import { TeamRunSupervisor } from "../src/team-run-supervisor.js";
import type {
  TeamRunRecordInput,
  TeamRunState,
} from "../src/team-run-state.js";
import { testAt, testBackendPin } from "../../../tests/support/backend.js";

const directories: string[] = [];
const revision = "a".repeat(40);

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function reviewOutput(verdict: "approved" | "changes_requested" | "invalid"):
  string {
  if (verdict === "invalid") return "not a structured review";
  const result: AgentReviewVerdictV2 = verdict === "approved"
    ? {
        verdict: "approve",
        summary: "The staged candidate satisfies the objective.",
        findings: [],
        evidence: ["Reviewed the complete staged diff."],
      }
    : {
        verdict: "request_changes",
        summary: "The staged candidate needs one bounded repair.",
        findings: [{
          path: "file-1.ts",
          problem: "The boundary case is not handled.",
          acceptance: "Handle the boundary case without broadening the change.",
          evidence: ["The staged diff omits the boundary branch."],
        }],
        evidence: ["Reviewed the complete staged diff."],
      };
  return JSON.stringify(result);
}

function patchHandle(
  id: string,
  leaseId: string,
  paths: readonly string[],
  salt: string,
): GitPatchArtifactHandle {
  return Object.freeze({
    id,
    leaseId,
    baseRevision: revision,
    sha256: salt.repeat(64),
    byteLength: 100,
    paths: Object.freeze([...paths]),
  });
}

function recordLabel(input: TeamRunRecordInput): string {
  if (input.type === "phase_started") {
    return `journal:phase_started:${input.phase}:${input.round}`;
  }
  if (input.type === "child_reserved") {
    return `journal:child_reserved:${input.child.role}:${input.child.index}:${input.child.round}`;
  }
  if (input.type === "child_finished") {
    return `journal:child_finished:${input.child.attemptId}`;
  }
  if (input.type === "review_recorded") {
    return `journal:review_recorded:${input.review.verdict}:${input.review.round}`;
  }
  return `journal:${input.type}`;
}

class RecordingCheckpoints extends CheckpointStore {
  constructor(private readonly log: string[]) {
    super();
  }

  prepared(sessionId: string, toolCallId: string): Checkpoint {
    return Object.freeze({
      id: "checkpoint-1",
      sessionId,
      toolCallId,
      before: Object.freeze({}),
    });
  }

  async assertPrepared(): Promise<void> {}

  async captureBefore(): Promise<Checkpoint> {
    throw new Error("The patch port owns candidate preparation");
  }

  async captureAfter(): Promise<Checkpoint> {
    throw new Error("Use idempotent checkpoint completion");
  }

  async complete(checkpoint: Checkpoint): Promise<Checkpoint> {
    this.log.push(`checkpoint:complete:${checkpoint.id}`);
    return Object.freeze({ ...checkpoint, after: Object.freeze({}) });
  }

  async undoLatest(): Promise<{ restored: string[]; deleted: string[] }> {
    throw new Error("unused");
  }
}

interface HarnessOptions {
  readonly reviewByRound?: (
    round: number,
  ) => "approved" | "changes_requested" | "invalid";
  readonly implementFailure?: ReadonlyMap<number, {
    readonly delayMs: number;
    readonly message: string;
  }>;
  readonly applyFailure?: Error;
  readonly eventSinkFailure?: boolean;
  readonly tamperReturnedChild?: boolean;
  readonly cancelAfterImplementStarts?: number;
  readonly repairActualPaths?: readonly string[];
}

async function harness(options: HarnessOptions = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "recurs-team-supervisor-"));
  directories.push(root);
  const log: string[] = [];
  const sessions = new JsonlSessionStore(path.join(root, "sessions"));
  const durableRuns = new JsonlTeamRunStore(path.join(root, "team-runs"));
  const pin = testBackendPin("team-model");
  let parent = await sessions.createPinnedSession({
    id: "parent-session",
    cwd: root,
    backend: pin,
    at: testAt,
  });
  const policy = getOperatingModePolicy("balanced_v4");
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
      operatingModeId: policy.id,
      operatingModeVersion: policy.version,
      at: testAt,
    });
  });
  parent = await sessions.loadState(parent.id) as typeof parent;

  const runs = {
    async create(...args: Parameters<JsonlTeamRunStore["create"]>) {
      const state = await durableRuns.create(...args);
      log.push("journal:team_created");
      return state;
    },
    async append(
      runId: string,
      expectedSequence: number,
      input: TeamRunRecordInput,
    ) {
      const state = await durableRuns.append(runId, expectedSequence, input);
      log.push(recordLabel(input));
      return state;
    },
    load: durableRuns.load.bind(durableRuns),
    list: durableRuns.list.bind(durableRuns),
  };

  const router = new AgentBackendRouter();
  const parentAbort = new AbortController();
  const reviewPrompts: string[] = [];
  let stagedPaths: readonly string[] = [];
  let implementStarts = 0;
  const coordinator: RunCoordinator = {
    async start(input: CoordinatedRunInput) {
      const child = await sessions.loadState(input.sessionId);
      if (child.version !== 2 || child.agent.team === undefined) {
        throw new Error("Expected a durable v4 team child");
      }
      const correlation = child.agent.team;
      if (correlation.role === "review") reviewPrompts.push(input.prompt);
      const turnId = `turn-${child.id}`;
      log.push(`child:${correlation.role}:${correlation.taskIndex}:start`);
      input.signal.addEventListener("abort", () => {
        log.push(`child:${correlation.role}:${correlation.taskIndex}:signal-aborted`);
      }, { once: true });
      await sessions.withSessionMutation(
        child.id,
        child.lastSequence,
        async (lease) => {
          await lease.append({
            type: "turn_started",
            turnId,
            prompt: input.prompt,
            at: testAt,
          });
        },
      );
      if (correlation.role === "implement" &&
        ++implementStarts === options.cancelAfterImplementStarts) {
        parentAbort.abort();
      }

      const implementationFailure = correlation.role === "implement"
        ? options.implementFailure?.get(correlation.taskIndex)
        : undefined;
      const delayMs = implementationFailure?.delayMs ??
        (correlation.role === "implement" && correlation.taskIndex === 1 ? 75 : 0);
      if (delayMs > 0) await wait(delayMs);

      if (implementationFailure !== undefined) {
        const failure: IntegrationFailure = {
          domain: "runtime",
          phase: "started",
          code: "runtime_failed",
          safeMessage: implementationFailure.message,
          diagnosticId: `failure-${correlation.taskIndex}`,
          retryable: false,
        };
        const running = await sessions.loadState(child.id);
        await sessions.withSessionMutation(
          child.id,
          running.lastSequence ?? 0,
          async (lease) => {
            await lease.append({ type: "turn_failed", turnId, error: failure, at: testAt });
          },
        );
        log.push(`child:${correlation.role}:${correlation.taskIndex}:finish`);
        return {
          events: { async *[Symbol.asyncIterator]() {} },
          outcome: Promise.resolve({ ok: false as const, failure }),
        };
      }

      const changedFiles = correlation.role === "implement"
        ? [`file-${correlation.taskIndex}.ts`]
        : correlation.role === "repair"
          ? ["file-1.ts"]
          : [];
      const result: RunResult = {
        finalText: correlation.role === "review"
          ? reviewOutput(
              options.reviewByRound?.(correlation.round) ?? "approved",
            )
          : `${correlation.role} ${correlation.taskIndex} completed`,
        usage: { inputTokens: 5, outputTokens: 2, costUsd: 0.01 },
        usageSource: "provider",
        steps: 1,
        changedFiles,
        changedFilesSource: changedFiles.length === 0 ? "none" : "host_tools",
        evidence: [`${correlation.role} evidence ${correlation.taskIndex}`],
        evidenceSource: "host_tools",
      };
      const running = await sessions.loadState(child.id);
      await sessions.withSessionMutation(
        child.id,
        running.lastSequence ?? 0,
        async (lease) => {
          await lease.append({ type: "turn_completed", turnId, result, at: testAt });
        },
      );
      log.push(`child:${correlation.role}:${correlation.taskIndex}:finish`);
      return {
        events: { async *[Symbol.asyncIterator]() {} },
        outcome: Promise.resolve({ ok: true as const, result }),
      };
    },
  };

  let childId = 0;
  const childManager = new ChildAgentManager({
    sessions,
    backendRouter: router,
    getCoordinator: () => coordinator,
    async emit() {},
    createId: () => `child-id-${++childId}`,
    now: () => testAt,
  });
  const children = {
    authorizeTeamRun: childManager.authorizeTeamRun.bind(childManager),
    revokeTeamRunAuthority: childManager.revokeTeamRunAuthority.bind(childManager),
    reserveIdentity(
      input: DelegateTaskInput,
      context: Pick<ToolContext, "sessionId">,
      childOptions?: ChildIdentityReservationOptions,
    ) {
      const team = childOptions?.team;
      if (team === undefined || !("runId" in team)) {
        throw new Error("Expected a durable team correlation");
      }
      log.push(`identity:${team.role}:${team.taskIndex}:${team.round}`);
      return childManager.reserveIdentity(input, context, childOptions);
    },
    async delegate(
      input: DelegateTaskInput,
      context: ToolContext,
      childOptions?: ChildDelegationOptions,
    ) {
      const team = childOptions?.team;
      if (team === undefined || !("runId" in team) ||
        childOptions?.identity === undefined) {
        throw new Error("Expected a reserved durable team delegation");
      }
      const state = await durableRuns.load(team.runId);
      const reservation = state.children.find((item) =>
        item.reservation.attemptId === team.attemptId
      )?.reservation;
      expect(reservation).toMatchObject({
        role: team.role,
        index: team.taskIndex,
        round: team.round,
        childAgentId: childOptions.identity.childAgentId,
        childSessionId: childOptions.identity.childSessionId,
      });
      log.push(`delegate:${team.role}:${team.taskIndex}:${team.round}`);
      const result = await childManager.delegate(input, context, childOptions);
      return options.tamperReturnedChild === true && team.role === "implement" &&
          team.taskIndex === 1
        ? {
            ...result,
            metadata: {
              ...result.metadata,
              requestsUsed: result.metadata.requestsUsed + 1,
            },
          }
        : result;
    },
  };

  const createdLeases: GitWorktreeLease[] = [];
  const releasedLeases: GitWorktreeLease[] = [];
  const workerArtifacts = new Map<string, GitPatchArtifactHandle>();
  const discardedArtifactIds: string[] = [];
  let parentMutationCount = 0;
  let leaseId = 0;
  const worktrees = {
    async create(): Promise<GitWorktreeLease> {
      const id = `lease-${++leaseId}`;
      const lease = Object.freeze({
        id,
        repositoryRoot: root,
        worktreeRoot: path.join(root, `.worktree-${id}`),
        revision,
      });
      createdLeases.push(lease);
      log.push(`worktree:create:${id}`);
      return lease;
    },
    async release(lease: GitWorktreeLease): Promise<void> {
      releasedLeases.push(lease);
      log.push(`worktree:release:${lease.id}`);
    },
  };
  const patches = {
    async preflightParent(): Promise<GitPatchBase> {
      log.push("patch:preflight");
      return { repositoryRoot: root, revision };
    },
    async capture(lease: GitWorktreeLease): Promise<GitPatchArtifactHandle> {
      log.push(`patch:capture:${lease.id}`);
      const numericId = Number.parseInt(lease.id.slice("lease-".length), 10);
      const existing = numericId <= 2 ? workerArtifacts.get(lease.id) : undefined;
      if (existing !== undefined) return existing;
      if (numericId > 2 && log.includes("child:repair:1:finish") &&
        options.repairActualPaths !== undefined) {
        stagedPaths = [...options.repairActualPaths];
      }
      const paths = numericId <= 2
        ? [`file-${numericId}.ts`]
        : [...stagedPaths];
      const captureIndex = [...workerArtifacts.keys()]
        .filter((id) => id.startsWith(`${lease.id}:`)).length + 1;
      const handle = patchHandle(
        numericId <= 2
          ? `artifact-${lease.id}`
          : `artifact-${lease.id}-snapshot-${captureIndex}`,
        lease.id,
        paths,
        ["a", "b", "c", "d"][numericId - 1] ?? "e",
      );
      workerArtifacts.set(
        numericId <= 2 ? lease.id : `${lease.id}:${captureIndex}`,
        handle,
      );
      return handle;
    },
    async stage(input: {
      lease: GitWorktreeLease;
      artifacts: readonly GitPatchArtifactHandle[];
    }) {
      log.push(`patch:stage:${input.artifacts.map((item) => item.id).join(",")}`);
      stagedPaths = [...new Set(input.artifacts.flatMap((item) => item.paths))]
        .sort((left, right) => left.localeCompare(right));
      return { changedFiles: stagedPaths };
    },
    async prepareCandidateApply(input: {
      sessionId: string;
      operationId: string;
    }) {
      log.push("patch:prepare");
      return checkpoints.prepared(input.sessionId, input.operationId);
    },
    async applyCandidate() {
      log.push("patch:apply");
      if (options.applyFailure !== undefined) throw options.applyFailure;
      parentMutationCount += 1;
      return { changedFiles: [...stagedPaths] };
    },
    async completeCandidateApply(input: { checkpoint: Checkpoint }) {
      const checkpoint = await checkpoints.complete(input.checkpoint, root);
      return { checkpoint, changedFiles: [...stagedPaths] };
    },
    async discard(handles: readonly GitPatchArtifactHandle[]) {
      const ids = handles.map((item) => item.id);
      discardedArtifactIds.push(...ids);
      log.push(`patch:discard:${ids.join(",")}`);
    },
  };
  const checkpoints = new RecordingCheckpoints(log);
  const reviews = new AgentReviewPanel({ sessions, children });
  const attemptedEvents: unknown[] = [];
  let supervisorId = 0;
  const supervisor = new TeamRunSupervisor({
    sessions,
    runs,
    children,
    worktrees,
    patches,
    reviews,
    router,
    checkpoints,
    backendCandidates(candidateParent) {
      return [{
        id: "parent",
        pin: candidateParent.backend.pin,
        parent: true,
        roles: ["implement", "review", "repair"],
        executionModes: ["act"],
        permissionModes: [candidateParent.permissionMode],
        hostTools: true,
        background: true,
        ready: true,
      }];
    },
    async emit(event) {
      attemptedEvents.push(event);
      if (options.eventSinkFailure === true) throw new Error("event sink failed");
    },
    createId: () => `supervisor-id-${++supervisorId}`,
    now: () => testAt,
  });
  const context: ToolContext = {
    sessionId: parent.id,
    cwd: parent.cwd,
    executionMode: "act",
    signal: parentAbort.signal,
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
  const input = {
    description: "Implement the bounded team objective",
    tasks: [
      { description: "Implement first slice", prompt: "Change file one." },
      { description: "Implement second slice", prompt: "Change file two." },
    ],
    review: { instructions: "Review the complete staged candidate." },
  };

  async function state(teamId: string): Promise<TeamRunState> {
    return await durableRuns.load(teamId);
  }

  return {
    supervisor,
    context,
    input,
    sessions,
    log,
    state,
    createdLeases,
    releasedLeases,
    discardedArtifactIds,
    attemptedEvents,
    reviewPrompts,
    parentMutationCount: () => parentMutationCount,
    listRuns: () => durableRuns.list(parent.id),
  };
}

function indexOf(log: readonly string[], value: string): number {
  const index = log.indexOf(value);
  expect(index, `Missing log entry: ${value}`).toBeGreaterThanOrEqual(0);
  return index;
}

function implementationFinishOrder(state: TeamRunState): number[] {
  const reservations = new Map(state.children.map((child) => [
    child.reservation.attemptId,
    child.reservation,
  ]));
  return state.records.flatMap((record) => {
    if (record.type !== "child_finished") return [];
    const reservation = reservations.get(record.child.attemptId);
    return reservation?.role === "implement" ? [reservation.index] : [];
  });
}

describe("TeamRunSupervisor durable foreground pipeline", () => {
  it("claims and reserves before concurrent delegation, then stages and applies in authoritative order", async () => {
    const test = await harness();
    const result = await test.supervisor.startForeground(test.input, test.context);
    const state = await test.state(result.metadata.teamId);

    expect(result.metadata).toMatchObject({
      status: "approved",
      operatingModeId: "balanced_v4",
      repairRounds: 0,
      changedFiles: ["file-1.ts", "file-2.ts"],
    });
    expect(state.status).toBe("approved");
    expect(test.parentMutationCount()).toBe(1);
    expect(state.descriptor.allocation).toEqual({
      maxChildren: 7,
      maxRequests: 56,
      requestAllowance: 8,
      maxReportedCostUsd: 3,
    });
    expect(state.accounting).toMatchObject({
      childrenReserved: 3,
      childrenFinished: 3,
      requestsReserved: 24,
      requestsUsed: 3,
      usageReportedChildren: 3,
      usageMissingChildren: 0,
      reportedCostUsd: 0.03,
      costCoverage: "complete",
    });

    expect(indexOf(test.log, "journal:team_created")).toBeLessThan(
      indexOf(test.log, "journal:run_claimed"),
    );
    for (const taskIndex of [1, 2]) {
      expect(indexOf(test.log, `identity:implement:${taskIndex}:0`)).toBeLessThan(
        indexOf(test.log, `journal:child_reserved:implement:${taskIndex}:0`),
      );
      expect(indexOf(
        test.log,
        `journal:child_reserved:implement:${taskIndex}:0`,
      )).toBeLessThan(indexOf(test.log, `delegate:implement:${taskIndex}:0`));
    }
    const firstFinish = Math.min(
      indexOf(test.log, "child:implement:1:finish"),
      indexOf(test.log, "child:implement:2:finish"),
    );
    expect(indexOf(test.log, "child:implement:1:start")).toBeLessThan(firstFinish);
    expect(indexOf(test.log, "child:implement:2:start")).toBeLessThan(firstFinish);
    expect(test.log.indexOf("child:implement:2:finish")).toBeLessThan(
      test.log.indexOf("child:implement:1:finish"),
    );
    expect(implementationFinishOrder(state)).toEqual([1, 2]);
    for (const child of state.children.filter((item) =>
      item.reservation.role === "implement"
    )) {
      const session = await test.sessions.loadState(child.reservation.childSessionId);
      expect(session.version).toBe(2);
      if (session.version === 2) {
        expect(session.agent).toMatchObject({
          role: "child",
          depth: 1,
          profile: { id: "implement_v2", version: 2 },
          parentSessionId: "parent-session",
          backend: { strategy: "policy_route", reason: "parent_fallback" },
          permissions: {
            parentExecutionMode: "act",
            executionMode: "act",
            parentPermissionMode: "approved_for_me",
            permissionMode: "approved_for_me",
          },
          team: {
            runId: result.metadata.teamId,
            role: "implement",
            taskIndex: child.reservation.index,
            round: 0,
            attemptId: child.reservation.attemptId,
          },
          workspace: {
            leaseId: `lease-${child.reservation.index}`,
            repositoryRoot: test.context.cwd,
            revision,
          },
        });
      }
    }
    expect(test.log).toContain(
      "patch:stage:artifact-lease-1,artifact-lease-2",
    );

    const transaction = [
      "patch:prepare",
      "journal:apply_prepared",
      "patch:apply",
      "checkpoint:complete:checkpoint-1",
      "journal:apply_committed",
    ];
    expect(transaction.map((entry) => indexOf(test.log, entry))).toEqual(
      [...transaction.map((entry) => indexOf(test.log, entry))].sort((a, b) => a - b),
    );
    expect(test.createdLeases.map((lease) => lease.id).sort()).toEqual(
      test.releasedLeases.map((lease) => lease.id).sort(),
    );
    for (const workerId of ["artifact-lease-1", "artifact-lease-2"]) {
      const discard = test.log.findIndex((entry) =>
        entry.startsWith("patch:discard:") && entry.includes(workerId)
      );
      expect(discard).toBeGreaterThan(indexOf(test.log, "journal:candidate_ready"));
    }
    const candidateDiscard = test.log.findIndex((entry) =>
      entry.startsWith("patch:discard:") && entry.includes("artifact-lease-3")
    );
    expect(candidateDiscard).toBeGreaterThan(indexOf(test.log, "journal:apply_committed"));
  });

  it("terminalizes an invalid review as unverified without repair or parent apply", async () => {
    const test = await harness({ reviewByRound: () => "invalid" });
    const result = await test.supervisor.startForeground(test.input, test.context);
    const state = await test.state(result.metadata.teamId);

    expect(result.metadata.status).toBe("unverified");
    expect(state.status).toBe("unverified");
    expect(state.reviews.at(-1)?.verdict).toBe("unverified");
    expect(state.children.some((child) => child.reservation.role === "repair"))
      .toBe(false);
    expect(test.log).not.toContain("patch:prepare");
    expect(test.log).not.toContain("patch:apply");
    expect(test.parentMutationCount()).toBe(0);
    expect(test.createdLeases.map((lease) => lease.id).sort()).toEqual(
      test.releasedLeases.map((lease) => lease.id).sort(),
    );
    const terminal = indexOf(test.log, "journal:run_terminal");
    for (const workerId of ["artifact-lease-1", "artifact-lease-2"]) {
      expect(test.log.findIndex((entry) =>
        entry.startsWith("patch:discard:") && entry.includes(workerId)
      )).toBeGreaterThan(terminal);
    }
  });

  it("rejects work beyond the frozen implementer bound before creating durable or workspace state", async () => {
    const test = await harness();
    const oversized = {
      ...test.input,
      tasks: [
        ...test.input.tasks,
        { description: "Unexpected third slice", prompt: "Do not run this." },
      ],
    };

    await expect(
      test.supervisor.startForeground(oversized, test.context),
    ).rejects.toMatchObject({ code: "permission_denied" });
    expect(await test.listRuns()).toEqual([]);
    expect(test.createdLeases).toEqual([]);
    expect(test.log).toEqual([]);
  });

  it("runs one bounded repair in the staging workspace and re-reviews before apply", async () => {
    const test = await harness({
      reviewByRound: (round) => round === 0 ? "changes_requested" : "approved",
    });
    const result = await test.supervisor.startForeground(test.input, test.context);
    const state = await test.state(result.metadata.teamId);

    expect(result.metadata).toMatchObject({ status: "approved", repairRounds: 1 });
    expect(state.reviews.map((review) => [review.round, review.verdict])).toEqual([
      [0, "changes_requested"],
      [1, "approved"],
    ]);
    const repair = state.children.find((child) =>
      child.reservation.role === "repair"
    );
    expect(repair?.reservation).toMatchObject({ round: 1, index: 1 });
    const repairSession = await test.sessions.loadState(
      repair?.reservation.childSessionId ?? "missing",
    );
    expect(repairSession.version).toBe(2);
    if (repairSession.version === 2) {
      expect(repairSession.agent).toMatchObject({
        depth: 1,
        team: { role: "repair", round: 1 },
        workspace: { leaseId: "lease-3" },
        permissions: {
          parentPermissionMode: "approved_for_me",
          permissionMode: "approved_for_me",
        },
      });
    }
    expect(test.parentMutationCount()).toBe(1);
  });

  it("recomputes the exact staging scope after repair before re-review", async () => {
    const test = await harness({
      reviewByRound: (round) => round === 0 ? "changes_requested" : "approved",
      repairActualPaths: ["file-1.ts", "file-2.ts", "repair-extra.ts"],
    });

    const result = await test.supervisor.startForeground(test.input, test.context);

    expect(result.metadata).toMatchObject({
      status: "approved",
      changedFiles: ["file-1.ts", "file-2.ts", "repair-extra.ts"],
    });
    expect(test.reviewPrompts).toHaveLength(3);
    expect(test.reviewPrompts.slice(0, -1).every((prompt) =>
      !prompt.includes("repair-extra.ts")
    )).toBe(true);
    expect(test.reviewPrompts.at(-1)).toContain("repair-extra.ts");
  });

  it("stops after the frozen repair allowance is exhausted and leaves the parent untouched", async () => {
    const test = await harness({ reviewByRound: () => "changes_requested" });
    const result = await test.supervisor.startForeground(test.input, test.context);
    const state = await test.state(result.metadata.teamId);

    expect(result.metadata).toMatchObject({
      status: "changes_requested",
      repairRounds: 1,
    });
    expect(state.status).toBe("changes_requested");
    expect(state.reviews.map((review) => review.round)).toEqual([0, 1]);
    expect(state.children.filter((child) => child.reservation.role === "repair"))
      .toHaveLength(1);
    expect(test.log).not.toContain("patch:prepare");
    expect(test.log).not.toContain("patch:apply");
    expect(test.parentMutationCount()).toBe(0);
  });

  it("persists every settled implement outcome but reports the lowest-index genuine failure", async () => {
    const test = await harness({
      implementFailure: new Map([
        [1, { delayMs: 15, message: "task one genuine failure" }],
        [2, { delayMs: 0, message: "task two genuine failure" }],
      ]),
    });
    const result = await test.supervisor.startForeground(test.input, test.context);
    const state = await test.state(result.metadata.teamId);

    expect(test.log.indexOf("child:implement:2:finish")).toBeLessThan(
      test.log.indexOf("child:implement:1:finish"),
    );
    expect(implementationFinishOrder(state)).toEqual([1, 2]);
    expect(state.children.filter((child) => child.reservation.role === "implement")
      .every((child) => child.result !== null)).toBe(true);
    expect(result.metadata).toMatchObject({
      status: "failed",
      failure: { message: expect.stringContaining("task one genuine failure") },
    });
    expect(state.outcome?.failure?.message).toContain("task one genuine failure");
    expect(indexOf(test.log, "journal:run_terminal")).toBeGreaterThan(
      indexOf(test.log, "journal:child_finished:" +
        state.children.find((child) => child.reservation.index === 2)?.reservation.attemptId),
    );
    expect(test.log).not.toContain("patch:stage:artifact-lease-1,artifact-lease-2");
    expect(test.parentMutationCount()).toBe(0);
    expect(test.createdLeases.map((lease) => lease.id).sort()).toEqual(
      test.releasedLeases.map((lease) => lease.id).sort(),
    );
  });

  it("rejects returned child metadata that disagrees with the durable child session", async () => {
    const test = await harness({ tamperReturnedChild: true });
    const result = await test.supervisor.startForeground(test.input, test.context);
    const state = await test.state(result.metadata.teamId);

    expect(result.metadata).toMatchObject({
      status: "failed",
      failure: {
        code: "invalid_child_result",
        message: expect.stringContaining("durable reservation"),
      },
    });
    expect(state.children.find((child) => child.reservation.index === 1)?.result)
      .toMatchObject({
        status: "failed",
        failure: { code: "invalid_child_result" },
      });
    expect(test.parentMutationCount()).toBe(0);
    expect(test.log).not.toContain("patch:prepare");
  });

  it("persists cancellation intent before abort and records every settled child", async () => {
    const test = await harness({ cancelAfterImplementStarts: 2 });
    const result = await test.supervisor.startForeground(test.input, test.context);
    const state = await test.state(result.metadata.teamId);

    expect(result.metadata.status).toBe("cancelled");
    expect(state.status).toBe("cancelled");
    expect(state.cancellation?.reason).toContain("Parent cancelled");
    const cancellation = indexOf(test.log, "journal:cancel_requested");
    const aborts = test.log.flatMap((entry, index) =>
      entry.endsWith(":signal-aborted") ? [index] : []
    );
    expect(aborts).toHaveLength(2);
    expect(aborts.every((index) => index > cancellation)).toBe(true);
    expect(state.children.filter((child) => child.reservation.role === "implement"))
      .toHaveLength(2);
    expect(state.children.filter((child) => child.reservation.role === "implement")
      .every((child) => child.result !== null)).toBe(true);
    expect(implementationFinishOrder(state)).toEqual([1, 2]);
    expect(test.log).not.toContain("patch:prepare");
    expect(test.log).not.toContain("patch:apply");
    expect(test.parentMutationCount()).toBe(0);
    expect(test.createdLeases.map((lease) => lease.id).sort()).toEqual(
      test.releasedLeases.map((lease) => lease.id).sort(),
    );
  });

  it("marks a post-prepare apply failure as manual-attention interrupted", async () => {
    const test = await harness({ applyFailure: new Error("apply outcome uncertain") });
    const result = await test.supervisor.startForeground(test.input, test.context);
    const state = await test.state(result.metadata.teamId);

    expect(result.metadata.status).toBe("interrupted");
    expect(state).toMatchObject({
      status: "interrupted",
      interruption: {
        manualAttentionRequired: true,
      },
    });
    expect(indexOf(test.log, "journal:run_interrupted")).toBeGreaterThan(
      indexOf(test.log, "journal:apply_prepared"),
    );
    expect(test.log).not.toContain("checkpoint:complete:checkpoint-1");
    expect(test.log).not.toContain("journal:apply_committed");
    expect(test.discardedArtifactIds).not.toContain("artifact-lease-3");
    expect(test.createdLeases.map((lease) => lease.id).sort()).toEqual(
      test.releasedLeases.map((lease) => lease.id).sort(),
    );
  });

  it("keeps approved durable and workspace truth when every presentation event fails", async () => {
    const test = await harness({ eventSinkFailure: true });
    const result = await test.supervisor.startForeground(test.input, test.context);
    const state = await test.state(result.metadata.teamId);

    expect(test.attemptedEvents.length).toBeGreaterThan(0);
    expect(result.metadata.status).toBe("approved");
    expect(state.status).toBe("approved");
    expect(state.apply?.committed).toBe(true);
    expect(test.parentMutationCount()).toBe(1);
  });
});
