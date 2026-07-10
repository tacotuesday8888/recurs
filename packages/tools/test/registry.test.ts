import { describe, expect, it, vi } from "vitest";

import type { ToolCall } from "@recurs/providers";

import {
  PermissionEngine,
  ToolError,
  ToolRegistry,
  type ApprovalHandler,
  type Tool,
  type ToolContext,
} from "../src/index.js";

function context(executionMode: "act" | "plan" = "act"): ToolContext {
  return {
    sessionId: "session-1",
    cwd: "/workspace",
    signal: new AbortController().signal,
    executionMode,
    readRevisions: new Map(),
  };
}

function textTool(mutating = false): Tool<{ text: string }> {
  return {
    definition: {
      name: mutating ? "write_text" : "echo",
      description: "Return text",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
    },
    mutating,
    parse(input) {
      if (
        typeof input !== "object" ||
        input === null ||
        !("text" in input) ||
        typeof input.text !== "string"
      ) {
        throw new ToolError("invalid_input", "text must be a string");
      }
      return { text: input.text };
    },
    permissions(input) {
      return [
        {
          category: mutating ? "write" : "read",
          resource: input.text,
          risk: "normal",
        },
      ];
    },
    async execute(input) {
      return { output: input.text };
    },
  };
}

const deny: ApprovalHandler = {
  async request() {
    return "deny";
  },
};

describe("ToolRegistry", () => {
  it("rejects unknown tools before execution", async () => {
    const registry = new ToolRegistry([textTool()]);
    const call: ToolCall = { id: "1", name: "missing", arguments: {} };

    await expect(
      registry.invoke(
        call,
        context(),
        new PermissionEngine("approved_for_me"),
        deny,
      ),
    ).rejects.toMatchObject({ code: "unknown_tool" });
  });

  it("rejects invalid input before execution", async () => {
    const tool = textTool();
    const execute = vi.spyOn(tool, "execute");
    const registry = new ToolRegistry([tool]);

    await expect(
      registry.invoke(
        { id: "1", name: "echo", arguments: { text: 42 } },
        context(),
        new PermissionEngine("approved_for_me"),
        deny,
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("enforces Plan mode independently of the prompt", async () => {
    const tool = textTool(true);
    const execute = vi.spyOn(tool, "execute");
    const registry = new ToolRegistry([tool]);

    await expect(
      registry.invoke(
        { id: "1", name: "write_text", arguments: { text: "src/a.ts" } },
        context("plan"),
        new PermissionEngine("full_access"),
        deny,
      ),
    ).rejects.toMatchObject({ code: "plan_mode_denied" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("persists an approved action only for the current session engine", async () => {
    const approvals: ApprovalHandler = {
      request: vi.fn(async () => "allow_session" as const),
    };
    const engine = new PermissionEngine("ask_always");
    const registry = new ToolRegistry([textTool(true)]);
    const call: ToolCall = {
      id: "1",
      name: "write_text",
      arguments: { text: "src/a.ts" },
    };

    await registry.invoke(call, context(), engine, approvals);
    await registry.invoke({ ...call, id: "2" }, context(), engine, approvals);

    expect(approvals.request).toHaveBeenCalledTimes(1);
  });

  it("hides mutating definitions in Plan mode", () => {
    const registry = new ToolRegistry([textTool(), textTool(true)]);

    expect(registry.definitions("plan").map((tool) => tool.name)).toEqual([
      "echo",
    ]);
  });
});
