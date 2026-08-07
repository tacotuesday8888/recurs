import type { EventSink, RecursEvent } from "@recurs/core";

import { renderRecursBrandRows } from "./terminal-style.js";
import { sanitizeTerminalText } from "./terminal-text.js";

export type TerminalAgentStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface TerminalAgentView {
  readonly assignmentId: string;
  readonly parentAssignmentId: string | null;
  readonly childAgentId: string;
  readonly departmentId: string;
  readonly roleName: string;
  readonly depth: number;
  readonly model: string | null;
  readonly effort: string | null;
  readonly status: TerminalAgentStatus;
  readonly detail: string | null;
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
  };
  readonly goal: TerminalGoalView | null;
  readonly agents: readonly TerminalAgentView[];
}

interface MutableAgent {
  assignmentId: string;
  parentAssignmentId: string | null;
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
  readonly #assignments = new Map<string, MutableAgent>();
  readonly #activatedAssignments = new Set<string>();
  #goal: MutableGoal | null = null;
  #onChange: (() => void) | null = null;

  constructor(session: TerminalUiSnapshot["session"]) {
    this.#session = Object.freeze({ ...session });
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
        this.#assignments.clear();
        this.#activatedAssignments.clear();
        break;
      case "company_assignment_started":
        this.#activatedAssignments.delete(event.assignmentId);
        this.#assignments.set(event.assignmentId, {
          assignmentId: event.assignmentId,
          parentAssignmentId: event.parentAssignmentId,
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
        const agent = [...this.#assignments.values()].find(
          (candidate) => candidate.childAgentId === event.childAgentId,
        );
        if (agent !== undefined) {
          agent.model = event.modelId;
          agent.effort = event.reasoningEffort;
          this.#activatedAssignments.add(agent.assignmentId);
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
    const agent = this.#assignments.get(assignmentId);
    if (agent === undefined) return;
    agent.status = status;
    agent.detail = detail;
  }

  snapshot(): TerminalUiSnapshot {
    const depth = (agent: MutableAgent): number => {
      let current = agent;
      let value = 1;
      const seen = new Set([agent.assignmentId]);
      while (current.parentAssignmentId !== null) {
        if (seen.has(current.parentAssignmentId)) break;
        seen.add(current.parentAssignmentId);
        const parent = this.#assignments.get(current.parentAssignmentId);
        if (parent === undefined) break;
        current = parent;
        value += 1;
      }
      return value;
    };
    const agents = [...this.#assignments.values()]
      .filter((agent) => this.#activatedAssignments.has(agent.assignmentId))
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
    return Object.freeze({
      session: this.#session,
      goal,
      agents: Object.freeze(agents),
    });
  }
}

function fit(text: string, width: number): string {
  const safeText = sanitizeTerminalText(text, { multiline: false });
  if (safeText.length <= width) return safeText;
  if (width <= 1) return safeText.slice(0, width);
  return `${safeText.slice(0, width - 1)}…`;
}

function centered(text: string, width: number): string {
  const value = fit(text, width);
  return `${" ".repeat(Math.max(0, Math.floor((width - value.length) / 2)))}${value}`;
}

function brandRows(width: number): readonly string[] {
  return renderRecursBrandRows(width).map((row) =>
    centered(row.trimEnd(), width)
  );
}

function statusMark(status: TerminalAgentStatus): string {
  switch (status) {
    case "running": return "◆";
    case "completed": return "✓";
    case "failed": return "×";
    case "cancelled": return "−";
  }
}

function mascot(depth: number, frame: number, active: boolean): string {
  const step = active && frame % 2 === 1 ? "▞" : "▚";
  if (depth <= 1) return `${step}▟█▙${step}`;
  if (depth === 2) return `${step}▐◆▌${step}`;
  return `${step}◆${step}`;
}

function agentLabel(
  agent: TerminalAgentView,
  frame: number,
  selected: boolean,
): string {
  const route = agent.model === null
    ? "route pending"
    : `${agent.model}${agent.effort === null ? "" : ` · ${agent.effort}`}`;
  const branch = agent.depth <= 1 ? "" : `${"  ".repeat(agent.depth - 2)}└─ `;
  return `${selected ? "›" : " "} ${branch}${mascot(agent.depth, frame, agent.status === "running")}  ${statusMark(agent.status)} ${agent.roleName.toUpperCase()}  ${route}`;
}

function connector(width: number, depth: number, frame: number): string {
  const dotted = frame % 2 === 0 ? "······" : "·•····";
  return centered(
    depth === 1 ? `╭${dotted}┴${dotted}╮` : `╰${dotted}┬${dotted}╯`,
    width,
  );
}

function compactCount(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}K`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`;
}

function reviewSummary(goal: TerminalGoalView): string | null {
  if (goal.reviewVerdict === null) return null;
  const verdict = goal.reviewVerdict.replaceAll("_", " ").toUpperCase();
  const findings = goal.reviewFindings === 0
    ? "NO FINDINGS"
    : `${goal.reviewFindings} ${goal.reviewFindings === 1 ? "FINDING" : "FINDINGS"}`;
  return `REVIEW ${verdict} · ${findings}`;
}

function handoffSummary(goal: TerminalGoalView): string {
  const parts = [`HANDOFFS ${goal.handoffs.completed} DONE`];
  if (goal.handoffs.failed > 0) parts.push(`${goal.handoffs.failed} FAILED`);
  if (goal.handoffs.cancelled > 0) parts.push(`${goal.handoffs.cancelled} CANCELLED`);
  parts.push(`EVIDENCE ${goal.evidenceCount}`);
  return parts.join(" · ");
}

function usageSummary(goal: TerminalGoalView): string {
  const usage = goal.handoffUsage;
  if (usage.reported === 0) {
    return usage.missing === 0 ? "USAGE PENDING" : "USAGE UNKNOWN";
  }
  const cost = usage.costMissing === 0 && usage.costReported > 0
    ? `$${usage.reportedCostUsd.toFixed(2)} REPORTED`
    : "COST UNKNOWN";
  return `USAGE PARTIAL · ${compactCount(usage.inputTokens)} IN · ${
    compactCount(usage.outputTokens)
  } OUT · ${cost}`;
}

export function renderCompanyHome(
  snapshot: TerminalUiSnapshot,
  requestedWidth: number,
  frame: number,
  selectedAssignmentId?: string,
): readonly string[] {
  const width = Math.max(1, requestedWidth);
  const lines = [
    ...brandRows(width),
    centered("RECURS / COMPANY", width),
    centered("THE BEST CODING MODEL IS A TEAM · YOU CONTROL THE TEAM", width),
    "",
    centered(`▚▟██▙▞  ◆ PARENT  ${snapshot.session.model}`, width),
  ];
  if (snapshot.agents.length === 0) {
    const empty = snapshot.goal === null
      ? "READY · START A COMPANY GOAL FROM CHAT"
      : snapshot.goal.status === "running"
        ? "GOAL RUNNING · WAITING FOR AGENT ACTIVATION"
        : `NO AGENTS ACTIVE · GOAL ${snapshot.goal.status.toUpperCase()}`;
    lines.push(
      connector(width, 1, frame),
      centered(empty, width),
    );
  } else {
    const maximumDepth = Math.max(...snapshot.agents.map((agent) => agent.depth));
    for (let depth = 1; depth <= maximumDepth; depth += 1) {
      const layer = snapshot.agents.filter((agent) => agent.depth === depth);
      if (layer.length === 0) continue;
      lines.push(connector(width, depth, frame));
      for (const agent of layer) {
        lines.push(centered(
          agentLabel(agent, frame, agent.assignmentId === selectedAssignmentId),
          width,
        ));
      }
    }
  }
  const selected = snapshot.agents.find(
    (agent) => agent.assignmentId === selectedAssignmentId,
  );
  if (selected !== undefined) {
    lines.push(centered(
      `${selected.departmentId.toUpperCase()} · ${selected.status.toUpperCase()}${
        selected.detail === null ? "" : ` · ${selected.detail}`
      }`,
      width,
    ));
  }
  const goal = snapshot.goal;
  lines.push(
    "",
    centered(
      goal === null
        ? `${snapshot.session.mode} · ${snapshot.session.permission}`
        : `${goal.status.toUpperCase()} · ${goal.activeAgents}/${goal.maxActiveAgents} ACTIVE · ${goal.objective}`,
    width,
    ),
    ...(goal === null
      ? []
      : [
          centered(
            `${goal.phase === null ? "STARTING" : goal.phase.toUpperCase()}${
              goal.phase === "repair" ? ` ${goal.repairRound}` : ""
            } · REQUESTS ${goal.requestsUsed}/${goal.maxRequests}`,
            width,
          ),
          ...(reviewSummary(goal) === null
            ? []
            : [centered(reviewSummary(goal)!, width)]),
          centered(handoffSummary(goal), width),
          centered(usageSummary(goal), width),
          ...(goal.reason === null
            ? []
            : [centered(`DETAIL · ${goal.reason}`, width)]),
        ]),
    centered(
      snapshot.agents.length === 0
        ? "ENTER CHAT   Q QUIT"
        : "ENTER CHAT   ↑↓ INSPECT   Q QUIT",
      width,
    ),
  );
  return Object.freeze(lines);
}
