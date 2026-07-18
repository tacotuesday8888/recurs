import path from "node:path";

import {
  getOperatingModePolicy,
  type SessionBackendPin,
  type TeamRunDescriptor,
  type TeamRunPolicySnapshot,
} from "@recurs/contracts";
import { describe, expect, it } from "vitest";

import {
  parseTeamRunRecord,
  reduceTeamRunRecord,
  reduceTeamRunRecords,
  type TeamRunRecord,
  type TeamRunRecordInput,
  type TeamRunState,
} from "../src/team-run-state.js";

const baseAt = Date.parse("2026-07-18T00:00:00.000Z");
const baseRevision = "a".repeat(40);

function at(sequence: number): string {
  return new Date(baseAt + sequence * 1_000).toISOString();
}

function pin(connectionId = "parent-connection"): SessionBackendPin {
  return {
    kind: "model_provider",
    providerId: "test-provider",
    adapterId: "test-adapter",
    connectionId,
    modelId: "test-model",
    modelIdentityKind: "versioned",
    providerResolvedModelRevisionAtCreation: "model-r1",
    catalogRevision: "catalog-r1",
    policyRevisionAtCreation: "policy-r1",
    billingPolicyRevisionAtCreation: "billing-r1",
    primaryBillingSourceAtCreation: "local_compute",
    billingSelectionAtCreation: {
      mode: "strict_primary_only",
      policyRevision: "policy-r1",
      disclosureRevision: "disclosure-r1",
      allowedSources: ["local_compute"],
      acknowledgedAt: at(0),
    },
    accountSubjectFingerprint: "account-fingerprint",
  };
}

function descriptor(overrides: Partial<TeamRunDescriptor> = {}): TeamRunDescriptor {
  const backend = pin();
  const policy = structuredClone(
    getOperatingModePolicy("balanced_v4"),
  ) as TeamRunPolicySnapshot;
  return {
    id: "team-run-1",
    version: 1,
    parentSessionId: "parent-session",
    parentAgentId: "parent-agent",
    execution: "foreground",
    parentExecutionMode: "act",
    parentPermissionMode: "approved_for_me",
    invocation: {
      invocation: "repl",
      presence: "present",
      location: "local",
      automation: "manual",
      embedding: "cli",
    },
    operatingModeId: "balanced_v4",
    operatingModeVersion: 4,
    policy,
    allocation: {
      maxChildren: 7,
      maxRequests: 56,
      requestAllowance: 8,
      maxReportedCostUsd: 3,
    },
    routes: [
      ["implement", "implement_v2"],
      ["review", "review_v2"],
      ["repair", "repair_v1"],
    ].map(([role, profileId]) => ({
      role,
      profileId,
      executionMode: "act",
      permissionMode: "approved_for_me",
      strategy: "inherit_parent",
      candidateId: "parent",
      reason: "parent_fallback",
      pin: backend,
    })) as TeamRunDescriptor["routes"],
    backend,
    repositoryRoot: path.resolve("/workspace"),
    baseRevision,
    request: {
      description: "Implement the bounded feature",
      tasks: [
        { description: "Implementation 1", prompt: "Change src/a.ts" },
        { description: "Implementation 2", prompt: "Change src/b.ts" },
      ],
      review: { instructions: "Review the staged candidate" },
    },
    ...overrides,
  };
}

function descriptorForMode(
  operatingModeId: "economy_v4" | "standard_v4" | "balanced_v4" |
    "performance_v4" | "max_v4",
  overrides: Partial<TeamRunDescriptor> = {},
): TeamRunDescriptor {
  const policy = structuredClone(
    getOperatingModePolicy(operatingModeId),
  ) as TeamRunPolicySnapshot;
  return descriptor({
    operatingModeId,
    operatingModeVersion: 4,
    policy,
    allocation: {
      maxChildren: policy.workflow.maxChildrenPerRun,
      maxRequests: policy.workflow.maxRequestsPerRun,
      requestAllowance: Math.floor(
        policy.workflow.maxRequestsPerRun /
          policy.workflow.maxChildrenPerRun,
      ),
      maxReportedCostUsd: policy.orchestration.maxReportedCostUsd,
    },
    ...overrides,
  });
}

