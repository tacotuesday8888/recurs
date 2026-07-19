import { randomUUID } from "node:crypto";

import {
  getOperatingModePolicy,
  type AgentGitWorktreeWorkspace,
  type OperatingModeId,
  type TeamRunExecution,
} from "@recurs/contracts";
import {
  ToolError,
  type CheckpointStore,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "@recurs/tools";

import type {
  AgentReviewPanel,
  AgentReviewPanelResult,
  AgentReviewRecord,
} from "./agent-review-panel.js";
import {
  childRequestAllowance,
  delegationWorkflowUsage,
  isDelegationBudgetForAgent,
} from "./agent-profile.js";
import type {
  ChildAgentManager,
  ChildDelegationResult,
} from "./child-agent-manager.js";
import type {
  AgentTeamFailurePhase,
  AgentTeamStatus,
  RecursEvent,
} from "./events.js";
import type {
  GitPatchArtifactHandle,
  GitPatchArtifactManager,
  GitPatchBase,
  GitPatchIntegrationOutcome,
} from "./git-patch-artifacts.js";
import type {
  GitWorktreeLease,
  GitWorktreeLeasePort,
} from "./git-worktree-leases.js";
import type { JsonlSessionStore } from "./jsonl-session-store.js";
import { isPinnedSessionState } from "./session-v2.js";
import type {
  TeamRunResult,
  TeamRunSupervisor,
} from "./team-run-supervisor.js";

const MAX_TASKS = 4;
const MAX_DESCRIPTION_LENGTH = 256;
const MAX_PROMPT_LENGTH = 32_768;
const MAX_REVIEW_INSTRUCTIONS_LENGTH = 12_000;
const MAX_HANDOFF_LENGTH = 16_000;
const TEAM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;

export interface TeamImplementationTask {
  readonly description: string;
  readonly prompt: string;
}

export interface DelegateTeamInput {
  readonly description: string;
  readonly tasks: readonly TeamImplementationTask[];
  readonly review: { readonly instructions: string };
  readonly execution?: TeamRunExecution;
}

interface SafeTeamFailure {
  readonly code: string;
  readonly message: string;
}

interface CompletedImplementation {
  readonly index: number;
  readonly description: string;
  readonly status: "completed";
  readonly childAgentId: string;
  readonly childSessionId: string;
  readonly handoff: string;
  readonly evidence: readonly string[];
  readonly artifact: GitPatchArtifactHandle;
}

interface FailedImplementation {
  readonly index: number;
  readonly description: string;
  readonly status: "failed" | "cancelled";
  readonly failure: SafeTeamFailure;
}

type ImplementationResult = CompletedImplementation | FailedImplementation;

export interface TeamAgentResultMetadata extends Record<string, unknown> {
  readonly teamId: string;
  readonly status: AgentTeamStatus | "failed";
  readonly operatingModeId: OperatingModeId;
  readonly implementations: readonly Record<string, unknown>[];
  readonly integration: GitPatchIntegrationOutcome | null;
  readonly review: AgentReviewPanelResult | null;
  readonly reviewFailure?: SafeTeamFailure;
  readonly workflow: ReturnType<typeof delegationWorkflowUsage>;
  readonly changedFiles: readonly string[];
  readonly evidence: readonly string[];
}

export interface TeamAgentManagerDependencies {
  readonly sessions: JsonlSessionStore;
  readonly supervisor?: Pick<
    TeamRunSupervisor,
    "preflight" | "startForeground" | "startBackground"
  >;
  readonly children: Pick<ChildAgentManager, "delegate">;
  readonly worktrees: GitWorktreeLeasePort;
  readonly patches: Pick<
    GitPatchArtifactManager,
    "preflightParent" | "capture" | "discard" | "integrate"
  >;
  readonly reviews: Pick<AgentReviewPanel, "run">;
  readonly checkpoints: CheckpointStore;
  emit(event: RecursEvent): Promise<void>;
  readonly createId?: () => string;
  readonly now?: () => string;
}

function exactKeys(
  value: unknown,
  expected: readonly string[],
  message: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ToolError("invalid_input", message);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== [...expected].sort().join(",")) {
    throw new ToolError("invalid_input", message);
  }
  return record;
}

