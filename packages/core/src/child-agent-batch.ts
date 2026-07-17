import { randomUUID } from "node:crypto";

import {
  getAgentProfilePolicy,
  getOperatingModePolicy,
  parseAgentProfileId,
  type AgentProfileId,
  type OperatingModeId,
  type ProviderUsage,
} from "@recurs/contracts";
import {
  ToolError,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "@recurs/tools";

import type {
  AgentBatchCounts,
  AgentWorkflowUsage,
  RecursEvent,
} from "./events.js";
import type { JsonlSessionStore } from "./jsonl-session-store.js";
import type {
  GitWorktreeLease,
  GitWorktreeLeasePort,
} from "./git-worktree-leases.js";
import {
  isPinnedSessionState,
  type PinnedSessionState,
} from "./session-v2.js";
import type {
  ChildAgentManager,
  ChildDelegationResult,
  DelegateTaskInput,
} from "./child-agent-manager.js";
import {
  delegationWorkflowUsage,
  isDelegationBudgetForAgent,
} from "./agent-profile.js";

const MIN_BATCH_TASKS = 2;
const MAX_BATCH_TASKS = 8;
const MAX_DESCRIPTION_LENGTH = 256;
const MAX_PROMPT_LENGTH = 32_768;

type BatchProfileId = Extract<AgentProfileId, "explore_v1" | "review_v1">;

export interface DelegateTasksTask {
  readonly profile: BatchProfileId;
  readonly description: string;
  readonly prompt: string;
}

export interface DelegateTasksInput {
  readonly tasks: readonly DelegateTasksTask[];
}

interface BatchTaskBase {
  readonly index: number;
  readonly profileId: BatchProfileId;
  readonly description: string;
}

export interface CompletedBatchTask extends BatchTaskBase {
  readonly status: "completed";
  readonly childAgentId: string;
  readonly childSessionId: string;
  readonly taskId: string;
  readonly output: string;
  readonly usage: ProviderUsage | null;
  readonly changedFiles: readonly string[];
  readonly evidence: readonly string[];
  readonly isolation: {
    readonly kind: "git_worktree";
    readonly version: 1;
    readonly leaseId: string;
    readonly revision: string;
  };
}

export interface UnsuccessfulBatchTask extends BatchTaskBase {
  readonly status: "failed" | "cancelled";
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

export type BatchTaskResult = CompletedBatchTask | UnsuccessfulBatchTask;

export interface ChildBatchMetadata extends Record<string, unknown> {
  readonly batchId: string;
  readonly status: "completed" | "partial" | "failed";
  readonly operatingModeId: OperatingModeId;
  readonly maxConcurrentChildren: number;
  readonly counts: AgentBatchCounts;
  readonly results: readonly BatchTaskResult[];
  readonly workflow: AgentWorkflowUsage;
}

export interface ChildBatchResult extends ToolResult {
  readonly metadata: ChildBatchMetadata;
}

export interface ChildAgentBatchManagerDependencies {
  readonly sessions: JsonlSessionStore;
  readonly children: Pick<ChildAgentManager, "delegate" | "preflight">;
  readonly worktrees: GitWorktreeLeasePort;
  emit(event: RecursEvent): Promise<void>;
  readonly createId?: () => string;
  readonly now?: () => string;
}

function exactTask(value: unknown): DelegateTasksTask {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ToolError("invalid_input", "Each delegated task must be an object");
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
      "Each delegated task requires exactly profile, description, and prompt",
    );
  }
  const profile = parseAgentProfileId(record.profile);
  if (profile !== "explore_v1" && profile !== "review_v1") {
    throw new ToolError(
      "invalid_input",
      "delegate_tasks supports only Explore and Review",
    );
  }
  const description = record.description.trim();
  const prompt = record.prompt.trim();
  if (
    description.length === 0 || description.length > MAX_DESCRIPTION_LENGTH ||
    prompt.length === 0 || prompt.length > MAX_PROMPT_LENGTH
  ) {
    throw new ToolError("invalid_input", "Delegated task input is empty or too large");
  }
  return { profile, description, prompt };
}

function exactInput(value: unknown): DelegateTasksInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ToolError("invalid_input", "delegate_tasks expects an object");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).join(",") !== "tasks" || !Array.isArray(record.tasks)) {
    throw new ToolError("invalid_input", "delegate_tasks requires exactly tasks");
  }
  if (
    record.tasks.length < MIN_BATCH_TASKS ||
    record.tasks.length > MAX_BATCH_TASKS
  ) {
    throw new ToolError(
      "invalid_input",
      `delegate_tasks requires between ${MIN_BATCH_TASKS} and ${MAX_BATCH_TASKS} tasks`,
    );
  }
  return { tasks: record.tasks.map(exactTask) };
}

function errorDetails(error: unknown): UnsuccessfulBatchTask["error"] {
  return error instanceof ToolError
    ? { code: error.code, message: error.message }
    : {
        code: "execution_failed",
        message: "The delegated child failed unexpectedly",
      };
}

function cancelledError(message = "The delegated task was cancelled") {
  return { code: "cancelled", message };
}

