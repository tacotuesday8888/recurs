import path from "node:path";
import { highlightTerminalCode } from "./terminal-code.js";
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

interface ReviewFile {
  path: string;
  oldPath: string | null;
  lines: DiffLine[];
  added: number;
  removed: number;
}

function gitPath(value: string, prefixed = true): string {
  let decoded = value;
  if (value.startsWith('"') && value.endsWith('"')) {
    const bytes: number[] = [];
    const body = value.slice(1, -1);
    for (let i = 0; i < body.length;) {
      const escaped = /^\\([0-7]{1,3}|[\\"tnr])/u.exec(body.slice(i));
      if (escaped) {
        const token = escaped[1]!;
        bytes.push(/^[0-7]/u.test(token) ? Number.parseInt(token, 8) : token === "t" ? 9 : token === "n" ? 10 : token === "r" ? 13 : token.charCodeAt(0));
        i += escaped[0].length;
      } else {
        const point = String.fromCodePoint(body.codePointAt(i)!);
        bytes.push(...Buffer.from(point)); i += point.length;
      }
    }
    decoded = Buffer.from(bytes).toString("utf8");
  }
  return sanitizeTerminalText(prefixed ? decoded.replace(/^[ab]\//u, "") : decoded, { multiline: false });
}

function reviewFiles(lines: readonly DiffLine[]): ReviewFile[] {
  const files: ReviewFile[] = [];
  let current: ReviewFile | undefined;
  let sourceHeader = false;
  for (const line of lines) {
    const startsFile = line.text.startsWith("diff --git ") && line.kind === "header";
    if (!current || startsFile || line.kind === "header" && line.text.startsWith("--- ") && sourceHeader) {
      current = { path: "Changes", oldPath: null, lines: [], added: 0, removed: 0 };
      files.push(current); sourceHeader = false;
      if (startsFile) {
        const match = / ("b\/(?:\\.|[^"\\])*"|b\/.*)$/u.exec(line.text);
        if (match) current.path = gitPath(match[1]!);
      }
    }
    if (line.kind === "header" && line.text.startsWith("--- ")) {
      current.oldPath = gitPath(line.text.slice(4)); sourceHeader = true;
      if (current.oldPath !== "/dev/null") current.path = current.oldPath;
    }
    if (line.kind === "header" && line.text.startsWith("+++ ") && line.text.slice(4) !== "/dev/null") current.path = gitPath(line.text.slice(4));
    if (line.text.startsWith("rename to ") && line.kind === "header") current.path = gitPath(line.text.slice(10), false);
    current.lines.push(line);
    if (line.kind === "add") current.added++;
    if (line.kind === "remove") current.removed++;
  }
  return files.filter((file) => file.lines.some((line) => line.text.length > 0));
}

const MODES = ["Unified", "Split", "Original", "Updated"] as const;

/** Read-only review: formatting and navigation never alter the underlying patch. */
export class TerminalDiffViewer implements Component {
  #mode = 0;
  #raw = false;
  #cache: { key: string; rows: string[] } | undefined;
  #fileRows: { label: string; offset: number; added: number; removed: number }[] = [];
  #browsing = false;
  #selectedFile = 0;
  #offset = 0;
  #column = 0;
  #page = 1;
  #maximum = 0;
  #pendingFile: number | undefined;
  readonly #truncated: boolean;
  readonly #files: ReviewFile[];
  readonly #added: number;
  readonly #removed: number;
  readonly #highlighted = new Map<DiffLine, string>();
  constructor(input: string, private readonly options: { theme: TerminalTheme; title?: string; rows(): number; back(): void; refresh(): void }) {
    this.#truncated = input.length > 256 * 1024;
    this.#files = reviewFiles(parseTerminalDiff(input.slice(0, 256 * 1024)));
    this.#added = this.#files.reduce((sum, file) => sum + file.added, 0);
    this.#removed = this.#files.reduce((sum, file) => sum + file.removed, 0);
    for (const file of this.#files) for (const line of file.lines) {
      if (["add", "remove", "context"].includes(line.kind)) this.#highlighted.set(line, highlightTerminalCode(line.text.slice(1), path.extname(file.path).slice(1), options.theme).join(""));
    }
  }
  invalidate(): void { this.#cache = undefined; }
  #activeFile(): number {
    return Math.max(0, this.#fileRows.findLastIndex((file) => file.offset <= this.#offset));
  }
  render(width: number): string[] {
    const columns = Math.max(1, width), height = Math.max(1, this.options.rows());
    const theme = this.options.theme;
    const fit = (text: string, size = columns): string => truncateToWidth(text, size, "…", false);
    const pad = (text: string, size: number): string => text + " ".repeat(Math.max(0, size - visibleWidth(text)));
    const mode = this.#mode === 1 && columns < 90 ? 0 : this.#mode;
    const key = `${mode}:${columns}:${this.#column}:${this.#raw}`;
    if (this.#cache?.key !== key) {
      const rows: string[] = [];
      this.#fileRows = [];
      const cell = (line: DiffLine | undefined, side: "old" | "new" | "both", size: number): string => {
        if (!line) return " ".repeat(size);
        const changed = line.kind === "add" || line.kind === "remove";
        const mark = line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " ";
        const numbers = side === "both"
          ? `${String(line.oldLine ?? "").padStart(4)} ${String(line.newLine ?? "").padStart(4)}`
          : String(side === "old" ? line.oldLine ?? "" : line.newLine ?? "").padStart(4);
        const gutter = `${numbers} │ ${mark} `;
        const ink = line.kind === "add" ? theme.success : line.kind === "remove" ? theme.failure : theme.muted;
        const source = sliceByColumn(this.#highlighted.get(line) ?? line.text.slice(1), this.#column, Math.max(1, size - gutter.length));
        const text = pad(fit(`${ink(gutter)}${source}`, size), size);
        return changed ? theme.change(text, line.kind as "add" | "remove") : text;
      };
      for (const file of this.#files) {
        if (rows.length) rows.push("");
        this.#fileRows.push({ label: file.path, offset: rows.length, added: file.added, removed: file.removed });
        const status = file.oldPath === "/dev/null" ? " · new" : file.lines.some((line) => line.text === "+++ /dev/null") ? " · deleted" : "";
        rows.push(fit(`${theme.strong(file.path)}${theme.muted(status)}  ${theme.success(`+${file.added}`)} ${theme.failure(`−${file.removed}`)}`));
        if (mode === 1) {
          const leftWidth = Math.floor((columns - 3) / 2);
          rows.push(`${theme.muted(pad("Original", leftWidth))} ${theme.muted("│")} ${theme.muted("Updated")}`);
        }
        for (let index = 0; index < file.lines.length; index++) {
          const line = file.lines[index]!;
          if (!["add", "remove", "context"].includes(line.kind)) {
            if (this.#raw) rows.push(theme.muted(fit(line.text)));
            else if (line.kind === "hunk") {
              const context = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/u.exec(line.text);
              if (context && (context[1] !== "1" || context[2] !== "1")) rows.push(theme.muted(fit(`⋯ ${context[3]?.trim() || `line ${context[2]}`}`)));
            } else if (/^(?:\\ No newline at end of file|Binary files|GIT binary patch|old mode|new mode|similarity index|rename from)/u.test(line.text)) rows.push(theme.muted(fit(line.text)));
            continue;
          }
          if (mode === 1) {
            const leftWidth = Math.floor((columns - 3) / 2), rightWidth = columns - 3 - leftWidth;
            if (line.kind === "context") rows.push(`${cell(line, "old", leftWidth)} ${theme.muted("│")} ${cell(line, "new", rightWidth)}`);
            else {
              const removed: DiffLine[] = [], added: DiffLine[] = [];
              while (index < file.lines.length && ["remove", "add"].includes(file.lines[index]!.kind)) {
                const change = file.lines[index++]!;
                (change.kind === "remove" ? removed : added).push(change);
              }
              index--;
              for (let i = 0; i < Math.max(removed.length, added.length); i++) rows.push(`${cell(removed[i], "old", leftWidth)} ${theme.muted("│")} ${cell(added[i], "new", rightWidth)}`);
            }
          } else if (!(mode === 2 && line.kind === "add" || mode === 3 && line.kind === "remove")) rows.push(cell(line, mode === 0 ? "both" : mode === 2 ? "old" : "new", columns));
        }
      }
      if (this.#pendingFile !== undefined) {
        this.#offset = this.#fileRows[this.#pendingFile]?.offset ?? 0;
        this.#pendingFile = undefined;
      }
      this.#cache = { key, rows };
    }
    const rows = this.#cache.rows;
    if (this.#browsing) {
      this.#page = Math.max(1, height - 2);
      const start = Math.max(0, this.#selectedFile - this.#page + 1);
      const files = this.#fileRows.slice(start, start + this.#page).map((file, index) => fit(`${start + index === this.#selectedFile ? theme.accent("›") : " "} ${file.label}  ${theme.success(`+${file.added}`)} ${theme.failure(`−${file.removed}`)}`));
      if (height === 1) return files.slice(0, 1);
      return [theme.strong(fit(`Changed files · ${this.#fileRows.length}`)), ...files, theme.muted(fit("↑↓ select · Enter open · Esc back"))].slice(0, height);
    }
    const title = fit(`${theme.strong(`${this.options.title ?? "Changes"} · ${MODES[mode]}${mode >= 2 ? " excerpt" : ""}`)} · ${theme.success(`+${this.#added}`)} ${theme.failure(`−${this.#removed}`)}${this.#truncated ? " · partial preview" : ""}`);
    if (height === 1) return [title];
    const hint = fit(this.#mode === 1 && mode === 0 ? "Split needs 90 columns · showing unified" : "1 unified · 2 split · 3 original · 4 updated");
    const header = height >= 5 ? [title, theme.muted(hint), ""] : [title];
    this.#page = Math.max(1, height - header.length - 1);
    this.#maximum = Math.max(0, rows.length - this.#page, this.#fileRows.at(-1)?.offset ?? 0);
    this.#offset = Math.min(this.#offset, this.#maximum);
    const body = rows.slice(this.#offset, this.#offset + this.#page);
    while (body.length < height - header.length - 1) body.push("");
    return [...header, ...body, theme.muted(fit(`Esc back · F files · N/P file · R metadata · ↑↓ scroll · ←→ pan`))].slice(0, height);
  }
  handleInput(data: string): void {
    if (this.#browsing) {
      if (matchesKey(data, Key.escape) || data.toLowerCase() === "f") this.#browsing = false;
      else if (matchesKey(data, Key.up)) this.#selectedFile = Math.max(0, this.#selectedFile - 1);
      else if (matchesKey(data, Key.down)) this.#selectedFile = Math.max(0, Math.min(this.#fileRows.length - 1, this.#selectedFile + 1));
      else if (matchesKey(data, Key.enter)) { this.#offset = this.#fileRows[this.#selectedFile]?.offset ?? 0; this.#browsing = false; }
      this.options.refresh(); return;
    }
    if (data.toLowerCase() === "f") { this.#selectedFile = this.#activeFile(); this.#browsing = true; this.options.refresh(); return; }
    if (matchesKey(data, Key.escape) || data === "q") { this.options.back(); return; }
    if (/^[1-4]$/u.test(data) || matchesKey(data, Key.tab)) { this.#pendingFile = this.#activeFile(); this.#mode = matchesKey(data, Key.tab) ? (this.#mode + 1) % MODES.length : Number(data) - 1; this.invalidate(); }
    else if (data.toLowerCase() === "r") { this.#pendingFile = this.#activeFile(); this.#raw = !this.#raw; }
    else if (data.toLowerCase() === "n" || data.toLowerCase() === "p") this.#offset = this.#fileRows[Math.max(0, Math.min(this.#fileRows.length - 1, this.#activeFile() + (data.toLowerCase() === "n" ? 1 : -1)))]?.offset ?? 0;
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
