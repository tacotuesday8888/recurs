import path from "node:path";

import {
  getOperatingModePolicy,
  type TeamRunDescriptor,
  type TeamRunPolicySnapshot,
} from "@recurs/contracts";
import { ToolError, type Checkpoint } from "@recurs/tools";
import { describe, expect, it, vi } from "vitest";

import type { RecursEvent } from "../src/events.js";
import type { GitPatchArtifactHandle } from "../src/git-patch-artifacts.js";
import type { TeamRunListEntry } from "../src/jsonl-team-run-store.js";
import {
  TeamRunRecoveryCoordinator,
} from "../src/team-run-recovery.js";
import {
  reduceTeamRunRecord,
  reduceTeamRunRecords,
  type TeamRunChildRecord,
  type TeamRunRecord,
  type TeamRunRecordInput,
  type TeamRunState,
} from "../src/team-run-state.js";
import { testBackendPin } from "../../../tests/support/backend.js";

const baseRevision = "a".repeat(40);
const candidate: GitPatchArtifactHandle = Object.freeze({
  id: "candidate-1",
  leaseId: "candidate-lease",
  baseRevision,
  sha256: "b".repeat(64),
  byteLength: 128,
  paths: Object.freeze(["src/value.ts"]),
});

function at(offset: number): string {
  return new Date(Date.UTC(2026, 6, 18, 0, 0, offset)).toISOString();
}

function descriptor(): TeamRunDescriptor {
  const policy = structuredClone(
    getOperatingModePolicy("balanced_v4"),
  ) as TeamRunPolicySnapshot;
  const backend = testBackendPin("recovery-model");
  return {
    id: "team-run-1",
    version: 1,
    parentSessionId: "parent-session",
    parentAgentId: "parent-agent",
    execution: "background",
    parentExecutionMode: "act",
    parentPermissionMode: "full_access",
    invocation: {
      invocation: "repl",
      presence: "present",
      location: "local",
      automation: "manual",
      embedding: "cli",
    },
    operatingModeId: policy.id,
    operatingModeVersion: policy.version,
    policy,
    allocation: {
      maxChildren: policy.workflow.maxChildrenPerRun,
      maxRequests: policy.workflow.maxRequestsPerRun,
      requestAllowance: 8,
      maxReportedCostUsd: policy.orchestration.maxReportedCostUsd,
    },
    routes: ([
      ["implement", "implement_v2"],
      ["review", "review_v2"],
      ["repair", "repair_v1"],
    ] as const).map(([role, profileId]) => ({
      role,
      profileId,
      executionMode: "act",
      permissionMode: "full_access",
      strategy: "inherit_parent",
      candidateId: "parent",
      reason: "parent_fallback",
      pin: backend,
    })),
    backend,
    repositoryRoot: path.resolve("/workspace"),
    baseRevision,
    request: {
      description: "Recover a durable team run",
      tasks: [{ description: "Implement value", prompt: "Change src/value.ts" }],
      review: { instructions: "Review the exact candidate" },
    },
  };
}

function record(
  sequence: number,
  input: TeamRunRecordInput,
): TeamRunRecord {
  return {
    version: 1,
    runId: "team-run-1",
    sequence,
    ...input,
  } as TeamRunRecord;
}

function initialRecords(): TeamRunRecord[] {
  return [{
    version: 1,
    runId: "team-run-1",
    sequence: 0,
    type: "team_created",
    descriptor: descriptor(),
    at: at(0),
  }];
}

function runningRecords(unfinished = false): TeamRunRecord[] {
  const records = [
    ...initialRecords(),
    record(1, {
      type: "run_claimed",
      ownerId: "dead-owner",
      claimEpoch: 1,
      at: at(1),
    }),
    record(2, { type: "phase_started", phase: "implement", round: 0, at: at(2) }),
  ];
  if (unfinished) {
    records.push(record(3, {
      type: "child_reserved",
      child: {
        attemptId: "attempt-1",
        role: "implement",
        index: 1,
        round: 0,
        childAgentId: "child-agent",
        childSessionId: "child-session",
        requestAllowance: 8,
      },
      at: at(3),
    }));
  }
  return records;
}