function counts(results: readonly BatchTaskResult[]): AgentBatchCounts {
  return {
    total: results.length,
    completed: results.filter((result) => result.status === "completed").length,
    failed: results.filter((result) => result.status === "failed").length,
    cancelled: results.filter((result) => result.status === "cancelled").length,
  };
}

function completedTask(
  index: number,
  task: DelegateTasksTask,
  result: ChildDelegationResult,
  lease: GitWorktreeLease,
): CompletedBatchTask {
  return {
    index,
    profileId: task.profile,
    description: task.description,
    status: "completed",
    childAgentId: result.metadata.childAgentId,
    childSessionId: result.metadata.childSessionId,
    taskId: result.metadata.taskId,
    output: result.output,
    usage: result.metadata.usage,
    changedFiles: [...result.metadata.changedFiles],
    evidence: [...result.metadata.evidence],
    isolation: {
      kind: "git_worktree",
      version: 1,
      leaseId: lease.id,
      revision: lease.revision,
    },
  };
}

function unsuccessfulTask(
  index: number,
  task: DelegateTasksTask,
  status: "failed" | "cancelled",
  error: UnsuccessfulBatchTask["error"],
): UnsuccessfulBatchTask {
  return {
    index,
    profileId: task.profile,
    description: task.description,
    status,
    error,
  };
}

function renderResult(
  batchId: string,
  batchCounts: AgentBatchCounts,
  results: readonly BatchTaskResult[],
): string {
  const lines = [
    `Delegation batch ${batchId}: ${batchCounts.completed} completed, ${batchCounts.failed} failed, ${batchCounts.cancelled} cancelled.`,
  ];
  for (const result of results) {
    const profile = getAgentProfilePolicy(result.profileId).displayName;
    lines.push(
      "",
      `[${result.index + 1}] ${profile} — ${result.description}: ${result.status}`,
    );
    if (result.status === "completed") {
      lines.push(result.output);
      if (result.evidence.length > 0) {
        lines.push(`Evidence: ${result.evidence.join("; ")}`);
      }
    } else {
      lines.push(`${result.error.code}: ${result.error.message}`);
    }
  }
  return lines.join("\n");
}

type SettledTask = {
  readonly result: BatchTaskResult;
  readonly cleanupFailure?: ToolError;
};

export class ChildAgentBatchManager {
  readonly #createId: () => string;
  readonly #now: () => string;

  constructor(private readonly dependencies: ChildAgentBatchManagerDependencies) {
    this.#createId = dependencies.createId ?? randomUUID;
    this.#now = dependencies.now ?? (() => new Date().toISOString());
  }

