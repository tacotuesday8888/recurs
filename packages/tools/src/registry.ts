import type { ToolCall, ToolDefinition } from "@recurs/providers";

import {
  permissionIntentKey,
  type PermissionEngine,
} from "./permissions.js";
import type { CheckpointStore } from "./checkpoints.js";
import {
  ToolError,
  type ApprovalHandler,
  type ExecutionMode,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "./types.js";

type RegisteredTool = Tool<unknown>;

function eraseTool<Input>(tool: Tool<Input>): RegisteredTool {
  return {
    definition: tool.definition,
    mutating: tool.mutating,
    parse(input) {
      return tool.parse(input);
    },
    permissions(input, context) {
      return tool.permissions(input as Input, context);
    },
    execute(input, context) {
      return tool.execute(input as Input, context);
    },
  };
}

export class ToolRegistry {
  readonly #tools = new Map<string, RegisteredTool>();

  constructor(
    tools: readonly Tool<never>[] = [],
    private readonly options: { checkpoints?: CheckpointStore } = {},
  ) {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  register<Input>(tool: Tool<Input>): void {
    const name = tool.definition.name;
    if (this.#tools.has(name)) {
      throw new ToolError("duplicate_tool", `Tool is already registered: ${name}`);
    }
    this.#tools.set(name, eraseTool(tool));
  }

  definitions(executionMode: ExecutionMode): ToolDefinition[] {
    return [...this.#tools.values()]
      .filter((tool) => executionMode === "act" || !tool.mutating)
      .map((tool) => tool.definition);
  }

  async invoke(
    call: ToolCall,
    context: ToolContext,
    permissions: PermissionEngine,
    approvals: ApprovalHandler,
  ): Promise<ToolResult> {
    const tool = this.#tools.get(call.name);
    if (tool === undefined) {
      throw new ToolError("unknown_tool", `Unknown tool: ${call.name}`);
    }

    if (context.executionMode === "plan" && tool.mutating) {
      throw new ToolError(
        "plan_mode_denied",
        `Tool ${call.name} is unavailable in Plan mode`,
      );
    }

    if (context.signal.aborted) {
      throw new ToolError("cancelled", `Tool ${call.name} was cancelled`);
    }

    let input: unknown;
    try {
      input = tool.parse(call.arguments);
    } catch (error) {
      if (error instanceof ToolError) {
        throw error;
      }
      throw new ToolError(
        "invalid_input",
        `Invalid input for tool ${call.name}`,
        { cause: error },
      );
    }

    for (const intent of tool.permissions(input, context)) {
      const decision = permissions.evaluate(intent);
      if (decision === "deny") {
        throw new ToolError(
          "permission_denied",
          `Permission denied for ${intent.category}: ${intent.resource}`,
        );
      }
      if (decision === "allow") {
        (context.approvedIntents ??= new Set()).add(permissionIntentKey(intent));
        continue;
      }

      const response = await approvals.request(intent);
      if (response === "deny") {
        throw new ToolError(
          "permission_denied",
          `Permission denied for ${intent.category}: ${intent.resource}`,
        );
      }
      if (response === "allow_session") {
        permissions.grantForSession(intent);
      }
      (context.approvedIntents ??= new Set()).add(permissionIntentKey(intent));
    }

    if (!tool.mutating || this.options.checkpoints === undefined) {
      return tool.execute(input, context);
    }

    const checkpoint = await this.options.checkpoints.captureBefore(
      context.sessionId,
      call.id,
      context.cwd,
    );
    let result: ToolResult;
    try {
      result = await tool.execute(input, context);
    } catch (error) {
      await this.options.checkpoints.captureAfter(checkpoint, context.cwd);
      throw error;
    }
    const completed = await this.options.checkpoints.captureAfter(
      checkpoint,
      context.cwd,
    );
    return {
      ...result,
      metadata: {
        ...result.metadata,
        checkpointId: completed.id,
      },
    };
  }
}
