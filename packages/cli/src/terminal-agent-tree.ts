import { stripVTControlCharacters } from "node:util";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { TerminalCompanyNodeView, TerminalUiSnapshot } from "./terminal-ui-state.js";
import { sanitizeTerminalText } from "./terminal-text.js";
import { formatTerminalLabel } from "./terminal-style.js";

/** Configured roles are distinct from the actual executions in the task panel. */
export function renderCompanyHome(
  snapshot: TerminalUiSnapshot,
  requestedWidth: number,
  _frame: number,
  selectedRoleId?: string,
  requestedHeight?: number,
): readonly string[] {
  const width = Math.max(1, Math.floor(requestedWidth));
  const height = Math.max(1, requestedHeight ?? 28);
  const fit = (text: string): string => stripVTControlCharacters(truncateToWidth(
    sanitizeTerminalText(text, { multiline: false }), width, "…", false,
  ));
  const ordered: TerminalCompanyNodeView[] = [];
  const visited = new Set<string>();
  const visit = (node: TerminalCompanyNodeView): void => {
    if (visited.has(node.roleId)) return;
    visited.add(node.roleId);
    ordered.push(node);
    snapshot.company.filter((child) => child.reportsToRoleId === node.roleId)
      .forEach(visit);
  };
  snapshot.company.filter((node) => node.reportsToRoleId === null).forEach(visit);
  snapshot.company.forEach(visit);
  const selectedIndex = Math.max(0, ordered.findIndex((node) => node.roleId === selectedRoleId));
  const selected = ordered[selectedIndex];
  const active = snapshot.agents.filter((agent) => agent.status === "running").length;
  const configured = snapshot.configuredCompany !== false;
  const header = fit(`Recurs · ${snapshot.session.workspace ?? "workspace"} · Team`);
  const status = fit(`${snapshot.session.model} · ${formatTerminalLabel(snapshot.session.mode)} · ${formatTerminalLabel(snapshot.session.permission)}`);
  const goal = snapshot.goal;
  const details = [
    fit(configured ? `${ordered.length} configured roles · ${active} running · ${snapshot.agents.length} executions in history` : `${snapshot.agents.length} actual child executions · ${active} running`),
    ...(goal === null ? [] : [fit(`Goal limits: depth ${goal.maxDelegationDepth} · ${goal.maxActiveAgents} active roles · ${goal.maxConcurrentAgents} concurrent`)]),
    fit(goal === null ? "Start a coding task in chat, or launch an approved goal." : `${goal.status} · ${goal.objective}`),
  ];
  const goalDetails: string[] = [];
  if (goal !== null) {
    goalDetails.push(`${(goal.phase ?? "starting").toUpperCase()}${goal.phase === "repair" ? ` ${goal.repairRound}` : ""} · REQUESTS ${goal.requestsUsed}/${goal.maxRequests}`);
    if (goal.reviewVerdict !== null) goalDetails.push(`REVIEW ${goal.reviewVerdict.replaceAll("_", " ").toUpperCase()} · ${goal.reviewFindings} FINDINGS`);
    goalDetails.push(`HANDOFFS ${goal.handoffs.completed} DONE · ${goal.handoffs.failed} FAILED · ${goal.handoffs.cancelled} CANCELLED · EVIDENCE ${goal.evidenceCount}`);
    const usage = goal.handoffUsage;
    const count = (value: number): string => value < 1000 ? String(value) : `${(value / 1000).toFixed(1)}K`;
    goalDetails.push(usage.reported === 0 ? "USAGE UNKNOWN" : `USAGE PARTIAL · ${count(usage.inputTokens)} IN · ${count(usage.outputTokens)} OUT · ${usage.costMissing === 0 && usage.costReported > 0 ? `$${usage.reportedCostUsd.toFixed(2)} REPORTED` : "COST UNKNOWN"}`);
    if (goal.reason !== null) goalDetails.push(goal.reason);
  }
  const footer = [
    fit(selected === undefined ? "No role selected" : `${selected.roleName} · ${selected.status} · ${selected.detail}`),
    fit("Ctrl+G chat · Enter inspect · ↑↓ roles · Ctrl+T executions"),
  ];
  if (height < 5 + details.length) {
    const compact = [header, status, ...details];
    while (compact.length < height - footer.length) compact.push("");
    return [...compact, ...footer].slice(-height);
  }
  const summary = height >= 22 ? goalDetails.map(fit) : [];
  const count = Math.max(0, height - 5 - details.length - summary.length);
  const start = Math.min(Math.max(0, selectedIndex - count + 1), Math.max(0, ordered.length - count));
  const rows = ordered.slice(start, start + count).map((node) => {
    const marker = node.roleId === selected?.roleId ? ">" : " ";
    const siblings = ordered.filter((candidate) => candidate.reportsToRoleId === node.reportsToRoleId);
    const branch = siblings.at(-1)?.roleId === node.roleId ? "└─ " : "├─ ";
    const tree = node.depth === 0 ? "" : `${"  ".repeat(Math.min(6, node.depth - 1))}${branch}`;
    const route = node.model === null ? "not activated" : node.model + (node.effort === null ? "" : ` / ${node.effort}`);
    return fit(`${marker} ${tree}${node.roleName} · ${node.status} · ${route}${node.assignmentIds.length > 1 ? ` · ${node.assignmentIds.length} executions` : ""}`);
  });
  const lines = [header, status, "", ...details, ...rows, ...summary];
  while (lines.length < height - footer.length) lines.push("");
  return Object.freeze([...lines, ...footer].slice(0, height));
}
