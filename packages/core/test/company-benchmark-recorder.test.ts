import { describe, expect, it } from "vitest";

import type {
  AgentRunRequest,
  AgentRuntime,
  ProviderUsage,
  RunAuthorization,
} from "@recurs/contracts";
import type { ModelProvider, ProviderRequest } from "@recurs/providers";

import {
  CompanyBenchmarkExecutionRecorder,
  type CompanyBenchmarkExecutionAllowance,
  type CompanyBenchmarkProviderRequest,
} from "../src/index.js";
import type { RecursEvent } from "../src/events.js";

const AT = Date.parse("2026-07-24T00:00:00.000Z");

function authorization(sessionId: string): RunAuthorization {
  return {
    kind: "run",
    id: `authorization-${sessionId}`,
    operation: "run",
    sessionId,
    operationId: `operation-${sessionId}`,
    turnId: `turn-${sessionId}`,
    connectionId: "connection",
    modelId: "model",
    backendFingerprint: "backend",
    connectionRevision: 1,
    policyRevision: "policy",
    billingMode: "strict_primary_only",
    billingSelectionDigest: "billing",
    contextDigest: "context",
    maxRequests: 8,
    expiresAt: "2026-07-24T01:00:00.000Z",
  };
}

class Allowance implements CompanyBenchmarkExecutionAllowance {
  readonly requestAllowance = 8;
  readonly reportedCostAllowanceUsd = 8;
  readonly reservations: number[] = [];
  readonly settlements: (number | null)[] = [];
  #next = 1;

  beforeProviderRequest(maximumReportedCostUsd: number) {
    this.reservations.push(maximumReportedCostUsd);
    return { id: `request-${this.#next++}` };
  }

  afterProviderResponse(
    request: CompanyBenchmarkProviderRequest,
    reportedCostUsd: number | null,
  ) {
    void request;
    this.settlements.push(reportedCostUsd);
  }
}

function directRequest(sessionId: string): ProviderRequest {
  return {
    model: "model",
    messages: [],
    tools: [],
    signal: new AbortController().signal,
    directContext: {
      authorization: authorization(sessionId),
      expectedSessionRecordSequence: 1,
    },
  };
}

function delegatedRequest(sessionId: string): AgentRunRequest {
  const authority = authorization(sessionId);
  return {
    sessionId,
    turnId: `turn-${sessionId}`,
    prompt: "bounded task",
    cwd: "/workspace",
    modelId: "model",
    executionMode: "act",
    permissionMode: "approved_for_me",
    authorization: authority,
    continuationReader: null,
    continuationWriter: {
      id: `writer-${sessionId}`,
      expiresAt: authority.expiresAt,
    },
    continuation: null,
    signal: new AbortController().signal,
  };
}

function childStarted(sessionId: string): RecursEvent {
  return {
    type: "agent_started",
    sessionId: "parent",
    at: "2026-07-24T00:00:00.100Z",
    parentAgentId: "parent-agent",
    childAgentId: `agent-${sessionId}`,
    childSessionId: sessionId,
    taskId: `task-${sessionId}`,
    description: "Implement one bounded change",
    operatingModeId: "balanced_v6",
    profileId: "implement_v2",
    modelId: "model",
    reasoningEffort: "medium",
    teamId: "team",
    teamIndex: 1,
  };
}

