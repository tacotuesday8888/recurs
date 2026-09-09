import type { AgentExecution, EventSink, RecursEvent } from "@recurs/core";
import type { CompanyBlueprintV2 } from "@recurs/contracts";

export { renderCompanyHome } from "./terminal-agent-tree.js";

export type TerminalAgentStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "ready"
  | "unknown";

export interface TerminalAgentView {
  readonly executionId: string;
  readonly parentExecutionId: string | null;
  readonly assignmentId: string;
  readonly parentAssignmentId: string | null;
  readonly roleId: string;
  readonly childAgentId: string;
  readonly departmentId: string;
  readonly roleName: string;
  readonly depth: number;
  readonly model: string | null;
  readonly effort: string | null;
  readonly status: TerminalAgentStatus;
  readonly detail: string | null;
}

export type TerminalCompanyNodeStatus =
  | TerminalAgentStatus
  | "inactive"
  | "ready";

export interface TerminalCompanyNodeView {
  readonly roleId: string;
  readonly reportsToRoleId: string | null;
  readonly assignmentIds: readonly string[];
  readonly departmentId: string;
  readonly roleName: string;
  readonly depth: 0 | 1 | 2 | 3;
  readonly model: string | null;
  readonly effort: string | null;
  readonly status: TerminalCompanyNodeStatus;
  readonly activated: boolean;
  readonly detail: string;
}

export interface TerminalGoalView {
  readonly id: string;
  readonly objective: string;
  readonly status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  readonly activeAgents: number;
  readonly maxActiveAgents: number;
  readonly maxConcurrentAgents: number;
  readonly maxDelegationDepth: number;
  readonly maxRequests: number;
  readonly phase: string | null;
  readonly repairRound: number;
  readonly requestsUsed: number;
  readonly reviewVerdict: "approved" | "changes_requested" | "unverified" | null;
  readonly reviewFindings: number;
  readonly handoffs: {
    readonly completed: number;
    readonly failed: number;
    readonly cancelled: number;
  };
  readonly evidenceCount: number;
  readonly handoffUsage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly reportedCostUsd: number;
    readonly reported: number;
    readonly missing: number;
    readonly costReported: number;
    readonly costMissing: number;
  };
  readonly reason: string | null;
}

export interface TerminalUiSnapshot {
  readonly session: {
    readonly model: string;
    readonly mode: string;
    readonly permission: string;
    readonly workspace?: string;
  };
  readonly goal: TerminalGoalView | null;
  readonly agents: readonly TerminalAgentView[];
  readonly company: readonly TerminalCompanyNodeView[];
}

interface MutableAgent {
  executionId: string;
  parentExecutionId: string | null;
  assignmentId: string;
  parentAssignmentId: string | null;
  roleId: string;
  childAgentId: string;
  departmentId: string;
  roleName: string;
  model: string | null;
  effort: string | null;
  status: TerminalAgentStatus;
  detail: string | null;
}

interface MutableGoal {
  id: string;
  objective: string;
  status: TerminalGoalView["status"];
  maxActiveAgents: number;
  maxConcurrentAgents: number;
  maxDelegationDepth: number;
  maxRequests: number;
  phase: string | null;
  repairRound: number;
  requestsUsed: number;
  reviewVerdict: TerminalGoalView["reviewVerdict"];
  reviewFindings: number;
  handoffs: { completed: number; failed: number; cancelled: number };
  evidence: Set<string>;
  handoffUsage: {
    inputTokens: number;
    outputTokens: number;
    reportedCostUsd: number;
    reported: number;
    missing: number;
    costReported: number;
    costMissing: number;
  };
  reason: string | null;
}

export class TerminalUiState implements EventSink {
  readonly #session: TerminalUiSnapshot["session"];
  readonly #blueprint: CompanyBlueprintV2 | null;
  readonly #assignments = new Map<string, MutableAgent>();
  readonly #activatedAssignments = new Set<string>();
  #goal: MutableGoal | null = null;
  #onChange: (() => void) | null = null;

  constructor(
    session: TerminalUiSnapshot["session"],
    blueprint: CompanyBlueprintV2 | null = null,
  ) {
    this.#session = Object.freeze({ ...session });
    this.#blueprint = blueprint;
  }