function readyRecords(): TeamRunRecord[] {
  const child: TeamRunChildRecord = {
    attemptId: "attempt-1",
    status: "completed",
    requestsUsed: 1,
    usage: { inputTokens: 5, outputTokens: 2, costUsd: 0.01 },
    usageSource: "provider",
    changedFiles: ["src/value.ts"],
    evidence: ["implementation evidence"],
    failure: null,
  };
  const reviewer: TeamRunChildRecord = {
    attemptId: "review-1",
    status: "completed",
    requestsUsed: 1,
    usage: null,
    usageSource: "unavailable",
    changedFiles: [],
    evidence: ["review evidence"],
    failure: null,
  };
  return [
    ...runningRecords(true),
    record(4, { type: "child_finished", child, at: at(4) }),
    record(5, {
      type: "artifact_linked",
      artifact: {
        kind: "worker",
        handle: { ...candidate, id: "worker-1", leaseId: "worker-lease" },
        round: 0,
        attemptId: "attempt-1",
      },
      at: at(5),
    }),
    record(6, { type: "phase_started", phase: "stage", round: 0, at: at(6) }),
    record(7, { type: "phase_started", phase: "review", round: 0, at: at(7) }),
    record(8, {
      type: "child_reserved",
      child: {
        attemptId: "review-1",
        role: "review",
        index: 1,
        round: 0,
        childAgentId: "review-agent",
        childSessionId: "review-session",
        requestAllowance: 8,
      },
      at: at(8),
    }),
    record(9, { type: "child_finished", child: reviewer, at: at(9) }),
    record(10, {
      type: "review_recorded",
      review: {
        round: 0,
        verdict: "approved",
        findings: [],
        evidence: ["review evidence"],
      },
      at: at(10),
    }),
    record(11, {
      type: "artifact_linked",
      artifact: {
        kind: "staged_candidate",
        handle: candidate,
        round: 0,
        attemptId: null,
      },
      at: at(11),
    }),
    record(12, {
      type: "candidate_ready",
      artifact: candidate,
      changedFiles: ["src/value.ts"],
      at: at(12),
    }),
  ];
}

function applyingRecords(prepared: boolean): TeamRunRecord[] {
  const records = [
    ...readyRecords(),
    record(13, { type: "phase_started", phase: "apply", round: 0, at: at(13) }),
  ];
  if (prepared) {
    records.push(record(14, {
      type: "apply_prepared",
      checkpoint: {
        id: "checkpoint-1",
        sessionId: "parent-session",
        toolCallId: "team-run-1",
      },
      at: at(14),
    }));
  }
  return records;
}

function entry(state: TeamRunState): TeamRunListEntry {
  return {
    id: state.descriptor.id,
    parentSessionId: state.descriptor.parentSessionId,
    execution: state.descriptor.execution,
    operatingModeId: state.descriptor.operatingModeId,
    status: state.status,
    phase: state.phase,
    round: state.round,
    childrenReserved: state.accounting.childrenReserved,
    childrenFinished: state.accounting.childrenFinished,
    usageReportedChildren: state.accounting.usageReportedChildren,
    usageMissingChildren: state.accounting.usageMissingChildren,
    usage: state.accounting.usage,
    reportedCostUsd: state.accounting.reportedCostUsd,
    costCoverage: state.accounting.costCoverage,
    manualAttentionRequired: state.interruption?.manualAttentionRequired ?? false,
    updatedAt: state.updatedAt,
    lastSequence: state.lastSequence,
  };
}

class MemoryRuns {
  state: TeamRunState;

  constructor(records: readonly TeamRunRecord[]) {
    this.state = reduceTeamRunRecords(records);
  }

  async list(): Promise<readonly TeamRunListEntry[]> {
    return [entry(this.state)];
  }

  async load(runId: string): Promise<TeamRunState> {
    if (runId !== this.state.descriptor.id) throw new Error("missing run");
    return this.state;
  }

  async append(
    runId: string,
    expected: number,
    input: TeamRunRecordInput,
  ): Promise<TeamRunState> {
    if (runId !== this.state.descriptor.id || expected !== this.state.lastSequence) {
      throw new Error("conflict");
    }
    this.state = reduceTeamRunRecord(this.state, {
      version: 1,
      runId,
      sequence: expected + 1,
      ...input,
    } as TeamRunRecord);
    return this.state;
  }
}

