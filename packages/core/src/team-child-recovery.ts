import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import type {
  AgentResult,
  IntegrationFailure,
  TeamRunDescriptor,
  TeamRunRole,
} from "@recurs/contracts";
import { getAgentProfilePolicy } from "@recurs/contracts";
import { isCredentialPath, ToolError } from "@recurs/tools";

import type { JsonlSessionStore } from "./jsonl-session-store.js";
import { isPinnedSessionState, type PinnedSessionState } from "./session-v2.js";
import { teamChildAssignmentSha256 } from "./team-child-binding.js";
import type {
  TeamRunChildRecord,
  TeamRunChildReservation,
} from "./team-run-state.js";

export interface TeamChildRecoveryExpectation {
  readonly childSessionId: string;
  readonly childAgentId: string;
  readonly parentSessionId: string;
  readonly parentAgentId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly role: TeamRunRole;
  readonly index: number;
  readonly round: number;
  readonly at: string;
}

export interface TeamChildRecoveryResult {
  readonly status: "completed" | "failed" | "cancelled";
  readonly started: boolean;
  readonly result: AgentResult | null;
  readonly failure: { readonly code: string; readonly message: string } | null;
}

export interface DurableTeamChildRecoveryInput {
  readonly descriptor: TeamRunDescriptor;
  readonly reservation: TeamRunChildReservation;
  readonly at: string;
}

function recoveryAt(requested: string): string {
  const parsed = Date.parse(requested);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== requested) {
    throw new ToolError("invalid_input", "Team child recovery time is invalid");
  }
  return requested;
}

function exactChild(
  state: PinnedSessionState,
  expected: TeamChildRecoveryExpectation,
): boolean {
  const team = state.agent.team;
  return state.id === expected.childSessionId &&
    state.agent.role === "child" && state.agent.depth === 1 &&
    state.agent.id === expected.childAgentId &&
    state.agent.parentSessionId === expected.parentSessionId &&
    state.agent.parentAgentId === expected.parentAgentId &&
    team !== undefined && team.runId === expected.runId &&
    team.attemptId === expected.attemptId && team.role === expected.role &&
    team.taskIndex === expected.index && team.round === expected.round &&
    state.pendingCompaction === null;
}

function failure(
  state: PinnedSessionState,
  phase: IntegrationFailure["phase"],
  domain: IntegrationFailure["domain"] = "runtime",
): IntegrationFailure {
  return {
    domain,
    phase,
    code: domain === "tool" ? "tool_failed" : "runtime_failed",
    safeMessage: "The process ended before the team child recorded a terminal result",
    diagnosticId: `${state.id}:team-recovery`,
    retryable: false,
  };
}

function resultFromState(state: PinnedSessionState): TeamChildRecoveryResult {
  const lifecycle = state.agentLifecycle;
  if (lifecycle.status === "completed") {
    if (state.agentResult === null) {
      throw new ToolError("execution_failed", "Completed team child result is unavailable");
    }
    return Object.freeze({
      status: "completed",
      started: true,
      result: Object.freeze(structuredClone(state.agentResult)),
      failure: null,
    });
  }
  if (lifecycle.status === "failed") {
    return Object.freeze({
      status: "failed",
      started: lifecycle.turnId !== null,
      result: null,
      failure: Object.freeze({
        code: lifecycle.failure.code,
        message: lifecycle.failure.safeMessage,
      }),
    });
  }
  if (lifecycle.status === "cancelled") {
    return Object.freeze({
      status: "cancelled",
      started: lifecycle.turnId !== null,
      result: null,
      failure: Object.freeze({ code: "cancelled", message: lifecycle.reason }),
    });
  }
  throw new ToolError("execution_failed", "Team child recovery did not settle the child");
}

function safePath(value: string): boolean {
  return Buffer.byteLength(value, "utf8") > 0 &&
    Buffer.byteLength(value, "utf8") <= 4_096 && !path.isAbsolute(value) &&
    !value.includes("\\") && !value.includes("\0") && !isCredentialPath(value) &&
    value.split("/").every((part) => part.length > 0 && part !== "." &&
      part !== ".." && ![...part].some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code <= 31 || (code >= 127 && code <= 159);
      }));
}

