import { randomUUID } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  getAgentProfilePolicy,
  getOperatingModePolicy,
  type AgentGitWorktreeWorkspace,
  type AgentProfileId,
  type OperatingModeId,
  type TeamRunBackendRoute,
  type TeamRunDescriptor,
  type TeamRunPolicySnapshot,
  type TeamRunRole,
} from "@recurs/contracts";
import {
  isCredentialPath,
  ToolError,
  type Checkpoint,
  type CheckpointStore,
  type ToolContext,
  type ToolResult,
} from "@recurs/tools";

import {
  repairPrompt,
  type AgentReviewPanel,
  type AgentReviewPanelResultV2,
} from "./agent-review-panel.js";
import {
  childRequestAllowance,
  isDelegationBudgetForAgent,
} from "./agent-profile.js";
import type {
  AgentBackendCandidate,
  AgentBackendRouteDecision,
  AgentBackendRouter,
} from "./agent-backend-router.js";
import type {
  ChildAgentManager,
  ChildDelegationOptions,
  ChildDelegationResult,
  ChildIdentityReservation,
  DelegateTaskInput,
  TeamChildAuthority,
} from "./child-agent-manager.js";
import {
  projectTeamRunActivityEvent,
  type RecursEvent,
} from "./events.js";
import type {
  GitPatchArtifactHandle,
  GitPatchArtifactManager,
  GitPatchBase,
} from "./git-patch-artifacts.js";
import type {
  GitWorktreeLease,
  GitWorktreeLeasePort,
} from "./git-worktree-leases.js";
import type { JsonlSessionStore } from "./jsonl-session-store.js";
import type { JsonlTeamRunStore } from "./jsonl-team-run-store.js";
import { SessionStoreError } from "./session-store-error.js";
import {
  isPinnedSessionState,
  type PinnedSessionState,
} from "./session-v2.js";
import type {
  TeamRunChildRecord,
  TeamRunRecordInput,
  TeamRunState,
} from "./team-run-state.js";
import type {
  DelegateTeamInput,
} from "./team-agent-manager.js";
import { uniqueSortedStrings } from "./stable-order.js";

const MAX_SAFE_TEXT = 16_384;

type TeamRunStatus =
  | "approved"
  | "changes_requested"
  | "unverified"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface TeamRunResultMetadata extends Record<string, unknown> {
  readonly teamId: string;
  readonly status: TeamRunStatus;
  readonly operatingModeId: OperatingModeId;
  readonly repairRounds: number;
  readonly accounting: TeamRunState["accounting"];
  readonly changedFiles: readonly string[];
  readonly evidence: readonly string[];
  readonly failure?: { readonly code: string; readonly message: string };
}

export interface TeamRunResult extends ToolResult {
  readonly metadata: TeamRunResultMetadata;
}

export interface TeamRunSupervisorDependencies {
  readonly sessions: Pick<JsonlSessionStore, "loadState">;
  readonly runs: Pick<JsonlTeamRunStore, "create" | "append" | "load" | "list">;
  readonly children: Pick<
    ChildAgentManager,
    | "authorizeTeamRun"
    | "revokeTeamRunAuthority"
    | "reserveIdentity"
    | "delegate"
  >;
  readonly worktrees: GitWorktreeLeasePort;
  readonly patches: Pick<
    GitPatchArtifactManager,
    | "preflightParent"
    | "capture"
    | "stage"
    | "prepareCandidateApply"
    | "applyCandidate"
    | "completeCandidateApply"
    | "discard"
  >;
  readonly reviews: Pick<AgentReviewPanel, "run">;
  readonly router: AgentBackendRouter;
  readonly checkpoints: CheckpointStore;
  backendCandidates(parent: PinnedSessionState): readonly AgentBackendCandidate[];
  emit(event: RecursEvent): Promise<void>;
  readonly createId?: () => string;
  readonly now?: () => string;
}

interface PreparedRun {
  readonly parent: PinnedSessionState;
  readonly base: GitPatchBase;
  readonly descriptor: TeamRunDescriptor;
  readonly decisions: ReadonlyMap<TeamRunRole, AgentBackendRouteDecision>;
}

interface ReservedChild {
  readonly index: number;
  readonly input: DelegateTaskInput;
  readonly identity: ChildIdentityReservation;
  readonly options: Omit<ChildDelegationOptions, "identity">;
  readonly lease: GitWorktreeLease;
}

interface SettledChild extends ReservedChild {
  readonly result?: ChildDelegationResult;
  readonly error?: unknown;
}

class RunJournal {
  #state: TeamRunState;
  #tail: Promise<void> = Promise.resolve();

  constructor(
    state: TeamRunState,
    private readonly store: TeamRunSupervisorDependencies["runs"],
    private readonly publish: (state: TeamRunState) => Promise<void>,
  ) {
    this.#state = state;
  }

  get state(): TeamRunState {
    return this.#state;
  }