function boundedText(
  value: unknown,
  maximum: number,
  allowLines: boolean,
): string {
  if (typeof value !== "string") {
    throw new ToolError("invalid_input", "delegate_team text is invalid");
  }
  const text = value.trim();
  const unsafeControl = [...text].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (codePoint <= 31 && !(allowLines && "\n\r\t".includes(character))) ||
      (codePoint >= 127 && codePoint <= 159);
  });
  if (text.length === 0 || text.length > maximum || unsafeControl) {
    throw new ToolError("invalid_input", "delegate_team text is empty or too large");
  }
  return text;
}

function parseInput(value: unknown): DelegateTeamInput {
  const raw = typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const hasExecution = Object.hasOwn(raw, "execution");
  const record = exactKeys(value, [
    "description",
    "tasks",
    "review",
    ...(hasExecution ? ["execution"] : []),
  ], "delegate_team requires description, tasks, review, and optional execution");
  if (hasExecution && record.execution !== "foreground" &&
    record.execution !== "background") {
    throw new ToolError(
      "invalid_input",
      "delegate_team execution must be foreground or background",
    );
  }
  if (!Array.isArray(record.tasks) ||
    record.tasks.length < 1 || record.tasks.length > MAX_TASKS) {
    throw new ToolError(
      "invalid_input",
      `delegate_team requires between 1 and ${MAX_TASKS} implementation tasks`,
    );
  }
  const tasks = record.tasks.map((value) => {
    const task = exactKeys(
      value,
      ["description", "prompt"],
      "Each delegate_team task requires exactly description and prompt",
    );
    return {
      description: boundedText(task.description, MAX_DESCRIPTION_LENGTH, false),
      prompt: boundedText(task.prompt, MAX_PROMPT_LENGTH, true),
    };
  });
  const review = exactKeys(
    record.review,
    ["instructions"],
    "delegate_team review requires exactly instructions",
  );
  return {
    description: boundedText(record.description, MAX_DESCRIPTION_LENGTH, false),
    tasks,
    review: {
      instructions: boundedText(
        review.instructions,
        MAX_REVIEW_INSTRUCTIONS_LENGTH,
        true,
      ),
    },
    ...(hasExecution
      ? { execution: record.execution as TeamRunExecution }
      : {}),
  };
}

function safeFailure(error: unknown, fallback: string): SafeTeamFailure {
  return error instanceof ToolError
    ? { code: error.code, message: error.message }
    : { code: "execution_failed", message: fallback };
}

function isCancelled(error: unknown): boolean {
  return error instanceof ToolError && error.code === "cancelled";
}

function boundedHandoff(value: string): string {
  if (value.length <= MAX_HANDOFF_LENGTH) return value;
  return `${value.slice(0, MAX_HANDOFF_LENGTH)}\n[handoff truncated by Recurs]`;
}

function publicImplementations(
  results: readonly ImplementationResult[],
): Record<string, unknown>[] {
  return results.map((result) => result.status === "completed"
    ? {
        index: result.index,
        description: result.description,
        status: result.status,
        childAgentId: result.childAgentId,
        childSessionId: result.childSessionId,
        evidence: [...result.evidence],
        patch: {
          id: result.artifact.id,
          sha256: result.artifact.sha256,
          byteLength: result.artifact.byteLength,
          paths: [...result.artifact.paths],
        },
      }
    : {
        index: result.index,
        description: result.description,
        status: result.status,
        failure: result.failure,
      });
}