function exactPaths(values: readonly string[]): readonly string[] | null {
  const sorted = [...new Set(values)].sort((left, right) => left.localeCompare(right));
  return sorted.length <= 256 && sorted.length === values.length &&
      sorted.every(safePath)
    ? Object.freeze(sorted)
    : null;
}

function evidence(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values.map((value) => value.trim()))]
    .filter((value) => value.length > 0)
    .sort((left, right) => left.localeCompare(right))
    .slice(0, 64)
    .map((value) => {
      if (Buffer.byteLength(value, "utf8") <= 16_384) return value;
      let result = "";
      for (const character of value) {
        if (Buffer.byteLength(`${result}${character}`, "utf8") > 16_368) break;
        result += character;
      }
      return `${result.trimEnd()} [truncated]`;
    }));
}

function exactDurableChild(
  state: PinnedSessionState,
  input: DurableTeamChildRecoveryInput,
): boolean {
  const { descriptor, reservation } = input;
  const route = descriptor.routes.find((candidate) =>
    candidate.role === reservation.role
  );
  const profileId = reservation.role === "implement"
    ? "implement_v2"
    : reservation.role === "review"
      ? "review_v2"
      : "repair_v1";
  const profile = getAgentProfilePolicy(profileId);
  const workspace = state.agent.workspace;
  const team = state.agent.team;
  const task = state.agent.task;
  const implementation = reservation.role === "implement"
    ? descriptor.request.tasks[reservation.index - 1]
    : undefined;
  return route !== undefined && route.profileId === profile.id &&
    reservation.taskId !== undefined && reservation.workspaceLeaseId !== undefined &&
    reservation.assignmentSha256 !== undefined &&
    state.id === reservation.childSessionId &&
    state.agent.id === reservation.childAgentId && state.agent.role === "child" &&
    state.agent.depth === 1 &&
    state.agent.parentSessionId === descriptor.parentSessionId &&
    state.agent.parentAgentId === descriptor.parentAgentId &&
    isDeepStrictEqual(state.agent.profile, {
      id: profile.id,
      version: profile.version,
    }) && task !== null && task.id === reservation.taskId &&
    reservation.assignmentSha256 === teamChildAssignmentSha256(
      profile.id,
      task.description,
      task.prompt,
    ) && (implementation === undefined ||
      (task.description === implementation.description &&
        task.prompt === implementation.prompt)) &&
    isDeepStrictEqual(state.agent.operatingMode, {
      id: descriptor.operatingModeId,
      version: descriptor.operatingModeVersion,
    }) && isDeepStrictEqual(state.backend.pin, route.pin) &&
    isDeepStrictEqual(state.agent.backend, {
      strategy: "policy_route",
      candidateId: route.candidateId,
      reason: route.reason,
      adapterId: route.pin.adapterId,
      connectionId: route.pin.connectionId,
      modelId: route.pin.modelId,
    }) && isDeepStrictEqual(state.agent.permissions, {
      parentExecutionMode: descriptor.parentExecutionMode,
      executionMode: profile.executionMode,
      parentPermissionMode: descriptor.parentPermissionMode,
      permissionMode: descriptor.parentPermissionMode,
    }) && isDeepStrictEqual(state.agent.limits, {
      ...descriptor.policy.orchestration,
      maxRequests: reservation.requestAllowance,
    }) && workspace !== undefined && workspace.kind === "git_worktree" &&
    workspace.version === 1 && workspace.repositoryRoot === descriptor.repositoryRoot &&
    workspace.revision === descriptor.baseRevision &&
    workspace.leaseId === reservation.workspaceLeaseId &&
    workspace.worktreeRoot === state.cwd &&
    team !== undefined && team.runId === descriptor.id &&
    team.attemptId === reservation.attemptId && team.role === reservation.role &&
    team.taskIndex === reservation.index && team.round === reservation.round;
}

