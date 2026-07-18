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
  type TeamRunExecution,
  type TeamRunPolicySnapshot,
  type TeamRunRole,
} from "@recurs/contracts";
import {
  isCredentialPath,
  permissionIntentKey,
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
import { teamChildAssignmentSha256 } from "./team-child-binding.js";
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
import type {
  JsonlTeamRunStore,
  TeamRunListEntry,
} from "./jsonl-team-run-store.js";
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
  TeamRunOwnerLease,
  TeamRunOwnerLeaseManager,
} from "./team-run-owner-lease.js";
import type {
  DelegateTeamInput,
} from "./team-agent-manager.js";
import { uniqueSortedStrings } from "./stable-order.js";

const MAX_SAFE_TEXT = 16_384;

export interface TeamRunResultMetadata extends Record<string, unknown> {
  readonly teamId: string;
  readonly status: TeamRunState["status"];
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

export interface TeamRunSnapshot {
  readonly id: string;
  readonly execution: TeamRunExecution;
  readonly operatingModeId: OperatingModeId;
  readonly status: TeamRunState["status"];
  readonly phase: TeamRunState["phase"];
  readonly round: number;
  readonly childrenReserved: number;
  readonly childrenFinished: number;
  readonly usage: TeamRunState["accounting"]["usage"];
  readonly reportedCostUsd: number | null;
  readonly costCoverage: TeamRunState["accounting"]["costCoverage"];
  readonly manualAttentionRequired: boolean;
  readonly updatedAt: string;
}

export interface TeamRunWaitResult {
  readonly snapshot: TeamRunSnapshot;
  readonly timedOut: boolean;
}

export interface TeamRunCancelResult {
  readonly result: "requested" | "already_terminal";
  readonly snapshot: TeamRunSnapshot;
}

export interface TeamRunResumeResult {
  readonly result: "started" | "already_active";
  readonly snapshot: TeamRunSnapshot;
}

export const TEAM_APPLY_PERMISSION = Object.freeze({
  category: "write" as const,
  resource: "team candidate apply",
  risk: "elevated" as const,
});

export interface TeamRunSupervisorDependencies {
  readonly sessions: Pick<JsonlSessionStore, "loadState">;
  readonly runs: Pick<JsonlTeamRunStore, "create" | "append" | "load" | "list">;
  readonly owners: Pick<TeamRunOwnerLeaseManager, "tryAcquire">;
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

interface ClaimedRunHooks {
  readonly execution: TeamRunExecution;
  readonly applyWhenReady: boolean;
  readonly resumeState?: TeamRunState;
  readonly onClaimed?: (
    journal: RunJournal,
    requestCancel: (reason: string) => Promise<void>,
  ) => void;
  readonly onStarted?: (state: TeamRunState) => void;
}

interface ActiveTeamRun {
  readonly parentSessionId: string;
  readonly ownerId: string;
  readonly controller: AbortController;
  readonly settled: Promise<void>;
  readonly requestCancel: (reason: string) => Promise<void>;
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
    private readonly assertOwned: () => Promise<void>,
  ) {
    this.#state = state;
  }

  get state(): TeamRunState {
    return this.#state;
  }

