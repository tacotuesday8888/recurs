import path from "node:path";

import {
  getOperatingModePolicy,
  type SessionBackendPin,
  type TeamRunDescriptor,
  type TeamRunPolicySnapshot,
} from "@recurs/contracts";
import { describe, expect, it } from "vitest";

import { projectTeamRunActivityEvent } from "../src/events.js";
import {
  reduceTeamRunRecords,
  type TeamRunRecord,
} from "../src/team-run-state.js";

const baseRevision = "a".repeat(40);
const createdAt = "2026-07-18T00:00:00.000Z";

function backend(): SessionBackendPin {
  return {
    kind: "model_provider",
    providerId: "provider-secret",
    adapterId: "adapter-secret",
    connectionId: "connection-secret",
    modelId: "model-secret",
    modelIdentityKind: "versioned",
    providerResolvedModelRevisionAtCreation: "model-revision-secret",
    catalogRevision: "catalog-secret",
    policyRevisionAtCreation: "policy-secret",
    billingPolicyRevisionAtCreation: "billing-secret",
    primaryBillingSourceAtCreation: "local_compute",
    billingSelectionAtCreation: {
      mode: "strict_primary_only",
      policyRevision: "policy-secret",
      disclosureRevision: "disclosure-secret",
      allowedSources: ["local_compute"],
      acknowledgedAt: createdAt,
    },
    accountSubjectFingerprint: "account-fingerprint-secret",
  };
}

function descriptor(): TeamRunDescriptor {
  const policy = structuredClone(
    getOperatingModePolicy("balanced_v4"),
  ) as TeamRunPolicySnapshot;
  const parentBackend = backend();
  const routeBackend = { ...backend(), connectionId: "role-connection-secret" };
  const routes: TeamRunDescriptor["routes"] = [
    {
      role: "implement",
      profileId: "implement_v2",
      executionMode: "act",
      permissionMode: "approved_for_me",
      strategy: "role_candidate",
      candidateId: "candidate-secret",
      reason: "eligible_role_candidate",
      pin: routeBackend,
    },
    {
      role: "review",
      profileId: "review_v2",
      executionMode: "act",
      permissionMode: "approved_for_me",
      strategy: "inherit_parent",
      candidateId: "parent",
      reason: "parent_fallback",
      pin: parentBackend,
    },
    {
      role: "repair",
      profileId: "repair_v1",
      executionMode: "act",
      permissionMode: "approved_for_me",
      strategy: "inherit_parent",
      candidateId: "parent",
      reason: "parent_fallback",
      pin: parentBackend,
    },
  ];
  return {
    id: "team-1",
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
      maxChildren: policy.workflow.maxChildrenPerRun,
      maxRequests: policy.workflow.maxRequestsPerRun,
      requestAllowance: Math.floor(
        policy.workflow.maxRequestsPerRun /
          policy.workflow.maxChildrenPerRun,
      ),
      maxReportedCostUsd: policy.orchestration.maxReportedCostUsd,
    },
    routes,
    backend: parentBackend,
    repositoryRoot: path.resolve("/private/worktree-location-secret"),
    baseRevision,
    request: {
      description: "description-secret",
      tasks: [
        { description: "task-one-secret", prompt: "prompt-one-secret" },
        { description: "task-two-secret", prompt: "prompt-two-secret" },
      ],
      review: { instructions: "review-instructions-secret" },
    },
  };
}

function record(
  sequence: number,
  value: Omit<TeamRunRecord, "version" | "runId" | "sequence">,
): TeamRunRecord {
  return {
    version: 1,
    runId: "team-1",
    sequence,
    ...value,
  } as TeamRunRecord;
}

describe("durable team activity events", () => {
  it("projects one exact safe journal activity without durable internals", () => {
    const requestAllowance = Math.floor(
      getOperatingModePolicy("balanced_v4").workflow.maxRequestsPerRun /
        getOperatingModePolicy("balanced_v4").workflow.maxChildrenPerRun,
    );
    const records: TeamRunRecord[] = [
      {
        version: 1,
        runId: "team-1",
        sequence: 0,
        at: createdAt,
        type: "team_created",
        descriptor: descriptor(),
      },
      record(1, {
        type: "run_claimed",
        ownerId: "owner-secret",
        claimEpoch: 1,
        at: "2026-07-18T00:00:01.000Z",
      }),
      record(2, {
        type: "phase_started",
        phase: "implement",
        round: 0,
        at: "2026-07-18T00:00:02.000Z",
      }),
      record(3, {
        type: "child_reserved",
        child: {
          attemptId: "attempt-1",
          role: "implement",
          index: 1,
          round: 0,
          childAgentId: "child-agent-secret",
          childSessionId: "child-session-secret",
          requestAllowance,
        },
        at: "2026-07-18T00:00:03.000Z",
      }),
      record(4, {
        type: "child_finished",
        child: {
          attemptId: "attempt-1",
          status: "completed",
          requestsUsed: 3,
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            costUsd: 0.25,
          },
          usageSource: "provider",
          changedFiles: ["src/private-path-secret.ts"],
          evidence: ["raw-evidence-secret"],
          failure: null,
        },
        at: "2026-07-18T00:00:04.000Z",
      }),
    ];

    const event = projectTeamRunActivityEvent(reduceTeamRunRecords(records));

    expect(event).toEqual({
      type: "agent_team_activity",
      sessionId: "parent-session",
      at: "2026-07-18T00:00:04.000Z",
      parentAgentId: "parent-agent",
      teamId: "team-1",
      sequence: 4,
      status: "running",
      phase: "implement",
      round: 0,
      operatingModeId: "balanced_v4",
      execution: "foreground",
      activity: "child_finished",
      counts: {
        childrenReserved: 1,
        childrenFinished: 1,
        requestsReserved: requestAllowance,
        requestsUsed: 3,
        costReportedChildren: 1,
        costMissingChildren: 0,
        costCoverage: "complete",
      },
      role: "implement",
      index: 1,
      routeStrategy: "role_candidate",
      routeReason: "eligible_role_candidate",
      modelId: "model-secret",
      reasoningEffort: null,
    });

    const serialized = JSON.stringify(event);
    for (const secret of [
      "prompt-one-secret",
      "review-instructions-secret",
      "private-path-secret",
      "raw-evidence-secret",
      "owner-secret",
      "child-agent-secret",
      "child-session-secret",
      "candidate-secret",
      "role-connection-secret",
      "account-fingerprint-secret",
      "worktree-location-secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    for (const forbiddenField of [
      "prompt",
      "findings",
      "paths",
      "artifactId",
      "checkpointId",
      "sha256",
      "pin",
      "accountSubjectFingerprint",
      "repositoryRoot",
      "worktree",
      "evidence",
    ]) {
      expect(serialized).not.toContain(`"${forbiddenField}"`);
    }
  });
});