function created(value = descriptor()): TeamRunRecord {
  return {
    version: 1,
    runId: value.id,
    sequence: 0,
    at: at(0),
    type: "team_created",
    descriptor: value,
  };
}

function record(
  sequence: number,
  input: TeamRunRecordInput,
  runId = "team-run-1",
): TeamRunRecord {
  return { version: 1, runId, sequence, ...input } as TeamRunRecord;
}

function claim(sequence = 1, epoch = 1): TeamRunRecord {
  return record(sequence, {
    type: "run_claimed",
    ownerId: `owner-${epoch}`,
    claimEpoch: epoch,
    at: at(sequence),
  });
}

function phase(
  sequence: number,
  value: "implement" | "stage" | "review" | "repair" | "apply",
  round = 0,
): TeamRunRecord {
  return record(sequence, {
    type: "phase_started",
    phase: value,
    round,
    at: at(sequence),
  });
}

function reservation(
  sequence: number,
  attemptId: string,
  role: "implement" | "review" | "repair",
  index: number,
  round = 0,
  requestAllowance = 8,
): TeamRunRecord {
  return record(sequence, {
    type: "child_reserved",
    child: {
      attemptId,
      role,
      index,
      round,
      childAgentId: `${attemptId}-agent`,
      childSessionId: `${attemptId}-session`,
      requestAllowance,
    },
    at: at(sequence),
  });
}

function finished(
  sequence: number,
  attemptId: string,
  options: {
    usage?: {
      inputTokens: number;
      outputTokens: number;
      costUsd?: number;
    } | null;
    usageSource?: "provider" | "runtime" | "unavailable";
    changedFiles?: readonly string[];
    evidence?: readonly string[];
    requestsUsed?: number;
  } = {},
): TeamRunRecord {
  return record(sequence, {
    type: "child_finished",
    child: {
      attemptId,
      status: "completed",
      requestsUsed: options.requestsUsed ?? 2,
      usage: options.usage === undefined
        ? { inputTokens: 10, outputTokens: 5, costUsd: 0.1 }
        : options.usage,
      usageSource: options.usageSource ?? "provider",
      changedFiles: [...(options.changedFiles ?? [])],
      evidence: [...(options.evidence ?? ["child evidence"])],
      failure: null,
    },
    at: at(sequence),
  });
}

function artifact(
  sequence: number,
  kind: "worker" | "staged_candidate",
  id: string,
  attemptId: string | null,
  paths: readonly string[],
  round = 0,
): TeamRunRecord {
  return record(sequence, {
    type: "artifact_linked",
    artifact: {
      kind,
      handle: {
        id,
        leaseId: `${id}-lease`,
        baseRevision,
        sha256: "b".repeat(64),
        byteLength: 128,
        paths: [...paths],
      },
      round,
      attemptId,
    },
    at: at(sequence),
  });
}

