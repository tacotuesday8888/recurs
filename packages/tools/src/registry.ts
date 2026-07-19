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
  type ToolPolicy,
  type PermissionRisk,
  type ToolSecurityProfile,
} from "./types.js";

type RegisteredTool = Tool<unknown>;

function eraseTool<Input>(tool: Tool<Input>): RegisteredTool {
  const preflight = tool.preflight?.bind(tool);
  const isMutating = tool.isMutating?.bind(tool);
  return {
    definition: tool.definition,
    executionClass: tool.executionClass,
    mutating: tool.mutating,
    parallelSafe: tool.parallelSafe ?? false,
    checkpointOwnership: tool.checkpointOwnership ?? "registry",
    ...(isMutating === undefined
      ? {}
      : {
          isMutating(input: unknown, context: ToolContext) {
            return isMutating(input as Input, context);
          },
        }),
    parse(input) {
      return tool.parse(input);
    },
    permissions(input, context) {
      return tool.permissions(input as Input, context);
    },
    ...(preflight === undefined
      ? {}
      : {
          preflight(input: unknown, context: ToolContext) {
            return preflight(input as Input, context);
          },
        }),
    execute(input, context) {
      return tool.execute(input as Input, context);
    },
  };
}

const PERMISSION_RISK_RANK = Object.freeze({
  normal: 0,
  elevated: 1,
  destructive: 2,
} satisfies Record<
  PermissionRisk,
  number
>);

function profileAllowsIntent(
  policy: ToolPolicy,
  intent: ReturnType<RegisteredTool["permissions"]>[number],
): boolean {
  return policy.allowedCategories.includes(intent.category) &&
    PERMISSION_RISK_RANK[intent.risk] <= PERMISSION_RISK_RANK[policy.maxRisk];
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

function sandboxedContext(
  profile: ToolSecurityProfile,
  context: ToolContext,
  intents: readonly { readonly category: string }[],
): ToolContext {
  if (profile !== "workspace_sandboxed") return context;
  return {
    ...context,
    processSandbox: {
      mode: "workspace",
      network: intents.some((intent) => intent.category === "network")
        ? "allow"
        : "deny",
    },
  };
}

async function preflightTool(
  tool: RegisteredTool,
  name: string,
  input: unknown,
  context: ToolContext,
): Promise<void> {
  if (tool.preflight === undefined) {
    return;
  }
  try {
    await tool.preflight(input, context);
  } catch (error) {
    if (error instanceof ToolError) {
      throw error;
    }
    throw new ToolError("execution_failed", `Tool ${name} failed`);
  }
}

function applyToolPolicyMetadata(
  result: ToolResult,
  policy: ToolPolicy | undefined,
): ToolResult {
  if (!policy?.evidenceFromSources || result.metadata === undefined) {
    return result;
  }
  const sources = Array.isArray(result.metadata.sources)
    ? result.metadata.sources.filter(
        (source): source is string => typeof source === "string",
      )
    : [];
  if (sources.length === 0) {
    return result;
  }
  const current = Array.isArray(result.metadata.evidence)
    ? result.metadata.evidence.filter(
        (item): item is string => typeof item === "string",
      )
    : [];
  return {
    ...result,
    metadata: {
      ...result.metadata,
      evidence: [...new Set([...current, ...sources])],
    },
  };
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

  definitions(
    executionMode: ExecutionMode,
    policy?: ToolPolicy,
  ): ToolDefinition[] {
    if (this.#securityProfile === "tools_disabled") {
      return [];
    }
    return [...this.#tools.values()]
      .filter((tool) =>
        (executionMode === "act" || !tool.mutating) &&
        (policy === undefined ||
          (policy.allowedNames.includes(tool.definition.name) &&
            (!policy.readOnly || !tool.mutating)))
      )
      .map((tool) => tool.definition);
  }

  canRunConcurrently(
    call: ToolCall,
    context: ToolContext,
    permissions: PermissionEngine,
  ): boolean {
    if (this.#securityProfile === "tools_disabled" || context.signal.aborted) {
      return false;
    }
    const tool = this.#tools.get(call.name);
    if (tool?.parallelSafe !== true) {
      return false;
    }
    if (
      context.toolPolicy !== undefined &&
      !context.toolPolicy.allowedNames.includes(call.name)
    ) {
      return false;
    }

    try {
      const input = tool.parse(call.arguments);
      const mutating = tool.mutating ||
        (tool.isMutating?.(input, context) ?? false);
      if (mutating) {
        return false;
      }
      const intents = tool.permissions(input, context);
      return intents.every((intent) =>
        (context.toolPolicy === undefined ||
          profileAllowsIntent(context.toolPolicy, intent)) &&
        permissions.evaluate(intent) === "allow"
      );
    } catch {
      // Normal invocation owns canonical parsing and failure reporting.
      return false;
    }
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

    if (
      context.toolPolicy !== undefined &&
      !context.toolPolicy.allowedNames.includes(call.name)
    ) {
      throw new ToolError(
        "tool_unavailable",
        `Tool ${call.name} is unavailable to this agent profile`,
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

    let mutating: boolean;
    try {
      mutating = tool.mutating || (tool.isMutating?.(input, context) ?? false);
    } catch (error) {
      if (error instanceof ToolError) {
        throw error;
      }
      throw new ToolError("execution_failed", `Tool ${call.name} failed`);
    }

    if (context.toolPolicy?.readOnly === true && mutating) {
      throw new ToolError(
        "tool_unavailable",
        `Tool ${call.name} is unavailable to this agent profile`,
      );
    }

    if (context.executionMode === "plan" && mutating) {
      throw new ToolError(
        "plan_mode_denied",
        `Tool ${call.name} is unavailable in Plan mode`,
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

    if (context.toolPolicy !== undefined) {
      for (const intent of intents) {
        if (!profileAllowsIntent(context.toolPolicy, intent)) {
          throw new ToolError(
            "permission_denied",
            `Agent profile denied ${intent.category} access to ${intent.resource}`,
          );
        }
      }
    }

    for (const intent of intents) {
      if (permissions.evaluate(intent) === "deny") {
        throw new ToolError(
          "permission_denied",
          `Permission denied for ${intent.category}: ${intent.resource}`,
        );
      }
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

    const executionContext = sandboxedContext(
      this.#securityProfile,
      context,
      intents,
    );
    await preflightTool(tool, call.name, input, executionContext);

    if (
      !mutating ||
      this.#checkpoints === undefined ||
      tool.checkpointOwnership === "self_managed"
    ) {
      return applyToolPolicyMetadata(
        await executeTool(tool, call.name, input, executionContext),
        context.toolPolicy,
      );
    }

    const checkpoint = await this.#checkpoints.captureBefore(
      context.sessionId,
      call.id,
      context.cwd,
    );
    let result: ToolResult;
    try {
      result = await executeTool(tool, call.name, input, executionContext);
    } catch (error) {
      await this.#checkpoints.captureAfter(checkpoint, context.cwd);
      throw error;
    }
    const completed = await this.#checkpoints.captureAfter(
      checkpoint,
      context.cwd,
    );
    const withPolicyMetadata = applyToolPolicyMetadata(
      result,
      context.toolPolicy,
    );
    return {
      ...withPolicyMetadata,
      metadata: {
        ...withPolicyMetadata.metadata,
        checkpointId: completed.id,
      },
    };
  }
}
