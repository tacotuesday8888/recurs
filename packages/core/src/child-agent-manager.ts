import { randomUUID } from "node:crypto";

import {
  createHostInvocation,
  getAgentProfilePolicy,
  getOperatingModePolicy,
  narrowAgentPermissionMode,
  parseAgentProfileId,
  type AgentGitWorktreeWorkspace,
  type AgentProfileId,
  type HostInvocation,
  type IntegrationFailure,
  type OperatingModeId,
  type ProviderUsage,
  type RunCoordinator,
  type TrustedRunContext,
} from "@recurs/contracts";
import {
  ToolError,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "@recurs/tools";

import type {
  AgentWorkflowUsage,
  RecursEvent,
} from "./events.js";
import {
  isPinnedSessionState,
  type PinnedSessionState,
} from "./session-v2.js";
import type { JsonlSessionStore } from "./jsonl-session-store.js";
import {
  childRequestAllowance,
  delegationWorkflowUsage,
  isDelegationBudgetForAgent,
  scopeAgentPrompt,
} from "./agent-profile.js";

export interface DelegateTaskInput {
  readonly profile: AgentProfileId;
  readonly description: string;
  readonly prompt: string;
}

export interface ChildDelegationOptions {
  readonly cwd: string;
  readonly workspace: AgentGitWorktreeWorkspace;
  readonly batch?: {
    readonly id: string;
    readonly index: number;
  };
}

export interface ChildDelegationMetadata extends Record<string, unknown> {
  readonly childAgentId: string;
  readonly childSessionId: string;
  readonly taskId: string;
  readonly attempts: 1;
  readonly retries: 0;
  readonly operatingModeId: OperatingModeId;
  readonly profileId: AgentProfileId;
  readonly usage: ProviderUsage | null;
  readonly usageSource: "provider" | "runtime" | "unavailable";
  readonly changedFiles: readonly string[];
  readonly evidence: readonly string[];
  readonly costLimitUsd: number;
  readonly costLimitExceeded: boolean;
  readonly workflow: AgentWorkflowUsage;
  readonly workspace?: AgentGitWorktreeWorkspace;
  readonly batchId?: string;
  readonly batchIndex?: number;
}

export interface ChildDelegationResult extends ToolResult {
  readonly metadata: ChildDelegationMetadata;
}

export interface ChildAgentManagerDependencies {
  readonly sessions: JsonlSessionStore;
  getCoordinator(): RunCoordinator | null | undefined;
  emit(event: RecursEvent): Promise<void>;
  readonly createId?: () => string;
  readonly now?: () => string;
}

const MAX_DESCRIPTION_LENGTH = 256;
const MAX_PROMPT_LENGTH = 32_768;

function exactInput(value: unknown): DelegateTaskInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ToolError("invalid_input", "delegate_task expects an object");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "description,profile,prompt" ||
    typeof record.profile !== "string" ||
    typeof record.description !== "string" ||
    typeof record.prompt !== "string"
  ) {
    throw new ToolError(
      "invalid_input",
      "delegate_task requires exactly profile, description, and prompt",
    );
  }
  const profile = parseAgentProfileId(record.profile);
  if (profile === null) {
    throw new ToolError("invalid_input", "Unknown agent profile");
  }
  const description = record.description.trim();
  const prompt = record.prompt.trim();
  if (
    description.length === 0 || description.length > MAX_DESCRIPTION_LENGTH ||
    prompt.length === 0 || prompt.length > MAX_PROMPT_LENGTH
  ) {
    throw new ToolError("invalid_input", "delegate_task input is empty or too large");
  }
  return { profile, description, prompt };
}

function invocationFromContext(context: TrustedRunContext): HostInvocation {
  return createHostInvocation({
    invocation: context.invocation,
    userPresent: context.presence === "present",
    remote: context.location === "remote",
    scripted: context.automation === "scripted",
    embedding: context.embedding,
  });
}

