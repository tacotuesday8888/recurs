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

    expect(output).toContain("↳ Explore child: Inspect cache key");
    expect(output).toContain("✓ Explore child completed: child-agent (1/4 this run)");
    expect(output).toContain("✗ Implement child failed: Focused tests failed");
    expect(output).toContain("✗ Review child cancelled: Parent cancelled the run");
  });
});