function teamOutput(
  teamId: string,
  status: AgentTeamStatus,
  implementations: readonly CompletedImplementation[],
  integration: Extract<GitPatchIntegrationOutcome, { ok: true }>,
  review: AgentReviewPanelResult | null,
  reviewFailure?: SafeTeamFailure,
): string {
  const lines = [
    `Team ${teamId}: ${status}`,
    `Integrated ${integration.artifactIds.length} patch artifact(s) across ${integration.changedFiles.length} file(s).`,
    "Implementation handoffs:",
    ...implementations.flatMap((result) => [
      `\n[${result.index}] ${result.description}`,
      result.handoff,
    ]),
  ];
  if (review !== null) {
    lines.push("", `Review: ${review.verdict}`);
    for (const record of review.reviews) {
      if (record.status === "completed") {
        lines.push(`[${record.index}] ${record.verdict}: ${record.summary}`);
      } else {
        lines.push(`[${record.index}] ${record.status}: ${record.error.message}`);
      }
    }
  } else if (reviewFailure !== undefined) {
    lines.push("", `Review unavailable: ${reviewFailure.message}`);
  }
  return lines.join("\n");
}

export class TeamAgentManager {
  readonly #createId: () => string;
  readonly #now: () => string;
  readonly #activeParents = new Set<string>();

  constructor(private readonly dependencies: TeamAgentManagerDependencies) {
    this.#createId = dependencies.createId ?? randomUUID;
    this.#now = dependencies.now ?? (() => new Date().toISOString());
  }

