import type { ToolCall, ToolDefinition } from "@recurs/contracts";

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
  type ToolSecurityProfile,
} from "./types.js";

type RegisteredTool = Tool<unknown>;

function eraseTool<Input>(tool: Tool<Input>): RegisteredTool {
  return {
    definition: tool.definition,
    executionClass: tool.executionClass,
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

async function executeTool(
  tool: RegisteredTool,
  name: string,
  input: unknown,
  context: ToolContext,
): Promise<ToolResult> {
  try {
    return await tool.execute(input, context);
  } catch (error) {
    if (error instanceof ToolError) {
      throw error;
    }
    throw new ToolError("execution_failed", `Tool ${name} failed`);
  }
}

export class ToolRegistry {
  readonly #tools = new Map<string, RegisteredTool>();
  readonly #checkpoints: CheckpointStore | undefined;
  readonly #securityProfile: ToolSecurityProfile;

  constructor(
    tools: readonly Tool<never>[] = [],
    options: {
      checkpoints?: CheckpointStore;
      securityProfile?: ToolSecurityProfile;
    } = {},
  ) {
    this.#checkpoints = options.checkpoints;
    this.#securityProfile = options.securityProfile ?? "local_guarded";
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
    if (this.#securityProfile === "tools_disabled") {
      return [];
    }
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
    if (this.#securityProfile === "tools_disabled") {
      throw new ToolError(
        "tool_unavailable",
        "Model tools are disabled for this runtime",
      );
    }
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
      );
    }

    let intents: ReturnType<RegisteredTool["permissions"]>;
    try {
      intents = tool.permissions(input, context);
    } catch (error) {
      if (error instanceof ToolError) {
        throw error;
      }
      throw new ToolError("execution_failed", `Tool ${call.name} failed`);
    }

    for (const intent of intents) {
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

    if (!tool.mutating || this.#checkpoints === undefined) {
      return executeTool(tool, call.name, input, context);
    }

    const checkpoint = await this.#checkpoints.captureBefore(
      context.sessionId,
      call.id,
      context.cwd,
    );
    let result: ToolResult;
    try {
      result = await executeTool(tool, call.name, input, context);
    } catch (error) {
      await this.#checkpoints.captureAfter(checkpoint, context.cwd);
      throw error;
    }
    const completed = await this.#checkpoints.captureAfter(
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
