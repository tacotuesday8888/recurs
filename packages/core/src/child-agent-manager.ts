import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  createHostInvocation,
  getAgentProfilePolicy,
  getOperatingModePolicy,
  narrowAgentPermissionMode,
  parseAgentProfileId,
  parseOperatingModeId,
  type AgentBackendSelection,
  type AgentCompanyGoalCorrelation,
  type AgentGitWorktreeWorkspace,
  type AgentExecutionMode,
  type AgentPermissionMode,
  type AgentProfileId,
  type AgentTeamCorrelation,
  type CompanyAgentBinding,
  type HostInvocation,
  type IntegrationFailure,
  type OperatingModeId,
  type OperatingModeVersion,
  type ProviderUsage,
  type RunCoordinator,
  type TeamRunExecution,
  type TeamRunRole,
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
import type {
  AgentBackendRouteDecision,
  AgentBackendRouter,
} from "./agent-backend-router.js";
import {
  companyAgentLimits,
  parseCompanyAgentBinding,
} from "./company-agent-binding.js";

export interface DelegateTaskInput {
  readonly profile: AgentProfileId;
  readonly description: string;
  readonly prompt: string;
}

interface ChildDelegationCorrelation {
  readonly batch?: {
    readonly id: string;
    readonly index: number;
  };
  readonly team?:
    | { readonly id: string; readonly index: number }
    | AgentTeamCorrelation;
}

export interface ChildIdentityReservation {
  readonly childSessionId: string;
  readonly childAgentId: string;
  readonly taskId: string;
}

export interface TeamOperatingModeBinding {
  readonly id: OperatingModeId;
  readonly version: OperatingModeVersion;
}

export interface TeamParentPermissionBinding {
  readonly executionMode: AgentExecutionMode;
  readonly permissionMode: AgentPermissionMode;
}

export interface TeamRunAuthorityInput {
  readonly runId: string;
  readonly execution: TeamRunExecution;
  readonly operatingMode: TeamOperatingModeBinding;
  readonly parentPermissions: TeamParentPermissionBinding;
  readonly repositoryRoot: string;
}

export interface TeamChildAuthority {
  readonly type: "team_child_authority";
}

interface TrustedChildOptions {
  readonly identity?: ChildIdentityReservation;
  readonly backend?: { readonly decision: AgentBackendRouteDecision };
  readonly teamExecution?: TeamRunExecution;
  readonly teamOperatingMode?: TeamOperatingModeBinding;
  readonly teamParentPermissions?: TeamParentPermissionBinding;
  readonly teamAuthority?: TeamChildAuthority;
  readonly company?: CompanyAgentBinding;
  readonly companyPermissionMode?: AgentPermissionMode;
  readonly companyGoal?: AgentCompanyGoalCorrelation;
}

export interface ChildIdentityReservationOptions extends ChildDelegationCorrelation {
  readonly backend?: { readonly decision: AgentBackendRouteDecision };
  readonly teamExecution?: TeamRunExecution;
  readonly teamOperatingMode?: TeamOperatingModeBinding;
  readonly teamParentPermissions?: TeamParentPermissionBinding;
  readonly teamAuthority?: TeamChildAuthority;
  readonly cwd?: string;
  readonly workspace?: AgentGitWorktreeWorkspace;
  readonly company?: CompanyAgentBinding;
  readonly companyPermissionMode?: AgentPermissionMode;
  readonly companyGoal?: AgentCompanyGoalCorrelation;
}

export type ChildDelegationOptions = ChildDelegationCorrelation & TrustedChildOptions & (
  | {
      readonly cwd: string;
      readonly workspace: AgentGitWorktreeWorkspace;
    }
  | {
      readonly cwd?: never;
      readonly workspace?: never;
    }
);

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
  readonly requestsUsed: number;
  readonly evidenceSource:
    | "host_tools"
    | "runtime"
    | "mixed"
    | "independent_verification"
    | "none";
  readonly changedFiles: readonly string[];
  readonly evidence: readonly string[];
  readonly costLimitUsd: number;
  readonly costLimitExceeded: boolean;
  readonly workflow: AgentWorkflowUsage;
  readonly company?: CompanyAgentBinding;
  readonly workspace?: AgentGitWorktreeWorkspace;
  readonly batchId?: string;
  readonly batchIndex?: number;
  readonly teamId?: string;
  readonly teamIndex?: number;
}