function cancelled(failure: IntegrationFailure): boolean {
  return failure.code === "cancelled";
}

export class ChildAgentManager {
  readonly #createId: () => string;
  readonly #now: () => string;
  readonly #activeChildren = new Map<string, Set<string>>();

  constructor(private readonly dependencies: ChildAgentManagerDependencies) {
    this.#createId = dependencies.createId ?? randomUUID;
    this.#now = dependencies.now ?? (() => new Date().toISOString());
  }

  createTool(): Tool<DelegateTaskInput> {
    return {
      definition: {
        name: "delegate_task",
        description: [
          "Create one bounded Recurs child with an exact Explore, Implement, or Review profile.",
          "The child inherits this session's pinned backend, model, operating mode, and permission ceiling.",
          "Use Explore for evidence, Implement for a scoped change, and Review for independent inspection and fixed verification.",
        ].join(" "),
        inputSchema: {
          type: "object",
          properties: {
            profile: {
              type: "string",
              enum: [
                "explore", "implement", "review",
                "explore_v1", "implement_v1", "review_v1",
              ],
            },
            description: { type: "string" },
            prompt: { type: "string" },
          },
          required: ["profile", "description", "prompt"],
          additionalProperties: false,
        },
      },
      executionClass: "in_process",
      mutating: false,
      isMutating(input) {
        return !getAgentProfilePolicy(input.profile).tools.readOnly;
      },
      parse: exactInput,
      permissions() {
        return [];
      },
      execute: (input, context) => this.delegate(input, context),
    };
  }