describe("CompanyBenchmarkExecutionRecorder", () => {
  it("meters direct and delegated requests and projects bounded role evidence", async () => {
    let now = AT;
    const allowance = new Allowance();
    const recorder = new CompanyBenchmarkExecutionRecorder({
      allowance,
      maximumReportedCostPerRequestUsd: 1,
      nowMs: () => ++now,
    });
    recorder.registerParent("parent-session", AT);

    const provider: ModelProvider = {
      id: "provider",
      async *stream() {
        yield {
          type: "usage",
          inputTokens: 10,
          outputTokens: 2,
          cachedInputTokens: 3,
          costUsd: 0.25,
        };
        yield { type: "done", stopReason: "complete" };
      },
    };
    for await (const event of recorder.wrapProvider(provider).stream(
      directRequest("parent-session"),
    )) {
      void event;
    }

    recorder.observe(childStarted("child-session"));
    const runtime: AgentRuntime = {
      adapterId: "runtime",
      connectionId: "connection",
      capabilityProfileRevision: "profile-v1",
      capabilities: {
        resume: false,
        cancellation: "protocol",
        fileEvents: true,
        usageEvents: true,
        supportedPermissionModes: ["approved_for_me"],
        approvalControl: "recurs_policy_bridge",
        planMode: "enforced",
        toolExecution: "host_tools",
        checkpointing: "host_tools",
      },
      async *run() {
        const usage: ProviderUsage = {
          inputTokens: 20,
          outputTokens: 4,
        };
        yield { type: "usage", usage };
        yield {
          type: "done",
          finalText: "implemented",
          stopReason: "complete",
        };
      },
      async reconcile() {
        return "gone";
      },
    };
    for await (const event of recorder.wrapRuntime(runtime).run(
      delegatedRequest("child-session"),
      {},
    )) {
      void event;
    }
    recorder.observe({
      type: "agent_completed",
      sessionId: "parent-session",
      at: "2026-07-24T00:00:00.500Z",
      parentAgentId: "parent-agent",
      childAgentId: "agent-child-session",
      childSessionId: "child-session",
      profileId: "implement_v2",
      usage: { inputTokens: 20, outputTokens: 4 },
      changedFiles: ["src/alias-path.js"],
      evidence: ["visible tests passed"],
      costLimitExceeded: false,
      workflow: {
        childrenStarted: 1,
        maxChildren: 2,
        requestsReserved: 1,
        requestsUsed: 1,
        maxRequests: 8,
        reportedCostUsd: 0,
        maxReportedCostUsd: 8,
      },
      teamId: "team",
      teamIndex: 1,
    });
    recorder.observe({
      type: "permission_requested",
      sessionId: "parent-session",
      at: "2026-07-24T00:00:00.510Z",
      intent: { category: "write", risk: "normal", summary: "write source" },
    });
    recorder.observe({
      type: "permission_resolved",
      sessionId: "parent-session",
      at: "2026-07-24T00:00:00.520Z",
      intent: { category: "write", risk: "normal", summary: "write source" },
      decision: "allowed_by_policy",
    });
    recorder.finishParent({
      completedAtMs: AT + 1_000,
      status: "completed",
      changedFiles: ["src/alias-path.js"],
      evidence: ["hidden verification passed"],
    });

    const snapshot = recorder.snapshot(AT + 1_000);

    expect(allowance.reservations).toEqual([1, 1]);
    expect(allowance.settlements).toEqual([0.25, null]);
    expect(snapshot.requests.map((request) => ({
      role: request.role,
      usage: request.usage,
    }))).toEqual([
      {
        role: "parent",
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          cachedInputTokens: 3,
          costUsd: 0.25,
        },
      },
      {
        role: "implement",
        usage: { inputTokens: 20, outputTokens: 4 },
      },
    ]);
    expect(snapshot.attempts).toEqual([
      expect.objectContaining({
        role: "parent",
        status: "completed",
      }),
      expect.objectContaining({
        role: "implement",
        status: "completed",
        changedFiles: ["src/alias-path.js"],
        evidence: ["visible tests passed"],
      }),
    ]);
    expect(snapshot.interventions).toEqual({
      externalConfirmationRequests: 1,
      userInputRequests: 0,
      automaticApprovals: 1,
      automaticDenials: 0,
    });
  });

  it("fails closed when a provider request cannot be attributed to an activated role", async () => {
    const recorder = new CompanyBenchmarkExecutionRecorder({
      allowance: new Allowance(),
      maximumReportedCostPerRequestUsd: 0,
    });
    const provider: ModelProvider = {
      id: "provider",
      async *stream() {
        yield { type: "done", stopReason: "complete" };
      },
    };

    const consume = async () => {
      for await (const event of recorder.wrapProvider(provider).stream(
        directRequest("unknown-session"),
      )) {
        void event;
      }
    };
    await expect(consume()).rejects.toThrow("no activated role");
  });
});