  createTool(): Tool<DelegateTasksInput> {
    return {
      definition: {
        name: "delegate_tasks",
        description: [
          "Run a bounded batch of independent Recurs Explore and Review children.",
          "Children inherit this session's pinned backend and permission ceiling, use isolated clean Git worktrees, and return ordered handoffs for synthesis.",
          "Parallel implementation is intentionally unsupported.",
        ].join(" "),
        inputSchema: {
          type: "object",
          properties: {
            tasks: {
              type: "array",
              minItems: MIN_BATCH_TASKS,
              maxItems: MAX_BATCH_TASKS,
              items: {
                type: "object",
                properties: {
                  profile: {
                    type: "string",
                    enum: ["explore", "review", "explore_v1", "review_v1"],
                  },
                  description: { type: "string" },
                  prompt: { type: "string" },
                },
                required: ["profile", "description", "prompt"],
                additionalProperties: false,
              },
            },
          },
          required: ["tasks"],
          additionalProperties: false,
        },
      },
      executionClass: "in_process",
      mutating: false,
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

  async #runTask(
    batchId: string,
    index: number,
    task: DelegateTasksTask,
    parent: PinnedSessionState,
    context: ToolContext,
    signal: AbortSignal,
    cancelBatch: () => void,
  ): Promise<SettledTask> {
    let lease: GitWorktreeLease | undefined;
    let result: BatchTaskResult;
    try {
      if (signal.aborted) throw new ToolError("cancelled", "The batch was cancelled");
      await this.dependencies.children.preflight(task, { ...context, signal });
      lease = await this.dependencies.worktrees.create(parent.cwd, signal);
      if (signal.aborted) throw new ToolError("cancelled", "The batch was cancelled");
      const childInput: DelegateTaskInput = task;
      const child = await this.dependencies.children.delegate(
        childInput,
        { ...context, signal },
        {
          cwd: lease.worktreeRoot,
          workspace: {
            kind: "git_worktree",
            version: 1,
            leaseId: lease.id,
            repositoryRoot: lease.repositoryRoot,
            worktreeRoot: lease.worktreeRoot,
            revision: lease.revision,
          },
          batch: { id: batchId, index },
        },
      );
      result = completedTask(index, task, child, lease);
    } catch (error) {
      const details = errorDetails(error);
      const isCancelled = details.code === "cancelled" || signal.aborted;
      if (isCancelled) cancelBatch();
      result = unsuccessfulTask(
        index,
        task,
        isCancelled ? "cancelled" : "failed",
        isCancelled ? cancelledError(details.message) : details,
      );
    }

    if (lease === undefined) return { result };
    try {
      await this.dependencies.worktrees.release(lease);
      return { result };
    } catch (error) {
      const cleanupFailure = error instanceof ToolError
        ? error
        : new ToolError("process_failed", "Git worktree cleanup failed");
      cancelBatch();
      return {
        result: unsuccessfulTask(
          index,
          task,
          "failed",
          { code: cleanupFailure.code, message: cleanupFailure.message },
        ),
        cleanupFailure,
      };
    }
  }

  async delegate(
    input: DelegateTasksInput,
    context: ToolContext,
  ): Promise<ChildBatchResult> {
    if (context.signal.aborted) {
      throw new ToolError("cancelled", "Child delegation batch was cancelled");
    }
    const parent = await this.#parent(context);
    const mode = getOperatingModePolicy(parent.agent.operatingMode.id);
    if (input.tasks.length > mode.workflow.maxChildrenPerRun) {
      throw new ToolError(
        "permission_denied",
        `Agent batch task limit reached (${mode.workflow.maxChildrenPerRun})`,
      );
    }
    const actProfile = input.tasks.find((task) =>
      getAgentProfilePolicy(task.profile).executionMode === "act"
    );
    if (actProfile !== undefined && context.executionMode !== "act") {
      throw new ToolError(
        "plan_mode_denied",
        `${getAgentProfilePolicy(actProfile.profile).displayName} children require an Act parent`,
      );
    }
    const budget = context.delegationBudget;
    if (budget === undefined ||
      !isDelegationBudgetForAgent(budget, parent.agent)) {
      throw new ToolError("tool_unavailable", "Trusted delegation budget is unavailable");
    }

    const batchId = this.#createId();
    const concurrency = Math.min(
      input.tasks.length,
      mode.orchestration.maxConcurrentChildren,
    );
    await this.dependencies.emit({
      type: "agent_batch_started",
      sessionId: parent.id,
      at: this.#now(),
      parentAgentId: parent.agent.id,
      batchId,
      operatingModeId: mode.id,
      taskCount: input.tasks.length,
      maxConcurrentChildren: concurrency,
    });

    const controller = new AbortController();
    const cancel = () => {
      if (!controller.signal.aborted) controller.abort();
    };
    context.signal.addEventListener("abort", cancel, { once: true });
    if (context.signal.aborted) cancel();
    const settled: Array<SettledTask | undefined> = new Array(input.tasks.length);
    let cursor = 0;
    const worker = async () => {
      while (!controller.signal.aborted) {
        const index = cursor;
        cursor += 1;
        const task = input.tasks[index];
        if (task === undefined) return;
        settled[index] = await this.#runTask(
          batchId,
          index,
          task,
          parent,
          context,
          controller.signal,
          cancel,
        );
      }
    };
    try {
      await Promise.all(Array.from({ length: concurrency }, worker));
    } finally {
      context.signal.removeEventListener("abort", cancel);
    }

    const results = input.tasks.map((task, index): BatchTaskResult =>
      settled[index]?.result ?? unsuccessfulTask(
        index,
        task,
        "cancelled",
        cancelledError("The batch was cancelled before this task started"),
      )
    );
    const batchCounts = counts(results);
    const workflow = delegationWorkflowUsage(budget);
    const terminal = {
      sessionId: parent.id,
      at: this.#now(),
      parentAgentId: parent.agent.id,
      batchId,
      operatingModeId: mode.id,
      counts: batchCounts,
      workflow,
    };
    const cleanupFailure = settled.find(
      (item) => item?.cleanupFailure !== undefined,
    )?.cleanupFailure;
    if (cleanupFailure !== undefined) {
      await this.dependencies.emit({
        type: "agent_batch_failed",
        ...terminal,
        partial: batchCounts.completed > 0,
        failure: {
          code: cleanupFailure.code,
          message: cleanupFailure.message,
        },
      });
      throw cleanupFailure;
    }
    if (controller.signal.aborted) {
      const reason = context.signal.aborted
        ? "Parent delegation was cancelled"
        : "A child delegation was cancelled";
      await this.dependencies.emit({
        type: "agent_batch_cancelled",
        ...terminal,
        reason,
      });
      throw new ToolError("cancelled", reason);
    }

    const status = batchCounts.failed === 0
      ? "completed" as const
      : batchCounts.completed === 0
        ? "failed" as const
        : "partial" as const;
    if (status === "completed") {
      await this.dependencies.emit({
        type: "agent_batch_completed",
        ...terminal,
      });
    } else {
      await this.dependencies.emit({
        type: "agent_batch_failed",
        ...terminal,
        partial: status === "partial",
      });
    }
    return {
      output: renderResult(batchId, batchCounts, results),
      metadata: {
        batchId,
        status,
        operatingModeId: mode.id,
        maxConcurrentChildren: concurrency,
        counts: batchCounts,
        results,
        workflow,
      },
    };
  }
}