  async #parent(context: ToolContext): Promise<PinnedSessionState> {
    const state = await this.dependencies.sessions.loadState(context.sessionId);
    if (!isPinnedSessionState(state) || state.cwd !== context.cwd) {
      throw new ToolError("tool_unavailable", "Parent agent session is unavailable");
    }
    return state;
  }

  #claim(parent: PinnedSessionState, childSessionId: string): () => void {
    const active = this.#activeChildren.get(parent.agent.id) ?? new Set<string>();
    if (active.size >= parent.agent.limits.maxConcurrentChildren) {
      throw new ToolError(
        "permission_denied",
        `Agent concurrency limit reached (${parent.agent.limits.maxConcurrentChildren})`,
      );
    }
    active.add(childSessionId);
    this.#activeChildren.set(parent.agent.id, active);
    return () => {
      active.delete(childSessionId);
      if (active.size === 0) this.#activeChildren.delete(parent.agent.id);
    };
  }

  async #persistPreflightTerminal(
    childSessionId: string,
    failure: IntegrationFailure,
  ): Promise<void> {
    const state = await this.dependencies.sessions.loadState(childSessionId);
    if (!isPinnedSessionState(state) || state.agentLifecycle.status !== "ready") {
      return;
    }
    await this.dependencies.sessions.withSessionMutation(
      childSessionId,
      state.lastSequence,
      async (lease) => {
        if (cancelled(failure)) {
          await lease.append({
            type: "agent_run_cancelled",
            reason: failure.safeMessage,
            at: this.#now(),
          });
        } else {
          await lease.append({
            type: "agent_run_failed",
            failure,
            at: this.#now(),
          });
        }
      },
    );
  }

  async #prepare(
    input: DelegateTaskInput,
    context: ToolContext,
    options?: ChildDelegationOptions,
  ) {
    if (context.signal.aborted) {
      throw new ToolError("cancelled", "Child delegation was cancelled");
    }
    const parent = await this.#parent(context);
    const childCwd = options?.cwd ?? parent.cwd;
    if (options !== undefined && (
      options.workspace.repositoryRoot !== parent.cwd ||
      options.workspace.worktreeRoot !== childCwd
    )) {
      throw new ToolError(
        "tool_unavailable",
        "Trusted child workspace is invalid",
      );
    }
    const mode = getOperatingModePolicy(parent.agent.operatingMode.id);
    const profile = getAgentProfilePolicy(input.profile);
    if (profile.executionMode === "act" && context.executionMode !== "act") {
      throw new ToolError(
        "plan_mode_denied",
        `${profile.displayName} children require an Act parent`,
      );
    }
    const childDepth = parent.agent.depth + 1;
    if (childDepth > mode.orchestration.maxDepth) {
      throw new ToolError(
        "permission_denied",
        `Agent depth limit reached (${mode.orchestration.maxDepth})`,
      );
    }
    if (context.runContext === undefined) {
      throw new ToolError("tool_unavailable", "Trusted run context is unavailable");
    }
    const coordinator = this.dependencies.getCoordinator();
    if (coordinator === null || coordinator === undefined) {
      throw new ToolError("tool_unavailable", "Child execution engine is unavailable");
    }
    const budget = context.delegationBudget;
    if (budget === undefined ||
      !isDelegationBudgetForAgent(budget, parent.agent)) {
      throw new ToolError("tool_unavailable", "Trusted delegation budget is unavailable");
    }
    if (budget.childrenStarted >= budget.maxChildren) {
      throw new ToolError(
        "permission_denied",
        `Agent child limit reached (${budget.maxChildren})`,
      );
    }
    if (budget.reportedCostUsd >= budget.maxReportedCostUsd) {
      throw new ToolError(
        "permission_denied",
        `Agent reported-cost limit reached ($${budget.maxReportedCostUsd})`,
      );
    }
    const childRequestLimit = childRequestAllowance(parent.agent);
    if (budget.requestsReserved + childRequestLimit > budget.maxRequests) {
      throw new ToolError(
        "permission_denied",
        `Agent request limit reached (${budget.maxRequests})`,
      );
    }
    return {
      parent,
      mode,
      profile,
      childDepth,
      coordinator,
      budget,
      childRequestLimit,
      childCwd,
      runContext: context.runContext,
    };
  }

  async preflight(
    input: DelegateTaskInput,
    context: ToolContext,
  ): Promise<void> {
    await this.#prepare(input, context);
  }

  async delegate(
    input: DelegateTaskInput,
    context: ToolContext,
    options?: ChildDelegationOptions,
  ): Promise<ChildDelegationResult> {
    const {
      parent,
      mode,
      profile,
      childDepth,
      coordinator,
      budget,
      childRequestLimit,
      childCwd,
      runContext,
    } = await this.#prepare(input, context, options);

    const childSessionId = this.#createId();
    const childAgentId = this.#createId();
    const taskId = this.#createId();
    const release = this.#claim(parent, childSessionId);
    budget.childrenStarted += 1;
    budget.requestsReserved += childRequestLimit;
    const permissionMode = narrowAgentPermissionMode(
      parent.permissionMode,
      parent.permissionMode,
    );
    try {
      const child = await this.dependencies.sessions.createPinnedSession({
        id: childSessionId,
        cwd: childCwd,
        backend: parent.backend.pin,
        at: this.#now(),
        agent: {
          id: childAgentId,
          role: "child",
          profile: { id: profile.id, version: profile.version },
          parentAgentId: parent.agent.id,
          parentSessionId: parent.id,
          depth: childDepth,
          task: { id: taskId, description: input.description, prompt: input.prompt },
          operatingMode: { id: mode.id, version: mode.version },
          backend: {
            strategy: "inherit_parent",
            adapterId: parent.backend.pin.adapterId,
            connectionId: parent.backend.pin.connectionId,
            modelId: parent.backend.pin.modelId,
          },
          permissions: {
            parentExecutionMode: context.executionMode,
            executionMode: profile.executionMode,
            parentPermissionMode: parent.permissionMode,
            permissionMode,
          },
          limits: { ...mode.orchestration, maxRequests: childRequestLimit },
          ...(options === undefined ? {} : { workspace: options.workspace }),
        },
      });
      await this.dependencies.emit({
        type: "agent_started",
        sessionId: parent.id,
        at: this.#now(),
        parentAgentId: parent.agent.id,
        childAgentId,
        childSessionId,
        taskId,
        description: input.description,
        operatingModeId: mode.id,
        profileId: profile.id,
        ...(options?.batch === undefined
          ? {}
          : { batchId: options.batch.id, batchIndex: options.batch.index }),
      });
      const run = await coordinator.start({
        sessionId: child.id,
        expectedSessionRecordSequence: child.lastSequence,
        prompt: scopeAgentPrompt(child.agent, input.prompt),
        invocation: invocationFromContext(runContext),
        executionMode: profile.executionMode,
        signal: context.signal,
      });
      const outcome = await run.outcome;
      if (!outcome.ok) {
        if (outcome.failure.phase === "started") {
          budget.requestsUsed = Math.min(
            budget.maxRequests,
            budget.requestsUsed + childRequestLimit,
          );
        }
        await this.#persistPreflightTerminal(child.id, outcome.failure);
        if (cancelled(outcome.failure)) {
          await this.dependencies.emit({
            type: "agent_cancelled",
            sessionId: parent.id,
            at: this.#now(),
            parentAgentId: parent.agent.id,
            childAgentId,
            childSessionId,
            profileId: profile.id,
            reason: outcome.failure.safeMessage,
            ...(options?.batch === undefined
              ? {}
              : { batchId: options.batch.id, batchIndex: options.batch.index }),
          });
          throw new ToolError("cancelled", outcome.failure.safeMessage);
        }
        await this.dependencies.emit({
          type: "agent_failed",
          sessionId: parent.id,
          at: this.#now(),
          parentAgentId: parent.agent.id,
          childAgentId,
          childSessionId,
          profileId: profile.id,
          failure: outcome.failure,
          ...(options?.batch === undefined
            ? {}
            : { batchId: options.batch.id, batchIndex: options.batch.index }),
        });
        throw new ToolError("execution_failed", outcome.failure.safeMessage);
      }
      const usedRequests = outcome.result.steps === null
        ? childRequestLimit
        : Math.min(childRequestLimit, outcome.result.steps);
      budget.requestsUsed = Math.min(
        budget.maxRequests,
        budget.requestsUsed + usedRequests,
      );
      const costUsd = outcome.result.usage?.costUsd;
      if (costUsd !== undefined) {
        budget.reportedCostUsd = Math.min(
          Number.MAX_SAFE_INTEGER,
          budget.reportedCostUsd + costUsd,
        );
      }
      const costLimitExceeded =
        budget.reportedCostUsd > budget.maxReportedCostUsd;
      const workflow = delegationWorkflowUsage(budget);
      await this.dependencies.emit({
        type: "agent_completed",
        sessionId: parent.id,
        at: this.#now(),
        parentAgentId: parent.agent.id,
        childAgentId,
        childSessionId,
        profileId: profile.id,
        usage: outcome.result.usage,
        changedFiles: [...outcome.result.changedFiles],
        evidence: [...outcome.result.evidence],
        costLimitExceeded,
        workflow,
        ...(options?.batch === undefined
          ? {}
          : { batchId: options.batch.id, batchIndex: options.batch.index }),
      });
      return {
        output: outcome.result.finalText,
        metadata: {
          childAgentId,
          childSessionId,
          taskId,
          attempts: 1,
          retries: 0,
          operatingModeId: mode.id,
          profileId: profile.id,
          usage: outcome.result.usage,
          usageSource: outcome.result.usageSource,
          changedFiles: [...outcome.result.changedFiles],
          evidence: [...outcome.result.evidence],
          costLimitUsd: budget.maxReportedCostUsd,
          costLimitExceeded,
          workflow,
          ...(options === undefined ? {} : { workspace: options.workspace }),
          ...(options?.batch === undefined
            ? {}
            : { batchId: options.batch.id, batchIndex: options.batch.index }),
        },
      };
    } finally {
      release();
    }
  }
}
