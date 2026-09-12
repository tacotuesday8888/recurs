import { Key, matchesKey, sliceByColumn, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "./terminal-text.js";
import type { TerminalTheme } from "./terminal-style.js";

export interface DiffLine {
  kind: "header" | "hunk" | "context" | "add" | "remove" | "meta";
  text: string;
  oldLine?: number;
  newLine?: number;
}

/** Count hunk contents only, including content that resembles a file header. */
export function parseTerminalDiff(input: string): DiffLine[] {
  let oldLine = 0, newLine = 0, oldRemaining = 0, newRemaining = 0;
  return sanitizeTerminalText(input).split("\n").map((text): DiffLine => {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]); newLine = Number(hunk[3]);
      oldRemaining = Number(hunk[2] ?? 1); newRemaining = Number(hunk[4] ?? 1);
      return { kind: "hunk", text };
    }
    if (oldRemaining > 0 || newRemaining > 0) {
      if (text.startsWith("-") && oldRemaining > 0) { oldRemaining--; return { kind: "remove", text, oldLine: oldLine++ }; }
      if (text.startsWith("+") && newRemaining > 0) { newRemaining--; return { kind: "add", text, newLine: newLine++ }; }
      if (text.startsWith(" ") && oldRemaining > 0 && newRemaining > 0) {
        oldRemaining--; newRemaining--;
        return { kind: "context", text, oldLine: oldLine++, newLine: newLine++ };
      }
    }
    if (/^(?:diff --git |--- |\+\+\+ |rename |new file |deleted file |Binary files)/u.test(text)) {
      oldRemaining = 0; newRemaining = 0;
      return { kind: "header", text };
    }
    return { kind: "meta", text };
  });
}

const MODES = ["Unified", "Split", "Original", "Updated"] as const;

/** A read-only snapshot; switching modes never changes files or the chat draft. */
export class TerminalDiffViewer implements Component {
  #mode = 0;
  #offset = 0;
  #column = 0;
  #page = 1;
  #maximum = 0;
  #truncated: boolean;
  readonly #lines: DiffLine[];
  readonly #added: number;
  readonly #removed: number;
  constructor(input: string, private readonly options: { theme: TerminalTheme; rows(): number; back(): void; refresh(): void }) {
    this.#truncated = input.length > 256 * 1024;
    this.#lines = parseTerminalDiff(input.slice(0, 256 * 1024));
    this.#added = this.#lines.filter((line) => line.kind === "add").length;
    this.#removed = this.#lines.filter((line) => line.kind === "remove").length;
  }
  invalidate(): void {}
  render(width: number): string[] {
    const safeWidth = Math.max(1, width), height = Math.max(1, this.options.rows());
    const theme = this.options.theme;
    const fit = (text: string, columns = safeWidth): string => truncateToWidth(text, columns, "…", false);
    const color = (line: DiffLine, text: string): string => line.kind === "add" ? theme.success(text) : line.kind === "remove" ? theme.failure(text) : line.kind === "header" || line.kind === "hunk" ? theme.accent(text) : theme.code(text);
    const content = (line: DiffLine): string => sliceByColumn(line.text.slice(1), this.#column, safeWidth);
    const numbered = (line: DiffLine, mode: number): string => color(line, fit(mode === 0
      ? `${String(line.oldLine ?? "").padStart(4)} ${String(line.newLine ?? "").padStart(4)} ${line.text[0]} ${content(line)}`
      : `${String(mode === 2 ? line.oldLine ?? "" : line.newLine ?? "").padStart(4)} ${content(line)}`));
    const mode = this.#mode === 1 && safeWidth < 90 ? 0 : this.#mode;
    const rows: string[] = [];
    if (mode === 1) {
      const leftWidth = Math.floor((safeWidth - 3) / 2), rightWidth = safeWidth - 3 - leftWidth;
      const cell = (line: DiffLine | undefined, side: "old" | "new", columns: number): string => {
        if (line === undefined) return " ".repeat(columns);
        const text = fit(`${String(side === "old" ? line.oldLine ?? "" : line.newLine ?? "").padStart(4)} ${content(line)}`, columns);
        return color(line, text + " ".repeat(Math.max(0, columns - visibleWidth(text))));
      };
      for (let index = 0; index < this.#lines.length; index++) {
        const line = this.#lines[index]!;
        if (line.kind === "remove" || line.kind === "add") {
          const removed: DiffLine[] = [], added: DiffLine[] = [];
          while (index < this.#lines.length && ["remove", "add"].includes(this.#lines[index]!.kind)) {
            const change = this.#lines[index++]!;
            (change.kind === "remove" ? removed : added).push(change);
          }
          index--;
          for (let i = 0; i < Math.max(removed.length, added.length); i++) rows.push(`${cell(removed[i], "old", leftWidth)} ${theme.muted("│")} ${cell(added[i], "new", rightWidth)}`);
        } else if (line.kind === "context") rows.push(`${cell(line, "old", leftWidth)} ${theme.muted("│")} ${cell(line, "new", rightWidth)}`);
        else rows.push(color(line, fit(line.text)));
      }
    } else {
      for (const line of this.#lines) {
        if (mode === 2 && line.kind === "add" || mode === 3 && line.kind === "remove") continue;
        rows.push(line.kind === "add" || line.kind === "remove" || line.kind === "context" ? numbered(line, mode) : color(line, fit(line.text)));
      }
    }
    const title = fit(`${theme.strong(`Changes · ${MODES[mode]}${mode >= 2 ? " excerpt" : ""}`)} · ${theme.success(`+${this.#added}`)} ${theme.failure(`−${this.#removed}`)}${this.#truncated ? " · partial preview" : ""}`);
    if (height === 1) return [title];
    const hint = fit(this.#mode === 1 && mode === 0 ? "Split needs 90 columns · showing unified" : "1 unified · 2 split · 3 original · 4 updated");
    const header = height >= 5 ? [title, theme.muted(hint)] : [title];
    this.#page = Math.max(1, height - header.length - 1);
    this.#maximum = Math.max(0, rows.length - this.#page);
    this.#offset = Math.min(this.#offset, this.#maximum);
    const body = rows.slice(this.#offset, this.#offset + this.#page);
    while (body.length < height - header.length - 1) body.push("");
    return [...header, ...body, theme.muted(fit(`Esc back · ↑↓ scroll · ←→ pan · ${this.#offset + 1}/${Math.max(1, rows.length)}`))].slice(0, height);
  }
  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || data === "q") { this.options.back(); return; }
    if (/^[1-4]$/u.test(data) || matchesKey(data, Key.tab)) { this.#mode = data === "\t" ? (this.#mode + 1) % MODES.length : Number(data) - 1; this.#offset = 0; }
    else if (matchesKey(data, Key.up)) this.#offset = Math.max(0, this.#offset - 1);
    else if (matchesKey(data, Key.down)) this.#offset = Math.min(this.#maximum, this.#offset + 1);
    else if (matchesKey(data, Key.pageUp)) this.#offset = Math.max(0, this.#offset - this.#page);
    else if (matchesKey(data, Key.pageDown)) this.#offset = Math.min(this.#maximum, this.#offset + this.#page);
    else if (matchesKey(data, Key.home)) this.#offset = 0;
    else if (matchesKey(data, Key.end)) this.#offset = this.#maximum;
    else if (matchesKey(data, Key.left)) this.#column = Math.max(0, this.#column - 8);
    else if (matchesKey(data, Key.right)) this.#column = Math.min(65536, this.#column + 8);
    this.options.refresh();
  }
}
