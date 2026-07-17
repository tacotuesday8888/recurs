import { describe, expect, it, vi } from "vitest";

import type { ToolCall } from "@recurs/providers";

import {
  type CheckpointStore,
  PermissionEngine,
  ToolError,
  ToolRegistry,
  createApplyPatchTool,
  createGitDiffTool,
  createGitStatusTool,
  createListFilesTool,
  createReadFileTool,
  createRunCommandTool,
  createSearchTextTool,
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
    executionClass: "in_process",
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
  it("records the actual execution class of every built-in tool", () => {
    expect([
      createReadFileTool(),
      createListFilesTool(),
      createSearchTextTool(),
      createApplyPatchTool(),
      createGitStatusTool(),
      createGitDiffTool(),
      createRunCommandTool(),
    ].map((tool) => [tool.definition.name, tool.executionClass])).toEqual([
      ["read_file", "in_process"],
      ["list_files", "fixed_process"],
      ["search_text", "fixed_process"],
      ["apply_patch", "fixed_process"],
      ["git_status", "fixed_process"],
      ["git_diff", "fixed_process"],
      ["run_command", "arbitrary_process"],
    ]);
  });

  it("tools_disabled advertises and executes no model tools", async () => {
    const tool = textTool(true);
    const parse = vi.spyOn(tool, "parse");
    const permissions = vi.spyOn(tool, "permissions");
    const execute = vi.spyOn(tool, "execute");
    const checkpoints = {
      captureBefore: vi.fn(),
      captureAfter: vi.fn(),
      undoLatest: vi.fn(),
    } as unknown as CheckpointStore;
    const approvals: ApprovalHandler = { request: vi.fn() };
    const registry = new ToolRegistry([tool], {
      checkpoints,
      securityProfile: "tools_disabled",
    });

    expect(registry.definitions("act")).toEqual([]);
    expect(registry.definitions("plan")).toEqual([]);
    await expect(
      registry.invoke(
        { id: "1", name: "write_text", arguments: { text: 42 } },
        context(),
        new PermissionEngine("ask_always"),
        approvals,
      ),
    ).rejects.toMatchObject({
      code: "tool_unavailable",
      message: "Model tools are disabled for this runtime",
    });
    expect(parse).not.toHaveBeenCalled();
    expect(permissions).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(approvals.request).not.toHaveBeenCalled();
    expect(checkpoints.captureBefore).not.toHaveBeenCalled();
    expect(checkpoints.captureAfter).not.toHaveBeenCalled();
  });

  it("snapshots the disabled profile at construction", () => {
    const options: {
      securityProfile: "local_guarded" | "tools_disabled";
    } = { securityProfile: "tools_disabled" };
    const registry = new ToolRegistry([textTool()], options);

    options.securityProfile = "local_guarded";

    expect(registry.definitions("act")).toEqual([]);
  });

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

  it("rejects denied intents before requesting any other approval", async () => {
    const tool = textTool();
    tool.permissions = () => [
      {
        category: "external_path",
        resource: "/outside/.env",
        risk: "elevated",
      },
      {
        category: "credential",
        resource: "/outside/.env",
        risk: "elevated",
      },
    ];
    const execute = vi.spyOn(tool, "execute");
    const approvals: ApprovalHandler = {
      request: vi.fn(async () => "allow_session" as const),
    };
    const registry = new ToolRegistry([tool]);

    await expect(
      registry.invoke(
        { id: "1", name: "echo", arguments: { text: "/outside/.env" } },
        context(),
        new PermissionEngine("full_access"),
        approvals,
      ),
    ).rejects.toMatchObject({
      code: "permission_denied",
      message: "Permission denied for credential: /outside/.env",
    });
    expect(approvals.request).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("normalizes unknown tool implementation failures before they escape", async () => {
    const canary = "RECURS_UNKNOWN_TOOL_CANARY";
    const tool = textTool();
    tool.execute = async () => {
      throw new Error(canary, { cause: new Error("RECURS_TOOL_CAUSE_CANARY") });
    };
    const registry = new ToolRegistry([tool]);

    let thrown: unknown;
    try {
      await registry.invoke(
        { id: "1", name: "echo", arguments: { text: "safe" } },
        context(),
        new PermissionEngine("full_access"),
        deny,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ToolError);
    expect(thrown).toMatchObject({
      code: "execution_failed",
      message: "Tool echo failed",
    });
    expect((thrown as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(String((thrown as Error).message)).not.toContain(canary);
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

  it("asks again after an allow-once approval", async () => {
    const approvals: ApprovalHandler = {
      request: vi.fn(async () => "allow_once" as const),
    };
    const registry = new ToolRegistry([textTool(true)]);
    const engine = new PermissionEngine("ask_always");
    const call: ToolCall = {
      id: "1",
      name: "write_text",
      arguments: { text: "src/a.ts" },
    };

    await registry.invoke(call, context(), engine, approvals);
    await registry.invoke({ ...call, id: "2" }, context(), engine, approvals);

    expect(approvals.request).toHaveBeenCalledTimes(2);
  });

  it("runs preflight after approval and before checkpoint capture", async () => {
    const events: string[] = [];
    const tool = textTool(true);
    tool.preflight = async () => {
      events.push("preflight");
    };
    const checkpoint = {
      id: "checkpoint-1",
      sessionId: "session-1",
      toolCallId: "1",
      before: {},
    };
    const checkpoints = {
      captureBefore: vi.fn(async () => {
        events.push("captureBefore");
        return checkpoint;
      }),
      captureAfter: vi.fn(async () => {
        events.push("captureAfter");
        return { ...checkpoint, after: {} };
      }),
      undoLatest: vi.fn(),
    } as unknown as CheckpointStore;
    const execute = vi.spyOn(tool, "execute").mockImplementation(async (input) => {
      events.push("execute");
      return { output: input.text };
    });
    const approvals: ApprovalHandler = {
      request: vi.fn(async () => {
        events.push("approval");
        return "allow_once" as const;
      }),
    };
    const registry = new ToolRegistry([tool], { checkpoints });

    await registry.invoke(
      { id: "1", name: "write_text", arguments: { text: "src/a.ts" } },
      context(),
      new PermissionEngine("ask_always"),
      approvals,
    );

    expect(events).toEqual([
      "approval",
      "preflight",
      "captureBefore",
      "execute",
      "captureAfter",
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not checkpoint or execute when preflight rejects", async () => {
    const tool = textTool(true);
    tool.preflight = async () => {
      throw new ToolError("permission_denied", "canonical target denied");
    };
    const execute = vi.spyOn(tool, "execute");
    const checkpoints = {
      captureBefore: vi.fn(),
      captureAfter: vi.fn(),
      undoLatest: vi.fn(),
    } as unknown as CheckpointStore;
    const registry = new ToolRegistry([tool], { checkpoints });

    await expect(
      registry.invoke(
        { id: "1", name: "write_text", arguments: { text: "src/a.ts" } },
        context(),
        new PermissionEngine("full_access"),
        deny,
      ),
    ).rejects.toMatchObject({ code: "permission_denied" });

    expect(checkpoints.captureBefore).not.toHaveBeenCalled();
    expect(checkpoints.captureAfter).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("hides mutating definitions in Plan mode", () => {
    const registry = new ToolRegistry([textTool(), textTool(true)]);

    expect(registry.definitions("plan").map((tool) => tool.name)).toEqual([
      "echo",
    ]);
  });

  it("enforces a host-derived read-only allowlist in definitions and invocation", async () => {
    const read = textTool();
    const write = textTool(true);
    const executeWrite = vi.spyOn(write, "execute");
    const registry = new ToolRegistry([read, write]);
    const toolPolicy = {
      readOnly: true,
      evidenceFromSources: true,
      allowedNames: ["echo", "write_text"],
      allowedCategories: ["read"],
      maxRisk: "normal",
    } as const;

    expect(registry.definitions("act", toolPolicy).map((tool) => tool.name))
      .toEqual(["echo"]);
    await expect(registry.invoke(
      { id: "policy-write", name: "write_text", arguments: { text: "x" } },
      { ...context(), toolPolicy },
      new PermissionEngine("full_access"),
      deny,
    )).rejects.toMatchObject({
      code: "tool_unavailable",
      message: "Tool write_text is unavailable to this agent profile",
    });
    expect(executeWrite).not.toHaveBeenCalled();
  });

  it("rejects tools outside an agent profile allowlist before parsing", async () => {
    const tool = textTool();
    const parse = vi.spyOn(tool, "parse");
    const registry = new ToolRegistry([tool]);
    const toolPolicy = {
      readOnly: true,
      evidenceFromSources: true,
      allowedNames: [],
      allowedCategories: ["read"],
      maxRisk: "normal",
    } as const;

    expect(registry.definitions("plan", toolPolicy)).toEqual([]);
    await expect(registry.invoke(
      { id: "policy-hidden", name: "echo", arguments: { text: 42 } },
      { ...context("plan"), toolPolicy },
      new PermissionEngine("full_access"),
      deny,
    )).rejects.toMatchObject({ code: "tool_unavailable" });
    expect(parse).not.toHaveBeenCalled();
  });

  it("promotes source traces to evidence only for profiles that request it", async () => {
    const tool = textTool();
    tool.execute = async (input) => ({
      output: input.text,
      metadata: { sources: ["read src/a.ts:1-3"] },
    });
    const registry = new ToolRegistry([tool]);
    const call = { id: "source", name: "echo", arguments: { text: "ok" } };

    const rootResult = await registry.invoke(
      call,
      context(),
      new PermissionEngine("full_access"),
      deny,
    );
    const exploreResult = await registry.invoke(
      { ...call, id: "explore-source" },
      {
        ...context("plan"),
        toolPolicy: {
          readOnly: true,
          evidenceFromSources: true,
          allowedNames: ["echo"],
          allowedCategories: ["read"],
          maxRisk: "normal",
        },
      },
      new PermissionEngine("full_access"),
      deny,
    );

    expect(rootResult.metadata).toEqual({ sources: ["read src/a.ts:1-3"] });
    expect(exploreResult.metadata).toEqual({
      sources: ["read src/a.ts:1-3"],
      evidence: ["read src/a.ts:1-3"],
    });
  });

  it("uses input-dependent mutation for Plan denial and checkpoint capture", async () => {
    const tool = textTool();
    const dynamic = tool as typeof tool & {
      isMutating(input: { text: string }, context: ToolContext): boolean;
    };
    dynamic.isMutating = (input) => input.text.startsWith("write:");
    const checkpoint = {
      id: "dynamic-checkpoint",
      sessionId: "session-1",
      toolCallId: "dynamic-act",
      before: {},
    };
    const checkpoints = {
      captureBefore: vi.fn(async () => checkpoint),
      captureAfter: vi.fn(async () => ({ ...checkpoint, after: {} })),
      undoLatest: vi.fn(),
    } as unknown as CheckpointStore;
    const registry = new ToolRegistry([dynamic], { checkpoints });

    expect(registry.definitions("plan").map((definition) => definition.name))
      .toEqual(["echo"]);
    await expect(registry.invoke(
      { id: "dynamic-plan", name: "echo", arguments: { text: "write:file" } },
      context("plan"),
      new PermissionEngine("full_access"),
      deny,
    )).rejects.toMatchObject({ code: "plan_mode_denied" });
    const result = await registry.invoke(
      { id: "dynamic-act", name: "echo", arguments: { text: "write:file" } },
      context("act"),
      new PermissionEngine("full_access"),
      deny,
    );

    expect(checkpoints.captureBefore).toHaveBeenCalledTimes(1);
    expect(checkpoints.captureAfter).toHaveBeenCalledTimes(1);
    expect(result.metadata).toMatchObject({ checkpointId: "dynamic-checkpoint" });
  });

  it("denies profile-disallowed intent categories and risk before approval", async () => {
    const tool = textTool();
    tool.permissions = () => [
      { category: "shell", resource: "npm test", risk: "normal" },
      { category: "read", resource: ".", risk: "destructive" },
    ];
    const execute = vi.spyOn(tool, "execute");
    const approvals: ApprovalHandler = { request: vi.fn() };
    const registry = new ToolRegistry([tool]);

    await expect(registry.invoke(
      { id: "intent-policy", name: "echo", arguments: { text: "inspect" } },
      {
        ...context(),
        toolPolicy: {
          readOnly: false,
          evidenceFromSources: true,
          allowedNames: ["echo"],
          allowedCategories: ["read"],
          maxRisk: "elevated",
        },
      },
      new PermissionEngine("full_access"),
      approvals,
    )).rejects.toMatchObject({
      code: "permission_denied",
      message: "Agent profile denied shell access to npm test",
    });
    expect(approvals.request).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
