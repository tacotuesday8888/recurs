import {
  COMPANY_ROLE_IDS,
  parseCompanyBlueprintBinding,
  type CompanyBlueprintV1,
  type CompanyRoleId,
} from "@recurs/contracts";
import { ToolError, type Tool, type ToolContext } from "@recurs/tools";

import type {
  ChildAgentManager,
  ChildDelegationResult,
} from "./child-agent-manager.js";
import type { FileCompanyBlueprintStore } from "./file-company-blueprint-store.js";
import type { JsonlSessionStore } from "./jsonl-session-store.js";
import { isPinnedSessionState } from "./session-v2.js";

export interface DelegateCompanyTaskInput {
  readonly role: CompanyRoleId;
  readonly description: string;
  readonly prompt: string;
}

export interface CompanyAgentManagerDependencies {
  readonly sessions: Pick<JsonlSessionStore, "loadState">;
  readonly blueprints: Pick<FileCompanyBlueprintStore, "load">;
  readonly children: Pick<ChildAgentManager, "delegate">;
}

const roleIds = new Set<string>(COMPANY_ROLE_IDS);
const MAX_DESCRIPTION_LENGTH = 256;
const MAX_PROMPT_LENGTH = 32_768;

function exactInput(value: unknown): DelegateCompanyTaskInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ToolError("invalid_input", "delegate_company_task expects an object");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(",") !== "description,prompt,role" ||
    typeof input.role !== "string" || !roleIds.has(input.role) ||
    typeof input.description !== "string" || typeof input.prompt !== "string") {
    throw new ToolError(
      "invalid_input",
      "delegate_company_task requires exactly role, description, and prompt",
    );
  }
  const description = input.description.trim();
  const prompt = input.prompt.trim();
  if (description.length === 0 || description.length > MAX_DESCRIPTION_LENGTH ||
    prompt.length === 0 || prompt.length > MAX_PROMPT_LENGTH) {
    throw new ToolError(
      "invalid_input",
      "delegate_company_task input is empty or too large",
    );
  }
  return { role: input.role as CompanyRoleId, description, prompt };
}

function scopedPrompt(
  blueprint: CompanyBlueprintV1,
  role: CompanyBlueprintV1["roles"][number],
  prompt: string,
): string {
  return [
    `You are the approved Recurs company role: ${role.displayName}.`,
    `Responsibility: ${role.responsibility}`,
    role.instructions,
    `Company initial goal: ${blueprint.initialGoal}`,
    "Complete only this bounded handoff and return concrete evidence:",
    prompt,
  ].join("\n\n");
}

export class CompanyAgentManager {
  constructor(private readonly dependencies: CompanyAgentManagerDependencies) {}

  createTool(): Tool<DelegateCompanyTaskInput> {
    return {
      definition: {
        name: "delegate_company_task",
        description: [
          "Delegate one bounded handoff to an approved role in the active Recurs company blueprint.",
          "The role, profile, model backend, permissions, and spend remain constrained by the durable parent session and operating mode.",
        ].join(" "),
        inputSchema: {
          type: "object",
          properties: {
            role: { type: "string", enum: [...COMPANY_ROLE_IDS] },
            description: { type: "string" },
            prompt: { type: "string" },
          },
          required: ["role", "description", "prompt"],
          additionalProperties: false,
        },
      },
      executionClass: "in_process",
      mutating: false,
      isMutating: (input) => input.role === "scoped_builder_v1",
      parse: exactInput,
      permissions() { return []; },
      execute: (input, context) => this.delegate(input, context),
    };
  }

  async delegate(
    input: DelegateCompanyTaskInput,
    context: ToolContext,
  ): Promise<ChildDelegationResult> {
    const parent = await this.dependencies.sessions.loadState(context.sessionId);
    if (!isPinnedSessionState(parent) || parent.agent.role !== "parent" ||
      parent.cwd !== context.cwd || parent.agent.company === undefined ||
      parent.agent.company.roleId !== "orchestrator_v1") {
      throw new ToolError("tool_unavailable", "No approved company is active");
    }
    const blueprint = await this.dependencies.blueprints.load(
      parent.agent.company.blueprintId,
      context.signal,
    );
    if (blueprint.state !== "approved" ||
      blueprint.version !== parent.agent.company.blueprintVersion ||
      blueprint.authority.operatingModeId !== parent.agent.operatingMode.id ||
      blueprint.authority.operatingModeVersion !== parent.agent.operatingMode.version ||
      blueprint.authority.permissionMode !== parent.permissionMode) {
      throw new ToolError(
        "permission_denied",
        "The company blueprint no longer matches the live parent authority",
      );
    }
    const role = blueprint.roles.find((candidate) => candidate.id === input.role);
    if (role?.executionProfileId === null || role === undefined) {
      throw new ToolError(
        "permission_denied",
        "The requested company role is not an approved executable role",
      );
    }
    const company = parseCompanyBlueprintBinding({
      blueprintId: blueprint.id,
      blueprintVersion: blueprint.version,
      roleId: role.id,
      roleVersion: role.version,
    });
    return this.dependencies.children.delegate({
      profile: role.executionProfileId,
      description: input.description,
      prompt: scopedPrompt(blueprint, role, input.prompt),
    }, context, { company });
  }
}
