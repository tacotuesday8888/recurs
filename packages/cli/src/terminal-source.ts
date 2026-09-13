import { Key, matchesKey, sliceByColumn, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import path from "node:path";
import { highlightTerminalCode } from "./terminal-code.js";
import { sanitizeTerminalText } from "./terminal-text.js";
import type { TerminalTheme } from "./terminal-style.js";

export class TerminalSourceViewer implements Component {
  #offset = 0;
  #column = 0;
  #page = 1;
  readonly #lines: readonly string[];
  constructor(private readonly source: { path: string; content: string; startLine: number; totalLines: number }, private readonly options: { theme: TerminalTheme; rows(): number; back(): void; refresh(): void; browse(): void }) {
    this.#lines = source.content.length === 0 ? [] : highlightTerminalCode(source.content.endsWith("\n") ? source.content.slice(0, -1) : source.content, path.extname(source.path).slice(1), options.theme);
  }
  invalidate(): void {}
  render(width: number): string[] {
    width = Math.max(1, width);
    const height = Math.max(1, this.options.rows());
    const { theme } = this.options;
    const fit = (text: string) => truncateToWidth(text, width, "…", false);
    const title = theme.strong(fit(sanitizeTerminalText(this.source.path, { multiline: false })));
    if (height === 1) return [title];
    this.#page = Math.max(0, height - 2);
    this.#offset = Math.max(0, Math.min(this.#offset, this.#lines.length - this.#page));
    const gutter = Math.max(3, String(this.source.startLine + this.#lines.length).length);
    const body = this.#lines.slice(this.#offset, this.#offset + this.#page).map((line, index) => fit(`${theme.muted(String(this.source.startLine + this.#offset + index).padStart(gutter))}  ${sliceByColumn(line, this.#column, Math.max(1, width - gutter - 2))}`));
    while (body.length < this.#page) body.push("");
    const first = this.#lines.length ? this.source.startLine : 0;
    const last = this.#lines.length ? first + this.#lines.length - 1 : 0;
    return [title, ...body, theme.muted(fit(`Esc back · F files · ↑↓ scroll · ←→ pan · ${first}–${last}/${this.source.totalLines}`))];
  }
  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || data === "q") { this.options.back(); return; }
    if (data === "f") { this.options.browse(); return; }
    if (matchesKey(data, Key.up)) this.#offset--;
    else if (matchesKey(data, Key.down)) this.#offset++;
    else if (matchesKey(data, Key.pageUp)) this.#offset -= this.#page;
    else if (matchesKey(data, Key.pageDown)) this.#offset += this.#page;
    else if (matchesKey(data, Key.home)) this.#offset = 0;
    else if (matchesKey(data, Key.end)) this.#offset = this.#lines.length;
    else if (matchesKey(data, Key.left)) this.#column = Math.max(0, this.#column - 8);
    else if (matchesKey(data, Key.right)) this.#column = Math.min(65536, this.#column + 8);
    this.#offset = Math.max(0, Math.min(this.#offset, this.#lines.length - this.#page));
    this.options.refresh();
  }
}
