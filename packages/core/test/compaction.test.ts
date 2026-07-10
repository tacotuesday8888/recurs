import { describe, expect, it } from "vitest";

import { ScriptedProvider } from "@recurs/providers";

import {
  activeGoal,
  compactSession,
  createSessionState,
} from "../src/index.js";

function longSession() {
  const goal = {
    ...activeGoal("Ship auth", "2026-07-10T00:00:00.000Z"),
    progress: "Implemented login",
    blockers: ["Blocked by missing migration"],
    evidence: ["unit tests pass"],
  };
  return {
    ...createSessionState({
      id: "s1",
      cwd: "/workspace",
      model: "scripted",
    }),
    goal,
    changedFiles: ["src/auth.ts"],
    messages: Array.from({ length: 10 }, (_, index) => ({
      id: `m${index}`,
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `message ${index}`,
    })),
  };
}

describe("compactSession", () => {
  it("requests a structured summary and retains the latest six messages", async () => {
    const state = longSession();
    const provider = new ScriptedProvider([
      [
        {
          type: "text_delta",
          text: "Goal: Ship auth\nChanged: src/auth.ts\nBlocked by missing migration",
        },
        { type: "done", stopReason: "complete" },
      ],
    ]);

    const compacted = await compactSession(
      state,
      provider,
      new AbortController().signal,
    );

    expect(compacted.summary).toContain("Ship auth");
    expect(compacted.summary).toContain("src/auth.ts");
    expect(compacted.summary).toContain("Blocked by missing migration");
    expect(compacted.retainedMessages).toEqual(state.messages.slice(-6));
    const request = provider.requests[0]?.messages.at(-1)?.content ?? "";
    expect(request).toContain("Ship auth");
    expect(request).toContain("src/auth.ts");
    expect(request).toContain("Blocked by missing migration");
  });

  it("rejects a compaction response that requests tools", async () => {
    const provider = new ScriptedProvider([
      [
        { type: "tool_call", call: { id: "1", name: "read_file", arguments: {} } },
        { type: "done", stopReason: "tool_calls" },
      ],
    ]);

    await expect(
      compactSession(longSession(), provider, new AbortController().signal),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
});
