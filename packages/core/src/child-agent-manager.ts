import { randomUUID } from "node:crypto";

import {
  createHostInvocation,
  getOperatingModePolicy,
  narrowAgentPermissionMode,
  type HostInvocation,
  type IntegrationFailure,
  type RunCoordinator,
  type TrustedRunContext,
} from "@recurs/contracts";
import {
  ToolError,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "@recurs/tools";

import type { RecursEvent } from "./events.js";
import {
  isPinnedSessionState,
  type PinnedSessionState,
} from "./session-v2.js";
import type { JsonlSessionStore } from "./jsonl-session-store.js";

interface DelegateTaskInput {
  readonly description: string;
  readonly prompt: string;
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
    Object.keys(record).sort().join(",") !== "description,prompt" ||
    typeof record.description !== "string" ||
    typeof record.prompt !== "string"
  ) {
    throw new ToolError(
      "invalid_input",
      "delegate_task requires exactly description and prompt",
    );
  }
  const description = record.description.trim();
  const prompt = record.prompt.trim();
  if (
    description.length === 0 || description.length > MAX_DESCRIPTION_LENGTH ||
    prompt.length === 0 || prompt.length > MAX_PROMPT_LENGTH
  ) {
    throw new ToolError("invalid_input", "delegate_task input is empty or too large");
  }
  return { description, prompt };
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
          "Create one bounded Recurs child agent for a concrete subtask.",
          "The child inherits this session's backend, execution mode, and permission ceiling.",
          "Use it only when an isolated investigation or implementation has a clear handoff.",
        ].join(" "),
        inputSchema: {
          type: "object",
          properties: {
            description: { type: "string" },
            prompt: { type: "string" },
          },
          required: ["description", "prompt"],
          additionalProperties: false,
        },
      },
      executionClass: "in_process",
      mutating: false,
      parse: exactInput,
      permissions() {
        return [];
      },
      execute: (input, context) => this.#delegate(input, context),
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

  async #delegate(
    input: DelegateTaskInput,
    context: ToolContext,
  ): Promise<ToolResult> {
    if (context.signal.aborted) {
      throw new ToolError("cancelled", "Child delegation was cancelled");
    }
    const parent = await this.#parent(context);
    const mode = getOperatingModePolicy(parent.agent.operatingMode.id);
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

    const childSessionId = this.#createId();
    const childAgentId = this.#createId();
    const taskId = this.#createId();
    const release = this.#claim(parent, childSessionId);
    const permissionMode = narrowAgentPermissionMode(
      parent.permissionMode,
      parent.permissionMode,
    );
    try {
      const child = await this.dependencies.sessions.createPinnedSession({
        id: childSessionId,
        cwd: parent.cwd,
        backend: parent.backend.pin,
        at: this.#now(),
        agent: {
          id: childAgentId,
          role: "child",
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
            executionMode: context.executionMode,
            parentPermissionMode: parent.permissionMode,
            permissionMode,
          },
          limits: mode.orchestration,
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
      });
      const run = await coordinator.start({
        sessionId: child.id,
        expectedSessionRecordSequence: child.lastSequence,
        prompt: input.prompt,
        invocation: invocationFromContext(context.runContext),
        executionMode: context.executionMode,
        signal: context.signal,
      });
      const outcome = await run.outcome;
      if (!outcome.ok) {
        await this.#persistPreflightTerminal(child.id, outcome.failure);
        if (cancelled(outcome.failure)) {
          await this.dependencies.emit({
            type: "agent_cancelled",
            sessionId: parent.id,
            at: this.#now(),
            parentAgentId: parent.agent.id,
            childAgentId,
            childSessionId,
            reason: outcome.failure.safeMessage,
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
          failure: outcome.failure,
        });
        throw new ToolError("execution_failed", outcome.failure.safeMessage);
      }
      const costUsd = outcome.result.usage?.costUsd;
      const costLimitExceeded = costUsd !== undefined &&
        costUsd > mode.orchestration.maxReportedCostUsd;
      await this.dependencies.emit({
        type: "agent_completed",
        sessionId: parent.id,
        at: this.#now(),
        parentAgentId: parent.agent.id,
        childAgentId,
        childSessionId,
        usage: outcome.result.usage,
        evidence: [...outcome.result.evidence],
        costLimitExceeded,
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
          usage: outcome.result.usage,
          usageSource: outcome.result.usageSource,
          changedFiles: [...outcome.result.changedFiles],
          evidence: [...outcome.result.evidence],
          costLimitUsd: mode.orchestration.maxReportedCostUsd,
          costLimitExceeded,
        },
      };
    } finally {
      release();
    }
  }
}
