import { Key, Text, matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { AgentExecutionDetail } from "@recurs/core";
import { sanitizeTerminalText } from "./terminal-text.js";
import { formatTerminalLabel } from "./terminal-style.js";

/** Read-only child inspection never shares the parent's composer or transcript. */
export class ExecutionInspector implements Component {
  #detail: AgentExecutionDetail | null = null;
  #notice = "Loading execution…";
  #offset = 0;
  #executionId: string | null = null;
  #cancelling = false;
  #body = new Text();
  constructor(private readonly actions: {
    rows(): number;
    back(): void;
    refresh(): void;
    reload(): void;
    cancel(executionId: string): void;
  }) {}

  invalidate(): void { this.#body.invalidate(); }

  show(detail: AgentExecutionDetail | null, notice?: string): void {
    if (detail !== null && detail.execution.executionId !== this.#executionId) this.#offset = 0;
    if (detail !== null) this.#executionId = detail.execution.executionId;
    this.#detail = detail;
    this.#cancelling = false;
    this.#notice = notice ?? (detail === null ? "Execution is unavailable in this session." : "");
    if (detail === null) { this.#body.setText(""); return; }
    const execution = detail.execution;
    const permissions = execution.permissions;
    const limits = execution.limits;
    const usage = execution.usage;
    const recovery = execution.companyGoalRunId != null
      ? [`Goal: ${execution.companyGoalRunId}`, `Inspect goal: /company run ${execution.companyGoalRunId}`,
          ...(execution.status === "unknown" || execution.status === "failed" ? [`Recover from parent: /company resume ${execution.companyGoalRunId}`] : [])]
      : execution.teamRunId != null
      ? [`Team: ${execution.teamRunId}`, `Inspect team: /agents team ${execution.teamRunId}`,
          ...(execution.status === "unknown" || execution.status === "failed" ? [`Recover from parent: /agents resume ${execution.teamRunId}`] : [])]
      : [];
    this.#body.setText(sanitizeTerminalText([
      `Task: ${execution.description}`,
      `Execution: ${execution.executionId}`,
      `Parent: ${execution.parentExecutionId ?? "none"}`,
      `Depth: ${execution.depth} (parent conversation is depth 0)`,
      `Permissions: ${formatTerminalLabel(permissions.executionMode ?? "unknown")} · ${formatTerminalLabel(permissions.permissionMode ?? "unknown")}`,
      `Parent ceiling: ${formatTerminalLabel(permissions.parentExecutionMode ?? "unknown")} · ${formatTerminalLabel(permissions.parentPermissionMode ?? "unknown")}`,
      ...(limits === undefined ? [] : [
        `Limits: depth ≤ ${limits.maxDepth} · concurrent children ≤ ${limits.maxConcurrentChildren}`,
        `Budget: ${limits.maxRequests} requests · ${limits.maxRetries} retries · $${limits.maxReportedCostUsd.toFixed(2)} reported cost`,
        "Limits are ceilings, not permission to create more agents.",
      ]),
      ...(execution.updatedAt === undefined ? [] : [`Last recorded: ${execution.updatedAt}`]),
      ...recovery,
      usage == null ? "Usage: not reported" : `Usage: ${usage.inputTokens} input · ${usage.outputTokens} output tokens · ${usage.costUsd === undefined ? "cost not reported" : `$${usage.costUsd.toFixed(4)} reported`}`,
      `Changed files: ${execution.changedFiles.join(", ") || "none recorded"}`,
      ...execution.evidence.map((item) => `Evidence: ${item}`),
      ...(execution.detail === null ? [] : [execution.detail]),
      detail.transcriptNotice ?? "",
      "",
      ...detail.messages.flatMap((message) => [
        `── ${message.role} ──`, message.content,
        ...((message.toolCalls ?? []).map((call) => `Tool ${call.name}: ${JSON.stringify(call.arguments)}`)), "",
      ]),
    ].join("\n")));
  }

  render(width: number): string[] {
    const height = Math.max(1, this.actions.rows());
    const fit = (text: string): string => truncateToWidth(sanitizeTerminalText(text, { multiline: false }), Math.max(1, width));
    const execution = this.#detail?.execution;
    const header = execution === undefined ? "Recurs · Execution" : `Recurs · ${execution.roleName} · ${execution.status}`;
    const route = execution === undefined ? this.#notice : `${execution.model}${execution.effort === null ? "" : ` / ${execution.effort}`} · read-only transcript`;
    const footer = fit(execution?.capabilities.cancel === true
      ? "Esc back · Ctrl+C stop subtree · R refresh · PgUp/PgDn scroll"
      : "Esc back · R refresh · PgUp/PgDn scroll");
    const notice = fit(this.#cancelling ? "Cancellation requested; refreshing execution state…" : execution?.capabilities.reason ?? this.#notice);
    const body = this.#body.render(Math.max(1, width));
    const available = Math.max(0, height - 4);
    this.#offset = Math.max(0, Math.min(this.#offset, body.length - available));
    const visible = body.slice(this.#offset, this.#offset + available);
    while (visible.length < available) visible.push("");
    return [fit(header), fit(route), ...visible, notice, footer].slice(-height);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || data === "q") { this.actions.back(); return; }
    if (data.toLowerCase() === "r") { this.actions.reload(); return; }
    if (matchesKey(data, Key.ctrl("c"))) {
      const execution = this.#detail?.execution;
      if (execution?.capabilities.cancel === true && !this.#cancelling) {
        this.#cancelling = true;
        this.actions.refresh();
        this.actions.cancel(execution.executionId);
      }
      return;
    }
    const page = Math.max(1, this.actions.rows() - 4);
    if (matchesKey(data, Key.down)) this.#offset += 1;
    else if (matchesKey(data, Key.up)) this.#offset = Math.max(0, this.#offset - 1);
    else if (matchesKey(data, Key.pageDown)) this.#offset += page;
    else if (matchesKey(data, Key.pageUp)) this.#offset = Math.max(0, this.#offset - page);
    else if (matchesKey(data, Key.home)) this.#offset = 0;
    else if (matchesKey(data, Key.end)) this.#offset = Number.MAX_SAFE_INTEGER;
    this.actions.refresh();
  }
}
