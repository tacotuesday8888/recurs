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

  it("does not split a tool call from its retained results", async () => {
    const state = {
      ...longSession(),
      messages: [
        { id: "old", role: "user" as const, content: "old" },
        {
          id: "tool-request",
          role: "assistant" as const,
          content: "",
          toolCalls: [
            { id: "call-1", name: "read_file", arguments: { path: "a.ts" } },
            { id: "call-2", name: "read_file", arguments: { path: "b.ts" } },
          ],
        },
        { id: "result-1", role: "tool" as const, content: "a", toolCallId: "call-1" },
        { id: "result-2", role: "tool" as const, content: "b", toolCallId: "call-2" },
        { id: "answer", role: "assistant" as const, content: "read both" },
        { id: "user-2", role: "user" as const, content: "next" },
        { id: "answer-2", role: "assistant" as const, content: "next answer" },
        { id: "user-3", role: "user" as const, content: "latest" },
      ],
    };
    const provider = new ScriptedProvider([
      [
        { type: "text_delta", text: "summary" },
        { type: "done", stopReason: "complete" },
      ],
    ]);

    const compacted = await compactSession(
      state,
      provider,
      new AbortController().signal,
    );

    expect(compacted.retainedMessages.map((message) => message.id)).toEqual([
      "tool-request",
      "result-1",
      "result-2",
      "answer",
      "user-2",
      "answer-2",
      "user-3",
    ]);
  });
});