  append(input: TeamRunRecordInput): Promise<TeamRunState> {
    const operation = this.#tail.then(async () => {
      await this.assertOwned();
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
      status: state.status,
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

function snapshotFromListEntry(entry: TeamRunListEntry): TeamRunSnapshot {
  return Object.freeze({
    id: entry.id,
    execution: entry.execution,
    operatingModeId: entry.operatingModeId,
    status: entry.status,
    phase: entry.phase,
    round: entry.round,
    childrenReserved: entry.childrenReserved,
    childrenFinished: entry.childrenFinished,
    usage: entry.usage === null ? null : Object.freeze({ ...entry.usage }),
    reportedCostUsd: entry.reportedCostUsd,
    costCoverage: entry.costCoverage,
    manualAttentionRequired: entry.manualAttentionRequired,
    updatedAt: entry.updatedAt,
  });
}

function snapshotFromState(state: TeamRunState): TeamRunSnapshot {
  return Object.freeze({
    id: state.descriptor.id,
    execution: state.descriptor.execution,
    operatingModeId: state.descriptor.operatingModeId,
    status: state.status,
    phase: state.phase,
    round: state.round,
    childrenReserved: state.accounting.childrenReserved,
    childrenFinished: state.accounting.childrenFinished,
    usage: state.accounting.usage === null
      ? null
      : Object.freeze({ ...state.accounting.usage }),
    reportedCostUsd: state.accounting.reportedCostUsd,
    costCoverage: state.accounting.costCoverage,
    manualAttentionRequired:
      state.interruption?.manualAttentionRequired === true,
    updatedAt: state.updatedAt,
  });
}

function durableEvidence(state: TeamRunState): string[] {
  const claimEpoch = state.claim?.claimEpoch;
  return boundedTeamEvidence([
    ...state.children.flatMap((child) =>
      child.reservation.claimEpoch === claimEpoch
        ? child.result?.evidence ?? []
        : []
    ),
    ...state.reviews.flatMap((review) =>
      review.claimEpoch === claimEpoch ? review.evidence : []
    ),
  ]);
}

function reserveDetachedBudget(
  budget: NonNullable<ToolContext["delegationBudget"]>,
  state: TeamRunState,
): void {
  const expectedCost = state.accounting.reportedCostUsd ?? 0;
  if (budget.maxChildren !== state.descriptor.allocation.maxChildren ||
    budget.maxRequests !== state.descriptor.allocation.maxRequests ||
    budget.maxReportedCostUsd !==
      state.descriptor.allocation.maxReportedCostUsd ||
    budget.childrenStarted !== state.accounting.childrenReserved ||
    budget.requestsReserved !== state.accounting.requestsReserved ||
    budget.requestsUsed !== state.accounting.requestsUsed ||
    budget.reportedCostUsd !== expectedCost) {
    throw new ToolError(
      "permission_denied",
      "The parent delegation budget changed before background ownership",
    );
  }
  budget.childrenStarted = budget.maxChildren;
  budget.requestsReserved = budget.maxRequests;
}

function syncDetachedBudget(
  budget: NonNullable<ToolContext["delegationBudget"]>,
  accounting: TeamRunState["accounting"],
): void {
  budget.requestsUsed = Math.max(budget.requestsUsed, accounting.requestsUsed);
  if (accounting.reportedCostUsd !== null) {
    budget.reportedCostUsd = Math.max(
      budget.reportedCostUsd,
      accounting.reportedCostUsd,
    );
  }
}

function terminalStatus(status: TeamRunState["status"]): boolean {
  return status === "approved" || status === "changes_requested" ||
    status === "unverified" || status === "failed" || status === "cancelled";
}

function waitSettledStatus(status: TeamRunState["status"]): boolean {
  return terminalStatus(status) || status === "ready_to_apply" ||
    status === "interrupted";
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function boundedWait(
  promise: Promise<void>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) throw new ToolError("cancelled", "Team wait was cancelled");
  if (timeoutMs === 0) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const cancelledWait = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new ToolError("cancelled", "Team wait was cancelled"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([promise.then(() => true as const), timeout, cancelledWait]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abort !== undefined) signal.removeEventListener("abort", abort);
  }
}

export class TeamRunSupervisor {
  readonly #createId: () => string;
  readonly #now: () => string;
  readonly #activeParents = new Set<string>();
  readonly #active = new Map<string, ActiveTeamRun>();

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

  async #acquireOwner(
    runId: string,
    parentSessionId: string,
  ): Promise<TeamRunOwnerLease> {
    const ownership = await this.dependencies.owners.tryAcquire(
      runId,
      parentSessionId,
    );
    if (ownership.status === "busy") {
      throw new ToolError(
        "permission_denied",
        "Team run is owned by another live process",
      );
    }
    return ownership.lease;
  }

  async #prepare(
    input: DelegateTeamInput,
    context: ToolContext,
    execution: TeamRunExecution,
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
    if (execution === "background" && (
      parent.permissionMode !== "full_access" ||
      parent.backend.pin.kind !== "model_provider" ||
      context.runContext.invocation === "one_shot" ||
      context.runContext.presence !== "present" ||
      context.runContext.location !== "local" ||
      context.runContext.automation !== "manual"
    )) {
      throw new ToolError(
        "permission_denied",
        "Background teams require a local, manual, user-present CLI session in Full Access",
      );
    }
    const unresolved = (await this.dependencies.runs.list(parent.id)).find((run) =>
      !terminalStatus(run.status)
    );
    if (unresolved !== undefined) {
      throw new ToolError(
        "permission_denied",
        `Parent already has an unresolved team run (${unresolved.id})`,
      );
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
        background: execution === "background",
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
      execution,
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
      request: {
        description: input.description,
        tasks: structuredClone(input.tasks),
        review: structuredClone(input.review),
      },
    };
    return { parent, base, descriptor, decisions };
  }