  append(input: TeamRunRecordInput): Promise<TeamRunState> {
    const operation = this.#tail.then(async () => {
      this.#state = await this.store.append(
        this.#state.descriptor.id,
        this.#state.lastSequence,
        input,
      );
      await this.publish(this.#state);
      return this.#state;
    });
    this.#tail = operation.then(() => undefined, () => undefined);
    return operation;
  }
}

function profileFor(role: TeamRunRole): AgentProfileId {
  return role === "implement"
    ? "implement_v2"
    : role === "review"
      ? "review_v2"
      : "repair_v1";
}

function safeFailure(
  error: unknown,
  fallback = "The team operation failed",
): { code: string; message: string } {
  const code = error instanceof ToolError &&
      /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(error.code)
    ? error.code
    : "execution_failed";
  const raw = error instanceof ToolError ? error.message : fallback;
  const message = raw.trim().length === 0 ? fallback : raw.trim();
  return {
    code,
    message: truncateUtf8(message, MAX_SAFE_TEXT),
  };
}

function truncateUtf8(value: string, maximum: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximum) return value;
  const suffix = " [truncated]";
  const limit = maximum - Buffer.byteLength(suffix, "utf8");
  let result = "";
  let used = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (used + bytes > limit) break;
    result += character;
    used += bytes;
  }
  return `${result.trimEnd()}${suffix}`;
}

function uniqueSorted(values: readonly string[]): string[] {
  return uniqueSortedStrings(values);
}

function sameCandidateContent(
  left: GitPatchArtifactHandle,
  right: GitPatchArtifactHandle,
): boolean {
  return left.baseRevision === right.baseRevision &&
    left.sha256 === right.sha256 && left.byteLength === right.byteLength &&
    isDeepStrictEqual(left.paths, right.paths);
}

function safeTeamPath(value: string): boolean {
  if (Buffer.byteLength(value, "utf8") === 0 ||
    Buffer.byteLength(value, "utf8") > 4_096 || path.isAbsolute(value) ||
    value.includes("\\") || value.includes("\0") || isCredentialPath(value)) {
    return false;
  }
  return value.split("/").every((part) =>
    part.length > 0 && part !== "." && part !== ".." &&
    ![...part].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || (code >= 127 && code <= 159);
    })
  );
}

function exactTeamPaths(values: readonly string[]): string[] | null {
  const normalized = uniqueSorted(values);
  return normalized.length <= 256 &&
      normalized.length === values.length && normalized.every(safeTeamPath)
    ? normalized
    : null;
}

function boundedTeamEvidence(values: readonly string[]): string[] {
  return uniqueSorted(values)
    .filter((value) => value.trim().length > 0)
    .slice(0, 64)
    .map((value) => truncateUtf8(value.trim(), MAX_SAFE_TEXT));
}

function reviewEvidence(review: AgentReviewPanelResultV2): string[] {
  const evidence = [...review.evidence];
  for (const record of review.reviews) {
    if (record.status === "invalid") {
      evidence.push(`Reviewer ${record.index}: invalid_review`);
    } else if (record.status === "failed") {
      evidence.push(`Reviewer ${record.index}: ${record.error.code}`);
    }
  }
  return boundedTeamEvidence(evidence);
}

function checkpointReference(checkpoint: Checkpoint) {
  return {
    id: checkpoint.id,
    sessionId: checkpoint.sessionId,
    toolCallId: checkpoint.toolCallId,
  };
}

function workspace(lease: GitWorktreeLease): AgentGitWorktreeWorkspace {
  return {
    kind: "git_worktree",
    version: 1,
    leaseId: lease.id,
    repositoryRoot: lease.repositoryRoot,
    worktreeRoot: lease.worktreeRoot,
    revision: lease.revision,
  };
}

function serializedRoute(
  role: TeamRunRole,
  decision: AgentBackendRouteDecision,
): TeamRunBackendRoute {
  return {
    role,
    profileId: profileFor(role),
    executionMode: decision.executionMode,
    permissionMode: decision.permissionMode,
    strategy: decision.strategy,
    candidateId: decision.candidateId,
    reason: decision.reason,
    pin: structuredClone(decision.pin),
  };
}

function resultFromState(
  state: TeamRunState,
  evidence: readonly string[],
): TeamRunResult {
  const failure = state.outcome?.failure ?? undefined;
  return {
    output: failure === undefined
      ? `Team ${state.descriptor.id}: ${state.status}`
      : `Team ${state.descriptor.id}: ${state.status} — ${failure.message}`,
    metadata: {
      teamId: state.descriptor.id,
      status: state.status as TeamRunStatus,
      operatingModeId: state.descriptor.operatingModeId,
      repairRounds: state.reviews.reduce(
        (maximum, review) => Math.max(maximum, review.round),
        0,
      ),
      accounting: state.accounting,
      changedFiles: state.status === "approved"
        ? [...(state.candidate?.changedFiles ?? [])]
        : [],
      evidence: boundedTeamEvidence(evidence),
      ...(failure === undefined ? {} : { failure }),
    },
  };
}

