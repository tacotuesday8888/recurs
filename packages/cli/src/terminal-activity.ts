import type { RecursEvent } from "@recurs/core";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "./terminal-text.js";
import { parseTerminalDiff } from "./terminal-diff.js";
import type { TerminalTheme } from "./terminal-style.js";

interface Activity { id: string; name: string; detail: string; status: "running" | "completed" | "failed" | "denied" | "cancelled" | "unconfirmed"; patch: string | null }

/** Bounded presentation of observed events; never infers reasoning, tokens, or edits. */
export class TerminalActivity {
  #items: Activity[] = [];
  #patch: string[] = [];
  #added = 0;
  #removed = 0;
  #files = new Set<string>();
  #started: number | null = null;
  #ended: number | null = null;
  #phase = "Waiting for model";
  constructor(private readonly now: () => number = Date.now) {}
  clear(): void { this.#items = []; this.#patch = []; this.#added = 0; this.#removed = 0; this.#files.clear(); this.#started = null; this.#ended = null; }
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
      const patch = event.call.name === "apply_patch" && args !== null && typeof args === "object" && typeof args.patch === "string" && args.patch.length <= 65536 ? args.patch : null;
      const target = args?.path ?? args?.command ?? args?.pattern;
      const detail = typeof target === "string" ? sanitizeTerminalText(target, { multiline: false }).slice(0, 160) : "";
      this.#items.push({ id: event.call.id, name: sanitizeTerminalText(event.call.name, { multiline: false }), detail, status: "running", patch });
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
          this.#patch = changes.slice(0, 8).map((line) => line.text);
          const file = lines.find((line) => line.kind === "header" && line.text.startsWith("+++ "));
          if (file) item.detail = file.text.slice(4).replace(/^b\//u, "");
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
  render(width: number, height: number, frame: number, theme: TerminalTheme): string[] {
    if (height < 2 || this.#started === null && this.#items.length === 0 && this.#files.size === 0) return [];
    const fit = (s: string): string => truncateToWidth(s, Math.max(1, width));
    const spinner = ["◐", "◓", "◑", "◒"][frame % 4]!;
    const seconds = this.#started === null ? 0 : Math.max(0, Math.floor(((this.#ended ?? this.now()) - this.#started) / 1000));
    const elapsed = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    const rows = [this.#started === null ? theme.muted(fit("ACTIVITY")) : theme.accent(fit(`${this.#ended === null ? spinner : "·"} ${this.#phase} · ${elapsed}${this.#ended === null ? " · Ctrl+C cancel" : ""}`))];
    // Counts remain visible even when recent tools compete for vertical space.
    if (this.#added + this.#removed > 0) rows.push(fit(`${theme.success(`+${this.#added}`)} ${theme.failure(`−${this.#removed}`)} ${theme.muted("this turn · /diff")}`));
    const itemCount = Math.min(3, Math.max(0, height - rows.length));
    const items = itemCount === 0 ? [] : this.#items.slice(-itemCount);
    for (const item of items) {
      const mark = item.status === "running" ? spinner : item.status === "completed" ? "✓" : item.status === "cancelled" ? "■" : "!";
      const style = item.status === "running" ? theme.accent : item.status === "completed" ? theme.success : item.status === "cancelled" ? theme.muted : theme.failure;
      rows.push(style(fit(`${mark} ${item.name}${["failed", "denied", "cancelled", "unconfirmed"].includes(item.status) ? ` · ${item.status}` : ""}${item.detail ? ` · ${item.detail}` : ""}`)));
    }
    for (const line of this.#patch.slice(0, Math.max(0, height - rows.length))) rows.push((line.startsWith("+") ? theme.success : theme.failure)(fit(line)));
    if (this.#files.size > 0 && rows.length < height) rows.push(theme.code(fit(`${this.#files.size} changed file${this.#files.size === 1 ? "" : "s"} · ${[...this.#files].slice(0, 2).join(", ")}`)));
    return rows.slice(0, height);
  }
}
