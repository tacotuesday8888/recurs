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
    });
    await renderer.emit({
      type: "agent_completed",
      sessionId: "parent-session",
      at: "2026-07-17T00:00:01.000Z",
      parentAgentId: "parent-agent",
      childAgentId: "child-agent",
      childSessionId: "child-session",
      usage: { inputTokens: 10, outputTokens: 4 },
      evidence: ["cache test passed"],
      costLimitExceeded: false,
    });

    expect(output).toContain("↳ child: Inspect cache key");
    expect(output).toContain("✓ child completed: child-agent");
  });
});