  restoreExecutions(executions: readonly AgentExecution[]): void {
    for (const execution of executions) {
      if (execution.parentExecutionId === null) continue;
      const previous = [...this.#assignments.values()].find((agent) => agent.executionId === execution.executionId);
      this.#assignments.set(execution.executionId, {
        executionId: execution.executionId,
        parentExecutionId: execution.parentExecutionId,
        assignmentId: previous?.assignmentId ?? execution.executionId,
        parentAssignmentId: previous?.parentAssignmentId ?? null,
        childAgentId: execution.agentId,
        roleId: execution.roleId,
        departmentId: previous?.departmentId ?? "agents",
        roleName: this.#blueprint?.roles.find((role) => role.id === execution.roleId)?.displayName ?? execution.roleName,
        model: execution.model,
        effort: execution.effort,
        status: execution.status,
        detail: execution.detail ?? execution.description,
      });
      this.#activatedAssignments.add(execution.executionId);
    }
    this.#onChange?.();
  }

  onChange(listener: (() => void) | null): void {
    this.#onChange = listener;
  }

  readonly emit = async (event: RecursEvent): Promise<void> => {
    switch (event.type) {
      case "company_goal_started":
        this.#goal = {
          id: event.goalRunId,
          objective: event.objective,
          status: "running",
          maxActiveAgents: event.maxActiveAgents,
          maxConcurrentAgents: event.maxConcurrentAgents,
          maxDelegationDepth: event.maxDelegationDepth,
          maxRequests: event.maxRequests,
          phase: null,
          repairRound: 0,
          requestsUsed: 0,
          reviewVerdict: null,
          reviewFindings: 0,
          handoffs: { completed: 0, failed: 0, cancelled: 0 },
          evidence: new Set(),
          handoffUsage: {
            inputTokens: 0,
            outputTokens: 0,
            reportedCostUsd: 0,
            reported: 0,
            missing: 0,
            costReported: 0,
            costMissing: 0,
          },
          reason: null,
        };
        break;
      case "company_assignment_started":
        this.#activatedAssignments.delete(event.assignmentId);
        this.#assignments.set(event.assignmentId, {
          executionId: "",
          parentExecutionId: null,
          assignmentId: event.assignmentId,
          parentAssignmentId: event.parentAssignmentId,
          roleId: event.roleId,
          childAgentId: event.childAgentId,
          departmentId: event.departmentId,
          roleName: event.roleName,
          model: null,
          effort: null,
          status: "running",
          detail: null,
        });
        break;
      case "agent_started": {
        const placeholder = [...this.#assignments.values()].find(
          (candidate) => candidate.childAgentId === event.childAgentId && candidate.executionId === "",
        );
        if (placeholder !== undefined) this.#assignments.delete(placeholder.assignmentId);
        const parent = [...this.#assignments.values()].find((candidate) => candidate.childAgentId === event.parentAgentId);
        this.#assignments.set(event.childSessionId, {
          executionId: event.childSessionId,
          parentExecutionId: event.sessionId,
          assignmentId: placeholder?.assignmentId ?? event.childSessionId,
          parentAssignmentId: placeholder?.parentAssignmentId ?? parent?.assignmentId ?? null,
          childAgentId: event.childAgentId,
          roleId: placeholder?.roleId ?? event.company?.roleId ?? event.profileId,
          departmentId: placeholder?.departmentId ?? "agents",
          roleName: placeholder?.roleName ?? event.profileId.replace(/_v\d+$/u, ""),
          model: event.modelId,
          effort: event.reasoningEffort,
          status: "running",
          detail: event.description,
        });
        this.#activatedAssignments.add(event.childSessionId);
        break;
      }
      case "agent_completed":
      case "agent_failed":
      case "agent_cancelled": {
        const agent = this.#assignments.get(event.childSessionId);
        if (agent !== undefined) {
          agent.status = event.type === "agent_completed" ? "completed" : event.type === "agent_failed" ? "failed" : "cancelled";
          agent.detail = event.type === "agent_failed" ? event.failure.safeMessage : event.type === "agent_cancelled" ? event.reason : agent.detail;
        }
        break;
      }
      case "company_handoff_completed":
        this.#finishAgent(event.assignmentId, "completed", null);
        if (this.#goal?.id === event.goalRunId) {
          this.#goal.handoffs.completed += 1;
          for (const item of event.evidence) this.#goal.evidence.add(item);
          if (event.usage === null) {
            this.#goal.handoffUsage.missing += 1;
            this.#goal.handoffUsage.costMissing += 1;
          } else {
            this.#goal.handoffUsage.reported += 1;
            this.#goal.handoffUsage.inputTokens += event.usage.inputTokens;
            this.#goal.handoffUsage.outputTokens += event.usage.outputTokens;
            if (event.usage.costUsd === undefined) {
              this.#goal.handoffUsage.costMissing += 1;
            } else {
              this.#goal.handoffUsage.costReported += 1;
              this.#goal.handoffUsage.reportedCostUsd += event.usage.costUsd;
            }
          }
        }
        break;
      case "company_handoff_failed":
        this.#finishAgent(event.assignmentId, "failed", event.reason);
        if (this.#goal?.id === event.goalRunId) this.#goal.handoffs.failed += 1;
        break;
      case "company_handoff_cancelled":
        this.#finishAgent(event.assignmentId, "cancelled", event.reason);
        if (this.#goal?.id === event.goalRunId) this.#goal.handoffs.cancelled += 1;
        break;
      case "agent_team_activity":
        if (event.goalRunId !== undefined && this.#goal?.id === event.goalRunId) {
          this.#goal.phase = event.phase;
          this.#goal.repairRound = event.phase === "repair" ? event.round : 0;
          this.#goal.requestsUsed = event.counts.requestsUsed;
          if (event.reviewVerdict !== undefined) {
            this.#goal.reviewVerdict = event.reviewVerdict;
            this.#goal.reviewFindings = event.findingCount ?? 0;
          }
        }
        break;
      case "company_goal_completed":
      case "company_goal_failed":
      case "company_goal_cancelled":
      case "company_goal_interrupted":
        if (this.#goal?.id === event.goalRunId) {
          this.#goal.status = event.status;
          this.#goal.reason = event.reason ?? null;
          this.#goal.requestsUsed = event.workflow.requestsUsed;
          this.#goal.evidence = new Set(event.evidence);
        }
        break;
      default:
        break;
    }
    this.#onChange?.();
  };

  #finishAgent(
    assignmentId: string,
    status: Exclude<TerminalAgentStatus, "running">,
    detail: string | null,
  ): void {
    const matches = [...this.#assignments.values()].filter((agent) => agent.assignmentId === assignmentId);
    const agent = matches.findLast((candidate) => candidate.status === "running") ?? matches.at(-1);
    if (agent === undefined) return;
    agent.status = status;
    if (detail !== null) agent.detail = detail;
  }

  snapshot(): TerminalUiSnapshot {
    const depth = (agent: MutableAgent): number => {
      let current = agent;
      let value = 1;
      const seen = new Set([agent.assignmentId]);
      while (current.parentExecutionId !== null) {
        if (seen.has(current.parentExecutionId)) break;
        seen.add(current.parentExecutionId);
        const parent = this.#assignments.get(current.parentExecutionId);
        if (parent === undefined) break;
        current = parent;
        value += 1;
      }
      return value;
    };
    const agents = [...this.#assignments.values()]
      .filter((agent) => this.#activatedAssignments.has(agent.executionId))
      .map((agent): TerminalAgentView => Object.freeze({
        ...agent,
        depth: depth(agent),
      }))
      .sort((left, right) =>
        left.depth - right.depth ||
        left.assignmentId.localeCompare(right.assignmentId)
      );
    const activeAgents = agents.filter((agent) => agent.status === "running").length;
    const goal = this.#goal === null
      ? null
      : (() => {
          const { evidence, ...view } = this.#goal;
          return Object.freeze({
            ...view,
            evidenceCount: evidence.size,
            activeAgents,
          });
        })();
    const company = this.#companyView(agents, goal);
    return Object.freeze({
      session: this.#session,
      goal,
      agents: Object.freeze(agents),
      company,
    });
  }

  #companyView(
    agents: readonly TerminalAgentView[],
    goal: TerminalGoalView | null,
  ): readonly TerminalCompanyNodeView[] {
    if (this.#blueprint === null) {
      const parentStatus: TerminalCompanyNodeStatus = goal?.status === "running"
        ? "running"
        : goal?.status === "completed" || goal?.status === "failed" ||
            goal?.status === "cancelled"
          ? goal.status
          : "ready";
      return Object.freeze([Object.freeze({
        roleId: "parent",
        reportsToRoleId: null,
        assignmentIds: Object.freeze([]),
        departmentId: "company",
        roleName: "Parent",
        depth: 0,
        model: this.#session.model,
        effort: null,
        status: parentStatus,
        activated: true,
        detail: goal?.phase ?? (goal === null ? "ready" : goal.status),
      } satisfies TerminalCompanyNodeView), ...agents.map((agent) =>
        Object.freeze({
          roleId: agent.roleId,
          reportsToRoleId: agent.parentAssignmentId === null
            ? "parent"
            : agents.find((candidate) =>
                candidate.assignmentId === agent.parentAssignmentId
              )?.roleId ?? "parent",
          assignmentIds: Object.freeze([agent.assignmentId]),
          departmentId: agent.departmentId,
          roleName: agent.roleName,
          depth: Math.min(3, agent.depth) as 1 | 2 | 3,
          model: agent.model,
          effort: agent.effort,
          status: agent.status,
          activated: true,
          detail: agent.detail ?? agent.status,
        } satisfies TerminalCompanyNodeView)
      )]);
    }

    const byRole = new Map(this.#blueprint.roles.map((role) => [role.id, role]));
    const rootRoleId = this.#blueprint.authorityAnchors.rootRoleId;
    const depthOf = (roleId: string): 0 | 1 | 2 | 3 => {
      let current = byRole.get(roleId);
      let depth = 0;
      const seen = new Set<string>();
      while (current?.reportsTo !== null && current?.reportsTo !== undefined) {
        if (seen.has(current.id)) break;
        seen.add(current.id);
        depth += 1;
        current = byRole.get(current.reportsTo);
      }
      return Math.min(3, depth) as 0 | 1 | 2 | 3;
    };
    const statusFor = (
      roleId: string,
      matches: readonly TerminalAgentView[],
    ): TerminalCompanyNodeStatus => {
      if (roleId === rootRoleId) {
        if (goal?.status === "running") return "running";
        if (goal?.status === "completed" || goal?.status === "failed" ||
          goal?.status === "cancelled") return goal.status;
        return "ready";
      }
      if (matches.length === 0) return "inactive";
      if (matches.some((agent) => agent.status === "running")) return "running";
      if (matches.every((agent) => agent.status === "completed")) return "completed";
      if (matches.some((agent) => agent.status === "failed")) return "failed";
      if (matches.some((agent) => agent.status === "unknown")) return "unknown";
      if (matches.some((agent) => agent.status === "ready")) return "ready";
      return "cancelled";
    };
    const children = new Map<string, string[]>();
    for (const role of this.#blueprint.roles) {
      if (role.reportsTo === null) continue;
      const siblings = children.get(role.reportsTo) ?? [];
      siblings.push(role.id);
      children.set(role.reportsTo, siblings);
    }
    const traversal: string[] = [];
    const visit = (roleId: string): void => {
      traversal.push(roleId);
      for (const childId of children.get(roleId) ?? []) visit(childId);
    };
    visit(rootRoleId);
    const traversalOrder = new Map(
      traversal.map((roleId, index) => [roleId, index]),
    );
    return Object.freeze(this.#blueprint.roles.map((role) => {
      const matches = agents.filter((agent) => agent.roleId === role.id);
      const representative = matches.find((agent) => agent.status === "running") ??
        matches.at(-1);
      const status = statusFor(role.id, matches);
      const isRoot = role.id === rootRoleId;
      return Object.freeze({
        roleId: role.id,
        reportsToRoleId: role.reportsTo,
        assignmentIds: Object.freeze(matches.map((agent) => agent.assignmentId)),
        departmentId: role.departmentId,
        roleName: role.displayName,
        depth: depthOf(role.id),
        model: isRoot ? this.#session.model : representative?.model ?? null,
        effort: isRoot ? null : representative?.effort ?? null,
        status,
        activated: isRoot || matches.length > 0,
        detail: isRoot
          ? goal?.phase ?? (goal === null ? "ready" : goal.status)
          : matches.length === 0
            ? "not activated"
            : representative?.detail ?? (matches.length === 1
              ? status
              : `${matches.length} assignments · ${status}`),
      } satisfies TerminalCompanyNodeView);
    }).sort((left, right) =>
      left.depth - right.depth ||
      (traversalOrder.get(left.roleId) ?? Number.MAX_SAFE_INTEGER) -
        (traversalOrder.get(right.roleId) ?? Number.MAX_SAFE_INTEGER)
    ));
  }
}