export interface ChildDelegationResult extends ToolResult {
  readonly metadata: ChildDelegationMetadata;
}

export interface ChildAgentManagerDependencies {
  readonly sessions: JsonlSessionStore;
  readonly backendRouter?: Pick<AgentBackendRouter, "validate">;
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
  if (profile !== "explore_v1" && profile !== "implement_v1" &&
    profile !== "review_v1") {
    throw new ToolError(
      "invalid_input",
      "Internal team profile IDs cannot be selected through delegate_task",
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

function teamRole(profile: AgentProfileId): TeamRunRole | null {
  return profile === "implement_v2"
    ? "implement"
    : profile === "review_v2"
      ? "review"
      : profile === "repair_v1"
        ? "repair"
        : null;
}

function validTeamCorrelation(
  value: AgentTeamCorrelation,
  role: TeamRunRole,
): boolean {
  return Object.keys(value).sort().join(",") ===
      "attemptId,role,round,runId,taskIndex" &&
    value.role === role &&
    typeof value.runId === "string" && value.runId.length > 0 &&
    value.runId === value.runId.trim() && value.runId.length <= 512 &&
    Number.isSafeInteger(value.taskIndex) && value.taskIndex >= 1 &&
    Number.isSafeInteger(value.round) && value.round >= 0 &&
    typeof value.attemptId === "string" && value.attemptId.length > 0 &&
    value.attemptId === value.attemptId.trim() && value.attemptId.length <= 512;
}

function validTeamOperatingModeBinding(
  value: unknown,
): value is TeamOperatingModeBinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const binding = value as Record<string, unknown>;
  return Object.keys(binding).sort().join(",") === "id,version" &&
    typeof binding.id === "string" &&
    parseOperatingModeId(binding.id) === binding.id &&
    Number.isSafeInteger(binding.version) && (binding.version as number) >= 1;
}

function validTeamParentPermissionBinding(
  value: unknown,
): value is TeamParentPermissionBinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const binding = value as Record<string, unknown>;
  return Object.keys(binding).sort().join(",") ===
      "executionMode,permissionMode" &&
    (binding.executionMode === "act" || binding.executionMode === "plan") &&
    (binding.permissionMode === "ask_always" ||
      binding.permissionMode === "approved_for_me" ||
      binding.permissionMode === "full_access");
}

export class ChildAgentManager {
  readonly #createId: () => string;
  readonly #now: () => string;
  readonly #activeChildren = new Map<string, Set<string>>();
  readonly #teamAuthorities = new WeakMap<object, {
    readonly input: TeamRunAuthorityInput;
    readonly parentSessionId: string;
    readonly parentAgentId: string;
  }>();
  readonly #identityReservations = new WeakMap<object, {
    readonly identity: ChildIdentityReservation;
    readonly parentSessionId: string;
    readonly input: DelegateTaskInput;
    readonly team: ChildDelegationCorrelation["team"];
    readonly teamExecution: TeamRunExecution | undefined;
    readonly teamOperatingMode: TrustedChildOptions["teamOperatingMode"];
    readonly teamParentPermissions: TrustedChildOptions["teamParentPermissions"];
    readonly teamAuthority: TrustedChildOptions["teamAuthority"];
    readonly cwd: string | undefined;
    readonly workspace: AgentGitWorktreeWorkspace | undefined;
    readonly decision: AgentBackendRouteDecision | undefined;
    readonly company: CompanyAgentBinding | undefined;
    readonly companyPermissionMode: AgentPermissionMode | undefined;
    readonly companyGoal: AgentCompanyGoalCorrelation | undefined;
  }>();

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
          "Use Explore for evidence, Implement for a scoped change, and Review for read-only inspection of diffs, files, and existing Implement evidence.",
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

  async authorizeTeamRun(
    input: TeamRunAuthorityInput,
    context: ToolContext,
  ): Promise<TeamChildAuthority> {
    if (typeof input !== "object" || input === null || Array.isArray(input) ||
      context.signal.aborted ||
      Object.keys(input).sort().join(",") !==
        "execution,operatingMode,parentPermissions,repositoryRoot,runId" ||
      typeof input.runId !== "string" || input.runId.trim() !== input.runId ||
      input.runId.length === 0 || input.runId.length > 512 ||
      (input.execution !== "foreground" && input.execution !== "background") ||
      !validTeamOperatingModeBinding(input.operatingMode) ||
      !validTeamParentPermissionBinding(input.parentPermissions)) {
      throw new ToolError("permission_denied", "Team run authority is invalid");
    }
    const parent = await this.#parent(context);
    const mode = getOperatingModePolicy(parent.agent.operatingMode.id);
    if (parent.agent.role !== "parent" || mode.version < 4 ||
      input.operatingMode.id !== mode.id ||
      input.operatingMode.version !== mode.version ||
      input.parentPermissions.executionMode !== context.executionMode ||
      input.parentPermissions.executionMode !== parent.executionMode ||
      input.parentPermissions.permissionMode !== parent.permissionMode ||
      input.repositoryRoot !== parent.cwd) {
      throw new ToolError(
        "permission_denied",
        "Team run authority does not match the live parent snapshot",
      );
    }
    const authority = Object.freeze({ type: "team_child_authority" as const });
    this.#teamAuthorities.set(authority, {
      input: structuredClone(input),
      parentSessionId: parent.id,
      parentAgentId: parent.agent.id,
    });
    return authority;
  }

  revokeTeamRunAuthority(authority: TeamChildAuthority): void {
    this.#teamAuthorities.delete(authority);
  }

  #validTeamAuthority(
    input: DelegateTaskInput,
    context: Pick<ToolContext, "sessionId">,
    options: ChildIdentityReservationOptions | ChildDelegationOptions,
    parentAgentId?: string,
  ): boolean {
    const role = teamRole(input.profile);
    const authority = options.teamAuthority;
    if (role === null) return authority === undefined;
    const trusted = authority === undefined
      ? undefined
      : this.#teamAuthorities.get(authority);
    const team = options.team;
    return trusted !== undefined && team !== undefined && "runId" in team &&
      trusted.parentSessionId === context.sessionId &&
      (parentAgentId === undefined || trusted.parentAgentId === parentAgentId) &&
      trusted.input.runId === team.runId &&
      trusted.input.execution === options.teamExecution &&
      isDeepStrictEqual(trusted.input.operatingMode, options.teamOperatingMode) &&
      isDeepStrictEqual(
        trusted.input.parentPermissions,
        options.teamParentPermissions,
      ) && trusted.input.repositoryRoot === options.workspace?.repositoryRoot &&
      role === team.role;
  }

  reserveIdentity(
    input: DelegateTaskInput,
    context: Pick<ToolContext, "sessionId">,
    options?: ChildIdentityReservationOptions,
  ): ChildIdentityReservation {
    if (options !== undefined && !this.#validTeamAuthority(input, context, options)) {
      throw new ToolError(
        "permission_denied",
        "A trusted team run authority is required for internal children",
      );
    }
    const identity = Object.freeze({
      childSessionId: this.#createId(),
      childAgentId: this.#createId(),
      taskId: this.#createId(),
    });
    this.#identityReservations.set(identity, {
      identity: { ...identity },
      parentSessionId: context.sessionId,
      input: { ...input },
      team: options?.team === undefined
        ? undefined
        : structuredClone(options.team),
      teamExecution: options?.teamExecution,
      teamOperatingMode: options?.teamOperatingMode === undefined
        ? undefined
        : structuredClone(options.teamOperatingMode),
      teamParentPermissions: options?.teamParentPermissions === undefined
        ? undefined
        : structuredClone(options.teamParentPermissions),
      teamAuthority: options?.teamAuthority,
      cwd: options?.cwd,
      workspace: options?.workspace === undefined
        ? undefined
        : structuredClone(options.workspace),
      decision: options?.backend?.decision,
      company: options?.company === undefined
        ? undefined
        : parseCompanyAgentBinding(options.company),
      companyPermissionMode: options?.companyPermissionMode,
      companyGoal: options?.companyGoal === undefined
        ? undefined
        : structuredClone(options.companyGoal),
    });
    return identity;
  }

  #identity(
    input: DelegateTaskInput,
    context: ToolContext,
    options?: ChildDelegationOptions,
  ): ChildIdentityReservation {
    if (options?.identity === undefined) {
      return {
        childSessionId: this.#createId(),
        childAgentId: this.#createId(),
        taskId: this.#createId(),
      };
    }
    const reservation = this.#identityReservations.get(options.identity);
    if (reservation === undefined) {
      throw new ToolError(
        "permission_denied",
        "A trusted unused child identity reservation is required",
      );
    }
    this.#identityReservations.delete(options.identity);
    if (
      reservation.parentSessionId !== context.sessionId ||
      !isDeepStrictEqual(reservation.identity, options.identity) ||
      !isDeepStrictEqual(reservation.input, input) ||
      !isDeepStrictEqual(reservation.team, options.team) ||
      reservation.teamExecution !== options.teamExecution ||
      !isDeepStrictEqual(
        reservation.teamOperatingMode,
        options.teamOperatingMode,
      ) ||
      !isDeepStrictEqual(
        reservation.teamParentPermissions,
        options.teamParentPermissions,
      ) ||
      reservation.teamAuthority !== options.teamAuthority ||
      reservation.cwd !== options.cwd ||
      !isDeepStrictEqual(reservation.workspace, options.workspace) ||
      reservation.decision !== options.backend?.decision ||
      !isDeepStrictEqual(reservation.company, options.company) ||
      reservation.companyPermissionMode !== options.companyPermissionMode
      || !isDeepStrictEqual(reservation.companyGoal, options.companyGoal)
    ) {
      throw new ToolError(
        "permission_denied",
        "The child identity reservation does not match this delegation",
      );
    }
    return reservation.identity;
  }

  async #publish(event: RecursEvent): Promise<void> {
    try {
      await this.dependencies.emit(event);
    } catch {
      // Durable child state is authoritative; presentation is best effort.
    }
  }

  async #parent(context: ToolContext): Promise<PinnedSessionState> {
    const state = await this.dependencies.sessions.loadState(context.sessionId);
    if (!isPinnedSessionState(state) || state.cwd !== context.cwd) {
      throw new ToolError("tool_unavailable", "Parent agent session is unavailable");
    }
    return state;
  }

  #claim(
    parent: PinnedSessionState,
    childSessionId: string,
    maximum: number,
  ): () => void {
    const active = this.#activeChildren.get(parent.agent.id) ?? new Set<string>();
    if (active.size >= maximum) {
      throw new ToolError(
        "permission_denied",
        `Agent concurrency limit reached (${maximum})`,
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
    const company = options?.company === undefined
      ? undefined
      : parseCompanyAgentBinding(options.company);
    const parent = await this.#parent(context);
    const childCwd = options?.workspace === undefined
      ? parent.cwd
      : options.cwd;
    if (options?.workspace !== undefined && (
      options.workspace.repositoryRoot !== parent.cwd ||
      options.workspace.worktreeRoot !== childCwd
    )) {
      throw new ToolError(
        "tool_unavailable",
        "Trusted child workspace is invalid",
      );
    }
    const profile = getAgentProfilePolicy(input.profile);
    const parentCompany = parent.agent.company;
    const mismatchedCompany = (parentCompany === undefined) !==
      (company === undefined) || (company !== undefined && (
      parentCompany === undefined ||
      company.blueprintId !== parentCompany.blueprintId ||
      company.blueprintVersion !== parentCompany.blueprintVersion ||
      (company.blueprintVersion === 1 &&
        (parentCompany.blueprintVersion !== 1 ||
          parentCompany.roleId !== "orchestrator_v1")) ||
      (company.blueprintVersion === 2 &&
        (parentCompany.blueprintVersion !== 2 ||
          company.blueprintRevision !== parentCompany.blueprintRevision))
    ));
    if (mismatchedCompany) {
      throw new ToolError(
        "permission_denied",
        "Company child binding does not match the live parent company",
      );
    }
    if ((company?.blueprintVersion === 2) !==
      (options?.companyGoal !== undefined)) {
      throw new ToolError(
        "permission_denied",
        "Company V2 children require an exact goal assignment correlation",
      );
    }
    const role = teamRole(profile.id);
    if (options !== undefined && !this.#validTeamAuthority(
      input,
      context,
      options,
      parent.agent.id,
    )) {
      throw new ToolError(
        "permission_denied",
        "Trusted team run authority does not match this child",
      );
    }
    const teamOperatingMode = options?.teamOperatingMode;
    const teamParentPermissions = options?.teamParentPermissions;
    if ((teamOperatingMode !== undefined &&
      !validTeamOperatingModeBinding(teamOperatingMode)) ||
      (teamParentPermissions !== undefined &&
        !validTeamParentPermissionBinding(teamParentPermissions))) {
      throw new ToolError(
        "permission_denied",
        "Trusted team policy bindings are invalid",
      );
    }
    const liveMode = getOperatingModePolicy(parent.agent.operatingMode.id);
    const mode = role !== null && teamOperatingMode !== undefined
      ? getOperatingModePolicy(teamOperatingMode.id)
      : liveMode;
    const parentExecutionMode = options?.teamParentPermissions?.executionMode ??
      context.executionMode;
    const parentPermissionMode = options?.teamParentPermissions?.permissionMode ??
      parent.permissionMode;
    if ((teamOperatingMode !== undefined || teamParentPermissions !== undefined) &&
      (role === null || teamOperatingMode === undefined ||
        teamParentPermissions === undefined ||
        teamOperatingMode.version !== mode.version)) {
      throw new ToolError(
        "permission_denied",
        "Trusted team policy bindings do not match the child profile",
      );
    }
    if (role !== null && mode.version < 4) {
      throw new ToolError(
        "tool_unavailable",
        "Internal team profiles require a version-4-or-newer operating policy",
      );
    }
    if (options?.team !== undefined && "runId" in options.team &&
      (role === null || !validTeamCorrelation(options.team, role))) {
      throw new ToolError(
        "permission_denied",
        "Trusted durable team correlation does not match the child profile",
      );
    }
    if (role !== null && (
      options?.workspace === undefined || options.cwd === undefined ||
      options.cwd === parent.cwd ||
      options.team === undefined || !("runId" in options.team) ||
      options.identity === undefined || options.backend === undefined ||
      teamOperatingMode === undefined || teamParentPermissions === undefined ||
      (options.teamExecution !== "foreground" &&
        options.teamExecution !== "background")
    )) {
      throw new ToolError(
        "permission_denied",
        "Internal profiles require a complete trusted team bundle",
      );
    }
    if (profile.executionMode === "act" && parentExecutionMode !== "act") {
      throw new ToolError(
        "plan_mode_denied",
        `${profile.displayName} children require an Act parent`,
      );
    }
    const childDepth = parent.agent.depth + 1;
    const agentLimits = companyAgentLimits(mode.id, company ?? parentCompany);
    if (childDepth > agentLimits.maxDepth) {
      throw new ToolError(
        "permission_denied",
        `Agent depth limit reached (${agentLimits.maxDepth})`,
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
    const budgetAgent = mode.id === parent.agent.operatingMode.id
      ? parent.agent
      : {
          ...parent.agent,
          operatingMode: { id: mode.id, version: mode.version },
          limits: agentLimits,
        };
    if (budget === undefined ||
      !isDelegationBudgetForAgent(budget, budgetAgent)) {
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
    const childRequestLimit = childRequestAllowance(budgetAgent);
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
      parentExecutionMode,
      parentPermissionMode,
      permissionMode: narrowAgentPermissionMode(
        parentPermissionMode,
        options?.companyPermissionMode ?? parentPermissionMode,
      ),
      runContext: context.runContext,
      company,
      companyGoal: options?.companyGoal,
      agentLimits,
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
      parentExecutionMode,
      parentPermissionMode,
      permissionMode,
      runContext,
      company,
      companyGoal,
      agentLimits,
    } = await this.#prepare(input, context, options);

    const { childSessionId, childAgentId, taskId } = this.#identity(
      input,
      context,
      options,
    );

    let childBackend = parent.backend.pin;
    let backend: AgentBackendSelection = {
      strategy: "inherit_parent" as const,
      adapterId: parent.backend.pin.adapterId,
      connectionId: parent.backend.pin.connectionId,
      modelId: parent.backend.pin.modelId,
    };
    if (options?.backend !== undefined) {
      const role = teamRole(profile.id);
      if (role === null || this.dependencies.backendRouter === undefined) {
        throw new ToolError("permission_denied", "A trusted backend route is required");
      }
      const decision = this.dependencies.backendRouter.validate(
        options.backend.decision,
        {
          role,
          executionMode: profile.executionMode,
          permissionMode: parentPermissionMode,
          background: options.teamExecution === "background",
        },
      );
      if (decision.strategy === "inherit_parent" &&
        !isDeepStrictEqual(decision.pin, parent.backend.pin)) {
        throw new ToolError(
          "permission_denied",
          "The parent-fallback backend route does not match the parent pin",
        );
      }
      childBackend = decision.pin;
      backend = {
        strategy: "policy_route" as const,
        candidateId: decision.candidateId,
        reason: decision.reason,
        adapterId: decision.pin.adapterId,
        connectionId: decision.pin.connectionId,
        modelId: decision.pin.modelId,
      };
    }
    const release = this.#claim(
      parent,
      childSessionId,
      agentLimits.maxConcurrentChildren,
    );
    budget.childrenStarted += 1;
    budget.requestsReserved += childRequestLimit;
    try {
      const child = await this.dependencies.sessions.createPinnedSession({
        id: childSessionId,
        cwd: childCwd,
        backend: childBackend,
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
          backend,
          permissions: {
            parentExecutionMode,
            executionMode: profile.executionMode,
            parentPermissionMode,
            permissionMode,
          },
          limits: { ...agentLimits, maxRequests: childRequestLimit },
          ...(company === undefined ? {} : { company }),
          ...(companyGoal === undefined ? {} : { companyGoal }),
          ...(options?.workspace === undefined
            ? {}
            : { workspace: options.workspace }),
          ...(options?.team === undefined || !("runId" in options.team)
            ? {}
            : { team: options.team }),
        },
      });
      const legacyTeam = options?.team === undefined
        ? undefined
        : "runId" in options.team
          ? { id: options.team.runId, index: options.team.taskIndex }
          : options.team;
      await this.#publish({
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
        ...(company === undefined ? {} : { company }),
        ...(options?.batch === undefined
          ? {}
          : { batchId: options.batch.id, batchIndex: options.batch.index }),
        ...(legacyTeam === undefined
          ? {}
          : { teamId: legacyTeam.id, teamIndex: legacyTeam.index }),
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
          await this.#publish({
            type: "agent_cancelled",
            sessionId: parent.id,
            at: this.#now(),
            parentAgentId: parent.agent.id,
            childAgentId,
            childSessionId,
            profileId: profile.id,
            reason: outcome.failure.safeMessage,
            ...(company === undefined ? {} : { company }),
            ...(options?.batch === undefined
              ? {}
              : { batchId: options.batch.id, batchIndex: options.batch.index }),
            ...(legacyTeam === undefined
              ? {}
              : { teamId: legacyTeam.id, teamIndex: legacyTeam.index }),
          });
          throw new ToolError("cancelled", outcome.failure.safeMessage);
        }
        await this.#publish({
          type: "agent_failed",
          sessionId: parent.id,
          at: this.#now(),
          parentAgentId: parent.agent.id,
          childAgentId,
          childSessionId,
          profileId: profile.id,
          failure: outcome.failure,
          ...(company === undefined ? {} : { company }),
          ...(options?.batch === undefined
            ? {}
            : { batchId: options.batch.id, batchIndex: options.batch.index }),
          ...(legacyTeam === undefined
            ? {}
            : { teamId: legacyTeam.id, teamIndex: legacyTeam.index }),
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
      await this.#publish({
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
        ...(company === undefined ? {} : { company }),
        ...(options?.batch === undefined
          ? {}
          : { batchId: options.batch.id, batchIndex: options.batch.index }),
        ...(legacyTeam === undefined
          ? {}
          : { teamId: legacyTeam.id, teamIndex: legacyTeam.index }),
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
          requestsUsed: usedRequests,
          evidenceSource: outcome.result.evidenceSource,
          changedFiles: [...outcome.result.changedFiles],
          evidence: [...outcome.result.evidence],
          costLimitUsd: budget.maxReportedCostUsd,
          costLimitExceeded,
          workflow,
          ...(company === undefined ? {} : { company }),
          ...(options?.workspace === undefined
            ? {}
            : { workspace: options.workspace }),
          ...(options?.batch === undefined
            ? {}
            : { batchId: options.batch.id, batchIndex: options.batch.index }),
          ...(legacyTeam === undefined
            ? {}
            : { teamId: legacyTeam.id, teamIndex: legacyTeam.index }),
        },
      };
    } finally {
      release();
    }
  }
}
