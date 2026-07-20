import { describe, expect, it, vi } from "vitest";

import type { ToolCall } from "@recurs/providers";

import {
  type CheckpointStore,
  OwnedProcessManager,
  PermissionEngine,
  ToolError,
  ToolRegistry,
  createApplyPatchTool,
  createGitDiffTool,
  createGitStatusTool,
  createListFilesTool,
  createProcessSessionTool,
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
    const processes = new OwnedProcessManager();
    expect([
      createReadFileTool(),
      createListFilesTool(),
      createSearchTextTool(),
      createApplyPatchTool(),
      createGitStatusTool(),
      createGitDiffTool(),
      createRunCommandTool(),
      createProcessSessionTool(processes),
    ].map((tool) => [
      tool.definition.name,
      tool.executionClass,
      tool.parallelSafe === true,
    ])).toEqual([
      ["read_file", "in_process", true],
      ["list_files", "fixed_process", true],
      ["search_text", "fixed_process", true],
      ["apply_patch", "fixed_process", false],
      ["git_status", "fixed_process", true],
      ["git_diff", "fixed_process", true],
      ["run_command", "arbitrary_process", false],
      ["process_session", "arbitrary_process", false],
    ]);
  });

  it("admits only explicit, non-mutating, approval-free concurrent calls", () => {
    const safe: Tool<{ text: string }> = {
      ...textTool(),
      parallelSafe: true,
    };
    const dynamic: Tool<{ text: string }> = {
      ...safe,
      definition: { ...safe.definition, name: "dynamic" },
      isMutating: (input) => input.text === "write",
    };
    const approval: Tool<{ text: string }> = {
      ...safe,
      definition: { ...safe.definition, name: "external" },
      permissions: (input) => [{
        category: "external_path",
        resource: input.text,
        risk: "elevated",
      }],
    };
    const registry = new ToolRegistry([safe, dynamic, approval]);
    const permissions = new PermissionEngine("ask_always");

    expect(registry.canRunConcurrently(
      { id: "safe", name: "echo", arguments: { text: "read" } },
      context(),
      permissions,
    )).toBe(true);
    expect(registry.canRunConcurrently(
      { id: "write", name: "dynamic", arguments: { text: "write" } },
      context(),
      permissions,
    )).toBe(false);
    expect(registry.canRunConcurrently(
      { id: "approval", name: "external", arguments: { text: "/outside" } },
      context(),
      permissions,
    )).toBe(false);
    expect(registry.canRunConcurrently(
      { id: "invalid", name: "echo", arguments: { text: 42 } },
      context(),
      permissions,
    )).toBe(false);
    expect(new ToolRegistry([textTool()]).canRunConcurrently(
      { id: "implicit", name: "echo", arguments: { text: "read" } },
      context(),
      permissions,
    )).toBe(false);
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

  it("binds workspace sandbox network policy to approved intents", async () => {
    const observed: ToolContext["processSandbox"][] = [];
    const tool = textTool();
    tool.permissions = (input) => [{
      category: input.text === "network" ? "network" : "shell",
      resource: input.text,
      risk: "normal",
    }];
    tool.execute = async (input, executionContext) => {
      observed.push(executionContext.processSandbox);
      return { output: input.text };
    };
    const registry = new ToolRegistry([tool], {
      securityProfile: "workspace_sandboxed",
    });
    const permissions = new PermissionEngine("full_access");

    await registry.invoke(
      { id: "shell", name: "echo", arguments: { text: "shell" } },
      context(),
      permissions,
      deny,
    );
    await registry.invoke(
      { id: "network", name: "echo", arguments: { text: "network" } },
      context(),
      permissions,
      deny,
    );

    expect(observed).toEqual([
      { mode: "workspace", network: "deny" },
      { mode: "workspace", network: "allow" },
    ]);
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

  it("lets a self-managed mutating tool own its durable checkpoint boundary", async () => {
    const events: string[] = [];
    const tool = textTool(true);
    tool.checkpointOwnership = "self_managed";
    tool.preflight = async () => {
      events.push("preflight");
    };
    tool.execute = async (input) => {
      events.push("execute");
      return { output: input.text, metadata: { durable: true } };
    };
    const checkpoints = {
      captureBefore: vi.fn(),
      captureAfter: vi.fn(),
      undoLatest: vi.fn(),
    } as unknown as CheckpointStore;
    const approvals: ApprovalHandler = {
      request: vi.fn(async () => {
        events.push("approval");
        return "allow_once" as const;
      }),
    };
    const registry = new ToolRegistry([tool], { checkpoints });

    const result = await registry.invoke(
      { id: "self-managed", name: "write_text", arguments: { text: "src/a.ts" } },
      context(),
      new PermissionEngine("ask_always"),
      approvals,
    );

    expect(events).toEqual(["approval", "preflight", "execute"]);
    expect(checkpoints.captureBefore).not.toHaveBeenCalled();
    expect(checkpoints.captureAfter).not.toHaveBeenCalled();
    expect(result.metadata).toEqual({ durable: true });
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