export class TeamRunSupervisor {
  readonly #createId: () => string;
  readonly #now: () => string;
  readonly #activeParents = new Set<string>();

  constructor(private readonly dependencies: TeamRunSupervisorDependencies) {
    this.#createId = dependencies.createId ?? randomUUID;
    this.#now = dependencies.now ?? (() => new Date().toISOString());
  }

  async #publish(state: TeamRunState): Promise<void> {
    try {
      await this.dependencies.emit(projectTeamRunActivityEvent(state));
    } catch {
      // The sequenced team journal is authoritative; presentation is best effort.
    }
  }

  async #prepare(
    input: DelegateTeamInput,
    context: ToolContext,
  ): Promise<PreparedRun> {
    if (context.signal.aborted) {
      throw new ToolError("cancelled", "Team delegation was cancelled");
    }
    if (context.executionMode !== "act") {
      throw new ToolError("plan_mode_denied", "Team implementation requires an Act parent");
    }
    const parent = await this.dependencies.sessions.loadState(context.sessionId);
    if (!isPinnedSessionState(parent) || parent.agent.role !== "parent" ||
      parent.cwd !== context.cwd) {
      throw new ToolError("tool_unavailable", "Parent agent session is unavailable");
    }
    const mode = getOperatingModePolicy(parent.agent.operatingMode.id);
    const team = mode.workflow.team;
    if (mode.version !== 4 || team === null) {
      throw new ToolError(
        "tool_unavailable",
        "Durable team execution requires an exact version-4 operating policy",
      );
    }
    if (input.tasks.length < 1 || input.tasks.length > team.maxImplementers) {
      throw new ToolError(
        "permission_denied",
        `${mode.displayName} mode supports at most ${team.maxImplementers} Implement workers`,
      );
    }
    if (context.runContext === undefined) {
      throw new ToolError("tool_unavailable", "Trusted run context is unavailable");
    }
    const budget = context.delegationBudget;
    if (budget === undefined || !isDelegationBudgetForAgent(budget, parent.agent)) {
      throw new ToolError("tool_unavailable", "Trusted delegation budget is unavailable");
    }
    if (budget.childrenStarted !== 0 || budget.requestsReserved !== 0 ||
      budget.requestsUsed !== 0 || budget.reportedCostUsd !== 0) {
      throw new ToolError(
        "permission_denied",
        "Durable team execution requires the complete frozen run budget",
      );
    }
    const base = await this.dependencies.patches.preflightParent(
      parent.cwd,
      context.signal,
    );
    if (base.repositoryRoot !== parent.cwd) {
      throw new ToolError("permission_denied", "Team base does not match the parent workspace");
    }
    const candidates = this.dependencies.backendCandidates(parent);
    const decisions = new Map<TeamRunRole, AgentBackendRouteDecision>();
    for (const role of ["implement", "review", "repair"] as const) {
      decisions.set(role, this.dependencies.router.select({
        role,
        executionMode: "act",
        permissionMode: parent.permissionMode,
        background: false,
        candidates,
      }));
    }
    const runId = this.#createId();
    const policy = structuredClone(mode) as TeamRunPolicySnapshot;
    const descriptor: TeamRunDescriptor = {
      id: runId,
      version: 1,
      parentSessionId: parent.id,
      parentAgentId: parent.agent.id,
      execution: "foreground",
      parentExecutionMode: "act",
      parentPermissionMode: parent.permissionMode,
      invocation: structuredClone(context.runContext),
      operatingModeId: mode.id,
      operatingModeVersion: mode.version,
      policy,
      allocation: {
        maxChildren: mode.workflow.maxChildrenPerRun,
        maxRequests: mode.workflow.maxRequestsPerRun,
        requestAllowance: childRequestAllowance(parent.agent),
        maxReportedCostUsd: mode.orchestration.maxReportedCostUsd,
      },
      routes: (["implement", "review", "repair"] as const).map((role) =>
        serializedRoute(role, decisions.get(role)!)
      ),
      backend: structuredClone(parent.backend.pin),
      repositoryRoot: base.repositoryRoot,
      baseRevision: base.revision,
      request: structuredClone(input),
    };
    return { parent, base, descriptor, decisions };
  }

  async preflight(input: DelegateTeamInput, context: ToolContext): Promise<void> {
    await this.#prepare(input, context);
  }

  #exactCompletedChild(
    state: PinnedSessionState,
    reserved: ReservedChild,
    descriptor: TeamRunDescriptor,
    parentDepth: number,
    result: ChildDelegationResult,
    requestsUsed: number,
  ): boolean {
    const profile = getAgentProfilePolicy(reserved.input.profile);
    const decision = reserved.options.backend?.decision;
    const team = reserved.options.team;
    const workspaceBinding = reserved.options.workspace;
    const mode = reserved.options.teamOperatingMode;
    const permissions = reserved.options.teamParentPermissions;
    if (decision === undefined || team === undefined || !("runId" in team) ||
      workspaceBinding === undefined || mode === undefined ||
      permissions === undefined || state.agent.role !== "child" ||
      state.agentResult === null || state.agentLifecycle.status !== "completed") {
      return false;
    }
    const expectedBackend = {
      strategy: "policy_route" as const,
      candidateId: decision.candidateId,
      reason: decision.reason,
      adapterId: decision.pin.adapterId,
      connectionId: decision.pin.connectionId,
      modelId: decision.pin.modelId,
    };
    const durable = state.agentResult;
    return state.id === reserved.identity.childSessionId &&
      state.cwd === reserved.options.cwd &&
      isDeepStrictEqual(state.backend.pin, decision.pin) &&
      state.agent.id === reserved.identity.childAgentId &&
      state.agent.parentSessionId === descriptor.parentSessionId &&
      state.agent.parentAgentId === descriptor.parentAgentId &&
      state.agent.depth === parentDepth + 1 &&
      isDeepStrictEqual(state.agent.profile, {
        id: profile.id,
        version: profile.version,
      }) &&
      isDeepStrictEqual(state.agent.task, {
        id: reserved.identity.taskId,
        description: reserved.input.description,
        prompt: reserved.input.prompt,
      }) &&
      isDeepStrictEqual(state.agent.operatingMode, mode) &&
      isDeepStrictEqual(state.agent.backend, expectedBackend) &&
      isDeepStrictEqual(state.agent.permissions, {
        parentExecutionMode: permissions.executionMode,
        executionMode: profile.executionMode,
        parentPermissionMode: permissions.permissionMode,
        permissionMode: permissions.permissionMode,
      }) &&
      isDeepStrictEqual(state.agent.limits, {
        ...descriptor.policy.orchestration,
        maxRequests: descriptor.allocation.requestAllowance,
      }) &&
      isDeepStrictEqual(state.agent.workspace, workspaceBinding) &&
      isDeepStrictEqual(state.agent.team, team) &&
      result.output === durable.finalText &&
      result.metadata.childAgentId === reserved.identity.childAgentId &&
      result.metadata.childSessionId === reserved.identity.childSessionId &&
      result.metadata.taskId === reserved.identity.taskId &&
      result.metadata.attempts === 1 && result.metadata.retries === 0 &&
      result.metadata.profileId === profile.id &&
      result.metadata.operatingModeId === mode.id &&
      result.metadata.requestsUsed === requestsUsed &&
      isDeepStrictEqual(result.metadata.usage, durable.usage) &&
      result.metadata.usageSource === durable.usageSource &&
      result.metadata.evidenceSource === durable.evidenceSource &&
      isDeepStrictEqual(result.metadata.changedFiles, durable.changedFiles) &&
      isDeepStrictEqual(result.metadata.evidence, durable.evidence) &&
      isDeepStrictEqual(result.metadata.workspace, workspaceBinding) &&
      result.metadata.teamId === team.runId &&
      result.metadata.teamIndex === team.taskIndex;
  }

  async #childRecord(
    reserved: ReservedChild,
    result: ChildDelegationResult | undefined,
    error: unknown,
    requestAllowance: number,
    descriptor: TeamRunDescriptor,
    parentDepth: number,
  ): Promise<TeamRunChildRecord> {
    let state: Awaited<ReturnType<JsonlSessionStore["loadState"]>> | undefined;
    try {
      state = await this.dependencies.sessions.loadState(
        reserved.identity.childSessionId,
      );
    } catch (loadError) {
      if (!(loadError instanceof SessionStoreError) ||
        loadError.code !== "session_not_found") {
        throw loadError;
      }
    }
    const attemptId = (reserved.options.team as { attemptId: string }).attemptId;
    if (state !== undefined && isPinnedSessionState(state) &&
      state.agent.role === "child" && state.agentResult !== null &&
      state.agentLifecycle.status === "completed" && result !== undefined) {
      const requestsUsed = state.agentResult.steps === null
        ? requestAllowance
        : Math.min(requestAllowance, state.agentResult.steps);
      const changedFiles = exactTeamPaths(state.agentResult.changedFiles);
      if (changedFiles !== null && this.#exactCompletedChild(
        state,
        reserved,
        descriptor,
        parentDepth,
        result,
        requestsUsed,
      )) {
        return {
          attemptId,
          status: "completed",
          requestsUsed,
          usage: state.agentResult.usage,
          usageSource: state.agentResult.usageSource,
          changedFiles,
          evidence: boundedTeamEvidence(state.agentResult.evidence),
          failure: null,
        };
      }
      return {
        attemptId,
        status: "failed",
        requestsUsed,
        usage: state.agentResult.usage,
        usageSource: state.agentResult.usageSource,
        changedFiles: [],
        evidence: [],
        failure: {
          code: "invalid_child_result",
          message: "The child result did not match its durable reservation",
        },
      };
    }
    const lifecycle = state !== undefined && isPinnedSessionState(state)
      ? state.agentLifecycle
      : null;
    const cancelled = lifecycle?.status === "cancelled" ||
      (error instanceof ToolError && error.code === "cancelled");
    const failure = lifecycle?.status === "failed"
      ? {
          code: lifecycle.failure.code,
          message: lifecycle.failure.safeMessage,
        }
      : lifecycle?.status === "cancelled"
        ? { code: "cancelled", message: lifecycle.reason }
        : safeFailure(error, "The delegated child failed");
    return {
      attemptId,
      status: cancelled ? "cancelled" : "failed",
      requestsUsed: lifecycle !== null && "turnId" in lifecycle &&
          lifecycle.turnId !== null
        ? requestAllowance
        : 0,
      usage: null,
      usageSource: "unavailable",
      changedFiles: [],
      evidence: [],
      failure,
    };
  }

  async #reserve(
    journal: RunJournal,
    role: TeamRunRole,
    index: number,
    round: number,
    input: DelegateTaskInput,
    lease: GitWorktreeLease,
    decision: AgentBackendRouteDecision,
    context: ToolContext,
    authority: TeamChildAuthority,
  ): Promise<ReservedChild> {
    const attemptId = this.#createId();
    const options = {
      cwd: lease.worktreeRoot,
      workspace: workspace(lease),
      teamExecution: "foreground" as const,
      teamOperatingMode: {
        id: journal.state.descriptor.operatingModeId,
        version: journal.state.descriptor.operatingModeVersion,
      },
      teamParentPermissions: {
        executionMode: journal.state.descriptor.parentExecutionMode,
        permissionMode: journal.state.descriptor.parentPermissionMode,
      },
      teamAuthority: authority,
      backend: { decision },
      team: {
        runId: journal.state.descriptor.id,
        role,
        taskIndex: index,
        round,
        attemptId,
      },
    } satisfies Omit<ChildDelegationOptions, "identity">;
    const identity = this.dependencies.children.reserveIdentity(
      input,
      context,
      options,
    );
    await journal.append({
      type: "child_reserved",
      child: {
        attemptId,
        role,
        index,
        round,
        childAgentId: identity.childAgentId,
        childSessionId: identity.childSessionId,
        requestAllowance: journal.state.descriptor.allocation.requestAllowance,
      },
      at: this.#now(),
    });
    return { index, input, identity, options, lease };
  }

  async #delegateReserved(
    reserved: ReservedChild,
    context: ToolContext,
    signal: AbortSignal,
  ): Promise<SettledChild> {
    try {
      const result = await this.dependencies.children.delegate(
        reserved.input,
        { ...context, signal },
        { ...reserved.options, identity: reserved.identity },
      );
      return { ...reserved, result };
    } catch (error) {
      return { ...reserved, error };
    }
  }

  async #delegateJournaled(
    journal: RunJournal,
    role: "review" | "repair",
    index: number,
    round: number,
    input: DelegateTaskInput,
    lease: GitWorktreeLease,
    decision: AgentBackendRouteDecision,
    context: ToolContext,
    signal: AbortSignal,
    parentDepth: number,
    authority: TeamChildAuthority,
  ): Promise<ChildDelegationResult> {
    const reserved = await this.#reserve(
      journal,
      role,
      index,
      round,
      input,
      lease,
      decision,
      context,
      authority,
    );
    const settled = await this.#delegateReserved(reserved, context, signal);
    const child = await this.#childRecord(
      reserved,
      settled.result,
      settled.error,
      journal.state.descriptor.allocation.requestAllowance,
      journal.state.descriptor,
      parentDepth,
    );
    await journal.append({ type: "child_finished", child, at: this.#now() });
    if (child.status === "completed" && settled.result !== undefined) {
      return settled.result;
    }
    if (child.failure !== null) {
      throw new ToolError("execution_failed", child.failure.message);
    }
    throw settled.error instanceof ToolError
      ? settled.error
      : new ToolError("execution_failed", safeFailure(settled.error).message);
  }

  async #terminal(
    journal: RunJournal,
    status: "changes_requested" | "unverified" | "failed" | "cancelled",
    failure: { code: string; message: string } | null,
    evidence: readonly string[],
  ): Promise<TeamRunResult> {
    await journal.append({
      type: "run_terminal",
      status,
      outcome: { changedFiles: [], evidence: boundedTeamEvidence(evidence), failure },
      at: this.#now(),
    });
    return resultFromState(journal.state, evidence);
  }

  async startForeground(
    input: DelegateTeamInput,
    context: ToolContext,
  ): Promise<TeamRunResult> {
    const prepared = await this.#prepare(input, context);
    const { parent, base, descriptor, decisions } = prepared;
    if (this.#activeParents.has(parent.agent.id)) {
      throw new ToolError("permission_denied", "A team is already active for this parent");
    }
    this.#activeParents.add(parent.agent.id);

    const leases = new Map<string, GitWorktreeLease>();
    const workerArtifacts: GitPatchArtifactHandle[] = [];
    const reviewSnapshots: GitPatchArtifactHandle[] = [];
    let candidate: GitPatchArtifactHandle | undefined;
    let authority: TeamChildAuthority | undefined;
    let journal: RunJournal | undefined;
    let stageLease: GitWorktreeLease | undefined;
    let cancelPromise: Promise<void> | undefined;
    let parentAbortObserved = context.signal.aborted;
    const childrenAbort = new AbortController();
    const evidence: string[] = [];
    const onParentAbort = (): void => {
      parentAbortObserved = true;
      if (journal === undefined || cancelPromise !== undefined) return;
      if (journal.state.apply !== null && !journal.state.apply.committed) {
        childrenAbort.abort();
        return;
      }
      const pending = journal.append({
        type: "cancel_requested",
        reason: "Parent cancelled the team run",
        at: this.#now(),
      }).then(
        () => { childrenAbort.abort(); },
        (error: unknown) => {
          childrenAbort.abort();
          throw error;
        },
      );
      cancelPromise = pending;
      void pending.catch(() => undefined);
    };
    const cancellationBoundary = async (): Promise<void> => {
      if (parentAbortObserved && cancelPromise === undefined) onParentAbort();
      await cancelPromise;
      if (journal?.state.cancellation !== null &&
        journal?.state.cancellation !== undefined) {
        throw new ToolError("cancelled", journal.state.cancellation.reason);
      }
      if (parentAbortObserved) {
        throw new ToolError("cancelled", "Parent cancelled the team run");
      }
    };
    context.signal.addEventListener("abort", onParentAbort, { once: true });

    try {
      const runAuthority = await this.dependencies.children.authorizeTeamRun({
        runId: descriptor.id,
        execution: descriptor.execution,
        operatingMode: {
          id: descriptor.operatingModeId,
          version: descriptor.operatingModeVersion,
        },
        parentPermissions: {
          executionMode: descriptor.parentExecutionMode,
          permissionMode: descriptor.parentPermissionMode,
        },
        repositoryRoot: descriptor.repositoryRoot,
      }, context);
      authority = runAuthority;
      const created = await this.dependencies.runs.create(descriptor, this.#now());
      await this.#publish(created);
      journal = new RunJournal(
        created,
        this.dependencies.runs,
        (state) => this.#publish(state),
      );
      await cancellationBoundary();
      await journal.append({
        type: "run_claimed",
        ownerId: this.#createId(),
        claimEpoch: 1,
        at: this.#now(),
      });
      await cancellationBoundary();
      await journal.append({
        type: "phase_started",
        phase: "implement",
        round: 0,
        at: this.#now(),
      });

      const reservedWorkers: ReservedChild[] = [];
      for (const [offset, task] of input.tasks.entries()) {
        await cancellationBoundary();
        const lease = await this.dependencies.worktrees.create(
          base.repositoryRoot,
          childrenAbort.signal,
        );
        leases.set(lease.id, lease);
        if (lease.repositoryRoot !== base.repositoryRoot ||
          lease.revision !== base.revision) {
          throw new ToolError("permission_denied", "Worker lease does not match the team base");
        }
        reservedWorkers.push(await this.#reserve(
          journal,
          "implement",
          offset + 1,
          0,
          {
            profile: "implement_v2",
            description: task.description,
            prompt: task.prompt,
          },
          lease,
          decisions.get("implement")!,
          context,
          runAuthority,
        ));
      }

      const workerPromises = reservedWorkers.map(async (reserved) => {
        const settled = await this.#delegateReserved(
          reserved,
          context,
          childrenAbort.signal,
        );
        if (settled.error !== undefined &&
          !(settled.error instanceof ToolError && settled.error.code === "cancelled")) {
          childrenAbort.abort();
        }
        return settled;
      });
      const settledWorkers = await Promise.all(workerPromises);
      try {
        await cancellationBoundary();
      } catch (error) {
        if (!(error instanceof ToolError) || error.code !== "cancelled") throw error;
      }

      const failures: Array<{
        index: number;
        failure: { code: string; message: string };
        cancelled: boolean;
      }> = [];
      const completedWorkers: Array<{
        readonly settled: SettledChild;
        readonly child: TeamRunChildRecord;
      }> = [];
      for (const settled of settledWorkers) {
        const child = await this.#childRecord(
          settled,
          settled.result,
          settled.error,
          descriptor.allocation.requestAllowance,
          descriptor,
          parent.agent.depth,
        );
        await journal.append({ type: "child_finished", child, at: this.#now() });
        if (child.status !== "completed") {
          failures.push({
            index: settled.index,
            failure: child.failure!,
            cancelled: child.status === "cancelled",
          });
          continue;
        }
        completedWorkers.push({ settled, child });
        evidence.push(...child.evidence);
      }
      if (journal.state.cancellation !== null) {
        return await this.#terminal(
          journal,
          "cancelled",
          { code: "cancelled", message: journal.state.cancellation.reason },
          evidence,
        );
      }
      if (failures.length > 0) {
        const genuine = failures.filter((failure) => !failure.cancelled)
          .sort((left, right) => left.index - right.index);
        const failure = genuine[0]?.failure ?? {
          code: "execution_failed",
          message: "Team implementation did not complete",
        };
        return await this.#terminal(journal, "failed", failure, evidence);
      }
      for (const { settled, child } of completedWorkers) {
        const artifact = await this.dependencies.patches.capture(
          settled.lease,
          childrenAbort.signal,
        );
        if (artifact === null) {
          throw new ToolError(
            "execution_failed",
            `Implement worker ${settled.index} returned without a patch artifact`,
          );
        }
        workerArtifacts.push(artifact);
        await journal.append({
          type: "artifact_linked",
          artifact: {
            kind: "worker",
            handle: artifact,
            round: 0,
            attemptId: child.attemptId,
          },
          at: this.#now(),
        });
      }
      for (const lease of reservedWorkers.map((item) => item.lease)) {
        await this.dependencies.worktrees.release(lease);
        leases.delete(lease.id);
      }

      await cancellationBoundary();
      await journal.append({
        type: "phase_started",
        phase: "stage",
        round: 0,
        at: this.#now(),
      });
      stageLease = await this.dependencies.worktrees.create(
        base.repositoryRoot,
        childrenAbort.signal,
      );
      leases.set(stageLease.id, stageLease);
      if (stageLease.repositoryRoot !== base.repositoryRoot ||
        stageLease.revision !== base.revision) {
        throw new ToolError("permission_denied", "Staging lease does not match the team base");
      }
      const staged = await this.dependencies.patches.stage({
        lease: stageLease,
        artifacts: workerArtifacts,
        signal: childrenAbort.signal,
      });
      const initialSnapshot = await this.dependencies.patches.capture(
        stageLease,
        childrenAbort.signal,
      );
      if (initialSnapshot === null ||
        !isDeepStrictEqual(initialSnapshot.paths, uniqueSorted(staged.changedFiles))) {
        throw new ToolError(
          "patch_files_mismatch",
          "The staging workspace changed after worker patches were staged",
        );
      }
      reviewSnapshots.push(initialSnapshot);
      let reviewedSnapshot = initialSnapshot;
      let changedFiles = [...reviewedSnapshot.paths];
      let round = 0;
      let review: AgentReviewPanelResultV2;

      for (;;) {
        await cancellationBoundary();
        await journal.append({
          type: "phase_started",
          phase: "review",
          round,
          at: this.#now(),
        });
        const reviewRoute = decisions.get("review")!;
        review = await this.dependencies.reviews.run({
          description: input.description,
          instructions: input.review.instructions,
          changedFiles,
        }, { ...context, signal: childrenAbort.signal }, {
          contract: "v2",
          policy: {
            operatingModeId: descriptor.operatingModeId,
            operatingModeVersion: 4,
            qualityStandard: descriptor.policy.workflow.team.qualityStandard,
            initialReviewers: descriptor.policy.workflow.team.initialReviewers,
            maxReviewers: descriptor.policy.workflow.team.maxReviewers,
          },
          delegateReviewer: (index, childInput) => this.#delegateJournaled(
            journal!,
            "review",
            index,
            round,
            childInput,
            stageLease!,
            reviewRoute,
            context,
            childrenAbort.signal,
            parent.agent.depth,
            runAuthority,
          ),
        });
        await cancellationBoundary();
        const currentReviewEvidence = reviewEvidence(review);
        await journal.append({
          type: "review_recorded",
          review: {
            round,
            verdict: review.verdict,
            findings: review.findings,
            evidence: currentReviewEvidence,
          },
          at: this.#now(),
        });
        evidence.push(...currentReviewEvidence);
        if (review.verdict === "unverified") {
          return await this.#terminal(journal, "unverified", null, evidence);
        }
        if (review.verdict === "approved") break;
        if (round >= descriptor.policy.workflow.team.maxRepairRounds) {
          return await this.#terminal(
            journal,
            "changes_requested",
            null,
            evidence,
          );
        }
        round += 1;
        await cancellationBoundary();
        await journal.append({
          type: "phase_started",
          phase: "repair",
          round,
          at: this.#now(),
        });
        const repair = await this.#delegateJournaled(
          journal,
          "repair",
          1,
          round,
          {
            profile: "repair_v1",
            description: `Repair staged findings (round ${round})`,
            prompt: repairPrompt({
              objective: input.description,
              changedFiles,
              findings: review.findings,
              round,
              maximumRounds: descriptor.policy.workflow.team.maxRepairRounds,
            }),
          },
          stageLease,
          decisions.get("repair")!,
          context,
          childrenAbort.signal,
          parent.agent.depth,
          runAuthority,
        );
        const repairedSnapshot = await this.dependencies.patches.capture(
          stageLease,
          childrenAbort.signal,
        );
        if (repairedSnapshot === null) {
          throw new ToolError(
            "execution_failed",
            "Repair removed the complete staged candidate",
          );
        }
        reviewSnapshots.push(repairedSnapshot);
        reviewedSnapshot = repairedSnapshot;
        changedFiles = [...reviewedSnapshot.paths];
        evidence.push(...repair.metadata.evidence);
      }

      await cancellationBoundary();
      candidate = await this.dependencies.patches.capture(
        stageLease,
        childrenAbort.signal,
      ) ?? undefined;
      if (candidate === undefined) {
        throw new ToolError("execution_failed", "Approved staging produced no candidate");
      }
      if (!sameCandidateContent(reviewedSnapshot, candidate)) {
        throw new ToolError(
          "patch_files_mismatch",
          "The staged candidate changed during independent review",
        );
      }
      await cancellationBoundary();
      await journal.append({
        type: "artifact_linked",
        artifact: {
          kind: "staged_candidate",
          handle: candidate,
          round,
          attemptId: null,
        },
        at: this.#now(),
      });
      await journal.append({
        type: "candidate_ready",
        artifact: candidate,
        changedFiles: candidate.paths,
        at: this.#now(),
      });
      await this.dependencies.patches.discard(workerArtifacts).catch(() => undefined);
      workerArtifacts.length = 0;
      await this.dependencies.worktrees.release(stageLease);
      leases.delete(stageLease.id);
      stageLease = undefined;

      await cancellationBoundary();
      await journal.append({
        type: "phase_started",
        phase: "apply",
        round,
        at: this.#now(),
      });
      const checkpoint = await this.dependencies.patches.prepareCandidateApply({
        base,
        artifact: candidate,
        sessionId: parent.id,
        operationId: descriptor.id,
        checkpoints: this.dependencies.checkpoints,
        signal: childrenAbort.signal,
      });
      await journal.append({
        type: "apply_prepared",
        checkpoint: checkpointReference(checkpoint),
        at: this.#now(),
      });
      await cancellationBoundary();
      const applied = await this.dependencies.patches.applyCandidate({
        base,
        artifact: candidate,
        checkpoint,
        checkpoints: this.dependencies.checkpoints,
        signal: childrenAbort.signal,
      });
      if (!isDeepStrictEqual(applied.changedFiles, candidate.paths)) {
        throw new ToolError(
          "patch_files_mismatch",
          "Applied candidate paths do not match the durable artifact",
        );
      }
      const completed = await this.dependencies.patches.completeCandidateApply({
        base,
        artifact: candidate,
        checkpoint,
        checkpoints: this.dependencies.checkpoints,
        signal: childrenAbort.signal,
      });
      if (!isDeepStrictEqual(completed.changedFiles, candidate.paths)) {
        throw new ToolError(
          "patch_files_mismatch",
          "Completed candidate paths do not match the durable artifact",
        );
      }
      await journal.append({
        type: "apply_committed",
        checkpoint: checkpointReference(completed.checkpoint),
        changedFiles: applied.changedFiles,
        at: this.#now(),
      });
      await this.dependencies.patches.discard([candidate]).catch(() => undefined);
      candidate = undefined;
      return resultFromState(journal.state, evidence);
    } catch (error) {
      if (journal === undefined) throw error;
      if (journal.state.apply !== null && !journal.state.apply.committed) {
        try {
          await journal.append({
            type: "run_interrupted",
            reason: safeFailure(error).message,
            manualAttentionRequired: true,
            at: this.#now(),
          });
          return resultFromState(journal.state, evidence);
        } catch {
          throw error;
        }
      }
      if (journal.state.status === "approved" ||
        journal.state.status === "changes_requested" ||
        journal.state.status === "unverified" ||
        journal.state.status === "failed" ||
        journal.state.status === "cancelled") {
        return resultFromState(journal.state, evidence);
      }
      if (journal.state.cancellation !== null) {
        return await this.#terminal(
          journal,
          "cancelled",
          { code: "cancelled", message: journal.state.cancellation.reason },
          evidence,
        );
      }
      const failure = safeFailure(error);
      return await this.#terminal(journal, "failed", failure, evidence);
    } finally {
      context.signal.removeEventListener("abort", onParentAbort);
      childrenAbort.abort();
      await Promise.all([...leases.values()].map(async (lease) => {
        try {
          await this.dependencies.worktrees.release(lease);
        } catch {
          // Durable journal truth is preserved; stale owned leases recover later.
        }
      }));
      if (journal !== undefined && journal.state.status !== "approved") {
        const retainPreparedCandidate = journal.state.apply !== null &&
          !journal.state.apply.committed;
        const artifacts = [
          ...workerArtifacts,
          ...(candidate === undefined || retainPreparedCandidate ? [] : [candidate]),
        ];
        if (artifacts.length > 0) {
          await this.dependencies.patches.discard(artifacts).catch(() => undefined);
        }
      }
      if (reviewSnapshots.length > 0) {
        await this.dependencies.patches.discard(reviewSnapshots).catch(() => undefined);
      }
      this.#activeParents.delete(parent.agent.id);
      if (authority !== undefined) {
        this.dependencies.children.revokeTeamRunAuthority(authority);
      }
    }
  }
}
