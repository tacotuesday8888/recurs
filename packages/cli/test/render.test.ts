import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { TextEventRenderer } from "../src/render.js";

describe("TextEventRenderer agent activity", () => {
  it("keeps child lifecycle visible in the terminal", async () => {
    let output = "";
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const renderer = new TextEventRenderer(stream);

    await renderer.emit({
      type: "company_blueprint_activated",
      sessionId: "parent-session",
      at: "2026-07-17T00:00:00.000Z",
      parentAgentId: "parent-agent",
      blueprintId: "company-1",
      blueprintVersion: 1,
      developmentStyle: "layered_company",
      operatingModeId: "balanced_v5",
      roleCount: 8,
    });

    await renderer.emit({
      type: "agent_started",
      sessionId: "parent-session",
      at: "2026-07-17T00:00:00.000Z",
      parentAgentId: "parent-agent",
      childAgentId: "child-agent",
      childSessionId: "child-session",
      taskId: "task-1",
      description: "Inspect cache key",
      operatingModeId: "balanced_v1",
      profileId: "explore_v1",
    });
    await renderer.emit({
      type: "agent_completed",
      sessionId: "parent-session",
      at: "2026-07-17T00:00:01.000Z",
      parentAgentId: "parent-agent",
      childAgentId: "child-agent",
      childSessionId: "child-session",
      profileId: "explore_v1",
      usage: { inputTokens: 10, outputTokens: 4 },
      changedFiles: [],
      evidence: ["cache test passed"],
      costLimitExceeded: false,
      workflow: {
        childrenStarted: 1,
        maxChildren: 4,
        reportedCostUsd: 0,
        maxReportedCostUsd: 3,
      },
    });
    await renderer.emit({
      type: "agent_failed",
      sessionId: "parent-session",
      at: "2026-07-17T00:00:02.000Z",
      parentAgentId: "parent-agent",
      childAgentId: "implement-agent",
      childSessionId: "implement-session",
      profileId: "implement_v1",
      failure: {
        domain: "runtime",
        phase: "started",
        code: "runtime_failed",
        safeMessage: "Focused tests failed",
        diagnosticId: "implement-failure",
        retryable: false,
      },
    });
    await renderer.emit({
      type: "agent_cancelled",
      sessionId: "parent-session",
      at: "2026-07-17T00:00:03.000Z",
      parentAgentId: "parent-agent",
      childAgentId: "review-agent",
      childSessionId: "review-session",
      profileId: "review_v1",
      reason: "Parent cancelled the run",
    });
    await renderer.emit({
      type: "agent_batch_started",
      sessionId: "parent-session",
      at: "2026-07-17T00:00:04.000Z",
      parentAgentId: "parent-agent",
      batchId: "batch-1",
      operatingModeId: "balanced_v2",
      taskCount: 3,
      maxConcurrentChildren: 3,
    });
    await renderer.emit({
      type: "agent_batch_failed",
      sessionId: "parent-session",
      at: "2026-07-17T00:00:05.000Z",
      parentAgentId: "parent-agent",
      batchId: "batch-1",
      operatingModeId: "balanced_v2",
      counts: { total: 3, completed: 2, failed: 1, cancelled: 0 },
      workflow: {
        childrenStarted: 3,
        maxChildren: 4,
        requestsReserved: 18,
        requestsUsed: 7,
        maxRequests: 24,
        reportedCostUsd: 0.5,
        maxReportedCostUsd: 3,
      },
      partial: true,
    });
    await renderer.emit({
      type: "agent_batch_completed",
      sessionId: "parent-session",
      at: "2026-07-17T00:00:06.000Z",
      parentAgentId: "parent-agent",
      batchId: "batch-2",
      operatingModeId: "standard_v2",
      counts: { total: 2, completed: 2, failed: 0, cancelled: 0 },
      workflow: {
        childrenStarted: 2,
        maxChildren: 3,
        requestsReserved: 10,
        requestsUsed: 4,
        maxRequests: 16,
        reportedCostUsd: 0.2,
        maxReportedCostUsd: 1,
      },
    });
    await renderer.emit({
      type: "agent_batch_cancelled",
      sessionId: "parent-session",
      at: "2026-07-17T00:00:07.000Z",
      parentAgentId: "parent-agent",
      batchId: "batch-3",
      operatingModeId: "standard_v2",
      counts: { total: 3, completed: 1, failed: 0, cancelled: 2 },
      workflow: {
        childrenStarted: 2,
        maxChildren: 3,
        requestsReserved: 10,
        requestsUsed: 4,
        maxRequests: 16,
        reportedCostUsd: 0.2,
        maxReportedCostUsd: 1,
      },
      reason: "Parent delegation was cancelled",
    });
    await renderer.emit({
      type: "agent_team_started",
      sessionId: "parent-session",
      at: "2026-07-17T00:00:08.000Z",
      parentAgentId: "parent-agent",
      teamId: "team-1",
      operatingModeId: "balanced_v3",
      description: "Implement cache isolation",
      implementerCount: 2,
      qualityStandard: "balanced",
    });
    await renderer.emit({
      type: "agent_team_patch_captured",
      sessionId: "parent-session",
      at: "2026-07-17T00:00:09.000Z",
      parentAgentId: "parent-agent",
      teamId: "team-1",
      operatingModeId: "balanced_v3",
      teamIndex: 1,
      childAgentId: "implement-agent",
      childSessionId: "implement-session",
      artifactId: "patch-1",
      paths: ["src/cache.ts", "test/cache.test.ts"],
    });
    await renderer.emit({
      type: "agent_team_patches_integrated",
      sessionId: "parent-session",
      at: "2026-07-17T00:00:10.000Z",
      parentAgentId: "parent-agent",
      teamId: "team-1",
      operatingModeId: "balanced_v3",
      artifactIds: ["patch-1", "patch-2"],
      changedFiles: ["src/cache.ts", "test/cache.test.ts"],
      checkpointId: "checkpoint-1",
    });
    await renderer.emit({
      type: "agent_team_review_recorded",
      sessionId: "parent-session",
      at: "2026-07-17T00:00:11.000Z",
      parentAgentId: "parent-agent",
      teamId: "team-1",
      operatingModeId: "balanced_v3",
      reviewIndex: 1,
      status: "completed",
      verdict: "approve",
      summary: "Focused verification passed",
      evidence: ["cache test passed"],
    });
    await renderer.emit({
      type: "agent_team_completed",
      sessionId: "parent-session",
      at: "2026-07-17T00:00:12.000Z",
      parentAgentId: "parent-agent",
      teamId: "team-1",
      operatingModeId: "balanced_v3",
      status: "approved",
      changedFiles: ["src/cache.ts", "test/cache.test.ts"],
      evidence: ["cache test passed"],
      workflow: {
        childrenStarted: 3,
        maxChildren: 4,
        requestsReserved: 24,
        requestsUsed: 9,
        maxRequests: 32,
        reportedCostUsd: 0.4,
        maxReportedCostUsd: 3,
      },
    });
    await renderer.emit({
      type: "agent_team_failed",
      sessionId: "parent-session",
      at: "2026-07-17T00:00:13.000Z",
      parentAgentId: "parent-agent",
      teamId: "team-2",
      operatingModeId: "standard_v3",
      phase: "integration",
      partial: false,
      failure: { code: "patch_failed", message: "Patches conflict" },
      workflow: {
        childrenStarted: 1,
        maxChildren: 3,
        requestsReserved: 6,
        requestsUsed: 3,
        maxRequests: 18,
        reportedCostUsd: 0.1,
        maxReportedCostUsd: 1,
      },
    });
    await renderer.emit({
      type: "agent_team_cancelled",
      sessionId: "parent-session",
      at: "2026-07-17T00:00:14.000Z",
      parentAgentId: "parent-agent",
      teamId: "team-3",
      operatingModeId: "standard_v3",
      phase: "review",
      partial: true,
      reason: "Parent cancelled the run",
      workflow: {
        childrenStarted: 2,
        maxChildren: 3,
        requestsReserved: 12,
        requestsUsed: 5,
        maxRequests: 18,
        reportedCostUsd: 0.2,
        maxReportedCostUsd: 1,
      },
    });

    expect(output).toContain("Company company-1 activated: 8 approved roles");
    expect(output).toContain("↳ Explore child: Inspect cache key");
    expect(output).toContain("✓ Explore child completed: child-agent (1/4 this run)");
    expect(output).toContain("✗ Implement child failed: Focused tests failed");
    expect(output).toContain("✗ Review child cancelled: Parent cancelled the run");
    expect(output).toContain("⇉ Agent batch batch-1: 3 tasks, up to 3 concurrent");
    expect(output).toContain(
      "✗ Agent batch batch-1 partially completed: 2 completed, 1 failed",
    );
    expect(output).toContain("✓ Agent batch batch-2 completed: 2/2");
    expect(output).toContain(
      "✗ Agent batch batch-3 cancelled: 1 completed, 2 cancelled",
    );
    expect(output).toContain("⇶ Team team-1: 2 Implement workers (balanced)");
    expect(output).toContain("↳ Team team-1 worker 1 captured 2 files");
    expect(output).toContain("⇢ Team team-1 integrated 2 patches across 2 files");
    expect(output).toContain("✓ Team team-1 review 1: approve — Focused verification passed");
    expect(output).toContain("✓ Team team-1 approved: 2 changed files");
    expect(output).toContain("✗ Team team-2 failed during integration: Patches conflict");
    expect(output).toContain("✗ Team team-3 cancelled during review after integration");
  });
});

describe("TextEventRenderer presentation", () => {
  it("adds semantic color without changing status text", async () => {
    let output = "";
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const renderer = new TextEventRenderer(stream, { colorEnabled: true });

    await renderer.emit({
      type: "warning",
      sessionId: "session-1",
      at: "2026-07-22T00:00:00.000Z",
      message: "Context is nearly full",
    });
    await renderer.emit({
      type: "verification_recorded",
      sessionId: "session-1",
      at: "2026-07-22T00:00:01.000Z",
      evidence: ["focused tests passed"],
    });

    expect(output).toContain("\u001b[33mWarning: Context is nearly full\u001b[0m");
    expect(output).toContain("\u001b[32mVerified: focused tests passed\u001b[0m");
  });
});
