import { Key, Text, matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { AgentExecutionDetail } from "@recurs/core";
import { sanitizeTerminalText } from "./terminal-text.js";

/** Read-only child inspection never shares the parent's composer or transcript. */
export class ExecutionInspector implements Component {
  #detail: AgentExecutionDetail | null = null;
  #notice = "Loading execution…";
  #offset = 0;
  #executionId: string | null = null;
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
    this.#notice = notice ?? (detail === null ? "Execution is unavailable in this session." : "");
    if (detail === null) { this.#body.setText(""); return; }
    const execution = detail.execution;
    this.#body.setText(sanitizeTerminalText([
      `Task: ${execution.description}`,
      `Execution: ${execution.executionId}`,
      `Parent: ${execution.parentExecutionId ?? "none"}`,
      `Authority: ${JSON.stringify(execution.permissions)}`,
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
      ? "↑↓/PgUp/PgDn scroll · R refresh · Ctrl+C cancel this subtree · Esc back"
      : "↑↓/PgUp/PgDn scroll · R refresh · Esc back");
    const notice = fit(execution?.capabilities.reason ?? this.#notice);
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
      if (execution?.capabilities.cancel === true) this.actions.cancel(execution.executionId);
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