function harness(
  records: readonly TeamRunRecord[],
  options: {
    readonly busy?: boolean;
    readonly workspace?: "clean_base" | "exact_candidate" | "other";
    readonly workspaceError?: unknown;
    readonly completionFails?: boolean;
  } = {},
) {
  const runs = new MemoryRuns(records);
  const release = vi.fn(async () => undefined);
  const assertOwned = vi.fn(async () => undefined);
  const recoverStale = vi.fn(async () => ({ removedLeaseIds: [], busyLeaseIds: [] }));
  const discard = vi.fn(async () => undefined);
  const complete = vi.fn(async (reference: Checkpoint): Promise<Checkpoint> => ({
    id: reference.id,
    sessionId: reference.sessionId,
    toolCallId: reference.toolCallId,
    before: {},
    after: { "src/value.ts": { type: "file", sha256: "c".repeat(64), size: 1 } },
  }));
  const completeCandidateApply = vi.fn(async () => {
    if (options.completionFails === true) {
      throw new ToolError("checkpoint_conflict", "Checkpoint result drifted");
    }
    return {
      checkpoint: {
        id: "checkpoint-1",
        sessionId: "parent-session",
        toolCallId: "team-run-1",
        before: {},
        after: {},
      },
      changedFiles: ["src/value.ts"],
    };
  });
  const recoverChild = vi.fn(async (): Promise<TeamRunChildRecord> => ({
    attemptId: "attempt-1",
    status: "failed",
    requestsUsed: 8,
    usage: null,
    usageSource: "unavailable",
    changedFiles: [],
    evidence: [],
    failure: { code: "runtime_failed", message: "Process ended" },
  }));
  const events: RecursEvent[] = [];
  const coordinator = new TeamRunRecoveryCoordinator({
    runs,
    owners: {
      async tryAcquire(runId, parentSessionId) {
        if (options.busy === true) return { status: "busy" as const };
        return {
          status: "acquired" as const,
          lease: {
            runId,
            parentSessionId,
            ownerId: "recovery-owner",
            fencingToken: 2,
            assertOwned,
            release,
          },
        };
      },
    },
    worktrees: { recoverStale },
    patches: {
      inspectCandidateWorkspace: vi.fn(async () => {
        if (options.workspaceError !== undefined) throw options.workspaceError;
        return options.workspace ?? "clean_base";
      }),
      completeCandidateApply,
      discard,
    },
    checkpoints: { complete },
    recoverChild,
    async emit(event) {
      events.push(event);
    },
    now: () => at(30),
  });
  return {
    coordinator,
    runs,
    release,
    assertOwned,
    recoverStale,
    discard,
    complete,
    completeCandidateApply,
    recoverChild,
    events,
  };
}