  async preflight(input: DelegateTeamInput, context: ToolContext): Promise<void> {
    await this.#prepare(input, context, input.execution ?? "foreground");
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
      teamExecution: journal.state.descriptor.execution,
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
        taskId: identity.taskId,
        workspaceLeaseId: lease.id,
        assignmentSha256: teamChildAssignmentSha256(
          input.profile,
          input.description,
          input.prompt,
        ),
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

  async #prepareResume(
    state: TeamRunState,
    context: ToolContext,
  ): Promise<PreparedRun> {
    if (state.status !== "interrupted" ||
      state.interruption?.manualAttentionRequired !== false ||
      state.descriptor.execution !== "background" ||
      state.cancellation !== null || state.apply !== null) {
      throw new ToolError("permission_denied", "Team run is not safely resumable");
    }
    const parent = await this.#controlParent(state, context, true);
    const base = await this.dependencies.patches.preflightParent(
      parent.cwd,
      context.signal,
    );
    if (!isDeepStrictEqual(base, {
      repositoryRoot: state.descriptor.repositoryRoot,
      revision: state.descriptor.baseRevision,
    })) {
      throw new ToolError("permission_denied", "Team parent base revision changed");
    }
    const team = state.descriptor.policy.workflow.team;
    const remainingChildren = state.descriptor.allocation.maxChildren -
      state.accounting.childrenReserved;
    const requiredChildren = state.descriptor.request.tasks.length +
      (team.maxRepairRounds + 1) * team.maxReviewers +
      team.maxRepairRounds;
    const remainingRequests = state.descriptor.allocation.maxRequests -
      state.accounting.requestsReserved;
    if (remainingChildren < requiredChildren || remainingRequests <
      requiredChildren * state.descriptor.allocation.requestAllowance ||
      (state.accounting.reportedCostUsd !== null &&
        state.accounting.reportedCostUsd >=
          state.descriptor.allocation.maxReportedCostUsd)) {
      throw new ToolError(
        "permission_denied",
        "Team run does not have enough frozen budget for a safe resume",
      );
    }
    const candidates = this.dependencies.backendCandidates(parent);
    const decisions = new Map<TeamRunRole, AgentBackendRouteDecision>();
    for (const role of ["implement", "review", "repair"] as const) {
      const decision = this.dependencies.router.select({
        role,
        executionMode: "act",
        permissionMode: state.descriptor.parentPermissionMode,
        background: true,
        candidates,
      });
      const frozen = state.descriptor.routes.find((route) => route.role === role);
      if (frozen === undefined ||
        !isDeepStrictEqual(serializedRoute(role, decision), frozen)) {
        throw new ToolError(
          "permission_denied",
          "Fresh team routing no longer matches the frozen run",
        );
      }
      decisions.set(role, decision);
    }
    return {
      parent,
      base,
      descriptor: state.descriptor,
      decisions,
    };
  }

