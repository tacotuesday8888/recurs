import type { RecursEvent } from "@recurs/core";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "./terminal-text.js";
import type { TerminalTheme } from "./terminal-style.js";

interface Activity { id: string; name: string; status: "running" | "completed" | "failed" | "cancelled" | "unconfirmed"; patch: string | null }

/** Bounded presentation of observed tool events; never infers unreported edits. */
export class TerminalActivity {
  #items: Activity[] = [];
  #patch: string[] = [];
  #added = 0;
  #removed = 0;
  #files = new Set<string>();
  clear(): void { this.#items = []; this.#patch = []; this.#added = 0; this.#removed = 0; this.#files.clear(); }
  emit(event: RecursEvent): void {
    if (event.type === "turn_started") this.clear();
    if (event.type === "tool_started") {
      const args = event.call.arguments as Record<string, unknown> | null;
      const patch = event.call.name === "apply_patch" && args !== null && typeof args === "object" && typeof args.patch === "string" && args.patch.length <= 65536 ? args.patch : null;
      this.#items.push({ id: event.call.id, name: sanitizeTerminalText(event.call.name, { multiline: false }), status: "running", patch });
      if (this.#items.length > 32) this.#items.shift();
    }
    if (event.type === "tool_completed" || event.type === "tool_failed" || event.type === "tool_denied") {
      const item = this.#items.findLast((entry) => entry.id === event.callId);
      if (item !== undefined && item.status === "running") {
        item.status = event.type === "tool_completed" ? "completed" : "failed";
        if (event.type === "tool_completed" && item.patch !== null) {
          const lines = sanitizeTerminalText(item.patch).split("\n");
          const changes: string[] = [];
          let inHunk = false;
          for (const [index, line] of lines.entries()) {
            if (line.startsWith("@@ ")) { inHunk = true; continue; }
            if (line.length === 0 || line.startsWith("diff --git ") || line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ")) { inHunk = false; continue; }
            if (inHunk && /^[+-]/u.test(line)) changes.push(line);
          }
          this.#added += changes.filter((line) => line.startsWith("+")).length;
          this.#removed += changes.filter((line) => line.startsWith("-")).length;
          this.#patch = changes.slice(0, 8);
          item.patch = null;
        }
      }
    }
    if (event.type === "files_changed") for (const file of event.paths.slice(0, Math.max(0, 256 - this.#files.size))) this.#files.add(sanitizeTerminalText(file, { multiline: false }));
    if (event.type === "turn_cancelled" || event.type === "turn_failed" || event.type === "turn_completed") {
      for (const item of this.#items) if (item.status === "running") item.status = event.type === "turn_cancelled" ? "cancelled" : "unconfirmed";
    }
  }
  render(width: number, height: number, frame: number, theme: TerminalTheme): string[] {
    if (height < 2 || this.#items.length === 0 && this.#files.size === 0) return [];
    const fit = (s: string): string => truncateToWidth(s, Math.max(1, width));
    const rows = [theme.muted(fit("ACTIVITY"))];
    const items = this.#items.slice(-Math.min(3, height - 1));
    for (const item of items) {
      const mark = item.status === "running" ? ["◐", "◓", "◑", "◒"][frame % 4]! : item.status === "completed" ? "✓" : item.status === "cancelled" ? "■" : "!";
      const style = item.status === "running" ? theme.accent : item.status === "completed" ? theme.success : item.status === "cancelled" ? theme.muted : theme.failure;
      rows.push(style(fit(`${mark} ${item.name} · ${item.status}`)));
    }
    if (this.#patch.length > 0 && rows.length < height) {
      rows.push(fit(`${theme.success(`+${this.#added}`)} ${theme.failure(`−${this.#removed}`)} ${theme.muted("observed patch lines")}`));
      for (const line of this.#patch.slice(0, Math.max(0, height - rows.length))) rows.push((line.startsWith("+") ? theme.success : theme.failure)(fit(line)));
    } else if (this.#files.size > 0 && rows.length < height) rows.push(theme.code(fit(`${this.#files.size} changed files · ${[...this.#files].slice(0, 2).join(", ")}`)));
    return rows.slice(0, height);
  }
}