describe("TeamRunRecoveryCoordinator", () => {
  it("settles unfinished children and interrupts a crashed run idempotently", async () => {
    const test = harness(runningRecords(true));

    await expect(test.coordinator.recover()).resolves.toMatchObject({
      recoveredRunIds: ["team-run-1"],
      busyRunIds: [],
      manualAttentionRunIds: [],
    });
    expect(test.runs.state).toMatchObject({
      status: "interrupted",
      interruption: { manualAttentionRequired: false },
      accounting: { childrenFinished: 1, requestsUsed: 8 },
    });
    expect(test.recoverChild).toHaveBeenCalledOnce();
    expect(test.recoverStale).toHaveBeenCalledOnce();
    expect(test.events.length).toBe(2);
    const sequence = test.runs.state.lastSequence;

    await test.coordinator.recover();
    expect(test.runs.state.lastSequence).toBe(sequence);
    expect(test.recoverChild).toHaveBeenCalledOnce();
    expect(test.release).toHaveBeenCalledTimes(2);
  });

  it("does not touch a run whose live owner lease is busy", async () => {
    const test = harness(runningRecords(true), { busy: true });
    const before = test.runs.state;

    await expect(test.coordinator.recover()).resolves.toMatchObject({
      recoveredRunIds: [],
      busyRunIds: ["team-run-1"],
    });
    expect(test.runs.state).toBe(before);
    expect(test.recoverChild).not.toHaveBeenCalled();
    expect(test.recoverStale).not.toHaveBeenCalled();
  });

  it("reclaims stale worktrees after a terminal journal survived process cleanup", async () => {
    const records = runningRecords();
    records.push(record(3, {
      type: "run_terminal",
      status: "failed",
      outcome: {
        changedFiles: [],
        evidence: [],
        failure: { code: "execution_failed", message: "Team failed" },
      },
      at: at(3),
    }));
    const test = harness(records);
    const sequence = test.runs.state.lastSequence;

    await test.coordinator.recover();

    expect(test.runs.state.status).toBe("failed");
    expect(test.runs.state.lastSequence).toBe(sequence);
    expect(test.recoverStale).toHaveBeenCalledOnce();
    expect(test.release).toHaveBeenCalledOnce();
  });

  it("preserves a stable ready candidate without a journal append", async () => {
    const test = harness(readyRecords());
    const sequence = test.runs.state.lastSequence;

    await expect(test.coordinator.recover()).resolves.toMatchObject({
      readyRunIds: ["team-run-1"],
    });
    expect(test.runs.state.status).toBe("ready_to_apply");
    expect(test.runs.state.lastSequence).toBe(sequence);
    expect(test.complete).not.toHaveBeenCalled();
  });

  it("resets an apply that crashed before mutating a clean base", async () => {
    const test = harness(applyingRecords(false), { workspace: "clean_base" });

    await test.coordinator.recover();
    expect(test.runs.state).toMatchObject({
      status: "ready_to_apply",
      apply: null,
      interruption: null,
    });
    expect(test.runs.state.records.at(-1)).toMatchObject({ type: "apply_reset" });
  });

  it("commits an exact prepared candidate after a process restart", async () => {
    const test = harness(applyingRecords(true), { workspace: "exact_candidate" });

    await test.coordinator.recover();
    expect(test.complete).toHaveBeenCalledOnce();
    expect(test.completeCandidateApply).toHaveBeenCalledOnce();
    expect(test.runs.state).toMatchObject({
      status: "approved",
      apply: { committed: true },
      outcome: { changedFiles: ["src/value.ts"], failure: null },
    });
    expect(test.discard).toHaveBeenCalledWith(expect.arrayContaining([candidate]));
  });

  it.each([
    [false, "exact_candidate"],
    [true, "other"],
  ] as const)(
    "requires manual attention for an ambiguous apply (prepared=%s, workspace=%s)",
    async (prepared, workspace) => {
      const test = harness(applyingRecords(prepared), { workspace });

      await expect(test.coordinator.recover()).resolves.toMatchObject({
        manualAttentionRunIds: ["team-run-1"],
      });
      expect(test.runs.state).toMatchObject({
        status: "interrupted",
        interruption: { manualAttentionRequired: true },
      });
      expect(test.complete).not.toHaveBeenCalled();
    },
  );

  it("records manual attention when prepared-candidate verification fails", async () => {
    const test = harness(applyingRecords(true), {
      workspace: "exact_candidate",
      completionFails: true,
    });

    await expect(test.coordinator.recover()).resolves.toMatchObject({
      manualAttentionRunIds: ["team-run-1"],
      failures: [{ runId: "team-run-1", code: "checkpoint_conflict" }],
    });
    expect(test.runs.state).toMatchObject({
      status: "interrupted",
      interruption: { manualAttentionRequired: true },
    });
  });

  it("does not expose private paths from recovery failures", async () => {
    const privatePath = "/Users/alice/private/project/.recurs/team.jsonl";
    const test = harness(applyingRecords(false), {
      workspaceError: new ToolError(
        "checkpoint_conflict",
        `Checkpoint at ${privatePath} changed`,
      ),
    });

    const summary = await test.coordinator.recover();

    expect(summary.failures).toEqual([{
      runId: "team-run-1",
      code: "checkpoint_conflict",
      message: "Team recovery checkpoint verification failed",
    }]);
    expect(test.runs.state.interruption?.reason)
      .toBe("Team recovery checkpoint verification failed");
    expect(test.events.find((event) => event.type === "warning"))
      .toMatchObject({
        type: "warning",
        code: "team_recovery_checkpoint_conflict",
        message: "Team run team-run-1: Team recovery checkpoint verification failed",
      });
    expect(JSON.stringify({ summary, state: test.runs.state, events: test.events }))
      .not.toContain(privatePath);
  });

  it("honors durable cancellation after settling interrupted children", async () => {
    const records = runningRecords(true);
    records.push(record(4, {
      type: "cancel_requested",
      reason: "User cancelled",
      at: at(4),
    }));
    const test = harness(records);

    await test.coordinator.recover();
    expect(test.runs.state).toMatchObject({
      status: "cancelled",
      outcome: { failure: { code: "cancelled", message: "User cancelled" } },
      accounting: { childrenFinished: 1 },
    });
  });
});