function approvedState(): TeamRunState {
  const records: TeamRunRecord[] = [
    created(),
    claim(),
    phase(2, "implement"),
    reservation(3, "implement-1", "implement", 1),
    reservation(4, "implement-2", "implement", 2),
    finished(5, "implement-1", { changedFiles: ["src/a.ts"] }),
    artifact(6, "worker", "patch-a", "implement-1", ["src/a.ts"]),
    finished(7, "implement-2", {
      usage: null,
      usageSource: "unavailable",
      changedFiles: ["src/b.ts"],
      requestsUsed: 8,
    }),
    artifact(8, "worker", "patch-b", "implement-2", ["src/b.ts"]),
    phase(9, "stage"),
    phase(10, "review"),
    reservation(11, "review-1", "review", 1),
    finished(12, "review-1", { changedFiles: [] }),
    record(13, {
      type: "review_recorded",
      review: {
        round: 0,
        verdict: "approved",
        findings: [],
        evidence: ["review evidence"],
      },
      at: at(13),
    }),
    artifact(
      14,
      "staged_candidate",
      "candidate-1",
      null,
      ["src/a.ts", "src/b.ts"],
    ),
    record(15, {
      type: "candidate_ready",
      artifact: {
        id: "candidate-1",
        leaseId: "candidate-1-lease",
        baseRevision,
        sha256: "b".repeat(64),
        byteLength: 128,
        paths: ["src/a.ts", "src/b.ts"],
      },
      changedFiles: ["src/a.ts", "src/b.ts"],
      at: at(15),
    }),
    phase(16, "apply"),
    record(17, {
      type: "apply_prepared",
      checkpoint: {
        id: "checkpoint-1",
        sessionId: "parent-session",
        toolCallId: "team-run-1",
      },
      at: at(17),
    }),
    record(18, {
      type: "apply_committed",
      checkpoint: {
        id: "checkpoint-1",
        sessionId: "parent-session",
        toolCallId: "team-run-1",
      },
      changedFiles: ["src/a.ts", "src/b.ts"],
      at: at(18),
    }),
  ];
  return reduceTeamRunRecords(records);
}

