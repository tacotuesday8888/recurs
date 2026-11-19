import { effortBadge } from "./terminal-effort.js";
import { Key, matchesKey, sliceByColumn, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { CommandSelectionOption } from "./commands/types.js";
import { wrapTerminalText, type TerminalTheme } from "./terminal-style.js";

/** An ephemeral choice returns an exact ID; commands still own validation and mutation. */
export class TerminalChoicePicker implements Component {
  #selected = 0;
  #query: string | null = null;
  get choices(): readonly CommandSelectionOption[] {
    const query = this.#query?.toLocaleLowerCase().trim();
    if (!query) return this.options.choices;
    return this.options.choices.filter((choice) =>
      `${choice.label} ${choice.detail ?? ""}`.toLocaleLowerCase().includes(query),
    );
  }
  constructor(private readonly options: {
    frame?(): number;
    message: string;
    emptyMessage?: string;
    startInSearch?: boolean;
    choices: readonly CommandSelectionOption[];
    theme: TerminalTheme;
    rows(): number;
    settle(id: string | null): void;
    refresh(): void;
  }) {
    this.#query = options.startInSearch ? "" : null;
    const current = options.choices.findIndex((choice) => choice.current === true);
    this.#selected = Math.max(0, current);
  }
  invalidate(): void {}
  render(width: number): string[] {
    const height = Math.max(1, this.options.rows());
    const safeWidth = Math.max(1, width);
    const line = (text: string) => truncateToWidth(text, safeWidth);
    const theme = this.options.theme;
    const choicesInView = this.choices;
    const selected = choicesInView[this.#selected];
    const escapeAction = this.options.startInSearch ? "back" : this.#query === null ? "cancel" : "clear";
    const query = `/${this.#query ?? ""}`;
    const queryWidth = visibleWidth(query);
    const queryLine = queryWidth <= safeWidth ? query : sliceByColumn(query, queryWidth - safeWidth, safeWidth, true);
    const heading = theme.strong(this.#query === null ? line(this.options.message) : queryLine);
    if (selected === undefined) {
      const empty = this.options.choices.length === 0 ? this.options.emptyMessage ?? "No choices available" : "No matches · type to search";
      const rows = [line(empty)];
      if (height >= 2) rows.unshift(heading);
      if (height >= 3) rows.push(line(`Esc ${escapeAction}`));
      if (this.#query !== null && height >= 4) rows.unshift(theme.strong(line(this.options.message)));
      return rows;
    }
    const footer = line(`Esc ${escapeAction} · Enter select${this.#query === null ? " · / search" : ""} · ↑↓ ${this.#selected + 1}/${choicesInView.length}`);
    if (height <= 3) {
      const selectedLine = theme.accent(line(`› ${selected.label}`));
      if (height === 1) return [selectedLine];
      if (height === 2 && this.#query !== null) return [heading, selectedLine];
      return [...(height === 3 ? [heading] : []), selectedLine, footer];
    }
    const detail = selected.detail === undefined ? [] : wrapTerminalText(selected.detail, safeWidth).slice(0, height > 10 ? 3 : 1).map(theme.muted);
    const title = this.#query === null
      ? wrapTerminalText(this.options.message, safeWidth).slice(0, height > 10 ? 3 : 1).map(theme.strong)
      : [...(height >= 6 ? [theme.strong(line(this.options.message))] : []), heading];
    const spacer = height - title.length - detail.length > 2 ? [""] : [];
    const count = Math.max(1, height - title.length - detail.length - spacer.length - 1);
    const start = Math.min(Math.max(0, this.#selected - count + 1), Math.max(0, choicesInView.length - count));
    const choices = choicesInView.slice(start, start + count).map((choice, offset) => {
      const label = this.options.message === "Thinking effort" && start + offset === this.#selected ? effortBadge(choice.id, theme, this.options.frame?.() ?? 0) : choice.label;
      const text = line(`${start + offset === this.#selected ? "›" : " "} ${label}`);
      return start + offset === this.#selected ? theme.accent(text) : text;
    });
    return [...title, ...choices, ...spacer, ...detail, footer];
  }
  handleInput(data: string): void {
    const choices = this.choices;
    if (matchesKey(data, Key.escape) && this.#query !== null && !this.options.startInSearch) {
      this.#query = null;
      this.#selected = Math.max(0, this.options.choices.findIndex((choice) => choice.current === true));
    } else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) this.options.settle(null);
    else if (matchesKey(data, Key.enter)) {
      const selected = choices[this.#selected];
      if (selected) this.options.settle(selected.id);
      else if (this.#query === null) this.options.settle(null);
    } else if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      if (choices.length > 0) this.#selected = (this.#selected + (matchesKey(data, Key.up) ? -1 : 1) + choices.length) % choices.length;
    } else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
      this.#selected = Math.max(0, Math.min(choices.length - 1, this.#selected + (matchesKey(data, Key.pageUp) ? -1 : 1) * Math.max(1, this.options.rows() - 8)));
    } else if (this.#query === null && data === "/") { this.#query = ""; this.#selected = 0; }
    else if (this.#query !== null && matchesKey(data, Key.backspace)) { this.#query = [...this.#query].slice(0, -1).join(""); this.#selected = 0; }
    else if (this.#query !== null) {
      const pasteStart = "\x1b[200~", pasteEnd = "\x1b[201~";
      const text = data.startsWith(pasteStart) && data.endsWith(pasteEnd)
        ? data.slice(pasteStart.length, -pasteEnd.length).trim()
        : data;
      if (text && !/[\p{Cc}\p{Bidi_Control}\p{Zl}\p{Zp}]/u.test(text)) {
        this.#query = [...this.#query, ...text.slice(0, 240)].slice(0, 120).join("");
        this.#selected = 0;
      }
    }
    this.options.refresh();
  }
}
