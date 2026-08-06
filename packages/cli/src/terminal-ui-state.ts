import type { EventSink, RecursEvent } from "@recurs/core";

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
        break;
      case "company_handoff_failed":
        this.#finishAgent(event.assignmentId, "failed", event.reason);
        break;
      case "company_handoff_cancelled":
        this.#finishAgent(event.assignmentId, "cancelled", event.reason);
        break;
      case "company_goal_completed":
      case "company_goal_failed":
      case "company_goal_cancelled":
      case "company_goal_interrupted":
        if (this.#goal?.id === event.goalRunId) {
          this.#goal.status = event.status;
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
    return Object.freeze({
      session: this.#session,
      goal: this.#goal === null
        ? null
        : Object.freeze({ ...this.#goal, activeAgents }),
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
  return `${selected ? "›" : " "} ${mascot(agent.depth, frame, agent.status === "running")}  ${statusMark(agent.status)} ${agent.roleName.toUpperCase()}  ${route}`;
}

function connector(width: number, depth: number, frame: number): string {
  const dotted = frame % 2 === 0 ? "······" : "·•····";
  return centered(
    depth === 1 ? `╭${dotted}┴${dotted}╮` : `╰${dotted}┬${dotted}╯`,
    width,
  );
}

export function renderCompanyHome(
  snapshot: TerminalUiSnapshot,
  requestedWidth: number,
  frame: number,
  selectedAssignmentId?: string,
): readonly string[] {
  const width = Math.max(1, requestedWidth);
  const lines = [
    centered("RECURS / COMPANY", width),
    centered("THE BEST CODING MODEL IS A TEAM", width),
    "",
    centered(`▚▟██▙▞  ◆ PARENT  ${snapshot.session.model}`, width),
  ];
  if (snapshot.agents.length === 0) {
    lines.push(
      connector(width, 1, frame),
      centered("NO AGENTS ACTIVE · START A GOAL FROM CHAT", width),
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
    centered(
      snapshot.agents.length === 0
        ? "ENTER CHAT   Q QUIT"
        : "ENTER CHAT   ↑↓ INSPECT   Q QUIT",
      width,
    ),
  );
  return Object.freeze(lines);
}