describe("team run state", () => {
  it("reduces one exact approved workflow with derived accounting", () => {
    const state = approvedState();

    expect(state).toMatchObject({
      status: "approved",
      phase: "apply",
      lastSequence: 18,
      claim: { ownerId: "owner-1", claimEpoch: 1 },
      candidate: {
        artifact: { id: "candidate-1" },
        changedFiles: ["src/a.ts", "src/b.ts"],
      },
      apply: {
        checkpoint: { id: "checkpoint-1" },
        committed: true,
      },
      accounting: {
        childrenReserved: 3,
        childrenFinished: 3,
        requestsReserved: 24,
        requestsUsed: 12,
        usageReportedChildren: 2,
        usageMissingChildren: 1,
        costReportedChildren: 2,
        costMissingChildren: 1,
        reportedCostUsd: 0.2,
        costCoverage: "partial",
      },
    });
    expect(state.accounting.usage).toMatchObject({
      inputTokens: 20,
      outputTokens: 10,
    });
  });

  it("enforces legal phases, reservation order, attempt identity, and budgets", () => {
    const initial = reduceTeamRunRecords([created(), claim()]);
    expect(() => reduceTeamRunRecord(initial, phase(2, "review")))
      .toThrow(/stage/u);

    const implementing = reduceTeamRunRecord(initial, phase(2, "implement"));
    expect(() => reduceTeamRunRecord(
      implementing,
      finished(3, "missing-attempt"),
    )).toThrow(/reserved/u);

    const reserved = reduceTeamRunRecord(
      implementing,
      reservation(3, "implement-1", "implement", 1),
    );
    expect(() => reduceTeamRunRecord(
      reserved,
      reservation(4, "implement-1", "implement", 1),
    )).toThrow(/attempt/u);
    expect(() => reduceTeamRunRecord(
      reserved,
      reservation(4, "too-many-requests", "implement", 2) satisfies TeamRunRecord,
    )).not.toThrow();

    const limited = reduceTeamRunRecords([
      created(),
      claim(),
      phase(2, "implement"),
      reservation(3, "costly-attempt", "implement", 1),
      finished(4, "costly-attempt", {
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 3 },
      }),
    ]);
    expect(() => reduceTeamRunRecord(
      limited,
      reservation(5, "over-budget", "implement", 2),
    )).toThrow(/cost limit/u);
  });

  it("requires valid reviews and candidate ownership before apply", () => {
    let state = reduceTeamRunRecords([
      created(descriptor({
        request: {
          description: "One task",
          tasks: [{ description: "Only task", prompt: "Change src/a.ts" }],
          review: { instructions: "Review it" },
        },
      })),
      claim(),
      phase(2, "implement"),
      reservation(3, "implement-1", "implement", 1),
      finished(4, "implement-1", { changedFiles: ["src/a.ts"] }),
    ]);
    expect(() => reduceTeamRunRecord(
      state,
      artifact(5, "worker", "unknown", "missing", ["src/a.ts"]),
    )).toThrow(/attempt/u);
    expect(() => reduceTeamRunRecord(
      state,
      artifact(5, "worker", "wrong-round", "implement-1", ["src/a.ts"], 1),
    )).toThrow(/artifact/u);
    state = reduceTeamRunRecord(
      state,
      artifact(5, "worker", "patch-a", "implement-1", ["src/a.ts"]),
    );
    state = reduceTeamRunRecord(state, phase(6, "stage"));
    state = reduceTeamRunRecord(state, phase(7, "review"));

    expect(() => reduceTeamRunRecord(state, reservation(
      8,
      "review-writes",
      "review",
      1,
    ))).not.toThrow();
    const reviewReserved = reduceTeamRunRecord(state, reservation(
      8,
      "review-writes",
      "review",
      1,
    ));
    expect(() => reduceTeamRunRecord(reviewReserved, finished(
      9,
      "review-writes",
      { changedFiles: ["src/a.ts"] },
    ))).toThrow(/read-only/iu);

    expect(() => reduceTeamRunRecord(state, record(8, {
      type: "review_recorded",
      review: {
        round: 0,
        verdict: "approved",
        findings: [{
          path: "src/a.ts",
          problem: "Still wrong",
          acceptance: "Fix it",
          evidence: ["src/a.ts:1"],
        }],
        evidence: ["review evidence"],
      },
      at: at(8),
    }))).toThrow(/finding/u);
    expect(() => reduceTeamRunRecord(state, record(8, {
      type: "candidate_ready",
      artifact: {
        id: "candidate-1",
        leaseId: "lease-1",
        baseRevision,
        sha256: "b".repeat(64),
        byteLength: 10,
        paths: ["src/a.ts"],
      },
      changedFiles: ["src/a.ts"],
      at: at(8),
    }))).toThrow(/review|candidate/u);
  });

  it("persists cancellation intent and prevents new work before terminal cancellation", () => {
    let state = reduceTeamRunRecords([
      created(),
      claim(),
      phase(2, "implement"),
    ]);
    state = reduceTeamRunRecord(state, record(3, {
      type: "cancel_requested",
      reason: "User cancelled the team",
      at: at(3),
    }));
    expect(() => reduceTeamRunRecord(
      state,
      reservation(4, "late-child", "implement", 1),
    )).toThrow(/cancel/iu);
    state = reduceTeamRunRecord(state, record(4, {
      type: "run_terminal",
      status: "cancelled",
      outcome: {
        changedFiles: [],
        evidence: [],
        failure: { code: "cancelled", message: "User cancelled the team" },
      },
      at: at(4),
    }));
    expect(state.status).toBe("cancelled");
    expect(() => reduceTeamRunRecord(state, claim(5, 2))).toThrow(/terminal/u);
  });

  it("resumes only non-manual interrupted runs with a monotonic claim epoch", () => {
    const running = reduceTeamRunRecords([
      created(),
      claim(),
      phase(2, "implement"),
    ]);
    const interrupted = reduceTeamRunRecord(running, record(3, {
      type: "run_interrupted",
      reason: "process_restart",
      manualAttentionRequired: false,
      at: at(3),
    }));
    const reclaimed = reduceTeamRunRecord(interrupted, claim(4, 2));
    expect(reclaimed).toMatchObject({
      status: "interrupted",
      claim: { ownerId: "owner-2", claimEpoch: 2 },
    });
    expect(() => reduceTeamRunRecord(reclaimed, record(5, {
      type: "apply_committed",
      checkpoint: {
        id: "checkpoint-1",
        sessionId: "parent-session",
        toolCallId: "team-run-1",
      },
      changedFiles: [],
      at: at(5),
    }))).toThrow(/apply/u);

    const manual = reduceTeamRunRecord(running, record(3, {
      type: "run_interrupted",
      reason: "uncertain parent workspace",
      manualAttentionRequired: true,
      at: at(3),
    }));
    expect(() => reduceTeamRunRecord(manual, claim(4, 2)))
      .toThrow(/manual attention/u);
  });

  it("uses replacement attempts after interruption without trusting orphaned attempts", () => {
    const oneTask = descriptor({
      request: {
        description: "One task",
        tasks: [{ description: "Only task", prompt: "Change src/a.ts" }],
        review: { instructions: "Review it" },
      },
    });
    let state = reduceTeamRunRecords([
      created(oneTask),
      claim(),
      phase(2, "implement"),
      reservation(3, "orphaned", "implement", 1),
      finished(4, "orphaned", { changedFiles: ["src/a.ts"] }),
      artifact(5, "worker", "orphaned-patch", "orphaned", ["src/a.ts"]),
      record(6, {
        type: "run_interrupted",
        reason: "process_restart",
        manualAttentionRequired: false,
        at: at(6),
      }),
      claim(7, 2),
      phase(8, "implement"),
    ]);
    expect(() => reduceTeamRunRecord(state, phase(9, "stage")))
      .toThrow(/artifact/u);
    state = reduceTeamRunRecord(
      state,
      reservation(9, "replacement", "implement", 1),
    );
    state = reduceTeamRunRecord(
      state,
      finished(10, "replacement", { changedFiles: ["src/a.ts"] }),
    );
    state = reduceTeamRunRecord(
      state,
      artifact(11, "worker", "replacement-patch", "replacement", ["src/a.ts"]),
    );
    state = reduceTeamRunRecord(state, phase(12, "stage"));
    expect(state).toMatchObject({ phase: "stage", round: 0 });
  });

  it("requires sequential required reviewers before recording a verdict", () => {
    const performance = descriptorForMode("performance_v4", {
      request: {
        description: "One task",
        tasks: [{ description: "Only task", prompt: "Change src/a.ts" }],
        review: { instructions: "Review it" },
      },
    });
    let state = reduceTeamRunRecords([
      created(performance),
      claim(),
      phase(2, "implement"),
      reservation(3, "implement-1", "implement", 1, 0, 10),
      finished(4, "implement-1", { changedFiles: ["src/a.ts"] }),
      artifact(5, "worker", "patch-a", "implement-1", ["src/a.ts"]),
      phase(6, "stage"),
      phase(7, "review"),
    ]);
    expect(() => reduceTeamRunRecord(
      state,
      reservation(8, "review-2", "review", 2, 0, 10),
    )).toThrow(/sequential/u);
    state = reduceTeamRunRecord(
      state,
      reservation(8, "review-1", "review", 1, 0, 10),
    );
    state = reduceTeamRunRecord(state, finished(9, "review-1"));
    const verdict = record(10, {
      type: "review_recorded",
      review: {
        round: 0,
        verdict: "approved",
        findings: [],
        evidence: ["review evidence"],
      },
      at: at(10),
    });
    expect(() => reduceTeamRunRecord(state, verdict)).toThrow(/reviewer/u);
    state = reduceTeamRunRecord(
      state,
      reservation(10, "review-2", "review", 2, 0, 10),
    );
    state = reduceTeamRunRecord(state, finished(11, "review-2"));
    expect(reduceTeamRunRecord(state, record(12, {
      type: "review_recorded",
      review: {
        round: 0,
        verdict: "approved",
        findings: [],
        evidence: ["review evidence"],
      },
      at: at(12),
    }))).toMatchObject({
      reviews: [{ verdict: "approved" }],
    });
  });

  it("allows an explicitly unverified verdict after a failed required reviewer", () => {
    const economy = descriptorForMode("economy_v4", {
      request: {
        description: "One task",
        tasks: [{ description: "Only task", prompt: "Change src/a.ts" }],
        review: { instructions: "Review it" },
      },
    });
    const state = reduceTeamRunRecords([
      created(economy),
      claim(),
      phase(2, "implement"),
      reservation(3, "implement-1", "implement", 1, 0, 4),
      finished(4, "implement-1", { changedFiles: ["src/a.ts"] }),
      artifact(5, "worker", "patch-a", "implement-1", ["src/a.ts"]),
      phase(6, "stage"),
      phase(7, "review"),
      reservation(8, "review-1", "review", 1, 0, 4),
      record(9, {
        type: "child_finished",
        child: {
          attemptId: "review-1",
          status: "failed",
          requestsUsed: 1,
          usage: null,
          usageSource: "unavailable",
          changedFiles: [],
          evidence: [],
          failure: { code: "invalid_response", message: "Malformed review" },
        },
        at: at(9),
      }),
      record(10, {
        type: "review_recorded",
        review: {
          round: 0,
          verdict: "unverified",
          findings: [],
          evidence: ["Reviewer did not produce a valid verdict"],
        },
        at: at(10),
      }),
    ]);
    expect(state.reviews.at(-1)).toMatchObject({
      verdict: "unverified",
      claimEpoch: 1,
    });
  });

  it("records a replacement review in the same round after a new claim epoch", () => {
    const oneTask = descriptor({
      request: {
        description: "One task",
        tasks: [{ description: "Only task", prompt: "Change src/a.ts" }],
        review: { instructions: "Review it" },
      },
    });
    const firstReview: TeamRunRecord[] = [
      created(oneTask),
      claim(),
      phase(2, "implement"),
      reservation(3, "implement-old", "implement", 1),
      finished(4, "implement-old", { changedFiles: ["src/a.ts"] }),
      artifact(5, "worker", "patch-old", "implement-old", ["src/a.ts"]),
      phase(6, "stage"),
      phase(7, "review"),
      reservation(8, "review-old", "review", 1),
      finished(9, "review-old"),
      record(10, {
        type: "review_recorded",
        review: {
          round: 0,
          verdict: "approved",
          findings: [],
          evidence: ["old review"],
        },
        at: at(10),
      }),
      record(11, {
        type: "run_interrupted",
        reason: "process_restart",
        manualAttentionRequired: false,
        at: at(11),
      }),
      claim(12, 2),
      phase(13, "implement"),
      reservation(14, "implement-new", "implement", 1),
      finished(15, "implement-new", { changedFiles: ["src/a.ts"] }),
      artifact(16, "worker", "patch-new", "implement-new", ["src/a.ts"]),
      phase(17, "stage"),
      phase(18, "review"),
      reservation(19, "review-new", "review", 1),
      finished(20, "review-new"),
      record(21, {
        type: "review_recorded",
        review: {
          round: 0,
          verdict: "approved",
          findings: [],
          evidence: ["new review"],
        },
        at: at(21),
      }),
    ];
    const resumedBeforeReview = reduceTeamRunRecords(firstReview.slice(0, -3));
    expect(() => reduceTeamRunRecord(resumedBeforeReview, artifact(
      19,
      "staged_candidate",
      "stale-approval-candidate",
      null,
      ["src/a.ts"],
    ))).toThrow(/approved review/u);
    const state = reduceTeamRunRecords(firstReview);
    expect(state.reviews).toMatchObject([
      { round: 0, claimEpoch: 1 },
      { round: 0, claimEpoch: 2 },
    ]);
  });

  it("does not let a prior claim's repair satisfy a resumed repair phase", () => {
    const oneTask = descriptor({
      request: {
        description: "One task",
        tasks: [{ description: "Only task", prompt: "Change src/a.ts" }],
        review: { instructions: "Review it" },
      },
    });
    const changeRequest = (sequence: number): TeamRunRecord => record(sequence, {
      type: "review_recorded",
      review: {
        round: 0,
        verdict: "changes_requested",
        findings: [{
          path: "src/a.ts",
          problem: "The edge case is not handled",
          acceptance: "Handle the edge case",
          evidence: ["src/a.ts:1"],
        }],
        evidence: ["review evidence"],
      },
      at: at(sequence),
    });
    const state = reduceTeamRunRecords([
      created(oneTask),
      claim(),
      phase(2, "implement"),
      reservation(3, "implement-old", "implement", 1),
      finished(4, "implement-old", { changedFiles: ["src/a.ts"] }),
      artifact(5, "worker", "patch-old", "implement-old", ["src/a.ts"]),
      phase(6, "stage"),
      phase(7, "review"),
      reservation(8, "review-old-1", "review", 1),
      finished(9, "review-old-1"),
      reservation(10, "review-old-2", "review", 2),
      finished(11, "review-old-2"),
      changeRequest(12),
      phase(13, "repair", 1),
      reservation(14, "repair-old", "repair", 1, 1),
      finished(15, "repair-old"),
      record(16, {
        type: "run_interrupted",
        reason: "process_restart",
        manualAttentionRequired: false,
        at: at(16),
      }),
      claim(17, 2),
      phase(18, "implement"),
      reservation(19, "implement-new", "implement", 1),
      finished(20, "implement-new", { changedFiles: ["src/a.ts"] }),
      artifact(21, "worker", "patch-new", "implement-new", ["src/a.ts"]),
      phase(22, "stage"),
      phase(23, "review"),
      reservation(24, "review-new-1", "review", 1),
      finished(25, "review-new-1"),
      reservation(26, "review-new-2", "review", 2),
      finished(27, "review-new-2"),
      changeRequest(28),
      phase(29, "repair", 1),
    ]);
    expect(() => reduceTeamRunRecord(state, phase(30, "review", 1)))
      .toThrow(/repair/u);
  });

  it("resets a prepared clean-base apply without calling it approved", () => {
    const approved = approvedState();
    const beforeCommit = reduceTeamRunRecords(
      approved.records.slice(0, -1),
    );
    const reset = reduceTeamRunRecord(beforeCommit, record(18, {
      type: "apply_reset",
      reason: "clean_base",
      at: at(18),
    }));

    expect(reset).toMatchObject({
      status: "ready_to_apply",
      apply: null,
      candidate: { artifact: { id: "candidate-1" } },
    });
  });

  it("keeps prepared apply uncertainty non-terminal until exact reconciliation", () => {
    const beforeCommit = reduceTeamRunRecords(
      approvedState().records.slice(0, -1),
    );
    const interrupted = reduceTeamRunRecord(beforeCommit, record(18, {
      type: "run_interrupted",
      reason: "uncertain parent workspace",
      manualAttentionRequired: true,
      at: at(18),
    }));
    expect(() => reduceTeamRunRecord(interrupted, record(19, {
      type: "cancel_requested",
      reason: "hide uncertain apply",
      at: at(19),
    }))).toThrow(/reconcil/u);
    expect(() => reduceTeamRunRecord(interrupted, record(19, {
      type: "run_terminal",
      status: "failed",
      outcome: {
        changedFiles: [],
        evidence: [],
        failure: { code: "failed", message: "hide uncertain apply" },
      },
      at: at(19),
    }))).toThrow(/reconcil/u);
    expect(() => reduceTeamRunRecord(interrupted, record(19, {
      type: "run_interrupted",
      reason: "downgrade manual attention",
      manualAttentionRequired: false,
      at: at(19),
    }))).toThrow(/already interrupted/u);

    const reset = reduceTeamRunRecord(interrupted, record(19, {
      type: "apply_reset",
      reason: "clean_base",
      at: at(19),
    }));
    expect(reset).toMatchObject({
      status: "ready_to_apply",
      apply: null,
      interruption: null,
    });

    const committed = reduceTeamRunRecord(interrupted, record(19, {
      type: "apply_committed",
      checkpoint: beforeCommit.apply!.checkpoint,
      changedFiles: ["src/a.ts", "src/b.ts"],
      at: at(19),
    }));
    expect(committed).toMatchObject({ status: "approved" });
  });

  it("does not prepare or commit apply after durable cancellation", () => {
    const applying = reduceTeamRunRecords(
      approvedState().records.slice(0, -2),
    );
    const cancelled = reduceTeamRunRecord(applying, record(17, {
      type: "cancel_requested",
      reason: "User cancelled before mutation",
      at: at(17),
    }));
    expect(() => reduceTeamRunRecord(cancelled, record(18, {
      type: "apply_prepared",
      checkpoint: {
        id: "checkpoint-1",
        sessionId: "parent-session",
        toolCallId: "team-run-1",
      },
      at: at(18),
    }))).toThrow(/cancel/u);
  });

  it("treats a crash before apply preparation as safely resumable", () => {
    const applying = reduceTeamRunRecords(
      approvedState().records.slice(0, -2),
    );
    const interrupted = reduceTeamRunRecord(applying, record(17, {
      type: "run_interrupted",
      reason: "process_restart_before_mutation",
      manualAttentionRequired: false,
      at: at(17),
    }));
    expect(interrupted).toMatchObject({
      status: "interrupted",
      apply: null,
      interruption: { manualAttentionRequired: false },
    });
  });

  it("parses exact bounded records and rejects tampering", () => {
    expect(parseTeamRunRecord(created(), "team-run-1")).toMatchObject({
      type: "team_created",
      sequence: 0,
    });
    expect(() => parseTeamRunRecord(
      { ...created(), runId: "foreign" },
      "team-run-1",
    )).toThrow(/run/u);
    const oversizedId = "a".repeat(129);
    expect(() => parseTeamRunRecord(
      created(descriptor({ id: oversizedId })),
      oversizedId,
    )).toThrow(/record/u);
    expect(() => parseTeamRunRecord(
      { ...created(), sequence: 1 },
      "team-run-1",
    )).toThrow(/sequence zero/u);
    expect(() => parseTeamRunRecord(
      { ...created(), extra: true },
      "team-run-1",
    )).toThrow(/record/u);
    expect(() => parseTeamRunRecord(
      { ...created(), at: "not-a-time" },
      "team-run-1",
    )).toThrow(/record/u);
    expect(() => parseTeamRunRecord(record(1, {
      type: "run_claimed",
      ownerId: "../unsafe",
      claimEpoch: 1,
      at: at(1),
    }), "team-run-1")).toThrow(/record/u);
    expect(() => parseTeamRunRecord(record(1, {
      type: "apply_prepared",
      checkpoint: {
        id: "../unsafe",
        sessionId: "parent-session",
        toolCallId: "team-run-1",
      },
      at: at(1),
    }), "team-run-1")).toThrow(/record/u);
    expect(() => parseTeamRunRecord(record(1, {
      type: "child_finished",
      child: {
        attemptId: "attempt-1",
        status: "completed",
        requestsUsed: 1,
        usage: { inputTokens: 1.5, outputTokens: 1 },
        usageSource: "provider",
        changedFiles: [],
        evidence: [],
        failure: null,
      },
      at: at(1),
    }), "team-run-1")).toThrow(/record/u);
    expect(() => parseTeamRunRecord(artifact(
      1,
      "worker",
      "unsafe-patch",
      "attempt-1",
      [".env"],
    ), "team-run-1")).toThrow(/record/u);
    expect(() => parseTeamRunRecord(record(1, {
      type: "run_terminal",
      status: "failed",
      outcome: {
        changedFiles: [],
        evidence: Array.from({ length: 64 }, () => "x".repeat(5_000)),
        failure: { code: "failed", message: "Oversized evidence" },
      },
      at: at(1),
    }), "team-run-1")).toThrow(/exceeds/u);
    expect(() => parseTeamRunRecord(created(descriptor({
      execution: "background",
    })), "team-run-1")).toThrow(/record/u);
  });

  it("snapshots descriptor, evidence, usage, and paths against caller mutation", () => {
    const mutable = descriptor();
    const state = reduceTeamRunRecords([created(mutable), claim()]);
    mutable.request.tasks[0]!.prompt = "mutated";
    mutable.backend.billingSelectionAtCreation.allowedSources[0] =
      "included_subscription";

    expect(state.descriptor.request.tasks[0]?.prompt).toBe("Change src/a.ts");
    expect(state.descriptor.backend.billingSelectionAtCreation.allowedSources)
      .toEqual(["local_compute"]);
    expect(Object.isFrozen(state.descriptor)).toBe(true);
  });
});