  async #run(
    input: DelegateTeamInput,
    context: ToolContext,
    hooks: ClaimedRunHooks,
  ): Promise<TeamRunResult> {
    const prepared = hooks.resumeState === undefined
      ? await this.#prepare(input, context, hooks.execution)
      : await this.#prepareResume(hooks.resumeState, context);
    const { parent, base, descriptor, decisions } = prepared;
    if (this.#activeParents.has(parent.agent.id)) {
      throw new ToolError("permission_denied", "A team is already active for this parent");
    }
    const owner = await this.#acquireOwner(descriptor.id, parent.id);
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
    const requestCancellation = (reason: string): Promise<void> => {
      parentAbortObserved = true;
      if (journal === undefined) return Promise.resolve();
      if (cancelPromise !== undefined) return cancelPromise;
      if (journal.state.cancellation !== null || terminalStatus(journal.state.status)) {
        childrenAbort.abort();
        return Promise.resolve();
      }
      if (journal.state.apply !== null && !journal.state.apply.committed) {
        childrenAbort.abort();
        return Promise.resolve();
      }
      const pending = journal.append({
        type: "cancel_requested",
        reason: truncateUtf8(reason.trim() || "Team run cancelled", MAX_SAFE_TEXT),
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
      return pending;
    };
    const onParentAbort = (): void => {
      void requestCancellation("Parent cancelled the team run").catch(() => undefined);
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
      await owner.assertOwned();
      const resumedRunId = hooks.resumeState?.descriptor.id;
      const conflicting = (await this.dependencies.runs.list(parent.id)).find((run) =>
        !terminalStatus(run.status) && run.id !== resumedRunId
      );
      if (conflicting !== undefined) {
        throw new ToolError(
          "permission_denied",
          `Parent already has an unresolved team run (${conflicting.id})`,
        );
      }
      let resumedState = hooks.resumeState;
      if (resumedState !== undefined) {
        const current = await this.dependencies.runs.load(descriptor.id);
        if (current.lastSequence !== resumedState.lastSequence) {
          throw new ToolError(
            "permission_denied",
            "Team run changed while ownership was being acquired",
          );
        }
        resumedState = current;
      }
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
      await owner.assertOwned();
      const created = resumedState ??
        await this.dependencies.runs.create(descriptor, this.#now());
      if (resumedState === undefined) await this.#publish(created);
      journal = new RunJournal(
        created,
        this.dependencies.runs,
        (state) => this.#publish(state),
        () => owner.assertOwned(),
      );
      await cancellationBoundary();
      await journal.append({
        type: "run_claimed",
        ownerId: owner.ownerId,
        claimEpoch: resumedState === undefined
          ? 1
          : (resumedState.claim?.claimEpoch ?? 0) + 1,
        at: this.#now(),
      });
      hooks.onClaimed?.(journal, requestCancellation);
      await cancellationBoundary();
      await journal.append({
        type: "phase_started",
        phase: "implement",
        round: 0,
        at: this.#now(),
      });
      hooks.onStarted?.(journal.state);

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
      await cancellationBoundary();
      await this.dependencies.patches.discard(workerArtifacts).catch(() => undefined);
      workerArtifacts.length = 0;
      await this.dependencies.worktrees.release(stageLease);
      leases.delete(stageLease.id);
      stageLease = undefined;

      if (!hooks.applyWhenReady) {
        return resultFromState(journal.state, evidence);
      }

      await cancellationBoundary();
      const checkpoint = await this.dependencies.patches.prepareCandidateApply({
        base,
        artifact: candidate,
        sessionId: parent.id,
        operationId: descriptor.id,
        checkpoints: this.dependencies.checkpoints,
        signal: childrenAbort.signal,
      });
      await journal.append({
        type: "phase_started",
        phase: "apply",
        round,
        at: this.#now(),
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
      if (journal.state.status === "applying" && journal.state.apply === null) {
        try {
          await journal.append({
            type: "apply_reset",
            reason: "clean_base",
            at: this.#now(),
          });
          return resultFromState(journal.state, evidence);
        } catch {
          throw error;
        }
      }
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
      if (journal.state.status === "ready_to_apply") {
        return resultFromState(journal.state, evidence);
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
        const retainPreparedCandidate = journal.state.status === "ready_to_apply" ||
          (journal.state.apply !== null && !journal.state.apply.committed);
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
      try {
        if (authority !== undefined) {
          this.dependencies.children.revokeTeamRunAuthority(authority);
        }
      } finally {
        await owner.release();
      }
    }
  }

  startForeground(
    input: DelegateTeamInput,
    context: ToolContext,
  ): Promise<TeamRunResult> {
    return this.#run(input, context, {
      execution: "foreground",
      applyWhenReady: true,
    });
  }

  async #launchBackground(
    input: DelegateTeamInput,
    context: ToolContext,
    resumeState?: TeamRunState,
  ): Promise<TeamRunResult> {
    const controller = new AbortController();
    const initiatingBudget = context.delegationBudget;
    const backgroundBudget = initiatingBudget === undefined
      ? undefined
      : { ...initiatingBudget };
    const onInitiatorAbort = (): void => controller.abort();
    if (context.signal.aborted) controller.abort();
    else context.signal.addEventListener("abort", onInitiatorAbort, { once: true });
    const backgroundContext: ToolContext = {
      ...context,
      signal: controller.signal,
      ...(backgroundBudget === undefined
        ? {}
        : { delegationBudget: backgroundBudget }),
    };
    const started = deferred<TeamRunState>();
    const completion = deferred<void>();
    let runId: string | undefined;
    let budgetReserved = false;
    const run = this.#run(input, backgroundContext, {
      execution: "background",
      applyWhenReady: false,
      ...(resumeState === undefined ? {} : { resumeState }),
      onClaimed: (journal, requestCancel) => {
        context.signal.removeEventListener("abort", onInitiatorAbort);
        runId = journal.state.descriptor.id;
        const ownerId = journal.state.claim?.ownerId;
        if (ownerId === undefined) {
          throw new ToolError("execution_failed", "Background team claim is unavailable");
        }
        if (initiatingBudget !== undefined) {
          reserveDetachedBudget(initiatingBudget, journal.state);
          budgetReserved = true;
        }
        this.#active.set(runId, {
          parentSessionId: journal.state.descriptor.parentSessionId,
          ownerId,
          controller,
          settled: completion.promise,
          requestCancel,
        });
      },
      onStarted: (state) => started.resolve(state),
    });
    const tracked = run.then((result) => {
      if (budgetReserved && initiatingBudget !== undefined) {
        syncDetachedBudget(initiatingBudget, result.metadata.accounting);
      }
      return result;
    });
    const settled = tracked.then(() => undefined, () => undefined).finally(() => {
      context.signal.removeEventListener("abort", onInitiatorAbort);
      if (runId !== undefined) this.#active.delete(runId);
      completion.resolve();
    });
    void settled;
    return await Promise.race([
      started.promise.then((state) => resultFromState(state, [])),
      tracked,
    ]);
  }

  startBackground(
    input: DelegateTeamInput,
    context: ToolContext,
  ): Promise<TeamRunResult> {
    return this.#launchBackground(input, context);
  }

  async list(parentSessionId: string): Promise<readonly TeamRunSnapshot[]> {
    return Object.freeze(
      (await this.dependencies.runs.list(parentSessionId))
        .map(snapshotFromListEntry),
    );
  }

  async status(
    parentSessionId: string,
    runId: string,
  ): Promise<TeamRunSnapshot> {
    return snapshotFromState(await this.#ownedState(parentSessionId, runId));
  }

  async wait(
    parentSessionId: string,
    runId: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<TeamRunWaitResult> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 30_000) {
      throw new ToolError("invalid_input", "Team wait must be between 0 and 30000 ms");
    }
    const before = await this.status(parentSessionId, runId);
    if (waitSettledStatus(before.status)) {
      if (before.status !== "ready_to_apply") {
        return Object.freeze({ snapshot: before, timedOut: false });
      }
      const readyState = await this.#ownedState(parentSessionId, runId);
      if (readyState.cancellation === null) {
        return Object.freeze({ snapshot: before, timedOut: false });
      }
    }
    const active = this.#active.get(runId);
    if (active === undefined || active.parentSessionId !== parentSessionId) {
      return Object.freeze({ snapshot: before, timedOut: true });
    }
    const durable = await this.#ownedState(parentSessionId, runId);
    if (active.ownerId !== durable.claim?.ownerId) {
      throw new ToolError("permission_denied", "Active team ownership is stale");
    }
    const settledInTime = await boundedWait(active.settled, timeoutMs, signal);
    return Object.freeze({
      snapshot: await this.status(parentSessionId, runId),
      timedOut: !settledInTime,
    });
  }

  async #ownedState(
    parentSessionId: string,
    runId: string,
  ): Promise<TeamRunState> {
    let state: TeamRunState;
    try {
      state = await this.dependencies.runs.load(runId);
    } catch (error) {
      if (error instanceof SessionStoreError &&
        (error.code === "session_not_found" || error.code === "invalid_session_id")) {
        throw new ToolError("not_found", "Team run not found");
      }
      throw error;
    }
    if (state.descriptor.parentSessionId !== parentSessionId) {
      throw new ToolError("not_found", "Team run not found");
    }
    return state;
  }

  async cancel(
    parentSessionId: string,
    runId: string,
    reason: string,
  ): Promise<TeamRunCancelResult> {
    let state = await this.#ownedState(parentSessionId, runId);
    if (terminalStatus(state.status)) {
      return Object.freeze({
        result: "already_terminal",
        snapshot: await this.status(parentSessionId, runId),
      });
    }
    const active = this.#active.get(runId);
    if (active !== undefined && active.parentSessionId === parentSessionId) {
      if (active.ownerId !== state.claim?.ownerId) {
        throw new ToolError("permission_denied", "Active team ownership is stale");
      }
      await active.requestCancel(reason);
      if (state.status !== "ready_to_apply") {
        return Object.freeze({
          result: "requested",
          snapshot: await this.status(parentSessionId, runId),
        });
      }
      await active.settled;
      state = await this.#ownedState(parentSessionId, runId);
      if (terminalStatus(state.status)) {
        return Object.freeze({
          result: "requested",
          snapshot: snapshotFromState(state),
        });
      }
    }
    if (state.status !== "ready_to_apply" && state.status !== "interrupted") {
      throw new ToolError(
        "permission_denied",
        "An inactive running team must be recovered before cancellation",
      );
    }
    const owner = await this.#acquireOwner(runId, parentSessionId);
    try {
      await owner.assertOwned();
      state = await this.#ownedState(parentSessionId, runId);
      if (terminalStatus(state.status)) {
        return Object.freeze({
          result: "already_terminal",
          snapshot: snapshotFromState(state),
        });
      }
      if (state.status !== "ready_to_apply" && state.status !== "interrupted") {
        throw new ToolError(
          "permission_denied",
          "Team run is no longer stable for cancellation",
        );
      }
      if (state.status === "interrupted" && state.phase === "apply") {
        throw new ToolError(
          "checkpoint_conflict",
          "An interrupted team apply must be reconciled before cancellation",
        );
      }
      if (state.apply !== null && !state.apply.committed) {
        throw new ToolError(
          "checkpoint_conflict",
          "A prepared team apply must be reconciled before cancellation",
        );
      }
      const journal = new RunJournal(
        state,
        this.dependencies.runs,
        (next) => this.#publish(next),
        () => owner.assertOwned(),
      );
      const safeReason = truncateUtf8(
        reason.trim() || "Team run cancelled",
        MAX_SAFE_TEXT,
      );
      if (journal.state.cancellation === null) {
        await journal.append({
          type: "cancel_requested",
          reason: safeReason,
          at: this.#now(),
        });
      }
      await journal.append({
        type: "run_terminal",
        status: "cancelled",
        outcome: {
          changedFiles: [],
          evidence: [],
          failure: {
            code: "cancelled",
            message: journal.state.cancellation?.reason ?? safeReason,
          },
        },
        at: this.#now(),
      });
      state = journal.state;
      if (state.candidate !== null) {
        await this.dependencies.patches.discard([state.candidate.artifact])
          .catch(() => undefined);
      }
      return Object.freeze({
        result: "requested",
        snapshot: snapshotFromState(state),
      });
    } finally {
      await owner.release();
    }
  }

  async #controlParent(
    state: TeamRunState,
    context: ToolContext,
    requireFullAccess: boolean,
  ): Promise<PinnedSessionState> {
    if (context.executionMode !== "act" || context.runContext === undefined ||
      context.runContext.invocation === "one_shot" ||
      context.runContext.presence !== "present" ||
      context.runContext.location !== "local" ||
      context.runContext.automation !== "manual") {
      throw new ToolError(
        "permission_denied",
        "Team control requires a local, manual, user-present Act session",
      );
    }
    const parent = await this.dependencies.sessions.loadState(context.sessionId);
    if (!isPinnedSessionState(parent) || parent.agent.role !== "parent" ||
      parent.id !== state.descriptor.parentSessionId ||
      parent.agent.id !== state.descriptor.parentAgentId ||
      parent.cwd !== context.cwd || parent.cwd !== state.descriptor.repositoryRoot ||
      parent.executionMode !== "act" ||
      !isDeepStrictEqual(parent.backend.pin, state.descriptor.backend) ||
      !isDeepStrictEqual(parent.agent.operatingMode, {
        id: state.descriptor.operatingModeId,
        version: state.descriptor.operatingModeVersion,
      })) {
      throw new ToolError("permission_denied", "Team run no longer matches its parent");
    }
    const explicitlyApproved = context.approvedIntents?.has(
      permissionIntentKey(TEAM_APPLY_PERMISSION),
    ) === true;
    if (requireFullAccess
      ? parent.permissionMode !== "full_access"
      : parent.permissionMode !== "full_access" && !explicitlyApproved) {
      throw new ToolError(
        "permission_denied",
        requireFullAccess
          ? "Team resume requires Full Access"
          : "Team apply requires Full Access or explicit approval",
      );
    }
    return parent;
  }

  async resume(
    parentSessionId: string,
    runId: string,
    context: ToolContext,
  ): Promise<TeamRunResumeResult> {
    const state = await this.#ownedState(parentSessionId, runId);
    await this.#controlParent(state, context, true);
    const active = this.#active.get(runId);
    if (active !== undefined && active.parentSessionId === parentSessionId) {
      if (active.ownerId !== state.claim?.ownerId) {
        throw new ToolError("permission_denied", "Active team ownership is stale");
      }
      return Object.freeze({
        result: "already_active",
        snapshot: await this.status(parentSessionId, runId),
      });
    }
    const budget = {
      maxChildren: state.descriptor.allocation.maxChildren,
      childrenStarted: state.accounting.childrenReserved,
      maxRequests: state.descriptor.allocation.maxRequests,
      requestsReserved: state.accounting.requestsReserved,
      requestsUsed: state.accounting.requestsUsed,
      maxReportedCostUsd: state.descriptor.allocation.maxReportedCostUsd,
      reportedCostUsd: state.accounting.reportedCostUsd ?? 0,
    };
    await this.#launchBackground({
      description: state.descriptor.request.description,
      tasks: state.descriptor.request.tasks,
      review: state.descriptor.request.review,
      execution: "background",
    }, {
      ...context,
      delegationBudget: budget,
    }, state);
    return Object.freeze({
      result: "started",
      snapshot: await this.status(parentSessionId, runId),
    });
  }

  async apply(
    parentSessionId: string,
    runId: string,
    context: ToolContext,
  ): Promise<TeamRunResult> {
    const observed = await this.#ownedState(parentSessionId, runId);
    await this.#controlParent(observed, context, false);
    const owner = await this.#acquireOwner(runId, parentSessionId);
    let activeParentAgentId: string | undefined;
    let transactionJournal: RunJournal | undefined;
    try {
      await owner.assertOwned();
      const state = await this.#ownedState(parentSessionId, runId);
      if (state.status !== "ready_to_apply" || state.candidate === null ||
        state.cancellation !== null) {
        throw new ToolError("permission_denied", "Team run is not ready to apply");
      }
      const parent = await this.#controlParent(state, context, false);
      if (this.#activeParents.has(parent.agent.id)) {
        throw new ToolError("permission_denied", "A team is already active for this parent");
      }
      this.#activeParents.add(parent.agent.id);
      activeParentAgentId = parent.agent.id;
      const journal = new RunJournal(
        state,
        this.dependencies.runs,
        (next) => this.#publish(next),
        () => owner.assertOwned(),
      );
      transactionJournal = journal;
      const base = {
        repositoryRoot: state.descriptor.repositoryRoot,
        revision: state.descriptor.baseRevision,
      };
      const candidate = state.candidate.artifact;
      await owner.assertOwned();
      const currentBase = await this.dependencies.patches.preflightParent(
        parent.cwd,
        context.signal,
      );
      if (!isDeepStrictEqual(currentBase, base)) {
        throw new ToolError("permission_denied", "Team parent base revision changed");
      }
      await owner.assertOwned();
      const checkpoint = await this.dependencies.patches.prepareCandidateApply({
        base,
        artifact: candidate,
        sessionId: parent.id,
        operationId: state.descriptor.id,
        checkpoints: this.dependencies.checkpoints,
        signal: context.signal,
      });
      await journal.append({
        type: "phase_started",
        phase: "apply",
        round: state.round,
        at: this.#now(),
      });
      await journal.append({
        type: "apply_prepared",
        checkpoint: checkpointReference(checkpoint),
        at: this.#now(),
      });
      await owner.assertOwned();
      const applied = await this.dependencies.patches.applyCandidate({
        base,
        artifact: candidate,
        checkpoint,
        checkpoints: this.dependencies.checkpoints,
        signal: context.signal,
      });
      await owner.assertOwned();
      const completed = await this.dependencies.patches.completeCandidateApply({
        base,
        artifact: candidate,
        checkpoint,
        checkpoints: this.dependencies.checkpoints,
        signal: context.signal,
      });
      if (!isDeepStrictEqual(applied.changedFiles, candidate.paths) ||
        !isDeepStrictEqual(completed.changedFiles, candidate.paths)) {
        throw new ToolError(
          "patch_files_mismatch",
          "Applied team candidate does not match its reviewed artifact",
        );
      }
      await journal.append({
        type: "apply_committed",
        checkpoint: checkpointReference(completed.checkpoint),
        changedFiles: applied.changedFiles,
        at: this.#now(),
      });
      await this.dependencies.patches.discard([candidate]).catch(() => undefined);
      return resultFromState(journal.state, durableEvidence(journal.state));
    } catch (error) {
      const journal = transactionJournal;
      const applyState = journal?.state.apply;
      if (journal?.state.status === "applying" && applyState === null) {
        try {
          await journal.append({
            type: "apply_reset",
            reason: "clean_base",
            at: this.#now(),
          });
          return resultFromState(journal.state, durableEvidence(journal.state));
        } catch {
          throw error;
        }
      }
      if (journal !== undefined && applyState !== null && applyState !== undefined &&
        !applyState.committed) {
        await journal.append({
          type: "run_interrupted",
          reason: safeFailure(error).message,
          manualAttentionRequired: true,
          at: this.#now(),
        });
        return resultFromState(
          journal.state,
          durableEvidence(journal.state),
        );
      }
      throw error;
    } finally {
      if (activeParentAgentId !== undefined) {
        this.#activeParents.delete(activeParentAgentId);
      }
      await owner.release();
    }
  }
}