export async function recoverInterruptedTeamChild(
  sessions: Pick<JsonlSessionStore, "loadState" | "withSessionMutation">,
  expected: TeamChildRecoveryExpectation,
): Promise<TeamChildRecoveryResult> {
  const state = await sessions.loadState(expected.childSessionId);
  if (!isPinnedSessionState(state) || !exactChild(state, expected)) {
    throw new ToolError(
      "permission_denied",
      "Team child recovery correlation does not match durable state",
    );
  }
  if (state.agentLifecycle.status === "completed" ||
    state.agentLifecycle.status === "failed" ||
    state.agentLifecycle.status === "cancelled") {
    return resultFromState(state);
  }
  const at = recoveryAt(expected.at);
  await sessions.withSessionMutation(
    state.id,
    state.lastSequence,
    async (lease) => {
      if (state.agentLifecycle.status === "ready") {
        await lease.append({
          type: "agent_run_failed",
          failure: failure(state, "preflight"),
          at,
        });
        return;
      }
      const turnId = state.agentLifecycle.turnId;
      if (turnId === null) {
        throw new ToolError(
          "execution_failed",
          "Running team child is missing its durable turn correlation",
        );
      }
      if (state.pendingRuntimeCompletion !== null) {
        await lease.append({
          type: "turn_completed",
          turnId,
          result: state.pendingRuntimeCompletion.result,
          at,
        });
        return;
      }
      for (const call of state.pendingToolCalls) {
        await lease.append({
          type: "tool_failed",
          turnId,
          callId: call.id,
          error: failure(state, "started", "tool"),
          at,
        });
      }
      await lease.append({
        type: "turn_interrupted",
        turnId,
        reason: "The process ended before the team child recorded a terminal result",
        at,
      });
    },
  );
  const settled = await sessions.loadState(state.id);
  if (!isPinnedSessionState(settled) || !exactChild(settled, expected)) {
    throw new ToolError(
      "permission_denied",
      "Recovered team child correlation changed unexpectedly",
    );
  }
  return resultFromState(settled);
}

export async function recoverDurableTeamChild(
  sessions: Pick<JsonlSessionStore, "loadState" | "withSessionMutation">,
  input: DurableTeamChildRecoveryInput,
): Promise<TeamRunChildRecord> {
  const { descriptor, reservation } = input;
  const recovered = await recoverInterruptedTeamChild(sessions, {
    childSessionId: reservation.childSessionId,
    childAgentId: reservation.childAgentId,
    parentSessionId: descriptor.parentSessionId,
    parentAgentId: descriptor.parentAgentId,
    runId: descriptor.id,
    attemptId: reservation.attemptId,
    role: reservation.role,
    index: reservation.index,
    round: reservation.round,
    at: input.at,
  });
  const state = await sessions.loadState(reservation.childSessionId);
  if (!isPinnedSessionState(state)) {
    throw new ToolError("permission_denied", "Recovered team child is not pinned");
  }
  if (recovered.status === "completed" && recovered.result !== null) {
    const requestsUsed = recovered.result.steps === null
      ? reservation.requestAllowance
      : Math.min(reservation.requestAllowance, recovered.result.steps);
    const changedFiles = exactPaths(recovered.result.changedFiles);
    if (changedFiles !== null && exactDurableChild(state, input) &&
      !(reservation.role === "review" && changedFiles.length > 0)) {
      return Object.freeze({
        attemptId: reservation.attemptId,
        status: "completed",
        requestsUsed,
        usage: recovered.result.usage === null
          ? null
          : Object.freeze({ ...recovered.result.usage }),
        usageSource: recovered.result.usageSource,
        changedFiles,
        evidence: evidence(recovered.result.evidence),
        failure: null,
      });
    }
    return Object.freeze({
      attemptId: reservation.attemptId,
      status: "failed",
      requestsUsed,
      usage: recovered.result.usage === null
        ? null
        : Object.freeze({ ...recovered.result.usage }),
      usageSource: recovered.result.usageSource,
      changedFiles: Object.freeze([]),
      evidence: Object.freeze([]),
      failure: Object.freeze({
        code: "invalid_child_result",
        message: "The recovered child result did not match its durable reservation",
      }),
    });
  }
  return Object.freeze({
    attemptId: reservation.attemptId,
    status: recovered.status,
    requestsUsed: recovered.started ? reservation.requestAllowance : 0,
    usage: null,
    usageSource: "unavailable",
    changedFiles: Object.freeze([]),
    evidence: Object.freeze([]),
    failure: recovered.failure === null
      ? Object.freeze({
          code: "execution_failed",
          message: "The interrupted team child did not return a result",
        })
      : recovered.failure,
  });
}