  async #durableSupervisor(
    context: ToolContext,
  ): Promise<NonNullable<TeamAgentManagerDependencies["supervisor"]> | null> {
    const supervisor = this.dependencies.supervisor;
    if (supervisor === undefined) return null;
    const parent = await this.dependencies.sessions.loadState(context.sessionId);
    if (!isPinnedSessionState(parent) || parent.agent.role !== "parent" ||
      parent.cwd !== context.cwd) {
      return null;
    }
    return getOperatingModePolicy(parent.agent.operatingMode.id).version === 4
      ? supervisor
      : null;
  }

  async #publish(event: RecursEvent): Promise<void> {
    try {
      await this.dependencies.emit(event);
    } catch {
      // Durable session and workspace truth is authoritative; presentation is best effort.
    }
  }

  createTool(): Tool<DelegateTeamInput> {
    return {
      definition: {
        name: "delegate_team",
        description: [
          "Run one Recurs-owned implementation team in foreground by default or explicitly in background.",
          "Each task executes in an isolated Git worktree before independent review; foreground runs apply an approved candidate, while background runs stop for explicit apply_team control.",
          "Use only for concrete, disjoint implementation tasks in a clean committed Git workspace.",
        ].join(" "),
        inputSchema: {
          type: "object",
          properties: {
            description: { type: "string" },
            tasks: {
              type: "array",
              minItems: 1,
              maxItems: MAX_TASKS,
              items: {
                type: "object",
                properties: {
                  description: { type: "string" },
                  prompt: { type: "string" },
                },
                required: ["description", "prompt"],
                additionalProperties: false,
              },
            },
            review: {
              type: "object",
              properties: { instructions: { type: "string" } },
              required: ["instructions"],
              additionalProperties: false,
            },
            execution: {
              type: "string",
              enum: ["foreground", "background"],
            },
          },
          required: ["description", "tasks", "review"],
          additionalProperties: false,
        },
      },
      executionClass: "in_process",
      mutating: true,
      checkpointOwnership: "self_managed",
      parse: parseInput,
      permissions() {
        return [
          {
            category: "write",
            resource: "team workspace integration",
            risk: "elevated",
          },
          {
            category: "shell",
            resource: "fixed Git worktree orchestration",
            risk: "normal",
          },
        ];
      },
      preflight: (input, context) => this.preflight(input, context),
      execute: (input, context) => this.delegate(input, context),
    };
  }

  async #prepare(input: DelegateTeamInput, context: ToolContext) {
    if (context.signal.aborted) {
      throw new ToolError("cancelled", "Team delegation was cancelled");
    }
    if (input.execution === "background") {
      throw new ToolError(
        "tool_unavailable",
        "Background teams require the durable version-4 supervisor",
      );
    }
    if (context.executionMode !== "act") {
      throw new ToolError("plan_mode_denied", "Team implementation requires an Act parent");
    }
    const parent = await this.dependencies.sessions.loadState(context.sessionId);
    if (!isPinnedSessionState(parent) ||
      parent.cwd !== context.cwd || parent.agent.role !== "parent") {
      throw new ToolError("tool_unavailable", "Parent agent session is unavailable");
    }
    const mode = getOperatingModePolicy(parent.agent.operatingMode.id);
    if (mode.version !== 3) {
      throw new ToolError(
        "tool_unavailable",
        "Legacy team execution requires an exact version-3 operating policy",
      );
    }
    const team = mode.workflow.team;
    if (team === null) {
      throw new ToolError(
        "tool_unavailable",
        "This historical operating mode does not define team orchestration",
      );
    }
    if (input.tasks.length > team.maxImplementers) {
      throw new ToolError(
        "permission_denied",
        `${mode.displayName} mode supports at most ${team.maxImplementers} Implement worker${team.maxImplementers === 1 ? "" : "s"}`,
      );
    }
    if (context.runContext === undefined) {
      throw new ToolError("tool_unavailable", "Trusted run context is unavailable");
    }
    const budget = context.delegationBudget;
    if (budget === undefined || !isDelegationBudgetForAgent(budget, parent.agent)) {
      throw new ToolError("tool_unavailable", "Trusted delegation budget is unavailable");
    }
    const requiredChildren = input.tasks.length + team.maxReviewers;
    const requestAllowance = childRequestAllowance(parent.agent);
    if (
      budget.childrenStarted + requiredChildren > budget.maxChildren ||
      budget.requestsReserved + requiredChildren * requestAllowance > budget.maxRequests
    ) {
      throw new ToolError(
        "permission_denied",
        `Team delegation requires complete adaptive review budget for ${requiredChildren} children`,
      );
    }
    if (budget.reportedCostUsd >= budget.maxReportedCostUsd) {
      throw new ToolError(
        "permission_denied",
        `Agent reported-cost limit reached ($${budget.maxReportedCostUsd})`,
      );
    }
    const base = await this.dependencies.patches.preflightParent(
      parent.cwd,
      context.signal,
    );
    return { parent, mode, team, budget, base };
  }

  async preflight(input: DelegateTeamInput, context: ToolContext): Promise<void> {
    const supervisor = await this.#durableSupervisor(context);
    if (supervisor !== null) {
      await supervisor.preflight(input, context);
      return;
    }
    await this.#prepare(input, context);
  }

  async #implement(
    task: TeamImplementationTask,
    index: number,
    teamId: string,
    parentAgentId: string,
    modeId: OperatingModeId,
    base: GitPatchBase,
    lease: GitWorktreeLease,
    context: ToolContext,
    captured: Map<number, GitPatchArtifactHandle>,
  ): Promise<CompletedImplementation> {
    let result: ChildDelegationResult | undefined;
    let artifact: GitPatchArtifactHandle | undefined;
    let failure: unknown;
    try {
      if (lease.repositoryRoot !== base.repositoryRoot ||
        lease.revision !== base.revision) {
        throw new ToolError(
          "permission_denied",
          "The isolated worker lease does not match the team base revision",
        );
      }
      const workspace: AgentGitWorktreeWorkspace = {
        kind: "git_worktree",
        version: 1,
        leaseId: lease.id,
        repositoryRoot: lease.repositoryRoot,
        worktreeRoot: lease.worktreeRoot,
        revision: lease.revision,
      };
      result = await this.dependencies.children.delegate({
        profile: "implement_v1",
        description: task.description,
        prompt: task.prompt,
      }, context, {
        cwd: lease.worktreeRoot,
        workspace,
        team: { id: teamId, index },
      });
      artifact = await this.dependencies.patches.capture(lease, context.signal) ??
        undefined;
      if (artifact === undefined) {
        throw new ToolError(
          "execution_failed",
          "An Implement worker returned without a patch artifact",
        );
      }
      captured.set(index, artifact);
      await this.#publish({
        type: "agent_team_patch_captured",
        sessionId: context.sessionId,
        at: this.#now(),
        parentAgentId,
        teamId,
        operatingModeId: modeId,
        teamIndex: index,
        childAgentId: result.metadata.childAgentId,
        childSessionId: result.metadata.childSessionId,
        artifactId: artifact.id,
        paths: [...artifact.paths],
      });
    } catch (error) {
      failure = error;
    }
    try {
      await this.dependencies.worktrees.release(lease);
    } catch (error) {
      failure = new ToolError(
        "execution_failed",
        failure === undefined
          ? "The isolated Implement worktree could not be cleaned up"
          : "Implementation failed and its isolated worktree could not be cleaned up",
        { cause: error },
      );
    }
    if (failure !== undefined) throw failure;
    if (result === undefined || artifact === undefined) {
      throw new ToolError("execution_failed", "Implementation did not complete");
    }
    return {
      index,
      description: task.description,
      status: "completed",
      childAgentId: result.metadata.childAgentId,
      childSessionId: result.metadata.childSessionId,
      handoff: boundedHandoff(result.output),
      evidence: [...result.metadata.evidence],
      artifact,
    };
  }

  async #emitReviews(
    teamId: string,
    parentAgentId: string,
    modeId: OperatingModeId,
    reviews: readonly AgentReviewRecord[],
    context: ToolContext,
  ): Promise<void> {
    for (const review of reviews) {
      const common = {
        type: "agent_team_review_recorded" as const,
        sessionId: context.sessionId,
        at: this.#now(),
        parentAgentId,
        teamId,
        operatingModeId: modeId,
        reviewIndex: review.index,
        status: review.status,
      };
      if (review.status === "completed") {
        await this.#publish({
          ...common,
          verdict: review.verdict,
          summary: review.summary,
          evidence: [...review.evidence],
        });
      } else {
        await this.#publish({ ...common, failure: review.error });
      }
    }
  }

  async #emitFailure(
    teamId: string,
    parentAgentId: string,
    modeId: OperatingModeId,
    phase: AgentTeamFailurePhase,
    partial: boolean,
    failure: SafeTeamFailure,
    context: ToolContext,
  ): Promise<void> {
    await this.#publish({
      type: "agent_team_failed",
      sessionId: context.sessionId,
      at: this.#now(),
      parentAgentId,
      teamId,
      operatingModeId: modeId,
      phase,
      partial,
      failure,
      workflow: delegationWorkflowUsage(context.delegationBudget!),
    });
  }

  async #emitCancellation(
    teamId: string,
    parentAgentId: string,
    modeId: OperatingModeId,
    phase: "implementation" | "integration" | "review",
    partial: boolean,
    reason: string,
    context: ToolContext,
  ): Promise<never> {
    await this.#publish({
      type: "agent_team_cancelled",
      sessionId: context.sessionId,
      at: this.#now(),
      parentAgentId,
      teamId,
      operatingModeId: modeId,
      phase,
      partial,
      reason,
      workflow: delegationWorkflowUsage(context.delegationBudget!),
    });
    throw new ToolError("cancelled", reason);
  }

  async delegate(
    input: DelegateTeamInput,
    context: ToolContext,
  ): Promise<
    | (ToolResult & { metadata: TeamAgentResultMetadata })
    | TeamRunResult
  > {
    const supervisor = await this.#durableSupervisor(context);
    if (supervisor !== null) {
      return input.execution === "background"
        ? supervisor.startBackground(input, context)
        : supervisor.startForeground(input, context);
    }
    const prepared = await this.#prepare(input, context);
    const { parent, mode, team, budget, base } = prepared;
    const teamId = this.#createId();
    if (!TEAM_ID.test(teamId)) {
      throw new ToolError("tool_unavailable", "The internal team ID is invalid");
    }
    if (this.#activeParents.has(parent.agent.id)) {
      throw new ToolError(
        "permission_denied",
        "A team workflow is already active for this parent agent",
      );
    }
    this.#activeParents.add(parent.agent.id);
    const controller = new AbortController();
    let parentCancelled = context.signal.aborted;
    const onParentAbort = () => {
      parentCancelled = true;
      controller.abort();
    };
    context.signal.addEventListener("abort", onParentAbort, { once: true });
    const teamContext = { ...context, signal: controller.signal };
    try {
      await this.#publish({
        type: "agent_team_started",
        sessionId: parent.id,
        at: this.#now(),
        parentAgentId: parent.agent.id,
        teamId,
        operatingModeId: mode.id,
        description: input.description,
        implementerCount: input.tasks.length,
        qualityStandard: team.qualityStandard,
      });

      const captured = new Map<number, GitPatchArtifactHandle>();
      const leases: GitWorktreeLease[] = [];
      try {
        while (leases.length < input.tasks.length) {
          const lease = await this.dependencies.worktrees.create(
            base.repositoryRoot,
            teamContext.signal,
          );
          leases.push(lease);
          if (lease.repositoryRoot !== base.repositoryRoot ||
            lease.revision !== base.revision) {
            throw new ToolError(
              "permission_denied",
              "The isolated worker lease does not match the team base revision",
            );
          }
        }
      } catch (error) {
        try {
          await Promise.all(leases.map((lease) =>
            this.dependencies.worktrees.release(lease)
          ));
        } catch (cleanupError) {
          throw new ToolError(
            "execution_failed",
            "Team workspace reservation failed and could not be cleaned up",
            { cause: cleanupError },
          );
        }
        throw error;
      }
      let failureObserved = false;
      const implementations: ImplementationResult[] = await Promise.all(
        input.tasks.map(async (task, offset) => {
          const index = offset + 1;
          try {
            return await this.#implement(
              task,
              index,
              teamId,
              parent.agent.id,
              mode.id,
              base,
              leases[offset]!,
              teamContext,
              captured,
            );
          } catch (error) {
            const failure = safeFailure(error, "An Implement worker failed");
            if (!failureObserved) {
              failureObserved = true;
              controller.abort();
            }
            return {
              index,
              description: task.description,
              status: isCancelled(error) ? "cancelled" as const : "failed" as const,
              failure,
            };
          }
        }),
      );

      const incomplete = implementations
        .filter((item): item is FailedImplementation =>
          item.status !== "completed"
        )
        .sort((left, right) => left.index - right.index);
      if (incomplete.length > 0) {
        const genuineFailures = incomplete.filter((item) =>
          item.status === "failed"
        );
        const artifacts = [...captured.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, artifact]) => artifact);
        if (artifacts.length > 0) {
          try {
            await this.dependencies.patches.discard(artifacts);
          } catch {
            // Durable refs can be reclaimed later; preserve the real workflow failure.
          }
        }
        const failure = genuineFailures[0]?.failure ?? incomplete[0]?.failure ?? {
          code: "execution_failed",
          message: "Team implementation did not complete",
        };
        if (
          parentCancelled ||
          (genuineFailures.length === 0 && failure.code === "cancelled")
        ) {
          await this.#emitCancellation(
            teamId,
            parent.agent.id,
            mode.id,
            "implementation",
            false,
            "Team implementation was cancelled",
            teamContext,
          );
        }
        await this.#emitFailure(
          teamId,
          parent.agent.id,
          mode.id,
          "implementation",
          false,
          failure,
          teamContext,
        );
        return {
          output: `Team ${teamId} failed during implementation: ${failure.message}`,
          metadata: {
            teamId,
            status: "failed",
            operatingModeId: mode.id,
            implementations: publicImplementations(implementations),
            integration: null,
            review: null,
            workflow: delegationWorkflowUsage(budget),
            changedFiles: [],
            evidence: [],
          },
        };
      }

      const completed = implementations as CompletedImplementation[];
      let integration: GitPatchIntegrationOutcome;
      try {
        integration = await this.dependencies.patches.integrate({
          base,
          artifacts: completed.map((item) => item.artifact),
          sessionId: parent.id,
          operationId: `${teamId}-integration`,
          checkpoints: this.dependencies.checkpoints,
          signal: teamContext.signal,
        });
      } catch (error) {
        const failure = safeFailure(error, "Team patch integration failed");
        if (parentCancelled || isCancelled(error)) {
          await this.#emitCancellation(
            teamId,
            parent.agent.id,
            mode.id,
            "integration",
            true,
            "Team patch integration was cancelled",
            teamContext,
          );
        }
        await this.#emitFailure(
          teamId,
          parent.agent.id,
          mode.id,
          "integration",
          true,
          failure,
          teamContext,
        );
        return {
          output: `Team ${teamId} integration failed; inspect the workspace: ${failure.message}`,
          metadata: {
            teamId,
            status: "failed",
            operatingModeId: mode.id,
            implementations: publicImplementations(implementations),
            integration: null,
            review: null,
            workflow: delegationWorkflowUsage(budget),
            changedFiles: [],
            evidence: [],
          },
        };
      }
      if (!integration.ok) {
        const partial = integration.integratedArtifactIds.length > 0 &&
          !integration.rolledBack;
        if (integration.code === "cancelled") {
          await this.#emitCancellation(
            teamId,
            parent.agent.id,
            mode.id,
            "integration",
            partial,
            integration.message,
            teamContext,
          );
        }
        const failure = { code: integration.code, message: integration.message };
        await this.#emitFailure(
          teamId,
          parent.agent.id,
          mode.id,
          "integration",
          partial,
          failure,
          teamContext,
        );
        return {
          output: `Team ${teamId} failed during integration: ${integration.message}`,
          metadata: {
            teamId,
            status: "failed",
            operatingModeId: mode.id,
            implementations: publicImplementations(implementations),
            integration,
            review: null,
            workflow: delegationWorkflowUsage(budget),
            changedFiles: [],
            evidence: completed.flatMap((item) => item.evidence),
          },
        };
      }

      await this.#publish({
        type: "agent_team_patches_integrated",
        sessionId: parent.id,
        at: this.#now(),
        parentAgentId: parent.agent.id,
        teamId,
        operatingModeId: mode.id,
        artifactIds: [...integration.artifactIds],
        changedFiles: [...integration.changedFiles],
        checkpointId: integration.checkpointId,
      });

      let review: AgentReviewPanelResult | null = null;
      let reviewFailure: SafeTeamFailure | undefined;
      try {
        review = await this.dependencies.reviews.run({
          description: input.description,
          instructions: input.review.instructions,
          changedFiles: integration.changedFiles,
        }, teamContext, {
          team: { id: teamId, indexOffset: input.tasks.length },
        });
        await this.#emitReviews(
          teamId,
          parent.agent.id,
          mode.id,
          review.reviews,
          teamContext,
        );
      } catch (error) {
        if (parentCancelled || isCancelled(error)) {
          await this.#emitCancellation(
            teamId,
            parent.agent.id,
            mode.id,
            "review",
            true,
            "Team review was cancelled",
            teamContext,
          );
        }
        reviewFailure = safeFailure(error, "Team review infrastructure failed");
      }

      const status = review?.verdict ?? "unverified";
      const evidence = [...new Set([
        ...completed.flatMap((item) => item.evidence),
        ...(review?.evidence ?? []),
        `Integrated ${integration.artifactIds.length} validated patch artifact(s) at checkpoint ${integration.checkpointId}`,
      ])];
      await this.#publish({
        type: "agent_team_completed",
        sessionId: parent.id,
        at: this.#now(),
        parentAgentId: parent.agent.id,
        teamId,
        operatingModeId: mode.id,
        status,
        changedFiles: [...integration.changedFiles],
        evidence,
        workflow: delegationWorkflowUsage(budget),
      });
      return {
        output: teamOutput(
          teamId,
          status,
          completed,
          integration,
          review,
          reviewFailure,
        ),
        metadata: {
          teamId,
          status,
          operatingModeId: mode.id,
          implementations: publicImplementations(implementations),
          integration,
          review,
          ...(reviewFailure === undefined ? {} : { reviewFailure }),
          workflow: delegationWorkflowUsage(budget),
          changedFiles: [...integration.changedFiles],
          evidence,
        },
      };
    } finally {
      context.signal.removeEventListener("abort", onParentAbort);
      this.#activeParents.delete(parent.agent.id);
    }
  }
}
