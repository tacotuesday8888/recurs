import type { EventSink, RecursEvent } from "@recurs/core";
import type { CompanyBlueprintV2 } from "@recurs/contracts";

import { sanitizeTerminalText } from "./terminal-text.js";

export type TerminalAgentStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface TerminalAgentView {
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

function statusMark(status: TerminalCompanyNodeStatus): string {
  switch (status) {
    case "running": return "◆";
    case "completed": return "✓";
    case "failed": return "×";
    case "cancelled": return "−";
    case "inactive": return "·";
    case "ready": return "○";
  }
}

const LAYER_LABELS = Object.freeze(["DIRECT", "LEAD", "SENIOR", "WORK"]);

function mascotRows(
  depth: number,
  frame: number,
  active: boolean,
  condensed = false,
): readonly string[] {
  const face = active && frame % 2 === 1 ? "▶" : "◀";
  const feet = active && frame % 2 === 1 ? " ▀  ▀" : "▀  ▀ ";
  if (condensed) {
    if (depth === 0) {
      return Object.freeze([
        " ▄████▄ ",
        `${face}██▄██▌`,
        ` ${feet}`,
      ]);
    }
    if (depth === 1) return Object.freeze([" ▄██▄ ", `${face}████▌`]);
    return Object.freeze([depth === 2 ? `${face}███▌` : "▄██▄"]);
  }
  if (depth === 0) {
    return Object.freeze([
      "   ▄██▄   ",
      " ▄██████▄ ",
      `${face}██▄██▄██ `,
      "  ▀████▀  ",
      ` ${feet} `,
    ]);
  }
  if (depth === 1) {
    return Object.freeze([
      "  ▄██▄ ",
      `${face}████▌ `,
      " ▀██▀  ",
      ` ${feet}`,
    ]);
  }
  if (depth === 2) {
    return Object.freeze([
      " ▄██▄ ",
      `${face}███▌ `,
      "  ▀ ▀ ",
    ]);
  }
  return Object.freeze(["▄██▄", active && frame % 2 === 1 ? " ▀▀ " : "▀  ▀"]);
}

function nodeMeta(node: TerminalCompanyNodeView): string {
  if (!node.activated) return "NOT ACTIVATED";
  const route = node.model === null
    ? null
    : `${node.model}${node.effort === null ? "" : ` · ${node.effort}`}`;
  return route ?? node.detail.toUpperCase();
}

function centeredCell(text: string, width: number): string {
  const value = fit(text, Math.max(1, width));
  const used = Array.from(value).length;
  const left = Math.max(0, Math.floor((width - used) / 2));
  return `${" ".repeat(left)}${value}${" ".repeat(Math.max(0, width - used - left))}`;
}

function layerRows(
  nodes: readonly TerminalCompanyNodeView[],
  depth: number,
  width: number,
  frame: number,
  selectedRoleId: string | undefined,
  condensed = false,
): readonly string[] {
  const labelWidth = width >= 72 ? 12 : 10;
  const contentWidth = Math.max(1, width - labelWidth);
  const minimumCellWidth = depth <= 1 ? 20 : 16;
  const maximumColumns = Math.max(1, Math.floor(contentWidth / minimumCellWidth));
  const rows: string[] = [];
  for (let start = 0; start < nodes.length; start += maximumColumns) {
    const group = nodes.slice(start, start + maximumColumns);
    const cellWidth = Math.max(1, Math.floor(contentWidth / group.length));
    const pets = group.map((node) => mascotRows(
      depth,
      frame,
      node.status === "running",
      condensed,
    ));
    const petHeight = Math.max(...pets.map((pet) => pet.length));
    const petRows = Array.from({ length: petHeight }, (_, row) =>
      group.map((_, index) => centeredCell(pets[index]?.[row] ?? "", cellWidth))
        .join("")
    );
    const blockRows = condensed
      ? [
          ...petRows,
          group.map((node) => centeredCell(
            `${node.roleId === selectedRoleId ? "> " : ""}${node.roleName.toUpperCase()} · ${statusMark(node.status)} ${nodeMeta(node)}`,
            cellWidth,
          )).join(""),
        ]
      : [
          ...petRows,
          group.map((node) => centeredCell(
            `${node.roleId === selectedRoleId ? "> " : ""}${node.roleName.toUpperCase()}`,
            cellWidth,
          )).join(""),
          group.map((node) => centeredCell(
            `${statusMark(node.status)} ${nodeMeta(node)}`,
            cellWidth,
          )).join(""),
        ];
    for (const [index, row] of blockRows.entries()) {
      const label = start === 0 && index === 0
        ? `${String(depth).padStart(2, "0")}  ${LAYER_LABELS[depth] ?? "WORK"}`
        : "";
      rows.push(fit(`${label.padEnd(labelWidth)}${row}`, width));
    }
  }
  return Object.freeze(rows);
}

function connectorRows(width: number, depth: number, frame: number): readonly string[] {
  const labelWidth = width >= 72 ? 12 : 10;
  const contentWidth = Math.max(1, width - labelWidth);
  const run = Math.max(1, Math.min(42, Math.floor((contentWidth - 3) / 2)));
  const moving = Array.from({ length: run }, (_, index) =>
    index === (frame * 3 + depth * 5) % run ? "•" : "·"
  ).join("");
  return Object.freeze([
    fit(`${"".padEnd(labelWidth)}${centered(`╰${moving}┬${moving}╮`, contentWidth)}`, width),
  ]);
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

function compactCompanyHome(
  snapshot: TerminalUiSnapshot,
  width: number,
  header: string,
  goalLabel: string,
  title: string,
  selectedRoleId: string | undefined,
  requestedHeight: number | undefined,
): readonly string[] {
  const targetHeight = Math.max(
    1,
    requestedHeight ?? snapshot.company.length + 9,
  );
  const selectedIndex = Math.max(
    0,
    snapshot.company.findIndex((node) => node.roleId === selectedRoleId),
  );
  const visibleCount = Math.max(1, targetHeight - 9);
  const start = Math.min(
    Math.max(0, selectedIndex - visibleCount + 1),
    Math.max(0, snapshot.company.length - visibleCount),
  );
  const visible = snapshot.company.slice(start, start + visibleCount);
  const selected = snapshot.company[selectedIndex] ?? snapshot.company[0];
  const lines = [
    fit(header, width),
    "─".repeat(width),
    fit(goalLabel.toUpperCase(), width),
    fit(title, width),
    "",
    ...visible.map((node) => fit(
      `${String(node.depth).padStart(2, "0")} ${LAYER_LABELS[node.depth] ?? "WORK"}  ${
        node.roleId === selectedRoleId ? ">" : " "
      } ${node.roleName.toUpperCase()} · ${statusMark(node.status)} ${nodeMeta(node)}`,
      width,
    )),
  ];
  while (lines.length < targetHeight - 4) lines.push("");
  lines.push(
    fit(
      selected === undefined
        ? "NO ROLE SELECTED"
        : `✳ ${selected.roleName.toUpperCase()} · ${selected.departmentId.toUpperCase()} · ${selected.status.toUpperCase()}`,
      width,
    ),
    "─".repeat(width),
    fit(`${snapshot.session.mode} · ${snapshot.session.permission}`, width),
    fit("ENTER OPEN   ARROWS SELECT   CTRL+T TASKS   Q QUIT", width),
  );
  return Object.freeze(lines.slice(0, targetHeight));
}

export function renderCompanyHome(
  snapshot: TerminalUiSnapshot,
  requestedWidth: number,
  frame: number,
  selectedRoleId?: string,
  requestedHeight?: number,
): readonly string[] {
  const width = Math.max(1, requestedWidth);
  const workspace = (snapshot.session.workspace ?? "workspace")
    .replaceAll("_", "-").toUpperCase();
  const live = snapshot.goal?.status === "running";
  const leftHeader = width < 54
    ? "R↘ RECURS / COMPANY"
    : `R↘ RECURS / ${workspace} / COMPANY`;
  const rightHeader = `${live ? "● LIVE" : "○ READY"} · ${snapshot.session.mode.toUpperCase()}`;
  const headerGap = Math.max(1, width - Array.from(leftHeader).length -
    Array.from(rightHeader).length);
  const header = width < 54
    ? leftHeader
    : `${leftHeader}${" ".repeat(headerGap)}${rightHeader}`;
  const title = snapshot.goal === null
    ? "Your company is ready."
    : snapshot.goal.status === "running"
      ? "Your company is working."
      : snapshot.goal.status === "completed"
        ? "Your company finished."
        : `Company goal ${snapshot.goal.status}.`;
  const goalLabel = snapshot.goal === null
    ? "NO ACTIVE GOAL · START FROM CHAT"
    : `GOAL ${snapshot.goal.id} · ${snapshot.goal.objective}`;
  if (width < 40 || (requestedHeight !== undefined && requestedHeight < 22)) {
    return compactCompanyHome(
      snapshot,
      width,
      header,
      goalLabel,
      title,
      selectedRoleId,
      requestedHeight,
    );
  }
  const lines = [
    fit(header, width),
    "─".repeat(width),
    fit(goalLabel.toUpperCase(), width),
    fit(title, width),
    "",
  ];
  const depths = [...new Set(snapshot.company.map((node) => node.depth))]
    .sort((left, right) => left - right);
  const condensed = requestedHeight !== undefined && requestedHeight < 38;
  for (const depth of depths) {
    if (depth > 0) lines.push(...connectorRows(width, depth, frame));
    lines.push(...layerRows(
      snapshot.company.filter((node) => node.depth === depth),
      depth,
      width,
      frame,
      selectedRoleId,
      condensed,
    ));
  }
  const selected = snapshot.company.find(
    (node) => node.roleId === selectedRoleId,
  ) ?? snapshot.company[0];
  if (selected !== undefined) {
    lines.push(
      "",
      fit(
        `✳ ${selected.roleName.toUpperCase()}  ${selected.departmentId.toUpperCase()} · ${selected.status.toUpperCase()} · ${selected.detail}  ENTER OPEN`,
        width,
      ),
    );
  }
  const goal = snapshot.goal;
  lines.push(
    "─".repeat(width),
    fit(
      goal === null
        ? `${snapshot.session.mode} · ${snapshot.session.permission}`
        : `${goal.status.toUpperCase()} · ${goal.activeAgents}/${goal.maxActiveAgents} ACTIVE · ${goal.objective}`,
      width,
    ),
    ...(goal === null || condensed
      ? []
      : [
          fit(
            `${goal.phase === null ? "STARTING" : goal.phase.toUpperCase()}${
              goal.phase === "repair" ? ` ${goal.repairRound}` : ""
            } · REQUESTS ${goal.requestsUsed}/${goal.maxRequests}`,
            width,
          ),
          ...(reviewSummary(goal) === null
            ? []
            : [fit(reviewSummary(goal)!, width)]),
          fit(handoffSummary(goal), width),
          fit(usageSummary(goal), width),
          ...(goal.reason === null
            ? []
            : [fit(`DETAIL · ${goal.reason}`, width)]),
        ]),
    fit(
      snapshot.company.length <= 1
        ? "ENTER CHAT   CTRL+Q QUIT"
        : "ENTER OPEN   ARROWS SELECT   / COMMANDS   CTRL+Q QUIT",
      width,
    ),
  );
  if (requestedHeight === undefined) return Object.freeze(lines);
  const height = Math.max(1, requestedHeight);
  if (lines.length < height) {
    const footerRows = goal === null || condensed ? 3 : 7 +
      (reviewSummary(goal) === null ? 0 : 1) + (goal.reason === null ? 0 : 1);
    const insertion = Math.max(5, lines.length - footerRows);
    lines.splice(insertion, 0, ...Array.from(
      { length: height - lines.length },
      () => "",
    ));
  }
  return Object.freeze(lines.slice(0, height));
}
