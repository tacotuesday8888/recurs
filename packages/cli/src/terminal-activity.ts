import type { RecursEvent } from "@recurs/core";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "./terminal-text.js";
import { parseTerminalDiff } from "./terminal-diff.js";
import type { TerminalTheme } from "./terminal-style.js";

export type ActivityTarget = { kind: "source"; path: string; content: string; startLine: number; totalLines: number } | { kind: "diff"; patch: string } | { kind: "output"; title: string; content: string };

interface Activity { id: string; name: string; detail: string; status: "running" | "completed" | "failed" | "denied" | "cancelled" | "unconfirmed"; patch: string | null; output: string; target?: ActivityTarget }

/** Bounded presentation of observed events; never infers reasoning, tokens, or edits. */
export class TerminalActivity {
  #items: Activity[] = [];
  #targets = new Map<number, ActivityTarget>();
  #targetBounds = new Map<number, { left: number; right: number }>();
  #patches = "";
  #patch: string[] = [];
  #added = 0;
  #removed = 0;
  #files = new Set<string>();
  #started: number | null = null;
  #ended: number | null = null;
  #phase = "Waiting for model";
  constructor(private readonly now: () => number = Date.now) {}
  clear(): void { this.#items = []; this.#patches = ""; this.#targets.clear(); this.#patch = []; this.#added = 0; this.#removed = 0; this.#files.clear(); this.#started = null; this.#ended = null; }
  emit(event: RecursEvent): void {
    if (event.type === "turn_started") { this.clear(); this.#started = this.now(); this.#phase = "Waiting for model"; }
    if (event.type === "model_reasoning_delta") this.#phase = "Thinking";
    if (event.type === "model_text_delta") this.#phase = "Writing response";
    if (event.type === "permission_requested") this.#phase = "Waiting for approval";
    if (event.type === "permission_resolved") this.#phase = event.decision === "deny" ? "Permission denied" : "Working";
    if (event.type === "retry_scheduled") this.#phase = `Retry ${event.attempt} · waiting`;
    if (event.type === "tool_started") {
      this.#phase = "Running tools";
      const args = event.call.arguments as Record<string, unknown> | null;
      const patch = event.call.name === "apply_patch" && args !== null && typeof args === "object" && typeof args.patch === "string" && args.patch.length <= 1024 * 1024 ? args.patch : null;
      const target = args?.path ?? args?.command ?? args?.pattern;
      const detail = typeof target === "string" ? sanitizeTerminalText(target, { multiline: false }).slice(0, 160) : "";
      this.#items.push({ id: event.call.id, name: sanitizeTerminalText(event.call.name, { multiline: false }), detail, status: "running", patch, output: "" });
      if (this.#items.length > 32) this.#items.shift();
    }
    if (event.type === "tool_completed" || event.type === "tool_failed" || event.type === "tool_denied") {
      const item = this.#items.findLast((entry) => entry.id === event.callId);
      if (item !== undefined && item.status === "running") {
        item.status = event.type === "tool_completed" ? "completed" : event.type === "tool_denied" ? "denied" : "failed";
        if (event.type === "tool_completed" && item.patch !== null) {
          const lines = parseTerminalDiff(item.patch);
          const changes = lines.filter((line) => line.kind === "add" || line.kind === "remove");
          this.#added += changes.filter((line) => line.kind === "add").length;
          this.#removed += changes.filter((line) => line.kind === "remove").length;
          item.target = { kind: "diff", patch: sanitizeTerminalText(item.patch) };
          this.#patches = (this.#patches + item.patch).slice(0, 256 * 1024 + 1);
          this.#patch = changes.slice(0, 8).map((line) => line.text);
          const file = lines.find((line) => line.kind === "header" && line.text.startsWith("+++ "));
          if (file) item.detail = file.text.slice(4).replace(/^b\//u, "");
        }
        if (event.type === "tool_completed") {
          const output = typeof event.result.output === "string" ? event.result.output : JSON.stringify(event.result.output) ?? "";
          const detail = sanitizeTerminalText(output + (item.patch ? `\n${item.patch}` : ""));
          item.output = detail.slice(0, 8192) + (detail.length > 8192 ? "\n[Output truncated]" : "");
          const metadata = event.result.metadata;
          if (item.name === "read_file" && typeof event.result.output === "string") {
            const startLine = typeof metadata?.startLine === "number" ? metadata.startLine : 1;
            // Match read_file's 256 KiB output ceiling so links retain the entire observed range.
            const content = sanitizeTerminalText(event.result.output).slice(0, 256 * 1024);
            item.target = { kind: "source", path: typeof metadata?.path === "string" ? sanitizeTerminalText(metadata.path, { multiline: false }) : item.detail, content, startLine, totalLines: typeof metadata?.totalLines === "number" ? metadata.totalLines : content.split("\n").length };
          }
          item.target ??= { kind: "output", title: activityLabel(item.name, false), content: item.output };

        }
        if (event.type === "tool_failed") {
          item.output = sanitizeTerminalText(event.error.message).slice(0, 8192);
          item.target = { kind: "output", title: `${activityLabel(item.name, false)} · failed`, content: item.output };
        }
        item.patch = null;
      }
      if (this.#items.every((entry) => entry.status !== "running")) this.#phase = "Waiting for model";
    }
    if (event.type === "files_changed") for (const file of event.paths.slice(0, Math.max(0, 256 - this.#files.size))) this.#files.add(sanitizeTerminalText(file, { multiline: false }));
    if (event.type === "turn_cancelled" || event.type === "turn_failed" || event.type === "turn_completed") {
      this.#ended = this.now();
      this.#phase = event.type === "turn_cancelled" ? "Cancelled" : event.type === "turn_failed" ? "Failed" : "Completed";
      for (const item of this.#items) if (item.status === "running") { item.status = event.type === "turn_cancelled" ? "cancelled" : "unconfirmed"; item.patch = null; }
    }
  }
  targetAt(row: number, column?: number): ActivityTarget | undefined {
    const bounds = this.#targetBounds.get(row);
    if (column !== undefined && bounds && (column < bounds.left || column >= bounds.right)) return undefined;
    return this.#targets.get(row);
  }
  detailsMarkdown(): string {
    return this.#items.map((item) => {
      const body = [item.detail, item.output].filter(Boolean).join("\n");
      const longest = Math.max(2, ...[...body.matchAll(/`+/gu)].map((match) => match[0].length));
      const fence = "`".repeat(longest + 1);
      return `### ${activityLabel(item.name, item.status === "running")} · ${item.status}\n\n${fence}\n${body || "No output"}\n${fence}`;
    }).join("\n\n");
  }
  render(width: number, height: number, frame: number, theme: TerminalTheme, expanded = false): string[] {
    this.#targets.clear(); this.#targetBounds.clear();
    if (height < 2 || this.#started === null && this.#items.length === 0 && this.#files.size === 0) return [];
    const fit = (s: string): string => truncateToWidth(s, Math.max(1, width));
    const spinner = ["◐", "◓", "◑", "◒"][frame % 4]!;
    const seconds = this.#started === null ? 0 : Math.max(0, Math.floor(((this.#ended ?? this.now()) - this.#started) / 1000));
    const elapsed = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    const rows = [this.#started === null ? theme.muted(fit("ACTIVITY")) : theme.accent(fit(`${this.#ended === null ? spinner : "·"} ${this.#phase} · ${elapsed}${this.#ended === null ? " · Ctrl+C cancel" : ""}`))];
    // Counts remain visible even when recent tools compete for vertical space.
    const hasChanges = this.#added + this.#removed > 0;
    const summaryHeight = hasChanges ? (height >= 5 && width >= 12 ? 3 : 1) : 0;
    const itemCount = Math.min(3, Math.max(0, height - rows.length - summaryHeight));
    const items = itemCount === 0 ? [] : this.#items.slice(-itemCount);
    for (const item of items) {
      const mark = item.status === "running" ? spinner : item.status === "completed" ? "✓" : item.status === "cancelled" ? "■" : "!";
      const style = item.status === "running" ? theme.accent : item.status === "completed" ? theme.success : item.status === "cancelled" ? theme.muted : theme.failure;
      if (item.target) this.#targets.set(rows.length, item.target);
      const label = item.detail && (expanded || item.name !== "run_command") ? ` · ${theme.colorEnabled && item.target ? `\u001b[4m${item.detail}\u001b[24m` : item.detail}` : "";
      rows.push(fit(`${theme.muted(activityIcon(item.name))} ${style(mark)} ${theme.muted(activityLabel(item.name, item.status === "running"))}${["failed", "denied", "cancelled", "unconfirmed"].includes(item.status) ? style(` · ${item.status}`) : ""}${label}${item.target ? theme.muted(" ▸") : ""}`));
    }
    for (const line of (expanded ? this.#patch : []).slice(0, Math.max(0, height - rows.length))) rows.push((line.startsWith("+") ? theme.success : theme.failure)(fit(line)));
    if (!hasChanges && this.#files.size > 0 && rows.length < height) rows.push(theme.code(fit(`${this.#files.size} changed file${(this.#files.size || 1) === 1 ? "" : "s"} · ${[...this.#files].slice(0, 2).join(", ")}`)));
    if (hasChanges) {
      const label = `${this.#files.size || 1} file${(this.#files.size || 1) === 1 ? "" : "s"} changed  ${theme.success(`+${this.#added}`)} ${theme.failure(`−${this.#removed}`)}`;
      const inner = ` ${truncateToWidth(label, Math.max(1, width - 4), "…", false)} `;
      const size = visibleWidth(inner);
      const left = Math.max(0, Math.floor((width - size - 2) / 2));
      const pad = " ".repeat(left);
      const pill = summaryHeight === 3 ? [
        `${pad}${theme.muted(`╭${"─".repeat(size)}╮`)}`,
        `${pad}${theme.muted("│")}${theme.input(theme.strong(inner))}${theme.muted("│")}`,
        `${pad}${theme.muted(`╰${"─".repeat(size)}╯`)}`,
      ] : [fit(theme.strong(label))];
      if (rows.length + pill.length > height) rows.length = height - pill.length;
      for (const line of pill) {
        this.#targets.set(rows.length, { kind: "diff", patch: this.#patches });
        if (summaryHeight === 3) this.#targetBounds.set(rows.length, { left, right: left + size + 2 });
        rows.push(line);
      }
    }
    return rows.slice(0, height);
  }
}

function activityLabel(name: string, running: boolean): string {
  const labels: Record<string, [string, string]> = {
    read_file: ["Reading file", "Read file"], apply_patch: ["Editing files", "Edited files"],
    run_command: ["Running command", "Ran command"], view_image: ["Viewing image", "Viewed image"],
    list_files: ["Finding files", "Found files"], search: ["Searching", "Searched"],
    delegate_task: ["Starting agent", "Started agent"],
  };
  return labels[name]?.[running ? 0 : 1] ?? name.replaceAll("_", " ");
}

function activityIcon(name: string): string {
  return name === "read_file" ? "▤" : name === "apply_patch" ? "✎" : name === "run_command" ? "›_" : name.includes("image") ? "▧" : name.includes("search") || name.includes("find") ? "⌕" : "◇";
}
