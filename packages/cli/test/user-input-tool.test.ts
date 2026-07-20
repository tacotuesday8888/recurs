import { deriveTrustedRunContext, createHostInvocation } from "@recurs/contracts";
import {
  PermissionEngine,
  ToolRegistry,
  type ApprovalHandler,
  type ToolContext,
} from "@recurs/tools";
import { describe, expect, it, vi } from "vitest";

import {
  createRequestUserInputTool,
  MAX_USER_ANSWER_BYTES,
} from "../src/index.js";

const deny: ApprovalHandler = {
  async request() {
    return "deny";
  },
};

function context(
  input: Parameters<typeof createHostInvocation>[0] = {
    invocation: "repl",
    userPresent: true,
    remote: false,
    scripted: false,
    embedding: "cli",
  },
  signal = new AbortController().signal,
): ToolContext {
  return {
    sessionId: "session-1",
    cwd: "/workspace",
    signal,
    executionMode: "plan",
    readRevisions: new Map(),
    runContext: deriveTrustedRunContext(createHostInvocation(input)),
  };
}

describe("request_user_input", () => {
  it("returns one bounded local user's selected answer without permission prompts", async () => {
    const ask = vi.fn(async () => "  Use the existing API  ");
    const registry = new ToolRegistry([createRequestUserInputTool(ask)]);
    const approvals = { request: vi.fn() };
    const localContext = context();

    expect(registry.definitions("plan", undefined, localContext).map(
      (definition) => definition.name,
    )).toEqual(["request_user_input"]);

    const result = await registry.invoke({
      id: "question-1",
      name: "request_user_input",
      arguments: {
        question: "Which implementation should I use?",
        options: ["Use the existing API", "Add a new adapter"],
      },
    }, localContext, new PermissionEngine("ask_always"), approvals);

    expect(JSON.parse(result.output)).toEqual({
      status: "answered",
      answer: "Use the existing API",
    });
    expect(ask).toHaveBeenCalledWith({
      question: "Which implementation should I use?",
      options: ["Use the existing API", "Add a new adapter"],
    }, expect.any(AbortSignal));
    expect(approvals.request).not.toHaveBeenCalled();
  });

  it("fails closed outside a local manual user-present CLI", async () => {
    const ask = vi.fn(async () => "answer");
    const registry = new ToolRegistry([createRequestUserInputTool(ask)]);
    const headless = context({
      invocation: "one_shot",
      userPresent: false,
      remote: false,
      scripted: true,
      embedding: "sdk",
    });

    expect(registry.definitions("plan", undefined, headless)).toEqual([]);

    await expect(registry.invoke({
      id: "question-1",
      name: "request_user_input",
      arguments: { question: "Continue?" },
    }, headless, new PermissionEngine("full_access"), deny)).rejects.toMatchObject({
      code: "tool_unavailable",
      message: "Tool request_user_input is unavailable in this host context",
    });
    expect(ask).not.toHaveBeenCalled();
  });

  it("rejects malformed requests, oversized answers, and cancellation", async () => {
    const oversized = new ToolRegistry([
      createRequestUserInputTool(async () => "x".repeat(MAX_USER_ANSWER_BYTES + 1)),
    ]);
    await expect(oversized.invoke({
      id: "question-1",
      name: "request_user_input",
      arguments: { question: "What next?", options: ["same", "SAME"] },
    }, context(), new PermissionEngine("full_access"), deny)).rejects.toMatchObject({
      code: "invalid_input",
      message: "options must be unique",
    });
    await expect(oversized.invoke({
      id: "question-2",
      name: "request_user_input",
      arguments: { question: "What next?" },
    }, context(), new PermissionEngine("full_access"), deny)).rejects.toMatchObject({
      code: "output_limit",
      message: `User answer exceeds ${MAX_USER_ANSWER_BYTES} bytes`,
    });

    const controller = new AbortController();
    const cancelled = new ToolRegistry([createRequestUserInputTool(async () => {
      controller.abort();
      throw new Error("private host failure");
    })]);
    await expect(cancelled.invoke({
      id: "question-3",
      name: "request_user_input",
      arguments: { question: "What next?" },
    }, context(undefined, controller.signal), new PermissionEngine("full_access"), deny))
      .rejects.toMatchObject({
        code: "cancelled",
        message: "User input was cancelled",
      });
  });
});
